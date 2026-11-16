import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";

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
  const refresh = vi.fn<() => void>();
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
  function startRefresh(scheduler: RefreshScheduler, refresh: Mock<() => void>): void {
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
});

describe("createRefreshHolds", () => {
  /** A scheduler paused by the holds alone, wired the way LiveRefresh wires it. */
  function setupHeld() {
    const holds = createRefreshHolds();
    const refresh = vi.fn<() => void>();
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
