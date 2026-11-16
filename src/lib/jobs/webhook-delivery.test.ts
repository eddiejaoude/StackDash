import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "@/lib/adapters/events";
import { fakeAdapter } from "@/lib/adapters/fake";
import { Secret, type OAuthCredential, type WebhookOutcome } from "@/lib/adapters/types";
import type { LogFields, Logger } from "@/lib/log/logger";
import { memoryNotificationDeps } from "@/lib/notifications/memory-store";

import { MemoryJobStore, type MemoryConnection, type MemoryJob } from "./memory-store";
import { runTick } from "./runner";
import type { ConnectionKey } from "./store";
import { SYNC_FAILED_TYPE_ID, type SyncDeps } from "./sync-connection";
import { runWebhookJob } from "./webhook-delivery";

const WORKSPACE_A = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_B = "22222222-2222-4222-8222-222222222222";
const START = "2026-11-15T13:00:00.000Z";
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };

const credential: OAuthCredential = {
  accessToken: new Secret("at-ok"),
  refreshToken: new Secret("rt-ok"),
  scopes: ["usage:read"],
  tokenType: "bearer",
  metadata: { mode: "ok" },
};

// What the fake adapter's webhook and sync both produce for today's deployment of fake-acct-1.
const deployment: ActivityEvent = {
  typeId: "fake.deploy.succeeded",
  occurredAt: new Date("2026-11-15T12:00:00.000Z"),
  severity: "success",
  title: "Deployment succeeded",
  body: "Daily deployment for 2026-11-15.",
  externalAccountId: "fake-acct-1",
  dedupeKey: "fake.deploy.succeeded:fake-acct-1:2026-11-15",
};
const DEPLOYMENT_ROW_KEY = `fake:${deployment.dedupeKey}`;

function setup() {
  let clock = new Date(START);
  const now = () => clock;
  const store = new MemoryJobStore(now);
  const infos: Array<{ event: string; fields: LogFields | undefined }> = [];
  // The connections a job stored a new event for, which the tick evaluates once its webhook jobs are done.
  const delivered = new Map<string, ConnectionKey>();
  const deps: SyncDeps = {
    store,
    getAdapter: () => fakeAdapter,
    loadOAuthClient: () => ({ clientId: "fake-client", clientSecret: new Secret("fake-secret"), extra: {} }),
    createOAuthContext: (client) => ({ client, fetch: () => Promise.reject(new Error("no network in tests")), now, timeoutMs: 1000, logger: silent }),
    now,
    random: () => 0.5,
    logError: () => "REF-TEST0000",
    log: { ...silent, info: (event, fields) => infos.push({ event, fields }) },
    evaluateAlerts: async () => ({ triggered: 0 }),
    evaluateAchievements: async () => 0,
    notifications: () => memoryNotificationDeps(),
  };

  /** A fake connection including fake-acct-1, not due to sync for an hour, so a tick runs only the webhook job. */
  function connect(workspaceId: string, fields: Partial<MemoryConnection> = {}): MemoryConnection {
    const connection = store.addConnection({
      workspace_id: workspaceId,
      provider: "fake",
      display_name: "Example provider (Example team)",
      authorized_account_label: "Example team",
      next_sync_at: new Date(clock.getTime() + 3_600_000).toISOString(),
      ...fields,
    });
    store.addAccount({ workspace_id: workspaceId, connection_id: connection.id, external_id: "fake-acct-1" });
    store.credentials.set(connection.id, credential);
    return connection;
  }

  /** Records a delivery as the route does and returns its queued job. */
  async function deliver(outcome: WebhookOutcome, deliveryId = "delivery-1"): Promise<MemoryJob> {
    expect(await store.recordWebhookDelivery({ provider: "fake", deliveryId, endpointId: null, outcome })).toBe(true);
    const job = store.jobs.find((candidate) => candidate.kind === "webhook" && candidate.status === "queued");
    if (job === undefined) throw new Error("No webhook job was queued");
    return job;
  }

  const eventsIn = (workspaceId: string) => store.events.filter((event) => event.workspace_id === workspaceId);
  return {
    store,
    deps,
    infos,
    delivered,
    connect,
    deliver,
    eventsIn,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
  };
}

const events = (list: ActivityEvent[]): WebhookOutcome => ({ kind: "events", externalAccountId: "fake-acct-1", events: list });

describe("runWebhookJob", () => {
  it("writes a delivery's events into every target workspace once, in one insert", async () => {
    const harness = setup();
    // Two connections in workspace A include the same account: one row there, not two.
    const first = harness.connect(WORKSPACE_A);
    const second = harness.connect(WORKSPACE_A);
    const other = harness.connect(WORKSPACE_B);
    let inserts = 0;
    const insertEvents = harness.store.insertEvents.bind(harness.store);
    harness.store.insertEvents = (rows) => {
      inserts += 1;
      return insertEvents(rows);
    };
    const job = await harness.deliver(events([deployment]));

    expect(await runWebhookJob(job, harness.deps, harness.delivered)).toEqual({ status: "succeeded" });

    expect(inserts).toBe(1);
    expect(harness.eventsIn(WORKSPACE_A)).toHaveLength(1);
    expect(harness.eventsIn(WORKSPACE_B)).toEqual([
      expect.objectContaining({
        connection_id: other.id,
        provider: "fake",
        type_id: "fake.deploy.succeeded",
        title: "Deployment succeeded",
        occurred_at: "2026-11-15T12:00:00.000Z",
        dedupe_key: DEPLOYMENT_ROW_KEY,
      }),
    ]);
    expect([...harness.delivered.values()]).toEqual(
      expect.arrayContaining([
        { workspaceId: WORKSPACE_A, connectionId: first.id },
        { workspaceId: WORKSPACE_A, connectionId: second.id },
        { workspaceId: WORKSPACE_B, connectionId: other.id },
      ]),
    );
    expect(harness.delivered.size).toBe(3);
  });

  it("adds no connection to evaluate when a delivery's events were already stored (boundary: nothing new)", async () => {
    const harness = setup();
    harness.connect(WORKSPACE_A);
    await harness.deliver(events([deployment]), "delivery-1");
    await harness.deliver(events([deployment]), "delivery-2");
    const [first, second] = harness.store.jobs.filter((job) => job.kind === "webhook");
    if (first === undefined || second === undefined) throw new Error("Expected two webhook jobs");
    await runWebhookJob(first, harness.deps, harness.delivered);
    harness.delivered.clear();

    expect(await runWebhookJob(second, harness.deps, harness.delivered)).toEqual({ status: "succeeded" });
    expect(harness.eventsIn(WORKSPACE_A)).toHaveLength(1);
    expect(harness.delivered.size).toBe(0);
  });

  it("writes nothing twice when the same job runs again after finishing (retried after a lost completion)", async () => {
    const harness = setup();
    harness.connect(WORKSPACE_A);
    const job = await harness.deliver(events([deployment]));
    await runWebhookJob(job, harness.deps, harness.delivered);
    expect(await runWebhookJob(job, harness.deps, harness.delivered)).toEqual({ status: "succeeded" });
    expect(harness.eventsIn(WORKSPACE_A)).toHaveLength(1);
  });

  it("writes a delivered event to a failed connection's workspace (boundary: polling erroring)", async () => {
    const harness = setup();
    const failing = harness.connect(WORKSPACE_A, { status: "failed", consecutive_failures: 2 });
    const job = await harness.deliver(events([deployment]));

    expect(await runWebhookJob(job, harness.deps, harness.delivered)).toEqual({ status: "succeeded" });
    expect(harness.eventsIn(WORKSPACE_A)).toEqual([
      expect.objectContaining({ connection_id: failing.id, type_id: "fake.deploy.succeeded", dedupe_key: DEPLOYMENT_ROW_KEY }),
    ]);
    expect(failing).toMatchObject({ status: "failed", consecutive_failures: 2 });
  });

  it.each(["webhook first", "sync first"] as const)(
    "stores an event once when a delivery and a poll both see it (%s)",
    async (order) => {
      const harness = setup();
      const connection = harness.connect(WORKSPACE_A);
      const sync = async () => {
        connection.next_sync_at = null;
        await runTick(harness.deps);
      };
      const webhook = async () => {
        await harness.deliver(events([deployment]));
        await runTick(harness.deps);
      };
      if (order === "webhook first") {
        await webhook();
        harness.advance(60_000);
        await sync();
      } else {
        await sync();
        harness.advance(60_000);
        await webhook();
      }

      // The sync wrote a week of events; the delivered one is among them exactly once.
      expect(harness.eventsIn(WORKSPACE_A).filter((event) => event.dedupe_key === DEPLOYMENT_ROW_KEY)).toHaveLength(1);
      expect(harness.store.jobs.filter((job) => job.kind === "webhook").map((job) => job.status)).toEqual(["succeeded"]);
    },
  );

  const UNINSTALLED_AT = new Date("2026-11-15T12:30:00.000Z");
  const uninstall: WebhookOutcome = { kind: "uninstalled", externalAccountId: "fake-acct-1", occurredAt: UNINSTALLED_AT };

  it("asks every target connection to reconnect on an uninstall, as a revoked credential does", async () => {
    const harness = setup();
    const active = harness.connect(WORKSPACE_A);
    const other = harness.connect(WORKSPACE_B);
    const job = await harness.deliver(uninstall);

    expect(await runWebhookJob(job, harness.deps, harness.delivered)).toEqual({ status: "succeeded" });

    for (const connection of [active, other]) {
      expect(connection).toMatchObject({ status: "needs_attention", last_error_code: "auth_revoked", next_sync_at: null });
    }
    const failures = harness.store.events.filter((event) => event.type_id === SYNC_FAILED_TYPE_ID);
    expect(failures.map((event) => event.workspace_id).sort()).toEqual([WORKSPACE_A, WORKSPACE_B]);
  });

  it("leaves a connection already waiting for a reconnect alone on an uninstall", async () => {
    const harness = setup();
    const waiting = harness.connect(WORKSPACE_A, { status: "needs_attention", consecutive_failures: 1, last_error_code: "auth_revoked" });
    const job = await harness.deliver(uninstall);

    expect(await runWebhookJob(job, harness.deps, harness.delivered)).toEqual({ status: "succeeded" });
    expect(waiting).toMatchObject({ status: "needs_attention", consecutive_failures: 1 });
    expect(harness.store.events).toEqual([]);
  });

  it("asks a failed connection to reconnect on an uninstall, adding no second failure event to its episode (boundary: failed)", async () => {
    const harness = setup();
    const failing = harness.connect(WORKSPACE_A, { status: "failed", consecutive_failures: 2 });
    const job = await harness.deliver(uninstall);

    expect(await runWebhookJob(job, harness.deps, harness.delivered)).toEqual({ status: "succeeded" });
    expect(failing).toMatchObject({ status: "needs_attention", last_error_code: "auth_revoked", consecutive_failures: 3, next_sync_at: null });
    // The episode's stackdash.sync_failed event was written when the connection left active.
    expect(harness.store.events.filter((event) => event.type_id === SYNC_FAILED_TYPE_ID)).toEqual([]);
  });

  it.each([
    ["with no grant time", null],
    ["granted one millisecond before the uninstall (boundary)", new Date(UNINSTALLED_AT.getTime() - 1).toISOString()],
    ["granted at the instant of the uninstall (boundary)", UNINSTALLED_AT.toISOString()],
  ])("revokes a connection %s", async (_case, grantedAt) => {
    const harness = setup();
    const connection = harness.connect(WORKSPACE_A, { granted_at: grantedAt });
    const job = await harness.deliver(uninstall);

    expect(await runWebhookJob(job, harness.deps, harness.delivered)).toEqual({ status: "succeeded" });
    expect(connection).toMatchObject({ status: "needs_attention", last_error_code: "auth_revoked" });
  });

  it("revokes a connection whose token was refreshed after the removal (boundary: refresh after removal, #476)", async () => {
    const harness = setup();
    // Granted before the removal, with a token that expires now, so the sync below refreshes it.
    const connection = harness.connect(WORKSPACE_A, { granted_at: new Date(UNINSTALLED_AT.getTime() - 3_600_000).toISOString() });
    harness.store.credentials.set(connection.id, { ...credential, expiresAt: new Date(START) });
    connection.next_sync_at = null;
    await runTick(harness.deps);
    expect(harness.store.savedCredentials).toHaveLength(1);
    expect(connection).toMatchObject({ status: "active" });

    const job = await harness.deliver(uninstall);

    expect(await runWebhookJob(job, harness.deps, harness.delivered)).toEqual({ status: "succeeded" });
    expect(connection).toMatchObject({ status: "needs_attention", last_error_code: "auth_revoked" });
    expect(harness.infos.map((line) => line.event)).not.toContain("webhook.uninstall_stale");
  });

  it("leaves a connection granted again one millisecond after the uninstall to its next sync (boundary: reconnect after removal)", async () => {
    const harness = setup();
    const reconnected = harness.connect(WORKSPACE_A, { granted_at: new Date(UNINSTALLED_AT.getTime() + 1).toISOString() });
    const removed = harness.connect(WORKSPACE_B, { granted_at: new Date(UNINSTALLED_AT.getTime() - 60_000).toISOString() });
    const job = await harness.deliver(uninstall);

    expect(await runWebhookJob(job, harness.deps, harness.delivered)).toEqual({ status: "succeeded" });
    expect(reconnected).toMatchObject({ status: "active", last_error_code: null });
    expect(removed).toMatchObject({ status: "needs_attention", last_error_code: "auth_revoked" });
    expect(harness.infos).toContainEqual({
      event: "webhook.uninstall_stale",
      fields: { jobId: job.id, provider: "fake", connectionId: reconnected.id },
    });
    const failures = harness.store.events.filter((event) => event.type_id === SYNC_FAILED_TYPE_ID);
    expect(failures.map((event) => event.workspace_id)).toEqual([WORKSPACE_B]);
  });

  it("succeeds without writing when the delivery was purged", async () => {
    const harness = setup();
    harness.connect(WORKSPACE_A);
    const job = harness.store.newJob({ workspace_id: null, connection_id: null, kind: "webhook", webhook_delivery_id: crypto.randomUUID() });

    expect(await runWebhookJob(job, harness.deps, harness.delivered)).toEqual({ status: "succeeded" });
    expect(harness.store.events).toEqual([]);
    expect(harness.infos.map((line) => line.event)).toEqual(["webhook.delivery_missing"]);
  });

  it("finishes a delivery for an account no workspace includes, writing nothing", async () => {
    const harness = setup();
    harness.connect(WORKSPACE_A);
    const job = await harness.deliver({ kind: "events", externalAccountId: "fake-acct-2", events: [{ ...deployment, externalAccountId: "fake-acct-2" }] });

    expect(await runWebhookJob(job, harness.deps, harness.delivered)).toEqual({ status: "succeeded" });
    expect(harness.store.events).toEqual([]);
    expect(harness.infos.map((line) => line.event)).toContain("webhook.no_targets");
    expect(harness.store.webhookDeliveries.map((delivery) => delivery.status)).toEqual(["processed"]);
  });

  it("is retried by the runner when the store fails, keeping the delivery for the next attempt", async () => {
    const harness = setup();
    harness.connect(WORKSPACE_A);
    harness.store.listWebhookTargets = () => Promise.reject(new Error("database unavailable"));
    await harness.deliver(events([deployment]));

    const result = await runTick(harness.deps);

    expect(result.retried).toBe(1);
    const job = harness.store.jobs.find((candidate) => candidate.kind === "webhook");
    expect(job).toMatchObject({ status: "queued", attempts: 1, error_code: "internal_error" });
    expect(harness.store.webhookDeliveries.map((delivery) => delivery.status)).toEqual(["received"]);
  });

  it("fails a webhook job without a delivery id instead of guessing", async () => {
    const harness = setup();
    const job = harness.store.newJob({ workspace_id: null, connection_id: null, kind: "webhook" });
    expect(await runWebhookJob(job, harness.deps, harness.delivered)).toEqual({ status: "failed", errorCode: "invalid_job", errorReference: null });
  });
});
