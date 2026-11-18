import { afterEach, describe, expect, it } from "vitest";

import { fakeAdapter, type FakeMode } from "@/lib/adapters/fake";
import { gitlabAdapter } from "@/lib/adapters/gitlab";
import { simulatedAdapters } from "@/lib/adapters/simulated";
import { simulatedCredentialMetadata, SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";
import { Secret, type OAuthClient, type OAuthCredential, type ProviderAdapter } from "@/lib/adapters/types";
import { TOKEN_REFRESH_SKEW_MS } from "@/lib/connections/credential-refresh";
import type { LogFields, Logger } from "@/lib/log/logger";
import { memoryNotificationDeps } from "@/lib/notifications/memory-store";

import { BACKOFF_CAP_MS, backoffCeilingMs } from "./backoff";
import { ALLOWANCE_RESET_TYPE_ID } from "./ingest";
import { MemoryJobStore, type MemoryConnection, type MemoryEvent } from "./memory-store";
import { runTick, type TickResult } from "./runner";
import type { ClaimedJob } from "./store";
import { markConnectionRevoked, SYNC_FAILED_TYPE_ID, type SyncDeps } from "./sync-connection";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const client: OAuthClient = { clientId: "fake-client", clientSecret: new Secret("fake-secret"), extra: {} };

function credential(mode: FakeMode, expiresAt?: Date): OAuthCredential {
  return {
    accessToken: new Secret(`at-${mode}`),
    refreshToken: new Secret(`rt-${mode}`),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    scopes: ["usage:read"],
    tokenType: "bearer",
    metadata: { mode },
  };
}

type Harness = {
  store: MemoryJobStore;
  deps: SyncDeps;
  connectionId: string;
  setNow: (at: string | Date) => void;
  advance: (ms: number) => void;
  now: () => Date;
  setMode: (mode: FakeMode) => void;
  tick: () => Promise<TickResult>;
  failureEvents: () => MemoryEvent[];
  references: string[];
  alertCalls: Array<{ workspaceId: string; now: string }>;
  // Each achievement evaluation, with how many events were stored when it ran.
  achievementCalls: Array<{ workspaceId: string; connectionId: string; now: string; storedEvents: number }>;
  // Each request to give the connection's new sources their webhooks (#428).
  sourceWebhookCalls: Array<{ workspaceId: string; connectionId: string }>;
  // Every info line the job logged, in order.
  infos: Array<{ event: string; fields: LogFields | undefined }>;
};

function setup(
  options: {
    start?: string;
    mode?: FakeMode;
    accounts?: number;
    adapter?: ProviderAdapter;
    random?: number;
    alertsFail?: boolean;
    achievementsFail?: boolean;
    sourceWebhooksFail?: boolean;
  } = {},
): Harness {
  let clock = new Date(options.start ?? "2026-10-14T10:00:00.000Z");
  const now = () => clock;
  const store = new MemoryJobStore(now);
  const connection = store.addConnection({
    workspace_id: WORKSPACE_ID,
    provider: "fake",
    display_name: "Fake connection",
    authorized_account_label: "Example team",
  });
  const accountIds = ["fake-acct-1", "fake-acct-2"].slice(0, options.accounts ?? 2);
  for (const externalId of accountIds) {
    store.addAccount({ workspace_id: WORKSPACE_ID, connection_id: connection.id, external_id: externalId });
  }
  store.credentials.set(connection.id, credential(options.mode ?? "ok"));
  const references: string[] = [];
  const alertCalls: Harness["alertCalls"] = [];
  const achievementCalls: Harness["achievementCalls"] = [];
  const sourceWebhookCalls: Harness["sourceWebhookCalls"] = [];
  const infos: Harness["infos"] = [];
  const adapter = options.adapter ?? fakeAdapter;
  const deps: SyncDeps = {
    store,
    getAdapter: () => adapter,
    loadOAuthClient: () => client,
    createOAuthContext: (oauthClient) => ({
      client: oauthClient,
      fetch: () => Promise.reject(new Error("no network in tests")),
      now,
      timeoutMs: 1000,
      logger: silent,
    }),
    now,
    random: () => options.random ?? 0.5,
    logError: () => {
      const reference = `REF-TEST${String(references.length).padStart(4, "0")}`;
      references.push(reference);
      return reference;
    },
    log: { ...silent, info: (event, fields) => infos.push({ event, fields }) },
    evaluateAlerts: async (workspaceId, at) => {
      alertCalls.push({ workspaceId, now: at.toISOString() });
      if (options.alertsFail === true) throw new Error("alert evaluation failed");
      return { triggered: 0 };
    },
    evaluateAchievements: async (workspaceId, connectionId, at) => {
      achievementCalls.push({ workspaceId, connectionId, now: at.toISOString(), storedEvents: store.events.length });
      if (options.achievementsFail === true) throw new Error("achievement evaluation failed");
      return 0;
    },
    addMissingSourceWebhooks: async (workspaceId, connectionId) => {
      sourceWebhookCalls.push({ workspaceId, connectionId });
      if (options.sourceWebhooksFail === true) throw new Error("webhook creation failed");
      return 0;
    },
    notifications: () => memoryNotificationDeps(),
  };
  return {
    store,
    deps,
    connectionId: connection.id,
    setNow: (at) => {
      clock = new Date(at);
    },
    advance: (ms) => {
      clock = new Date(clock.getTime() + ms);
    },
    now,
    setMode: (mode) => store.credentials.set(connection.id, credential(mode)),
    tick: () => runTick(deps),
    failureEvents: () => store.events.filter((event) => event.type_id === SYNC_FAILED_TYPE_ID),
    references,
    alertCalls,
    achievementCalls,
    sourceWebhookCalls,
    infos,
  };
}

function connectionOf(harness: Harness) {
  const row = harness.store.connections.find((connection) => connection.id === harness.connectionId);
  if (row === undefined) throw new Error("connection missing");
  return row;
}

function syncJobs(harness: Harness) {
  return harness.store.jobs.filter((job) => job.kind === "sync");
}

function lastSyncJob(harness: Harness) {
  const job = syncJobs(harness).at(-1);
  if (job === undefined) throw new Error("no sync job");
  return job;
}

describe("sync job: idempotency (#44, #53)", () => {
  it("running the same sync twice stores no duplicate snapshots or events", async () => {
    const harness = setup();
    await harness.tick();
    expect(lastSyncJob(harness).status).toBe("succeeded");
    const snapshotCount = harness.store.snapshots.length;
    const eventCount = harness.store.events.length;
    // 2 accounts x 5 metrics, one row per account, metric, and UTC day.
    expect(snapshotCount).toBe(10);
    expect(eventCount).toBeGreaterThan(0);

    // Forget the cursors so the adapter returns every event again, then sync again.
    for (const account of harness.store.accounts) account.sync_cursor = null;
    await harness.store.enqueueSync({ workspaceId: WORKSPACE_ID, connectionId: harness.connectionId });
    await harness.tick();

    expect(syncJobs(harness).map((job) => job.status)).toEqual(["succeeded", "succeeded"]);
    expect(harness.store.snapshots).toHaveLength(snapshotCount);
    expect(harness.store.events).toHaveLength(eventCount);
    expect(new Set(harness.store.events.map((event) => event.dedupe_key)).size).toBe(eventCount);
  });

  it("marks the connection synced and schedules the next poll on success", async () => {
    const harness = setup();
    await harness.tick();
    const connection = connectionOf(harness);
    expect(connection.status).toBe("active");
    expect(connection.consecutive_failures).toBe(0);
    expect(connection.last_synced_at).toBe("2026-10-14T10:00:00.000Z");
    expect(connection.next_sync_at).toBe("2026-10-14T11:00:00.000Z");
  });

  it("queues at most one open sync per connection however often it is asked", async () => {
    const harness = setup();
    const key = { workspaceId: WORKSPACE_ID, connectionId: harness.connectionId };
    expect(await harness.store.enqueueSync(key)).toBe(true);
    expect(await harness.store.enqueueSync(key)).toBe(false);
    expect(await harness.store.enqueueDueSyncs(10)).toBe(0);
    expect(syncJobs(harness)).toHaveLength(1);
  });
});

describe("sync job: rate limits and provider outages (#44)", () => {
  it("retries a 429 at Retry-After, then marks the connection failed after 5 attempts", async () => {
    const harness = setup({ mode: "rate_limited" });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const before = harness.now().getTime();
      await harness.tick();
      const job = lastSyncJob(harness);
      expect(job.status).toBe("queued");
      expect(job.attempts).toBe(attempt);
      expect(job.error_code).toBe("rate_limited");
      // The fake provider sends Retry-After: 1 s.
      expect(new Date(job.run_after).getTime() - before).toBe(1000);
      expect(connectionOf(harness).status).toBe("active");
      expect(connectionOf(harness).consecutive_failures).toBe(attempt);
      harness.advance(1000);
    }

    await harness.tick();
    const job = lastSyncJob(harness);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(5);
    expect(syncJobs(harness)).toHaveLength(1);
    const connection = connectionOf(harness);
    expect(connection.status).toBe("failed");
    expect(connection.last_error_code).toBe("rate_limited");
    expect(connection.last_error_reference).toBe(job.error_reference);
    expect(connection.next_sync_at).toBe(new Date(harness.now().getTime() + BACKOFF_CAP_MS).toISOString());
    expect(harness.failureEvents()).toHaveLength(1);
  });

  it("backs off a 5xx with full jitter inside [0, ceiling] for each attempt", async () => {
    const harness = setup({ mode: "unavailable", random: 0.999999 });
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const before = harness.now().getTime();
      await harness.tick();
      const job = lastSyncJob(harness);
      const delay = new Date(job.run_after).getTime() - before;
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(backoffCeilingMs(attempt));
      expect(job.error_code).toBe("provider_unavailable");
      harness.advance(delay);
    }
    await harness.tick();
    expect(lastSyncJob(harness).status).toBe("failed");
    expect(connectionOf(harness).status).toBe("failed");
  });

  it("gives a failed connection one attempt per scheduled run once its backoff elapses", async () => {
    const harness = setup({ mode: "unavailable", random: 0 });
    for (let attempt = 1; attempt <= 5; attempt += 1) await harness.tick();
    expect(connectionOf(harness).status).toBe("failed");

    harness.advance(BACKOFF_CAP_MS - 1);
    await harness.tick();
    expect(syncJobs(harness)).toHaveLength(1);

    harness.advance(1);
    await harness.tick();
    expect(syncJobs(harness)).toHaveLength(2);
    expect(lastSyncJob(harness).status).toBe("failed");
    expect(lastSyncJob(harness).attempts).toBe(1);
  });
});

describe("sync job: failure episodes (#60)", () => {
  it("moves a revoked credential to needs_attention at once with one sync_failed event", async () => {
    const harness = setup({ mode: "revoked" });
    await harness.tick();

    const job = lastSyncJob(harness);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(job.error_code).toBe("auth_revoked");
    const connection = connectionOf(harness);
    expect(connection.status).toBe("needs_attention");
    expect(connection.next_sync_at).toBeNull();

    const [event, ...rest] = harness.failureEvents();
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      provider: null,
      url: null,
      severity: "critical",
      connection_id: harness.connectionId,
      title: "Example provider sync failed for Example team",
    });
    expect(event?.body).toContain("Reconnect Example provider");
    expect(event?.body).toContain(job.error_reference ?? "missing");

    // Later requests do not add events: a needs_attention connection waits for the user.
    for (let i = 0; i < 3; i += 1) {
      harness.advance(60_000);
      await harness.store.enqueueSync({ workspaceId: WORKSPACE_ID, connectionId: harness.connectionId });
      await harness.tick();
    }
    expect(harness.failureEvents()).toHaveLength(1);
    expect(connectionOf(harness).status).toBe("needs_attention");
  });

  it("writes one sync_failed event across several failed jobs in one episode", async () => {
    const harness = setup({ mode: "unavailable", random: 0 });
    for (let attempt = 1; attempt <= 5; attempt += 1) await harness.tick();
    for (let run = 0; run < 3; run += 1) {
      harness.advance(BACKOFF_CAP_MS);
      await harness.tick();
    }
    expect(syncJobs(harness).filter((job) => job.status === "failed")).toHaveLength(4);
    const events = harness.failureEvents();
    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe("warning");
    expect(events[0]?.body).toContain("reconnect Example provider");
  });

  it("recovery resets the episode so the next failure writes a new event", async () => {
    const harness = setup({ mode: "unavailable", random: 0 });
    for (let attempt = 1; attempt <= 5; attempt += 1) await harness.tick();
    expect(harness.failureEvents()).toHaveLength(1);

    harness.setMode("ok");
    harness.advance(BACKOFF_CAP_MS);
    await harness.tick();
    const recovered = connectionOf(harness);
    expect(recovered.status).toBe("active");
    expect(recovered.consecutive_failures).toBe(0);
    expect(recovered.last_error_code).toBeNull();
    expect(recovered.last_error_reference).toBeNull();

    harness.setMode("unavailable");
    harness.advance(3_600_000);
    for (let attempt = 1; attempt <= 5; attempt += 1) await harness.tick();
    const events = harness.failureEvents();
    expect(events).toHaveLength(2);
    expect(events[0]?.dedupe_key).not.toBe(events[1]?.dedupe_key);
  });
});

describe("sync job: simulated credentials (#131)", () => {
  const simulatedCredential: OAuthCredential = {
    accessToken: new Secret("simulated-at-test"),
    scopes: [SIMULATED_SCOPE],
    tokenType: "bearer",
    metadata: simulatedCredentialMetadata("5eed0a11"),
  };

  it("refuses a simulated credential with a real adapter at once, without asking for a client or calling the provider", async () => {
    const calls = { sync: 0, fetch: 0, client: 0 };
    const real: ProviderAdapter = {
      ...fakeAdapter,
      sync: (input, ctx) => {
        calls.sync += 1;
        return fakeAdapter.sync(input, ctx);
      },
    };
    const harness = setup({ adapter: real });
    harness.store.credentials.set(harness.connectionId, simulatedCredential);
    const deps: SyncDeps = {
      ...harness.deps,
      loadOAuthClient: (adapter) => {
        calls.client += 1;
        return harness.deps.loadOAuthClient(adapter);
      },
      createOAuthContext: (oauthClient) => ({
        ...harness.deps.createOAuthContext(oauthClient),
        fetch: () => {
          calls.fetch += 1;
          return Promise.reject(new Error("no network in tests"));
        },
      }),
    };

    await runTick(deps);

    const job = lastSyncJob(harness);
    expect(job.status).toBe("failed");
    expect(job.attempts).toBe(1);
    expect(job.error_code).toBe("simulated_credential");
    const connection = connectionOf(harness);
    expect(connection.status).toBe("needs_attention");
    expect(connection.last_error_code).toBe("simulated_credential");
    expect(connection.next_sync_at).toBeNull();
    expect(calls).toEqual({ sync: 0, fetch: 0, client: 0 });
    const [event, ...rest] = harness.failureEvents();
    expect(rest).toHaveLength(0);
    expect(event?.severity).toBe("critical");
    expect(event?.body).toContain("STACKDASH_SIMULATE_PROVIDERS=1");
  });

  it("syncs a simulated credential with the registry's simulated adapter", async () => {
    const harness = setup({ adapter: simulatedAdapters.stripe, accounts: 0 });
    harness.store.credentials.set(harness.connectionId, simulatedCredential);
    await harness.tick();
    expect(lastSyncJob(harness).status).toBe("succeeded");
    expect(connectionOf(harness).status).toBe("active");
  });
});

describe("sync job: alert evaluation (#65)", () => {
  it("evaluates the workspace's alerts once per successful sync", async () => {
    const harness = setup();
    await harness.tick();
    expect(harness.alertCalls).toEqual([{ workspaceId: WORKSPACE_ID, now: "2026-10-14T10:00:00.000Z" }]);
    await harness.store.enqueueSync({ workspaceId: WORKSPACE_ID, connectionId: harness.connectionId });
    await harness.tick();
    expect(harness.alertCalls).toHaveLength(2);
  });

  it("does not evaluate alerts when the sync fails or is retried", async () => {
    const harness = setup({ mode: "unavailable", random: 0 });
    for (let attempt = 1; attempt <= 5; attempt += 1) await harness.tick();
    const revoked = setup({ mode: "revoked" });
    await revoked.tick();
    expect(harness.alertCalls).toHaveLength(0);
    expect(revoked.alertCalls).toHaveLength(0);
  });

  it("logs an alert evaluation error without failing the sync", async () => {
    const harness = setup({ alertsFail: true });
    await harness.tick();
    expect(harness.alertCalls).toHaveLength(1);
    expect(lastSyncJob(harness).status).toBe("succeeded");
    expect(connectionOf(harness).status).toBe("active");
    expect(harness.references).toHaveLength(1);
  });
});

describe("sync job: achievement evaluation (#413)", () => {
  it("evaluates the connection's achievements after each successful sync, once its evidence is stored", async () => {
    const harness = setup();
    await harness.tick();
    expect(harness.achievementCalls).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        connectionId: harness.connectionId,
        now: "2026-10-14T10:00:00.000Z",
        storedEvents: harness.store.events.length,
      },
    ]);
    expect(harness.achievementCalls[0]?.storedEvents).toBeGreaterThan(0);
    await harness.store.enqueueSync({ workspaceId: WORKSPACE_ID, connectionId: harness.connectionId });
    await harness.tick();
    expect(harness.achievementCalls).toHaveLength(2);
  });

  it("does not evaluate achievements when the sync fails or is retried", async () => {
    const harness = setup({ mode: "unavailable", random: 0 });
    for (let attempt = 1; attempt <= 5; attempt += 1) await harness.tick();
    const revoked = setup({ mode: "revoked" });
    await revoked.tick();
    expect(harness.achievementCalls).toHaveLength(0);
    expect(revoked.achievementCalls).toHaveLength(0);
  });

  it("logs an achievement evaluation error without failing the sync", async () => {
    const harness = setup({ achievementsFail: true });
    await harness.tick();
    expect(harness.achievementCalls).toHaveLength(1);
    expect(lastSyncJob(harness).status).toBe("succeeded");
    expect(connectionOf(harness).status).toBe("active");
    expect(harness.references).toHaveLength(1);
  });

  it("still evaluates achievements when the alert evaluation failed", async () => {
    const harness = setup({ alertsFail: true });
    await harness.tick();
    expect(harness.achievementCalls).toHaveLength(1);
    expect(lastSyncJob(harness).status).toBe("succeeded");
  });
});

describe("sync job: webhooks for new sources (#428)", () => {
  it("asks for the connection's new sources' webhooks once the sync succeeded", async () => {
    const harness = setup();
    await harness.tick();
    expect(harness.sourceWebhookCalls).toEqual([{ workspaceId: WORKSPACE_ID, connectionId: harness.connectionId }]);
  });

  it("does not ask when the sync fails", async () => {
    const harness = setup({ mode: "revoked" });
    await harness.tick();
    expect(harness.sourceWebhookCalls).toHaveLength(0);
  });

  it("logs a failure to create them without failing the sync (boundary: provider fails)", async () => {
    const harness = setup({ sourceWebhooksFail: true });
    await harness.tick();
    expect(harness.sourceWebhookCalls).toHaveLength(1);
    expect(lastSyncJob(harness).status).toBe("succeeded");
    expect(connectionOf(harness).status).toBe("active");
    expect(harness.references).toHaveLength(1);
  });
});

describe("sync job: token refresh (#44)", () => {
  function recordingAdapter(seen: OAuthCredential[]): ProviderAdapter {
    return {
      ...fakeAdapter,
      sync: (input, ctx) => {
        seen.push(input.credential);
        return fakeAdapter.sync(input, ctx);
      },
    };
  }

  it("refreshes a token inside the 5 minute skew and saves the rotated token before syncing", async () => {
    const seen: OAuthCredential[] = [];
    const harness = setup({ adapter: recordingAdapter(seen), accounts: 1 });
    const expiresAt = new Date(harness.now().getTime() + TOKEN_REFRESH_SKEW_MS);
    const original = credential("ok", expiresAt);
    harness.store.credentials.set(harness.connectionId, original);

    await harness.tick();

    expect(harness.store.savedCredentials).toHaveLength(1);
    const rotated = harness.store.savedCredentials[0];
    expect(rotated?.refreshToken?.reveal()).not.toBe(original.refreshToken?.reveal());
    expect(harness.store.credentials.get(harness.connectionId)).toBe(rotated);
    expect(seen).toEqual([rotated]);
    expect(lastSyncJob(harness).status).toBe("succeeded");
    // The connection's refresh lock (#496) is free again for the next refresh.
    expect(harness.store.refreshLocks.size).toBe(0);
  });

  it("refreshes a GitLab token, which lasts 2 hours, inside the skew and saves GitLab's rotated pair before syncing", async () => {
    const refresh = gitlabAdapter.refreshTokens;
    if (refresh === undefined) throw new Error("gitlab must refresh tokens");
    const seen: OAuthCredential[] = [];
    const tokenRequests: string[] = [];
    const adapter: ProviderAdapter = {
      ...recordingAdapter(seen),
      // GitLab's own refresh, answered with its documented response; the sync itself stays fake.
      refreshTokens: (current, ctx) =>
        refresh(current, {
          ...ctx,
          fetch: async (input, init) => {
            tokenRequests.push(`${String(input)} ${String(init?.body)}`);
            return Response.json({ access_token: "gl-at-2", token_type: "bearer", expires_in: 7200, refresh_token: "gl-rt-2" });
          },
        }),
    };
    const harness = setup({ adapter, accounts: 1 });
    // Connected 1 hour 56 minutes ago: 4 minutes left, inside the 5 minute skew.
    const original = credential("ok", new Date(harness.now().getTime() + 4 * 60_000));
    harness.store.credentials.set(harness.connectionId, original);

    await harness.tick();

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]).toMatch(/^https:\/\/gitlab\.com\/oauth\/token .*grant_type=refresh_token&refresh_token=rt-ok/);
    const [rotated] = harness.store.savedCredentials;
    expect(rotated?.refreshToken?.reveal()).toBe("gl-rt-2");
    expect(rotated?.expiresAt).toEqual(new Date(harness.now().getTime() + 7200 * 1000));
    expect(seen).toEqual([rotated]);
    expect(lastSyncJob(harness).status).toBe("succeeded");
  });

  it("does not refresh a token that expires after the skew", async () => {
    const harness = setup({ accounts: 1 });
    const expiresAt = new Date(harness.now().getTime() + TOKEN_REFRESH_SKEW_MS + 1);
    harness.store.credentials.set(harness.connectionId, credential("ok", expiresAt));
    await harness.tick();
    expect(harness.store.savedCredentials).toHaveLength(0);
  });

  it("treats a refresh rejected as revoked like any revoked credential", async () => {
    const harness = setup({ accounts: 1 });
    harness.store.credentials.set(harness.connectionId, credential("revoked", harness.now()));
    await harness.tick();
    expect(harness.store.savedCredentials).toHaveLength(0);
    expect(connectionOf(harness).status).toBe("needs_attention");
  });
});

describe("sync job: snapshots and billing periods (#53)", () => {
  it("files 23:59:59 UTC and 00:00:00 UTC under different snapshot dates", async () => {
    const harness = setup({ start: "2026-10-14T23:59:59.000Z", accounts: 1 });
    await harness.tick();
    expect(new Set(harness.store.snapshots.map((row) => row.snapshot_date))).toEqual(new Set(["2026-10-14"]));

    harness.setNow("2026-10-15T00:00:00.000Z");
    await harness.store.enqueueSync({ workspaceId: WORKSPACE_ID, connectionId: harness.connectionId });
    await harness.tick();
    const dates = harness.store.snapshots.map((row) => row.snapshot_date);
    expect(dates.filter((date) => date === "2026-10-14")).toHaveLength(5);
    expect(dates.filter((date) => date === "2026-10-15")).toHaveLength(5);
  });

  it("writes one allowance reset event per billing period rollover", async () => {
    const harness = setup({ start: "2026-10-31T23:00:00.000Z", accounts: 1 });
    await harness.tick();
    expect(harness.store.events.filter((event) => event.type_id === ALLOWANCE_RESET_TYPE_ID)).toHaveLength(0);

    for (const at of ["2026-11-01T00:30:00.000Z", "2026-11-01T01:30:00.000Z", "2026-11-02T09:00:00.000Z"]) {
      harness.setNow(at);
      await harness.store.enqueueSync({ workspaceId: WORKSPACE_ID, connectionId: harness.connectionId });
      await harness.tick();
    }

    const resets = harness.store.events.filter((event) => event.type_id === ALLOWANCE_RESET_TYPE_ID);
    expect(resets).toHaveLength(1);
    expect(resets[0]).toMatchObject({
      provider: null,
      occurred_at: "2026-11-01T00:00:00.000Z",
      severity: "info",
    });
    // The month-to-date usage starts again in the new period.
    const usage = harness.store.snapshots.find(
      (row) => row.metric_key === "fake.requests.month" && row.snapshot_date === "2026-11-01",
    );
    expect(usage?.value).toBe(1200);
  });
});

describe("sync job: installation id of a connection made before #480", () => {
  const INSTALLATION = "fake-installation-1";
  const installed: ProviderAdapter = { ...fakeAdapter, installationIdOf: () => INSTALLATION };

  it("fills a missing installation id from the credential on the next sync", async () => {
    const harness = setup({ adapter: installed });
    expect(connectionOf(harness).external_installation_id).toBeNull();

    await harness.tick();

    expect(lastSyncJob(harness).status).toBe("succeeded");
    expect(connectionOf(harness).external_installation_id).toBe(INSTALLATION);
  });

  it("fills it even when the sync then fails (boundary: revoked credential)", async () => {
    const harness = setup({ adapter: installed, mode: "revoked" });

    await harness.tick();

    expect(connectionOf(harness)).toMatchObject({ status: "needs_attention", external_installation_id: INSTALLATION });
  });

  it("never rewrites an installation id the grant recorded (boundary: already set)", async () => {
    const harness = setup({ adapter: { ...fakeAdapter, installationIdOf: () => "fake-installation-2" } });
    connectionOf(harness).external_installation_id = INSTALLATION;

    await harness.tick();

    expect(connectionOf(harness).external_installation_id).toBe(INSTALLATION);
  });

  it.each([
    ["an adapter whose credential names no installation (boundary: null)", { ...fakeAdapter, installationIdOf: () => null }],
    ["an adapter that returns an empty id (boundary: blank)", { ...fakeAdapter, installationIdOf: () => "" }],
    ["an adapter that returns whitespace (boundary: blank)", { ...fakeAdapter, installationIdOf: () => " \t" }],
    ["an adapter that does not declare installationIdOf (boundary: omitted)", fakeAdapter],
  ])("leaves it null for %s", async (_case, adapter: ProviderAdapter) => {
    const harness = setup({ adapter });

    await harness.tick();

    expect(lastSyncJob(harness).status).toBe("succeeded");
    expect(connectionOf(harness).external_installation_id).toBeNull();
  });
});

describe("sync job: an uninstall applied while the sync runs (#487)", () => {
  // The fake adapter, except that one sync call can be preceded by a webhook job marking the
  // connection revoked (#28): the uninstall lands between the sync's read of the connection and its
  // final write, as when both run in the same tick.
  let beforeNextSync: (() => Promise<void>) | null = null;
  const interleaved: ProviderAdapter = {
    ...fakeAdapter,
    sync: async (input, ctx) => {
      const hook = beforeNextSync;
      beforeNextSync = null;
      await hook?.();
      return fakeAdapter.sync(input, ctx);
    },
  };
  // A hook armed but never reached does not fire in the next test.
  afterEach(() => {
    beforeNextSync = null;
  });

  type Uninstalled = { result: "marked" | "skipped"; connection: MemoryConnection };

  /**
   * Arms the uninstall for the next sync call; resolves to its result and the connection as it left
   * it. Asserted by the caller: the hook runs inside the sync, whose failure handling would turn a
   * failed assertion here into a sync error.
   */
  function uninstallDuringNextSync(harness: Harness): Promise<Uninstalled> {
    const { promise, resolve } = Promise.withResolvers<Uninstalled>();
    beforeNextSync = async () => {
      // The delivery's job is queued after the sync's, so its failure episode starts later.
      harness.advance(1000);
      const job: ClaimedJob = {
        id: crypto.randomUUID(),
        workspace_id: null,
        connection_id: null,
        kind: "webhook",
        attempts: 1,
        max_attempts: 5,
        created_at: harness.now().toISOString(),
        dedupe_key: null,
        webhook_delivery_id: crypto.randomUUID(),
      };
      const result = await markConnectionRevoked({
        job,
        key: { workspaceId: WORKSPACE_ID, connectionId: harness.connectionId },
        reason: "fake reported that StackDash was removed from the account",
        deps: harness.deps,
      });
      resolve({ result, connection: { ...connectionOf(harness) } });
    };
    return promise;
  }

  /** The connection as the uninstall marked it, after checking the uninstall applied. */
  async function markedBy(uninstalled: Promise<Uninstalled>): Promise<MemoryConnection> {
    const { result, connection } = await uninstalled;
    expect(result).toBe("marked");
    expect(connection).toMatchObject({ status: "needs_attention", last_error_code: "auth_revoked", next_sync_at: null });
    return connection;
  }

  it("leaves the connection as the uninstall marked it when the sync then succeeds (boundary: revoke between read and write)", async () => {
    const harness = setup({ adapter: interleaved, accounts: 1 });
    const uninstalled = uninstallDuringNextSync(harness);

    await harness.tick();

    expect(connectionOf(harness)).toEqual(await markedBy(uninstalled));
    expect(lastSyncJob(harness).status).toBe("succeeded");
    expect(harness.failureEvents()).toHaveLength(1);
    expect(harness.failureEvents()[0]?.severity).toBe("critical");
    expect(harness.infos.filter((line) => line.event === "sync.superseded")).toHaveLength(1);
    // The data the sync read is kept, but no webhook is created on a connection that was removed.
    expect(harness.store.snapshots.length).toBeGreaterThan(0);
    expect(harness.sourceWebhookCalls).toHaveLength(0);
  });

  it.each([
    { name: "a retryable error (boundary: retry path)", mode: "rate_limited" as const, attemptsBefore: 0 },
    { name: "a retryable error on the last attempt (boundary: failure path)", mode: "rate_limited" as const, attemptsBefore: 4 },
    { name: "a revoked credential (boundary: permanent failure)", mode: "revoked" as const, attemptsBefore: 0 },
  ])("leaves it as the uninstall marked it when the sync then fails with $name", async ({ mode, attemptsBefore }) => {
    const harness = setup({ adapter: interleaved, accounts: 1, mode });
    for (let attempt = 1; attempt <= attemptsBefore; attempt += 1) {
      await harness.tick();
      harness.advance(1000);
    }
    expect(connectionOf(harness).status).toBe("active");
    const uninstalled = uninstallDuringNextSync(harness);

    await harness.tick();

    expect(connectionOf(harness)).toEqual(await markedBy(uninstalled));
    // The job ends: a connection waiting for a reconnect is not retried.
    const job = lastSyncJob(harness);
    expect(job).toMatchObject({ status: "failed", attempts: attemptsBefore + 1 });
    expect(syncJobs(harness)).toHaveLength(1);
    // Only the uninstall's event: the sync's own would say it keeps retrying, or repeat the reconnect.
    expect(harness.failureEvents()).toHaveLength(1);
    expect(harness.failureEvents()[0]?.severity).toBe("critical");
    const superseded = harness.infos.filter((line) => line.event === "sync.superseded");
    expect(superseded.map((line) => line.fields?.outcome)).toEqual(["failed"]);
  });

  it("leaves it as the uninstall marked it when a sync of an already failed connection then fails (boundary: no status re-read)", async () => {
    const harness = setup({ adapter: interleaved, accounts: 1, mode: "rate_limited" });
    // A failed connection gets one attempt per run, so its failure goes straight to the final write,
    // and its episode's event is already written: the status filter is the only guard.
    Object.assign(connectionOf(harness), { status: "failed", consecutive_failures: 5, last_error_code: "rate_limited" });
    await harness.store.enqueueSync({ workspaceId: WORKSPACE_ID, connectionId: harness.connectionId });
    const uninstalled = uninstallDuringNextSync(harness);

    await harness.tick();

    expect(connectionOf(harness)).toEqual(await markedBy(uninstalled));
    expect(lastSyncJob(harness)).toMatchObject({ status: "failed", attempts: 1 });
    // Neither writer starts an episode for a connection that was already failed.
    expect(harness.failureEvents()).toHaveLength(0);
    const superseded = harness.infos.filter((line) => line.event === "sync.superseded");
    expect(superseded.map((line) => line.fields?.outcome)).toEqual(["failed"]);
  });

  it("still recovers a failed connection with no uninstall: active, failures reset, next poll scheduled (happy path)", async () => {
    const harness = setup({ adapter: interleaved, accounts: 1 });
    Object.assign(connectionOf(harness), { status: "failed", consecutive_failures: 5, last_error_code: "rate_limited" });
    await harness.store.enqueueSync({ workspaceId: WORKSPACE_ID, connectionId: harness.connectionId });

    await harness.tick();

    expect(connectionOf(harness)).toMatchObject({
      status: "active",
      consecutive_failures: 0,
      last_error_code: null,
      last_error_reference: null,
      last_synced_at: "2026-10-14T10:00:00.000Z",
      next_sync_at: "2026-10-14T11:00:00.000Z",
    });
    expect(harness.infos.filter((line) => line.event === "sync.superseded")).toHaveLength(0);
    expect(harness.sourceWebhookCalls).toHaveLength(1);
  });
});
