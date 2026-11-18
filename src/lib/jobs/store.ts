import "server-only";

import { z } from "zod";

import { ActivityEventSchema } from "@/lib/adapters/events";
import { SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";
import { ProviderIdSchema, type OAuthCredential, type ProviderId, type WebhookOutcome } from "@/lib/adapters/types";
import { ANOMALY_KINDS, type AnomalyMute, type AnomalyRow } from "@/lib/alerts/anomaly";
import type { SnapshotInput } from "@/lib/dashboard/aggregate";
import {
  acquireCredentialRefreshLock,
  loadCredential,
  releaseCredentialRefreshLock,
  saveCredential,
} from "@/lib/data/credentials";
import { log } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Json, Tables, TablesInsert, TablesUpdate } from "@/lib/supabase/database.types";
import { readAllPages } from "@/lib/supabase/paging";

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
  | "external_installation_id"
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
  | "external_installation_id"
>;

export type ClaimedJob = Pick<
  Tables<"sync_jobs">,
  "id" | "workspace_id" | "connection_id" | "kind" | "attempts" | "max_attempts" | "created_at" | "dedupe_key" | "webhook_delivery_id"
>;

// What claimJobs and claimWebhookJobs read back of each claimed row.
const CLAIMED_JOB_COLUMNS = "id, workspace_id, connection_id, kind, attempts, max_attempts, created_at, dedupe_key, webhook_delivery_id";

export type SnapshotRow = TablesInsert<"usage_snapshots">;
export type EventRow = TablesInsert<"activity_events">;

export type ManualSyncResult = "queued" | "already_queued" | "cooldown" | "not_found";

export type JobFailure = Readonly<{ errorCode: string; errorReference: string | null }>;

export type SummaryConnection = Pick<Tables<"connections">, "id" | "provider">;
export type SummarySnapshot = SnapshotInput;

// One workspace's connections, or one workspace's snapshots for the summary's history window, read
// in pages of the Data API's row cap (readAllPages). Far above any MVP workspace (a few
// connections, tens of metrics each, one row a day).
export const SUMMARY_ROW_LIMIT = 5000;

export type AnomalySettings = Readonly<{ enabled: boolean; mutes: readonly AnomalyMute[] }>;

// Anomaly detection reads 17 days of spend and usage rows in pages of the Data API's row cap
// (readAllPages). The total bound is far above any MVP workspace.
export const ANOMALY_ROW_LIMIT = 20_000;
// Mutes per workspace: one per metric a person chose to silence.
const ANOMALY_MUTE_LIMIT = 1000;

export type ConnectionKey = Readonly<{ workspaceId: string; connectionId: string }>;

/**
 * An outcome a webhook job has work for. An `ignored` delivery is stored already processed, with no
 * outcome and no job (record_webhook_delivery), so a job never reads one back.
 */
export type StoredWebhookOutcome = Exclude<WebhookOutcome, { kind: "ignored" }>;

/** A verified delivery as the webhook job reads it back (#28). `endpointId` is null for an app-level URL. */
export type WebhookDeliveryRecord = Readonly<{
  id: string;
  provider: ProviderId;
  endpointId: string | null;
  outcome: StoredWebhookOutcome;
}>;

/**
 * A live connection a delivery acts on. `grantedAt` is when the connection was last granted, by a
 * connect or a reconnect (ISO), and null for a live connection with no recorded grant (#502;
 * docs/operations/jobs.md, Uninstalled, says which those are). A token refresh does not move it,
 * so an uninstall older than a reconnect is left to the next sync while one older than only a
 * refresh is applied.
 */
export type ConnectionTarget = Readonly<{ workspaceId: string; connectionId: string; grantedAt: string | null }>;

/** An included external account of a live connection that a delivery's account maps to. */
export type WebhookTarget = ConnectionTarget & Readonly<{ accountId: string }>;

export type RecordWebhookDeliveryInput = Readonly<{
  provider: ProviderId;
  deliveryId: string;
  endpointId: string | null;
  outcome: WebhookOutcome;
}>;

export interface JobStore {
  /** Queues a sync for every due connection (see enqueue_due_syncs). Returns how many were queued. */
  enqueueDueSyncs(limit: number): Promise<number>;
  /**
   * Makes every active connection the simulator made (`granted_scopes` holds SIMULATED_SCOPE) due
   * at `at`, so the next schedule queues it. Real connections are never touched, whatever their
   * provider. Only `npm run jobs:tick -- --watch` calls it (#131). Returns how many active
   * simulated connections are due after the call, so zero means there is nothing to stream.
   */
  markSimulatedSyncsDue(at: Date): Promise<number>;
  /** Queues one sync unless one is already open. False also when the connection is not in the workspace. */
  enqueueSync(key: ConnectionKey): Promise<boolean>;
  /** "Sync now": cooldown check, cooldown stamp, and enqueue in one atomic step. */
  requestManualSync(key: ConnectionKey & Readonly<{ cooldownSeconds: number }>): Promise<ManualSyncResult>;
  /** Queues the instance-wide retention job once per dedupe key. */
  enqueueRetention(dedupeKey: string): Promise<boolean>;

  /** Claims due jobs of every kind but `webhook`, oldest first (claim_sync_jobs), leased for `leaseSeconds`. */
  claimJobs(limit: number, leaseSeconds: number): Promise<ClaimedJob[]>;
  /**
   * Claims due `webhook` jobs, oldest first (claim_webhook_jobs): a claim of their own, so neither a
   * burst of deliveries nor a backlog of syncs can take the other's share of a tick.
   */
  claimWebhookJobs(limit: number, leaseSeconds: number): Promise<ClaimedJob[]>;
  /** Returns a claimed job that was never started to the queue without spending an attempt. */
  releaseJob(jobId: string): Promise<void>;
  completeJob(jobId: string, finishedAt: Date): Promise<void>;
  retryJob(jobId: string, runAfter: Date, failure: JobFailure): Promise<void>;
  failJob(jobId: string, finishedAt: Date, failure: JobFailure): Promise<void>;

  getConnection(key: ConnectionKey): Promise<SyncConnection | null>;
  listIncludedAccounts(key: ConnectionKey): Promise<SyncAccount[]>;
  updateConnection(key: ConnectionKey, patch: ConnectionPatch): Promise<void>;
  /**
   * Applies the patch only while the connection's status is one of `statuses`, in the same
   * statement, so a status another job wrote since the caller read the row is kept (#487). Returns
   * whether the patch applied; false also when the connection is not in the workspace.
   */
  updateConnectionInStatus(key: ConnectionKey, statuses: readonly SyncConnection["status"][], patch: ConnectionPatch): Promise<boolean>;
  loadCredential(key: ConnectionKey): Promise<OAuthCredential | null>;
  saveCredential(key: ConnectionKey, credential: OAuthCredential): Promise<void>;
  /** The connection's credential refresh lock for `leaseSeconds`: its id, or null while it is held (#496). */
  acquireCredentialRefreshLock(key: ConnectionKey, leaseSeconds: number): Promise<string | null>;
  releaseCredentialRefreshLock(key: ConnectionKey, lockId: string): Promise<void>;

  /** metric_key -> resets_at (ISO, or null) of the latest snapshot of each metric of the account. */
  latestResets(workspaceId: string, externalAccountId: string): Promise<Map<string, string | null>>;
  /** Upserts on (external_account_id, metric_key, snapshot_date). */
  upsertSnapshots(rows: readonly SnapshotRow[]): Promise<void>;
  /**
   * Inserts rows whose (workspace_id, dedupe_key) is new; for one already stored, only sets a null
   * body to the row's non-null body (insert_activity_events, #499). Within one call the first row
   * of a key is the one written. Returns how many were new.
   */
  insertEvents(rows: readonly EventRow[]): Promise<number>;
  setCursor(workspaceId: string, externalAccountId: string, cursor: string | null): Promise<void>;

  purgeSnapshots(beforeDate: string, limit: number): Promise<number>;
  purgeEvents(before: Date, limit: number): Promise<number>;
  purgeJobs(before: Date, limit: number): Promise<number>;
  /** Deletes OAuth states whose expires_at is at or before `before` (abandoned connect flows). */
  purgeOAuthStates(before: Date, limit: number): Promise<number>;
  /** Deletes public rate limit counters whose minute started before `before` (#149). */
  purgeRateLimitCounters(before: Date, limit: number): Promise<number>;
  /** Deletes published metric view counts of UTC days before `beforeDate` (#149). */
  purgeMetricViews(beforeDate: string, limit: number): Promise<number>;
  /** Deletes digest delivery records delivered before `before`; alert records go with their alert. */
  purgeNotificationDeliveries(before: Date, limit: number): Promise<number>;

  /** Queues one daily_summary job per workspace with a connection, keyed by the summarized date. */
  enqueueDailySummaries(date: string): Promise<number>;
  /** Connections that count for the summary (everything but revoked). */
  listSummaryConnections(workspaceId: string): Promise<SummaryConnection[]>;
  /** Snapshots dated `fromDate` to `toDate` (UTC dates, both inclusive), newest first. */
  listSnapshotsBetween(workspaceId: string, fromDate: string, toDate: string): Promise<SummarySnapshot[]>;
  /** Whether anomaly detection is on for the workspace, and its muted metrics (#169). */
  getAnomalySettings(workspaceId: string): Promise<AnomalySettings>;
  /**
   * Spend and usage rows over a period (not point in time), `fromDate` to `toDate` inclusive, oldest
   * day first, then by id: findAnomalies keeps the first of two rows of one day it cannot tell
   * apart. A read stopped at its bound leaves out the oldest days, never the newest (#219).
   */
  listAnomalySnapshots(workspaceId: string, fromDate: string, toDate: string): Promise<AnomalyRow[]>;

  /** Queues an alert_dispatch job for each workspace with an undispatched alert, one open (queued or running) per workspace (#152). */
  enqueueAlertDispatches(): Promise<number>;
  /** Queues one digest job per workspace with a connection, keyed by the summarized date (#152). */
  enqueueDigests(date: string): Promise<number>;

  /**
   * Stores a verified delivery and, unless its outcome is `ignored`, queues its `webhook` job in one
   * atomic step (#28). An `ignored` delivery is stored already processed, with no outcome and no
   * job, so a repeat is still recognized. False when (provider, endpoint, delivery id) is already
   * stored: a repeated delivery, acknowledged and dropped. The endpoint is part of the key because
   * a provider sends one message id to every endpoint of an account.
   */
  recordWebhookDelivery(input: RecordWebhookDeliveryInput): Promise<boolean>;
  /**
   * The delivery a `webhook` job points at, its outcome parsed again at this boundary. Null once
   * processed (an earlier attempt finished it) or purged: nothing is left to do.
   */
  loadWebhookDelivery(deliveryRowId: string): Promise<WebhookDeliveryRecord | null>;
  /**
   * Where a delivery's external account lands: every included external account with that
   * provider and external id on an active, failed, or needs_attention connection (everything but
   * pending and revoked; failed connections are still polled, so push is the path still working),
   * across workspaces for an app-level URL, and only within the endpoint's own connection when
   * `endpointId` is set.
   */
  listWebhookTargets(input: Readonly<{ provider: ProviderId; externalAccountId: string; endpointId: string | null }>): Promise<WebhookTarget[]>;
  /**
   * Where an uninstall naming an installation lands (#480): every connection of the provider whose
   * `external_installation_id` is that installation, by the same status and endpoint rules as
   * `listWebhookTargets`, one entry per connection.
   */
  listInstallationTargets(input: Readonly<{ provider: ProviderId; installationId: string; endpointId: string | null }>): Promise<ConnectionTarget[]>;
  /** Marks a delivery processed and drops its stored outcome, which is no longer needed. */
  finishWebhookDelivery(deliveryRowId: string, finishedAt: Date): Promise<void>;
  /** Deletes delivery records received before `before`: the deduplication window (#28). */
  purgeWebhookDeliveries(before: Date, limit: number): Promise<number>;
}

// Errors carry the operation and the Postgres code only, never row data.
function failure(operation: string, error: { code: string }): Error {
  return new Error(`Job store ${operation} failed (code ${error.code}).`);
}

const MANUAL_SYNC_RESULTS: readonly ManualSyncResult[] = ["queued", "already_queued", "cooldown", "not_found"];

function isManualSyncResult(value: unknown): value is ManualSyncResult {
  return MANUAL_SYNC_RESULTS.some((result) => result === value);
}

// The bound of list_webhook_targets (20261115090200_webhook_delivery_review.sql). One provider account
// connected to more workspaces than this reaches the first by account id; polling still brings
// the rest their events.
export const WEBHOOK_TARGET_LIMIT = 100;

// webhook_deliveries.outcome holds a WebhookOutcome as JSON: an event's occurredAt and an
// uninstall's occurredAt travel as ISO text and are Dates again once the job reads them back. An
// account uninstall stored without `by` (the only shape before #480) still reads back.
const StoredWebhookOutcomeSchema = z.union([
  z.strictObject({
    kind: z.literal("events"),
    externalAccountId: z.string().min(1),
    events: z.array(ActivityEventSchema.extend({ occurredAt: z.iso.datetime().transform((value) => new Date(value)) })),
  }),
  z.strictObject({
    kind: z.literal("uninstalled"),
    by: z.literal("account").exactOptional(),
    externalAccountId: z.string().min(1),
    occurredAt: z.iso.datetime().transform((value) => new Date(value)),
  }),
  z.strictObject({
    kind: z.literal("uninstalled"),
    by: z.literal("installation"),
    installationId: z.string().min(1),
    occurredAt: z.iso.datetime().transform((value) => new Date(value)),
  }),
  z.strictObject({ kind: z.literal("ignored"), reason: z.string() }),
]);

/**
 * A delivery's outcome as record_webhook_delivery stores it. A `source` (#428) is left out: the
 * route records it for the setup panel, and the job has no use for it.
 */
export function webhookOutcomeToJson(outcome: WebhookOutcome): Json {
  if (outcome.kind === "uninstalled") return { ...outcome, occurredAt: outcome.occurredAt.toISOString() };
  if (outcome.kind === "ignored") return { kind: outcome.kind, reason: outcome.reason };
  return {
    kind: outcome.kind,
    externalAccountId: outcome.externalAccountId,
    events: outcome.events.map((event) => ({ ...event, occurredAt: event.occurredAt.toISOString() })),
  };
}

/** A stored outcome read back, or null when it is not the shape webhookOutcomeToJson writes. */
export function webhookOutcomeFromJson(value: unknown): WebhookOutcome | null {
  const parsed = StoredWebhookOutcomeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createSupabaseJobStore(): JobStore {
  const db = createAdminClient();

  return {
    async enqueueDueSyncs(limit) {
      const { data, error } = await db.rpc("enqueue_due_syncs", { p_limit: limit });
      if (error) throw failure("enqueue_due_syncs", error);
      return data;
    },

    async markSimulatedSyncsDue(at) {
      const due = at.toISOString();
      // Every active simulated connection, including ones already due or never scheduled. Moving
      // those to `at` keeps them due as long as the watcher's clock is not ahead of the database's
      // now() (both are this machine locally); the count then answers "is anything active to
      // stream", which the watch loop reports when the answer is no.
      const { data, error } = await db
        .from("connections")
        .update({ next_sync_at: due })
        .contains("granted_scopes", [SIMULATED_SCOPE])
        .eq("status", "active")
        .select("id");
      if (error) throw failure("mark simulated syncs due", error);
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
        .select(CLAIMED_JOB_COLUMNS);
      if (error) throw failure("claim_sync_jobs", error);
      return data;
    },

    async claimWebhookJobs(limit, leaseSeconds) {
      const { data, error } = await db
        .rpc("claim_webhook_jobs", { p_limit: limit, p_lease_seconds: leaseSeconds })
        .select(CLAIMED_JOB_COLUMNS);
      if (error) throw failure("claim_webhook_jobs", error);
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
          "id, workspace_id, provider, status, display_name, authorized_account_label, poll_interval_seconds, consecutive_failures, missing_scopes, external_installation_id",
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

    async updateConnectionInStatus({ workspaceId, connectionId }, statuses, patch) {
      const { data, error } = await db
        .from("connections")
        .update(patch)
        .eq("id", connectionId)
        .eq("workspace_id", workspaceId)
        .in("status", [...statuses])
        .select("id");
      if (error) throw failure("connection update", error);
      return data.length > 0;
    },

    loadCredential(key) {
      return loadCredential(key);
    },

    saveCredential(key, credential) {
      return saveCredential({ ...key, credential });
    },

    acquireCredentialRefreshLock(key, leaseSeconds) {
      return acquireCredentialRefreshLock(key, leaseSeconds);
    },

    releaseCredentialRefreshLock(key, lockId) {
      return releaseCredentialRefreshLock(key, lockId);
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
      const { data, error } = await db.rpc("insert_activity_events", { p_rows: [...rows] });
      if (error) throw failure("insert_activity_events", error);
      return data;
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

    async purgeRateLimitCounters(before, limit) {
      const { data, error } = await db.rpc("purge_public_rate_limit_counters", { p_before: before.toISOString(), p_limit: limit });
      if (error) throw failure("purge_public_rate_limit_counters", error);
      return data;
    },

    async purgeMetricViews(beforeDate, limit) {
      const { data, error } = await db.rpc("purge_published_metric_views", { p_before: beforeDate, p_limit: limit });
      if (error) throw failure("purge_published_metric_views", error);
      return data;
    },

    async purgeNotificationDeliveries(before, limit) {
      const { data, error } = await db.rpc("purge_notification_deliveries", { p_before: before.toISOString(), p_limit: limit });
      if (error) throw failure("purge_notification_deliveries", error);
      return data;
    },

    async enqueueAlertDispatches() {
      const { data, error } = await db.rpc("enqueue_alert_dispatches");
      if (error) throw failure("enqueue_alert_dispatches", error);
      return data;
    },

    async enqueueDigests(date) {
      const { data, error } = await db.rpc("enqueue_digests", { p_date: date });
      if (error) throw failure("enqueue_digests", error);
      return data;
    },

    async enqueueDailySummaries(date) {
      const { data, error } = await db.rpc("enqueue_daily_summaries", { p_date: date });
      if (error) throw failure("enqueue_daily_summaries", error);
      return data;
    },

    async listSummaryConnections(workspaceId) {
      const { rows, complete } = await readAllPages(async (from, to) => {
        const { data, error } = await db
          .from("connections")
          .select("id, provider")
          .eq("workspace_id", workspaceId)
          .neq("status", "revoked")
          .order("id")
          .range(from, to);
        if (error) throw failure("summary connections read", error);
        return data;
      }, SUMMARY_ROW_LIMIT);
      if (!complete) log.warn("daily_summary.connections_truncated", { workspaceId, rows: rows.length });
      return rows;
    },

    async listSnapshotsBetween(workspaceId, fromDate, toDate) {
      const { rows, complete } = await readAllPages(async (from, to) => {
        const { data, error } = await db
          .from("usage_snapshots")
          .select(
            "connection_id, external_account_id, metric_key, kind, label, snapshot_date, value, unit, amount_minor, currency, period_start, period_end, point_at, resets_at, retrieved_at, provenance_source, pricing_source",
          )
          .eq("workspace_id", workspaceId)
          .gte("snapshot_date", fromDate)
          .lte("snapshot_date", toDate)
          // The (workspace_id, snapshot_date desc) index. Newest first, so if the bound is reached
          // the oldest days are the ones cut, and the projections lose history before the day's
          // values. `id` last makes the order total, so pages neither skip nor repeat a row.
          .order("snapshot_date", { ascending: false })
          .order("id")
          .range(from, to);
        if (error) throw failure("summary snapshots read", error);
        return data;
      }, SUMMARY_ROW_LIMIT);
      if (!complete) log.warn("daily_summary.snapshots_truncated", { workspaceId, rows: rows.length });
      return rows;
    },

    async getAnomalySettings(workspaceId) {
      const [workspace, mutes] = await Promise.all([
        db.from("workspaces").select("anomaly_detection_enabled").eq("id", workspaceId).maybeSingle(),
        db
          .from("anomaly_mutes")
          .select("provider, metric_key")
          .eq("workspace_id", workspaceId)
          .order("created_at")
          .limit(ANOMALY_MUTE_LIMIT),
      ]);
      if (workspace.error) throw failure("anomaly settings read", workspace.error);
      if (mutes.error) throw failure("anomaly mutes read", mutes.error);
      // A workspace deleted since the job was queued has nothing left to check.
      return { enabled: workspace.data?.anomaly_detection_enabled ?? false, mutes: mutes.data };
    },

    async listAnomalySnapshots(workspaceId, fromDate, toDate) {
      // Pages newest first over usage_snapshots_workspace_date_idx (workspace_id, snapshot_date
      // desc), bounded by ANOMALY_ROW_LIMIT: a cut read loses the oldest history, never the
      // checked day (#219).
      const { rows, complete } = await readAllPages(async (from, to) => {
        const { data, error } = await db
          .from("usage_snapshots")
          .select(
            "connection_id, external_account_id, metric_key, kind, label, snapshot_date, value, unit, amount_minor, currency, period_start, period_end, point_at, resets_at, retrieved_at, provenance_source, pricing_source",
          )
          .eq("workspace_id", workspaceId)
          .in("kind", [...ANOMALY_KINDS])
          .is("point_at", null)
          .gte("snapshot_date", fromDate)
          .lte("snapshot_date", toDate)
          .order("snapshot_date", { ascending: false })
          .order("id")
          .range(from, to);
        if (error) throw failure("anomaly snapshots read", error);
        return data;
      }, ANOMALY_ROW_LIMIT);
      if (!complete) log.warn("anomaly.snapshots_truncated", { workspaceId, rows: rows.length });
      // Back to oldest first, then by id, the order a complete read gave the rules: findAnomalies
      // keeps the first of two rows of one day it cannot tell apart. The sort is stable, so the
      // id order within each day stays.
      return rows.sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date));
    },

    async recordWebhookDelivery({ provider, deliveryId, endpointId, outcome }) {
      const { data, error } = await db.rpc("record_webhook_delivery", {
        p_provider: provider,
        p_delivery_id: deliveryId,
        p_outcome: webhookOutcomeToJson(outcome),
        ...(endpointId === null ? {} : { p_endpoint_id: endpointId }),
      });
      if (error) throw failure("record_webhook_delivery", error);
      return data;
    },

    async loadWebhookDelivery(deliveryRowId) {
      const { data, error } = await db
        .from("webhook_deliveries")
        .select("id, provider, endpoint_id, outcome")
        .eq("id", deliveryRowId)
        .eq("status", "received")
        .maybeSingle();
      if (error) throw failure("webhook delivery read", error);
      if (data === null) return null;
      const provider = ProviderIdSchema.safeParse(data.provider);
      const outcome = webhookOutcomeFromJson(data.outcome);
      // Only that the shape is wrong: zod issues would echo the stored values. A received delivery
      // is never ignored: record_webhook_delivery stores those processed.
      if (!provider.success || outcome === null || outcome.kind === "ignored") {
        throw new Error("Job store webhook delivery has an unexpected shape.");
      }
      return { id: data.id, provider: provider.data, endpointId: data.endpoint_id, outcome };
    },

    async listWebhookTargets({ provider, externalAccountId, endpointId }) {
      const { data, error } = await db.rpc("list_webhook_targets", {
        p_provider: provider,
        p_external_id: externalAccountId,
        ...(endpointId === null ? {} : { p_endpoint_id: endpointId }),
      });
      if (error) throw failure("list_webhook_targets", error);
      if (data.length >= WEBHOOK_TARGET_LIMIT) log.warn("webhook.targets_truncated", { provider, targets: data.length });
      return data.map((row) => ({
        workspaceId: row.workspace_id,
        connectionId: row.connection_id,
        accountId: row.account_id,
        grantedAt: row.granted_at,
      }));
    },

    async listInstallationTargets({ provider, installationId, endpointId }) {
      const { data, error } = await db.rpc("list_webhook_targets", {
        p_provider: provider,
        p_installation_id: installationId,
        ...(endpointId === null ? {} : { p_endpoint_id: endpointId }),
      });
      if (error) throw failure("list_webhook_targets", error);
      if (data.length >= WEBHOOK_TARGET_LIMIT) log.warn("webhook.targets_truncated", { provider, targets: data.length });
      // One row per connection, with no account: an uninstall acts on connections.
      return data.map((row) => ({ workspaceId: row.workspace_id, connectionId: row.connection_id, grantedAt: row.granted_at }));
    },

    async finishWebhookDelivery(deliveryRowId, finishedAt) {
      const { error } = await db
        .from("webhook_deliveries")
        .update({ status: "processed", processed_at: finishedAt.toISOString(), outcome: null })
        .eq("id", deliveryRowId);
      if (error) throw failure("webhook delivery finish", error);
    },

    async purgeWebhookDeliveries(before, limit) {
      const { data, error } = await db.rpc("purge_webhook_deliveries", { p_before: before.toISOString(), p_limit: limit });
      if (error) throw failure("purge_webhook_deliveries", error);
      return data;
    },
  };
}
