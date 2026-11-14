import { z } from "zod";
import type { Achievement } from "../achievements";
import {
  AuthRevokedError,
  fetchJson,
  InvalidResponseError,
  PermissionMissingError,
  readOAuthErrorCode,
} from "../errors";
import type { ActivityEvent, EventType } from "../events";
import type { AdapterMetric } from "../metrics";
import {
  Secret,
  type ExternalAccount,
  type FetchLike,
  type OAuthContext,
  type OAuthCredential,
  type ProviderAdapter,
  type SyncResult,
} from "../types";
import {
  AccountListResponseSchema,
  BillingResponseSchema,
  EventPageResponseSchema,
  PaymentsSummaryResponseSchema,
  TokenResponseSchema,
  UsageResponseSchema,
  type BillingResponse,
  type PaymentsSummaryResponse,
  type ProviderEvent,
  type TokenResponse,
  type UsageResponse,
} from "./schemas";

/**
 * Example Cloud adapter: the starting point for a new provider adapter (docs/adapters.md).
 *
 * Example Cloud is a fictional hosting and payments platform. Its API exists only as the recorded
 * responses in `fixtures/`, which is enough to exercise every capability the contract has: usage,
 * an allowance, verified and estimated spend, a credit balance, revenue, and timeline events, plus
 * the OAuth code flow with PKCE, rotating refresh tokens, revocation, and partial results when the
 * grant is missing a scope. It is never registered (`registry.ts`), so it never runs in the app.
 *
 * Copy the folder, rename the provider id in every file, and replace the calls and mappings with
 * your provider's. The guide lists the shared files a registered provider touches.
 */

export const EXAMPLE_API_BASE = "https://api.example.com";
const AUTHORIZE_URL = "https://app.example.com/oauth/authorize";
const TOKEN_URL = `${EXAMPLE_API_BASE}/oauth/token`;
const REVOKE_URL = `${EXAMPLE_API_BASE}/oauth/revoke`;

// Read-only scopes, one per area, so a member can leave billing or payments out and still connect.
export const EXAMPLE_SCOPES = {
  accounts: "accounts:read",
  usage: "usage:read",
  billing: "billing:read",
  payments: "payments:read",
  events: "events:read",
} as const;
const REQUESTED_SCOPES: readonly string[] = Object.values(EXAMPLE_SCOPES);

const STATE_MAX_LENGTH = 1024;
// RFC 7636 section 4.1: 43 to 128 unreserved characters.
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

// 50 events per page and at most 5 pages per sync: a busy account catches up over several syncs
// instead of one sync running without bound.
const EVENT_PAGE_SIZE = 50;
export const MAX_EVENT_PAGES = 5;
// The first sync reads this far back, so a new connection shows recent activity, not all history.
export const EVENT_BACKFILL_DAYS = 7;
const DAY_MS = 86_400_000;
const TITLE_NAME_MAX = 120;

// The overage price is not in the API, so the estimate names the price list it came from. A real
// adapter cites the provider's public pricing page and the date it was checked.
const OVERAGE_PRICE_MINOR_PER_1000_REQUESTS = 40;
const OVERAGE_CURRENCY = "USD";
const PRICING_SOURCE = "Example Cloud price list (fictional): USD 0.40 per 1,000 requests over the allowance";

export const metricKeys = {
  requestsUsed: "example.requests.used",
  requestsIncluded: "example.requests.included",
  requestsRemaining: "example.requests.remaining",
  creditBalance: "example.credits.balance",
  spendMonthToDate: "example.spend.month_to_date",
  overageProjected: "example.spend.overage_projected",
  revenueMonthToDate: "example.revenue.month_to_date",
  recurringRevenue: "example.revenue.mrr",
} as const;

export const eventTypes = [
  {
    id: "example.signup",
    label: "New signup",
    description: "Someone signed up to an app hosted on Example Cloud.",
    shownByDefault: true,
    category: "signup",
    emoji: "👋",
  },
  {
    id: "example.deploy.succeeded",
    label: "Deployment succeeded",
    description: "A deployment finished and is serving traffic.",
    shownByDefault: true,
    category: "deploy_succeeded",
    emoji: "🚀",
  },
  {
    id: "example.deploy.failed",
    label: "Deployment failed",
    description: "A deployment failed before it could serve traffic.",
    shownByDefault: true,
    category: "deploy_failed",
    emoji: "💥",
  },
] as const satisfies readonly EventType[];

// Achievements (#413). A provider of a kind that already has a ladder copies it: a deployment host
// takes the deployment ladder of Vercel, Railway, DigitalOcean, and GitLab; a signup source takes
// Supabase's signup ladder. Read theirs first and keep the ids, thresholds, and wording parallel
// (docs/adapters.md, "Achievements"). Only a few are shown here, to show the shape.
export const achievements: readonly Achievement[] = [
  {
    id: "example.deployments.first",
    title: "First Example Cloud deployment recorded",
    publicTitle: "First Example Cloud deployment recorded",
    description: "Earned when DevMacro records the first successful Example Cloud deployment.",
    rule: { kind: "event_count", typeIds: ["example.deploy.succeeded"], count: 1 },
  },
  {
    id: "example.deployments.streak_10",
    title: "10 Example Cloud deployments in a row",
    publicTitle: "10 Example Cloud deployments in a row",
    description:
      "Earned when DevMacro records 10 successful Example Cloud deployments in a row, with no failed deployment between them.",
    rule: {
      kind: "event_streak",
      successTypeIds: ["example.deploy.succeeded"],
      failureTypeIds: ["example.deploy.failed"],
      count: 10,
    },
  },
  {
    id: "example.signups.first",
    title: "First Example Cloud signup recorded",
    publicTitle: "First Example Cloud signup recorded",
    description: "Earned when DevMacro records the first Example Cloud signup.",
    rule: { kind: "event_count", typeIds: ["example.signup"], count: 1 },
  },
];

type EventTypeId = (typeof eventTypes)[number]["id"];

// Provider event types the timeline shows. Any other type is skipped, so a type the provider adds
// later never fails a sync.
const EVENT_TYPE_BY_PROVIDER_TYPE: Readonly<Record<string, EventTypeId>> = {
  signup: "example.signup",
  "deploy.succeeded": "example.deploy.succeeded",
  "deploy.failed": "example.deploy.failed",
};

type AccountResource = "usage" | "billing" | "payments/summary" | "events";

/** Origin and path with the account id as a placeholder: provenance never carries an id or query. */
function endpointOf(resource: AccountResource): string {
  return `${EXAMPLE_API_BASE}/v1/accounts/{account_id}/${resource}`;
}

/* OAuth ---------------------------------------------------------------------------------------- */

function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

// RFC 6749 section 2.3.1: id and secret are form-encoded before Basic encoding. Never logged.
function oauthHeaders(ctx: OAuthContext): Record<string, string> {
  const { clientId, clientSecret } = ctx.client;
  return {
    Authorization: `Basic ${btoa(`${formEncode(clientId)}:${formEncode(clientSecret.reveal())}`)}`,
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
  };
}

/**
 * Token endpoint call. `invalid_grant` (400) means the code or the grant is gone, so it is reported
 * as auth revoked and the connection asks to reconnect; `fetchJson` alone would call it an invalid
 * response and retry it.
 */
async function requestTokens(ctx: OAuthContext, form: Record<string, string>): Promise<TokenResponse> {
  let oauthError: string | undefined;
  const capturingFetch: FetchLike = async (input, init) => {
    const response = await ctx.fetch(input, init);
    if (response.status === 400) oauthError = await readOAuthErrorCode(response.clone());
    return response;
  };
  try {
    return await fetchJson(
      { ...ctx, fetch: capturingFetch },
      TOKEN_URL,
      { method: "POST", headers: oauthHeaders(ctx), body: new URLSearchParams(form).toString() },
      TokenResponseSchema,
    );
  } catch (error) {
    if (error instanceof InvalidResponseError && error.status === 400 && oauthError === "invalid_grant") {
      throw new AuthRevokedError("Example Cloud rejected the authorization grant (invalid_grant)", {
        cause: error,
        status: 400,
        endpoint: TOKEN_URL,
      });
    }
    throw error;
  }
}

function toCredential(tokens: TokenResponse, ctx: OAuthContext, fallbackScopes: readonly string[]): OAuthCredential {
  return {
    accessToken: new Secret(tokens.access_token),
    refreshToken: new Secret(tokens.refresh_token),
    // Taken from the response, never assumed.
    expiresAt: new Date(ctx.now().getTime() + tokens.expires_in * 1000),
    // RFC 6749 section 5.1: an omitted scope means the scope asked for (or granted before).
    scopes: tokens.scope === undefined ? fallbackScopes : tokens.scope.split(" ").filter((scope) => scope.length > 0),
    tokenType: tokens.token_type,
  };
}

/* API reads ------------------------------------------------------------------------------------ */

function apiGet<T>(
  ctx: OAuthContext,
  credential: OAuthCredential,
  path: string,
  query: Readonly<Record<string, string>>,
  schema: z.ZodType<T>,
): Promise<T> {
  const url = new URL(path, EXAMPLE_API_BASE);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return fetchJson(
    ctx,
    url,
    { method: "GET", headers: { Authorization: `Bearer ${credential.accessToken.reveal()}`, Accept: "application/json" } },
    schema,
  );
}

function accountGet<T>(
  ctx: OAuthContext,
  credential: OAuthCredential,
  externalAccountId: string,
  resource: AccountResource,
  query: Readonly<Record<string, string>>,
  schema: z.ZodType<T>,
): Promise<T> {
  return apiGet(ctx, credential, `/v1/accounts/${encodeURIComponent(externalAccountId)}/${resource}`, query, schema);
}

type Optional<T> = { ok: true; value: T } | { ok: false; gap: PermissionMissingError };

/**
 * A read the sync can do without. A 403 becomes a gap naming the scope that would allow it, so the
 * connection shows what is missing while the rest of the sync is stored. Any other failure still
 * fails the sync.
 */
async function optional<T>(scope: string, what: string, read: () => Promise<T>): Promise<Optional<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (!(error instanceof PermissionMissingError)) throw error;
    const gap = new PermissionMissingError(`Example Cloud refused ${what}; the grant needs ${scope}`, [scope], {
      cause: error,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.endpoint === undefined ? {} : { endpoint: error.endpoint }),
    });
    return { ok: false, gap };
  }
}

/* Metrics -------------------------------------------------------------------------------------- */

export function usageMetrics(usage: UsageResponse, externalAccountId: string, retrievedAt: Date): AdapterMetric[] {
  const { start, end } = usage.period;
  const base = {
    externalAccountId,
    retrievedAt,
    timeframe: { type: "period", start, end },
    provenance: { source: "provider_api", endpoint: endpointOf("usage") },
    resetsAt: end,
    unit: "requests",
  } as const;
  const metrics: AdapterMetric[] = [
    { ...base, kind: "usage", metricKey: metricKeys.requestsUsed, label: "Requests this billing period", value: usage.requests.used },
  ];
  // A plan without an allowance gets no allowance metrics, rather than a made-up zero or infinity.
  const { included } = usage.requests;
  if (included !== null) {
    metrics.push(
      { ...base, kind: "included_allowance", metricKey: metricKeys.requestsIncluded, label: "Requests included in the plan", value: included },
      {
        ...base,
        kind: "remaining_allowance",
        metricKey: metricKeys.requestsRemaining,
        label: "Requests left in the allowance",
        // Usage past the allowance is billed as overage; remaining never goes below zero.
        value: Math.max(0, included - usage.requests.used),
      },
    );
  }
  if (usage.credits !== null) {
    metrics.push({
      kind: "credit_balance",
      metricKey: metricKeys.creditBalance,
      label: "Account credit",
      amountMinor: usage.credits.balance_minor,
      currency: usage.credits.currency,
      timeframe: { type: "point", at: retrievedAt },
      externalAccountId,
      retrievedAt,
      provenance: { source: "provider_api", endpoint: endpointOf("usage") },
    });
  }
  return metrics;
}

/**
 * Overage the whole billing period is on course for: requests so far scaled to the full period,
 * less the allowance, at the price list's rate. It is an estimate DevMacro calculates, so it is
 * `derived` and names its price list, and it is a projection for the whole period, so the adapter
 * declares its key in `projectedSpend` and no reading of spend counts it as spent so far.
 * Left out on a plan without an allowance, and in the period's first day, when a few hours of
 * traffic scaled to a month says nothing. Rounded once, half up, on the final amount.
 */
export function projectedOverage(
  usage: UsageResponse,
  externalAccountId: string,
  retrievedAt: Date,
): Extract<AdapterMetric, { kind: "estimated_spend" }> | undefined {
  const { included, used } = usage.requests;
  if (included === null) return undefined;
  const { start, end } = usage.period;
  const periodMs = end.getTime() - start.getTime();
  const elapsedMs = Math.min(periodMs, retrievedAt.getTime() - start.getTime());
  if (elapsedMs < DAY_MS) return undefined;
  const projectedRequests = (used * periodMs) / elapsedMs;
  const overRequests = Math.max(0, projectedRequests - included);
  return {
    kind: "estimated_spend",
    metricKey: metricKeys.overageProjected,
    label: "Overage expected this billing period",
    amountMinor: Math.round((overRequests * OVERAGE_PRICE_MINOR_PER_1000_REQUESTS) / 1000),
    currency: OVERAGE_CURRENCY,
    timeframe: { type: "period", start, end },
    externalAccountId,
    retrievedAt,
    provenance: { source: "derived", endpoint: endpointOf("usage"), pricingSource: PRICING_SOURCE },
  };
}

export function spendMetric(billing: BillingResponse, externalAccountId: string, retrievedAt: Date): AdapterMetric {
  return {
    kind: "verified_spend",
    metricKey: metricKeys.spendMonthToDate,
    label: "Spend this billing period",
    amountMinor: billing.month_to_date_minor,
    currency: billing.currency,
    timeframe: { type: "period", start: billing.period.start, end: billing.period.end },
    externalAccountId,
    retrievedAt,
    provenance: { source: "provider_api", endpoint: endpointOf("billing") },
  };
}

export function revenueMetrics(summary: PaymentsSummaryResponse, externalAccountId: string, retrievedAt: Date): AdapterMetric[] {
  const base = {
    currency: summary.currency,
    externalAccountId,
    retrievedAt,
    provenance: { source: "provider_api", endpoint: endpointOf("payments/summary") },
  } as const;
  return [
    {
      ...base,
      kind: "revenue",
      metricKey: metricKeys.revenueMonthToDate,
      label: "Revenue this billing period, net of refunds",
      amountMinor: summary.net_revenue_minor,
      timeframe: { type: "period", start: summary.period.start, end: summary.period.end },
    },
    {
      // A run rate at one moment, so it is never summed into revenue for a period.
      ...base,
      kind: "recurring_revenue",
      metricKey: metricKeys.recurringRevenue,
      label: "Monthly recurring revenue",
      amountMinor: summary.mrr_minor,
      timeframe: { type: "point", at: retrievedAt },
    },
  ];
}

/* Events --------------------------------------------------------------------------------------- */

const CursorSchema = z.strictObject({ v: z.literal(1), since: z.iso.datetime() });

/**
 * When the next event read starts. `created_since` is inclusive, so the newest event read is read
 * again next time and its dedupe key keeps it from being stored twice: two events in the same
 * millisecond can never fall between two syncs. An unreadable cursor is our own value come back
 * wrong, so it is logged and the read starts over from the backfill window instead of failing every
 * future sync.
 */
function readCursor(cursor: string | undefined, ctx: OAuthContext, now: Date): Date {
  const backfill = new Date(now.getTime() - EVENT_BACKFILL_DAYS * DAY_MS);
  if (cursor === undefined) return backfill;
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success) {
    ctx.logger.warn("example.sync.cursor_unreadable", { provider: "example" });
    return backfill;
  }
  return new Date(parsed.data.since);
}

function writeCursor(since: Date): string {
  return JSON.stringify({ v: 1, since: since.toISOString() });
}

type EventRead = { events: ProviderEvent[]; complete: boolean };

/** Oldest first, at most MAX_EVENT_PAGES pages; `complete` is false when the cap stopped it. */
async function readEvents(
  ctx: OAuthContext,
  credential: OAuthCredential,
  externalAccountId: string,
  since: Date,
): Promise<EventRead> {
  const events: ProviderEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const query: Record<string, string> = { created_since: since.toISOString(), limit: String(EVENT_PAGE_SIZE) };
    if (pageToken !== undefined) query.page_token = pageToken;
    const response = await accountGet(ctx, credential, externalAccountId, "events", query, EventPageResponseSchema);
    events.push(...response.data);
    if (response.next_page_token === null) return { events, complete: true };
    pageToken = response.next_page_token;
  }
  return { events, complete: false };
}

function httpsUrl(value: string | undefined): string | undefined {
  if (value === undefined || !URL.canParse(value)) return undefined;
  return new URL(value).protocol === "https:" ? value : undefined;
}

function shorten(name: string): string {
  return name.length > TITLE_NAME_MAX ? `${name.slice(0, TITLE_NAME_MAX)}…` : name;
}

/**
 * Timeline events. The event model has no field for a person on purpose: a signup is counted, and
 * nothing about who signed up (name, email) is read or stored.
 */
export function toActivityEvents(events: readonly ProviderEvent[], externalAccountId: string): ActivityEvent[] {
  const mapped: ActivityEvent[] = [];
  for (const event of events) {
    const typeId = EVENT_TYPE_BY_PROVIDER_TYPE[event.type];
    if (typeId === undefined) continue;
    const project = event.project === undefined ? undefined : shorten(event.project);
    const url = httpsUrl(event.url);
    const shared = {
      typeId,
      occurredAt: event.created_at,
      externalAccountId,
      dedupeKey: `${typeId}:${event.id}`,
      ...(url === undefined ? {} : { url }),
    };
    if (typeId === "example.signup") {
      mapped.push({ ...shared, severity: "info", title: project === undefined ? "New signup" : `New signup on ${project}` });
    } else if (typeId === "example.deploy.succeeded") {
      mapped.push({ ...shared, severity: "success", title: project === undefined ? "Deployment succeeded" : `${project} deployed` });
    } else {
      mapped.push({
        ...shared,
        severity: "critical",
        title: project === undefined ? "Deployment failed" : `${project} failed to deploy`,
        body: "The previous deployment keeps serving traffic. Open the deployment in Example Cloud for its build log.",
      });
    }
  }
  return mapped;
}

/* Adapter -------------------------------------------------------------------------------------- */

export const exampleAdapter: ProviderAdapter<"example"> = {
  id: "example",
  displayName: "Example Cloud",
  capabilities: {
    oauth: true,
    polling: true,
    webhooks: false,
    usage: true,
    spending: true,
    allowance: true,
    credits: true,
    revenue: true,
    events: true,
  },
  permissions: [
    { scope: EXAMPLE_SCOPES.accounts, access: "read", description: "See the names of the accounts you choose to connect." },
    { scope: EXAMPLE_SCOPES.usage, access: "read", description: "Read request usage, your plan's allowance, and account credit." },
    { scope: EXAMPLE_SCOPES.billing, access: "read", description: "Read what you have been billed this period." },
    { scope: EXAMPLE_SCOPES.payments, access: "read", description: "Read revenue and recurring revenue totals, never single payments." },
    { scope: EXAMPLE_SCOPES.events, access: "read", description: "Read signups and deployments for the timeline." },
  ],
  dataCollected: [
    "Requests used this billing period and the allowance your plan includes",
    "Account credit balance",
    "Spend this billing period, and the overage it is on course for",
    "Revenue this billing period and monthly recurring revenue",
    "Signups and deployments, without who signed up",
  ],
  eventTypes,
  achievements,
  projectedSpend: [metricKeys.overageProjected],
  oauth: {
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    revokeUrl: REVOKE_URL,
    scopes: REQUESTED_SCOPES,
    pkce: true,
    clientIdEnv: "EXAMPLE_CLIENT_ID",
    clientSecretEnv: "EXAMPLE_CLIENT_SECRET",
  },
  // Hourly, the contract default: usage and billing change slowly, and a sync costs at most eight
  // requests per account.
  pollIntervalSeconds: 3600,

  buildAuthorizeUrl({ client, state, redirectUri, codeChallenge }) {
    if (codeChallenge === undefined) throw new TypeError("Example Cloud requires a PKCE S256 code challenge");
    if (state.length === 0 || state.length > STATE_MAX_LENGTH) {
      throw new RangeError(`state must be 1 to ${STATE_MAX_LENGTH} characters`);
    }
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    // Always explicit: a scope left to the provider's default can grant more than the adapter needs.
    url.searchParams.set("scope", REQUESTED_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  },

  async exchangeCode({ code, redirectUri, codeVerifier }, ctx) {
    if (codeVerifier === undefined || !CODE_VERIFIER.test(codeVerifier)) {
      throw new TypeError("Example Cloud requires a PKCE code verifier of 43 to 128 unreserved characters");
    }
    const tokens = await requestTokens(ctx, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    return toCredential(tokens, ctx, REQUESTED_SCOPES);
  },

  /**
   * Returns the new refresh token: Example Cloud rotates it on every use. The sync runner saves the
   * returned credential before anything else runs, and never refreshes one connection twice at once.
   */
  async refreshTokens(credential, ctx) {
    if (credential.refreshToken === undefined) {
      throw new AuthRevokedError("Example Cloud connection has no refresh token; reconnect required");
    }
    const tokens = await requestTokens(ctx, {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken.reveal(),
    });
    const refreshed = toCredential(tokens, ctx, credential.scopes);
    return credential.metadata === undefined ? refreshed : { ...refreshed, metadata: credential.metadata };
  },

  /** RFC 7009: revoking the refresh token ends the whole grant, access tokens included. */
  async revoke(credential, ctx) {
    const token = credential.refreshToken ?? credential.accessToken;
    await fetchJson(
      ctx,
      REVOKE_URL,
      {
        method: "POST",
        headers: oauthHeaders(ctx),
        body: new URLSearchParams({
          token: token.reveal(),
          token_type_hint: credential.refreshToken === undefined ? "access_token" : "refresh_token",
        }).toString(),
      },
      z.object({}),
    );
  },

  async listAccounts(credential, ctx): Promise<ExternalAccount[]> {
    const response = await apiGet(ctx, credential, "/v1/accounts", {}, AccountListResponseSchema);
    return response.data.map((account) => ({ externalId: account.id, displayName: account.name, kind: account.type }));
  },

  detectMissingPermissions(grant) {
    return REQUESTED_SCOPES.filter((scope) => !grant.scopes.includes(scope));
  },

  // Reads run one after another: Example Cloud's rate limit is per token, and a sync is not urgent.
  async sync({ credential, externalAccountId, cursor }, ctx): Promise<SyncResult> {
    const retrievedAt = ctx.now();
    const partialErrors: PermissionMissingError[] = [];

    // Usage is the primary read: without it the sync has nothing to show, so any failure fails it.
    const usage = await accountGet(ctx, credential, externalAccountId, "usage", {}, UsageResponseSchema);
    const metrics = usageMetrics(usage, externalAccountId, retrievedAt);
    const overage = projectedOverage(usage, externalAccountId, retrievedAt);
    if (overage !== undefined) metrics.push(overage);

    const billing = await optional(EXAMPLE_SCOPES.billing, "billing", () =>
      accountGet(ctx, credential, externalAccountId, "billing", {}, BillingResponseSchema),
    );
    if (billing.ok) metrics.push(spendMetric(billing.value, externalAccountId, retrievedAt));
    else partialErrors.push(billing.gap);

    const payments = await optional(EXAMPLE_SCOPES.payments, "payments", () =>
      accountGet(ctx, credential, externalAccountId, "payments/summary", {}, PaymentsSummaryResponseSchema),
    );
    if (payments.ok) metrics.push(...revenueMetrics(payments.value, externalAccountId, retrievedAt));
    else partialErrors.push(payments.gap);

    const since = readCursor(cursor, ctx, retrievedAt);
    const read = await optional(EXAMPLE_SCOPES.events, "events", () => readEvents(ctx, credential, externalAccountId, since));
    let events: ActivityEvent[] = [];
    // An unreadable event stream keeps the previous cursor, so the next sync reads the same window.
    let nextCursor = cursor;
    if (read.ok) {
      if (!read.value.complete) {
        ctx.logger.warn("example.sync.event_page_cap", { provider: "example", maxPages: MAX_EVENT_PAGES });
      }
      events = toActivityEvents(read.value.events, externalAccountId);
      // Oldest first, so after a capped read the newest event read is where the next sync goes on.
      const newest = read.value.events.at(-1)?.created_at;
      nextCursor = writeCursor(newest === undefined || newest.getTime() < since.getTime() ? since : newest);
    } else {
      partialErrors.push(read.gap);
    }

    return {
      metrics,
      events,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
      ...(partialErrors.length === 0 ? {} : { partialErrors }),
    };
  },
};
