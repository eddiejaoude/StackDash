import type { ActivityEvent } from "@/lib/adapters/events";
import type { ProviderId } from "@/lib/adapters/types";

import { toEventRow } from "./ingest";
import type { ClaimedJob, WebhookTarget } from "./store";
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
function distinctConnections(targets: readonly WebhookTarget[]): WebhookTarget[] {
  const byConnection = new Map<string, WebhookTarget>();
  for (const target of targets) if (!byConnection.has(target.connectionId)) byConnection.set(target.connectionId, target);
  return [...byConnection.values()];
}

/**
 * Achievements (#413) can be earned by an event (a first deployment), so the connections that
 * received one are evaluated now rather than on their next poll, as `runSyncJob` does after a
 * sync. Never fails the job: earning is idempotent, and the next sync catches up. Alerts are not
 * evaluated here: every alert rule is a threshold on snapshots, which a delivery never writes.
 */
async function evaluateAchievements(job: ClaimedJob, targets: readonly WebhookTarget[], deps: SyncDeps): Promise<void> {
  for (const target of distinctConnections(targets)) {
    try {
      await deps.evaluateAchievements(target.workspaceId, target.connectionId, deps.now());
    } catch (error) {
      deps.logError("webhook.achievement_evaluation_failed", error, {
        jobId: job.id,
        workspaceId: target.workspaceId,
        connectionId: target.connectionId,
      });
    }
  }
}

export async function runWebhookJob(job: ClaimedJob, deps: SyncDeps): Promise<JobOutcome> {
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
  const targets = await deps.store.listWebhookTargets({
    provider,
    externalAccountId: outcome.externalAccountId,
    endpointId: delivery.endpointId,
  });
  if (targets.length === 0) {
    // An account no workspace includes, or whose connection is gone: nothing to apply it to.
    deps.log.info("webhook.no_targets", { jobId: job.id, provider, deliveryRowId: delivery.id, kind: outcome.kind });
  } else if (outcome.kind === "events") {
    const inserted = await writeEvents(provider, targets, outcome.events, deps);
    deps.log.info("webhook.events_written", { jobId: job.id, provider, targets: targets.length, inserted });
    if (inserted > 0) await evaluateAchievements(job, targets, deps);
  } else {
    for (const target of distinctConnections(targets)) {
      // An uninstall older than the last time the connection's credential was saved is left to
      // the next sync. A save is a reconnect or a token refresh, and the two cannot be told apart
      // here: revoking a live reconnect over a late or redelivered uninstall costs more than
      // leaving a real one to the next sync, which fails and asks for a reconnect as it did before
      // webhooks. A credential saved at the same instant is not after it.
      if (target.credentialUpdatedAt !== null && Date.parse(target.credentialUpdatedAt) > outcome.occurredAt.getTime()) {
        deps.log.info("webhook.uninstall_stale", { jobId: job.id, provider, connectionId: target.connectionId });
        continue;
      }
      const result = await markConnectionRevoked({
        job,
        key: { workspaceId: target.workspaceId, connectionId: target.connectionId },
        reason: `${provider} reported that StackDash was removed from the account`,
        deps,
      });
      deps.log.info("webhook.uninstalled", { jobId: job.id, provider, connectionId: target.connectionId, result });
    }
  }

  await deps.store.finishWebhookDelivery(delivery.id, deps.now());
  return { status: "succeeded" };
}
