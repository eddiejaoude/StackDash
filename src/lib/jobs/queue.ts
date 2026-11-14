import "server-only";

import { evaluateConnectionAchievements } from "@/lib/achievements/run";
import { createOAuthContext, getAdapter, loadOAuthClient } from "@/lib/adapters/registry";
import { evaluateWorkspaceAlerts } from "@/lib/alerts/run";
import { log, logError } from "@/lib/log/logger";
import { createNotificationDeps } from "@/lib/notifications/deps";

import { createSupabaseJobStore } from "./store";
import type { SyncDeps } from "./sync-connection";

/*
 * Entry points for the rest of the app. Callers (Server Actions, the OAuth callback) must have
 * authorized the user for the workspace with `requireWorkspaceAction` first: the store runs with
 * the service role. The workspace id and connection id are re-checked together in the database,
 * so a connection id from another workspace queues nothing.
 */

/** "Sync now" is accepted at most once per connection per this many seconds. */
export const MANUAL_SYNC_COOLDOWN_SECONDS = 300;

export type EnqueueSyncInput = Readonly<{
  workspaceId: string;
  connectionId: string;
  reason: "initial" | "manual" | "scheduled";
}>;

/**
 * Queues a sync unless one is already queued or running for the connection. A manual request
 * inside the cooldown, or for a connection outside the workspace, returns `{ queued: false }`.
 */
export async function enqueueSync({ workspaceId, connectionId, reason }: EnqueueSyncInput): Promise<{ queued: boolean }> {
  const store = createSupabaseJobStore();
  if (reason === "manual") {
    const result = await store.requestManualSync({
      workspaceId,
      connectionId,
      cooldownSeconds: MANUAL_SYNC_COOLDOWN_SECONDS,
    });
    log.info("sync.requested", { workspaceId, connectionId, reason, result });
    return { queued: result === "queued" };
  }
  const queued = await store.enqueueSync({ workspaceId, connectionId });
  log.info("sync.requested", { workspaceId, connectionId, reason, result: queued ? "queued" : "not_queued" });
  return { queued };
}

/** Production wiring for the tick: Postgres store, adapter registry, real clock and randomness. */
export function createJobDeps(): SyncDeps {
  return {
    store: createSupabaseJobStore(),
    getAdapter,
    loadOAuthClient,
    createOAuthContext,
    now: () => new Date(),
    random: Math.random,
    logError,
    log,
    evaluateAlerts: evaluateWorkspaceAlerts,
    evaluateAchievements: evaluateConnectionAchievements,
    notifications: createNotificationDeps,
  };
}
