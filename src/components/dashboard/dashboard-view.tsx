import Link from "next/link";
import { useId, type ReactNode } from "react";

import { ScopeFilter } from "@/components/filters/scope-filter";
import type { ProviderId } from "@/lib/adapters/types";
import type { CurrencyAmounts, DashboardView as View } from "@/lib/dashboard/aggregate";
import { trendWindowLabel, type TrendGranularity, type TrendSeries } from "@/lib/dashboard/trends";
import type { ScopeFilters, ScopeOptions } from "@/lib/filters/scope";

import { CurrencyAmountsList } from "./currency-amounts";
import { ProviderCard } from "./provider-card";
import { TrendChart } from "./trend-chart";

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <section aria-labelledby={titleId} className="mt-10">
      <h2 id={titleId} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      {description === undefined ? null : <p className="mt-1 max-w-2xl text-sm leading-6 text-muted">{description}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** One card per currency, each its own labeled region, so currencies are never read as one sum. */
function CurrencyCards({ amounts, noun, now }: { amounts: readonly CurrencyAmounts[]; noun: string; now: Date }) {
  return (
    <ul className="grid gap-4 md:grid-cols-2">
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
      <section aria-labelledby={titleId} className="rounded-xl border border-line bg-panel p-5">
        <h3 id={titleId} className="font-mono text-sm font-medium text-muted">
          {`${noun} in ${amounts.currency}`}
        </h3>
        <div className="mt-3">
          <CurrencyAmountsList
            amounts={amounts}
            now={now}
            verifiedLabel={`Verified ${noun.toLowerCase()}`}
            estimatedLabel={`Estimated ${noun.toLowerCase()}`}
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
      description="Each provider metric as reported per UTC day or month, compared with the period before. Days or months with no data are shown as unavailable, never as zero, and currencies and units are never mixed in one chart."
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
  trends,
  simulatedProviders,
}: {
  view: View;
  now: Date;
  dashboardPath: string;
  scope: ScopeFilters;
  scopeOptions: ScopeOptions;
  /** The active filter in words, or null when nothing is filtered. */
  scopeDescription: string | null;
  trends: DashboardTrends;
  /** Providers this instance simulates, decided on the server (#131). */
  simulatedProviders: readonly ProviderId[];
}) {
  const count = view.byProvider.length;
  const shown = count === 0 ? "Showing no connections" : `Showing ${count} ${count === 1 ? "connection" : "connections"}`;
  return (
    <>
      <ScopeFilter
        action={dashboardPath}
        scope={scope}
        options={scopeOptions}
        hidden={trends.granularity === "daily" ? undefined : { trend: trends.granularity }}
      />

      <p role="status" aria-live="polite" className="mt-6 text-sm text-muted">
        {scopeDescription === null ? shown : `${shown} for ${scopeDescription}`}
      </p>

      <Section
        title="Spending this billing period"
        description="Totals per currency. Currencies are never added together, and verified amounts from providers are kept apart from DevMacro estimates."
      >
        {view.totals.length === 0 ? (
          <p className="text-sm text-muted">
            No spend has been reported for the current billing period yet. Values appear after the next sync.
          </p>
        ) : (
          <CurrencyCards amounts={view.totals} noun="Spend" now={now} />
        )}
      </Section>

      {view.revenue.length === 0 ? null : (
        <Section title="Revenue this billing period" description="Money coming in, shown apart from spending.">
          <CurrencyCards amounts={view.revenue} noun="Revenue" now={now} />
        </Section>
      )}

      <Section title="By provider" description="Spend, credit balance, and allowances for each connected account.">
        {view.byProvider.length === 0 ? (
          <p className="text-sm text-muted">No connections match these filters. Choose other filters or clear them.</p>
        ) : (
          <ul className="space-y-4">
            {view.byProvider.map((summary) => (
              <ProviderCard
                key={summary.connectionId}
                summary={summary}
                now={now}
                simulated={simulatedProviders.includes(summary.provider)}
              />
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="By project"
        description="Spend this billing period grouped by project. Accounts without a project are listed as unassigned."
      >
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

      <TrendsSection trends={trends} />
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
