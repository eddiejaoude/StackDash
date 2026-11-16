import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "@/lib/adapters/events";
import { fakeAdapter } from "@/lib/adapters/fake";
import { Secret, type WebhookOutcome } from "@/lib/adapters/types";
import type { LogFields, Logger } from "@/lib/log/logger";
import { memoryNotificationDeps } from "@/lib/notifications/memory-store";

import { MemoryJobStore } from "./memory-store";
import {
  CRON_SECRET_MIN_LENGTH,
  isAuthorizedCronRequest,
  runTick,
  TICK_CLAIM_LIMIT,
  WEBHOOK_TICK_BUDGET_MS,
  WEBHOOK_TICK_CLAIM_LIMIT,
} from "./runner";
import { retentionDedupeKey } from "./schedule";
import type { ConnectionKey } from "./store";
import type { SyncDeps } from "./sync-connection";

const SECRET = "a".repeat(64);
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

describe("isAuthorizedCronRequest (tick auth)", () => {
  it("accepts the correct bearer secret", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it("rejects a missing Authorization header", () => {
    expect(isAuthorizedCronRequest(null, SECRET)).toBe(false);
  });

  it("rejects a value of the wrong length without comparing", () => {
    expect(isAuthorizedCronRequest(`Bearer ${SECRET}x`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest("Bearer", SECRET)).toBe(false);
  });

  it("rejects a wrong value of the same length", () => {
    expect(isAuthorizedCronRequest(`Bearer ${"b".repeat(64)}`, SECRET)).toBe(false);
    expect(isAuthorizedCronRequest(`bearer ${SECRET}`, SECRET)).toBe(false);
  });

  it("rejects everything when CRON_SECRET is unset, empty, or shorter than 32 characters", () => {
    const short = "s".repeat(CRON_SECRET_MIN_LENGTH - 1);
    expect(isAuthorizedCronRequest("Bearer ", undefined)).toBe(false);
    expect(isAuthorizedCronRequest("Bearer ", "")).toBe(false);
    expect(isAuthorizedCronRequest(`Bearer ${short}`, short)).toBe(false);
    const exact = "s".repeat(CRON_SECRET_MIN_LENGTH);
    expect(isAuthorizedCronRequest(`Bearer ${exact}`, exact)).toBe(true);
  });
});

function deps(store: MemoryJobStore, now: () => Date): SyncDeps {
  return {
    store,
    getAdapter: () => fakeAdapter,
    loadOAuthClient: () => ({ clientId: "id", clientSecret: new Secret("secret"), extra: {} }),
    createOAuthContext: (client) => ({ client, fetch: () => Promise.reject(new Error("offline")), now, timeoutMs: 1000, logger: silent }),
    now,
    random: () => 0.5,
    logError: () => "REF-TEST0000",
    log: silent,
    evaluateAlerts: async () => ({ triggered: 0 }),
    evaluateAchievements: async () => 0,
    notifications: () => memoryNotificationDeps(),
  };
}

/** Schedules no summaries, digests, or retention, so a tick claims only the jobs a test queues. */
class QueuedOnlyStore extends MemoryJobStore {
  override async enqueueDailySummaries(): Promise<number> {
    return 0;
  }

  override async enqueueDigests(): Promise<number> {
    return 0;
  }

  override async enqueueRetention(): Promise<boolean> {
    return false;
  }
}

/** Records a delivery for an account no workspace includes, as the route does: one queued webhook job. */
async function deliver(store: MemoryJobStore, deliveryId: string): Promise<void> {
  const outcome: WebhookOutcome = { kind: "events", externalAccountId: "fake-acct-9", events: [] };
  expect(await store.recordWebhookDelivery({ provider: "fake", deliveryId, endpointId: null, outcome })).toBe(true);
}

/** A connection including fake-acct-1, not due to sync for an hour, so only webhook jobs evaluate it. */
function connectAccount(store: MemoryJobStore, workspaceId: string, now: Date): string {
  const connection = store.addConnection({
    workspace_id: workspaceId,
    provider: "fake",
    next_sync_at: new Date(now.getTime() + 3_600_000).toISOString(),
  });
  store.addAccount({ workspace_id: workspaceId, connection_id: connection.id, external_id: "fake-acct-1" });
  return connection.id;
}

/** Records a delivery of one new deployment for fake-acct-1, distinct per `day`. */
async function deliverDeployment(store: MemoryJobStore, day: number): Promise<void> {
  const event: ActivityEvent = {
    typeId: "fake.deploy.succeeded",
    occurredAt: new Date(Date.UTC(2026, 9, day, 12)),
    severity: "success",
    title: "Deployment succeeded",
    externalAccountId: "fake-acct-1",
    dedupeKey: `fake.deploy.succeeded:fake-acct-1:2026-10-${String(day).padStart(2, "0")}`,
  };
  const outcome: WebhookOutcome = { kind: "events", externalAccountId: "fake-acct-1", events: [event] };
  expect(await store.recordWebhookDelivery({ provider: "fake", deliveryId: `delivery-${day}`, endpointId: null, outcome })).toBe(true);
}

describe("runTick", () => {
  it("queues the retention job once per UTC day", async () => {
    let clock = new Date("2026-10-31T23:59:00.000Z");
    const store = new MemoryJobStore(() => clock);
    const tickDeps = deps(store, () => clock);

    expect((await runTick(tickDeps)).retentionQueued).toBe(true);
    expect((await runTick(tickDeps)).retentionQueued).toBe(false);
    clock = new Date("2026-11-01T00:00:00.000Z");
    expect((await runTick(tickDeps)).retentionQueued).toBe(true);
    expect(store.jobs.map((job) => job.dedupe_key)).toEqual([
      retentionDedupeKey(new Date("2026-10-31T00:00:00.000Z")),
      "retention:2026-11-01",
    ]);
    expect(store.jobs.every((job) => job.status === "succeeded")).toBe(true);
  });

  it("claims at most the limit and releases jobs it has no time to start, without spending an attempt", async () => {
    let clock = new Date("2026-10-14T10:00:00.000Z");
    // Each job takes 30 s of clock time, so the 50 s budget starts two and releases the rest.
    class SlowStore extends QueuedOnlyStore {
      override async getConnection(key: ConnectionKey) {
        clock = new Date(clock.getTime() + 30_000);
        return super.getConnection(key);
      }
    }
    const store = new SlowStore(() => clock);
    for (let i = 0; i < 12; i += 1) {
      store.addConnection({ workspace_id: "w", provider: "fake", status: "needs_attention" });
    }
    const connectionIds = store.connections.map((connection) => connection.id);
    for (const id of connectionIds) await store.enqueueSync({ workspaceId: "w", connectionId: id });
    const tickDeps = deps(store, () => clock);

    const result = await runTick(tickDeps, { concurrency: 1 });
    expect(result.claimed).toBe(TICK_CLAIM_LIMIT);
    expect(result.succeeded).toBe(2);
    expect(result.released).toBe(8);
    const queued = store.jobs.filter((job) => job.status === "queued");
    expect(queued).toHaveLength(10);
    expect(queued.every((job) => job.attempts === 0)).toBe(true);
  });

  it("starts every webhook job before any other kind, even when the other job was queued first", async () => {
    let clock = new Date("2026-10-14T10:00:00.000Z");
    const started: string[] = [];
    class OrderStore extends QueuedOnlyStore {
      override async getConnection(key: ConnectionKey) {
        started.push("sync");
        return super.getConnection(key);
      }

      override async loadWebhookDelivery(deliveryRowId: string) {
        started.push("webhook");
        return super.loadWebhookDelivery(deliveryRowId);
      }
    }
    const store = new OrderStore(() => clock);
    const connection = store.addConnection({ workspace_id: "w", provider: "fake", status: "needs_attention" });
    await store.enqueueSync({ workspaceId: "w", connectionId: connection.id });
    clock = new Date(clock.getTime() + 60_000);
    await deliver(store, "delivery-1");

    const result = await runTick(deps(store, () => clock), { concurrency: 1 });

    expect(started).toEqual(["webhook", "sync"]);
    expect(result).toMatchObject({ claimed: 2, succeeded: 2 });
  });

  it("still runs other jobs when more webhook jobs are due than their allowance (boundary: allowance + 1)", async () => {
    let clock = new Date("2026-10-14T10:00:00.000Z");
    const store = new QueuedOnlyStore(() => clock);
    const connection = store.addConnection({ workspace_id: "w", provider: "fake", status: "needs_attention" });
    for (let i = 0; i <= WEBHOOK_TICK_CLAIM_LIMIT; i += 1) await deliver(store, `delivery-${i}`);
    // Queued after every delivery, so an order by run_after alone would also put it last.
    clock = new Date(clock.getTime() + 60_000);
    await store.enqueueSync({ workspaceId: "w", connectionId: connection.id });

    const result = await runTick(deps(store, () => clock));

    expect(result).toMatchObject({ claimed: WEBHOOK_TICK_CLAIM_LIMIT + 1, succeeded: WEBHOOK_TICK_CLAIM_LIMIT + 1 });
    expect(store.jobs.find((job) => job.kind === "sync")?.status).toBe("succeeded");
    expect(store.jobs.filter((job) => job.kind === "webhook" && job.status === "queued")).toHaveLength(1);
  });

  it("releases webhook jobs once their share of the budget is spent and still runs the other kinds (boundary: webhook jobs slower than their share)", async () => {
    let clock = new Date("2026-10-14T10:00:00.000Z");
    // Each webhook job takes longer than the whole webhook share.
    class SlowWebhookStore extends QueuedOnlyStore {
      override async loadWebhookDelivery(deliveryRowId: string) {
        clock = new Date(clock.getTime() + WEBHOOK_TICK_BUDGET_MS + 1);
        return super.loadWebhookDelivery(deliveryRowId);
      }
    }
    const store = new SlowWebhookStore(() => clock);
    const connection = store.addConnection({ workspace_id: "w", provider: "fake", status: "needs_attention" });
    for (let i = 0; i < 5; i += 1) await deliver(store, `delivery-${i}`);
    await store.enqueueSync({ workspaceId: "w", connectionId: connection.id });

    const result = await runTick(deps(store, () => clock));

    expect(result).toMatchObject({ claimed: 6, succeeded: 2, released: 4 });
    expect(store.jobs.find((job) => job.kind === "sync")?.status).toBe("succeeded");
    const released = store.jobs.filter((job) => job.kind === "webhook" && job.status === "queued");
    expect(released).toHaveLength(4);
    expect(released.every((job) => job.attempts === 0)).toBe(true);
  });

  it("runs every webhook job that starts within their share of the budget", async () => {
    let clock = new Date("2026-10-14T10:00:00.000Z");
    // A full claim whose jobs each take just under an even part of the share.
    class SteadyWebhookStore extends QueuedOnlyStore {
      override async loadWebhookDelivery(deliveryRowId: string) {
        clock = new Date(clock.getTime() + WEBHOOK_TICK_BUDGET_MS / WEBHOOK_TICK_CLAIM_LIMIT - 1);
        return super.loadWebhookDelivery(deliveryRowId);
      }
    }
    const store = new SteadyWebhookStore(() => clock);
    const connection = store.addConnection({ workspace_id: "w", provider: "fake", status: "needs_attention" });
    for (let i = 0; i < WEBHOOK_TICK_CLAIM_LIMIT; i += 1) await deliver(store, `delivery-${i}`);
    await store.enqueueSync({ workspaceId: "w", connectionId: connection.id });

    const result = await runTick(deps(store, () => clock));

    expect(result).toMatchObject({ claimed: WEBHOOK_TICK_CLAIM_LIMIT + 1, succeeded: WEBHOOK_TICK_CLAIM_LIMIT + 1, released: 0 });
  });

  it.each([
    ["evaluates one connection once for every delivery to it", 1],
    ["evaluates each connection once (boundary: two connections)", 2],
  ])("%s in a tick", async (_case, connectionCount) => {
    const clock = new Date("2026-10-14T10:00:00.000Z");
    const store = new QueuedOnlyStore(() => clock);
    const connectionIds = Array.from({ length: connectionCount }, (_, i) => connectAccount(store, `w${i}`, clock));
    for (let day = 1; day <= 5; day += 1) await deliverDeployment(store, day);
    const evaluated: ConnectionKey[] = [];
    const tickDeps: SyncDeps = {
      ...deps(store, () => clock),
      evaluateAchievements: async (workspaceId, connectionId) => {
        evaluated.push({ workspaceId, connectionId });
        return 0;
      },
    };

    const result = await runTick(tickDeps);

    expect(result).toMatchObject({ claimed: 5, succeeded: 5 });
    expect(store.events).toHaveLength(5 * connectionCount);
    expect(evaluated.map((key) => key.connectionId).sort()).toEqual([...connectionIds].sort());
  });

  it("leaves achievements to the next sync when the webhook share is spent before they are evaluated (boundary)", async () => {
    let clock = new Date("2026-10-14T10:00:00.000Z");
    class SlowWebhookStore extends QueuedOnlyStore {
      override async loadWebhookDelivery(deliveryRowId: string) {
        clock = new Date(clock.getTime() + WEBHOOK_TICK_BUDGET_MS);
        return super.loadWebhookDelivery(deliveryRowId);
      }
    }
    const store = new SlowWebhookStore(() => clock);
    connectAccount(store, "w", clock);
    await deliverDeployment(store, 1);
    let evaluations = 0;
    const infos: Array<{ event: string; fields: LogFields | undefined }> = [];
    const tickDeps: SyncDeps = {
      ...deps(store, () => clock),
      log: { ...silent, info: (event, fields) => infos.push({ event, fields }) },
      evaluateAchievements: async () => {
        evaluations += 1;
        return 0;
      },
    };

    const result = await runTick(tickDeps);

    expect(result).toMatchObject({ claimed: 1, succeeded: 1 });
    expect(store.events).toHaveLength(1);
    expect(evaluations).toBe(0);
    expect(infos).toContainEqual({ event: "webhook.achievements_deferred", fields: { connections: 1 } });
  });

  it("keeps webhook jobs succeeded when an evaluation fails, and logs it", async () => {
    const clock = new Date("2026-10-14T10:00:00.000Z");
    const store = new QueuedOnlyStore(() => clock);
    const connectionId = connectAccount(store, "w", clock);
    await deliverDeployment(store, 1);
    const errors: Array<{ event: string; fields: LogFields | undefined }> = [];
    const tickDeps: SyncDeps = {
      ...deps(store, () => clock),
      logError: (event, _error, fields) => {
        errors.push({ event, fields });
        return "REF-TEST0000";
      },
      evaluateAchievements: () => Promise.reject(new Error("database unavailable")),
    };

    const result = await runTick(tickDeps);

    expect(result).toMatchObject({ claimed: 1, succeeded: 1, failed: 0 });
    expect(store.jobs.find((job) => job.kind === "webhook")?.status).toBe("succeeded");
    expect(errors).toEqual([{ event: "webhook.achievement_evaluation_failed", fields: { workspaceId: "w", connectionId } }]);
  });

  it("returns counts only", async () => {
    const clock = new Date("2026-10-14T10:00:00.000Z");
    const store = new MemoryJobStore(() => clock);
    const result = await runTick(deps(store, () => clock));
    expect(Object.keys(result).sort()).toEqual(
      [
        "claimed",
        "digestsQueued",
        "dispatchesQueued",
        "failed",
        "released",
        "retentionQueued",
        "retried",
        "succeeded",
        "summariesQueued",
        "syncsQueued",
      ].sort(),
    );
  });
});
