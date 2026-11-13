import Link from "next/link";

import { ScopeFilter } from "@/components/filters/scope-filter";
import type { ScopeOptions } from "@/lib/filters/scope";
import { typeOwnerName } from "@/lib/providers";
import {
  EVENT_SEVERITIES,
  eventTypeLabel,
  MAX_SEARCH_LENGTH,
  severityBadge,
  timelineHref,
  type TimelineQuery,
} from "@/lib/timeline/query";

const CHECKBOX_LABEL = "flex min-h-6 cursor-pointer items-center gap-2 px-1 text-sm";
const CHECKBOX = "size-4 shrink-0 accent-accent";
const TEXT_INPUT =
  "mt-1 block min-h-10 w-full rounded-md border border-line-strong bg-panel-raised px-3 py-2 text-sm text-foreground [color-scheme:dark]";

const SEVERITY_LINK = "inline-flex min-h-10 items-center rounded-md border px-4 py-2 text-sm transition-colors";

/**
 * One-click severity views, so the commonest filter needs no form. Each link keeps every other
 * filter and, like the form, starts from the newest events because it carries no cursor. A
 * mixed severity selection from the form marks no link as current.
 */
export function SeverityLinks({ action, query }: { action: string; query: TimelineQuery }) {
  const links = [
    { label: "All", severities: [], current: query.severities.length === 0 },
    ...EVENT_SEVERITIES.map((severity) => ({
      label: severityBadge(severity),
      severities: [severity],
      current: query.severities.length === 1 && query.severities[0] === severity,
    })),
  ];
  return (
    <nav aria-label="Severity" className="mt-4 flex flex-wrap gap-2">
      {links.map(({ label, severities, current }) => (
        <Link
          key={label}
          href={timelineHref(action, { ...query, severities }, null)}
          scroll={false}
          aria-current={current ? "page" : undefined}
          className={`${SEVERITY_LINK} ${
            current ? "border-accent font-medium text-foreground" : "border-line-strong text-muted hover:text-foreground"
          }`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * The shared scope filter (provider, project, account) with the timeline's own fields: a title
 * search, event type, severity, and dates. Submitting starts from the newest events, because the
 * form carries no cursor.
 */
export function TimelineFilters({
  action,
  query,
  typeIds,
  scopeOptions,
  status,
}: {
  action: string;
  query: TimelineQuery;
  /** Type ids present in the workspace; selected ones are added so they can be unticked. */
  typeIds: readonly string[];
  scopeOptions: ScopeOptions;
  /** The result in words, such as "Showing 3 events for provider GitHub". */
  status: string;
}) {
  const typeOptions = [...new Set([...typeIds, ...query.types])].sort();
  const extraActiveCount =
    query.types.length +
    query.severities.length +
    (query.from === null ? 0 : 1) +
    (query.to === null ? 0 : 1) +
    (query.timeRange === null ? 0 : 1) +
    (query.search === null ? 0 : 1);
  return (
    <ScopeFilter
      action={action}
      scope={query.scope}
      options={scopeOptions}
      status={status}
      extraActiveCount={extraActiveCount}
      hidden={query.timeRange === null ? undefined : { start: query.timeRange.from, until: query.timeRange.toExclusive }}
      resetKey={JSON.stringify([query.types, query.severities, query.from, query.to, query.search, query.timeRange])}
    >
      <label className="block text-sm font-medium">
        Search event titles
        <input
          type="search"
          name="q"
          defaultValue={query.search ?? ""}
          maxLength={MAX_SEARCH_LENGTH}
          autoComplete="off"
          className={`${TEXT_INPUT} font-normal`}
        />
      </label>
      <div className="grid gap-6 md:grid-cols-[2fr_1fr_1fr]">
        <fieldset className="min-w-0">
          <legend className="text-sm font-medium">Event type</legend>
          <div className="mt-2 grid max-h-56 gap-1 overflow-y-auto pr-1 sm:grid-cols-2">
            {typeOptions.map((typeId) => (
              <label key={typeId} className={CHECKBOX_LABEL}>
                <input
                  type="checkbox"
                  name="type"
                  value={typeId}
                  defaultChecked={query.types.includes(typeId)}
                  className={CHECKBOX}
                />
                <span className="min-w-0 break-words">
                  {typeOwnerName(typeId)}: {eventTypeLabel(typeId)}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium">Severity</legend>
          <div className="mt-2 grid gap-1">
            {EVENT_SEVERITIES.map((severity) => (
              <label key={severity} className={CHECKBOX_LABEL}>
                <input
                  type="checkbox"
                  name="severity"
                  value={severity}
                  defaultChecked={query.severities.includes(severity)}
                  className={CHECKBOX}
                />
                <span>{severityBadge(severity)}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium">Date range</legend>
          <p id="timeline-dates-hint" className="mt-1 text-xs text-muted">
            Whole days, UK time. Both dates are included.
          </p>
          <div className="mt-2 grid gap-3">
            <label className="block text-sm">
              From date
              <input
                type="date"
                name="from"
                defaultValue={query.from ?? ""}
                aria-describedby="timeline-dates-hint"
                className={TEXT_INPUT}
              />
            </label>
            <label className="block text-sm">
              To date
              <input
                type="date"
                name="to"
                defaultValue={query.to ?? ""}
                aria-describedby="timeline-dates-hint"
                className={TEXT_INPUT}
              />
            </label>
          </div>
        </fieldset>
      </div>
    </ScopeFilter>
  );
}
