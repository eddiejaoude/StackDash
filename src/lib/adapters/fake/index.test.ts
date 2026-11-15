import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { validateAdapterEvents } from "@/lib/adapters/events";
import { checkWebhookOutcome } from "@/lib/adapters/harness";
import { validateAdapterMetrics, type AdapterMetric } from "@/lib/adapters/metrics";
import {
  Secret,
  type OAuthContext,
  type OAuthCredential,
  type WebhookDescriptor,
  type WebhookRequest,
} from "@/lib/adapters/types";

import {
  FAKE_EVENT_WINDOW_DAYS,
  FAKE_WEBHOOK_HEADERS,
  FAKE_WEBHOOK_SECRET_ENV,
  FAKE_WEBHOOK_TOLERANCE_SECONDS,
  fakeAdapter,
  signFakeWebhook,
  type FakeMode,
} from "./index";

// The fake provider has no documentation page and no recorded payloads: every value below is
// derived in code from the fixed clock, so there are no fixture files.

const REDIRECT_URI = "http://localhost:3000/api/connections/fake/callback";
const OCT_2_AFTERNOON = new Date("2026-10-02T15:00:00.000Z");

function makeCtx(now: Date = OCT_2_AFTERNOON): OAuthContext {
  return {
    // Any call fails the test: the fake provider must never reach the network.
    fetch: vi.fn(() => Promise.reject(new Error("network is not allowed in fake adapter tests"))),
    now: () => now,
    timeoutMs: 5000,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    client: { clientId: "fake-client", clientSecret: new Secret("fake-client-secret"), extra: {} },
  };
}

async function connect(callbackParams: Record<string, string> = {}, ctx = makeCtx()): Promise<OAuthCredential> {
  return fakeAdapter.exchangeCode(
    { code: "fake-0b6a6f1e", redirectUri: REDIRECT_URI, callbackParams },
    ctx,
  );
}

function metricByKey(metrics: readonly AdapterMetric[], key: string): AdapterMetric {
  const metric = metrics.find((candidate) => candidate.metricKey === key);
  if (metric === undefined) throw new Error(`metric ${key} missing`);
  return metric;
}

const globalFetch = vi.fn(() => Promise.reject(new Error("network is not allowed in fake adapter tests")));

beforeEach(() => {
  vi.stubGlobal("fetch", globalFetch);
});

afterEach(() => {
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  globalFetch.mockClear();
});

describe("fakeAdapter declaration", () => {
  it("declares the example provider with a read scope, an optional full scope, and hourly polling", () => {
    expect(fakeAdapter.id).toBe("fake");
    expect(fakeAdapter.displayName).toBe("Example provider");
    expect(fakeAdapter.pollIntervalSeconds).toBe(3600);
    expect(fakeAdapter.permissions.map(({ scope, access }) => [scope, access])).toEqual([
      ["usage:read", "read"],
      ["admin", "full"],
    ]);
    expect(fakeAdapter.eventTypes.map((eventType) => eventType.id)).toEqual(["fake.deploy.succeeded", "fake.signup"]);
  });
});

describe("buildAuthorizeUrl", () => {
  it("points at the dev consent route on the redirect URI's origin with state, redirect, and scopes", () => {
    const url = fakeAdapter.buildAuthorizeUrl({
      client: makeCtx().client,
      state: "state-123",
      redirectUri: REDIRECT_URI,
    });
    expect(url.origin).toBe("http://localhost:3000");
    expect(url.pathname).toBe("/api/dev/fake-provider/authorize");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(url.searchParams.get("scope")).toBe("usage:read admin");
    expect(url.searchParams.has("code_challenge")).toBe(false);
  });
});

describe("exchangeCode", () => {
  it("grants every scope, a refresh token, and a one hour expiry without a network call", async () => {
    const ctx = makeCtx();
    const credential = await connect({}, ctx);
    expect(credential.scopes).toEqual(["usage:read", "admin"]);
    expect(credential.refreshToken).toBeInstanceOf(Secret);
    expect(credential.expiresAt).toEqual(new Date("2026-10-02T16:00:00.000Z"));
    expect(credential.metadata).toEqual({ mode: "ok" });
    expect(credential.tokenType).toBe("bearer");
    expect(ctx.fetch).not.toHaveBeenCalled();
  });

  it("keeps tokens out of serialization", async () => {
    const credential = await connect();
    const serialized = JSON.stringify(credential);
    expect(serialized).not.toContain(credential.accessToken.reveal());
    expect(serialized).toContain("[redacted]");
  });

  it.each([
    ["one scope declined", "admin", ["admin"]],
    ["unknown scopes dropped", "usage:read bogus admin", ["usage:read", "admin"]],
    ["extra whitespace", "  usage:read   ", ["usage:read"]],
    ["empty granted_scope means nothing granted", "", []],
  ])("reads granted_scope from the callback (%s)", async (_title, grantedScope, expected) => {
    const credential = await connect({ granted_scope: grantedScope });
    expect(credential.scopes).toEqual(expected);
  });

  it("records the callback mode in the credential metadata", async () => {
    const credential = await connect({ mode: "rate_limited" });
    expect(credential.metadata).toEqual({ mode: "rate_limited" });
  });

  it.each([
    ["code without the fake- prefix", "abc123", {}],
    ["code that is only the prefix", "fake-", {}],
    ["unknown mode", "fake-1", { mode: "explode" }],
  ])("rejects %s as invalid_response", async (_title, code, callbackParams) => {
    await expect(
      fakeAdapter.exchangeCode({ code, redirectUri: REDIRECT_URI, callbackParams }, makeCtx()),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("refreshTokens", () => {
  it("rotates both tokens and resets the expiry, keeping scopes and mode", async () => {
    const credential = await connect({ granted_scope: "usage:read" });
    const later = new Date("2026-10-02T18:00:00.000Z");
    const refreshed = await fakeAdapter.refreshTokens?.(credential, makeCtx(later));
    if (refreshed === undefined) throw new Error("fake adapter must support refresh");
    expect(refreshed.accessToken.reveal()).not.toBe(credential.accessToken.reveal());
    expect(refreshed.refreshToken?.reveal()).not.toBe(credential.refreshToken?.reveal());
    expect(refreshed.expiresAt).toEqual(new Date("2026-10-02T19:00:00.000Z"));
    expect(refreshed.scopes).toEqual(["usage:read"]);
    expect(refreshed.metadata).toEqual({ mode: "ok" });
  });

  it("treats a credential without a refresh token as revoked", async () => {
    const { refreshToken: _dropped, ...withoutRefresh } = await connect();
    await expect(fakeAdapter.refreshTokens?.(withoutRefresh, makeCtx())).rejects.toMatchObject({
      code: "auth_revoked",
    });
  });
});

describe("listAccounts", () => {
  it("returns the two example teams, even in a failure mode so the connection can be created", async () => {
    const expected = [
      { externalId: "fake-acct-1", displayName: "Example team", kind: "team" },
      { externalId: "fake-acct-2", displayName: "Example sandbox", kind: "team" },
    ];
    expect(await fakeAdapter.listAccounts(await connect(), makeCtx())).toEqual(expected);
    expect(await fakeAdapter.listAccounts(await connect({ mode: "revoked" }), makeCtx())).toEqual(expected);
  });
});

describe("detectMissingPermissions", () => {
  it.each([
    ["everything granted", ["usage:read", "admin"], []],
    ["optional admin declined is not missing", ["usage:read"], []],
    ["usage:read declined", ["admin"], ["usage:read"]],
    ["empty grant", [], ["usage:read"]],
  ])("%s", (_title, scopes, expected) => {
    expect(fakeAdapter.detectMissingPermissions({ scopes })).toEqual(expected);
  });
});

describe("sync", () => {
  it("returns valid month metrics and a week of events for an account", async () => {
    const result = await fakeAdapter.sync(
      { credential: await connect(), externalAccountId: "fake-acct-1" },
      makeCtx(),
    );

    const metrics = validateAdapterMetrics("fake", result.metrics);
    const events = validateAdapterEvents(fakeAdapter.eventTypes, result.events);
    expect(metrics.ok).toBe(true);
    expect(events.ok).toBe(true);
    expect(result.partialErrors).toBeUndefined();

    expect(result.metrics.map((metric) => [metric.metricKey, metric.kind])).toEqual([
      ["fake.spend.month", "verified_spend"],
      ["fake.requests.month", "usage"],
      ["fake.requests.included", "included_allowance"],
      ["fake.requests.remaining", "remaining_allowance"],
      ["fake.cost.estimate", "estimated_spend"],
    ]);
    // The month estimate is a projection, so the dashboard headline (#173) never counts it as spend so far.
    expect(fakeAdapter.projectedSpend).toEqual(["fake.cost.estimate"]);
    for (const metric of result.metrics) {
      expect(metric.retrievedAt).toEqual(OCT_2_AFTERNOON);
      expect(metric.externalAccountId).toBe("fake-acct-1");
      expect(metric.provenance.endpoint).toBeDefined();
    }
    expect(metricByKey(result.metrics, "fake.requests.month")).toMatchObject({ value: 2400, unit: "requests" });
    expect(metricByKey(result.metrics, "fake.requests.included")).toMatchObject({ value: 50_000 });
    expect(metricByKey(result.metrics, "fake.requests.remaining")).toMatchObject({
      value: 47_600,
      resetsAt: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(metricByKey(result.metrics, "fake.cost.estimate")).toMatchObject({
      currency: "USD",
      // 31 days x 1.2345 = 38.2695, rounded once.
      amountMinor: 3827,
      provenance: { source: "derived", pricingSource: expect.stringContaining("price list") },
    });

    expect(result.events).toHaveLength(FAKE_EVENT_WINDOW_DAYS * 2);
    expect(result.events.at(0)?.occurredAt).toEqual(new Date("2026-09-26T09:30:00.000Z"));
    expect(result.events.at(-1)).toMatchObject({
      typeId: "fake.deploy.succeeded",
      dedupeKey: "fake.deploy.succeeded:fake-acct-1:2026-10-02",
    });
    expect(result.cursor).toBe("2026-10-02T12:00:00.000Z");
  });

  it("sums sub-cent daily charges before rounding once (money rounding boundary)", async () => {
    const result = await fakeAdapter.sync(
      { credential: await connect(), externalAccountId: "fake-acct-1" },
      makeCtx(),
    );
    // 2 x 1.2345 = 2.469 -> 247 cents. Rounding each day first would give 123 + 123 = 246.
    expect(metricByKey(result.metrics, "fake.spend.month")).toMatchObject({ amountMinor: 247, currency: "USD" });
  });

  it("keeps the month-to-date period positive at exactly midnight on the 1st (period boundary)", async () => {
    const midnight = new Date("2026-10-01T00:00:00.000Z");
    const result = await fakeAdapter.sync(
      { credential: await connect(), externalAccountId: "fake-acct-2" },
      makeCtx(midnight),
    );
    expect(validateAdapterMetrics("fake", result.metrics).ok).toBe(true);
    // Today's events are still in the future at midnight.
    expect(result.events).toHaveLength((FAKE_EVENT_WINDOW_DAYS - 1) * 2);
  });

  it("resets allowances on the first of next year across December (year boundary)", async () => {
    const result = await fakeAdapter.sync(
      { credential: await connect(), externalAccountId: "fake-acct-2" },
      makeCtx(new Date("2026-12-15T08:00:00.000Z")),
    );
    expect(metricByKey(result.metrics, "fake.requests.month").resetsAt).toEqual(new Date("2027-01-01T00:00:00.000Z"));
  });

  it("is deterministic: the same clock gives the same metrics, keys, and dedupe keys", async () => {
    const input = { credential: await connect(), externalAccountId: "fake-acct-2" };
    const first = await fakeAdapter.sync(input, makeCtx());
    const second = await fakeAdapter.sync(input, makeCtx());
    expect(second).toEqual(first);
  });

  it("produces identical dedupe keys for duplicate events across two overlapping syncs", async () => {
    const credential = await connect();
    const first = await fakeAdapter.sync({ credential, externalAccountId: "fake-acct-1" }, makeCtx());
    const laterSameDay = await fakeAdapter.sync(
      { credential, externalAccountId: "fake-acct-1" },
      makeCtx(new Date("2026-10-02T23:00:00.000Z")),
    );
    expect(laterSameDay.events.map((event) => event.dedupeKey)).toEqual(first.events.map((event) => event.dedupeKey));
  });

  it("uses the cursor to return only newer events, and keeps it when nothing is new", async () => {
    const credential = await connect();
    const first = await fakeAdapter.sync({ credential, externalAccountId: "fake-acct-1" }, makeCtx());

    const again = await fakeAdapter.sync(
      { credential, externalAccountId: "fake-acct-1", ...(first.cursor === undefined ? {} : { cursor: first.cursor }) },
      makeCtx(),
    );
    expect(again.events).toEqual([]);
    expect(again.cursor).toBe(first.cursor);

    const nextMorning = await fakeAdapter.sync(
      { credential, externalAccountId: "fake-acct-1", ...(first.cursor === undefined ? {} : { cursor: first.cursor }) },
      makeCtx(new Date("2026-10-03T10:00:00.000Z")),
    );
    expect(nextMorning.events.map((event) => event.dedupeKey)).toEqual(["fake.signup:fake-acct-1:2026-10-03"]);
    expect(nextMorning.cursor).toBe("2026-10-03T09:30:00.000Z");
  });

  it("caps an old cursor at the event window (pagination cap)", async () => {
    const result = await fakeAdapter.sync(
      { credential: await connect(), externalAccountId: "fake-acct-1", cursor: "2026-08-01T00:00:00.000Z" },
      makeCtx(),
    );
    expect(result.events).toHaveLength(FAKE_EVENT_WINDOW_DAYS * 2);
    expect(result.events.at(0)?.occurredAt).toEqual(new Date("2026-09-26T09:30:00.000Z"));
  });

  it("returns events and a permission_missing partial error when usage:read was declined", async () => {
    const result = await fakeAdapter.sync(
      { credential: await connect({ granted_scope: "admin" }), externalAccountId: "fake-acct-1" },
      makeCtx(),
    );
    expect(result.metrics).toEqual([]);
    expect(result.events).toHaveLength(FAKE_EVENT_WINDOW_DAYS * 2);
    expect(result.partialErrors).toHaveLength(1);
    expect(result.partialErrors?.at(0)).toMatchObject({ code: "permission_missing", missingScopes: ["usage:read"] });
  });

  it.each([
    ["unknown account", "fake-acct-9", undefined],
    ["cursor that is not a timestamp", "fake-acct-1", "yesterday"],
  ])("rejects an %s as invalid_response", async (_title, externalAccountId, cursor) => {
    await expect(
      fakeAdapter.sync(
        { credential: await connect(), externalAccountId, ...(cursor === undefined ? {} : { cursor }) },
        makeCtx(),
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("failure modes", () => {
  it.each<[FakeMode, string, Record<string, unknown>]>([
    ["rate_limited", "rate_limited", { retryAfterMs: 1000, status: 429 }],
    ["revoked", "auth_revoked", { status: 401 }],
    ["unavailable", "provider_unavailable", { status: 503 }],
  ])("mode %s makes sync and refresh throw %s", async (mode, code, extra) => {
    const credential = await connect({ mode });
    await expect(
      fakeAdapter.sync({ credential, externalAccountId: "fake-acct-1" }, makeCtx()),
    ).rejects.toMatchObject({ code, ...extra });
    await expect(fakeAdapter.refreshTokens?.(credential, makeCtx())).rejects.toMatchObject({ code, ...extra });
  });

  it("rejects a credential whose stored mode is unknown as invalid_response", async () => {
    const credential: OAuthCredential = { ...(await connect()), metadata: { mode: "explode" } };
    await expect(
      fakeAdapter.sync({ credential, externalAccountId: "fake-acct-1" }, makeCtx()),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("webhooks", () => {
  // Made up, and built from parts so CI's secret scan (gitleaks) does not read it as a credential.
  const SECRET_VALUE = ["fake", "webhook", "value"].join("-");
  const SECRET = new Secret(SECRET_VALUE);
  const NOW_SECONDS = OCT_2_AFTERNOON.getTime() / 1000;
  const DEPLOY_BODY = JSON.stringify({
    type: "event",
    account: "fake-acct-1",
    event: { typeId: "fake.deploy.succeeded", occurredAt: "2026-10-02T12:00:00.000Z" },
  });

  function descriptor(): WebhookDescriptor {
    const { webhooks } = fakeAdapter;
    if (webhooks === undefined) throw new Error("the fake adapter declares no webhook");
    return webhooks;
  }

  type Delivery = Partial<{ timestampSeconds: number; signedWith: string; signedBody: string; headers: Record<string, string | null> }>;

  // A delivery as the provider sends it; each option bends one part of it for a boundary test.
  function delivery(rawBody: string, options: Delivery = {}): WebhookRequest {
    const timestampSeconds = options.timestampSeconds ?? NOW_SECONDS;
    const headers = new Headers({
      [FAKE_WEBHOOK_HEADERS.delivery]: "dlv_0001",
      [FAKE_WEBHOOK_HEADERS.timestamp]: String(timestampSeconds),
      [FAKE_WEBHOOK_HEADERS.signature]: signFakeWebhook({
        secret: options.signedWith ?? SECRET_VALUE,
        rawBody: options.signedBody ?? rawBody,
        timestampSeconds,
      }),
    });
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (value === null) headers.delete(name);
      else headers.set(name, value);
    }
    return { headers, rawBody: new TextEncoder().encode(rawBody) };
  }

  function verifyAndParse(request: WebhookRequest) {
    const verification = descriptor().verify(request, SECRET, OCT_2_AFTERNOON);
    return { verification, outcome: verification.ok ? descriptor().parse(request, makeCtx()) : undefined };
  }

  it("is registered on the app, with its secret named by an instance setting", () => {
    expect(descriptor().registration).toEqual({ kind: "app", secretEnv: FAKE_WEBHOOK_SECRET_ENV });
    expect(FAKE_WEBHOOK_SECRET_ENV).toBe("STACKDASH_FAKE_WEBHOOK_SECRET");
    expect(descriptor().subscriptions).toEqual(["event", "uninstalled"]);
  });

  it("verifies a signed delivery and parses it into one event for its account", () => {
    const { verification, outcome } = verifyAndParse(delivery(DEPLOY_BODY));
    expect(verification).toEqual({ ok: true, deliveryId: "dlv_0001" });
    expect(outcome).toEqual({
      kind: "events",
      externalAccountId: "fake-acct-1",
      events: [
        {
          typeId: "fake.deploy.succeeded",
          occurredAt: new Date("2026-10-02T12:00:00.000Z"),
          severity: "success",
          title: "Deployment succeeded",
          body: "Daily deployment for 2026-10-02.",
          externalAccountId: "fake-acct-1",
          dedupeKey: "fake.deploy.succeeded:fake-acct-1:2026-10-02",
        },
      ],
    });
    if (outcome === undefined) throw new Error("verified delivery was not parsed");
    expect(checkWebhookOutcome(fakeAdapter, outcome)).toEqual([]);
  });

  it("signs the timestamp, a dot, and the raw body as v1= and lowercase hex", () => {
    expect(signFakeWebhook({ secret: SECRET_VALUE, rawBody: "{}", timestampSeconds: 1 })).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  it.each<[string, Delivery, string]>([
    ["no signature header", { headers: { [FAKE_WEBHOOK_HEADERS.signature]: null } }, "missing_signature"],
    ["an empty signature header", { headers: { [FAKE_WEBHOOK_HEADERS.signature]: "" } }, "missing_signature"],
    ["no timestamp header", { headers: { [FAKE_WEBHOOK_HEADERS.timestamp]: null } }, "missing_signature"],
    ["a timestamp that is not a number", { headers: { [FAKE_WEBHOOK_HEADERS.timestamp]: "yesterday" } }, "stale"],
    ["a timestamp one second past the tolerance", { timestampSeconds: NOW_SECONDS - FAKE_WEBHOOK_TOLERANCE_SECONDS - 1 }, "stale"],
    ["a timestamp one second past the tolerance in the future", { timestampSeconds: NOW_SECONDS + FAKE_WEBHOOK_TOLERANCE_SECONDS + 1 }, "stale"],
    ["a signature made with another secret", { signedWith: "another-webhook-value" }, "bad_signature"],
    ["a tampered body", { signedBody: DEPLOY_BODY.replace("fake-acct-1", "fake-acct-2") }, "bad_signature"],
    // A captured delivery replayed later with a fresh timestamp: the old signature no longer matches.
    ["a fresh timestamp on an old signature", { headers: { [FAKE_WEBHOOK_HEADERS.timestamp]: String(NOW_SECONDS - 1) } }, "bad_signature"],
    ["a signature without its v1= prefix", { headers: { [FAKE_WEBHOOK_HEADERS.signature]: "0".repeat(64) } }, "bad_signature"],
    ["no delivery id", { headers: { [FAKE_WEBHOOK_HEADERS.delivery]: null } }, "malformed"],
    ["a blank delivery id", { headers: { [FAKE_WEBHOOK_HEADERS.delivery]: "   " } }, "malformed"],
    ["a delivery id of 201 characters", { headers: { [FAKE_WEBHOOK_HEADERS.delivery]: "d".repeat(201) } }, "malformed"],
  ])("rejects %s (boundary)", (_case, options, reason) => {
    expect(descriptor().verify(delivery(DEPLOY_BODY, options), SECRET, OCT_2_AFTERNOON)).toEqual({ ok: false, reason });
  });

  it.each([
    ["exactly at the tolerance in the past", NOW_SECONDS - FAKE_WEBHOOK_TOLERANCE_SECONDS],
    ["exactly at the tolerance in the future", NOW_SECONDS + FAKE_WEBHOOK_TOLERANCE_SECONDS],
  ])("accepts a timestamp %s (boundary)", (_case, timestampSeconds) => {
    expect(descriptor().verify(delivery(DEPLOY_BODY, { timestampSeconds }), SECRET, OCT_2_AFTERNOON)).toEqual({
      ok: true,
      deliveryId: "dlv_0001",
    });
  });

  it("verifies a body with unicode bytes signed as UTF-8 (boundary: unicode body)", () => {
    const body = JSON.stringify({ type: "event", account: "fake-acct-1", note: "Déploiement 🚀", event: { typeId: "fake.signup", occurredAt: "2026-10-02T09:30:00.000Z" } });
    const { verification, outcome } = verifyAndParse(delivery(body));
    expect(verification.ok).toBe(true);
    expect(outcome).toMatchObject({ kind: "events", events: [{ dedupeKey: "fake.signup:fake-acct-1:2026-10-02" }] });
  });

  it("reports an uninstall for its account", () => {
    const { outcome } = verifyAndParse(delivery(JSON.stringify({ type: "uninstalled", account: "fake-acct-2" })));
    expect(outcome).toEqual({ kind: "uninstalled", externalAccountId: "fake-acct-2" });
  });

  it.each([
    ["an unknown delivery type", JSON.stringify({ type: "account.renamed", account: "fake-acct-1" })],
    ["an unknown event type", JSON.stringify({ type: "event", account: "fake-acct-1", event: { typeId: "fake.deploy.failed", occurredAt: "2026-10-02T12:00:00.000Z" } })],
    ["an event without a time", JSON.stringify({ type: "event", account: "fake-acct-1", event: { typeId: "fake.signup" } })],
    ["an empty account", JSON.stringify({ type: "uninstalled", account: "" })],
    ["a JSON array", "[]"],
    ["a body that is not JSON", "type=event"],
    ["an empty body", ""],
  ])("ignores a verified delivery with %s (boundary)", (_case, body) => {
    const { verification, outcome } = verifyAndParse(delivery(body));
    expect(verification.ok).toBe(true);
    expect(outcome).toMatchObject({ kind: "ignored", reason: expect.any(String) });
  });

  describe("reconciliation with sync", () => {
    it.each(["fake.deploy.succeeded", "fake.signup"] as const)("delivers the same %s event that sync finds for the account and day", async (typeId) => {
      const synced = await fakeAdapter.sync({ credential: await connect(), externalAccountId: "fake-acct-1" }, makeCtx());
      const fromSync = synced.events.find((event) => event.typeId === typeId && event.dedupeKey.endsWith(":2026-10-02"));
      if (fromSync === undefined) throw new Error(`sync found no ${typeId} on 2026-10-02`);

      const body = JSON.stringify({ type: "event", account: "fake-acct-1", event: { typeId, occurredAt: fromSync.occurredAt.toISOString() } });
      const { outcome } = verifyAndParse(delivery(body));
      expect(outcome).toEqual({ kind: "events", externalAccountId: "fake-acct-1", events: [fromSync] });
    });

    function dedupeKeyAt(occurredAt: string): string | undefined {
      const body = JSON.stringify({ type: "event", account: "fake-acct-1", event: { typeId: "fake.signup", occurredAt } });
      const { outcome } = verifyAndParse(delivery(body));
      return outcome?.kind === "events" ? outcome.events[0]?.dedupeKey : undefined;
    }

    it.each([
      ["another time on the same UTC day", "2026-10-02T23:59:59.999Z", "fake.signup:fake-acct-1:2026-10-02"],
      ["an offset time that is still that UTC day", "2026-10-03T00:30:00+01:00", "fake.signup:fake-acct-1:2026-10-02"],
      ["the first millisecond of the next UTC day", "2026-10-03T00:00:00.000Z", "fake.signup:fake-acct-1:2026-10-03"],
    ])("keys an event at %s by its UTC day (boundary)", (_case, occurredAt, dedupeKey) => {
      expect(dedupeKeyAt(occurredAt)).toBe(dedupeKey);
    });
  });
});
