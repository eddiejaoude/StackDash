import { describe, expect, it, vi } from "vitest";
import {
  AuthRevokedError,
  InvalidResponseError,
  PermissionMissingError,
  RateLimitedError,
} from "@/lib/adapters/errors";
import { validateAdapterEvents } from "@/lib/adapters/events";
import { checkAdapterDeclaration, checkWebhookOutcome, dashboardSpendAfterSync } from "@/lib/adapters/harness";
import { validateAdapterMetrics } from "@/lib/adapters/metrics";
import { Secret, type FetchLike, type OAuthContext, type OAuthCredential, type WebhookDescriptor, type WebhookRequest } from "@/lib/adapters/types";
import { signStripeWebhook, STRIPE_SIGNATURE_HEADER, STRIPE_WEBHOOK_TOLERANCE_SECONDS, stripeAdapter, toActivityEvent } from "./index";
// Fixtures are from documentation, not recorded: shaped after the sample responses and object
// fields on docs/providers/stripe.md, trimmed, with synthetic ids, amounts, and personal data.
import balanceTransactionsFixture from "./fixtures/balance-transactions.json";
// From documentation, not recorded: event list with charge, customer, and subscription snapshots
// full of synthetic personal data, to prove none of it survives the parse boundary.
import eventsFixture from "./fixtures/events.json";
// From documentation, not recorded: the documented token response for a refresh (test mode install).
import refreshFixture from "./fixtures/token-refresh.json";
// From documentation, not recorded: the documented token response for a code exchange (live mode).
import tokenFixture from "./fixtures/token.json";
// From documentation, not recorded: webhook deliveries shaped after Stripe's Event object and the
// install event samples on docs.stripe.com/stripe-apps/events, with `account` set as a Connect
// endpoint receives it. The charge is the polled `evt_fixture_charge_succeeded` above, delivered.
import webhookApplicationDeauthorizedFixture from "./fixtures/webhook-application-deauthorized.json";
import webhookChargeSucceededFixture from "./fixtures/webhook-charge-succeeded.json";
import webhookInstallDeletedFixture from "./fixtures/webhook-install-deleted.json";

const now = new Date("2026-11-10T12:00:00Z");
const nowSeconds = 1794312000;
const retentionStartSeconds = nowSeconds - 30 * 24 * 60 * 60;
const monthStart = new Date("2026-11-01T00:00:00Z");
const thirtyDaysAgo = new Date("2026-10-11T12:00:00Z");
const accountId = "acct_fixture123";
const liveKey = "sk_live_fixture_owner";
const testKey = "sk_test_fixture_owner";

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
const emptyList = ok({ object: "list", data: [], has_more: false });

function context(fetch: FetchLike, extra: Record<string, Secret> = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: OAuthContext = {
    fetch,
    now: () => now,
    timeoutMs: 1000,
    logger,
    client: { clientId: "ca_fixture_client", clientSecret: new Secret(liveKey), extra },
  };
  return { ctx, logger };
}

function credential(livemode = true, metadata?: Record<string, string>): OAuthCredential {
  return {
    accessToken: new Secret("stripe_access_token_fixture_1"),
    refreshToken: new Secret("stripe_refresh_token_fixture_1"),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
    scopes: ["stripe_apps"],
    tokenType: "bearer",
    metadata: metadata ?? { stripeUserId: accountId, livemode: String(livemode) },
  };
}

function header(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init?.headers).get(name);
}

function formBody(call: Call | undefined): URLSearchParams {
  return new URLSearchParams(String(call?.init?.body));
}

const basic = (key: string) => `Basic ${btoa(`${key}:`)}`;

const syncRoutes = {
  "/v1/balance_transactions": ok(balanceTransactionsFixture),
  "/v1/events": ok(eventsFixture),
};

function amounts(metrics: readonly { metricKey: string; amountMinor?: number }[]) {
  return Object.fromEntries(metrics.map((metric) => [metric.metricKey, metric.amountMinor]));
}

describe("stripeAdapter.buildAuthorizeUrl", () => {
  it("builds the install link with client id, redirect, and state, and no PKCE or scopes", () => {
    const url = stripeAdapter.buildAuthorizeUrl({
      client: { clientId: "ca_fixture_client", clientSecret: new Secret(liveKey), extra: {} },
      state: "state-123",
      redirectUri: "https://stackdash.example.com/api/connections/stripe/callback",
      codeChallenge: "ignored",
    });
    expect(`${url.origin}${url.pathname}`).toBe("https://marketplace.stripe.com/oauth/v2/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "ca_fixture_client",
      redirect_uri: "https://stackdash.example.com/api/connections/stripe/callback",
      state: "state-123",
    });
    expect(stripeAdapter.oauth.pkce).toBe(false);
  });
});

describe("stripeAdapter.exchangeCode", () => {
  it("posts the code with the owner's secret key as Basic auth and returns a 1 hour credential with metadata", async () => {
    const { fetch, calls } = fakeFetch({ "/v1/oauth/token": ok(tokenFixture) });
    const { ctx } = context(fetch);

    const result = await stripeAdapter.exchangeCode(
      { code: "ac_fixture", redirectUri: "https://stackdash.example.com/cb", callbackParams: { code: "ac_fixture", state: "s" } },
      ctx,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]?.init?.method).toBe("POST");
    expect(header(calls[0], "authorization")).toBe(basic(liveKey));
    expect(Object.fromEntries(formBody(calls[0]))).toEqual({ grant_type: "authorization_code", code: "ac_fixture" });
    expect(result.accessToken.reveal()).toBe("stripe_access_token_fixture_1");
    expect(result.refreshToken?.reveal()).toBe("stripe_refresh_token_fixture_1");
    expect(result.expiresAt).toEqual(new Date(now.getTime() + 60 * 60 * 1000));
    expect(result.scopes).toEqual(["stripe_apps"]);
    expect(result.tokenType).toBe("bearer");
    expect(result.metadata).toEqual({ stripeUserId: accountId, livemode: "true" });
    expect(JSON.stringify(result)).not.toContain("pk_live_fixture");
  });

  it("retries with the test mode key when the live key is rejected (400) and a test key is configured", async () => {
    const { fetch, calls } = fakeFetch({
      "/v1/oauth/token": (_url, init) =>
        new Headers(init?.headers).get("authorization") === basic(liveKey)
          ? Response.json({ error: "invalid_grant" }, { status: 400 })
          : Response.json(refreshFixture),
    });
    const { ctx } = context(fetch, { testSecretKey: new Secret(testKey) });

    const result = await stripeAdapter.exchangeCode(
      { code: "ac_fixture", redirectUri: "https://stackdash.example.com/cb", callbackParams: {} },
      ctx,
    );

    expect(calls.map((call) => header(call, "authorization"))).toEqual([basic(liveKey), basic(testKey)]);
    expect(result.metadata).toEqual({ stripeUserId: accountId, livemode: "false" });
  });

  it("does not retry a rejected code (400) when no test key is configured", async () => {
    const { fetch, calls } = fakeFetch({
      "/v1/oauth/token": () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    const { ctx } = context(fetch);

    await expect(
      stripeAdapter.exchangeCode({ code: "ac_used", redirectUri: "https://x.example/cb", callbackParams: {} }, ctx),
    ).rejects.toBeInstanceOf(InvalidResponseError);
    expect(calls).toHaveLength(1);
  });
});

describe("stripeAdapter.refreshTokens", () => {
  it("rotates the refresh token using the test mode key for a test mode install", async () => {
    const { fetch, calls } = fakeFetch({ "/v1/oauth/token": ok(refreshFixture) });
    const { ctx } = context(fetch, { testSecretKey: new Secret(testKey) });

    const result = await stripeAdapter.refreshTokens?.(credential(false), ctx);

    expect(header(calls[0], "authorization")).toBe(basic(testKey));
    expect(Object.fromEntries(formBody(calls[0]))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "stripe_refresh_token_fixture_1",
    });
    expect(result?.refreshToken?.reveal()).toBe("stripe_refresh_token_fixture_2");
    expect(result?.expiresAt).toEqual(new Date(now.getTime() + 60 * 60 * 1000));
    expect(result?.metadata).toEqual({ stripeUserId: accountId, livemode: "false" });
  });

  it("maps a rejected refresh token (400 invalid_grant) to auth revoked", async () => {
    const { fetch } = fakeFetch({
      "/v1/oauth/token": () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    const { ctx } = context(fetch);

    await expect(stripeAdapter.refreshTokens?.(credential(true), ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("rejects a refresh answered for a different account as invalid_response", async () => {
    const { fetch } = fakeFetch({ "/v1/oauth/token": ok({ ...refreshFixture, stripe_user_id: "acct_other" }) });
    const { ctx } = context(fetch);

    await expect(stripeAdapter.refreshTokens?.(credential(false), ctx)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("stripeAdapter.listAccounts", () => {
  it("returns the connected account from the grant metadata without an API call", async () => {
    const { fetch, calls } = fakeFetch({});
    const { ctx } = context(fetch);

    await expect(stripeAdapter.listAccounts(credential(false), ctx)).resolves.toEqual([
      { externalId: accountId, displayName: `Stripe account ${accountId} (test mode)`, kind: "account" },
    ]);
    expect(calls).toHaveLength(0);
  });

  it("asks for a reconnect when the credential has no account metadata", async () => {
    const { fetch } = fakeFetch({});
    const { ctx } = context(fetch);

    await expect(stripeAdapter.listAccounts(credential(true, {}), ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("stripeAdapter.detectMissingPermissions", () => {
  it.each([
    { name: "app grant covers every manifest permission", scopes: ["stripe_apps"], missing: [] },
    {
      name: "empty grant misses everything",
      scopes: [],
      missing: ["event_read", "charge_read", "customer_read", "subscription_read", "balance_read"],
    },
    {
      name: "partial permission list",
      scopes: ["event_read", "charge_read", "customer_read"],
      missing: ["subscription_read", "balance_read"],
    },
    {
      name: "a listed grant that also holds permissions no longer requested misses nothing",
      scopes: ["event_read", "charge_read", "customer_read", "subscription_read", "invoice_read", "balance_read", "payout_read"],
      missing: [],
    },
  ])("$name", ({ scopes, missing }) => {
    expect(stripeAdapter.detectMissingPermissions({ scopes })).toEqual(missing);
  });
});

describe("stripeAdapter.sync", () => {
  it("returns valid fee and revenue metrics per currency and timeline events on the happy path", async () => {
    const { fetch, calls } = fakeFetch(syncRoutes);
    const { ctx } = context(fetch);

    const result = await stripeAdapter.sync({ credential: credential(), externalAccountId: accountId }, ctx);

    const metrics = validateAdapterMetrics("stripe", result.metrics);
    const events = validateAdapterEvents(stripeAdapter.eventTypes, result.events);
    expect(metrics.ok).toBe(true);
    expect(events.ok).toBe(true);

    // application_fee and the transfer are excluded; the separate stripe_fee transaction and fee tax count.
    expect(amounts(result.metrics)).toEqual({
      "stripe.fees.month.eur": 122,
      "stripe.fees.month.jpy": 54,
      "stripe.fees.month.usd": 298,
      "stripe.revenue.month.eur": 3000,
      "stripe.revenue.month.jpy": 1500,
      "stripe.revenue.month.usd": 1000,
      "stripe.fees.last_30_days.eur": 122,
      "stripe.fees.last_30_days.jpy": 54,
      "stripe.fees.last_30_days.usd": 473,
      "stripe.revenue.last_30_days.eur": 3000,
      "stripe.revenue.last_30_days.jpy": 1500,
      "stripe.revenue.last_30_days.usd": 6000,
    });
    const usdMonthFees = result.metrics.find((metric) => metric.metricKey === "stripe.fees.month.usd");
    expect(usdMonthFees).toMatchObject({
      kind: "verified_spend",
      currency: "USD",
      externalAccountId: accountId,
      retrievedAt: now,
      timeframe: { type: "period", start: monthStart, end: now },
      provenance: { source: "provider_api", endpoint: "https://api.stripe.com/v1/balance_transactions" },
    });
    expect(result.metrics.find((metric) => metric.metricKey === "stripe.revenue.last_30_days.usd")).toMatchObject({
      kind: "revenue",
      timeframe: { type: "period", start: thirtyDaysAgo, end: now },
    });

    expect(result.events.map((event) => [event.typeId, event.title, event.dedupeKey])).toEqual([
      ["stripe.charge.refunded", "Payment partially refunded: $5.00 of $20.00 so far", "evt_fixture_charge_refunded"],
      ["stripe.charge.failed", "Payment failed: $15.00", "evt_fixture_charge_failed"],
      ["stripe.charge.succeeded", "Payment succeeded: $20.00", "evt_fixture_charge_succeeded"],
      ["stripe.customer.created", "New customer", "evt_fixture_customer_created"],
      ["stripe.customer.subscription.created", "Subscription created", "evt_fixture_subscription_created"],
      ["stripe.customer.subscription.deleted", "Subscription ended", "evt_fixture_subscription_deleted"],
    ]);
    expect(result.events[1]?.body).toBe("The card issuer declined the payment.");
    expect(result.events[0]?.occurredAt).toEqual(new Date(1794308400 * 1000));
    expect(result.cursor).toBe("1794308400");
    expect(result.partialErrors).toBeUndefined();

    const balanceCall = calls.find((call) => call.url.pathname === "/v1/balance_transactions");
    expect(balanceCall?.url.searchParams.get("created[gte]")).toBe(String(thirtyDaysAgo.getTime() / 1000));
    expect(balanceCall?.url.searchParams.get("limit")).toBe("100");
    expect(header(balanceCall, "authorization")).toBe("Bearer stripe_access_token_fixture_1");
    expect(header(balanceCall, "stripe-version")).toBe("2026-10-28.endive");
    expect(header(balanceCall, "stripe-account")).toBeNull();
    const eventsCall = calls.find((call) => call.url.pathname === "/v1/events");
    expect(eventsCall?.url.searchParams.get("created[gte]")).toBe(String(retentionStartSeconds));
    expect(eventsCall?.url.searchParams.getAll("types[]")).toEqual([
      "charge.succeeded",
      "charge.failed",
      "charge.refunded",
      "customer.created",
      "customer.subscription.created",
      "customer.subscription.deleted",
    ]);
  });

  it("counts Stripe spend once on the dashboard: this month's fees per currency, not the rolling 30 days", async () => {
    const { fetch } = fakeFetch(syncRoutes);
    const result = await stripeAdapter.sync({ credential: credential(), externalAccountId: accountId }, context(fetch).ctx);
    // Each currency's fees twice: this month, and the last 30 days that hold this month's fees too.
    expect(amounts(result.metrics.filter((metric) => metric.kind === "verified_spend"))).toEqual({
      "stripe.fees.month.eur": 122,
      "stripe.fees.month.jpy": 54,
      "stripe.fees.month.usd": 298,
      "stripe.fees.last_30_days.eur": 122,
      "stripe.fees.last_30_days.jpy": 54,
      "stripe.fees.last_30_days.usd": 473,
    });
    // November's fees in balance-transactions.json, per currency: EUR 117 + 5 on the euro charge;
    // JPY 54; USD 88 + 10 on today's charge (its 50 application fee goes to a platform, not Stripe)
    // plus the 200 stripe_fee transaction. The 30 days again would add 122, 54, and 473.
    const once = [
      { currency: "EUR", verifiedMinor: 117 + 5, estimatedMinor: null },
      { currency: "JPY", verifiedMinor: 54, estimatedMinor: null },
      { currency: "USD", verifiedMinor: 88 + 10 + 200, estimatedMinor: null },
    ];
    expect(dashboardSpendAfterSync(stripeAdapter, result.metrics, now)).toEqual({ provider: once, totals: once });
  });

  it("keeps currencies separate: one metric per currency, key suffix matching the currency", async () => {
    const { fetch } = fakeFetch(syncRoutes);
    const { ctx } = context(fetch);

    const { metrics } = await stripeAdapter.sync({ credential: credential(), externalAccountId: accountId }, ctx);

    for (const metric of metrics) {
      expect(metric.metricKey.endsWith(`.${"currency" in metric ? metric.currency.toLowerCase() : "?"}`)).toBe(true);
    }
    expect(new Set(metrics.map((metric) => metric.metricKey)).size).toBe(metrics.length);
    expect(metrics.filter((metric) => "currency" in metric && metric.currency === "JPY")).toHaveLength(4);
  });

  it("sums integer minor amounts exactly with no rounding, including zero-decimal JPY", async () => {
    const big = Number.MAX_SAFE_INTEGER - 1;
    const { fetch } = fakeFetch({
      "/v1/balance_transactions": ok({
        object: "list",
        has_more: false,
        data: [
          { id: "txn_a", amount: big - 1, created: nowSeconds - 60, currency: "jpy", fee_details: [], type: "charge" },
          { id: "txn_b", amount: 1, created: nowSeconds - 120, currency: "jpy", fee_details: [], type: "charge" },
        ],
      }),
      "/v1/events": emptyList,
    });
    const { ctx } = context(fetch);

    const { metrics } = await stripeAdapter.sync({ credential: credential(), externalAccountId: accountId }, ctx);

    expect(amounts(metrics)["stripe.revenue.month.jpy"]).toBe(big);
    expect(amounts(metrics)["stripe.fees.month.jpy"]).toBe(0);
  });

  it("emits no customer names, emails, addresses, phone numbers, card details, or free text (privacy)", async () => {
    const { fetch } = fakeFetch(syncRoutes);
    const { ctx } = context(fetch);

    const result = await stripeAdapter.sync({ credential: credential(), externalAccountId: accountId }, ctx);
    const emitted = JSON.stringify([result.metrics, result.events]);

    for (const personal of [
      "jane.doe@example.com",
      "Jane Doe",
      "1 Main Street",
      "Springfield",
      "+15555550123",
      "4242",
      "visa",
      "VIP",
      "was declined",
      "cus_fixture",
    ]) {
      expect(emitted).not.toContain(personal);
    }
    for (const field of ["email", "name", "phone", "address", "billing_details", "payment_method_details", "metadata", "description"]) {
      expect(emitted).not.toContain(`"${field}"`);
    }
  });

  it("produces identical metric keys and event dedupe keys across two syncs with overlap, using the cursor", async () => {
    const { fetch, calls } = fakeFetch(syncRoutes);
    const { ctx } = context(fetch);

    const first = await stripeAdapter.sync({ credential: credential(), externalAccountId: accountId }, ctx);
    const second = await stripeAdapter.sync(
      { credential: credential(), externalAccountId: accountId, ...(first.cursor === undefined ? {} : { cursor: first.cursor }) },
      ctx,
    );

    expect(second.metrics.map((metric) => metric.metricKey)).toEqual(first.metrics.map((metric) => metric.metricKey));
    expect(second.events.map((event) => event.dedupeKey)).toEqual(first.events.map((event) => event.dedupeKey));
    expect(second.cursor).toBe(first.cursor);
    const eventCalls = calls.filter((call) => call.url.pathname === "/v1/events");
    expect(eventCalls[1]?.url.searchParams.get("created[gte]")).toBe("1794308400");
  });

  it("clamps a cursor older than the 30 day event retention and logs the gap", async () => {
    const { fetch, calls } = fakeFetch({ "/v1/balance_transactions": emptyList, "/v1/events": emptyList });
    const { ctx, logger } = context(fetch);

    await stripeAdapter.sync({ credential: credential(), externalAccountId: accountId, cursor: "1000" }, ctx);

    const eventsCall = calls.find((call) => call.url.pathname === "/v1/events");
    expect(eventsCall?.url.searchParams.get("created[gte]")).toBe(String(retentionStartSeconds));
    expect(logger.warn).toHaveBeenCalledWith("stripe.events.gap", expect.any(Object));
  });

  it("returns no metrics and no events for empty lists, with the cursor at the retention start", async () => {
    const { fetch } = fakeFetch({ "/v1/balance_transactions": emptyList, "/v1/events": emptyList });
    const { ctx } = context(fetch);

    const result = await stripeAdapter.sync({ credential: credential(), externalAccountId: accountId }, ctx);

    expect(result).toEqual({ metrics: [], events: [], cursor: String(retentionStartSeconds) });
  });

  it("stops at the pagination cap of 10 pages and reports no partial money totals", async () => {
    let counter = 0;
    const page: Route = (url) => {
      counter += 1;
      const isEvents = url.pathname === "/v1/events";
      const item = isEvents
        ? { id: `evt_page_${counter}`, type: "customer.created", created: nowSeconds - counter, data: { object: { id: `cus_${counter}` } } }
        : { id: `txn_page_${counter}`, amount: 100, created: nowSeconds - counter, currency: "usd", fee_details: [], type: "charge" };
      return Response.json({ object: "list", data: [item], has_more: true });
    };
    const { fetch, calls } = fakeFetch({ "/v1/balance_transactions": page, "/v1/events": page });
    const { ctx, logger } = context(fetch);

    const result = await stripeAdapter.sync({ credential: credential(), externalAccountId: accountId }, ctx);

    const balanceCalls = calls.filter((call) => call.url.pathname === "/v1/balance_transactions");
    const eventCalls = calls.filter((call) => call.url.pathname === "/v1/events");
    expect(balanceCalls).toHaveLength(10);
    expect(eventCalls).toHaveLength(10);
    expect(balanceCalls[0]?.url.searchParams.has("starting_after")).toBe(false);
    expect(balanceCalls[1]?.url.searchParams.get("starting_after")).toMatch(/^txn_page_/);
    expect(result.metrics).toEqual([]);
    expect(result.events).toHaveLength(10);
    expect(logger.warn).toHaveBeenCalledWith("stripe.balance_transactions.truncated", expect.any(Object));
    expect(logger.warn).toHaveBeenCalledWith("stripe.events.truncated", expect.any(Object));
  });

  it("throws auth revoked on 401", async () => {
    const unauthorized: Route = () => Response.json({ error: { type: "invalid_request_error" } }, { status: 401 });
    const { fetch } = fakeFetch({ "/v1/balance_transactions": unauthorized, "/v1/events": unauthorized });
    const { ctx } = context(fetch);

    await expect(
      stripeAdapter.sync({ credential: credential(), externalAccountId: accountId }, ctx),
    ).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws rate limited with the Retry-After delay on 429", async () => {
    const limited: Route = () =>
      Response.json({}, { status: 429, headers: { "Retry-After": "30", "Stripe-Rate-Limited-Reason": "global-rate" } });
    const { fetch } = fakeFetch({ "/v1/balance_transactions": limited, "/v1/events": limited });
    const { ctx } = context(fetch);

    const error = await stripeAdapter
      .sync({ credential: credential(), externalAccountId: accountId }, ctx)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ retryAfterMs: 30_000 });
  });

  it("returns events and a partial error naming balance_read when balance transactions are refused (403)", async () => {
    const { fetch } = fakeFetch({
      "/v1/balance_transactions": () => Response.json({}, { status: 403 }),
      "/v1/events": ok(eventsFixture),
    });
    const { ctx } = context(fetch);

    const result = await stripeAdapter.sync({ credential: credential(), externalAccountId: accountId }, ctx);

    expect(result.metrics).toEqual([]);
    expect(result.events).toHaveLength(6);
    expect(result.partialErrors).toHaveLength(1);
    expect(result.partialErrors?.[0]).toBeInstanceOf(PermissionMissingError);
    expect(result.partialErrors?.[0]?.missingScopes).toEqual(["balance_read"]);
  });

  it("keeps the previous cursor when events are refused (403)", async () => {
    const { fetch } = fakeFetch({
      "/v1/balance_transactions": emptyList,
      "/v1/events": () => Response.json({}, { status: 403 }),
    });
    const { ctx } = context(fetch);

    const result = await stripeAdapter.sync(
      { credential: credential(), externalAccountId: accountId, cursor: "1794300000" },
      ctx,
    );

    expect(result.cursor).toBe("1794300000");
    expect(result.partialErrors?.[0]?.missingScopes).toEqual(["event_read"]);
  });

  it.each([
    {
      name: "balance transaction amount as a string",
      routes: {
        "/v1/balance_transactions": ok({
          has_more: false,
          data: [{ id: "txn_x", amount: "2000", created: nowSeconds, currency: "usd", fee_details: [], type: "charge" }],
        }),
        "/v1/events": emptyList,
      },
    },
    {
      name: "subscription event object without status",
      routes: {
        "/v1/balance_transactions": emptyList,
        "/v1/events": ok({
          has_more: false,
          data: [{ id: "evt_x", type: "customer.subscription.created", created: nowSeconds, data: { object: { id: "sub_x" } } }],
        }),
      },
    },
    {
      name: "charge currency that is not a three-letter code",
      routes: {
        "/v1/balance_transactions": emptyList,
        "/v1/events": ok({
          has_more: false,
          data: [
            { id: "evt_x", type: "charge.succeeded", created: nowSeconds, data: { object: { id: "ch_x", amount: 100, currency: "dollars" } } },
          ],
        }),
      },
    },
  ])("throws invalid_response on a schema mismatch: $name", async ({ routes }) => {
    const { fetch } = fakeFetch(routes);
    const { ctx } = context(fetch);

    await expect(
      stripeAdapter.sync({ credential: credential(), externalAccountId: accountId }, ctx),
    ).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe("stripe payment events on the timeline (#261)", () => {
  const charge = (type: string, object: Record<string, unknown>) =>
    toActivityEvent({ id: "evt_x", type, created: nowSeconds, data: { object: { id: "ch_x", ...object } } }, accountId);

  it.each([
    { name: "a two-decimal currency", object: { amount: 4900, currency: "usd" }, title: "Payment succeeded: $49.00" },
    { name: "a zero-decimal currency (JPY)", object: { amount: 1900, currency: "jpy" }, title: "Payment succeeded: ¥1,900" },
    { name: "a three-decimal currency (KWD)", object: { amount: 1500, currency: "kwd" }, title: "Payment succeeded: KWD\u00a01.500" },
    { name: "a zero amount", object: { amount: 0, currency: "eur" }, title: "Payment succeeded: €0.00" },
    { name: "a missing amount", object: { currency: "usd" }, title: "Payment succeeded" },
    { name: "a missing currency", object: { amount: 4900 }, title: "Payment succeeded" },
  ])("titles a payment with $name", ({ object, title }) => {
    expect(charge("charge.succeeded", object)?.title).toBe(title);
  });

  it("keeps each payment in its own currency, never summed", () => {
    const titles = [
      charge("charge.succeeded", { amount: 4900, currency: "usd" }),
      charge("charge.succeeded", { amount: 1900, currency: "eur" }),
    ].map((event) => event?.title);
    expect(titles).toEqual(["Payment succeeded: $49.00", "Payment succeeded: €19.00"]);
  });

  it.each([
    { name: "a known code", code: "insufficient_funds", body: "The customer's account did not have enough funds." },
    {
      name: "an unknown code",
      code: "some_future_code",
      body: "Stripe gave a reason StackDash does not recognize. Open the payment in your Stripe Dashboard to see it.",
    },
    {
      name: "a code named like an Object.prototype member",
      code: "constructor",
      body: "Stripe gave a reason StackDash does not recognize. Open the payment in your Stripe Dashboard to see it.",
    },
    {
      name: "free text where the code belongs",
      code: "Card of Jane Doe was declined",
      body: "Stripe gave a reason StackDash does not recognize. Open the payment in your Stripe Dashboard to see it.",
    },
  ])("explains a failed payment with $name in a plain sentence, never the code", ({ code, body }) => {
    const event = charge("charge.failed", { amount: 1500, currency: "gbp", failure_code: code });
    expect(event).toMatchObject({ title: "Payment failed: £15.00", severity: "warning", body });
    expect(event?.body).not.toContain(code);
  });

  it("adds no body to a failed payment Stripe gave no code for", () => {
    expect(charge("charge.failed", { amount: 1500, currency: "usd", failure_code: null })?.body).toBeUndefined();
  });

  it.each([
    {
      name: "a full refund",
      object: { amount: 4900, amount_refunded: 4900, currency: "eur", refunded: true },
      title: "Payment refunded: €49.00",
    },
    { name: "a full refund without amount_refunded", object: { amount: 4900, currency: "eur", refunded: true }, title: "Payment refunded: €49.00" },
    {
      name: "a partial refund",
      object: { amount: 4900, amount_refunded: 900, currency: "usd", refunded: false },
      title: "Payment partially refunded: $9.00 of $49.00 so far",
    },
    {
      name: "a partial refund in a zero-decimal currency",
      object: { amount: 5000, amount_refunded: 1200, currency: "jpy", refunded: false },
      title: "Payment partially refunded: ¥1,200 of ¥5,000 so far",
    },
    {
      name: "a partial refund without amount_refunded, never the charge amount as the refund",
      object: { amount: 4900, currency: "usd", refunded: false },
      title: "Payment partially refunded",
    },
    {
      name: "a partial refund without the charge amount",
      object: { amount_refunded: 900, currency: "usd", refunded: false },
      title: "Payment partially refunded: $9.00",
    },
  ])("titles $name", ({ object, title }) => {
    expect(charge("charge.refunded", object)?.title).toBe(title);
  });
});

describe("stripeAdapter declarations", () => {
  it("polls hourly and declares the six timeline event types", () => {
    expect(stripeAdapter.pollIntervalSeconds).toBe(3600);
    expect(stripeAdapter.eventTypes.map((eventType) => eventType.id)).toEqual([
      "stripe.charge.succeeded",
      "stripe.charge.failed",
      "stripe.charge.refunded",
      "stripe.customer.created",
      "stripe.customer.subscription.created",
      "stripe.customer.subscription.deleted",
    ]);
  });
});

describe("stripeAdapter webhooks (#423, #481)", () => {
  // Made up, and built from parts so CI's secret scan (gitleaks) does not read it as a credential.
  const WEBHOOK_SECRET = ["whsec", "fixture", "endpoint"].join("_");
  const CHARGE_BODY = JSON.stringify(webhookChargeSucceededFixture);

  function descriptor(): WebhookDescriptor {
    const { webhooks } = stripeAdapter;
    if (webhooks === undefined) throw new Error("the Stripe adapter declares no webhook");
    return webhooks;
  }

  function request(rawBody: string, signature: string | null): WebhookRequest {
    const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
    if (signature !== null) headers.set(STRIPE_SIGNATURE_HEADER, signature);
    return { headers, rawBody: new TextEncoder().encode(rawBody) };
  }

  // A delivery as Stripe sends it: signed now with the endpoint's secret.
  function delivery(rawBody: string, timestampSeconds = nowSeconds): WebhookRequest {
    return request(rawBody, signStripeWebhook({ secret: WEBHOOK_SECRET, rawBody, timestampSeconds }));
  }

  function verify(webhookRequest: WebhookRequest) {
    return descriptor().verify(webhookRequest, new Secret(WEBHOOK_SECRET), now);
  }

  function parsed(rawBody: string) {
    const webhookRequest = delivery(rawBody);
    expect(verify(webhookRequest).ok).toBe(true);
    return descriptor().parse(webhookRequest, context(fakeFetch({}).fetch).ctx);
  }

  // The `v1` value of a signed header, to rebuild the header in other shapes.
  function v1(rawBody: string, timestampSeconds = nowSeconds, secret = WEBHOOK_SECRET): string {
    const value = signStripeWebhook({ secret, rawBody, timestampSeconds }).split(",v1=")[1];
    if (value === undefined) throw new Error("signStripeWebhook returned no v1 entry");
    return value;
  }

  it("declares an app-level endpoint with a live and a test mode secret, the polled events, and both uninstall events", () => {
    expect(checkAdapterDeclaration(stripeAdapter)).toEqual([]);
    expect(descriptor().registration).toEqual({ kind: "app", secretEnv: "STRIPE_WEBHOOK_SECRET", testModeSecretEnv: "STRIPE_WEBHOOK_TEST_SECRET" });
    expect(descriptor().subscriptions).toEqual([
      "charge.succeeded",
      "charge.failed",
      "charge.refunded",
      "customer.created",
      "customer.subscription.created",
      "customer.subscription.deleted",
      "apps.install.deleted",
      "account.application.deauthorized",
    ]);
  });

  it("verifies a signed delivery with the event id as delivery id, and maps it to the event polling stores", async () => {
    const webhookRequest = delivery(CHARGE_BODY);
    expect(verify(webhookRequest)).toEqual({ ok: true, deliveryId: "evt_fixture_charge_succeeded" });
    const outcome = descriptor().parse(webhookRequest, context(fakeFetch({}).fetch).ctx);
    expect(checkWebhookOutcome(stripeAdapter, outcome)).toEqual([]);

    // The same Stripe event read by polling: one dedupe key, so the timeline stores it once.
    const { ctx } = context(fakeFetch(syncRoutes).fetch);
    const result = await stripeAdapter.sync({ credential: credential(), externalAccountId: accountId }, ctx);
    const polled = result.events.find((event) => event.dedupeKey === "evt_fixture_charge_succeeded");
    expect(polled).toBeDefined();
    expect(outcome).toEqual({ kind: "events", externalAccountId: accountId, mode: "live", events: [polled] });
  });

  it("names test mode on a test mode event, with the same event polling with the test key stores (#481)", () => {
    const outcome = parsed(JSON.stringify({ ...webhookChargeSucceededFixture, livemode: false }));
    expect(outcome).toMatchObject({ kind: "events", externalAccountId: accountId, mode: "test", events: [{ dedupeKey: "evt_fixture_charge_succeeded" }] });
    expect(checkWebhookOutcome(stripeAdapter, outcome)).toEqual([]);
  });

  it("keeps no personal data from the delivered object (privacy)", () => {
    const emitted = JSON.stringify(parsed(CHARGE_BODY));
    for (const personal of ["jane.doe@example.com", "Jane Doe", "1 Main Street", "Springfield", "+15555550123", "4242", "visa", "VIP"]) {
      expect(emitted).not.toContain(personal);
    }
    for (const field of ["email", "name", "phone", "address", "billing_details", "payment_method_details", "metadata", "description"]) {
      expect(emitted).not.toContain(`"${field}"`);
    }
  });

  it.each([
    ["apps.install.deleted", webhookInstallDeletedFixture],
    ["account.application.deauthorized", webhookApplicationDeauthorizedFixture],
    // The name Stripe uses on endpoints pinned to an API version before 2026-09-30.
    ["app.install.deleted (older API versions)", { ...webhookInstallDeletedFixture, type: "app.install.deleted" }],
  ])("reports %s as an uninstall of the account, at the event's time, in live mode", (_case, fixture) => {
    const outcome = parsed(JSON.stringify(fixture));
    expect(outcome).toEqual({ kind: "uninstalled", externalAccountId: accountId, mode: "live", occurredAt: new Date(1794308400 * 1000) });
    expect(checkWebhookOutcome(stripeAdapter, outcome)).toEqual([]);
  });

  it.each([
    ["apps.install.deleted", webhookInstallDeletedFixture],
    ["account.application.deauthorized", webhookApplicationDeauthorizedFixture],
  ])("reports a test mode %s as an uninstall in test mode, so it never revokes a live connection (#481)", (_case, fixture) => {
    const outcome = parsed(JSON.stringify({ ...fixture, livemode: false }));
    expect(outcome).toEqual({ kind: "uninstalled", externalAccountId: accountId, mode: "test", occurredAt: new Date(1794308400 * 1000) });
    expect(checkWebhookOutcome(stripeAdapter, outcome)).toEqual([]);
  });

  it("accepts any of several v1 signatures, as while a secret is rolled, and ignores v0", () => {
    const other = v1(CHARGE_BODY, nowSeconds, "whsec_fixture_previous");
    const header = `t=${nowSeconds},v1=${other},v1=${v1(CHARGE_BODY)},v0=${other}`;
    expect(verify(request(CHARGE_BODY, header))).toEqual({ ok: true, deliveryId: "evt_fixture_charge_succeeded" });
  });

  it("accepts a timestamp exactly at the tolerance, either side (boundary)", () => {
    expect(verify(delivery(CHARGE_BODY, nowSeconds - STRIPE_WEBHOOK_TOLERANCE_SECONDS)).ok).toBe(true);
    expect(verify(delivery(CHARGE_BODY, nowSeconds + STRIPE_WEBHOOK_TOLERANCE_SECONDS)).ok).toBe(true);
  });

  const signedNow = () => v1(CHARGE_BODY);
  it.each<[string, () => string | null, string]>([
    ["no Stripe-Signature header", () => null, "missing_signature"],
    ["an empty header", () => " ", "missing_signature"],
    ["no v1 entry", () => `t=${nowSeconds}`, "missing_signature"],
    // A downgrade: only the scheme Stripe says to ignore, carrying a valid MAC.
    ["only a v0 entry", () => `t=${nowSeconds},v0=${signedNow()}`, "missing_signature"],
    ["no timestamp", () => `v1=${signedNow()}`, "malformed"],
    ["a timestamp that is not a number", () => `t=soon,v1=${signedNow()}`, "malformed"],
    ["two timestamps", () => `t=${nowSeconds},t=${nowSeconds},v1=${signedNow()}`, "malformed"],
    ["a signature made with another secret", () => `t=${nowSeconds},v1=${v1(CHARGE_BODY, nowSeconds, "whsec_fixture_other")}`, "bad_signature"],
    ["a tampered body", () => `t=${nowSeconds},v1=${v1(CHARGE_BODY.replace("acct_fixture123", "acct_fixture999"))}`, "bad_signature"],
    // A captured signature under a fresh timestamp: the timestamp is signed.
    ["a signature replayed under a new timestamp", () => `t=${nowSeconds},v1=${v1(CHARGE_BODY, nowSeconds - 3600)}`, "bad_signature"],
    ["a timestamp one second past the tolerance", () => `t=${nowSeconds - 301},v1=${v1(CHARGE_BODY, nowSeconds - 301)}`, "stale"],
    ["a timestamp one second past the tolerance in the future", () => `t=${nowSeconds + 301},v1=${v1(CHARGE_BODY, nowSeconds + 301)}`, "stale"],
  ])("rejects a delivery with %s (boundary)", (_case, header, reason) => {
    expect(verify(request(CHARGE_BODY, header()))).toEqual({ ok: false, reason });
  });

  it.each([
    ["a body that is not JSON", "type=charge.succeeded"],
    ["an event without an id", JSON.stringify({ ...webhookChargeSucceededFixture, id: undefined })],
    ["an event id longer than a delivery id may be", JSON.stringify({ ...webhookChargeSucceededFixture, id: `evt_${"a".repeat(200)}` })],
  ])("rejects a correctly signed delivery with %s as malformed (boundary)", (_case, body) => {
    expect(verify(delivery(body))).toEqual({ ok: false, reason: "malformed" });
  });

  it.each([
    ["an event on the app owner's own account (no account)", { ...webhookChargeSucceededFixture, account: undefined }],
    ["an event type the timeline does not show", { ...webhookChargeSucceededFixture, type: "payout.paid" }],
    ["an event with no livemode", { ...webhookChargeSucceededFixture, livemode: undefined }],
  ])("ignores %s (boundary)", (_case, fixture) => {
    expect(parsed(JSON.stringify(fixture))).toMatchObject({ kind: "ignored" });
  });

  it("acknowledges and drops an object the allowlist rejects, logging the event type only", () => {
    const body = JSON.stringify({
      ...webhookChargeSucceededFixture,
      data: { object: { ...webhookChargeSucceededFixture.data.object, amount: -1 } },
    });
    const webhookRequest = delivery(body);
    const { ctx, logger } = context(fakeFetch({}).fetch);
    expect(descriptor().parse(webhookRequest, ctx)).toMatchObject({ kind: "ignored" });
    expect(logger.warn).toHaveBeenCalledWith("stripe.webhook.object_rejected", { eventType: "charge.succeeded" });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("Jane Doe");
  });
});

describe("stripeAdapter.modeOf (#481)", () => {
  it.each([
    { name: "a live mode grant", metadata: { stripeUserId: accountId, livemode: "true" }, mode: "live" },
    { name: "a test mode grant", metadata: { stripeUserId: accountId, livemode: "false" }, mode: "test" },
    { name: "a grant without livemode (boundary: missing)", metadata: { stripeUserId: accountId }, mode: null },
    { name: "a livemode that is not a boolean (boundary: drifted)", metadata: { stripeUserId: accountId, livemode: "TRUE" }, mode: null },
  ])("reads $name as $mode", ({ metadata, mode }) => {
    expect(stripeAdapter.modeOf?.(credential(true, metadata))).toBe(mode);
  });
});
