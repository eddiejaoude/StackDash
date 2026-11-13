/**
 * The live state and the arrival batches of a workspace page (#171), kept outside React state so
 * that a change never reaches a part of the page that has not hydrated yet (#211).
 *
 * They used to be React state handed down through context from the provider around the header and
 * the page. A context value that changes schedules work on every Suspense boundary below the
 * provider that is still dehydrated, because React cannot see which components inside read it
 * (`propagateContextChanges`). A dehydrated boundary whose streamed HTML has not been revealed yet
 * cannot hydrate, so React renders it on the client instead (`updateDehydratedSuspenseComponent`),
 * and the server's copy stays in the document beside it until React's reveal script removes it.
 * React reveals streamed boundaries in batches up to 300 ms apart, and the live connection usually
 * opens inside that window: the page was in the document twice. Both functions are in
 * node_modules/next/dist/compiled/react-dom/cjs/react-dom-client.development.js (React 19.3).
 *
 * Components read this store with useSyncExternalStore
 * (https://react.dev/reference/react/useSyncExternalStore), which re-renders only the components
 * that subscribed, and a component only subscribes once it has hydrated.
 */
import type { LiveStatus } from "./arrivals";

export type LiveState = Readonly<{
  status: LiveStatus;
  /** Commit time of the newest change Realtime delivered, from the database clock. */
  lastArrivalAt: string | null;
}>;

/** The latest batch LiveRefresh announced, and which of the components that mark data saw it. */
export type ArrivalBatch = Readonly<{
  /** Batches arrived since the page opened; the indicator plays its receiving effect each time it grows. */
  number: number;
  /** The ids of the components that mark data and were in view when it arrived. */
  inView: ReadonlySet<string>;
  /**
   * For each connection that has received data since the page opened, the number of the last batch
   * that carried its rows, for the live indicator's list (#392). Kept across batches, so a later
   * batch from another connection does not end this one's "Receiving" early.
   */
  receivedIn: ReadonlyMap<string, number>;
}>;

/** What the server renders, and what every page starts from. */
export const INITIAL_LIVE_STATE: LiveState = { status: "connecting", lastArrivalAt: null };
export const NO_BATCH: ArrivalBatch = { number: 0, inView: new Set(), receivedIn: new Map() };

export type ArrivalStore = Readonly<{
  /** Runs the listener after every change; returns the unsubscribe function. */
  subscribe: (listener: () => void) => () => void;
  /** The current live state: the same object until it changes, as useSyncExternalStore requires. */
  live: () => LiveState;
  /** The current batch: the same object until it changes. */
  batch: () => ArrivalBatch;
  setStatus: (status: LiveStatus) => void;
  /**
   * A batch of changes arrived and the page is refreshing; `at` is its newest commit time and
   * `connectionIds` the connections that sent provider data in it (see `changedConnectionId`).
   */
  arrived: (at: string | null, connectionIds: ReadonlySet<string>) => void;
  /** A component that marks data is in view until the returned function runs. */
  watch: (id: string) => () => void;
}>;

export function createArrivalStore(): ArrivalStore {
  let live = INITIAL_LIVE_STATE;
  let batch = NO_BATCH;
  const inView = new Set<string>();
  const listeners = new Set<() => void>();

  function changed(): void {
    for (const listener of listeners) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    live: () => live,
    batch: () => batch,
    setStatus(status) {
      if (live.status === status) return;
      live = { ...live, status };
      changed();
    },
    arrived(at, connectionIds) {
      // The newest commit wins: batches can be announced out of commit order.
      if (at !== null && (live.lastArrivalAt === null || Date.parse(at) > Date.parse(live.lastArrivalAt))) {
        live = { ...live, lastArrivalAt: at };
      }
      const number = batch.number + 1;
      const receivedIn = new Map(batch.receivedIn);
      for (const connectionId of connectionIds) receivedIn.set(connectionId, number);
      batch = { number, inView: new Set(inView), receivedIn };
      changed();
    },
    watch(id) {
      inView.add(id);
      return () => {
        inView.delete(id);
        // Hidden before the batch's refresh reached it: that refresh is not an arrival for it.
        if (!batch.inView.has(id)) return;
        const seen = new Set(batch.inView);
        seen.delete(id);
        batch = { ...batch, inView: seen };
        changed();
      };
    },
  };
}
