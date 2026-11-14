import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { PageHeader } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { YearSlides, type YearSlideView } from "@/components/public-metrics/year-slides";
import { loadYearReview } from "@/lib/data/year-review";
import { CARD_SIZE, shareToXUrl } from "@/lib/public-metrics/share";
import {
  isYearComplete,
  latestCardYear,
  parseCardYear,
  yearLabel,
  yearPartialNote,
  yearPeriod,
  yearProvenance,
  yearSlideAltText,
  yearSlideDownloadName,
  yearSlideFile,
  yearSlides,
  yearSlideShareText,
  yearToDateNote,
} from "@/lib/public-metrics/yearly";
import { requireWorkspace } from "@/lib/workspaces/access";
import { workspacePath, yearInReviewPath } from "@/lib/workspaces/paths";

export const metadata: Metadata = { title: "Year in review" };

/*
 * The year in review (#151, slides #262): what the workspace did in a calendar year, for its
 * members only, as four slides (busiest day, longest run of successful deployments, most active
 * provider, totals), each downloadable as an image. A past year shows in full; the current year
 * shows at any time as the year to date, labeled "2026 so far" (decision on issue #151). Sharing is
 * the same dialog as the milestone cards (#149), with Download in place of a public URL, because a
 * slide has none: it is public only once a member posts it.
 */

// Every section renders inside its own Suspense boundary so navigating between sections
// has an instant shell; access checks and data reads stream in behind it.
export default function YearInReviewPage(props: PageProps<"/w/[workspace]/year/[year]">) {
  return (
    <Suspense fallback={<PageSkeleton label="Loading the year in review" />}>
      <YearInReviewContent {...props} />
    </Suspense>
  );
}

async function YearInReviewContent({ params }: PageProps<"/w/[workspace]/year/[year]">) {
  const { workspace: slug, year: yearParam } = await params;
  const { workspace } = await requireWorkspace(slug, "viewer");
  // Read after the request data above, so the clock never runs during prerendering.
  const now = new Date();
  const year = parseCardYear(yearParam, now);
  if (year === null) notFound();
  const complete = isYearComplete(year, now);

  return (
    <>
      <PageHeader
        title={`Your stack in ${yearLabel(year, now)}`}
        description={`What your connected providers did ${complete ? `in ${year}` : "this year up to today"}, counted from the data StackDash stored. Only members of this workspace can see it.`}
      />
      <nav aria-label="Years" className="mt-4 flex flex-wrap gap-4 text-sm">
        <Link href={yearInReviewPath(workspace.slug, year - 1)} className="text-muted underline underline-offset-4 hover:text-foreground">
          {year - 1}
        </Link>
        {year + 1 <= latestCardYear(now) ? (
          <Link href={yearInReviewPath(workspace.slug, year + 1)} className="text-muted underline underline-offset-4 hover:text-foreground">
            {year + 1}
          </Link>
        ) : null}
      </nav>
      <YearReviewSection workspaceId={workspace.id} slug={workspace.slug} year={year} now={now} />
    </>
  );
}

async function YearReviewSection({ workspaceId, slug, year, now }: { workspaceId: string; slug: string; year: number; now: Date }) {
  const review = await loadYearReview(workspaceId, year, now);
  const { summary } = review;
  const complete = isYearComplete(year, now);
  const partial = yearPartialNote(review);
  const slides: YearSlideView[] = yearSlides(review).map((slide) => ({
    slide,
    image: {
      src: `${yearInReviewPath(slug, year)}/${yearSlideFile(slide.id)}`,
      alt: yearSlideAltText(review, slide),
      downloadName: yearSlideDownloadName(summary, slide.id),
    },
    xIntentUrl: shareToXUrl(yearSlideShareText(review, slide)),
  }));
  return (
    <section aria-labelledby="year-review-title" className="mt-6 space-y-6 rounded-xl border border-line bg-panel px-6 py-5 text-sm">
      <div className="space-y-1">
        <h2 id="year-review-title" className="font-semibold">
          {complete ? yearPeriod(summary) : `Year to date: ${yearPeriod(summary)}`}
        </h2>
        {complete ? null : <p className="text-muted">{yearToDateNote(year)}</p>}
        {partial === null ? null : <p className="text-muted">{partial}</p>}
        {summary.providers > 0 ? null : (
          <p className="text-muted">
            No provider was connected in {yearLabel(year, now)}.{" "}
            {complete ? null : (
              <>
                <Link href={workspacePath(slug, "connections")} className="text-foreground underline underline-offset-4">
                  Connect a provider
                </Link>{" "}
                to start counting.
              </>
            )}
          </p>
        )}
      </div>
      <YearSlides slides={slides} yearName={complete ? String(year) : `${year} year to date`} {...CARD_SIZE} />
      <p className="text-muted">{yearProvenance(summary)}. No spend, no account names, no repository names, and payments are not counted.</p>
    </section>
  );
}
