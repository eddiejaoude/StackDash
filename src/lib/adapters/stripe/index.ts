import type { z } from "zod";
import {
  AdapterError,
  AuthRevokedError,
  InvalidResponseError,
  PermissionMissingError,
  fetchJson,
} from "@/lib/adapters/errors";
import type { ActivityEvent, EventSeverity, EventType } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import {
  Secret,
  type AdapterContext,
  type ExternalAccount,
  type OAuthClient,
  type OAuthContext,
  type OAuthCredential,
  type Permission,
  type ProviderAdapter,
  type SyncInput,
  type SyncResult,
} from "@/lib/adapters/types";
import { PROVIDER_NAMES } from "@/lib/providers";
import {
  BalanceTransactionSchema,
  ChargeObjectSchema,
  CustomerObjectSchema,
  EventSchema,
  SubscriptionObjectSchema,
  TokenResponseSchema,
  stripeListSchema,
  type BalanceTransaction,
  type StripeEvent,
  type StripeList,
  type TokenResponse,
} from "./schemas";

/**
 * Stripe adapter (adapter pattern over the Stripe REST API). Facts, endpoints, and privacy rules
 * come from docs/providers/stripe.md; "Unverified #n" refers to that page's Unverified list.
 */

const AUTHORIZE_URL = "https://marketplace.stripe.com/oauth/v2/authorize";
const TOKEN_URL = "https://api.stripe.com/v1/oauth/token";
const API_BASE = "https://api.stripe.com/v1";
const BALANCE_TRANSACTIONS_URL = `${API_BASE}/balance_transactions`;
const EVENTS_URL = `${API_BASE}/events`;
// Pinned API version. Event payloads keep the version they were created with, hence allowlist schemas.
const STRIPE_VERSION = "2026-10-28.endive";

// The token response has no `expires_in`; Stripe documents a 1 hour access token lifetime.
const ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
// The grant's `scope` value. Installing the app grants every permission in the manifest at once.
const GRANT_SCOPE = "stripe_apps";
const TEST_SECRET_KEY = "testSecretKey";

const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
// `GET /v1/events` only goes back 30 days.
const EVENTS_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const permissions: readonly Permission[] = [
  {
    scope: "event_read",
    access: "read",
    description: "Read payment, customer, subscription, and refund events to show them on your DevMacro timeline",
  },
  { scope: "charge_read", access: "read", description: "Read payment and refund amounts to show revenue" },
  {
    scope: "customer_read",
    access: "read",
    description: "Count new customers. DevMacro does not store customer names or emails",
  },
  { scope: "subscription_read", access: "read", description: "Count new and canceled subscriptions" },
  { scope: "invoice_read", access: "read", description: "Read paid invoice amounts to show revenue" },
  { scope: "balance_read", access: "read", description: "Read your balance and Stripe fees" },
  { scope: "payout_read", access: "read", description: "Read payout amounts and dates" },
];

const requestedScopes = permissions.map((permission) => permission.scope);

// Payment events use `charge.*` (covered by `charge_read`) instead of `payment_intent.*`, which
// may need `payment_intent_read` (Unverified #1).
// Exported, like `moneyMetrics` and `toActivityEvent` below, for the local simulator (#131).
export const timelineEvents = [
  {
    stripeType: "charge.succeeded",
    label: "Payment succeeded",
    description: "A payment on your Stripe account succeeded.",
  },
  { stripeType: "charge.failed", label: "Payment failed", description: "A payment on your Stripe account failed." },
  {
    stripeType: "charge.refunded",
    label: "Payment refunded",
    description: "A payment on your Stripe account was refunded in full or in part.",
  },
  { stripeType: "customer.created", label: "New customer", description: "A customer was added to your Stripe account." },
  {
    stripeType: "customer.subscription.created",
    label: "Subscription created",
    description: "A subscription was created on your Stripe account.",
  },
  {
    stripeType: "customer.subscription.deleted",
    label: "Subscription ended",
    description: "A subscription on your Stripe account ended.",
  },
] as const;

const eventTypes: readonly EventType[] = timelineEvents.map((event) => ({
  id: `stripe.${event.stripeType}`,
  label: event.label,
  description: event.description,
  shownByDefault: true,
}));

// "Stripe fees" per docs/providers/stripe.md (Fees). `application_fee` goes to a Connect platform, not Stripe.
// Whether these cover every processing fee is Unverified #11.
const FEE_DETAIL_TYPES: Readonly<Record<string, true>> = {
  stripe_fee: true,
  payment_method_passthrough_fee: true,
  tax: true,
};
// Fees billed as their own balance transactions, with a negative `amount`.
const FEE_TRANSACTION_TYPES: Readonly<Record<string, true>> = { stripe_fee: true, stripe_fx_fee: true, tax_fee: true };
// Gross payments and refunds (negative `amount`), so revenue is net of refunds.
const REVENUE_TRANSACTION_TYPES: Readonly<Record<string, true>> = {
  charge: true,
  payment: true,
  refund: true,
  payment_refund: true,
};

type ConnectedAccount = { stripeUserId: string; livemode: boolean };

/** The account and environment recorded at exchange time. Without them the credential is unusable. */
function connectedAccount(credential: OAuthCredential): ConnectedAccount {
  const stripeUserId = credential.metadata?.stripeUserId;
  const livemode = credential.metadata?.livemode;
  if (stripeUserId === undefined || (livemode !== "true" && livemode !== "false")) {
    throw new AuthRevokedError("Stripe credential is missing its account id or mode; reconnect Stripe");
  }
  return { stripeUserId, livemode: livemode === "true" };
}

/**
 * The exchange and refreshes use the app owner's secret key for the install's environment.
 * Test mode installs fall back to the main key so a development setup can put a test key there.
 */
function secretKeyFor(livemode: boolean, client: OAuthClient): Secret {
  if (livemode) return client.clientSecret;
  return client.extra[TEST_SECRET_KEY] ?? client.clientSecret;
}

function requestToken(ctx: AdapterContext, secretKey: Secret, body: URLSearchParams): Promise<TokenResponse> {
  return fetchJson(
    ctx,
    TOKEN_URL,
    {
      method: "POST",
      headers: {
        // Basic auth: secret key as username, empty password. `client_id` is not sent.
        Authorization: `Basic ${btoa(`${secretKey.reveal()}:`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    },
    TokenResponseSchema,
  );
}

function credentialFromToken(token: TokenResponse, issuedAt: Date): OAuthCredential {
  return {
    accessToken: new Secret(token.access_token),
    refreshToken: new Secret(token.refresh_token),
    expiresAt: new Date(issuedAt.getTime() + ACCESS_TOKEN_LIFETIME_MS),
    scopes: token.scope.split(" ").filter((scope) => scope.length > 0),
    tokenType: token.token_type,
    metadata: { stripeUserId: token.stripe_user_id, livemode: String(token.livemode) },
  };
}

/**
 * True when the token endpoint refused the key or code (any 4xx except a rate limit), the case
 * where a code from a test mode link meets the live key. The exact error is Unverified #5.
 */
function isTokenRejection(error: unknown): boolean {
  if (!(error instanceof AdapterError)) return false;
  if (error.code === "auth_revoked" || error.code === "permission_missing") return true;
  return error.code === "invalid_response" && error.status !== undefined && error.status >= 400 && error.status < 500;
}

async function stripeGet<T>(
  ctx: AdapterContext,
  credential: OAuthCredential,
  url: string,
  params: URLSearchParams,
  schema: z.ZodType<T>,
  permission: string,
): Promise<T> {
  const target = new URL(url);
  target.search = params.toString();
  try {
    return await fetchJson(
      ctx,
      target,
      {
        method: "GET",
        // The token is scoped to the installing account, so no `Stripe-Account` header.
        headers: { Authorization: `Bearer ${credential.accessToken.reveal()}`, "Stripe-Version": STRIPE_VERSION },
      },
      schema,
    );
  } catch (error) {
    if (error instanceof PermissionMissingError && error.missingScopes.length === 0) {
      throw new PermissionMissingError(`Stripe refused ${url}; the app needs ${permission}`, [permission], {
        cause: error,
        status: 403,
        endpoint: url,
      });
    }
    throw error;
  }
}

type Paged<T> = { items: T[]; truncated: boolean };

/** Cursor pagination, newest first, capped at MAX_PAGES. */
async function listPages<T extends { id: string }>(
  ctx: AdapterContext,
  credential: OAuthCredential,
  url: string,
  baseParams: URLSearchParams,
  schema: z.ZodType<StripeList<T>>,
  permission: string,
): Promise<Paged<T>> {
  const items: T[] = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams(baseParams);
    params.set("limit", String(PAGE_LIMIT));
    if (startingAfter !== undefined) params.set("starting_after", startingAfter);
    const list = await stripeGet(ctx, credential, url, params, schema, permission);
    items.push(...list.data);
    const last = list.data.at(-1);
    if (!list.has_more || last === undefined) return { items, truncated: false };
    startingAfter = last.id;
  }
  return { items, truncated: true };
}

type MetricWindow = { key: "month" | "last_30_days"; label: string; start: Date; end: Date };

function metricWindows(now: Date): MetricWindow[] {
  const windows: MetricWindow[] = [];
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  // At the first instant of a month the period would be empty, which a timeframe cannot be.
  if (monthStart.getTime() < now.getTime()) {
    windows.push({ key: "month", label: "this month", start: monthStart, end: now });
  }
  windows.push({ key: "last_30_days", label: "last 30 days", start: new Date(now.getTime() - 30 * DAY_MS), end: now });
  return windows;
}

type Totals = { feesMinor: bigint; revenueMinor: bigint };

function addTo(totals: Map<string, Totals>, currency: string, field: keyof Totals, amountMinor: bigint): void {
  const current = totals.get(currency) ?? { feesMinor: 0n, revenueMinor: 0n };
  current[field] += amountMinor;
  totals.set(currency, current);
}

/**
 * Per currency, never across currencies. Stripe amounts are already integers in the smallest
 * currency unit, so they are summed exactly as bigints and nothing is rounded.
 */
function totalsByCurrency(transactions: readonly BalanceTransaction[], window: MetricWindow): Map<string, Totals> {
  const totals = new Map<string, Totals>();
  const startMs = window.start.getTime();
  const endMs = window.end.getTime();
  for (const transaction of transactions) {
    const createdMs = transaction.created * 1000;
    if (createdMs < startMs || createdMs > endMs) continue;
    for (const detail of transaction.fee_details) {
      if (FEE_DETAIL_TYPES[detail.type] === true) {
        addTo(totals, detail.currency, "feesMinor", BigInt(detail.amount));
      }
    }
    if (FEE_TRANSACTION_TYPES[transaction.type] === true) {
      addTo(totals, transaction.currency, "feesMinor", -BigInt(transaction.amount));
    }
    if (REVENUE_TRANSACTION_TYPES[transaction.type] === true) {
      addTo(totals, transaction.currency, "revenueMinor", BigInt(transaction.amount));
    }
  }
  return totals;
}

function toSafeMinor(amountMinor: bigint): number {
  if (amountMinor > BigInt(Number.MAX_SAFE_INTEGER) || amountMinor < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new InvalidResponseError("Stripe amounts add up to more than can be stored", {
      endpoint: BALANCE_TRANSACTIONS_URL,
    });
  }
  return Number(amountMinor);
}

export function moneyMetrics(
  transactions: readonly BalanceTransaction[],
  now: Date,
  externalAccountId: string,
  ctx: AdapterContext,
): AdapterMetric[] {
  const windows = metricWindows(now);
  const perWindow = windows.map((window) => ({ window, totals: totalsByCurrency(transactions, window) }));
  // A currency active in either window gets both windows, zero where nothing happened.
  const currencies = [...new Set(perWindow.flatMap(({ totals }) => [...totals.keys()]))].sort();
  const provenance = { source: "provider_api", endpoint: BALANCE_TRANSACTIONS_URL } as const;
  const metrics: AdapterMetric[] = [];

  for (const { window, totals } of perWindow) {
    const timeframe = { type: "period", start: window.start, end: window.end } as const;
    for (const currency of currencies) {
      const { feesMinor, revenueMinor } = totals.get(currency) ?? { feesMinor: 0n, revenueMinor: 0n };
      const suffix = `${window.key}.${currency.toLowerCase()}`;
      // Fee credits are netted into the total; a net credit cannot be shown as spend.
      if (feesMinor >= 0n) {
        metrics.push({
          kind: "verified_spend",
          metricKey: `stripe.fees.${suffix}`,
          label: `Stripe fees, ${window.label} (${currency})`,
          timeframe,
          externalAccountId,
          retrievedAt: now,
          provenance,
          amountMinor: toSafeMinor(feesMinor),
          currency,
        });
      } else {
        ctx.logger.warn("stripe.fees.net_credit", { window: window.key, currency });
      }
      metrics.push({
        kind: "revenue",
        metricKey: `stripe.revenue.${suffix}`,
        label: `Revenue net of refunds, ${window.label} (${currency})`,
        timeframe,
        externalAccountId,
        retrievedAt: now,
        provenance,
        amountMinor: toSafeMinor(revenueMinor),
        currency,
      });
    }
  }
  return metrics;
}

async function syncMoney(
  credential: OAuthCredential,
  externalAccountId: string,
  ctx: AdapterContext,
): Promise<AdapterMetric[]> {
  const now = ctx.now();
  const windowStartMs = Math.min(...metricWindows(now).map((window) => window.start.getTime()));
  // Totals cover whole windows, so every sync reads the window again; no cursor here.
  const params = new URLSearchParams({ "created[gte]": String(Math.floor(windowStartMs / 1000)) });
  const { items, truncated } = await listPages(
    ctx,
    credential,
    BALANCE_TRANSACTIONS_URL,
    params,
    stripeListSchema(BalanceTransactionSchema),
    "balance_read",
  );
  if (truncated) {
    // Partial totals would understate fees and revenue, so none are reported.
    ctx.logger.warn("stripe.balance_transactions.truncated", { maxPages: MAX_PAGES, pageLimit: PAGE_LIMIT });
    return [];
  }
  return moneyMetrics(items, now, externalAccountId, ctx);
}

function parseObject<T>(schema: z.ZodType<T>, value: unknown, eventType: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new InvalidResponseError(`Stripe ${eventType} event has an unexpected object shape`, {
      cause: parsed.error,
      endpoint: EVENTS_URL,
    });
  }
  return parsed.data;
}

const FAILURE_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

type TimelineEntry = { severity: EventSeverity; title: string; body?: string };

function timelineEntry(event: StripeEvent): TimelineEntry | undefined {
  const type = event.type;
  const object = event.data.object;
  switch (type) {
    case "charge.succeeded":
      parseObject(ChargeObjectSchema, object, type);
      return { severity: "success", title: "Payment succeeded" };
    case "charge.failed": {
      const charge = parseObject(ChargeObjectSchema, object, type);
      const code = charge.failure_code;
      // Only Stripe's enum code; anything else could be free text.
      return code !== undefined && code !== null && FAILURE_CODE_PATTERN.test(code)
        ? { severity: "warning", title: "Payment failed", body: `Failure code: ${code}` }
        : { severity: "warning", title: "Payment failed" };
    }
    case "charge.refunded": {
      const charge = parseObject(ChargeObjectSchema, object, type);
      return { severity: "info", title: charge.refunded === false ? "Payment partially refunded" : "Payment refunded" };
    }
    case "customer.created":
      parseObject(CustomerObjectSchema, object, type);
      return { severity: "info", title: "New customer" };
    case "customer.subscription.created":
      parseObject(SubscriptionObjectSchema, object, type);
      return { severity: "success", title: "Subscription created" };
    case "customer.subscription.deleted":
      parseObject(SubscriptionObjectSchema, object, type);
      return { severity: "warning", title: "Subscription ended" };
    default:
      return undefined;
  }
}

export function toActivityEvent(event: StripeEvent, externalAccountId: string): ActivityEvent | undefined {
  const entry = timelineEntry(event);
  if (entry === undefined) return undefined;
  return {
    typeId: `stripe.${event.type}`,
    occurredAt: new Date(event.created * 1000),
    severity: entry.severity,
    title: entry.title,
    ...(entry.body === undefined ? {} : { body: entry.body }),
    externalAccountId,
    // Stripe event ids are stable across polls; the store upserts on them.
    dedupeKey: event.id,
  };
}

/** The cursor is the `created` (Unix seconds) of the newest event seen. */
function parseCursor(cursor: string | undefined, ctx: AdapterContext): number | undefined {
  if (cursor === undefined) return undefined;
  if (/^\d{1,12}$/.test(cursor)) return Number(cursor);
  ctx.logger.warn("stripe.events.cursor_invalid", {});
  return undefined;
}

type EventsSync = { events: ActivityEvent[]; cursor: string };

async function syncEvents(
  credential: OAuthCredential,
  externalAccountId: string,
  cursor: string | undefined,
  ctx: AdapterContext,
): Promise<EventsSync> {
  const nowSeconds = Math.floor(ctx.now().getTime() / 1000);
  const retentionStart = nowSeconds - EVENTS_RETENTION_SECONDS;
  const previous = parseCursor(cursor, ctx);
  if (previous !== undefined && previous < retentionStart) {
    // Events older than 30 days are gone from the API; the timeline has a gap.
    ctx.logger.warn("stripe.events.gap", { cursorSeconds: previous, retentionStartSeconds: retentionStart });
  }
  // `gte` repeats the boundary second; the dedupe key absorbs the overlap.
  const since = Math.max(previous ?? retentionStart, retentionStart);
  const params = new URLSearchParams({ "created[gte]": String(since) });
  for (const event of timelineEvents) params.append("types[]", event.stripeType);

  const { items, truncated } = await listPages(
    ctx,
    credential,
    EVENTS_URL,
    params,
    stripeListSchema(EventSchema),
    "event_read",
  );
  if (truncated) {
    // Newest first, so the oldest events of this window were not read.
    ctx.logger.warn("stripe.events.truncated", { maxPages: MAX_PAGES, pageLimit: PAGE_LIMIT, sinceSeconds: since });
  }

  const events: ActivityEvent[] = [];
  let newest = since;
  for (const item of items) {
    newest = Math.max(newest, item.created);
    const event = toActivityEvent(item, externalAccountId);
    if (event !== undefined) events.push(event);
  }
  return { events, cursor: String(newest) };
}

/** A permission the grant lacks stops one part of the sync, not the whole sync. */
async function settle<T>(
  part: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: PermissionMissingError }> {
  try {
    return { ok: true, value: await part };
  } catch (error) {
    if (error instanceof PermissionMissingError) return { ok: false, error };
    throw error;
  }
}

export const stripeAdapter: ProviderAdapter = {
  id: "stripe",
  displayName: PROVIDER_NAMES.stripe,
  capabilities: {
    oauth: true,
    polling: true,
    webhooks: false,
    usage: false,
    spending: true,
    allowance: false,
    credits: false,
    revenue: true,
    events: true,
  },
  permissions,
  dataCollected: [
    "Stripe fees per currency, this month and last 30 days",
    "Revenue net of refunds per currency, this month and last 30 days",
    "Payment, refund, new customer, and subscription events with Stripe ids and dates",
    "Never customer names, emails, addresses, or card details",
  ],
  eventTypes,
  oauth: {
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    // Permissions are fixed by the app manifest, not sent on the install link.
    scopes: requestedScopes,
    pkce: false,
    clientIdEnv: "STRIPE_APP_CLIENT_ID",
    // Stripe Apps have no client secret; the app owner's live secret key takes that role.
    clientSecretEnv: "STRIPE_APP_SECRET_KEY",
    // Optional: only needed to support installs from the test mode link.
    extraEnv: { [TEST_SECRET_KEY]: "STRIPE_APP_TEST_SECRET_KEY" },
    optionalExtraKeys: [TEST_SECRET_KEY],
  },
  pollIntervalSeconds: 3600,

  buildAuthorizeUrl({ client, state, redirectUri }) {
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    return url;
  },

  async exchangeCode(input, ctx) {
    // Stripe sends only `code` and `state` to the callback; the environment is learned from `livemode`.
    const body = new URLSearchParams({ grant_type: "authorization_code", code: input.code });
    const issuedAt = ctx.now();
    const testKey = ctx.client.extra[TEST_SECRET_KEY];
    let token: TokenResponse;
    try {
      token = await requestToken(ctx, ctx.client.clientSecret, body);
    } catch (error) {
      // The contract does not carry which install link was used, so a code the live key cannot
      // redeem is retried with the test mode key. A failed exchange does not consume the code.
      if (testKey === undefined || !isTokenRejection(error)) throw error;
      ctx.logger.info("stripe.oauth.exchange_with_test_key", {});
      token = await requestToken(ctx, testKey, body);
    }
    return credentialFromToken(token, issuedAt);
  },

  /**
   * Refresh tokens rotate: the old one dies on use. Callers must serialize refreshes per
   * connection (lock, re-read, refresh only if still needed, store all three values in one
   * transaction); a failed store after this returns means the connection needs reconnecting.
   */
  async refreshTokens(credential, ctx) {
    const account = connectedAccount(credential);
    if (credential.refreshToken === undefined) {
      throw new AuthRevokedError("Stripe credential has no refresh token; reconnect Stripe", { endpoint: TOKEN_URL });
    }
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refreshToken.reveal() });
    const issuedAt = ctx.now();
    let token: TokenResponse;
    try {
      token = await requestToken(ctx, secretKeyFor(account.livemode, ctx.client), body);
    } catch (error) {
      // A used, expired, or revoked refresh token is most likely a 400 `invalid_grant` (Unverified #5).
      if (error instanceof InvalidResponseError && error.status === 400) {
        throw new AuthRevokedError("Stripe rejected the refresh token; reconnect Stripe", {
          cause: error,
          status: 400,
          endpoint: TOKEN_URL,
        });
      }
      throw error;
    }
    if (token.stripe_user_id !== account.stripeUserId || token.livemode !== account.livemode) {
      throw new InvalidResponseError("Stripe refreshed a token for a different account or mode", {
        endpoint: TOKEN_URL,
      });
    }
    return credentialFromToken(token, issuedAt);
  },

  // No revoke: Stripe Apps OAuth documents no revocation endpoint (Unverified #8).

  async listAccounts(credential): Promise<ExternalAccount[]> {
    // The grant is for exactly one account, recorded at exchange time; no API call is needed.
    const account = connectedAccount(credential);
    return [
      {
        externalId: account.stripeUserId,
        displayName: account.livemode
          ? `Stripe account ${account.stripeUserId}`
          : `Stripe account ${account.stripeUserId} (test mode)`,
        kind: "account",
      },
    ];
  },

  detectMissingPermissions(grant) {
    if (grant.scopes.includes(GRANT_SCOPE)) return [];
    return requestedScopes.filter((scope) => !grant.scopes.includes(scope));
  },

  async sync(input: SyncInput, ctx: OAuthContext): Promise<SyncResult> {
    const account = connectedAccount(input.credential);
    if (input.externalAccountId !== account.stripeUserId) {
      throw new Error("Stripe sync was asked for an account this credential does not belong to");
    }
    const [money, timeline] = await Promise.all([
      settle(syncMoney(input.credential, input.externalAccountId, ctx)),
      settle(syncEvents(input.credential, input.externalAccountId, input.cursor, ctx)),
    ]);

    const partialErrors: PermissionMissingError[] = [];
    if (!money.ok) partialErrors.push(money.error);
    if (!timeline.ok) partialErrors.push(timeline.error);
    // An unreadable timeline keeps the previous cursor so the next sync resumes from it.
    const cursor = timeline.ok ? timeline.value.cursor : input.cursor;

    return {
      metrics: money.ok ? money.value : [],
      events: timeline.ok ? timeline.value.events : [],
      ...(cursor === undefined ? {} : { cursor }),
      ...(partialErrors.length === 0 ? {} : { partialErrors }),
    };
  },
};
