import { createHmac } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  AuthRevokedError,
  InvalidResponseError,
  PermissionMissingError,
  ProviderUnavailableError,
  RateLimitedError,
} from "@/lib/adapters/errors";
import { validateAdapterEvents } from "@/lib/adapters/events";
import { checkAdapterDeclaration, checkWebhookOutcome } from "@/lib/adapters/harness";
import { validateAdapterMetrics, type AdapterMetric } from "@/lib/adapters/metrics";
import {
  Secret,
  type AdapterContext,
  type FetchLike,
  type OAuthContext,
  type OAuthCredential,
  type WebhookDescriptor,
  type WebhookRequest,
} from "@/lib/adapters/types";
import { STANDARD_WEBHOOK_HEADERS } from "@/lib/webhooks/standard-webhooks";
import { orderEvent, polarAdapter, polarWebhookSignature, refundEvent } from "./index";
// Fixtures are from documentation, not recorded: shaped after the response schemas and examples in
// Polar's API reference, version 2026-10, checked 2026-11-05, trimmed, with synthetic ids, amounts,
// and personal data (docs/providers/polar.md, Sample responses). The personal data is there to
// prove none of it survives the parse boundary.
// https://polar.sh/docs/api-reference/2026-10/customers/list-customers
import customersFixture from "./fixtures/customers.json";
// https://polar.sh/docs/api-reference/2026-10/metrics/get-metrics
import metricsFixture from "./fixtures/metrics.json";
// https://polar.sh/docs/api-reference/2026-10/orders/list-orders
import ordersFixture from "./fixtures/orders.json";
// https://polar.sh/docs/api-reference/2026-10/organizations/list-organizations
import organizationsFixture from "./fixtures/organizations.json";
// https://polar.sh/docs/api-reference/2026-10/refunds/list-refunds
import refundsFixture from "./fixtures/refunds.json";
// https://polar.sh/docs/api-reference/2026-10/subscriptions/list-subscriptions, queried twice:
// `canceled_at_after` and `started_after`.
import canceledFixture from "./fixtures/subscriptions-canceled.json";
import startedFixture from "./fixtures/subscriptions-started.json";
// https://polar.sh/docs/api-reference/2026-10/oauth2/request-token and the example response on
// https://polar.sh/docs/integrate/oauth2/connect, for the code exchange and the refresh.
import refreshFixture from "./fixtures/token-refresh.json";
import tokenFixture from "./fixtures/token.json";
// Webhook deliveries (#429), shaped after the 2026-10 webhook payload schemas (`order.paid`,
// `subscription.active`, `subscription.canceled`, `refund.updated` at
// https://polar.sh/docs/api-reference/2026-10/order_paid and its siblings): the envelope
// `{ type, timestamp, api_version, data }` around the same synthetic objects as the list fixtures
// above, with the embedded customer and its personal data the payloads carry.
import webhookOrderPaid from "./fixtures/webhook-order-paid.json";
import webhookRefundUpdated from "./fixtures/webhook-refund-updated.json";
import webhookSubscriptionActive from "./fixtures/webhook-subscription-active.json";
import webhookSubscriptionCanceled from "./fixtures/webhook-subscription-canceled.json";
// https://polar.sh/docs/api-reference/2026-10/webhooks/create-webhook-endpoint, response 201, with
// a placeholder secret.
import webhookEndpointCreated from "./fixtures/webhook-endpoint-created.json";

const now = new Date("2026-11-10T12:00:00Z");
const monthStart = new Date("2026-11-01T00:00:00Z");
const thirtyDaysAgo = "2026-10-11T12:00:00.000Z";
const orgId = "1dbfc517-0bbf-4301-9ba8-555ca42b9737";
const clientSecret = "polar_cs_fixture_client_secret";
const verifier = "a".repeat(43);
const ALL_SCOPES = ["organizations:read", "metrics:read", "orders:read", "subscriptions:read", "customers:read", "refunds:read"];

type Call = { url: URL; init: RequestInit | undefined };
type Route = (url: URL, init: RequestInit | undefined) => Response;

function fakeFetch(routes: Record<string, Route>): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const route = routes[url.pathname];
    if (route === undefined) throw new Error(`unexpected request to ${url.pathname}`);
    return route(url, init);
  };
  return { fetch, calls };
}

const ok = (body: unknown): Route => () => Response.json(body);
const emptyList = ok({ items: [], pagination: { total_count: 0, max_page: 0 } });
const emptyMetrics = ok({ periods: [], totals: {}, metrics: {} });

function context(fetch: FetchLike, at: Date = now) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: OAuthContext = {
    fetch,
    now: () => at,
    timeoutMs: 1000,
    logger,
    client: { clientId: "polar_ci_fixture_client", clientSecret: new Secret(clientSecret), extra: {} },
  };
  return { ctx, logger };
}

function credential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    accessToken: new Secret("polar_at_fixture_access_1"),
    refreshToken: new Secret("polar_rt_fixture_refresh_1"),
    expiresAt: new Date(now.getTime() + 864_000_000),
    scopes: ALL_SCOPES,
    tokenType: "Bearer",
    ...overrides,
  };
}

function header(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init?.headers).get(name);
}

function formBody(call: Call | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(call?.init?.body)));
}

const subscriptionsRoute: Route = (url) =>
  Response.json(url.searchParams.has("started_after") ? startedFixture : canceledFixture);

const syncRoutes: Record<string, Route> = {
  "/v1/metrics/": ok(metricsFixture),
  "/v1/customers/": ok(customersFixture),
  "/v1/orders/": ok(ordersFixture),
  "/v1/subscriptions/": subscriptionsRoute,
  // The pending refund stays in the fixture: the adapter still drops it if Polar ignores `succeeded`.
  "/v1/refunds/": ok(refundsFixture),
};

function values(metrics: readonly AdapterMetric[]) {
  return Object.fromEntries(metrics.map((metric) => [metric.metricKey, "amountMinor" in metric ? metric.amountMinor : metric.value]));
}

function sync(routes: Record<string, Route>, cursor?: string, at: Date = now) {
  const { fetch, calls } = fakeFetch(routes);
  const { ctx, logger } = context(fetch, at);
  const input = cursor === undefined ? { credential: credential(), externalAccountId: orgId } : { credential: credential(), externalAccountId: orgId, cursor };
  return { calls, logger, result: polarAdapter.sync(input, ctx) };
}

describe("polarAdapter.buildAuthorizeUrl", () => {
  it("asks for the six read-only scopes with a PKCE S256 challenge", () => {
    const url = polarAdapter.buildAuthorizeUrl({
      client: { clientId: "polar_ci_fixture_client", clientSecret: new Secret(clientSecret), extra: {} },
      state: "state-123",
      redirectUri: "https://stackdash.example.com/api/connections/polar/callback",
      codeChallenge: "challenge-abc",
    });
    expect(`${url.origin}${url.pathname}`).toBe("https://polar.sh/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "polar_ci_fixture_client",
      redirect_uri: "https://stackdash.example.com/api/connections/polar/callback",
      scope: ALL_SCOPES.join(" "),
      state: "state-123",
      code_challenge: "challenge-abc",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.get("scope")).not.toMatch(/write/);
  });

  it("refuses to build a link without a code challenge", () => {
    expect(() =>
      polarAdapter.buildAuthorizeUrl({
        client: { clientId: "c", clientSecret: new Secret("s"), extra: {} },
        state: "s",
        redirectUri: "https://stackdash.example.com/cb",
      }),
    ).toThrow(TypeError);
  });

  it("adds webhooks:write only when automatic webhook setup passes it (boundary: none passed reads only)", () => {
    const params = {
      client: { clientId: "polar_ci_fixture_client", clientSecret: new Secret(clientSecret), extra: {} },
      state: "state-123",
      redirectUri: "https://stackdash.example.com/api/connections/polar/callback",
      codeChallenge: "challenge-abc",
    };
    expect(polarAdapter.buildAuthorizeUrl({ ...params, extraScopes: ["webhooks:write"] }).searchParams.get("scope")).toBe(
      [...ALL_SCOPES, "webhooks:write"].join(" "),
    );
    expect(polarAdapter.buildAuthorizeUrl({ ...params, extraScopes: [] }).searchParams.get("scope")).toBe(ALL_SCOPES.join(" "));
  });
});

describe("polarAdapter.exchangeCode", () => {
  it("posts the code, verifier, and client credentials on the pinned API version and returns a 10 day credential without the id token", async () => {
    const { fetch, calls } = fakeFetch({ "/v1/oauth2/token": ok(tokenFixture) });
    const { ctx } = context(fetch);

    const result = await polarAdapter.exchangeCode(
      {
        code: "polar_ac_fixture",
        redirectUri: "https://stackdash.example.com/cb",
        codeVerifier: verifier,
        callbackParams: { code: "polar_ac_fixture", state: "s", iss: "https://api.polar.sh" },
      },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(header(calls[0], "content-type")).toBe("application/x-www-form-urlencoded");
    expect(header(calls[0], "polar-version")).toBe("2026-10");
    expect(formBody(calls[0])).toEqual({
      grant_type: "authorization_code",
      code: "polar_ac_fixture",
      redirect_uri: "https://stackdash.example.com/cb",
      code_verifier: verifier,
      client_id: "polar_ci_fixture_client",
      client_secret: clientSecret,
    });
    expect(result.accessToken.reveal()).toBe("polar_at_fixture_access_1");
    expect(result.refreshToken?.reveal()).toBe("polar_rt_fixture_refresh_1");
    expect(result.expiresAt).toEqual(new Date(now.getTime() + 864_000 * 1000));
    expect(result.scopes).toEqual(ALL_SCOPES);
    expect(result.tokenType).toBe("Bearer");
    expect(JSON.stringify(result)).not.toContain("fixture-id-token-not-kept");
  });

  it.each([
    { name: "a callback from another issuer", iss: "https://evil.example", verifierValue: verifier, error: InvalidResponseError },
    { name: "a missing code verifier", iss: undefined, verifierValue: undefined, error: TypeError },
    { name: "a code verifier one character short", iss: undefined, verifierValue: "a".repeat(42), error: TypeError },
  ])("refuses $name before calling Polar", async ({ iss, verifierValue, error }) => {
    const { fetch, calls } = fakeFetch({ "/v1/oauth2/token": ok(tokenFixture) });
    const { ctx } = context(fetch);

    await expect(
      polarAdapter.exchangeCode(
        {
          code: "polar_ac_fixture",
          redirectUri: "https://stackdash.example.com/cb",
          ...(verifierValue === undefined ? {} : { codeVerifier: verifierValue }),
          callbackParams: iss === undefined ? {} : { iss },
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(error);
    expect(calls).toHaveLength(0);
  });

  it("maps a 400 invalid_grant code to auth revoked and a 400 invalid_client to an invalid response", async () => {
    const grant = fakeFetch({ "/v1/oauth2/token": () => Response.json({ error: "invalid_grant" }, { status: 400 }) });
    const input = { code: "used", redirectUri: "https://x.example/cb", codeVerifier: verifier, callbackParams: {} };

    await expect(polarAdapter.exchangeCode(input, context(grant.fetch).ctx)).rejects.toBeInstanceOf(AuthRevokedError);

    const client = fakeFetch({ "/v1/oauth2/token": () => Response.json({ error: "invalid_client" }, { status: 400 }) });
    await expect(polarAdapter.exchangeCode(input, context(client.fetch).ctx)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("polarAdapter.refreshTokens", () => {
  it("rotates both tokens with the refresh grant on the pinned API version", async () => {
    const { fetch, calls } = fakeFetch({ "/v1/oauth2/token": ok(refreshFixture) });
    const { ctx } = context(fetch);

    const result = await polarAdapter.refreshTokens?.(credential(), ctx);

    expect(formBody(calls[0])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "polar_rt_fixture_refresh_1",
      client_id: "polar_ci_fixture_client",
      client_secret: clientSecret,
    });
    expect(header(calls[0], "polar-version")).toBe("2026-10");
    expect(result?.accessToken.reveal()).toBe("polar_at_fixture_access_2");
    expect(result?.refreshToken?.reveal()).toBe("polar_rt_fixture_refresh_2");
    expect(result?.expiresAt).toEqual(new Date(now.getTime() + 864_000 * 1000));
  });

  it("keeps the current refresh token when the answer carries none", async () => {
    const { fetch } = fakeFetch({ "/v1/oauth2/token": ok({ ...refreshFixture, refresh_token: null }) });
    const { ctx } = context(fetch);

    const result = await polarAdapter.refreshTokens?.(credential(), ctx);

    expect(result?.refreshToken?.reveal()).toBe("polar_rt_fixture_refresh_1");
  });

  it.each([
    ["400 invalid_grant (used, expired, or revoked refresh token)", 400, "invalid_grant"],
    ["401 invalid_grant (revoked grant)", 401, "invalid_grant"],
  ])("maps a %s to auth revoked, so the connection asks to reconnect", async (_title, status, error) => {
    const { fetch } = fakeFetch({ "/v1/oauth2/token": () => Response.json({ error }, { status }) });
    const { ctx } = context(fetch);

    await expect(polarAdapter.refreshTokens?.(credential(), ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  // RFC 6749 section 5.2 codes that are this instance's configuration, not the user's grant.
  it.each([
    ["400 invalid_client (wrong client id or secret)", 400, { error: "invalid_client" }],
    ["401 invalid_client (wrong client id or secret)", 401, { error: "invalid_client" }],
    ["400 invalid_request (malformed request)", 400, { error: "invalid_request" }],
    ["400 unsupported_grant_type", 400, { error: "unsupported_grant_type" }],
    ["400 without an OAuth error body", 400, { detail: "bad request" }],
  ])("keeps a %s as an invalid response, not auth revoked", async (_title, status, body) => {
    const { fetch } = fakeFetch({ "/v1/oauth2/token": () => Response.json(body, { status }) });
    const { ctx } = context(fetch);

    await expect(polarAdapter.refreshTokens?.(credential(), ctx)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("asks for a reconnect when the credential has no refresh token", async () => {
    const { fetch, calls } = fakeFetch({});
    const { ctx } = context(fetch);
    const { refreshToken: _dropped, ...withoutRefresh } = credential();

    await expect(polarAdapter.refreshTokens?.(withoutRefresh, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
    expect(calls).toHaveLength(0);
  });
});

describe("polarAdapter.revoke", () => {
  it("revokes the refresh token, then the access token, on the pinned API version", async () => {
    const { fetch, calls } = fakeFetch({ "/v1/oauth2/revoke": ok({}) });
    const { ctx } = context(fetch);

    await polarAdapter.revoke?.(credential(), ctx);

    expect(calls.map((call) => formBody(call))).toEqual([
      { token: "polar_rt_fixture_refresh_1", token_type_hint: "refresh_token", client_id: "polar_ci_fixture_client", client_secret: clientSecret },
      { token: "polar_at_fixture_access_1", token_type_hint: "access_token", client_id: "polar_ci_fixture_client", client_secret: clientSecret },
    ]);
    expect(calls.map((call) => header(call, "polar-version"))).toEqual(["2026-10", "2026-10"]);
  });

  it("revokes only the access token when there is no refresh token", async () => {
    const { fetch, calls } = fakeFetch({ "/v1/oauth2/revoke": ok({}) });
    const { ctx } = context(fetch);
    const { refreshToken: _dropped, ...withoutRefresh } = credential();

    await polarAdapter.revoke?.(withoutRefresh, ctx);

    expect(calls.map((call) => formBody(call).token_type_hint)).toEqual(["access_token"]);
  });
});

describe("polarAdapter.listAccounts", () => {
  it("lists every organization the grant can read, by id and name, on the pinned API version", async () => {
    const { fetch, calls } = fakeFetch({ "/v1/organizations/": ok(organizationsFixture) });
    const { ctx } = context(fetch);

    await expect(polarAdapter.listAccounts(credential(), ctx)).resolves.toEqual([
      { externalId: orgId, displayName: "Example organization", kind: "organization" },
      { externalId: "2a5c3f10-7d2e-4c11-8b3a-000000000002", displayName: "Side project", kind: "organization" },
    ]);
    expect(header(calls[0], "authorization")).toBe("Bearer polar_at_fixture_access_1");
    expect(header(calls[0], "polar-version")).toBe("2026-10");
    expect(calls[0]?.url.searchParams.get("limit")).toBe("100");
  });

  it("returns no accounts when the grant covers no organization", async () => {
    const { fetch } = fakeFetch({ "/v1/organizations/": emptyList });
    const { ctx } = context(fetch);

    await expect(polarAdapter.listAccounts(credential(), ctx)).resolves.toEqual([]);
  });
});

describe("polarAdapter.detectMissingPermissions", () => {
  it.each([
    { name: "every requested scope granted", scopes: ALL_SCOPES, missing: [] },
    { name: "empty grant misses everything", scopes: [], missing: ALL_SCOPES },
    { name: "a grant without refunds and customers", scopes: ALL_SCOPES.slice(0, 4), missing: ["customers:read", "refunds:read"] },
    { name: "a write scope does not stand in for a read scope", scopes: ["orders:write"], missing: ALL_SCOPES },
  ])("$name", ({ scopes, missing }) => {
    expect(polarAdapter.detectMissingPermissions({ scopes })).toEqual(missing);
  });
});

describe("polarAdapter.sync", () => {
  it("returns revenue as revenue, fees as spend, MRR and ARR as recurring revenue, counts, and timeline events", async () => {
    const { calls, result: pending } = sync(syncRoutes);
    const result = await pending;

    expect(validateAdapterMetrics("polar", result.metrics)).toMatchObject({ ok: true });
    expect(validateAdapterEvents(polarAdapter.eventTypes, result.events)).toMatchObject({ ok: true });
    // 54800.5 cents of revenue rounds half to even, once; fees are 54800.5 minus 51660.25 cents.
    expect(values(result.metrics)).toEqual({
      "polar.revenue.month.usd": 54800,
      "polar.fees.month.usd": 3140,
      "polar.orders.month": 14,
      "polar.subscriptions.new.month": 5,
      "polar.subscriptions.canceled.month": 2,
      "polar.mrr.usd": 158333,
      "polar.arr.usd": 1900000,
      "polar.subscriptions.active": 83,
      "polar.customers.new.month": 3,
    });
    const byKey = new Map(result.metrics.map((metric) => [metric.metricKey, metric]));
    expect(byKey.get("polar.revenue.month.usd")).toMatchObject({
      kind: "revenue",
      currency: "USD",
      timeframe: { type: "period", start: monthStart, end: now },
      provenance: { source: "provider_api", endpoint: "https://api.polar.sh/v1/metrics/" },
      externalAccountId: orgId,
      retrievedAt: now,
    });
    expect(byKey.get("polar.fees.month.usd")).toMatchObject({ kind: "verified_spend", currency: "USD" });
    expect(byKey.get("polar.mrr.usd")).toMatchObject({ kind: "recurring_revenue", timeframe: { type: "point", at: now } });
    expect(byKey.get("polar.orders.month")).toMatchObject({ kind: "usage", unit: "orders" });
    expect(byKey.get("polar.customers.new.month")).toMatchObject({
      kind: "usage",
      unit: "customers",
      provenance: { source: "provider_api", endpoint: "https://api.polar.sh/v1/customers/" },
    });

    expect(result.events.map((event) => [event.typeId, event.title, event.body ?? null, event.dedupeKey])).toEqual([
      ["polar.subscription.canceled", "Subscription canceled", null, "subscription_canceled:5ab5ab50-0000-4000-8000-000000000006"],
      ["polar.order.paid", "Order paid for a new subscription: $19.00", null, "order:0a1b2c3d-0000-4000-8000-000000000004"],
      ["polar.subscription.started", "Subscription started", null, "subscription_started:5ab5ab50-0000-4000-8000-000000000004"],
      ["polar.refund.succeeded", "Order refunded: $9.00", "Reason: customer request", "refund:7ef07ef0-0000-4000-8000-000000000001"],
      [
        "polar.subscription.canceled",
        "Subscription canceled",
        "Reason: too expensive. Access continues until the paid period ends.",
        "subscription_canceled:5ab5ab50-0000-4000-8000-000000000002",
      ],
      ["polar.order.paid", "Subscription renewed: $19.00", null, "order:0a1b2c3d-0000-4000-8000-000000000002"],
      ["polar.subscription.started", "Trial started", null, "subscription_started:5ab5ab50-0000-4000-8000-000000000005"],
      // The order's value after discounts and tax: $49.00 plus $9.80 tax.
      ["polar.order.paid", "Order paid: $58.80", null, "order:0a1b2c3d-0000-4000-8000-000000000001"],
    ]);
    expect(result.events[0]?.occurredAt).toEqual(new Date("2026-11-03T07:45:00Z"));
    expect(result.cursor).toBe(now.toISOString());
    expect(result.partialErrors).toBeUndefined();

    const at = (path: string, predicate: (url: URL) => boolean = () => true) =>
      calls.find((call) => call.url.pathname === path && predicate(call.url))?.url.searchParams;
    const metricsParams = new URLSearchParams(at("/v1/metrics/"));
    // One `metrics` slug per field read, so Polar runs only those queries.
    expect(metricsParams.getAll("metrics")).toEqual([
      "revenue",
      "net_revenue",
      "orders",
      "new_subscriptions",
      "canceled_subscriptions",
      "active_subscriptions",
      "monthly_recurring_revenue",
      "annual_recurring_revenue",
    ]);
    metricsParams.delete("metrics");
    expect(Object.fromEntries(metricsParams)).toEqual({
      start_date: "2026-11-01",
      end_date: "2026-11-10",
      interval: "day",
      timezone: "UTC",
      organization_id: orgId,
    });
    expect(Object.fromEntries(at("/v1/orders/") ?? [])).toEqual({
      organization_id: orgId,
      created_after: thirtyDaysAgo,
      sorting: "-created_at",
      page: "1",
      limit: "100",
    });
    expect(at("/v1/subscriptions/", (url) => url.searchParams.has("started_after"))?.get("started_after")).toBe(thirtyDaysAgo);
    expect(at("/v1/subscriptions/", (url) => url.searchParams.has("canceled_at_after"))?.get("canceled_at_after")).toBe(thirtyDaysAgo);
    expect(Object.fromEntries(at("/v1/refunds/") ?? [])).toEqual({
      organization_id: orgId,
      succeeded: "true",
      sorting: "-created_at",
      page: "1",
      limit: "100",
    });
    // Newest first: the first customer from before the month ends the walk on page one.
    expect(calls.filter((call) => call.url.pathname === "/v1/customers/")).toHaveLength(1);
    for (const call of calls) {
      expect(header(call, "polar-version"), call.url.pathname).toBe("2026-10");
      expect(header(call, "authorization")).toBe("Bearer polar_at_fixture_access_1");
    }
  });

  it("emits no customer names, emails, addresses, tax ids, metadata, or free text (privacy)", async () => {
    const result = await sync(syncRoutes).result;
    const emitted = JSON.stringify([result.metrics, result.events]);

    for (const personal of [
      "jane.doe@example.com",
      "Jane Doe",
      "Kim Loe",
      "1 Main Street",
      "Springfield",
      "EU123456789",
      "Acme Rockets",
      "VIP",
      "cheaper tool",
      "asked by phone",
      "c0ffee00",
      "Starter kit",
    ]) {
      expect(emitted).not.toContain(personal);
    }
    for (const field of ["email", "name", "billing_address", "tax_id", "metadata", "custom_field_data", "description"]) {
      expect(emitted).not.toContain(`"${field}"`);
    }
  });

  it("reads events from one day before the previous sync, and repeats the same dedupe keys on overlap", async () => {
    const first = await sync(syncRoutes).result;
    const later = new Date("2026-11-10T13:00:00Z");
    const { calls, result } = sync(syncRoutes, first.cursor, later);
    const second = await result;

    expect(calls.find((call) => call.url.pathname === "/v1/orders/")?.url.searchParams.get("created_after")).toBe("2026-11-09T12:00:00.000Z");
    // Only what falls inside the overlap window comes back, with the keys the first sync used.
    const firstKeys = new Set(first.events.map((event) => event.dedupeKey));
    expect(second.events.map((event) => event.dedupeKey)).toEqual([
      "subscription_started:5ab5ab50-0000-4000-8000-000000000005",
      "order:0a1b2c3d-0000-4000-8000-000000000001",
    ]);
    for (const event of second.events) expect(firstKeys.has(event.dedupeKey)).toBe(true);
    expect(second.cursor).toBe(later.toISOString());
  });

  it.each([
    { name: "not an ISO time", cursor: "1794312000", warning: "polar.events.cursor_invalid" },
    { name: "older than the 30 day backfill", cursor: "2026-09-01T00:00:00.000Z", warning: "polar.events.gap" },
  ])("reads the last 30 days and warns when the cursor is $name", async ({ cursor, warning }) => {
    const { calls, logger, result } = sync({ ...syncRoutes }, cursor);
    await result;

    expect(calls.find((call) => call.url.pathname === "/v1/orders/")?.url.searchParams.get("created_after")).toBe(thirtyDaysAgo);
    expect(logger.warn).toHaveBeenCalledWith(warning, expect.any(Object));
  });

  it("returns no metrics and no events for an organization with nothing yet, and advances the cursor", async () => {
    const result = await sync({
      "/v1/metrics/": emptyMetrics,
      "/v1/customers/": emptyList,
      "/v1/orders/": emptyList,
      "/v1/subscriptions/": emptyList,
      "/v1/refunds/": emptyList,
    }).result;

    expect(result.metrics.map((metric) => metric.metricKey)).toEqual(["polar.customers.new.month"]);
    expect(values(result.metrics)["polar.customers.new.month"]).toBe(0);
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe(now.toISOString());
  });

  it("reports revenue and fees as unavailable, never zero, when a day's revenue is missing", async () => {
    const periods = metricsFixture.periods.map((period, index) => (index === 4 ? { ...period, revenue: null } : period));
    const result = await sync({ ...syncRoutes, "/v1/metrics/": ok({ ...metricsFixture, periods }) }).result;

    const keys = result.metrics.map((metric) => metric.metricKey);
    expect(keys).not.toContain("polar.revenue.month.usd");
    expect(keys).not.toContain("polar.fees.month.usd");
    expect(keys).toContain("polar.mrr.usd");
    expect(keys).toContain("polar.orders.month");
  });

  it("drops fees, with a warning, when net revenue is above revenue", async () => {
    const periods = metricsFixture.periods.map((period) => ({ ...period, net_revenue: (period.revenue ?? 0) + 1 }));
    const { logger, result } = sync({ ...syncRoutes, "/v1/metrics/": ok({ ...metricsFixture, periods }) });
    const { metrics } = await result;

    expect(metrics.map((metric) => metric.metricKey)).not.toContain("polar.fees.month.usd");
    expect(values(metrics)["polar.revenue.month.usd"]).toBe(54800);
    expect(logger.warn).toHaveBeenCalledWith("polar.fees.net_credit", expect.any(Object));
  });

  it("at the first instant of a month reports run rates but no month totals", async () => {
    const at = new Date("2026-12-01T00:00:00Z");
    const periods = [{ ...metricsFixture.periods[9], timestamp: "2026-12-01T00:00:00.000000Z" }];
    const { calls, result } = sync({ ...syncRoutes, "/v1/metrics/": ok({ ...metricsFixture, periods }) }, undefined, at);
    const { metrics } = await result;

    expect(metrics.map((metric) => metric.metricKey).sort()).toEqual(["polar.arr.usd", "polar.mrr.usd", "polar.subscriptions.active"]);
    const params = calls.find((call) => call.url.pathname === "/v1/metrics/")?.url.searchParams;
    expect([params?.get("start_date"), params?.get("end_date")]).toEqual(["2026-12-01", "2026-12-01"]);
  });

  it("stops at the pagination cap of 10 pages and reports no partial customer count", async () => {
    let counter = 0;
    const page: Route = () => {
      counter += 1;
      return Response.json({
        items: [{ id: `c-${counter}`, created_at: "2026-11-09T00:00:00Z", email: "x@example.com" }],
        pagination: { total_count: 5000, max_page: 50 },
      });
    };
    const { calls, logger, result } = sync({ ...syncRoutes, "/v1/customers/": page });
    const { metrics } = await result;

    const customerCalls = calls.filter((call) => call.url.pathname === "/v1/customers/");
    expect(customerCalls).toHaveLength(10);
    expect(customerCalls.map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
    expect(metrics.map((metric) => metric.metricKey)).not.toContain("polar.customers.new.month");
    expect(logger.warn).toHaveBeenCalledWith("polar.customers.truncated", expect.any(Object));
  });

  it("keeps the events it read and warns when a timeline stream passes the page cap", async () => {
    const page: Route = (url) =>
      Response.json({
        items: [{ id: `o-${url.searchParams.get("page")}`, created_at: "2026-11-09T00:00:00Z", status: "paid", billing_reason: "purchase" }],
        pagination: { total_count: 5000, max_page: 50 },
      });
    const { logger, result } = sync({ ...syncRoutes, "/v1/orders/": page });
    const { events } = await result;

    expect(events.filter((event) => event.typeId === "polar.order.paid")).toHaveLength(10);
    expect(logger.warn).toHaveBeenCalledWith("polar.events.truncated", expect.objectContaining({ stream: "orders" }));
  });

  it("returns events and a partial error naming metrics:read when analytics are refused (403)", async () => {
    const result = await sync({ ...syncRoutes, "/v1/metrics/": () => Response.json({ detail: "Forbidden" }, { status: 403 }) }).result;

    expect(result.metrics.map((metric) => metric.metricKey)).toEqual(["polar.customers.new.month"]);
    expect(result.events).toHaveLength(8);
    expect(result.partialErrors).toHaveLength(1);
    expect(result.partialErrors?.[0]).toBeInstanceOf(PermissionMissingError);
    expect(result.partialErrors?.[0]?.missingScopes).toEqual(["metrics:read"]);
    expect(result.cursor).toBe(now.toISOString());
  });

  it("keeps the previous cursor when one timeline stream is refused (403)", async () => {
    const cursor = "2026-11-10T11:00:00.000Z";
    const result = await sync({ ...syncRoutes, "/v1/refunds/": () => Response.json({}, { status: 403 }) }, cursor).result;

    expect(result.cursor).toBe(cursor);
    expect(result.partialErrors?.map((error) => error.missingScopes)).toEqual([["refunds:read"]]);
    expect(result.events.some((event) => event.typeId === "polar.order.paid")).toBe(true);
  });

  it("throws auth revoked on 401", async () => {
    const unauthorized: Route = () => Response.json({ error: "invalid_token" }, { status: 401 });
    const routes = Object.fromEntries(Object.keys(syncRoutes).map((path) => [path, unauthorized]));

    await expect(sync(routes).result).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws rate limited with the Retry-After delay on 429", async () => {
    const limited: Route = () => Response.json({}, { status: 429, headers: { "Retry-After": "30" } });
    const error = await sync({ ...syncRoutes, "/v1/metrics/": limited }).result.catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ retryAfterMs: 30_000 });
  });

  it.each([
    {
      name: "revenue as a string",
      routes: { ...syncRoutes, "/v1/metrics/": ok({ periods: [{ ...metricsFixture.periods[0], revenue: "12000" }] }) },
    },
    {
      name: "negative revenue",
      routes: { ...syncRoutes, "/v1/metrics/": ok({ periods: [{ ...metricsFixture.periods[0], revenue: -1 }] }) },
    },
    {
      name: "an order without a status",
      routes: {
        ...syncRoutes,
        "/v1/orders/": ok({ items: [{ id: "o", created_at: "2026-11-09T00:00:00Z", billing_reason: "purchase" }], pagination: { total_count: 1, max_page: 1 } }),
      },
    },
    { name: "a list without pagination", routes: { ...syncRoutes, "/v1/refunds/": ok({ items: [] }) } },
  ])("throws invalid_response on a schema mismatch: $name", async ({ routes }) => {
    await expect(sync(routes).result).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe("polar payment events on the timeline (#261)", () => {
  const created_at = new Date("2026-11-10T09:30:00Z");

  it.each([
    { name: "a two-decimal currency", money: { total_amount: 1900, currency: "USD" }, title: "Subscription renewed: $19.00" },
    { name: "a zero-decimal currency (JPY)", money: { total_amount: 3000, currency: "JPY" }, title: "Subscription renewed: ¥3,000" },
    { name: "a missing amount", money: { currency: "USD" }, title: "Subscription renewed" },
    { name: "a missing currency", money: { total_amount: 1900 }, title: "Subscription renewed" },
  ])("titles a paid order with $name", ({ money, title }) => {
    const event = orderEvent({ id: "o", created_at, status: "paid", billing_reason: "subscription_cycle", ...money }, orgId);
    expect(event?.title).toBe(title);
  });

  it.each([
    { name: "before tax plus the tax refunded with it", money: { amount: 4900, tax_amount: 980, currency: "EUR" }, title: "Order refunded: €58.80" },
    { name: "in a zero-decimal currency (JPY)", money: { amount: 1500, tax_amount: 150, currency: "JPY" }, title: "Order refunded: ¥1,650" },
    { name: "with no amount when the tax part is missing", money: { amount: 4900, currency: "USD" }, title: "Order refunded" },
    { name: "with no amount when the amount is missing", money: { tax_amount: 980, currency: "USD" }, title: "Order refunded" },
  ])("titles a refund $name", ({ money, title }) => {
    const event = refundEvent({ id: "r", created_at, status: "succeeded", reason: "duplicate", ...money }, orgId);
    expect(event?.title).toBe(title);
  });

  it("reads the amount and an uppercase currency from Polar's lowercase code at the parse boundary", async () => {
    const order = { ...ordersFixture.items[0], currency: "jpy", total_amount: 3000 };
    const result = await sync({ ...syncRoutes, "/v1/orders/": ok({ ...ordersFixture, items: [order] }) }).result;
    expect(result.events.find((event) => event.typeId === "polar.order.paid")?.title).toBe("Order paid: ¥3,000");
  });
});

describe("polarAdapter declarations", () => {
  it("is OAuth with PKCE, reads by default, polled hourly, and declares the four timeline event types", () => {
    expect(polarAdapter.oauth.pkce).toBe(true);
    expect(polarAdapter.oauth.scopes).toEqual(ALL_SCOPES);
    expect(polarAdapter.permissions.every((permission) => permission.access === "read")).toBe(true);
    expect(polarAdapter.pollIntervalSeconds).toBe(3600);
    expect(polarAdapter.capabilities).toMatchObject({ revenue: true, spending: true });
    expect(polarAdapter.eventTypes.map((eventType) => eventType.id)).toEqual([
      "polar.order.paid",
      "polar.subscription.started",
      "polar.subscription.canceled",
      "polar.refund.succeeded",
    ]);
    // Webhooks are declared (#429): polling stays, and they pass the contract's checks.
    expect(polarAdapter.webhooks).toBeDefined();
    expect(checkAdapterDeclaration(polarAdapter)).toEqual([]);
  });
});

describe("polarAdapter webhooks (#429)", () => {
  // Made up, and built from parts so CI's secret scan (gitleaks) does not read it as a credential:
  // `whsec_` and the base64 of 32 synthetic bytes, shaped like a Standard Webhooks secret.
  const SIGNING_SECRET = new Secret(["whsec", Buffer.from("synthetic-polar-signing-key-32by").toString("base64")].join("_"));
  const DELIVERY_ID = "msg_synthetic0000000000000001";
  const NOW_SECONDS = String(now.getTime() / 1000);
  const ORDER_BODY = JSON.stringify(webhookOrderPaid);

  function descriptor(): WebhookDescriptor {
    const { webhooks } = polarAdapter;
    if (webhooks === undefined) throw new Error("the Polar adapter declares no webhook");
    return webhooks;
  }

  function automatic() {
    const { registration } = descriptor();
    if (registration.kind !== "connection" || registration.setup.secretSource !== "provider") {
      throw new Error("expected a per-connection webhook whose secret Polar generates");
    }
    const { automatic: setup } = registration.setup;
    if (setup === undefined) throw new Error("expected automatic setup");
    return setup;
  }

  type Delivery = Partial<{
    id: string | null;
    timestamp: string | null;
    signature: string | null;
    secret: Secret;
    signedId: string;
    signedBody: string;
  }>;

  // A delivery as Polar sends it. Each option bends one part for a boundary test.
  function delivery(rawBody: string, options: Delivery = {}): WebhookRequest {
    const id = options.id === undefined ? DELIVERY_ID : options.id;
    const timestamp = options.timestamp === undefined ? NOW_SECONDS : options.timestamp;
    const headers = new Headers({ "content-type": "application/json" });
    if (id !== null) headers.set(STANDARD_WEBHOOK_HEADERS.delivery, id);
    if (timestamp !== null) headers.set(STANDARD_WEBHOOK_HEADERS.timestamp, timestamp);
    const signature =
      options.signature === undefined
        ? polarWebhookSignature(
            options.secret ?? SIGNING_SECRET,
            options.signedId ?? id ?? "",
            timestamp ?? "",
            new TextEncoder().encode(options.signedBody ?? rawBody),
          )
        : options.signature;
    if (signature !== null) headers.set(STANDARD_WEBHOOK_HEADERS.signature, signature);
    return { headers, rawBody: new TextEncoder().encode(rawBody) };
  }

  function parseCtx() {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const ctx: AdapterContext = { fetch: () => Promise.reject(new Error("no network in parse")), now: () => now, timeoutMs: 1000, logger };
    return { ctx, logger };
  }

  function parsed(rawBody: string) {
    const request = delivery(rawBody);
    expect(descriptor().verify(request, SIGNING_SECRET, now)).toEqual({ ok: true, deliveryId: DELIVERY_ID });
    return descriptor().parse(request, parseCtx().ctx);
  }

  function withData(fixture: { data: object }, type: string, overrides: Record<string, unknown>): string {
    return JSON.stringify({ ...fixture, type, data: { ...fixture.data, ...overrides } });
  }

  /** The event the sync stores for `dedupeKey` from the list fixtures. */
  async function polled(dedupeKey: string) {
    const event = (await sync(syncRoutes).result).events.find((candidate) => candidate.dedupeKey === dedupeKey);
    expect(event).toBeDefined();
    return event;
  }

  it("is per connection, with Polar's secret, automatic setup asking for webhooks:write, and the timeline's events", () => {
    const { registration, subscriptions } = descriptor();
    expect(registration.kind).toBe("connection");
    if (registration.kind !== "connection") return;
    expect(registration.setup.secretSource).toBe("provider");
    expect(registration.setup.manualSteps.join(" ")).toContain(subscriptions.join(", "));
    expect(automatic().extraPermissions.map((permission) => [permission.scope, permission.access])).toEqual([["webhooks:write", "full"]]);
    expect(automatic().extraPermissions[0]?.fullAccessReason).toMatch(/^Polar has no read-only access that can create a webhook\./);
    // A Polar endpoint belongs to one organization: automatic setup is refused before any consent otherwise.
    expect(automatic().accounts).toBe("one");
    expect(subscriptions).toEqual([
      "order.paid",
      "subscription.created",
      "subscription.active",
      "subscription.canceled",
      "subscription.revoked",
      "refund.created",
      "refund.updated",
    ]);
  });

  // The scheme itself (headers, freshness, replay, every entry compared) is tested in
  // src/lib/webhooks/standard-webhooks.test.ts. These are Polar's: the two keys one secret stands for.
  describe("verify", () => {
    it("verifies a delivery for a secret made since 2026-09-08, keyed by the base64 after whsec_, from Polar's headers", () => {
      expect(descriptor().verify(delivery(ORDER_BODY), SIGNING_SECRET, now)).toEqual({ ok: true, deliveryId: DELIVERY_ID });
    });

    it("verifies a delivery for a secret made before 2026-09-08, keyed by the UTF-8 bytes of the whole secret", () => {
      const signed = Buffer.concat([Buffer.from(`${DELIVERY_ID}.${NOW_SECONDS}.`), Buffer.from(ORDER_BODY)]);
      const original = `v1,${createHmac("sha256", Buffer.from(SIGNING_SECRET.reveal(), "utf8")).update(signed).digest("base64")}`;
      expect(descriptor().verify(delivery(ORDER_BODY, { signature: original }), SIGNING_SECRET, now)).toEqual({ ok: true, deliveryId: DELIVERY_ID });
    });

    it("rejects a delivery signed under another secret's keys", () => {
      const other = new Secret(["whsec", Buffer.from("another-synthetic-signing-key-32").toString("base64")].join("_"));
      expect(descriptor().verify(delivery(ORDER_BODY, { secret: other }), SIGNING_SECRET, now)).toEqual({ ok: false, reason: "bad_signature" });
    });

    it("verifies nothing with a secret too short to be one Polar made (boundary: under 16 bytes either way)", () => {
      const short = "whsec_c2hvcnQ";
      const signed = Buffer.concat([Buffer.from(`${DELIVERY_ID}.${NOW_SECONDS}.`), Buffer.from(ORDER_BODY)]);
      const signature = `v1,${createHmac("sha256", Buffer.from(short, "utf8")).update(signed).digest("base64")}`;
      expect(descriptor().verify(delivery(ORDER_BODY, { signature }), new Secret(short), now)).toEqual({ ok: false, reason: "bad_signature" });
    });
  });

  describe("parse", () => {
    it("maps order.paid to the event the sync stores for the same order, for the organization the delivery names", async () => {
      const outcome = parsed(ORDER_BODY);
      expect(checkWebhookOutcome(polarAdapter, outcome)).toEqual([]);
      expect(outcome).toEqual({ kind: "events", externalAccountId: orgId, events: [await polled("order:0a1b2c3d-0000-4000-8000-000000000001")] });
    });

    it("maps subscription.active and subscription.created to the sync's started event (one dedupe key)", async () => {
      const started = await polled("subscription_started:5ab5ab50-0000-4000-8000-000000000004");
      expect(parsed(JSON.stringify(webhookSubscriptionActive))).toEqual({ kind: "events", externalAccountId: orgId, events: [started] });
      expect(parsed(withData(webhookSubscriptionActive, "subscription.created", {}))).toEqual({ kind: "events", externalAccountId: orgId, events: [started] });
    });

    it("maps subscription.canceled and a canceled subscription.revoked to the sync's canceled event", async () => {
      const canceled = await polled("subscription_canceled:5ab5ab50-0000-4000-8000-000000000002");
      expect(parsed(JSON.stringify(webhookSubscriptionCanceled))).toEqual({ kind: "events", externalAccountId: orgId, events: [canceled] });
      expect(parsed(withData(webhookSubscriptionCanceled, "subscription.revoked", { status: "canceled" }))).toEqual({
        kind: "events",
        externalAccountId: orgId,
        events: [canceled],
      });
    });

    it("maps a succeeded refund.updated to the sync's refund event", async () => {
      const refund = await polled("refund:7ef07ef0-0000-4000-8000-000000000001");
      expect(parsed(JSON.stringify(webhookRefundUpdated))).toEqual({ kind: "events", externalAccountId: orgId, events: [refund] });
    });

    it.each<[string, string]>([
      ["a subscription created before its first payment (no started_at)", withData(webhookSubscriptionActive, "subscription.created", { status: "incomplete", started_at: null })],
      ["a subscription revoked for unpaid renewals (no canceled_at)", withData(webhookSubscriptionActive, "subscription.revoked", { status: "unpaid", canceled_at: null })],
      ["a refund created pending", withData(webhookRefundUpdated, "refund.created", { status: "pending" })],
      ["an order paid event for a draft order", withData(webhookOrderPaid, "order.paid", { status: "draft" })],
    ])("ignores %s, as the sync does", (_name, body) => {
      expect(parsed(body)).toEqual({ kind: "ignored", reason: "not on the timeline yet" });
    });

    it.each<[string, string, string]>([
      ["an event type StackDash does not subscribe to", JSON.stringify({ ...webhookOrderPaid, type: "checkout.created" }), "event type is not on the timeline"],
      ["order.refunded, which names no refund", JSON.stringify({ ...webhookOrderPaid, type: "order.refunded" }), "event type is not on the timeline"],
      ["a body that is not JSON", "not json", "body is not JSON"],
      ["a body without a type (boundary: empty object)", "{}", "not a Polar webhook delivery"],
    ])("ignores %s", (_name, body, reason) => {
      expect(parsed(body)).toEqual({ kind: "ignored", reason });
    });

    it.each<[string, string, "events" | "ignored"]>([
      ["exactly at the sync's 30 day floor (boundary)", thirtyDaysAgo, "events"],
      ["one millisecond before the floor (boundary)", "2026-10-11T11:59:59.999Z", "ignored"],
    ])("keeps or drops an event dated %s, as the sync does", (_name, createdAt, kind) => {
      expect(parsed(withData(webhookOrderPaid, "order.paid", { created_at: createdAt })).kind).toBe(kind);
    });

    it("drops a recovered payment's subscription.active naming a start months ago, which the sync would never store", () => {
      expect(parsed(withData(webhookSubscriptionActive, "subscription.active", { started_at: "2026-03-01T00:00:00.000Z" }))).toEqual({
        kind: "ignored",
        reason: "older than the sync's window",
      });
    });

    it("ignores a subscribed event in a shape it cannot read, and logs its type only", () => {
      const { ctx, logger } = parseCtx();
      const body = withData(webhookOrderPaid, "order.paid", { customer: { email: "jane.doe@example.com" } });
      expect(descriptor().parse(delivery(body), ctx)).toEqual({ kind: "ignored", reason: "not a delivery Polar maps" });
      expect(logger.warn).toHaveBeenCalledWith("polar.webhook.unreadable", { type: "order.paid" });
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("jane");
    });

    it("keeps no customer name, email, address, tax id, metadata, or comment from any delivery (privacy)", () => {
      const outcomes = [webhookOrderPaid, webhookSubscriptionActive, webhookSubscriptionCanceled, webhookRefundUpdated].map((fixture) => parsed(JSON.stringify(fixture)));
      const serialized = JSON.stringify(outcomes);
      for (const dropped of ["Jane", "jane.doe", "Main Street", "EU123456789", "VIP", "Acme Rockets", "cheaper tool", "phone"]) {
        expect(serialized).not.toContain(dropped);
      }
    });
  });

  describe("automatic setup", () => {
    const URL_FOR_CONNECTION = "https://stackdash.example.com/api/webhooks/polar/0f0f0f0f-0000-4000-8000-000000000001";
    const writeCredential = credential({ scopes: [...ALL_SCOPES, "webhooks:write"] });

    it("creates the endpoint in the connection's organization and keeps Polar's secret", async () => {
      const created = { ...webhookEndpointCreated, secret: SIGNING_SECRET.reveal() };
      const { fetch, calls } = fakeFetch({ "/v1/webhooks/endpoints": () => Response.json(created, { status: 201 }) });
      const result = await automatic().create({ credential: writeCredential, url: URL_FOR_CONNECTION, externalAccountIds: [orgId] }, context(fetch).ctx);
      expect(result.webhookId).toBe("e0d0e0d0-0000-4000-8000-000000000001");
      expect(result.secret.reveal()).toBe(SIGNING_SECRET.reveal());
      expect(calls).toHaveLength(1);
      expect(calls[0]?.init?.method).toBe("POST");
      expect(header(calls[0], "authorization")).toBe("Bearer polar_at_fixture_access_1");
      expect(header(calls[0], "polar-version")).toBe("2026-10");
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
        url: URL_FOR_CONNECTION,
        name: "StackDash",
        format: "raw",
        api_version: "2026-10",
        events: descriptor().subscriptions,
        organization_id: orgId,
      });
    });

    it.each<[string, string[]]>([
      ["no organization (boundary: none)", []],
      ["two organizations (boundary: many)", [orgId, "2ecfc517-0bbf-4301-9ba8-555ca42b9737"]],
    ])("creates nothing for a connection with %s", async (_name, externalAccountIds) => {
      const { fetch, calls } = fakeFetch({});
      await expect(automatic().create({ credential: writeCredential, url: URL_FOR_CONNECTION, externalAccountIds }, context(fetch).ctx)).rejects.toThrow(RangeError);
      expect(calls).toHaveLength(0);
    });

    it.each<[string, Record<string, unknown>]>([
      ["no secret (boundary: missing)", { secret: undefined }],
      ["a secret too short to verify anything (boundary: under 16 bytes)", { secret: "whsec_c2hvcnQ" }],
    ])("deletes the endpoint again and fails when Polar answers with %s", async (_name, change) => {
      const created = { ...webhookEndpointCreated, ...change };
      const { fetch, calls } = fakeFetch({
        "/v1/webhooks/endpoints": () => Response.json(created, { status: 201 }),
        "/v1/webhooks/endpoints/e0d0e0d0-0000-4000-8000-000000000001": () => new Response(null, { status: 204 }),
      });
      await expect(
        automatic().create({ credential: writeCredential, url: URL_FOR_CONNECTION, externalAccountIds: [orgId] }, context(fetch).ctx),
      ).rejects.toThrow(InvalidResponseError);
      expect(calls.map((call) => call.init?.method)).toEqual(["POST", "DELETE"]);
    });

    it.each<[string, number, new (...args: never[]) => Error]>([
      ["a grant without webhooks:write (403)", 403, PermissionMissingError],
      ["an expired or revoked token (401)", 401, AuthRevokedError],
      ["an endpoint Polar refuses (422)", 422, InvalidResponseError],
    ])("fails on %s", async (_name, status, errorClass) => {
      const { fetch } = fakeFetch({ "/v1/webhooks/endpoints": () => Response.json({ detail: [] }, { status }) });
      await expect(automatic().create({ credential: writeCredential, url: URL_FOR_CONNECTION, externalAccountIds: [orgId] }, context(fetch).ctx)).rejects.toThrow(errorClass);
    });

    it("deletes the endpoint on disconnect", async () => {
      const { fetch, calls } = fakeFetch({ "/v1/webhooks/endpoints/e0d0e0d0-0000-4000-8000-000000000001": () => new Response(null, { status: 204 }) });
      await automatic().remove({ credential: writeCredential, webhookId: "e0d0e0d0-0000-4000-8000-000000000001" }, context(fetch).ctx);
      expect(calls[0]?.init?.method).toBe("DELETE");
      expect(header(calls[0], "authorization")).toBe("Bearer polar_at_fixture_access_1");
      expect(header(calls[0], "polar-version")).toBe("2026-10");
    });

    it("treats an endpoint already deleted in Polar (404) as removed", async () => {
      const { fetch } = fakeFetch({ "/v1/webhooks/endpoints/gone": () => Response.json({ detail: "Not found" }, { status: 404 }) });
      const { ctx, logger } = context(fetch);
      await expect(automatic().remove({ credential: writeCredential, webhookId: "gone" }, ctx)).resolves.toBeUndefined();
      expect(logger.info).toHaveBeenCalledWith("polar.webhook.already_removed", { provider: "polar" });
    });

    it("fails when Polar cannot delete the endpoint (500), so the user gets the steps by hand", async () => {
      const { fetch } = fakeFetch({ "/v1/webhooks/endpoints/e1": () => new Response(null, { status: 500 }) });
      await expect(automatic().remove({ credential: writeCredential, webhookId: "e1" }, context(fetch).ctx)).rejects.toThrow(ProviderUnavailableError);
    });
  });
});
