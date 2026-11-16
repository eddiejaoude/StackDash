import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { createOAuthContext, getAdapter, loadOAuthClient } from "@/lib/adapters/registry";
import {
  Secret,
  type ConnectionWebhookSetup,
  type FullAccessPermission,
  type ProviderAdapter,
  type ProviderId,
} from "@/lib/adapters/types";
import {
  acquireCredentialRefreshLock,
  loadCredential,
  releaseCredentialRefreshLock,
  saveCredential,
} from "@/lib/data/credentials";
import {
  countWorkspaceWebhookEndpoints,
  deleteWebhookEndpoint,
  getConnectionWebhook,
  insertWebhookEndpoint,
  replaceWebhookEndpointSecret,
  WebhookEndpointExistsError,
  WebhookEndpointLimitError,
} from "@/lib/data/webhook-endpoints";
import { log, logError } from "@/lib/log/logger";
import { PROVIDER_NAMES } from "@/lib/providers";
import { createAdminClient } from "@/lib/supabase/admin";

import { refreshIfExpiring, type CredentialRefreshDeps } from "./credential-refresh";
import { WEBHOOK_ENDPOINTS_PER_WORKSPACE } from "./webhook-copy";

/*
 * Setting up a connection's webhook (#426), automatically through the provider's API or by hand,
 * and removing it again on disconnect. Callers authorize the user to manage connections in the
 * workspace first and pass a connection they re-read inside it.
 *
 * Automatic setup creates the webhook at the provider before the endpoint row exists, so the
 * provider is handed the final URL: the endpoint id is chosen here. If storing the row then fails
 * (the workspace reached its limit in a race), the webhook is deleted at the provider again.
 */

// 32 random bytes, as the providers that take a secret from the caller accept (GitLab allows any
// string up to 255 characters).
const SECRET_BYTES = 32;
// A grant reaching more accounts than this is unusual; the same bound as connect.ts.
const MAX_ACCOUNTS = 500;

// The provider calls below use the stored credential refreshed first when it is about to expire,
// under the same per-connection refresh lock a sync takes, so the two never spend one refresh token.
const refreshDeps: CredentialRefreshDeps = {
  store: {
    loadCredential,
    saveCredential: (key, credential) => saveCredential({ ...key, credential }),
    acquireCredentialRefreshLock,
    releaseCredentialRefreshLock,
  },
  now: () => new Date(),
  sleep: (ms) => sleep(ms),
  logError,
};

/** The adapter's per-connection webhook setup, or null when its webhooks (if any) are app-level. */
export function connectionWebhookSetup(adapter: ProviderAdapter): ConnectionWebhookSetup | null {
  const registration = adapter.webhooks?.registration;
  return registration?.kind === "connection" ? registration.setup : null;
}

/** The connection's own delivery URL on this instance. */
export function webhookUrl(origin: string, provider: ProviderId, endpointId: string): string {
  return new URL(`/api/webhooks/${provider}/${endpointId}`, origin).href;
}

export function newWebhookSecret(): Secret {
  return new Secret(randomBytes(SECRET_BYTES).toString("base64url"));
}

// The workspace is at its limit, or a second setup of the connection raced the first.
type SetupRefusal = Readonly<{ kind: "limit_reached" }> | Readonly<{ kind: "already_set_up" }>;

// The secret to show once: StackDash's, or null when the provider generates it.
export type ManualSetupOutcome = Readonly<{ kind: "manual"; endpointId: string; secret: Secret | null }> | SetupRefusal;

export type AutomaticSetupOutcome =
  | Readonly<{ kind: "automatic" }>
  | SetupRefusal
  // The grant does not hold the scopes automatic setup needs: the user has not approved them.
  | Readonly<{ kind: "write_access_missing" }>
  // The provider is no longer set up on this instance, so StackDash cannot call it.
  | Readonly<{ kind: "not_configured" }>;

/**
 * The write permissions a connect or reconnect asks for on top of the adapter's own: automatic
 * setup's, when the user chose it for this connection, or when the connection's webhook was set up
 * automatically, so a reconnect keeps the access that deletes the webhook on disconnect. Empty
 * otherwise, and always for a first connect.
 */
export async function webhookWritePermissions({
  adapter,
  workspaceId,
  connectionId,
  chosen,
}: Readonly<{ adapter: ProviderAdapter; workspaceId: string; connectionId: string | undefined; chosen: boolean }>): Promise<
  readonly FullAccessPermission[]
> {
  const extra = connectionWebhookSetup(adapter)?.automatic?.extraPermissions ?? [];
  if (extra.length === 0 || connectionId === undefined) return [];
  if (chosen) return extra;
  return (await getConnectionWebhook(workspaceId, connectionId))?.setupMode === "automatic" ? extra : [];
}

type SetupTarget = Readonly<{ workspaceId: string; connectionId: string; adapter: ProviderAdapter; setup: ConnectionWebhookSetup }>;

/** Expected refusals from storing the endpoint, as outcomes; anything else is rethrown. */
function refusal(error: unknown): SetupRefusal | null {
  if (error instanceof WebhookEndpointLimitError) return { kind: "limit_reached" };
  if (error instanceof WebhookEndpointExistsError) return { kind: "already_set_up" };
  return null;
}

/**
 * Creates the endpoint for setup by hand. Never asks the provider for anything. Where StackDash
 * generates the secret it is returned once for the panel to show; where the provider does, the
 * endpoint holds a random secret nobody knows, so every delivery is refused until the user pastes
 * the provider's.
 */
export async function setUpWebhookByHand({ workspaceId, connectionId, adapter, setup }: SetupTarget): Promise<ManualSetupOutcome> {
  const refused = await setupRefusal(workspaceId, connectionId);
  if (refused !== null) return refused;
  const endpointId = randomUUID();
  const secret = newWebhookSecret();
  const awaitingProviderSecret = setup.secretSource === "provider";
  try {
    await insertWebhookEndpoint({
      id: endpointId,
      workspaceId,
      connectionId,
      provider: adapter.id,
      secret,
      setup: { mode: "manual", awaitingProviderSecret },
    });
  } catch (error) {
    const outcome = refusal(error);
    if (outcome === null) throw error;
    return outcome;
  }
  log.info("webhook_setup.manual", { provider: adapter.id, workspaceId, connectionId, endpointId });
  return { kind: "manual", endpointId, secret: awaitingProviderSecret ? null : secret };
}

async function includedAccountIds(workspaceId: string, connectionId: string): Promise<string[]> {
  const { data, error } = await createAdminClient()
    .from("external_accounts")
    .select("external_id")
    .eq("workspace_id", workspaceId)
    .eq("connection_id", connectionId)
    .eq("included", true)
    .order("external_id", { ascending: true })
    .limit(MAX_ACCOUNTS);
  if (error) throw new Error(`External accounts lookup failed (code ${error.code}).`);
  return data.map((row) => row.external_id);
}

/**
 * Why a webhook cannot be set up for this connection now, or null when it can: the connection has
 * one already, or the workspace is at its limit. Checked before the write access consent and at the
 * start of either setup, so a stale tab or a repeat gets the reason before anything is created, at
 * the provider or here.
 */
export async function setupRefusal(workspaceId: string, connectionId: string): Promise<SetupRefusal | null> {
  const [existing, count] = await Promise.all([
    getConnectionWebhook(workspaceId, connectionId),
    countWorkspaceWebhookEndpoints(workspaceId),
  ]);
  if (existing !== null) return { kind: "already_set_up" };
  return count >= WEBHOOK_ENDPOINTS_PER_WORKSPACE ? { kind: "limit_reached" } : null;
}

/**
 * Creates the webhook at the provider with the connection's stored credential, refreshed and saved
 * first when it is about to expire, then the endpoint. Refused without a call to the provider when
 * the grant lacks a scope automatic setup needs; a failed refresh is thrown before `create`.
 */
export async function setUpWebhookAutomatically({
  workspaceId,
  connectionId,
  adapter,
  setup,
  origin,
}: SetupTarget & Readonly<{ origin: string }>): Promise<AutomaticSetupOutcome> {
  if (setup.automatic === undefined) throw new Error(`${adapter.id} declares no automatic webhook setup.`);
  const refused = await setupRefusal(workspaceId, connectionId);
  if (refused !== null) return refused;

  const [stored, accountIds] = await Promise.all([
    loadCredential({ workspaceId, connectionId }),
    includedAccountIds(workspaceId, connectionId),
  ]);
  if (stored === null) throw new Error("The connection has no stored credential to set up a webhook with.");
  if (setup.automatic.extraPermissions.some((permission) => !stored.scopes.includes(permission.scope))) {
    return { kind: "write_access_missing" };
  }
  const client = loadOAuthClient(adapter);
  if (client === null) return { kind: "not_configured" };
  const ctx = createOAuthContext(client);
  const credential = await refreshIfExpiring(adapter, stored, { workspaceId, connectionId }, ctx, refreshDeps);

  const endpointId = randomUUID();
  const input = { credential, url: webhookUrl(origin, adapter.id, endpointId), externalAccountIds: accountIds };
  let created: Readonly<{ webhookId: string; secret: Secret }>;
  if (setup.secretSource === "stackdash") {
    const secret = newWebhookSecret();
    created = { webhookId: (await setup.automatic.create({ ...input, secret }, ctx)).webhookId, secret };
  } else {
    created = await setup.automatic.create(input, ctx);
  }
  try {
    await insertWebhookEndpoint({
      id: endpointId,
      workspaceId,
      connectionId,
      provider: adapter.id,
      secret: created.secret,
      setup: { mode: "automatic", providerWebhookId: created.webhookId },
    });
  } catch (error) {
    // Nothing points at the webhook any more: delete it at the provider rather than leave it
    // sending deliveries to a URL that answers 404.
    try {
      await setup.automatic.remove({ credential, webhookId: created.webhookId }, ctx);
    } catch (removeError) {
      logError("webhook_setup.cleanup_failed", removeError, { provider: adapter.id, workspaceId, connectionId });
    }
    const outcome = refusal(error);
    if (outcome === null) throw error;
    return outcome;
  }
  log.info("webhook_setup.automatic", { provider: adapter.id, workspaceId, connectionId, endpointId });
  return { kind: "automatic" };
}

/**
 * A new StackDash secret for a webhook set up by hand, returned once; the old one stops verifying
 * at once. Null when the connection has no endpoint.
 */
export async function rotateWebhookSecret(workspaceId: string, connectionId: string): Promise<Secret | null> {
  const secret = newWebhookSecret();
  return (await replaceWebhookEndpointSecret({ workspaceId, connectionId, secret })) ? secret : null;
}

/** What became of the connection's webhook on disconnect. */
export type WebhookRemoval =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "removed" }>
  // Set up by hand: only the user can remove it in the provider.
  | Readonly<{ kind: "manual" }>
  | Readonly<{ kind: "failed"; referenceId: string }>;

/**
 * Deletes the endpoint, so a delivery still sent to it is refused like one to an unknown URL, and
 * then deletes an automatic webhook at the provider with the credential StackDash still holds,
 * refreshed and saved first when it is about to expire. Run it before revoking that credential. A
 * failed refresh or provider call is returned, not thrown: the disconnect goes on and the user is
 * told how to remove the webhook by hand.
 */
export async function removeConnectionWebhook({
  workspaceId,
  connectionId,
  provider,
}: Readonly<{ workspaceId: string; connectionId: string; provider: ProviderId }>): Promise<WebhookRemoval> {
  const removed = await deleteWebhookEndpoint(workspaceId, connectionId);
  if (removed === null) return { kind: "none" };
  if (removed.setupMode === "manual" || removed.providerWebhookId === null) return { kind: "manual" };
  try {
    const adapter = getAdapter(provider);
    const automatic = connectionWebhookSetup(adapter)?.automatic;
    if (automatic === undefined) throw new Error(`${provider} no longer declares automatic webhook setup.`);
    const credential = await loadCredential({ workspaceId, connectionId });
    const client = loadOAuthClient(adapter);
    if (credential === null) throw new Error("The connection has no stored credential to delete its webhook with.");
    if (client === null) throw new Error(`${provider} is no longer set up on this instance.`);
    const ctx = createOAuthContext(client);
    const current = await refreshIfExpiring(adapter, credential, { workspaceId, connectionId }, ctx, refreshDeps);
    await automatic.remove({ credential: current, webhookId: removed.providerWebhookId }, ctx);
    return { kind: "removed" };
  } catch (error) {
    return { kind: "failed", referenceId: logError("webhook_setup.remove_failed", error, { provider, workspaceId, connectionId }) };
  }
}

/** The steps that remove the provider's webhook by hand, from its declaration. */
export function webhookRemovalSteps(provider: ProviderId): string {
  try {
    const setup = connectionWebhookSetup(getAdapter(provider));
    if (setup !== null) return setup.removalSteps.join(" ");
  } catch (error) {
    // The fake provider is disabled on this instance; fall back to the generic step.
    log.warn("webhook_setup.adapter_unavailable", { provider, error: error instanceof Error ? error.name : typeof error });
  }
  return `Remove StackDash's webhook in your ${PROVIDER_NAMES[provider]} settings.`;
}

/** One or two sentences for the disconnect message, or null when there was no webhook. */
export function webhookRemovalMessage(provider: ProviderId, removal: WebhookRemoval): string | null {
  const name = PROVIDER_NAMES[provider];
  switch (removal.kind) {
    case "none":
      return null;
    case "removed":
      return `StackDash deleted its webhook in ${name}.`;
    case "manual":
      return `Remove the webhook you added in ${name}: ${webhookRemovalSteps(provider)}`;
    case "failed":
      return `StackDash could not delete its webhook in ${name} (reference ${removal.referenceId}). ${webhookRemovalSteps(provider)}`;
  }
}
