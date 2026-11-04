import { SimulatedBadge } from "@/components/connections/simulated-badge";
import { PlatformLogo } from "@/components/icons";
import { SeverityBadge } from "@/components/severity-badge";
import type { TimelineEvent } from "@/lib/data/timeline";
import { providerName, providerPlatform } from "@/lib/providers";
import { groupEventsByDay } from "@/lib/timeline/days";
import { severityBadge, type EventSeverity } from "@/lib/timeline/query";

import { EventTime } from "./event-time";

// A quick visual scan only: the badge on every row still prints the severity as a word.
const SEVERITY_EDGE: Record<EventSeverity, string> = {
  info: "border-l-line-strong",
  success: "border-l-success",
  warning: "border-l-warning",
  critical: "border-l-danger",
};

/**
 * One page of events, newest first, under a heading per London day. The events region holds one
 * list per day, labelled by that day's heading, so a screen reader can jump between days by
 * heading and still hear how many events each day holds. Every row prints "Simulated" when its
 * connection was made by the provider simulator.
 */
export function EventList({ events, now }: { events: readonly TimelineEvent[]; now: Date }) {
  return (
    <section aria-label="Events" className="mt-6 grid gap-6">
      {groupEventsByDay(events, now).map((day) => {
        const headingId = `timeline-day-${day.date}`;
        return (
          <section key={day.date} className="grid gap-2">
            <h2 id={headingId} className="text-sm font-semibold text-foreground">
              {day.label}
            </h2>
            <ol
              aria-labelledby={headingId}
              className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel"
            >
              {day.events.map((event) => (
                <EventItem key={event.id} event={event} now={now} />
              ))}
            </ol>
          </section>
        );
      })}
    </section>
  );
}

function EventItem({ event, now }: { event: TimelineEvent; now: Date }) {
  const platform = providerPlatform(event.provider);
  // The account says which team or repository; the connection name is the fallback.
  const source = event.accountName ?? event.connectionName;
  return (
    <li className={`flex gap-3 border-l-2 px-4 py-3 sm:px-5 ${SEVERITY_EDGE[event.severity]}`}>
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-line bg-panel-raised text-foreground">
        {platform === null ? null : <PlatformLogo platform={platform} className="size-4" />}
      </span>
      <article className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="break-words text-sm font-medium leading-5">{event.title}</h3>
            <p className="mt-0.5 break-words font-mono text-xs text-muted">
              <span className="text-foreground">{providerName(event.provider)}</span>
              {source === null ? null : (
                <>
                  <span aria-hidden="true"> · </span>
                  <span className="sr-only">, </span>
                  <span>{source}</span>
                </>
              )}
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, </span>
              <EventTime occurredAt={event.occurred_at} now={now} />
            </p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {event.simulated ? <SimulatedBadge /> : null}
            <SeverityBadge severity={severityBadge(event.severity)} />
          </div>
        </div>
        {event.body === null ? null : (
          <p className="mt-1 whitespace-pre-line break-words text-sm leading-5 text-muted">{event.body}</p>
        )}
        {event.url === null || !event.url.startsWith("https://") ? null : (
          <a
            href={event.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex min-h-6 items-center text-sm text-accent underline-offset-4 hover:underline"
          >
            View in {providerName(event.provider)}
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
      </article>
    </li>
  );
}
