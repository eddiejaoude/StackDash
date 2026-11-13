import Form from "next/form";
import Link from "next/link";

import { ScopeFilter } from "@/components/filters/scope-filter";
import { CloseIcon, SearchIcon } from "@/components/icons";
import { buttonClass } from "@/components/ui/button";
import type { ScopeOptions } from "@/lib/filters/scope";
import { typeOwnerName } from "@/lib/providers";
import {
  activeFilters,
  EVENT_SEVERITIES,
  eventTypeLabel,
  hasActiveFilters,
  MAX_SEARCH_LENGTH,
  severityBadge,
  timelineHref,
  timelineParams,
  type TimelineQuery,
} from "@/lib/timeline/query";

const CHECKBOX_LABEL = "flex min-h-6 cursor-pointer items-center gap-2 px-1 text-sm";
const CHECKBOX = "size-4 shrink-0 accent-accent";
const TEXT_INPUT =
  "mt-1 block min-h-10 w-full rounded-md border border-line-strong bg-panel-raised px-3 py-2 text-sm text-foreground [color-scheme:dark]";

const SEVERITY_LINK = "inline-flex min-h-10 shrink-0 items-center rounded-md border px-4 py-2 text-sm transition-colors";

/**
 * One-click severity views, so the commonest filter needs no form. Each link keeps every other
 * filter and, like the form, starts from the newest events because it carries no cursor. A
 * mixed severity selection from the form marks no link as current. Below `sm` the links scroll
 * sideways on one row instead of wrapping to a second; the padding keeps their focus outline
 * inside the scroll box, which would otherwise clip it.
 */
function SeverityLinks({ action, query }: { action: string; query: TimelineQuery }) {
  const links = [
    { label: "All", severities: [], current: query.severities.length === 0 },
    ...EVENT_SEVERITIES.map((severity) => ({
      label: severityBadge(severity),
      severities: [severity],
      current: query.severities.length === 1 && query.severities[0] === severity,
    })),
  ];
  return (
    <nav aria-label="Severity" className="-m-1 flex min-w-0 gap-2 overflow-x-auto p-1 sm:flex-wrap md:shrink-0">
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
 * The title search, outside the collapsed filter form so it is always in view. A GET form of its
 * own: every other filter in the URL rides along as a hidden input, written by the same
 * `timelineParams` that builds the page's links, and no cursor, so a search starts from the newest
 * events. The label is visually hidden: the Search button beside the field names its purpose
 * (WCAG technique G167), and the placeholder says what it searches. The field is keyed by the search in the URL so it shows the new value
 * after a client navigation, such as removing the search's chip, even once someone has typed in it.
 */
function TimelineSearch({ action, query }: { action: string; query: TimelineQuery }) {
  const hidden = [...timelineParams({ ...query, search: null }, null)];
  return (
    <Form action={action} role="search" className="flex min-w-0 gap-2 md:max-w-sm md:flex-1">
      {hidden.map(([name, value]) => (
        <input key={`${name}=${value}`} type="hidden" name={name} value={value} />
      ))}
      <label htmlFor="timeline-search" className="sr-only">
        Search event titles
      </label>
      <div className="relative min-w-0 flex-1">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <input
          key={query.search ?? ""}
          id="timeline-search"
          type="search"
          name="q"
          defaultValue={query.search ?? ""}
          maxLength={MAX_SEARCH_LENGTH}
          autoComplete="off"
          placeholder="Event titles"
          className="block min-h-10 w-full rounded-md border border-line-strong bg-panel-raised py-2 pl-9 pr-3 text-sm text-foreground [color-scheme:dark] placeholder:text-muted"
        />
      </div>
      <button type="submit" className={`shrink-0 ${buttonClass("secondary")}`}>
        Search
      </button>
    </Form>
  );
}

/** The severity links and the title search: one row from `md` up, stacked below it. */
export function TimelineToolbar({ action, query }: { action: string; query: TimelineQuery }) {
  return (
    <div className="mt-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <SeverityLinks action={action} query={query} />
      <TimelineSearch action={action} query={query} />
    </div>
  );
}

/**
 * One removable chip per active filter value, under the filter bar, so a filter is named without
 * opening the form. Each chip is a link to the same view without that one value, starting from the
 * newest events; its name says what it does. Renders nothing when no filter is active.
 */
export function ActiveFilterChips({
  action,
  query,
  scopeOptions,
}: {
  action: string;
  query: TimelineQuery;
  scopeOptions: ScopeOptions;
}) {
  if (!hasActiveFilters(query)) return null;
  return (
    <ul aria-label="Active filters" className="mt-3 flex flex-wrap gap-2">
      {activeFilters(query, scopeOptions).map((filter) => (
        <li key={filter.key} className="min-w-0">
          <Link
            href={timelineHref(action, filter.query, null)}
            scroll={false}
            aria-label={filter.name}
            className="inline-flex min-h-8 max-w-full items-center gap-1.5 rounded-full border border-line-strong bg-panel px-3 py-1 text-xs text-foreground transition-colors hover:border-accent"
          >
            {/* The space keeps the visible words apart, so the name contains them (WCAG 2.5.3). */}
            <span className="shrink-0 text-muted">{filter.kind}</span>{" "}
            <span className="min-w-0 break-words font-medium">{filter.value}</span>
            <CloseIcon className="size-3.5 shrink-0 text-muted" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * The shared scope filter (provider, project, account) with the timeline's own fields: event type,
 * severity, and dates. The title search lives in `TimelineSearch`, so this form carries it as a
 * hidden input, as it does the selected period, and applying filters keeps both. Submitting starts
 * from the newest events, because the form carries no cursor.
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
  /** The result in words, such as "Showing 3 of 3 events for provider GitHub". */
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
      hidden={{
        ...(query.timeRange === null ? {} : { start: query.timeRange.from, until: query.timeRange.toExclusive }),
        ...(query.search === null ? {} : { q: query.search }),
      }}
      resetKey={JSON.stringify([query.types, query.severities, query.from, query.to, query.search, query.timeRange])}
    >
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
