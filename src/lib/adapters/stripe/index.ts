import type { z } from "zod";
import type { Achievement } from "@/lib/adapters/achievements";
import {
  AdapterError,
  AuthRevokedError,
  InvalidResponseError,
  PermissionMissingError,
  fetchJson,
} from "@/lib/adapters/errors";
import { titleWithAmount, type ActivityEvent, type EventSeverity, type EventType } from "@/lib/adapters/events";
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
  type WebhookOutcome,
  type WebhookRequest,
  type WebhookVerification,
} from "@/lib/adapters/types";
import { formatMoney } from "@/lib/format";
import { PROVIDER_NAMES } from "@/lib/providers";
import { hmacHex, isFresh, safeEqual } from "@/lib/webhooks/signature";
import {
  BalanceTransactionSchema,
  ChargeObjectSchema,
  CustomerObjectSchema,
  EventSchema,
  SubscriptionObjectSchema,
  TokenResponseSchema,
  WebhookEventIdSchema,
  WebhookEventSchema,
  stripeListSchema,
  type BalanceTransaction,
  type StripeEvent,
  type StripeList,
  type TokenResponse,
} from "./schemas";

/**
 * Stripe adapter (adapter pattern over the Stripe REST API). Facts, endpoints, and privacy rules
 * come from docs/providers/stripe.md; "Unverified #n" refers to that page's Unverified list.
 *
 * Webhooks (#423): one endpoint on the app owner's account, in live mode, with "Listen to events on
 * Connected accounts", receives every install's events with `account` set to the installing
 * account. Stripe signs the timestamp and the raw body, and the event id (the delivery id) is inside
 * the body, so a captured delivery can be neither replayed later nor sent again under a new id.
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

// Webhook (#423), per https://docs.stripe.com/webhooks#verify-manually: `Stripe-Signature` is
// `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`, with one `v1` per active secret
// while a secret is being rolled, and a fake `v0` on sandbox events that must be ignored. Stripe's
// libraries default to a 5 minute tolerance.
export const STRIPE_SIGNATURE_HEADER = "stripe-signature";
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;
const SIGNATURE_SCHEME = "v1";
// The events Stripe sends when an account uninstalls the app (docs.stripe.com/stripe-apps/events).
// `app.install.deleted` is the older name, on endpoints pinned to an API version before 2026-09-30.
const UNINSTALL_EVENTS: Readonly<Record<string, true>> = {
  "apps.install.deleted": true,
  "app.install.deleted": true,
  "account.application.deauthorized": true,
};

const permissions: readonly Permission[] = [
  {
    scope: "event_read",
    access: "read",
    description: "Read payment, customer, subscription, and refund events to show them on your StackDash timeline",
  },
  { scope: "charge_read", access: "read", description: "Read payment and refund amounts to show revenue" },
  {
    scope: "customer_read",
    access: "read",
    description: "Count new customers. StackDash does not store customer names or emails",
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
    emoji: "💳",
  },
  {
    stripeType: "charge.failed",
    label: "Payment failed",
    description: "A payment on your Stripe account failed.",
    emoji: "🚫",
  },
  {
    stripeType: "charge.refunded",
    label: "Payment refunded",
    description: "A payment on your Stripe account was refunded in full or in part.",
    emoji: "↩️",
  },
  {
    stripeType: "customer.created",
    label: "New customer",
    description: "A customer was added to your Stripe account.",
    emoji: "🤝",
  },
  {
    stripeType: "customer.subscription.created",
    label: "Subscription created",
    description: "A subscription was created on your Stripe account.",
    emoji: "🔁",
  },
  {
    stripeType: "customer.subscription.deleted",
    label: "Subscription ended",
    description: "A subscription on your Stripe account ended.",
    emoji: "🚪",
  },
] as const;

// What the webhook endpoint listens to: the events the sync polls, so a pushed event and a polled
// one are the same Stripe event, and the two uninstall events.
const WEBHOOK_SUBSCRIPTIONS = [
  ...timelineEvents.map((event) => event.stripeType),
  "apps.install.deleted",
  "account.application.deauthorized",
];

// No `category` (#173): `customer.created` and `customer.subscription.created` are billing records,
// made at checkout or by an invoice whether or not someone signed up to the product, and a free
// signup makes neither. Counting them would mix payers into signups and count people twice
// beside the product's own auth provider, so the headline's signups leave them out.
const eventTypes: readonly EventType[] = timelineEvents.map((event) => ({
  id: `stripe.${event.stripeType}`,
  label: event.label,
  description: event.description,
  shownByDefault: true,
  emoji: event.emoji,
}));

// Achievements (#413): counts only, never amounts. The payment and subscription ids are shared
// with Polar: keep the ids, thresholds, and wording in step with Polar's (docs/adapters.md,
// "Achievements"). Polar has no customer event, so the customer ones are Stripe's own.
const achievements: readonly Achievement[] = [
  {
    id: "stripe.payments.first",
    title: "First Stripe payment recorded",
    publicTitle: "First Stripe payment recorded",
    description: "Earned when StackDash records the first successful Stripe payment.",
    rule: { kind: "event_count", typeIds: ["stripe.charge.succeeded"], count: 1 },
  },
  {
    id: "stripe.payments.10",
    title: "10 Stripe payments recorded",
    publicTitle: "10 Stripe payments recorded",
    description: "Earned when StackDash records the 10th successful Stripe payment.",
    rule: { kind: "event_count", typeIds: ["stripe.charge.succeeded"], count: 10 },
  },
  {
    id: "stripe.payments.100",
    title: "100 Stripe payments recorded",
    publicTitle: "100 Stripe payments recorded",
    description: "Earned when StackDash records the 100th successful Stripe payment.",
    rule: { kind: "event_count", typeIds: ["stripe.charge.succeeded"], count: 100 },
  },
  {
    id: "stripe.payments.1000",
    title: "1,000 Stripe payments recorded",
    publicTitle: "1,000 Stripe payments recorded",
    description: "Earned when StackDash records the 1,000th successful Stripe payment.",
    rule: { kind: "event_count", typeIds: ["stripe.charge.succeeded"], count: 1000 },
  },
  {
    id: "stripe.payments.payday",
    title: "Payday: 10 payments in one day",
    publicTitle: "Payday: 10 payments in one day",
    description: "Earned when StackDash records 10 successful Stripe payments on one London calendar day.",
    rule: { kind: "events_in_window", typeIds: ["stripe.charge.succeeded"], count: 10, window: "day" },
  },
  {
    id: "stripe.payments.while_you_slept",
    title: "While you slept: a payment between midnight and 5 am",
    publicTitle: "While you slept: a payment between midnight and 5 am",
    description: "Earned when StackDash records a successful Stripe payment between midnight and 5 am London time.",
    rule: { kind: "event_at_local_time", typeIds: ["stripe.charge.succeeded"], fromHour: 0, toHour: 5 },
  },
  {
    id: "stripe.subscriptions.first",
    title: "First Stripe subscription recorded",
    publicTitle: "First Stripe subscription recorded",
    description: "Earned when StackDash records the first new Stripe subscription.",
    rule: { kind: "event_count", typeIds: ["stripe.customer.subscription.created"], count: 1 },
  },
  {
    id: "stripe.subscriptions.10",
    title: "10 Stripe subscriptions recorded",
    publicTitle: "10 Stripe subscriptions recorded",
    description: "Earned when StackDash records the 10th new Stripe subscription.",
    rule: { kind: "event_count", typeIds: ["stripe.customer.subscription.created"], count: 10 },
  },
  {
    id: "stripe.customers.first",
    title: "First Stripe customer recorded",
    publicTitle: "First Stripe customer recorded",
    description: "Earned when StackDash records the first new Stripe customer.",
    rule: { kind: "event_count", typeIds: ["stripe.customer.created"], count: 1 },
  },
  {
    id: "stripe.customers.100",
    title: "100 Stripe customers recorded",
    publicTitle: "100 Stripe customers recorded",
    description: "Earned when StackDash records the 100th new Stripe customer.",
    rule: { kind: "event_count", typeIds: ["stripe.customer.created"], count: 100 },
  },
];

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

// Stripe's charge `failure_code` values (https://docs.stripe.com/error-codes) as plain sentences
// (#261). A code missing here reads as UNKNOWN_FAILURE: the code itself is never shown, so a
// provider internal never reaches the timeline, and nor can text that is not one of Stripe's codes.
// A Map rather than a Record because the key comes from Stripe: `constructor` must not find
// Object.prototype.
const FAILURE_SENTENCES: ReadonlyMap<string, string> = new Map([
  ["account_closed", "The customer's bank account is closed."],
  ["authentication_required", "The payment needed the customer to authenticate, and they did not."],
  ["bank_account_declined", "The bank account cannot be charged: it is not verified yet or not supported."],
  ["card_decline_rate_limit_exceeded", "The card had too many declines in a row. Stripe allows another try after 24 hours."],
  ["card_declined", "The card issuer declined the payment."],
  ["debit_not_authorized", "The customer told their bank the payment was not authorized."],
  ["expired_card", "The card has expired."],
  ["incorrect_cvc", "The card's security code was incorrect."],
  ["incorrect_number", "The card number was incorrect."],
  ["incorrect_zip", "The card's postal code was incorrect."],
  ["insufficient_funds", "The customer's account did not have enough funds."],
  ["invalid_cvc", "The card's security code was invalid."],
  ["invalid_expiry_month", "The card's expiration month was invalid."],
  ["invalid_expiry_year", "The card's expiration year was invalid."],
  ["invalid_number", "The card number was invalid."],
  ["no_account", "The bank account could not be found."],
  ["processing_error", "An error occurred while processing the card."],
]);
const UNKNOWN_FAILURE = "Stripe gave a reason StackDash does not recognize. Open the payment in your Stripe Dashboard to see it.";

type TimelineEntry = { severity: EventSeverity; title: string; body?: string };

function timelineEntry(event: StripeEvent): TimelineEntry | undefined {
  const type = event.type;
  const object = event.data.object;
  switch (type) {
    case "charge.succeeded": {
      const charge = parseObject(ChargeObjectSchema, object, type);
      return { severity: "success", title: titleWithAmount("Payment succeeded", charge.amount, charge.currency) };
    }
    case "charge.failed": {
      const charge = parseObject(ChargeObjectSchema, object, type);
      const title = titleWithAmount("Payment failed", charge.amount, charge.currency);
      const code = charge.failure_code;
      return code === undefined || code === null
        ? { severity: "warning", title }
        : { severity: "warning", title, body: FAILURE_SENTENCES.get(code) ?? UNKNOWN_FAILURE };
    }
    case "charge.refunded": {
      const { amount, amount_refunded: refundedMinor, currency, refunded } = parseObject(ChargeObjectSchema, object, type);
      // A full refund returns the whole amount, so either field gives it.
      if (refunded !== false) return { severity: "info", title: titleWithAmount("Payment refunded", refundedMinor ?? amount, currency) };
      // `amount_refunded` totals every refund of the charge so far, not just this one, and the
      // title says so: a second partial refund would otherwise read as one refund of the total.
      const ofAmount =
        refundedMinor === undefined || amount === undefined || currency === undefined ? "" : ` of ${formatMoney(amount, currency)} so far`;
      return { severity: "info", title: `${titleWithAmount("Payment partially refunded", refundedMinor, currency)}${ofAmount}` };
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

/* Webhook -------------------------------------------------------------------------------------- */

/**
 * The hex `v1` signature Stripe sends for a delivery: HMAC-SHA256 of `<t>.<raw body>`, keyed with the
 * endpoint's signing secret. Signed as bytes, never decoded first: decoding would map invalid UTF-8
 * onto U+FFFD and let two different bodies share one signature.
 */
function webhookSignature(secret: Secret, timestamp: string, rawBody: Uint8Array): string {
  return hmacHex("sha256", secret, Buffer.concat([Buffer.from(`${timestamp}.`, "utf8"), rawBody]));
}

/**
 * The `Stripe-Signature` header Stripe would send for `rawBody` at `timestampSeconds`. For tests and
 * the e2e suite, which play Stripe.
 */
export function signStripeWebhook({ secret, rawBody, timestampSeconds }: { secret: string; rawBody: string; timestampSeconds: number }): string {
  const timestamp = String(timestampSeconds);
  return `t=${timestamp},${SIGNATURE_SCHEME}=${webhookSignature(new Secret(secret), timestamp, new TextEncoder().encode(rawBody))}`;
}

type SignatureHeader = Readonly<{ timestamp: string | undefined; signatures: readonly string[] }>;

/**
 * Splits the header on `,` and each element on its first `=`. Keeps `t` and every `v1`, and drops
 * every other scheme (`v0`), so a downgrade to a weaker scheme is never checked. A second `t` makes
 * the timestamp ambiguous, so the header has none.
 */
function parseSignatureHeader(value: string): SignatureHeader {
  let timestamp: string | undefined;
  let timestamps = 0;
  const signatures: string[] = [];
  for (const element of value.split(",")) {
    const separator = element.indexOf("=");
    if (separator === -1) continue;
    const prefix = element.slice(0, separator).trim();
    const entry = element.slice(separator + 1).trim();
    if (prefix === "t") {
      timestamps += 1;
      timestamp = entry;
    } else if (prefix === SIGNATURE_SCHEME && entry.length > 0) {
      signatures.push(entry);
    }
  }
  return { timestamp: timestamps === 1 ? timestamp : undefined, signatures };
}

/** The verified body's event id, or undefined when the body is not an event with a usable id. */
function readEventId(rawBody: Uint8Array): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(rawBody));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
  const parsed = WebhookEventIdSchema.safeParse(raw);
  return parsed.success ? parsed.data.id : undefined;
}

/**
 * The header, then every `v1` against the expected signature in constant time, then the tolerance,
 * in the order of Stripe's manual verification steps. The body is read for its event id only once
 * the signature has matched.
 */
function verifyStripeWebhook({ headers, rawBody }: WebhookRequest, secret: Secret, now: Date): WebhookVerification {
  const header = headers.get(STRIPE_SIGNATURE_HEADER);
  if (header === null || header.trim() === "") return { ok: false, reason: "missing_signature" };
  const { timestamp, signatures } = parseSignatureHeader(header);
  if (signatures.length === 0) return { ok: false, reason: "missing_signature" };
  if (timestamp === undefined || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: "malformed" };
  const expected = webhookSignature(secret, timestamp, rawBody);
  // Every entry is compared, so the time taken does not say which one matched.
  let matched = false;
  for (const signature of signatures) matched = safeEqual(signature, expected) || matched;
  if (!matched) return { ok: false, reason: "bad_signature" };
  if (!isFresh(Number(timestamp), now, STRIPE_WEBHOOK_TOLERANCE_SECONDS)) return { ok: false, reason: "stale" };
  const deliveryId = readEventId(rawBody);
  if (deliveryId === undefined) return { ok: false, reason: "malformed" };
  return { ok: true, deliveryId };
}

/**
 * Maps a verified delivery with `toActivityEvent`, the sync's own mapping and allowlists, so a pushed
 * event and the same event polled later share a dedupe key (the Stripe event id) and the timeline
 * stores it once. Nothing from `data.object` outlives this function but the allowlisted fields.
 */
function parseStripeWebhook({ rawBody }: WebhookRequest, ctx: AdapterContext): WebhookOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(rawBody));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { kind: "ignored", reason: "body is not JSON" };
  }
  const parsed = WebhookEventSchema.safeParse(raw);
  if (!parsed.success) return { kind: "ignored", reason: "not a Stripe event" };
  const event = parsed.data;
  if (event.account === undefined) return { kind: "ignored", reason: "an event on the app owner's own account, not an install's" };
  // Decided on #423 (option A): the endpoint is a live mode one, and Stripe also sends it the test
  // mode events of an account that installed the app in both modes. The account id is the same in
  // both, and nothing downstream knows a connection's mode, so a test mode uninstall would revoke
  // the live connection. Test mode connections stay polled until #481.
  // Known gap, accepted by Eddie on #423 (comment 6913870670), open until #481 routes deliveries by
  // mode: the same blindness runs the other way. A live delivery for an account that also has a test
  // mode connection (in this workspace or another, or left behind by a live connection deleted in
  // StackDash but never uninstalled in Stripe) is written to that test mode connection too: live
  // payments on its timeline and in its achievements, and a live uninstall marks it as needing a
  // reconnect.
  if (!event.livemode) return { kind: "ignored", reason: "test mode event; test mode connections are polled" };
  if (UNINSTALL_EVENTS[event.type] === true) {
    return { kind: "uninstalled", externalAccountId: event.account, occurredAt: new Date(event.created * 1000) };
  }
  let activity: ActivityEvent | undefined;
  try {
    activity = toActivityEvent(event, event.account);
  } catch (error) {
    // An object the allowlist rejects. A 4xx would have Stripe retry the same body for three days
    // and then disable the endpoint, so it is acknowledged and dropped; polling reads the event too
    // and fails its sync with the same error. Logged by type only: the object holds personal data.
    if (!(error instanceof InvalidResponseError)) throw error;
    ctx.logger.warn("stripe.webhook.object_rejected", { eventType: event.type });
    return { kind: "ignored", reason: "event object does not match the allowlist" };
  }
  if (activity === undefined) return { kind: "ignored", reason: "event type is not on the timeline" };
  return { kind: "events", externalAccountId: event.account, events: [activity] };
}

/* Adapter -------------------------------------------------------------------------------------- */

export const stripeAdapter: ProviderAdapter = {
  id: "stripe",
  displayName: PROVIDER_NAMES.stripe,
  capabilities: {
    oauth: true,
    polling: true,
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
    "Payment, refund, new customer, and subscription events with Stripe ids, dates, and each payment's amount and currency",
    "Never customer names, emails, addresses, or card details",
  ],
  eventTypes,
  achievements,
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
  // App-level: one live mode endpoint on the app owner's account receives every install's events.
  // One secret, deliberately (#423): see `parseStripeWebhook` for why test mode stays polled.
  webhooks: {
    registration: { kind: "app", secretEnv: "STRIPE_WEBHOOK_SECRET" },
    subscriptions: WEBHOOK_SUBSCRIPTIONS,
    verify: verifyStripeWebhook,
    parse: parseStripeWebhook,
  },

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
