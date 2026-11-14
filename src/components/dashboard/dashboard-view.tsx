import Link from "next/link";
import { useId, type ReactNode } from "react";

import { SimulatedBadge } from "@/components/connections/simulated-badge";
import { ScopeFilter } from "@/components/filters/scope-filter";
import { buttonClass } from "@/components/ui/button";
import { LiveRegion } from "@/components/ui/live-region";
import {
  hasSimulatedSource,
  type CurrencyAmounts,
  type DashboardView as View,
  type DeclaredFields,
  type ProviderId,
} from "@/lib/dashboard/aggregate";
import { markerCategoryLabel, type MarkerCategory, type TrendMarker } from "@/lib/dashboard/markers";
import type { DashboardProjections, SpendProjection } from "@/lib/dashboard/projection";
import { trendWindowLabel, type ProviderTrends, type TrendGranularity, type TrendSeries } from "@/lib/dashboard/trends";
import type { ScopeFilters, ScopeOptions } from "@/lib/filters/scope";
import { providerName } from "@/lib/providers";
import { amountValues } from "@/lib/realtime/arrivals";

import { ArrivalCard } from "./arrival-values";
import { CurrencyAmountsList } from "./currency-amounts";
import { LinkPendingLabel } from "./link-pending";
import { ProviderCard } from "./provider-card";
import { TrendChart, TrendLegend } from "./trend-chart";
import { MarkerShape } from "./trend-markers";
import { SpendProjectionNote } from "./value-meta";

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="mt-6 min-w-0">
      <h2 id={titleId} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {description === undefined ? null : <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{description}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

type MoneyGroup = "spend" | "revenue";

const GROUP_NOUNS: Record<MoneyGroup, string> = { spend: "Spend", revenue: "Revenue" };

/**
 * One card per currency, each its own labeled region, so currencies are never read as one sum.
 * The columns follow the card list's own width rather than the viewport, because the same list
 * fills the whole row on its own and shares it when revenue sits beside spend.
 */
function CurrencyCards({
  amounts,
  group,
  now,
  projections = [],
  markSimulated,
}: {
  amounts: readonly CurrencyAmounts[];
  group: MoneyGroup;
  now: Date;
  /** Spend projections to the end of the period (#167), matched by currency. */
  projections?: readonly SpendProjection[];
  markSimulated: boolean;
}) {
  return (
    <ul className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
      {amounts.map((entry) => (
        <CurrencyCard
          key={entry.currency}
          amounts={entry}
          group={group}
          now={now}
          markSimulated={markSimulated}
          projection={projections.find((projection) => projection.currency === entry.currency)}
        />
      ))}
    </ul>
  );
}

/**
 * Labeled "Simulated" when any connection behind the totals was made by the provider simulator
 * (#131), unless the page says so once for every card (`markSimulated` false, #269).
 */
function CurrencyCard({
  amounts,
  group,
  now,
  projection,
  markSimulated,
}: {
  amounts: CurrencyAmounts;
  group: MoneyGroup;
  now: Date;
  projection: SpendProjection | undefined;
  markSimulated: boolean;
}) {
  const titleId = useId();
  const noun = GROUP_NOUNS[group];
  const title = `${noun} in ${amounts.currency}`;
  return (
    <li>
      <section aria-labelledby={titleId} className="relative isolate h-full rounded-xl border border-line bg-panel p-4">
        <ArrivalCard values={amountValues(group, [amounts])} label={title}>
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={titleId} className="font-mono text-sm font-medium text-muted">
              {title}
            </h3>
            {markSimulated && hasSimulatedSource(amounts) ? <SimulatedBadge /> : null}
          </div>
          <div className="mt-2">
            <CurrencyAmountsList
              amounts={amounts}
              group={group}
              now={now}
              verifiedLabel={`Verified ${noun.toLowerCase()}`}
              estimatedLabel={`Estimated ${noun.toLowerCase()}`}
              headline
            />
          </div>
          <SpendProjectionNote projection={projection} partsNote="Each provider card shows its own projection or the reason there is none." />
        </ArrivalCard>
      </section>
    </li>
  );
}

/** One provider's trends with its disclosure, which is a link: open is URL state (#263). */
export type ProviderTrendsView = ProviderTrends & Readonly<{ open: boolean; toggleHref: string }>;

/** The charts a provider puts on the page: its default set, plus the rest once opened. */
export function renderedSeries({ defaults, more, open }: ProviderTrendsView): readonly TrendSeries[] {
  return open ? [...defaults, ...more] : defaults;
}

export type DashboardTrends = Readonly<{
  granularity: TrendGranularity;
  providers: readonly ProviderTrendsView[];
  /** Links to each trend period, keeping the current filter. */
  hrefs: Readonly<Record<TrendGranularity, string>>;
  /** Event markers (#168). */
  markers: Readonly<{
    /** Categories hidden through the URL, in category order. */
    hidden: readonly MarkerCategory[];
    /** Each rendered chart's markers by series key, oldest bucket first; closed series have none. */
    bySeries: Readonly<Record<string, readonly TrendMarker[]>>;
    /** One link per category that shows or hides it, keeping everything else. */
    toggles: readonly Readonly<{ category: MarkerCategory; shown: boolean; href: string }>[];
  }>;
}>;

const TREND_PERIODS = [
  { granularity: "daily", label: "Daily" },
  { granularity: "monthly", label: "Monthly" },
] as const satisfies readonly { granularity: TrendGranularity; label: string }[];

/** The Trends section, which the page streams in behind its own Suspense boundary (#263). */
export function TrendsSection({ trends, markSimulated }: { trends: DashboardTrends; markSimulated: boolean }) {
  const { markers } = trends;
  const anyShown = markers.toggles.some((toggle) => toggle.shown);
  const rendered = trends.providers.flatMap(renderedSeries);
  const markersOf = (key: string) => (anyShown ? (markers.bySeries[key] ?? []) : null);
  return (
    <Section
      title="Trends"
      description="Each provider's spend and revenue per UTC day or month, with missing data shown as unavailable, never as zero. Open a provider's other series, such as usage and breakdowns, below its charts. Markers under each chart count deployments, payments, signups, star events, and triggered alerts in the same days or months."
    >
      <nav aria-label="Trend period" className="flex flex-wrap gap-2">
        {TREND_PERIODS.map(({ granularity, label }) => {
          const current = granularity === trends.granularity;
          return (
            <Link
              key={granularity}
              href={trends.hrefs[granularity]}
              scroll={false}
              aria-current={current ? "page" : undefined}
              className={`inline-flex min-h-10 items-center rounded-md border px-4 py-2 text-sm transition-colors ${
                current ? "border-accent font-medium text-foreground" : "border-line-strong text-muted hover:text-foreground"
              }`}
            >
              {`${label}, ${trendWindowLabel(granularity)}`}
            </Link>
          );
        })}
      </nav>
      {/* Links rather than buttons: each one is a URL, so a shared link reproduces the view. The
          text names the outcome, and the shape is hollow while the category is hidden. */}
      <nav aria-label="Event markers" className="mt-3 flex flex-wrap gap-2">
        {markers.toggles.map(({ category, shown, href }) => (
          <Link
            key={category}
            href={href}
            scroll={false}
            className={`gap-2 ${buttonClass("secondary")}`}
          >
            <MarkerShape category={category} filled={shown} />
            {`${shown ? "Hide" : "Show"} ${markerCategoryLabel(category).toLowerCase()}`}
          </Link>
        ))}
      </nav>
      {trends.providers.length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          No history to chart for the {trendWindowLabel(trends.granularity)}. Trends appear after the first syncs.
        </p>
      ) : (
        <>
          {/* Only when a chart is on the page, so the legend never describes charts that are not there. */}
          {rendered.length === 0 ? null : (
            <TrendLegend series={rendered} markers={rendered.flatMap((series) => markersOf(series.key) ?? [])} />
          )}
          <ul className="mt-4 grid gap-8">
            {trends.providers.map((group) => (
              <ProviderTrendsGroup key={group.provider} group={group} markersOf={markersOf} markSimulated={markSimulated} />
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

/**
 * Stands in for the Trends section while its snapshot read streams in (#263), shaped like the
 * section's first screen (heading, description, period and marker links, the first chart) so the
 * page does not jump when the charts arrive.
 */
export function TrendsSkeleton() {
  return (
    <LiveRegion tone="status" className="mt-6 min-w-0">
      <span className="sr-only">Loading the trend charts</span>
      <div aria-hidden="true">
        <div className="h-7 w-24 rounded bg-panel-raised motion-safe:animate-pulse" />
        <div className="mt-1 h-18 max-w-2xl rounded bg-panel-raised motion-safe:animate-pulse" />
        <div className="mt-3 flex flex-wrap gap-2">
          <div className="h-10 w-44 rounded-md border border-line bg-panel motion-safe:animate-pulse" />
          <div className="h-10 w-48 rounded-md border border-line bg-panel motion-safe:animate-pulse" />
        </div>
        <div className="mt-3 h-10 max-w-3xl rounded-md border border-line bg-panel motion-safe:animate-pulse" />
        <div className="mt-4 rounded-xl border border-line bg-panel p-5">
          <div className="h-6 w-64 max-w-full rounded bg-panel-raised motion-safe:animate-pulse" />
          <div className="mt-2 h-5 w-48 max-w-full rounded bg-panel-raised motion-safe:animate-pulse" />
          <div className="mt-4 aspect-32/9 rounded bg-panel-raised motion-safe:animate-pulse" />
        </div>
      </div>
    </LiveRegion>
  );
}

/**
 * One provider's default charts, then a disclosure for the rest, which are not rendered until it
 * is opened (#263). The disclosure is a link that adds the provider to the URL, like the period
 * and marker choices, so the closed charts cost nothing on load and a shared link reproduces the
 * view; `aria-expanded` gives it the disclosure's state.
 */
function ProviderTrendsGroup({
  group,
  markersOf,
  markSimulated,
}: {
  group: ProviderTrendsView;
  markersOf: (key: string) => readonly TrendMarker[] | null;
  markSimulated: boolean;
}) {
  const titleId = useId();
  const moreId = useId();
  const { provider, defaults, more, open, toggleHref } = group;
  const name = providerName(provider);
  const others = `${more.length}${defaults.length === 0 ? "" : " more"} ${name} series`;
  return (
    <li className="min-w-0">
      <section aria-labelledby={titleId}>
        <h3 id={titleId} className="font-semibold tracking-tight">
          {name}
        </h3>
        {defaults.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No spend or revenue to chart for {name}.</p>
        ) : (
          // One chart per row: markers on neighboring days need the width (see `TrendChart`).
          <ul className="mt-3 grid gap-4">
            {defaults.map((series) => (
              <li key={series.key} className="min-w-0">
                <TrendChart series={series} markers={markersOf(series.key)} markSimulated={markSimulated} />
              </li>
            ))}
          </ul>
        )}
        {more.length === 0 ? null : (
          <>
            <Link
              href={toggleHref}
              scroll={false}
              aria-expanded={open}
              aria-controls={open ? moreId : undefined}
              className={`mt-3 ${buttonClass("secondary")}`}
            >
              <LinkPendingLabel idle={`${open ? "Hide" : "Show"} ${others}`} pending={`Loading ${others}`} />
            </Link>
            {open ? (
              <ul id={moreId} className="mt-4 grid gap-4">
                {more.map((series) => (
                  <li key={series.key} className="min-w-0">
                    <TrendChart series={series} markers={markersOf(series.key)} markSimulated={markSimulated} />
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </section>
    </li>
  );
}

export function DashboardView({
  view,
  projections,
  now,
  dashboardPath,
  scope,
  scopeOptions,
  scopeDescription,
  filterParams,
  whatChanged,
  headline,
  alerts,
  trends,
  heatmap,
  declared,
  markSimulated,
}: {
  view: View;
  /** Spend and quota projections to the end of the period (#167). */
  projections: DashboardProjections;
  now: Date;
  dashboardPath: string;
  scope: ScopeFilters;
  scopeOptions: ScopeOptions;
  /** The active filter in words, or null when nothing is filtered. */
  scopeDescription: string | null;
  /** The page's other URL state (trend period, hidden markers, headline window), carried through the filter form. */
  filterParams: Readonly<Record<string, string | readonly string[]>>;
  /** What was unusual lately, in words (#270), first under the filter it follows; the element renders nothing when nothing was. */
  whatChanged: ReactNode;
  /** The headline strip: revenue against spend, signups, and deploys over one window (#173). */
  headline: ReactNode;
  /** The unacknowledged alerts row, placed after the totals so the numbers lead the page. */
  alerts: ReactNode;
  /** The Trends section; the page streams it in behind its own Suspense boundary (#263). */
  trends: ReactNode;
  /** The activity heatmap, last; the page streams it in behind its own Suspense boundary (#414). */
  heatmap: ReactNode;
  /** What each provider's adapter declares it reports, so its card leaves out the rest (#269). */
  declared: (provider: ProviderId) => DeclaredFields;
  /** False when the page says "Simulated" once for every card, total, and chart (#269). */
  markSimulated: boolean;
}) {
  const count = view.byProvider.length;
  const shown = count === 0 ? "Showing no connections" : `Showing ${count} ${count === 1 ? "connection" : "connections"}`;
  const hasRevenue = view.revenue.length > 0;
  return (
    <>
      <ScopeFilter
        action={dashboardPath}
        scope={scope}
        options={scopeOptions}
        status={scopeDescription === null ? shown : `${shown} for ${scopeDescription}`}
        hidden={filterParams}
      />

      {whatChanged}

      {headline}

      {/* The billing period totals, with revenue sharing the row on wide screens. */}
      <div className={hasRevenue ? "grid gap-x-6 xl:grid-cols-[2fr_1fr]" : undefined}>
        <Section title="Spending this billing period">
          {view.totals.length === 0 ? (
            <p className="text-sm text-muted">
              No spend has been reported for the current billing period yet. Values appear after the next sync.
            </p>
          ) : (
            <div className="@container">
              <CurrencyCards amounts={view.totals} group="spend" now={now} projections={projections.totals} markSimulated={markSimulated} />
            </div>
          )}
        </Section>

        {hasRevenue ? (
          <Section title="Revenue this billing period" description="Money coming in, shown apart from spending.">
            <div className="@container">
              <CurrencyCards amounts={view.revenue} group="revenue" now={now} markSimulated={markSimulated} />
            </div>
          </Section>
        ) : null}
      </div>

      {alerts}

      <Section title="By provider">
        {view.byProvider.length === 0 ? (
          <p className="text-sm text-muted">No connections match these filters. Choose other filters or clear them.</p>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {view.byProvider.map((summary) => (
              <ProviderCard
                key={summary.connectionId}
                summary={summary}
                declared={declared(summary.provider)}
                spendProjections={projections.byConnection.get(summary.connectionId) ?? []}
                quotaProjections={projections.quotas}
                now={now}
                markSimulated={markSimulated}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section title="By project" description="Spend by project, with accounts outside a project listed as unassigned.">
        {view.byProject.length === 0 ? (
          <p className="text-sm text-muted">No spend to group by project yet.</p>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {view.byProject.map((project) => (
              <ProjectCard
                key={project.projectId ?? "unassigned"}
                name={project.name}
                spend={project.spend}
                now={now}
                markSimulated={markSimulated}
              />
            ))}
          </ul>
        )}
      </Section>

      {trends}

      {heatmap}
    </>
  );
}

function ProjectCard({
  name,
  spend,
  now,
  markSimulated,
}: {
  name: string;
  spend: readonly CurrencyAmounts[];
  now: Date;
  markSimulated: boolean;
}) {
  const titleId = useId();
  return (
    <li>
      <section aria-labelledby={titleId} className="relative isolate rounded-xl border border-line bg-panel p-5">
        <ArrivalCard values={amountValues("spend", spend)} label={`${name} spend`}>
          <h3 id={titleId} className="font-semibold">
            {name}
          </h3>
          <ul className="mt-3 space-y-4">
            {spend.map((amounts) => (
              <li key={amounts.currency}>
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <p className="font-mono text-xs font-medium text-muted">{amounts.currency}</p>
                  {markSimulated && hasSimulatedSource(amounts) ? <SimulatedBadge /> : null}
                </div>
                <CurrencyAmountsList
                  amounts={amounts}
                  group="spend"
                  now={now}
                  verifiedLabel="Verified spend"
                  estimatedLabel="Estimated spend"
                />
              </li>
            ))}
          </ul>
        </ArrivalCard>
      </section>
    </li>
  );
}
