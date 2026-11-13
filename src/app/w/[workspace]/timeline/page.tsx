import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ArrivalScope } from "@/components/app/arrivals";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { SampleDataForm } from "@/components/connections/connection-controls";
import { FeedbackBanner } from "@/components/connections/feedback-banner";
import { SimulatedNotice } from "@/components/connections/simulated-badge";
import { ArrowRightIcon, TimelineIcon } from "@/components/icons";
import { EventList } from "@/components/timeline/event-list";
import { EventInspector, type InspectorEvent } from "@/components/timeline/event-inspector";
import { ActivityOverview } from "@/components/timeline/activity-overview";
import { ProviderBadges } from "@/components/timeline/provider-badges";
import { ActiveFilterChips, TimelineFilters, TimelineToolbar } from "@/components/timeline/timeline-filters";
import { buttonClass } from "@/components/ui/button";
import { eventTypeName } from "@/lib/adapters/registry";
import { isProviderSimulationEnabled } from "@/lib/adapters/simulated";
import { everySimulated } from "@/lib/adapters/simulated/marker";
import { getWorkspaceScope } from "@/lib/data/dashboard";
import { getTimelineEvent, listTimelineActivity, listTimelineConnectionCounts, listTimelineEvents, listTimelineTypeIds, type TimelineEvent } from "@/lib/data/timeline";
import { SAMPLE_DATA_ADDED_PARAM, sampleDataRefusal } from "@/lib/demo/workspace";
import { buildScopeOptions, describeScope } from "@/lib/filters/scope";
import { formatDateTime } from "@/lib/format";
import { timelineEmptyKind } from "@/lib/timeline/empty-state";
import {
  hasActiveFilters,
  parseTimelineEventId,
  parseTimelineSearchParams,
  timelineHref,
  timelineStatus,
  timelineTotal,
} from "@/lib/timeline/query";
import { requireWorkspace } from "@/lib/workspaces/access";
import { workspacePath } from "@/lib/workspaces/paths";
import { actionDeniedReason, canPerform } from "@/lib/workspaces/permissions";

export const metadata: Metadata = { title: "Timeline" };

const DESCRIPTION = "Deploys, payments, alerts, and other activity from every provider, newest first.";
// The inspector returns focus here when nothing on the page opened it.
const HEADING_ID = "timeline-title";

// Per-member hidden event types arrive with #119; the query already excludes whatever is listed.
const HIDDEN_TYPE_IDS: readonly string[] = [];

// Written on the server, as the row's own time is: browsers name the London zone differently. The
// type's declared name comes from the adapter registry, which is server-only (#294).
function inspected(event: TimelineEvent): InspectorEvent {
  return { ...event, londonTime: formatDateTime(event.occurred_at), typeName: eventTypeName(event.type_id) };
}

// Every section renders inside its own Suspense boundary so navigating between sections
// has an instant shell; access checks and data reads stream in behind it.
export default function TimelinePage(props: PageProps<"/w/[workspace]/timeline">) {
  return (
    <Suspense fallback={<PageSkeleton label="Loading the timeline" />}>
      <TimelineContent {...props} />
    </Suspense>
  );
}

async function TimelineContent({ params, searchParams }: PageProps<"/w/[workspace]/timeline">) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug, "viewer");
  const rawQuery = await searchParams;
  const query = parseTimelineSearchParams(rawQuery);
  const selectedEventId = parseTimelineEventId(rawQuery.event);
  const basePath = workspacePath(workspace.slug, "timeline");

  const filters = { ...query, hiddenTypeIds: HIDDEN_TYPE_IDS };
  const [page, connectionCounts, typeIds, workspaceScope, linkedEvent, activity] = await Promise.all([
    listTimelineEvents(workspace.id, filters),
    listTimelineConnectionCounts(workspace.id, filters),
    listTimelineTypeIds(workspace.id),
    getWorkspaceScope(workspace.id),
    selectedEventId === null ? null : getTimelineEvent(workspace.id, selectedEventId),
    listTimelineActivity(workspace.id, filters),
  ]);
  // Read after the request data above, so prerendering never sees the clock.
  const now = new Date();
  const inspectorProps = {
    events: page.events.map(inspected),
    linkedEvent: linkedEvent === null ? null : inspected(linkedEvent),
    baseHref: timelineHref(basePath, query, query.cursor),
    fallbackFocusId: HEADING_ID,
  };

  // The type ids come from the daily event count rollup, which its triggers keep equal to every
  // event the workspace has, so they are empty only when there are no events at all.
  if (typeIds.length === 0) {
    // Something is connected (#322): say whether events are coming instead of asking for a provider.
    // Every role can read the Connections page, so neither control is ever denied.
    const emptyKind = timelineEmptyKind(workspaceScope.connections);
    if (emptyKind !== "no_connections") {
      const connectionsPath = workspacePath(workspace.slug, "connections");
      return (
        <EventInspector {...inspectorProps}>
          <PageHeader id={HEADING_ID} title="Timeline" description={DESCRIPTION} />
          {emptyKind === "first_sync" ? (
            <EmptyState
              icon={<TimelineIcon width={20} height={20} />}
              title="Events are on their way"
              description="The first sync is queued or running. Its events appear here as they arrive, without a reload. While you wait, see its status on the Connections page."
              action={{ href: connectionsPath, label: "Check connection status" }}
            />
          ) : (
            <EmptyState
              icon={<TimelineIcon width={20} height={20} />}
              title="No activity yet"
              description="Your connected providers have not reported any events yet. New events appear here as they happen. To see whether each connection is syncing, check the Connections page."
              action={{ href: connectionsPath, label: "Check connections" }}
            />
          )}
        </EventInspector>
      );
    }
    const canConnect = canPerform(role, "manage_connections");
    // Offered to owners and admins of a workspace with nothing connected, while simulation is on.
    const offerSampleData =
      canConnect &&
      sampleDataRefusal({
        simulationEnabled: isProviderSimulationEnabled(),
        connectionCount: workspaceScope.connections.length,
      }) === null;
    return (
      <EventInspector {...inspectorProps}>
        <PageHeader id={HEADING_ID} title="Timeline" description={DESCRIPTION} />
        <EmptyState
          icon={<TimelineIcon width={20} height={20} />}
          title="No activity yet"
          description={
            offerSampleData
              ? "Events appear here after you connect a provider and its first sync finishes. To look around first, explore with sample data: made-up activity from simulated providers, labeled Simulated."
              : "Events appear here after you connect a provider and its first sync finishes."
          }
          action={{ href: workspacePath(workspace.slug, "connections"), label: "Connect a provider" }}
          deniedReason={canConnect ? undefined : actionDeniedReason("manage_connections")}
          secondaryAction={offerSampleData ? <SampleDataForm workspaceSlug={workspace.slug} /> : undefined}
        />
      </EventInspector>
    );
  }

  const count = page.events.length;
  const filtered = hasActiveFilters(query);
  const olderPage = query.cursor !== null;
  const showNewestLink = olderPage && count > 0;
  const scopeOptions = buildScopeOptions(workspaceScope, query.scope);
  const status = timelineStatus({
    count,
    total: timelineTotal(activity, query.timeRange),
    olderPage,
    search: query.search,
    scopeDescription: describeScope(query.scope, scopeOptions),
  });
  // Events with a connection are the connections in view; DevMacro's own events have none (#269).
  const allSimulated = everySimulated(page.events.filter((event) => event.connectionName !== null));

  return (
    <EventInspector {...inspectorProps}>
      <PageHeader
        id={HEADING_ID}
        title="Timeline"
        description={DESCRIPTION}
        titleAside={<ProviderBadges counts={connectionCounts} action={basePath} query={query} />}
      />
      {rawQuery[SAMPLE_DATA_ADDED_PARAM] === "added" ? (
        <FeedbackBanner tone="success" title="Sample data added">
          <p>
            Every simulated provider is connected to this workspace. Their data is made up, and everything it shows is
            labeled Simulated. Delete the simulated connections on the{" "}
            <Link
              href={workspacePath(workspace.slug, "connections")}
              className="font-medium text-foreground underline underline-offset-4"
            >
              Connections page
            </Link>{" "}
            when you are done.
          </p>
        </FeedbackBanner>
      ) : null}
      <TimelineToolbar action={basePath} query={query} />
      <TimelineFilters
        action={basePath}
        query={query}
        typeIds={typeIds}
        scopeOptions={scopeOptions}
        status={status}
      />
      <ActiveFilterChips action={basePath} query={query} scopeOptions={scopeOptions} />
      <ActivityOverview buckets={activity} query={query} basePath={basePath} />

      {count === 0 ? (
        filtered ? (
          <EmptyState
            icon={<TimelineIcon width={20} height={20} />}
            title="No events match these filters"
            description="Try a wider date range or different filters, or clear the filters to see everything."
            action={{ href: basePath, label: "Clear filters" }}
          />
        ) : (
          <EmptyState
            icon={<TimelineIcon width={20} height={20} />}
            title="No older events"
            description="You have reached the start of this timeline."
            action={{ href: basePath, label: "Show newest events" }}
          />
        )
      ) : (
        <>
          {allSimulated ? <SimulatedNotice /> : null}
          {/* The list's URL is its scope: new filters or another page reset what counts as arrived. */}
          <ArrivalScope scope={timelineHref(basePath, query, query.cursor)}>
            <EventList events={page.events} now={now} markSimulated={!allSimulated} />
          </ArrivalScope>
        </>
      )}

      {page.nextCursor === null && !showNewestLink ? null : (
        <nav aria-label="Timeline pages" className="mt-6 flex flex-wrap items-center gap-3">
          {showNewestLink ? (
            <Link
              href={timelineHref(basePath, query, null)}
              className={buttonClass("secondary")}
            >
              Show newest events
            </Link>
          ) : null}
          {page.nextCursor === null ? null : (
            <Link
              href={timelineHref(basePath, query, page.nextCursor)}
              className={`gap-2 ${buttonClass("primary")}`}
            >
              Load older events
              <ArrowRightIcon />
            </Link>
          )}
        </nav>
      )}
    </EventInspector>
  );
}
