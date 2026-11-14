import { z } from "zod";

import type { Severity } from "@/components/severity-badge";
import { ACHIEVEMENT_EARNED_TYPE_ID } from "@/lib/achievements/events";
import { ANOMALY_TYPE_ID } from "@/lib/alerts/anomaly";
import {
  appendScopeParams,
  EMPTY_SCOPE,
  hasScopeFilters,
  paramValues,
  repeatedParam,
  ScopeSearchParamsSchema,
  type ScopeFilters,
  type ScopeOption,
  type ScopeOptions,
} from "@/lib/filters/scope";
import { formatDateTime } from "@/lib/format";
import { providerName, typeOwnerName } from "@/lib/providers";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Pure parsing for the timeline URL (`?type=..&severity=..&from=..&to=..&start=..&until=..&q=..&cursor=..&event=..`)
 * and its keyset cursor. `start` and `until` are a half-open pair of instants (the activity
 * overview's selected period) that counts only when both are valid and `start` is before `until`.
 * `event` selects the event shown in the inspector and is not a filter: it never changes the feed,
 * its counts, or its cursor. Nothing here touches the database, so every boundary is unit tested.
 * Anything invalid in the URL is dropped rather than failing the page: a hand-edited or stale link
 * still shows the timeline.
 */

export type EventSeverity = Database["public"]["Enums"]["event_severity"];

export const TIMELINE_PAGE_SIZE = 50;

/**
 * Most type ids one URL may filter on, and most the type picker offers (`listTimelineTypeIds`),
 * so every offered type can be ticked at once. Every type comes from an adapter's declared types or
 * StackDash's own, about 60 today. The ids travel in the event list's PostgREST query string
 * (`type_id=in.(...)`), so the bound also keeps that URL a few kilobytes long.
 */
export const MAX_TYPE_FILTERS = 100;

export const EVENT_SEVERITIES = ["info", "success", "warning", "critical"] as const satisfies readonly EventSeverity[];

// The badge vocabulary shared with the landing page. The filter uses the same words as each event
// row: success, warning, and critical rows show theirs as a pill, while an info row's "Event" is
// screen-reader text only, so quiet rows carry no pill (#385). The event details show the pill for
// every severity.
const SEVERITY_BADGE: Record<EventSeverity, Severity> = {
  info: "Event",
  success: "Success",
  warning: "Warning",
  critical: "Critical",
};

export function severityBadge(severity: EventSeverity): Severity {
  return SEVERITY_BADGE[severity];
}

// Same shape adapters declare (`AdapterScopedKeySchema`): lowercase, dotted, bounded. It also
// keeps ids safe to place in a PostgREST `in (...)` list.
const TYPE_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;
const MAX_TYPE_ID_LENGTH = 100;

export function isEventTypeId(value: string): value is string {
  return value.length <= MAX_TYPE_ID_LENGTH && TYPE_ID_PATTERN.test(value);
}

// StackDash's own types whose id reads differently from the product's name for them (#345): alert
// settings calls these "unusual spend and usage", so the timeline must not say "anomaly". An
// achievement entry (#413) is named by its label, which the type filter repeats so a member can
// find and hide it by the same words.
const STACKDASH_TYPE_LABELS: ReadonlyMap<string, string> = new Map([
  [ANOMALY_TYPE_ID, "Unusual spend or usage"],
  [ACHIEVEMENT_EARNED_TYPE_ID, "Achievement earned"],
]);

/** `vercel.deployment_failed` reads as "Deployment failed". The provider is shown beside it. */
export function eventTypeLabel(typeId: string): string {
  const named = STACKDASH_TYPE_LABELS.get(typeId);
  if (named !== undefined) return named;
  const rest = typeId.split(".").slice(1).join(" ").replaceAll("_", " ").trim();
  if (rest === "") return typeId;
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written `YYYY-MM-DD` (rejects `2026-02-30`). */
export function isIsoDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export const TIMELINE_TIME_ZONE = "Europe/London";

const offsetFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMELINE_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Milliseconds London is ahead of UTC at `instant` (0 in winter, one hour in summer). */
function londonOffsetMs(instant: number): number {
  const parts: Record<string, number> = {};
  for (const part of offsetFormatter.formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0,
  );
  return asUtc - (instant - (instant % 1000));
}

/** The UTC instant at which the London calendar day `date` (`YYYY-MM-DD`) begins. */
export function londonDayStart(date: string): Date {
  const match = ISO_DATE_PATTERN.exec(date);
  if (!match || !isIsoDate(date)) throw new RangeError("Expected a YYYY-MM-DD date");
  const wallClock = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Two passes: the offset at the guess can differ from the offset at the answer on clock-change
  // days. London changes at 01:00 UTC, so midnight itself always exists and is unambiguous.
  const guess = wallClock - londonOffsetMs(wallClock);
  return new Date(wallClock - londonOffsetMs(guess));
}

function nextIsoDate(date: string): string {
  const match = ISO_DATE_PATTERN.exec(date);
  if (!match) throw new RangeError("Expected a YYYY-MM-DD date");
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1)).toISOString().slice(0, 10);
}

export type OccurredRange = {
  /** Inclusive lower bound, ISO UTC instant. */
  from: string | null;
  /** Exclusive upper bound: the start of the London day after `to`. */
  toExclusive: string | null;
};

/** Whole London days `from` to `to`, both inclusive, as UTC instants for the query. */
export function occurredRange(from: string | null, to: string | null): OccurredRange {
  return {
    from: from === null ? null : londonDayStart(from).toISOString(),
    toExclusive: to === null ? null : londonDayStart(nextIsoDate(to)).toISOString(),
  };
}

/** A selected histogram bucket, half open and independent of the whole-day filters. */
export type TimelineTimeRange = { from: string; toExclusive: string };

/** Intersect, never replace, the calendar dates with the selected time bucket. */
export function timelineOccurredRange(
  filters: Pick<TimelineQuery, "from" | "to" | "timeRange">,
): OccurredRange {
  const dates = occurredRange(filters.from, filters.to);
  if (filters.timeRange === null) return dates;
  return {
    from: dates.from === null || Date.parse(dates.from) < Date.parse(filters.timeRange.from)
      ? filters.timeRange.from : dates.from,
    toExclusive: dates.toExclusive === null || Date.parse(dates.toExclusive) > Date.parse(filters.timeRange.toExclusive)
      ? filters.timeRange.toExclusive : dates.toExclusive,
  };
}

export type TimelineCursor = {
  /** `occurred_at` exactly as the database returned it, so microseconds survive the round trip. */
  occurredAt: string;
  id: string;
};

const CURSOR_SEPARATOR = "|";
const MAX_CURSOR_LENGTH = 200;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCursor(value: TimelineCursor): boolean {
  return (
    TIMESTAMP_PATTERN.test(value.occurredAt) &&
    !Number.isNaN(Date.parse(value.occurredAt)) &&
    UUID_PATTERN.test(value.id)
  );
}

/** Opaque base64url token for the last event on a page. */
export function encodeCursor(cursor: TimelineCursor): string {
  if (!isCursor(cursor)) throw new RangeError("Cursor needs an ISO timestamp and a uuid");
  return Buffer.from(`${cursor.occurredAt}${CURSOR_SEPARATOR}${cursor.id}`, "utf8").toString("base64url");
}

/** The cursor in `token`, or null for anything not produced by `encodeCursor`. */
export function decodeCursor(token: string): TimelineCursor | null {
  if (token.length === 0 || token.length > MAX_CURSOR_LENGTH || !BASE64URL_PATTERN.test(token)) return null;
  const bytes = Buffer.from(token, "base64url");
  // Node's decoder skips what it cannot read, so a token that does not re-encode to itself was
  // altered or truncated.
  if (bytes.toString("base64url") !== token) return null;
  const parts = bytes.toString("utf8").split(CURSOR_SEPARATOR);
  if (parts.length !== 2) return null;
  const [occurredAt, id] = parts;
  if (occurredAt === undefined || id === undefined) return null;
  const cursor = { occurredAt, id };
  return isCursor(cursor) ? cursor : null;
}

/** Longest title search the URL may carry; the search box stops at the same length. */
export const MAX_SEARCH_LENGTH = 100;

/**
 * A case-insensitive Postgres regular expression (`~*`) matching titles that contain `search`
 * literally: every regex metacharacter is escaped. The list query and the provider badges' count
 * both filter with it, so they match the same events. A regex rather than ILIKE because PostgREST
 * reads `*` in a LIKE pattern as `%`, so a search for `*` would match every title.
 */
export function titleSearchPattern(search: string): string {
  return search.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

export type TimelineQuery = {
  types: string[];
  severities: EventSeverity[];
  /** London calendar date `YYYY-MM-DD`, inclusive. */
  from: string | null;
  /** London calendar date `YYYY-MM-DD`, inclusive. */
  to: string | null;
  timeRange: TimelineTimeRange | null;
  /** Text every event title must contain, ignoring case; trimmed and never empty. */
  search: string | null;
  cursor: TimelineCursor | null;
  /** Provider, project, and account filter shared with the dashboard. */
  scope: ScopeFilters;
};

type SearchParamValue = string | string[] | undefined;
export type RawSearchParams = Record<string, SearchParamValue>;

/** The first value of a parameter when it is valid, otherwise null. */
function one<T>(parse: (value: string) => T | null) {
  return z.unknown().optional().transform((raw) => {
    const first = paramValues(raw)[0]?.trim();
    return first === undefined || first === "" ? null : parse(first);
  });
}

const EventIdParamSchema = one((value) => (UUID_PATTERN.test(value) ? value.toLowerCase() : null));

/** Inspector selection is not a feed filter and never changes its counts or cursor. */
export function parseTimelineEventId(value: SearchParamValue): string | null {
  return EventIdParamSchema.parse(value);
}

const isSeverity = (value: string): value is EventSeverity =>
  (EVENT_SEVERITIES as readonly string[]).includes(value);

// Bucket boundaries have millisecond precision or less. Normalize offsets once so comparisons
// and shared URLs use the same UTC representation; Zod rejects impossible calendar dates.
const InstantSchema = z.iso.datetime({ offset: true }).refine(
  (value) => !/\.\d{4}/.test(value),
);
const instantParam = one((value) => {
  const result = InstantSchema.safeParse(value);
  if (!result.success) return null;
  const date = new Date(result.data);
  // PostgreSQL has no year zero; keep URL instants in its common four-digit AD range.
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) return null;
  return date.toISOString();
});

// One schema for the whole URL: the shared scope filter plus the timeline's own keys.
const TimelineSearchParamsSchema = ScopeSearchParamsSchema.extend({
  type: repeatedParam(isEventTypeId, MAX_TYPE_FILTERS),
  severity: repeatedParam(isSeverity, EVENT_SEVERITIES.length),
  from: one((value) => (isIsoDate(value) ? value : null)),
  to: one((value) => (isIsoDate(value) ? value : null)),
  start: instantParam,
  until: instantParam,
  q: one((value) => (value.length <= MAX_SEARCH_LENGTH ? value : null)),
  cursor: one(decodeCursor),
});

/** The timeline filters in a request's search params. Never throws. */
export function parseTimelineSearchParams(searchParams: RawSearchParams): TimelineQuery {
  const parsed = TimelineSearchParamsSchema.parse(searchParams);
  return {
    types: parsed.type,
    severities: parsed.severity,
    from: parsed.from,
    to: parsed.to,
    timeRange: parsed.start !== null && parsed.until !== null && parsed.start < parsed.until
      ? { from: parsed.start, toExclusive: parsed.until } : null,
    search: parsed.q,
    cursor: parsed.cursor,
    scope: { providers: parsed.provider, projects: parsed.project, accounts: parsed.account },
  };
}

export function hasActiveFilters(query: TimelineQuery): boolean {
  return (
    query.types.length > 0 ||
    query.severities.length > 0 ||
    query.from !== null ||
    query.to !== null ||
    query.timeRange !== null ||
    query.search !== null ||
    hasScopeFilters(query.scope)
  );
}

/**
 * The search params for the filters in `query`, and `cursor` when given: the shape
 * `parseTimelineSearchParams` reads. Links use it through `timelineHref`; the search form writes
 * the same entries as hidden inputs, so a link and a form submission carry the same filters.
 */
export function timelineParams(query: TimelineQuery, cursor: TimelineCursor | null): URLSearchParams {
  const params = new URLSearchParams();
  for (const type of query.types) params.append("type", type);
  for (const severity of query.severities) params.append("severity", severity);
  if (query.from !== null) params.set("from", query.from);
  if (query.to !== null) params.set("to", query.to);
  if (query.timeRange !== null) {
    params.set("start", query.timeRange.from);
    params.set("until", query.timeRange.toExclusive);
  }
  if (query.search !== null) params.set("q", query.search);
  appendScopeParams(params, query.scope);
  if (cursor !== null) params.set("cursor", encodeCursor(cursor));
  return params;
}

/** Link to `basePath` carrying the filters in `query`, and `cursor` when given. */
export function timelineHref(basePath: string, query: TimelineQuery, cursor: TimelineCursor | null): string {
  const search = timelineParams(query, cursor).toString();
  return search === "" ? basePath : `${basePath}?${search}`;
}

/** How far either side of an event "Show events around this time" reaches. */
export const AROUND_EVENT_WINDOW_MINUTES = 60;

const NO_FILTERS: TimelineQuery = {
  types: [],
  severities: [],
  from: null,
  to: null,
  timeRange: null,
  search: null,
  cursor: null,
  scope: EMPTY_SCOPE,
};

/** Links from an event's details to the timeline narrowed by one of the event's own values. */
export type EventFilterHrefs = Readonly<{
  type: string;
  /** null for an event with no account, such as StackDash's own. */
  account: string | null;
  /** The half-open period `AROUND_EVENT_WINDOW_MINUTES` either side of the event, as `start` and `until`. */
  around: string;
}>;

/**
 * The event's type, its account, and the time around it, each as the only filter: a shared event
 * can be open outside the current filters, so keeping them could show a timeline without it.
 */
export function eventFilterHrefs(
  basePath: string,
  event: Readonly<{ type_id: string; external_account_id: string | null; occurred_at: string }>,
): EventFilterHrefs {
  // Postgres keeps microseconds and the URL's instants stop at milliseconds. Truncating moves the
  // instant back by under a millisecond, far less than the window, so the event stays inside it.
  const occurredMs = Date.parse(event.occurred_at.replace(/(\.\d{3})\d+/, "$1"));
  const windowMs = AROUND_EVENT_WINDOW_MINUTES * 60_000;
  const timeRange = {
    from: new Date(occurredMs - windowMs).toISOString(),
    toExclusive: new Date(occurredMs + windowMs).toISOString(),
  };
  return {
    type: timelineHref(basePath, { ...NO_FILTERS, types: [event.type_id] }, null),
    account: event.external_account_id === null
      ? null
      : timelineHref(basePath, { ...NO_FILTERS, scope: { ...EMPTY_SCOPE, accounts: [event.external_account_id] } }, null),
    around: timelineHref(basePath, { ...NO_FILTERS, timeRange }, null),
  };
}

/** One active filter value, named so it can be removed on its own. */
export type ActiveFilter = Readonly<{
  /** Unique among the filters of one query, for React keys. */
  key: string;
  /** What is filtered, in sentence case: "Provider", "Event type". */
  kind: string;
  /** The value as the filter form names it: "GitHub", "Vercel: Deployment ready". */
  value: string;
  /** What activating it does: "Remove filter: provider GitHub". */
  name: string;
  /** The same filters without this one value, starting from the newest events. */
  query: TimelineQuery;
}>;

function optionLabel(value: string, options: readonly ScopeOption[], unknown: string): string {
  return options.find((option) => option.value === value)?.label ?? unknown;
}

/**
 * Every active filter value, one entry each, in the order the page describes them: search, event
 * types, severities, dates, the selected period, then providers, projects, and accounts. Event
 * types are named as the filter form names them, with `typeName` (the adapters' declared names live
 * on the server, #294), and scope values by the form's options, so a chip reads the same as the box
 * that set it. Each entry's query drops only its own value and the cursor.
 */
export function activeFilters(query: TimelineQuery, options: ScopeOptions, typeName: (typeId: string) => string): ActiveFilter[] {
  const base = { ...query, cursor: null };
  const filters: ActiveFilter[] = [];
  const add = (key: string, kind: string, value: string, without: Partial<TimelineQuery>) => {
    filters.push({ key, kind, value, name: `Remove filter: ${kind.toLowerCase()} ${value}`, query: { ...base, ...without } });
  };
  if (query.search !== null) add("q", "Search", `“${query.search}”`, { search: null });
  for (const type of query.types) {
    add(`type=${type}`, "Event type", `${typeOwnerName(type)}: ${typeName(type)}`, {
      types: query.types.filter((other) => other !== type),
    });
  }
  for (const severity of query.severities) {
    add(`severity=${severity}`, "Severity", severityBadge(severity), {
      severities: query.severities.filter((other) => other !== severity),
    });
  }
  if (query.from !== null) add("from", "From date", query.from, { from: null });
  if (query.to !== null) add("to", "To date", query.to, { to: null });
  if (query.timeRange !== null) {
    add("period", "Period", `${formatDateTime(query.timeRange.from)} to before ${formatDateTime(query.timeRange.toExclusive)}`, {
      timeRange: null,
    });
  }
  const { scope } = query;
  for (const provider of scope.providers) {
    add(`provider=${provider}`, "Provider", optionLabel(provider, options.providers, providerName(provider)), {
      scope: { ...scope, providers: scope.providers.filter((other) => other !== provider) },
    });
  }
  for (const project of scope.projects) {
    add(`project=${project}`, "Project", optionLabel(project, options.projects, "Unknown project"), {
      scope: { ...scope, projects: scope.projects.filter((other) => other !== project) },
    });
  }
  for (const account of scope.accounts) {
    add(`account=${account}`, "Account", optionLabel(account, options.accounts, "Unknown account"), {
      scope: { ...scope, accounts: scope.accounts.filter((other) => other !== account) },
    });
  }
  return filters;
}

/** The fields of an activity overview bar that matching and totals read. */
export type ActivityCount = Readonly<{ bucket_start: string; bucket_end: string; events: number }>;

/**
 * The overview bar that is exactly the selected period, or undefined: a hand-written range, or one
 * whose bars shifted after new events arrived, is not one bar.
 */
export function selectedActivityBucket<T extends ActivityCount>(
  buckets: readonly T[],
  range: TimelineTimeRange | null,
): T | undefined {
  if (range === null) return undefined;
  return buckets.find((bucket) =>
    new Date(bucket.bucket_start).toISOString() === range.from && new Date(bucket.bucket_end).toISOString() === range.toExclusive);
}

/**
 * How many events match the filters across every page, from the overview's bars: all of them with
 * no period selected, the selected bar's with one. null when the selected period is not one bar,
 * because then no bar holds its count.
 */
export function timelineTotal(buckets: readonly ActivityCount[], range: TimelineTimeRange | null): number | null {
  if (range === null) return buckets.reduce((sum, bucket) => sum + bucket.events, 0);
  return selectedActivityBucket(buckets, range)?.events ?? null;
}

const FULL_COUNT = new Intl.NumberFormat("en-US");

/**
 * The feed's result in words, announced as a live region: "Showing 50 of 60 events with “deploy”
 * in the title for provider Vercel". An older page says "Showing 10 older events of 60". The list
 * and the total are separate reads, so an event arriving between them can leave the total behind
 * the list; a total below the count shown, or no total, falls back to the count alone rather than
 * printing a number that cannot be true.
 */
export function timelineStatus({
  count,
  total,
  olderPage,
  search,
  scopeDescription,
}: Readonly<{
  count: number;
  total: number | null;
  olderPage: boolean;
  search: string | null;
  scopeDescription: string | null;
}>): string {
  const older = olderPage ? "older " : "";
  const noun = (n: number) => (n === 1 ? "event" : "events");
  let shown: string;
  if (count === 0) shown = "Showing no events";
  else if (total === null || total < count) shown = `Showing ${FULL_COUNT.format(count)} ${older}${noun(count)}`;
  else if (olderPage) shown = `Showing ${FULL_COUNT.format(count)} older ${noun(count)} of ${FULL_COUNT.format(total)}`;
  else shown = `Showing ${FULL_COUNT.format(count)} of ${FULL_COUNT.format(total)} ${noun(total)}`;
  const matching = search === null ? shown : `${shown} with “${search}” in the title`;
  return scopeDescription === null ? matching : `${matching} for ${scopeDescription}`;
}
