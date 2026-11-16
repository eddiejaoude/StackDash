import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import { PROVIDER_NAMES } from "@/lib/providers";
import type { Achievement } from "../achievements";
import { AuthRevokedError, fetchJson, InvalidResponseError, PermissionMissingError } from "../errors";
import type { ActivityEvent, EventSeverity, EventType } from "../events";
import type { AdapterMetric, Timeframe } from "../metrics";
import {
  Secret,
  type ExternalAccount,
  type FetchLike,
  type OAuthContext,
  type OAuthCredential,
  type ProviderAdapter,
  type SyncInput,
  type SyncResult,
  type WebhookOutcome,
  type WebhookRequest,
  type WebhookVerification,
} from "../types";
import { hmacHex, isFresh, readDeliveryId, safeEqual } from "@/lib/webhooks/signature";
import {
  INSTALLATION_ID_PATTERN,
  InstallationWebhookSchema,
  IssuesPageSchema,
  IssueWebhookSchema,
  ProjectsPageSchema,
  ReleasesPageSchema,
  SHORT_ID_PATTERN,
  StatsResponseSchema,
  TokenResponseSchema,
  type Issue,
  type Release,
  type StatsResponse,
} from "./schemas";

/**
 * Sentry adapter (adapter pattern over the Sentry REST API), per docs/providers/sentry.md, #117.
 *
 * Connects through a Sentry public integration (integration platform): the external install URL
 * with `state`, then Sentry redirects back with `code`, `installationId`, and `orgSlug`. Tokens
 * last 8 hours and are refreshed with the JWT bearer grant Sentry recommends, so no refresh token
 * is stored. Sentry has no revocation endpoint for integrators; the user uninstalls in Sentry.
 *
 * One external account is one Sentry project. Sync reads only GET endpoints: error counts by
 * outcome from `stats_v2`, issues from the organization issue search (new, regressed, and
 * resolved), and releases. Issue titles, messages, and event data are never read or stored.
 *
 * Webhooks (#421): the integration's one webhook URL receives `issue` and `installation`
 * deliveries, signed with `Sentry-Hook-Signature`, the hex HMAC SHA-256 of the raw body keyed with
 * the client secret. Sentry signs the body only: neither `Request-ID` (the delivery id) nor
 * `Sentry-Hook-Timestamp` is covered. So the id deduplicates honest repeats only, and the
 * timestamp's window bounds only a delivery delayed in transit: a captured delivery replayed under
 * a fresh id and timestamp passes `verify`. What bounds such a replay is each event's dedupe key,
 * shared with the sync (a replayed new issue, resolution, or same-day regression stores nothing new),
 * and for an uninstall the installation id, which a reconnect replaces.
 */

const API_ORIGIN = "https://sentry.io";
const API_BASE = `${API_ORIGIN}/api/0`;
const USER_AGENT = "StackDash";

export const SENTRY_SCOPES = ["org:read", "event:read", "project:read"] as const;
type SentryScope = (typeof SENTRY_SCOPES)[number];

const SLUG_EXTRA_KEY = "integrationSlug";
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
// Callback values, untrusted until Sentry accepts them (INSTALLATION_ID_PATTERN, ./schemas.ts, for
// the installation id).
const ORG_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const PROJECT_ID_PATTERN = /^\d+$/;

// Webhook headers Sentry sends with every delivery (docs/providers/sentry.md, Webhooks).
export const SENTRY_WEBHOOK_HEADERS = {
  delivery: "request-id",
  resource: "sentry-hook-resource",
  timestamp: "sentry-hook-timestamp",
  signature: "sentry-hook-signature",
} as const;
// Sentry documents no tolerance; it stamps the time as it sends, in whole seconds. Five minutes, as
// the other providers' documented windows, absorbs clock skew without keeping old deliveries.
export const SENTRY_WEBHOOK_TOLERANCE_SECONDS = 300;

// Credential metadata keys written by `exchangeCode` and read by every later call.
export const metadataKeys = {
  installationId: "installationId",
  organizationSlug: "organizationSlug",
} as const;

const JWT_BEARER_GRANT = "urn:sentry:params:oauth:grant-type:jwt-bearer";
// Sentry's example signs the refresh JWT for one minute.
const JWT_LIFETIME_SECONDS = 60;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const PAGE_SIZE = 100;
// Bounded listing: at most 500 projects, the most accounts one connection stores.
export const MAX_PROJECT_PAGES = 5;
// Unresolved issues remembered per project, so a later sync can see them resolved. One page of
// the resolved lookup, which takes at most 100 results.
export const MAX_TRACKED_ISSUES = PAGE_SIZE;
// The first sync reads the last day of new issues and releases; a sync after a long pause catches
// up at most a week.
const FIRST_SYNC_LOOKBACK_MS = DAY_MS;
const MAX_LOOKBACK_MS = 7 * DAY_MS;
// Re-read a little before the last sync: an event can reach the issue search a few minutes after
// Sentry received it. Dedupe keys make the overlap idempotent.
const OVERLAP_MS = 10 * MINUTE_MS;
// Issue search only finds issues seen inside `statsPeriod`, so a tracked issue is dropped before
// it falls out of that window.
const ISSUE_SEARCH_PERIOD = "14d";
const TRACK_TTL_MS = 13 * DAY_MS;

const VERSION_TITLE_MAX = 120;

// Exported, like the metric and event builders below, for the local simulator (#131).
// None has a category for the headline (#173): issues are neither signups nor deploys, and a
// release is a version Sentry was told about, not a deployment of it, so it is not counted as one.
export const eventTypes = [
  {
    id: "sentry.issue.created",
    label: "New issue",
    description: "Sentry saw an error or problem for the first time and opened a new issue.",
    shownByDefault: true,
    emoji: "🐛",
  },
  {
    id: "sentry.issue.regressed",
    label: "Issue regressed",
    description: "An issue that was resolved started happening again.",
    shownByDefault: true,
    emoji: "🐞",
  },
  {
    id: "sentry.issue.resolved",
    label: "Issue resolved",
    description: "An issue was marked resolved in Sentry.",
    shownByDefault: true,
    emoji: "✅",
  },
  {
    id: "sentry.release.created",
    label: "New release",
    description: "A new release was created in Sentry for the project.",
    shownByDefault: true,
    emoji: "📦",
  },
] as const satisfies readonly EventType[];

// Achievements (#413), evaluated per project from stored events (docs/adapters.md, "Achievements").
const achievements: readonly Achievement[] = [
  {
    id: "sentry.issues.resolved_first",
    title: "First Sentry issue resolved",
    publicTitle: "First Sentry issue resolved",
    description: "Earned when StackDash records the first resolved Sentry issue.",
    rule: { kind: "event_count", typeIds: ["sentry.issue.resolved"], count: 1 },
  },
  {
    id: "sentry.issues.resolved_100",
    title: "100 Sentry issues resolved",
    publicTitle: "100 Sentry issues resolved",
    description: "Earned when StackDash records the 100th resolved Sentry issue.",
    rule: { kind: "event_count", typeIds: ["sentry.issue.resolved"], count: 100 },
  },
  {
    id: "sentry.issues.bug_squasher",
    title: "Bug squasher: 10 issues resolved in one day",
    publicTitle: "Bug squasher: 10 issues resolved in one day",
    description: "Earned when StackDash records 10 resolved Sentry issues on one London calendar day.",
    rule: { kind: "events_in_window", typeIds: ["sentry.issue.resolved"], count: 10, window: "day" },
  },
  {
    id: "sentry.releases.first",
    title: "First Sentry release recorded",
    publicTitle: "First Sentry release recorded",
    description: "Earned when StackDash records the first new Sentry release.",
    rule: { kind: "event_count", typeIds: ["sentry.release.created"], count: 1 },
  },
  {
    id: "sentry.releases.10",
    title: "10 Sentry releases recorded",
    publicTitle: "10 Sentry releases recorded",
    description: "Earned when StackDash records the 10th new Sentry release.",
    rule: { kind: "event_count", typeIds: ["sentry.release.created"], count: 10 },
  },
];

export const errorOutcomes = [
  { outcome: "accepted", metricKey: "sentry.errors.accepted", label: "Errors accepted, last 24 hours" },
  { outcome: "filtered", metricKey: "sentry.errors.filtered", label: "Errors filtered, last 24 hours" },
  { outcome: "rate_limited", metricKey: "sentry.errors.rate_limited", label: "Errors rate limited, last 24 hours" },
] as const;

export type ErrorOutcome = (typeof errorOutcomes)[number]["outcome"];

const STATS_ENDPOINT = `${API_BASE}/organizations/{organization}/stats_v2/`;

type Installation = Readonly<{ installationId: string; organizationSlug: string }>;

/** The installation and organization stored with the grant by `exchangeCode`. */
function readInstallation(credential: OAuthCredential): Installation {
  const installationId = credential.metadata?.[metadataKeys.installationId];
  const organizationSlug = credential.metadata?.[metadataKeys.organizationSlug];
  if (
    installationId === undefined ||
    !INSTALLATION_ID_PATTERN.test(installationId) ||
    organizationSlug === undefined ||
    !ORG_SLUG_PATTERN.test(organizationSlug)
  ) {
    // Only a reconnection rebuilds the metadata, so the runner should ask for one.
    throw new AuthRevokedError("Sentry credential is missing its installation metadata; reconnect Sentry");
  }
  return { installationId, organizationSlug };
}

function tokenUrl(installationId: string): string {
  return `${API_BASE}/sentry-app-installations/${encodeURIComponent(installationId)}/authorizations/`;
}

function apiUrl(path: string, params: readonly (readonly [string, string])[] = []): URL {
  const url = new URL(`${API_BASE}${path}`);
  // `append`, not `set`: `groupBy` and `collapse` repeat.
  for (const [name, value] of params) url.searchParams.append(name, value);
  return url;
}

function organizationPath(organizationSlug: string, rest: string): string {
  return `/organizations/${encodeURIComponent(organizationSlug)}${rest}`;
}

function getJson<T>(ctx: OAuthContext, credential: OAuthCredential, url: URL, schema: z.ZodType<T>): Promise<T> {
  return fetchJson(
    ctx,
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.accessToken.reveal()}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
      },
    },
    schema,
  );
}

/**
 * Sentry paginates with a Link header (`rel="next"; results="true"; cursor="0:100:0"`) and always
 * sends a next link, so `results` says whether there is another page.
 */
export function nextPageCursor(link: string | null): string | undefined {
  if (link === null) return undefined;
  for (const part of link.split(",")) {
    if (!/;\s*rel="next"/.test(part)) continue;
    if (!/;\s*results="true"/.test(part)) return undefined;
    return /;\s*cursor="([^"]+)"/.exec(part)?.[1];
  }
  return undefined;
}

async function getPage<T>(
  ctx: OAuthContext,
  credential: OAuthCredential,
  url: URL,
  schema: z.ZodType<T>,
): Promise<{ body: T; next: string | undefined }> {
  let link: string | null = null;
  const capturingFetch: FetchLike = async (input, init) => {
    const response = await ctx.fetch(input, init);
    link = response.headers.get("link");
    return response;
  };
  const body = await getJson({ ...ctx, fetch: capturingFetch }, credential, url, schema);
  return { body, next: nextPageCursor(link) };
}

function base64UrlJson(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * The JWT Sentry's recommended manual refresh expects: HS256 with the client secret, `iss` and
 * `sub` set to the client id, valid for one minute, with a unique `jti`.
 */
function refreshJwt(ctx: OAuthContext): string {
  const clientId = ctx.client.clientId;
  const nowSeconds = Math.floor(ctx.now().getTime() / 1000);
  const unsigned = `${base64UrlJson({ alg: "HS256", typ: "JWT" })}.${base64UrlJson({
    iss: clientId,
    sub: clientId,
    iat: nowSeconds,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    jti: randomUUID(),
  })}`;
  const signature = createHmac("sha256", ctx.client.clientSecret.reveal()).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function toCredential(token: z.infer<typeof TokenResponseSchema>, installation: Installation): OAuthCredential {
  return {
    accessToken: new Secret(token.token),
    // Eight hours per the docs; taken from the response, never assumed.
    expiresAt: token.expiresAt,
    // The token response lists no scopes. A public integration is installed with every scope
    // registered on it, and the code asks for exactly these (docs/providers/sentry.md, Unverified).
    scopes: [...SENTRY_SCOPES],
    tokenType: "Bearer",
    metadata: {
      [metadataKeys.installationId]: installation.installationId,
      [metadataKeys.organizationSlug]: installation.organizationSlug,
    },
  };
}

/** Bounded project listing, in Sentry's order. */
async function listProjects(
  ctx: OAuthContext,
  credential: OAuthCredential,
  organizationSlug: string,
  maxPages: number,
): Promise<z.infer<typeof ProjectsPageSchema>> {
  const projects: z.infer<typeof ProjectsPageSchema> = [];
  let cursor: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const params: [string, string][] = [["per_page", String(PAGE_SIZE)]];
    if (cursor !== undefined) params.push(["cursor", cursor]);
    const { body, next } = await getPage(ctx, credential, apiUrl(organizationPath(organizationSlug, "/projects/"), params), ProjectsPageSchema);
    projects.push(...body);
    if (next === undefined || body.length === 0) return projects;
    if (page === maxPages - 1) ctx.logger.warn("sentry.projects.page_cap", { provider: "sentry", maxPages });
    cursor = next;
  }
  return projects;
}

/** Error counts for one project and period, one usage metric per outcome StackDash shows. */
export function errorVolumeMetrics(
  counts: Readonly<Record<ErrorOutcome, number>>,
  timeframe: Extract<Timeframe, { type: "period" }>,
  externalAccountId: string,
  retrievedAt: Date,
  endpoint: string = STATS_ENDPOINT,
): AdapterMetric[] {
  return errorOutcomes.map(({ outcome, metricKey, label }) => ({
    kind: "usage",
    metricKey,
    label,
    value: counts[outcome],
    unit: "errors",
    timeframe,
    externalAccountId,
    retrievedAt,
    provenance: { source: "provider_api", endpoint },
  }));
}

function countsByOutcome(stats: StatsResponse): Record<ErrorOutcome, number> {
  const counts: Record<ErrorOutcome, number> = { accepted: 0, filtered: 0, rate_limited: 0 };
  for (const group of stats.groups) {
    const outcome = errorOutcomes.find((entry) => entry.outcome === group.by.outcome)?.outcome;
    // Invalid, abuse, client discard, and cardinality limited are not shown (page, Data).
    if (outcome === undefined) continue;
    counts[outcome] += group.totals["sum(quantity)"] ?? 0;
  }
  return counts;
}

function isSentryLink(value: string | null | undefined): value is string {
  if (value === null || value === undefined) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
  return url.protocol === "https:" && (url.hostname === "sentry.io" || url.hostname.endsWith(".sentry.io"));
}

/** The fields an issue event is built from; titles and messages are deliberately not among them. */
export type IssueSnapshot = Pick<Issue, "id" | "shortId" | "level" | "firstSeen" | "permalink">;

function levelBody(level: string | null | undefined): { body: string } | Record<string, never> {
  const trimmed = level?.trim();
  return trimmed === undefined || trimmed.length === 0 ? {} : { body: `Level: ${trimmed}` };
}

function issueLink(issue: IssueSnapshot): { url: string } | Record<string, never> {
  return isSentryLink(issue.permalink) ? { url: issue.permalink } : {};
}

/** A new issue, dated when Sentry first saw it. */
export function issueCreatedEvent(issue: IssueSnapshot, externalAccountId: string): ActivityEvent {
  const severity: EventSeverity = issue.level === "fatal" ? "critical" : issue.level === "error" ? "warning" : "info";
  return {
    typeId: "sentry.issue.created",
    occurredAt: issue.firstSeen,
    severity,
    title: `New issue ${issue.shortId}`,
    ...levelBody(issue.level),
    externalAccountId,
    dedupeKey: `sentry.issue.created:${issue.id}`,
    ...issueLink(issue),
  };
}

/**
 * An issue that regressed or was resolved. A delivery dates it when Sentry sent it; a sync, which
 * cannot tell when the status changed, dates it when it saw the change.
 *
 * The dedupe key is the issue and the UTC day of the change, the one value a delivery and the next
 * sync both know, so the timeline stores the change once (#421). Nothing on the issue stands still
 * across a change: each new event moves `lastSeen`, and an issue resolved for a release or a commit
 * keeps receiving events from older releases while it stays resolved. So: one regression and one
 * resolution per issue per UTC day, and a change delivered in the last poll interval before
 * midnight UTC can show twice when the sync sees it after midnight (docs/providers/sentry.md,
 * Limitations).
 */
export function issueStatusEvent(
  change: "regressed" | "resolved",
  issue: IssueSnapshot,
  externalAccountId: string,
  occurredAt: Date,
): ActivityEvent {
  const regressed = change === "regressed";
  const utcDay = occurredAt.toISOString().slice(0, 10);
  const severity: EventSeverity = regressed
    ? issue.level === "fatal" || issue.level === "error"
      ? "critical"
      : "warning"
    : "success";
  return {
    typeId: regressed ? "sentry.issue.regressed" : "sentry.issue.resolved",
    occurredAt,
    severity,
    title: `Issue ${issue.shortId} ${change}`,
    ...(regressed ? levelBody(issue.level) : {}),
    externalAccountId,
    dedupeKey: `sentry.issue.${change}:${issue.id}:${utcDay}`,
    ...issueLink(issue),
  };
}

/** A release created for the project, dated when Sentry created it. */
export function releaseEvent(release: Release, externalAccountId: string): ActivityEvent {
  const version = (release.shortVersion ?? release.version).trim() || release.version;
  const shown = version.length > VERSION_TITLE_MAX ? `${version.slice(0, VERSION_TITLE_MAX)}…` : version;
  return {
    typeId: "sentry.release.created",
    occurredAt: release.dateCreated,
    severity: "info",
    title: `Release ${shown} created`,
    externalAccountId,
    // Releases belong to the organization and can span projects: one event per project.
    dedupeKey: `sentry.release.created:${externalAccountId}:${release.id}`,
  };
}

const TrackedIssueSchema = z.object({
  shortId: z.string().regex(SHORT_ID_PATTERN),
  regressed: z.boolean(),
  lastSeen: z.iso.datetime(),
});

const CursorSchema = z.object({
  v: z.literal(1),
  since: z.iso.datetime(),
  issues: z.record(z.string().regex(/^\d+$/), TrackedIssueSchema),
});

type TrackedIssue = z.infer<typeof TrackedIssueSchema>;
type Cursor = Readonly<{ since: Date; issues: Map<string, TrackedIssue> }>;

function decodeCursor(cursor: string | undefined, ctx: OAuthContext): Cursor | undefined {
  if (cursor === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    raw = undefined;
  }
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success) {
    // Our own value came back unreadable: start over as a first sync, which sends no regressed or
    // resolved events, rather than fail every future sync on it.
    ctx.logger.warn("sentry.sync.cursor_unreadable", { provider: "sentry" });
    return undefined;
  }
  return { since: new Date(parsed.data.since), issues: new Map(Object.entries(parsed.data.issues)) };
}

function encodeCursor(since: Date, issues: ReadonlyMap<string, TrackedIssue>): string {
  const sorted = [...issues.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({ v: 1, since: since.toISOString(), issues: Object.fromEntries(sorted) });
}

/** Sentry's search datetime, to the second, in UTC. */
function searchTime(at: Date): string {
  return `${at.toISOString().slice(0, 19)}Z`;
}

type SyncScope = Readonly<{
  ctx: OAuthContext;
  credential: OAuthCredential;
  organizationSlug: string;
  // The Sentry project id: one external account is one project.
  externalAccountId: string;
  retrievedAt: Date;
  since: Date;
}>;

async function searchIssues(scope: SyncScope, query: string, sort?: "new" | "date"): Promise<Issue[]> {
  const params: [string, string][] = [
    ["project", scope.externalAccountId],
    ["query", query],
    ["statsPeriod", ISSUE_SEARCH_PERIOD],
    ["limit", String(PAGE_SIZE)],
    // Drops the per-issue graphs and counters the adapter never reads.
    ["collapse", "stats"],
    ["collapse", "lifetime"],
    ["collapse", "filtered"],
    ["collapse", "unhandled"],
  ];
  if (sort !== undefined) params.push(["sort", sort]);
  const issues = await getJson(
    scope.ctx,
    scope.credential,
    apiUrl(organizationPath(scope.organizationSlug, "/issues/"), params),
    IssuesPageSchema,
  );
  if (issues.length >= PAGE_SIZE) {
    scope.ctx.logger.warn("sentry.issues.page_cap", { provider: "sentry", pageSize: PAGE_SIZE });
  }
  return issues;
}

async function collectIssues(
  scope: SyncScope,
  previous: Cursor | undefined,
): Promise<{ events: ActivityEvent[]; issues: Map<string, TrackedIssue> }> {
  const since = searchTime(scope.since);
  const created = await searchIssues(scope, `firstSeen:>=${since}`, "new");
  const active = await searchIssues(scope, `is:unresolved lastSeen:>=${since}`, "date");

  const events: ActivityEvent[] = [];
  for (const issue of created) {
    if (issue.firstSeen.getTime() >= scope.since.getTime()) events.push(issueCreatedEvent(issue, scope.externalAccountId));
  }

  const tracked = new Map(previous?.issues ?? []);
  // A first sync has no earlier state, so it records a baseline instead of reporting every issue
  // that is regressed right now as if it had just regressed.
  if (previous !== undefined) {
    const activeIds = new Set(active.map((issue) => issue.id));
    for (const issue of active) {
      if (issue.substatus === "regressed" && tracked.get(issue.id)?.regressed !== true) {
        events.push(issueStatusEvent("regressed", issue, scope.externalAccountId, scope.retrievedAt));
      }
    }
    const quiet = [...tracked.entries()].filter(([id]) => !activeIds.has(id));
    if (quiet.length > 0) {
      const shortIds = quiet.map(([, issue]) => issue.shortId).join(",");
      const resolved = await searchIssues(scope, `is:resolved issue:[${shortIds}]`);
      for (const issue of resolved) {
        if (issue.status !== "resolved" || !tracked.has(issue.id)) continue;
        events.push(issueStatusEvent("resolved", issue, scope.externalAccountId, scope.retrievedAt));
        tracked.delete(issue.id);
      }
    }
  }

  for (const issue of [...created, ...active]) {
    if (issue.status !== "unresolved") {
      tracked.delete(issue.id);
      continue;
    }
    tracked.set(issue.id, {
      shortId: issue.shortId,
      regressed: issue.substatus === "regressed",
      lastSeen: issue.lastSeen.toISOString(),
    });
  }
  const oldest = scope.retrievedAt.getTime() - TRACK_TTL_MS;
  const kept = [...tracked.entries()]
    .filter(([, issue]) => Date.parse(issue.lastSeen) >= oldest)
    .sort(([, a], [, b]) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
    .slice(0, MAX_TRACKED_ISSUES);
  return { events, issues: new Map(kept) };
}

async function collectErrorVolume(scope: SyncScope): Promise<AdapterMetric[]> {
  const stats = await getJson(
    scope.ctx,
    scope.credential,
    apiUrl(organizationPath(scope.organizationSlug, "/stats_v2/"), [
      ["field", "sum(quantity)"],
      ["groupBy", "outcome"],
      ["category", "error"],
      ["project", scope.externalAccountId],
      ["statsPeriod", "24h"],
      ["interval", "1h"],
    ]),
    StatsResponseSchema,
  );
  if (stats.end.getTime() <= stats.start.getTime()) {
    throw new InvalidResponseError("Sentry stats returned a period that does not move forward", { endpoint: STATS_ENDPOINT });
  }
  // Sentry aligns the window to whole intervals, so the returned range is the truth.
  return errorVolumeMetrics(
    countsByOutcome(stats),
    { type: "period", start: stats.start, end: stats.end },
    scope.externalAccountId,
    scope.retrievedAt,
  );
}

async function collectReleases(scope: SyncScope): Promise<ActivityEvent[]> {
  const releases = await getJson(
    scope.ctx,
    scope.credential,
    apiUrl(organizationPath(scope.organizationSlug, "/releases/"), [
      ["project", scope.externalAccountId],
      ["per_page", String(PAGE_SIZE)],
    ]),
    ReleasesPageSchema,
  );
  const recent = releases.filter((release) => release.dateCreated.getTime() >= scope.since.getTime());
  if (releases.length >= PAGE_SIZE && recent.length === releases.length) {
    scope.ctx.logger.warn("sentry.releases.page_cap", { provider: "sentry", pageSize: PAGE_SIZE });
  }
  return recent.map((release) => releaseEvent(release, scope.externalAccountId));
}

function permissionGap(error: unknown, scope: SentryScope, what: string): PermissionMissingError | undefined {
  if (!(error instanceof PermissionMissingError)) return undefined;
  return new PermissionMissingError(`Sentry refused ${what}; the integration needs ${scope}`, [scope], {
    cause: error,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.endpoint === undefined ? {} : { endpoint: error.endpoint }),
  });
}

/**
 * An uninstalled integration can no longer mint tokens. The exact status is undocumented
 * (docs/providers/sentry.md, Unverified), so 403 and 404 on the refresh are read as revoked too:
 * the runner then asks for a reconnect instead of retrying.
 */
async function withInstallationGoneAsRevoked<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (
      (error instanceof PermissionMissingError && error.status === 403) ||
      (error instanceof InvalidResponseError && error.status === 404)
    ) {
      throw new AuthRevokedError("The Sentry integration is no longer installed; reconnect Sentry", {
        cause: error,
        status: error.status,
        ...(error.endpoint === undefined ? {} : { endpoint: error.endpoint }),
      });
    }
    throw error;
  }
}

/**
 * The `Sentry-Hook-Signature` Sentry sends for a delivery: the lowercase hex HMAC SHA-256 of the
 * raw body, keyed with the client secret. Exported for the tests and the e2e spec, which sign
 * deliveries as Sentry does.
 */
export function sentryWebhookSignature(secret: Secret, rawBody: Uint8Array | string): string {
  // Signed as bytes, never decoded and re-encoded: Sentry signs the exact bytes it sends.
  return hmacHex("sha256", secret, rawBody);
}

/** `Sentry-Hook-Timestamp`, whole seconds since the epoch, or undefined when it is not one. */
function hookTimestampSeconds(headers: Headers): number | undefined {
  const text = headers.get(SENTRY_WEBHOOK_HEADERS.timestamp)?.trim();
  return text !== undefined && /^\d{1,12}$/.test(text) ? Number(text) : undefined;
}

/**
 * Headers, then freshness, then the delivery id, then the signature in constant time. None of the
 * headers is signed (see the header comment for what bounds a replay).
 */
function verifyWebhook({ headers, rawBody }: WebhookRequest, secret: Secret, now: Date): WebhookVerification {
  const signature = headers.get(SENTRY_WEBHOOK_HEADERS.signature);
  if (!signature || headers.get(SENTRY_WEBHOOK_HEADERS.timestamp) === null) return { ok: false, reason: "missing_signature" };
  const timestampSeconds = hookTimestampSeconds(headers);
  if (timestampSeconds === undefined) return { ok: false, reason: "malformed" };
  if (!isFresh(timestampSeconds, now, SENTRY_WEBHOOK_TOLERANCE_SECONDS)) return { ok: false, reason: "stale" };
  const deliveryId = readDeliveryId(headers, SENTRY_WEBHOOK_HEADERS.delivery);
  if (deliveryId === undefined) return { ok: false, reason: "malformed" };
  if (!safeEqual(signature, sentryWebhookSignature(secret, rawBody))) return { ok: false, reason: "bad_signature" };
  return { ok: true, deliveryId };
}

/**
 * Maps a verified delivery with the sync's own builders, so a pushed issue event and the same
 * event polled later share a dedupe key. `issue.created` is dated when Sentry first saw the issue,
 * a resolution and a regression (`unresolved` with substatus `regressed`) when Sentry sent the
 * delivery. `installation.deleted` names only the installation (#480): every connection granted
 * for it needs a reconnect, unless granted again after Sentry sent the delivery. `assigned`,
 * `archived`, any other `unresolved`, feedback issues (which the issue search never returns, so
 * polling never reports them either), `installation.created`, and every other resource are
 * ignored. The reasons are fixed text: nothing from the body reaches them.
 */
function parseWebhook({ headers, rawBody }: WebhookRequest): WebhookOutcome {
  const resource = headers.get(SENTRY_WEBHOOK_HEADERS.resource)?.trim();
  if (resource !== "issue" && resource !== "installation") return { kind: "ignored", reason: "resource StackDash does not read" };
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(rawBody));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { kind: "ignored", reason: "body is not JSON" };
  }
  // `verify` has already required this header to be a fresh whole number.
  const sentSeconds = hookTimestampSeconds(headers);
  if (sentSeconds === undefined) return { kind: "ignored", reason: "delivery has no timestamp" };
  const sentAt = new Date(sentSeconds * 1000);

  if (resource === "installation") {
    const installation = InstallationWebhookSchema.safeParse(raw);
    if (!installation.success) return { kind: "ignored", reason: "not an installation delivery StackDash reads" };
    if (installation.data.action !== "deleted") return { kind: "ignored", reason: "installation action StackDash does not act on" };
    return { kind: "uninstalled", by: "installation", installationId: installation.data.installation.uuid, occurredAt: sentAt };
  }

  const parsed = IssueWebhookSchema.safeParse(raw);
  if (!parsed.success) return { kind: "ignored", reason: "not an issue delivery StackDash reads" };
  const { action, data } = parsed.data;
  const { issue } = data;
  const externalAccountId = issue.project.id;
  if (issue.issueCategory === "feedback") return { kind: "ignored", reason: "feedback issues are not on the timeline" };
  if (action === "created") return { kind: "events", externalAccountId, events: [issueCreatedEvent(issue, externalAccountId)] };
  const change = action === "resolved" ? "resolved" : action === "unresolved" && issue.substatus === "regressed" ? "regressed" : undefined;
  if (change === undefined) return { kind: "ignored", reason: "issue action is not on the timeline" };
  return { kind: "events", externalAccountId, events: [issueStatusEvent(change, issue, externalAccountId, sentAt)] };
}

export const sentryAdapter: ProviderAdapter = {
  id: "sentry",
  displayName: PROVIDER_NAMES.sentry,
  capabilities: {
    oauth: true,
    polling: true,
    usage: true,
    // No spend or quota endpoint exists for integrations (docs/providers/sentry.md, Data).
    spending: false,
    allowance: false,
    credits: false,
    revenue: false,
    events: true,
  },
  permissions: [
    {
      scope: "org:read",
      access: "read",
      description:
        "Organization: the project list and error counts by outcome from the usage stats. It can also read other organization details and settings; StackDash reads only these.",
    },
    {
      scope: "event:read",
      access: "read",
      description:
        "Issues and events in every project. Events can hold anything your app sends to Sentry, such as error messages, stack traces, and user details. StackDash reads only each issue's short id, status, level, and first and last seen times, never titles, messages, or events.",
    },
    {
      scope: "project:read",
      access: "read",
      description:
        "Projects and their releases. It can also read project settings and client keys (DSNs); StackDash reads only release versions and when they were created.",
    },
  ],
  dataCollected: [
    "Error events per project over the last 24 hours: accepted, filtered, and rate limited",
    "New, regressed, and resolved issues per project (short id and level only)",
    "New releases per project (version and time)",
  ],
  eventTypes,
  achievements,
  oauth: {
    authorizeUrl: `${API_ORIGIN}/sentry-apps/{slug}/external-install/`,
    tokenUrl: `${API_BASE}/sentry-app-installations/{installationId}/authorizations/`,
    // Integration scopes are set on the integration's registration, not sent with the install URL.
    scopes: SENTRY_SCOPES,
    pkce: false,
    clientIdEnv: "SENTRY_CLIENT_ID",
    clientSecretEnv: "SENTRY_CLIENT_SECRET",
    extraEnv: { [SLUG_EXTRA_KEY]: "SENTRY_INTEGRATION_SLUG" },
  },
  // Hourly: Sentry warns that polling quickly meets its rate limits (docs/providers/sentry.md). With
  // webhooks it is the backfill, and still the only source of error volume and releases.
  pollIntervalSeconds: 3600,
  // One webhook URL on the integration's registration, signed with the client secret.
  webhooks: {
    registration: { kind: "app", secretEnv: "SENTRY_CLIENT_SECRET" },
    subscriptions: ["issue.created", "issue.resolved", "issue.unresolved", "installation.deleted"],
    verify: verifyWebhook,
    parse: parseWebhook,
  },

  buildAuthorizeUrl({ client, state }) {
    const slug = client.extra[SLUG_EXTRA_KEY]?.reveal().trim();
    if (slug === undefined || !SLUG_PATTERN.test(slug)) {
      throw new TypeError("SENTRY_INTEGRATION_SLUG must be set to the integration's slug");
    }
    // The redirect URL is fixed on the integration's registration, so it is not a parameter here.
    const url = new URL(`${API_ORIGIN}/sentry-apps/${encodeURIComponent(slug)}/external-install/`);
    url.searchParams.set("state", state);
    return url;
  },

  async exchangeCode({ code, callbackParams }, ctx) {
    const installationId = callbackParams.installationId;
    const organizationSlug = callbackParams.orgSlug;
    if (installationId === undefined || !INSTALLATION_ID_PATTERN.test(installationId)) {
      throw new InvalidResponseError("Sentry callback did not carry a valid installation id");
    }
    if (organizationSlug === undefined || !ORG_SLUG_PATTERN.test(organizationSlug)) {
      throw new InvalidResponseError("Sentry callback did not carry a valid organization slug");
    }
    // The code is bound to the installation, so a spoofed installation id fails here.
    const token = await fetchJson(
      ctx,
      tokenUrl(installationId),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          client_id: ctx.client.clientId,
          client_secret: ctx.client.clientSecret.reveal(),
        }),
      },
      TokenResponseSchema,
    );
    const credential = toCredential(token, { installationId, organizationSlug });
    // `orgSlug` is untrusted too. An integration token only reads the organization it is installed
    // on, so one page of that organization's projects proves the slug before it is stored.
    await getJson(
      ctx,
      credential,
      apiUrl(organizationPath(organizationSlug, "/projects/"), [["per_page", "1"]]),
      ProjectsPageSchema,
    );
    return credential;
  },

  /** JWT bearer refresh: needs only the client secret, so a token lost in transit is never fatal. */
  async refreshTokens(credential, ctx) {
    const installation = readInstallation(credential);
    const token = await withInstallationGoneAsRevoked(() =>
      fetchJson(
        ctx,
        tokenUrl(installation.installationId),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${refreshJwt(ctx)}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": USER_AGENT,
          },
          body: JSON.stringify({ grant_type: JWT_BEARER_GRANT }),
        },
        TokenResponseSchema,
      ),
    );
    return { ...toCredential(token, installation), scopes: credential.scopes };
  },

  async listAccounts(credential, ctx): Promise<ExternalAccount[]> {
    const { organizationSlug } = readInstallation(credential);
    const projects = await listProjects(ctx, credential, organizationSlug, MAX_PROJECT_PAGES);
    return projects.map((project) => {
      const name = project.name?.trim();
      return { externalId: project.id, displayName: name !== undefined && name.length > 0 ? name : project.slug, kind: "project" };
    });
  },

  // The installation `exchangeCode` stored, which `installation.deleted` names (#480). Null for a
  // credential whose metadata lost it or holds a value the callback check would have refused.
  installationIdOf(credential) {
    const installationId = credential.metadata?.[metadataKeys.installationId];
    return installationId !== undefined && INSTALLATION_ID_PATTERN.test(installationId) ? installationId : null;
  },

  detectMissingPermissions(grant) {
    return SENTRY_SCOPES.filter((scope) => !grant.scopes.includes(scope));
  },

  // Requests run one after another on purpose: Sentry limits concurrent requests per caller and
  // warns that polling meets its rate limits quickly (docs/providers/sentry.md, Rate limits).
  async sync({ credential, externalAccountId, cursor }: SyncInput, ctx): Promise<SyncResult> {
    const { organizationSlug } = readInstallation(credential);
    if (!PROJECT_ID_PATTERN.test(externalAccountId)) {
      throw new Error("Sentry sync was handed an external account that is not a project id");
    }
    const retrievedAt = ctx.now();
    const previous = decodeCursor(cursor, ctx);
    const since = new Date(
      previous === undefined
        ? retrievedAt.getTime() - FIRST_SYNC_LOOKBACK_MS
        : Math.max(previous.since.getTime() - OVERLAP_MS, retrievedAt.getTime() - MAX_LOOKBACK_MS),
    );
    const scope: SyncScope = {
      ctx,
      credential,
      organizationSlug,
      externalAccountId,
      retrievedAt,
      since,
    };
    const partialErrors: PermissionMissingError[] = [];
    const metrics: AdapterMetric[] = [];
    const events: ActivityEvent[] = [];
    let issues = previous?.issues ?? new Map<string, TrackedIssue>();

    try {
      metrics.push(...(await collectErrorVolume(scope)));
    } catch (error) {
      const gap = permissionGap(error, "org:read", "the usage stats");
      if (gap === undefined) throw error;
      partialErrors.push(gap);
    }

    try {
      const collected = await collectIssues(scope, previous);
      events.push(...collected.events);
      issues = collected.issues;
    } catch (error) {
      const gap = permissionGap(error, "event:read", "the issue list");
      if (gap === undefined) throw error;
      partialErrors.push(gap);
    }

    try {
      events.push(...(await collectReleases(scope)));
    } catch (error) {
      const gap = permissionGap(error, "project:read", "the release list");
      if (gap === undefined) throw error;
      partialErrors.push(gap);
    }

    // A permission gap is lasting, so the window moves on either way; any other failure threw above
    // and leaves the stored cursor where it was.
    return {
      metrics,
      events,
      cursor: encodeCursor(retrievedAt, issues),
      ...(partialErrors.length === 0 ? {} : { partialErrors }),
    };
  },
};
