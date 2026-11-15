import { createHmac, timingSafeEqual } from "node:crypto";
import type { Secret } from "@/lib/adapters/types";

/**
 * Signature, freshness, and delivery id primitives for provider webhooks (#28). Each adapter's
 * `webhooks.verify` composes these with its provider's header names and signing scheme, so the
 * constant-time compare, the replay window, and the delivery id rules are written once.
 */

/** Lowercase hex HMAC of `data` (raw body bytes, or a string signed as UTF-8). */
export function hmacHex(algorithm: "sha1" | "sha256", secret: Secret, data: Uint8Array | string): string {
  const hmac = createHmac(algorithm, secret.reveal());
  if (typeof data === "string") hmac.update(data, "utf8");
  else hmac.update(data);
  return hmac.digest("hex");
}

/**
 * Compares two signatures in constant time. `timingSafeEqual` throws on unequal lengths; the
 * length of a signature is not secret, so a mismatch returns false without comparing.
 */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * True when a delivery's timestamp (whole seconds since the epoch) is within `toleranceSeconds` of
 * `now`, either side: a clock running ahead is skew, not a reason to accept a replay from the future.
 */
export function isFresh(timestampSeconds: number, now: Date, toleranceSeconds: number): boolean {
  if (!Number.isFinite(timestampSeconds)) return false;
  return Math.abs(now.getTime() / 1000 - timestampSeconds) <= toleranceSeconds;
}

// Longer than any provider's delivery id (GitHub and Svix send UUID-sized ids). The id is a unique
// key in the database, so an unbounded header must not reach it.
export const DELIVERY_ID_MAX_LENGTH = 200;

/**
 * The provider's delivery id from header `name`, trimmed, or undefined when it is absent, blank, or
 * longer than DELIVERY_ID_MAX_LENGTH: such a delivery cannot be deduplicated, so it is malformed.
 */
export function readDeliveryId(headers: Headers, name: string): string | undefined {
  const deliveryId = headers.get(name)?.trim();
  if (deliveryId === undefined || deliveryId.length === 0 || deliveryId.length > DELIVERY_ID_MAX_LENGTH) return undefined;
  return deliveryId;
}
