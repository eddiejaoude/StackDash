import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { fakeAdapter } from "@/lib/adapters/fake";
import { isSimulatedAdapter, simulatedAdapters } from "@/lib/adapters/simulated";
import { simulatedCredentialMetadata, SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";
import { stripeAdapter } from "@/lib/adapters/stripe";
import { Secret, type LiveProviderId, type OAuthCredential, type ProviderAdapter, type ProviderId } from "@/lib/adapters/types";
import { memoryNotificationDeps } from "@/lib/notifications/memory-store";

import { MemoryJobStore } from "./memory-store";
import { TICK_CLAIM_LIMIT, type TickResult } from "./runner";
import type { EventRow } from "./store";
import type { SyncDeps } from "./sync-connection";
import {
  abortableSleep,
  countingEventWrites,
  formatTickLine,
  parseTickArgs,
  runWatch,
  runWatchTick,
  WATCH_CLAIM_LIMIT,
  WATCH_DEFAULT_INTERVAL_SECONDS,
  type WatchDeps,
  type WatchTick,
  watchUntilStopped,
  withSimulatedEventVolume,
} from "./watch";

const NOW = new Date("2026-11-04T21:30:00.000Z");

const RESULT: TickResult = {
  syncsQueued: 2,
  retentionQueued: false,
  summariesQueued: 0,
  dispatchesQueued: 0,
  digestsQueued: 0,
  claimed: 3,
  succeeded: 2,
  retried: 0,
  failed: 1,
  released: 0,
};

describe("parseTickArgs", () => {
  const simulating = { simulationEnabled: true };

  it.each([
    ["no arguments: one tick, as before", [], { kind: "once" }],
    ["--watch: the default interval", ["--watch"], { kind: "watch", intervalSeconds: WATCH_DEFAULT_INTERVAL_SECONDS, volume: 1 }],
    ["--watch --interval 30", ["--watch", "--interval", "30"], { kind: "watch", intervalSeconds: 30, volume: 1 }],
    ["the interval first", ["--interval", "5", "--watch"], { kind: "watch", intervalSeconds: 5, volume: 1 }],
    ["--volume 1", ["--watch", "--volume", "1"], { kind: "watch", intervalSeconds: WATCH_DEFAULT_INTERVAL_SECONDS, volume: 1 }],
    ["--volume 20, the maximum", ["--watch", "--volume", "20"], { kind: "watch", intervalSeconds: WATCH_DEFAULT_INTERVAL_SECONDS, volume: 20 }],
    ["--volume 10 after --watch", ["--watch", "--volume", "10"], { kind: "watch", intervalSeconds: WATCH_DEFAULT_INTERVAL_SECONDS, volume: 10 }],
    ["--volume 10 before --watch", ["--volume", "10", "--watch"], { kind: "watch", intervalSeconds: WATCH_DEFAULT_INTERVAL_SECONDS, volume: 10 }],
    ["--volume with --interval", ["--watch", "--interval", "30", "--volume", "10"], { kind: "watch", intervalSeconds: 30, volume: 10 }],
  ])("accepts %s", (_title, argv, expected) => {
    expect(parseTickArgs(argv, simulating)).toEqual(expected);
  });

  it.each([true, false])("defaults to volume 1 when --volume is left out (simulation on: %s)", (simulationEnabled) => {
    expect(parseTickArgs(["--watch"], { simulationEnabled })).toEqual({
      kind: "watch",
      intervalSeconds: WATCH_DEFAULT_INTERVAL_SECONDS,
      volume: 1,
    });
  });

  it.each([
    ["an interval below the 5 second minimum", ["--watch", "--interval", "4"]],
    ["a zero interval", ["--watch", "--interval", "0"]],
    ["a fractional interval", ["--watch", "--interval", "7.5"]],
    ["a negative interval", ["--watch", "--interval", "-10"]],
    ["a non-numeric interval", ["--watch", "--interval", "fast"]],
    ["--interval without a value", ["--watch", "--interval"]],
    ["--interval without --watch", ["--interval", "10"]],
    ["an unknown flag", ["--wacth"]],
    ["a stray value", ["--watch", "10"]],
  ])("refuses %s", (_title, argv) => {
    expect(parseTickArgs(argv, simulating).kind).toBe("invalid");
  });

  it.each([
    ["a zero volume", ["--watch", "--volume", "0"]],
    ["a negative volume", ["--watch", "--volume", "-1"]],
    ["a fractional volume", ["--watch", "--volume", "1.5"]],
    ["a volume above the maximum of 20", ["--watch", "--volume", "21"]],
    ["a non-numeric volume", ["--watch", "--volume", "lots"]],
    ["--volume without a value", ["--watch", "--volume"]],
    ["--volume without --watch", ["--volume", "10"]],
  ])("refuses %s, naming --volume", (_title, argv) => {
    expect(parseTickArgs(argv, simulating)).toEqual({ kind: "invalid", message: expect.stringContaining("--volume") });
  });

  it.each([["1"], ["10"]])("refuses --volume %s with simulation off, naming the setting that turns it on", (volume) => {
    expect(parseTickArgs(["--watch", "--volume", volume], { simulationEnabled: false })).toEqual({
      kind: "invalid",
      message: expect.stringContaining("Add STACKDASH_SIMULATE_PROVIDERS=1 to .env.local"),
    });
  });
});

type Harness = { deps: WatchDeps; lines: string[]; calls: string[]; controller: AbortController };

function harness(options: {
  simulating: boolean;
  ticks: number;
  tick?: () => Promise<WatchTick>;
  // How many connections each successive markSimulatedDue call made due; the last value repeats.
  dueCounts?: readonly number[];
}): Harness {
  const lines: string[] = [];
  const calls: string[] = [];
  const controller = new AbortController();
  let ticks = 0;
  const deps: WatchDeps = {
    tick:
      options.tick ??
      (async () => {
        calls.push("tick");
        ticks += 1;
        // Ctrl+C arrives while the last tick is running: that tick still finishes and prints.
        if (ticks === options.ticks) controller.abort();
        return { result: RESULT, eventsWritten: 4 };
      }),
    simulationEnabled: () => options.simulating,
    markSimulatedDue: async () => {
      calls.push("markDue");
      const counts = options.dueCounts ?? [1];
      const marked = calls.filter((call) => call === "markDue").length;
      return counts[Math.min(marked, counts.length) - 1] ?? 1;
    },
    now: () => NOW,
    sleep: async (ms) => {
      calls.push(`sleep ${ms}`);
    },
    print: (line) => lines.push(line),
    signal: controller.signal,
  };
  return { deps, lines, calls, controller };
}

describe("runWatch", () => {
  it("marks simulated connections due before every tick, sleeps the interval, and prints one line per tick", async () => {
    const { deps, lines, calls } = harness({ simulating: true, ticks: 3 });
    await runWatch(deps, { intervalSeconds: 12, volume: 1 });
    expect(calls).toEqual(["markDue", "tick", "sleep 12000", "markDue", "tick", "sleep 12000", "markDue", "tick"]);
    const tickLines = lines.filter((line) => line.startsWith(NOW.toISOString()));
    expect(tickLines).toEqual(Array.from({ length: 3 }, () => formatTickLine(NOW, { result: RESULT, eventsWritten: 4 })));
    expect(lines.at(-1)).toBe("Stopped.");
  });

  it("stops after the tick in progress when the signal aborts, without sleeping again", async () => {
    const { deps, calls, lines } = harness({ simulating: true, ticks: 1 });
    await runWatch(deps, { intervalSeconds: 10, volume: 1 });
    expect(calls).toEqual(["markDue", "tick"]);
    expect(lines.filter((line) => line.startsWith(`${NOW.toISOString()} synced`))).toHaveLength(1);
  });

  it("never starts a tick when stopped before the first one", async () => {
    const { deps, calls, controller } = harness({ simulating: true, ticks: 1 });
    controller.abort();
    await runWatch(deps, { intervalSeconds: 10, volume: 1 });
    expect(calls).toEqual([]);
  });

  it("with simulation off, says so once and runs the normal tick without marking anything due", async () => {
    const { deps, calls, lines } = harness({ simulating: false, ticks: 2 });
    await runWatch(deps, { intervalSeconds: 10, volume: 1 });
    expect(calls).toEqual(["tick", "sleep 10000", "tick"]);
    expect(lines.filter((line) => line.includes("Provider simulation is off"))).toHaveLength(1);
    // The one setting that turns streaming on, and that a running watcher must be restarted.
    expect(lines.filter((line) => line.includes("add STACKDASH_SIMULATE_PROVIDERS=1 to .env.local, restart this watcher"))).toHaveLength(1);
  });

  it("with simulation on but no active simulated connection, says how to connect one, once", async () => {
    const { deps, lines } = harness({ simulating: true, ticks: 3, dueCounts: [0] });
    await runWatch(deps, { intervalSeconds: 10, volume: 1 });
    expect(lines.filter((line) => line.startsWith("No active simulated connection"))).toHaveLength(1);
    expect(lines.some((line) => line.includes("STACKDASH_SIMULATE_PROVIDERS=1"))).toBe(false);
  });

  it("stays quiet once a simulated connection is active, and says it again only if none is", async () => {
    const { deps, lines } = harness({ simulating: true, ticks: 4, dueCounts: [0, 2, 2, 0] });
    await runWatch(deps, { intervalSeconds: 10, volume: 1 });
    expect(lines.filter((line) => line.startsWith("No active simulated connection"))).toHaveLength(2);
  });

  it.each([1, 10])("names volume %i in the startup line while simulating", async (volume) => {
    const { deps, lines } = harness({ simulating: true, ticks: 1 });
    await runWatch(deps, { intervalSeconds: 10, volume });
    expect(lines[0]).toBe(
      `Watching: a tick every 10 seconds at volume ${volume}, with simulated connections synced on every tick. Press Ctrl+C to stop.`,
    );
  });

  it("prints a failed tick and keeps going", async () => {
    let attempt = 0;
    const control: { controller?: AbortController } = {};
    const { deps, lines, controller } = harness({
      simulating: false,
      ticks: 0,
      tick: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("Job store claim_sync_jobs failed (code 57014).");
        control.controller?.abort();
        return { result: RESULT, eventsWritten: 0 };
      },
    });
    control.controller = controller;
    await runWatch(deps, { intervalSeconds: 10, volume: 1 });
    expect(lines).toContain(`${NOW.toISOString()} tick failed: Job store claim_sync_jobs failed (code 57014).`);
    expect(lines.filter((line) => line.startsWith(`${NOW.toISOString()} synced`))).toHaveLength(1);
  });
});

describe("formatTickLine", () => {
  it("prints the time and counts only", () => {
    expect(formatTickLine(NOW, { result: RESULT, eventsWritten: 4 })).toBe(
      "2026-11-04T21:30:00.000Z synced 2, events written 4, failed 1, retrying 0",
    );
  });
});

describe("countingEventWrites", () => {
  function event(dedupeKey: string): EventRow {
    return {
      workspace_id: "w1",
      connection_id: "c1",
      external_account_id: null,
      provider: "stripe",
      type_id: "stripe.charge.succeeded",
      severity: "success",
      title: "Payment succeeded",
      body: null,
      url: null,
      occurred_at: NOW.toISOString(),
      dedupe_key: dedupeKey,
    };
  }

  it("counts only the events that were new, and passes every other call through", async () => {
    const store = new MemoryJobStore(() => NOW);
    const counter = { written: 0 };
    const counted = countingEventWrites(store, counter);
    expect(await counted.insertEvents([event("a"), event("b")])).toBe(2);
    expect(await counted.insertEvents([event("b"), event("c")])).toBe(1);
    expect(await counted.insertEvents([])).toBe(0);
    expect(counter.written).toBe(3);
    expect(store.events).toHaveLength(3);
    // A class store keeps working through the proxy, private fields included.
    expect(await counted.purgeEvents(new Date("2027-01-01T00:00:00Z"), 10)).toBe(3);
  });
});

describe("markSimulatedSyncsDue (memory store, mirroring the Postgres one)", () => {
  it("makes every active simulated connection due and counts them, never touching a real one of the same provider", async () => {
    const store = new MemoryJobStore(() => NOW);
    const later = "2026-11-04T21:31:00.000Z";
    const simulated = { granted_scopes: [SIMULATED_SCOPE], next_sync_at: later };
    const stripe = store.addConnection({ workspace_id: "w1", provider: "stripe", ...simulated });
    const failed = store.addConnection({ workspace_id: "w1", provider: "stripe", status: "failed", ...simulated });
    const realVercel = store.addConnection({
      workspace_id: "w1",
      provider: "vercel",
      granted_scopes: ["read:project"],
      next_sync_at: later,
    });
    // Just connected: never scheduled, already due. It still counts, so the watcher is not told
    // that nothing is simulated on the very first tick after connecting.
    const neverScheduled = store.addConnection({ workspace_id: "w1", provider: "vercel", granted_scopes: [SIMULATED_SCOPE] });
    expect(await store.markSimulatedSyncsDue(NOW)).toBe(2);
    expect(stripe.next_sync_at).toBe(NOW.toISOString());
    expect(neverScheduled.next_sync_at).toBe(NOW.toISOString());
    expect(failed.next_sync_at).toBe(later);
    expect(realVercel.next_sync_at).toBe(later);
    // Every watch iteration asks again; the real connection is still never made due.
    expect(await store.markSimulatedSyncsDue(new Date(NOW.getTime() + 1000))).toBe(2);
    expect(realVercel.next_sync_at).toBe(later);
  });

  it("counts zero when only real connections exist", async () => {
    const store = new MemoryJobStore(() => NOW);
    store.addConnection({ workspace_id: "w1", provider: "fake", granted_scopes: ["usage:read"] });
    expect(await store.markSimulatedSyncsDue(NOW)).toBe(0);
  });
});

/** A connection the simulator made, with its credential, as connecting from the app leaves it. */
function addSimulatedConnection(store: MemoryJobStore, provider: LiveProviderId): { connectionId: string; credential: OAuthCredential } {
  const connection = store.addConnection({ workspace_id: "w1", provider, granted_scopes: [SIMULATED_SCOPE] });
  const credential: OAuthCredential = {
    accessToken: new Secret("simulated-at-test"),
    scopes: [SIMULATED_SCOPE],
    tokenType: "bearer",
    metadata: simulatedCredentialMetadata("5eed0a11"),
  };
  store.credentials.set(connection.id, credential);
  return { connectionId: connection.id, credential };
}

/** What the registry returns while simulation is on: the simulated twin of every live provider. */
function simulatedGetAdapter(id: ProviderId): ProviderAdapter {
  return id === "fake" ? fakeAdapter : simulatedAdapters[id];
}

function syncDeps(store: MemoryJobStore, getAdapter: SyncDeps["getAdapter"], now: () => Date = () => NOW): SyncDeps {
  return {
    store,
    getAdapter,
    loadOAuthClient: () => ({ clientId: "simulated", clientSecret: new Secret("simulated"), extra: {} }),
    createOAuthContext: (client) => ({
      client,
      fetch: () => Promise.reject(new Error("no network in tests")),
      now,
      timeoutMs: 1000,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }),
    now,
    random: () => 0.5,
    logError: () => "REF-TEST",
    log: { info: () => {}, warn: () => {}, error: () => {} },
    evaluateAlerts: async () => undefined,
    evaluateAchievements: async () => 0,
    addMissingSourceWebhooks: async () => 0,
    notifications: () => memoryNotificationDeps(),
  };
}

describe("runWatchTick", () => {
  it("syncs more simulated connections in one tick than the route's claim limit", async () => {
    const store = new MemoryJobStore(() => NOW);
    const count = TICK_CLAIM_LIMIT + 5;
    for (let index = 0; index < count; index += 1) addSimulatedConnection(store, "stripe");
    const deps = syncDeps(store, () => simulatedAdapters.stripe);

    const { result } = await runWatchTick(deps);

    expect(WATCH_CLAIM_LIMIT).toBeGreaterThan(count);
    expect(result.failed).toBe(0);
    const syncs = store.jobs.filter((job) => job.kind === "sync");
    expect(syncs).toHaveLength(count);
    expect(syncs.every((job) => job.status === "succeeded")).toBe(true);
  });
});

describe("withSimulatedEventVolume", () => {
  it("hands back the registry's own simulated adapters at volume 1", () => {
    const deps = withSimulatedEventVolume(syncDeps(new MemoryJobStore(() => NOW), simulatedGetAdapter), 1);
    expect(deps.getAdapter("stripe")).toBe(simulatedAdapters.stripe);
  });

  it("swaps each simulated adapter for the same provider's at the volume, built once", () => {
    const deps = withSimulatedEventVolume(syncDeps(new MemoryJobStore(() => NOW), simulatedGetAdapter), 10);
    const stripe = deps.getAdapter("stripe");
    expect(stripe).not.toBe(simulatedAdapters.stripe);
    expect(stripe.id).toBe("stripe");
    expect(isSimulatedAdapter(stripe)).toBe(true);
    expect(deps.getAdapter("stripe")).toBe(stripe);
    expect(deps.getAdapter("vercel").id).toBe("vercel");
  });

  it("returns real adapters and the fake adapter unchanged", () => {
    const real = (id: ProviderId) => (id === "fake" ? fakeAdapter : stripeAdapter);
    const deps = withSimulatedEventVolume(syncDeps(new MemoryJobStore(() => NOW), real), 10);
    expect(deps.getAdapter("stripe")).toBe(stripeAdapter);
    expect(deps.getAdapter("fake")).toBe(fakeAdapter);
  });
});

describe("a watch window at a higher volume", () => {
  const providers: readonly LiveProviderId[] = ["vercel", "github", "stripe", "resend", "sentry"];

  /** Six watch iterations over one simulated connection per provider, every account included, as runWatch drives them. */
  async function watchWindow(volume: number): Promise<{ written: number; claimed: number; stored: number }> {
    let now = NOW;
    const clock = () => now;
    const store = new MemoryJobStore(clock);
    const base = syncDeps(store, simulatedGetAdapter, clock);
    const ctx = base.createOAuthContext({ clientId: "simulated", clientSecret: new Secret("simulated"), extra: {} });
    for (const provider of providers) {
      const { connectionId, credential } = addSimulatedConnection(store, provider);
      for (const account of await simulatedAdapters[provider].listAccounts(credential, ctx)) {
        store.addAccount({ workspace_id: "w1", connection_id: connectionId, external_id: account.externalId });
      }
    }
    const deps = withSimulatedEventVolume(base, volume);
    let written = 0;
    let claimed = 0;
    for (let iteration = 0; iteration < 6; iteration += 1) {
      await store.markSimulatedSyncsDue(now);
      const { result, eventsWritten } = await runWatchTick(deps);
      expect(result.failed).toBe(0);
      written += eventsWritten;
      claimed += result.claimed;
      now = new Date(now.getTime() + WATCH_DEFAULT_INTERVAL_SECONDS * 1000);
    }
    return { written, claimed, stored: store.events.length };
  }

  it("writes more timeline events at volume 10 than at volume 1, claiming the same jobs", async () => {
    const usual = await watchWindow(1);
    const busy = await watchWindow(10);
    expect(busy.claimed).toBe(usual.claimed);
    expect(usual.written).toBeGreaterThan(0);
    expect(busy.written).toBeGreaterThan(usual.written);
    expect(busy.stored).toBe(busy.written);
  });
});

describe("abortableSleep", () => {
  it("resolves early when the signal aborts", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let done = false;
      const sleeping = abortableSleep(60_000, controller.signal).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(done).toBe(false);
      controller.abort();
      await sleeping;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves after the full time when nothing aborts", async () => {
    vi.useFakeTimers();
    try {
      let done = false;
      const sleeping = abortableSleep(5_000, new AbortController().signal).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(4_999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await sleeping;
      expect(done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("watchUntilStopped", () => {
  function watchDeps(signals: EventEmitter, lines: string[]): Omit<WatchDeps, "signal"> {
    let ticks = 0;
    return {
      tick: async () => {
        ticks += 1;
        // Ctrl+C arrives while the second tick is running: that tick still finishes and prints.
        if (ticks === 2) signals.emit("SIGINT");
        return { result: RESULT, eventsWritten: 4 };
      },
      simulationEnabled: () => true,
      markSimulatedDue: async () => 1,
      now: () => NOW,
      sleep: async () => {},
      print: (line) => lines.push(line),
    };
  }

  it("stops after the tick in progress on Ctrl+C and lets go of the signals", async () => {
    const signals = new EventEmitter();
    const lines: string[] = [];
    await watchUntilStopped(watchDeps(signals, lines), { intervalSeconds: 10, volume: 1 }, signals);
    expect(lines.filter((line) => line.startsWith(`${NOW.toISOString()} synced`))).toHaveLength(2);
    expect(lines.at(-1)).toBe("Stopped.");
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("stops on SIGTERM too", async () => {
    const signals = new EventEmitter();
    const lines: string[] = [];
    const deps = { ...watchDeps(signals, lines), tick: async () => {
      signals.emit("SIGTERM");
      return { result: RESULT, eventsWritten: 0 };
    } };
    await watchUntilStopped(deps, { intervalSeconds: 10, volume: 1 }, signals);
    expect(lines.at(-1)).toBe("Stopped.");
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });
});
