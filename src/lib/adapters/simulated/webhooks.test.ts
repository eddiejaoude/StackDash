import { describe, expect, it } from "vitest";

import { gitlabAdapter, GITLAB_TOKEN_HEADER } from "@/lib/adapters/gitlab";
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
 * Per-connection webhooks of simulated providers (#426): the one a profile declares where the live
 * adapter has none yet (Resend until #427, and the scheme of `simulatedConnectionWebhooks`), and
 * the live adapter's own forwarded with its automatic setup simulated (GitLab, #428).
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

  it("returns the provider's signing secret from automatic setup where the provider generates it", async () => {
    const credential = { accessToken: new Secret("simulated-at"), scopes: [], tokenType: "bearer" };
    const input = { credential, url: "http://localhost/api/webhooks/resend/id", externalAccountIds: [] };
    const resendSetup = setupOf(simulatedAdapters.resend.webhooks);
    if (resendSetup.secretSource !== "provider") throw new Error("unexpected secret source");
    const first = await resendSetup.automatic?.create(input, oauthCtx);
    const second = await resendSetup.automatic?.create(input, oauthCtx);
    expect(first?.secret.reveal()).toMatch(/^whsec_/);
    expect(first?.webhookId).not.toBe(second?.webhookId);
  });

  describe("the GitLab twin (#428)", () => {
    const twin = simulatedAdapters.gitlab.webhooks;
    const setup = setupOf(twin);
    const live = setupOf(gitlabAdapter.webhooks);
    const credential = { accessToken: new Secret("simulated-at"), scopes: [], tokenType: "bearer" };

    it("keeps the live steps, secret source, verify, and parse, so a delivery runs through the real code", () => {
      expect(setup.manualSteps).toEqual(live.manualSteps);
      expect(setup.removalSteps).toEqual(live.removalSteps);
      expect(setup.secretSource).toBe("stackdash");
      expect(setup.sourceNoun).toEqual(live.sourceNoun);
      expect(twin?.verify).toBe(gitlabAdapter.webhooks?.verify);
      expect(twin?.parse).toBe(gitlabAdapter.webhooks?.parse);
      const request = { headers: new Headers({ [GITLAB_TOKEN_HEADER]: SECRET.reveal(), "webhook-id": "delivery-1" }), rawBody: body };
      expect(twin?.verify(request, SECRET, NOW)).toEqual({ ok: true, deliveryId: "delivery-1" });
    });

    it("lists the profile's projects of each account and mints a webhook per project without calling GitLab", async () => {
      const automatic = setup.automatic;
      if (automatic?.per !== "source") throw new Error("expected one webhook per project");
      const accountId = "305419896";
      const sources = await automatic.listSources({ credential, externalAccountIds: [accountId] }, oauthCtx);
      expect(sources.map((source) => source.name)).toEqual(["example-group/web", "example-group/api", "example-group/docs"]);
      expect(await automatic.listSources({ credential, externalAccountIds: [] }, oauthCtx)).toEqual([]);
      const [first, second] = await Promise.all(
        sources.slice(0, 2).map((source) => automatic.create({ credential, url: "http://localhost/hook", secret: SECRET, sourceId: source.id }, oauthCtx)),
      );
      expect(first?.webhookId).toMatch(/^simulated-webhook-/);
      expect(first?.webhookId).not.toBe(second?.webhookId);
      await expect(automatic.remove({ credential, webhookId: first?.webhookId ?? "", sourceId: "1" }, oauthCtx)).resolves.toBeUndefined();
    });
  });

  it.each(["gitlab", "resend"] as const)("passes the adapter declaration checks for simulated %s", (id) => {
    expect(checkAdapterDeclaration(simulatedAdapters[id])).toEqual([]);
  });
});
