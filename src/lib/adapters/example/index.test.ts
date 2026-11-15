import { describe, expect, it } from "vitest";
import { AuthRevokedError, PermissionMissingError, RateLimitedError } from "@/lib/adapters/errors";
import {
  checkAdapterDeclaration,
  checkSyncResult,
  checkTraffic,
  checkWebhookOutcome,
  createAdapterHarness,
  HARNESS_CLIENT_ID,
  KIND_CAPABILITY,
  type RecordedRoutes,
} from "@/lib/adapters/harness";
import {
  Secret,
  type AdapterCapabilities,
  type OAuthCredential,
  type WebhookDescriptor,
  type WebhookRequest,
} from "@/lib/adapters/types";
import {
  EVENT_BACKFILL_DAYS,
  EXAMPLE_API_BASE,
  EXAMPLE_SCOPES,
  EXAMPLE_WEBHOOK_HEADERS,
  EXAMPLE_WEBHOOK_TOLERANCE_SECONDS,
  exampleAdapter,
  exampleWebhookSignature,
  MAX_EVENT_PAGES,
  metricKeys,
  projectedOverage,
} from "./index";
import { UsageResponseSchema } from "./schemas";
// Synthetic responses in Example Cloud's shape, with made-up ids, tokens, and amounts. A real
// adapter records its fixtures from the provider and scrubs them (docs/adapters.md, Fixtures).
import accountsFixture from "./fixtures/accounts.json";
import billingFixture from "./fixtures/billing.json";
import eventsPage1Fixture from "./fixtures/events-page-1.json";
import eventsPage2Fixture from "./fixtures/events-page-2.json";
import paymentsFixture from "./fixtures/payments-summary.json";
import tokenRefreshedFixture from "./fixtures/token-refreshed.json";
import tokenFixture from "./fixtures/token.json";
import usageFixture from "./fixtures/usage.json";
import webhookEventFixture from "./fixtures/webhook-event-created.json";

// Half way through the fixtures' billing period (2026-11-01 to 2026-12-01).
const NOW = new Date("2026-11-16T00:00:00.000Z");
const DAY_MS = 86_400_000;
const ACCOUNT_ID = "acct_1001";
const ACCESS_TOKEN = tokenFixture.access_token;
const REFRESH_TOKEN = tokenFixture.refresh_token;
const SECRETS = [ACCESS_TOKEN, REFRESH_TOKEN, tokenRefreshedFixture.access_token, tokenRefreshedFixture.refresh_token];
const ALL_SCOPES: readonly string[] = Object.values(EXAMPLE_SCOPES);
const VERIFIER = "v".repeat(43);
const REDIRECT_URI = "https://stackdash.test/api/connections/example/callback";

const credential: OAuthCredential = {
  accessToken: new Secret(ACCESS_TOKEN),
  refreshToken: new Secret(REFRESH_TOKEN),
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  scopes: ALL_SCOPES,
  tokenType: "Bearer",
};

const TOKEN = `POST ${EXAMPLE_API_BASE}/oauth/token`;
const REVOKE = `POST ${EXAMPLE_API_BASE}/oauth/revoke`;
const accountRoute = (resource: string) => `GET ${EXAMPLE_API_BASE}/v1/accounts/${ACCOUNT_ID}/${resource}`;
const FORBIDDEN = { status: 403, body: { error: "insufficient_scope" } };

function recorded(overrides: RecordedRoutes = {}): RecordedRoutes {
  return {
    [TOKEN]: { body: tokenFixture },
    [REVOKE]: { body: {} },
    [`GET ${EXAMPLE_API_BASE}/v1/accounts`]: { body: accountsFixture },
    [accountRoute("usage")]: { body: usageFixture },
    [accountRoute("billing")]: { body: billingFixture },
    [accountRoute("payments/summary")]: { body: paymentsFixture },
    [accountRoute("events")]: (request) => ({
      body: request.url.searchParams.get("page_token") === "page-2" ? eventsPage2Fixture : eventsPage1Fixture,
    }),
    ...overrides,
  };
}

function setup(overrides: RecordedRoutes = {}, now: Date = NOW) {
  return createAdapterHarness({ routes: recorded(overrides), now });
}

async function syncWith(overrides: RecordedRoutes = {}, cursor?: string) {
  const harness = setup(overrides);
  const result = await exampleAdapter.sync(
    cursor === undefined ? { credential, externalAccountId: ACCOUNT_ID } : { credential, externalAccountId: ACCOUNT_ID, cursor },
    harness.ctx,
  );
  expect(checkSyncResult(exampleAdapter, ACCOUNT_ID, result)).toEqual([]);
  expect(checkTraffic(harness, SECRETS)).toEqual([]);
  return { harness, result };
}

describe("example adapter declaration", () => {
  it("keeps the adapter contract", () => {
    expect(checkAdapterDeclaration(exampleAdapter)).toEqual([]);
  });

  const DATA_CAPABILITIES = new Set<keyof AdapterCapabilities>([...Object.values(KIND_CAPABILITY), "events"]);

  // checkSyncResult rejects a kind whose capability is false; this is the other direction, so a
  // capability declared but never exercised fails here instead of passing unnoticed.
  it("emits a metric or an event for every data capability it declares", async () => {
    const { result } = await syncWith();
    const emitted = new Set<keyof AdapterCapabilities>(result.metrics.map((metric) => KIND_CAPABILITY[metric.kind]));
    if (result.events.length > 0) emitted.add("events");
    const declared = [...DATA_CAPABILITIES].filter((capability) => exampleAdapter.capabilities[capability]);

    expect(declared.filter((capability) => !emitted.has(capability))).toEqual([]);
  });

  // True of Example Cloud only: most providers report no revenue or credits. Delete this case in a copy.
  it("declares every data capability, so the example exercises the whole contract", () => {
    const undeclared = [...DATA_CAPABILITIES].filter((capability) => !exampleAdapter.capabilities[capability]);
    expect(undeclared).toEqual([]);
  });
});

describe("example adapter OAuth", () => {
  it("asks for every scope explicitly, with a PKCE S256 challenge", () => {
    const { ctx } = setup();
    const url = exampleAdapter.buildAuthorizeUrl({ client: ctx.client, state: "state-1", redirectUri: REDIRECT_URI, codeChallenge: "challenge-1" });

    expect(url.origin + url.pathname).toBe(exampleAdapter.oauth.authorizeUrl);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: HARNESS_CLIENT_ID,
      response_type: "code",
      redirect_uri: REDIRECT_URI,
      scope: ALL_SCOPES.join(" "),
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
  });

  it.each([
    ["no code challenge", { state: "state-1" }, TypeError],
    ["an empty state", { state: "", codeChallenge: "challenge-1" }, RangeError],
    ["a state over 1024 characters", { state: "s".repeat(1025), codeChallenge: "challenge-1" }, RangeError],
  ])("refuses to build the authorize URL with %s (boundary)", (_case, params, expected) => {
    const { ctx } = setup();
    expect(() => exampleAdapter.buildAuthorizeUrl({ client: ctx.client, redirectUri: REDIRECT_URI, ...params })).toThrow(expected);
  });

  it("exchanges the code with the verifier and Basic client authentication", async () => {
    const harness = setup();
    const result = await exampleAdapter.exchangeCode(
      { code: "code-1", redirectUri: REDIRECT_URI, codeVerifier: VERIFIER, callbackParams: {} },
      harness.ctx,
    );

    expect(result.accessToken.reveal()).toBe(ACCESS_TOKEN);
    expect(result.refreshToken?.reveal()).toBe(REFRESH_TOKEN);
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + 3_600_000));
    expect(result.scopes).toEqual(ALL_SCOPES);
    const [request] = harness.requests;
    expect(request?.headers.get("authorization")).toBe(`Basic ${btoa(`${HARNESS_CLIENT_ID}:${harness.clientSecret}`)}`);
    expect(Object.fromEntries(new URLSearchParams(request?.body))).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
    });
    expect(checkTraffic(harness, SECRETS)).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["42 characters", "v".repeat(42)],
    ["129 characters", "v".repeat(129)],
    ["a reserved character", `${"v".repeat(42)}/`],
  ])("refuses a code verifier that is %s (boundary)", async (_case, codeVerifier) => {
    const harness = setup();
    await expect(
      exampleAdapter.exchangeCode(
        { code: "code-1", redirectUri: REDIRECT_URI, callbackParams: {}, ...(codeVerifier === undefined ? {} : { codeVerifier }) },
        harness.ctx,
      ),
    ).rejects.toThrow(TypeError);
    expect(harness.requests).toEqual([]);
  });

  it("reports invalid_grant from the token endpoint as revoked access (boundary)", async () => {
    const harness = setup({ [TOKEN]: { status: 400, body: { error: "invalid_grant" } } });
    await expect(
      exampleAdapter.exchangeCode({ code: "code-1", redirectUri: REDIRECT_URI, codeVerifier: VERIFIER, callbackParams: {} }, harness.ctx),
    ).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("refreshes with the rotated token and keeps the granted scopes when the response omits them", async () => {
    const harness = setup({ [TOKEN]: { body: tokenRefreshedFixture } });
    const narrowed = { ...credential, scopes: [EXAMPLE_SCOPES.accounts, EXAMPLE_SCOPES.usage], metadata: { region: "eu" } };
    const refresh = exampleAdapter.refreshTokens;
    expect(refresh).toBeDefined();
    const result = await refresh?.(narrowed, harness.ctx);

    expect(result?.accessToken.reveal()).toBe(tokenRefreshedFixture.access_token);
    expect(result?.refreshToken?.reveal()).toBe(tokenRefreshedFixture.refresh_token);
    expect(result?.scopes).toEqual([EXAMPLE_SCOPES.accounts, EXAMPLE_SCOPES.usage]);
    expect(result?.metadata).toEqual({ region: "eu" });
    expect(new URLSearchParams(harness.requests[0]?.body).get("refresh_token")).toBe(REFRESH_TOKEN);
  });

  it("asks to reconnect when there is no refresh token (boundary)", async () => {
    const { refreshToken: _omitted, ...withoutRefresh } = credential;
    const harness = setup();
    await expect(exampleAdapter.refreshTokens?.(withoutRefresh, harness.ctx)).rejects.toBeInstanceOf(AuthRevokedError);
    expect(harness.requests).toEqual([]);
  });

  it("revokes the grant through the refresh token", async () => {
    const harness = setup();
    await exampleAdapter.revoke?.(credential, harness.ctx);
    expect(Object.fromEntries(new URLSearchParams(harness.requests[0]?.body))).toEqual({
      token: REFRESH_TOKEN,
      token_type_hint: "refresh_token",
    });
    expect(checkTraffic(harness, SECRETS)).toEqual([]);
  });

  it("lists the accounts the grant can read", async () => {
    const harness = setup();
    expect(await exampleAdapter.listAccounts(credential, harness.ctx)).toEqual([
      { externalId: "acct_1001", displayName: "Synthetic Labs", kind: "team" },
      { externalId: "acct_1002", displayName: "Personal sandbox", kind: "personal" },
    ]);
  });

  it.each([
    ["every scope", ALL_SCOPES, []],
    ["no billing scope", ALL_SCOPES.filter((scope) => scope !== EXAMPLE_SCOPES.billing), [EXAMPLE_SCOPES.billing]],
    ["no scope at all", [], ALL_SCOPES],
  ])("names what is missing from a grant with %s", (_case, scopes, missing) => {
    expect(exampleAdapter.detectMissingPermissions({ scopes })).toEqual(missing);
  });
});

describe("example adapter sync", () => {
  it("maps every capability from the recorded responses", async () => {
    const { result, harness } = await syncWith();

    expect(result.partialErrors).toBeUndefined();
    expect(result.metrics.map((metric) => [metric.metricKey, metric.kind, "value" in metric ? metric.value : metric.amountMinor])).toEqual([
      [metricKeys.requestsUsed, "usage", 41250],
      [metricKeys.requestsIncluded, "included_allowance", 50000],
      [metricKeys.requestsRemaining, "remaining_allowance", 8750],
      [metricKeys.creditBalance, "credit_balance", 2500],
      // 41,250 requests in half the period is 82,500 for all of it: 32,500 over, at 40 cents per 1,000.
      [metricKeys.overageProjected, "estimated_spend", 1300],
      [metricKeys.spendMonthToDate, "verified_spend", 1840],
      [metricKeys.revenueMonthToDate, "revenue", 128900],
      [metricKeys.recurringRevenue, "recurring_revenue", 45000],
    ]);
    expect(result.metrics.find((metric) => metric.metricKey === metricKeys.overageProjected)?.provenance).toMatchObject({
      source: "derived",
      pricingSource: expect.stringContaining("price list"),
    });

    // The unmapped `domain.added` is skipped, and the http link is dropped rather than stored.
    expect(result.events.map((event) => [event.typeId, event.title, event.url])).toEqual([
      ["example.signup", "New signup on storefront", undefined],
      ["example.deploy.succeeded", "storefront deployed", "https://app.example.com/deploys/dep_3001"],
      ["example.deploy.failed", "api failed to deploy", undefined],
      ["example.signup", "New signup", undefined],
    ]);
    expect(result.cursor).toBe(JSON.stringify({ v: 1, since: "2026-11-15T21:10:00.000Z" }));

    const eventReads = harness.requests.filter((request) => request.url.pathname.endsWith("/events"));
    expect(eventReads.map((request) => request.url.searchParams.get("created_since"))).toEqual([
      new Date(NOW.getTime() - EVENT_BACKFILL_DAYS * DAY_MS).toISOString(),
      new Date(NOW.getTime() - EVENT_BACKFILL_DAYS * DAY_MS).toISOString(),
    ]);
    expect(harness.requests.every((request) => request.headers.get("authorization") === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
  });

  it("produces the same dedupe keys when the same events are read again", async () => {
    const first = await syncWith();
    const second = await syncWith({}, first.result.cursor);
    expect(second.result.events.map((event) => event.dedupeKey)).toEqual(first.result.events.map((event) => event.dedupeKey));
  });

  it.each([
    ["the period's first day", { period: { start: "2026-11-15T12:00:00Z", end: "2026-12-15T12:00:00Z" } }, undefined],
    ["a plan without an allowance", { requests: { used: 41250, included: null } }, undefined],
    ["usage on course to stay inside the allowance", { requests: { used: 1000, included: 50000 } }, 0],
    ["a reading after the period ended", { period: { start: "2026-10-01T00:00:00Z", end: "2026-11-01T00:00:00Z" } }, 0],
    ["exactly one day into the period", { period: { start: "2026-11-15T00:00:00Z", end: "2026-12-15T00:00:00Z" }, requests: { used: 2000, included: 50000 } }, 400],
  ])("projects overage for %s (boundary)", (_case, change, expected) => {
    const usage = UsageResponseSchema.parse({ ...usageFixture, ...change });
    expect(projectedOverage(usage, ACCOUNT_ID, NOW)?.amountMinor).toBe(expected);
  });

  it("leaves the allowance out on a plan without one", async () => {
    const { result } = await syncWith({ [accountRoute("usage")]: { body: { ...usageFixture, requests: { used: 41250, included: null } } } });
    const keys = result.metrics.map((metric) => metric.metricKey);
    expect(keys).not.toContain(metricKeys.requestsIncluded);
    expect(keys).not.toContain(metricKeys.requestsRemaining);
    expect(keys).not.toContain(metricKeys.overageProjected);
  });

  it.each([
    ["billing", accountRoute("billing"), EXAMPLE_SCOPES.billing, metricKeys.spendMonthToDate],
    ["payments", accountRoute("payments/summary"), EXAMPLE_SCOPES.payments, metricKeys.revenueMonthToDate],
  ])("keeps the rest of the sync and names %s's scope when it is refused (boundary)", async (_case, route, scope, absentKey) => {
    const { result } = await syncWith({ [route]: FORBIDDEN });
    expect(result.partialErrors?.map((error) => [error.constructor, error.missingScopes])).toEqual([[PermissionMissingError, [scope]]]);
    expect(result.metrics.map((metric) => metric.metricKey)).not.toContain(absentKey);
    expect(result.metrics.map((metric) => metric.metricKey)).toContain(metricKeys.requestsUsed);
    expect(result.events).toHaveLength(4);
  });

  it("keeps the previous cursor when events are refused (boundary)", async () => {
    const cursor = JSON.stringify({ v: 1, since: "2026-11-14T00:00:00.000Z" });
    const { result } = await syncWith({ [accountRoute("events")]: FORBIDDEN }, cursor);
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe(cursor);
    expect(result.partialErrors?.map((error) => error.missingScopes)).toEqual([[EXAMPLE_SCOPES.events]]);
  });

  it("reads from the cursor, and from the backfill window when the cursor is unreadable (boundary)", async () => {
    const since = "2026-11-15T00:00:00.000Z";
    const fromCursor = await syncWith({}, JSON.stringify({ v: 1, since }));
    expect(fromCursor.harness.requests.find((request) => request.url.pathname.endsWith("/events"))?.url.searchParams.get("created_since")).toBe(since);

    const unreadable = await syncWith({}, "not json");
    expect(unreadable.harness.requests.find((request) => request.url.pathname.endsWith("/events"))?.url.searchParams.get("created_since")).toBe(
      new Date(NOW.getTime() - EVENT_BACKFILL_DAYS * DAY_MS).toISOString(),
    );
    expect(unreadable.harness.logs.map((entry) => entry.event)).toContain("example.sync.cursor_unreadable");
  });

  it("keeps the cursor where it was when no event is newer (boundary)", async () => {
    const cursor = JSON.stringify({ v: 1, since: "2026-11-15T23:00:00.000Z" });
    const { result } = await syncWith({ [accountRoute("events")]: { body: { data: [], next_page_token: null } } }, cursor);
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe(cursor);
  });

  it("stops at the page cap and goes on from the newest event read (boundary)", async () => {
    let page = 0;
    const { result, harness } = await syncWith({
      [accountRoute("events")]: () => {
        page += 1;
        const at = new Date(Date.UTC(2026, 10, 10, page)).toISOString();
        return { body: { data: [{ id: `evt_${page}`, type: "signup", created_at: at }], next_page_token: `page-${page + 1}` } };
      },
    });
    expect(harness.requests.filter((request) => request.url.pathname.endsWith("/events"))).toHaveLength(MAX_EVENT_PAGES);
    expect(result.events).toHaveLength(MAX_EVENT_PAGES);
    expect(result.cursor).toBe(JSON.stringify({ v: 1, since: new Date(Date.UTC(2026, 10, 10, MAX_EVENT_PAGES)).toISOString() }));
    expect(harness.logs.map((entry) => entry.event)).toContain("example.sync.event_page_cap");
  });

  it.each([
    ["rejected (401)", { status: 401, body: { error: "invalid_token" } }, AuthRevokedError],
    ["refused (403)", FORBIDDEN, PermissionMissingError],
    ["rate limited (429)", { status: 429, body: {}, headers: { "Retry-After": "30" } }, RateLimitedError],
  ])("fails the whole sync when usage is %s (boundary)", async (_case, response, expected) => {
    const harness = setup({ [accountRoute("usage")]: response });
    const sync = exampleAdapter.sync({ credential, externalAccountId: ACCOUNT_ID }, harness.ctx);
    await expect(sync).rejects.toBeInstanceOf(expected);
    const error: unknown = await sync.catch((caught: unknown) => caught);
    expect(error instanceof Error ? error.message : "").not.toContain(ACCESS_TOKEN);
  });
});

describe("example adapter webhooks", () => {
  // Made up, and built from parts so CI's secret scan (gitleaks) does not read it as a credential.
  const WEBHOOK_SECRET = new Secret(["example", "webhook", "value"].join("-"));
  const NOW_SECONDS = NOW.getTime() / 1000;
  const RECORDED_BODY = JSON.stringify(webhookEventFixture);

  function descriptor(): WebhookDescriptor {
    const { webhooks } = exampleAdapter;
    if (webhooks === undefined) throw new Error("the example adapter declares no webhook");
    return webhooks;
  }

  type Delivery = Partial<{ timestampSeconds: number; secret: Secret; signedBody: string; omit: keyof typeof EXAMPLE_WEBHOOK_HEADERS }>;

  // A delivery as Example Cloud sends it; each option bends one part of it for a boundary test.
  function delivery(rawBody: string, options: Delivery = {}): WebhookRequest {
    const timestamp = String(options.timestampSeconds ?? NOW_SECONDS);
    const signed = new TextEncoder().encode(options.signedBody ?? rawBody);
    const headers = new Headers({
      [EXAMPLE_WEBHOOK_HEADERS.delivery]: "a1b2c3d4-0000-4000-8000-000000000001",
      [EXAMPLE_WEBHOOK_HEADERS.timestamp]: timestamp,
      [EXAMPLE_WEBHOOK_HEADERS.signature]: exampleWebhookSignature(options.secret ?? WEBHOOK_SECRET, timestamp, signed),
    });
    if (options.omit !== undefined) headers.delete(EXAMPLE_WEBHOOK_HEADERS[options.omit]);
    return { headers, rawBody: new TextEncoder().encode(rawBody) };
  }

  function parsed(rawBody: string) {
    const request = delivery(rawBody);
    expect(descriptor().verify(request, WEBHOOK_SECRET, NOW).ok).toBe(true);
    return descriptor().parse(request, setup().ctx);
  }

  it("verifies the recorded delivery and maps it to the event the sync stores for it", async () => {
    const request = delivery(RECORDED_BODY);
    expect(descriptor().verify(request, WEBHOOK_SECRET, NOW)).toEqual({ ok: true, deliveryId: "a1b2c3d4-0000-4000-8000-000000000001" });
    const outcome = descriptor().parse(request, setup().ctx);
    expect(checkWebhookOutcome(exampleAdapter, outcome)).toEqual([]);

    // The same provider event read by polling: one dedupe key, so the timeline stores it once.
    const { result } = await syncWith();
    const polled = result.events.find((event) => event.dedupeKey === "example.deploy.succeeded:evt_2002");
    expect(polled).toBeDefined();
    expect(outcome).toEqual({ kind: "events", externalAccountId: ACCOUNT_ID, events: [polled] });
  });

  it.each<[string, Delivery, string]>([
    ["no signature", { omit: "signature" }, "missing_signature"],
    ["no timestamp", { omit: "timestamp" }, "missing_signature"],
    ["a timestamp one second past the tolerance", { timestampSeconds: NOW_SECONDS - EXAMPLE_WEBHOOK_TOLERANCE_SECONDS - 1 }, "stale"],
    ["a timestamp one second past the tolerance in the future", { timestampSeconds: NOW_SECONDS + EXAMPLE_WEBHOOK_TOLERANCE_SECONDS + 1 }, "stale"],
    ["a signature made with another secret", { secret: new Secret("another-webhook-value") }, "bad_signature"],
    ["a tampered body", { signedBody: RECORDED_BODY.replace("acct_1001", "acct_9999") }, "bad_signature"],
    ["no delivery id", { omit: "delivery" }, "malformed"],
  ])("rejects a delivery with %s (boundary)", (_case, options, reason) => {
    expect(descriptor().verify(delivery(RECORDED_BODY, options), WEBHOOK_SECRET, NOW)).toEqual({ ok: false, reason });
  });

  it("accepts a timestamp exactly at the tolerance (boundary)", () => {
    const request = delivery(RECORDED_BODY, { timestampSeconds: NOW_SECONDS - EXAMPLE_WEBHOOK_TOLERANCE_SECONDS });
    expect(descriptor().verify(request, WEBHOOK_SECRET, NOW).ok).toBe(true);
  });

  it("reports an uninstall for its account", () => {
    expect(parsed(JSON.stringify({ type: "installation.deleted", account_id: ACCOUNT_ID }))).toEqual({
      kind: "uninstalled",
      externalAccountId: ACCOUNT_ID,
    });
  });

  it.each([
    ["an event type the timeline does not show", JSON.stringify({ ...webhookEventFixture, data: { ...webhookEventFixture.data, type: "domain.added" } })],
    ["an unknown delivery type", JSON.stringify({ type: "account.updated", account_id: ACCOUNT_ID })],
    ["a body that is not JSON", "type=event.created"],
  ])("ignores %s (boundary)", (_case, body) => {
    expect(parsed(body)).toMatchObject({ kind: "ignored" });
  });
});
