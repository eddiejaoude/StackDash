import type { z } from "zod";
import type { Achievement } from "@/lib/adapters/achievements";
import {
  AuthRevokedError,
  InvalidResponseError,
  PermissionMissingError,
  fetchJson,
  readOAuthErrorCode,
} from "@/lib/adapters/errors";
import { titleWithAmount, type ActivityEvent, type EventSeverity, type EventType } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import {
  Secret,
  type AdapterContext,
  type ExternalAccount,
  type FetchLike,
  type OAuthContext,
  type OAuthCredential,
  type Permission,
  type ProviderAdapter,
  type SyncInput,
  type SyncResult,
} from "@/lib/adapters/types";
import { addDecimals, InvalidDecimalError, parseDecimal, toMinorUnits, type Decimal } from "@/lib/money";
import { PROVIDER_NAMES } from "@/lib/providers";
import {
  CustomerSchema,
  MetricPeriodSchema,
  MetricsResponseSchema,
  OrderSchema,
  OrganizationSchema,
  RefundSchema,
  RevokeResponseSchema,
  SubscriptionSchema,
  TokenResponseSchema,
  polarListSchema,
  type MetricPeriod,
  type MetricsResponse,
  type Order,
  type PolarList,
  type Refund,
  type Subscription,
  type TokenResponse,
} from "./schemas";

/**
 * Polar adapter (adapter pattern over the Polar REST API, issue #114). Facts, endpoints, and
 * privacy rules come from docs/providers/polar.md; "Unverified #n" refers to that page's
 * Unverified list. Nothing here has been run against a real Polar account yet.
 *
 * OAuth 2.0 authorization code flow with PKCE (S256) as a confidential client. Money, recurring
 * revenue, and counts come from Polar's own analytics (`GET /v1/metrics/`); the timeline polls
 * orders, subscriptions, and refunds, because push events would need `webhooks:write`.
 */

const AUTHORIZE_URL = "https://polar.sh/oauth2/authorize";
const API_BASE = "https://api.polar.sh";
const TOKEN_URL = `${API_BASE}/v1/oauth2/token`;
const REVOKE_URL = `${API_BASE}/v1/oauth2/revoke`;
const ORGANIZATIONS_URL = `${API_BASE}/v1/organizations/`;
const METRICS_URL = `${API_BASE}/v1/metrics/`;
const CUSTOMERS_URL = `${API_BASE}/v1/customers/`;
const ORDERS_URL = `${API_BASE}/v1/orders/`;
const SUBSCRIPTIONS_URL = `${API_BASE}/v1/subscriptions/`;
const REFUNDS_URL = `${API_BASE}/v1/refunds/`;
// RFC 9207: Polar's discovery document sets `authorization_response_iss_parameter_supported`.
const POLAR_ISSUER = "https://api.polar.sh";
// Pinned on every call, the OAuth2 token and revoke requests too (both are in the 2026-10
// OpenAPI document): without the header Polar uses its Current version, which changes every
// quarter. 2026-10 is removed in the first week of April 2027, then every call answers 404: bump
// it first (docs/providers/polar.md, Limitations).
const POLAR_API_VERSION = "2026-10";
// Form encoded OAuth2 requests: token (exchange and refresh) and revoke.
const OAUTH_FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
  "Polar-Version": POLAR_API_VERSION,
};

// Polar's metrics endpoint has no currency field; amounts are cents in Polar's settlement
// currency, USD (Unverified #3).
const METRICS_CURRENCY = "USD";

// The slugs the adapter reads, one `metrics` parameter each: Polar then runs only the queries they
// need instead of every series in its schema (Get metrics reference, 2026-10).
const METRIC_SLUGS = Object.keys(MetricPeriodSchema.shape).filter((key) => key !== "timestamp");

const PAGE_LIMIT = 100;
const MAX_PAGES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
// The first sync reads the last 30 days of events; later syncs go back one day before the
// previous sync, so an order paid or a refund confirmed late is still seen. Dedupe keys absorb
// the overlap.
const EVENTS_BACKFILL_MS = 30 * DAY_MS;
const EVENTS_OVERLAP_MS = DAY_MS;

const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

type Scope =
  | "organizations:read"
  | "metrics:read"
  | "orders:read"
  | "subscriptions:read"
  | "customers:read"
  | "refunds:read";

const permissions: readonly (Permission & { scope: Scope })[] = [
  {
    scope: "organizations:read",
    access: "read",
    description: "Read the names of your Polar organizations so you can choose which ones to track",
  },
  {
    scope: "metrics:read",
    access: "read",
    description: "Read revenue, Polar fees, recurring revenue, and order and subscription counts from Polar's analytics",
  },
  {
    scope: "orders:read",
    access: "read",
    description: "Read paid orders to show them on your StackDash timeline. StackDash does not store customer names or emails",
  },
  { scope: "subscriptions:read", access: "read", description: "Read new and canceled subscriptions to show them on your timeline" },
  {
    scope: "customers:read",
    access: "read",
    description: "Count new customers. StackDash does not store customer names, emails, or addresses",
  },
  { scope: "refunds:read", access: "read", description: "Read refunds to show them on your timeline" },
];

const requestedScopes: readonly Scope[] = permissions.map((permission) => permission.scope);

// Exported, like the metric and event builders below, for the local simulator (#131).
// No `category` (#173): a paid order and a started subscription are payments by a customer, not
// signups or deploys, so the headline's signups leave them out, as they do Stripe's customer and
// subscription events. Polar's revenue reaches the headline through its revenue metric instead.
export const eventTypes = [
  {
    id: "polar.order.paid",
    label: "Order paid",
    description: "An order on your Polar organization was paid, including subscription renewals.",
    shownByDefault: true,
    emoji: "💳",
  },
  {
    id: "polar.subscription.started",
    label: "Subscription started",
    description: "A subscription on your Polar organization started.",
    shownByDefault: true,
    emoji: "🔁",
  },
  {
    id: "polar.subscription.canceled",
    label: "Subscription canceled",
    description: "A customer canceled a subscription on your Polar organization. Access can continue until the paid period ends.",
    shownByDefault: true,
    emoji: "🚪",
  },
  {
    id: "polar.refund.succeeded",
    label: "Order refunded",
    description: "An order on your Polar organization was refunded in full or in part.",
    shownByDefault: true,
    emoji: "↩️",
  },
] as const satisfies readonly EventType[];

// Achievements (#413): counts only, never amounts. Shared with Stripe: keep the ids, thresholds,
// and wording in step with Stripe's (docs/adapters.md, "Achievements"). Polar has no customer
// event, so it has no customer ones.
const achievements: readonly Achievement[] = [
  {
    id: "polar.payments.first",
    title: "First Polar payment recorded",
    publicTitle: "First Polar payment recorded",
    description: "Earned when StackDash records the first successful Polar payment.",
    rule: { kind: "event_count", typeIds: ["polar.order.paid"], count: 1 },
  },
  {
    id: "polar.payments.10",
    title: "10 Polar payments recorded",
    publicTitle: "10 Polar payments recorded",
    description: "Earned when StackDash records the 10th successful Polar payment.",
    rule: { kind: "event_count", typeIds: ["polar.order.paid"], count: 10 },
  },
  {
    id: "polar.payments.100",
    title: "100 Polar payments recorded",
    publicTitle: "100 Polar payments recorded",
    description: "Earned when StackDash records the 100th successful Polar payment.",
    rule: { kind: "event_count", typeIds: ["polar.order.paid"], count: 100 },
  },
  {
    id: "polar.payments.1000",
    title: "1,000 Polar payments recorded",
    publicTitle: "1,000 Polar payments recorded",
    description: "Earned when StackDash records the 1,000th successful Polar payment.",
    rule: { kind: "event_count", typeIds: ["polar.order.paid"], count: 1000 },
  },
  {
    id: "polar.payments.payday",
    title: "Payday: 10 payments in one day",
    publicTitle: "Payday: 10 payments in one day",
    description: "Earned when StackDash records 10 successful Polar payments on one London calendar day.",
    rule: { kind: "events_in_window", typeIds: ["polar.order.paid"], count: 10, window: "day" },
  },
  {
    id: "polar.payments.while_you_slept",
    title: "While you slept: a payment between midnight and 5 am",
    publicTitle: "While you slept: a payment between midnight and 5 am",
    description: "Earned when StackDash records a successful Polar payment between midnight and 5 am London time.",
    rule: { kind: "event_at_local_time", typeIds: ["polar.order.paid"], fromHour: 0, toHour: 5 },
  },
  {
    id: "polar.subscriptions.first",
    title: "First Polar subscription recorded",
    publicTitle: "First Polar subscription recorded",
    description: "Earned when StackDash records the first new Polar subscription.",
    rule: { kind: "event_count", typeIds: ["polar.subscription.started"], count: 1 },
  },
  {
    id: "polar.subscriptions.10",
    title: "10 Polar subscriptions recorded",
    publicTitle: "10 Polar subscriptions recorded",
    description: "Earned when StackDash records the 10th new Polar subscription.",
    rule: { kind: "event_count", typeIds: ["polar.subscription.started"], count: 10 },
  },
];

type EventTypeId = (typeof eventTypes)[number]["id"];

// Order statuses that mean the money arrived; `draft`, `pending`, and `void` orders are not events.
const PAID_ORDER_STATUSES: Readonly<Record<string, true>> = { paid: true, refunded: true, partially_refunded: true };

const ORDER_TITLES: Readonly<Record<string, string>> = {
  purchase: "Order paid",
  subscription_create: "Order paid for a new subscription",
  subscription_cycle: "Subscription renewed",
  subscription_update: "Order paid for a subscription change",
};

// Polar's enum values in words. `other` and unknown values get no reason rather than a guess.
const CANCELLATION_REASONS: Readonly<Record<string, string>> = {
  too_expensive: "too expensive",
  missing_features: "missing features",
  switched_service: "switched service",
  unused: "unused",
  customer_service: "customer service",
  low_quality: "low quality",
  too_complex: "too complex",
};

const REFUND_REASONS: Readonly<Record<string, string>> = {
  duplicate: "duplicate",
  fraudulent: "fraudulent",
  customer_request: "customer request",
  service_disruption: "service disruption",
  satisfaction_guarantee: "satisfaction guarantee",
  dispute_prevention: "dispute prevention",
  tax_refund: "tax refund",
  vat_reverse_charge_correction: "VAT reverse charge correction",
};

/**
 * Token endpoint call, for the code exchange and the refresh. Only `invalid_grant` (RFC 6749
 * section 5.2: a code or refresh token that is used, expired, or revoked) means the grant is gone,
 * so only it becomes auth revoked and asks the user to reconnect; the exact error Polar sends for a
 * spent refresh token is Unverified #2. `invalid_client`, `invalid_request`, and
 * `unsupported_grant_type` are this instance's configuration, not the user's grant: they stay
 * invalid responses, retried and logged, even when `invalid_client` comes as a 401, which
 * `fetchJson` alone would call auth revoked.
 */
async function tokenRequest(ctx: OAuthContext, form: Readonly<Record<string, string>>): Promise<TokenResponse> {
  let oauthError: string | undefined;
  const capturingFetch: FetchLike = async (input, init) => {
    const response = await ctx.fetch(input, init);
    if (response.status === 400 || response.status === 401) {
      oauthError = await readOAuthErrorCode(response.clone());
    }
    return response;
  };
  try {
    return await fetchJson(
      { ...ctx, fetch: capturingFetch },
      TOKEN_URL,
      {
        method: "POST",
        headers: OAUTH_FORM_HEADERS,
        // client_secret_post, as in Polar's token request reference. Never logged.
        body: new URLSearchParams({
          ...form,
          client_id: ctx.client.clientId,
          client_secret: ctx.client.clientSecret.reveal(),
        }).toString(),
      },
      TokenResponseSchema,
    );
  } catch (error) {
    if (error instanceof InvalidResponseError && error.status === 400 && oauthError === "invalid_grant") {
      throw new AuthRevokedError("Polar rejected the authorization grant (invalid_grant); reconnect Polar", {
        cause: error,
        status: 400,
        endpoint: TOKEN_URL,
      });
    }
    if (error instanceof AuthRevokedError && error.status === 401 && oauthError === "invalid_client") {
      throw new InvalidResponseError("Polar rejected this instance's OAuth client credentials (invalid_client)", {
        cause: error,
        status: 401,
        endpoint: TOKEN_URL,
      });
    }
    throw error;
  }
}

function toCredential(token: TokenResponse, issuedAt: Date, previousRefresh: Secret | undefined): OAuthCredential {
  // A refresh answer without a refresh token keeps the one that is still valid (Unverified #2).
  const refreshToken = token.refresh_token == null ? previousRefresh : new Secret(token.refresh_token);
  return {
    accessToken: new Secret(token.access_token),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    // 864000 seconds (10 days) in Polar's example; taken from the response, never assumed.
    expiresAt: new Date(issuedAt.getTime() + token.expires_in * 1000),
    scopes: token.scope.split(" ").filter((scope) => scope.length > 0),
    tokenType: token.token_type,
  };
}

async function polarGet<T>(
  ctx: AdapterContext,
  credential: OAuthCredential,
  url: string,
  params: URLSearchParams,
  schema: z.ZodType<T>,
  scope: Scope,
): Promise<T> {
  const target = new URL(url);
  target.search = params.toString();
  try {
    return await fetchJson(
      ctx,
      target,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${credential.accessToken.reveal()}`,
          Accept: "application/json",
          "Polar-Version": POLAR_API_VERSION,
        },
      },
      schema,
    );
  } catch (error) {
    if (error instanceof PermissionMissingError && error.missingScopes.length === 0) {
      throw new PermissionMissingError(`Polar refused ${url}; the grant needs ${scope}`, [scope], {
        cause: error,
        status: 403,
        endpoint: url,
      });
    }
    throw error;
  }
}

type Paged<T> = { items: T[]; truncated: boolean };

/**
 * Page and limit pagination, capped at MAX_PAGES. `stopAt` ends the walk early on a list sorted
 * newest first, at the first item older than the window.
 */
async function listPages<T>(
  ctx: AdapterContext,
  credential: OAuthCredential,
  url: string,
  baseParams: URLSearchParams,
  schema: z.ZodType<PolarList<T>>,
  scope: Scope,
  stopAt?: (item: T) => boolean,
): Promise<Paged<T>> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const params = new URLSearchParams(baseParams);
    params.set("page", String(page));
    params.set("limit", String(PAGE_LIMIT));
    const list = await polarGet(ctx, credential, url, params, schema, scope);
    for (const item of list.items) {
      if (stopAt?.(item) === true) return { items, truncated: false };
      items.push(item);
    }
    if (list.items.length === 0 || page >= list.pagination.max_page) return { items, truncated: false };
  }
  return { items, truncated: true };
}

function utcMonthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

// Polar returns currency values in cents, sometimes with a fraction. As a decimal in dollars they
// go through the app's one rounding rule (src/lib/money.ts): summed exactly, rounded once.
function centsToDollars(cents: number): Decimal {
  const decimal = parseDecimal(cents);
  return { coefficient: decimal.coefficient, scale: decimal.scale + 2 };
}

function toUsdMinor(values: readonly Decimal[]): number {
  try {
    return toMinorUnits(addDecimals(values), METRICS_CURRENCY);
  } catch (error) {
    if (!(error instanceof InvalidDecimalError)) throw error;
    throw new InvalidResponseError("Polar metrics hold an amount StackDash cannot store", {
      cause: error,
      endpoint: METRICS_URL,
    });
  }
}

type PeriodField = Exclude<keyof MetricPeriod, "timestamp">;

/** Every period's value, or undefined when any period lacks it: a gap is unavailable, never zero. */
function seriesOf(periods: readonly MetricPeriod[], field: PeriodField): number[] | undefined {
  const values: number[] = [];
  for (const period of periods) {
    const value = period[field];
    if (value === null || value === undefined) return undefined;
    values.push(value);
  }
  return values;
}

/**
 * Metrics from one `GET /v1/metrics/` response read at `now` with a daily interval from the first
 * of the UTC month to today. Flows (revenue, fees, orders, new and canceled subscriptions) are the
 * sum of the month's days; run rates and the active count are the latest day's value.
 */
export function analyticsMetrics(
  response: MetricsResponse,
  now: Date,
  externalAccountId: string,
  ctx: AdapterContext,
): AdapterMetric[] {
  const monthStart = utcMonthStart(now);
  const periods = response.periods
    .filter((period) => period.timestamp.getTime() >= monthStart.getTime() && period.timestamp.getTime() <= now.getTime())
    .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const common = { externalAccountId, retrievedAt: now, provenance: { source: "provider_api", endpoint: METRICS_URL } } as const;
  const metrics: AdapterMetric[] = [];

  // At the first instant of a month the period would be empty, which a timeframe cannot be.
  if (monthStart.getTime() < now.getTime() && periods.length > 0) {
    const month = { ...common, timeframe: { type: "period", start: monthStart, end: now } } as const;
    const revenue = seriesOf(periods, "revenue");
    const netRevenue = seriesOf(periods, "net_revenue");
    if (revenue !== undefined) {
      const dollars = revenue.map(centsToDollars);
      metrics.push({
        ...month,
        kind: "revenue",
        metricKey: "polar.revenue.month.usd",
        label: `Revenue before fees, this month (${METRICS_CURRENCY})`,
        amountMinor: toUsdMinor(dollars),
        currency: METRICS_CURRENCY,
      });
      if (netRevenue !== undefined) {
        // Net revenue is revenue after Polar's platform and payment processor fees, so the
        // difference is what Polar kept. Never inferred from a price list.
        const fees = netRevenue.map((cents) => {
          const net = centsToDollars(cents);
          return { coefficient: -net.coefficient, scale: net.scale };
        });
        const feesMinor = toUsdMinor([...dollars, ...fees]);
        if (feesMinor >= 0) {
          metrics.push({
            ...month,
            kind: "verified_spend",
            metricKey: "polar.fees.month.usd",
            label: `Polar fees, this month (${METRICS_CURRENCY})`,
            amountMinor: feesMinor,
            currency: METRICS_CURRENCY,
          });
        } else {
          // More net than gross cannot be shown as spend.
          ctx.logger.warn("polar.fees.net_credit", { currency: METRICS_CURRENCY });
        }
      }
    }
    const counts = [
      { field: "orders", metricKey: "polar.orders.month", label: "Orders this month", unit: "orders" },
      {
        field: "new_subscriptions",
        metricKey: "polar.subscriptions.new.month",
        label: "New subscriptions this month",
        unit: "subscriptions",
      },
      {
        field: "canceled_subscriptions",
        metricKey: "polar.subscriptions.canceled.month",
        label: "Canceled subscriptions this month",
        unit: "subscriptions",
      },
    ] as const;
    for (const { field, metricKey, label, unit } of counts) {
      const values = seriesOf(periods, field);
      if (values === undefined) continue;
      metrics.push({ ...month, kind: "usage", metricKey, label, value: values.reduce((sum, value) => sum + value, 0), unit });
    }
  }

  const latest = periods.at(-1);
  if (latest !== undefined) {
    const point = { ...common, timeframe: { type: "point", at: now } } as const;
    const rates = [
      { field: "monthly_recurring_revenue", metricKey: "polar.mrr.usd", label: `Monthly recurring revenue (${METRICS_CURRENCY})` },
      { field: "annual_recurring_revenue", metricKey: "polar.arr.usd", label: `Annual recurring revenue (${METRICS_CURRENCY})` },
    ] as const;
    for (const { field, metricKey, label } of rates) {
      const cents = latest[field];
      if (cents === null || cents === undefined) continue;
      metrics.push({
        ...point,
        kind: "recurring_revenue",
        metricKey,
        label,
        amountMinor: toUsdMinor([centsToDollars(cents)]),
        currency: METRICS_CURRENCY,
      });
    }
    const active = latest.active_subscriptions;
    if (active !== null && active !== undefined) {
      metrics.push({
        ...point,
        kind: "usage",
        metricKey: "polar.subscriptions.active",
        label: "Active subscriptions",
        value: active,
        unit: "subscriptions",
      });
    }
  }
  return metrics;
}

/** New customers this month, from a count of customers created since the first of the UTC month. */
export function newCustomersMetric(count: number, now: Date, externalAccountId: string): AdapterMetric[] {
  const monthStart = utcMonthStart(now);
  if (monthStart.getTime() >= now.getTime()) return [];
  return [
    {
      kind: "usage",
      metricKey: "polar.customers.new.month",
      label: "New customers this month",
      timeframe: { type: "period", start: monthStart, end: now },
      externalAccountId,
      retrievedAt: now,
      provenance: { source: "provider_api", endpoint: CUSTOMERS_URL },
      value: count,
      unit: "customers",
    },
  ];
}

async function syncAnalytics(
  credential: OAuthCredential,
  externalAccountId: string,
  now: Date,
  ctx: AdapterContext,
): Promise<AdapterMetric[]> {
  // Totals cover the whole month to date, so every sync reads it again; no cursor here.
  const params = new URLSearchParams({
    start_date: utcMonthStart(now).toISOString().slice(0, 10),
    end_date: now.toISOString().slice(0, 10),
    interval: "day",
    timezone: "UTC",
    organization_id: externalAccountId,
  });
  for (const slug of METRIC_SLUGS) params.append("metrics", slug);
  const response = await polarGet(ctx, credential, METRICS_URL, params, MetricsResponseSchema, "metrics:read");
  return analyticsMetrics(response, now, externalAccountId, ctx);
}

async function syncNewCustomers(
  credential: OAuthCredential,
  externalAccountId: string,
  now: Date,
  ctx: AdapterContext,
): Promise<AdapterMetric[]> {
  const monthStartMs = utcMonthStart(now).getTime();
  // The customer list has no date filter, so it is read newest first until the month began.
  const params = new URLSearchParams({ organization_id: externalAccountId, sorting: "-created_at" });
  const { items, truncated } = await listPages(
    ctx,
    credential,
    CUSTOMERS_URL,
    params,
    polarListSchema(CustomerSchema),
    "customers:read",
    (customer) => customer.created_at.getTime() < monthStartMs,
  );
  if (truncated) {
    // A partial count would understate new customers, so none is reported.
    ctx.logger.warn("polar.customers.truncated", { maxPages: MAX_PAGES, pageLimit: PAGE_LIMIT });
    return [];
  }
  return newCustomersMetric(items.length, now, externalAccountId);
}

type TimelineEntry = { typeId: EventTypeId; occurredAt: Date; severity: EventSeverity; title: string; body?: string; dedupeKey: string };

function toEvent(entry: TimelineEntry, externalAccountId: string): ActivityEvent {
  return {
    typeId: entry.typeId,
    occurredAt: entry.occurredAt,
    severity: entry.severity,
    title: entry.title,
    ...(entry.body === undefined ? {} : { body: entry.body }),
    externalAccountId,
    // Polar ids are stable across polls; the store upserts on them.
    dedupeKey: entry.dedupeKey,
  };
}

export function orderEvent(order: Order, externalAccountId: string): ActivityEvent | undefined {
  if (PAID_ORDER_STATUSES[order.status] !== true) return undefined;
  return toEvent(
    {
      typeId: "polar.order.paid",
      occurredAt: order.created_at,
      severity: "success",
      title: titleWithAmount(ORDER_TITLES[order.billing_reason] ?? "Order paid", order.total_amount, order.currency),
      dedupeKey: `order:${order.id}`,
    },
    externalAccountId,
  );
}

export function subscriptionStartedEvent(subscription: Subscription, externalAccountId: string): ActivityEvent | undefined {
  if (subscription.started_at === null) return undefined;
  return toEvent(
    {
      typeId: "polar.subscription.started",
      occurredAt: subscription.started_at,
      severity: "success",
      title: subscription.status === "trialing" ? "Trial started" : "Subscription started",
      dedupeKey: `subscription_started:${subscription.id}`,
    },
    externalAccountId,
  );
}

export function subscriptionCanceledEvent(subscription: Subscription, externalAccountId: string): ActivityEvent | undefined {
  if (subscription.canceled_at === null) return undefined;
  const reasonCode = subscription.customer_cancellation_reason;
  const reason = reasonCode === null || reasonCode === undefined ? undefined : CANCELLATION_REASONS[reasonCode];
  const sentences = [
    ...(reason === undefined ? [] : [`Reason: ${reason}.`]),
    ...(subscription.cancel_at_period_end ? ["Access continues until the paid period ends."] : []),
  ];
  return toEvent(
    {
      typeId: "polar.subscription.canceled",
      occurredAt: subscription.canceled_at,
      severity: "warning",
      title: "Subscription canceled",
      ...(sentences.length === 0 ? {} : { body: sentences.join(" ") }),
      dedupeKey: `subscription_canceled:${subscription.id}`,
    },
    externalAccountId,
  );
}

export function refundEvent(refund: Refund, externalAccountId: string): ActivityEvent | undefined {
  if (refund.status !== "succeeded") return undefined;
  const reason = REFUND_REASONS[refund.reason];
  // What the customer got back: the refund before tax plus the tax Polar refunded with it, both in
  // the refund's one currency. Without either part the total is unknown, so no amount is shown.
  const refundedMinor = refund.amount === undefined || refund.tax_amount === undefined ? undefined : refund.amount + refund.tax_amount;
  return toEvent(
    {
      typeId: "polar.refund.succeeded",
      occurredAt: refund.created_at,
      severity: "info",
      title: titleWithAmount("Order refunded", refundedMinor, refund.currency),
      ...(reason === undefined ? {} : { body: `Reason: ${reason}` }),
      dedupeKey: `refund:${refund.id}`,
    },
    externalAccountId,
  );
}

/** The cursor is the ISO time of the previous sync; events are read from a day before it. */
function eventsSince(cursor: string | undefined, now: Date, ctx: AdapterContext): Date {
  const floor = now.getTime() - EVENTS_BACKFILL_MS;
  if (cursor === undefined) return new Date(floor);
  const previous = Date.parse(cursor);
  if (Number.isNaN(previous) || new Date(previous).toISOString() !== cursor) {
    ctx.logger.warn("polar.events.cursor_invalid", {});
    return new Date(floor);
  }
  if (previous < floor) {
    // Syncs stopped for more than 30 days; the timeline has a gap before the floor.
    ctx.logger.warn("polar.events.gap", { cursor, floor: new Date(floor).toISOString() });
  }
  return new Date(Math.max(previous - EVENTS_OVERLAP_MS, floor));
}

type StreamRead<T> = {
  name: string;
  url: string;
  scope: Scope;
  params: URLSearchParams;
  schema: z.ZodType<PolarList<T>>;
  stopAt?: (item: T) => boolean;
  toEvent: (item: T, externalAccountId: string) => ActivityEvent | undefined;
};

async function readStream<T>(
  stream: StreamRead<T>,
  credential: OAuthCredential,
  externalAccountId: string,
  since: Date,
  ctx: AdapterContext,
): Promise<ActivityEvent[]> {
  const { items, truncated } = await listPages(
    ctx,
    credential,
    stream.url,
    stream.params,
    stream.schema,
    stream.scope,
    stream.stopAt,
  );
  if (truncated) {
    ctx.logger.warn("polar.events.truncated", { stream: stream.name, maxPages: MAX_PAGES, pageLimit: PAGE_LIMIT });
  }
  const events: ActivityEvent[] = [];
  for (const item of items) {
    const event = stream.toEvent(item, externalAccountId);
    // The filters are inclusive or approximate on Polar's side; the window is enforced here too.
    if (event !== undefined && event.occurredAt.getTime() >= since.getTime()) events.push(event);
  }
  return events;
}

function timelineStreams(externalAccountId: string, since: Date) {
  const sinceIso = since.toISOString();
  const org = { organization_id: externalAccountId };
  return [
    {
      name: "orders",
      url: ORDERS_URL,
      scope: "orders:read",
      params: new URLSearchParams({ ...org, created_after: sinceIso, sorting: "-created_at" }),
      schema: polarListSchema(OrderSchema),
      toEvent: orderEvent,
    } satisfies StreamRead<Order>,
    {
      name: "subscriptions_started",
      url: SUBSCRIPTIONS_URL,
      scope: "subscriptions:read",
      params: new URLSearchParams({ ...org, started_after: sinceIso, sorting: "-started_at" }),
      schema: polarListSchema(SubscriptionSchema),
      toEvent: subscriptionStartedEvent,
    } satisfies StreamRead<Subscription>,
    {
      name: "subscriptions_canceled",
      url: SUBSCRIPTIONS_URL,
      scope: "subscriptions:read",
      params: new URLSearchParams({ ...org, canceled_at_after: sinceIso }),
      schema: polarListSchema(SubscriptionSchema),
      toEvent: subscriptionCanceledEvent,
    } satisfies StreamRead<Subscription>,
    {
      // Refunds have no date filter: newest first, stopping at the first one before the window.
      // `succeeded=true` keeps pending and failed refunds, which never become events, off the page cap.
      name: "refunds",
      url: REFUNDS_URL,
      scope: "refunds:read",
      params: new URLSearchParams({ ...org, succeeded: "true", sorting: "-created_at" }),
      schema: polarListSchema(RefundSchema),
      stopAt: (refund: Refund) => refund.created_at.getTime() < since.getTime(),
      toEvent: refundEvent,
    } satisfies StreamRead<Refund>,
  ] as const;
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

export const polarAdapter: ProviderAdapter = {
  id: "polar",
  displayName: PROVIDER_NAMES.polar,
  capabilities: {
    oauth: true,
    polling: true,
    usage: true,
    spending: true,
    allowance: false,
    credits: false,
    revenue: true,
    events: true,
  },
  permissions,
  dataCollected: [
    "Revenue before fees and Polar fees in USD, this month",
    "Monthly and annual recurring revenue in USD",
    "Orders, new and canceled subscriptions, active subscriptions, and new customers, as counts",
    "Paid order, subscription, and refund events with Polar ids, dates, each order's and refund's amount and currency, and Polar's reason codes",
    "Never customer names, emails, addresses, tax ids, or payment details",
  ],
  eventTypes,
  achievements,
  oauth: {
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    revokeUrl: REVOKE_URL,
    scopes: requestedScopes,
    pkce: true,
    clientIdEnv: "POLAR_CLIENT_ID",
    clientSecretEnv: "POLAR_CLIENT_SECRET",
  },
  // Hourly, like Stripe: about six requests per organization per sync against 500 per minute.
  pollIntervalSeconds: 3600,

  buildAuthorizeUrl({ client, state, redirectUri, codeChallenge }) {
    if (codeChallenge === undefined) throw new TypeError("Polar requires a PKCE S256 code challenge");
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    // Always explicit: never let the scope default by omission.
    url.searchParams.set("scope", requestedScopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  },

  async exchangeCode({ code, redirectUri, codeVerifier, callbackParams }, ctx) {
    // RFC 9207: a callback naming a different issuer is a mix-up attack.
    const iss = callbackParams.iss;
    if (iss !== undefined && iss !== POLAR_ISSUER) {
      throw new InvalidResponseError("Polar callback carried an unexpected issuer");
    }
    if (codeVerifier === undefined || !CODE_VERIFIER.test(codeVerifier)) {
      throw new TypeError("Polar requires a PKCE code verifier of 43 to 128 unreserved characters");
    }
    const issuedAt = ctx.now();
    const token = await tokenRequest(ctx, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    return toCredential(token, issuedAt, undefined);
  },

  /**
   * Polar may rotate the refresh token (Unverified #2). Callers serialize refreshes per
   * connection and store the returned credential before using it, as for Stripe and Resend.
   */
  async refreshTokens(credential, ctx) {
    if (credential.refreshToken === undefined) {
      throw new AuthRevokedError("Polar credential has no refresh token; reconnect Polar", { endpoint: TOKEN_URL });
    }
    const issuedAt = ctx.now();
    // A used, expired, or revoked refresh token is `invalid_grant`, which `tokenRequest` reports as
    // auth revoked (Unverified #2).
    const token = await tokenRequest(ctx, { grant_type: "refresh_token", refresh_token: credential.refreshToken.reveal() });
    return toCredential(token, issuedAt, credential.refreshToken);
  },

  /**
   * RFC 7009 revocation of both tokens: whether revoking one also ends the other is not
   * documented (Unverified #8), and revoking an unknown token still answers 200.
   */
  async revoke(credential, ctx) {
    const tokens = [
      ...(credential.refreshToken === undefined ? [] : [{ token: credential.refreshToken, hint: "refresh_token" }]),
      { token: credential.accessToken, hint: "access_token" },
    ];
    for (const { token, hint } of tokens) {
      await fetchJson(
        ctx,
        REVOKE_URL,
        {
          method: "POST",
          headers: OAUTH_FORM_HEADERS,
          body: new URLSearchParams({
            token: token.reveal(),
            token_type_hint: hint,
            client_id: ctx.client.clientId,
            client_secret: ctx.client.clientSecret.reveal(),
          }).toString(),
        },
        RevokeResponseSchema,
      );
    }
  },

  async listAccounts(credential, ctx): Promise<ExternalAccount[]> {
    const { items, truncated } = await listPages(
      ctx,
      credential,
      ORGANIZATIONS_URL,
      new URLSearchParams({ sorting: "name" }),
      polarListSchema(OrganizationSchema),
      "organizations:read",
    );
    if (truncated) ctx.logger.warn("polar.organizations.truncated", { maxPages: MAX_PAGES, pageLimit: PAGE_LIMIT });
    return items.map((organization) => ({ externalId: organization.id, displayName: organization.name, kind: "organization" }));
  },

  detectMissingPermissions(grant) {
    return requestedScopes.filter((scope) => !grant.scopes.includes(scope));
  },

  async sync(input: SyncInput, ctx: OAuthContext): Promise<SyncResult> {
    const { credential, externalAccountId } = input;
    const now = ctx.now();
    const since = eventsSince(input.cursor, now, ctx);
    const [orders, started, canceled, refunds] = timelineStreams(externalAccountId, since);
    const [analytics, customers, ...timeline] = await Promise.all([
      settle(syncAnalytics(credential, externalAccountId, now, ctx)),
      settle(syncNewCustomers(credential, externalAccountId, now, ctx)),
      settle(readStream(orders, credential, externalAccountId, since, ctx)),
      settle(readStream(started, credential, externalAccountId, since, ctx)),
      settle(readStream(canceled, credential, externalAccountId, since, ctx)),
      settle(readStream(refunds, credential, externalAccountId, since, ctx)),
    ]);

    const metrics: AdapterMetric[] = [];
    const events: ActivityEvent[] = [];
    const partialErrors: PermissionMissingError[] = [];
    for (const part of [analytics, customers]) {
      if (part.ok) metrics.push(...part.value);
      else partialErrors.push(part.error);
    }
    for (const part of timeline) {
      if (part.ok) events.push(...part.value);
      else partialErrors.push(part.error);
    }
    events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.dedupeKey < b.dedupeKey ? -1 : 1));
    // An unreadable stream keeps the previous cursor, so the next sync reads its window again.
    const cursor = timeline.every((part) => part.ok) ? now.toISOString() : input.cursor;

    return {
      metrics,
      events,
      ...(cursor === undefined ? {} : { cursor }),
      ...(partialErrors.length === 0 ? {} : { partialErrors }),
    };
  },
};
