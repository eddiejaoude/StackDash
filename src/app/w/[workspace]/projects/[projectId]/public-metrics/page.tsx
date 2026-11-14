import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { PageSkeleton } from "@/components/app/page-skeleton";
import { PageHeader } from "@/components/app/page-header";
import { SimulatedBadge } from "@/components/connections/simulated-badge";
import { LockIcon } from "@/components/icons";
import {
  DisableProjectPageButton,
  ProjectPageForm,
  PublicationAnnouncer,
  PublishMetricForm,
  SelfReportedForm,
  UnpublishButton,
  UnpublishEverythingButton,
} from "@/components/public-metrics/publication-controls";
import { SELF_REPORTED_LIVE_MAX } from "@/components/public-metrics/self-reported-rules";
import { ShareDialog } from "@/components/public-metrics/share-dialog";
import { achievementsPath } from "@/lib/achievements/private";
import { requestPublicOrigin } from "@/lib/connections/oauth-state";
import { loadProjectPageSettings } from "@/lib/data/project-pages";
import { countLivePublications, loadProjectPublications, VIEW_WINDOW_DAYS, type ProjectMetricStatus } from "@/lib/data/published-metrics";
import { formatDateTime } from "@/lib/format";
import {
  allowedRoundings,
  FORMULAS_DOC_PATH,
  PROVENANCE_LABELS,
  PUBLISHED_METRIC_DELAYS,
  ROUNDING_LABELS,
} from "@/lib/public-metrics/definitions";
import { publicationSummary } from "@/lib/public-metrics/display";
import { projectPagePath, suggestPageSlug, workspaceAddress } from "@/lib/public-metrics/project-page";
import type { PublishedValue } from "@/lib/public-metrics/published";
import {
  badgeAltText,
  badgePath,
  CARD_SIZE,
  cardAltText,
  cardPath,
  metricShareLinks,
  shareableMetric,
  type ShareProjectPage,
} from "@/lib/public-metrics/share";
import { ACCOUNTS_LIMIT } from "@/lib/public-metrics/supabase-store";
import { requireWorkspace } from "@/lib/workspaces/access";
import { workspacePath } from "@/lib/workspaces/paths";
import { actionDeniedReason, canPerform } from "@/lib/workspaces/permissions";

export const metadata: Metadata = { title: "Public metrics" };

const METRICS_HEADING_ID = "public-metrics-title";
const SELF_REPORTED_HEADING_ID = "self-reported-title";
const PROJECT_PAGE_HEADING_ID = "project-page-title";

const DELAY_CHOICES = PUBLISHED_METRIC_DELAYS.map((days) => ({
  value: String(days),
  label: days === 0 ? "Current value" : `${days} days late`,
}));

// Every section renders inside its own Suspense boundary so navigating between sections
// has an instant shell; access checks and data reads stream in behind it.
export default function PublicMetricsPage(props: PageProps<"/w/[workspace]/projects/[projectId]/public-metrics">) {
  return (
    <Suspense fallback={<PageSkeleton label="Loading public metrics" />}>
      <PublicMetricsContent {...props} />
    </Suspense>
  );
}

function ValueText({ value }: { value: PublishedValue }) {
  if (value.status === "unavailable") return <span className="text-muted">{value.text}</span>;
  return (
    <>
      <span className="font-medium text-foreground">{value.text}</span>
      <span className="text-muted">
        {", synced "}
        <time dateTime={value.lastSyncedAt.toISOString()}>{formatDateTime(value.lastSyncedAt)}</time>
      </span>
    </>
  );
}

async function PublicMetricsContent({ params }: PageProps<"/w/[workspace]/projects/[projectId]/public-metrics">) {
  const { workspace: slug, projectId } = await params;
  const { workspace, role } = await requireWorkspace(slug, "viewer");
  // A malformed id would fail the uuid cast in the query; it is the same "no such project" answer.
  if (!z.guid().safeParse(projectId).success) notFound();
  // Read after the request data above, so the clock never runs during prerendering.
  const now = new Date();
  const [publications, liveCount, pageSettings, origin] = await Promise.all([
    loadProjectPublications(workspace.id, projectId, now),
    countLivePublications(workspace.id),
    loadProjectPageSettings(workspace.id, projectId),
    // Share links use the public origin, as the public JSON route builds its formula links.
    requestPublicOrigin(),
  ]);
  if (publications === null) notFound();

  const { project, metrics, selfReported, tooManyAccounts } = publications;
  const canPublish = canPerform(role, "publish_metrics");
  const deniedReason = actionDeniedReason("publish_metrics");
  const publicDataPath = `/api/public/projects/${project.id}/metrics`;
  const anyPublished = metrics.some((metric) => metric.publication !== null) || selfReported.length > 0;
  const pagePath = pageSettings === null ? null : projectPagePath(workspace, pageSettings.slug);
  // Share links lead to the page only while it answers: it is on, and the metric being shared is
  // published, so the project has a live publication.
  const sharePage: ShareProjectPage | null = pageSettings?.enabled === true && pagePath !== null ? { path: pagePath, projectName: project.name } : null;

  return (
    <>
      <p className="mb-4 text-sm">
        <Link
          href={workspacePath(workspace.slug, "projects")}
          className="text-muted underline-offset-4 hover:text-foreground hover:underline"
        >
          All projects
        </Link>
      </p>
      <PageHeader
        title={`Public metrics for ${project.name}`}
        description="Owners and admins choose which numbers anyone can see. Nothing is public until it is published. Spend, budgets, and alerts from your providers can never be published, and no account or repository names are shown."
      />

      <PublicationAnnouncer>
        {canPublish ? null : (
          <p className="mt-6 flex items-center gap-2 text-sm text-muted">
            <LockIcon className="shrink-0" />
            <span>{deniedReason}</span>
          </p>
        )}

        <section aria-labelledby="public-link-title" className="mt-6 rounded-xl border border-line bg-panel px-6 py-5 text-sm">
          <h2 id="public-link-title" className="font-semibold">
            Where it is public
          </h2>
          {anyPublished ? (
            <p className="mt-2 leading-6 text-muted">
              Anyone can read this project&apos;s published values at{" "}
              <a href={publicDataPath} className="break-all font-medium text-foreground underline underline-offset-4">
                {publicDataPath}
              </a>
              . Each published metric also has a live badge and a card: use Share beside it. The project page,
              badges, and cards read the same values.
            </p>
          ) : (
            <p className="mt-2 leading-6 text-muted">No metric or self-reported value from this project is public.</p>
          )}
          <p className="mt-2 leading-6 text-muted">
            Every formula is on the{" "}
            <Link href={FORMULAS_DOC_PATH} className="font-medium text-foreground underline underline-offset-4">
              public metrics formulas page
            </Link>
            .
          </p>
          <p className="mt-2 leading-6 text-muted">
            Achievements this project has earned are published one at a time on its{" "}
            <Link href={achievementsPath(workspace.slug, project.id)} className="font-medium text-foreground underline underline-offset-4">
              Achievements page
            </Link>
            .
          </p>
          {canPublish && liveCount > 0 ? (
            <div className="mt-4 border-t border-line pt-4">
              <p className="mb-3 leading-6 text-muted">
                Unpublish every metric and self-reported value of every project in this workspace at once.
              </p>
              <UnpublishEverythingButton workspaceSlug={workspace.slug} liveCount={liveCount} focusId={METRICS_HEADING_ID} />
            </div>
          ) : null}
        </section>

        <section aria-labelledby={PROJECT_PAGE_HEADING_ID} className="mt-6 rounded-xl border border-line bg-panel px-6 py-5 text-sm">
          <h2 id={PROJECT_PAGE_HEADING_ID} tabIndex={-1} className="font-semibold">
            Project page
          </h2>
          <p className="mt-2 leading-6 text-muted">
            {pageSettings === null || pagePath === null ? (
              "Off. Nothing is public at a project page address until an owner or admin turns it on."
            ) : !pageSettings.enabled ? (
              <>
                Off. Its address, <span className="break-all font-mono">{pagePath}</span>, answers page not found.
              </>
            ) : anyPublished ? (
              <>
                On. Anyone can open it at{" "}
                <a href={pagePath} className="break-all font-mono font-medium text-foreground underline underline-offset-4">
                  {pagePath}
                </a>
                .{" "}
                {pageSettings.indexable ? "Search engines may index it." : "It asks search engines not to index it."}
              </>
            ) : (
              <>
                On, but <span className="break-all font-mono">{pagePath}</span> answers page not found until something below is
                published.
              </>
            )}
          </p>
          <p className="mt-2 leading-6 text-muted">
            The page shows the project name, the values published below with their 30 and 90 day history, the milestones
            those values reveal, and the providers behind them as icons. Choose its metrics, rounding, and timing below.
          </p>
          {canPublish ? (
            <div className="mt-4 space-y-4 border-t border-line pt-4">
              <ProjectPageForm
                workspaceSlug={workspace.slug}
                workspaceAddress={workspaceAddress(workspace)}
                projectId={project.id}
                initialSlug={pageSettings?.slug ?? suggestPageSlug(project.name)}
                initialIndexable={pageSettings?.indexable ?? false}
                enabled={pageSettings?.enabled ?? false}
                focusId={PROJECT_PAGE_HEADING_ID}
              />
              {pageSettings?.enabled ? (
                <DisableProjectPageButton workspaceSlug={workspace.slug} projectId={project.id} focusId={PROJECT_PAGE_HEADING_ID} />
              ) : null}
            </div>
          ) : null}
        </section>

        <section aria-labelledby={METRICS_HEADING_ID} className="mt-6 rounded-xl border border-line bg-panel">
          <h2 id={METRICS_HEADING_ID} tabIndex={-1} className="border-b border-line px-6 py-4 text-sm font-semibold">
            Metrics from your connected providers
          </h2>
          {tooManyAccounts ? (
            <div className="border-b border-line px-6 py-4 text-sm">
              <p className="font-semibold text-warning">These metrics cannot be computed</p>
              <p className="mt-1 leading-6 text-muted">
                This project has more than {ACCOUNTS_LIMIT} included accounts, and public metrics count at most{" "}
                {ACCOUNTS_LIMIT}. Rather than show a smaller number, every metric below is unavailable, here and
                wherever it is published. To fix it, exclude the accounts this project does not need on their
                connection&apos;s page in{" "}
                <Link
                  href={workspacePath(workspace.slug, "connections")}
                  className="underline underline-offset-4 hover:text-foreground"
                >
                  Connections
                </Link>
                .
              </p>
            </div>
          ) : null}
          <ul className="divide-y divide-line">
            {metrics.map((metric) => (
              <MetricRow
                key={metric.metricId}
                metric={metric}
                workspaceSlug={workspace.slug}
                projectId={project.id}
                canPublish={canPublish}
                origin={origin}
                projectPage={sharePage}
              />
            ))}
          </ul>
        </section>

        <section aria-labelledby={SELF_REPORTED_HEADING_ID} className="mt-6 rounded-xl border border-line bg-panel">
          <div className="border-b border-line px-6 py-4">
            <h2 id={SELF_REPORTED_HEADING_ID} tabIndex={-1} className="text-sm font-semibold">
              Self-reported values
            </h2>
            <p className="mt-1 text-sm leading-6 text-muted">
              Numbers you type yourself, up to {SELF_REPORTED_LIVE_MAX} per project. They appear on the project page
              labeled Self-reported, and never on a badge or a leaderboard.
            </p>
          </div>
          {selfReported.length === 0 ? (
            <p className="px-6 py-4 text-sm text-muted">No self-reported values are published.</p>
          ) : (
            <ul className="divide-y divide-line">
              {selfReported.map((entry) => (
                <li key={entry.publicationId} className="flex flex-col gap-3 px-6 py-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="break-words font-medium">
                      {entry.label}: {entry.text}
                    </p>
                    <p className="mt-1 text-muted">
                      {PROVENANCE_LABELS.self_reported}, published{" "}
                      <time dateTime={entry.publishedAt.toISOString()}>{formatDateTime(entry.publishedAt)}</time>
                    </p>
                  </div>
                  {canPublish ? (
                    <UnpublishButton
                      workspaceSlug={workspace.slug}
                      publicationId={entry.publicationId}
                      label={entry.label}
                      focusId={SELF_REPORTED_HEADING_ID}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {canPublish ? (
            <div className="border-t border-line px-6 py-5">
              <h3 className="mb-3 text-sm font-semibold">Publish a self-reported value</h3>
              <SelfReportedForm workspaceSlug={workspace.slug} projectId={project.id} focusId={SELF_REPORTED_HEADING_ID} />
            </div>
          ) : null}
        </section>
      </PublicationAnnouncer>
    </>
  );
}

/** "1 time", "320 times". */
function times(count: number): string {
  return count === 1 ? "1 time" : `${new Intl.NumberFormat("en-US").format(count)} times`;
}

/** The share dialog of a published metric: its badge, its card, and where they are served. */
function ShareMetric({ metric, publication, projectId, origin, projectPage }: {
  metric: ProjectMetricStatus;
  publication: NonNullable<ProjectMetricStatus["publication"]>;
  projectId: string;
  origin: string;
  projectPage: ShareProjectPage | null;
}) {
  const shareable = shareableMetric(publication);
  // The previews load from this page's own origin, which the app's img-src 'self' allows even when
  // NEXT_PUBLIC_SITE_URL names another host; the copied links use the public origin.
  const badgeSrc = badgePath(projectId, metric.metricId);
  const cardSrc = cardPath(projectId, metric.metricId);
  const links = metricShareLinks({ origin, projectId, metricId: metric.metricId, formulaPath: metric.formulaPath, metric: shareable, projectPage });
  return (
    <ShareDialog
      title={`Share ${metric.label}`}
      triggerText="Share"
      subject={metric.label}
      badge={{ src: badgeSrc, alt: badgeAltText(shareable), markdown: links.badgeMarkdown }}
      card={{ src: cardSrc, alt: cardAltText(shareable, projectPage?.projectName ?? null), ...CARD_SIZE, publicUrl: links.cardUrl }}
      xIntentUrl={links.xIntentUrl}
      link={{ url: links.link, linkedInUrl: links.linkedInUrl }}
      notes={[
        projectPage === null
          ? "Anyone with these links sees the published value, and nothing else. Unpublishing turns both into an Unpublished image within a minute."
          : "Anyone with these links sees the published value and the project name, which the project page already shows. Unpublishing turns both into an Unpublished image within a minute.",
        // Cards are cached for a minute (PUBLIC_CACHE_CONTROL), so the name follows the page that late.
        projectPage === null
          ? "Posts link to the card, and the badge to how the metric is counted. Turn on the project page to link posts and the badge to it; the card shows the project name within a minute."
          : `Posts and the badge link to the project page at ${projectPage.path}. The card shows the project name within a minute of turning the page on, and drops it within a minute of turning it off.`,
        `In the last ${VIEW_WINDOW_DAYS} days DevMacro served the badge ${times(metric.views.badge)} and the card ${times(metric.views.card)}, including previews here. Views a cache answers, such as GitHub's image proxy, are not counted.`,
      ]}
    />
  );
}

function MetricRow({
  metric,
  workspaceSlug,
  projectId,
  canPublish,
  origin,
  projectPage,
}: {
  metric: ProjectMetricStatus;
  workspaceSlug: string;
  projectId: string;
  canPublish: boolean;
  origin: string;
  projectPage: ShareProjectPage | null;
}) {
  const { publication } = metric;
  const simulated =
    (metric.current.status === "available" && metric.current.simulated) ||
    (publication?.value.status === "available" && publication.value.simulated);
  return (
    <li className="flex flex-col gap-3 px-6 py-4 text-sm lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{metric.label}</span>
          <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs text-muted">
            {PROVENANCE_LABELS[metric.provenance]}
          </span>
          {simulated ? <SimulatedBadge /> : null}
        </p>
        <p className="mt-1">
          <span className="text-muted">Now: </span>
          <ValueText value={metric.current} />
        </p>
        <p className="mt-1">
          {publication === null ? (
            <span className="text-muted">Not published</span>
          ) : (
            <>
              <span className="font-medium text-success">Published</span>
              <span className="text-muted">
                {` (${publicationSummary(publication.rounding, publication.delayDays)}) since `}
                <time dateTime={publication.publishedAt.toISOString()}>{formatDateTime(publication.publishedAt)}</time>
                {". Public value: "}
              </span>
              <ValueText value={publication.value} />
            </>
          )}
        </p>
        <p className="mt-1">
          <Link href={metric.formulaPath} className="text-muted underline underline-offset-4 hover:text-foreground">
            How it is counted<span className="sr-only"> for {metric.label}</span>
          </Link>
        </p>
      </div>
      {publication === null ? (
        canPublish ? (
          <div className="shrink-0">
            <PublishMetricForm
              workspaceSlug={workspaceSlug}
              projectId={projectId}
              metricId={metric.metricId}
              metricLabel={metric.label}
              roundings={allowedRoundings(metric.unit).map((rounding) => ({ value: rounding, label: ROUNDING_LABELS[rounding] }))}
              delays={DELAY_CHOICES}
              focusId={METRICS_HEADING_ID}
            />
          </div>
        ) : null
      ) : (
        <div className="flex shrink-0 flex-wrap items-start gap-3">
          {canPublish ? (
            <UnpublishButton
              workspaceSlug={workspaceSlug}
              publicationId={publication.publicationId}
              label={metric.label}
              focusId={METRICS_HEADING_ID}
            />
          ) : null}
          <ShareMetric metric={metric} publication={publication} projectId={projectId} origin={origin} projectPage={projectPage} />
        </div>
      )}
    </li>
  );
}
