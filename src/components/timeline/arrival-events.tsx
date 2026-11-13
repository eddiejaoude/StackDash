"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import { useArrivalHighlight, useArrivalReport, useRenderDiff } from "@/components/app/arrivals";
import { newEventIds } from "@/lib/realtime/arrivals";

/**
 * Timeline events that arrived in a live refresh (#171). The list compares its ids with the
 * previous render; a new row slides into its day group, its card shows a severity-colored edge and
 * wash that fade, and it says "New" while highlighted. Rows already on screen never move or animate.
 * The provider chips in the title row glow when their provider's count grows (#403).
 */

type Arrivals = Readonly<{
  /** Arrived in the latest batch. */
  newIds: ReadonlySet<string>;
  /** Arrived in any batch since this view opened: these rows keep the space of their label. */
  labeledIds: ReadonlySet<string>;
  highlighted: boolean;
}>;

const ArrivalsContext = createContext<Arrivals>({ newIds: new Set(), labeledIds: new Set(), highlighted: false });

/** Around the whole list, with the ids of every event it shows. */
export function ArrivalEvents({ eventIds, children }: { eventIds: readonly string[]; children: ReactNode }) {
  const diff = useRenderDiff(eventIds, eventIds.join(" "));
  const arrived = newEventIds(diff.previous, eventIds);
  // Grows with every batch and empties when the view changes (no previous render), so a label is
  // never removed from a row while the view is open: removing it could reflow the row.
  const [labeled, setLabeled] = useState<Readonly<{ batch: number; ids: readonly string[] }>>({ batch: 0, ids: [] });
  let labeledIds = labeled.ids;
  if (labeled.batch !== diff.batch || (diff.previous === null && labeled.ids.length > 0)) {
    labeledIds = diff.previous === null ? [] : [...labeled.ids, ...arrived];
    setLabeled({ batch: diff.batch, ids: labeledIds });
  }
  const highlighted = useArrivalHighlight(diff.batch, arrived.length > 0);
  useArrivalReport(diff.batch, arrived.length > 0 ? { kind: "events", count: arrived.length } : null);
  return (
    <ArrivalsContext value={{ newIds: new Set(arrived), labeledIds: new Set(labeledIds), highlighted }}>
      {children}
    </ArrivalsContext>
  );
}

/**
 * One row's list item: a single event, or a run of identical events collapsed into one row (#253).
 * A row that is new as a whole mounts with the slide in, so it runs once; a run already on screen
 * that an arriving event joins stays put. The item is positioned and isolated, so its own layers
 * (the timeline line, or an `ArrivalFlash`) stay behind its content and inside the item.
 */
export function ArrivalEventRow({
  eventIds,
  className,
  children,
}: {
  /** The row's events: one, or every event in its run. */
  eventIds: readonly string[];
  className: string;
  children: ReactNode;
}) {
  const { newIds } = useContext(ArrivalsContext);
  const entered = eventIds.some((id) => newIds.has(id)) && eventIds.every((id) => newIds.has(id));
  return <li className={`relative isolate ${className} ${entered ? "arrival-enter" : ""}`}>{children}</li>;
}

/**
 * The severity-colored edge and wash (or, under reduced motion, a static highlight) of an event
 * that arrived, shown only while an arrival among `eventIds` is highlighted. Render it inside the
 * surface it marks, which must be positioned and isolated so this layer sits above the surface's
 * background and below its content; `className` matches the surface's corners.
 */
export function ArrivalFlash({
  eventIds,
  flash,
  className = "",
}: {
  /** The events the surface shows: one, or every event in its run. */
  eventIds: readonly string[];
  /** The severity color of the arriving edge, as a CSS color. */
  flash: string;
  className?: string;
}) {
  const { newIds, highlighted } = useContext(ArrivalsContext);
  if (!highlighted || !eventIds.some((id) => newIds.has(id))) return null;
  return (
    <span
      aria-hidden="true"
      className={`arrival-flash pointer-events-none absolute inset-0 -z-10 ${className}`}
      style={{ "--flash": flash }}
    />
  );
}

/**
 * "New" after a row's details when one of its events is new, so the highlight never rests on color
 * alone. Once the highlight ends it is hidden but keeps its space.
 */
export function ArrivalNewLabel({ eventIds }: { eventIds: readonly string[] }) {
  const { newIds, labeledIds, highlighted } = useContext(ArrivalsContext);
  if (!eventIds.some((id) => labeledIds.has(id))) return null;
  const visible = highlighted && eventIds.some((id) => newIds.has(id));
  return (
    <span
      className={`ml-2 rounded-full border border-accent px-1.5 font-mono text-[10px] text-accent ${visible ? "" : "invisible"}`}
    >
      <span className="sr-only">, </span>
      New
    </span>
  );
}

type ChipArrivals = Readonly<{
  /** Providers whose event count grew, or that appeared, in the latest batch. */
  grown: ReadonlySet<string>;
  batch: number;
  highlighted: boolean;
}>;

const ChipArrivalsContext = createContext<ChipArrivals>({ grown: new Set(), batch: 0, highlighted: false });

/**
 * Around the provider chips in the title row (#403), with each provider's event count under the
 * current filters. A provider whose count grew in a live refresh, or that has its first event in
 * view, arrived; a count that fell (a filter, retention) is not an arrival. The event list already
 * announces the new events, so this adds no announcement of its own.
 */
export function ArrivalProviderChips({ counts, children }: { counts: Readonly<Record<string, number>>; children: ReactNode }) {
  const diff = useRenderDiff(counts, JSON.stringify(counts));
  const previous = diff.previous;
  const grown =
    previous === null
      ? []
      : Object.entries(counts)
          .filter(([provider, events]) => events > (previous[provider] ?? 0))
          .map(([provider]) => provider);
  const highlighted = useArrivalHighlight(diff.batch, grown.length > 0);
  return <ChipArrivalsContext value={{ grown: new Set(grown), batch: diff.batch, highlighted }}>{children}</ChipArrivalsContext>;
}

/**
 * One provider chip's list item. While its provider's arrival is highlighted, the coral glow the
 * dashboard's changed cards use pulses out of the chip, and its count is the new one. The glow
 * layer sits over the chip, so under reduced motion its static highlight (a coral tint and edge)
 * shows on the chip's own background rather than behind it.
 */
export function ArrivalProviderChip({ provider, children }: { provider: string; children: ReactNode }) {
  const { grown, batch, highlighted } = useContext(ChipArrivalsContext);
  const arrived = highlighted && grown.has(provider);
  return (
    <li className="relative" data-arrived={arrived ? "true" : undefined}>
      {children}
      {/* Keyed by batch, so a second arrival while highlighted pulses again. */}
      {arrived ? (
        <span key={batch} aria-hidden="true" className="arrival-pulse pointer-events-none absolute inset-0 z-10 rounded-lg" />
      ) : null}
    </li>
  );
}
