import { timingSafeEqual } from "node:crypto";

import { runAlertDispatchJob, runDigestJob } from "@/lib/notifications/dispatch";

import { backoffDelayMs } from "./backoff";
import { runDailySummaryJob } from "./daily-summary";
import { runRetention } from "./retention";
import { scheduleDueJobs, type ScheduleResult } from "./schedule";
import type { ClaimedJob } from "./store";
import { runSyncJob, type JobOutcome, type SyncDeps } from "./sync-connection";
import { runWebhookJob } from "./webhook-delivery";

/*
 * One tick (#10, #44): schedule due work, claim a bounded batch, and run it within a time budget so
 * a tick always finishes inside the function's maximum duration. Hosted and self-hosted run this
 * same code; only the caller of POST /api/jobs/tick differs (pg_cron, or `npm run jobs:tick`).
 *
 * `webhook` jobs (#28) are claimed separately (claim_webhook_jobs) with their own allowance and
 * started first; every other kind shares TICK_CLAIM_LIMIT (claim_sync_jobs). Neither claim can take
 * the other's share, so a burst of deliveries never stops polling or email, and a backlog of syncs
 * never holds a delivery back behind it.
 */

export const TICK_CLAIM_LIMIT = 10;
// A webhook job makes no provider call: it reads its delivery, finds its targets, and writes their
// events in one bounded insert (src/lib/jobs/webhook-delivery.ts), a handful of database round
// trips. 50 of them across TICK_CONCURRENCY workers is about 17 each, far inside TICK_BUDGET_MS
// beside the 10 regular jobs, whose provider calls are what the budget is sized for. Any the
// budget does not reach are released without spending an attempt, like the regular jobs.
export const WEBHOOK_TICK_CLAIM_LIMIT = 50;
// Longer than the budget plus the slowest job's provider timeouts, so a job is never claimed
// twice while it is still running. A tick that dies mid-job leaves the lease to expire.
export const TICK_LEASE_SECONDS = 120;
// No job starts after this much of the tick has passed; the route's maxDuration leaves headroom
// for the jobs already running to finish.
export const TICK_BUDGET_MS = 50_000;
export const TICK_CONCURRENCY = 3;
// Generated with `openssl rand -hex 32`; anything shorter is treated as not configured.
export const CRON_SECRET_MIN_LENGTH = 32;

/**
 * Checks `Authorization: Bearer <secret>` in constant time. False when the secret is not
 * configured, so a missing CRON_SECRET can never open the route.
 */
export function isAuthorizedCronRequest(authorization: string | null, secret: string | undefined): boolean {
  if (secret === undefined || secret.length < CRON_SECRET_MIN_LENGTH) return false;
  if (authorization === null) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const given = Buffer.from(authorization, "utf8");
  // timingSafeEqual throws on unequal lengths; the length itself is not secret.
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

export type TickResult = ScheduleResult & {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  released: number;
};

async function runJob(job: ClaimedJob, deps: SyncDeps, hasTime: () => boolean): Promise<JobOutcome> {
  if (job.kind === "sync") return runSyncJob(job, deps);
  if (job.kind === "webhook") return runWebhookJob(job, deps);
  if (job.kind === "daily_summary") return runDailySummaryJob(job, deps);
  if (job.kind === "alert_dispatch") return runAlertDispatchJob(job, deps.notifications());
  if (job.kind === "digest") return runDigestJob(job, deps.notifications());
  if (job.kind === "retention") {
    const result = await runRetention(deps.store, deps.now(), hasTime);
    deps.log.info("retention.finished", { jobId: job.id, ...result });
    return { status: "succeeded" };
  }
  // A kind this runner does not know (a row written by a newer version). Failing without retry
  // keeps it visible instead of looping.
  return { status: "failed", errorCode: "unsupported_kind", errorReference: null };
}

async function settle(job: ClaimedJob, deps: SyncDeps, hasTime: () => boolean): Promise<JobOutcome> {
  let outcome: JobOutcome;
  try {
    outcome = await runJob(job, deps, hasTime);
  } catch (error) {
    // Only store failures reach here; provider failures are outcomes. Retry like any transient
    // failure; the job's own attempt limit still applies.
    const errorReference = deps.logError("job.crashed", error, { jobId: job.id, kind: job.kind, attempt: job.attempts });
    outcome =
      job.attempts < job.max_attempts
        ? {
            status: "retry",
            runAfter: new Date(deps.now().getTime() + backoffDelayMs(job.attempts, deps.random)),
            errorCode: "internal_error",
            errorReference,
          }
        : { status: "failed", errorCode: "internal_error", errorReference };
  }

  switch (outcome.status) {
    case "succeeded":
      await deps.store.completeJob(job.id, deps.now());
      break;
    case "retry":
      await deps.store.retryJob(job.id, outcome.runAfter, outcome);
      break;
    case "failed":
      await deps.store.failJob(job.id, deps.now(), outcome);
      break;
  }
  return outcome;
}

export type TickOptions = Readonly<{
  claimLimit?: number;
  leaseSeconds?: number;
  budgetMs?: number;
  concurrency?: number;
}>;

export async function runTick(deps: SyncDeps, options: TickOptions = {}): Promise<TickResult> {
  const budgetMs = options.budgetMs ?? TICK_BUDGET_MS;
  const startedAt = deps.now().getTime();
  const hasTime = () => deps.now().getTime() - startedAt < budgetMs;

  const scheduled = await scheduleDueJobs(deps.store, new Date(startedAt));
  const leaseSeconds = options.leaseSeconds ?? TICK_LEASE_SECONDS;
  const webhookJobs = await deps.store.claimWebhookJobs(WEBHOOK_TICK_CLAIM_LIMIT, leaseSeconds);
  const otherJobs = await deps.store.claimJobs(options.claimLimit ?? TICK_CLAIM_LIMIT, leaseSeconds);

  const result: TickResult = {
    ...scheduled,
    claimed: webhookJobs.length + otherJobs.length,
    succeeded: 0,
    retried: 0,
    failed: 0,
    released: 0,
  };

  // Webhook jobs at the head: workers take jobs in this order, so every delivery starts before any
  // job of another kind and never waits behind a slow sync.
  const pending = [...webhookJobs, ...otherJobs];
  const worker = async () => {
    for (let job = pending.shift(); job !== undefined; job = pending.shift()) {
      if (!hasTime()) {
        // Never started, so it goes back without spending an attempt.
        await deps.store.releaseJob(job.id);
        result.released += 1;
        continue;
      }
      try {
        const outcome = await settle(job, deps, hasTime);
        if (outcome.status === "succeeded") result.succeeded += 1;
        else if (outcome.status === "retry") result.retried += 1;
        else result.failed += 1;
      } catch (error) {
        // Recording the outcome failed; the lease expires and the job is claimed again.
        deps.logError("job.settle_failed", error, { jobId: job.id, kind: job.kind });
        result.failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? TICK_CONCURRENCY, pending.length) }, worker));
  return result;
}
