import Link from "next/link";
import { useId, type ReactNode } from "react";

import { ScopeFilter } from "@/components/filters/scope-filter";
import type { CurrencyAmounts, DashboardView as View } from "@/lib/dashboard/aggregate";
import { trendWindowLabel, type TrendGranularity, type TrendSeries } from "@/lib/dashboard/trends";
import type { ScopeFilters, ScopeOptions } from "@/lib/filters/scope";

import { CurrencyAmountsList } from "./currency-amounts";
import { ProviderCard } from "./provider-card";
import { TrendChart } from "./trend-chart";

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

/**
 * One card per currency, each its own labeled region, so currencies are never read as one sum.
 * The columns follow the card list's own width rather than the viewport, because the same list
 * fills the whole row on its own and shares it when revenue sits beside spend.
 */
function CurrencyCards({ amounts, noun, now }: { amounts: readonly CurrencyAmounts[]; noun: string; now: Date }) {
  return (
    <ul className="grid gap-4 @xl:grid-cols-2 @4xl:grid-cols-3">
      {amounts.map((entry) => (
        <CurrencyCard key={entry.currency} amounts={entry} noun={noun} now={now} />
      ))}
    </ul>
  );
}

function CurrencyCard({ amounts, noun, now }: { amounts: CurrencyAmounts; noun: string; now: Date }) {
  const titleId = useId();
  return (
    <li>
      <section aria-labelledby={titleId} className="h-full rounded-xl border border-line bg-panel p-4">
        <h3 id={titleId} className="font-mono text-sm font-medium text-muted">
          {`${noun} in ${amounts.currency}`}
        </h3>
        <div className="mt-2">
          <CurrencyAmountsList
            amounts={amounts}
            now={now}
            verifiedLabel={`Verified ${noun.toLowerCase()}`}
            estimatedLabel={`Estimated ${noun.toLowerCase()}`}
            headline
          />
        </div>
      </section>
    </li>
  );
}

export type DashboardTrends = Readonly<{
  granularity: TrendGranularity;
  series: readonly TrendSeries[];
  /** Links to each trend period, keeping the current filter. */
  hrefs: Readonly<Record<TrendGranularity, string>>;
}>;

const TREND_PERIODS = [
  { granularity: "daily", label: "Daily" },
  { granularity: "monthly", label: "Monthly" },
] as const satisfies readonly { granularity: TrendGranularity; label: string }[];

function TrendsSection({ trends }: { trends: DashboardTrends }) {
  return (
    <Section
      title="Trends"
      description="Each metric per UTC day or month, with missing data shown as unavailable, never as zero."
    >
      <nav aria-label="Trend period" className="flex flex-wrap gap-2">
        {TREND_PERIODS.map(({ granularity, label }) => {
          const current = granularity === trends.granularity;
          return (
            <Link
              key={granularity}
              href={trends.hrefs[granularity]}
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
      {trends.series.length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          No history to chart for the {trendWindowLabel(trends.granularity)}. Trends appear after the first syncs.
        </p>
      ) : (
        <ul className="mt-4 grid gap-4 lg:grid-cols-2">
          {trends.series.map((series) => (
            <li key={series.key}>
              <TrendChart series={series} />
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function DashboardView({
  view,
  now,
  dashboardPath,
  scope,
  scopeOptions,
  scopeDescription,
  alerts,
  trends,
}: {
  view: View;
  now: Date;
  dashboardPath: string;
  scope: ScopeFilters;
  scopeOptions: ScopeOptions;
  /** The active filter in words, or null when nothing is filtered. */
  scopeDescription: string | null;
  /** The unacknowledged alerts row, placed after the totals so the numbers lead the page. */
  alerts: ReactNode;
  trends: DashboardTrends;
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
        hidden={trends.granularity === "daily" ? undefined : { trend: trends.granularity }}
      />

      {/* The headline: totals first, with revenue sharing the row on wide screens. */}
      <div className={hasRevenue ? "grid gap-x-6 xl:grid-cols-[2fr_1fr]" : undefined}>
        <Section title="Spending this billing period">
          {view.totals.length === 0 ? (
            <p className="text-sm text-muted">
              No spend has been reported for the current billing period yet. Values appear after the next sync.
            </p>
          ) : (
            <div className="@container">
              <CurrencyCards amounts={view.totals} noun="Spend" now={now} />
            </div>
          )}
        </Section>

        {hasRevenue ? (
          <Section title="Revenue this billing period" description="Money coming in, shown apart from spending.">
            <div className="@container">
              <CurrencyCards amounts={view.revenue} noun="Revenue" now={now} />
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
              <ProviderCard key={summary.connectionId} summary={summary} now={now} />
            ))}
          </ul>
        )}
      </Section>

      <TrendsSection trends={trends} />

      <Section title="By project" description="Spend by project, with accounts outside a project listed as unassigned.">
        {view.byProject.length === 0 ? (
          <p className="text-sm text-muted">No spend to group by project yet.</p>
        ) : (
          <ul className="grid gap-4 md:grid-cols-2">
            {view.byProject.map((project) => (
              <ProjectCard key={project.projectId ?? "unassigned"} name={project.name} spend={project.spend} now={now} />
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

function ProjectCard({ name, spend, now }: { name: string; spend: readonly CurrencyAmounts[]; now: Date }) {
  const titleId = useId();
  return (
    <li>
      <section aria-labelledby={titleId} className="rounded-xl border border-line bg-panel p-5">
        <h3 id={titleId} className="font-semibold">
          {name}
        </h3>
        <ul className="mt-3 space-y-4">
          {spend.map((amounts) => (
            <li key={amounts.currency}>
              <p className="mb-1 font-mono text-xs font-medium text-muted">{amounts.currency}</p>
              <CurrencyAmountsList
                amounts={amounts}
                now={now}
                verifiedLabel="Verified spend"
                estimatedLabel="Estimated spend"
              />
            </li>
          ))}
        </ul>
      </section>
    </li>
  );
}
