import { AchievementEarnedLabel } from "@/components/achievements/achievement-earned-label";
import { SimulatedBadge } from "@/components/connections/simulated-badge";
import { ChevronDownIcon } from "@/components/icons";
import { ProviderMark } from "@/components/ui/provider-mark";
import { SeverityBadge } from "@/components/severity-badge";
import { ACHIEVEMENT_EARNED_TYPE_ID } from "@/lib/achievements/events";
import { eventTypeName } from "@/lib/adapters/registry";
import type { TimelineEvent } from "@/lib/data/timeline";
import { providerName } from "@/lib/providers";
import { groupEventsByDay } from "@/lib/timeline/days";
import { severityBadge, type EventSeverity } from "@/lib/timeline/query";
import { groupEventRuns, type EventRun } from "@/lib/timeline/runs";

import { ArrivalEventRow, ArrivalEvents, ArrivalFlash, ArrivalNewLabel } from "./arrival-events";
import { EventTime } from "./event-time";
import { EventInspectorLink } from "./event-inspector";

// Severity stays on the node and in every row's status pill (#594), not a competing left edge.
// Only an arriving event flashes a left edge for a moment (#171).
const SEVERITY_NODE: Record<EventSeverity, string> = {
  info: "border-line-strong",
  success: "border-success",
  warning: "border-warning",
  critical: "border-danger",
};

// The neutral line connects chronological neighbors, not causes or dependent events. Rows are flat
// (#385): no card, only a divider under each row's content, so the line never crosses one.
const TIMELINE_ROW = "group/row grid grid-cols-[2.5rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1 pt-2 before:pointer-events-none before:absolute before:inset-y-0 before:left-5 before:-z-10 before:w-px before:bg-line-strong last:before:bottom-auto last:before:h-7 lg:grid-cols-[7.5rem_2.5rem_minmax(0,1fr)] lg:gap-x-4 lg:before:left-[9.75rem]";

// A row's content: the surface its arrival flash and its details link's hit area cover, reaching a
// little left of the text so neither touches it. The divider starts at the text, and the last row
// of a day has none: the next day's heading draws its own line. The surface lightens under the
// pointer and takes the accent wash while its event is open in the details panel (#399), fading
// briefly except under reduced motion; the `:has()` stays inside the row.
const ROW_CONTENT = "relative isolate col-start-2 min-w-0 -ml-2 rounded-md pb-2 pl-2 transition-colors motion-reduce:transition-none after:pointer-events-none after:absolute after:bottom-0 after:left-2 after:right-0 after:h-px after:bg-line hover:bg-panel-raised has-[a[aria-current=location]]:bg-accent-soft group-last/row:after:hidden lg:col-start-3 lg:row-start-1 lg:pt-2.5";

// An event inside an expanded run takes the same wash when it is the open one, over its run's.
const RUN_MEMBER = "px-3 py-2 transition-colors motion-reduce:transition-none has-[a[aria-current=location]]:bg-accent-soft";

// The left edge an arriving event's row flashes (#171), in its severity's color. Info uses the
// accent, since the node's neutral border would not stand out as an arrival.
const SEVERITY_FLASH: Record<EventSeverity, string> = {
  info: "var(--accent)",
  success: "var(--success)",
  warning: "var(--warning)",
  critical: "var(--danger)",
};

/**
 * One page of events, newest first, under a heading per London day. The events region holds one
 * list per day, labelled by that day's heading, so a screen reader can jump between days by
 * heading and still hear how many rows each day holds. A burst of identical events is one row
 * (#253). With `markSimulated`, a row prints "Simulated" when its connection was made by the
 * provider simulator; the page passes false when it says so once for every row instead (#269).
 * Events that arrive while the page is open are marked (#171).
 */
export function EventList({ events, now, markSimulated }: { events: readonly TimelineEvent[]; now: Date; markSimulated: boolean }) {
  return (
    <section aria-label="Events" className="mt-4">
      {/* Said once for the whole feed (#385); each time's accessible text also names GMT or BST. */}
      <p className="text-xs text-muted">Times are London time.</p>
      <div className="grid gap-6">
        <ArrivalEvents eventIds={events.map((event) => event.id)}>
          {groupEventsByDay(events, now).map((day) => {
            const headingId = `timeline-day-${day.date}`;
            return (
              <section key={day.date}>
                {/* Below the shell's 3.5rem header, 2.75rem nav, and borders; no scroll listener. */}
                <div className="sticky top-[calc(6.25rem+2px)] z-20 border-b border-line bg-background py-3 md:top-[calc(6.25rem+1px)]">
                  <h2 id={headingId} className="text-sm font-semibold text-foreground">{day.label}</h2>
                </div>
                {/* The first row's own top padding follows the heading's line, as every row follows a divider. */}
                <ol aria-labelledby={headingId}>
                  {groupEventRuns(day.events).map((run) =>
                    // Keyed by the run's oldest event: arrivals join a run at its newest end, so the
                    // row they join keeps its key, stays mounted, and keeps its disclosure state.
                    run.length === 1 ? (
                      <EventItem key={run[0].id} event={run[0]} now={now} markSimulated={markSimulated} />
                    ) : (
                      <EventRunItem key={(run.at(-1) ?? run[0]).id} run={run} now={now} markSimulated={markSimulated} />
                    ),
                  )}
                </ol>
              </section>
            );
          })}
        </ArrivalEvents>
      </div>
    </section>
  );
}

function EventItem({ event, now, markSimulated }: { event: TimelineEvent; now: Date; markSimulated: boolean }) {
  // The account says which team or repository; the connection name is the fallback.
  const source = event.accountName ?? event.connectionName;
  return (
    <ArrivalEventRow eventIds={[event.id]} className={TIMELINE_ROW}>
      <TimelinePosition event={event} now={now} />
      <article className={ROW_CONTENT}>
        <ArrivalFlash eventIds={[event.id]} flash={SEVERITY_FLASH[event.severity]} className="rounded-md" />
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="break-words text-sm font-medium leading-5">
                <EventInspectorLink eventId={event.id}>{event.title}</EventInspectorLink>
              </h3>
              {event.type_id === ACHIEVEMENT_EARNED_TYPE_ID ? <AchievementEarnedLabel /> : null}
            </div>
            <p className="mt-0.5 break-words text-xs text-muted">
              <span className="text-foreground">{providerName(event.markProvider)}</span>
              {source === null ? null : (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="sr-only">, </span>
                  <span>{source}</span>
                </>
              )}
              <ArrivalNewLabel eventIds={[event.id]} />
            </p>
          </div>
          <RowLabels severity={event.severity} emoji={event.emoji} achievement={event.achievement !== null} simulated={markSimulated && event.simulated} />
        </div>
      </article>
    </ArrivalEventRow>
  );
}

/**
 * A run of identical events (#253) as one row: what happened, how many times, and when the latest
 * was, with each event one disclosure away. The heading is the events' shared title, or the name
 * their adapter declares for their type when the titles differ (payments of different amounts),
 * and the count sits beside it rather than in it, so the row is found by
 * the same heading as a single event. The heading stays outside the summary, whose children are
 * presentational, so heading navigation still reaches the row.
 */
function EventRunItem({ run, now, markSimulated }: { run: EventRun<TimelineEvent>; now: Date; markSimulated: boolean }) {
  const [latest] = run;
  const source = latest.accountName ?? latest.connectionName;
  const eventIds = run.map((event) => event.id);
  // A run of payments with different amounts (#261) is named the way each payment is, by its type.
  const title = run.every((event) => event.title === latest.title) ? latest.title : eventTypeName(latest.type_id);
  const count = `${run.length} events`;
  return (
    <ArrivalEventRow eventIds={eventIds} className={TIMELINE_ROW}>
      <TimelinePosition event={latest} now={now} latest />
      <article className={ROW_CONTENT}>
        <ArrivalFlash eventIds={eventIds} flash={SEVERITY_FLASH[latest.severity]} className="rounded-md" />
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="break-words text-sm font-medium leading-5">
                <EventInspectorLink eventId={latest.id}>{title}</EventInspectorLink>
              </h3>
              <span className="whitespace-nowrap rounded-full border border-line-strong px-1.5 font-mono text-[11px] text-muted">
                {count}
              </span>
              {/* A run of different achievements is already headed "Achievement earned". */}
              {latest.type_id === ACHIEVEMENT_EARNED_TYPE_ID && title === latest.title ? <AchievementEarnedLabel /> : null}
            </div>
            <p className="mt-0.5 break-words text-xs text-muted">
              <span className="text-foreground">{providerName(latest.markProvider)}</span>
              {source === null ? null : (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="sr-only">, </span>
                  <span>{source}</span>
                </>
              )}
              <ArrivalNewLabel eventIds={eventIds} />
            </p>
          </div>
          <RowLabels severity={latest.severity} emoji={latest.emoji} achievement={latest.achievement !== null} simulated={markSimulated && latest.simulated} />
        </div>
        <details className="group relative z-10 mt-2">
          <summary className="inline-flex min-h-6 list-none items-center gap-1 text-sm text-accent underline-offset-4 hover:underline [&::-webkit-details-marker]:hidden">
            <span className="group-open:hidden">Show the {count}</span>
            <span className="hidden group-open:inline">Hide the {count}</span>
            <ChevronDownIcon className="size-4 shrink-0 transition-transform motion-reduce:transition-none group-open:rotate-180" />
          </summary>
          <ol aria-label={`${title}: ${count}`} className="mt-2 divide-y divide-line rounded-lg border border-line">
            {run.map((event) => (
              <EventRunMember key={event.id} event={event} now={now} />
            ))}
          </ol>
        </details>
      </article>
    </ArrivalEventRow>
  );
}

/**
 * The row's status pill, with the event's emoji inside it rather than over the provider logo
 * (#594). The word is the severity's (`severityBadge`), so a neutral row's "Info" matches the
 * filters and event details; an achievement shows its gold label instead of the ordinary Success.
 */
function RowLabels({ severity, emoji, achievement, simulated }: { severity: EventSeverity; emoji: string; achievement: boolean; simulated: boolean }) {
  const word = achievement ? "Achievement" : severityBadge(severity);
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
      {simulated ? <SimulatedBadge /> : null}
      <SeverityBadge severity={word} emoji={emoji} />
    </div>
  );
}

function TimelinePosition({ event, now, latest = false }: { event: TimelineEvent; now: Date; latest?: boolean }) {
  return (
    <>
      <div className="col-start-2 row-start-1 min-w-0 lg:col-start-1 lg:pt-3">
        {latest ? <span className="sr-only">Latest event: </span> : null}
        <EventTime occurredAt={event.occurred_at} now={now} gutter />
      </div>
      <div aria-hidden="true" className="col-start-1 row-span-2 row-start-1 lg:col-start-2 lg:row-span-1">
        <span className={`flex size-10 items-center justify-center rounded-lg border bg-background ${event.achievement === null ? SEVERITY_NODE[event.severity] : "border-gold/60"}`}>
          <ProviderMark provider={event.markProvider} size="sm" />
        </span>
      </div>
    </>
  );
}

/**
 * One event inside an expanded run: its own title, time, and inspector link. The provider, account,
 * severity, and simulated label are the run's, already on the row above, so they are not repeated.
 */
function EventRunMember({ event, now }: { event: TimelineEvent; now: Date }) {
  return (
    <ArrivalEventRow eventIds={[event.id]} className={RUN_MEMBER}>
      <ArrivalFlash eventIds={[event.id]} flash={SEVERITY_FLASH[event.severity]} />
      <h4 className="break-words text-sm leading-5">
        <EventInspectorLink eventId={event.id}>{event.title}</EventInspectorLink>
      </h4>
      <p className="mt-0.5 break-words">
        <EventTime occurredAt={event.occurred_at} now={now} />
        <ArrivalNewLabel eventIds={[event.id]} />
      </p>
    </ArrivalEventRow>
  );
}
