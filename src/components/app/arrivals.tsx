"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { ConnectionStatusBadge } from "@/components/connections/connection-status-badge";
import { AlertIcon } from "@/components/icons";
import { LiveRegion } from "@/components/ui/live-region";
import { ProviderMark } from "@/components/ui/provider-mark";
import { formatLondonTime } from "@/lib/format";
import {
  createArrivalStore,
  INITIAL_LIVE_STATE,
  NO_BATCH,
  type ArrivalBatch,
  type ArrivalStore,
} from "@/lib/realtime/arrival-store";
import {
  ARRIVAL_HIGHLIGHT_MS,
  describeArrivals,
  liveConnectionsText,
  liveStatusText,
  type ArrivalReport,
  type LiveConnection,
  type LiveConnectionsRead,
} from "@/lib/realtime/arrivals";

/**
 * Arriving data, made visible (#171). The provider sits in the workspace layout around the header
 * and the page: LiveRefresh tells it when a batch arrives, the components that show data tell it
 * what changed, and it says so once per batch in one polite live region. The live indicator in
 * the header reads its state.
 *
 * The live state and the batches live in an ArrivalStore that components read with
 * useSyncExternalStore, never in a context value that changes: a changing context value makes
 * React render the streamed page on the client before its server HTML is revealed, and the page
 * was then in the document twice (#211, explained in src/lib/realtime/arrival-store.ts). Both
 * context values below are created once and never change.
 */

type ArrivalControls = Pick<ArrivalStore, "arrived" | "setStatus" | "watch"> &
  Readonly<{
    /**
     * What one component saw change in a render. `id` is unique per component and batch, so the
     * second run of an effect (React Strict Mode) is not counted twice.
     */
    report: (id: string, report: ArrivalReport) => void;
  }>;

const ArrivalStoreContext = createContext<ArrivalStore | null>(null);
const ArrivalControlsContext = createContext<ArrivalControls | null>(null);

// The server snapshots are the initial state, so hydration matches the server HTML and a change
// that came first re-renders the component once it has hydrated. Outside the provider nothing
// arrives and the snapshots never change.
const noSubscription = () => () => {};
const initialLiveState = () => INITIAL_LIVE_STATE;
const noBatch = () => NO_BATCH;

function useArrivalBatch(): ArrivalBatch {
  const store = useContext(ArrivalStoreContext);
  return useSyncExternalStore(store?.subscribe ?? noSubscription, store?.batch ?? noBatch, noBatch);
}

// Long enough for a screen reader to notice the region emptied, so the same sentence twice in a
// row is still announced twice.
const ANNOUNCEMENT_RESET_MS = 100;

export function ArrivalProvider({ children }: { children: ReactNode }) {
  // State, not memos: LiveRefresh's channel effect depends on the controls, so neither identity may
  // ever change (React may drop a memoized value; a state initializer runs once).
  const [store] = useState(createArrivalStore);
  const [announcement, setAnnouncement] = useState("");
  const pending = useRef(new Map<string, ArrivalReport>());
  const timers = useRef({ flush: 0, announce: 0 });
  const [controls] = useState<ArrivalControls>(() => {
    // Every component that changed reports from its effect in the same commit, so the reports of
    // one refresh are all in before a zero-delay timer runs.
    function flush(): void {
      timers.current.flush = 0;
      const text = describeArrivals([...pending.current.values()]);
      pending.current.clear();
      if (text === null) return;
      setAnnouncement("");
      window.clearTimeout(timers.current.announce);
      timers.current.announce = window.setTimeout(() => setAnnouncement(text), ANNOUNCEMENT_RESET_MS);
    }
    return {
      arrived: store.arrived,
      setStatus: store.setStatus,
      watch: store.watch,
      report(id, report) {
        pending.current.set(id, report);
        if (timers.current.flush === 0) timers.current.flush = window.setTimeout(flush, 0);
      },
    };
  });

  useEffect(() => {
    const pendingTimers = timers.current;
    return () => {
      window.clearTimeout(pendingTimers.flush);
      window.clearTimeout(pendingTimers.announce);
    };
  }, []);

  return (
    <ArrivalControlsContext value={controls}>
      <ArrivalStoreContext value={store}>
        {children}
        {/* In the page from the first render, so a later sentence is a change a screen reader hears. */}
        <LiveRegion tone="status" as="p" aria-atomic="true" className="sr-only" data-testid="arrival-announcement">
          {announcement}
        </LiveRegion>
      </ArrivalStoreContext>
    </ArrivalControlsContext>
  );
}

/** For LiveRefresh: null outside the provider, where nothing is marked. */
export function useArrivalControls(): ArrivalControls | null {
  return useContext(ArrivalControlsContext);
}

/**
 * The view a page is showing: its path with the filters and page that decide what it lists. A
 * change in scope is navigation, not arrival, so it resets every comparison instead of animating.
 */
const ScopeContext = createContext<string | null>(null);

export function ArrivalScope({ scope, children }: { scope: string; children: ReactNode }) {
  return <ScopeContext value={scope}>{children}</ScopeContext>;
}

export type RenderDiff<T> = Readonly<{
  /** What the previous render showed, when this render's change arrived in view; otherwise null. */
  previous: T | null;
  /** Grows by one with each change that arrived in view. */
  batch: number;
}>;

type DiffState<T> = RenderDiff<T> &
  Readonly<{
    scope: string | null;
    signature: string;
    value: T;
    /** The batch number when the value was taken, so one batch marks a change once. */
    arrival: number;
  }>;

/**
 * The previous render's value, kept in state as React documents for information from previous
 * renders (https://react.dev/reference/react/useState#storing-information-from-previous-renders).
 * `signature` identifies the value, so a refresh that brings identical data changes nothing.
 * Outside an ArrivalScope there is never a previous value, so nothing animates.
 *
 * A change is an arrival only when a batch arrived while this component was in view. Leaving a
 * page does not unmount it: with Cache Components, Next.js keeps recent pages in a hidden React
 * Activity and shows them again, state and all, on return (node_modules/next/dist/docs/01-app/
 * 02-guides/preserving-ui-state.md). Hiding runs layout effect cleanups and showing runs the
 * layout effects again, so the layout effect tells the provider when this is in view, and the
 * cleanup drops the last comparison, so nothing marked replays when the page shows again.
 * Whatever changed while the page was hidden then shows unmarked: that is navigation, not arrival.
 */
export function useRenderDiff<T>(value: T, signature: string): RenderDiff<T> {
  const scope = useContext(ScopeContext);
  const controls = useContext(ArrivalControlsContext);
  const arrival = useArrivalBatch();
  const id = useId();
  const [state, setState] = useState<DiffState<T>>({
    scope,
    signature,
    value,
    previous: null,
    batch: 0,
    arrival: arrival.number,
  });
  useLayoutEffect(() => {
    const unwatch = controls?.watch(id);
    return () => {
      unwatch?.();
      setState((current) => (current.previous === null ? current : { ...current, previous: null }));
    };
  }, [controls, id]);
  if (state.scope === scope && state.signature === signature) return state;
  const arrived =
    scope !== null && state.scope === scope && arrival.number !== state.arrival && arrival.inView.has(id);
  const next: DiffState<T> = {
    scope,
    signature,
    value,
    previous: arrived ? state.value : null,
    batch: arrived ? state.batch + 1 : state.batch,
    arrival: arrival.number,
  };
  setState(next);
  return next;
}

/** True from a change until ARRIVAL_HIGHLIGHT_MS later; a newer change restarts it. */
export function useArrivalHighlight(batch: number, changed: boolean): boolean {
  const [clearedBatch, setClearedBatch] = useState(0);
  useEffect(() => {
    if (!changed) return;
    const timer = window.setTimeout(() => setClearedBatch(batch), ARRIVAL_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [batch, changed]);
  return changed && clearedBatch !== batch;
}

/** Adds this component's change to the batch announcement, once per batch. */
export function useArrivalReport(batch: number, report: ArrivalReport | null): void {
  const controls = useContext(ArrivalControlsContext);
  const id = useId();
  // Primitives, so a new report object with the same content does not report again.
  const events = report?.kind === "events" ? report.count : null;
  const label = report?.kind === "updated" ? report.label : null;
  useEffect(() => {
    if (controls === null) return;
    if (events !== null) controls.report(`${id}:${batch}`, { kind: "events", count: events });
    else if (label !== null) controls.report(`${id}:${batch}`, { kind: "updated", label });
  }, [controls, id, batch, events, label]);
}

/**
 * "Live" in the workspace header. While the channel is live the dot breathes a slow ring (ready);
 * when a batch arrives it flashes coral and ripples, a different effect, and the connections that
 * batch came from are marked "Receiving" in the list (#392). Beside the word, from `lg`, how many
 * connections are connected, and from `sm` a mark when one needs attention; the name always
 * carries both. Hover or focus shows when data
 * last arrived and lists the connections with their status; Escape hides that until the pointer
 * or focus leaves, and a press keeps it open for touch screens.
 *
 * Below `md` the tooltip is placed against the header's top row (positioned in the workspace
 * layout) rather than the button, so its width never runs off the left edge: on a phone, and up
 * to `md`, where a long account name can leave the button within 288px of the edge.
 */
export function LiveIndicator({ connections }: { connections: LiveConnectionsRead }) {
  const store = useContext(ArrivalStoreContext);
  const { status, lastArrivalAt } = useSyncExternalStore(
    store?.subscribe ?? noSubscription,
    store?.live ?? initialLiveState,
    initialLiveState,
  );
  const arrivals = useArrivalBatch().number;
  const text = liveStatusText(status);
  const summary = connections.state === "loaded" ? connections.summary : null;
  const count = summary === null ? null : liveConnectionsText(summary);
  const tooltipId = useId();
  const [pinned, setPinned] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    if (event.key !== "Escape") return;
    setDismissed(true);
    setPinned(false);
  }

  const visibility = dismissed ? "invisible" : pinned ? "visible" : "invisible group-hover:visible group-focus-within:visible";
  return (
    <div className="group inline-flex md:relative" onMouseLeave={() => setDismissed(false)}>
      <button
        type="button"
        aria-describedby={tooltipId}
        onClick={() => {
          setPinned((current) => !current);
          setDismissed(false);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setPinned(false);
          setDismissed(false);
        }}
        className="inline-flex min-h-6 min-w-6 items-center gap-1.5 rounded-md px-1.5 font-mono text-xs text-muted transition-colors hover:text-foreground"
      >
        <span aria-hidden="true" className="relative flex size-2">
          {status === "live" ? <span data-testid="live-ready" className="live-ready absolute inset-0 rounded-full bg-success" /> : null}
          {/* Keyed by batch, so each arrival mounts a fresh ripple that runs its three rings once. */}
          {arrivals > 0 ? (
            <span key={arrivals} data-testid="live-receive" className="live-receive absolute inset-0 rounded-full border border-accent" />
          ) : null}
          {/* Filled when live, hollow otherwise: the shape says it as well as the color and the word.
              Keyed by batch too, so its coral flash restarts on every arrival. */}
          <span
            key={`dot-${arrivals}`}
            data-testid="live-dot"
            className={`relative size-2 rounded-full ${status === "live" ? "bg-success" : "border border-muted"} ${arrivals > 0 ? "live-receive-dot" : ""}`}
          />
        </span>
        {/* The whole name, and the visible words for sight; the tooltip describes the state. Below
            sm the phone header row has no room for the word (#175, #198): the dot's shape (filled
            or hollow) still says it, and the name and tooltip are unchanged. The count waits for
            lg, where the top row has room for it beside the Admin link (#364). */}
        <span className="sr-only">{count === null ? text.name : `${text.name}, ${count.name}`}</span>
        <span aria-hidden="true" className="hidden sm:inline">
          {text.word}
        </span>
        {count === null ? null : (
          <span aria-hidden="true" className="hidden border-l border-line pl-1.5 lg:inline">
            {count.word}
          </span>
        )}
        {summary !== null && summary.attention > 0 ? (
          <AlertIcon data-testid="live-attention" width={12} height={12} className="hidden text-warning sm:inline" />
        ) : null}
      </button>
      <div
        role="tooltip"
        id={tooltipId}
        className={`absolute right-0 top-full z-50 mt-2 w-72 max-w-[calc(100vw-2rem)] space-y-2 rounded-md border border-line-strong bg-panel-raised px-3 py-2 text-xs leading-5 text-foreground shadow-lg ${visibility}`}
      >
        <p>
          {status === "offline" ? (
            // The client rejoins on its own after a failure (phoenix's rejoinTimer) and the word turns
            // back to Live when it does, so say so and keep the reload for when it sticks.
            "Live updates stopped. Trying to reconnect; reload the page if this does not clear."
          ) : status === "connecting" ? (
            "Connecting to live updates."
          ) : lastArrivalAt === null ? (
            "Live updates are on. No new data since this page opened."
          ) : (
            <>
              Live updates are on. Data last arrived at{" "}
              <time dateTime={lastArrivalAt}>{formatLondonTime(lastArrivalAt)}</time> London time.
            </>
          )}
        </p>
        <LiveConnectionsList connections={connections} />
      </div>
    </div>
  );
}

/** The tooltip's connections: a sentence that counts them, then each one with its status. */
function LiveConnectionsList({ connections }: { connections: LiveConnectionsRead }) {
  if (connections.state === "loading") return <p className="text-muted">Loading connections.</p>;
  if (connections.state === "failed") {
    return (
      <p>
        Connections could not be loaded. Reload the page to try again, and quote reference {connections.reference} if it
        keeps happening.
      </p>
    );
  }
  const { summary } = connections;
  if (summary.listed.length === 0) return <p>No connections yet. Add one on the Connections page.</p>;
  return (
    <>
      <p>Connections: {liveConnectionsText(summary).name}.</p>
      <ul className="space-y-1.5" aria-label="Connections">
        {summary.listed.map((connection) => (
          <LiveConnectionRow key={connection.id} connection={connection} />
        ))}
      </ul>
      {summary.unlisted > 0 ? <p className="text-muted">And {summary.unlisted} more on the Connections page.</p> : null}
    </>
  );
}

/**
 * One connection in the tooltip. For ARRIVAL_HIGHLIGHT_MS after a batch that changed its rows it
 * says "Receiving" beside a coral ripple; the word carries it under reduced motion, where the
 * ripple is hidden, and for a screen reader reading the description.
 */
function LiveConnectionRow({ connection }: { connection: LiveConnection }) {
  const batch = useArrivalBatch();
  const receiving = useArrivalHighlight(batch.number, batch.connectionIds.has(connection.id));
  return (
    <li className="flex items-center gap-2">
      <ProviderMark provider={connection.provider} size="sm" labeled />
      <span className="min-w-0 flex-1 truncate">{connection.display_name}</span>
      {receiving ? (
        <span className="inline-flex shrink-0 items-center gap-1.5 text-accent">
          <span aria-hidden="true" className="relative flex size-1.5">
            <span key={batch.number} className="live-receive absolute inset-0 rounded-full border border-accent" />
            <span className="relative size-1.5 rounded-full bg-accent" />
          </span>
          Receiving
        </span>
      ) : null}
      <ConnectionStatusBadge status={connection.status} />
    </li>
  );
}
