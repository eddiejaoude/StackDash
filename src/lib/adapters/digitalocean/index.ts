import { z } from "zod";
import { formatMoney } from "@/lib/format";
import { addDecimals, InvalidDecimalError, toMinorUnits, type Decimal } from "@/lib/money";
import { PROVIDER_NAMES } from "@/lib/providers";
import type { Achievement } from "../achievements";
import { AuthRevokedError, fetchJson, InvalidResponseError, PermissionMissingError, readOAuthErrorCode } from "../errors";
import { titleWithAmount, type ActivityEvent, type EventSeverity, type EventType } from "../events";
import type { AdapterMetric } from "../metrics";
import {
  Secret,
  type ExternalAccount,
  type FetchLike,
  type OAuthContext,
  type OAuthCredential,
  type ProviderAdapter,
  type SyncInput,
  type SyncResult,
} from "../types";
import {
  AccountResponseSchema,
  ActionsSchema,
  AppsSchema,
  BalanceSchema,
  DeploymentsSchema,
  DropletsSchema,
  InsightsSchema,
  InvoiceItemsSchema,
  InvoicesSchema,
  TokenResponseSchema,
  type Action,
  type App,
  type Balance,
  type Deployment,
  type Invoice,
  type InsightsDataPoint,
  type PageLinks,
  type TokenResponse,
} from "./schemas";

/**
 * DigitalOcean adapter (adapter pattern over the DigitalOcean API), per
 * docs/providers/digitalocean.md and issue #116.
 *
 * OAuth authorization code flow as a confidential client, with PKCE (S256), which DigitalOcean
 * accepts from confidential clients "for additional protection". One grant is one team. Sync reads
 * GET routes only: the balance, invoices and their line items, and Billing Insights for spend;
 * the action history (Droplet names from the Droplet list) and App Platform deployments for the
 * timeline. Nothing here has been run against a real DigitalOcean account yet (#141): every claim
 * the page marks unverified stays a claim until it has.
 */

const API_ORIGIN = "https://api.digitalocean.com";
const OAUTH_ORIGIN = "https://cloud.digitalocean.com";
const AUTHORIZE_URL = `${OAUTH_ORIGIN}/v1/oauth/authorize`;
const TOKEN_URL = `${OAUTH_ORIGIN}/v1/oauth/token`;
const REVOKE_URL = `${OAUTH_ORIGIN}/v1/oauth/revoke`;

/** The read-only scopes #116 lists, requested explicitly so the consent screen offers nothing else. */
export const SCOPES = ["billing:read", "actions:read", "app:read", "droplet:read", "account:read"] as const;

// `api:read` "is equivalent to all read scopes"; `read` is the legacy read-only scope the OAuth
// documentation's token example returns. Either one covers every scope above (page, Unverified).
const READ_ALIAS_SCOPES = ["api:read", "read"] as const;

const CURRENCY = "USD";
// DigitalOcean's maximum page size.
const PAGE_SIZE = 200;
// Bounded sync: at most this many pages of any one list per run (1,000 items at 200 a page).
export const MAX_PAGES = 5;
// A first sync emits only the latest invoice; a later one at most this many new ones.
export const MAX_NEW_INVOICES = 3;
// Daily SKU metrics per sync, largest first; the rest are logged as skipped.
export const MAX_SKU_METRICS = 50;
// Apps whose deployments are read in one sync, most recently deployed first.
export const MAX_APPS_WITH_DEPLOYMENTS = 25;
const DEPLOYMENTS_PAGE_SIZE = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_SYNC_LOOKBACK_MS = 7 * DAY_MS;
// Re-read an hour before the cursor so an action or deployment still running at the last poll is
// seen again once it finishes. Dedupe keys make the re-read idempotent.
const OVERLAP_MS = 60 * 60 * 1000;
// Billing Insights are built from nightly invoice items, so the latest whole day can lag; three
// days back always holds the latest one published.
const INSIGHTS_LOOKBACK_DAYS = 3;
const NAME_MAX = 100;
const SKU_LABEL_MAX = 90;
const INVOICE_PRODUCTS_SHOWN = 5;

export const MONTH_TO_DATE_METRIC_KEY = "digitalocean.spend.month_to_date";
export const CREDIT_BALANCE_METRIC_KEY = "digitalocean.credit.balance";
export const LATEST_INVOICE_METRIC_KEY = "digitalocean.invoice.latest";
const SKU_METRIC_PREFIX = "digitalocean.daily_spend.sku_";

export const INSIGHTS_PRICING_SOURCE =
  "DigitalOcean Billing Insights estimates from nightly invoice items (https://docs.digitalocean.com/platform/billing/insights/, checked 2026-11-05)";

const ENDPOINTS = {
  balance: `${API_ORIGIN}/v2/customers/my/balance`,
  invoices: `${API_ORIGIN}/v2/customers/my/invoices`,
  insights: `${API_ORIGIN}/v2/billing/{account_urn}/insights/{start_date}/{end_date}`,
} as const;

// Exported, like the metric and event builders below, for the local simulator (#131).
export const eventTypes = [
  {
    id: "digitalocean.deployment.started",
    label: "App deployment started",
    description: "An App Platform deployment started building.",
    shownByDefault: true,
    emoji: "🏗️",
  },
  {
    id: "digitalocean.deployment.succeeded",
    label: "App deployment succeeded",
    description: "An App Platform deployment finished and went live.",
    shownByDefault: true,
    category: "deploy_succeeded",
    emoji: "🚀",
  },
  {
    id: "digitalocean.deployment.failed",
    label: "App deployment failed",
    description: "An App Platform deployment failed to build or deploy.",
    shownByDefault: true,
    category: "deploy_failed",
    emoji: "💥",
  },
  {
    id: "digitalocean.droplet.created",
    label: "Droplet created",
    description: "A Droplet was created in the team.",
    shownByDefault: true,
    emoji: "💧",
  },
  {
    id: "digitalocean.droplet.resized",
    label: "Droplet resized",
    description: "A Droplet moved to a different size, which changes what it costs.",
    shownByDefault: true,
    emoji: "📏",
  },
  {
    id: "digitalocean.droplet.power_cycled",
    label: "Droplet power cycled",
    description: "A Droplet was switched off and on again.",
    shownByDefault: true,
    emoji: "🔌",
  },
  {
    id: "digitalocean.droplet.destroyed",
    label: "Droplet deleted",
    description: "A Droplet was deleted from the team.",
    shownByDefault: true,
    emoji: "🗑️",
  },
  {
    id: "digitalocean.droplet.action_failed",
    label: "Droplet action failed",
    description: "Creating, resizing, power cycling, or deleting a Droplet failed.",
    shownByDefault: true,
    emoji: "⚠️",
  },
  {
    id: "digitalocean.invoice.issued",
    label: "Invoice issued",
    description: "DigitalOcean issued the invoice for a billing month.",
    shownByDefault: true,
    emoji: "🧾",
  },
] as const satisfies readonly EventType[];

// Achievements (#413). The deployment ladder is shared with Vercel, Railway, and GitLab: keep the ids,
// thresholds, and wording in step with theirs (docs/adapters.md, "Achievements").
// The droplet ones are DigitalOcean's own.
const achievements: readonly Achievement[] = [
  {
    id: "digitalocean.deployments.first",
    title: "First DigitalOcean deployment recorded",
    publicTitle: "First DigitalOcean deployment recorded",
    description: "Earned when StackDash records the first successful DigitalOcean deployment.",
    rule: { kind: "event_count", typeIds: ["digitalocean.deployment.succeeded"], count: 1 },
  },
  {
    id: "digitalocean.deployments.10",
    title: "10 DigitalOcean deployments recorded",
    publicTitle: "10 DigitalOcean deployments recorded",
    description: "Earned when StackDash records the 10th successful DigitalOcean deployment.",
    rule: { kind: "event_count", typeIds: ["digitalocean.deployment.succeeded"], count: 10 },
  },
  {
    id: "digitalocean.deployments.100",
    title: "100 DigitalOcean deployments recorded",
    publicTitle: "100 DigitalOcean deployments recorded",
    description: "Earned when StackDash records the 100th successful DigitalOcean deployment.",
    rule: { kind: "event_count", typeIds: ["digitalocean.deployment.succeeded"], count: 100 },
  },
  {
    id: "digitalocean.deployments.streak_10",
    title: "10 DigitalOcean deployments in a row",
    publicTitle: "10 DigitalOcean deployments in a row",
    description: "Earned when StackDash records 10 successful DigitalOcean deployments in a row, with no failed deployment between them.",
    rule: { kind: "event_streak", successTypeIds: ["digitalocean.deployment.succeeded"], failureTypeIds: ["digitalocean.deployment.failed"], count: 10 },
  },
  {
    id: "digitalocean.deployments.night_owl",
    title: "Night owl: a DigitalOcean deployment between midnight and 5 am",
    publicTitle: "Night owl: a DigitalOcean deployment between midnight and 5 am",
    description: "Earned when StackDash records a successful DigitalOcean deployment between midnight and 5 am London time.",
    rule: { kind: "event_at_local_time", typeIds: ["digitalocean.deployment.succeeded"], fromHour: 0, toHour: 5 },
  },
  {
    id: "digitalocean.deployments.friday_ship",
    title: "Shipped on a Friday afternoon",
    publicTitle: "Shipped on a Friday afternoon",
    description: "Earned when StackDash records a successful DigitalOcean deployment on a Friday between 4 pm and midnight London time.",
    rule: { kind: "event_at_local_time", typeIds: ["digitalocean.deployment.succeeded"], fromHour: 16, toHour: 24, weekdays: ["friday"] },
  },
  {
    id: "digitalocean.deployments.busy_day",
    title: "Busy day: 10 DigitalOcean deployments in one day",
    publicTitle: "Busy day: 10 DigitalOcean deployments in one day",
    description: "Earned when StackDash records 10 successful DigitalOcean deployments on one London calendar day.",
    rule: { kind: "events_in_window", typeIds: ["digitalocean.deployment.succeeded"], count: 10, window: "day" },
  },
  {
    id: "digitalocean.deployments.weekly_rhythm",
    title: "Weekly rhythm: a DigitalOcean deployment on 7 days in a row",
    publicTitle: "Weekly rhythm: a DigitalOcean deployment on 7 days in a row",
    description: "Earned when StackDash records a successful DigitalOcean deployment on each of 7 consecutive London calendar days.",
    rule: { kind: "consecutive_days", typeIds: ["digitalocean.deployment.succeeded"], days: 7 },
  },
  {
    id: "digitalocean.droplets.first",
    title: "First droplet created",
    publicTitle: "First droplet created",
    description: "Earned when StackDash records the first new DigitalOcean droplet.",
    rule: { kind: "event_count", typeIds: ["digitalocean.droplet.created"], count: 1 },
  },
  {
    id: "digitalocean.droplets.fleet",
    title: "Fleet commander: 10 droplets created",
    publicTitle: "Fleet commander: 10 droplets created",
    description: "Earned when StackDash records the 10th new DigitalOcean droplet.",
    rule: { kind: "event_count", typeIds: ["digitalocean.droplet.created"], count: 10 },
  },
];

type EventTypeId = (typeof eventTypes)[number]["id"];

export const dropletActionTypes = ["create", "resize", "power_cycle", "destroy"] as const;
type DropletActionType = (typeof dropletActionTypes)[number];

const DROPLET_ACTIONS: Readonly<
  Record<DropletActionType, { typeId: EventTypeId; done: string; noun: string; severity: EventSeverity }>
> = {
  create: { typeId: "digitalocean.droplet.created", done: "created", noun: "creation", severity: "success" },
  resize: { typeId: "digitalocean.droplet.resized", done: "resized", noun: "resize", severity: "info" },
  power_cycle: { typeId: "digitalocean.droplet.power_cycled", done: "power cycled", noun: "power cycle", severity: "warning" },
  destroy: { typeId: "digitalocean.droplet.destroyed", done: "deleted", noun: "deletion", severity: "warning" },
};

function isDropletActionType(type: string): type is DropletActionType {
  return (dropletActionTypes as readonly string[]).includes(type);
}

/**
 * Opaque to the sync runner. `actions` and `deployments` are the latest `started_at` and
 * `created_at` seen, in Unix milliseconds; `invoice` is the latest invoice month seen.
 */
const CursorSchema = z.strictObject({
  v: z.literal(1),
  actions: z.int().nonnegative().optional(),
  deployments: z.int().nonnegative().optional(),
  invoice: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(),
});
type Cursor = z.infer<typeof CursorSchema>;

// Team ids are UUIDs in the OAuth documentation and 40 hex characters in the account example; both
// fit here, and nothing else reaches a URL path.
const TEAM_ID = /^[A-Za-z0-9-]{1,64}$/;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function nextMonthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/** The first instant of a `YYYY-MM` billing month, in UTC. */
function periodStart(period: string): Date {
  return new Date(`${period}-01T00:00:00Z`);
}

function minorUnits(value: Decimal, endpoint: string): number {
  try {
    return toMinorUnits(value, CURRENCY);
  } catch (error) {
    if (error instanceof InvalidDecimalError) {
      throw new InvalidResponseError(`${endpoint} returned an amount outside the storable range`, {
        cause: error,
        endpoint,
      });
    }
    throw error;
  }
}

function readTeamUuid(credential: OAuthCredential): string {
  const team = credential.metadata?.["teamUuid"];
  if (team === undefined || !TEAM_ID.test(team)) {
    // Only a reconnection rebuilds the metadata, so the runner should ask for one.
    throw new AuthRevokedError("DigitalOcean credential is missing its team; reconnect DigitalOcean");
  }
  return team;
}

function apiUrl(path: string, query: Readonly<Record<string, string>> = {}): URL {
  const url = new URL(path, API_ORIGIN);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}

function apiGet<T>(ctx: OAuthContext, credential: OAuthCredential, url: URL, schema: z.ZodType<T>): Promise<T> {
  const headers = { Authorization: `Bearer ${credential.accessToken.reveal()}`, Accept: "application/json" };
  return fetchJson(ctx, url, { method: "GET", headers }, schema);
}

function parseScopes(scope: string | undefined, fallback: readonly string[]): readonly string[] {
  // RFC 6749 section 5.1: an omitted scope means the requested (or previously granted) scope.
  if (scope === undefined) return fallback;
  return scope.split(" ").filter((value) => value.length > 0);
}

/**
 * Token endpoint call. The documentation's code exchange example puts every parameter in the query
 * string; they go in a form body here (RFC 6749 section 4.1.3), which the documented refresh
 * example also uses, so the client secret never sits in a URL (page, Unverified; decided on #116).
 *
 * DigitalOcean documents three token errors (OAuth troubleshooting page). Only `invalid_grant`
 * (a code or refresh token that is used, expired, or revoked) means the grant is gone, so only it
 * becomes auth revoked and asks the user to reconnect. `invalid_client` (wrong client id or secret)
 * and `invalid_request` (malformed request) are this instance's configuration, not the user's
 * grant: they stay invalid responses, retried and logged, even when `invalid_client` comes as a
 * 401 (RFC 6749 section 5.2), which `fetchJson` alone would call auth revoked.
 */
async function requestTokens(ctx: OAuthContext, form: Readonly<Record<string, string>>): Promise<TokenResponse> {
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
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: new URLSearchParams(form).toString(),
      },
      TokenResponseSchema,
    );
  } catch (error) {
    if (error instanceof InvalidResponseError && error.status === 400 && oauthError === "invalid_grant") {
      throw new AuthRevokedError("DigitalOcean rejected the authorization grant (invalid_grant); reconnect DigitalOcean", {
        cause: error,
        status: 400,
        endpoint: TOKEN_URL,
      });
    }
    if (error instanceof AuthRevokedError && error.status === 401 && oauthError === "invalid_client") {
      throw new InvalidResponseError("DigitalOcean rejected this instance's OAuth client credentials (invalid_client)", {
        cause: error,
        status: 401,
        endpoint: TOKEN_URL,
      });
    }
    throw error;
  }
}

function toCredential(
  tokens: TokenResponse,
  now: Date,
  teamUuid: string,
  fallbackScopes: readonly string[],
): OAuthCredential {
  if (tokens.token_type.toLowerCase() !== "bearer") {
    throw new InvalidResponseError("DigitalOcean returned a token type other than bearer", { endpoint: TOKEN_URL });
  }
  // Access and refresh token travel together: the refresh token is single use and refreshing
  // invalidates the access token it was issued with, so the pair is only ever stored as one.
  return {
    accessToken: new Secret(tokens.access_token),
    refreshToken: new Secret(tokens.refresh_token),
    // 2,592,000 seconds (30 days) for confidential clients per the docs; taken from the response.
    expiresAt: new Date(now.getTime() + tokens.expires_in * 1000),
    scopes: parseScopes(tokens.scope, fallbackScopes),
    tokenType: "bearer",
    metadata: { teamUuid },
  };
}

async function readAccountTeam(
  ctx: OAuthContext,
  credential: OAuthCredential,
): Promise<{ uuid: string; name: string } | undefined> {
  const body = await apiGet(ctx, credential, apiUrl("/v2/account"), AccountResponseSchema);
  return body.account.team;
}

function permissionGap(error: unknown, scope: (typeof SCOPES)[number], message: string): PermissionMissingError | undefined {
  if (!(error instanceof PermissionMissingError)) return undefined;
  return new PermissionMissingError(message, [scope], {
    cause: error,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.endpoint === undefined ? {} : { endpoint: error.endpoint }),
  });
}

/** Runs one read; a 403 becomes a partial error so the rest of the sync continues. */
async function readOrGap<T>(
  read: () => Promise<T>,
  gaps: PermissionMissingError[],
  scope: (typeof SCOPES)[number],
  message: string,
): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    const gap = permissionGap(error, scope, message);
    if (gap === undefined) throw error;
    gaps.push(gap);
    return undefined;
  }
}

/** Reads up to MAX_PAGES pages of a list, following `links.pages.next` by page number. */
async function readPages<T extends { links?: PageLinks }>(
  ctx: OAuthContext,
  credential: OAuthCredential,
  path: string,
  schema: z.ZodType<T>,
  perPage: number,
  shouldStop: (page: T) => boolean = () => false,
): Promise<{ pages: T[]; complete: boolean }> {
  const pages: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await apiGet(ctx, credential, apiUrl(path, { page: String(page), per_page: String(perPage) }), schema);
    pages.push(body);
    if (body.links?.pages?.next === undefined || shouldStop(body)) return { pages, complete: true };
  }
  return { pages, complete: false };
}

/* Spend --------------------------------------------------------------------------------------- */

/**
 * Month-to-date usage (verified: DigitalOcean's own figure, final once invoiced) and the account
 * balance as a credit. `month_to_date_balance` is documented as `account_balance` plus
 * `month_to_date_usage`, so a positive `account_balance` is owed and a credit is negative; the
 * credit metric is its negation (page, Unverified).
 */
export function balanceMetrics(balance: Balance, externalAccountId: string, retrievedAt: Date): AdapterMetric[] {
  const endpoint = ENDPOINTS.balance;
  const usageMinor = minorUnits(balance.month_to_date_usage, endpoint);
  if (usageMinor < 0) {
    throw new InvalidResponseError(`${endpoint} returned negative month-to-date usage`, { endpoint });
  }
  // The billing month of the reading. Right after midnight on the 1st the balance can still be last
  // month's, which then ends before this sync and so never counts as this month's spend.
  const start = new Date(Date.UTC(balance.generated_at.getUTCFullYear(), balance.generated_at.getUTCMonth(), 1));
  const tomorrow = new Date(startOfUtcDay(retrievedAt.getTime()) + DAY_MS);
  const monthEnd = nextMonthStart(balance.generated_at);
  const provenance = { source: "provider_api", endpoint } as const;
  return [
    {
      kind: "verified_spend",
      metricKey: MONTH_TO_DATE_METRIC_KEY,
      label: "DigitalOcean usage, month to date",
      amountMinor: usageMinor,
      currency: CURRENCY,
      timeframe: { type: "period", start, end: tomorrow < monthEnd ? tomorrow : monthEnd },
      externalAccountId,
      retrievedAt,
      provenance,
    },
    {
      kind: "credit_balance",
      metricKey: CREDIT_BALANCE_METRIC_KEY,
      label: "DigitalOcean account credit",
      amountMinor: minorUnits(
        { coefficient: -balance.account_balance.coefficient, scale: balance.account_balance.scale },
        endpoint,
      ),
      currency: CURRENCY,
      timeframe: { type: "point", at: balance.generated_at },
      externalAccountId,
      retrievedAt,
      provenance,
    },
  ];
}

/** The latest issued invoice's total, for its billing month. Verified: it is the billed amount. */
export function invoiceMetric(invoice: Invoice, externalAccountId: string, retrievedAt: Date): AdapterMetric | undefined {
  const amountMinor = minorUnits(invoice.amount, ENDPOINTS.invoices);
  // Credits can exceed charges; spend metrics cannot be negative, so such an invoice has no metric.
  if (amountMinor < 0) return undefined;
  const start = periodStart(invoice.invoice_period);
  return {
    kind: "verified_spend",
    metricKey: LATEST_INVOICE_METRIC_KEY,
    label: "DigitalOcean last invoice total",
    amountMinor,
    currency: CURRENCY,
    timeframe: { type: "period", start, end: nextMonthStart(start) },
    externalAccountId,
    retrievedAt,
    provenance: { source: "provider_api", endpoint: ENDPOINTS.invoices },
  };
}

/** Line item amounts summed per product, exactly; rounded once per product when shown. */
export function productTotals(items: readonly { product: string; amount: Decimal }[]): Map<string, Decimal> {
  const byProduct = new Map<string, Decimal[]>();
  for (const item of items) {
    const amounts = byProduct.get(item.product) ?? [];
    amounts.push(item.amount);
    byProduct.set(item.product, amounts);
  }
  return new Map([...byProduct.entries()].map(([product, amounts]) => [product, addDecimals(amounts)] as const));
}

/**
 * "Invoice for 2026-10 issued: $42.10", dated the 1st of the following month, when DigitalOcean
 * generates invoices. The body names the largest products from the line items.
 */
export function invoiceEvent(
  invoice: Invoice,
  products: ReadonlyMap<string, Decimal>,
  externalAccountId: string,
): ActivityEvent {
  const endpoint = ENDPOINTS.invoices;
  const ranked = [...products.entries()]
    .map(([product, amount]) => ({ product, amountMinor: minorUnits(amount, endpoint) }))
    .sort((a, b) => b.amountMinor - a.amountMinor || a.product.localeCompare(b.product));
  const shown = ranked
    .slice(0, INVOICE_PRODUCTS_SHOWN)
    .map(({ product, amountMinor }) => `${clip(product, NAME_MAX)} ${formatMoney(amountMinor, CURRENCY)}`);
  const more = ranked.length - shown.length;
  const event: ActivityEvent = {
    typeId: "digitalocean.invoice.issued",
    occurredAt: nextMonthStart(periodStart(invoice.invoice_period)),
    severity: "info",
    title: titleWithAmount(`Invoice for ${invoice.invoice_period} issued`, minorUnits(invoice.amount, endpoint), CURRENCY),
    externalAccountId,
    dedupeKey: `invoice:${invoice.invoice_uuid}`,
  };
  if (shown.length > 0) {
    event.body = `${shown.join(", ")}${more > 0 ? `, and ${more} more ${more === 1 ? "product" : "products"}` : ""}.`;
  }
  return event;
}

function skuMetricKey(sku: string): string | undefined {
  const normalized = sku
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (normalized.length === 0) return undefined;
  return `${SKU_METRIC_PREFIX}${normalized}`.slice(0, 100).replace(/_+$/, "");
}

/**
 * One estimated spend metric per SKU for one UTC day of Billing Insights, largest first and capped
 * at MAX_SKU_METRICS. Estimated, because DigitalOcean says these figures are estimates until the
 * invoice is final (decided on #116). A SKU whose day nets below zero (a credit) has no metric.
 * `totals` holds the exact sum per SKU for that day.
 */
export function skuSpendMetrics(
  totals: ReadonlyMap<string, Decimal>,
  day: Date,
  externalAccountId: string,
  retrievedAt: Date,
): AdapterMetric[] {
  const endpoint = ENDPOINTS.insights;
  const byKey = new Map<string, { sku: string; amounts: Decimal[] }>();
  for (const [sku, amount] of totals) {
    const key = skuMetricKey(sku);
    if (key === undefined) continue;
    const entry = byKey.get(key) ?? { sku, amounts: [] };
    entry.amounts.push(amount);
    byKey.set(key, entry);
  }
  const start = new Date(startOfUtcDay(day.getTime()));
  return [...byKey.entries()]
    .map(([metricKey, { sku, amounts }]) => ({ metricKey, sku, amountMinor: minorUnits(addDecimals(amounts), endpoint) }))
    .filter(({ amountMinor }) => amountMinor >= 0)
    .sort((a, b) => b.amountMinor - a.amountMinor || a.metricKey.localeCompare(b.metricKey))
    .slice(0, MAX_SKU_METRICS)
    .map(({ metricKey, sku, amountMinor }) => ({
      kind: "estimated_spend",
      metricKey,
      label: `Daily spend on SKU ${clip(sku, SKU_LABEL_MAX)}`,
      amountMinor,
      currency: CURRENCY,
      timeframe: { type: "period", start, end: new Date(start.getTime() + DAY_MS) },
      externalAccountId,
      retrievedAt,
      provenance: { source: "derived", endpoint, pricingSource: INSIGHTS_PRICING_SOURCE },
    }));
}

/** The latest day present in the data points and that day's exact total per SKU. */
function latestDayTotals(points: readonly InsightsDataPoint[]): { day: Date; totals: Map<string, Decimal> } | undefined {
  let latest: number | undefined;
  for (const point of points) {
    const at = Date.parse(`${point.start_date}T00:00:00Z`);
    if (latest === undefined || at > latest) latest = at;
  }
  if (latest === undefined) return undefined;
  const day = latest;
  const amounts = new Map<string, Decimal[]>();
  for (const point of points) {
    if (Date.parse(`${point.start_date}T00:00:00Z`) !== day) continue;
    const list = amounts.get(point.sku) ?? [];
    list.push(point.total_amount);
    amounts.set(point.sku, list);
  }
  return { day: new Date(day), totals: new Map([...amounts].map(([sku, list]) => [sku, addDecimals(list)] as const)) };
}

async function syncInsights(
  ctx: OAuthContext,
  credential: OAuthCredential,
  teamUuid: string,
  externalAccountId: string,
  now: Date,
): Promise<AdapterMetric[]> {
  const urn = `do:team:${teamUuid}`;
  const end = startOfUtcDay(now.getTime()) - DAY_MS;
  const start = end - (INSIGHTS_LOOKBACK_DAYS - 1) * DAY_MS;
  // The URN's colons stay literal, as in the documentation's example; the team id was checked
  // against TEAM_ID, so nothing else can reach the path.
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const path = `/v2/billing/${urn}/insights/${day(start)}/${day(end)}`;
  const points: InsightsDataPoint[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await apiGet(
      ctx,
      credential,
      apiUrl(path, { page: String(page), per_page: String(PAGE_SIZE) }),
      InsightsSchema,
    );
    points.push(...body.data_points);
    if (body.current_page >= body.total_pages || body.data_points.length === 0) break;
    if (page === MAX_PAGES) ctx.logger.warn("digitalocean.insights.page_cap_reached", { pages: MAX_PAGES });
  }
  const own = points.filter((point) => point.usage_team_urn === urn);
  if (own.length < points.length) {
    ctx.logger.warn("digitalocean.insights.other_team_points_skipped", { count: points.length - own.length });
  }
  const latest = latestDayTotals(own);
  if (latest === undefined) return [];
  const metrics = skuSpendMetrics(latest.totals, latest.day, externalAccountId, now);
  if (metrics.length < latest.totals.size) {
    ctx.logger.warn("digitalocean.insights.skus_skipped", {
      skus: latest.totals.size,
      kept: metrics.length,
      maxSkus: MAX_SKU_METRICS,
    });
  }
  return metrics;
}

async function invoiceProducts(
  ctx: OAuthContext,
  credential: OAuthCredential,
  invoice: Invoice,
): Promise<Map<string, Decimal>> {
  const { pages, complete } = await readPages(
    ctx,
    credential,
    `/v2/customers/my/invoices/${encodeURIComponent(invoice.invoice_uuid)}`,
    InvoiceItemsSchema,
    PAGE_SIZE,
  );
  if (!complete) ctx.logger.warn("digitalocean.invoice.items_page_cap_reached", { pages: MAX_PAGES });
  return productTotals(pages.flatMap((page) => page.invoice_items));
}

async function syncInvoices(
  ctx: OAuthContext,
  credential: OAuthCredential,
  externalAccountId: string,
  previous: string | undefined,
  now: Date,
): Promise<{ metrics: AdapterMetric[]; events: ActivityEvent[]; latest: string | undefined }> {
  // Order is undocumented, so the first page is sorted here rather than trusted (page, Unverified).
  const body = await apiGet(
    ctx,
    credential,
    apiUrl("/v2/customers/my/invoices", { page: "1", per_page: "20" }),
    InvoicesSchema,
  );
  const invoices = [...(body.invoices ?? [])].sort(
    (a, b) => periodStart(b.invoice_period).getTime() - periodStart(a.invoice_period).getTime(),
  );
  const newest = invoices[0];
  if (newest === undefined) return { metrics: [], events: [], latest: previous };

  const metric = invoiceMetric(newest, externalAccountId, now);
  // The first sync announces only the latest invoice instead of replaying the whole history. A later
  // one announces the newest MAX_NEW_INVOICES unannounced invoices; the cursor then moves past any
  // older ones, so they are logged rather than silently never announced.
  let fresh = [newest];
  if (previous !== undefined) {
    const unannounced = invoices.filter((invoice) => periodStart(invoice.invoice_period) > periodStart(previous));
    fresh = unannounced.slice(0, MAX_NEW_INVOICES);
    if (fresh.length < unannounced.length) {
      ctx.logger.warn("digitalocean.invoices.new_cap_reached", {
        skipped: unannounced.length - fresh.length,
        maxNewInvoices: MAX_NEW_INVOICES,
      });
    }
  }
  const events: ActivityEvent[] = [];
  for (const invoice of fresh) {
    events.push(invoiceEvent(invoice, await invoiceProducts(ctx, credential, invoice), externalAccountId));
  }
  const latest =
    previous !== undefined && periodStart(previous) > periodStart(newest.invoice_period) ? previous : newest.invoice_period;
  return { metrics: metric === undefined ? [] : [metric], events, latest };
}

/* Droplet actions ----------------------------------------------------------------------------- */

/** Finished create, resize, power cycle, and destroy actions on Droplets; anything else is none. */
export function dropletActionEvent(
  action: Action,
  dropletName: string | undefined,
  externalAccountId: string,
): ActivityEvent | undefined {
  if (action.resource_type !== "droplet" || !isDropletActionType(action.type)) return undefined;
  if (action.status === "in-progress") return undefined;
  const spec = DROPLET_ACTIONS[action.type];
  const name =
    dropletName !== undefined && dropletName.trim().length > 0
      ? clip(dropletName, NAME_MAX)
      : action.resource_id === null || action.resource_id === undefined
        ? "unknown"
        : String(action.resource_id);
  const failed = action.status === "errored";
  const event: ActivityEvent = {
    typeId: failed ? "digitalocean.droplet.action_failed" : spec.typeId,
    occurredAt: action.completed_at ?? action.started_at,
    severity: failed ? "critical" : spec.severity,
    title: failed ? `Droplet ${name} ${spec.noun} failed` : `Droplet ${name} ${spec.done}`,
    externalAccountId,
    // Stable across re-polls: one event per action and final status.
    dedupeKey: `action:${action.id}:${action.status}`,
  };
  const region = action.region_slug?.trim();
  if (region !== undefined && region.length > 0) event.body = `Region ${clip(region, 32)}.`;
  return event;
}

async function dropletNames(
  ctx: OAuthContext,
  credential: OAuthCredential,
): Promise<Map<number, string>> {
  const { pages, complete } = await readPages(ctx, credential, "/v2/droplets", DropletsSchema, PAGE_SIZE);
  if (!complete) ctx.logger.warn("digitalocean.droplets.page_cap_reached", { pages: MAX_PAGES });
  return new Map(pages.flatMap((page) => page.droplets.map((droplet) => [droplet.id, droplet.name] as const)));
}

async function syncDropletActions(
  ctx: OAuthContext,
  credential: OAuthCredential,
  externalAccountId: string,
  previous: number | undefined,
  gaps: PermissionMissingError[],
): Promise<{ events: ActivityEvent[]; latest: number | undefined }> {
  const since = previous === undefined ? ctx.now().getTime() - FIRST_SYNC_LOOKBACK_MS : previous - OVERLAP_MS;
  // Read newest first until a page reaches back past `since`. That the list is newest first is
  // undocumented (page, Unverified).
  const { pages, complete } = await readPages(ctx, credential, "/v2/actions", ActionsSchema, PAGE_SIZE, (page) =>
    page.actions.some((action) => action.started_at.getTime() < since),
  );
  if (!complete) ctx.logger.warn("digitalocean.actions.page_cap_reached", { pages: MAX_PAGES });

  let latest = previous;
  const recent: Action[] = [];
  for (const action of pages.flatMap((page) => page.actions)) {
    const started = action.started_at.getTime();
    latest = Math.max(latest ?? started, started);
    if (started >= since && action.resource_type === "droplet" && isDropletActionType(action.type)) {
      recent.push(action);
    }
  }
  const finished = recent.filter((action) => action.status !== "in-progress");
  if (finished.length === 0) return { events: [], latest };

  // Names make the timeline readable; without droplet:read the events keep the Droplet id instead.
  const names =
    (await readOrGap(
      () => dropletNames(ctx, credential),
      gaps,
      "droplet:read",
      "DigitalOcean refused to list Droplets, so Droplet events show ids instead of names.",
    )) ?? new Map<number, string>();
  const events = new Map<string, ActivityEvent>();
  for (const action of finished) {
    const event = dropletActionEvent(
      action,
      action.resource_id === null || action.resource_id === undefined ? undefined : names.get(action.resource_id),
      externalAccountId,
    );
    if (event !== undefined) events.set(event.dedupeKey, event);
  }
  return { events: [...events.values()], latest };
}

/* App Platform deployments -------------------------------------------------------------------- */

function finishedAt(deployment: Deployment): Date {
  const phaseAt = deployment.phase_last_updated_at;
  // The zero time (`0001-01-01T00:00:00Z`) means "not set" in the documentation's example.
  if (phaseAt !== undefined && phaseAt.getTime() >= deployment.created_at.getTime()) return phaseAt;
  return deployment.updated_at ?? deployment.created_at;
}

function succeeded(deployment: Deployment): boolean {
  if (deployment.phase === "ACTIVE") return true;
  if (deployment.phase !== "SUPERSEDED") return false;
  // A newer deployment replaced this one. It only went live if every step succeeded; one that
  // was superseded while still pending never did (page, Unverified).
  const progress = deployment.progress;
  if (progress?.total_steps === undefined || progress.total_steps === 0) return false;
  return progress.success_steps === progress.total_steps && (progress.error_steps ?? 0) === 0;
}

/**
 * A started event for every deployment, plus a succeeded or failed one once it finished. Canceled
 * and still running deployments have only the started event. The cause (commit message, author)
 * is never read.
 */
export function deploymentEvents(deployment: Deployment, appName: string, externalAccountId: string): ActivityEvent[] {
  const app = clip(appName, NAME_MAX);
  const events: ActivityEvent[] = [
    {
      typeId: "digitalocean.deployment.started",
      occurredAt: deployment.created_at,
      severity: "info",
      title: `Deployment of ${app} started`,
      externalAccountId,
      dedupeKey: `deployment:${deployment.id}:started`,
    },
  ];
  if (succeeded(deployment)) {
    events.push({
      typeId: "digitalocean.deployment.succeeded",
      occurredAt: finishedAt(deployment),
      severity: "success",
      title: `Deployment of ${app} succeeded`,
      externalAccountId,
      dedupeKey: `deployment:${deployment.id}:succeeded`,
    });
  } else if (deployment.phase === "ERROR") {
    events.push({
      typeId: "digitalocean.deployment.failed",
      occurredAt: finishedAt(deployment),
      severity: "critical",
      title: `Deployment of ${app} failed`,
      externalAccountId,
      dedupeKey: `deployment:${deployment.id}:failed`,
    });
  }
  return events;
}

async function syncDeployments(
  ctx: OAuthContext,
  credential: OAuthCredential,
  externalAccountId: string,
  previous: number | undefined,
): Promise<{ events: ActivityEvent[]; latest: number | undefined }> {
  const since = previous === undefined ? ctx.now().getTime() - FIRST_SYNC_LOOKBACK_MS : previous - OVERLAP_MS;
  const { pages, complete } = await readPages(ctx, credential, "/v2/apps", AppsSchema, PAGE_SIZE);
  if (!complete) ctx.logger.warn("digitalocean.apps.page_cap_reached", { pages: MAX_PAGES });

  // Only apps that deployed since the window opened; an app without the field is read to be safe.
  const deployedAt = (app: App) => app.last_deployment_created_at?.getTime() ?? Number.POSITIVE_INFINITY;
  const candidates = pages
    .flatMap((page) => page.apps ?? [])
    .filter((app) => deployedAt(app) >= since)
    .sort((a, b) => deployedAt(b) - deployedAt(a));
  if (candidates.length > MAX_APPS_WITH_DEPLOYMENTS) {
    ctx.logger.warn("digitalocean.apps.deployment_cap_reached", {
      apps: candidates.length,
      maxApps: MAX_APPS_WITH_DEPLOYMENTS,
    });
  }

  let latest = previous;
  const events = new Map<string, ActivityEvent>();
  for (const app of candidates.slice(0, MAX_APPS_WITH_DEPLOYMENTS)) {
    const body = await apiGet(
      ctx,
      credential,
      apiUrl(`/v2/apps/${encodeURIComponent(app.id)}/deployments`, { page: "1", per_page: String(DEPLOYMENTS_PAGE_SIZE) }),
      DeploymentsSchema,
    );
    for (const deployment of body.deployments ?? []) {
      const created = deployment.created_at.getTime();
      latest = Math.max(latest ?? created, created);
      if (created < since) continue;
      for (const event of deploymentEvents(deployment, app.spec.name, externalAccountId)) {
        events.set(event.dedupeKey, event);
      }
    }
  }
  return { events: [...events.values()], latest };
}

/* Adapter ------------------------------------------------------------------------------------- */

function readCursor(raw: string | undefined, ctx: OAuthContext): Cursor | undefined {
  if (raw === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    json = undefined;
  }
  const parsed = CursorSchema.safeParse(json);
  if (parsed.success) return parsed.data;
  // Our own value came back unreadable: start over with the first sync's window rather than fail
  // every future sync on it.
  ctx.logger.warn("digitalocean.sync.cursor_unreadable", { provider: "digitalocean" });
  return undefined;
}

const BILLING_REFUSED =
  "DigitalOcean refused billing data. It needs the billing:read permission and a team role that can see billing";

export const digitaloceanAdapter: ProviderAdapter = {
  id: "digitalocean",
  displayName: PROVIDER_NAMES.digitalocean,
  capabilities: {
    oauth: true,
    polling: true,
    usage: false,
    spending: true,
    allowance: false,
    credits: true,
    revenue: false,
    events: true,
  },
  permissions: [
    {
      scope: "billing:read",
      access: "read",
      description:
        "Your team's balance, month-to-date usage, invoices with line items, and daily spend. Also allows downloading invoice PDF and CSV files, which show the billing address; StackDash never downloads them.",
    },
    {
      scope: "actions:read",
      access: "read",
      description:
        "The team's action history for every resource type. StackDash reads only Droplet creates, resizes, power cycles, and deletes.",
    },
    {
      scope: "app:read",
      access: "read",
      description:
        "App Platform apps and deployments. Also allows reading app settings, including environment variable values that are not marked secret, and build and runtime logs, which can contain secrets. StackDash reads only app names and deployment status.",
    },
    {
      scope: "droplet:read",
      access: "read",
      description:
        "Droplets, to name them in Droplet events. Also allows reading Droplet details such as IP addresses, sizes, tags, backups, and snapshots. StackDash reads only Droplet names.",
    },
    {
      scope: "account:read",
      access: "read",
      description:
        "Your team's name and id. Also allows reading your own name and email address; StackDash never stores them.",
    },
  ],
  dataCollected: [
    "Month-to-date usage and account credit",
    "Invoice totals with a breakdown by product",
    "Daily spend by SKU (DigitalOcean estimates)",
    "App Platform deployments started, succeeded, or failed, with the app name",
    "Droplet creates, resizes, power cycles, and deletes, with the Droplet name",
  ],
  eventTypes,
  achievements,
  // No `projectedSpend`: its estimated spend is what each SKU cost on one UTC day, spent, not a
  // projection, and its month to date and invoice totals are verified.
  oauth: {
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    revokeUrl: REVOKE_URL,
    scopes: SCOPES,
    pkce: true,
    clientIdEnv: "DIGITALOCEAN_CLIENT_ID",
    clientSecretEnv: "DIGITALOCEAN_CLIENT_SECRET",
  },
  // Hourly: billing changes nightly, and 5,000 requests an hour per token leave ample room.
  pollIntervalSeconds: 3600,

  buildAuthorizeUrl({ client, state, redirectUri, codeChallenge }) {
    if (codeChallenge === undefined) throw new TypeError("DigitalOcean connections use a PKCE S256 code challenge");
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    // Always explicit: without `scope` the consent screen lets the user pick any scope.
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  },

  async exchangeCode({ code, redirectUri, codeVerifier }, ctx) {
    if (codeVerifier === undefined) throw new TypeError("DigitalOcean connections need the PKCE code verifier");
    // DigitalOcean returns only `code` and `state` to the callback, so no callback parameter is read.
    const tokens = await requestTokens(ctx, {
      grant_type: "authorization_code",
      code,
      client_id: ctx.client.clientId,
      client_secret: ctx.client.clientSecret.reveal(),
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    let teamUuid = tokens.info?.team_uuid;
    if (teamUuid === undefined) {
      // `info.team_uuid` is documented on the token response; `/v2/account` is the fallback.
      const probe: OAuthCredential = { accessToken: new Secret(tokens.access_token), scopes: [], tokenType: "bearer" };
      teamUuid = (await readAccountTeam(ctx, probe))?.uuid;
    }
    if (teamUuid === undefined || !TEAM_ID.test(teamUuid)) {
      throw new InvalidResponseError("DigitalOcean did not say which team the grant covers", { endpoint: TOKEN_URL });
    }
    return toCredential(tokens, ctx.now(), teamUuid, SCOPES);
  },

  /**
   * Returns the NEW access and refresh token as one credential: a DigitalOcean refresh token works
   * exactly once and refreshing invalidates the old access token, so the pair must be stored
   * together before either is used. StackDash refreshes and saves before anything else, under a
   * per-connection refresh lock (`refreshIfExpiring` in src/lib/connections/credential-refresh.ts),
   * so two refreshes never race on one token.
   */
  async refreshTokens(credential, ctx) {
    if (credential.refreshToken === undefined) {
      throw new AuthRevokedError("DigitalOcean connection has no refresh token; reconnect DigitalOcean");
    }
    const teamUuid = readTeamUuid(credential);
    // The refresh example sends only `grant_type` and `refresh_token`; a confidential client
    // also authenticates, per RFC 6749 section 6 (page, Unverified). A used, expired, or revoked
    // refresh token is `invalid_grant`, which `requestTokens` reports as auth revoked.
    const tokens = await requestTokens(ctx, {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken.reveal(),
      client_id: ctx.client.clientId,
      client_secret: ctx.client.clientSecret.reveal(),
    });
    if (tokens.info?.team_uuid !== undefined && tokens.info.team_uuid !== teamUuid) {
      throw new InvalidResponseError("DigitalOcean refreshed a token for a different team", { endpoint: TOKEN_URL });
    }
    return toCredential(tokens, ctx.now(), teamUuid, credential.scopes);
  },

  /** Revokes the access token (empty JSON object on success). */
  async revoke(credential, ctx) {
    const token = credential.accessToken.reveal();
    await fetchJson(
      ctx,
      REVOKE_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams({ token }).toString(),
      },
      z.unknown(),
    );
  },

  async listAccounts(credential, ctx): Promise<ExternalAccount[]> {
    const teamUuid = readTeamUuid(credential);
    const team = await readAccountTeam(ctx, credential);
    if (team !== undefined && team.uuid !== teamUuid) {
      throw new InvalidResponseError("DigitalOcean account team does not match the grant", {
        endpoint: `${API_ORIGIN}/v2/account`,
      });
    }
    const name = team?.name.trim();
    return [
      {
        externalId: teamUuid,
        displayName: name === undefined || name.length === 0 ? "DigitalOcean team" : clip(name, NAME_MAX),
        kind: "team",
      },
    ];
  },

  detectMissingPermissions(grant) {
    if (READ_ALIAS_SCOPES.some((alias) => grant.scopes.includes(alias))) return [];
    return SCOPES.filter((scope) => !grant.scopes.includes(scope));
  },

  // Requests run one after another: the limit is 250 requests a minute per token.
  async sync({ credential, externalAccountId, cursor: rawCursor }: SyncInput, ctx): Promise<SyncResult> {
    const teamUuid = readTeamUuid(credential);
    if (externalAccountId !== teamUuid) {
      throw new Error("DigitalOcean sync was handed an external account the credential does not cover");
    }
    const now = ctx.now();
    const cursor = readCursor(rawCursor, ctx);
    const gaps: PermissionMissingError[] = [];
    const metrics: AdapterMetric[] = [];
    const events: ActivityEvent[] = [];

    const balance = await readOrGap(
      () => apiGet(ctx, credential, apiUrl("/v2/customers/my/balance"), BalanceSchema),
      gaps,
      "billing:read",
      `${BILLING_REFUSED} (balance).`,
    );
    if (balance !== undefined) metrics.push(...balanceMetrics(balance, externalAccountId, now));

    const invoices = await readOrGap(
      () => syncInvoices(ctx, credential, externalAccountId, cursor?.invoice, now),
      gaps,
      "billing:read",
      `${BILLING_REFUSED} (invoices).`,
    );
    if (invoices !== undefined) {
      metrics.push(...invoices.metrics);
      events.push(...invoices.events);
    }

    try {
      const daily = await readOrGap(
        () => syncInsights(ctx, credential, teamUuid, externalAccountId, now),
        gaps,
        "billing:read",
        `${BILLING_REFUSED} (Billing Insights).`,
      );
      if (daily !== undefined) metrics.push(...daily);
    } catch (error) {
      // Billing Insights only cover spend from 2025-12-01, and whether a team inside an
      // organization can read them by its own URN is unverified; a 404 leaves the other figures.
      if (!(error instanceof InvalidResponseError && error.status === 404)) throw error;
      gaps.push(
        new PermissionMissingError("DigitalOcean has no Billing Insights for this team.", [], {
          cause: error,
          status: 404,
          ...(error.endpoint === undefined ? {} : { endpoint: error.endpoint }),
        }),
      );
    }

    const actions = await readOrGap(
      () => syncDropletActions(ctx, credential, externalAccountId, cursor?.actions, gaps),
      gaps,
      "actions:read",
      "DigitalOcean refused the action history, so Droplet events are unavailable.",
    );
    if (actions !== undefined) events.push(...actions.events);

    const deployments = await readOrGap(
      () => syncDeployments(ctx, credential, externalAccountId, cursor?.deployments),
      gaps,
      "app:read",
      "DigitalOcean refused to list App Platform apps, so deployment events are unavailable.",
    );
    if (deployments !== undefined) events.push(...deployments.events);

    // A part the grant could not reach keeps its previous position, so nothing is skipped later.
    const invoiceCursor = invoices === undefined ? cursor?.invoice : invoices.latest;
    const actionsCursor = actions === undefined ? cursor?.actions : actions.latest;
    const deploymentsCursor = deployments === undefined ? cursor?.deployments : deployments.latest;
    const next: Cursor = {
      v: 1,
      ...(actionsCursor === undefined ? {} : { actions: actionsCursor }),
      ...(deploymentsCursor === undefined ? {} : { deployments: deploymentsCursor }),
      ...(invoiceCursor === undefined ? {} : { invoice: invoiceCursor }),
    };
    return {
      metrics,
      events,
      cursor: JSON.stringify(next),
      ...(gaps.length === 0 ? {} : { partialErrors: gaps }),
    };
  },
};
