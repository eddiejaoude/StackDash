import type { OAuthCredential, ProviderId } from "@/lib/adapters/types";
import type { Tables } from "@/lib/supabase/database.types";

import { dailySummaryJobKey } from "./daily-summary";
import type {
  ClaimedJob,
  ConnectionPatch,
  ConnectionKey,
  EventRow,
  JobFailure,
  JobStore,
  ManualSyncResult,
  SnapshotRow,
  SummaryConnection,
  SummarySnapshot,
} from "./store";

/*
 * In-memory JobStore for unit tests only. It mirrors the database rules the engine relies on:
 * one open sync per connection, claim semantics of claim_sync_jobs, the snapshot and event unique
 * keys, workspace scoping, and the retention predicates. Never imported by app code.
 */

export type MemoryConnection = Tables<"connections">;
export type MemoryAccount = Tables<"external_accounts">;
export type MemoryJob = Tables<"sync_jobs">;
export type MemorySnapshot = SnapshotRow & { id: string };
export type MemoryEvent = EventRow & { id: string };
export type MemoryOAuthState = Pick<Tables<"oauth_states">, "state" | "workspace_id" | "expires_at">;

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
  credentials = new Map<string, OAuthCredential>();
  savedCredentials: OAuthCredential[] = [];

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

  async markSyncsDue(providers: readonly ProviderId[], at: Date): Promise<number> {
    let moved = 0;
    for (const row of this.connections) {
      if (row.status !== "active" || !providers.includes(row.provider)) continue;
      if (row.next_sync_at === null || new Date(row.next_sync_at).getTime() <= at.getTime()) continue;
      row.next_sync_at = at.toISOString();
      moved += 1;
    }
    return moved;
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
    const now = this.now().getTime();
    const expired = (job: MemoryJob) =>
      job.status === "running" && job.locked_until !== null && new Date(job.locked_until).getTime() < now;
    for (const job of this.jobs) {
      if (expired(job) && job.attempts >= job.max_attempts) {
        job.status = "failed";
        job.locked_until = null;
        job.finished_at = this.#nowIso();
        job.error_code ??= "lease_expired";
      }
    }
    const claimable = this.jobs
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
    return claimable.map(({ id, workspace_id, connection_id, kind, attempts, max_attempts, created_at, dedupe_key }) => ({
      id,
      workspace_id,
      connection_id,
      kind,
      attempts,
      max_attempts,
      created_at,
      dedupe_key,
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
    const { id, workspace_id, provider, status, display_name, authorized_account_label, poll_interval_seconds, consecutive_failures, missing_scopes } = row;
    return { id, workspace_id, provider, status, display_name, authorized_account_label, poll_interval_seconds, consecutive_failures, missing_scopes };
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

  async loadCredential({ connectionId }: ConnectionKey): Promise<OAuthCredential | null> {
    return this.credentials.get(connectionId) ?? null;
  }

  async saveCredential({ connectionId }: ConnectionKey, credential: OAuthCredential): Promise<void> {
    this.credentials.set(connectionId, credential);
    this.savedCredentials.push(credential);
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
    for (const row of rows) {
      const exists = this.events.some(
        (event) => event.workspace_id === row.workspace_id && event.dedupe_key === row.dedupe_key,
      );
      if (exists) continue;
      this.events.push({ ...row, id: crypto.randomUUID() });
      inserted += 1;
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

  async listSnapshotsForDate(workspaceId: string, date: string): Promise<SummarySnapshot[]> {
    return this.snapshots
      .filter((row) => row.workspace_id === workspaceId && row.snapshot_date === date)
      .map((row) => ({
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
      }));
  }
}
