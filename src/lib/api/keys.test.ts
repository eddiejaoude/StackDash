import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { API_KEY_PREFIX, bearerApiKey, generateApiKey, hashApiKey } from "./keys";

describe("generateApiKey", () => {
  it("makes a sd_ key with 43 base64url characters, its SHA-256 hex, and an 8 character display prefix", () => {
    const { key, tokenHash, tokenPrefix } = generateApiKey();
    expect(key).toMatch(/^sd_[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(createHash("sha256").update(key).digest("hex"));
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // The database checks token_prefix against ^sd_[A-Za-z0-9_-]{8}$.
    expect(tokenPrefix).toMatch(/^sd_[A-Za-z0-9_-]{8}$/);
    expect(key.startsWith(tokenPrefix)).toBe(true);
  });

  it("never repeats a key or a hash across many draws", () => {
    const draws = Array.from({ length: 200 }, () => generateApiKey());
    expect(new Set(draws.map((draw) => draw.key)).size).toBe(200);
    expect(new Set(draws.map((draw) => draw.tokenHash)).size).toBe(200);
  });
});

describe("hashApiKey", () => {
  it("is the SHA-256 hex of the UTF-8 key, so the same key always finds the same row", () => {
    expect(hashApiKey("sd_example")).toBe(createHash("sha256").update("sd_example", "utf8").digest("hex"));
    expect(hashApiKey("sd_example")).toBe(hashApiKey("sd_example"));
  });

  it("differs for keys that differ by one character", () => {
    expect(hashApiKey("sd_a")).not.toBe(hashApiKey("sd_b"));
  });
});

describe("bearerApiKey", () => {
  const key = generateApiKey().key;

  it.each([
    ["the standard header", `Bearer ${key}`],
    ["a lowercase scheme", `bearer ${key}`],
    ["surrounding whitespace", `  Bearer ${key}  `],
    ["several spaces after the scheme", `Bearer    ${key}`],
  ])("reads the key from %s", (_case, header) => {
    expect(bearerApiKey(header)).toBe(key);
  });

  it.each<[string, string | null]>([
    ["no header", null],
    ["an empty header", ""],
    ["the scheme alone", "Bearer"],
    ["another scheme", `Basic ${key}`],
    ["the key without a scheme", key],
    ["a key one character short", `Bearer ${key.slice(0, -1)}`],
    ["a key one character long", `Bearer ${key}A`],
    ["another prefix", `Bearer sk_${key.slice(API_KEY_PREFIX.length)}`],
    ["a character outside base64url", `Bearer ${key.slice(0, -1)}=`],
    ["two keys", `Bearer ${key} ${key}`],
    ["unicode in the key", `Bearer ${key.slice(0, -1)}é`],
  ])("refuses %s", (_case, header) => {
    expect(bearerApiKey(header)).toBeNull();
  });
});
