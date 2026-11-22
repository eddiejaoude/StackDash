import "server-only";

import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { createOAuthContext, getAdapter, loadOAuthClient } from "@/lib/adapters/registry";
import {
  Secret,
  type AutomaticWebhookSetup,
  type ConnectionWebhookSetup,
  type FullAccessPermission,
  type OAuthContext,
  type OAuthCredential,
  type PerSourceWebhookSetup,
  type ProviderAdapter,
  type ProviderId,
  type RemoveWebhookInput,
  type WebhookSource,
} from "@/lib/adapters/types";
import { listIncludedAccounts } from "@/lib/data/connections";
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
  getWebhookEndpointSetup,
  insertWebhookEndpoint,
  listWebhookSources,
  loadWebhookEndpoint,
  noteSourceWithoutWebhook,
  replaceWebhookEndpointSecret,
  saveCreatedWebhookSource,
  WEBHOOK_SOURCES_PER_ENDPOINT,
  WebhookEndpointExistsError,
  WebhookEndpointLimitError,
  type SourceWebhook,
} from "@/lib/data/webhook-endpoints";
import { log, logError, type LogFields } from "@/lib/log/logger";
import { messageOrigin } from "@/lib/notifications/links";
import { PROVIDER_NAMES } from "@/lib/providers";

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
 *
 * A provider whose webhooks are per source (#428, GitLab projects) is the other way round: the
 * endpoint row is stored first, then each source's webhook is created and recorded in
 * `webhook_sources` as soon as it exists, so a webhook is never created without a row that deletes
 * it on disconnect. Sources the connection reads later get theirs after a sync
 * (`addMissingSourceWebhooks`). Every path that calls the provider (setup, removal on disconnect,
 * and the after-sync pass) loads the stored credential once and refreshes it through
 * `refreshIfExpiring` (#496) before its first provider call, so one setup, removal, or pass spends a
 * refresh token at most once, however many sources it covers.
 */

// 32 random bytes, encoded base64url. GitLab fixes the length: automatic setup sends this secret as
// its signing token, which must encode exactly 32 bytes (`signingToken` in
// src/lib/adapters/gitlab/index.ts throws on any other length).
const SECRET_BYTES = 32;
// Webhook calls to the provider at once, for a per-source setup or removal. GitLab limits webhook
// creation per project, not per user, but a hundred calls at once would still be a burst.
const SOURCE_CALL_CONCURRENCY = 5;

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

// The workspace is at its limit, or a second setup of the connection raced the first; or, for
// automatic setup only, the provider's webhook covers one account and the connection does not
// include exactly one (`AutomaticWebhookSetup.accounts`).
type SetupRefusal =
  | Readonly<{ kind: "limit_reached" }>
  | Readonly<{ kind: "already_set_up" }>
  | Readonly<{ kind: "one_account_needed" }>;

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
  // Setup by hand is never refused for the accounts automatic setup can serve.
  const refused = await setupRefusal(workspaceId, connectionId, undefined);
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
  return (await listIncludedAccounts(workspaceId, connectionId)).map((account) => account.externalId);
}

/**
 * Why a webhook cannot be set up for this connection now, or null when it can: the connection has
 * one already, or the workspace is at its limit, or, given the automatic setup about to run, its
 * webhook covers one account and the connection does not include exactly one. Checked before the
 * write access consent and at the start of either setup, so a stale tab, a repeat, or a connection
 * automatic setup cannot serve gets the reason before anything is asked for or created, at the
 * provider or here. `automatic` is required, and `undefined` only for setup by hand, so a caller
 * cannot drop it by accident and move the accounts refusal back to after the consent; it picks a
 * property every automatic setup shape has, so each shape is accepted.
 */
export async function setupRefusal(
  workspaceId: string,
  connectionId: string,
  automatic: Pick<AutomaticWebhookSetup<unknown>, "accounts" | "extraPermissions"> | undefined,
): Promise<SetupRefusal | null> {
  const [existing, count, included] = await Promise.all([
    getConnectionWebhook(workspaceId, connectionId),
    countWorkspaceWebhookEndpoints(workspaceId),
    automatic?.accounts === "one" ? includedAccountIds(workspaceId, connectionId) : null,
  ]);
  if (existing !== null) return { kind: "already_set_up" };
  if (count >= WEBHOOK_ENDPOINTS_PER_WORKSPACE) return { kind: "limit_reached" };
  return included !== null && included.length !== 1 ? { kind: "one_account_needed" } : null;
}

/** Runs `call` on every item, SOURCE_CALL_CONCURRENCY at a time, and returns the failures. */
async function settleInBatches<T>(items: readonly T[], call: (item: T) => Promise<unknown>): Promise<unknown[]> {
  const failures: unknown[] = [];
  for (let start = 0; start < items.length; start += SOURCE_CALL_CONCURRENCY) {
    const results = await Promise.allSettled(items.slice(start, start + SOURCE_CALL_CONCURRENCY).map(call));
    for (const result of results) if (result.status === "rejected") failures.push(result.reason);
  }
  return failures;
}

type SourceWebhooksInput = Readonly<{
  endpointId: string;
  automatic: PerSourceWebhookSetup;
  credential: OAuthCredential;
  url: string;
  secret: Secret;
  ctx: OAuthContext;
  fields: LogFields;
}>;

/** Deletes a webhook just created that nothing records, logging rather than throwing a failure. */
async function deleteUnrecordedWebhook(
  { automatic, credential, ctx, fields }: SourceWebhooksInput,
  webhookId: string,
  sourceId: string,
): Promise<void> {
  try {
    await automatic.remove({ credential, webhookId, sourceId }, ctx);
  } catch (removeError) {
    logError("webhook_setup.cleanup_failed", removeError, { ...fields, sourceId });
  }
}

/**
 * Creates one source's webhook and records it at once. A webhook that cannot be recorded (the
 * endpoint reached its limit, or the database failed) is deleted at the provider again, because
 * nothing would delete it on disconnect. So is one for a source that already holds StackDash's
 * webhook when it is recorded (a second setup of the connection raced this one): the source is
 * covered, and only one webhook stays.
 */
async function createSourceWebhook(source: WebhookSource, input: SourceWebhooksInput): Promise<void> {
  const { endpointId, automatic, credential, url, secret, ctx } = input;
  const { webhookId } = await automatic.create({ credential, url, secret, sourceId: source.id }, ctx);
  let recorded: boolean;
  try {
    recorded = await saveCreatedWebhookSource({ endpointId, source, providerWebhookId: webhookId });
  } catch (saveError) {
    await deleteUnrecordedWebhook(input, webhookId, source.id);
    throw saveError;
  }
  if (!recorded) {
    log.info("webhook_setup.source_already_covered", { ...input.fields, sourceId: source.id });
    await deleteUnrecordedWebhook(input, webhookId, source.id);
  }
}

/**
 * Gives each source its webhook. A source that fails is logged and listed without a webhook, so
 * the panel shows it as missing and the next sync tries it again. Returns how many sources now hold
 * a webhook, and the first failure.
 */
async function createSourceWebhooks(sources: readonly WebhookSource[], input: SourceWebhooksInput): Promise<Readonly<{ created: number; failure: unknown }>> {
  const { endpointId, fields } = input;
  const failures = await settleInBatches(sources, async (source) => {
    try {
      await createSourceWebhook(source, input);
    } catch (error) {
      logError("webhook_setup.source_failed", error, { ...fields, sourceId: source.id });
      try {
        await noteSourceWithoutWebhook({ endpointId, source });
      } catch (noteError) {
        logError("webhook_setup.source_note_failed", noteError, { ...fields, sourceId: source.id });
      }
      throw error;
    }
  });
  return { created: sources.length - failures.length, failure: failures[0] };
}

/** Deletes each source's webhook at the provider. Returns the ones still there, and the first failure. */
async function removeSourceWebhooks(
  automatic: PerSourceWebhookSetup,
  credential: OAuthCredential,
  hooks: readonly SourceWebhook[],
  ctx: OAuthContext,
): Promise<Readonly<{ left: SourceWebhook[]; failure: unknown }>> {
  const left: SourceWebhook[] = [];
  const failures = await settleInBatches(hooks, async (hook) => {
    try {
      await automatic.remove({ credential, webhookId: hook.providerWebhookId, sourceId: hook.sourceId }, ctx);
    } catch (error) {
      left.push(hook);
      throw error;
    }
  });
  return { left, failure: failures[0] };
}

type PerSourceTarget = Readonly<{
  workspaceId: string;
  connectionId: string;
  adapter: ProviderAdapter;
  automatic: PerSourceWebhookSetup;
  credential: OAuthCredential;
  accountIds: readonly string[];
  ctx: OAuthContext;
  origin: string;
}>;

/**
 * Automatic setup with one webhook per source. Setup succeeds when at least one webhook exists, or
 * when the connection reads no source yet (the first sync that finds one adds it); when every
 * source fails, the endpoint is deleted again and the first failure is thrown.
 */
async function setUpPerSource({ workspaceId, connectionId, adapter, automatic, credential, accountIds, ctx, origin }: PerSourceTarget): Promise<AutomaticSetupOutcome> {
  const fields = { provider: adapter.id, workspaceId, connectionId };
  const sources = (await automatic.listSources({ credential, externalAccountIds: accountIds }, ctx)).slice(0, WEBHOOK_SOURCES_PER_ENDPOINT);
  const endpointId = randomUUID();
  const secret = newWebhookSecret();
  try {
    await insertWebhookEndpoint({ id: endpointId, workspaceId, connectionId, provider: adapter.id, secret, setup: { mode: "automatic", perSource: true } });
  } catch (error) {
    const outcome = refusal(error);
    if (outcome === null) throw error;
    return outcome;
  }
  const url = webhookUrl(origin, adapter.id, endpointId);
  const { created, failure } = await createSourceWebhooks(sources, { endpointId, automatic, credential, url, secret, ctx, fields });
  if (sources.length > 0 && created === 0) {
    // Not one webhook exists: drop the endpoint, so the panel offers setup again instead of showing
    // an automatic webhook that is not there.
    await deleteWebhookEndpoint(workspaceId, connectionId);
    throw new Error(`No ${adapter.id} webhook could be created.`, { cause: failure });
  }
  log.info("webhook_setup.automatic", { ...fields, endpointId, sources: sources.length, created });
  return { kind: "automatic" };
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
  const refused = await setupRefusal(workspaceId, connectionId, setup.automatic);
  if (refused !== null) return refused;

  const [loaded, accountIds] = await Promise.all([
    loadCredential({ workspaceId, connectionId }),
    includedAccountIds(workspaceId, connectionId),
  ]);
  if (loaded === null) throw new Error("The connection has no stored credential to set up a webhook with.");
  if (setup.automatic.extraPermissions.some((permission) => !loaded.scopes.includes(permission.scope))) {
    return { kind: "write_access_missing" };
  }
  const client = loadOAuthClient(adapter);
  if (client === null) return { kind: "not_configured" };
  const ctx = createOAuthContext(client);
  const credential = await refreshIfExpiring(adapter, loaded, { workspaceId, connectionId }, ctx, refreshDeps);

  const endpointId = randomUUID();
  const input = { credential, url: webhookUrl(origin, adapter.id, endpointId), externalAccountIds: accountIds };
  let created: Readonly<{ webhookId: string; secret: Secret }>;
  let remove: (input: RemoveWebhookInput) => Promise<void>;
  if (setup.secretSource === "stackdash") {
    const automatic = setup.automatic;
    if (automatic.per === "source") {
      return setUpPerSource({ workspaceId, connectionId, adapter, automatic, credential, accountIds, ctx, origin });
    }
    const secret = newWebhookSecret();
    created = { webhookId: (await automatic.create({ ...input, secret }, ctx)).webhookId, secret };
    remove = (removeInput) => automatic.remove(removeInput, ctx);
  } else {
    const automatic = setup.automatic;
    created = await automatic.create(input, ctx);
    remove = (removeInput) => automatic.remove(removeInput, ctx);
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
      await remove({ credential, webhookId: created.webhookId });
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
 * After a successful sync (#428): gives each source the connection now reads a webhook, for a
 * connection whose webhooks were set up automatically per source, so a project added later gets
 * one on the next sync, and a project whose webhook failed before is tried again. A source with
 * StackDash's webhook recorded is left alone, including one the user deleted at the provider since.
 * The URL is built on the instance's public origin, as other work done from a job is
 * (NEXT_PUBLIC_SITE_URL). Returns how many webhooks it created; throws when every one it tried
 * failed. Returns at once, with no query, for a provider without per-source webhooks.
 */
export async function addMissingSourceWebhooks(workspaceId: string, connectionId: string, provider: ProviderId): Promise<number> {
  const adapter = getAdapter(provider);
  const automatic = connectionWebhookSetup(adapter)?.automatic;
  if (automatic?.per !== "source") return 0;
  const setup = await getWebhookEndpointSetup(workspaceId, connectionId);
  if (setup === null || setup.setupMode !== "automatic" || !setup.perSource) return 0;
  // Null when the secret cannot be read, which loadWebhookEndpoint logs: no webhook could verify.
  const endpoint = await loadWebhookEndpoint(setup.id);
  if (endpoint === null) return 0;
  const fields = { provider, workspaceId, connectionId };

  // Usually fresh, since the sync has just refreshed it, but refreshed here too (#496): a sync that
  // read many accounts can leave it close to expiry, and no refresh token is spent outside the lock.
  const [loaded, accountIds, stored] = await Promise.all([
    loadCredential({ workspaceId, connectionId }),
    includedAccountIds(workspaceId, connectionId),
    listWebhookSources(endpoint.id),
  ]);
  if (loaded === null) return 0;
  if (automatic.extraPermissions.some((permission) => !loaded.scopes.includes(permission.scope))) {
    // The write access is gone (a reconnect that gave it up): nothing can be created.
    log.warn("webhook_setup.write_access_gone", fields);
    return 0;
  }
  const client = loadOAuthClient(adapter);
  if (client === null) return 0;
  const ctx = createOAuthContext(client);
  const credential = await refreshIfExpiring(adapter, loaded, { workspaceId, connectionId }, ctx, refreshDeps);

  const known = new Map(stored.map((source) => [source.sourceId, source]));
  let free = WEBHOOK_SOURCES_PER_ENDPOINT - stored.length;
  const missing = (await automatic.listSources({ credential, externalAccountIds: accountIds }, ctx)).filter((source) => {
    const existing = known.get(source.id);
    if (existing !== undefined) return existing.providerWebhookId === null;
    if (free <= 0) return false;
    free -= 1;
    return true;
  });
  if (missing.length === 0) return 0;

  const url = webhookUrl(messageOrigin(), provider, endpoint.id);
  const { created, failure } = await createSourceWebhooks(missing, { endpointId: endpoint.id, automatic, credential, url, secret: endpoint.secret, ctx, fields });
  log.info("webhook_setup.sources_added", { ...fields, missing: missing.length, created });
  if (created === 0) throw new Error(`No new ${provider} webhook could be created.`, { cause: failure });
  return created;
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
  // `left`: the sources whose webhook StackDash created and could not delete (per-source setups).
  | Readonly<{ kind: "failed"; referenceId: string; left: readonly string[] }>;

/**
 * Deletes the endpoint, so a delivery still sent to it is refused like one to an unknown URL, and
 * then deletes the automatic webhook (or every per-source one) at the provider with the credential
 * StackDash still holds, refreshed and saved first when it is about to expire (once for every
 * source). Run it before revoking that credential. A failed refresh or provider call is returned,
 * not thrown: the disconnect goes on and the user is told how to remove the webhook by hand, and
 * for per-source webhooks, where they still are.
 */
export async function removeConnectionWebhook({
  workspaceId,
  connectionId,
  provider,
}: Readonly<{ workspaceId: string; connectionId: string; provider: ProviderId }>): Promise<WebhookRemoval> {
  const removed = await deleteWebhookEndpoint(workspaceId, connectionId);
  if (removed === null) return { kind: "none" };
  if (removed.setupMode === "manual") return { kind: "manual" };
  // A per-source setup that never found a source created nothing to delete.
  if (removed.providerWebhookId === null && removed.sourceWebhooks.length === 0) return { kind: "none" };
  let left = removed.sourceWebhooks;
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
    if (automatic.per === "source") {
      const result = await removeSourceWebhooks(automatic, current, removed.sourceWebhooks, ctx);
      left = result.left;
      if (left.length > 0) {
        throw new Error(`${left.length} of ${removed.sourceWebhooks.length} webhooks could not be deleted.`, { cause: result.failure });
      }
    } else {
      if (removed.providerWebhookId === null) throw new Error(`${provider}'s endpoint names no webhook to delete.`);
      await automatic.remove({ credential: current, webhookId: removed.providerWebhookId }, ctx);
    }
    return { kind: "removed" };
  } catch (error) {
    return {
      kind: "failed",
      referenceId: logError("webhook_setup.remove_failed", error, { provider, workspaceId, connectionId }),
      left: left.map((hook) => hook.name),
    };
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

/** True when the provider keeps one webhook per source, so its webhooks are spoken of in the plural. */
function perSource(provider: ProviderId): boolean {
  try {
    return connectionWebhookSetup(getAdapter(provider))?.automatic?.per === "source";
  } catch (error) {
    log.warn("webhook_setup.adapter_unavailable", { provider, error: error instanceof Error ? error.name : typeof error });
    return false;
  }
}

// The sources a failed disconnect names before it says how many more there are.
const LEFT_NAMED = 3;

/** One or two sentences for the disconnect message, or null when there was no webhook. */
export function webhookRemovalMessage(provider: ProviderId, removal: WebhookRemoval): string | null {
  const name = PROVIDER_NAMES[provider];
  const its = perSource(provider) ? "its webhooks" : "its webhook";
  switch (removal.kind) {
    case "none":
      return null;
    case "removed":
      return `StackDash deleted ${its} in ${name}.`;
    case "manual":
      return `Remove the webhook you added in ${name}: ${webhookRemovalSteps(provider)}`;
    case "failed": {
      const named = removal.left.slice(0, LEFT_NAMED).join(", ");
      const more = removal.left.length - LEFT_NAMED;
      const where =
        removal.left.length === 0 ? "" : ` They are still in ${named}${more > 0 ? ` and ${more} more` : ""}.`;
      return `StackDash could not delete ${its} in ${name} (reference ${removal.referenceId}).${where} ${webhookRemovalSteps(provider)}`;
    }
  }
}
