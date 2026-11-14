import { connection } from "next/server";
import { z } from "zod";

import { loadPublicPageOfProject } from "@/lib/data/project-pages";
import { logError } from "@/lib/log/logger";
import { AchievementCard, cardImageResponse, MetricCard, NoticeCard } from "@/lib/public-metrics/card-image";
import { loadPublishedAchievement, loadPublishedMetricCard } from "@/lib/public-metrics/published";
import {
  checkPublicRateLimit,
  countViewAfterResponse,
  NO_STORE,
  PUBLIC_CACHE_CONTROL,
  rateLimitedHeaders,
} from "@/lib/public-metrics/requests";
import { achievementIdFromFile, CARD_TREND_DAYS, metricIdFromFile } from "@/lib/public-metrics/share";

/*
 * GET /card/<project id>/<metric id>.png (#149): the 1200 by 630 milestone card of a published
 * metric, for a post on X, LinkedIn, or Reddit and as the preview image of the public project
 * page (#150). The same rules as the badge route beside it: the value comes from the public engine,
 * an unknown or unpublished metric gets a neutral "Unpublished" card (the badge's word) with a 200
 * (so a preview never breaks and never tells which projects exist), the same one minute cache and
 * per IP rate limit, and no session or cookie. While the project's page is public (#150), the card
 * names the project, which that page already shows to anyone (#255); otherwise it names nothing.
 *
 * GET /card/<project id>/achievement-<achievement id>.png (#413): the card of a published
 * achievement, by the same rules, read through loadPublishedAchievement.
 *
 * A Route Handler rather than the opengraph-image file convention: the convention attaches an
 * image to a page segment, and this card has no page of its own. Rendered at request time
 * (`connection()`), because the value depends on the clock and the database.
 */

const ProjectIdSchema = z.guid();

const IMAGE_HEADERS = { "Cross-Origin-Resource-Policy": "cross-origin" };

export async function GET(request: Request, ctx: RouteContext<"/card/[projectId]/[file]">) {
  await connection();
  const { projectId, file } = await ctx.params;

  try {
    const now = new Date();
    const limit = await checkPublicRateLimit(request.headers, now);
    if (!limit.allowed) {
      return cardImageResponse(<NoticeCard title="Try again in a minute" body="Too many requests from this address." />, {
        status: 429,
        headers: { ...IMAGE_HEADERS, ...rateLimitedHeaders(limit) },
      });
    }

    const validProject = ProjectIdSchema.safeParse(projectId).success;
    const headers = { ...IMAGE_HEADERS, "Cache-Control": PUBLIC_CACHE_CONTROL };

    // Achievement cards are not counted: view counts are kept per published metric.
    const achievementId = achievementIdFromFile(file, "png");
    if (achievementId !== null) {
      const achievement = validProject ? await loadPublishedAchievement(projectId, achievementId) : null;
      if (achievement === null) {
        return cardImageResponse(<NoticeCard title="Unpublished" body="This achievement is not public on StackDash." />, { headers });
      }
      const page = await loadPublicPageOfProject(projectId);
      return cardImageResponse(<AchievementCard achievement={achievement} projectName={page?.projectName ?? null} />, { headers });
    }

    const metricId = metricIdFromFile(file, "png");
    const card = metricId === null || !validProject ? null : await loadPublishedMetricCard(projectId, metricId, now, CARD_TREND_DAYS);
    if (card === null) {
      return cardImageResponse(<NoticeCard title="Unpublished" body="This metric is not public on StackDash." />, { headers });
    }
    // Read after the card, not beside it: an unknown or unpublished metric costs no page read, and a
    // failing page read can never turn the cached Unpublished card into a 503.
    const page = await loadPublicPageOfProject(projectId);
    countViewAfterResponse(projectId, card.metric.metricId, "card");
    return cardImageResponse(<MetricCard card={card} projectName={page?.projectName ?? null} />, { headers });
  } catch (error) {
    logError("public_metrics.card_failed", error);
    return cardImageResponse(<NoticeCard title="Temporarily unavailable" body="Try again in a moment." />, {
      status: 503,
      headers: { ...IMAGE_HEADERS, "Cache-Control": NO_STORE },
    });
  }
}
