import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import { afterCursorFilter } from "@/lib/data/cursor";
import { log } from "@/lib/log/logger";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { MAX_ROWS_PER_REQUEST, readAllPages, type PagedRows } from "@/lib/supabase/paging";

import type { AchievementEvent, EarnedAchievement, MetricReading } from "./evaluate";

/*
 * The reads and the one write of achievement evaluation (#413). Every query runs as the service
 * role, so each is scoped to the workspace by hand, and selects only the columns evaluation uses.
 */

type Db = SupabaseClient<Database>;
export type ProviderId = Database["public"]["Enums"]["provider_id"];

// Bounds for the small lists: a workspace has a handful of connections of one provider, a project
// a handful of accounts and at most a few hundred achievements, a connection a few hundred accounts.
const CONNECTIONS_MAX_ROWS = 500;
const ACCOUNTS_MAX_ROWS = 2_000;
const EARNED_MAX_ROWS = 5_000;
// Evidence is read oldest first, so a read cut at the bound still proves only what happened:
// anything earned is earned at its true date, and what the bound left out waits for retention to
// drop the oldest rows. 13 months of a busy project's deployments fit well inside it.
const EVENTS_MAX_ROWS = 50_000;
const READINGS_MAX_ROWS = 50_000;

/**
 * Every row of one query in its keyset order, read in pages of at most MAX_ROWS_PER_REQUEST rows,
 * up to `maxRows`. `readPage(after, limit)` returns at most `limit` rows that come after the row
 * `after` (from the start when null), ordered by a key that ends with a unique column. Unlike an
 * offset, each page starts where the last one ended, so the database never rescans the rows before
 * it, and a row written or deleted between two requests cannot shift a later page.
 */
async function readAllAfter<Row>(
  readPage: (after: Row | null, limit: number) => PromiseLike<readonly Row[]>,
  maxRows: number,
): Promise<PagedRows<Row>> {
  const rows: Row[] = [];
  let after: Row | null = null;
  while (rows.length < maxRows) {
    const limit = Math.min(MAX_ROWS_PER_REQUEST, maxRows - rows.length);
    const page = await readPage(after, limit);
    rows.push(...page);
    const last = page.at(-1);
    if (page.length < limit || last === undefined) return { rows, complete: true };
    after = last;
  }
  return { rows, complete: false };
}

/** The connection's provider, or null when the connection is gone from the workspace. */
export async function loadConnectionProvider(db: Db, workspaceId: string, connectionId: string): Promise<ProviderId | null> {
  const { data, error } = await db
    .from("connections")
    .select("provider")
    .eq("workspace_id", workspaceId)
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw new Error("Failed to load the synced connection for achievements", { cause: error });
  return data?.provider ?? null;
}

/**
 * The workspace's connections of one provider, each mapped to whether the provider simulator made
 * it (`isSimulatedConnection`, from its granted scopes), so an achievement earned from made-up data
 * is recorded as simulated.
 */
export async function loadProviderConnections(db: Db, workspaceId: string, provider: ProviderId): Promise<Map<string, boolean>> {
  const { rows, complete } = await readAllPages(async (from, to) => {
    const { data, error } = await db
      .from("connections")
      .select("id, granted_scopes")
      .eq("workspace_id", workspaceId)
      .eq("provider", provider)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error("Failed to load the provider's connections for achievements", { cause: error });
    return data;
  }, CONNECTIONS_MAX_ROWS);
  if (!complete) log.warn("achievements.connections_truncated", { workspaceId, provider, rows: rows.length });
  return new Map(rows.map((connection) => [connection.id, isSimulatedConnection(connection)]));
}

export type ProjectAccounts = Readonly<{
  accountIds: string[];
  // True when any of the accounts is on a simulated connection.
  simulated: boolean;
}>;

/**
 * The project's accounts on `connections` (one provider's, from loadProviderConnections). Only
 * included accounts count, as on the dashboard and in alerts: an account the member stopped
 * syncing no longer speaks for the project.
 */
export async function loadProjectAccounts(
  db: Db,
  input: Readonly<{ workspaceId: string; projectId: string; connections: ReadonlyMap<string, boolean> }>,
): Promise<ProjectAccounts> {
  if (input.connections.size === 0) return { accountIds: [], simulated: false };
  const { rows, complete } = await readAllPages(async (from, to) => {
    const { data, error } = await db
      .from("external_accounts")
      .select("id, connection_id")
      .eq("workspace_id", input.workspaceId)
      .eq("project_id", input.projectId)
      .eq("included", true)
      .in("connection_id", [...input.connections.keys()])
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error("Failed to load the project's accounts for achievements", { cause: error });
    return data;
  }, ACCOUNTS_MAX_ROWS);
  if (!complete) log.warn("achievements.accounts_truncated", { workspaceId: input.workspaceId, projectId: input.projectId, rows: rows.length });
  return {
    accountIds: rows.map((row) => row.id),
    simulated: rows.some((row) => input.connections.get(row.connection_id) === true),
  };
}

/** The projects a connection's included accounts are assigned to. */
export async function loadConnectionProjectIds(db: Db, workspaceId: string, connectionId: string): Promise<string[]> {
  const { rows, complete } = await readAllPages(async (from, to) => {
    const { data, error } = await db
      .from("external_accounts")
      .select("id, project_id")
      .eq("workspace_id", workspaceId)
      .eq("connection_id", connectionId)
      .eq("included", true)
      .not("project_id", "is", null)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error("Failed to load the connection's projects for achievements", { cause: error });
    return data;
  }, ACCOUNTS_MAX_ROWS);
  if (!complete) log.warn("achievements.accounts_truncated", { workspaceId, connectionId, rows: rows.length });
  return [...new Set(rows.flatMap((row) => (row.project_id === null ? [] : [row.project_id])))];
}

/** The ids the project has already earned, whichever adapter still declares them. */
export async function loadEarnedIds(db: Db, workspaceId: string, projectId: string): Promise<Set<string>> {
  const { rows, complete } = await readAllPages(async (from, to) => {
    const { data, error } = await db
      .from("project_achievements")
      .select("achievement_id")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId)
      .order("achievement_id", { ascending: true })
      .range(from, to);
    if (error) throw new Error("Failed to load earned achievements", { cause: error });
    return data;
  }, EARNED_MAX_ROWS);
  // Harmless when cut: recording an earned achievement again changes nothing.
  if (!complete) log.warn("achievements.earned_truncated", { workspaceId, projectId, rows: rows.length });
  return new Set(rows.map((row) => row.achievement_id));
}

/**
 * Every retained event of `typeIds` from the accounts, up to `now`, oldest first (occurred_at,
 * then id). All of them, not a rolling window, so a 10th event stays provable after it leaves any
 * 30 day metric.
 *
 * Keyset paging: each page after the first starts at `occurred_at >= cursor`, an index bound, so a
 * deep page costs what the first does. Measured for #413 (1M events from one account, 200 from
 * another in the same workspace, 900k elsewhere): a page 200 days deep used
 * activity_events_workspace_type_time_idx (workspace_id, type_id, occurred_at) with that bound,
 * 1.9 ms; the sparse account used activity_events_external_account_id_idx and a sort, 0.3 ms.
 */
export async function loadEvents(
  db: Db,
  input: Readonly<{ workspaceId: string; accountIds: readonly string[]; typeIds: readonly string[]; now: Date }>,
): Promise<AchievementEvent[]> {
  type EventRow = Pick<Tables<"activity_events">, "id" | "type_id" | "occurred_at">;
  const { rows, complete } = await readAllAfter<EventRow>(async (after, limit) => {
    let query = db
      .from("activity_events")
      .select("id, type_id, occurred_at")
      .eq("workspace_id", input.workspaceId)
      .in("external_account_id", [...input.accountIds])
      .in("type_id", [...input.typeIds])
      .lte("occurred_at", input.now.toISOString());
    // The `gte` is the index bound the scan starts from; the `or` then drops the rows at the
    // cursor's own instant that were already read.
    if (after !== null) query = query.gte("occurred_at", after.occurred_at).or(afterCursorFilter("occurred_at", [after.occurred_at, after.id]));
    const { data, error } = await query.order("occurred_at", { ascending: true }).order("id", { ascending: true }).limit(limit);
    if (error) throw new Error("Failed to load events for achievements", { cause: error });
    return data;
  }, EVENTS_MAX_ROWS);
  if (!complete) log.warn("achievements.events_truncated", { workspaceId: input.workspaceId, rows: rows.length });
  return rows.map((row) => ({ typeId: row.type_id, occurredAt: new Date(row.occurred_at) }));
}

/**
 * Every retained reading of `metricKeys` from the accounts, oldest day first (snapshot_date, then
 * id), so a read cut at the bound drops the newest days of every account rather than whole accounts.
 *
 * Index: usage_snapshots_account_metric_date_key (external_account_id, metric_key, snapshot_date),
 * one range per account and metric, starting at `snapshot_date >= cursor` after the first page. Its
 * order is per account and metric, not across them, so the sort by (snapshot_date, id) runs on the
 * rows it returns: one per account, metric, and day, 0.6 ms for 3 accounts over 400 days.
 */
export async function loadReadings(
  db: Db,
  input: Readonly<{ workspaceId: string; accountIds: readonly string[]; metricKeys: readonly string[] }>,
): Promise<MetricReading[]> {
  type ReadingRow = Pick<
    Tables<"usage_snapshots">,
    "id" | "external_account_id" | "metric_key" | "snapshot_date" | "value" | "retrieved_at" | "point_at" | "period_start"
  >;
  const { rows, complete } = await readAllAfter<ReadingRow>(async (after, limit) => {
    let query = db
      .from("usage_snapshots")
      .select("id, external_account_id, metric_key, snapshot_date, value, retrieved_at, point_at, period_start")
      .eq("workspace_id", input.workspaceId)
      .in("external_account_id", [...input.accountIds])
      .in("metric_key", [...input.metricKeys])
      .not("value", "is", null);
    if (after !== null) query = query.gte("snapshot_date", after.snapshot_date).or(afterCursorFilter("snapshot_date", [after.snapshot_date, after.id]));
    const { data, error } = await query.order("snapshot_date", { ascending: true }).order("id", { ascending: true }).limit(limit);
    if (error) throw new Error("Failed to load metric readings for achievements", { cause: error });
    return data;
  }, READINGS_MAX_ROWS);
  if (!complete) log.warn("achievements.readings_truncated", { workspaceId: input.workspaceId, rows: rows.length });
  return rows.flatMap((row) =>
    row.value === null
      ? []
      : [
          {
            accountId: row.external_account_id,
            metricKey: row.metric_key,
            snapshotDate: row.snapshot_date,
            value: row.value,
            // A point in time reading held at point_at; any other at the moment it was read.
            observedAt: new Date(row.point_at ?? row.retrieved_at),
            periodStart: row.period_start === null ? null : new Date(row.period_start),
          },
        ],
  );
}

/**
 * Records what one evaluation of one provider proved for one project through
 * record_project_achievements(), which inserts on conflict do nothing and writes one timeline
 * event per newly earned achievement, so a repeated or concurrent evaluation changes nothing.
 * Returns the ids newly earned.
 */
export async function recordAchievements(
  db: Db,
  input: Readonly<{
    workspaceId: string;
    projectId: string;
    provider: ProviderId;
    // True when any account the evidence came from is on a simulated connection.
    simulated: boolean;
    achievements: readonly EarnedAchievement[];
  }>,
): Promise<string[]> {
  const { data, error } = await db.rpc("record_project_achievements", {
    p_workspace_id: input.workspaceId,
    p_project_id: input.projectId,
    p_achievements: input.achievements.map((achievement) => ({
      achievement_id: achievement.achievementId,
      provider: input.provider,
      title: achievement.title,
      public_title: achievement.publicTitle,
      description: achievement.description,
      earned_at: achievement.earnedAt.toISOString(),
      earned_precision: achievement.earnedPrecision,
      evidence: achievement.evidence,
      threshold: achievement.threshold,
      simulated: input.simulated,
    })),
  });
  if (error) throw new Error("Failed to record achievements", { cause: error });
  return data;
}
