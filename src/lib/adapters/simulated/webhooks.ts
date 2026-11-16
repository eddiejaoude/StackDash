import { randomBytes, randomUUID } from "node:crypto";

import { Secret, type FullAccessPermission, type LiveProviderId, type WebhookDescriptor } from "@/lib/adapters/types";
import { PROVIDER_NAMES } from "@/lib/providers";
import { hmacHex, readDeliveryId, safeEqual } from "@/lib/webhooks/signature";

/*
 * A per-connection webhook for a simulated provider whose real adapter declares none yet (#426), so
 * the setup panel, its write access consent, and the per-connection URL run end to end in a demo
 * and in e2e. GitLab and Resend declare one in their profiles: they are the providers #424 names
 * for a user-created webhook, one needing write access and one not. #428 (GitLab) and #427
 * (Resend) replace these with the real declarations, which the simulator then forwards.
 *
 * Nothing leaves this process: creating and deleting the webhook only mint and forget an id.
 * Deliveries are signed `sha256=<hex HMAC of "<delivery id>.<raw body>">` in
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
  // Automatic setup needs write access (GitLab) or uses the access already granted (Resend).
  writeAccess: boolean;
  manualSteps: readonly string[];
  removalSteps: readonly string[];
}>;

/** The signature header value for `rawBody` sent with `deliveryId`, as a simulated provider signs it. */
export function simulatedWebhookSignature(secret: Secret, deliveryId: string, rawBody: Uint8Array): string {
  return `sha256=${hmacHex("sha256", secret, Buffer.concat([Buffer.from(`${deliveryId}.`, "utf8"), rawBody]))}`;
}

export function simulatedConnectionWebhooks(provider: LiveProviderId, setup: SimulatedWebhookSetup): WebhookDescriptor {
  const name = PROVIDER_NAMES[provider];
  const extraPermissions: FullAccessPermission[] = setup.writeAccess
    ? [
        {
          scope: SIMULATED_WEBHOOK_WRITE_SCOPE,
          access: "full",
          description: `Simulated. Lets StackDash add and delete webhooks in ${name}, as ${name}'s write access would. No ${name} account is changed.`,
          fullAccessReason: `Simulated. ${name} has no read-only access that can create a webhook.`,
        },
      ]
    : [];
  return {
    registration: {
      kind: "connection",
      setup: {
        secretSource: setup.secretSource,
        manualSteps: setup.manualSteps,
        removalSteps: setup.removalSteps,
        automatic: {
          extraPermissions,
          async create() {
            return {
              webhookId: `simulated-webhook-${randomUUID()}`,
              // The provider's own secret where it makes one, shaped like Svix's.
              ...(setup.secretSource === "provider" ? { secret: new Secret(`whsec_${randomBytes(24).toString("base64")}`) } : {}),
            };
          },
          // Nothing exists outside this process, so there is nothing to delete.
          async remove() {},
        },
      },
    },
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
