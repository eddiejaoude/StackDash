import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/app/page-skeleton";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { ArrowRightIcon, TimelineIcon } from "@/components/icons";
import { EventList } from "@/components/timeline/event-list";
import { TimelineFilters } from "@/components/timeline/timeline-filters";
import { getWorkspaceScope } from "@/lib/data/dashboard";
import { listTimelineEvents, listTimelineTypeIds } from "@/lib/data/timeline";
import { buildScopeOptions, describeScope } from "@/lib/filters/scope";
import { hasActiveFilters, parseTimelineSearchParams, timelineHref } from "@/lib/timeline/query";
import { requireWorkspace, workspacePath } from "@/lib/workspaces/access";
import { actionDeniedReason, canPerform } from "@/lib/workspaces/permissions";

export const metadata: Metadata = { title: "Timeline" };

const DESCRIPTION = "Deploys, payments, alerts, and other activity from every provider, newest first.";

// Per-member hidden event types arrive with #119; the query already excludes whatever is listed.
const HIDDEN_TYPE_IDS: readonly string[] = [];

// Every section renders inside its own Suspense boundary so navigating between sections
// has an instant shell; access checks and data reads stream in behind it.
export default function TimelinePage(props: PageProps<"/w/[workspace]/timeline">) {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TimelineContent {...props} />
    </Suspense>
  );
}

async function TimelineContent({ params, searchParams }: PageProps<"/w/[workspace]/timeline">) {
  const { workspace: slug } = await params;
  const { workspace, role } = await requireWorkspace(slug, "viewer");
  const query = parseTimelineSearchParams(await searchParams);
  const basePath = workspacePath(workspace.slug, "timeline");

  const [page, typeIds, workspaceScope] = await Promise.all([
    listTimelineEvents(workspace.id, { ...query, hiddenTypeIds: HIDDEN_TYPE_IDS }),
    listTimelineTypeIds(workspace.id),
    getWorkspaceScope(workspace.id),
  ]);
  // Read after the request data above, so prerendering never sees the clock.
  const now = new Date();

  // The type sample covers the newest events, so it is empty only when there are none at all.
  if (typeIds.length === 0) {
    const canConnect = canPerform(role, "manage_connections");
    return (
      <>
        <PageHeader title="Timeline" description={DESCRIPTION} />
        <EmptyState
          icon={<TimelineIcon width={20} height={20} />}
          title="No activity yet"
          description="Events appear here after you connect a provider and its first sync finishes."
          action={{ href: workspacePath(workspace.slug, "connections"), label: "Connect a provider" }}
          deniedReason={canConnect ? undefined : actionDeniedReason("manage_connections")}
        />
      </>
    );
  }

  const count = page.events.length;
  const filtered = hasActiveFilters(query);
  const olderPage = query.cursor !== null;
  const showNewestLink = olderPage && count > 0;
  const scopeOptions = buildScopeOptions(workspaceScope, query.scope);
  const scopeDescription = describeScope(query.scope, scopeOptions);
  const shown =
    count === 0 ? "Showing no events" : `Showing ${count} ${olderPage ? "older " : ""}${count === 1 ? "event" : "events"}`;

  return (
    <>
      <PageHeader title="Timeline" description={DESCRIPTION} />
      <TimelineFilters action={basePath} query={query} typeIds={typeIds} scopeOptions={scopeOptions} />

      <p role="status" aria-live="polite" className="mt-6 text-sm text-muted">
        {scopeDescription === null ? shown : `${shown} for ${scopeDescription}`}
      </p>

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
        <EventList events={page.events} now={now} />
      )}

      {page.nextCursor === null && !showNewestLink ? null : (
        <nav aria-label="Timeline pages" className="mt-6 flex flex-wrap items-center gap-3">
          {showNewestLink ? (
            <Link
              href={timelineHref(basePath, query, null)}
              className="inline-flex min-h-10 items-center rounded-md border border-line-strong px-4 py-2 text-sm text-muted transition-colors hover:text-foreground"
            >
              Show newest events
            </Link>
          ) : null}
          {page.nextCursor === null ? null : (
            <Link
              href={timelineHref(basePath, query, page.nextCursor)}
              className="inline-flex min-h-10 items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85"
            >
              Load older events
              <ArrowRightIcon />
            </Link>
          )}
        </nav>
      )}
    </>
  );
}
