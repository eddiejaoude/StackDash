import type { ActivityEvent } from "@/lib/adapters/events";
import type { ProviderId } from "@/lib/adapters/types";

import { toEventRow } from "./ingest";
import type { ClaimedJob, ConnectionKey, ConnectionTarget, StoredWebhookOutcome, WebhookDeliveryRecord, WebhookTarget } from "./store";
import { markConnectionRevoked, type JobOutcome, type SyncDeps } from "./sync-connection";

/*
 * One `webhook` job (#28): applies a verified delivery the route stored, on the next tick. The route
 * answers the provider at once and never writes events itself, so a slow database never makes a
 * provider time out and retry.
 *
 * Idempotent like a sync: events insert on (workspace_id, dedupe_key) and carry the dedupe key the
 * adapter's `sync` produces for the same provider event, so a retried job, a repeated delivery that
 * slipped past deduplication, or the next poll all store each event once. Store failures throw and
 * the runner retries the job with backoff.
 */

/** Every target's copy of the delivery's events, written in one insert. */
async function writeEvents(
  provider: ProviderId,
  targets: readonly WebhookTarget[],
  events: readonly ActivityEvent[],
  deps: SyncDeps,
): Promise<number> {
  const rows = targets.flatMap((target) =>
    events.map((event) =>
      toEventRow(event, provider, { id: target.connectionId, workspace_id: target.workspaceId }, { id: target.accountId }),
    ),
  );
  // Two connections in one workspace that include the same account produce the same row twice;
  // the insert skips the second on (workspace_id, dedupe_key), as two syncs of that account do.
  return deps.store.insertEvents(rows);
}

/** One entry per connection: two included accounts of one connection are one connection to act on. */
function distinctConnections(targets: readonly ConnectionTarget[]): ConnectionTarget[] {
  const byConnection = new Map<string, ConnectionTarget>();
  for (const target of targets) if (!byConnection.has(target.connectionId)) byConnection.set(target.connectionId, target);
  return [...byConnection.values()];
}

type Uninstall = Extract<StoredWebhookOutcome, { kind: "uninstalled" }>;

/**
 * The connections an uninstall names: those including the account, or those whose credential
 * belongs to the installation (`external_installation_id`, #480), one entry per connection.
 */
async function uninstallTargets(outcome: Uninstall, delivery: WebhookDeliveryRecord, deps: SyncDeps): Promise<ConnectionTarget[]> {
  const { provider, endpointId } = delivery;
  if (outcome.by === "installation") {
    return deps.store.listInstallationTargets({ provider, installationId: outcome.installationId, endpointId });
  }
  return distinctConnections(
    await deps.store.listWebhookTargets({ provider, externalAccountId: outcome.externalAccountId, installationId: null, endpointId }),
  );
}

/**
 * The targets of the kind that verified the delivery (#495), as the route recorded it: simulated
 * connections for a delivery the provider's simulated twin verified, real ones otherwise. The twin
 * checks an app-level delivery with STACKDASH_SIMULATED_WEBHOOK_SECRET, a value from .env.local or
 * the synthetic one e2e signs with, so what it accepts must never reach a real connection that
 * includes the same account; and a real delivery has nothing to say to a connection of made-up
 * data. The recorded kind decides, not the simulation flag now: the flag can change between the
 * route accepting a delivery and a tick, or a retry, applying it. A per-connection delivery
 * (`endpointId` set: GitLab, Polar, Resend) follows the same rule on purpose, although both the
 * twin and the live adapter verify it with its endpoint's stored secret and the endpoint names its
 * one connection: the kinds match unless the flag changed since the connection was made, and a
 * connection in that state already refuses to sync, so one rule keeps a real delivery off made-up
 * data and the twin's off real data. What it drops: an authentic delivery to a real connection's URL
 * while simulation is on, a delivery to a simulated connection's URL while it is off, and a
 * per-connection delivery in flight across the deploy of #495 (no recorded kind, below). A real
 * connection's next successful sync brings those events (once simulation is off, as the twin
 * refuses its credential), and an uninstall shows when that sync finds the grant gone; a simulated
 * connection loses only made-up data. The fake provider has no twin, so its deliveries and its
 * connections are real. A delivery a build before #495 stored records no kind (`simulated` null),
 * so nothing says which secret verified it: it reaches no connection. The rest are logged as a
 * count, never by id.
 */
function targetsOfDeliveryKind<T extends ConnectionTarget>(targets: readonly T[], job: ClaimedJob, delivery: WebhookDeliveryRecord, deps: SyncDeps): T[] {
  const { simulated } = delivery;
  const kept = simulated === null ? [] : targets.filter((target) => target.simulated === simulated);
  if (kept.length < targets.length) {
    deps.log.info("webhook.targets_dropped", {
      jobId: job.id,
      provider: delivery.provider,
      deliveryRowId: delivery.id,
      kind: delivery.outcome.kind,
      simulated,
      dropped: targets.length - kept.length,
    });
  }
  return kept;
}

/**
 * Achievements (#413) can be earned by an event (a first deployment), so once a tick's webhook jobs
 * are done (src/lib/jobs/runner.ts) the connections they stored a new event for are evaluated
 * rather than left to their next poll, as `runSyncJob` does after a sync. Once per connection, not
 * per delivery: an evaluation reads all retained events and readings of the pending rules' types
 * (src/lib/achievements/store.ts), and a burst for one account would otherwise repeat the same
 * reads for every delivery. None starts once `hasTime` (the tick's webhook share) is spent. Never
 * fails a job: earning is idempotent, and the connection's next successful sync evaluates whatever
 * was deferred or failed here (`runSyncJob` evaluates only after a sync succeeds). For an `active`
 * connection that is usually its next scheduled sync. A delivery also reaches `failed` and
 * `needs_attention` connections, and for those it comes later: a `failed` one is retried hourly
 * until a sync succeeds, and a `needs_attention` one is not synced until the user reconnects it.
 * Alerts are not evaluated: every alert rule is a threshold on snapshots, which a delivery never
 * writes.
 */
export async function evaluateDeliveredConnections(
  delivered: ReadonlyMap<string, ConnectionKey>,
  deps: SyncDeps,
  hasTime: () => boolean,
): Promise<void> {
  let evaluated = 0;
  for (const key of delivered.values()) {
    if (!hasTime()) {
      deps.log.info("webhook.achievements_deferred", { connections: delivered.size - evaluated });
      return;
    }
    evaluated += 1;
    try {
      await deps.evaluateAchievements(key.workspaceId, key.connectionId, deps.now());
    } catch (error) {
      deps.logError("webhook.achievement_evaluation_failed", error, key);
    }
  }
}

/**
 * Applies one delivery. Every connection it stores a new event for is added to `delivered`, keyed
 * by connection id, for the tick to evaluate once its webhook jobs are done.
 */
export async function runWebhookJob(
  job: ClaimedJob,
  deps: SyncDeps,
  delivered: Map<string, ConnectionKey>,
): Promise<JobOutcome> {
  if (job.webhook_delivery_id === null) {
    // The table's checks make this unreachable for kind 'webhook'; fail loudly rather than guess.
    return { status: "failed", errorCode: "invalid_job", errorReference: null };
  }
  const delivery = await deps.store.loadWebhookDelivery(job.webhook_delivery_id);
  if (delivery === null) {
    // Purged after the retention window, or already finished by an earlier run of this job.
    deps.log.info("webhook.delivery_missing", { jobId: job.id, deliveryRowId: job.webhook_delivery_id });
    return { status: "succeeded" };
  }

  // Never `ignored`: such a delivery is stored processed and queues no job.
  const { outcome, provider } = delivery;
  if (outcome.kind === "events") {
    // An installation named with the account (#497) narrows the targets to that installation's
    // connections, so an uninstalled connection that still includes the account gets nothing.
    const targets = targetsOfDeliveryKind(
      await deps.store.listWebhookTargets({
        provider,
        externalAccountId: outcome.externalAccountId,
        installationId: outcome.installationId ?? null,
        endpointId: delivery.endpointId,
      }),
      job,
      delivery,
      deps,
    );
    if (targets.length === 0) {
      // An account no workspace includes, or whose connection is gone or belongs to another or no
      // recorded installation, or only connections of the other kind (logged just above as
      // `webhook.targets_dropped`): nothing to apply it to. `installationNamed` (never the id) says
      // whether the installation took part, so a mismatch that polling would hide is not read as an
      // account nobody includes.
      deps.log.info("webhook.no_targets", {
        jobId: job.id,
        provider,
        deliveryRowId: delivery.id,
        kind: outcome.kind,
        installationNamed: outcome.installationId !== undefined,
      });
    } else {
      const inserted = await writeEvents(provider, targets, outcome.events, deps);
      deps.log.info("webhook.events_written", { jobId: job.id, provider, targets: targets.length, inserted });
      if (inserted > 0) {
        for (const { workspaceId, connectionId } of targets) delivered.set(connectionId, { workspaceId, connectionId });
      }
    }
  } else {
    const by = outcome.by ?? "account";
    const targets = targetsOfDeliveryKind(await uninstallTargets(outcome, delivery, deps), job, delivery, deps);
    if (targets.length === 0) {
      // An account or installation no live connection of this kind has: nothing to apply it to.
      deps.log.info("webhook.no_targets", { jobId: job.id, provider, deliveryRowId: delivery.id, kind: outcome.kind, by });
    }
    for (const target of targets) {
      // An uninstall older than the connection's last grant (a reconnect) is stale: revoking a live
      // reconnect over a late or redelivered uninstall would undo what the user just did. A token
      // refresh is not a grant and does not move the grant (#476), so a removal followed by a
      // refresh is still applied. A grant at the same instant is not after it. A null `grantedAt`
      // is a live connection with no recorded grant (#502): nothing is known to be newer than the
      // removal, so it is applied, whenever its credential was last saved.
      if (target.grantedAt !== null && Date.parse(target.grantedAt) > outcome.occurredAt.getTime()) {
        deps.log.info("webhook.uninstall_stale", { jobId: job.id, provider, connectionId: target.connectionId });
        continue;
      }
      const result = await markConnectionRevoked({
        job,
        key: { workspaceId: target.workspaceId, connectionId: target.connectionId },
        reason: `${provider} reported that StackDash was removed from the ${by}`,
        deps,
      });
      deps.log.info("webhook.uninstalled", { jobId: job.id, provider, connectionId: target.connectionId, by, result });
    }
  }

  await deps.store.finishWebhookDelivery(delivery.id, deps.now());
  return { status: "succeeded" };
}
