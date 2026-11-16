import { randomBytes, randomUUID } from "node:crypto";

import {
  Secret,
  type ConnectionWebhookSetup,
  type FullAccessPermission,
  type LiveProviderId,
  type OAuthCredential,
  type WebhookSource,
} from "@/lib/adapters/types";
import { PROVIDER_NAMES } from "@/lib/providers";

/*
 * Per-connection webhooks for simulated providers (#426), so the setup panel, its write access
 * consent, and the per-connection URL run end to end in a demo and in e2e. A live adapter that
 * declares one (GitLab #428, Resend #427) keeps its steps, secret source, `verify`, and `parse` in
 * its twin, so a delivery posted to the twin runs through the real code; only automatic setup is
 * swapped for the in-process one below (`simulatedConnectionSetup`), so a twin never calls the
 * provider. Nothing leaves this process: creating and deleting a webhook only mint and forget an id.
 */

export const SIMULATED_WEBHOOK_WRITE_SCOPE = "simulated:webhooks:write";

function simulatedWritePermission(provider: LiveProviderId): FullAccessPermission {
  const name = PROVIDER_NAMES[provider];
  return {
    scope: SIMULATED_WEBHOOK_WRITE_SCOPE,
    access: "full",
    description: `Simulated. Lets StackDash add and delete webhooks in ${name}, as ${name}'s write access would. No ${name} account is changed.`,
    fullAccessReason: `Simulated. ${name} has no read-only access that can create a webhook.`,
  };
}

const newWebhookId = () => `simulated-webhook-${randomUUID()}`;
// A webhook with the provider's own secret, shaped like Svix's: 24 random bytes after `whsec_`.
const mintWithProviderSecret = async () => ({ webhookId: newWebhookId(), secret: new Secret(`whsec_${randomBytes(24).toString("base64")}`) });
// Nothing exists outside this process, so there is nothing to delete.
const removeNothing = async () => {};

/**
 * A twin's copy of the live adapter's per-connection setup: automatic setup mints ids in this
 * process, asks for the simulated write scope where the live one asks for write access, and for a
 * per-source setup lists the sources `sources` gives for the credential and the included accounts.
 */
export function simulatedConnectionSetup(
  provider: LiveProviderId,
  live: ConnectionWebhookSetup,
  sources: ((credential: OAuthCredential, accountIds: readonly string[]) => readonly WebhookSource[]) | undefined,
): ConnectionWebhookSetup {
  const extraPermissions = (live.automatic?.extraPermissions.length ?? 0) > 0 ? [simulatedWritePermission(provider)] : [];
  if (live.secretSource === "provider") {
    return live.automatic === undefined
      ? live
      : { ...live, automatic: { extraPermissions, create: mintWithProviderSecret, remove: removeNothing } };
  }
  if (live.automatic === undefined) return live;
  if (live.automatic.per !== "source") {
    return { ...live, automatic: { extraPermissions, create: async () => ({ webhookId: newWebhookId() }), remove: removeNothing } };
  }
  return {
    ...live,
    automatic: {
      per: "source",
      extraPermissions,
      listSources: async ({ credential, externalAccountIds }) => [...(sources?.(credential, externalAccountIds) ?? [])],
      create: async () => ({ webhookId: newWebhookId() }),
      remove: removeNothing,
    },
  };
}
