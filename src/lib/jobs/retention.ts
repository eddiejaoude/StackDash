import type { JobStore } from "./store";
import { utcDate } from "./ingest";

import { ATTACHMENT_SWEEP_AGE_HOURS } from "@/lib/support/limits";

/*
 * Retention (#37 decision): daily snapshots and activity events are kept 13 months, sync job rows
 * and digest delivery records (#152) 30 days. Triggered alerts are kept while their rule exists, so
 * they are not touched here, and their delivery records go with them. OAuth
 * states go once expired: a finished connect flow deletes its own state, so an expired one belongs
 * to an abandoned flow and still holds a sealed PKCE verifier bound to a user.
 * Share surfaces (#149): the per-minute rate limit counters are kept one day (they only need the
 * current minute, and hold hashed IPs of the public routes and HMACs of webhook endpoint ids, #28),
 * published metric view counts 13 months like the history they describe.
 * Webhook delivery records (#28) are kept WEBHOOK_DELIVERY_RETENTION_DAYS, the deduplication
 * window; each one's job goes with it.
 * Support chat (#680): its rate limit counters (HMACs of user ids and IPs) are kept one day like the
 * public ones. An image attached and never sent, and an object in the support-attachments bucket
 * that no row names (what a cascade leaves), are deleted after ATTACHMENT_SWEEP_AGE_HOURS. Those
 * two delete bytes through the Storage API, objects before rows, so a run cut short leaves rows the
 * next run finds again; they go in batches of SUPPORT_ATTACHMENT_BATCH_SIZE. Conversations
 * themselves are kept until the account is deleted.
 * Deletes run in batches until a batch comes back short, so the job is safe to re-run and a run cut
 * short by the time budget is finished by the next one.
 */

export const HISTORY_RETENTION_MONTHS = 13;
export const SYNC_JOB_RETENTION_DAYS = 30;
export const RATE_LIMIT_COUNTER_RETENTION_DAYS = 1;
// Longer than any provider's retry window (Stripe retries for up to 3 days), so a late retry of a
// delivery is still recognized as a repeat and dropped instead of processed again.
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;
export const RETENTION_BATCH_SIZE = 1000;
// Storage deletes up to this many objects per request (src/lib/support/attachment-store.ts).
export const SUPPORT_ATTACHMENT_BATCH_SIZE = 100;

/**
 * The same calendar day `months` earlier in UTC, clamped to the end of a shorter month (13 months
 * before 2027-03-31 is 2026-02-28).
 */
export function subtractUtcMonths(at: Date, months: number): Date {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() - months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(at.getUTCDate(), lastDay),
      at.getUTCHours(),
      at.getUTCMinutes(),
      at.getUTCSeconds(),
      at.getUTCMilliseconds(),
    ),
  );
}

export type RetentionCutoffs = Readonly<{
  // Snapshots with snapshot_date strictly before this UTC date are deleted.
  snapshotsBeforeDate: string;
  // Events with occurred_at strictly before this instant are deleted.
  eventsBefore: Date;
  // Finished jobs created strictly before this instant are deleted.
  jobsBefore: Date;
  // Public and support rate limit counters whose window started strictly before this instant are deleted.
  rateLimitCountersBefore: Date;
  // Published metric view counts of UTC days strictly before this date are deleted.
  metricViewsBeforeDate: string;
  // Webhook delivery records received strictly before this instant are deleted.
  webhookDeliveriesBefore: Date;
  // Unsent support attachments claimed, and unnamed support objects created, strictly before this instant are deleted.
  supportAttachmentsBefore: Date;
}>;

/** Everything exactly 13 months old (or 30 days for jobs) is kept; anything older goes. */
export function retentionCutoffs(now: Date): RetentionCutoffs {
  const historyCutoff = subtractUtcMonths(now, HISTORY_RETENTION_MONTHS);
  return {
    snapshotsBeforeDate: utcDate(historyCutoff),
    eventsBefore: historyCutoff,
    jobsBefore: new Date(now.getTime() - SYNC_JOB_RETENTION_DAYS * 86_400_000),
    rateLimitCountersBefore: new Date(now.getTime() - RATE_LIMIT_COUNTER_RETENTION_DAYS * 86_400_000),
    metricViewsBeforeDate: utcDate(historyCutoff),
    webhookDeliveriesBefore: new Date(now.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * 86_400_000),
    supportAttachmentsBefore: new Date(now.getTime() - ATTACHMENT_SWEEP_AGE_HOURS * 3_600_000),
  };
}

export type RetentionResult = {
  oauthStates: number;
  snapshots: number;
  events: number;
  jobs: number;
  rateLimitCounters: number;
  metricViews: number;
  deliveries: number;
  webhookDeliveries: number;
  supportRateLimitCounters: number;
  supportAttachments: number;
  supportOrphanObjects: number;
  // False when the time budget ran out first; the next run continues.
  complete: boolean;
};

async function purgeAll(
  purge: () => Promise<number>,
  hasTime: () => boolean,
  batchSize: number = RETENTION_BATCH_SIZE,
): Promise<{ deleted: number; complete: boolean }> {
  let deleted = 0;
  for (;;) {
    if (!hasTime()) return { deleted, complete: false };
    const batch = await purge();
    deleted += batch;
    if (batch < batchSize) return { deleted, complete: true };
  }
}

export async function runRetention(store: JobStore, now: Date, hasTime: () => boolean): Promise<RetentionResult> {
  const cutoffs = retentionCutoffs(now);
  // First: the table is small, and its rows hold secrets, so a long history purge never delays it.
  const oauthStates = await purgeAll(() => store.purgeOAuthStates(now, RETENTION_BATCH_SIZE), hasTime);
  const snapshots = await purgeAll(() => store.purgeSnapshots(cutoffs.snapshotsBeforeDate, RETENTION_BATCH_SIZE), hasTime);
  const events = await purgeAll(() => store.purgeEvents(cutoffs.eventsBefore, RETENTION_BATCH_SIZE), hasTime);
  const jobs = await purgeAll(() => store.purgeJobs(cutoffs.jobsBefore, RETENTION_BATCH_SIZE), hasTime);
  const rateLimitCounters = await purgeAll(
    () => store.purgeRateLimitCounters(cutoffs.rateLimitCountersBefore, RETENTION_BATCH_SIZE),
    hasTime,
  );
  const metricViews = await purgeAll(() => store.purgeMetricViews(cutoffs.metricViewsBeforeDate, RETENTION_BATCH_SIZE), hasTime);
  // Digest delivery records only stop a retried digest job from sending twice, so they share the
  // job rows' 30 days.
  const deliveries = await purgeAll(() => store.purgeNotificationDeliveries(cutoffs.jobsBefore, RETENTION_BATCH_SIZE), hasTime);
  const webhookDeliveries = await purgeAll(
    () => store.purgeWebhookDeliveries(cutoffs.webhookDeliveriesBefore, RETENTION_BATCH_SIZE),
    hasTime,
  );
  const supportRateLimitCounters = await purgeAll(
    () => store.purgeSupportRateLimitCounters(cutoffs.rateLimitCountersBefore, RETENTION_BATCH_SIZE),
    hasTime,
  );
  const supportAttachments = await purgeAll(
    () => store.purgeStagedSupportAttachments(cutoffs.supportAttachmentsBefore, SUPPORT_ATTACHMENT_BATCH_SIZE),
    hasTime,
    SUPPORT_ATTACHMENT_BATCH_SIZE,
  );
  // After the staged rows, whose objects that sweep deletes itself.
  const supportOrphanObjects = await purgeAll(
    () => store.purgeOrphanedSupportObjects(cutoffs.supportAttachmentsBefore, SUPPORT_ATTACHMENT_BATCH_SIZE),
    hasTime,
    SUPPORT_ATTACHMENT_BATCH_SIZE,
  );
  const purges = [
    oauthStates,
    snapshots,
    events,
    jobs,
    rateLimitCounters,
    metricViews,
    deliveries,
    webhookDeliveries,
    supportRateLimitCounters,
    supportAttachments,
    supportOrphanObjects,
  ];
  return {
    oauthStates: oauthStates.deleted,
    snapshots: snapshots.deleted,
    events: events.deleted,
    jobs: jobs.deleted,
    rateLimitCounters: rateLimitCounters.deleted,
    metricViews: metricViews.deleted,
    deliveries: deliveries.deleted,
    webhookDeliveries: webhookDeliveries.deleted,
    supportRateLimitCounters: supportRateLimitCounters.deleted,
    supportAttachments: supportAttachments.deleted,
    supportOrphanObjects: supportOrphanObjects.deleted,
    complete: purges.every((purge) => purge.complete),
  };
}
