import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { SimulatedBadge } from "@/components/connections/simulated-badge";
import { ProviderMark } from "@/components/ui/provider-mark";
import { AchievementShareDialog } from "@/components/public-metrics/achievement-share-dialog";
import { HistoryChart } from "@/components/public-metrics/history-chart";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";
import { requestPublicOrigin } from "@/lib/connections/oauth-state";
import { loadPublicProjectPage } from "@/lib/data/project-pages";
import { formatDateTime, formatUtcDate } from "@/lib/format";
import { FORMULAS_DOC_PATH, PROVENANCE_LABELS } from "@/lib/public-metrics/definitions";
import { HISTORY_DAYS, milestonesBesideAchievements } from "@/lib/public-metrics/history";
import { projectPagePath } from "@/lib/public-metrics/project-page";
import {
  loadPublishedAchievements,
  loadPublishedProjectHistory,
  type PublishedAchievement,
  type PublishedEngineMetric,
  type PublishedMetric,
  type PublishedSelfReportedMetric,
} from "@/lib/public-metrics/published";
import { achievementEarnedText, CARD_SIZE, cardPath, type ShareProjectPage } from "@/lib/public-metrics/share";
import { site } from "@/lib/site";
import { socialMetadata } from "@/lib/site-metadata";

/*
 * A public project page (#150), answered at /@<handle or workspace slug>/<page slug> (src/proxy.ts
 * rewrites that address here, sends a slug address to the handle address while the workspace has a
 * handle (#258), and refuses this path when it is asked for directly). It shows only what the
 * metric engine publishes for the project: the published values, their history, the milestones
 * those values reveal, and the providers behind them as icons; and the achievements the project
 * published (#413), each with its share dialog. No account names, no amounts. A milestone that a
 * published achievement already states is left out, so no fact is listed twice.
 *
 * The enforced CSP nonce (src/proxy.ts) needs this page's HTML rendered per request, so it awaits
 * `connection()` before anything renders and allows an empty static shell (#125). That shell is
 * sent with a 200 before the data loads, so the proxy answers an unknown address, a page that is
 * off, and a page with nothing published with the same 404 before this page renders. The
 * notFound() calls here cover a page turned off between the proxy's read and this one: the
 * not-found page streams in with noindex.
 *
 * Caching (#321): nothing is cached across requests. The HTML carries the per request nonce, which
 * a shared cache would hand to every reader, and turning a page off must answer 404 on the very
 * next request. Within a request, generateMetadata and the page share one loadPublicProjectPage
 * read (React cache, in src/lib/data/project-pages.ts). What bounds the cost instead is the public
 * rate limit the badges and cards share, which src/proxy.ts applies before this page renders,
 * because only the proxy can still answer a 429.
 */
export const instant = false;

// One chart per metric over the whole history the page reads (#344). The last 30 days are a
// sentence beside it, not a second chart of the same line.
const HISTORY_PERIOD = `last ${HISTORY_DAYS} days`;
const RECENT_WINDOW = { days: 30, period: "last 30 days" } as const;
const DESCRIPTION_METRICS = 3;

function isEngine(metric: PublishedMetric): metric is PublishedEngineMetric {
  return metric.kind === "engine";
}

export async function generateMetadata({ params }: PageProps<"/p/[workspace]/[slug]">): Promise<Metadata> {
  await connection();
  const { workspace, slug } = await params;
  const page = await loadPublicProjectPage(workspace, slug);
  if (page === null) notFound();

  const title = `${page.projectName}: public metrics`;
  const shown = page.published.metrics
    .slice(0, DESCRIPTION_METRICS)
    .map((metric) => `${metric.label}: ${metric.kind === "engine" ? metric.value.text : metric.text}`);
  const description = `What ${page.projectName} publishes on ${site.name}. ${shown.join(". ")}.`;
  const card = page.published.metrics.find(isEngine);
  // The preview image is the badges and cards (#149) card of the first published engine metric,
  // and the site image (#338) when only self-reported values are published.
  const images =
    card === undefined
      ? {}
      : { images: [{ url: cardPath(page.published.projectId, card.metricId), ...CARD_SIZE, alt: `${card.label} for ${page.projectName}` }] };

  return {
    title,
    description,
    // Indexable only when the owner chose it (#150).
    robots: page.indexable ? { index: true, follow: true } : { index: false, follow: false },
    ...socialMetadata({ title, description, path: projectPagePath(page.workspace, page.pageSlug), ...images }),
  };
}

export default async function ProjectPage({ params }: PageProps<"/p/[workspace]/[slug]">) {
  await connection();
  const { workspace, slug } = await params;
  const page = await loadPublicProjectPage(workspace, slug);
  if (page === null) notFound();
  const projectPage: ShareProjectPage = { path: projectPagePath(page.workspace, page.pageSlug), projectName: page.projectName };
  const [history, achievements, origin] = await Promise.all([
    loadPublishedProjectHistory(page.published),
    loadPublishedAchievements(page.published.projectId),
    // Share links use the public origin, as the in-app share dialogs build theirs.
    requestPublicOrigin(),
  ]);
  const milestones = milestonesBesideAchievements(history.milestones, achievements);

  const engine = page.published.metrics.filter(isEngine);
  const selfReported = page.published.metrics.filter((metric): metric is PublishedSelfReportedMetric => metric.kind === "self_reported");
  // Icons only, for the connected providers behind published values; never account names. A metric
  // that counts several providers (deployments) shows only those the project has connected.
  const providers = [...new Set(engine.flatMap((metric) => metric.providers))];

  return (
    <>
      <SiteNav anchorBase="/" />
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-6 py-12 lg:py-16">
        <p className="font-mono text-xs font-medium text-muted">Public project page</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight break-words">{page.projectName}</h1>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted">
          The numbers this project chose to publish on {site.name}, counted from what its providers report. Each one
          says how it is counted and when it was last synced.
        </p>
        {providers.length === 0 ? null : (
          <div className="mt-6">
            <h2 className="text-sm font-semibold">Connected providers</h2>
            <ul className="mt-3 flex flex-wrap gap-3">
              {providers.map((provider) => (
                <li key={provider}>
                  <ProviderMark provider={provider} labeled />
                </li>
              ))}
            </ul>
          </div>
        )}

        <section aria-labelledby="published-title" className="mt-10">
          <h2 id="published-title" className="text-lg font-semibold">
            Published metrics
          </h2>
          <ul className="mt-4 grid gap-4 sm:grid-cols-2">
            {engine.map((metric) => (
              <EngineMetricCard key={metric.publicationId} metric={metric} />
            ))}
            {selfReported.map((metric) => (
              <li key={metric.publicationId} className="rounded-xl border border-line bg-panel p-5">
                <h3 className="flex flex-wrap items-center gap-2 font-medium">
                  <span className="break-words">{metric.label}</span>
                  <ProvenanceBadge label={PROVENANCE_LABELS.self_reported} />
                </h3>
                <p className="mt-3 text-2xl font-semibold tabular-nums">{metric.text}</p>
                <p className="mt-2 text-sm text-muted">
                  Typed by the project, not counted by {site.name}. Published{" "}
                  <time dateTime={metric.publishedAt.toISOString()}>{formatDateTime(metric.publishedAt)}</time>.
                </p>
              </li>
            ))}
          </ul>
        </section>

        {achievements.length === 0 ? null : (
          <section aria-labelledby="achievements-title" className="mt-12">
            <h2 id="achievements-title" className="text-lg font-semibold">
              Achievements
            </h2>
            <p className="mt-2 text-sm text-muted">
              Earned from what this project&apos;s providers report, and published by the project. Once earned, an achievement
              stays earned.
            </p>
            <ul className="mt-4 space-y-3">
              {achievements.map((achievement) => (
                <AchievementItem
                  key={achievement.achievementId}
                  achievement={achievement}
                  projectId={page.published.projectId}
                  origin={origin}
                  projectPage={projectPage}
                />
              ))}
            </ul>
          </section>
        )}

        {history.histories.length === 0 ? null : (
          <section aria-labelledby="history-title" className="mt-12">
            <h2 id="history-title" className="text-lg font-semibold">
              History
            </h2>
            <p className="mt-2 text-sm text-muted">
              Each day&apos;s published value, rounded and delayed the same way as today&apos;s.
            </p>
            {history.histories.map((entry) => (
              <div key={entry.publicationId} className="mt-6">
                <h3 className="font-medium">{entry.label}</h3>
                <div className="mt-3">
                  <HistoryChart title={entry.label} period={HISTORY_PERIOD} recent={RECENT_WINDOW} points={entry.points} />
                </div>
              </div>
            ))}
          </section>
        )}

        <section aria-labelledby="milestones-title" className="mt-12">
          <h2 id="milestones-title" className="text-lg font-semibold">
            Milestones
          </h2>
          {milestones.length === 0 ? (
            <p className="mt-2 text-sm text-muted">No milestones yet in what this project publishes.</p>
          ) : (
            <ol className="mt-4 space-y-3 border-l border-line pl-5">
              {milestones.map((milestone) => (
                <li key={milestone.id} className="text-sm">
                  <span className="font-medium">{milestone.title}</span>
                  <span className="text-muted">
                    {" on "}
                    <time dateTime={milestone.at.toISOString()}>{milestone.at.toISOString().slice(0, 10)}</time>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>

        <p className="mt-12 text-sm text-muted">
          Every formula is on the{" "}
          <Link href={FORMULAS_DOC_PATH} className="font-medium text-foreground underline underline-offset-4">
            public metrics formulas page
          </Link>
          . Spend, budgets, and account names are never published.
        </p>
      </main>
      <SiteFooter anchorBase="/" />
    </>
  );
}

function ProvenanceBadge({ label }: { label: string }) {
  return <span className="rounded-full border border-line-strong px-2 py-0.5 text-xs font-normal text-muted">{label}</span>;
}

function EngineMetricCard({ metric }: { metric: PublishedEngineMetric }) {
  const { value } = metric;
  return (
    <li className="rounded-xl border border-line bg-panel p-5">
      <h3 className="flex flex-wrap items-center gap-2 font-medium">
        <span>{metric.label}</span>
        <ProvenanceBadge label={PROVENANCE_LABELS[metric.provenance]} />
        {value.status === "available" && value.simulated ? <SimulatedBadge /> : null}
      </h3>
      {value.status === "available" ? (
        <>
          <p className="mt-3 text-2xl font-semibold tabular-nums">{value.text}</p>
          <p className="mt-2 text-sm text-muted">
            {metric.delayDays === 0 ? "Synced " : `Shown ${metric.delayDays} days late, as of `}
            <time dateTime={(metric.delayDays === 0 ? value.lastSyncedAt : metric.asOf).toISOString()}>
              {formatDateTime(metric.delayDays === 0 ? value.lastSyncedAt : metric.asOf)}
            </time>
            .
          </p>
        </>
      ) : (
        <p className="mt-3 text-lg text-muted">{value.text}</p>
      )}
      <p className="mt-2 text-sm">
        <Link href={metric.formulaPath} className="text-muted underline underline-offset-4 hover:text-foreground">
          How it is counted<span className="sr-only"> for {metric.label}</span>
        </Link>
      </p>
    </li>
  );
}

function AchievementItem({
  achievement,
  projectId,
  origin,
  projectPage,
}: {
  achievement: PublishedAchievement;
  projectId: string;
  origin: string;
  projectPage: ShareProjectPage;
}) {
  // A daily total has a day and no time, so its machine-readable date is the day alone.
  const dateTime = achievement.earnedPrecision === "day" ? formatUtcDate(achievement.earnedAt) : achievement.earnedAt.toISOString();
  return (
    <li className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-5 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <ProviderMark provider={achievement.provider} size="md" />
        <div className="min-w-0">
          <h3 className="font-medium break-words">{achievement.publicTitle}</h3>
          <p className="mt-1 text-sm text-muted">
            {achievement.providerName} achievement. <time dateTime={dateTime}>{achievementEarnedText(achievement)}</time>.
          </p>
        </div>
      </div>
      <div className="shrink-0">
        <AchievementShareDialog
          projectId={projectId}
          achievementId={achievement.achievementId}
          publicTitle={achievement.publicTitle}
          providerName={achievement.providerName}
          siteOrigin={origin}
          projectPage={projectPage}
        />
      </div>
    </li>
  );
}
