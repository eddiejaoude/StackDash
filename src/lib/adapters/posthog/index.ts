import { z } from "zod";
import { decimalToMinorUnits } from "@/lib/money";
import { PROVIDER_NAMES } from "@/lib/providers";
import type { Achievement } from "../achievements";
import {
  AdapterError,
  AuthRevokedError,
  fetchJson,
  PermissionMissingError,
  ProviderUnavailableError,
  readOAuthErrorCode,
} from "../errors";
import type { ActivityEvent, EventType } from "../events";
import { UnitSchema, type AdapterMetric, type Timeframe } from "../metrics";
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
import { CLIENT_ASSERTION_TYPE, createClientAssertion, loadSigningKey } from "./client-auth";
import {
  BillingResponseSchema,
  OrganizationListSchema,
  ProjectListSchema,
  SignupQueryResponseSchema,
  TokenResponseSchema,
  type BillingProduct,
  type BillingResponse,
  type Project,
  type TokenResponse,
} from "./schemas";

/**
 * PostHog adapter (docs/providers/posthog.md, issue #115).
 *
 * OAuth 2.0 authorization code flow with PKCE (S256), registered by client ID metadata document
 * and authenticated with `private_key_jwt` (./client-auth.ts). Sync reads the organization's
 * billing overview for spend, projected spend, and usage against each product's free allocation
 * and billing limit, and runs one HogQL count per project and day for signups. No webhooks exist
 * for OAuth apps, so everything is polled.
 */

// Region-agnostic OAuth host: "use https://oauth.posthog.com" for an integration that should work
// for any PostHog customer (PostHog OAuth, OAuth server endpoints).
const OAUTH_ORIGIN = "https://oauth.posthog.com";
const AUTHORIZE_URL = `${OAUTH_ORIGIN}/oauth/authorize/`;
const TOKEN_URL = `${OAUTH_ORIGIN}/oauth/token/`;
const REVOKE_URL = `${OAUTH_ORIGIN}/oauth/revoke/`;

// The API has no region-agnostic host: data lives in US or EU Cloud, and the token works only there.
export const REGION_ORIGINS = {
  us: "https://us.posthog.com",
  eu: "https://eu.posthog.com",
} as const;
export type Region = keyof typeof REGION_ORIGINS;
// Probe order when detecting a token's region; US Cloud first.
const REGIONS: readonly Region[] = ["us", "eu"];
const REGION_METADATA_KEY = "region";
// The organizations the user picked on the consent screen (`scoped_organizations`), comma joined.
// Absent when the grant covers every organization the user belongs to.
const ORGANIZATIONS_METADATA_KEY = "organizations";

// Read-only scopes, as #115 lists them. The metadata document declares the same list as the scope
// ceiling, so a token can never carry more.
export const SCOPES = ["billing:read", "organization:read", "project:read", "query:read"] as const;

const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

// One page each; the bounds keep a sync's request count fixed (docs/providers/posthog.md, Rate limits).
const ORGANIZATION_PAGE_LIMIT = 100;
export const MAX_SIGNUP_PROJECTS = 20;
// The first sync reports this many completed UTC days; later syncs report only new ones.
export const SIGNUP_BACKFILL_DAYS = 7;
// PostHog's own billing alert levels: emails at 80 and 100 percent (Billing limits and alerts).
export const NEAR_LIMIT_RATIO = 0.8;

const DAY_MS = 24 * 60 * 60 * 1000;
const PRODUCT_NAME_MAX = 60;
const PRODUCT_TYPE_PATTERN = /^[a-z][a-z0-9_]*$/;

// Shown to the user as the estimate's pricing source, so it names what PostHog calls the figure and
// where they can see it; the endpoint stays in `provenance.endpoint`. No check date: the projection
// is read live on every sync, not copied from a price list.
export const PROJECTED_PRICING_SOURCE = "PostHog's own projection for the billing period, from its billing overview";
const CURRENCY = "USD";
// The organization's spend so far. Each product's spend is a breakdown of it, keyed one segment
// below (`posthog.spend.current.<type>`), so the dashboard counts the total and drops the products
// (`dropSupersededBreakdowns`, #204).
const CURRENT_SPEND_METRIC_KEY = "posthog.spend.current";
// PostHog's estimate of the whole billing period's bill, declared as projected spend.
const PROJECTED_SPEND_METRIC_KEY = "posthog.spend.projected";

// Exported, like `billingMetrics` and the event builders below, for the local simulator (#131).
export const eventTypes = [
  {
    id: "posthog.signups.daily",
    label: "Daily signups",
    description: "New people identified in a PostHog project on one UTC day. Only the count is kept.",
    shownByDefault: true,
  },
  {
    id: "posthog.usage_limit.near",
    label: "Usage near billing limit",
    description: "A PostHog product passed 80 percent of the billing limit set for the period.",
    shownByDefault: true,
  },
  {
    id: "posthog.usage_limit.reached",
    label: "Billing limit reached",
    description: "A PostHog product reached its billing limit, so PostHog stops processing its new data.",
    shownByDefault: true,
  },
] as const satisfies readonly EventType[];

// Cursor: the last UTC day whose signups were reported for every project.
const CursorSchema = z.strictObject({ v: z.literal(1), through: z.iso.date() });

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function readCursor(cursor: string | undefined, ctx: OAuthContext): string | undefined {
  if (cursor === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    raw = undefined;
  }
  const parsed = CursorSchema.safeParse(raw);
  if (parsed.success) return parsed.data.through;
  // Our own value came back unreadable: start again from the backfill window rather than fail.
  ctx.logger.warn("posthog.sync.cursor_unreadable", { provider: "posthog" });
  return undefined;
}

/** Client authentication for every token endpoint call: a fresh assertion each time. */
function clientAuthentication(ctx: OAuthContext): Record<string, string> {
  const key = loadSigningKey(ctx.client.clientSecret.reveal());
  return {
    client_id: ctx.client.clientId,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: createClientAssertion(ctx.client.clientId, key, ctx.now(), crypto.randomUUID()),
  };
}

/**
 * Token endpoint call. `invalid_grant` means the code or refresh token is gone (the user revoked
 * the app, or the grant expired), so it is reported as auth revoked: the connection asks to
 * reconnect and is never retried. A 401, or `invalid_client` with any status, is client
 * authentication failing (RFC 6749 section 5.2): PostHog could not read the JWKS, has not seen a
 * rotated key yet, or the clock drifted past its skew (Provisioning, Troubleshoot assertion errors).
 * That is the deployment's problem and passes once fixed, so it is reported as provider
 * unavailable, which the runner retries, never as a revoked grant for every connection.
 */
async function requestTokens(ctx: OAuthContext, form: Record<string, string>): Promise<TokenResponse> {
  let oauthError: string | undefined;
  const capturingFetch: FetchLike = async (input, init) => {
    const response = await ctx.fetch(input, init);
    if (response.status === 400 || response.status === 401) oauthError = await readOAuthErrorCode(response.clone());
    return response;
  };
  try {
    return await fetchJson(
      { ...ctx, fetch: capturingFetch },
      TOKEN_URL,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...form, ...clientAuthentication(ctx) }).toString(),
      },
      TokenResponseSchema,
    );
  } catch (error) {
    if (!(error instanceof AdapterError) || (error.status !== 400 && error.status !== 401)) throw error;
    const details = {
      cause: error,
      status: error.status,
      ...(error.endpoint === undefined ? {} : { endpoint: error.endpoint }),
    };
    if (oauthError === "invalid_grant") {
      throw new AuthRevokedError("PostHog rejected the authorization grant (invalid_grant)", details);
    }
    if (error.status === 401 || oauthError === "invalid_client") {
      throw new ProviderUnavailableError(
        `PostHog rejected DevMacro's client assertion (${oauthError ?? "401"}); check POSTHOG_OAUTH_PRIVATE_KEY and the JWKS route`,
        details,
      );
    }
    throw error;
  }
}

function parseScopes(scope: string | undefined, fallback: readonly string[]): readonly string[] {
  // RFC 6749 section 5.1: an omitted scope means the requested (or previously granted) scope.
  if (scope === undefined) return fallback;
  return scope.split(" ").filter((value) => value.length > 0);
}

/**
 * The grant's organizations: the token response's `scoped_organizations` when it names any, else
 * nothing (every organization). A refresh response without the field keeps the previous list.
 */
function grantedOrganizations(tokens: TokenResponse, previous: OAuthCredential | undefined): string | undefined {
  const scoped = tokens.scoped_organizations;
  if (scoped === undefined) return previous?.metadata?.[ORGANIZATIONS_METADATA_KEY];
  return scoped === null || scoped.length === 0 ? undefined : scoped.join(",");
}

function toCredential(
  tokens: TokenResponse,
  ctx: OAuthContext,
  region: Region,
  fallbackScopes: readonly string[],
  previous?: OAuthCredential,
): OAuthCredential {
  const refreshToken = tokens.refresh_token === undefined ? previous?.refreshToken : new Secret(tokens.refresh_token);
  const organizations = grantedOrganizations(tokens, previous);
  return {
    accessToken: new Secret(tokens.access_token),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAt: new Date(ctx.now().getTime() + tokens.expires_in * 1000),
    scopes: parseScopes(tokens.scope, fallbackScopes),
    tokenType: tokens.token_type,
    metadata: {
      [REGION_METADATA_KEY]: region,
      ...(organizations === undefined ? {} : { [ORGANIZATIONS_METADATA_KEY]: organizations }),
    },
  };
}

function regionOf(credential: OAuthCredential): Region {
  const region = credential.metadata?.[REGION_METADATA_KEY];
  if (region === "us" || region === "eu") return region;
  throw new AuthRevokedError("PostHog credential has no region; reconnect PostHog");
}

function bearer(credential: OAuthCredential): Record<string, string> {
  return { Authorization: `Bearer ${credential.accessToken.reveal()}`, Accept: "application/json" };
}

function apiGet<T>(
  ctx: OAuthContext,
  credential: OAuthCredential,
  origin: string,
  path: string,
  query: Readonly<Record<string, string>>,
  schema: z.ZodType<T>,
): Promise<T> {
  const url = new URL(path, origin);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return fetchJson(ctx, url, { method: "GET", headers: bearer(credential) }, schema);
}

/**
 * Which region issued the token. The region-agnostic OAuth host does not say, so each region is
 * asked in turn: the one that knows the token answers anything but 401, a 403 included (the token
 * is known there, it only lacks a permission). Unverified until a real account exists
 * (docs/providers/posthog.md, Unverified).
 */
async function detectRegion(ctx: OAuthContext, accessToken: string): Promise<Region> {
  const probe: OAuthCredential = { accessToken: new Secret(accessToken), scopes: [], tokenType: "Bearer" };
  for (const region of REGIONS) {
    try {
      await apiGet(ctx, probe, REGION_ORIGINS[region], "/api/organizations/", { limit: "1" }, OrganizationListSchema);
      return region;
    } catch (error) {
      if (error instanceof PermissionMissingError) return region;
      if (!(error instanceof AuthRevokedError)) throw error;
    }
  }
  throw new AuthRevokedError("Neither PostHog US Cloud nor EU Cloud accepted the new access token");
}

/**
 * A refusal reported as a missing permission. `message` replaces the default wording when the
 * scope is already granted and the refusal has another cause.
 */
function permissionGap(
  error: unknown,
  scope: (typeof SCOPES)[number],
  what: string,
  message = `PostHog refused ${what}; the grant needs ${scope}`,
): PermissionMissingError | undefined {
  if (!(error instanceof PermissionMissingError)) return undefined;
  return new PermissionMissingError(message, [scope], {
    cause: error,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.endpoint === undefined ? {} : { endpoint: error.endpoint }),
  });
}

function productName(product: BillingProduct): string {
  return product.name.length > PRODUCT_NAME_MAX ? `${product.name.slice(0, PRODUCT_NAME_MAX)}…` : product.name;
}

/**
 * The product's unit as DevMacro shows it next to a count. PostHog names units in the singular
 * (`event`, `recording`, `survey response`), so a lowercase noun gets a plural "s"; a symbol such as
 * `GB` is kept as sent. A unit the metric model cannot store becomes `units`.
 */
function unitOf(product: BillingProduct): string {
  const unit = product.unit?.trim();
  if (unit === undefined) return "units";
  const plural = /^[a-z]+(?: [a-z]+)*$/.test(unit) && !unit.endsWith("s") ? `${unit}s` : unit;
  return UnitSchema.safeParse(plural).success ? plural : "units";
}

/** Metered products with a key DevMacro can store: `usage_key` set and a lowercase type. */
function meteredProducts(billing: BillingResponse): BillingProduct[] {
  return (billing.products ?? []).filter(
    (product) => product.usage_key != null && PRODUCT_TYPE_PATTERN.test(product.type),
  );
}

function billingTimeframe(billing: BillingResponse, retrievedAt: Date): Timeframe {
  const period = billing.billing_period;
  return period == null
    ? { type: "point", at: retrievedAt }
    : { type: "period", start: period.current_period_start, end: period.current_period_end };
}

export function billingMetrics(
  billing: BillingResponse,
  externalAccountId: string,
  retrievedAt: Date,
  region: Region,
): AdapterMetric[] {
  const timeframe = billingTimeframe(billing, retrievedAt);
  const resetsAt = billing.billing_period?.current_period_end;
  const endpoint = `${REGION_ORIGINS[region]}/api/billing/`;
  const base = {
    externalAccountId,
    retrievedAt,
    timeframe,
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
  const fromApi = { source: "provider_api", endpoint } as const;
  const metrics: AdapterMetric[] = [];

  const current = billing.current_total_amount_usd_after_discount ?? billing.current_total_amount_usd;
  if (current != null) {
    metrics.push({
      ...base,
      kind: "verified_spend",
      metricKey: CURRENT_SPEND_METRIC_KEY,
      label: "Spend so far this billing period",
      amountMinor: decimalToMinorUnits(current, CURRENCY),
      currency: CURRENCY,
      provenance: fromApi,
    });
  }
  // Declared a projection (`projectedSpend`), so no reading of spend counts it as spent so far,
  // with or without a current total beside it (#223).
  const projected = billing.projected_total_amount_usd_after_discount ?? billing.projected_total_amount_usd;
  if (projected != null) {
    metrics.push({
      ...base,
      kind: "estimated_spend",
      metricKey: PROJECTED_SPEND_METRIC_KEY,
      label: "Projected spend for the billing period",
      amountMinor: decimalToMinorUnits(projected, CURRENCY),
      currency: CURRENCY,
      provenance: { source: "derived", endpoint, pricingSource: PROJECTED_PRICING_SOURCE },
    });
  }

  for (const product of meteredProducts(billing)) {
    const name = productName(product);
    const unit = unitOf(product);
    const key = `posthog.${product.type}`;
    const used = product.current_usage;
    if (used !== undefined) {
      metrics.push({ ...base, kind: "usage", metricKey: `${key}.usage`, label: `${name} usage`, value: used, unit, provenance: fromApi });
    }
    // A free allocation of zero or null means no free tier for the product: no allowance metrics.
    const free = product.free_allocation;
    if (free != null && free > 0) {
      metrics.push({
        ...base,
        kind: "included_allowance",
        metricKey: `${key}.free`,
        label: `${name} free allocation`,
        value: free,
        unit,
        provenance: fromApi,
      });
      if (used !== undefined) {
        metrics.push({
          ...base,
          kind: "remaining_allowance",
          metricKey: `${key}.free_remaining`,
          label: `${name} free allocation left`,
          value: Math.max(0, free - used),
          unit,
          provenance: fromApi,
        });
      }
    }
    if (product.current_amount_usd != null) {
      metrics.push({
        ...base,
        kind: "verified_spend",
        metricKey: `${CURRENT_SPEND_METRIC_KEY}.${product.type}`,
        label: `${name} spend so far`,
        amountMinor: decimalToMinorUnits(product.current_amount_usd, CURRENCY),
        currency: CURRENCY,
        provenance: fromApi,
      });
    }
  }
  return metrics;
}

/**
 * One event per product, billing period, and level when usage crosses 80 or 100 percent of the
 * product's billing limit, PostHog's own alert levels. The dedupe key holds the period start, so
 * each level fires once per period however many syncs see it.
 */
export function usageLimitEvents(
  billing: BillingResponse,
  externalAccountId: string,
  detectedAt: Date,
  region: Region,
): ActivityEvent[] {
  const periodKey = billing.billing_period?.current_period_start.toISOString() ?? "no-period";
  const events: ActivityEvent[] = [];
  for (const product of meteredProducts(billing)) {
    const limit = product.usage_limit;
    const used = product.current_usage;
    if (limit == null || limit <= 0 || used === undefined) continue;
    const name = productName(product);
    const reached = product.has_exceeded_limit === true || used >= limit;
    if (!reached && used < limit * NEAR_LIMIT_RATIO) continue;
    const percent = Math.floor((used / limit) * 100);
    const typeId = reached ? "posthog.usage_limit.reached" : "posthog.usage_limit.near";
    events.push({
      typeId,
      // PostHog does not say when usage crossed the line, so the event is dated when the sync saw it.
      occurredAt: detectedAt,
      severity: reached ? "critical" : "warning",
      title: reached ? `${name} reached its PostHog billing limit` : `${name} is at ${percent} percent of its PostHog billing limit`,
      body: reached
        ? "PostHog stops processing new data for this product until the limit is raised or the billing period resets. Data sent in the meantime is lost."
        : "Raise the billing limit in PostHog's billing settings before it is reached, or PostHog stops processing new data for this product.",
      externalAccountId,
      dedupeKey: `posthog.usage_limit:${externalAccountId}:${product.type}:${periodKey}:${reached ? "reached" : "near"}`,
      url: `${REGION_ORIGINS[region]}/organization/billing`,
    });
  }
  return events;
}

export type SignupDay = Readonly<{ project: Pick<Project, "id" | "name">; date: string; signups: number }>;

/** One event per project and UTC day with at least one signup, dated when the day ended. */
export function signupEvents(days: readonly SignupDay[], externalAccountId: string, region: Region): ActivityEvent[] {
  return days
    .filter((day) => day.signups > 0)
    .map((day) => ({
      typeId: "posthog.signups.daily",
      occurredAt: new Date(Date.parse(`${day.date}T00:00:00.000Z`) + DAY_MS),
      severity: "info",
      title: `${day.signups} ${day.signups === 1 ? "signup" : "signups"} in ${day.project.name} on ${day.date}`,
      externalAccountId,
      dedupeKey: `posthog.signups:${day.project.id}:${day.date}`,
      url: `${REGION_ORIGINS[region]}/project/${day.project.id}`,
    }));
}

/** The usage metric holding the organization's signups for one UTC day, which the headline counts. */
const SIGNUP_METRIC_KEY = "posthog.signups.daily";

// Achievements (#413). The signup ladder is shared with Supabase: keep the ids, thresholds, and
// wording in step with Supabase's (docs/adapters.md, "Achievements"). PostHog reports one signup
// total per UTC day, so these sum the daily totals, are dated to the day, and none is hour based.
const achievements: readonly Achievement[] = [
  {
    id: "posthog.signups.first",
    title: "First PostHog signup recorded",
    publicTitle: "First PostHog signup recorded",
    description: "Earned when DevMacro records the first PostHog signup, counted from daily signup totals.",
    rule: { kind: "daily_total_threshold", metricKey: SIGNUP_METRIC_KEY, value: 1, sum: "cumulative" },
  },
  {
    id: "posthog.signups.10",
    title: "10 PostHog signups recorded",
    publicTitle: "10 PostHog signups recorded",
    description: "Earned when DevMacro records the 10th PostHog signup, counted from daily signup totals.",
    rule: { kind: "daily_total_threshold", metricKey: SIGNUP_METRIC_KEY, value: 10, sum: "cumulative" },
  },
  {
    id: "posthog.signups.100",
    title: "100 PostHog signups recorded",
    publicTitle: "100 PostHog signups recorded",
    description: "Earned when DevMacro records the 100th PostHog signup, counted from daily signup totals.",
    rule: { kind: "daily_total_threshold", metricKey: SIGNUP_METRIC_KEY, value: 100, sum: "cumulative" },
  },
  {
    id: "posthog.signups.1000",
    title: "1,000 PostHog signups recorded",
    publicTitle: "1,000 PostHog signups recorded",
    description: "Earned when DevMacro records the 1,000th PostHog signup, counted from daily signup totals.",
    rule: { kind: "daily_total_threshold", metricKey: SIGNUP_METRIC_KEY, value: 1000, sum: "cumulative" },
  },
  {
    id: "posthog.signups.big_day",
    title: "Big day: 100 signups in one day",
    publicTitle: "Big day: 100 signups in one day",
    description: "Earned when DevMacro records a PostHog daily signup total of 100 or more.",
    rule: { kind: "daily_total_threshold", metricKey: SIGNUP_METRIC_KEY, value: 100, sum: "single_day" },
  },
];

/** The organization's signups on its latest reported day, summed across the queried projects. */
export function signupMetric(
  days: readonly SignupDay[],
  date: string,
  externalAccountId: string,
  retrievedAt: Date,
  region: Region,
): AdapterMetric {
  const start = Date.parse(`${date}T00:00:00.000Z`);
  return {
    kind: "usage",
    metricKey: SIGNUP_METRIC_KEY,
    // The timeframe carries the day, so the label holds on any day the dashboard shows.
    label: "Daily signups",
    value: days.filter((day) => day.date === date).reduce((sum, day) => sum + day.signups, 0),
    unit: "signups",
    externalAccountId,
    retrievedAt,
    timeframe: { type: "period", start: new Date(start), end: new Date(start + DAY_MS) },
    provenance: { source: "provider_api", endpoint: `${REGION_ORIGINS[region]}/api/projects/{project_id}/query/` },
  };
}

/**
 * People created per UTC day in [from, to). Persons are created when PostHog first identifies
 * someone (the default `identified_only` person profiles), which is the signup signal. Date literals
 * name UTC explicitly: HogQL parses them in the project's timezone otherwise (SQL, Supported
 * ClickHouse functions). The dates are DevMacro's own, never user input.
 */
function signupQuery(from: string, to: string): string {
  return [
    "SELECT toDate(toTimeZone(created_at, 'UTC')) AS day, count() AS signups",
    "FROM persons",
    `WHERE created_at >= toDateTime('${from} 00:00:00', 'UTC') AND created_at < toDateTime('${to} 00:00:00', 'UTC')`,
    "GROUP BY day",
    "ORDER BY day",
    `LIMIT ${SIGNUP_BACKFILL_DAYS}`,
  ].join("\n");
}

type SignupRead = { days: SignupDay[]; complete: boolean; gaps: PermissionMissingError[] };

async function readSignups(
  ctx: OAuthContext,
  credential: OAuthCredential,
  origin: string,
  organizationId: string,
  from: string,
  to: string,
): Promise<SignupRead> {
  let projects: Project[];
  try {
    const listing = await apiGet(
      ctx,
      credential,
      origin,
      `/api/organizations/${encodeURIComponent(organizationId)}/projects/`,
      { limit: String(MAX_SIGNUP_PROJECTS) },
      ProjectListSchema,
    );
    projects = listing.results;
    if (listing.next != null) {
      ctx.logger.warn("posthog.sync.project_cap", { provider: "posthog", maxProjects: MAX_SIGNUP_PROJECTS });
    }
  } catch (error) {
    const gap = permissionGap(error, "project:read", "the project list");
    if (gap === undefined) throw error;
    return { days: [], complete: false, gaps: [gap] };
  }

  const days: SignupDay[] = [];
  const gaps: PermissionMissingError[] = [];
  // One query at a time: PostHog runs at most 3 queries per project concurrently (API queries, Rate limits).
  for (const project of projects) {
    try {
      const response = await fetchJson(
        ctx,
        new URL(`/api/projects/${project.id}/query/`, origin),
        {
          method: "POST",
          headers: { ...bearer(credential), "Content-Type": "application/json" },
          body: JSON.stringify({
            query: { kind: "HogQLQuery", query: signupQuery(from, to) },
            name: "DevMacro signups per day",
          }),
        },
        SignupQueryResponseSchema,
      );
      for (const [date, signups] of response.results) {
        days.push({ project: { id: project.id, name: project.name }, date, signups });
      }
    } catch (error) {
      const gap = permissionGap(error, "query:read", `the signup query for project ${project.id}`);
      if (gap === undefined) throw error;
      // One gap is enough: the same grant is refused for every project.
      if (gaps.length === 0) gaps.push(gap);
    }
  }
  return { days, complete: gaps.length === 0, gaps };
}

export const postHogAdapter: ProviderAdapter = {
  id: "posthog",
  displayName: PROVIDER_NAMES.posthog,
  capabilities: {
    oauth: true,
    polling: true,
    // No webhooks for OAuth apps (#115).
    webhooks: false,
    usage: true,
    spending: true,
    allowance: true,
    credits: false,
    revenue: false,
    events: true,
  },
  permissions: [
    {
      scope: "billing:read",
      access: "read",
      description:
        "Read the organization's billing: spend so far, projected spend, and each product's usage, free allocation, and billing limit.",
    },
    { scope: "organization:read", access: "read", description: "Read the names of the organizations you connect." },
    { scope: "project:read", access: "read", description: "Read the names of the projects in those organizations." },
    {
      scope: "query:read",
      access: "read",
      description:
        "Run one read-only query a day per project that counts new people per day. DevMacro keeps only the counts, never names, emails, properties, or ids of people.",
    },
  ],
  dataCollected: [
    "Spend so far and projected spend for the billing period",
    "Usage, free allocation, and spend per product",
    "When a product nears or reaches its billing limit",
    "Signups per project per day",
    "Organization and project names",
  ],
  eventTypes,
  achievements,
  signupDailyTotals: [SIGNUP_METRIC_KEY],
  projectedSpend: [PROJECTED_SPEND_METRIC_KEY],
  oauth: {
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    revokeUrl: REVOKE_URL,
    scopes: SCOPES,
    pkce: true,
    // The client id is the URL of the metadata document this deployment serves (CLIENT_METADATA_PATH).
    clientIdEnv: "POSTHOG_OAUTH_CLIENT_ID",
    // PostHog issues no client secret to a metadata-document client; the private key that signs
    // client assertions takes that role (./client-auth.ts).
    clientSecretEnv: "POSTHOG_OAUTH_PRIVATE_KEY",
  },
  // Hourly: billing usage is not real time, and signups are counted once per completed UTC day.
  pollIntervalSeconds: 3600,

  buildAuthorizeUrl({ client, state, redirectUri, codeChallenge }) {
    if (codeChallenge === undefined) throw new TypeError("PostHog requires a PKCE S256 code challenge");
    if (state.length === 0) throw new RangeError("state must not be empty");
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    // Always explicit: never let the scope default by omission.
    url.searchParams.set("scope", SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // Billing is per organization, so the user picks organizations, not single projects
    // (OAuth development guide, Access levels).
    url.searchParams.set("required_access_level", "organization");
    return url;
  },

  async exchangeCode({ code, redirectUri, codeVerifier }, ctx) {
    if (codeVerifier === undefined || !CODE_VERIFIER.test(codeVerifier)) {
      throw new TypeError("PostHog requires a PKCE code verifier of 43 to 128 unreserved characters");
    }
    const tokens = await requestTokens(ctx, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    const region = await detectRegion(ctx, tokens.access_token);
    return toCredential(tokens, ctx, region, SCOPES);
  },

  async refreshTokens(credential, ctx) {
    if (credential.refreshToken === undefined) {
      throw new AuthRevokedError("PostHog connection has no refresh token; reconnect required");
    }
    const region = regionOf(credential);
    const tokens = await requestTokens(ctx, {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken.reveal(),
    });
    // Whether PostHog rotates refresh tokens is unverified: a returned one replaces the old one.
    return toCredential(tokens, ctx, region, credential.scopes, credential);
  },

  /** Revokes the grant through the refresh token (RFC 7009), signed like every token call. */
  async revoke(credential, ctx) {
    if (credential.refreshToken === undefined) {
      ctx.logger.warn("posthog.revoke.no_refresh_token", { provider: "posthog" });
      return;
    }
    // RFC 7009 answers 200 with an empty body; fetchJson expects JSON, so an empty success body is
    // read as JSON null. Error statuses pass through untouched and keep fetchJson's mapping.
    const emptyBodyFetch: FetchLike = async (input, init) => {
      const response = await ctx.fetch(input, init);
      if (!response.ok) return response;
      const text = await response.clone().text();
      return text.trim().length === 0 ? new Response("null", { status: response.status, headers: response.headers }) : response;
    };
    await fetchJson(
      { ...ctx, fetch: emptyBodyFetch },
      REVOKE_URL,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          token: credential.refreshToken.reveal(),
          token_type_hint: "refresh_token",
          ...clientAuthentication(ctx),
        }).toString(),
      },
      z.unknown(),
    );
  },

  /**
   * The organizations the grant covers. Whether PostHog already narrows `/api/organizations/` to
   * `scoped_organizations` is unverified, so the list is filtered here too: an organization outside
   * the grant would only answer 403 on every read.
   */
  async listAccounts(credential, ctx): Promise<ExternalAccount[]> {
    const origin = REGION_ORIGINS[regionOf(credential)];
    const listing = await apiGet(
      ctx,
      credential,
      origin,
      "/api/organizations/",
      { limit: String(ORGANIZATION_PAGE_LIMIT) },
      OrganizationListSchema,
    );
    if (listing.next != null) {
      ctx.logger.warn("posthog.organizations_truncated", { provider: "posthog", kept: ORGANIZATION_PAGE_LIMIT });
    }
    const granted = credential.metadata?.[ORGANIZATIONS_METADATA_KEY]?.split(",");
    return listing.results
      .filter((organization) => granted === undefined || granted.includes(organization.id))
      .map((organization) => ({
        externalId: organization.id,
        displayName: organization.name,
        kind: "organization",
      }));
  },

  detectMissingPermissions(grant) {
    return SCOPES.filter((scope) => !grant.scopes.includes(scope));
  },

  async sync({ credential, externalAccountId, cursor }: SyncInput, ctx): Promise<SyncResult> {
    const region = regionOf(credential);
    const origin = REGION_ORIGINS[region];
    const retrievedAt = ctx.now();
    const metrics: AdapterMetric[] = [];
    const events: ActivityEvent[] = [];
    const partialErrors: PermissionMissingError[] = [];

    // Billing is refused without billing access in the organization, and whether a metadata
    // document app can be granted billing:read at all is unconfirmed (#11). Either way it is a
    // partial result, so signups still sync.
    try {
      const billing = await apiGet(
        ctx,
        credential,
        origin,
        "/api/billing/",
        { organization_id: externalAccountId, include_forecasting: "true" },
        BillingResponseSchema,
      );
      metrics.push(...billingMetrics(billing, externalAccountId, retrievedAt, region));
      events.push(...usageLimitEvents(billing, externalAccountId, retrievedAt, region));
    } catch (error) {
      // With billing:read granted, the refusal is the member's: PostHog reads billing only for
      // members with billing access (ee/api/billing.py, `user_has_billing_access`). The scope stays
      // listed so the connection still shows billing as unavailable.
      const gap = permissionGap(
        error,
        "billing:read",
        "the billing overview",
        credential.scopes.includes("billing:read")
          ? "PostHog refused the billing overview for this member. Reading billing needs billing access in the PostHog organization."
          : undefined,
      );
      if (gap === undefined) throw error;
      partialErrors.push(gap);
    }

    // Signups for every completed UTC day not reported yet, at most SIGNUP_BACKFILL_DAYS back.
    const todayStart = Math.floor(retrievedAt.getTime() / DAY_MS) * DAY_MS;
    const yesterday = utcDate(todayStart - DAY_MS);
    const through = readCursor(cursor, ctx);
    const earliest = todayStart - SIGNUP_BACKFILL_DAYS * DAY_MS;
    const fromMs = through === undefined ? earliest : Math.max(earliest, Date.parse(`${through}T00:00:00.000Z`) + DAY_MS);
    let nextCursor = cursor;
    if (fromMs < todayStart) {
      const signups = await readSignups(ctx, credential, origin, externalAccountId, utcDate(fromMs), utcDate(todayStart));
      partialErrors.push(...signups.gaps);
      if (signups.complete) {
        events.push(...signupEvents(signups.days, externalAccountId, region));
        metrics.push(signupMetric(signups.days, yesterday, externalAccountId, retrievedAt, region));
        nextCursor = JSON.stringify({ v: 1, through: yesterday });
      }
    }

    return {
      metrics,
      events,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
      ...(partialErrors.length === 0 ? {} : { partialErrors }),
    };
  },
};
