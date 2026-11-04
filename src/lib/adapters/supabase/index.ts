import { z } from "zod";
import { PROVIDER_NAMES } from "@/lib/providers";
import { InvalidResponseError, PermissionMissingError, fetchJson } from "../errors";
import type { ActivityEvent, EventType } from "../events";
import type { AdapterMetric } from "../metrics";
import {
  Secret,
  type AdapterContext,
  type ExternalAccount,
  type OAuthContext,
  type OAuthCredential,
  type ProviderAdapter,
} from "../types";
import {
  ActionCountRowSchema,
  ActiveUsersRowSchema,
  EntitlementsSchema,
  HealthSchema,
  NumericEntitlementConfigSchema,
  OrganizationProjectsSchema,
  OrganizationSchema,
  OrganizationsSchema,
  ProjectSchema,
  SignupRowSchema,
  TokenResponseSchema,
  logsResponseSchema,
  type LogTimestamp,
  type ServiceHealth,
  type TokenResponse,
} from "./schemas";

/**
 * Supabase Management API adapter (docs/providers/supabase.md, issue #118).
 *
 * Reads the organization's plan and limits, each project's health, and auth activity counted by
 * ClickHouse from the `auth_audit_logs` source. Only counts and timestamps leave Supabase.
 */

const API_ORIGIN = "https://api.supabase.com";
const DASHBOARD_ORIGIN = "https://supabase.com/dashboard/project";

/**
 * Configured on the OAuth app, not sent per request. Never `database:read`: it unlocks
 * `POST /v1/projects/{ref}/database/query/read-only`, which runs as a `bypassrls` role with
 * `pg_read_all_data` and so reads every row, `auth.users` emails included. DevMacro needs counts,
 * not rows (page, "Why never database:read").
 */
const SCOPES = ["organizations:read", "projects:read", "analytics:read"] as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Logs appear after a short delay, so every window ends this far in the past (page, "Polling").
const SETTLE_LAG_MS = 5 * MINUTE_MS;
// The logs endpoint rejects ranges over 24 hours.
const MAX_WINDOW_MS = DAY_MS;
// Free keeps auth audit logs for 1 hour (page, "Retention per plan").
const FREE_AUDIT_RETENTION_MS = HOUR_MS;
// A window may start at most this far inside retention: 45 minutes behind on Free, per the page.
const RETENTION_SAFETY_MS = 10 * MINUTE_MS;
const MAX_WINDOWS_PER_SYNC = 8;
// Matches the `limit` in the signup query; a full page means the window is split in half.
const SIGNUP_QUERY_LIMIT = 1000;
const MAX_SIGNUP_SPLIT_DEPTH = 2;
const MAX_ORGANIZATIONS = 25;
const PROJECTS_PAGE_LIMIT = 100;
const MAX_PROJECT_PAGES_PER_ORGANIZATION = 10;
const HEALTH_SERVICES = "auth,db,rest,storage,realtime";
const HEALTH_TIMEOUT_MS = 2000;

/*
 * SQL from the page ("Queries"). The page lists `source` versus `source_name` as unverified; these
 * follow the current query guide (`source`). `actor_id` appears only inside `uniqExact()`, so no
 * user id leaves Supabase.
 */
const COUNTS_SQL = `select log_attributes['auth_audit_event.action'] as action, count() as events
from logs
where source = 'auth_audit_logs'
  and log_attributes['auth_audit_event.action'] in
    ('user_signedup', 'login', 'logout', 'user_deleted', 'token_refreshed')
group by action
limit 10`;

const SIGNUPS_SQL = `select timestamp
from logs
where source = 'auth_audit_logs'
  and log_attributes['auth_audit_event.action'] = 'user_signedup'
order by timestamp asc
limit ${SIGNUP_QUERY_LIMIT}`;

const ACTIVE_USERS_SQL = `select uniqExact(log_attributes['auth_audit_event.actor_id']) as active_users
from logs
where source = 'auth_audit_logs'
  and log_attributes['auth_audit_event.action'] in ('login', 'token_refreshed')
limit 1`;

// Exported, like the allowance vocabulary and event types below, for the local simulator (#131).
export const PRICING_SOURCE = "https://supabase.com/pricing (checked 2026-10-31)";

export const DAILY_ACTIVE_USERS_METRIC_KEY = "supabase.auth.daily_active_users";

type AllowanceSpec = Readonly<{ metricKey: string; label: string; value: number; unit: string }>;

/**
 * Plan limits with no entitlement key, taken from the pricing page and labeled estimated
 * (page, "Plan and entitlements"). Enterprise and platform limits are custom, so none apply.
 */
export const PRICING_PAGE_LIMITS: Readonly<Record<string, readonly AllowanceSpec[]>> = {
  free: [
    { metricKey: "supabase.plan.database_size", label: "Database size per project (estimated)", value: 500, unit: "MB" },
    { metricKey: "supabase.plan.monthly_active_users", label: "Monthly active users (estimated)", value: 50_000, unit: "users" },
  ],
  pro: [
    { metricKey: "supabase.plan.disk_size", label: "Disk per project (estimated)", value: 8, unit: "GB" },
    { metricKey: "supabase.plan.monthly_active_users", label: "Monthly active users (estimated)", value: 100_000, unit: "users" },
  ],
  team: [
    { metricKey: "supabase.plan.disk_size", label: "Disk per project (estimated)", value: 8, unit: "GB" },
    { metricKey: "supabase.plan.monthly_active_users", label: "Monthly active users (estimated)", value: 100_000, unit: "users" },
  ],
};

const AUDIT_RETENTION_KEY = "security.audit_logs_days";

export const ENTITLEMENT_ALLOWANCES: Readonly<
  Record<string, Readonly<{ metricKey: string; label: string; defaultUnit?: string }>>
> = {
  [AUDIT_RETENTION_KEY]: { metricKey: "supabase.plan.audit_log_retention", label: "Auth audit log retention", defaultUnit: "days" },
  "log.retention_days": { metricKey: "supabase.plan.log_retention", label: "API and database log retention", defaultUnit: "days" },
  "function.max_count": { metricKey: "supabase.plan.edge_functions", label: "Edge Functions", defaultUnit: "functions" },
  "realtime.max_concurrent_users": {
    metricKey: "supabase.plan.realtime_concurrent_users",
    label: "Realtime concurrent users",
    defaultUnit: "users",
  },
  "storage.max_file_size": { metricKey: "supabase.plan.storage_max_file_size", label: "Storage maximum file size" },
};

// Same rule as the metric model's unit field.
const UNIT_PATTERN = /^[A-Za-z][A-Za-z0-9_/-]*(?: [A-Za-z0-9_/-]+)*$/;

export const eventTypes = [
  {
    id: "supabase.auth.signup",
    label: "New signup",
    description: "A user signed up to a Supabase project. Only the time is kept.",
    shownByDefault: true,
  },
  {
    id: "supabase.auth.daily_summary",
    label: "Daily auth summary",
    description: "Logins, signups, logouts, deleted users, and active users for one UTC day.",
    shownByDefault: true,
  },
  {
    id: "supabase.project.unhealthy",
    label: "Project unhealthy",
    description: "One or more Supabase services of the project reported unhealthy.",
    shownByDefault: true,
  },
  {
    id: "supabase.project.healthy",
    label: "Project healthy again",
    description: "Every checked Supabase service of the project is healthy again.",
    shownByDefault: true,
  },
] as const satisfies readonly EventType[];

const HealthStateSchema = z.enum(["healthy", "unhealthy"]);
type HealthState = z.infer<typeof HealthStateSchema>;

const DayTallySchema = z.strictObject({
  date: z.iso.date(),
  // False when part of the day was not counted (first sync mid-day, or a gap past retention).
  complete: z.boolean(),
  logins: z.int().nonnegative(),
  logouts: z.int().nonnegative(),
  signups: z.int().nonnegative(),
  deletedUsers: z.int().nonnegative(),
});
type DayTally = z.infer<typeof DayTallySchema>;

/**
 * Opaque to the sync runner. `windowEnd` is the end of the last queried window; the day tally
 * carries counts across 15 minute windows until the UTC day ends (Free keeps logs 1 hour, so a
 * full-day count query is not possible there), and `health` drives change-only health events.
 */
const CursorSchema = z.strictObject({
  v: z.literal(1),
  windowEnd: z.iso.datetime(),
  day: DayTallySchema.optional(),
  health: HealthStateSchema.optional(),
});
type Cursor = z.infer<typeof CursorSchema>;

type HttpContext = Pick<AdapterContext, "fetch" | "now" | "timeoutMs">;

/**
 * Supabase reports when a rate limit resets in `X-RateLimit-Reset` (seconds) rather than
 * `Retry-After`, so a 429 carrying only the former is given the latter for `fetchJson` to read.
 */
function httpContext(ctx: OAuthContext): HttpContext {
  return {
    now: ctx.now,
    timeoutMs: ctx.timeoutMs,
    fetch: async (input, init) => {
      const response = await ctx.fetch(input, init);
      const reset = response.headers.get("x-ratelimit-reset");
      if (response.status !== 429 || response.headers.has("retry-after") || reset === null) return response;
      if (!/^\d+$/.test(reset.trim())) return response;
      const headers = new Headers(response.headers);
      headers.set("retry-after", reset.trim());
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    },
  };
}

function apiUrl(path: string, query: Readonly<Record<string, string>> = {}): URL {
  const url = new URL(path, API_ORIGIN);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

function getJson<T>(
  http: HttpContext,
  credential: OAuthCredential,
  url: URL,
  schema: z.ZodType<T>,
): Promise<T> {
  const headers = { Accept: "application/json", Authorization: `Bearer ${credential.accessToken.reveal()}` };
  return fetchJson(http, url, { method: "GET", headers }, schema);
}

function requestToken(ctx: OAuthContext, form: URLSearchParams): Promise<TokenResponse> {
  return fetchJson(
    httpContext(ctx),
    apiUrl("/v1/oauth/token"),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${btoa(`${ctx.client.clientId}:${ctx.client.clientSecret.reveal()}`)}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    },
    TokenResponseSchema,
  );
}

function toCredential(token: TokenResponse, now: Date, previousRefreshToken?: Secret): OAuthCredential {
  // The token response carries no scope: scopes are fixed on the OAuth app (page, "Scopes and
  // why"), so the grant is the app's configured set. A scope removed from the app surfaces as a
  // 403 at use time.
  const refreshToken = token.refresh_token === undefined ? previousRefreshToken : new Secret(token.refresh_token);
  return {
    accessToken: new Secret(token.access_token),
    ...(refreshToken === undefined ? {} : { refreshToken }),
    // Lifetime is undocumented (page, Unverified), so expiry always comes from `expires_in`.
    expiresAt: new Date(now.getTime() + token.expires_in * 1000),
    scopes: [...SCOPES],
    tokenType: token.token_type,
  };
}

function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// The logs endpoint takes `2026-10-31T09:00:00Z`; windows are whole minutes because it rounds to one.
function isoMinute(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

const numberFormat = new Intl.NumberFormat("en-GB");

/** "1 login", "1,234 logins". Exported for the local simulator's daily summary (#131). */
export function counted(value: number, singular: string, plural: string): string {
  return `${numberFormat.format(value)} ${value === 1 ? singular : plural}`;
}

function projectUrl(ref: string): string {
  return `${DASHBOARD_ORIGIN}/${encodeURIComponent(ref)}`;
}

type PlanFacts = Readonly<{
  plan: string | undefined;
  auditRetentionMs: number;
  // An exact daily count needs one query over the whole UTC day, so retention must cover a day.
  dailyActiveUsersAllowed: boolean;
  metrics: AdapterMetric[];
  partialErrors: PermissionMissingError[];
}>;

/** A 403 on an organization read becomes a partial error; the rest of the sync continues. */
async function readOrPartial<T>(
  read: () => Promise<T>,
  partialErrors: PermissionMissingError[],
  message: string,
): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof PermissionMissingError)) throw error;
    partialErrors.push(
      new PermissionMissingError(message, ["organizations:read"], {
        cause: error,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.endpoint === undefined ? {} : { endpoint: error.endpoint }),
      }),
    );
    return undefined;
  }
}

async function readPlan(
  http: HttpContext,
  credential: OAuthCredential,
  organizationSlug: string,
  ref: string,
  now: Date,
): Promise<PlanFacts> {
  const partialErrors: PermissionMissingError[] = [];
  const slug = encodeURIComponent(organizationSlug);
  const organizationPath = `/v1/organizations/${slug}`;
  const entitlementsPath = `/v1/organizations/${slug}/entitlements`;

  // The spec lists `organization_admin_read` for both reads, so a member without the owner or
  // admin role may be refused (page, Unverified).
  const organization = await readOrPartial(
    () => getJson(http, credential, apiUrl(organizationPath), OrganizationSchema),
    partialErrors,
    "Supabase refused to show the organization's plan. Reading it may need the owner or admin role.",
  );
  const entitlements = await readOrPartial(
    () => getJson(http, credential, apiUrl(entitlementsPath), EntitlementsSchema),
    partialErrors,
    "Supabase refused to show the organization's plan limits. Reading them may need the owner or admin role.",
  );

  const plan = organization?.plan;
  const metrics: AdapterMetric[] = [];
  const base = {
    externalAccountId: ref,
    retrievedAt: now,
    timeframe: { type: "point" as const, at: now },
  };

  let auditRetentionDays: number | undefined;
  for (const entitlement of entitlements?.entitlements ?? []) {
    const spec = ENTITLEMENT_ALLOWANCES[entitlement.feature.key];
    if (spec === undefined || entitlement.type !== "numeric" || !entitlement.hasAccess) continue;
    const config = NumericEntitlementConfigSchema.safeParse(entitlement.config);
    if (!config.success) {
      throw new InvalidResponseError(`${API_ORIGIN}${entitlementsPath} returned an unexpected numeric entitlement`, {
        cause: config.error,
        endpoint: `${API_ORIGIN}${entitlementsPath}`,
      });
    }
    if (!config.data.enabled || config.data.unlimited) continue;
    if (entitlement.feature.key === AUDIT_RETENTION_KEY) {
      auditRetentionDays = config.data.value;
      // How Free's 1 hour retention appears here is unverified (page, Unverified); a value below one
      // day is not a whole-day allowance, so it is not shown as one.
      if (config.data.value < 1) continue;
    }
    const unit = UNIT_PATTERN.test(config.data.unit) ? config.data.unit : spec.defaultUnit;
    if (unit === undefined) continue;
    metrics.push({
      ...base,
      kind: "included_allowance",
      metricKey: spec.metricKey,
      label: spec.label,
      value: config.data.value,
      unit,
      provenance: { source: "provider_api", endpoint: "GET /v1/organizations/{slug}/entitlements" },
    });
  }

  for (const limit of plan === undefined ? [] : (PRICING_PAGE_LIMITS[plan] ?? [])) {
    metrics.push({
      ...base,
      kind: "included_allowance",
      metricKey: limit.metricKey,
      label: limit.label,
      value: limit.value,
      unit: limit.unit,
      provenance: { source: "derived", pricingSource: PRICING_SOURCE },
    });
  }

  // Unknown plan or unreadable retention falls back to the Free hour: the shortest retention, so
  // no window starts outside it.
  const hasDayRetention = plan !== "free" && auditRetentionDays !== undefined && auditRetentionDays >= 1;
  return {
    plan,
    auditRetentionMs: hasDayRetention && auditRetentionDays !== undefined ? auditRetentionDays * DAY_MS : FREE_AUDIT_RETENTION_MS,
    dailyActiveUsersAllowed: hasDayRetention,
    metrics,
    partialErrors,
  };
}

function healthState(services: readonly ServiceHealth[]): HealthState | undefined {
  if (services.some((service) => service.status === "UNHEALTHY")) return "unhealthy";
  if (services.length > 0 && services.every((service) => service.status === "ACTIVE_HEALTHY")) return "healthy";
  // Services still coming up say nothing new about health.
  return undefined;
}

function healthEvent(
  project: Readonly<{ ref: string; name: string }>,
  state: HealthState,
  services: readonly ServiceHealth[],
  now: Date,
): ActivityEvent {
  const shared = {
    occurredAt: now,
    externalAccountId: project.ref,
    dedupeKey: `supabase.project.${state}:${project.ref}:${utcDate(now.getTime())}`,
    url: projectUrl(project.ref),
  };
  if (state === "healthy") {
    return { ...shared, typeId: "supabase.project.healthy", severity: "success", title: `${project.name} is healthy again` };
  }
  const unhealthy = services.filter((service) => service.status === "UNHEALTHY").map((service) => service.name);
  return {
    ...shared,
    typeId: "supabase.project.unhealthy",
    severity: "critical",
    title: `${project.name} is unhealthy`,
    body: `Unhealthy services: ${unhealthy.join(", ")}.`,
  };
}

type Window = Readonly<{ start: number; end: number }>;

async function queryLogs<Row>(
  http: HttpContext,
  credential: OAuthCredential,
  ref: string,
  window: Window,
  sql: string,
  row: z.ZodType<Row>,
): Promise<Row[]> {
  const length = window.end - window.start;
  if (length <= 0 || length > MAX_WINDOW_MS) {
    throw new RangeError("Supabase log windows must be longer than zero and at most 24 hours");
  }
  const path = `/v1/projects/${encodeURIComponent(ref)}/analytics/endpoints/logs`;
  const endpoint = `${API_ORIGIN}${path}`;
  const url = apiUrl(path, {
    sql,
    iso_timestamp_start: isoMinute(window.start),
    iso_timestamp_end: isoMinute(window.end),
  });
  const body = await getJson(http, credential, url, logsResponseSchema(row)).catch((error: unknown) => {
    // 402: the organization's Logs Query allowance is used up. Not worth retrying (page, "Log query allowance").
    if (error instanceof InvalidResponseError && error.status === 402) {
      throw new InvalidResponseError(`${endpoint} refused the query: the Logs Query allowance is exceeded (402)`, {
        cause: error,
        status: 402,
        endpoint,
      });
    }
    throw error;
  });
  if (body.error !== undefined && body.error !== null) {
    // The provider's message stays in `cause`; it never reaches the error text.
    throw new InvalidResponseError(`${endpoint} reported a query error`, { cause: body.error, endpoint });
  }
  return body.result ?? [];
}

type SignupMoment = Readonly<{ timestamp: LogTimestamp }>;

async function querySignups(
  http: HttpContext,
  credential: OAuthCredential,
  ref: string,
  window: Window,
  depth: number,
  ctx: OAuthContext,
): Promise<SignupMoment[]> {
  const rows = await queryLogs(http, credential, ref, window, SIGNUPS_SQL, SignupRowSchema);
  if (rows.length >= SIGNUP_QUERY_LIMIT) {
    const middle = Math.floor((window.start + window.end) / 2 / MINUTE_MS) * MINUTE_MS;
    if (depth < MAX_SIGNUP_SPLIT_DEPTH && middle > window.start) {
      const first = await querySignups(http, credential, ref, { start: window.start, end: middle }, depth + 1, ctx);
      const second = await querySignups(http, credential, ref, { start: middle, end: window.end }, depth + 1, ctx);
      return [...first, ...second];
    }
    // The daily count still comes from `count()`, so only timeline entries are missing.
    ctx.logger.warn("supabase.signups_truncated", { projectRef: ref, windowStart: isoMinute(window.start) });
  }
  // Half-open windows, so a row on a boundary minute belongs to exactly one window.
  return rows.filter((row) => {
    const at = row.timestamp.at.getTime();
    return at >= window.start && at < window.end;
  });
}

function signupEvents(ref: string, signups: readonly SignupMoment[]): ActivityEvent[] {
  // Rows carry only a timestamp (log row ids are never selected, page "Privacy"), so the dedupe key
  // is the microsecond timestamp plus its position among identical timestamps. Windows never
  // overlap and rows are ordered, so a re-poll of the same window yields the same keys.
  const seen = new Map<string, number>();
  return signups.map((signup): ActivityEvent => {
    const ordinal = seen.get(signup.timestamp.key) ?? 0;
    seen.set(signup.timestamp.key, ordinal + 1);
    return {
      typeId: "supabase.auth.signup",
      occurredAt: signup.timestamp.at,
      severity: "success",
      title: "New signup",
      externalAccountId: ref,
      dedupeKey: `supabase.auth.signup:${ref}:${signup.timestamp.key}:${ordinal}`,
      url: projectUrl(ref),
    };
  });
}

function addCounts(tally: DayTally, rows: readonly z.infer<typeof ActionCountRowSchema>[]): DayTally {
  const next = { ...tally };
  for (const row of rows) {
    if (row.action === "login") next.logins += row.events;
    else if (row.action === "logout") next.logouts += row.events;
    else if (row.action === "user_signedup") next.signups += row.events;
    else if (row.action === "user_deleted") next.deletedUsers += row.events;
    // `token_refreshed` only feeds daily active users, which ClickHouse counts itself.
  }
  return next;
}

async function finishDay(
  tally: DayTally,
  plan: PlanFacts,
  http: HttpContext,
  credential: OAuthCredential,
  ref: string,
  now: Date,
): Promise<{ event: ActivityEvent; metric?: AdapterMetric }> {
  const dayStart = Date.parse(`${tally.date}T00:00:00Z`);
  const day: Window = { start: dayStart, end: dayStart + DAY_MS };
  const withinRetention = day.start >= now.getTime() - plan.auditRetentionMs;

  let activeUsers: number | undefined;
  let metric: AdapterMetric | undefined;
  let unavailableReason: string | undefined;
  if (!plan.dailyActiveUsersAllowed) {
    // Distinct users do not add up across windows, and keeping ids to deduplicate them breaks the
    // privacy rule, so without a full retained day there is no exact count and the metric is
    // omitted; the dashboard shows it as unavailable (page, "Windows and daily active users").
    unavailableReason =
      plan.plan === "free"
        ? "Supabase keeps auth logs for 1 hour on the Free plan."
        : "DevMacro could not read how long this organization keeps auth logs.";
  } else if (!withinRetention) {
    unavailableReason = "this day is past Supabase's auth log retention.";
  } else {
    const rows = await queryLogs(http, credential, ref, day, ACTIVE_USERS_SQL, ActiveUsersRowSchema);
    activeUsers = rows[0]?.active_users ?? 0;
    metric = {
      kind: "usage",
      metricKey: DAILY_ACTIVE_USERS_METRIC_KEY,
      label: "Daily active users",
      value: activeUsers,
      unit: "users",
      timeframe: { type: "period", start: new Date(day.start), end: new Date(day.end) },
      externalAccountId: ref,
      retrievedAt: now,
      provenance: { source: "provider_api", endpoint: "GET /v1/projects/{ref}/analytics/endpoints/logs" },
    };
  }

  const title =
    activeUsers === undefined
      ? counted(tally.logins, "login", "logins")
      : `${counted(tally.logins, "login", "logins")}, ${counted(activeUsers, "active user", "active users")}`;
  const lines = [
    `${counted(tally.signups, "new signup", "new signups")}, ${counted(tally.logouts, "logout", "logouts")}, ${counted(tally.deletedUsers, "deleted user", "deleted users")}.`,
  ];
  if (unavailableReason !== undefined) lines.push(`Daily active users unavailable: ${unavailableReason}`);
  if (!tally.complete) lines.push("Partial day: part of this day was outside Supabase's auth log retention when DevMacro polled.");

  const event: ActivityEvent = {
    typeId: "supabase.auth.daily_summary",
    occurredAt: new Date(day.start),
    severity: "info",
    title,
    body: lines.join(" "),
    externalAccountId: ref,
    dedupeKey: `supabase.auth.daily_summary:${ref}:${tally.date}`,
    url: projectUrl(ref),
  };
  return metric === undefined ? { event } : { event, metric };
}

function readCursor(raw: string | undefined, ctx: OAuthContext, ref: string): Cursor | undefined {
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
  ctx.logger.warn("supabase.cursor_invalid", { projectRef: ref });
  return undefined;
}

export const supabaseAdapter: ProviderAdapter = {
  id: "supabase",
  displayName: PROVIDER_NAMES.supabase,
  capabilities: {
    oauth: true,
    polling: true,
    webhooks: false,
    usage: true,
    // No billing endpoint carries an OAuth scope (page, "Usage and database size").
    spending: false,
    allowance: true,
    credits: false,
    revenue: false,
    events: true,
  },
  permissions: [
    { scope: "organizations:read", access: "read", description: "Read your organization name, plan, and plan limits." },
    { scope: "projects:read", access: "read", description: "Read your projects' names, regions, status, and service health." },
    {
      scope: "analytics:read",
      access: "read",
      description:
        "Read your projects' logs, including auth logs, to count signups, logins, and active users. DevMacro keeps only counts and timestamps, never emails, IP addresses, or user ids.",
    },
  ],
  dataCollected: [
    "Organization plan and plan limits",
    "Project names and service health",
    "Signups, logins, logouts, and deleted users per day",
    "The time of each signup",
    "Daily active users (Pro plan and above)",
  ],
  eventTypes,
  oauth: {
    authorizeUrl: `${API_ORIGIN}/v1/oauth/authorize`,
    tokenUrl: `${API_ORIGIN}/v1/oauth/token`,
    revokeUrl: `${API_ORIGIN}/v1/oauth/revoke`,
    scopes: SCOPES,
    pkce: true,
    clientIdEnv: "SUPABASE_OAUTH_CLIENT_ID",
    clientSecretEnv: "SUPABASE_OAUTH_CLIENT_SECRET",
  },
  // Free keeps auth audit logs for 1 hour; 15 minutes with a 5 minute settle lag stays well inside it.
  pollIntervalSeconds: 900,

  buildAuthorizeUrl({ client, state, redirectUri, codeChallenge }) {
    if (codeChallenge === undefined) throw new TypeError("Supabase requires a PKCE code challenge");
    const url = new URL(`${API_ORIGIN}/v1/oauth/authorize`);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // No `scope`: deprecated, scopes are set on the OAuth app (page, "Authorize").
    return url;
  },

  async exchangeCode({ code, redirectUri, codeVerifier }, ctx) {
    if (codeVerifier === undefined) throw new TypeError("Supabase requires a PKCE code verifier");
    // Supabase sends only `code` and `state` to the callback, so no callback parameter is read.
    const token = await requestToken(
      ctx,
      new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier }),
    );
    return toCredential(token, ctx.now());
  },

  async refreshTokens(credential, ctx) {
    if (credential.refreshToken === undefined) {
      throw new TypeError("This Supabase credential has no refresh token");
    }
    // Rotation is undocumented (page, Unverified): keep a returned refresh token, else the old one.
    // A 401 here means the app was revoked and surfaces as AuthRevokedError from fetchJson.
    const token = await requestToken(
      ctx,
      new URLSearchParams({ grant_type: "refresh_token", refresh_token: credential.refreshToken.reveal() }),
    );
    return toCredential(token, ctx.now(), credential.refreshToken);
  },

  async revoke(credential, ctx) {
    if (credential.refreshToken === undefined) return;
    try {
      await fetchJson(
        httpContext(ctx),
        apiUrl("/v1/oauth/revoke"),
        {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: ctx.client.clientId,
            client_secret: ctx.client.clientSecret.reveal(),
            refresh_token: credential.refreshToken.reveal(),
          }),
        },
        z.unknown(),
      );
    } catch (error) {
      // Success is `204` with no body, which fetchJson reports as a body that is not JSON.
      if (error instanceof InvalidResponseError && error.status === 204) return;
      throw error;
    }
  },

  async listAccounts(credential, ctx) {
    const http = httpContext(ctx);
    // Called at connect time only: this endpoint's rate limit is shared across the OAuth app.
    const organizations = await getJson(http, credential, apiUrl("/v1/organizations"), OrganizationsSchema);
    if (organizations.length > MAX_ORGANIZATIONS) {
      ctx.logger.warn("supabase.organizations_truncated", { organizations: organizations.length, kept: MAX_ORGANIZATIONS });
    }

    const accounts = new Map<string, ExternalAccount>();
    for (const organization of organizations.slice(0, MAX_ORGANIZATIONS)) {
      const path = `/v1/organizations/${encodeURIComponent(organization.slug)}/projects`;
      for (let page = 0; page < MAX_PROJECT_PAGES_PER_ORGANIZATION; page += 1) {
        const offset = page * PROJECTS_PAGE_LIMIT;
        const response = await getJson(
          http,
          credential,
          apiUrl(path, { offset: String(offset), limit: String(PROJECTS_PAGE_LIMIT), sort: "name_asc" }),
          OrganizationProjectsSchema,
        );
        for (const project of response.projects) {
          // Preview branches are short-lived copies of a project, not projects to watch.
          if (project.is_branch) continue;
          accounts.set(project.ref, { externalId: project.ref, displayName: project.name, kind: "project" });
        }
        const done = response.projects.length === 0 || offset + response.projects.length >= response.pagination.count;
        if (done) break;
        if (page === MAX_PROJECT_PAGES_PER_ORGANIZATION - 1) {
          ctx.logger.warn("supabase.projects_truncated", { organization: organization.slug, total: response.pagination.count });
        }
      }
    }
    return [...accounts.values()];
  },

  detectMissingPermissions(grant) {
    return SCOPES.filter((scope) => !grant.scopes.includes(scope));
  },

  async sync({ credential, externalAccountId: ref, cursor: rawCursor }, ctx) {
    const http = httpContext(ctx);
    const now = ctx.now();
    const project = await getJson(
      http,
      credential,
      apiUrl(`/v1/projects/${encodeURIComponent(ref)}`),
      ProjectSchema,
    );
    const plan = await readPlan(http, credential, project.organization_slug, ref, now);
    const metrics: AdapterMetric[] = [...plan.metrics];
    const events: ActivityEvent[] = [];
    const partial = plan.partialErrors.length === 0 ? {} : { partialErrors: plan.partialErrors };
    const cursor = readCursor(rawCursor, ctx, ref);

    // Paused projects have no logs or health to read; the cursor waits for them to resume.
    if (project.status === "INACTIVE") {
      return { metrics, events, ...(cursor === undefined ? {} : { cursor: JSON.stringify(cursor) }), ...partial };
    }

    const services = await getJson(
      http,
      credential,
      apiUrl(`/v1/projects/${encodeURIComponent(ref)}/health`, {
        services: HEALTH_SERVICES,
        timeout_ms: String(HEALTH_TIMEOUT_MS),
      }),
      HealthSchema,
    );
    const observed = healthState(services);
    const previousHealth = cursor?.health;
    // A first healthy reading is not news; a first unhealthy one is.
    if (observed !== undefined && observed !== previousHealth && !(previousHealth === undefined && observed === "healthy")) {
      events.push(healthEvent(project, observed, services, now));
    }

    const settledEnd = Math.floor((now.getTime() - SETTLE_LAG_MS) / MINUTE_MS) * MINUTE_MS;
    const oldestAllowed =
      Math.ceil((now.getTime() - plan.auditRetentionMs + RETENTION_SAFETY_MS) / MINUTE_MS) * MINUTE_MS;
    let windowStart: number;
    let gapped = false;
    if (cursor === undefined) {
      windowStart = Math.max(startOfUtcDay(settledEnd), oldestAllowed);
    } else {
      windowStart = Date.parse(cursor.windowEnd);
      if (windowStart < oldestAllowed) {
        // Older logs are gone, so the gap is recorded on the day instead of counted as zero.
        ctx.logger.warn("supabase.auth_logs_gap", {
          projectRef: ref,
          missedFrom: isoMinute(windowStart),
          missedUntil: isoMinute(oldestAllowed),
        });
        windowStart = oldestAllowed;
        gapped = true;
      }
    }

    let tally = cursor?.day;
    for (let windows = 0; windows < MAX_WINDOWS_PER_SYNC && windowStart < settledEnd; windows += 1) {
      const dayStart = startOfUtcDay(windowStart);
      const dayEnd = dayStart + DAY_MS;
      // Never crosses UTC midnight, so it is at most 24 hours and belongs to one day's tally.
      const window: Window = { start: windowStart, end: Math.min(dayEnd, settledEnd) };
      const date = utcDate(dayStart);

      if (tally !== undefined && tally.date !== date) {
        // Only a gap moves past a day before its last window ran, so that day is partial.
        const finished = await finishDay({ ...tally, complete: false }, plan, http, credential, ref, now);
        events.push(finished.event);
        if (finished.metric !== undefined) metrics.push(finished.metric);
        tally = undefined;
      }
      if (tally === undefined) {
        const complete = window.start === dayStart;
        tally = { date, complete, logins: 0, logouts: 0, signups: 0, deletedUsers: 0 };
      } else if (gapped) tally = { ...tally, complete: false };
      gapped = false;

      const counts = await queryLogs(http, credential, ref, window, COUNTS_SQL, ActionCountRowSchema);
      const signups = await querySignups(http, credential, ref, window, 0, ctx);
      tally = addCounts(tally, counts);
      events.push(...signupEvents(ref, signups));
      windowStart = window.end;

      if (window.end === dayEnd) {
        const finished = await finishDay(tally, plan, http, credential, ref, now);
        events.push(finished.event);
        if (finished.metric !== undefined) metrics.push(finished.metric);
        tally = undefined;
      }
    }

    const health = observed ?? previousHealth;
    const next: Cursor = {
      v: 1,
      windowEnd: isoMinute(windowStart),
      ...(tally === undefined ? {} : { day: tally }),
      ...(health === undefined ? {} : { health }),
    };
    return { metrics, events, cursor: JSON.stringify(next), ...partial };
  },
};
