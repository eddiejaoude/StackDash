import { describe, expect, it } from "vitest";

import { fakeAdapter } from "@/lib/adapters/fake";
import { Secret, type WebhookOutcome } from "@/lib/adapters/types";
import type { Logger } from "@/lib/log/logger";
import { memoryNotificationDeps } from "@/lib/notifications/memory-store";

import { MemoryJobStore } from "./memory-store";
import { CRON_SECRET_MIN_LENGTH, isAuthorizedCronRequest, runTick, TICK_CLAIM_LIMIT, WEBHOOK_TICK_CLAIM_LIMIT } from "./runner";
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
