import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import { log } from "@/lib/log/logger";
import { Constants, type Database } from "@/lib/supabase/database.types";
import { readAllPages } from "@/lib/supabase/paging";

import { SNAPSHOT_READ_MAX_ROWS, type SnapshotPoint, type SourceAccount } from "./engine";
import type { HistoryEvent, HistoryStore } from "./history";
import type { DayCount, ProviderCount, YearReviewStore } from "./yearly";

/*
 * The engine's reads for one project (or, with `projectId` null, every included account of the
 * workspace, for the yearly card #151), against Supabase. Every query is scoped to the workspace
 * and to those accounts explicitly, because the public route runs it with the service role, which
 * bypasses row level security. In the app it runs as the signed-in member, and row level security
 * applies as well.
 */

type MetricKind = Database["public"]["Enums"]["metric_kind"];

// Quantities only: even a mistyped metric key in a definition cannot read an amount of money.
const QUANTITY_KINDS: readonly MetricKind[] = ["usage", "included_allowance", "remaining_allowance"];

// Bounds. A project groups a handful of accounts. The account read asks for one row past
// ACCOUNTS_LIMIT, so reaching the bound is seen rather than silently cutting the rest (#220). A
// snapshot read is paged (#209): PostgREST returns at most 1000 rows a request, and a history or
// trend window of many accounts holds more.
export const ACCOUNTS_LIMIT = 200;

// year_review_event_counts returns a row per London day of a window of at most 366 days, and a row
// per provider plus one for events without one, so this many rows always fit one request.
const YEAR_REVIEW_COUNT_ROWS = 366 + Constants.public.Enums.provider_id.length + 1;

// Generated function types mark every returned column non-null; `day` is null on a provider row,
// `provider` on a day row and for events with no provider.
type YearReviewCountRow = Readonly<{ bucket: string; day: string | null; provider: Database["public"]["Enums"]["provider_id"] | null; events: number }>;

/**
 * The project (or, with no project, the workspace) has more included accounts than ACCOUNTS_LIMIT,
 * so no number may be computed from what the read returned (#220). Public routes answer it as any
 * failed read; the owner's settings page shows its metrics as unavailable and says why.
 */
export class AccountBoundError extends Error {
  override readonly name = "AccountBoundError";
}

export function createSupabaseMetricStore(
  db: SupabaseClient<Database>,
  workspaceId: string,
  projectId: string | null,
): HistoryStore & YearReviewStore {
  return {
    async accounts(): Promise<SourceAccount[]> {
      const included = db.from("external_accounts").select("id, connection_id").eq("workspace_id", workspaceId).eq("included", true);
      const accounts = await (projectId === null ? included : included.eq("project_id", projectId)).order("id").limit(ACCOUNTS_LIMIT + 1);
      if (accounts.error) throw new Error("Failed to load the project's accounts", { cause: accounts.error });
      // Every number rests on every included account, so a read that may be missing some publishes
      // nothing (#220).
      if (accounts.data.length > ACCOUNTS_LIMIT) {
        throw new AccountBoundError(
          `Public metrics read at most ${ACCOUNTS_LIMIT} included accounts, and workspace ${workspaceId}${projectId === null ? "" : ` project ${projectId}`} has more`,
        );
      }
      if (accounts.data.length === 0) return [];

      // Only the connections of the accounts just read, so this read holds at most as many rows as
      // that one and cannot be cut either. A disconnected (revoked) connection keeps its rows, but
      // the user asked StackDash to stop using them, so its accounts drop out and the metric reads
      // "not connected". The scheduler and the daily summary skip revoked connections the same way
      // (src/lib/jobs/store.ts).
      const connectionIds = [...new Set(accounts.data.map((account) => account.connection_id))];
      const connections = await db
        .from("connections")
        .select("id, provider, created_at, last_synced_at, granted_scopes")
        .eq("workspace_id", workspaceId)
        .in("id", connectionIds)
        .neq("status", "revoked")
        .limit(connectionIds.length);
      if (connections.error) throw new Error("Failed to load the workspace's connections", { cause: connections.error });
      const byId = new Map(connections.data.map((connection) => [connection.id, connection]));
      return accounts.data.flatMap((account) => {
        const connection = byId.get(account.connection_id);
        if (connection === undefined) return [];
        return [
          {
            accountId: account.id,
            provider: connection.provider,
            connectionCreatedAt: new Date(connection.created_at),
            lastSyncedAt: connection.last_synced_at === null ? null : new Date(connection.last_synced_at),
            simulated: isSimulatedConnection(connection),
          },
        ];
      });
    },

    async snapshots({ accountIds, metricKeys, fromDate, toDate }): Promise<SnapshotPoint[]> {
      if (accountIds.length === 0 || metricKeys.length === 0) return [];
      const { rows, complete } = await readAllPages(async (from, to) => {
        const { data, error } = await db
          .from("usage_snapshots")
          .select("external_account_id, metric_key, snapshot_date, value, period_start, period_end, resets_at, retrieved_at")
          .eq("workspace_id", workspaceId)
          .in("external_account_id", accountIds)
          .in("metric_key", metricKeys)
          .in("kind", QUANTITY_KINDS)
          .not("value", "is", null)
          .gte("snapshot_date", fromDate)
          .lte("snapshot_date", toDate)
          // Newest first, so a read stopped at the bound loses the oldest days, never today. The
          // id makes the order total. A sync inserting today's rows between two pages shifts the
          // later pages, so a row can come back twice; the engine keeps one reading per account and
          // day (newestByAccount, the baseline lookup in snapshotChange), so a repeat changes no number.
          .order("snapshot_date", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to);
        if (error) throw new Error("Failed to load snapshots for public metrics", { cause: error });
        return data;
      }, SNAPSHOT_READ_MAX_ROWS);
      // Callers see the cut by the row count (snapshotsWholeFrom in engine.ts), so the mapping below
      // must keep every row.
      if (!complete) log.warn("public_metrics.snapshots_truncated", { workspaceId, projectId, fromDate, toDate, rows: rows.length });
      return rows.map((row) => {
        if (row.value === null) throw new Error("usage_snapshots returned a null value the query excluded");
        return {
          accountId: row.external_account_id,
          metricKey: row.metric_key,
          snapshotDate: row.snapshot_date,
          value: row.value,
          periodStart: row.period_start === null ? null : new Date(row.period_start),
          periodEnd: row.period_end === null ? null : new Date(row.period_end),
          resetsAt: row.resets_at === null ? null : new Date(row.resets_at),
          retrievedAt: new Date(row.retrieved_at),
        };
      });
    },

    async earliestSnapshotDate({ accountIds, metricKey }): Promise<string | null> {
      if (accountIds.length === 0) return null;
      // Served by usage_snapshots_workspace_date_idx (workspace_id, snapshot_date).
      const { data, error } = await db
        .from("usage_snapshots")
        .select("snapshot_date")
        .eq("workspace_id", workspaceId)
        .in("external_account_id", accountIds)
        .eq("metric_key", metricKey)
        .in("kind", QUANTITY_KINDS)
        .not("value", "is", null)
        .order("snapshot_date", { ascending: true })
        .limit(1);
      if (error) throw new Error("Failed to load the earliest snapshot for public metrics", { cause: error });
      return data[0]?.snapshot_date ?? null;
    },

    async countEvents({ accountIds, typeIds, from, to }): Promise<number> {
      if (accountIds.length === 0 || typeIds.length === 0) return 0;
      // A head request: Postgres counts, no rows travel. Served by activity_events_workspace_timeline_idx.
      const { count, error } = await db
        .from("activity_events")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspaceId)
        .in("external_account_id", accountIds)
        .in("type_id", typeIds)
        .gte("occurred_at", from.toISOString())
        .lt("occurred_at", to.toISOString());
      if (error) throw new Error("Failed to count events for public metrics", { cause: error });
      if (count === null) throw new Error("Event count missing from the response");
      return count;
    },

    async earliestEvent({ accountIds, typeIds }): Promise<Date | null> {
      if (accountIds.length === 0 || typeIds.length === 0) return null;
      const { data, error } = await db
        .from("activity_events")
        .select("occurred_at")
        .eq("workspace_id", workspaceId)
        .in("external_account_id", accountIds)
        .in("type_id", typeIds)
        .order("occurred_at", { ascending: true })
        .limit(1);
      if (error) throw new Error("Failed to load the earliest event for public metrics", { cause: error });
      const first = data[0];
      return first === undefined ? null : new Date(first.occurred_at);
    },

    async recentEvents({ accountIds, typeIds, since, before, limit }) {
      if (accountIds.length === 0 || typeIds.length === 0) return [];
      let query = db
        .from("activity_events")
        .select("external_account_id, type_id, occurred_at")
        .eq("workspace_id", workspaceId)
        .in("external_account_id", accountIds)
        .in("type_id", typeIds)
        .lte("occurred_at", before.toISOString());
      if (since !== undefined) query = query.gte("occurred_at", since.toISOString());
      const { data, error } = await query
        .order("occurred_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);
      if (error) throw new Error("Failed to load recent events for public metrics", { cause: error });
      return data.flatMap((row) =>
        row.external_account_id === null ? [] : [{ accountId: row.external_account_id, typeId: row.type_id, occurredAt: new Date(row.occurred_at) }],
      );
    },

    // The history cache (#150) pages through a window's events. Ordered like recentEvents, with
    // the id as the tie-break, so pages never overlap or skip a row.
    async eventPage({ accountIds, typeIds, before, offset, limit }): Promise<HistoryEvent[]> {
      if (accountIds.length === 0 || typeIds.length === 0) return [];
      const { data, error } = await db
        .from("activity_events")
        .select("id, external_account_id, type_id, occurred_at")
        .eq("workspace_id", workspaceId)
        .in("external_account_id", accountIds)
        .in("type_id", typeIds)
        .lte("occurred_at", before.toISOString())
        .order("occurred_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + limit - 1);
      if (error) throw new Error("Failed to load events for public metric history", { cause: error });
      return data.flatMap((row) =>
        row.external_account_id === null
          ? []
          : [{ id: row.id, accountId: row.external_account_id, typeId: row.type_id, occurredAt: new Date(row.occurred_at) }],
      );
    },

    // The year in review (#262): counted in the database, so a year of events never travels. The
    // measured plans are in 20261111120000_year_review_slides.sql.
    async eventActivity({ accountIds, excludedTypeIds, from, to }) {
      if (accountIds.length === 0) return { days: [], providers: [] };
      const { data, error } = await db
        .rpc("year_review_event_counts", {
          p_workspace_id: workspaceId,
          p_account_ids: [...accountIds],
          p_excluded_type_ids: [...excludedTypeIds],
          p_from: from.toISOString(),
          p_until: to.toISOString(),
        })
        .limit(YEAR_REVIEW_COUNT_ROWS);
      if (error) throw new Error("Failed to count events for the year in review", { cause: error });
      const rows: readonly YearReviewCountRow[] = data;
      const days: DayCount[] = [];
      const providers: ProviderCount[] = [];
      for (const row of rows) {
        if (row.bucket === "day" && row.day !== null) days.push({ day: row.day, events: row.events });
        if (row.bucket === "provider" && row.provider !== null) providers.push({ provider: row.provider, events: row.events });
      }
      return { days, providers };
    },

    async longestRun({ accountIds, successTypeId, failureTypeId, from, to }) {
      if (accountIds.length === 0) return 0;
      const { data, error } = await db.rpc("year_review_longest_run", {
        p_workspace_id: workspaceId,
        p_account_ids: [...accountIds],
        p_success_type_id: successTypeId,
        p_failure_type_id: failureTypeId,
        p_from: from.toISOString(),
        p_until: to.toISOString(),
      });
      if (error) throw new Error("Failed to find the longest run of deployments for the year in review", { cause: error });
      return data;
    },
  };
}
