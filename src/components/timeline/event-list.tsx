import { SimulatedBadge } from "@/components/connections/simulated-badge";
import { PlatformLogo } from "@/components/icons";
import { SeverityBadge } from "@/components/severity-badge";
import type { ProviderId } from "@/lib/adapters/types";
import type { TimelineEvent } from "@/lib/data/timeline";
import { providerName, providerPlatform } from "@/lib/providers";
import { severityBadge } from "@/lib/timeline/query";

import { EventTime } from "./event-time";

/**
 * One page of events, newest first. Every row prints its provider and severity as words, and
 * "Simulated" when its provider, or the connection a DevMacro event is about, is simulated here.
 */
export function EventList({
  events,
  now,
  simulatedProviders,
}: {
  events: readonly TimelineEvent[];
  now: Date;
  simulatedProviders: readonly ProviderId[];
}) {
  return (
    <ol aria-label="Events" className="mt-4 divide-y divide-line overflow-hidden rounded-xl border border-line bg-panel">
      {events.map((event) => {
        const provider = event.provider ?? event.connectionProvider;
        return (
          <EventItem
            key={event.id}
            event={event}
            now={now}
            simulated={provider !== null && simulatedProviders.includes(provider)}
          />
        );
      })}
    </ol>
  );
}

function EventItem({ event, now, simulated }: { event: TimelineEvent; now: Date; simulated: boolean }) {
  const platform = providerPlatform(event.provider);
  // The account says which team or repository; the connection name is the fallback.
  const source = event.accountName ?? event.connectionName;
  return (
    <li className="flex gap-3 px-4 py-4 sm:px-5">
      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-line bg-panel-raised text-foreground">
        {platform === null ? null : <PlatformLogo platform={platform} className="size-4" />}
      </span>
      <article className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="min-w-0 font-mono text-xs text-muted">
            <span className="text-foreground">{providerName(event.provider)}</span>
            {source === null ? null : (
              <>
                <span aria-hidden="true"> · </span>
                <span className="sr-only">, </span>
                <span className="break-words">{source}</span>
              </>
            )}
          </p>
          <EventTime occurredAt={event.occurred_at} now={now} />
        </div>
        <div className="mt-1 flex items-start justify-between gap-3">
          <h2 className="min-w-0 break-words text-sm font-medium leading-6">{event.title}</h2>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            {simulated ? <SimulatedBadge /> : null}
            <SeverityBadge severity={severityBadge(event.severity)} />
          </div>
        </div>
        {event.body === null ? null : (
          <p className="mt-1 whitespace-pre-line break-words text-sm leading-6 text-muted">{event.body}</p>
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
