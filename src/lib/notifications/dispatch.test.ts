import { describe, expect, it } from "vitest";

import { declaredProjectedSpend } from "@/lib/adapters/registry";
import type { ConnectionInput, DashboardInput, SnapshotInput } from "@/lib/dashboard/aggregate";
import { EmailSendError } from "@/lib/email/send";
import type { ClaimedJob } from "@/lib/jobs/store";

import type { PostOutcome } from "./channels";
import {
  CHANNEL_NEEDS_ATTENTION_TYPE_ID,
  DELIVERY_CONCURRENCY,
  digestFigures,
  NOTIFICATION_FAILED_TYPE_ID,
  runAlertDispatchJob,
  runDigestJob,
} from "./dispatch";
import { MemoryEmailTransport, MemoryNotificationStore, memoryNotificationDeps, type MemoryAlert, type MemoryDestination } from "./memory-store";
import { DESTINATION_FAILURE_LIMIT, digestJobKey, type Recipient } from "./model";

const WORKSPACE = { id: "11111111-1111-4111-8111-111111111111", slug: "acme123", name: "Acme" };
const NOW = new Date("2026-11-05T09:00:00.000Z");

const owner: Recipient = { userId: "u-owner", email: "owner@example.com", frequency: "immediate" };
const admin: Recipient = { userId: "u-admin", email: "admin@example.com", frequency: "immediate" };

function job(fields: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: "job-1",
    workspace_id: WORKSPACE.id,
    connection_id: null,
    kind: "alert_dispatch",
    attempts: 1,
    max_attempts: 5,
    created_at: NOW.toISOString(),
    dedupe_key: null,
    ...fields,
  };
}

function alert(id: string, fields: Partial<MemoryAlert> = {}): MemoryAlert {
  return {
    id,
    workspaceId: WORKSPACE.id,
    dispatchedAt: null,
    ruleId: `rule-${id}`,
    title: `Spend passed $${id}`,
    message: `Workspace spend is $${id} for the billing period starting 2026-11-01.`,
    severity: "warning",
    thresholdLabel: "$10.00",
    isEstimated: false,
    providerName: null,
    projectName: null,
    resetsAt: null,
    triggeredAt: "2026-11-05T08:59:00.000Z",
    ...fields,
  };
}

function channel(id: string, fields: Partial<MemoryDestination> = {}): MemoryDestination {
  return {
    id,
    workspaceId: WORKSPACE.id,
    kind: "slack",
    name: `#alerts-${id}`,
    allRules: true,
    ruleIds: new Set(),
    digest: "off",
    status: "active",
    consecutiveFailures: 0,
    secret: { url: `https://hooks.slack.com/services/T1/B1/${id}` },
    lastErrorCode: null,
    lastErrorReference: null,
    lastDeliveredAt: null,
    ...fields,
  };
}

function setup(options: { recipients?: Recipient[]; post?: (url: string) => PostOutcome } = {}) {
  const store = new MemoryNotificationStore();
  store.workspaces.push(WORKSPACE);
  store.recipients.set(WORKSPACE.id, options.recipients ?? [owner, admin]);
  const email = new MemoryEmailTransport();
  const posts: Array<{ url: string; body: string }> = [];
  const references: string[] = [];
  const deps = memoryNotificationDeps({
    store,
    email,
    now: () => NOW,
    post: async (request) => {
      posts.push({ url: request.url, body: request.body });
      return options.post?.(request.url) ?? { ok: true, attempts: 1 };
    },
    logError: () => {
      const reference = `REF-TEST000${references.length}`;
      references.push(reference);
      return reference;
    },
  });
  return { store, email, posts, references, deps };
}

describe("runAlertDispatchJob: coalescing", () => {
  it("sends one email per owner and admin holding every alert of the tick, then marks them dispatched", async () => {
    const { store, email, deps } = setup();
    store.alerts.push(alert("10"), alert("25"));

    expect(await runAlertDispatchJob(job(), deps)).toEqual({ status: "succeeded" });

    expect(email.sent.map((message) => message.to)).toEqual(["owner@example.com", "admin@example.com"]);
    const [first] = email.sent;
    expect(first?.subject).toBe("2 alerts in Acme");
    expect(first?.text).toContain("Spend passed $10");
    expect(first?.text).toContain("Spend passed $25");
    expect(first?.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(first?.headers?.["List-Unsubscribe"]).toBe(
      `<https://stackdash.test/api/notifications/unsubscribe?token=token-${WORKSPACE.id}-u-owner>`,
    );
    // The email setting lives on alert settings, not the alerts inbox (#343).
    expect(first?.text).toContain(`Change your alert emails: https://stackdash.test/w/${WORKSPACE.slug}/alerts/settings#alert-emails`);
    expect(store.alerts.every((item) => item.dispatchedAt === NOW.toISOString())).toBe(true);
    expect(store.deliveries).toHaveLength(4);
  });

  it("does nothing when no alert is waiting", async () => {
    const { email, posts, deps } = setup();
    expect(await runAlertDispatchJob(job(), deps)).toEqual({ status: "succeeded" });
    expect(email.sent).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("marks alerts dispatched without needing a public origin when nobody receives them", async () => {
    const { store, email, posts, deps } = setup({ recipients: [{ ...owner, frequency: "off" }] });
    store.alerts.push(alert("10"));
    const withoutOrigin = {
      ...deps,
      origin: () => {
        throw new Error("NEXT_PUBLIC_SITE_URL is not set");
      },
    };
    expect(await runAlertDispatchJob(job(), withoutOrigin)).toEqual({ status: "succeeded" });
    expect(email.sent).toEqual([]);
    expect(posts).toEqual([]);
    expect(store.alerts[0]?.dispatchedAt).toBe(NOW.toISOString());
  });
});

describe("runAlertDispatchJob: once per alert per cycle", () => {
  it("never emails an alert twice, even when its job runs again", async () => {
    const { store, email, deps } = setup();
    store.alerts.push(alert("10"));
    await runAlertDispatchJob(job(), deps);
    // A re-run that still sees the alert as waiting (a crash before dispatched_at was written).
    for (const item of store.alerts) item.dispatchedAt = null;
    await runAlertDispatchJob(job({ id: "job-2" }), deps);
    expect(email.sent).toHaveLength(2);
  });

  it("emails a new alert of a later cycle again", async () => {
    const { store, email, deps } = setup({ recipients: [owner] });
    store.alerts.push(alert("10"));
    await runAlertDispatchJob(job(), deps);
    store.alerts.push(alert("10-next-cycle"));
    await runAlertDispatchJob(job({ id: "job-2" }), deps);
    expect(email.sent.map((message) => message.subject)).toEqual(["Alert in Acme: Spend passed $10", "Alert in Acme: Spend passed $10-next-cycle"]);
  });
});

describe("runAlertDispatchJob: sending", () => {
  it(`sends the targets of one job ${DELIVERY_CONCURRENCY} at a time, not one after another`, async () => {
    const { store, deps } = setup({ recipients: [] });
    const flight = { now: 0, most: 0 };
    // Every post waits until DELIVERY_CONCURRENCY of them are in flight: one at a time would never
    // open the gate, and an unbounded send would show more than the limit in flight.
    const gate = Promise.withResolvers<void>();
    const slowPost = async () => {
      flight.now += 1;
      flight.most = Math.max(flight.most, flight.now);
      if (flight.now === DELIVERY_CONCURRENCY) gate.resolve();
      await gate.promise;
      flight.now -= 1;
      return { ok: true as const, attempts: 1 };
    };
    for (const id of ["a", "b", "c", "d", "e", "f"]) store.destinations.push(channel(id));
    store.alerts.push(alert("10"));

    expect(await runAlertDispatchJob(job(), { ...deps, post: slowPost })).toEqual({ status: "succeeded" });

    expect(flight.most).toBe(DELIVERY_CONCURRENCY);
    expect(store.deliveries).toHaveLength(6);
    expect(store.destinations.every((destination) => destination.lastDeliveredAt === NOW.toISOString())).toBe(true);
  });

  it("gives each alert set its own idempotency key, the same on every retry and never longer than Resend allows", async () => {
    const ids = (last: string) => ["alert-0001", "alert-0002", "alert-0003", "alert-0004", "alert-0005", "alert-0006", last];
    const keyFor = async (alertIds: string[]) => {
      const { store, email, deps } = setup({ recipients: [owner] });
      store.alerts.push(...alertIds.map((id) => alert(id)));
      await runAlertDispatchJob(job(), deps);
      return email.sent[0]?.idempotencyKey;
    };

    const first = await keyFor(ids("alert-0007"));
    expect(first).toMatch(/^[^:]+:u-owner:[0-9a-f]{64}$/);
    expect(first?.length).toBeLessThanOrEqual(256);
    expect(await keyFor(ids("alert-0007"))).toBe(first);
    // Same first six alerts, a different seventh: a different message, so a different key.
    expect(await keyFor(ids("alert-0008"))).not.toBe(first);
  });
});

describe("runAlertDispatchJob: preferences", () => {
  it("stops delivery to a member who turned email off, and still emails the others", async () => {
    const { store, email, deps } = setup({ recipients: [{ ...owner, frequency: "off" }, admin] });
    store.alerts.push(alert("10"));
    await runAlertDispatchJob(job(), deps);
    expect(email.sent.map((message) => message.to)).toEqual(["admin@example.com"]);
  });

  it("sends only to channels when email is not set up on the instance", async () => {
    const { store, posts, deps } = setup();
    store.destinations.push(channel("a"));
    store.alerts.push(alert("10"));
    expect(await runAlertDispatchJob(job(), { ...deps, email: null })).toEqual({ status: "succeeded" });
    expect(posts).toHaveLength(1);
    expect(store.alerts[0]?.dispatchedAt).toBe(NOW.toISOString());
  });
});

describe("runAlertDispatchJob: failures", () => {
  it("records an email failure as a timeline event with its reference id and retries the job", async () => {
    const { store, email, references, deps } = setup({ recipients: [owner] });
    email.fail = new EmailSendError("Resend answered 503 service_unavailable", { retryable: true });
    store.alerts.push(alert("10"));

    const outcome = await runAlertDispatchJob(job(), deps);

    expect(outcome.status).toBe("retry");
    expect(store.alerts[0]?.dispatchedAt).toBeNull();
    expect(store.events).toHaveLength(1);
    const [event] = store.events;
    expect(event?.type_id).toBe(NOTIFICATION_FAILED_TYPE_ID);
    expect(event?.severity).toBe("warning");
    expect(event?.body).toContain(`Reference ${references[0]}.`);
    expect(event?.body).toContain("StackDash tries again shortly.");
    // Never the address: the timeline is visible to every member.
    expect(event?.body).not.toContain("owner@example.com");
  });

  it("writes one failure event per job and target however often the job is retried", async () => {
    const { store, email, deps } = setup({ recipients: [owner] });
    email.fail = new EmailSendError("Resend answered 503 service_unavailable", { retryable: true });
    store.alerts.push(alert("10"));
    await runAlertDispatchJob(job({ attempts: 1 }), deps);
    await runAlertDispatchJob(job({ attempts: 2 }), deps);
    expect(store.events).toHaveLength(1);
  });

  it("gives up on the last attempt: the alert is dispatched and the event says it will not be retried", async () => {
    const { store, email, deps } = setup({ recipients: [owner] });
    email.fail = new EmailSendError("Resend answered 503 service_unavailable", { retryable: true });
    store.alerts.push(alert("10"));

    expect(await runAlertDispatchJob(job({ attempts: 5, max_attempts: 5 }), deps)).toEqual({ status: "succeeded" });
    expect(store.alerts[0]?.dispatchedAt).toBe(NOW.toISOString());
    expect(store.events[0]?.body).toContain("StackDash will not try this message again.");
  });

  it("does not retry a permanent rejection", async () => {
    const { store, email, deps } = setup({ recipients: [owner] });
    email.fail = new EmailSendError("Resend answered 401 validation_error", { retryable: false });
    store.alerts.push(alert("10"));
    expect(await runAlertDispatchJob(job(), deps)).toEqual({ status: "succeeded" });
    expect(store.events[0]?.body).toContain("will not try this message again");
  });

  it("retries only the target that failed", async () => {
    const { store, email, posts, deps } = setup({
      recipients: [owner],
      post: () => ({ ok: false, attempts: 3, retryable: true, code: "http_503" }),
    });
    store.destinations.push(channel("a"));
    store.alerts.push(alert("10"));
    expect((await runAlertDispatchJob(job(), deps)).status).toBe("retry");
    await runAlertDispatchJob(job({ attempts: 2 }), deps);
    expect(email.sent).toHaveLength(1);
    expect(posts).toHaveLength(2);
  });
});

describe("runAlertDispatchJob: channel needs attention", () => {
  it(`marks a channel needs attention after ${DESTINATION_FAILURE_LIMIT} failed deliveries in a row and surfaces it on the timeline once`, async () => {
    const { store, deps } = setup({ recipients: [], post: () => ({ ok: false, attempts: 3, retryable: true, code: "http_503" }) });
    store.destinations.push(channel("a"));
    store.alerts.push(alert("10"));

    for (let attempt = 1; attempt <= DESTINATION_FAILURE_LIMIT + 1; attempt += 1) {
      await runAlertDispatchJob(job({ attempts: attempt }), deps);
    }

    const [destination] = store.destinations;
    expect(destination?.status).toBe("needs_attention");
    expect(destination?.lastErrorCode).toBe("http_503");
    const attention = store.events.filter((event) => event.type_id === CHANNEL_NEEDS_ATTENTION_TYPE_ID);
    expect(attention).toHaveLength(1);
    expect(attention[0]?.title).toBe("The channel #alerts-a needs attention");
    expect(attention[0]?.body).toContain("send a test message from alert settings");
    // A channel that needs attention gets nothing more, so the alert is no longer held back.
    expect(store.alerts[0]?.dispatchedAt).toBe(NOW.toISOString());
  });

  it("needs attention at once when the webhook is gone (404), without retrying the job", async () => {
    const { store, deps } = setup({ recipients: [], post: () => ({ ok: false, attempts: 1, retryable: false, code: "http_404" }) });
    store.destinations.push(channel("a"));
    store.alerts.push(alert("10"));
    expect(await runAlertDispatchJob(job(), deps)).toEqual({ status: "succeeded" });
    expect(store.destinations[0]?.status).toBe("needs_attention");
    expect(store.events.map((event) => event.type_id).sort()).toEqual([CHANNEL_NEEDS_ATTENTION_TYPE_ID, NOTIFICATION_FAILED_TYPE_ID].sort());
  });

  it("resets the failure count after a delivery", async () => {
    const { store, deps } = setup({ recipients: [] });
    store.destinations.push(channel("a", { consecutiveFailures: 2, lastErrorCode: "http_503" }));
    store.alerts.push(alert("10"));
    await runAlertDispatchJob(job(), deps);
    expect(store.destinations[0]).toMatchObject({ status: "active", consecutiveFailures: 0, lastErrorCode: null, lastDeliveredAt: NOW.toISOString() });
  });

  it("marks a channel whose sealed URL cannot be read as needing attention, without retrying", async () => {
    const { store, deps } = setup({ recipients: [] });
    store.destinations.push(channel("a", { secret: null }));
    store.alerts.push(alert("10"));
    expect(await runAlertDispatchJob(job(), deps)).toEqual({ status: "succeeded" });

    // Alert settings reads these: the channel shows as needing attention, with the reason.
    const [destination] = store.destinations;
    expect(destination).toMatchObject({
      status: "needs_attention",
      consecutiveFailures: 1,
      lastErrorCode: "secret_missing",
      lastErrorReference: "REF-TEST0000",
    });
    expect(store.events.map((event) => event.type_id).sort()).toEqual([CHANNEL_NEEDS_ATTENTION_TYPE_ID, NOTIFICATION_FAILED_TYPE_ID].sort());
    const attention = store.events.find((event) => event.type_id === CHANNEL_NEEDS_ATTENTION_TYPE_ID);
    expect(attention?.body).toContain("The webhook URL can no longer be read, so StackDash stopped posting alerts to #alerts-a.");
    expect(attention?.body).toContain("Remove the channel in alert settings and add it again with its URL.");
    expect(attention?.body).toContain("Reference REF-TEST0000.");
  });

  it("posts nothing more to an unreadable channel once it needs attention", async () => {
    const { store, deps } = setup({ recipients: [] });
    store.destinations.push(channel("a", { secret: null }));
    store.alerts.push(alert("10"));
    await runAlertDispatchJob(job(), deps);
    store.alerts.push(alert("11"));
    await runAlertDispatchJob(job({ id: "job-2" }), deps);

    // One failure, one needs attention event: the second dispatch skips the channel.
    expect(store.events.filter((event) => event.type_id === NOTIFICATION_FAILED_TYPE_ID)).toHaveLength(1);
    expect(store.events.filter((event) => event.type_id === CHANNEL_NEEDS_ATTENTION_TYPE_ID)).toHaveLength(1);
    expect(store.destinations[0]?.consecutiveFailures).toBe(1);
    expect(store.alerts.map((row) => row.dispatchedAt)).toEqual([NOW.toISOString(), NOW.toISOString()]);
  });
});

describe("runAlertDispatchJob: invalid jobs", () => {
  it("fails a job without a workspace", async () => {
    const { deps } = setup();
    expect(await runAlertDispatchJob(job({ workspace_id: null }), deps)).toEqual({ status: "failed", errorCode: "invalid_job", errorReference: null });
  });

  it("succeeds quietly for a workspace deleted since the job was queued", async () => {
    const { deps } = setup();
    expect(await runAlertDispatchJob(job({ workspace_id: "99999999-9999-4999-8999-999999999999" }), deps)).toEqual({ status: "succeeded" });
  });
});

describe("runDigestJob", () => {
  const daily: Recipient = { ...owner, frequency: "daily" };
  const weekly: Recipient = { ...admin, frequency: "weekly" };

  it("sends the daily digest to members who chose daily, with the day's new alerts", async () => {
    const { store, email, deps } = setup({ recipients: [daily, weekly] });
    store.alerts.push(alert("10", { triggeredAt: "2026-11-04T12:00:00.000Z", dispatchedAt: "2026-11-04T12:01:00.000Z" }));
    store.highlights = { deploys: 3, signups: 1, stars: 0, payments: 2 };

    expect(await runDigestJob(job({ kind: "digest", dedupe_key: digestJobKey(WORKSPACE.id, "2026-11-04") }), deps)).toEqual({ status: "succeeded" });

    expect(email.sent.map((message) => [message.to, message.subject])).toEqual([["owner@example.com", "Daily digest for Acme: 2026-11-04"]]);
    expect(email.sent[0]?.text).toContain("Spend passed $10");
    expect(email.sent[0]?.text).toContain("3 deployments, 1 signup, 0 star events, 2 payments");
  });

  it("adds the weekly digest on Monday for the week that ended", async () => {
    const { email, deps } = setup({ recipients: [daily, weekly] });
    await runDigestJob(job({ kind: "digest", dedupe_key: digestJobKey(WORKSPACE.id, "2026-11-08") }), deps);
    expect(email.sent.map((message) => [message.to, message.subject])).toEqual([
      ["owner@example.com", "Daily digest for Acme: 2026-11-08"],
      ["admin@example.com", "Weekly digest for Acme: 2026-11-02 to 2026-11-08"],
    ]);
  });

  it("posts a daily channel and a weekly channel once each on a Monday, each with its own failure count", async () => {
    const { store, posts, deps } = setup({ recipients: [], post: () => ({ ok: false, attempts: 3, retryable: true, code: "http_503" }) });
    store.destinations.push(channel("daily", { digest: "daily" }), channel("weekly", { digest: "weekly" }));
    await runDigestJob(job({ kind: "digest", dedupe_key: digestJobKey(WORKSPACE.id, "2026-11-08") }), deps);
    expect(posts.map((post) => post.url)).toEqual(["https://hooks.slack.com/services/T1/B1/daily", "https://hooks.slack.com/services/T1/B1/weekly"]);
    expect(store.destinations.map((destination) => destination.consecutiveFailures)).toEqual([1, 1]);
  });

  it("sends a digest once, however often its job runs", async () => {
    const { store, email, deps } = setup({ recipients: [daily] });
    store.destinations.push(channel("a", { digest: "daily" }));
    const digestJob = job({ kind: "digest", dedupe_key: digestJobKey(WORKSPACE.id, "2026-11-04") });
    await runDigestJob(digestJob, deps);
    await runDigestJob(digestJob, deps);
    expect(email.sent).toHaveLength(1);
    expect(store.deliveries).toHaveLength(2);
  });

  it("sends nothing to members set to immediate or off", async () => {
    const { email, deps } = setup({ recipients: [owner, { ...admin, frequency: "off" }] });
    await runDigestJob(job({ kind: "digest", dedupe_key: digestJobKey(WORKSPACE.id, "2026-11-04") }), deps);
    expect(email.sent).toEqual([]);
  });

  it("fails a job whose key names no date", async () => {
    const { deps } = setup();
    expect(await runDigestJob(job({ kind: "digest", dedupe_key: "digest:broken" }), deps)).toEqual({
      status: "failed",
      errorCode: "invalid_job",
      errorReference: null,
    });
  });
});

describe("digestFigures", () => {
  it("is empty for a workspace with nothing synced", () => {
    const empty = { connections: [], accounts: [], projects: [], snapshots: [], projectedSpend: declaredProjectedSpend, now: NOW };
    expect(digestFigures(empty)).toEqual({ allowances: [], spend: [] });
  });

  it("never reports a provider's declared projection as spend (#223)", () => {
    const november = { period_start: "2026-11-01T00:00:00.000Z", period_end: "2026-12-01T00:00:00.000Z" };
    const money = (metricKey: string, kind: SnapshotInput["kind"], amountMinor: number): SnapshotInput => ({
      connection_id: "c1",
      external_account_id: "a1",
      metric_key: metricKey,
      kind,
      label: metricKey,
      snapshot_date: "2026-11-05",
      value: null,
      unit: null,
      amount_minor: amountMinor,
      currency: "USD",
      ...november,
      point_at: null,
      resets_at: november.period_end,
      retrieved_at: "2026-11-05T08:30:00.000Z",
      provenance_source: kind === "estimated_spend" ? "derived" : "provider_api",
      pricing_source: null,
    });
    const posthog: ConnectionInput = {
      id: "c1",
      provider: "posthog",
      display_name: "PostHog",
      status: "active",
      last_synced_at: null,
      last_sync_requested_at: null,
      poll_interval_seconds: 3600,
      granted_scopes: [],
    };
    const input = (snapshots: SnapshotInput[]): DashboardInput => ({
      connections: [posthog],
      accounts: [{ id: "a1", connection_id: "c1", display_name: "Example organization", project_id: null }],
      projects: [],
      snapshots,
      projectedSpend: declaredProjectedSpend,
      now: NOW,
    });
    const projection = money("posthog.spend.projected", "estimated_spend", 2_986);
    // Beside spend so far, only the spend so far; alone, no spend at all.
    const period = { start: november.period_start, end: november.period_end };
    expect(digestFigures(input([money("posthog.spend.current", "verified_spend", 0), projection])).spend).toEqual([
      { connectionName: "PostHog", currency: "USD", verifiedMinor: 0, estimatedMinor: null, period },
    ]);
    expect(digestFigures(input([projection])).spend).toEqual([]);
  });
});
