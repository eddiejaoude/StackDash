import { setTimeout as sleep } from "node:timers/promises";

import {
  AdapterError,
  AuthRevokedError,
  InvalidResponseError,
  PermissionMissingError,
  RateLimitedError,
} from "@/lib/adapters/errors";
import { validateAdapterEvents } from "@/lib/adapters/events";
import { validateAdapterMetrics } from "@/lib/adapters/metrics";
import { isSimulatedAdapter, SIMULATE_PROVIDERS_ENV } from "@/lib/adapters/simulated";
import { isSimulatedCredential } from "@/lib/adapters/simulated/marker";
import { credentialInstallationId, type OAuthClient, type OAuthContext, type ProviderAdapter, type ProviderId } from "@/lib/adapters/types";
import { refreshIfExpiring } from "@/lib/connections/credential-refresh";
import type { LogFields, Logger } from "@/lib/log/logger";
import type { NotificationDeps } from "@/lib/notifications/dispatch";
import { providerName } from "@/lib/providers";
import type { Database } from "@/lib/supabase/database.types";

import { BACKOFF_CAP_MS, backoffDelayMs, rateLimitDelayMs } from "./backoff";
import { ingestSyncResult } from "./ingest";
import type { ClaimedJob, ConnectionKey, ConnectionPatch, EventRow, JobStore, SyncConnection } from "./store";

/*
 * One sync job for one connection (#44, #60). Strategy pattern: the job holds a ProviderAdapter and
 * never branches on provider id; failures are classified by AdapterError.code only.
 */

type ConnectionStatus = Database["public"]["Enums"]["connection_status"];

export const SYNC_FAILED_TYPE_ID = "stackdash.sync_failed";

export type JobOutcome =
  | { status: "succeeded" }
  | { status: "retry"; runAfter: Date; errorCode: string; errorReference: string | null }
  | { status: "failed"; errorCode: string; errorReference: string | null };

export type SyncDeps = Readonly<{
  store: JobStore;
  getAdapter: (id: ProviderId) => ProviderAdapter;
  loadOAuthClient: (adapter: ProviderAdapter) => OAuthClient | null;
  createOAuthContext: (client: OAuthClient) => OAuthContext;
  now: () => Date;
  // Returns a value in [0, 1); injected so tests can pin the jitter.
  random: () => number;
  logError: (event: string, error: unknown, fields?: LogFields) => string;
  log: Logger;
  // evaluateWorkspaceAlerts from src/lib/alerts/run.ts in production; injected so tests stub it.
  evaluateAlerts: (workspaceId: string, now: Date) => Promise<unknown>;
  // evaluateConnectionAchievements from src/lib/achievements/run.ts in production (#413); injected
  // so tests stub it.
  evaluateAchievements: (workspaceId: string, connectionId: string, now: Date) => Promise<unknown>;
  // addMissingSourceWebhooks from src/lib/connections/webhook-setup.ts in production (#428): gives
  // the sources a connection reads since its last sync (GitLab projects) their webhook, for a
  // connection whose webhooks were set up automatically per source. Injected so tests stub it.
  // Returns before any query for a provider without per-source webhooks.
  addMissingSourceWebhooks: (workspaceId: string, connectionId: string, provider: ProviderId) => Promise<unknown>;
  // Built per alert_dispatch or digest job (createNotificationDeps in production), so a broken
  // email configuration fails that job only.
  notifications: () => NotificationDeps;
}>;

/** A failure that is ours or the instance's, not the provider's. */
class SyncSetupError extends Error {
  constructor(
    readonly code: "provider_not_configured" | "credential_missing" | "simulated_credential",
    message: string,
  ) {
    super(message);
    this.name = "SyncSetupError";
  }
}

// The user has to act (reconnect, grant scopes, or delete a simulated connection): retrying cannot help.
const PERMANENT_CODES: Record<string, true> = {
  auth_revoked: true,
  permission_missing: true,
  credential_missing: true,
  simulated_credential: true,
};

// Healthy means syncing normally. needs_attention and failed are the two failure states; an
// episode starts when a connection leaves `active` for one of them.
export const SYNCABLE_CONNECTION_STATUSES = ["active", "failed"] as const satisfies readonly ConnectionStatus[];
const SYNCABLE_STATUSES: ReadonlySet<ConnectionStatus> = new Set(SYNCABLE_CONNECTION_STATUSES);

function addMs(at: Date, ms: number): Date {
  return new Date(at.getTime() + ms);
}

export async function runSyncJob(job: ClaimedJob, deps: SyncDeps): Promise<JobOutcome> {
  if (job.workspace_id === null || job.connection_id === null) {
    // The table's checks make this unreachable for kind 'sync'; fail loudly rather than guess.
    return { status: "failed", errorCode: "invalid_job", errorReference: null };
  }
  const key: ConnectionKey = { workspaceId: job.workspace_id, connectionId: job.connection_id };
  const connection = await deps.store.getConnection(key);
  // Deleted, disconnected, or waiting for the user: nothing to do, and nothing went wrong.
  if (connection === null || !SYNCABLE_STATUSES.has(connection.status)) {
    deps.log.info("sync.skipped", { jobId: job.id, connectionId: key.connectionId, status: connection?.status ?? "missing" });
    return { status: "succeeded" };
  }

  let applied: boolean;
  try {
    const recovery = await syncConnection(deps.getAdapter(connection.provider), connection, key, deps);
    applied = await writeConnection({ source: "sync", outcome: "succeeded", job, key, patch: recovery, deps });
  } catch (error) {
    return handleFailure({ error, source: "sync", job, connection, key, deps });
  }

  // Thresholds (#65) are checked against the fresh snapshots. A failure here is logged and does
  // not fail the sync: the data is stored, and the next successful sync evaluates again.
  try {
    await deps.evaluateAlerts(key.workspaceId, deps.now());
  } catch (error) {
    deps.logError("sync.alert_evaluation_failed", error, { jobId: job.id, workspaceId: key.workspaceId });
  }
  // Achievements (#413) of the projects this connection's accounts belong to, from the fresh
  // evidence. Likewise never fails the sync: earning is idempotent, so the next sync catches up.
  try {
    await deps.evaluateAchievements(key.workspaceId, key.connectionId, deps.now());
  } catch (error) {
    deps.logError("sync.achievement_evaluation_failed", error, {
      jobId: job.id,
      workspaceId: key.workspaceId,
      connectionId: key.connectionId,
    });
  }
  // An uninstall took the connection out of service while it synced (#487): it waits for a
  // reconnect, so no webhook is created for it.
  if (!applied) return { status: "succeeded" };
  // A source added since the last sync gets its webhook (#428). Likewise never fails the sync: the
  // next sync tries again, and polling brings the source's events meanwhile.
  try {
    await deps.addMissingSourceWebhooks(key.workspaceId, key.connectionId, connection.provider);
  } catch (error) {
    deps.logError("sync.source_webhooks_failed", error, {
      jobId: job.id,
      workspaceId: key.workspaceId,
      connectionId: key.connectionId,
    });
  }
  return { status: "succeeded" };
}

/** Reads and stores every included account; returns the connection's recovery patch for the caller to write. */
async function syncConnection(
  adapter: ProviderAdapter,
  connection: SyncConnection,
  key: ConnectionKey,
  deps: SyncDeps,
): Promise<ConnectionPatch> {
  let credential = await deps.store.loadCredential(key);
  if (credential === null) throw new SyncSetupError("credential_missing", "Connection has no stored credential");
  // A credential the simulator minted (#131) is made up: it is never handed to a real adapter,
  // which would send it to the provider. The credential is loaded and checked before the client,
  // so a refusal never depends on whether the real provider's OAuth app is configured here. It also
  // means a missing credential outranks an unconfigured provider: such a connection reports
  // `credential_missing` and needs attention at once, rather than `provider_not_configured`, which
  // is retried and ends in `failed`.
  if (isSimulatedCredential(credential) && !isSimulatedAdapter(adapter)) {
    throw new SyncSetupError(
      "simulated_credential",
      `${adapter.id} connection holds a simulated credential while ${SIMULATE_PROVIDERS_ENV} is off`,
    );
  }
  // A connection made before #480 has no installation id, and the id is only in the sealed
  // credential, so SQL could not backfill it: the first sync fills it, before any provider call, so
  // even a sync that then fails leaves it set. Never rewritten here: only a grant changes it.
  if (connection.external_installation_id === null) {
    const installationId = credentialInstallationId(adapter, credential);
    if (installationId !== null) await deps.store.updateConnection(key, { external_installation_id: installationId });
  }
  // The mode is in the sealed credential too (#481). The backfill read it from the account label,
  // so the first sync after it, and every later one, checks it against the credential before any
  // provider call: a null fills, and a mode that disagrees is corrected, since the credential is
  // what the grant was. A refresh keeps the mode (Stripe refuses one for the other), so this writes
  // only once per connection.
  const mode = adapter.modeOf?.(credential) ?? null;
  if (mode !== null && connection.mode !== mode) await deps.store.updateConnection(key, { mode });

  const client = deps.loadOAuthClient(adapter);
  if (client === null) {
    throw new SyncSetupError("provider_not_configured", `${adapter.id} OAuth client is not configured on this instance`);
  }
  const ctx = deps.createOAuthContext(client);
  // Under the connection's refresh lock, which automatic webhook setup and removal also take (#496).
  credential = await refreshIfExpiring(adapter, credential, key, ctx, {
    store: deps.store,
    now: deps.now,
    sleep: (ms) => sleep(ms),
    logError: deps.logError,
  });

  const accounts = await deps.store.listIncludedAccounts(key);
  const missingScopes = new Set(adapter.detectMissingPermissions({ scopes: credential.scopes }));

  for (const account of accounts) {
    const result = await adapter.sync(
      account.sync_cursor === null
        ? { credential, externalAccountId: account.external_id }
        : { credential, externalAccountId: account.external_id, cursor: account.sync_cursor },
      ctx,
    );

    const metrics = validateAdapterMetrics(adapter.id, result.metrics);
    const events = validateAdapterEvents(adapter.eventTypes, result.events);
    if (!metrics.ok || !events.ok) {
      throw new InvalidResponseError(`${adapter.id} adapter returned an invalid batch`, {
        cause: { metricIssues: metrics.ok ? [] : metrics.issues, eventIssues: events.ok ? [] : events.issues },
      });
    }
    const foreign =
      metrics.items.some((metric) => metric.externalAccountId !== account.external_id) ||
      events.items.some((event) => event.externalAccountId !== account.external_id);
    if (foreign) {
      throw new InvalidResponseError(`${adapter.id} adapter returned data for another account`);
    }

    for (const partial of result.partialErrors ?? []) {
      for (const scope of partial.missingScopes) missingScopes.add(scope);
      if (partial.missingScopes.length === 0) {
        deps.log.warn("sync.partial_error_without_scope", { connectionId: key.connectionId, provider: adapter.id });
      }
    }

    await ingestSyncResult({
      store: deps.store,
      provider: adapter.id,
      connection,
      account,
      metrics: metrics.items,
      events: events.items,
      cursor: result.cursor,
    });
  }

  // Recovery: a success ends any failure episode, so the next failure starts a new one.
  const now = deps.now();
  return {
    status: "active",
    consecutive_failures: 0,
    last_error_code: null,
    last_error_reference: null,
    last_synced_at: now.toISOString(),
    next_sync_at: addMs(now, connection.poll_interval_seconds * 1000).toISOString(),
    missing_scopes: [...missingScopes],
  };
}

/**
 * Who writes a connection's failure or recovery: its own sync, or an uninstall delivery (#28)
 * through markConnectionRevoked.
 */
type ConnectionWriter = "sync" | "uninstall";

/**
 * A sync's own write applies only while the connection is still one a sync may change (#487): an
 * uninstall that took it out of service while the sync ran is the newer truth, and the later write
 * would otherwise undo it. The uninstall's own write always applies. Returns whether it applied,
 * logging `sync.superseded` when it did not.
 */
async function writeConnection(input: {
  source: ConnectionWriter;
  outcome: JobOutcome["status"];
  job: ClaimedJob;
  key: ConnectionKey;
  patch: ConnectionPatch;
  deps: SyncDeps;
}): Promise<boolean> {
  const { source, job, key, patch, deps } = input;
  if (source === "uninstall") {
    await deps.store.updateConnection(key, patch);
    return true;
  }
  const applied = await deps.store.updateConnectionInStatus(key, SYNCABLE_CONNECTION_STATUSES, patch);
  if (!applied) logSuperseded(job, key, input.outcome, deps);
  return applied;
}

function logSuperseded(job: ClaimedJob, key: ConnectionKey, outcome: JobOutcome["status"], deps: SyncDeps): void {
  deps.log.info("sync.superseded", { jobId: job.id, connectionId: key.connectionId, outcome });
}

function syncFailedEvent(input: {
  connection: SyncConnection;
  job: ClaimedJob;
  status: "needs_attention" | "failed";
  errorCode: string;
  errorReference: string;
  occurredAt: Date;
}): EventRow {
  const { connection } = input;
  const name = providerName(connection.provider);
  const account = connection.authorized_account_label ?? connection.display_name;
  const action =
    input.errorCode === "permission_missing"
      ? `Reconnect ${name} in Connections and grant the requested permissions.`
      : input.errorCode === "simulated_credential"
        ? `This is a simulated connection and provider simulation is off, so its made-up data is not mixed with real data. Delete it in Connections, or turn simulation back on (${SIMULATE_PROVIDERS_ENV}=1) and reconnect it.`
        : `Reconnect ${name} in Connections to resume syncing.`;
  const body =
    input.status === "needs_attention"
      ? `StackDash can no longer read ${name} data for ${account}. ${action} Reference ${input.errorReference}.`
      : `${name} did not answer after several attempts. StackDash keeps retrying every hour. If it keeps failing, reconnect ${name} in Connections. Reference ${input.errorReference}.`;
  // The episode starts with the job whose failure took the connection out of `active`. Its
  // created_at is stable across a re-run of that job, so a crash between writing this event and
  // updating the connection cannot produce a second event for the same episode.
  const episodeStart = new Date(input.job.created_at).toISOString();
  return {
    workspace_id: connection.workspace_id,
    connection_id: connection.id,
    external_account_id: null,
    provider: null,
    type_id: SYNC_FAILED_TYPE_ID,
    severity: input.status === "needs_attention" ? "critical" : "warning",
    title: `${name} sync failed for ${account}`,
    body,
    url: null,
    occurred_at: input.occurredAt.toISOString(),
    dedupe_key: `sync_failed:${connection.id}:${episodeStart}`,
  };
}

async function handleFailure(input: {
  error: unknown;
  source: ConnectionWriter;
  job: ClaimedJob;
  connection: SyncConnection;
  key: ConnectionKey;
  deps: SyncDeps;
}): Promise<JobOutcome> {
  const { error, source, job, connection, key, deps } = input;
  const errorCode = error instanceof AdapterError || error instanceof SyncSetupError ? error.code : "internal_error";
  const errorReference = deps.logError("sync.failed", error, {
    jobId: job.id,
    connectionId: key.connectionId,
    provider: connection.provider,
    errorCode,
    attempt: job.attempts,
  });
  const now = deps.now();
  const consecutiveFailures = connection.consecutive_failures + 1;

  // A connection already in `failed` gets one attempt per scheduled run; retries inside a job are
  // for connections that were healthy until now.
  const lastAttempt = job.attempts >= job.max_attempts || connection.status === "failed";
  const permanent = PERMANENT_CODES[errorCode] === true;

  if (!permanent && !lastAttempt) {
    const delay =
      error instanceof RateLimitedError
        ? rateLimitDelayMs(error.retryAfterMs, job.attempts, deps.random)
        : backoffDelayMs(job.attempts, deps.random);
    const patch: ConnectionPatch = {
      consecutive_failures: consecutiveFailures,
      last_error_code: errorCode,
      last_error_reference: errorReference,
    };
    // Out of service since the sync started (#487): a retry would only skip it, so the job ends,
    // and `sync.superseded` says so with the outcome the job ends with.
    if (!(await writeConnection({ source, outcome: "failed", job, key, patch, deps }))) {
      return { status: "failed", errorCode, errorReference };
    }
    return { status: "retry", runAfter: addMs(now, delay), errorCode, errorReference };
  }

  const status: "needs_attention" | "failed" = permanent ? "needs_attention" : "failed";
  if (connection.status === "active") {
    // A sync reads the status again first (#487): an uninstall applied while it ran has written
    // its own event for the episode, and this sync's status write would not apply. This narrows
    // the race to the time between this read and the insert below; it cannot close it, because
    // the event has to be written before the status (see syncFailedEvent), so an uninstall landing
    // in between still gets this sync's event too, and only the status write is skipped.
    if (source === "sync") {
      const current = await deps.store.getConnection(key);
      if (current === null || !SYNCABLE_STATUSES.has(current.status)) {
        logSuperseded(job, key, "failed", deps);
        return { status: "failed", errorCode, errorReference };
      }
    }
    // Written before the status change, see syncFailedEvent.
    await deps.store.insertEvents([
      syncFailedEvent({
        connection,
        job,
        status,
        errorCode,
        errorReference,
        occurredAt: now,
      }),
    ]);
  }

  const patch: ConnectionPatch = {
    status,
    consecutive_failures: consecutiveFailures,
    last_error_code: errorCode,
    last_error_reference: errorReference,
    // needs_attention waits for the user; failed is retried by the scheduler once the cap elapses.
    next_sync_at: status === "failed" ? addMs(now, BACKOFF_CAP_MS).toISOString() : null,
  };
  if (error instanceof PermissionMissingError && error.missingScopes.length > 0) {
    patch.missing_scopes = [...new Set([...connection.missing_scopes, ...error.missingScopes])];
  }
  await writeConnection({ source, outcome: "failed", job, key, patch, deps });
  return { status: "failed", errorCode, errorReference };
}

/**
 * Takes a connection out of service the way a sync that hit AuthRevokedError does: the same
 * sync_failed event, `needs_attention` status, and patch, through the same code path. A provider's
 * uninstall delivery (#28) calls it so the connection asks for a reconnect at once instead of on
 * its next sync. A connection that is gone or already waiting for the user is left alone, as
 * `runSyncJob` leaves it.
 */
export async function markConnectionRevoked(input: {
  job: ClaimedJob;
  key: ConnectionKey;
  reason: string;
  deps: SyncDeps;
}): Promise<"marked" | "skipped"> {
  const { job, key, deps } = input;
  const connection = await deps.store.getConnection(key);
  if (connection === null || !SYNCABLE_STATUSES.has(connection.status)) return "skipped";
  await handleFailure({ error: new AuthRevokedError(input.reason), source: "uninstall", job, connection, key, deps });
  return "marked";
}
