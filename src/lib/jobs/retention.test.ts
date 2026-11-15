import { describe, expect, it, vi } from "vitest";

import { MemoryJobStore, type MemorySnapshot } from "./memory-store";
import { RETENTION_BATCH_SIZE, retentionCutoffs, runRetention, subtractUtcMonths, WEBHOOK_DELIVERY_RETENTION_DAYS } from "./retention";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-10-31T12:00:00.000Z");

function snapshot(date: string): MemorySnapshot {
  return {
    id: crypto.randomUUID(),
    workspace_id: WORKSPACE_ID,
    connection_id: "c",
    external_account_id: "a",
    metric_key: `fake.metric.d${date.replaceAll("-", "")}`,
    kind: "usage",
    label: "Usage",
    snapshot_date: date,
    value: 1,
    unit: "requests",
    point_at: `${date}T00:00:00.000Z`,
    retrieved_at: `${date}T00:00:00.000Z`,
    provenance_source: "provider_api",
  };
}

function event(occurredAt: string, key: string) {
  return {
    id: crypto.randomUUID(),
    workspace_id: WORKSPACE_ID,
    type_id: "fake.signup",
    severity: "info" as const,
    title: "New signup",
    occurred_at: occurredAt,
    dedupe_key: key,
  };
}

describe("subtractUtcMonths", () => {
  it("keeps the day and time of day", () => {
    expect(subtractUtcMonths(NOW, 13).toISOString()).toBe("2025-09-30T12:00:00.000Z");
  });

  it("clamps to the last day of a shorter month", () => {
    expect(subtractUtcMonths(new Date("2027-03-31T00:00:00.000Z"), 13).toISOString()).toBe("2026-02-28T00:00:00.000Z");
    expect(subtractUtcMonths(new Date("2029-03-31T00:00:00.000Z"), 13).toISOString()).toBe("2028-02-29T00:00:00.000Z");
  });
});

describe("retention (#37)", () => {
  it("keeps data exactly 13 months old and deletes anything older", async () => {
    const store = new MemoryJobStore(() => NOW);
    store.snapshots.push(snapshot("2025-09-30"), snapshot("2025-09-29"), snapshot("2026-10-31"));
    store.events.push(
      event("2025-09-30T12:00:00.000Z", "exactly-13-months"),
      event("2025-09-30T11:59:59.999Z", "older"),
    );

    const result = await runRetention(store, NOW, () => true);

    expect(store.snapshots.map((row) => row.snapshot_date).sort()).toEqual(["2025-09-30", "2026-10-31"]);
    expect(store.events.map((row) => row.dedupe_key)).toEqual(["exactly-13-months"]);
    expect(result).toEqual({
      oauthStates: 0,
      snapshots: 1,
      events: 1,
      jobs: 0,
      rateLimitCounters: 0,
      metricViews: 0,
      deliveries: 0,
      webhookDeliveries: 0,
      complete: true,
    });
  });

  it("deletes finished sync jobs older than 30 days and never queued or running ones", async () => {
    const store = new MemoryJobStore(() => NOW);
    const cutoff = retentionCutoffs(NOW).jobsBefore.getTime();
    const at = (ms: number) => new Date(cutoff + ms).toISOString();
    store.jobs.push(
      store.newJob({ workspace_id: null, connection_id: null, kind: "retention", status: "succeeded", created_at: at(0), dedupe_key: "kept-exact" }),
      store.newJob({ workspace_id: null, connection_id: null, kind: "retention", status: "failed", created_at: at(-1), dedupe_key: "old-failed" }),
      store.newJob({ workspace_id: null, connection_id: null, kind: "retention", status: "queued", created_at: at(-1), dedupe_key: "old-queued" }),
    );

    await runRetention(store, NOW, () => true);
    expect(store.jobs.map((job) => job.dedupe_key).sort()).toEqual(["kept-exact", "old-queued"]);
  });

  it("deletes digest delivery records older than 30 days and never alert delivery records (#152)", async () => {
    const store = new MemoryJobStore(() => NOW);
    const cutoff = retentionCutoffs(NOW).jobsBefore.getTime();
    const at = (ms: number) => new Date(cutoff + ms).toISOString();
    store.notificationDeliveries.push(
      { id: "digest-kept-exact", triggered_alert_id: null, delivered_at: at(0) },
      { id: "digest-old", triggered_alert_id: null, delivered_at: at(-1) },
      { id: "alert-old", triggered_alert_id: "alert-1", delivered_at: at(-86_400_000) },
    );

    const result = await runRetention(store, NOW, () => true);
    expect(store.notificationDeliveries.map((row) => row.id).sort()).toEqual(["alert-old", "digest-kept-exact"]);
    expect(result.deliveries).toBe(1);
  });

  it("deletes webhook delivery records received more than 30 days ago with their jobs, and keeps one received exactly 30 days ago (#28)", async () => {
    const cutoff = retentionCutoffs(NOW).webhookDeliveriesBefore;
    let clock = new Date(cutoff.getTime() - 1);
    const store = new MemoryJobStore(() => clock);
    // An ignored delivery queues no job, so this one is an uninstall: the purge must take its job too.
    const outcome = { kind: "uninstalled", externalAccountId: "fake-acct-1", occurredAt: cutoff } as const;
    await store.recordWebhookDelivery({ provider: "fake", deliveryId: "old", endpointId: null, outcome });
    clock = cutoff;
    await store.recordWebhookDelivery({ provider: "fake", deliveryId: "kept-exact", endpointId: null, outcome });

    const result = await runRetention(store, NOW, () => true);

    expect(store.webhookDeliveries.map((row) => row.delivery_id)).toEqual(["kept-exact"]);
    expect(store.jobs.map((job) => job.webhook_delivery_id)).toEqual(store.webhookDeliveries.map((row) => row.id));
    expect(result.webhookDeliveries).toBe(1);
  });

  it.each([
    { name: "a retry 3 days late, the end of Stripe's retry window", daysLate: 3, repeat: true },
    { name: "one day past the retention window", daysLate: WEBHOOK_DELIVERY_RETENTION_DAYS + 1, repeat: false },
  ])("recognizes a provider retry after retention as a repeat only inside the window (boundary: $name)", async ({ daysLate, repeat }) => {
    let clock = new Date(NOW.getTime() - daysLate * 86_400_000);
    const store = new MemoryJobStore(() => clock);
    const delivery = { provider: "fake", deliveryId: "evt_1", endpointId: null, outcome: { kind: "ignored", reason: "test" } } as const;
    await store.recordWebhookDelivery(delivery);

    clock = NOW;
    await runRetention(store, NOW, () => true);

    expect(await store.recordWebhookDelivery(delivery)).toBe(!repeat);
  });

  it("deletes OAuth states once expired and keeps flows still in progress", async () => {
    const store = new MemoryJobStore(() => NOW);
    const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    store.oauthStates.push(
      { state: "abandoned", workspace_id: WORKSPACE_ID, expires_at: at(-60_000) },
      { state: "expires-now", workspace_id: WORKSPACE_ID, expires_at: at(0) },
      { state: "in-progress", workspace_id: WORKSPACE_ID, expires_at: at(1) },
    );

    const result = await runRetention(store, NOW, () => true);

    expect(store.oauthStates.map((row) => row.state)).toEqual(["in-progress"]);
    expect(result.oauthStates).toBe(2);
  });

  it("deletes in batches of 1000 and is safe to re-run", async () => {
    const store = new MemoryJobStore(() => NOW);
    for (let i = 0; i < 2 * RETENTION_BATCH_SIZE + 5; i += 1) {
      store.snapshots.push({ ...snapshot("2024-01-01"), metric_key: `fake.metric.n${i}` });
    }
    const purge = vi.spyOn(store, "purgeSnapshots");

    const first = await runRetention(store, NOW, () => true);
    expect(first.snapshots).toBe(2 * RETENTION_BATCH_SIZE + 5);
    expect(purge).toHaveBeenCalledTimes(3);
    expect(purge.mock.calls.every(([, limit]) => limit === RETENTION_BATCH_SIZE)).toBe(true);

    const second = await runRetention(store, NOW, () => true);
    expect(second).toEqual({
      oauthStates: 0,
      snapshots: 0,
      events: 0,
      jobs: 0,
      rateLimitCounters: 0,
      metricViews: 0,
      deliveries: 0,
      webhookDeliveries: 0,
      complete: true,
    });
  });

  it("deletes rate limit counters older than a day and keeps the last day's (#149)", async () => {
    const store = new MemoryJobStore(() => NOW);
    const cutoff = retentionCutoffs(NOW).rateLimitCountersBefore.getTime();
    const at = (ms: number) => new Date(cutoff + ms).toISOString();
    store.rateLimitCounters.push(
      { ip_hash: "a".repeat(64), window_start: at(-60_000), count: 3 },
      { ip_hash: "b".repeat(64), window_start: at(0), count: 1 },
    );

    const result = await runRetention(store, NOW, () => true);

    expect(store.rateLimitCounters.map((row) => row.ip_hash)).toEqual(["b".repeat(64)]);
    expect(result.rateLimitCounters).toBe(1);
  });

  it("keeps metric view counts exactly 13 months old and deletes older days (#149)", async () => {
    const store = new MemoryJobStore(() => NOW);
    const view = (viewDate: string) => ({
      workspace_id: WORKSPACE_ID,
      project_id: "22222222-2222-4222-8222-222222222222",
      metric_id: "github-stars" as const,
      surface: "badge" as const,
      view_date: viewDate,
      views: 4,
    });
    store.metricViews.push(view("2025-09-29"), view("2025-09-30"));

    const result = await runRetention(store, NOW, () => true);

    expect(store.metricViews.map((row) => row.view_date)).toEqual(["2025-09-30"]);
    expect(result.metricViews).toBe(1);
  });

  it("stops between batches when the time budget runs out and reports the run incomplete", async () => {
    const store = new MemoryJobStore(() => NOW);
    store.snapshots.push(snapshot("2024-01-01"));
    const result = await runRetention(store, NOW, () => false);
    expect(result.complete).toBe(false);
    expect(store.snapshots).toHaveLength(1);
  });
});
