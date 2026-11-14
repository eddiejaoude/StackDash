import "server-only";

import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import { Secret, type OAuthCredential } from "@/lib/adapters/types";
import { encryptionEnv } from "@/lib/env";

/*
 * Application-level encryption for provider credentials (issue #35).
 *
 * AES-256-GCM with a fresh 12-byte IV per encryption and a 16-byte tag. The key lives only in the
 * environment, so a database dump alone reveals no credential. Each record stores the id of the
 * key that sealed it, which lets `STACKDASH_ENCRYPTION_KEYS_PREVIOUS` keep old rows readable while
 * `npm run keys:rotate` re-encrypts them under the current key.
 *
 * Associated data binds a ciphertext to its row (`workspaceId:connectionId`), so copying an
 * encrypted credential into another workspace's or connection's row makes decryption fail.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_HEX_CHARS = 8;

// Strict canonical base64; Buffer.from(..., "base64") silently skips invalid characters, which
// would let a mistyped key decode to different bytes instead of failing.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export type EncryptedSecret = Readonly<{
  keyId: string;
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}>;

/** The configured keys are missing or malformed. Messages name the variable, never its value. */
export class EncryptionKeyConfigError extends Error {
  override readonly name = "EncryptionKeyConfigError";
}

/** A record was sealed with a key that is not configured (neither current nor previous). */
export class UnknownEncryptionKeyError extends Error {
  override readonly name = "UnknownEncryptionKeyError";
  readonly keyId: string;

  constructor(keyId: string) {
    super(
      `No encryption key with id "${keyId}" is configured. Add it to STACKDASH_ENCRYPTION_KEYS_PREVIOUS, or reconnect the affected connection.`,
    );
    this.keyId = keyId;
  }
}

/** Authentication failed: the record was tampered with, truncated, or moved to another row. */
export class DecryptionFailedError extends Error {
  override readonly name = "DecryptionFailedError";
  readonly keyId: string;

  constructor(keyId: string) {
    super(`Encrypted record with key id "${keyId}" failed authentication and cannot be decrypted.`);
    this.keyId = keyId;
  }
}

type Keyring = Readonly<{
  currentKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
}>;

export function keyIdFor(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, KEY_ID_HEX_CHARS);
}

function decodeKey(encoded: string, source: string): Buffer {
  const trimmed = encoded.trim();
  if (!BASE64.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new EncryptionKeyConfigError(
      `${source} is not valid base64. Generate a key with: openssl rand -base64 32`,
    );
  }
  const key = Buffer.from(trimmed, "base64");
  if (key.length !== KEY_BYTES) {
    throw new EncryptionKeyConfigError(
      `${source} must decode to exactly ${KEY_BYTES} bytes, got ${key.length}. Generate a key with: openssl rand -base64 32`,
    );
  }
  return key;
}

// Read on every call rather than cached: hashing two or three 32-byte keys is negligible next to a
// network round trip, and it keeps rotation (and `vi.stubEnv` in tests) free of stale state.
function loadKeyring(): Keyring {
  const env = encryptionEnv();
  const current = decodeKey(env.STACKDASH_ENCRYPTION_KEY, "STACKDASH_ENCRYPTION_KEY");
  const currentKeyId = keyIdFor(current);
  const keys = new Map<string, Buffer>([[currentKeyId, current]]);

  const previous = env.STACKDASH_ENCRYPTION_KEYS_PREVIOUS ?? "";
  for (const [index, rawEntry] of previous.split(",").entries()) {
    const entry = rawEntry.trim();
    if (entry === "") continue;
    const source = `STACKDASH_ENCRYPTION_KEYS_PREVIOUS entry ${index + 1}`;
    // Base64 never contains ":", so the first colon always separates the id from the key.
    const separator = entry.indexOf(":");
    if (separator <= 0) {
      throw new EncryptionKeyConfigError(`${source} must have the form keyId:base64Key.`);
    }
    const declaredId = entry.slice(0, separator);
    const key = decodeKey(entry.slice(separator + 1), source);
    const actualId = keyIdFor(key);
    // A mismatch means the pair was copied wrongly; failing loudly beats rows that never decrypt.
    if (declaredId !== actualId) {
      throw new EncryptionKeyConfigError(
        `${source} declares key id "${declaredId}" but the key's id is "${actualId}".`,
      );
    }
    if (!keys.has(actualId)) keys.set(actualId, key);
  }

  return { currentKeyId, keys };
}

/** Id of the key new records are sealed with. */
export function currentKeyId(): string {
  return loadKeyring().currentKeyId;
}

/** True when a record sealed with `keyId` should be re-encrypted under the current key. */
export function needsRotation(keyId: string): boolean {
  return keyId !== loadKeyring().currentKeyId;
}

// HKDF info prefixes (RFC 5869, `crypto.hkdfSync`): one namespace per kind of derived key, each
// versioned, so a key derived for one purpose never equals an encryption key or a key derived for
// another purpose, and changing what a key is used for is a version bump, not a key rotation. The
// two prefixes differ in the first word after the shared `stackdash `, so no purpose string makes
// them collide. The signing prefix is fixed: changing it would invalidate every signature already
// sent.
const SIGNING_INFO_PREFIX = "stackdash signing v1:";
const DERIVED_INFO_PREFIX = "stackdash key v1:";

/** The one HKDF derivation in this file: a 32 byte key from `key` for the purpose `info` names. */
function hkdfKey(key: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), info, KEY_BYTES));
}

/**
 * A key for one purpose other than sealing credentials or signing messages, derived from the
 * current key, so the deployment needs no second secret and the derived key reveals nothing about
 * the encryption key. Rotating the encryption key changes it, so only use it where that is
 * harmless, such as hashing client IPs for a one minute rate limit window (#149).
 */
export function derivedKey(purpose: string): Buffer {
  const { currentKeyId: keyId, keys } = loadKeyring();
  const key = keys.get(keyId);
  if (key === undefined) throw new UnknownEncryptionKeyError(keyId);
  return hkdfKey(key, `${DERIVED_INFO_PREFIX}${purpose}`);
}

function signingKey(key: Buffer, purpose: string): Buffer {
  return hkdfKey(key, `${SIGNING_INFO_PREFIX}${purpose}`);
}

/**
 * Signs `message` for `purpose` (such as "unsubscribe") with HMAC-SHA256 under a key derived from
 * the current encryption key. Returns `<keyId>.<base64url signature>`, so a signature made before a
 * rotation still verifies while the old key is in STACKDASH_ENCRYPTION_KEYS_PREVIOUS.
 */
export function signMessage(purpose: string, message: string): string {
  const { currentKeyId: keyId, keys } = loadKeyring();
  const key = keys.get(keyId);
  if (key === undefined) throw new UnknownEncryptionKeyError(keyId);
  const signature = createHmac("sha256", signingKey(key, purpose)).update(message, "utf8").digest("base64url");
  return `${keyId}.${signature}`;
}

/** True when `signed` is a `signMessage` result for `purpose` and `message` under a configured key. */
export function verifyMessage(purpose: string, message: string, signed: string): boolean {
  const separator = signed.indexOf(".");
  if (separator <= 0) return false;
  const key = loadKeyring().keys.get(signed.slice(0, separator));
  if (key === undefined) return false;
  // Compared as text, not decoded bytes: base64url decoding ignores the spare bits of the last
  // character, so several spellings decode alike, and only the canonical one is accepted.
  const given = Buffer.from(signed.slice(separator + 1), "utf8");
  const expected = Buffer.from(createHmac("sha256", signingKey(key, purpose)).update(message, "utf8").digest("base64url"), "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Associated data for a stored connection credential; binds the ciphertext to its row. */
export function credentialAad(workspaceId: string, connectionId: string): string {
  return `${workspaceId}:${connectionId}`;
}

export function encryptSecret(plaintext: string, aad: string): EncryptedSecret {
  const { currentKeyId: keyId, keys } = loadKeyring();
  const key = keys.get(keyId);
  if (key === undefined) throw new UnknownEncryptionKeyError(keyId);

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { keyId, iv, ciphertext, authTag: cipher.getAuthTag() };
}

export function decryptSecret(record: EncryptedSecret, aad: string): string {
  const key = loadKeyring().keys.get(record.keyId);
  if (key === undefined) throw new UnknownEncryptionKeyError(record.keyId);
  // Node accepts shorter tags unless told otherwise; a truncated tag must never authenticate.
  if (record.iv.length !== IV_BYTES || record.authTag.length !== TAG_BYTES) {
    throw new DecryptionFailedError(record.keyId);
  }

  const decipher = createDecipheriv(ALGORITHM, key, record.iv, { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(record.authTag);
  try {
    return Buffer.concat([decipher.update(record.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // The underlying error carries no secret, but its wording varies by Node version; a typed
    // error gives callers one thing to handle.
    throw new DecryptionFailedError(record.keyId);
  }
}

// Versioned so a future change to the stored shape can be migrated rather than misread.
const serializedCredentialSchema = z
  .object({
    v: z.literal(1),
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
    expiresAt: z.iso.datetime({ offset: true }).optional(),
    scopes: z.array(z.string()),
    tokenType: z.string(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();

type SerializedCredential = z.infer<typeof serializedCredentialSchema>;

/**
 * Encrypts an adapter credential. Tokens are unwrapped with `reveal()` only here, immediately
 * before encryption; the plaintext JSON never leaves this function.
 */
export function encryptCredential(credential: OAuthCredential, aad: string): EncryptedSecret {
  const serialized: SerializedCredential = {
    v: 1,
    accessToken: credential.accessToken.reveal(),
    ...(credential.refreshToken === undefined
      ? {}
      : { refreshToken: credential.refreshToken.reveal() }),
    ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt.toISOString() }),
    scopes: [...credential.scopes],
    tokenType: credential.tokenType,
    ...(credential.metadata === undefined ? {} : { metadata: { ...credential.metadata } }),
  };
  return encryptSecret(JSON.stringify(serialized), aad);
}

/** Decrypts and validates a credential, re-wrapping tokens in `Secret` so they cannot be logged. */
export function decryptCredential(record: EncryptedSecret, aad: string): OAuthCredential {
  const plaintext = decryptSecret(record, aad);
  let json: unknown;
  try {
    json = JSON.parse(plaintext);
  } catch {
    throw new DecryptionFailedError(record.keyId);
  }
  const parsed = serializedCredentialSchema.safeParse(json);
  // Report only that the shape is wrong; zod issues could echo token values.
  if (!parsed.success) {
    throw new Error(`Decrypted credential with key id "${record.keyId}" has an unexpected shape.`);
  }
  const data = parsed.data;
  return {
    accessToken: new Secret(data.accessToken),
    ...(data.refreshToken === undefined ? {} : { refreshToken: new Secret(data.refreshToken) }),
    ...(data.expiresAt === undefined ? {} : { expiresAt: new Date(data.expiresAt) }),
    scopes: data.scopes,
    tokenType: data.tokenType,
    ...(data.metadata === undefined ? {} : { metadata: data.metadata }),
  };
}
