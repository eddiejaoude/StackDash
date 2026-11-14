import { createHash } from "node:crypto";

import { aggregateDashboard, type DashboardInput } from "@/lib/dashboard/aggregate";
import type { EmailMessage, EmailTransport } from "@/lib/email/send";
import { EmailSendError } from "@/lib/email/send";
import type { ClaimedJob, EventRow } from "@/lib/jobs/store";
import type { JobOutcome } from "@/lib/jobs/sync-connection";
import type { LogFields, Logger } from "@/lib/log/logger";

import {
  channelRequest,
  describeFailure,
  repairStep,
  SECRET_MISSING_CODE,
  type ChannelRequest,
  type ChannelSecret,
  type PostOutcome,
} from "./channels";
import { renderNoticeEmail } from "./email";
import { emailPreferenceUrl, unsubscribeUrls, workspaceLinks } from "./links";
import {
  alertSubjectKey,
  digestJobDate,
  digestPeriods,
  digestSubjectKey,
  nextDestinationHealth,
  planAlertMessages,
  planDigestTargets,
  type DeliveryAlert,
  type DeliveryDestination,
  type DeliveryTarget,
  type DigestPeriod,
  type EmailFrequency,
  type Recipient,
} from "./model";
import {
  alertNotice,
  digestNotice,
  type DigestAllowance,
  type DigestHighlights,
  type DigestSpend,
  type Notice,
} from "./notice";

/*
 * The two notification jobs (#152, #153), run by the tick like any job (src/lib/jobs/runner.ts).
 * Everything they touch is injected (`NotificationDeps`), so delivery, retries, and failure
 * handling are unit tested against an in-memory store and a mocked transport.
 *
 * - alert_dispatch sends every triggered alert not dispatched yet: one coalesced message per
 *   recipient and channel (planAlertMessages), a delivery record per alert and target, then
 *   `dispatched_at`. A target that fails is retried with the job's backoff; targets already
 *   delivered are skipped on the retry. After the last attempt the alerts are marked dispatched
 *   anyway, so one broken channel cannot hold back every later alert.
 * - digest sends the daily digest (and the weekly one on Mondays) to the members and channels that
 *   chose it, with the same delivery records.
 * - Every failed send writes one `stackdash.notification_failed` timeline event per job and target,
 *   with the reference id of the logged error. A channel whose failures cross the limit becomes
 *   "needs attention" and writes one `stackdash.channel_needs_attention` event.
 */

export const NOTIFICATION_FAILED_TYPE_ID = "stackdash.notification_failed";
export const CHANNEL_NEEDS_ATTENTION_TYPE_ID = "stackdash.channel_needs_attention";

// Bounds for one dispatch. Alerts beyond the first batch go out with the next tick's dispatch.
export const DISPATCH_ALERT_LIMIT = 100;
// Messages of one job sent at the same time. Each goes to a different recipient or webhook, so
// per-webhook rate limits (Slack: about one post per second) are unaffected; the bound keeps an
// instance with many owners from sending that many emails to Resend at once.
export const DELIVERY_CONCURRENCY = 4;

export type WorkspaceInfo = Readonly<{ id: string; slug: string; name: string }>;

export type DeliveryRecord = Readonly<{
  workspaceId: string;
  subjectKey: string;
  target: DeliveryTarget;
  triggeredAlertId: string | null;
}>;

export type DestinationHealthPatch = Readonly<{
  status: DeliveryDestination["status"];
  consecutive_failures: number;
  last_error_code: string | null;
  last_error_reference: string | null;
  last_delivered_at?: string;
}>;

export interface NotificationStore {
  getWorkspace(workspaceId: string): Promise<WorkspaceInfo | null>;
  listUndispatchedAlerts(workspaceId: string, limit: number): Promise<DeliveryAlert[]>;
  listAlertsTriggeredBetween(workspaceId: string, start: string, end: string, limit: number): Promise<DeliveryAlert[]>;
  listRecipients(workspaceId: string): Promise<Recipient[]>;
  listDestinations(workspaceId: string): Promise<DeliveryDestination[]>;
  loadDestinationSecret(workspaceId: string, destinationId: string): Promise<ChannelSecret | null>;
  /** `deliveryKey`s of the deliveries already made for these subjects. */
  listDeliveries(workspaceId: string, subjectKeys: readonly string[]): Promise<Set<string>>;
  /** Inserts, skipping a (subject, target) pair that already exists. */
  recordDeliveries(records: readonly DeliveryRecord[]): Promise<void>;
  markDispatched(workspaceId: string, alertIds: readonly string[], at: Date): Promise<void>;
  updateDestinationHealth(workspaceId: string, destinationId: string, patch: DestinationHealthPatch): Promise<void>;
  insertEvents(rows: readonly EventRow[]): Promise<number>;
  /** What the dashboard reduces, for the digest's allowances and spend. */
  loadDashboardInput(workspaceId: string, now: Date): Promise<DashboardInput>;
  countHighlights(workspaceId: string, start: string, end: string): Promise<DigestHighlights>;
}

export type NotificationDeps = Readonly<{
  store: NotificationStore;
  /** Null when email is not set up on this instance: email targets are skipped, channels still send. */
  email: EmailTransport | null;
  post: (request: ChannelRequest) => Promise<PostOutcome>;
  /** The instance's public origin, for links in messages. */
  origin: () => string;
  unsubscribeToken: (workspaceId: string, userId: string) => string;
  now: () => Date;
  random: () => number;
  newId: () => string;
  logError: (event: string, error: unknown, fields?: LogFields) => string;
  log: Logger;
}>;

type SendResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; retryable: boolean; code: string; referenceId: string }>;

const FREQUENCY_REASON: Record<EmailFrequency, string> = {
  immediate: "each alert as it happens",
  daily: "a daily digest",
  weekly: "a weekly digest",
  off: "off",
};

function backoffMs(attempt: number, random: () => number): number {
  // Same shape as the sync backoff: full jitter up to min(1 hour, 60 s x 2^(attempt - 1)).
  return Math.floor(random() * Math.min(3_600_000, 60_000 * 2 ** (attempt - 1)));
}

class DeliveryFailure extends Error {
  override readonly name = "DeliveryFailure";
}

async function sendToTarget(
  deps: NotificationDeps,
  workspace: WorkspaceInfo,
  target: DeliveryTarget,
  notice: Notice,
  idempotencyKey: string,
): Promise<SendResult> {
  const origin = deps.origin();
  if (target.kind === "email") {
    if (deps.email === null) return { ok: true };
    const { recipient } = target;
    const urls = unsubscribeUrls(origin, deps.unsubscribeToken(workspace.id, recipient.userId));
    const rendered = renderNoticeEmail(notice, {
      reason: `You get this because you are an owner or admin of ${workspace.name} and your alert emails are set to ${FREQUENCY_REASON[recipient.frequency]}.`,
      preferencesUrl: emailPreferenceUrl(origin, workspace.slug),
      unsubscribePageUrl: urls.page,
      oneClickUrl: urls.oneClick,
    });
    const message: EmailMessage = { ...rendered, to: recipient.email, idempotencyKey };
    try {
      await deps.email.send(message);
      return { ok: true };
    } catch (error) {
      const retryable = error instanceof EmailSendError ? error.retryable : true;
      const referenceId = deps.logError("notifications.email_failed", error, {
        workspaceId: workspace.id,
        retryable,
      });
      return { ok: false, retryable, code: "email_failed", referenceId };
    }
  }

  const { destination } = target;
  const secret = await deps.store.loadDestinationSecret(workspace.id, destination.id);
  if (secret === null) {
    // No sealed URL, or one this instance cannot decrypt (sealed under a key it no longer has, see
    // scripts/rotate-encryption-key.ts). Retrying cannot bring it back: the channel needs its URL again.
    const referenceId = deps.logError("notifications.channel_secret_missing", new DeliveryFailure("No readable sealed URL for the channel"), {
      workspaceId: workspace.id,
      destinationId: destination.id,
    });
    return recordChannelFailure(deps, workspace, destination, { code: SECRET_MISSING_CODE, retryable: false }, referenceId);
  }
  const outcome = await deps.post(channelRequest(destination.kind, secret, notice, deps));
  if (outcome.ok) {
    await deps.store.updateDestinationHealth(workspace.id, destination.id, {
      status: nextDestinationHealth(destination, "delivered").status,
      consecutive_failures: 0,
      last_error_code: null,
      last_error_reference: null,
      last_delivered_at: deps.now().toISOString(),
    });
    return { ok: true };
  }
  // The URL is a secret: only the kind, the id, and the code are logged.
  const referenceId = deps.logError("notifications.channel_failed", new DeliveryFailure(`Channel answered ${outcome.code}`), {
    workspaceId: workspace.id,
    destinationId: destination.id,
    kind: destination.kind,
    code: outcome.code,
    attempts: outcome.attempts,
  });
  return recordChannelFailure(deps, workspace, destination, outcome, referenceId);
}

/**
 * Writes a failed delivery onto the channel: its failure count, error code, and reference id, so
 * alert settings shows the problem. A permanent failure, or the one that reaches the limit, makes
 * the channel "needs attention" and writes one `stackdash.channel_needs_attention` event.
 */
async function recordChannelFailure(
  deps: NotificationDeps,
  workspace: WorkspaceInfo,
  destination: DeliveryDestination,
  failure: Readonly<{ code: string; retryable: boolean }>,
  referenceId: string,
): Promise<SendResult> {
  const health = nextDestinationHealth(destination, failure.retryable ? "transient_failure" : "permanent_failure");
  await deps.store.updateDestinationHealth(workspace.id, destination.id, {
    status: health.status,
    consecutive_failures: health.consecutiveFailures,
    last_error_code: failure.code,
    last_error_reference: referenceId,
  });
  if (health.becameNeedsAttention) {
    await deps.store.insertEvents([
      {
        workspace_id: workspace.id,
        connection_id: null,
        external_account_id: null,
        provider: null,
        type_id: CHANNEL_NEEDS_ATTENTION_TYPE_ID,
        severity: "critical",
        title: `The channel ${destination.name} needs attention`,
        body: `${describeFailure(failure.code)}, so StackDash stopped posting alerts to ${destination.name}. ${repairStep(failure.code, false)}. Reference ${referenceId}.`,
        url: null,
        occurred_at: deps.now().toISOString(),
        dedupe_key: `channel_needs_attention:${destination.id}:${deps.now().toISOString()}`,
      },
    ]);
  }
  return { ok: false, retryable: failure.retryable && !health.becameNeedsAttention, code: failure.code, referenceId };
}

function failureEvent(input: {
  workspace: WorkspaceInfo;
  job: ClaimedJob;
  target: DeliveryTarget;
  what: "alerts" | "digest";
  result: Extract<SendResult, { ok: false }>;
  willRetry: boolean;
  now: Date;
}): EventRow {
  const { target, result } = input;
  const subject = input.what === "alerts" ? "An alert" : "The digest";
  const where =
    target.kind === "email"
      ? "the email to an owner or admin of this workspace"
      : `the channel ${target.destination.name}`;
  const next = input.willRetry
    ? "StackDash tries again shortly."
    : target.kind === "email"
      ? "StackDash will not try this message again. Alerts stay on the alerts page."
      : "StackDash will not try this message again. Check the channel in alert settings.";
  return {
    workspace_id: input.workspace.id,
    connection_id: null,
    external_account_id: null,
    provider: null,
    type_id: NOTIFICATION_FAILED_TYPE_ID,
    severity: "warning",
    title: target.kind === "email" ? `${subject} email could not be sent` : `${subject} could not be posted to ${target.destination.name}`,
    body: `${subject} could not be delivered through ${where}. ${next} Reference ${result.referenceId}.`,
    url: null,
    occurred_at: input.now.toISOString(),
    // One event per job and target: the retries of the same job add nothing.
    dedupe_key: `notification_failed:${input.job.id}:${target.key}`,
  };
}

type PlannedMessage = Readonly<{ target: DeliveryTarget; notice: Notice; subjectKeys: readonly string[]; alertIds: readonly (string | null)[] }>;

/**
 * Same message, same key, for Resend's 24 hour idempotency window: the target and every subject,
 * hashed so a message to many alerts keeps a key unique to its whole alert set (Resend allows 256
 * characters, which a list of alert ids outgrows).
 */
function idempotencyKey(message: PlannedMessage): string {
  return `${message.target.key}:${createHash("sha256").update(message.subjectKeys.join(",")).digest("hex")}`;
}

/**
 * Sends the messages of one job, DELIVERY_CONCURRENCY at a time, so a job takes about as long as
 * its slowest target rather than the sum of them and stays inside the job lease. Each message has
 * its own target, so health updates and events never race on the same row.
 */
async function deliverAll(input: {
  deps: NotificationDeps;
  job: ClaimedJob;
  workspace: WorkspaceInfo;
  what: "alerts" | "digest";
  messages: readonly PlannedMessage[];
}): Promise<{ retryable: number; failed: number; delivered: number }> {
  const { deps, job, workspace } = input;
  const lastAttempt = job.attempts >= job.max_attempts;
  const counts = { retryable: 0, failed: 0, delivered: 0 };
  const deliver = async (message: PlannedMessage) => {
    const result = await sendToTarget(deps, workspace, message.target, message.notice, idempotencyKey(message));
    if (result.ok) {
      await deps.store.recordDeliveries(
        message.subjectKeys.map((subjectKey, index) => ({
          workspaceId: workspace.id,
          subjectKey,
          target: message.target,
          triggeredAlertId: message.alertIds[index] ?? null,
        })),
      );
      counts.delivered += 1;
      return;
    }
    const willRetry = result.retryable && !lastAttempt;
    if (willRetry) counts.retryable += 1;
    else counts.failed += 1;
    await deps.store.insertEvents([
      failureEvent({ workspace, job, target: message.target, what: input.what, result, willRetry, now: deps.now() }),
    ]);
  };
  let next = 0;
  const worker = async () => {
    for (let message = input.messages[next++]; message !== undefined; message = input.messages[next++]) await deliver(message);
  };
  await Promise.all(Array.from({ length: Math.min(DELIVERY_CONCURRENCY, input.messages.length) }, worker));
  return counts;
}

export async function runAlertDispatchJob(job: ClaimedJob, deps: NotificationDeps): Promise<JobOutcome> {
  if (job.workspace_id === null) return { status: "failed", errorCode: "invalid_job", errorReference: null };
  const workspace = await deps.store.getWorkspace(job.workspace_id);
  if (workspace === null) return { status: "succeeded" };
  const alerts = await deps.store.listUndispatchedAlerts(workspace.id, DISPATCH_ALERT_LIMIT);
  if (alerts.length === 0) return { status: "succeeded" };

  const [recipients, destinations, delivered] = await Promise.all([
    deps.store.listRecipients(workspace.id),
    deps.store.listDestinations(workspace.id),
    deps.store.listDeliveries(workspace.id, alerts.map((alert) => alertSubjectKey(alert.id))),
  ]);
  const planned = planAlertMessages({
    alerts,
    // Without an email transport nobody can be emailed; channels still get the alerts.
    recipients: deps.email === null ? [] : recipients,
    destinations,
    delivered,
  });
  // Nobody to send to (no email transport or recipients, no channel): the alerts are handled. No
  // links are built, so an instance without delivery needs no public origin either.
  if (planned.length === 0) {
    await deps.store.markDispatched(workspace.id, alerts.map((alert) => alert.id), deps.now());
    return { status: "succeeded" };
  }
  const links = workspaceLinks(deps.origin(), workspace.slug);
  const result = await deliverAll({
    deps,
    job,
    workspace,
    what: "alerts",
    messages: planned.map(({ target, alerts: pending }) => ({
      target,
      notice: alertNotice({ workspaceName: workspace.name, alerts: pending, links }),
      subjectKeys: pending.map((alert) => alertSubjectKey(alert.id)),
      alertIds: pending.map((alert) => alert.id),
    })),
  });
  deps.log.info("notifications.alerts_dispatched", { jobId: job.id, workspaceId: workspace.id, alerts: alerts.length, ...result });

  if (result.retryable > 0) {
    return {
      status: "retry",
      runAfter: new Date(deps.now().getTime() + backoffMs(job.attempts, deps.random)),
      errorCode: "delivery_failed",
      errorReference: null,
    };
  }
  await deps.store.markDispatched(workspace.id, alerts.map((alert) => alert.id), deps.now());
  return { status: "succeeded" };
}

// ── Digest ──────────────────────────────────────────────────────────────────────

const DIGEST_ALERT_LIMIT = 50;

/** Allowances and spend per connection, reduced exactly as the dashboard reduces them. */
export function digestFigures(input: DashboardInput): { allowances: DigestAllowance[]; spend: DigestSpend[] } {
  const view = aggregateDashboard(input);
  const allowances: DigestAllowance[] = [];
  const spend: DigestSpend[] = [];
  for (const provider of view.byProvider) {
    for (const allowance of provider.allowances) {
      allowances.push({
        connectionName: provider.name,
        label: allowance.label,
        unit: allowance.unit,
        used: allowance.used?.value ?? null,
        included: allowance.included?.value ?? null,
        percentUsed: allowance.percentUsed,
        resetsAt: allowance.resetsAt,
      });
    }
    for (const amounts of provider.spend) {
      spend.push({
        connectionName: provider.name,
        currency: amounts.currency,
        verifiedMinor: amounts.verified?.amountMinor ?? null,
        estimatedMinor: amounts.estimated?.amountMinor ?? null,
        period: provider.billingPeriod,
      });
    }
  }
  return { allowances, spend };
}

async function digestNoticeFor(deps: NotificationDeps, workspace: WorkspaceInfo, period: DigestPeriod): Promise<Notice> {
  const [alerts, dashboard, highlights] = await Promise.all([
    deps.store.listAlertsTriggeredBetween(workspace.id, period.start, period.end, DIGEST_ALERT_LIMIT),
    deps.store.loadDashboardInput(workspace.id, deps.now()),
    deps.store.countHighlights(workspace.id, period.start, period.end),
  ]);
  return digestNotice(
    { workspaceName: workspace.name, period, alerts, highlights, ...digestFigures(dashboard) },
    workspaceLinks(deps.origin(), workspace.slug),
  );
}

export async function runDigestJob(job: ClaimedJob, deps: NotificationDeps): Promise<JobOutcome> {
  const date = digestJobDate(job.dedupe_key);
  if (job.workspace_id === null || date === null) return { status: "failed", errorCode: "invalid_job", errorReference: null };
  const workspace = await deps.store.getWorkspace(job.workspace_id);
  if (workspace === null) return { status: "succeeded" };
  const periods = digestPeriods(date);
  // Read once for both periods: a channel has one digest frequency (planDigestTargets keeps only
  // destinations whose `digest` is the period's), so on a Monday no channel is posted twice and the
  // health a daily post writes is never read back for a weekly one.
  const [recipients, destinations, delivered] = await Promise.all([
    deps.store.listRecipients(workspace.id),
    deps.store.listDestinations(workspace.id),
    deps.store.listDeliveries(workspace.id, periods.map(digestSubjectKey)),
  ]);

  let retryable = 0;
  for (const period of periods) {
    const targets = planDigestTargets({
      period,
      recipients: deps.email === null ? [] : recipients,
      destinations,
      delivered,
    });
    if (targets.length === 0) continue;
    const notice = await digestNoticeFor(deps, workspace, period);
    const subjectKey = digestSubjectKey(period);
    const result = await deliverAll({
      deps,
      job,
      workspace,
      what: "digest",
      messages: targets.map((target) => ({ target, notice, subjectKeys: [subjectKey], alertIds: [null] })),
    });
    deps.log.info("notifications.digest_sent", { jobId: job.id, workspaceId: workspace.id, frequency: period.frequency, ...result });
    retryable += result.retryable;
  }
  if (retryable > 0) {
    return {
      status: "retry",
      runAfter: new Date(deps.now().getTime() + backoffMs(job.attempts, deps.random)),
      errorCode: "delivery_failed",
      errorReference: null,
    };
  }
  return { status: "succeeded" };
}
