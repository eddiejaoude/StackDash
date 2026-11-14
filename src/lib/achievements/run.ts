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
  loadEarnedIds,
  loadEvents,
  loadProjectAccounts,
  loadReadings,
  recordAchievements,
  type ProviderEarned,
  type ProviderId,
} from "./store";

/*
 * Evaluates a project's achievements (#413). Called by the sync runner after each successful sync
 * of a connection, for every project its accounts are assigned to. Achievements count per
 * provider: each provider's definitions are evaluated against that provider's accounts only.
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

async function evaluateProject(db: Db, workspaceId: string, projectId: string, now: Date): Promise<number> {
  const [accounts, earnedIds] = await Promise.all([
    loadProjectAccounts(db, workspaceId, projectId),
    loadEarnedIds(db, workspaceId, projectId),
  ]);

  const proved: ProviderEarned[] = [];
  for (const [provider, accountIds] of accounts) {
    const pending = declaredAchievements(provider).filter((achievement) => !earnedIds.has(achievement.id));
    if (pending.length === 0) continue;
    const typeIds = [...new Set(pending.flatMap((achievement) => achievementRuleTypeIds(achievement.rule)))];
    const metricKeys = [
      ...new Set(pending.flatMap((achievement) => achievementRuleMetricKey(achievement.rule) ?? [])),
    ];
    const [events, readings] = await Promise.all([
      typeIds.length === 0 ? [] : loadEvents(db, { workspaceId, accountIds, typeIds, now }),
      metricKeys.length === 0 ? [] : loadReadings(db, { workspaceId, accountIds, metricKeys }),
    ]);
    for (const achievement of evaluateAchievements({ achievements: pending, earnedIds, events, readings })) {
      proved.push({ provider, achievement });
    }
  }
  if (proved.length === 0) return 0;

  const earned = await recordAchievements(db, workspaceId, projectId, proved);
  if (earned.length > 0) log.info("achievements.earned", { workspaceId, projectId, earned: earned.length });
  return earned.length;
}

/** Evaluates one project. Returns how many achievements it newly earned. */
export async function evaluateProjectAchievements(workspaceId: string, projectId: string, now: Date): Promise<number> {
  return evaluateProject(createAdminClient(), workspaceId, projectId, now);
}

/**
 * Evaluates every project the connection's accounts are assigned to, one after another. Returns
 * how many achievements they newly earned together.
 */
export async function evaluateConnectionAchievements(workspaceId: string, connectionId: string, now: Date): Promise<number> {
  const db = createAdminClient();
  let earned = 0;
  for (const projectId of await loadConnectionProjectIds(db, workspaceId, connectionId)) {
    earned += await evaluateProject(db, workspaceId, projectId, now);
  }
  return earned;
}
