import { createHmac, hkdfSync, randomBytes } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Secret, type OAuthCredential } from "@/lib/adapters/types";
import {
  credentialAad,
  currentKeyId,
  decryptCredential,
  decryptSecret,
  DecryptionFailedError,
  derivedKey,
  encryptCredential,
  encryptSecret,
  EncryptionKeyConfigError,
  keyIdFor,
  needsRotation,
  signMessage,
  UnknownEncryptionKeyError,
  type EncryptedSecret,
} from "@/lib/crypto/credentials";

// Keys are generated per run so no key material is ever committed.
const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const KEY_A_B64 = KEY_A.toString("base64");
const KEY_B_B64 = KEY_B.toString("base64");

const WORKSPACE_ID = "6f1c2c7e-6a43-4c7b-9a39-0d6f0b1d2a11";
const CONNECTION_ID = "0b8f3a4e-5d2c-4e1f-8a7b-9c6d5e4f3a21";
const OTHER_ID = "9e7d6c5b-4a39-4281-b7a6-5f4e3d2c1b09";
const AAD = credentialAad(WORKSPACE_ID, CONNECTION_ID);

function useKeys(current: string, previous?: string): void {
  vi.stubEnv("STACKDASH_ENCRYPTION_KEY", current);
  vi.stubEnv("STACKDASH_ENCRYPTION_KEYS_PREVIOUS", previous ?? "");
}

function flipFirstByte(buffer: Buffer): Buffer {
  const copy = Buffer.from(buffer);
  copy[0] = (copy[0] ?? 0) ^ 0x01;
  return copy;
}

beforeEach(() => {
  useKeys(KEY_A_B64);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("encryptSecret and decryptSecret", () => {
  const plaintexts: readonly { name: string; value: string }[] = [
    { name: "short ascii", value: "token-value" },
    { name: "empty string", value: "" },
    { name: "unicode (accents, CJK, emoji, combining marks)", value: "café 東京 🔐 e\u0301" },
    { name: "10k characters", value: "x".repeat(10_000) },
  ];

  it.each(plaintexts)("round trips $name", ({ value }) => {
    const record = encryptSecret(value, AAD);
    expect(decryptSecret(record, AAD)).toBe(value);
  });

  it("uses a 12-byte IV, a 16-byte tag, and the current key id", () => {
    const record = encryptSecret("token-value", AAD);
    expect(record.iv).toHaveLength(12);
    expect(record.authTag).toHaveLength(16);
    expect(record.keyId).toBe(keyIdFor(KEY_A));
    expect(record.keyId).toMatch(/^[0-9a-f]{8}$/);
  });

  it("uses a fresh IV for every encryption", () => {
    const first = encryptSecret("token-value", AAD);
    const second = encryptSecret("token-value", AAD);
    expect(first.iv.equals(second.iv)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  const tampers: readonly { name: string; tamper: (record: EncryptedSecret) => EncryptedSecret }[] =
    [
      { name: "flipped ciphertext byte", tamper: (r) => ({ ...r, ciphertext: flipFirstByte(r.ciphertext) }) },
      { name: "flipped tag byte", tamper: (r) => ({ ...r, authTag: flipFirstByte(r.authTag) }) },
      { name: "flipped iv byte", tamper: (r) => ({ ...r, iv: flipFirstByte(r.iv) }) },
      { name: "truncated tag (4 bytes)", tamper: (r) => ({ ...r, authTag: r.authTag.subarray(0, 4) }) },
      { name: "short iv (8 bytes)", tamper: (r) => ({ ...r, iv: r.iv.subarray(0, 8) }) },
      { name: "appended ciphertext byte", tamper: (r) => ({ ...r, ciphertext: Buffer.concat([r.ciphertext, Buffer.from([0])]) }) },
      { name: "truncated ciphertext", tamper: (r) => ({ ...r, ciphertext: r.ciphertext.subarray(1) }) },
    ];

  it.each(tampers)("rejects a $name", ({ tamper }) => {
    const record = encryptSecret("token-value", AAD);
    expect(() => decryptSecret(tamper(record), AAD)).toThrow(DecryptionFailedError);
  });

  const wrongAads: readonly { name: string; aad: string }[] = [
    { name: "another workspace", aad: credentialAad(OTHER_ID, CONNECTION_ID) },
    { name: "another connection", aad: credentialAad(WORKSPACE_ID, OTHER_ID) },
    { name: "swapped ids", aad: credentialAad(CONNECTION_ID, WORKSPACE_ID) },
    { name: "empty aad", aad: "" },
  ];

  it.each(wrongAads)("rejects decryption bound to $name", ({ aad }) => {
    const record = encryptSecret("token-value", AAD);
    expect(() => decryptSecret(record, aad)).toThrow(DecryptionFailedError);
  });
});

describe("key configuration", () => {
  const badCurrent: readonly { name: string; value: string }[] = [
    { name: "16 bytes", value: randomBytes(16).toString("base64") },
    { name: "31 bytes", value: randomBytes(31).toString("base64") },
    { name: "33 bytes", value: randomBytes(33).toString("base64") },
    { name: "64 bytes", value: randomBytes(64).toString("base64") },
    { name: "not base64", value: "not a base64 key at all, clearly!!" },
    { name: "hex instead of base64", value: KEY_A.toString("hex") },
  ];

  it.each(badCurrent)("rejects a current key of $name", ({ value }) => {
    useKeys(value);
    expect(() => encryptSecret("token-value", AAD)).toThrow(EncryptionKeyConfigError);
    expect(() => encryptSecret("token-value", AAD)).toThrow(/STACKDASH_ENCRYPTION_KEY/);
  });

  it("names the variable when the key is not set", () => {
    vi.stubEnv("STACKDASH_ENCRYPTION_KEY", "");
    expect(() => encryptSecret("token-value", AAD)).toThrow(/STACKDASH_ENCRYPTION_KEY is not set/);
  });

  it("accepts a key with surrounding whitespace", () => {
    useKeys(` ${KEY_A_B64}\n`);
    expect(encryptSecret("token-value", AAD).keyId).toBe(keyIdFor(KEY_A));
  });

  const badPrevious: readonly { name: string; value: string }[] = [
    { name: "missing key id", value: KEY_A_B64 },
    { name: "empty key id", value: `:${KEY_A_B64}` },
    { name: "key id that does not match the key", value: `deadbeef:${KEY_A_B64}` },
    { name: "short key", value: `${keyIdFor(KEY_A)}:${randomBytes(31).toString("base64")}` },
  ];

  it.each(badPrevious)("rejects a previous entry with $name", ({ value }) => {
    useKeys(KEY_B_B64, value);
    expect(() => encryptSecret("token-value", AAD)).toThrow(EncryptionKeyConfigError);
  });

  it("does not echo key material in configuration errors", () => {
    useKeys(KEY_B_B64, `deadbeef:${KEY_A_B64}`);
    let caught: unknown;
    try {
      encryptSecret("token-value", AAD);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EncryptionKeyConfigError);
    if (!(caught instanceof Error)) return;
    expect(caught.message).not.toContain(KEY_A_B64);
    expect(caught.message).not.toContain(KEY_B_B64);
  });
});

describe("rotation", () => {
  it("decrypts with a previous key after the current key changes", () => {
    const record = encryptSecret("token-value", AAD);
    useKeys(KEY_B_B64, `${keyIdFor(KEY_A)}:${KEY_A_B64}`);

    expect(decryptSecret(record, AAD)).toBe("token-value");
    expect(needsRotation(record.keyId)).toBe(true);
    expect(currentKeyId()).toBe(keyIdFor(KEY_B));
    expect(needsRotation(currentKeyId())).toBe(false);

    const rotated = encryptSecret(decryptSecret(record, AAD), AAD);
    expect(rotated.keyId).toBe(keyIdFor(KEY_B));
    expect(decryptSecret(rotated, AAD)).toBe("token-value");
  });

  it("accepts several previous keys and blank entries", () => {
    const record = encryptSecret("token-value", AAD);
    const extra = randomBytes(32);
    useKeys(
      KEY_B_B64,
      ` ${keyIdFor(extra)}:${extra.toString("base64")}, ,${keyIdFor(KEY_A)}:${KEY_A_B64} `,
    );
    expect(decryptSecret(record, AAD)).toBe("token-value");
  });

  it("raises a typed error naming the unknown key id, without key material", () => {
    const record = encryptSecret("token-value", AAD);
    useKeys(KEY_B_B64);

    let caught: unknown;
    try {
      decryptSecret(record, AAD);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnknownEncryptionKeyError);
    if (!(caught instanceof UnknownEncryptionKeyError)) return;
    expect(caught.keyId).toBe(keyIdFor(KEY_A));
    expect(caught.message).toContain(keyIdFor(KEY_A));
    for (const material of [KEY_A_B64, KEY_B_B64, KEY_A.toString("hex"), KEY_B.toString("hex")]) {
      expect(caught.message).not.toContain(material);
      expect(JSON.stringify(caught)).not.toContain(material);
    }
  });
});

describe("derivedKey", () => {
  function hkdf(key: Buffer, info: string): Buffer {
    return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), info, 32));
  }

  it("is a 32 byte HKDF key in its own versioned namespace, one per purpose", () => {
    const key = derivedKey("public-rate-limit");
    expect(key).toEqual(hkdf(KEY_A, "stackdash key v1:public-rate-limit"));
    expect(key).toHaveLength(32);
    expect(key).not.toEqual(KEY_A);
    expect(derivedKey("other")).not.toEqual(key);
  });

  it("never equals the signing key of the same purpose, which keeps its own namespace (boundary: same purpose string)", () => {
    const signingKey = hkdf(KEY_A, "stackdash signing v1:public-rate-limit");
    expect(derivedKey("public-rate-limit")).not.toEqual(signingKey);
    // The signing derivation is pinned byte for byte: changing it would invalidate every signature already sent.
    const signature = createHmac("sha256", signingKey).update("message", "utf8").digest("base64url");
    expect(signMessage("public-rate-limit", "message")).toBe(`${keyIdFor(KEY_A)}.${signature}`);
  });

  it("follows the current key, never a previous one (boundary: rotation)", () => {
    useKeys(KEY_B_B64, `${keyIdFor(KEY_A)}:${KEY_A_B64}`);
    expect(derivedKey("public-rate-limit")).toEqual(hkdf(KEY_B, "stackdash key v1:public-rate-limit"));
  });
});

describe("encryptCredential and decryptCredential", () => {
  // Assembled at runtime so secret scanners never see a token-shaped literal.
  const ACCESS = ["access", "fixture", "a1b2c3d4e5f6"].join("-");
  const REFRESH = ["refresh", "fixture", "f6e5d4c3b2a1"].join("-");
  const EXPIRES = new Date("2026-11-01T12:34:56.789Z");

  const credentials: readonly { name: string; credential: OAuthCredential }[] = [
    {
      name: "all fields",
      credential: {
        accessToken: new Secret(ACCESS),
        refreshToken: new Secret(REFRESH),
        expiresAt: EXPIRES,
        scopes: ["read:org", "repo"],
        tokenType: "bearer",
      },
    },
    {
      name: "no refresh token or expiry",
      credential: { accessToken: new Secret(ACCESS), scopes: [], tokenType: "bearer" },
    },
  ];

  it.each(credentials)("round trips a credential with $name", ({ credential }) => {
    const decrypted = decryptCredential(encryptCredential(credential, AAD), AAD);

    expect(decrypted.accessToken).toBeInstanceOf(Secret);
    expect(decrypted.accessToken.reveal()).toBe(credential.accessToken.reveal());
    expect(decrypted.refreshToken?.reveal()).toBe(credential.refreshToken?.reveal());
    if (credential.refreshToken !== undefined) {
      expect(decrypted.refreshToken).toBeInstanceOf(Secret);
    } else {
      expect("refreshToken" in decrypted).toBe(false);
    }
    if (credential.expiresAt !== undefined) {
      expect(decrypted.expiresAt).toBeInstanceOf(Date);
      expect(decrypted.expiresAt?.getTime()).toBe(credential.expiresAt.getTime());
    } else {
      expect("expiresAt" in decrypted).toBe(false);
    }
    expect(decrypted.scopes).toEqual(credential.scopes);
    expect(decrypted.tokenType).toBe(credential.tokenType);
  });

  it("does not reveal tokens when a decrypted credential is stringified", () => {
    const [first] = credentials;
    if (first === undefined) throw new Error("fixture missing");
    const decrypted = decryptCredential(encryptCredential(first.credential, AAD), AAD);
    const json = JSON.stringify(decrypted);
    expect(json).not.toContain(ACCESS);
    expect(json).not.toContain(REFRESH);
    expect(String(decrypted.accessToken)).not.toContain(ACCESS);
  });

  it("does not store tokens in clear in the encrypted record", () => {
    const [first] = credentials;
    if (first === undefined) throw new Error("fixture missing");
    const record = encryptCredential(first.credential, AAD);
    for (const part of [record.ciphertext, record.iv, record.authTag]) {
      expect(part.includes(Buffer.from(ACCESS))).toBe(false);
      expect(part.includes(Buffer.from(REFRESH))).toBe(false);
    }
  });

  it("rejects a decrypted payload that is not a credential", () => {
    const record = encryptSecret(JSON.stringify({ v: 1, accessToken: ACCESS }), AAD);
    let caught: unknown;
    try {
      decryptCredential(record, AAD);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    if (!(caught instanceof Error)) return;
    expect(caught.message).not.toContain(ACCESS);
  });

  it("rejects a credential moved to another connection's row", () => {
    const [first] = credentials;
    if (first === undefined) throw new Error("fixture missing");
    const record = encryptCredential(first.credential, AAD);
    expect(() => decryptCredential(record, credentialAad(WORKSPACE_ID, OTHER_ID))).toThrow(
      DecryptionFailedError,
    );
  });
});
