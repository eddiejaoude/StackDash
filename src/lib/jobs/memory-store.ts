import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import type { OAuthCredential } from "@/lib/adapters/types";
import type { AnomalyMute, AnomalyRow } from "@/lib/alerts/anomaly";
import { digestJobKey } from "@/lib/notifications/model";
import type { Tables } from "@/lib/supabase/database.types";

import { dailySummaryJobKey } from "./daily-summary";
import {
  PARKED_SYNC_AFTER_MS,
  WEBHOOK_TARGET_LIMIT,
  type AnomalySettings,
  type ClaimedJob,
  type ConnectionPatch,
  type ConnectionKey,
  type ConnectionTarget,
  type EventRow,
  type JobFailure,
  type JobStore,
  type ManualSyncResult,
  type RecordWebhookDeliveryInput,
  type SnapshotRow,
  type StoredWebhookOutcome,
  type SummaryConnection,
  type SummarySnapshot,
  type WebhookDeliveryRecord,
  type WebhookTarget,
} from "./store";

/*
 * In-memory JobStore for unit tests only. It mirrors the database rules the engine relies on:
 * one open sync per connection, claim semantics of claim_sync_jobs and claim_webhook_jobs, the
 * snapshot and event unique keys, workspace scoping, the retention predicates, and the webhook
 * delivery rules of record_webhook_delivery and list_webhook_targets. Never imported by app code.
 */

export type MemoryConnection = Tables<"connections">;
export type MemoryAccount = Tables<"external_accounts">;
export type MemoryJob = Tables<"sync_jobs">;
export type MemorySnapshot = SnapshotRow & { id: string };
export type MemoryEvent = EventRow & { id: string };
export type MemoryOAuthState = Pick<Tables<"oauth_states">, "state" | "workspace_id" | "expires_at">;
export type MemoryRateLimitCounter = Tables<"public_rate_limit_counters">;
export type MemoryMetricView = Tables<"published_metric_views">;
export type MemoryWebhookEndpoint = Pick<Tables<"webhook_endpoints">, "id" | "workspace_id" | "connection_id" | "provider">;
// The outcome is kept as the object the route stored; the Supabase store's JSON round trip is
// covered by store.test.ts. `simulated` is the provenance Postgres keeps inside the outcome's JSON
// (#495); a test sets it to null for a delivery a build before #495 stored.
export type MemoryWebhookDelivery = Omit<Tables<"webhook_deliveries">, "outcome"> & {
  outcome: StoredWebhookOutcome | null;
  simulated: boolean | null;
};

function isOpenSync(job: MemoryJob, connectionId: string): boolean {
  return job.kind === "sync" && job.connection_id === connectionId && (job.status === "queued" || job.status === "running");
}

export class MemoryJobStore implements JobStore {
  connections: MemoryConnection[] = [];
  accounts: MemoryAccount[] = [];
  jobs: MemoryJob[] = [];
  snapshots: MemorySnapshot[] = [];
  events: MemoryEvent[] = [];
  oauthStates: MemoryOAuthState[] = [];
  rateLimitCounters: MemoryRateLimitCounter[] = [];
  metricViews: MemoryMetricView[] = [];
  credentials = new Map<string, OAuthCredential>();
  savedCredentials: OAuthCredential[] = [];
  /** connection id -> credential_refresh_locks row, as acquire_credential_refresh_lock keeps it (#496). */
  refreshLocks = new Map<string, { lockId: string; lockedUntil: Date }>();
  /** Workspaces with anomaly detection turned off; every other workspace has it on (#169). */
  anomalyDisabled = new Set<string>();
  anomalyMutes: Array<AnomalyMute & { workspace_id: string }> = [];
  /** Workspaces with a triggered alert not dispatched yet, as triggered_alerts would answer. */
  undispatchedAlertWorkspaces: string[] = [];
  notificationDeliveries: Array<{ id: string; triggered_alert_id: string | null; delivered_at: string }> = [];
  webhookEndpoints: MemoryWebhookEndpoint[] = [];
  webhookDeliveries: MemoryWebhookDelivery[] = [];

  constructor(private readonly now: () => Date) {}

  #nowIso(): string {
    return this.now().toISOString();
  }

  addConnection(fields: Pick<MemoryConnection, "workspace_id" | "provider"> & Partial<MemoryConnection>): MemoryConnection {
    const row: MemoryConnection = {
      id: crypto.randomUUID(),
      status: "active",
      display_name: "Example connection",
      authorized_account_label: null,
      external_installation_id: null,
      mode: null,
      granted_at: null,
      granted_scopes: [],
      missing_scopes: [],
      poll_interval_seconds: 3600,
      next_sync_at: null,
      last_synced_at: null,
      last_sync_requested_at: null,
      consecutive_failures: 0,
      last_error_code: null,
      last_error_reference: null,
      created_by: null,
      updated_by: null,
      created_at: this.#nowIso(),
      updated_at: this.#nowIso(),
      ...fields,
    };
    this.connections.push(row);
    return row;
  }

  addAccount(
    fields: Pick<MemoryAccount, "workspace_id" | "connection_id" | "external_id"> & Partial<MemoryAccount>,
  ): MemoryAccount {
    const row: MemoryAccount = {
      id: crypto.randomUUID(),
      display_name: fields.external_id,
      kind: "team",
      project_id: null,
      included: true,
      sync_cursor: null,
      created_at: this.#nowIso(),
      updated_at: this.#nowIso(),
      ...fields,
    };
    this.accounts.push(row);
    return row;
  }

  #connection({ workspaceId, connectionId }: ConnectionKey): MemoryConnection | undefined {
    return this.connections.find((row) => row.id === connectionId && row.workspace_id === workspaceId);
  }

  #job(jobId: string): MemoryJob {
    const job = this.jobs.find((row) => row.id === jobId);
    if (job === undefined) throw new Error(`No job ${jobId}`);
    return job;
  }

  #insertSync(workspaceId: string, connectionId: string): boolean {
    if (this.jobs.some((job) => isOpenSync(job, connectionId))) return false;
    this.jobs.push(this.newJob({ workspace_id: workspaceId, connection_id: connectionId, kind: "sync" }));
    return true;
  }

  newJob(fields: Pick<MemoryJob, "workspace_id" | "connection_id" | "kind"> & Partial<MemoryJob>): MemoryJob {
    return {
      id: crypto.randomUUID(),
      status: "queued",
      run_after: this.#nowIso(),
      attempts: 0,
      max_attempts: 5,
      locked_until: null,
      started_at: null,
      finished_at: null,
      error_code: null,
      error_reference: null,
      dedupe_key: null,
      webhook_delivery_id: null,
      created_at: this.#nowIso(),
      ...fields,
    };
  }

  async enqueueDueSyncs(limit: number): Promise<number> {
    const now = this.now().getTime();
    const due = this.connections
      .filter(
        (row) =>
          (row.status === "active" || row.status === "failed") &&
          (row.next_sync_at === null || new Date(row.next_sync_at).getTime() <= now) &&
          !this.jobs.some((job) => isOpenSync(job, row.id)),
      )
      .slice(0, limit);
    let queued = 0;
    for (const row of due) if (this.#insertSync(row.workspace_id, row.id)) queued += 1;
    return queued;
  }

  async markSimulatedSyncsDue(at: Date): Promise<number> {
    const parkedAfter = at.getTime() + PARKED_SYNC_AFTER_MS;
    let due = 0;
    for (const row of this.connections) {
      if (row.status !== "active" || !isSimulatedConnection(row)) continue;
      if (row.next_sync_at !== null && new Date(row.next_sync_at).getTime() > parkedAfter) continue;
      row.next_sync_at = at.toISOString();
      due += 1;
    }
    return due;
  }

  async enqueueSync(key: ConnectionKey): Promise<boolean> {
    if (this.#connection(key) === undefined) return false;
    return this.#insertSync(key.workspaceId, key.connectionId);
  }

  async requestManualSync(key: ConnectionKey & Readonly<{ cooldownSeconds: number }>): Promise<ManualSyncResult> {
    const connection = this.#connection(key);
    if (connection === undefined) return "not_found";
    const now = this.now().getTime();
    if (
      connection.last_sync_requested_at !== null &&
      new Date(connection.last_sync_requested_at).getTime() > now - key.cooldownSeconds * 1000
    ) {
      return "cooldown";
    }
    connection.last_sync_requested_at = this.#nowIso();
    return this.#insertSync(key.workspaceId, key.connectionId) ? "queued" : "already_queued";
  }

  async enqueueRetention(dedupeKey: string): Promise<boolean> {
    if (this.jobs.some((job) => job.dedupe_key === dedupeKey)) return false;
    this.jobs.push(this.newJob({ workspace_id: null, connection_id: null, kind: "retention", dedupe_key: dedupeKey }));
    return true;
  }

  async claimJobs(limit: number, leaseSeconds: number): Promise<ClaimedJob[]> {
    return this.#claim((job) => job.kind !== "webhook", limit, leaseSeconds);
  }

  async claimWebhookJobs(limit: number, leaseSeconds: number): Promise<ClaimedJob[]> {
    return this.#claim((job) => job.kind === "webhook", limit, leaseSeconds);
  }

  /** claim_sync_jobs and claim_webhook_jobs: the same claim over the jobs `inQueue` selects. */
  #claim(inQueue: (job: MemoryJob) => boolean, limit: number, leaseSeconds: number): ClaimedJob[] {
    const now = this.now().getTime();
    const expired = (job: MemoryJob) =>
      job.status === "running" && job.locked_until !== null && new Date(job.locked_until).getTime() < now;
    const queue = this.jobs.filter(inQueue);
    for (const job of queue) {
      if (expired(job) && job.attempts >= job.max_attempts) {
        job.status = "failed";
        job.locked_until = null;
        job.finished_at = this.#nowIso();
        job.error_code ??= "lease_expired";
      }
    }
    const claimable = queue
      .filter(
        (job) =>
          job.attempts < job.max_attempts &&
          ((job.status === "queued" && new Date(job.run_after).getTime() <= now) || expired(job)),
      )
      .sort((a, b) => a.run_after.localeCompare(b.run_after) || a.id.localeCompare(b.id))
      .slice(0, limit);
    for (const job of claimable) {
      job.status = "running";
      job.locked_until = new Date(now + leaseSeconds * 1000).toISOString();
      job.attempts += 1;
      job.started_at = this.#nowIso();
      job.finished_at = null;
    }
    return claimable.map(({ id, workspace_id, connection_id, kind, attempts, max_attempts, created_at, dedupe_key, webhook_delivery_id }) => ({
      id,
      workspace_id,
      connection_id,
      kind,
      attempts,
      max_attempts,
      created_at,
      dedupe_key,
      webhook_delivery_id,
    }));
  }

  async releaseJob(jobId: string): Promise<void> {
    const job = this.#job(jobId);
    if (job.status !== "running") return;
    job.status = "queued";
    job.locked_until = null;
    job.started_at = null;
    job.attempts = Math.max(0, job.attempts - 1);
  }

  async completeJob(jobId: string, finishedAt: Date): Promise<void> {
    Object.assign(this.#job(jobId), {
      status: "succeeded",
      locked_until: null,
      finished_at: finishedAt.toISOString(),
      error_code: null,
      error_reference: null,
    });
  }

  async retryJob(jobId: string, runAfter: Date, failure: JobFailure): Promise<void> {
    Object.assign(this.#job(jobId), {
      status: "queued",
      locked_until: null,
      run_after: runAfter.toISOString(),
      error_code: failure.errorCode,
      error_reference: failure.errorReference,
    });
  }

  async failJob(jobId: string, finishedAt: Date, failure: JobFailure): Promise<void> {
    Object.assign(this.#job(jobId), {
      status: "failed",
      locked_until: null,
      finished_at: finishedAt.toISOString(),
      error_code: failure.errorCode,
      error_reference: failure.errorReference,
    });
  }

  async getConnection(key: ConnectionKey) {
    const row = this.#connection(key);
    if (row === undefined) return null;
    const {
      id,
      workspace_id,
      provider,
      status,
      display_name,
      authorized_account_label,
      poll_interval_seconds,
      consecutive_failures,
      missing_scopes,
      external_installation_id,
      mode,
    } = row;
    return {
      id,
      workspace_id,
      provider,
      status,
      display_name,
      authorized_account_label,
      poll_interval_seconds,
      consecutive_failures,
      missing_scopes,
      external_installation_id,
      mode,
    };
  }

  async listIncludedAccounts({ workspaceId, connectionId }: ConnectionKey) {
    return this.accounts
      .filter((row) => row.workspace_id === workspaceId && row.connection_id === connectionId && row.included)
      .map(({ id, external_id, display_name, sync_cursor }) => ({ id, external_id, display_name, sync_cursor }));
  }

  async updateConnection(key: ConnectionKey, patch: ConnectionPatch): Promise<void> {
    const row = this.#connection(key);
    if (row === undefined) return;
    Object.assign(row, patch, { updated_at: this.#nowIso() });
  }

  async updateConnectionInStatus(
    key: ConnectionKey,
    statuses: readonly MemoryConnection["status"][],
    patch: ConnectionPatch,
  ): Promise<boolean> {
    const row = this.#connection(key);
    if (row === undefined || !statuses.includes(row.status)) return false;
    Object.assign(row, patch, { updated_at: this.#nowIso() });
    return true;
  }

  async loadCredential({ connectionId }: ConnectionKey): Promise<OAuthCredential | null> {
    return this.credentials.get(connectionId) ?? null;
  }

  async saveCredential({ connectionId }: ConnectionKey, credential: OAuthCredential): Promise<void> {
    this.credentials.set(connectionId, credential);
    this.savedCredentials.push(credential);
  }

  async acquireCredentialRefreshLock({ connectionId }: ConnectionKey, leaseSeconds: number): Promise<string | null> {
    const now = this.now();
    const held = this.refreshLocks.get(connectionId);
    if (held !== undefined && held.lockedUntil >= now) return null;
    const lockId = crypto.randomUUID();
    this.refreshLocks.set(connectionId, { lockId, lockedUntil: new Date(now.getTime() + leaseSeconds * 1000) });
    return lockId;
  }

  async releaseCredentialRefreshLock({ connectionId }: ConnectionKey, lockId: string): Promise<void> {
    if (this.refreshLocks.get(connectionId)?.lockId === lockId) this.refreshLocks.delete(connectionId);
  }

  async latestResets(workspaceId: string, externalAccountId: string): Promise<Map<string, string | null>> {
    const latest = new Map<string, MemorySnapshot>();
    for (const row of this.snapshots) {
      if (row.workspace_id !== workspaceId || row.external_account_id !== externalAccountId) continue;
      const current = latest.get(row.metric_key);
      if (current === undefined || row.snapshot_date > current.snapshot_date) latest.set(row.metric_key, row);
    }
    return new Map([...latest].map(([key, row]) => [key, row.resets_at ?? null]));
  }

  async upsertSnapshots(rows: readonly SnapshotRow[]): Promise<void> {
    const keys = new Set<string>();
    for (const row of rows) {
      const key = `${row.external_account_id}|${row.metric_key}|${row.snapshot_date}`;
      // Postgres rejects an upsert that touches one row twice; so does this store.
      if (keys.has(key)) throw new Error("ON CONFLICT DO UPDATE command cannot affect row a second time");
      keys.add(key);
      const existing = this.snapshots.find(
        (snapshot) =>
          snapshot.external_account_id === row.external_account_id &&
          snapshot.metric_key === row.metric_key &&
          snapshot.snapshot_date === row.snapshot_date,
      );
      if (existing === undefined) this.snapshots.push({ ...row, id: crypto.randomUUID() });
      else Object.assign(existing, row, { id: existing.id });
    }
  }

  async insertEvents(rows: readonly EventRow[]): Promise<number> {
    let inserted = 0;
    const written = new Set<string>();
    for (const row of rows) {
      // insert_activity_events writes the first row of a key in one call and skips the rest.
      const key = `${row.workspace_id}|${row.dedupe_key}`;
      if (written.has(key)) continue;
      written.add(key);
      const stored = this.events.find((event) => event.workspace_id === row.workspace_id && event.dedupe_key === row.dedupe_key);
      const body = row.body ?? null;
      if (stored === undefined) {
        this.events.push({ ...row, id: crypto.randomUUID() });
        inserted += 1;
      } else if ((stored.body ?? null) === null && body !== null) {
        // A stored event only gains a missing body; nothing else of it changes (#499).
        stored.body = body;
      }
    }
    return inserted;
  }

  async setCursor(workspaceId: string, externalAccountId: string, cursor: string | null): Promise<void> {
    const row = this.accounts.find((account) => account.id === externalAccountId && account.workspace_id === workspaceId);
    if (row !== undefined) row.sync_cursor = cursor;
  }

  #purge<T extends { id: string }>(rows: T[], doomed: (row: T) => boolean, limit: number): { kept: T[]; deleted: number } {
    const ids = new Set(
      rows
        .filter(doomed)
        .map((row) => row.id)
        .sort()
        .slice(0, limit),
    );
    return { kept: rows.filter((row) => !ids.has(row.id)), deleted: ids.size };
  }

  async purgeSnapshots(beforeDate: string, limit: number): Promise<number> {
    const { kept, deleted } = this.#purge(this.snapshots, (row) => row.snapshot_date < beforeDate, limit);
    this.snapshots = kept;
    return deleted;
  }

  async purgeEvents(before: Date, limit: number): Promise<number> {
    const { kept, deleted } = this.#purge(
      this.events,
      (row) => new Date(row.occurred_at).getTime() < before.getTime(),
      limit,
    );
    this.events = kept;
    return deleted;
  }

  async purgeJobs(before: Date, limit: number): Promise<number> {
    const { kept, deleted } = this.#purge(
      this.jobs,
      (row) =>
        new Date(row.created_at).getTime() < before.getTime() && (row.status === "succeeded" || row.status === "failed"),
      limit,
    );
    this.jobs = kept;
    return deleted;
  }

  async purgeOAuthStates(before: Date, limit: number): Promise<number> {
    const doomed = new Set(
      this.oauthStates
        .filter((row) => new Date(row.expires_at).getTime() <= before.getTime())
        .sort((a, b) => a.expires_at.localeCompare(b.expires_at) || a.state.localeCompare(b.state))
        .slice(0, limit)
        .map((row) => row.state),
    );
    this.oauthStates = this.oauthStates.filter((row) => !doomed.has(row.state));
    return doomed.size;
  }

  async purgeRateLimitCounters(before: Date, limit: number): Promise<number> {
    const doomed = new Set(
      this.rateLimitCounters
        .filter((row) => Date.parse(row.window_start) < before.getTime())
        .sort((a, b) => Date.parse(a.window_start) - Date.parse(b.window_start) || a.ip_hash.localeCompare(b.ip_hash))
        .slice(0, limit),
    );
    this.rateLimitCounters = this.rateLimitCounters.filter((row) => !doomed.has(row));
    return doomed.size;
  }

  async purgeMetricViews(beforeDate: string, limit: number): Promise<number> {
    const doomed = new Set(
      this.metricViews
        .filter((row) => row.view_date < beforeDate)
        .sort((a, b) => a.view_date.localeCompare(b.view_date) || a.project_id.localeCompare(b.project_id))
        .slice(0, limit),
    );
    this.metricViews = this.metricViews.filter((row) => !doomed.has(row));
    return doomed.size;
  }

  async purgeNotificationDeliveries(before: Date, limit: number): Promise<number> {
    const { kept, deleted } = this.#purge(
      this.notificationDeliveries,
      (row) => row.triggered_alert_id === null && new Date(row.delivered_at).getTime() < before.getTime(),
      limit,
    );
    this.notificationDeliveries = kept;
    return deleted;
  }

  async enqueueAlertDispatches(): Promise<number> {
    let queued = 0;
    for (const workspaceId of new Set(this.undispatchedAlertWorkspaces)) {
      const open = this.jobs.some(
        (job) => job.kind === "alert_dispatch" && job.workspace_id === workspaceId && (job.status === "queued" || job.status === "running"),
      );
      if (open) continue;
      this.jobs.push(this.newJob({ workspace_id: workspaceId, connection_id: null, kind: "alert_dispatch" }));
      queued += 1;
    }
    return queued;
  }

  async enqueueDigests(date: string): Promise<number> {
    const workspaceIds = new Set(this.connections.filter((row) => row.status !== "revoked").map((row) => row.workspace_id));
    let queued = 0;
    for (const workspaceId of workspaceIds) {
      const dedupeKey = digestJobKey(workspaceId, date);
      if (this.jobs.some((job) => job.dedupe_key === dedupeKey)) continue;
      this.jobs.push(this.newJob({ workspace_id: workspaceId, connection_id: null, kind: "digest", dedupe_key: dedupeKey }));
      queued += 1;
    }
    return queued;
  }

  async enqueueDailySummaries(date: string): Promise<number> {
    const workspaceIds = new Set(this.connections.filter((row) => row.status !== "revoked").map((row) => row.workspace_id));
    let queued = 0;
    for (const workspaceId of workspaceIds) {
      const dedupeKey = dailySummaryJobKey(workspaceId, date);
      if (this.jobs.some((job) => job.dedupe_key === dedupeKey)) continue;
      this.jobs.push(this.newJob({ workspace_id: workspaceId, connection_id: null, kind: "daily_summary", dedupe_key: dedupeKey }));
      queued += 1;
    }
    return queued;
  }

  async listSummaryConnections(workspaceId: string): Promise<SummaryConnection[]> {
    return this.connections
      .filter((row) => row.workspace_id === workspaceId && row.status !== "revoked")
      .map(({ id, provider }) => ({ id, provider }));
  }

  async listSnapshotsBetween(workspaceId: string, fromDate: string, toDate: string): Promise<SummarySnapshot[]> {
    return this.snapshots
      .filter((row) => row.workspace_id === workspaceId && row.snapshot_date >= fromDate && row.snapshot_date <= toDate)
      .sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date))
      .map((row) => this.#toSnapshotInput(row));
  }

  async getAnomalySettings(workspaceId: string): Promise<AnomalySettings> {
    return {
      enabled: !this.anomalyDisabled.has(workspaceId),
      mutes: this.anomalyMutes
        .filter((mute) => mute.workspace_id === workspaceId)
        .map(({ provider, metric_key }) => ({ provider, metric_key })),
    };
  }

  async listAnomalySnapshots(workspaceId: string, fromDate: string, toDate: string): Promise<AnomalyRow[]> {
    return this.snapshots
      .filter(
        (row) =>
          row.workspace_id === workspaceId &&
          (row.kind === "verified_spend" || row.kind === "estimated_spend" || row.kind === "usage") &&
          (row.point_at ?? null) === null &&
          row.snapshot_date >= fromDate &&
          row.snapshot_date <= toDate,
      )
      .sort((a, b) => a.snapshot_date.localeCompare(b.snapshot_date) || a.id.localeCompare(b.id))
      .map((row) => this.#toSnapshotInput(row));
  }

  async recordWebhookDelivery({ provider, deliveryId, endpointId, outcome, simulated }: RecordWebhookDeliveryInput): Promise<boolean> {
    // webhook_deliveries_delivery_id_length counts characters, not UTF-16 code units.
    const length = [...deliveryId].length;
    if (length < 1 || length > 200) throw new Error("violates check constraint webhook_deliveries_delivery_id_length");
    if (outcome.kind === "uninstalled" && (outcome.by === "installation" ? outcome.installationId : outcome.externalAccountId) === "") {
      throw new Error("an uninstalled p_outcome must name an account or an installation");
    }
    if (endpointId !== null && !this.webhookEndpoints.some((row) => row.id === endpointId && row.provider === provider)) {
      throw new Error("p_endpoint_id must name an endpoint of p_provider");
    }
    // Keyed per (provider, endpoint, delivery id), nulls not distinct.
    const repeat = this.webhookDeliveries.some(
      (row) => row.provider === provider && row.endpoint_id === endpointId && row.delivery_id === deliveryId,
    );
    if (repeat) return false;
    const id = crypto.randomUUID();
    // An ignored delivery is stored processed, without its outcome, and queues no job.
    const ignored = outcome.kind === "ignored";
    this.webhookDeliveries.push({
      id,
      provider,
      delivery_id: deliveryId,
      endpoint_id: endpointId,
      status: ignored ? "processed" : "received",
      outcome: ignored ? null : outcome,
      simulated,
      received_at: this.#nowIso(),
      processed_at: ignored ? this.#nowIso() : null,
    });
    if (!ignored) this.jobs.push(this.newJob({ workspace_id: null, connection_id: null, kind: "webhook", webhook_delivery_id: id }));
    return true;
  }

  async loadWebhookDelivery(deliveryRowId: string): Promise<WebhookDeliveryRecord | null> {
    const row = this.webhookDeliveries.find((delivery) => delivery.id === deliveryRowId && delivery.status === "received");
    if (row === undefined || row.outcome === null) return null;
    return { id: row.id, provider: row.provider, endpointId: row.endpoint_id, outcome: row.outcome, simulated: row.simulated };
  }

  /** list_webhook_targets' connection rules: the provider, a live status, and the endpoint's own connection when one is given. */
  #isWebhookTarget(
    connection: MemoryConnection | undefined,
    provider: MemoryConnection["provider"],
    endpoint: MemoryWebhookEndpoint | null,
  ): connection is MemoryConnection {
    return (
      connection !== undefined &&
      connection.provider === provider &&
      (connection.status === "active" || connection.status === "failed" || connection.status === "needs_attention") &&
      (endpoint === null || (endpoint.workspace_id === connection.workspace_id && endpoint.connection_id === connection.id))
    );
  }

  async listWebhookTargets({
    provider,
    externalAccountId,
    installationId,
    endpointId,
  }: Parameters<JobStore["listWebhookTargets"]>[0]): Promise<WebhookTarget[]> {
    const endpoint = endpointId === null ? null : this.webhookEndpoints.find((row) => row.id === endpointId);
    if (endpoint === undefined) return [];
    return this.accounts
      .flatMap((account) => {
        if (account.external_id !== externalAccountId || !account.included) return [];
        const connection = this.#connection({ workspaceId: account.workspace_id, connectionId: account.connection_id });
        if (!this.#isWebhookTarget(connection, provider, endpoint)) return [];
        // Named with the account (#497): only that installation's connections; none recorded is no match.
        return installationId === null || connection.external_installation_id === installationId ? [{ account, connection }] : [];
      })
      .sort((a, b) => a.account.id.localeCompare(b.account.id))
      .slice(0, WEBHOOK_TARGET_LIMIT)
      .map(({ account, connection }) => ({
        workspaceId: account.workspace_id,
        connectionId: account.connection_id,
        accountId: account.id,
        grantedAt: connection.granted_at,
        simulated: isSimulatedConnection(connection),
        mode: connection.mode,
      }));
  }

  async listInstallationTargets({
    provider,
    installationId,
    endpointId,
  }: Parameters<JobStore["listInstallationTargets"]>[0]): Promise<ConnectionTarget[]> {
    const endpoint = endpointId === null ? null : this.webhookEndpoints.find((row) => row.id === endpointId);
    if (endpoint === undefined) return [];
    return this.connections
      .filter((connection) => connection.external_installation_id === installationId && this.#isWebhookTarget(connection, provider, endpoint))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, WEBHOOK_TARGET_LIMIT)
      .map((connection) => ({
        workspaceId: connection.workspace_id,
        connectionId: connection.id,
        grantedAt: connection.granted_at,
        simulated: isSimulatedConnection(connection),
        mode: connection.mode,
      }));
  }

  async finishWebhookDelivery(deliveryRowId: string, finishedAt: Date): Promise<void> {
    const row = this.webhookDeliveries.find((delivery) => delivery.id === deliveryRowId);
    if (row === undefined) return;
    row.status = "processed";
    row.processed_at = finishedAt.toISOString();
    row.outcome = null;
  }

  async purgeWebhookDeliveries(before: Date, limit: number): Promise<number> {
    const { kept, deleted } = this.#purge(this.webhookDeliveries, (row) => Date.parse(row.received_at) < before.getTime(), limit);
    const remaining = new Set(kept.map((row) => row.id));
    // sync_jobs.webhook_delivery_id is on delete cascade.
    this.jobs = this.jobs.filter((job) => job.webhook_delivery_id === null || remaining.has(job.webhook_delivery_id));
    this.webhookDeliveries = kept;
    return deleted;
  }

  #toSnapshotInput(row: MemorySnapshot): SummarySnapshot {
    return {
      connection_id: row.connection_id,
      external_account_id: row.external_account_id,
      metric_key: row.metric_key,
      kind: row.kind,
      label: row.label,
      snapshot_date: row.snapshot_date,
      value: row.value ?? null,
      unit: row.unit ?? null,
      amount_minor: row.amount_minor ?? null,
      currency: row.currency ?? null,
      period_start: row.period_start ?? null,
      period_end: row.period_end ?? null,
      point_at: row.point_at ?? null,
      resets_at: row.resets_at ?? null,
      retrieved_at: row.retrieved_at,
      provenance_source: row.provenance_source,
      pricing_source: row.pricing_source ?? null,
    };
  }
}
