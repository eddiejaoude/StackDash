import { describe, expect, it } from "vitest";

import { checkAdapterDeclaration } from "@/lib/adapters/harness";
import { Secret, type OAuthContext, type WebhookDescriptor } from "@/lib/adapters/types";

import { simulatedAdapters } from "./index";
import {
  SIMULATED_DELIVERY_HEADER,
  SIMULATED_SIGNATURE_HEADER,
  SIMULATED_WEBHOOK_WRITE_SCOPE,
  simulatedConnectionWebhooks,
  simulatedWebhookSignature,
} from "./webhooks";

/*
 * The simulated per-connection webhook (#426) that GitLab's and Resend's twins carry until their
 * live adapters declare one (#428, #427).
 */

const NOW = new Date("2026-11-16T09:00:00.000Z");
const SECRET = new Secret("simulated-webhook-secret");
const body = new TextEncoder().encode(JSON.stringify({ test: true }));

const gitlab = simulatedConnectionWebhooks("gitlab", {
  subscriptions: ["Pipeline Hook"],
  secretSource: "stackdash",
  writeAccess: true,
  manualSteps: ["Add it."],
  removalSteps: ["Delete it."],
});

const oauthCtx: OAuthContext = {
  fetch: () => Promise.reject(new Error("no network in tests")),
  now: () => NOW,
  timeoutMs: 1000,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  client: { clientId: "simulated", clientSecret: new Secret("simulated"), extra: {} },
};

function signed(deliveryId: string, signature = simulatedWebhookSignature(SECRET, deliveryId, body)) {
  return { headers: new Headers({ [SIMULATED_DELIVERY_HEADER]: deliveryId, [SIMULATED_SIGNATURE_HEADER]: signature }), rawBody: body };
}

function setupOf(descriptor: WebhookDescriptor | undefined) {
  const registration = descriptor?.registration;
  if (registration?.kind !== "connection") throw new Error("expected a per-connection webhook");
  return registration.setup;
}

describe("simulated connection webhooks (#426)", () => {
  it("accepts a delivery signed with the endpoint's secret and ignores it once verified", () => {
    expect(gitlab.verify(signed("delivery-1"), SECRET, NOW)).toEqual({ ok: true, deliveryId: "delivery-1" });
    expect(gitlab.parse(signed("delivery-1"), oauthCtx)).toEqual({ kind: "ignored", reason: "simulated test delivery" });
  });

  it.each([
    ["no signature", { headers: new Headers({ [SIMULATED_DELIVERY_HEADER]: "delivery-1" }), rawBody: body }, "missing_signature"],
    ["no delivery id", { headers: new Headers({ [SIMULATED_SIGNATURE_HEADER]: "sha256=00" }), rawBody: body }, "malformed"],
    ["a delivery id longer than 200 characters", signed("d".repeat(201)), "malformed"],
    ["another secret's signature", signed("delivery-1", simulatedWebhookSignature(new Secret("other"), "delivery-1", body)), "bad_signature"],
    ["a captured delivery replayed under a new id", signed("delivery-2", simulatedWebhookSignature(SECRET, "delivery-1", body)), "bad_signature"],
  ] as const)("refuses %s (boundary)", (_case, request, reason) => {
    expect(gitlab.verify(request, SECRET, NOW)).toEqual({ ok: false, reason });
  });

  it("asks for the simulated write scope only where automatic setup needs write access", () => {
    expect(setupOf(simulatedAdapters.gitlab.webhooks).automatic?.extraPermissions.map((permission) => permission.scope)).toEqual([
      SIMULATED_WEBHOOK_WRITE_SCOPE,
    ]);
    expect(setupOf(simulatedAdapters.resend.webhooks).automatic?.extraPermissions).toEqual([]);
  });

  it("returns the provider's signing secret from automatic setup only where the provider generates it", async () => {
    const credential = { accessToken: new Secret("simulated-at"), scopes: [], tokenType: "bearer" };
    const input = { credential, url: "http://localhost/api/webhooks/resend/id", secret: SECRET, externalAccountIds: [] };
    const resend = await setupOf(simulatedAdapters.resend.webhooks).automatic?.create(input, oauthCtx);
    expect(resend?.secret?.reveal()).toMatch(/^whsec_/);
    const gitlabCreated = await setupOf(simulatedAdapters.gitlab.webhooks).automatic?.create(input, oauthCtx);
    expect(gitlabCreated?.secret).toBeUndefined();
    expect(gitlabCreated?.webhookId).not.toBe(resend?.webhookId);
  });

  it.each(["gitlab", "resend"] as const)("passes the adapter declaration checks for simulated %s", (id) => {
    expect(checkAdapterDeclaration(simulatedAdapters[id])).toEqual([]);
  });
});
