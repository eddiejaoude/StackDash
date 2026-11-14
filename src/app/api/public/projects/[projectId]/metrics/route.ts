import { connection } from "next/server";
import { z } from "zod";

import { connectOrigin } from "@/lib/connections/oauth-state";
import { logError } from "@/lib/log/logger";
import { loadPublishedProjectMetrics, type PublishedMetric } from "@/lib/public-metrics/published";
import { checkPublicRateLimit, NO_STORE, PUBLIC_CACHE_CONTROL, rateLimitedHeaders } from "@/lib/public-metrics/requests";

/*
 * GET /api/public/projects/<projectId>/metrics (#148): the metrics a project has published, as
 * JSON, for anyone. Live publications only (public_published_metrics), each value computed from
 * stored snapshots and events. No account, repository, or provider account names, and no money.
 *
 * Caching and the per IP rate limit are shared with badges and cards (src/lib/public-metrics/
 * requests.ts): one minute in browsers and shared caches, so an unpublished metric stops showing
 * within a minute, and a 429 with Retry-After past the limit. Not prerendered: every response
 * reads the database at request time.
 *
 * CORS: same-origin only. No `Access-Control-Allow-Origin` is sent, so a script on another site
 * cannot `fetch` this; badges and cards (#149) are rendered by StackDash's own server, and anyone
 * else can still read the JSON server-side or with curl. Opening it to browsers elsewhere is a
 * separate decision, not a side effect of a new surface.
 *
 * `formulaUrl` is absolute (NEXT_PUBLIC_SITE_URL, else the request's origin, as the connect routes
 * build theirs), because readers off-site cannot resolve a path against an origin they do not know.
 */

// `guid`, not `uuid`: fixtures use hand-written ids that skip the RFC version bits.
const ProjectIdSchema = z.guid();

// One answer for a malformed id, an unknown project, and a project with nothing published, so the
// route never reveals which projects exist.
function notFound(): Response {
  return Response.json(
    { error: "not_found", message: "Nothing is published for this project." },
    { status: 404, headers: { "Cache-Control": PUBLIC_CACHE_CONTROL } },
  );
}

function serialize(metric: PublishedMetric, origin: string) {
  if (metric.kind === "self_reported") {
    return {
      kind: metric.kind,
      label: metric.label,
      provenance: metric.provenance,
      value: metric.value,
      unit: metric.unit,
      text: metric.text,
      publishedAt: metric.publishedAt.toISOString(),
    };
  }
  const { value } = metric;
  return {
    kind: metric.kind,
    id: metric.metricId,
    label: metric.label,
    provenance: metric.provenance,
    unit: metric.unit,
    formulaUrl: new URL(metric.formulaPath, origin).href,
    rounding: metric.rounding,
    delayDays: metric.delayDays,
    asOf: metric.asOf.toISOString(),
    publishedAt: metric.publishedAt.toISOString(),
    ...(value.status === "available"
      ? {
          status: value.status,
          value: value.value,
          atLeast: value.atLeast,
          text: value.text,
          lastSyncedAt: value.lastSyncedAt.toISOString(),
          simulated: value.simulated,
        }
      : { status: value.status, reason: value.reason, text: value.text }),
  };
}

export async function GET(request: Request, ctx: RouteContext<"/api/public/projects/[projectId]/metrics">) {
  // The answer depends on the clock and the database, so it is always rendered at request time.
  await connection();
  const { projectId } = await ctx.params;

  try {
    const now = new Date();
    const limit = await checkPublicRateLimit(request.headers, now);
    if (!limit.allowed) {
      return Response.json(
        { error: "rate_limited", message: "Too many requests from this address. Try again in a minute." },
        { status: 429, headers: rateLimitedHeaders(limit) },
      );
    }
    if (!ProjectIdSchema.safeParse(projectId).success) return notFound();
    const published = await loadPublishedProjectMetrics(projectId, now);
    if (published === null) return notFound();
    const origin = connectOrigin(request.url, process.env.NEXT_PUBLIC_SITE_URL);
    return Response.json(
      { projectId: published.projectId, metrics: published.metrics.map((metric) => serialize(metric, origin)) },
      { headers: { "Cache-Control": PUBLIC_CACHE_CONTROL } },
    );
  } catch (error) {
    const referenceId = logError("public_metrics.read_failed", error);
    return Response.json(
      { error: "unavailable", message: "Published metrics could not be read. Try again in a moment.", referenceId },
      { status: 503, headers: { "Cache-Control": NO_STORE } },
    );
  }
}
