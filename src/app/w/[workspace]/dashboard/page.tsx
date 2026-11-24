import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import { ArrivalScope } from "@/components/app/arrivals";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { SimulatedNotice } from "@/components/connections/simulated-badge";
import { ActivityHeatmapSection, ActivityHeatmapSkeleton } from "@/components/dashboard/activity-heatmap";
import { AlertsSummary } from "@/components/dashboard/alerts-summary";
import { CapNotice } from "@/components/dashboard/cap-notice";
import { DashboardView, renderedSeries, TrendsSection, TrendsSkeleton } from "@/components/dashboard/dashboard-view";
import { HeadlineStrip } from "@/components/dashboard/headline-strip";
import { StaleNotice } from "@/components/dashboard/stale-notice";
import { WhatChanged } from "@/components/dashboard/what-changed";
import { GaugeIcon } from "@/components/icons";
import { buttonClass } from "@/components/ui/button";
import { LiveRegion } from "@/components/ui/live-region";
import {
  declaredCapabilities,
  declaredDailyTotals,
  declaredEventTypes,
  declaredProjectedSpend,
  declaredSignupDailyTotals,
  revenueProviderIds,
  spendProviderIds,
} from "@/lib/adapters/registry";
import { everySimulated } from "@/lib/adapters/simulated/marker";
import { offeredProviderIds } from "@/lib/connections/provider-availability";
import { aggregateDashboard, type CappedRead, type ProviderId, snapshotWindowStart, withStaleNotice } from "@/lib/dashboard/aggregate";
import {
  buildHeadline,
  chooseHeadline,
  fallbackWindows,
  HEADLINE_WINDOW_KINDS,
  headlineEventTypes,
  headlineWindows,
  type HeadlineStrip as HeadlineStripData,
  type HeadlineWindowKind,
} from "@/lib/dashboard/headline";
import { HEAT_FILTERS, heatGrid, type HeatCountRow, type HeatFilter } from "@/lib/dashboard/heatmap";
import {
  bucketEventCounts,
  canonicalHidden,
  chartMarkers,
  type EventCountRow,
  HIDE_MARKER_PARAM,
  isMarkerCategory,
  MARKER_CATEGORIES,
  shownCategories,
  toggleHidden,
  type MarkerCategory,
} from "@/lib/dashboard/markers";
import { projectDashboard } from "@/lib/dashboard/projection";
import {
  buildTrends,
  canonicalExpanded,
  defaultSeriesKeys,
  EXPAND_TRENDS_PARAM,
  groupTrends,
  toggleExpanded,
  trendCompleteFrom,
  type TrendGranularity,
} from "@/lib/dashboard/trends";
import { recentAnomalies, whatChanged } from "@/lib/dashboard/what-changed";
import { getAnomalyControls, getRecentAnomalies, RECENT_ANOMALY_DAYS } from "@/lib/data/anomalies";
import { type DashboardData, getDashboardData, getWorkspaceScope } from "@/lib/data/dashboard";
import { getActivityHeatmap } from "@/lib/data/heatmap";
import { getHeadlineEvents, getHeadlineSnapshots } from "@/lib/data/headline";
import { getTrendData, getTrendEventCounts, type TrendData } from "@/lib/data/trends";
import { getUnacknowledgedSummary } from "@/lib/data/triggered-alerts";
import {
  appendScopeParams,
  buildScopeOptions,
  describeScope,
  repeatedParam,
  ScopeSearchParamsSchema,
  type ScopeFilters,
} from "@/lib/filters/scope";
import { isYearComplete, latestCardYear, yearLabel } from "@/lib/public-metrics/yearly";
import { requireWorkspace, type WorkspaceAccess } from "@/lib/workspaces/access";
import { workspacePath, yearInReviewPath } from "@/lib/workspaces/paths";
import { actionDeniedReason, canPerform } from "@/lib/workspaces/permissions";

export const metadata: Metadata = { title: "Dashboard" };

// The page's one URL schema: the shared scope filter, the trend period, the hidden event marker
// categories, the providers whose other trend series are open, the headline window, and the
// heatmap's event group. Unknown or malformed values fall back to the defaults rather than
// erroring, because the URL is user-editable; other keys are ignored.
const searchParamsSchema = ScopeSearchParamsSchema.extend({
  trend: z.enum(["daily", "monthly"]).catch("daily"),
  [HIDE_MARKER_PARAM]: repeatedParam(isMarkerCategory, MARKER_CATEGORIES.length),
  // A list of providers, read like the provider filter.
  [EXPAND_TRENDS_PARAM]: ScopeSearchParamsSchema.shape.provider,
  window: z.enum(HEADLINE_WINDOW_KINDS).catch("week"),
  heat: z.enum(HEAT_FILTERS).catch("all"),
});

type DashboardViewParams = Readonly<{
  trend: TrendGranularity;
  hidden: readonly MarkerCategory[];
  expanded: readonly ProviderId[];
  window: HeadlineWindowKind;
  heat: HeatFilter;
}>;

/**
 * The page's own URL state. The defaults (the daily trend, every marker shown, every provider's
 * other trends closed, this week, every event in the heatmap) stay out of the URL, so a demo link
 * carries only what differs.
 */
function viewParams({ trend, hidden, expanded, window, heat }: DashboardViewParams): Record<string, string | readonly string[]> {
  return {
    ...(trend === "daily" ? {} : { trend }),
    ...(hidden.length === 0 ? {} : { [HIDE_MARKER_PARAM]: hidden }),
    ...(expanded.length === 0 ? {} : { [EXPAND_TRENDS_PARAM]: expanded }),
    ...(window === "week" ? {} : { window }),
    ...(heat === "all" ? {} : { heat }),
  };
}

/** Dashboard link keeping the filter and the other view choices. */
function dashboardHref(basePath: string, scope: ScopeFilters, view: DashboardViewParams): string {
  const params = new URLSearchParams();
  appendScopeParams(params, scope);
  for (const [name, value] of Object.entries(viewParams(view))) {
    for (const item of typeof value === "string" ? [value] : value) params.append(name, item);
  }
  const search = params.toString();
  return search === "" ? basePath : `${basePath}?${search}`;
}

// Every section renders inside its own Suspense boundary so navigating between sections
// has an instant shell; access checks and data reads stream in behind it. Inside the dashboard,
// Trends has a boundary of its own (#263): the monthly view reads 13 months of snapshots, and the
// headline strip, cards, and By project do not wait for that read. The activity heatmap (#414) has
// its own as well, so neither waits for the other.
export default function DashboardPage(props: PageProps<"/w/[workspace]/dashboard">) {
  return (
    <Suspense fallback={<PageSkeleton label="Loading the dashboard" />}>
      <DashboardPageContent {...props} />
    </Suspense>
  );
}

async function DashboardPageContent({ params, searchParams }: PageProps<"/w/[workspace]/dashboard">) {
  const { workspace: slug } = await params;
  const access = await requireWorkspace(slug, "viewer");
  const parsed = searchParamsSchema.parse(await searchParams);
  const scope: ScopeFilters = { providers: parsed.provider, projects: parsed.project, accounts: parsed.account };
  const view: DashboardViewParams = {
    trend: parsed.trend,
    hidden: canonicalHidden(parsed[HIDE_MARKER_PARAM]),
    expanded: canonicalExpanded(parsed[EXPAND_TRENDS_PARAM]),
    window: parsed.window,
    heat: parsed.heat,
  };
  // Read after the request data above, so the clock never runs during prerendering.
  const now = new Date();
  const reviewYear = latestCardYear(now);

  return (
    <>
      <PageHeader
        title="Dashboard"
        description="Spend, usage, and allowances across every provider this workspace connects."
        actions={
          <Link href={yearInReviewPath(access.workspace.slug, reviewYear)} className={buttonClass("raised")}>
            {isYearComplete(reviewYear, now) ? `Your ${reviewYear} in review` : `Your ${yearLabel(reviewYear, now)}`}
          </Link>
        }
      />
      <Suspense fallback={<DashboardSkeleton />}>
        <DashboardContent access={access} scope={scope} view={view} />
      </Suspense>
    </>
  );
}

async function DashboardContent({
  access,
  scope,
  view,
}: {
  access: WorkspaceAccess;
  scope: ScopeFilters;
  view: DashboardViewParams;
}) {
  const { workspace, role } = access;
  const { trend, hidden } = view;
  // Request data first: reading the clock before it would fail the prerender.
  await connection();
  const now = new Date();
  const shown = shownCategories(hidden);
  const windows = headlineWindows(view.window, now);
  const eventTypes = headlineEventTypes(declaredEventTypes, declaredSignupDailyTotals);
  // Alerts load with the rest so their row never streams in later and shifts the provider cards.
  const anomaliesSince = new Date(now.getTime() - RECENT_ANOMALY_DAYS * 86_400_000).toISOString();
  // The trend rows, the markers' counts, and the heatmap's counts are not awaited here: Trends and
  // the heatmap await them behind their own Suspense boundaries (#263, #414). They start now, with
  // the rest, so nothing waits on another read. The empty state below never awaits them, and a
  // rejection can land before a section awaits; Next's process-wide unhandledRejection handler
  // logs either case and carries on, which is accepted here. Do not add a .catch or move these
  // below the Promise.all, which would serialize the reads.
  const trendData = getTrendData(workspace.id, trend, now, scope);
  const viewCounts = getTrendEventCounts(workspace.id, trend, now, scope, shown);
  const heatCounts = getActivityHeatmap(workspace.id, view.heat, now, scope);
  // The summary names every category's events by day; the charts' own read already is that when
  // they show the daily trend with no category hidden.
  const dayCounts =
    trend === "daily" && hidden.length === 0 ? viewCounts : getTrendEventCounts(workspace.id, "daily", now, scope, MARKER_CATEGORIES);
  const [
    workspaceScope,
    data,
    alertsSummary,
    headlineSnapshots,
    headlineEvents,
    recentAnomalyEvents,
    anomalyControls,
    dayEventCounts,
  ] = await Promise.all([
    getWorkspaceScope(workspace.id),
    // The same `now` as the trend read, so the daily view's rows come from this one cached read.
    getDashboardData(workspace.id, snapshotWindowStart(now), scope),
    getUnacknowledgedSummary(workspace.id),
    getHeadlineSnapshots(workspace.id, scope, windows, eventTypes),
    getHeadlineEvents(workspace.id, scope, windows, eventTypes),
    getRecentAnomalies(workspace.id, anomaliesSince),
    getAnomalyControls(workspace.id),
    dayCounts,
  ]);
  const alerts = <AlertsSummary workspace={workspace} summary={alertsSummary} anomalies={recentAnomalyEvents} />;

  if (workspaceScope.connections.length === 0) {
    const canConnect = canPerform(role, "manage_connections");
    return (
      <>
        <EmptyState
          icon={<GaugeIcon width={20} height={20} />}
          title="Connect your first provider"
          description="Connect a provider to see what you have spent, how much allowance is left, and when it resets."
          action={{ href: workspacePath(workspace.slug, "connections"), label: "Connect a provider" }}
          deniedReason={canConnect ? undefined : actionDeniedReason("manage_connections")}
        />
        {alerts}
      </>
    );
  }

  const dashboardPath = workspacePath(workspace.slug, "dashboard");
  const timelinePath = workspacePath(workspace.slug, "timeline");
  const scopeOptions = buildScopeOptions(workspaceScope, scope);
  const input = { ...data, projectedSpend: declaredProjectedSpend, now };
  // One notice for the page when most connections are stale, instead of a line on every value (#267),
  // counting only connections Sync now can bring up to date (#588).
  const { view: dashboard, notice } = withStaleNotice(aggregateDashboard(input), offeredProviderIds());
  // One "Simulated" for the page when every connection in view is simulated, instead of a badge on
  // every card, total, and chart; a mixed workspace keeps them (#269).
  const allSimulated = everySimulated(dashboard.byProvider);
  // What was unusual in the last week, in words (#270): the days the daily summary jobs checked,
  // found again from the 45 days of rows already read, so it follows the filter and today's mutes.
  const changes = whatChanged(
    recentAnomalies({
      now,
      days: RECENT_ANOMALY_DAYS,
      enabled: anomalyControls.enabled,
      rows: data.snapshots,
      connections: data.connections,
      mutes: anomalyControls.mutes,
      projectedSpend: declaredProjectedSpend,
      dailyTotals: declaredDailyTotals,
    }),
    bucketEventCounts(dayEventCounts, "daily", now),
    { timelinePath, scope },
  );

  const headlineInput = {
    connections: data.connections,
    eventTypes,
    projectedSpend: declaredProjectedSpend,
    revenueProviders: revenueProviderIds,
    spendProviders: spendProviderIds,
  };
  const strip = buildHeadline({ ...headlineInput, windows, snapshots: headlineSnapshots.rows, events: headlineEvents });
  // Only when the window to date has no figure because a connection in view is stale: the last
  // complete window, whose reads depend on the strip above, so they run after it.
  const lastComplete = fallbackWindows(strip, data.connections, now);
  let fallback: HeadlineStripData | null = null;
  let fallbackCompleteFrom: string | null = null;
  if (lastComplete !== null) {
    const [snapshots, events] = await Promise.all([
      getHeadlineSnapshots(workspace.id, scope, lastComplete, eventTypes),
      getHeadlineEvents(workspace.id, scope, lastComplete, eventTypes),
    ]);
    fallback = buildHeadline({ ...headlineInput, windows: lastComplete, snapshots: snapshots.rows, events });
    fallbackCompleteFrom = snapshots.completeFrom;
  }
  // The parts whose snapshot reads stopped at the row cap (#336). The headline counts its last
  // complete window's read too when it made one. The daily trend reads the cards' rows (#263), so
  // its part is known now; the monthly trend's is added once its read resolves.
  const capReads: CappedRead[] = [
    { part: "headline", completeFrom: headlineSnapshots.completeFrom },
    { part: "headline", completeFrom: fallbackCompleteFrom },
    { part: "cards", completeFrom: data.completeFrom },
  ];
  if (trend === "daily") capReads.push({ part: "daily trend", completeFrom: trendCompleteFrom(data.completeFrom, "daily", now) });

  // The page's URL is its scope: a new filter, trend period, marker choice, headline window, or
  // heatmap event group resets what counts as changed.
  return (
    <ArrivalScope scope={dashboardHref(dashboardPath, scope, view)}>
      {allSimulated ? <SimulatedNotice /> : null}
      {notice === null ? null : (
        <StaleNotice notice={notice} now={now} workspaceSlug={workspace.slug} canSync={canPerform(role, "manage_connections")} />
      )}
      <DashboardCapNotice reads={capReads} trend={trend} trendData={trendData} />
      <DashboardView
        view={dashboard}
        projections={projectDashboard(input)}
        now={now}
        dashboardPath={dashboardPath}
        scope={scope}
        scopeOptions={scopeOptions}
        scopeDescription={describeScope(scope, scopeOptions)}
        filterParams={viewParams(view)}
        whatChanged={<WhatChanged summary={changes} days={RECENT_ANOMALY_DAYS} />}
        headline={
          <HeadlineStrip
            headline={chooseHeadline(strip, fallback)}
            hrefs={{
              week: dashboardHref(dashboardPath, scope, { ...view, window: "week" }),
              month: dashboardHref(dashboardPath, scope, { ...view, window: "month" }),
            }}
            markSimulated={!allSimulated}
          />
        }
        declared={declaredCapabilities}
        markSimulated={!allSimulated}
        alerts={alerts}
        trends={
          <Suspense fallback={<TrendsSkeleton />}>
            <DashboardTrendsContent
              trendData={trendData}
              eventCounts={viewCounts}
              dashboardRows={data}
              now={now}
              scope={scope}
              view={view}
              dashboardPath={dashboardPath}
              timelinePath={timelinePath}
              markSimulated={!allSimulated}
            />
          </Suspense>
        }
        heatmap={
          <Suspense fallback={<ActivityHeatmapSkeleton />}>
            <DashboardHeatmapContent
              counts={heatCounts}
              filter={view.heat}
              hrefs={{
                all: dashboardHref(dashboardPath, scope, { ...view, heat: "all" }),
                deploys: dashboardHref(dashboardPath, scope, { ...view, heat: "deploys" }),
                signups: dashboardHref(dashboardPath, scope, { ...view, heat: "signups" }),
                failures: dashboardHref(dashboardPath, scope, { ...view, heat: "failures" }),
              }}
            />
          </Suspense>
        }
      />
    </ArrivalScope>
  );
}

/**
 * The page's one notice when a snapshot read stopped at its row cap (#336), in a live region that
 * stays mounted, so a notice that arrives after the rest of the page is announced. With the daily
 * trend every part is known at once. The monthly trend reads its own rows behind Trends' boundary
 * (#263), so its part joins behind a boundary of its own, which shows the parts already known
 * while that read runs.
 */
function DashboardCapNotice({
  reads,
  trend,
  trendData,
}: {
  /** Every part's read but the monthly trend's. */
  reads: readonly CappedRead[];
  trend: TrendGranularity;
  trendData: Promise<TrendData>;
}) {
  return (
    <LiveRegion tone="status">
      {trend === "daily" ? (
        <CapNotice reads={reads} />
      ) : (
        <Suspense fallback={<CapNotice reads={reads} />}>
          <MonthlyCapNotice reads={reads} trendData={trendData} />
        </Suspense>
      )}
    </LiveRegion>
  );
}

/** The notice once the monthly trend's read resolves, with that read's part (#336). */
async function MonthlyCapNotice({ reads, trendData }: { reads: readonly CappedRead[]; trendData: Promise<TrendData> }) {
  const { completeFrom } = await trendData;
  return <CapNotice reads={[...reads, { part: "monthly trend", completeFrom }]} />;
}

/**
 * The Trends section, awaited behind its own Suspense boundary (#263) so the rest of the dashboard
 * shows without waiting for the trend read: the monthly view groups 13 months of snapshots (#317).
 */
async function DashboardTrendsContent({
  trendData,
  eventCounts,
  dashboardRows,
  now,
  scope,
  view,
  dashboardPath,
  timelinePath,
  markSimulated,
}: {
  trendData: Promise<TrendData>;
  eventCounts: Promise<EventCountRow[]>;
  /**
   * The dashboard's own 45 days, so the default series follow the same rows as the spending and
   * revenue cards in both periods.
   */
  dashboardRows: Pick<DashboardData, "snapshots" | "connections">;
  now: Date;
  scope: ScopeFilters;
  view: DashboardViewParams;
  dashboardPath: string;
  timelinePath: string;
  markSimulated: boolean;
}) {
  const { trend, hidden, expanded } = view;
  const shown = shownCategories(hidden);
  const [{ snapshots, connections }, eventCountRows] = await Promise.all([trendData, eventCounts]);
  const series = buildTrends(snapshots, connections, trend, now);
  const groups = groupTrends(series, defaultSeriesKeys(dashboardRows.snapshots, dashboardRows.connections, declaredProjectedSpend, now));
  const providers = groups.map((group) => ({
    ...group,
    open: expanded.includes(group.provider),
    toggleHref: dashboardHref(dashboardPath, scope, { ...view, expanded: toggleExpanded(expanded, group.provider) }),
  }));
  // Only the charts on the page get markers: a closed disclosure renders nothing.
  const rendered = providers.flatMap(renderedSeries);
  const counts = bucketEventCounts(eventCountRows, trend, now);
  return (
    <TrendsSection
      markSimulated={markSimulated}
      trends={{
        granularity: trend,
        providers,
        hrefs: {
          daily: dashboardHref(dashboardPath, scope, { ...view, trend: "daily" }),
          monthly: dashboardHref(dashboardPath, scope, { ...view, trend: "monthly" }),
        },
        markers: {
          hidden,
          bySeries: Object.fromEntries(
            rendered.map((entry) => [
              entry.key,
              chartMarkers(counts, { provider: entry.provider, shown, granularity: trend, timelinePath, scope }),
            ]),
          ),
          toggles: MARKER_CATEGORIES.map((category) => ({
            category,
            shown: shown.includes(category),
            href: dashboardHref(dashboardPath, scope, { ...view, hidden: toggleHidden(hidden, category) }),
          })),
        },
      }}
    />
  );
}

/** The activity heatmap, awaited behind its own Suspense boundary (#414). */
async function DashboardHeatmapContent({
  counts,
  filter,
  hrefs,
}: {
  counts: Promise<HeatCountRow[]>;
  filter: HeatFilter;
  hrefs: Readonly<Record<HeatFilter, string>>;
}) {
  return <ActivityHeatmapSection grid={heatGrid(await counts)} filter={filter} hrefs={hrefs} />;
}

/** Shaped like the first screen (the closed filter bar and the headline strip's first row), so nothing jumps. */
function DashboardSkeleton() {
  return (
    <LiveRegion tone="status">
      <span className="sr-only">Loading the dashboard</span>
      <div aria-hidden="true">
        <div className="mt-4 h-12.5 rounded-xl border border-line bg-panel motion-safe:animate-pulse" />
        <div className="mt-6 h-6 w-56 rounded bg-panel-raised motion-safe:animate-pulse" />
        <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          <div className="h-36 rounded-xl border border-line bg-panel motion-safe:animate-pulse" />
          <div className="h-36 rounded-xl border border-line bg-panel motion-safe:animate-pulse" />
          <div className="h-36 rounded-xl border border-line bg-panel motion-safe:animate-pulse" />
        </div>
      </div>
    </LiveRegion>
  );
}
