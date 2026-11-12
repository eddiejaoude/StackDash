"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createContext, use, useEffect, useEffectEvent, useId, useRef, useState, type ReactNode } from "react";

import { SimulatedBadge } from "@/components/connections/simulated-badge";
import { GuardedButton } from "@/components/guarded-button";
import { SeverityBadge } from "@/components/severity-badge";
import { buttonClass } from "@/components/ui/button";
import { LiveRegion, OutcomeAnnouncement, type Outcome } from "@/components/ui/live-region";
import { DialogCloseButton, ModalDialog, useModalDialog } from "@/components/ui/modal-dialog";
import { ProviderMark } from "@/components/ui/provider-mark";
import type { TimelineEvent } from "@/lib/data/timeline";
import { formatDateTime } from "@/lib/format";
import { providerName } from "@/lib/providers";
import { eventTypeLabel, parseTimelineEventId, severityBadge } from "@/lib/timeline/query";

const InspectorContext = createContext<{
  baseHref: string;
  selectedId: string | null;
  select: (id: string, opener: HTMLAnchorElement | null) => void;
} | null>(null);

function eventHref(baseHref: string, id: string): string {
  return `${baseHref}${baseHref.includes("?") ? "&" : "?"}event=${encodeURIComponent(id)}`;
}

/** Loaded rows open without a request; a full navigation resolves shared links on the server. */
export function EventInspector({ events, linkedEvent, baseHref, children }: {
  events: readonly TimelineEvent[];
  linkedEvent: TimelineEvent | null;
  baseHref: string;
  children: ReactNode;
}) {
  const searchParams = useSearchParams();
  const selectedId = parseTimelineEventId(searchParams.get("event") ?? undefined);
  const selected = events.find((event) => event.id === selectedId)
    ?? (linkedEvent?.id === selectedId ? linkedEvent : null);
  const selectedIndex = events.findIndex((event) => event.id === selectedId);
  const newer = selectedIndex > 0 ? events[selectedIndex - 1] : undefined;
  const older = selectedIndex >= 0 ? events[selectedIndex + 1] : undefined;
  const fallbackId = useId();
  const dialog = useModalDialog({ fallbackFocusId: fallbackId });
  const opener = useRef<HTMLAnchorElement | null>(null);
  const open = selectedId !== null;

  const syncDialog = useEffectEvent(() => {
    if (open && !dialog.ref.current?.open) dialog.open(opener.current);
    if (!open && dialog.ref.current?.open) dialog.close();
  });
  useEffect(() => { syncDialog(); }, [open]);

  // The native dialog owns focus; this prevents wheel/touch scrolling the preserved feed behind it.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => { root.style.overflow = previous; };
  }, [open]);

  function select(id: string, from: HTMLAnchorElement | null) {
    opener.current = from;
    window.history.pushState(null, "", eventHref(baseHref, id));
  }

  function closeSelection() {
    const url = new URL(window.location.href);
    // Back may have already removed the selection. Never overwrite that navigation.
    if (!url.searchParams.has("event")) return;
    url.searchParams.delete("event");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function moveTo(event: TimelineEvent | undefined) {
    if (event === undefined) return;
    window.history.replaceState(null, "", eventHref(baseHref, event.id));
    dialog.ref.current?.scrollTo({ top: 0, behavior: "instant" });
  }

  return (
    <InspectorContext value={{ baseHref, selectedId, select }}>
      <div id={fallbackId} tabIndex={-1}>{children}</div>
      <ModalDialog
        dialog={dialog}
        title="Event details"
        titleAction={<DialogCloseButton className={buttonClass("secondary", "sm")}>Close event</DialogCloseButton>}
        size="inspector"
        onClose={closeSelection}
      >
        {selected === null ? (
          <div className="mt-6 space-y-3">
            <h3 className="text-lg font-semibold">Event unavailable</h3>
            <p className="text-sm leading-6 text-muted">
              This event is no longer available in this workspace. Close the inspector and choose another event.
            </p>
          </div>
        ) : (
          <>
            <EventDetails key={selected.id} event={selected} href={eventHref(baseHref, selected.id)} />
            <nav aria-label="Events on this page" className="mt-6 flex flex-wrap gap-2 border-t border-line pt-4">
              <GuardedButton type="button" unavailable={newer === undefined} onClick={() => moveTo(newer)} className={buttonClass("secondary", "sm")}>
                Newer event
              </GuardedButton>
              <GuardedButton type="button" unavailable={older === undefined} onClick={() => moveTo(older)} className={buttonClass("secondary", "sm")}>
                Older event
              </GuardedButton>
            </nav>
            <p className="mt-2 text-xs text-muted">Navigation follows the events on this page.</p>
            <LiveRegion tone="status" className="sr-only">Viewing {selected.title}</LiveRegion>
          </>
        )}
      </ModalDialog>
    </InspectorContext>
  );
}

/** A real link for new tabs and sharing; normal activation preserves the feed and its disclosures. */
export function EventInspectorLink({ eventId, children }: { eventId: string; children: ReactNode }) {
  const inspector = use(InspectorContext);
  const ref = useRef<HTMLAnchorElement>(null);
  if (inspector === null) throw new Error("EventInspectorLink must be rendered inside EventInspector");
  return (
    <Link
      ref={ref}
      href={eventHref(inspector.baseHref, eventId)}
      prefetch={false}
      scroll={false}
      aria-haspopup="dialog"
      aria-current={inspector.selectedId === eventId ? "location" : undefined}
      onNavigate={(event) => {
        event.preventDefault();
        inspector.select(eventId, ref.current);
      }}
      className="after:absolute after:inset-0 after:rounded-xl hover:text-accent aria-current:text-accent focus-visible:after:outline-2 focus-visible:after:outline-accent"
    >
      {children}
    </Link>
  );
}

function EventDetails({ event, href }: { event: TimelineEvent; href: string }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [manualLink, setManualLink] = useState<string | null>(null);
  const linkId = useId();
  const provider = providerName(event.provider);
  const source = event.accountName ?? event.connectionName;

  async function copyLink() {
    const url = new URL(href, window.location.origin).href;
    setOutcome(null);
    try {
      await navigator.clipboard.writeText(url);
      setManualLink(null);
      setOutcome({ tone: "info", message: "Copied the event link." });
    } catch {
      setManualLink(url);
      setOutcome({ tone: "error", message: "Could not copy the event link. Select the link below and copy it yourself." });
    }
  }

  return (
    <div className="mt-6 space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <ProviderMark provider={event.provider} size="sm" />
        <span className="text-sm">{provider}</span>
        <SeverityBadge severity={severityBadge(event.severity)} />
        {event.simulated ? <SimulatedBadge /> : null}
      </div>
      <h3 className="break-words text-xl font-semibold leading-7">{event.title}</h3>
      <dl className="grid gap-3 text-sm">
        <div><dt className="text-muted">Event type</dt><dd className="mt-1 break-words">{eventTypeLabel(event.type_id)}</dd></div>
        {source === null ? null : <div><dt className="text-muted">Source account</dt><dd className="mt-1 break-words">{source}</dd></div>}
        <div><dt className="text-muted">London time</dt><dd className="mt-1 font-mono text-xs">{formatDateTime(event.occurred_at)}</dd></div>
        <div><dt className="text-muted">Exact timestamp (UTC)</dt><dd className="mt-1 break-all font-mono text-xs"><time dateTime={event.occurred_at}>{event.occurred_at}</time></dd></div>
      </dl>
      <div className="border-t border-line pt-4">
        <h4 className="text-sm font-semibold">Details</h4>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-muted">
          {event.body || "This event has no additional details."}
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        {event.url?.startsWith("https://") ? (
          <a href={event.url} target="_blank" rel="noopener noreferrer" className={buttonClass("raised", "sm")}>
            View in {provider}<span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
        <button type="button" onClick={copyLink} className={buttonClass("secondary", "sm")}>Copy event link</button>
      </div>
      <OutcomeAnnouncement outcome={outcome} />
      {manualLink === null ? null : (
        <div>
          <label htmlFor={linkId} className="text-sm font-medium">Event link</label>
          <input id={linkId} readOnly value={manualLink} onFocus={(event) => event.currentTarget.select()} className="mt-2 min-h-10 w-full rounded-md border border-line-strong bg-background px-3 text-sm" />
        </div>
      )}
    </div>
  );
}
