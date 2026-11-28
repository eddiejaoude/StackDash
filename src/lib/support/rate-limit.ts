import "server-only";

import { createHmac } from "node:crypto";

import { derivedKey } from "@/lib/crypto/credentials";
import { clientIpEnv } from "@/lib/env";
import { logError } from "@/lib/log/logger";
import { clientIp } from "@/lib/public-metrics/requests";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  CLAIM_LIMIT_PER_IP,
  CLAIM_LIMIT_PER_USER,
  SEND_LIMIT_PER_IP,
  SEND_LIMIT_PER_USER,
  SEND_WINDOW_SECONDS,
} from "./limits";

/*
 * Support chat's rate limit (#680), keyed by user and by client IP: every message sent, and every
 * attachment claimed, counts against both. bump_support_rate_limit counts an attempt in the current
 * window of the database clock and returns both keys' counts for that window and the one before; an
 * attempt passes while each key's two windows together stay within its limit (a sliding window
 * approximation, BackTalk 0086), so a burst across a window boundary cannot get twice the limit
 * through. Refused attempts count too, so hammering the button does not help.
 *
 * Keys are HMAC-SHA-256 of the scope and the user id or the client IP, under a key derived from the
 * encryption key, so the table holds no IP address and no user id (support_rate_limit_counters).
 * The IP is read the way the public routes read it (clientIp, #149).
 */

export type RateLimitScope = "send" | "claim";

const LIMITS: Readonly<Record<RateLimitScope, Readonly<{ perUser: number; perIp: number }>>> = {
  send: { perUser: SEND_LIMIT_PER_USER, perIp: SEND_LIMIT_PER_IP },
  claim: { perUser: CLAIM_LIMIT_PER_USER, perIp: CLAIM_LIMIT_PER_IP },
};

/** The bucket for requests whose client IP the platform did not report. */
const UNKNOWN_CLIENT = "unknown";

export type WindowCounts = Readonly<{ current: number; previous: number }>;

export type RateLimitDecision = Readonly<{ allowed: true }> | Readonly<{ allowed: false; retryAt: Date }>;

/**
 * One key's decision, from its attempts in the current window and the one before, this attempt
 * included. Refused, the attempt may be made again once a later window leaves room for it: at the
 * next window, this window's attempts become the "previous" ones, so one more fits only while they
 * are under the limit; otherwise at the window after that, when nothing older counts.
 */
export function windowDecision(counts: WindowCounts, limit: number, windowStart: Date, windowSeconds: number): RateLimitDecision {
  if (counts.current + counts.previous <= limit) return { allowed: true };
  const widthMs = windowSeconds * 1000;
  const nextWindow = windowStart.getTime() + widthMs;
  return { allowed: false, retryAt: new Date(counts.current < limit ? nextWindow : nextWindow + widthMs) };
}

/** Refused when either key is; then the later of the two times, when both would allow it. */
export function combineDecisions(...decisions: readonly RateLimitDecision[]): RateLimitDecision {
  let retryAt: Date | null = null;
  for (const decision of decisions) {
    if (!decision.allowed && (retryAt === null || decision.retryAt > retryAt)) retryAt = decision.retryAt;
  }
  return retryAt === null ? { allowed: true } : { allowed: false, retryAt };
}

/** Lowercase hex HMAC-SHA-256, the only form support_rate_limit_counters accepts. */
export function rateLimitKey(secret: Buffer, scope: RateLimitScope, kind: "user" | "ip", value: string): string {
  return createHmac("sha256", secret).update(`${scope}:${kind}:${value.toLowerCase()}`).digest("hex");
}

/**
 * Counts this attempt for the user and the request's client IP, and decides. Fails open, and logs:
 * a limiter that cannot count must not be the reason nobody can reach support.
 */
export async function checkSupportRateLimit(scope: RateLimitScope, userId: string, headers: Headers): Promise<RateLimitDecision> {
  try {
    const secret = derivedKey("support-rate-limit");
    const ip = clientIp(headers, clientIpEnv()) ?? UNKNOWN_CLIENT;
    const { data, error } = await createAdminClient()
      .rpc("bump_support_rate_limit", {
        p_user_key: rateLimitKey(secret, scope, "user", userId),
        p_ip_key: rateLimitKey(secret, scope, "ip", ip),
        p_window_seconds: SEND_WINDOW_SECONDS,
      })
      .single();
    if (error) throw new Error("Counting a support attempt failed", { cause: error });
    const windowStart = new Date(data.window_start);
    const limits = LIMITS[scope];
    return combineDecisions(
      windowDecision({ current: data.user_current, previous: data.user_previous }, limits.perUser, windowStart, SEND_WINDOW_SECONDS),
      windowDecision({ current: data.ip_current, previous: data.ip_previous }, limits.perIp, windowStart, SEND_WINDOW_SECONDS),
    );
  } catch (error) {
    logError("support.rate_limit_failed", error, { scope });
    return { allowed: true };
  }
}
