import { createHmac } from "node:crypto";

import type { Secret, WebhookRequest, WebhookVerification } from "@/lib/adapters/types";

import { isFresh, readDeliveryId, safeEqual } from "./signature";

/*
 * Standard Webhooks verification (#429), the scheme Svix sends and Polar signs with
 * (https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md):
 * an HMAC-SHA256 over `<id>.<timestamp>.<raw body>`, sent base64 as `v1,<signature>` entries,
 * space-separated, in the signature header. The id is signed, so a captured delivery replayed under
 * a new id fails the signature, and one replayed under its own id is a duplicate. Each adapter
 * passes its provider's header names and the HMAC keys its secret can stand for.
 */

export type StandardWebhookHeaders = Readonly<{ delivery: string; timestamp: string; signature: string }>;

// The spec's own names, which Polar sends (Polar, "Handle & monitor webhook deliveries").
export const STANDARD_WEBHOOK_HEADERS = {
  delivery: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
} as const satisfies StandardWebhookHeaders;

// Five minutes either side of now: the tolerance of the Standard Webhooks and Svix libraries. Each
// retry is signed with its own timestamp, so a retry hours later is never stale.
export const STANDARD_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

const SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1,";
// The spec's secrets are 24 to 64 random bytes. A secret that decodes to fewer than 16 is not one a
// provider made, and a key that short could be guessed, so it verifies nothing.
const MIN_KEY_BYTES = 16;
// Whole seconds since the epoch; twelve digits reach far past any real clock.
const TIMESTAMP_SECONDS = /^\d{1,12}$/;

/** The HMAC key a Standard Webhooks secret encodes (base64 after `whsec_`), or null when it is too short. */
export function standardWebhookKey(secret: Secret): Buffer | null {
  const value = secret.reveal().trim();
  const key = Buffer.from(value.startsWith(SECRET_PREFIX) ? value.slice(SECRET_PREFIX.length) : value, "base64");
  return key.length >= MIN_KEY_BYTES ? key : null;
}

/** The `v1,<base64 HMAC-SHA256>` entry for one delivery under `key`. */
export function standardWebhookSignature(key: Buffer, deliveryId: string, timestamp: string, rawBody: Uint8Array): string {
  // Signed as bytes, never decoded first: decoding would map invalid UTF-8 onto U+FFFD and let two
  // different bodies share one signature.
  const signed = Buffer.concat([Buffer.from(`${deliveryId}.${timestamp}.`, "utf8"), rawBody]);
  return `${SIGNATURE_VERSION}${createHmac("sha256", key).update(signed).digest("base64")}`;
}

/**
 * Headers, then freshness, then the delivery id (the signature covers it, so a missing one is
 * malformed), then the signature in constant time against every entry under every key. A provider
 * sends several entries while a secret rotates; one match is enough. Every entry is compared, so
 * the time taken does not say which one matched. A key shorter than 16 bytes is skipped, and no
 * usable key verifies nothing.
 */
export function verifyStandardWebhook(
  { headers, rawBody }: WebhookRequest,
  keys: readonly Buffer[],
  names: StandardWebhookHeaders,
  now: Date,
): WebhookVerification {
  const timestamp = headers.get(names.timestamp)?.trim();
  const signatures = headers.get(names.signature)?.trim();
  if (!timestamp || !signatures) return { ok: false, reason: "missing_signature" };
  if (!TIMESTAMP_SECONDS.test(timestamp)) return { ok: false, reason: "malformed" };
  if (!isFresh(Number(timestamp), now, STANDARD_WEBHOOK_TOLERANCE_SECONDS)) return { ok: false, reason: "stale" };
  const deliveryId = readDeliveryId(headers, names.delivery);
  if (deliveryId === undefined) return { ok: false, reason: "malformed" };
  const candidates = signatures.split(/\s+/);
  let matched = false;
  for (const key of keys) {
    if (key.length < MIN_KEY_BYTES) continue;
    const expected = standardWebhookSignature(key, deliveryId, timestamp, rawBody);
    for (const candidate of candidates) matched = safeEqual(candidate, expected) || matched;
  }
  return matched ? { ok: true, deliveryId } : { ok: false, reason: "bad_signature" };
}
