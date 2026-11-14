import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { achievementRuleMetricKey, achievementRuleTypeIds, type Achievement } from "@/lib/adapters/achievements";
import { getAdapter, isFakeProviderEnabled } from "@/lib/adapters/registry";
import { log } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

import { evaluateAchievements } from "./evaluate";
import {
  loadConnectionProjectIds,
  loadConnectionProvider,
  loadEarnedIds,
  loadEvents,
  loadProjectAccounts,
  loadProviderConnections,
  loadReadings,
  recordAchievements,
  type ProviderId,
} from "./store";

/*
 * Evaluates achievements after a sync (#413). The sync runner calls this after each successful
 * sync of a connection: for every project the connection's accounts are assigned to, the synced
 * provider's achievements are evaluated against all of that project's included accounts of the
 * provider, across its connections. Another provider's evidence cannot change with this sync, so
 * it is not read; its own syncs evaluate it.
 *
 * Evaluation reads all retained evidence, so it is also the backfill: the first run after deploy
 * (or after an account is assigned to a project) earns everything stored history proves, at its
 * historical dates. Only what is not yet earned is evaluated, and only the event types and metric
 * keys those rules read are loaded.
 */

type Db = SupabaseClient<Database>;

function declaredAchievements(provider: ProviderId): readonly Achievement[] {
  // The fake provider's stored rows outlive its flag, but its adapter cannot be loaded without it.
  if (provider === "fake" && !isFakeProviderEnabled()) return [];
  return getAdapter(provider).achievements ?? [];
}

type ProviderScope = Readonly<{
  workspaceId: string;
  provider: ProviderId;
  achievements: readonly Achievement[];
  // The workspace's connections of the provider, each mapped to whether it is simulated.
  connections: ReadonlyMap<string, boolean>;
  now: Date;
}>;

/** Evaluates one provider's achievements for one project. Returns how many it newly earned. */
async function evaluateProject(db: Db, scope: ProviderScope, projectId: string): Promise<number> {
  const { workspaceId, provider, connections, now } = scope;
  const [accounts, earnedIds] = await Promise.all([
    loadProjectAccounts(db, { workspaceId, projectId, connections }),
    loadEarnedIds(db, workspaceId, projectId),
  ]);
  const { accountIds, simulated } = accounts;
  const pending = scope.achievements.filter((achievement) => !earnedIds.has(achievement.id));
  if (accountIds.length === 0 || pending.length === 0) return 0;

  const typeIds = [...new Set(pending.flatMap((achievement) => achievementRuleTypeIds(achievement.rule)))];
  const metricKeys = [...new Set(pending.flatMap((achievement) => achievementRuleMetricKey(achievement.rule) ?? []))];
  const [events, readings] = await Promise.all([
    typeIds.length === 0 ? [] : loadEvents(db, { workspaceId, accountIds, typeIds, now }),
    metricKeys.length === 0 ? [] : loadReadings(db, { workspaceId, accountIds, metricKeys }),
  ]);
  const proved = evaluateAchievements({ achievements: pending, earnedIds, events, readings });
  if (proved.length === 0) return 0;

  const earned = await recordAchievements(db, { workspaceId, projectId, provider, simulated, achievements: proved });
  if (earned.length > 0) log.info("achievements.earned", { workspaceId, projectId, provider, earned: earned.length });
  return earned.length;
}

/**
 * Evaluates the synced connection's provider for every project the connection's accounts are
 * assigned to, one after another. Returns how many achievements they newly earned together.
 */
export async function evaluateConnectionAchievements(workspaceId: string, connectionId: string, now: Date): Promise<number> {
  const db = createAdminClient();
  const provider = await loadConnectionProvider(db, workspaceId, connectionId);
  if (provider === null) return 0;
  const achievements = declaredAchievements(provider);
  if (achievements.length === 0) return 0;

  const [projectIds, connections] = await Promise.all([
    loadConnectionProjectIds(db, workspaceId, connectionId),
    loadProviderConnections(db, workspaceId, provider),
  ]);
  const scope: ProviderScope = { workspaceId, provider, achievements, connections, now };
  let earned = 0;
  for (const projectId of projectIds) earned += await evaluateProject(db, scope, projectId);
  return earned;
}
