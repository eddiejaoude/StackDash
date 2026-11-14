import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { log } from "@/lib/log/logger";
import type { Database } from "@/lib/supabase/database.types";
import { readAllPages } from "@/lib/supabase/paging";

import type { AchievementEvent, EarnedAchievement, MetricReading } from "./evaluate";

/*
 * The reads and the one write of achievement evaluation (#413). Every query runs as the service
 * role, so each is scoped to the workspace by hand, and selects only the columns evaluation uses.
 */

type Db = SupabaseClient<Database>;
export type ProviderId = Database["public"]["Enums"]["provider_id"];

// Bounds for the small lists: a project has a handful of accounts and at most a few hundred
// achievements, a connection a few hundred accounts.
const ACCOUNTS_MAX_ROWS = 2_000;
const EARNED_MAX_ROWS = 5_000;
// Evidence is read oldest first, so a read cut at the bound still proves only what happened:
// anything earned is earned at its true date, and what the bound left out waits for retention to
// drop the oldest rows. 13 months of a busy project's deployments fit well inside it.
const EVENTS_MAX_ROWS = 50_000;
const READINGS_MAX_ROWS = 50_000;

/**
 * The project's accounts per provider. Only included accounts count, as on the dashboard and in
 * alerts: an account the member stopped syncing no longer speaks for the project.
 */
export async function loadProjectAccounts(db: Db, workspaceId: string, projectId: string): Promise<Map<ProviderId, string[]>> {
  const { rows: accounts, complete } = await readAllPages(async (from, to) => {
    const { data, error } = await db
      .from("external_accounts")
      .select("id, connection_id")
      .eq("workspace_id", workspaceId)
      .eq("project_id", projectId)
      .eq("included", true)
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error("Failed to load the project's accounts for achievements", { cause: error });
    return data;
  }, ACCOUNTS_MAX_ROWS);
  if (!complete) log.warn("achievements.accounts_truncated", { workspaceId, projectId, rows: accounts.length });
  if (accounts.length === 0) return new Map();

  const connectionIds = [...new Set(accounts.map((account) => account.connection_id))];
  const { data: connections, error } = await db
    .from("connections")
    .select("id, provider")
    .eq("workspace_id", workspaceId)
    .in("id", connectionIds)
    .order("id", { ascending: true });
  if (error) throw new Error("Failed to load the project's connections for achievements", { cause: error });
  const providerOf = new Map(connections.map((connection) => [connection.id, connection.provider]));

  const byProvider = new Map<ProviderId, string[]>();
  for (const account of accounts) {
    const provider = providerOf.get(account.connection_id);
    if (provider === undefined) continue;
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), account.id]);
  }
  return byProvider;
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
 */
export async function loadEvents(
  db: Db,
  input: Readonly<{ workspaceId: string; accountIds: readonly string[]; typeIds: readonly string[]; now: Date }>,
): Promise<AchievementEvent[]> {
  const { rows, complete } = await readAllPages(async (from, to) => {
    const { data, error } = await db
      .from("activity_events")
      .select("id, type_id, occurred_at")
      .eq("workspace_id", input.workspaceId)
      .in("external_account_id", [...input.accountIds])
      .in("type_id", [...input.typeIds])
      .lte("occurred_at", input.now.toISOString())
      .order("occurred_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error("Failed to load events for achievements", { cause: error });
    return data;
  }, EVENTS_MAX_ROWS);
  if (!complete) log.warn("achievements.events_truncated", { workspaceId: input.workspaceId, rows: rows.length });
  return rows.map((row) => ({ typeId: row.type_id, occurredAt: new Date(row.occurred_at) }));
}

/** Every retained reading of `metricKeys` from the accounts, oldest day first. */
export async function loadReadings(
  db: Db,
  input: Readonly<{ workspaceId: string; accountIds: readonly string[]; metricKeys: readonly string[] }>,
): Promise<MetricReading[]> {
  const { rows, complete } = await readAllPages(async (from, to) => {
    const { data, error } = await db
      .from("usage_snapshots")
      .select("id, external_account_id, metric_key, snapshot_date, value, retrieved_at, point_at, period_start")
      .eq("workspace_id", input.workspaceId)
      .in("external_account_id", [...input.accountIds])
      .in("metric_key", [...input.metricKeys])
      .not("value", "is", null)
      .order("snapshot_date", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to);
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

export type ProviderEarned = Readonly<{ provider: ProviderId; achievement: EarnedAchievement }>;

/**
 * Records what one evaluation proved for one project through record_project_achievements(), which
 * inserts on conflict do nothing and writes one timeline event per newly earned achievement, so a
 * repeated or concurrent evaluation changes nothing. Returns the ids newly earned.
 */
export async function recordAchievements(
  db: Db,
  workspaceId: string,
  projectId: string,
  earned: readonly ProviderEarned[],
): Promise<string[]> {
  const { data, error } = await db.rpc("record_project_achievements", {
    p_workspace_id: workspaceId,
    p_project_id: projectId,
    p_achievements: earned.map(({ provider, achievement }) => ({
      achievement_id: achievement.achievementId,
      provider,
      title: achievement.title,
      public_title: achievement.publicTitle,
      description: achievement.description,
      earned_at: achievement.earnedAt.toISOString(),
      earned_precision: achievement.earnedPrecision,
      evidence: achievement.evidence,
      threshold: achievement.threshold,
    })),
  });
  if (error) throw new Error("Failed to record achievements", { cause: error });
  return data;
}
