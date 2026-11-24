/**
 * When to refresh a workspace page after Realtime reports a change (#129).
 *
 * A sync writes in a burst of statements: its snapshots, its events, then the connection's status,
 * each one message (#628). Refreshing per message would re-render the page several times for one
 * sync, so changes are coalesced with a trailing debounce, and a maximum wait stops a continuous
 * stream from putting the refresh off forever. A hidden tab does not refresh at all; it refreshes
 * once when it becomes visible again, so a background tab never re-renders for nobody. A page can
 * hold refreshes the same way (`createRefreshHolds`): changes wait until the last hold is
 * released, then refresh once.
 *
 * The maximum wait bounds latency, not load: every refresh renders the whole workspace route on
 * the server again, and nothing in the router stops a second one starting before the first has
 * landed (#309). So only one refresh runs at a time. Changes flushed while it runs queue a single
 * trailing refresh, started when the running one settles; however fast changes arrive, at most one
 * refresh is running and one is waiting. A refresh that never settles stops counting as running
 * after `REFRESH_MAX_IN_FLIGHT_MS`, so a stalled request delays live updates but cannot stop them.
 *
 * Pure apart from the timers, so the component owns the browser APIs and the tests use fake timers.
 */

export const REFRESH_DEBOUNCE_MS = 750;
export const REFRESH_MAX_WAIT_MS = 3_000;
// How long a refresh may stay in flight before the scheduler stops waiting for it. `settled()`
// arrives once the refreshed payload is on screen, which takes well under a second on the local
// server (#309) and 4 s in the slow-server measurement there; e2e/fixtures/realtime.ts allows
// 15 s for delivery, the debounce, and one render together. A refresh still open after that has
// stalled (a held connection, a function hanging to its platform limit), and waiting longer would
// leave every later change queued with nothing shown. Expiring early costs one overlapping render,
// which is what every refresh did before #309.
export const REFRESH_MAX_IN_FLIGHT_MS = 15_000;

export type RefreshSchedulerOptions = {
  /** Starts a refresh. The caller reports its end with `settled()`. */
  refresh: () => void;
  /**
   * Whether refreshes must wait right now: the tab is hidden (`document.visibilityState`), or the
   * page holds them (`RefreshHolds.held`).
   */
  isPaused: () => boolean;
};

export type RefreshScheduler = {
  /** A change arrived. */
  notify: () => void;
  /**
   * Call whenever `isPaused` may have changed: on every `visibilitychange`, and when the last hold
   * is released. Requests one refresh if changes arrived while paused, queued behind a running one.
   */
  pauseChanged: () => void;
  /**
   * No refresh this scheduler started is still running: call it when every one has landed, the
   * way `useTransition`'s `isPending` turns false only once all of them have. It starts the refresh
   * queued behind them, if any. A refresh not settled within `REFRESH_MAX_IN_FLIGHT_MS` is treated
   * as settled, and may start a successor; a late `settled()` for the expired one is safe only
   * under this contract, because it cannot arrive before the successor has landed too. A caller
   * that reported each refresh separately would end the successor early and drop its limit.
   */
  settled: () => void;
  /** Cancels any pending, queued, or deferred refresh. Every later call does nothing. */
  dispose: () => void;
};

export function createRefreshScheduler({ refresh, isPaused }: RefreshSchedulerOptions): RefreshScheduler {
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  // Started by the first change of a burst and left running while later changes reset the debounce.
  let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
  let deferred = false;
  let inFlight = false;
  // Ends a refresh that never reports settling, so a stalled request cannot hold the queue.
  let inFlightTimer: ReturnType<typeof setTimeout> | undefined;
  // Changes flushed while a refresh runs, to refresh once more when it settles.
  let queued = false;
  let disposed = false;

  function clearTimers(): void {
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    debounceTimer = undefined;
    maxWaitTimer = undefined;
  }

  function request(): void {
    // The tab can be hidden, or the page can hold refreshes, between a change and its refresh.
    if (isPaused()) {
      deferred = true;
      return;
    }
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    inFlightTimer = setTimeout(settle, REFRESH_MAX_IN_FLIGHT_MS);
    refresh();
  }

  function settle(): void {
    clearTimeout(inFlightTimer);
    inFlightTimer = undefined;
    inFlight = false;
    if (!queued) return;
    queued = false;
    request();
  }

  function flush(): void {
    clearTimers();
    request();
  }

  return {
    notify() {
      if (disposed) return;
      if (isPaused()) {
        clearTimers();
        deferred = true;
        return;
      }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(flush, REFRESH_DEBOUNCE_MS);
      maxWaitTimer ??= setTimeout(flush, REFRESH_MAX_WAIT_MS);
    },
    pauseChanged() {
      if (disposed || !deferred || isPaused()) return;
      deferred = false;
      request();
    },
    settled() {
      if (disposed) return;
      settle();
    },
    dispose() {
      disposed = true;
      deferred = false;
      queued = false;
      clearTimers();
      clearTimeout(inFlightTimer);
    },
  };
}

export type RefreshHolds = Readonly<{
  /** Holds refreshes until the returned function runs. Running it again does nothing. */
  hold: () => () => void;
  /** Whether any hold is in place. */
  held: () => boolean;
  /** Runs `listener` each time the last hold is released; returns the unsubscribe function. */
  onReleased: (listener: () => void) => () => void;
}>;

/**
 * Holds that make live refreshes wait, for a page whose URL can say something the router has not
 * rendered (the timeline's event details, #477). Each hold is released once, so a release that
 * runs twice cannot end another component's hold.
 */
export function createRefreshHolds(): RefreshHolds {
  const holds = new Set<symbol>();
  const listeners = new Set<() => void>();
  return {
    hold() {
      const hold = Symbol("refresh hold");
      holds.add(hold);
      return () => {
        if (!holds.delete(hold) || holds.size > 0) return;
        for (const listener of listeners) listener();
      };
    },
    held: () => holds.size > 0,
    onReleased(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
