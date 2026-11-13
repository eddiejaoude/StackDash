import { describe, expect, it, vi } from "vitest";

import { createArrivalStore, INITIAL_LIVE_STATE, NO_BATCH } from "./arrival-store";

const NO_CONNECTIONS: ReadonlySet<string> = new Set();

function setup() {
  const store = createArrivalStore();
  const listener = vi.fn<() => void>();
  const unsubscribe = store.subscribe(listener);
  return { store, listener, unsubscribe };
}

describe("createArrivalStore", () => {
  it("starts from what the server renders", () => {
    const { store } = setup();
    expect(store.live()).toBe(INITIAL_LIVE_STATE);
    expect(store.batch()).toBe(NO_BATCH);
  });

  it("notifies once per status change, and not when the status is set to the one it has", () => {
    const { store, listener } = setup();
    store.setStatus("connecting");
    expect(listener).not.toHaveBeenCalled();
    expect(store.live()).toBe(INITIAL_LIVE_STATE);

    store.setStatus("live");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.live()).toEqual({ status: "live", lastArrivalAt: null });
    store.setStatus("live");
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps a snapshot's identity until it changes, as useSyncExternalStore requires", () => {
    const { store } = setup();
    store.setStatus("live");
    const live = store.live();
    const batch = store.batch();
    expect(store.live()).toBe(live);
    expect(store.batch()).toBe(batch);
    store.arrived(null, NO_CONNECTIONS);
    expect(store.live()).toBe(live);
    expect(store.batch()).not.toBe(batch);
  });

  it("counts every batch and keeps the newest commit time: an older, equal, or unknown one does not replace it", () => {
    const { store, listener } = setup();
    store.arrived("2026-11-05T10:00:01.000Z", NO_CONNECTIONS);
    expect(store.live().lastArrivalAt).toBe("2026-11-05T10:00:01.000Z");
    store.arrived("2026-11-05T10:00:00.999Z", NO_CONNECTIONS);
    store.arrived("2026-11-05T10:00:01.000Z", NO_CONNECTIONS);
    store.arrived(null, NO_CONNECTIONS);
    expect(store.live().lastArrivalAt).toBe("2026-11-05T10:00:01.000Z");
    store.arrived("2026-11-05T10:00:02.000Z", NO_CONNECTIONS);
    expect(store.live().lastArrivalAt).toBe("2026-11-05T10:00:02.000Z");
    expect(store.batch().number).toBe(5);
    expect(listener).toHaveBeenCalledTimes(5);
  });

  it("records which components were in view when a batch arrived, and drops one that hides before its refresh", () => {
    const { store, listener } = setup();
    const unwatchCard = store.watch("card");
    const unwatchList = store.watch("list");
    // Watching is not a change anyone renders.
    expect(listener).not.toHaveBeenCalled();

    store.arrived(null, NO_CONNECTIONS);
    expect([...store.batch().inView]).toEqual(["card", "list"]);
    expect(listener).toHaveBeenCalledTimes(1);

    unwatchCard();
    expect([...store.batch().inView]).toEqual(["list"]);
    expect(listener).toHaveBeenCalledTimes(2);

    // Hidden then shown again: the next batch sees it, the batch it missed does not.
    store.watch("card");
    expect([...store.batch().inView]).toEqual(["list"]);
    unwatchList();
    store.arrived(null, NO_CONNECTIONS);
    expect([...store.batch().inView]).toEqual(["card"]);
  });

  it("changes nothing when a component the batch never saw stops watching", () => {
    const { store, listener } = setup();
    store.arrived(null, NO_CONNECTIONS);
    const batch = store.batch();
    const unwatch = store.watch("late");
    listener.mockClear();

    unwatch();
    expect(store.batch()).toBe(batch);
    expect(listener).not.toHaveBeenCalled();
  });

  it("records the last batch each connection received data in, and keeps it through batches from others", () => {
    const { store } = setup();
    const pending = new Set(["c1", "c2"]);
    store.arrived(null, pending);
    // The caller reuses its set for the next batch; the store kept what it needed.
    pending.clear();
    expect([...store.batch().receivedIn]).toEqual([
      ["c1", 1],
      ["c2", 1],
    ]);
    // A batch from another connection, then one with no connection: c1 and c2 keep batch 1.
    store.arrived(null, new Set(["c3"]));
    store.arrived(null, NO_CONNECTIONS);
    expect(Object.fromEntries(store.batch().receivedIn)).toEqual({ c1: 1, c2: 1, c3: 2 });
    // Receiving again moves it to the new batch.
    store.arrived(null, new Set(["c1"]));
    expect(store.batch().receivedIn.get("c1")).toBe(4);
  });

  it("stops notifying a listener once it unsubscribes, and keeps notifying the others", () => {
    const { store, listener, unsubscribe } = setup();
    const other = vi.fn<() => void>();
    store.subscribe(other);
    unsubscribe();
    store.setStatus("offline");
    expect(listener).not.toHaveBeenCalled();
    expect(other).toHaveBeenCalledTimes(1);
  });
});
