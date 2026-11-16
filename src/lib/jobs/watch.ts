import { isProviderSimulationEnabled, isSimulatedAdapter, SIMULATE_PROVIDERS_ENV, simulatedAdaptersAtVolume } from "@/lib/adapters/simulated";
import { DEFAULT_EVENT_VOLUME, MAX_EVENT_VOLUME } from "@/lib/adapters/simulated/simulation";

import { runTick, type TickResult } from "./runner";
import type { JobStore } from "./store";
import type { SyncDeps } from "./sync-connection";

/*
 * `npm run jobs:tick -- --watch` (#131), also started by `npm run demo` once it has seeded (#260):
 * runs the normal tick in a loop for local use, so open screens keep updating. With provider
 * simulation on, each iteration first makes the simulated connections due, so they sync every few
 * seconds instead of once a minute, and `--volume` (#383) multiplies how many timeline events they
 * make, so open screens fill faster. Everything it touches (the tick, the clock, sleeping, output,
 * the stop signal) is injected so the loop is tested without a database.
 */

export const WATCH_DEFAULT_INTERVAL_SECONDS = 10;
export const WATCH_MIN_INTERVAL_SECONDS = 5;
// Jobs of every kind but `webhook` one watch tick claims, instead of the route's TICK_CLAIM_LIMIT
// (10), so every simulated connection of a local instance syncs on every tick; `webhook` jobs keep
// their own WEBHOOK_TICK_CLAIM_LIMIT (50) on top. Bounded all the same; jobs left when the tick's
// time budget runs out go back to the queue unstarted, as in any tick.
export const WATCH_CLAIM_LIMIT = 100;

export type TickArgs =
  | { kind: "once" }
  | { kind: "watch"; intervalSeconds: number; volume: number }
  | { kind: "invalid"; message: string };

const USAGE = `Usage: npm run jobs:tick [-- --watch [--interval <seconds>] [--volume <${DEFAULT_EVENT_VOLUME}-${MAX_EVENT_VOLUME}>]]`;

/**
 * Parses the script's arguments. Anything it does not know is refused, so a typo never runs.
 * `simulationEnabled` is the process's provider simulation setting, passed in so this stays pure:
 * `--volume` only scales simulated events, so it is refused while simulation is off.
 */
export function parseTickArgs(argv: readonly string[], context: Readonly<{ simulationEnabled: boolean }>): TickArgs {
  let watch = false;
  let interval: string | undefined;
  let volume: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--watch") watch = true;
    else if (arg === "--interval") {
      interval = argv[index + 1];
      if (interval === undefined) return { kind: "invalid", message: `--interval needs a number of seconds. ${USAGE}` };
      index += 1;
    } else if (arg === "--volume") {
      volume = argv[index + 1];
      if (volume === undefined) {
        return { kind: "invalid", message: `--volume needs a multiplier from ${DEFAULT_EVENT_VOLUME} to ${MAX_EVENT_VOLUME}. ${USAGE}` };
      }
      index += 1;
    } else return { kind: "invalid", message: `Unknown argument ${JSON.stringify(arg)}. ${USAGE}` };
  }
  if (!watch) {
    if (interval !== undefined) return { kind: "invalid", message: `--interval needs --watch. ${USAGE}` };
    if (volume !== undefined) return { kind: "invalid", message: `--volume needs --watch. ${USAGE}` };
    return { kind: "once" };
  }

  let intervalSeconds = WATCH_DEFAULT_INTERVAL_SECONDS;
  if (interval !== undefined) {
    intervalSeconds = /^\d+$/.test(interval) ? Number(interval) : Number.NaN;
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < WATCH_MIN_INTERVAL_SECONDS) {
      return { kind: "invalid", message: `--interval must be a whole number of seconds, at least ${WATCH_MIN_INTERVAL_SECONDS}.` };
    }
  }

  if (volume === undefined) return { kind: "watch", intervalSeconds, volume: DEFAULT_EVENT_VOLUME };
  // Any explicit --volume, even 1, so nobody believes a volume applies to real providers.
  if (!context.simulationEnabled) {
    return {
      kind: "invalid",
      message: `--volume scales simulated events only, and provider simulation is off. Add ${SIMULATE_PROVIDERS_ENV}=1 to .env.local and run the command again, or leave out --volume.`,
    };
  }
  const multiplier = /^\d+$/.test(volume) ? Number(volume) : Number.NaN;
  if (!Number.isSafeInteger(multiplier) || multiplier < DEFAULT_EVENT_VOLUME || multiplier > MAX_EVENT_VOLUME) {
    return {
      kind: "invalid",
      message: `--volume must be a whole number from ${DEFAULT_EVENT_VOLUME} to ${MAX_EVENT_VOLUME}, for example --volume 10.`,
    };
  }
  return { kind: "watch", intervalSeconds, volume: multiplier };
}

/**
 * `deps` with every simulated adapter `getAdapter` returns swapped for the same provider's adapter
 * at `volume` (#383). Real adapters and the fake one pass through, so a volume never touches real
 * data; at the default volume `deps` is returned as is.
 */
export function withSimulatedEventVolume(deps: SyncDeps, volume: number): SyncDeps {
  if (volume === DEFAULT_EVENT_VOLUME) return deps;
  const scaled = simulatedAdaptersAtVolume(volume);
  return {
    ...deps,
    getAdapter: (id) => {
      const adapter = deps.getAdapter(id);
      return adapter.id !== "fake" && isSimulatedAdapter(adapter) ? scaled[adapter.id] : adapter;
    },
  };
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

/**
 * One normal tick claiming up to WATCH_CLAIM_LIMIT jobs of every kind but `webhook` (whose claim
 * stays at WEBHOOK_TICK_CLAIM_LIMIT), with the number of new timeline events it wrote.
 */
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
  /** Makes the active simulated connections due now and returns how many; zero means none is active. */
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

export type WatchOptions = Readonly<{
  intervalSeconds: number;
  /** The simulated event volume the deps' adapters run at, shown in the startup line. */
  volume: number;
}>;

export async function runWatch(deps: WatchDeps, options: WatchOptions): Promise<void> {
  const { intervalSeconds, volume } = options;
  const simulating = deps.simulationEnabled();
  deps.print(
    simulating
      ? `Watching: a tick every ${intervalSeconds} seconds at volume ${volume}, with simulated connections synced on every tick. Press Ctrl+C to stop.`
      : `Watching: a tick every ${intervalSeconds} seconds. Provider simulation is off, so connections sync only when they are due. Press Ctrl+C to stop.`,
  );
  if (!simulating) deps.print(SIMULATION_OFF_HINT);

  // Printed when the tick has no active simulated connection to sync, and again only after that
  // changes, so a watcher is told why nothing arrives instead of seeing `synced 0` forever.
  let warnedNoSimulated = false;
  while (!deps.signal.aborted) {
    try {
      if (deps.simulationEnabled()) {
        const due = await deps.markSimulatedDue();
        if (due === 0 && !warnedNoSimulated) deps.print(NO_SIMULATED_CONNECTIONS_HINT);
        warnedNoSimulated = due === 0;
      }
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

/** The live wiring for `runWatch` around the job deps a script made, printing through `print`. */
export function liveWatchDeps(deps: SyncDeps, print: (line: string) => void): Omit<WatchDeps, "signal"> {
  return {
    tick: () => runWatchTick(deps),
    simulationEnabled: isProviderSimulationEnabled,
    // Only connections the simulator made (by their granted scope), never a real connection,
    // whatever its provider: the simulated adapters refuse real credentials.
    markSimulatedDue: () => deps.store.markSimulatedSyncsDue(new Date()),
    now: () => new Date(),
    sleep: abortableSleep,
    print,
  };
}

/** Where Ctrl+C (SIGINT) and SIGTERM arrive: the process, or an emitter in tests. */
export type StopSignals = Readonly<{
  once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}>;

/**
 * `runWatch` until Ctrl+C or SIGTERM, which stop it after the tick in progress. The listeners go
 * when it returns, so a second Ctrl+C after "Stopped." ends the process as usual.
 */
export async function watchUntilStopped(deps: Omit<WatchDeps, "signal">, options: WatchOptions, signals: StopSignals = process): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signals.once("SIGINT", stop);
  signals.once("SIGTERM", stop);
  try {
    await runWatch({ ...deps, signal: controller.signal }, options);
  } finally {
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
  }
}

const SIMULATION_OFF_HINT =
  "Due means hourly for most providers and every 15 minutes for Supabase, and the Example provider adds two events a day. To stream data, add STACKDASH_SIMULATE_PROVIDERS=1 to .env.local, restart this watcher and npm run dev, then connect Vercel, GitHub, Resend, Stripe, or Supabase from Connections in the app.";

const NO_SIMULATED_CONNECTIONS_HINT =
  "No active simulated connection, so there is nothing to stream. Connect Vercel, GitHub, Resend, Stripe, or Supabase from Connections in the app (they show Simulated), or reconnect the ones that need attention from their connection pages. The Example provider is not simulated.";

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
