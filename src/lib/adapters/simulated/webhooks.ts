import { randomBytes, randomUUID } from "node:crypto";

import {
  Secret,
  type ConnectionWebhookSetup,
  type FullAccessPermission,
  type LiveProviderId,
  type WebhookDescriptor,
} from "@/lib/adapters/types";
import { PROVIDER_NAMES } from "@/lib/providers";
import { hmacHex, readDeliveryId, safeEqual } from "@/lib/webhooks/signature";

/*
 * Per-connection webhooks for simulated providers (#426), so the setup panel, its write access
 * consent, and the per-connection URL run end to end in a demo and in e2e.
 * - A live adapter that declares one (Resend, #427) keeps its steps, secret source, `verify`, and
 *   `parse` in its twin; only automatic setup's create and delete are swapped for the in-process
 *   ones below (`simulatedConnectionSetup`), so a twin never calls the provider.
 * - A provider whose live adapter declares none yet carries one in its profile
 *   (`simulatedConnectionWebhooks`): GitLab, until #428. Its deliveries are signed
 *   `sha256=<hex HMAC of "<delivery id>.<raw body>">` in SIMULATED_SIGNATURE_HEADER, so a captured
 *   delivery replayed under a new id fails, and are ignored once verified: a simulated provider's
 *   events come from its sync, and a delivery only shows on the panel as the last one received.
 *
 * Nothing leaves this process: creating and deleting the webhook only mint and forget an id.
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

type SetupSteps = Pick<ConnectionWebhookSetup, "manualSteps" | "removalSteps">;

/** Automatic setup kept in this process, with the simulated write scope where the live one needs write access. */
function inProcessSetup(provider: LiveProviderId, steps: SetupSteps, secretSource: "stackdash" | "provider", writeAccess: boolean): ConnectionWebhookSetup {
  const name = PROVIDER_NAMES[provider];
  const extraPermissions: FullAccessPermission[] = writeAccess
    ? [
        {
          scope: SIMULATED_WEBHOOK_WRITE_SCOPE,
          access: "full",
          description: `Simulated. Lets StackDash add and delete webhooks in ${name}, as ${name}'s write access would. No ${name} account is changed.`,
          fullAccessReason: `Simulated. ${name} has no read-only access that can create a webhook.`,
        },
      ]
    : [];
  const { manualSteps, removalSteps } = steps;
  const newWebhookId = () => `simulated-webhook-${randomUUID()}`;
  // Nothing exists outside this process, so there is nothing to delete.
  const remove = async () => {};
  return secretSource === "stackdash"
    ? { manualSteps, removalSteps, secretSource, automatic: { extraPermissions, create: async () => ({ webhookId: newWebhookId() }), remove } }
    : {
        manualSteps,
        removalSteps,
        secretSource,
        automatic: {
          extraPermissions,
          // The provider's own secret, shaped like Svix's: 24 random bytes after `whsec_`.
          create: async () => ({ webhookId: newWebhookId(), secret: new Secret(`whsec_${randomBytes(24).toString("base64")}`) }),
          remove,
        },
      };
}

/**
 * A live adapter's per-connection setup for its twin: the same steps and secret source, with
 * automatic setup's create and delete kept in this process. Needing write access in the live
 * adapter means needing the simulated write scope in the twin.
 */
export function simulatedConnectionSetup(provider: LiveProviderId, setup: ConnectionWebhookSetup): ConnectionWebhookSetup {
  if (setup.automatic === undefined) return setup;
  return inProcessSetup(provider, setup, setup.secretSource, setup.automatic.extraPermissions.length > 0);
}

export function simulatedConnectionWebhooks(provider: LiveProviderId, setup: SimulatedWebhookSetup): WebhookDescriptor {
  return {
    registration: { kind: "connection", setup: inProcessSetup(provider, setup, setup.secretSource, setup.writeAccess) },
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
