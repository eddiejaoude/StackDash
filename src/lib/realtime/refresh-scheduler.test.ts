import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

import { createPendingChanges, type DueChanges, type LiveTable } from "./arrivals";
import {
  createRefreshHolds,
  createRefreshScheduler,
  REFRESH_DEBOUNCE_MS,
  REFRESH_MAX_IN_FLIGHT_MS,
  REFRESH_MAX_WAIT_MS,
  type RefreshScheduler,
} from "./refresh-scheduler";

function setup() {
  const page = { hidden: false };
  const refresh = vi.fn<() => boolean>(() => true);
  const scheduler = createRefreshScheduler({ refresh, isPaused: () => page.hidden });
  return { page, refresh, scheduler };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createRefreshScheduler", () => {
  it("refreshes once, exactly one debounce after a single change", () => {
    const { refresh, scheduler } = setup();
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS - 1);
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    // The max wait timer of the same burst must not fire a second refresh.
    vi.advanceTimersByTime(REFRESH_MAX_WAIT_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes once for 50 changes 40 ms apart: the burst ends before the max wait", () => {
    const { refresh, scheduler } = setup();
    // The last change lands at 1960 ms, so the debounce fires at 2710 ms, before the 3000 ms max
    // wait, and the flush cancels that max wait.
    for (let change = 0; change < 50; change += 1) {
      scheduler.notify();
      vi.advanceTimersByTime(40);
    }
    vi.runAllTimers();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("fires at the max wait while changes keep arriving faster than the debounce", () => {
    const { refresh, scheduler } = setup();
    const interval = REFRESH_DEBOUNCE_MS / 3;
    let elapsed = 0;
    while (elapsed < REFRESH_MAX_WAIT_MS - interval) {
      scheduler.notify();
      vi.advanceTimersByTime(interval);
      elapsed += interval;
    }
    expect(refresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REFRESH_MAX_WAIT_MS - elapsed);
    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.settled();

    // The stream goes on: the next burst gets its own max wait.
    for (let tick = 0; tick < REFRESH_MAX_WAIT_MS / interval; tick += 1) {
      scheduler.notify();
      vi.advanceTimersByTime(interval);
    }
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("starts a new burst after a refresh, so a later lone change refreshes again", () => {
    const { refresh, scheduler } = setup();
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    scheduler.settled();
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("defers changes that arrive in a hidden tab to one refresh when it becomes visible", () => {
    const { page, refresh, scheduler } = setup();
    page.hidden = true;
    scheduler.notify();
    scheduler.notify();
    scheduler.notify();
    vi.runAllTimers();
    expect(refresh).not.toHaveBeenCalled();

    // Still hidden: a visibility event that does not show the page changes nothing.
    scheduler.pauseChanged();
    expect(refresh).not.toHaveBeenCalled();

    page.hidden = false;
    scheduler.pauseChanged();
    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.pauseChanged();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("defers a pending refresh when the tab is hidden before the debounce ends", () => {
    const { page, refresh, scheduler } = setup();
    scheduler.notify();
    page.hidden = true;
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(refresh).not.toHaveBeenCalled();
    page.hidden = false;
    scheduler.pauseChanged();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on becoming visible when nothing changed while hidden", () => {
    const { refresh, scheduler } = setup();
    scheduler.pauseChanged();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("cancels a pending refresh on dispose and ignores every later call", () => {
    const { refresh, scheduler } = setup();
    scheduler.notify();
    scheduler.dispose();
    vi.runAllTimers();
    scheduler.notify();
    vi.runAllTimers();
    scheduler.pauseChanged();
    expect(refresh).not.toHaveBeenCalled();
  });

  it("drops a deferred refresh on dispose", () => {
    const { page, refresh, scheduler } = setup();
    page.hidden = true;
    scheduler.notify();
    scheduler.dispose();
    page.hidden = false;
    scheduler.pauseChanged();
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe("createRefreshScheduler single flight", () => {
  /** Lets one change through to a refresh that is still running when the test continues. */
  function startRefresh(scheduler: RefreshScheduler, refresh: Mock<() => boolean>): void {
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  }

  it("queues a change flushed while a refresh runs and starts exactly one refresh when it settles", () => {
    const { refresh, scheduler } = setup();
    startRefresh(scheduler, refresh);
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_MAX_WAIT_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.settled();
    expect(refresh).toHaveBeenCalledTimes(2);
    // The trailing refresh is itself in flight: its end starts nothing more.
    scheduler.settled();
    vi.runAllTimers();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  // The most flushes, one debounce apart, that fit inside one refresh's in-flight limit.
  const flushesWithinLimit = Math.floor((REFRESH_MAX_IN_FLIGHT_MS - REFRESH_DEBOUNCE_MS) / REFRESH_DEBOUNCE_MS);

  it.each([2, 5, flushesWithinLimit])("starts one trailing refresh for %i flushes during one running refresh", (flushes) => {
    const { refresh, scheduler } = setup();
    startRefresh(scheduler, refresh);
    for (let flush = 0; flush < flushes; flush += 1) {
      scheduler.notify();
      vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    }
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.settled();
    scheduler.settled();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("starts the queued refresh at the in-flight limit, not one millisecond before, when the running one never settles", () => {
    const { refresh, scheduler } = setup();
    startRefresh(scheduler, refresh);
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    // The running refresh started one debounce ago.
    vi.advanceTimersByTime(REFRESH_MAX_IN_FLIGHT_MS - REFRESH_DEBOUNCE_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(2);

    // The refresh the limit started gets a limit of its own.
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    vi.advanceTimersByTime(REFRESH_MAX_IN_FLIGHT_MS - REFRESH_DEBOUNCE_MS - 1);
    expect(refresh).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("frees the scheduler at the in-flight limit with nothing queued, so the next change refreshes", () => {
    const { refresh, scheduler } = setup();
    startRefresh(scheduler, refresh);
    vi.advanceTimersByTime(REFRESH_MAX_IN_FLIGHT_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("stops the in-flight limit when the refresh settles before it", () => {
    const { refresh, scheduler } = setup();
    startRefresh(scheduler, refresh);
    scheduler.settled();
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    // Had settling not cleared it, the first refresh's limit would fire during the next advance,
    // before the flush; the second refresh is still running, so the change queues.
    vi.advanceTimersByTime(REFRESH_MAX_IN_FLIGHT_MS - 2 * REFRESH_DEBOUNCE_MS);
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("starts nothing when a refresh settles with no change queued", () => {
    const { refresh, scheduler } = setup();
    startRefresh(scheduler, refresh);
    scheduler.settled();
    vi.runAllTimers();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does nothing when settled is called with no refresh running, as on mount", () => {
    const { refresh, scheduler } = setup();
    scheduler.settled();
    vi.runAllTimers();
    expect(refresh).not.toHaveBeenCalled();
    // Nor does it leave the scheduler thinking a refresh runs: the next change refreshes.
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("waits for the trailing refresh to settle before the next change refreshes", () => {
    const { refresh, scheduler } = setup();
    startRefresh(scheduler, refresh);
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    scheduler.settled();
    expect(refresh).toHaveBeenCalledTimes(2);

    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
    scheduler.settled();
    expect(refresh).toHaveBeenCalledTimes(3);
  });

  it("defers the trailing refresh to visibility when the tab is hidden as the running one settles", () => {
    const { page, refresh, scheduler } = setup();
    startRefresh(scheduler, refresh);
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    page.hidden = true;
    scheduler.settled();
    expect(refresh).toHaveBeenCalledTimes(1);

    page.hidden = false;
    scheduler.pauseChanged();
    expect(refresh).toHaveBeenCalledTimes(2);
    scheduler.pauseChanged();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("queues the deferred refresh when the tab becomes visible while a refresh runs", () => {
    const { page, refresh, scheduler } = setup();
    startRefresh(scheduler, refresh);
    page.hidden = true;
    scheduler.notify();
    page.hidden = false;
    scheduler.pauseChanged();
    expect(refresh).toHaveBeenCalledTimes(1);

    scheduler.settled();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("drops the queued refresh on dispose during a running refresh, so settled does nothing", () => {
    const { refresh, scheduler } = setup();
    startRefresh(scheduler, refresh);
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    scheduler.dispose();
    scheduler.settled();
    vi.runAllTimers();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves no refresh running when the due changes need none, so the next change refreshes on its own", () => {
    const { refresh, scheduler } = setup();
    refresh.mockReturnValueOnce(false);
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(1);
    // No settled() follows a refresh that never started, and none is waited for.
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("frees the scheduler when the trailing changes need no refresh", () => {
    const { refresh, scheduler } = setup();
    startRefresh(scheduler, refresh);
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    refresh.mockReturnValueOnce(false);
    scheduler.settled();
    expect(refresh).toHaveBeenCalledTimes(2);

    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(refresh).toHaveBeenCalledTimes(3);
  });
});

describe("createRefreshHolds", () => {
  /** A scheduler paused by the holds alone, wired the way LiveRefresh wires it. */
  function setupHeld() {
    const holds = createRefreshHolds();
    const refresh = vi.fn<() => boolean>(() => true);
    const scheduler = createRefreshScheduler({ refresh, isPaused: holds.held });
    holds.onReleased(() => scheduler.pauseChanged());
    return { holds, refresh, scheduler };
  }

  it("holds a change past the max wait and refreshes once when the hold is released", () => {
    const { holds, refresh, scheduler } = setupHeld();
    const release = holds.hold();
    scheduler.notify();
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_MAX_WAIT_MS * 2);
    expect(refresh).not.toHaveBeenCalled();

    release();
    expect(holds.held()).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("holds a debounce that was already running when the hold began", () => {
    const { holds, refresh, scheduler } = setupHeld();
    scheduler.notify();
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS - 1);
    const release = holds.hold();
    vi.advanceTimersByTime(1);
    expect(refresh).not.toHaveBeenCalled();
    release();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on release when nothing changed while held", () => {
    const { holds, refresh } = setupHeld();
    holds.hold()();
    vi.runAllTimers();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    { order: "the earlier hold first", earlierFirst: true },
    { order: "the later hold first", earlierFirst: false },
  ])("waits for the last of two holds, released $order", ({ earlierFirst }) => {
    const { holds, refresh, scheduler } = setupHeld();
    const earlier = holds.hold();
    const later = holds.hold();
    const [releasedFirst, releasedLast] = earlierFirst ? [earlier, later] : [later, earlier];
    scheduler.notify();
    releasedFirst();
    vi.runAllTimers();
    expect(holds.held()).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    releasedLast();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("ignores a release that runs twice, so it cannot end another hold", () => {
    const { holds, refresh, scheduler } = setupHeld();
    const first = holds.hold();
    const second = holds.hold();
    first();
    first();
    scheduler.notify();
    vi.runAllTimers();
    expect(holds.held()).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
    second();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("tells no listener once it has unsubscribed", () => {
    const holds = createRefreshHolds();
    const listener = vi.fn<() => void>();
    const unsubscribe = holds.onReleased(listener);
    holds.hold()();
    unsubscribe();
    holds.hold()();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

// Route-aware refresh (#650): a change the page does not read starts no refresh, and never costs a
// change it does read its refresh, however long the batch waits.
describe("createRefreshScheduler with pending changes", () => {
  const DASHBOARD = "/w/acme/dashboard";
  const TIMELINE = "/w/acme/timeline";
  const CONNECTIONS = "/w/acme/connections";

  /**
   * Pending changes and a scheduler on one page, wired the way LiveRefresh wires them when it
   * mounts there: over `skipped`, the workspace's set it shares with earlier mounts.
   */
  function setupPage(pathname: string, skipped = new Set<LiveTable>()) {
    const page = { hidden: false, pathname };
    const holds = createRefreshHolds();
    const pending = createPendingChanges(skipped);
    // What LiveRefresh hands the live indicator, and its `router.refresh()` calls.
    const arrivals: NonNullable<DueChanges["arrival"]>[] = [];
    const routerRefresh = vi.fn<() => void>();
    const scheduler = createRefreshScheduler({
      refresh: () => {
        const due = pending.take(page.pathname);
        if (due.arrival !== null) arrivals.push(due.arrival);
        if (!due.refresh) return false;
        routerRefresh();
        return true;
      },
      isPaused: () => page.hidden || holds.held(),
    });
    holds.onReleased(() => scheduler.pauseChanged());
    function hear(table: LiveTable): void {
      pending.heard({ changedAt: "2026-11-24T10:00:00.000000+00:00", connectionIds: [], table });
      scheduler.notify();
    }
    /**
     * Back or Forward to `to`, as LiveRefresh hears it on `popstate`: the browser's location names
     * `to` at once, and the pathname React renders stays on the page it left until the router
     * renders the step.
     */
    function popState(to: string): void {
      if (pending.landed(to)) scheduler.notify();
    }
    /** Back or Forward to `to`, rendered before the next batch is due. */
    function stepInHistory(to: string): void {
      popState(to);
      page.pathname = to;
    }
    // The step that mounted LiveRefresh fired its `popstate` before LiveRefresh listened.
    popState(pathname);
    return { page, holds, pending, arrivals, routerRefresh, scheduler, hear, popState, stepInHistory };
  }

  it("refreshes a page once for a change to a table it reads, and records the arrival", () => {
    const { arrivals, routerRefresh, hear } = setupPage(DASHBOARD);
    hear("triggered_alerts");
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(arrivals).toHaveLength(1);
  });

  it("records a change to a table the page does not read and refreshes nothing", () => {
    const { arrivals, routerRefresh, hear } = setupPage(CONNECTIONS);
    hear("triggered_alerts");
    vi.runAllTimers();
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(arrivals).toHaveLength(1);
  });

  it("refreshes once for a batch that mixes tables the page reads with tables it does not", () => {
    const { arrivals, routerRefresh, hear } = setupPage(CONNECTIONS);
    hear("triggered_alerts");
    hear("connections");
    hear("activity_events");
    vi.runAllTimers();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(arrivals).toHaveLength(1);
  });

  it("refreshes once when the tab shows again after an unread change and then a read one arrived while hidden", () => {
    const { page, arrivals, routerRefresh, scheduler, hear } = setupPage(CONNECTIONS);
    page.hidden = true;
    hear("triggered_alerts");
    vi.advanceTimersByTime(REFRESH_MAX_WAIT_MS);
    hear("connections");
    vi.runAllTimers();
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(arrivals).toEqual([]);

    page.hidden = false;
    scheduler.pauseChanged();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(arrivals).toHaveLength(1);
  });

  it("records but does not refresh when the tab shows again after only unread changes", () => {
    const { page, arrivals, routerRefresh, scheduler, hear } = setupPage(CONNECTIONS);
    page.hidden = true;
    hear("triggered_alerts");
    hear("activity_events");
    vi.runAllTimers();
    page.hidden = false;
    scheduler.pauseChanged();
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(arrivals).toHaveLength(1);
  });

  it("refreshes once on release after an unread change and then a read one arrived during a hold", () => {
    const { holds, arrivals, routerRefresh, hear } = setupPage(TIMELINE);
    const release = holds.hold();
    hear("usage_snapshots");
    vi.advanceTimersByTime(REFRESH_MAX_WAIT_MS);
    hear("activity_events");
    vi.runAllTimers();
    expect(routerRefresh).not.toHaveBeenCalled();

    release();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(arrivals).toHaveLength(1);
  });

  it("keeps a read change that arrives behind an unread one during a running refresh for the trailing refresh", () => {
    const { arrivals, routerRefresh, scheduler, hear } = setupPage(CONNECTIONS);
    hear("connections");
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    hear("triggered_alerts");
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    hear("connections");
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(routerRefresh).toHaveBeenCalledTimes(1);

    scheduler.settled();
    expect(routerRefresh).toHaveBeenCalledTimes(2);
    // The two changes that waited behind the first refresh arrive as one batch.
    expect(arrivals).toHaveLength(2);
  });

  it("records an unread change that waited behind a running refresh once it settles, and refreshes nothing more", () => {
    const { arrivals, routerRefresh, scheduler, hear } = setupPage(CONNECTIONS);
    hear("connections");
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    hear("triggered_alerts");
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(arrivals).toHaveLength(1);

    scheduler.settled();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(arrivals).toHaveLength(2);
    // Nothing is left running, so the next read change refreshes one debounce later.
    hear("connections");
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(routerRefresh).toHaveBeenCalledTimes(2);
  });

  it("refreshes for the changes missed while the channel was down, whatever the page reads", () => {
    const { arrivals, pending, routerRefresh, scheduler } = setupPage("/w/acme/settings");
    pending.missed();
    scheduler.notify();
    vi.runAllTimers();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(arrivals).toHaveLength(1);
  });

  it("refreshes the page Back returns to once when it reads a change the page before skipped", () => {
    const { arrivals, routerRefresh, scheduler, hear, stepInHistory } = setupPage(CONNECTIONS);
    hear("triggered_alerts");
    vi.runAllTimers();
    expect(routerRefresh).not.toHaveBeenCalled();

    stepInHistory(DASHBOARD);
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    // Nothing new arrived, so the indicator has nothing more to record.
    expect(arrivals).toHaveLength(1);
    scheduler.settled();

    // That refresh emptied the history cache: Forward and Back again refresh nothing.
    stepInHistory(CONNECTIONS);
    stepInHistory(DASHBOARD);
    vi.runAllTimers();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh the page Back returns to when it reads none of the skipped changes", () => {
    const { routerRefresh, hear, stepInHistory } = setupPage(CONNECTIONS);
    hear("triggered_alerts");
    vi.runAllTimers();
    stepInHistory(TIMELINE);
    vi.runAllTimers();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it("refreshes the page Back lands on when the max wait ends a batch before the router renders it", () => {
    const { page, arrivals, routerRefresh, hear, popState } = setupPage(CONNECTIONS);
    hear("triggered_alerts");
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    // Events the connections page does not read keep arriving faster than the debounce, so the
    // max wait ends their batch.
    const interval = REFRESH_DEBOUNCE_MS / 3;
    let elapsed = 0;
    while (elapsed < REFRESH_MAX_WAIT_MS - interval) {
      hear("activity_events");
      vi.advanceTimersByTime(interval);
      elapsed += interval;
    }
    expect(routerRefresh).not.toHaveBeenCalled();

    // Back to the dashboard just before the max wait: the batch is taken while React still renders
    // the connections page.
    popState(DASHBOARD);
    vi.advanceTimersByTime(REFRESH_MAX_WAIT_MS - elapsed);
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    expect(arrivals).toHaveLength(2);

    // The router renders the dashboard, which that refresh reached: nothing more is due.
    page.pathname = DASHBOARD;
    vi.runAllTimers();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  // Leaving the workspace shell unmounts LiveRefresh, and the step back into it fires its
  // `popstate` before the new mount listens; the workspace's skipped set outlives both.
  it("refreshes the page a jump of several entries back into the shell mounts on, once, for a change skipped before leaving", () => {
    const skipped = new Set<LiveTable>();
    const left = setupPage(CONNECTIONS, skipped);
    left.hear("triggered_alerts");
    vi.runAllTimers();
    left.scheduler.dispose();
    expect(left.routerRefresh).not.toHaveBeenCalled();

    const back = setupPage(DASHBOARD, skipped);
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(back.routerRefresh).toHaveBeenCalledTimes(1);
    expect(back.arrivals).toEqual([]);
    back.scheduler.settled();
    back.scheduler.dispose();

    // That refresh emptied the history cache, so the next mount refreshes nothing.
    const again = setupPage(DASHBOARD, skipped);
    vi.runAllTimers();
    expect(again.routerRefresh).not.toHaveBeenCalled();
  });

  it("refreshes the page a single Back mounts on when a step judged it stale and the shell unmounted before the batch", () => {
    const skipped = new Set<LiveTable>();
    const left = setupPage(CONNECTIONS, skipped);
    left.hear("triggered_alerts");
    vi.runAllTimers();
    left.stepInHistory(DASHBOARD);
    // A link out of the shell before the batch comes due.
    left.scheduler.dispose();
    vi.runAllTimers();
    expect(left.routerRefresh).not.toHaveBeenCalled();

    // Back lands on the dashboard, still cached from before the alert.
    const back = setupPage(DASHBOARD, skipped);
    vi.advanceTimersByTime(REFRESH_DEBOUNCE_MS);
    expect(back.routerRefresh).toHaveBeenCalledTimes(1);
  });

  it("refreshes nothing when the shell mounts on a page that reads none of the skipped changes", () => {
    const skipped = new Set<LiveTable>();
    const left = setupPage(CONNECTIONS, skipped);
    left.hear("triggered_alerts");
    vi.runAllTimers();
    left.scheduler.dispose();

    const back = setupPage(TIMELINE, skipped);
    vi.runAllTimers();
    expect(back.routerRefresh).not.toHaveBeenCalled();
  });
});
