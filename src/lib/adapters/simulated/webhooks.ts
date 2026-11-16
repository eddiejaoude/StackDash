import { randomBytes, randomUUID } from "node:crypto";

import {
  Secret,
  type ConnectionWebhookSetup,
  type FullAccessPermission,
  type LiveProviderId,
  type WebhookDescriptor,
  type WebhookSource,
} from "@/lib/adapters/types";
import { PROVIDER_NAMES } from "@/lib/providers";
import { hmacHex, readDeliveryId, safeEqual } from "@/lib/webhooks/signature";

/*
 * Per-connection webhooks for simulated providers (#426), so the setup panel, its write access
 * consent, and the per-connection URL run end to end in a demo and in e2e. Two shapes:
 * - `simulatedConnectionSetup`: the live adapter declares a per-connection webhook (GitLab, #428).
 *   The twin keeps the live steps, secret source, `verify`, and `parse`, so a delivery posted to it
 *   runs through the real code; only automatic setup is simulated.
 * - `simulatedConnectionWebhooks`: a profile declares one where the live adapter has none yet
 *   (Resend, until #427), with its own signing scheme below.
 *
 * Nothing leaves this process: creating and deleting a webhook only mint and forget an id. The
 * profile's own deliveries are signed `sha256=<hex HMAC of "<delivery id>.<raw body>">` in
 * SIMULATED_SIGNATURE_HEADER, so a captured delivery replayed under a new id fails, and are
 * ignored once verified: a simulated provider's events come from its sync, and a delivery only
 * shows on the panel as the last one received.
 */

export const SIMULATED_WEBHOOK_WRITE_SCOPE = "simulated:webhooks:write";
export const SIMULATED_SIGNATURE_HEADER = "x-simulated-signature";
export const SIMULATED_DELIVERY_HEADER = "x-simulated-delivery";

export type SimulatedWebhookSetup = Readonly<{
  subscriptions: readonly string[];
  secretSource: "stackdash" | "provider";
  // Automatic setup needs write access or uses the access already granted (Resend).
  writeAccess: boolean;
  manualSteps: readonly string[];
  removalSteps: readonly string[];
}>;

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
// A webhook with the provider's own secret, shaped like Svix's.
const mintWithProviderSecret = async () => ({ webhookId: newWebhookId(), secret: new Secret(`whsec_${randomBytes(24).toString("base64")}`) });
// Nothing exists outside this process, so there is nothing to delete.
const removeNothing = async () => {};

/**
 * A twin's copy of the live adapter's per-connection setup: automatic setup mints ids in this
 * process, asks for the simulated write scope where the live one asks for write access, and for a
 * per-source setup lists the profile's `webhookSources` of each included account.
 */
export function simulatedConnectionSetup(
  provider: LiveProviderId,
  live: ConnectionWebhookSetup,
  sources: ((accountId: string) => readonly WebhookSource[]) | undefined,
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
      listSources: async ({ externalAccountIds }) => externalAccountIds.flatMap((accountId) => sources?.(accountId) ?? []),
      create: async () => ({ webhookId: newWebhookId() }),
      remove: removeNothing,
    },
  };
}

/** The signature header value for `rawBody` sent with `deliveryId`, as a simulated provider signs it. */
export function simulatedWebhookSignature(secret: Secret, deliveryId: string, rawBody: Uint8Array): string {
  return `sha256=${hmacHex("sha256", secret, Buffer.concat([Buffer.from(`${deliveryId}.`, "utf8"), rawBody]))}`;
}

export function simulatedConnectionWebhooks(provider: LiveProviderId, setup: SimulatedWebhookSetup): WebhookDescriptor {
  const extraPermissions: FullAccessPermission[] = setup.writeAccess ? [simulatedWritePermission(provider)] : [];
  const steps = { manualSteps: setup.manualSteps, removalSteps: setup.removalSteps };
  const connectionSetup: ConnectionWebhookSetup =
    setup.secretSource === "stackdash"
      ? { ...steps, secretSource: "stackdash", automatic: { extraPermissions, create: async () => ({ webhookId: newWebhookId() }), remove: removeNothing } }
      : { ...steps, secretSource: "provider", automatic: { extraPermissions, create: mintWithProviderSecret, remove: removeNothing } };
  return {
    registration: { kind: "connection", setup: connectionSetup },
    subscriptions: setup.subscriptions,
    verify({ headers, rawBody }, secret) {
      const signature = headers.get(SIMULATED_SIGNATURE_HEADER);
      if (signature === null) return { ok: false, reason: "missing_signature" };
      const deliveryId = readDeliveryId(headers, SIMULATED_DELIVERY_HEADER);
      if (deliveryId === undefined) return { ok: false, reason: "malformed" };
      return safeEqual(signature, simulatedWebhookSignature(secret, deliveryId, rawBody))
        ? { ok: true, deliveryId }
        : { ok: false, reason: "bad_signature" };
    },
    parse() {
      return { kind: "ignored", reason: "simulated test delivery" };
    },
  };
}
