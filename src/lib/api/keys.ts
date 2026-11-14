import "server-only";

import { createHash, randomBytes } from "node:crypto";

/*
 * API key format and hashing (#162), following BackTalk's token storage: a key is "sd_" plus 32
 * random bytes in base64url, shown to its creator once and never stored. The database keeps the
 * SHA-256 hex digest (the lookup key) and a display prefix. A plain digest is enough here because
 * the secret is 256 random bits: there is nothing to guess, so a slow password hash would only add
 * latency to every request.
 */

export const API_KEY_PREFIX = "sd_";

const SECRET_BYTES = 32;
// "sd_" plus the first 8 characters of the secret: tells keys apart in a list, cannot authenticate.
const DISPLAY_PREFIX_LENGTH = API_KEY_PREFIX.length + 8;
// 32 bytes are 43 base64url characters without padding.
const API_KEY_PATTERN = /^sd_[A-Za-z0-9_-]{43}$/;

export type GeneratedApiKey = Readonly<{
  /** The plaintext key. Show it once, then let it go: it is never logged or stored. */
  key: string;
  tokenHash: string;
  tokenPrefix: string;
}>;

/** The SHA-256 hex digest of a key, the only form the database stores or compares. */
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function generateApiKey(): GeneratedApiKey {
  const key = `${API_KEY_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
  return { key, tokenHash: hashApiKey(key), tokenPrefix: key.slice(0, DISPLAY_PREFIX_LENGTH) };
}

/**
 * The key from an `Authorization: Bearer sd_...` header, or null when the header is missing or
 * holds anything else. A wrong shape is refused here, before any database lookup.
 */
export function bearerApiKey(authorization: string | null): string | null {
  if (authorization === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  const key = match?.[1];
  return key !== undefined && API_KEY_PATTERN.test(key) ? key : null;
}
