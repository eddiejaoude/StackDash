import "server-only";

import { z } from "zod";

import { signMessage, verifyMessage } from "@/lib/crypto/credentials";

/*
 * One-click unsubscribe tokens (#152): `<workspace id>.<user id>.<key id>.<signature>`, an
 * HMAC-SHA256 under a key derived from STACKDASH_ENCRYPTION_KEY (signMessage). The token is the
 * whole authorization, because RFC 8058 forbids cookies on the one-click POST; all it can do is
 * turn alert email off for one member in one workspace, which is safe to repeat. It does not
 * expire, so an old email's link keeps working, and it survives key rotation while the old key is
 * listed in STACKDASH_ENCRYPTION_KEYS_PREVIOUS.
 */

const PURPOSE = "unsubscribe";
const MAX_TOKEN_LENGTH = 200;

const idSchema = z.guid();

export type UnsubscribeTarget = Readonly<{ workspaceId: string; userId: string }>;

export function unsubscribeToken(workspaceId: string, userId: string): string {
  const message = `${workspaceId}.${userId}`;
  return `${message}.${signMessage(PURPOSE, message)}`;
}

/** The member and workspace a token names, or null for anything malformed, forged, or under an unknown key. */
export function readUnsubscribeToken(token: string | null | undefined): UnsubscribeTarget | null {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [workspaceId, userId, keyId, signature] = parts;
  if (!idSchema.safeParse(workspaceId).success || !idSchema.safeParse(userId).success) return null;
  if (workspaceId === undefined || userId === undefined || keyId === undefined || signature === undefined) return null;
  if (!verifyMessage(PURPOSE, `${workspaceId}.${userId}`, `${keyId}.${signature}`)) return null;
  return { workspaceId, userId };
}
