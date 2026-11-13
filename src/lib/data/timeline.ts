import "server-only";

import { cache } from "react";

import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import { projectSelection, timelineScope, type ScopeFilters, type TimelineScope } from "@/lib/filters/scope";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import {
  MAX_TYPE_FILTERS,
  occurredRange,
  TIMELINE_PAGE_SIZE,
  timelineOccurredRange,
  titleSearchPattern,
  type EventSeverity,
  type TimelineCursor,
  type TimelineTimeRange,
} from "@/lib/timeline/query";

type ActivityEventRow = Database["public"]["Tables"]["activity_events"]["Row"];

export type TimelineEvent = Pick<
  ActivityEventRow,
  | "id"
  | "type_id"
  | "severity"
  | "title"
  | "body"
  | "url"
  | "occurred_at"
  | "provider"
  | "external_account_id"
  | "connection_id"
> & {
  accountName: string | null;
  connectionName: string | null;
  // True when the event's connection was made by the provider simulator (#131), so the event is
  // made up. DevMacro's own events about such a connection, such as a sync failure, count too.
  simulated: boolean;
};

export type TimelineFilters = {
  types: readonly string[];
  severities: readonly EventSeverity[];
  /** London calendar dates, inclusive; converted to UTC instants here. */
  from: string | null;
  to: string | null;
  timeRange: TimelineTimeRange | null;
  /** Text the title must contain, ignoring case. */
  search: string | null;
  /** Event types the viewer chose to hide (#119); excluded from every page. */
  hiddenTypeIds: readonly string[];
  cursor: TimelineCursor | null;
  /** Provider, project, and account filter shared with the dashboard. */
  scope: ScopeFilters;
};

export type TimelinePage = {
  events: TimelineEvent[];
  /** Position after the last event, or null when this is the oldest page. */
  nextCursor: TimelineCursor | null;
};

const EVENT_COLUMNS = "id, type_id, severity, title, body, url, occurred_at, provider, external_account_id, connection_id, external_accounts(display_name), connections(display_name, granted_scopes)";

/** A shared event link can point outside the loaded page, but never outside this workspace. */
export async function getTimelineEvent(workspaceId: string, eventId: string): Promise<TimelineEvent | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("activity_events")
    .select(EVENT_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("id", eventId)
    .maybeSingle();
  if (error) throw new Error("Failed to load the timeline event", { cause: error });
  if (data === null) return null;
  const { external_accounts, connections, ...event } = data;
  return {
    ...event,
    accountName: external_accounts?.display_name ?? null,
    connectionName: connections?.display_name ?? null,
    simulated: connections !== null && isSimulatedConnection(connections),
  };
}

// Postgres timestamps hold commas and colons, so the values in the `or` filter are quoted. The
// cursor was validated by `decodeCursor`, so it never contains a quote.
function olderThan(cursor: TimelineCursor): string {
  const at = `"${cursor.occurredAt}"`;
  return `occurred_at.lt.${at},and(occurred_at.eq.${at},id.lt.${cursor.id})`;
}

// Accounts per workspace are a handful in the MVP; this bounds the project lookup.
const PROJECT_ACCOUNTS_LIMIT = 1000;

/**
 * Ids of the workspace's provider accounts in the selected projects (and, for `unassigned`, in
 * none), in one query. null when no project is selected. Project ids passed the scope schema's
 * uuid check, so they are safe in the `or` list.
 */
async function accountIdsInProjects(workspaceId: string, scope: ScopeFilters): Promise<string[] | null> {
  if (scope.projects.length === 0) return null;
  const { projectIds, unassigned } = projectSelection(scope);
  const conditions = [
    ...(projectIds.length > 0 ? [`project_id.in.(${projectIds.join(",")})`] : []),
    ...(unassigned ? ["project_id.is.null"] : []),
  ];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("external_accounts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .or(conditions.join(","))
    .order("created_at", { ascending: true })
    .limit(PROJECT_ACCOUNTS_LIMIT);
  if (error) throw new Error("Failed to load the accounts in the selected projects", { cause: error });
  return data.map((account) => account.id);
}

/**
 * The providers and accounts `scope` leaves in view, with its projects resolved to their accounts.
 * Shared by the event list, its connection counts, and the trend markers, which all count what the
 * timeline would list. Cached per request: the timeline page passes the same parsed `scope` object
 * to the list and the counts, so a project filter costs one lookup, not two.
 */
export const resolveTimelineScope = cache(
  async (workspaceId: string, scope: ScopeFilters): Promise<TimelineScope> =>
    timelineScope(scope, await accountIdsInProjects(workspaceId, scope)),
);

/**
 * One page of the workspace's activity, newest first, keyset paginated on
 * (occurred_at desc, id desc) to match the table's index. Provider account and connection names
 * come from the same request as embedded resources, so a page is always one round trip. Type ids
 * in `types` and `hiddenTypeIds` must have passed `isEventTypeId`. A project filter costs one
 * extra query first, to resolve the projects to their accounts.
 */
export async function listTimelineEvents(workspaceId: string, filters: TimelineFilters): Promise<TimelinePage> {
  const supabase = await createClient();
  const scope = await resolveTimelineScope(workspaceId, filters.scope);
  // No account can match, so no event can either.
  if (scope.accountIds !== null && scope.accountIds.length === 0) return { events: [], nextCursor: null };
  let query = supabase
    .from("activity_events")
    .select(EVENT_COLUMNS)
    .eq("workspace_id", workspaceId);

  if (filters.types.length > 0) query = query.in("type_id", [...filters.types]);
  if (filters.hiddenTypeIds.length > 0) query = query.not("type_id", "in", `(${filters.hiddenTypeIds.join(",")})`);
  if (filters.severities.length > 0) query = query.in("severity", [...filters.severities]);
  if (scope.providers.length > 0) query = query.in("provider", [...scope.providers]);
  if (scope.accountIds !== null) query = query.in("external_account_id", [...scope.accountIds]);
  if (filters.search !== null) query = query.regexIMatch("title", titleSearchPattern(filters.search));
  const range = timelineOccurredRange(filters);
  if (range.from !== null) query = query.gte("occurred_at", range.from);
  if (range.toExclusive !== null) query = query.lt("occurred_at", range.toExclusive);
  if (filters.cursor !== null) query = query.or(olderThan(filters.cursor));

  // One extra row says whether an older page exists without a count query.
  const { data, error } = await query
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(TIMELINE_PAGE_SIZE + 1);
  if (error) throw new Error("Failed to load timeline events", { cause: error });

  const page = data.slice(0, TIMELINE_PAGE_SIZE);
  const last = page.at(-1);
  return {
    events: page.map(({ external_accounts, connections, ...event }) => ({
      ...event,
      accountName: external_accounts?.display_name ?? null,
      connectionName: connections?.display_name ?? null,
      simulated: connections !== null && isSimulatedConnection(connections),
    })),
    nextCursor:
      data.length > TIMELINE_PAGE_SIZE && last !== undefined ? { occurredAt: last.occurred_at, id: last.id } : null,
  };
}

/** One connection with events in view: its provider and how many of those events it holds. */
export type ConnectionEventCount = Readonly<{
  provider: Database["public"]["Enums"]["provider_id"];
  events: number;
}>;

// One row per connection, and a workspace holds a handful; this bounds the read all the same.
const CONNECTION_COUNT_LIMIT = 100;

/**
 * How many events each connection holds under `filters`, across every page of the timeline (the
 * cursor is ignored), one row per connection, most events first. Connections with no matching
 * event are left out, and so are events with no connection. Counted in the database
 * (`timeline_connection_event_counts`), which counts nothing for a non-member. Only the provider
 * and the count are read: the title badges group by provider.
 */
export async function listTimelineConnectionCounts(
  workspaceId: string,
  filters: Omit<TimelineFilters, "cursor">,
): Promise<ConnectionEventCount[]> {
  const scope = await resolveTimelineScope(workspaceId, filters.scope);
  // No account can match, so no event can either.
  if (scope.accountIds !== null && scope.accountIds.length === 0) return [];
  const range = timelineOccurredRange(filters);
  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("timeline_connection_event_counts", {
      p_workspace_id: workspaceId,
      p_type_ids: [...filters.types],
      p_hidden_type_ids: [...filters.hiddenTypeIds],
      p_severities: [...filters.severities],
      p_providers: [...scope.providers],
      ...(scope.accountIds === null ? {} : { p_account_ids: [...scope.accountIds] }),
      ...(range.from === null ? {} : { p_from: range.from }),
      ...(range.toExclusive === null ? {} : { p_until: range.toExclusive }),
      ...(filters.search === null ? {} : { p_title_pattern: titleSearchPattern(filters.search) }),
    })
    // PostgREST orders a function's rows only by selected columns. Order matters only for which
    // rows CONNECTION_COUNT_LIMIT keeps; rows that tie on both are the same provider and count, so
    // which of them it keeps changes nothing the badges show.
    .select("provider, events")
    .order("events", { ascending: false })
    .order("provider", { ascending: true })
    .limit(CONNECTION_COUNT_LIMIT);
  if (error) throw new Error("Failed to load timeline event counts per connection", { cause: error });
  return data;
}

export type ActivityBucket = Database["public"]["Functions"]["timeline_activity_buckets"]["Returns"][number];

/** Complete filtered counts, before pagination or bucket selection, in at most 12 time buckets. */
export async function listTimelineActivity(
  workspaceId: string,
  filters: Omit<TimelineFilters, "cursor">,
): Promise<ActivityBucket[]> {
  const scope = await resolveTimelineScope(workspaceId, filters.scope);
  if (scope.accountIds !== null && scope.accountIds.length === 0) return [];
  const range = occurredRange(filters.from, filters.to);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("timeline_activity_buckets", {
    p_workspace_id: workspaceId,
    p_type_ids: [...filters.types],
    p_hidden_type_ids: [...filters.hiddenTypeIds],
    p_severities: [...filters.severities],
    p_providers: [...scope.providers],
    ...(scope.accountIds === null ? {} : { p_account_ids: [...scope.accountIds] }),
    ...(range.from === null ? {} : { p_from: range.from }),
    ...(range.toExclusive === null ? {} : { p_until: range.toExclusive }),
    ...(filters.search === null ? {} : { p_title_pattern: titleSearchPattern(filters.search) }),
  }).select("bucket_start, bucket_end, events").order("bucket_start").limit(12);
  if (error) throw new Error("Failed to load timeline activity", { cause: error });
  return data;
}

/**
 * Every distinct event type id the workspace has events of, sorted, up to `MAX_TYPE_FILTERS` (the
 * most one URL may filter on, so every offered type can be ticked). Read from the daily event
 * count rollup (`timeline_type_ids`), so a type whose only event is years older than the rest is
 * still offered, and a non-member gets none. The rollup holds one row per day, type, provider, and
 * account, and the function reads all of the workspace's rows: far fewer than its events, but not
 * bounded by the number of types. The rollup is kept equal to `activity_events` by its triggers, so
 * this is empty exactly when the workspace has no activity at all.
 */
export const listTimelineTypeIds = cache(async (workspaceId: string): Promise<string[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .rpc("timeline_type_ids", { p_workspace_id: workspaceId })
    .select("type_id")
    .order("type_id", { ascending: true })
    .limit(MAX_TYPE_FILTERS);
  if (error) throw new Error("Failed to load timeline event types", { cause: error });
  return data.map((row) => row.type_id);
});
