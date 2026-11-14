"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { createContext, use, useEffect, useEffectEvent, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { PublishAchievementButton } from "@/components/achievements/achievement-controls";
import { AchievementEarnedLabel } from "@/components/achievements/achievement-earned-label";
import { SimulatedBadge } from "@/components/connections/simulated-badge";
import { GuardedButton } from "@/components/guarded-button";
import { AchievementShareDialog } from "@/components/public-metrics/achievement-share-dialog";
import { PublicationAnnouncer } from "@/components/public-metrics/publication-controls";
import { SeverityBadge } from "@/components/severity-badge";
import { buttonClass } from "@/components/ui/button";
import { LiveRegion, OutcomeAnnouncement, type Outcome } from "@/components/ui/live-region";
import { DialogCloseButton, ModalDialog, useModalDialog } from "@/components/ui/modal-dialog";
import { ProviderMark } from "@/components/ui/provider-mark";
import { ACHIEVEMENT_EARNED_TYPE_ID } from "@/lib/achievements/events";
import type { TimelineAchievement } from "@/lib/achievements/private";
import type { TimelineEvent } from "@/lib/data/timeline";
import { providerName } from "@/lib/providers";
import { parseTimelineEventId, severityBadge, type EventFilterHrefs } from "@/lib/timeline/query";

/**
 * An event with what the server writes for it: its London time, since browsers name the London
 * zone differently, its type's declared name, from the server-only adapter registry (#294), and
 * its filter links, built with `timelineHref` so the panel never writes a query string itself. An
 * "Achievement earned" entry (#413) also carries its achievement, read with the page's events.
 */
export type InspectorEvent = Omit<TimelineEvent, "achievement"> &
  Readonly<{ londonTime: string; typeName: string; filterHrefs: EventFilterHrefs; achievement: TimelineAchievement | null }>;

/** What the viewer may do with an achievement entry, and the origin its share links use. */
export type AchievementActions = Readonly<{ workspaceSlug: string; canPublish: boolean; siteOrigin: string }>;

const InspectorContext = createContext<{
  baseHref: string;
  selectedId: string | null;
  select: (id: string, opener: HTMLAnchorElement | null) => void;
} | null>(null);

function eventHref(baseHref: string, id: string): string {
  return `${baseHref}${baseHref.includes("?") ? "&" : "?"}event=${encodeURIComponent(id)}`;
}

// `select` marks the history entry it pushes, so closing still goes back to the entry before it
// after the route was hidden and shown again, as Back from a related event link does (#394). Next
// keeps custom history state when it traverses to an entry (`preserveCustomHistoryState`).
const PUSHED_ENTRY = "devmacroInspectorPushed";

function onPushedEntry(): boolean {
  const state: unknown = window.history.state;
  return typeof state === "object" && state !== null && PUSHED_ENTRY in state && state[PUSHED_ENTRY] === true;
}

/** Shows `href` in place of the current entry, keeping the mark `select` put on it. */
function replaceEntry(href: string): void {
  window.history.replaceState(onPushedEntry() ? { [PUSHED_ENTRY]: true } : null, "", href);
}

/**
 * Loaded rows open without a request; a full navigation resolves shared links on the server. With
 * no opener (a shared link, a reload, Forward), focus returns to the event's row when it is on this
 * page, and to `fallbackFocusId` otherwise.
 */
export function EventInspector({ events, linkedEvent, baseHref, fallbackFocusId, achievementActions, children }: {
  events: readonly InspectorEvent[];
  linkedEvent: InspectorEvent | null;
  baseHref: string;
  fallbackFocusId: string;
  achievementActions: AchievementActions;
  children: ReactNode;
}) {
  const searchParams = useSearchParams();
  const selectedId = parseTimelineEventId(searchParams.get("event") ?? undefined);
  const open = selectedId !== null;
  const selected = events.find((event) => event.id === selectedId)
    ?? (linkedEvent?.id === selectedId ? linkedEvent : null);
  // The panel fades out after closing (#399), by which time the URL no longer names the event, so
  // it keeps showing the event it showed rather than "Event unavailable" until it opens again.
  const [shown, setShown] = useState(selected);
  if (open && shown !== selected) setShown(selected);
  const current = open ? selected : shown;
  const selectedIndex = current === null ? -1 : events.findIndex((event) => event.id === current.id);
  const newer = selectedIndex > 0 ? events[selectedIndex - 1] : undefined;
  const older = selectedIndex >= 0 ? events[selectedIndex + 1] : undefined;
  const dialog = useModalDialog({ fallbackFocusId });
  const opener = useRef<HTMLAnchorElement | null>(null);
  // True while the open inspector is the history entry `select` pushed, so closing goes back to it.
  const pushed = useRef(false);

  const syncDialog = useEffectEvent(() => {
    if (open && !dialog.ref.current?.open) {
      dialog.open(opener.current ?? (selectedIndex >= 0 ? visibleRowLink() : null));
      opener.current = null;
    }
    if (!open && dialog.ref.current?.open) dialog.close();
  });
  useEffect(() => { syncDialog(); }, [open]);

  // With cacheComponents, Next hides a route it leaves instead of unmounting it, and an open modal
  // under `display: none` keeps the visible page inert. Close it on hide; the URL reopens it. The
  // current entry may not be the one `select` pushed when the route shows again, so closing then
  // reads the entry's own mark (`onPushedEntry`) rather than this ref.
  useLayoutEffect(() => {
    const element = dialog.ref.current;
    return () => {
      pushed.current = false;
      element?.close();
    };
  }, [dialog.ref]);

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
    // A second activation (a double-click, a held Enter) can land before the dialog opens, and
    // closing goes back one entry, so never stack a second selection entry. Read the URL rather
    // than `pushed`: a click between Escape and its popstate would leave `pushed` set on an entry
    // `select` did not push, and the next close would go back out of the timeline.
    if (new URL(window.location.href).searchParams.has("event")) {
      replaceEntry(eventHref(baseHref, id));
      return;
    }
    pushed.current = true;
    window.history.pushState({ [PUSHED_ENTRY]: true }, "", eventHref(baseHref, id));
  }

  function closeSelection() {
    const url = new URL(window.location.href);
    // Back may have already removed the selection, or this route was hidden for another page.
    // Never overwrite that navigation.
    if (!url.searchParams.has("event") || url.pathname !== new URL(baseHref, url.origin).pathname) {
      pushed.current = false;
      return;
    }
    // Going back to the entry before the pushed one leaves no duplicate timeline entry behind. The
    // ref survives a refresh, which drops the entry's mark; the mark survives the route being hidden.
    if (pushed.current || onPushedEntry()) {
      pushed.current = false;
      window.history.back();
      return;
    }
    url.searchParams.delete("event");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  function moveTo(event: InspectorEvent | undefined) {
    if (event === undefined) return;
    replaceEntry(eventHref(baseHref, event.id));
    dialog.ref.current?.scrollTo({ top: 0, behavior: "instant" });
  }

  return (
    <InspectorContext value={{ baseHref, selectedId, select }}>
      {children}
      <ModalDialog
        dialog={dialog}
        title="Event details"
        titleAction={<DialogCloseButton className={buttonClass("secondary", "sm")}>Close event</DialogCloseButton>}
        size="inspector"
        lightDismiss
        onClose={closeSelection}
      >
        {current === null ? (
          <div className="mt-6 space-y-3">
            <h3 className="text-lg font-semibold">Event unavailable</h3>
            <p className="text-sm leading-6 text-muted">
              This event is no longer available in this workspace. Select Close event, then choose another one.
            </p>
          </div>
        ) : (
          <>
            <EventDetails key={current.id} event={current} href={eventHref(baseHref, current.id)} achievementActions={achievementActions} />
            <nav aria-label="Events on this page" className="mt-6 flex flex-wrap gap-2 border-t border-line pt-4">
              <GuardedButton type="button" unavailable={newer === undefined} onClick={() => moveTo(newer)} className={buttonClass("secondary", "sm")}>
                Newer event
              </GuardedButton>
              <GuardedButton type="button" unavailable={older === undefined} onClick={() => moveTo(older)} className={buttonClass("secondary", "sm")}>
                Older event
              </GuardedButton>
            </nav>
            <p className="mt-2 text-xs text-muted">Navigation follows the events on this page.</p>
            <LiveRegion tone="status" className="sr-only">Viewing {current.title}</LiveRegion>
          </>
        )}
      </ModalDialog>
    </InspectorContext>
  );
}

/** The selected event's own row link; a burst's latest event is also inside its closed disclosure. */
function visibleRowLink(): HTMLAnchorElement | null {
  const links = document.querySelectorAll<HTMLAnchorElement>('a[aria-haspopup="dialog"][aria-current="location"]');
  return Array.from(links).find((link) => link.checkVisibility()) ?? null;
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
      className="after:absolute after:inset-0 after:rounded-md hover:text-accent aria-[current=location]:text-accent focus-visible:after:outline-2 focus-visible:after:outline-accent"
    >
      {children}
    </Link>
  );
}

function EventDetails({ event, href, achievementActions }: { event: InspectorEvent; href: string; achievementActions: AchievementActions }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [manualLink, setManualLink] = useState<string | null>(null);
  const linkId = useId();
  const provider = providerName(event.markProvider);
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
        <ProviderMark provider={event.markProvider} emoji={event.emoji} size="sm" />
        <span className="text-sm">{provider}</span>
        <SeverityBadge severity={event.achievement === null ? severityBadge(event.severity) : "Achievement"} />
        {event.type_id === ACHIEVEMENT_EARNED_TYPE_ID ? <AchievementEarnedLabel /> : null}
        {event.simulated ? <SimulatedBadge /> : null}
      </div>
      <h3 className="break-words text-xl font-semibold leading-7">{event.title}</h3>
      <dl className="grid gap-3 text-sm">
        <div><dt className="text-muted">Event type</dt><dd className="mt-1 break-words">{event.typeName}</dd></div>
        {source === null ? null : <div><dt className="text-muted">Source account</dt><dd className="mt-1 break-words">{source}</dd></div>}
        {event.achievement === null ? null : <div><dt className="text-muted">Project</dt><dd className="mt-1 break-words">{event.achievement.projectName}</dd></div>}
        <div><dt className="text-muted">London time</dt><dd className="mt-1 font-mono text-xs">{event.londonTime}</dd></div>
        <div><dt className="text-muted">Exact timestamp (UTC)</dt><dd className="mt-1 break-all font-mono text-xs"><time dateTime={event.occurred_at}>{event.occurred_at}</time></dd></div>
      </dl>
      <div className="border-t border-line pt-4">
        <h4 className="text-sm font-semibold">Details</h4>
        <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-muted">
          {event.body || "This event has no additional details."}
        </p>
      </div>
      {event.achievement === null ? null : <AchievementPublication achievement={event.achievement} title={event.title} actions={achievementActions} />}
      <div className="flex flex-wrap gap-2">
        {event.url?.startsWith("https://") ? (
          <a href={event.url} target="_blank" rel="noopener noreferrer" className={buttonClass("raised", "sm")}>
            View in {provider}<span className="sr-only"> (opens in a new tab)</span>
          </a>
        ) : null}
        {event.achievement === null ? null : (
          <Link href={event.achievement.href} className={buttonClass("raised", "sm")}>
            View in project achievements
          </Link>
        )}
        <button type="button" onClick={copyLink} className={buttonClass("secondary", "sm")}>Copy event link</button>
      </div>
      <OutcomeAnnouncement outcome={outcome} />
      {manualLink === null ? null : (
        <div>
          <label htmlFor={linkId} className="text-sm font-medium">Event link</label>
          <input id={linkId} readOnly value={manualLink} onFocus={(event) => event.currentTarget.select()} className="mt-2 min-h-10 w-full rounded-md border border-line-strong bg-background px-3 text-sm" />
        </div>
      )}
      <RelatedEvents hrefs={event.filterHrefs} />
    </div>
  );
}

/**
 * Whether an "Achievement earned" entry's achievement is public (#413), with Share once it is.
 * Before then, owners and admins can publish it from here, and other members see the state alone.
 * A publish swaps its button for Share, so the announcement lives above both and focus moves to
 * this section's heading.
 */
function AchievementPublication({ achievement, title, actions }: {
  achievement: TimelineAchievement;
  title: string;
  actions: AchievementActions;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="border-t border-line pt-4">
      <h4 id={headingId} tabIndex={-1} className="text-sm font-semibold">Publication</h4>
      <PublicationAnnouncer>
        <p className="mt-2 break-words text-sm leading-6 text-muted">
          {achievement.published
            ? `Published. Anyone can see it as ${achievement.publicTitle}.`
            : "Not published. Only members of this workspace can see it."}
        </p>
        {achievement.published ? (
          <div className="mt-3">
            <AchievementShareDialog
              projectId={achievement.projectId}
              achievementId={achievement.achievementId}
              publicTitle={achievement.publicTitle}
              providerName={achievement.providerName}
              siteOrigin={actions.siteOrigin}
              projectPage={achievement.projectPage}
            />
          </div>
        ) : actions.canPublish ? (
          <div className="mt-3">
            <PublishAchievementButton
              workspaceSlug={actions.workspaceSlug}
              projectId={achievement.projectId}
              achievementId={achievement.achievementId}
              title={title}
              focusId={headingId}
            />
          </div>
        ) : null}
      </PublicationAnnouncer>
    </section>
  );
}

/**
 * Next steps from one event: the timeline showing only its type, its account, or the time around
 * it. Each is a plain navigation, so the panel closes once the URL drops `event`, and Back returns
 * to the open panel.
 */
function RelatedEvents({ hrefs }: { hrefs: EventFilterHrefs }) {
  const headingId = useId();
  const links = [
    { href: hrefs.type, label: "Show only this event type" },
    ...(hrefs.account === null ? [] : [{ href: hrefs.account, label: "Show only this account" }]),
    { href: hrefs.around, label: "Show events around this time" },
  ];
  return (
    <section aria-labelledby={headingId} className="border-t border-line pt-4">
      <h4 id={headingId} className="text-sm font-semibold">Related events</h4>
      <ul className="mt-2 flex flex-wrap gap-2">
        {links.map((link) => (
          <li key={link.label}>
            <Link href={link.href} prefetch={false} className={buttonClass("secondary", "sm")}>
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
