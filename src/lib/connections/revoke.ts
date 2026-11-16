import "server-only";

import { createOAuthContext, getAdapter, loadOAuthClient } from "@/lib/adapters/registry";
import type { ProviderId } from "@/lib/adapters/types";
import { deleteCredential, loadCredential } from "@/lib/data/credentials";
import { logError } from "@/lib/log/logger";
import { PROVIDER_NAMES } from "@/lib/providers";
import { createAdminClient } from "@/lib/supabase/admin";

import { removeConnectionWebhook, type WebhookRemoval } from "./webhook-setup";

/*
 * Removing StackDash's access at a provider, shared by disconnect and delete connection (#40) and
 * account deletion (#42). Callers authorize the user for the connection's workspace first.
 */

/**
 * What happened at the provider. `revoked` also covers "nothing stored to revoke". Every other
 * outcome leaves a manual step for the user, from `manualRevokeMessage`.
 */
export type RevokeOutcome =
  | { kind: "revoked" }
  | { kind: "unsupported" }
  | { kind: "not_configured" }
  | { kind: "failed"; referenceId: string };

// Where to remove StackDash's access by hand, from docs/providers/*.md. Providers not listed get the
// generic account settings wording.
const MANUAL_REVOKE_STEPS: Partial<Record<ProviderId, string>> = {
  vercel:
    "In the Vercel dashboard, open Integrations, choose Manage next to StackDash, open Settings, and choose Uninstall Integration.",
  github:
    "Uninstall the StackDash GitHub App at github.com/settings/installations, or for an organization in the organization's settings under GitHub Apps.",
  stripe:
    "In the Stripe Dashboard, open Settings, then Installed apps, open the StackDash app menu, and choose Uninstall. Only an administrator of the Stripe account can do this.",
  gitlab:
    "In GitLab, select your avatar, then Edit profile, then Access, then Applications, and under Authorized applications choose Revoke next to StackDash.",
  resend: "In your Resend team settings, revoke StackDash's access.",
  sentry: "In Sentry, open Settings, then Integrations, choose StackDash, and choose Uninstall.",
};

/** The steps that remove StackDash's access at the provider by hand. */
export function manualRevokeStep(provider: ProviderId): string {
  return MANUAL_REVOKE_STEPS[provider] ?? `Remove StackDash's access in your ${PROVIDER_NAMES[provider]} account settings.`;
}

/** True when StackDash can ask the provider to revoke its own access. */
export function supportsRevoke(provider: ProviderId): boolean {
  try {
    return getAdapter(provider).revoke !== undefined;
  } catch {
    // The fake provider is disabled on this instance: nothing can call it.
    return false;
  }
}

/**
 * Revokes the grant at the provider where it supports that. Never throws: a failed revoke must not
 * stop the local credential from being deleted. Failures are logged under the returned reference.
 */
export async function revokeAtProvider(
  workspaceId: string,
  connectionId: string,
  provider: ProviderId,
): Promise<RevokeOutcome> {
  try {
    const adapter = getAdapter(provider);
    if (adapter.revoke === undefined) return { kind: "unsupported" };
    const credential = await loadCredential({ workspaceId, connectionId });
    if (credential === null) return { kind: "revoked" };
    const client = loadOAuthClient(adapter);
    if (client === null) return { kind: "not_configured" };
    await adapter.revoke(credential, createOAuthContext(client));
    return { kind: "revoked" };
  } catch (error) {
    return { kind: "failed", referenceId: logError("connections.revoke_failed", error, { provider }) };
  }
}

/** The manual step left after `outcome`, as one sentence pair, or null when nothing is left to do. */
export function manualRevokeMessage(provider: ProviderId, outcome: RevokeOutcome): string | null {
  const name = PROVIDER_NAMES[provider];
  const step = manualRevokeStep(provider);
  switch (outcome.kind) {
    case "revoked":
      return null;
    case "unsupported":
      return `${name} does not let apps revoke their own access. ${step}`;
    case "not_configured":
      return `${name} is no longer set up on this instance, so StackDash could not revoke access. ${step}`;
    case "failed":
      return `StackDash could not revoke access at ${name} (reference ${outcome.referenceId}). ${step}`;
  }
}

export type DisconnectOutcome = Readonly<{ revoke: RevokeOutcome; webhook: WebhookRemoval }>;

/**
 * Deletes the connection's webhook (#426), revokes where possible, deletes the stored credential,
 * and marks the connection disconnected. The caller must have authorized `userId` to manage
 * connections in `workspaceId`. A failed webhook deletion or revoke is returned, not thrown; a
 * failed endpoint delete, credential delete, or status write throws.
 */
export async function disconnectConnection({
  workspaceId,
  connectionId,
  provider,
  userId,
}: Readonly<{ workspaceId: string; connectionId: string; provider: ProviderId; userId: string }>): Promise<DisconnectOutcome> {
  // First: deleting a webhook StackDash created needs the credential the revoke ends.
  const webhook = await removeConnectionWebhook({ workspaceId, connectionId, provider });
  const revoke = await revokeAtProvider(workspaceId, connectionId, provider);
  await deleteCredential({ workspaceId, connectionId });
  // Status and schedule are server-written columns; the caller was authorized above.
  const { error } = await createAdminClient()
    .from("connections")
    .update({ status: "revoked", next_sync_at: null, updated_by: userId })
    .eq("workspace_id", workspaceId)
    .eq("id", connectionId);
  if (error) throw new Error(`Disconnect status update failed (code ${error.code}).`);
  return { revoke, webhook };
}
