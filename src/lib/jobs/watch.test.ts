import { describe, expect, it, vi } from "vitest";

import { MemoryJobStore } from "./memory-store";
import type { TickResult } from "./runner";
import type { EventRow } from "./store";
import {
  abortableSleep,
  countingEventWrites,
  formatTickLine,
  parseTickArgs,
  runWatch,
  WATCH_DEFAULT_INTERVAL_SECONDS,
  type WatchDeps,
  type WatchTick,
} from "./watch";

const NOW = new Date("2026-11-04T21:30:00.000Z");

const RESULT: TickResult = {
  syncsQueued: 2,
  retentionQueued: false,
  summariesQueued: 0,
  claimed: 3,
  succeeded: 2,
  retried: 0,
  failed: 1,
  released: 0,
};

describe("parseTickArgs", () => {
  it.each([
    ["no arguments: one tick, as before", [], { kind: "once" }],
    ["--watch: the default interval", ["--watch"], { kind: "watch", intervalSeconds: WATCH_DEFAULT_INTERVAL_SECONDS }],
    ["--watch --interval 30", ["--watch", "--interval", "30"], { kind: "watch", intervalSeconds: 30 }],
    ["the interval first", ["--interval", "5", "--watch"], { kind: "watch", intervalSeconds: 5 }],
  ])("accepts %s", (_title, argv, expected) => {
    expect(parseTickArgs(argv)).toEqual(expected);
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
    expect(parseTickArgs(argv).kind).toBe("invalid");
  });
});

type Harness = { deps: WatchDeps; lines: string[]; calls: string[]; controller: AbortController };

function harness(options: { simulating: boolean; ticks: number; tick?: () => Promise<WatchTick> }): Harness {
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
      return 1;
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
    await runWatch(deps, 12);
    expect(calls).toEqual(["markDue", "tick", "sleep 12000", "markDue", "tick", "sleep 12000", "markDue", "tick"]);
    const tickLines = lines.filter((line) => line.startsWith(NOW.toISOString()));
    expect(tickLines).toEqual(Array.from({ length: 3 }, () => formatTickLine(NOW, { result: RESULT, eventsWritten: 4 })));
    expect(lines.at(-1)).toBe("Stopped.");
  });

  it("stops after the tick in progress when the signal aborts, without sleeping again", async () => {
    const { deps, calls, lines } = harness({ simulating: true, ticks: 1 });
    await runWatch(deps, 10);
    expect(calls).toEqual(["markDue", "tick"]);
    expect(lines.filter((line) => line.startsWith(`${NOW.toISOString()} synced`))).toHaveLength(1);
  });

  it("never starts a tick when stopped before the first one", async () => {
    const { deps, calls, controller } = harness({ simulating: true, ticks: 1 });
    controller.abort();
    await runWatch(deps, 10);
    expect(calls).toEqual([]);
  });

  it("with simulation off, says so once and runs the normal tick without marking anything due", async () => {
    const { deps, calls, lines } = harness({ simulating: false, ticks: 2 });
    await runWatch(deps, 10);
    expect(calls).toEqual(["tick", "sleep 10000", "tick"]);
    expect(lines.filter((line) => line.includes("Provider simulation is off"))).toHaveLength(1);
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
    await runWatch(deps, 10);
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

describe("markSyncsDue (memory store, mirroring the Postgres one)", () => {
  it("pulls forward only active connections of the listed providers", async () => {
    const store = new MemoryJobStore(() => NOW);
    const later = "2026-11-04T21:31:00.000Z";
    const stripe = store.addConnection({ workspace_id: "w1", provider: "stripe", next_sync_at: later });
    const failed = store.addConnection({ workspace_id: "w1", provider: "stripe", status: "failed", next_sync_at: later });
    const fake = store.addConnection({ workspace_id: "w1", provider: "fake", next_sync_at: later });
    const neverScheduled = store.addConnection({ workspace_id: "w1", provider: "vercel" });
    expect(await store.markSyncsDue(["stripe", "vercel"], NOW)).toBe(1);
    expect(stripe.next_sync_at).toBe(NOW.toISOString());
    expect(failed.next_sync_at).toBe(later);
    expect(fake.next_sync_at).toBe(later);
    expect(neverScheduled.next_sync_at).toBeNull();
    expect(await store.markSyncsDue([], NOW)).toBe(0);
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
