import "server-only";

import { createHmac } from "node:crypto";

import { after } from "next/server";

import { derivedKey } from "@/lib/crypto/credentials";
import { clientIpEnv, type ClientIpEnv } from "@/lib/env";
import { logError } from "@/lib/log/logger";
import { site } from "@/lib/site";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

import type { PublicMetricId } from "./definitions";

/*
 * What every public read shares (#149): the badge, the card, the JSON route of #148, and the public
 * project page (#150, limited by src/proxy.ts since #321).
 *
 * Caching: one minute in browsers and shared caches for the badge, card, and JSON route, so a value
 * that is unpublished stops showing within a minute (#149's acceptance bound), while an embed read
 * by many people is computed about once a minute per cache. The project page is not cached: its
 * HTML carries the per request CSP nonce, which a shared cache would hand to every reader, and
 * turning a page off answers 404 from the next request (#150). The rate limit bounds it instead.
 *
 * Rate limit: PUBLIC_REQUESTS_PER_MINUTE requests per client IP per minute across all four,
 * counted in Postgres (public_rate_limit_counters) so every server instance shares one count.
 * Requests a cache answers never reach the server, so they are not counted. The IP is hashed with
 * HMAC-SHA-256 under a key derived from the encryption key before it leaves the server, and the
 * table refuses anything but a hash, so no IP address is stored. Decision on issue #149. The same
 * table also holds the per-endpoint webhook delivery counts (#28, src/lib/webhooks/receive.ts),
 * keyed by an HMAC of the endpoint id under a key derived for that alone, so the two never share
 * a row, and the one day retention covers both.
 */

export const PUBLIC_CACHE_CONTROL = "public, max-age=60, s-maxage=60";
export const NO_STORE = "no-store";

/**
 * Generous for one person or a README image proxy (GitHub's camo fetches a badge once per cache
 * expiry, not once per reader); far below what it takes to load the database.
 */
export const PUBLIC_REQUESTS_PER_MINUTE = 120;

/** The bucket for requests whose client IP the platform did not report. */
const UNKNOWN_CLIENT = "unknown";

/**
 * The client IP, read from the header `source` names (clientIpEnv in env.ts), counting
 * `trustedProxies` entries from the right. Each proxy appends the address it received the request
 * from, so the entry the outermost trusted proxy appended is the client, and anything to its left
 * is whatever the client sent and is ignored: a client cannot pick its own bucket. On Vercel the
 * header is `x-vercel-forwarded-for`, which holds exactly the client
 * (https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for). Fewer entries than
 * trusted proxies means one did not append, so the leftmost entry, which a trusted proxy wrote, is
 * used. Null when the header is missing or empty.
 */
export function clientIp(headers: Headers, source: ClientIpEnv): string | null {
  const entries = (headers.get(source.header) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
  return entries[Math.max(0, entries.length - source.trustedProxies)] ?? null;
}

/** Lowercase hex HMAC-SHA-256 of the IP, the only form public_rate_limit_counters accepts. */
export function hashClientIp(ip: string, key: Buffer): string {
  return createHmac("sha256", key).update(ip.toLowerCase()).digest("hex");
}

export type RateLimitDecision = Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAfterSeconds: number }>;

/** Whole seconds until the next minute starts, 1 to 60: when a refused client may try again. */
export function secondsUntilNextMinute(now: Date): number {
  return 60 - Math.floor((now.getTime() % 60_000) / 1000);
}

/** Allowed up to and including the limit; the request after it waits for the next minute. */
export function rateLimitDecision(countThisMinute: number, now: Date): RateLimitDecision {
  if (countThisMinute <= PUBLIC_REQUESTS_PER_MINUTE) return { allowed: true };
  return { allowed: false, retryAfterSeconds: secondsUntilNextMinute(now) };
}

/** Counts this request against its client IP and decides whether to serve it. */
export async function checkPublicRateLimit(headers: Headers, now: Date): Promise<RateLimitDecision> {
  const ipHash = hashClientIp(clientIp(headers, clientIpEnv()) ?? UNKNOWN_CLIENT, derivedKey("public-rate-limit"));
  const { data, error } = await createAdminClient().rpc("bump_public_rate_limit", { p_ip_hash: ipHash });
  if (error) throw new Error("Failed to count a public request", { cause: error });
  return rateLimitDecision(data, now);
}

/** The headers of a refused request: never cached, and when to come back. */
export function rateLimitedHeaders(decision: Readonly<{ retryAfterSeconds: number }>): Record<string, string> {
  return { "Cache-Control": NO_STORE, "Retry-After": String(decision.retryAfterSeconds) };
}

/**
 * The document a refused public project page answers with, beside a 429 and rateLimitedHeaders
 * (#321). It says what the badge and card notices say ("Too many requests from this address. Try
 * again in a minute."), names the wait, and links home. src/proxy.ts sends it before the page
 * renders, so it is plain HTML: no script and no style element, only style attributes, which the
 * page policy allows (style-src-attr in src/proxy.ts). The colors are the site's (--background,
 * --foreground, and --muted in src/app/globals.css), whose stylesheet this document cannot load.
 * Nothing in it comes from the request.
 */
export function rateLimitedPageHtml(decision: Readonly<{ retryAfterSeconds: number }>): string {
  const seconds = decision.retryAfterSeconds;
  const wait = `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="robots" content="noindex">',
    `<title>Too many requests · ${site.name}</title>`,
    "</head>",
    '<body style="margin:0;background:#0a0a0a;color:#ededed;font-family:system-ui,sans-serif;line-height:1.5">',
    '<main id="main" style="max-width:36rem;margin:0 auto;padding:4rem 1.5rem">',
    '<h1 style="font-size:1.5rem;margin:0">Too many requests from this address</h1>',
    `<p style="color:#a1a1aa">Public project pages, badges, and cards answer up to ${PUBLIC_REQUESTS_PER_MINUTE} requests a minute from one network address. Try again in ${wait}, when the next minute starts.</p>`,
    '<p><a href="/" style="color:#ededed">Go to the home page</a></p>',
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

export type ShareSurface = Database["public"]["Enums"]["share_surface"];

/**
 * Counts one serve of a published metric's badge or card for its owner's "served this week"
 * figure. The database counts only while the metric is published in that project.
 */
export async function recordPublishedMetricView(projectId: string, metricId: PublicMetricId, surface: ShareSurface): Promise<void> {
  const { error } = await createAdminClient().rpc("record_published_metric_view", {
    p_project_id: projectId,
    p_metric_id: metricId,
    p_surface: surface,
  });
  if (error) throw new Error("Failed to count a published metric view", { cause: error });
}

/**
 * Counts the serve after the response has gone (`after` in next/server), so the badge or card
 * never waits for the write. A failed count is logged and loses that one view; it never turns a
 * served image into an error.
 */
export function countViewAfterResponse(projectId: string, metricId: PublicMetricId, surface: ShareSurface): void {
  after(async () => {
    try {
      await recordPublishedMetricView(projectId, metricId, surface);
    } catch (error) {
      logError("public_metrics.view_count_failed", error, { surface });
    }
  });
}