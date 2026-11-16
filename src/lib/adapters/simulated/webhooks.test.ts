import { describe, expect, it } from "vitest";

import { gitlabAdapter, GITLAB_TOKEN_HEADER } from "@/lib/adapters/gitlab";
import { checkAdapterDeclaration } from "@/lib/adapters/harness";
import { resendAdapter } from "@/lib/adapters/resend";
import { Secret, type OAuthContext, type WebhookDescriptor } from "@/lib/adapters/types";

import { simulatedAdapters } from "./index";
import { SIMULATED_SCOPE, simulatedCredentialMetadata } from "./marker";
import { SIMULATED_WEBHOOK_WRITE_SCOPE } from "./webhooks";

/*
 * Per-connection webhooks of simulated providers (#426): the live declaration each twin forwards,
 * GitLab's one webhook per project (#428) and Resend's one per connection (#427), with automatic
 * setup kept in this process.
 */

const NOW = new Date("2026-11-16T09:00:00.000Z");
const SECRET = new Secret("simulated-webhook-secret");
const body = new TextEncoder().encode(JSON.stringify({ test: true }));

const oauthCtx: OAuthContext = {
  fetch: () => Promise.reject(new Error("no network in tests")),
  now: () => NOW,
  timeoutMs: 1000,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  client: { clientId: "simulated", clientSecret: new Secret("simulated"), extra: {} },
};

function setupOf(descriptor: WebhookDescriptor | undefined) {
  const registration = descriptor?.registration;
  if (registration?.kind !== "connection") throw new Error("expected a per-connection webhook");
  return registration.setup;
}

describe("simulated connection webhooks (#426)", () => {
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
    // A grant minted with seed 12345678, whose one account is the group 305419896 (0x12345678).
    const credential = { accessToken: new Secret("simulated-at"), scopes: [SIMULATED_SCOPE], tokenType: "bearer", metadata: simulatedCredentialMetadata("12345678") };

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

    it("lists the profile's projects of the grant's account and mints a webhook per project without calling GitLab", async () => {
      const automatic = setup.automatic;
      if (automatic?.per !== "source") throw new Error("expected one webhook per project");
      const accountId = "305419896";
      const sources = await automatic.listSources({ credential, externalAccountIds: [accountId] }, oauthCtx);
      expect(sources.map((source) => source.name)).toEqual(["example-group/web", "example-group/api", "example-group/docs"]);
      expect(await automatic.listSources({ credential, externalAccountIds: [] }, oauthCtx)).toEqual([]);
      // The account of an earlier grant, which a reconnect replaced, has no projects (boundary).
      expect(await automatic.listSources({ credential, externalAccountIds: [accountId, "1"] }, oauthCtx)).toEqual(sources);
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

  it("gives Resend's twin the live steps, with create and delete never leaving the process", async () => {
    const live = resendAdapter.webhooks;
    const twin = simulatedAdapters.resend.webhooks;
    if (live === undefined || twin === undefined) throw new Error("expected Resend webhooks");
    const liveSetup = setupOf(live);
    const twinSetup = setupOf(twin);
    expect(twinSetup.manualSteps).toEqual(liveSetup.manualSteps);
    expect(twinSetup.removalSteps).toEqual(liveSetup.removalSteps);
    expect(twinSetup.secretSource).toBe("provider");
    if (twinSetup.secretSource !== "provider") return;
    // oauthCtx.fetch rejects: a call to Resend would fail the create.
    const credential = { accessToken: new Secret("simulated-at"), scopes: [], tokenType: "bearer" };
    const created = await twinSetup.automatic?.create({ credential, url: "http://localhost/api/webhooks/resend/id", externalAccountIds: [] }, oauthCtx);
    expect(created?.webhookId).toMatch(/^simulated-webhook-/);
    await expect(twinSetup.automatic?.remove({ credential, webhookId: created?.webhookId ?? "" }, oauthCtx)).resolves.toBeUndefined();
  });
});
