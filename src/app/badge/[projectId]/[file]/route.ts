import { connection } from "next/server";
import { z } from "zod";

import { logError } from "@/lib/log/logger";
import {
  achievementBadgeContent,
  badgeContent,
  RATE_LIMITED_BADGE,
  renderBadgeSvg,
  UNAVAILABLE_BADGE,
  type BadgeContent,
} from "@/lib/public-metrics/badge";
import { loadPublishedAchievement, loadPublishedMetric } from "@/lib/public-metrics/published";
import {
  checkPublicRateLimit,
  countViewAfterResponse,
  NO_STORE,
  PUBLIC_CACHE_CONTROL,
  rateLimitedHeaders,
} from "@/lib/public-metrics/requests";
import { achievementIdFromFile, metricIdFromFile } from "@/lib/public-metrics/share";

/*
 * GET /badge/<project id>/<metric id>.svg (#149): the live badge of a published metric, for a
 * README or any page. Reads the value through the public engine (loadPublishedMetric), so it shows
 * exactly what the JSON route of #148 shows, and never spend, budgets, alerts, or names.
 *
 * GET /badge/<project id>/achievement-<achievement id>.svg (#413): the badge of a published
 * achievement, the provider's name and the achievement's public title, read through
 * loadPublishedAchievement. Never the private title, an account, a repository, or an amount.
 *
 * A project that does not exist, a metric or achievement that is not published or was
 * unpublished, and a malformed id all get the same neutral "Unpublished" badge with a 200, rather
 * than a 404 that would tell a stranger which projects exist; an embed then shows "Unpublished"
 * instead of a broken image. The one minute cache (requests.ts) bounds how long an unpublished
 * value can still show.
 *
 * Safe to embed anywhere: outside the proxy matcher, so no session is read and no cookie is set;
 * an SVG with text only (badge.ts); Cross-Origin-Resource-Policy so other sites may load it as an
 * image; and, so that opened directly it can load and run nothing, the policy
 * "default-src 'none'; frame-ancestors 'none'; sandbox". That policy is set in next.config.ts, not
 * here: Next applies the config's headers first and drops a handler header of the same name, so a
 * Content-Security-Policy set in this file would never be sent (e2e/share-cards.spec.ts checks it).
 */

const ProjectIdSchema = z.guid();

const SVG_HEADERS = {
  "Content-Type": "image/svg+xml; charset=utf-8",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function svgResponse(content: BadgeContent, status: number, headers: Record<string, string>): Response {
  return new Response(renderBadgeSvg(content), { status, headers: { ...SVG_HEADERS, ...headers } });
}

export async function GET(request: Request, ctx: RouteContext<"/badge/[projectId]/[file]">) {
  // The answer depends on the clock and the database, so it is always rendered at request time.
  await connection();
  const { projectId, file } = await ctx.params;

  try {
    const now = new Date();
    const limit = await checkPublicRateLimit(request.headers, now);
    if (!limit.allowed) return svgResponse(RATE_LIMITED_BADGE, 429, rateLimitedHeaders(limit));

    const validProject = ProjectIdSchema.safeParse(projectId).success;
    const cached = { "Cache-Control": PUBLIC_CACHE_CONTROL };

    // Achievement badges are not counted: view counts are kept per published metric.
    const achievementId = achievementIdFromFile(file, "svg");
    if (achievementId !== null) {
      const achievement = validProject ? await loadPublishedAchievement(projectId, achievementId) : null;
      return svgResponse(achievementBadgeContent(achievement), 200, cached);
    }

    const metricId = metricIdFromFile(file, "svg");
    const metric = metricId === null || !validProject ? null : await loadPublishedMetric(projectId, metricId, now);
    if (metric !== null) countViewAfterResponse(projectId, metric.metricId, "badge");
    return svgResponse(badgeContent(metric), 200, cached);
  } catch (error) {
    logError("public_metrics.badge_failed", error);
    return svgResponse(UNAVAILABLE_BADGE, 503, { "Cache-Control": NO_STORE });
  }
}
