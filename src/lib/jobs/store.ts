import "server-only";

import type { OAuthCredential, ProviderId } from "@/lib/adapters/types";
import type { SnapshotInput } from "@/lib/dashboard/aggregate";
import { loadCredential, saveCredential } from "@/lib/data/credentials";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Tables, TablesInsert, TablesUpdate } from "@/lib/supabase/database.types";

/*
 * Persistence for the job system (#44). The runner, scheduler, and retention job only talk to a
 * `JobStore`, so the same logic runs against Postgres in production (this file) and against
 * `memory-store.ts` in unit tests. Every method here runs with the service role: callers are the
 * tick route (authenticated by CRON_SECRET) and `queue.ts` (called by Server Actions after
 * `requireWorkspaceAction`). Every row-level method takes the workspace id and scopes by it.
 */

export type SyncConnection = Pick<
  Tables<"connections">,
  | "id"
  | "workspace_id"
  | "provider"
  | "status"
  | "display_name"
  | "authorized_account_label"
  | "poll_interval_seconds"
  | "consecutive_failures"
  | "missing_scopes"
>;

export type SyncAccount = Pick<Tables<"external_accounts">, "id" | "external_id" | "display_name" | "sync_cursor">;

export type ConnectionPatch = Pick<
  TablesUpdate<"connections">,
  | "status"
  | "next_sync_at"
  | "last_synced_at"
  | "consecutive_failures"
  | "last_error_code"
  | "last_error_reference"
  | "missing_scopes"
>;

export type ClaimedJob = Pick<
  Tables<"sync_jobs">,
  "id" | "workspace_id" | "connection_id" | "kind" | "attempts" | "max_attempts" | "created_at" | "dedupe_key"
>;

export type SnapshotRow = TablesInsert<"usage_snapshots">;
export type EventRow = TablesInsert<"activity_events">;

export type ManualSyncResult = "queued" | "already_queued" | "cooldown" | "not_found";

export type JobFailure = Readonly<{ errorCode: string; errorReference: string | null }>;

export type SummaryConnection = Pick<Tables<"connections">, "id" | "provider">;
export type SummarySnapshot = SnapshotInput;

// One workspace's connections, or one workspace's snapshots for one day. Far above any MVP
// workspace (a few connections, tens of metrics each).
const SUMMARY_ROW_LIMIT = 5000;

export type ConnectionKey = Readonly<{ workspaceId: string; connectionId: string }>;

export interface JobStore {
  /** Queues a sync for every due connection (see enqueue_due_syncs). Returns how many were queued. */
  enqueueDueSyncs(limit: number): Promise<number>;
  /**
   * Makes every active connection of `providers` due at `at`, so the next schedule queues it.
   * Only `npm run jobs:tick -- --watch` calls it, for simulated providers (#131). Returns how many moved.
   */
  markSyncsDue(providers: readonly ProviderId[], at: Date): Promise<number>;
  /** Queues one sync unless one is already open. False also when the connection is not in the workspace. */
  enqueueSync(key: ConnectionKey): Promise<boolean>;
  /** "Sync now": cooldown check, cooldown stamp, and enqueue in one atomic step. */
  requestManualSync(key: ConnectionKey & Readonly<{ cooldownSeconds: number }>): Promise<ManualSyncResult>;
  /** Queues the instance-wide retention job once per dedupe key. */
  enqueueRetention(dedupeKey: string): Promise<boolean>;

  claimJobs(limit: number, leaseSeconds: number): Promise<ClaimedJob[]>;
  /** Returns a claimed job that was never started to the queue without spending an attempt. */
  releaseJob(jobId: string): Promise<void>;
  completeJob(jobId: string, finishedAt: Date): Promise<void>;
  retryJob(jobId: string, runAfter: Date, failure: JobFailure): Promise<void>;
  failJob(jobId: string, finishedAt: Date, failure: JobFailure): Promise<void>;

  getConnection(key: ConnectionKey): Promise<SyncConnection | null>;
  listIncludedAccounts(key: ConnectionKey): Promise<SyncAccount[]>;
  updateConnection(key: ConnectionKey, patch: ConnectionPatch): Promise<void>;
  loadCredential(key: ConnectionKey): Promise<OAuthCredential | null>;
  saveCredential(key: ConnectionKey, credential: OAuthCredential): Promise<void>;

  /** metric_key -> resets_at (ISO, or null) of the latest snapshot of each metric of the account. */
  latestResets(workspaceId: string, externalAccountId: string): Promise<Map<string, string | null>>;
  /** Upserts on (external_account_id, metric_key, snapshot_date). */
  upsertSnapshots(rows: readonly SnapshotRow[]): Promise<void>;
  /** Inserts, skipping rows whose (workspace_id, dedupe_key) already exists. Returns how many were new. */
  insertEvents(rows: readonly EventRow[]): Promise<number>;
  setCursor(workspaceId: string, externalAccountId: string, cursor: string | null): Promise<void>;

  purgeSnapshots(beforeDate: string, limit: number): Promise<number>;
  purgeEvents(before: Date, limit: number): Promise<number>;
  purgeJobs(before: Date, limit: number): Promise<number>;
  /** Deletes OAuth states whose expires_at is at or before `before` (abandoned connect flows). */
  purgeOAuthStates(before: Date, limit: number): Promise<number>;

  /** Queues one daily_summary job per workspace with a connection, keyed by the summarized date. */
  enqueueDailySummaries(date: string): Promise<number>;
  /** Connections that count for the summary (everything but revoked). */
  listSummaryConnections(workspaceId: string): Promise<SummaryConnection[]>;
  listSnapshotsForDate(workspaceId: string, date: string): Promise<SummarySnapshot[]>;
}

// Errors carry the operation and the Postgres code only, never row data.
function failure(operation: string, error: { code: string }): Error {
  return new Error(`Job store ${operation} failed (code ${error.code}).`);
}

const MANUAL_SYNC_RESULTS: readonly ManualSyncResult[] = ["queued", "already_queued", "cooldown", "not_found"];

function isManualSyncResult(value: unknown): value is ManualSyncResult {
  return MANUAL_SYNC_RESULTS.some((result) => result === value);
}

export function createSupabaseJobStore(): JobStore {
  const db = createAdminClient();

  return {
    async enqueueDueSyncs(limit) {
      const { data, error } = await db.rpc("enqueue_due_syncs", { p_limit: limit });
      if (error) throw failure("enqueue_due_syncs", error);
      return data;
    },

    async markSyncsDue(providers, at) {
      if (providers.length === 0) return 0;
      const due = at.toISOString();
      // Never-scheduled connections (next_sync_at null) are already due and stay untouched.
      const { data, error } = await db
        .from("connections")
        .update({ next_sync_at: due })
        .in("provider", [...providers])
        .eq("status", "active")
        .gt("next_sync_at", due)
        .select("id");
      if (error) throw failure("mark syncs due", error);
      return data.length;
    },

    async enqueueSync({ workspaceId, connectionId }) {
      const { data, error } = await db.rpc("enqueue_sync_job", {
        p_workspace_id: workspaceId,
        p_connection_id: connectionId,
      });
      if (error) throw failure("enqueue_sync_job", error);
      return data;
    },

    async requestManualSync({ workspaceId, connectionId, cooldownSeconds }) {
      const { data, error } = await db.rpc("request_manual_sync", {
        p_workspace_id: workspaceId,
        p_connection_id: connectionId,
        p_cooldown_seconds: cooldownSeconds,
      });
      if (error) throw failure("request_manual_sync", error);
      if (!isManualSyncResult(data)) throw new Error("Job store request_manual_sync returned an unknown result.");
      return data;
    },

    async enqueueRetention(dedupeKey) {
      const { data, error } = await db
        .from("sync_jobs")
        .upsert({ kind: "retention", dedupe_key: dedupeKey }, { onConflict: "dedupe_key", ignoreDuplicates: true })
        .select("id");
      if (error) throw failure("enqueue retention", error);
      return data.length > 0;
    },

    async claimJobs(limit, leaseSeconds) {
      const { data, error } = await db
        .rpc("claim_sync_jobs", { p_limit: limit, p_lease_seconds: leaseSeconds })
        .select("id, workspace_id, connection_id, kind, attempts, max_attempts, created_at, dedupe_key");
      if (error) throw failure("claim_sync_jobs", error);
      return data;
    },

    async releaseJob(jobId) {
      const { data: job, error: readError } = await db
        .from("sync_jobs")
        .select("attempts")
        .eq("id", jobId)
        .eq("status", "running")
        .maybeSingle();
      if (readError) throw failure("release read", readError);
      if (job === null) return;
      const { error } = await db
        .from("sync_jobs")
        .update({
          status: "queued",
          locked_until: null,
          started_at: null,
          attempts: Math.max(0, job.attempts - 1),
        })
        .eq("id", jobId)
        .eq("status", "running");
      if (error) throw failure("release", error);
    },

    async completeJob(jobId, finishedAt) {
      const { error } = await db
        .from("sync_jobs")
        .update({
          status: "succeeded",
          locked_until: null,
          finished_at: finishedAt.toISOString(),
          error_code: null,
          error_reference: null,
        })
        .eq("id", jobId);
      if (error) throw failure("complete", error);
    },

    async retryJob(jobId, runAfter, { errorCode, errorReference }) {
      const { error } = await db
        .from("sync_jobs")
        .update({
          status: "queued",
          locked_until: null,
          run_after: runAfter.toISOString(),
          error_code: errorCode,
          error_reference: errorReference,
        })
        .eq("id", jobId);
      if (error) throw failure("retry", error);
    },

    async failJob(jobId, finishedAt, { errorCode, errorReference }) {
      const { error } = await db
        .from("sync_jobs")
        .update({
          status: "failed",
          locked_until: null,
          finished_at: finishedAt.toISOString(),
          error_code: errorCode,
          error_reference: errorReference,
        })
        .eq("id", jobId);
      if (error) throw failure("fail", error);
    },

    async getConnection({ workspaceId, connectionId }) {
      const { data, error } = await db
        .from("connections")
        .select(
          "id, workspace_id, provider, status, display_name, authorized_account_label, poll_interval_seconds, consecutive_failures, missing_scopes",
        )
        .eq("id", connectionId)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (error) throw failure("connection read", error);
      return data;
    },

    async listIncludedAccounts({ workspaceId, connectionId }) {
      // Bounded: a connection with more accounts than this syncs the first ones by id. No MVP
      // provider grant comes close.
      const { data, error } = await db
        .from("external_accounts")
        .select("id, external_id, display_name, sync_cursor")
        .eq("workspace_id", workspaceId)
        .eq("connection_id", connectionId)
        .eq("included", true)
        .order("id")
        .limit(200);
      if (error) throw failure("accounts read", error);
      return data;
    },

    async updateConnection({ workspaceId, connectionId }, patch) {
      const { error } = await db
        .from("connections")
        .update(patch)
        .eq("id", connectionId)
        .eq("workspace_id", workspaceId);
      if (error) throw failure("connection update", error);
    },

    loadCredential(key) {
      return loadCredential(key);
    },

    saveCredential(key, credential) {
      return saveCredential({ ...key, credential });
    },

    async latestResets(workspaceId, externalAccountId) {
      const { data, error } = await db.rpc("latest_usage_resets", {
        p_workspace_id: workspaceId,
        p_external_account_id: externalAccountId,
      });
      if (error) throw failure("latest_usage_resets", error);
      return new Map(data.map((row) => [row.metric_key, row.resets_at]));
    },

    async upsertSnapshots(rows) {
      if (rows.length === 0) return;
      const { error } = await db
        .from("usage_snapshots")
        .upsert([...rows], { onConflict: "external_account_id,metric_key,snapshot_date" });
      if (error) throw failure("snapshot upsert", error);
    },

    async insertEvents(rows) {
      if (rows.length === 0) return 0;
      // With ignoreDuplicates only the rows actually inserted come back.
      const { data, error } = await db
        .from("activity_events")
        .upsert([...rows], { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true })
        .select("id");
      if (error) throw failure("event insert", error);
      return data.length;
    },

    async setCursor(workspaceId, externalAccountId, cursor) {
      const { error } = await db
        .from("external_accounts")
        .update({ sync_cursor: cursor })
        .eq("id", externalAccountId)
        .eq("workspace_id", workspaceId);
      if (error) throw failure("cursor update", error);
    },

    async purgeSnapshots(beforeDate, limit) {
      const { data, error } = await db.rpc("purge_usage_snapshots", { p_before: beforeDate, p_limit: limit });
      if (error) throw failure("purge_usage_snapshots", error);
      return data;
    },

    async purgeEvents(before, limit) {
      const { data, error } = await db.rpc("purge_activity_events", { p_before: before.toISOString(), p_limit: limit });
      if (error) throw failure("purge_activity_events", error);
      return data;
    },

    async purgeJobs(before, limit) {
      const { data, error } = await db.rpc("purge_sync_jobs", { p_before: before.toISOString(), p_limit: limit });
      if (error) throw failure("purge_sync_jobs", error);
      return data;
    },

    async purgeOAuthStates(before, limit) {
      const { data, error } = await db.rpc("purge_oauth_states", { p_before: before.toISOString(), p_limit: limit });
      if (error) throw failure("purge_oauth_states", error);
      return data;
    },

    async enqueueDailySummaries(date) {
      const { data, error } = await db.rpc("enqueue_daily_summaries", { p_date: date });
      if (error) throw failure("enqueue_daily_summaries", error);
      return data;
    },

    async listSummaryConnections(workspaceId) {
      const { data, error } = await db
        .from("connections")
        .select("id, provider")
        .eq("workspace_id", workspaceId)
        .neq("status", "revoked")
        .order("id")
        .limit(SUMMARY_ROW_LIMIT);
      if (error) throw failure("summary connections read", error);
      return data;
    },

    async listSnapshotsForDate(workspaceId, date) {
      const { data, error } = await db
        .from("usage_snapshots")
        .select(
          "connection_id, external_account_id, metric_key, kind, label, snapshot_date, value, unit, amount_minor, currency, period_start, period_end, point_at, resets_at, retrieved_at, provenance_source, pricing_source",
        )
        .eq("workspace_id", workspaceId)
        .eq("snapshot_date", date)
        .order("id")
        .limit(SUMMARY_ROW_LIMIT);
      if (error) throw failure("summary snapshots read", error);
      return data;
    },
  };
}
