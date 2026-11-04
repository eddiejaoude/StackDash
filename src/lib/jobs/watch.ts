import { runTick, type TickResult } from "./runner";
import type { JobStore } from "./store";
import type { SyncDeps } from "./sync-connection";

/*
 * `npm run jobs:tick -- --watch` (#131): runs the normal tick in a loop for local use, so open
 * screens keep updating. With provider simulation on, each iteration first makes the simulated
 * connections due, so they sync every few seconds instead of once a minute. Everything it touches
 * (the tick, the clock, sleeping, output, the stop signal) is injected so the loop is tested
 * without a database.
 */

export const WATCH_DEFAULT_INTERVAL_SECONDS = 10;
export const WATCH_MIN_INTERVAL_SECONDS = 5;
// Jobs one watch tick claims, instead of the route's TICK_CLAIM_LIMIT (10), so every simulated
// connection of a local instance syncs on every tick. Bounded all the same; jobs left when the
// tick's time budget runs out go back to the queue unstarted, as in any tick.
export const WATCH_CLAIM_LIMIT = 100;

export type TickArgs =
  | { kind: "once" }
  | { kind: "watch"; intervalSeconds: number }
  | { kind: "invalid"; message: string };

const USAGE = "Usage: npm run jobs:tick [-- --watch [--interval <seconds>]]";

/** Parses the script's arguments. Anything it does not know is refused, so a typo never runs. */
export function parseTickArgs(argv: readonly string[]): TickArgs {
  let watch = false;
  let interval: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--watch") watch = true;
    else if (arg === "--interval") {
      interval = argv[index + 1];
      if (interval === undefined) return { kind: "invalid", message: `--interval needs a number of seconds. ${USAGE}` };
      index += 1;
    } else return { kind: "invalid", message: `Unknown argument ${JSON.stringify(arg)}. ${USAGE}` };
  }
  if (!watch) return interval === undefined ? { kind: "once" } : { kind: "invalid", message: `--interval needs --watch. ${USAGE}` };
  if (interval === undefined) return { kind: "watch", intervalSeconds: WATCH_DEFAULT_INTERVAL_SECONDS };
  const seconds = /^\d+$/.test(interval) ? Number(interval) : Number.NaN;
  if (!Number.isSafeInteger(seconds) || seconds < WATCH_MIN_INTERVAL_SECONDS) {
    return { kind: "invalid", message: `--interval must be a whole number of seconds, at least ${WATCH_MIN_INTERVAL_SECONDS}.` };
  }
  return { kind: "watch", intervalSeconds: seconds };
}

/** `store` with every `insertEvents` result added to `counter.written`; everything else passes through. */
export function countingEventWrites(store: JobStore, counter: { written: number }): JobStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "insertEvents") {
        const insertEvents: JobStore["insertEvents"] = async (rows) => {
          const written = await target.insertEvents(rows);
          counter.written += written;
          return written;
        };
        return insertEvents;
      }
      const value: unknown = Reflect.get(target, property, target);
      // Bound to the real store, so class stores keep their private fields.
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export type WatchTick = Readonly<{ result: TickResult; eventsWritten: number }>;

/** One normal tick claiming up to WATCH_CLAIM_LIMIT jobs, with the number of new timeline events it wrote. */
export async function runWatchTick(deps: SyncDeps): Promise<WatchTick> {
  const counter = { written: 0 };
  const result = await runTick({ ...deps, store: countingEventWrites(deps.store, counter) }, { claimLimit: WATCH_CLAIM_LIMIT });
  return { result, eventsWritten: counter.written };
}

export type WatchDeps = Readonly<{
  /** One normal tick, with the number of new timeline events it wrote. */
  tick: () => Promise<WatchTick>;
  /** Read every iteration: true while this process simulates providers. */
  simulationEnabled: () => boolean;
  /** Makes the simulated connections due now; only called while simulation is enabled. */
  markSimulatedDue: () => Promise<number>;
  now: () => Date;
  /** Waits `ms`, or less when `signal` aborts. */
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  print: (line: string) => void;
  /** Aborted on SIGINT or SIGTERM: the loop stops after the tick in progress. */
  signal: AbortSignal;
}>;

/** One line per tick: when, and counts only. Never data, ids, or secrets. */
export function formatTickLine(at: Date, tick: WatchTick): string {
  const { result, eventsWritten } = tick;
  return `${at.toISOString()} synced ${result.succeeded}, events written ${eventsWritten}, failed ${result.failed}, retrying ${result.retried}`;
}

export async function runWatch(deps: WatchDeps, intervalSeconds: number): Promise<void> {
  const simulating = deps.simulationEnabled();
  deps.print(
    simulating
      ? `Watching: a tick every ${intervalSeconds} seconds, with simulated connections synced on every tick. Press Ctrl+C to stop.`
      : `Watching: a tick every ${intervalSeconds} seconds. Provider simulation is off, so connections sync only when they are due. Press Ctrl+C to stop.`,
  );

  while (!deps.signal.aborted) {
    try {
      if (deps.simulationEnabled()) await deps.markSimulatedDue();
      const tick = await deps.tick();
      deps.print(formatTickLine(deps.now(), tick));
    } catch (error) {
      // Store errors carry Postgres codes only, never row data or secrets. The next tick tries again.
      const reason = error instanceof Error && error.message.length > 0 ? error.message : "unknown error";
      deps.print(`${deps.now().toISOString()} tick failed: ${reason}`);
    }
    if (deps.signal.aborted) break;
    await deps.sleep(intervalSeconds * 1000, deps.signal);
  }
  deps.print("Stopped.");
}

/** setTimeout that resolves early, without throwing, when `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  if (signal.aborted) {
    resolve();
    return promise;
  }
  const onAbort = () => {
    clearTimeout(timer);
    resolve();
  };
  const timer = setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  signal.addEventListener("abort", onAbort, { once: true });
  return promise;
}
