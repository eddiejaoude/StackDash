import "server-only";

import { cache } from "react";

import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import { projectSelection, timelineScope, type ScopeFilters } from "@/lib/filters/scope";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import {
  occurredRange,
  TIMELINE_PAGE_SIZE,
  type EventSeverity,
  type TimelineCursor,
} from "@/lib/timeline/query";

type ActivityEventRow = Database["public"]["Tables"]["activity_events"]["Row"];

export type TimelineEvent = Pick<
  ActivityEventRow,
  "id" | "type_id" | "severity" | "title" | "body" | "url" | "occurred_at" | "provider"
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
 * One page of the workspace's activity, newest first, keyset paginated on
 * (occurred_at desc, id desc) to match the table's index. Provider account and connection names
 * come from the same request as embedded resources, so a page is always one round trip. Type ids
 * in `types` and `hiddenTypeIds` must have passed `isEventTypeId`. A project filter costs one
 * extra query first, to resolve the projects to their accounts.
 */
export async function listTimelineEvents(workspaceId: string, filters: TimelineFilters): Promise<TimelinePage> {
  const supabase = await createClient();
  const scope = timelineScope(filters.scope, await accountIdsInProjects(workspaceId, filters.scope));
  // No account can match, so no event can either.
  if (scope.accountIds !== null && scope.accountIds.length === 0) return { events: [], nextCursor: null };
  let query = supabase
    .from("activity_events")
    .select(
      "id, type_id, severity, title, body, url, occurred_at, provider, external_accounts(display_name), connections(display_name, granted_scopes)",
    )
    .eq("workspace_id", workspaceId);

  if (filters.types.length > 0) query = query.in("type_id", [...filters.types]);
  if (filters.hiddenTypeIds.length > 0) query = query.not("type_id", "in", `(${filters.hiddenTypeIds.join(",")})`);
  if (filters.severities.length > 0) query = query.in("severity", [...filters.severities]);
  if (scope.providers.length > 0) query = query.in("provider", [...scope.providers]);
  if (scope.accountIds !== null) query = query.in("external_account_id", [...scope.accountIds]);
  const range = occurredRange(filters.from, filters.to);
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

// PostgREST has no DISTINCT, so the type picker samples the newest events. Types older than the
// sample are rare in practice and still filterable through the URL.
const TYPE_SAMPLE_SIZE = 1000;
const MAX_TYPE_OPTIONS = 50;

/**
 * Up to 50 distinct event type ids seen in the workspace's newest 1,000 events, sorted. Empty
 * exactly when the workspace has no activity at all.
 */
export const listTimelineTypeIds = cache(async (workspaceId: string): Promise<string[]> => {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("activity_events")
    .select("type_id")
    .eq("workspace_id", workspaceId)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(TYPE_SAMPLE_SIZE);
  if (error) throw new Error("Failed to load timeline event types", { cause: error });
  return [...new Set(data.map((row) => row.type_id))].sort().slice(0, MAX_TYPE_OPTIONS);
});
