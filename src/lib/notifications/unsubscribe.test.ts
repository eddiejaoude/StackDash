import { randomBytes } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { keyIdFor } from "@/lib/crypto/credentials";

import { readUnsubscribeToken, unsubscribeToken } from "./unsubscribe";

// Keys are generated per run so no key material is ever committed.
const KEY_A = randomBytes(32);
const KEY_B = randomBytes(32);
const WORKSPACE_ID = "6f1c2c7e-6a43-4c7b-9a39-0d6f0b1d2a11";
const USER_ID = "0b8f3a4e-5d2c-4e1f-8a7b-9c6d5e4f3a21";

function useKeys(current: Buffer, previous?: Buffer): void {
  vi.stubEnv("STACKDASH_ENCRYPTION_KEY", current.toString("base64"));
  vi.stubEnv("STACKDASH_ENCRYPTION_KEYS_PREVIOUS", previous === undefined ? "" : `${keyIdFor(previous)}:${previous.toString("base64")}`);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("unsubscribe tokens", () => {
  it("names the member and workspace it was made for", () => {
    useKeys(KEY_A);
    const token = unsubscribeToken(WORKSPACE_ID, USER_ID);
    expect(token).toMatch(/^[0-9a-f-]{36}\.[0-9a-f-]{36}\.[0-9a-f]{8}\.[A-Za-z0-9_-]+$/);
    expect(readUnsubscribeToken(token)).toEqual({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  });

  it("keeps working after a key rotation while the old key is still listed", () => {
    useKeys(KEY_A);
    const token = unsubscribeToken(WORKSPACE_ID, USER_ID);
    useKeys(KEY_B, KEY_A);
    expect(readUnsubscribeToken(token)).toEqual({ workspaceId: WORKSPACE_ID, userId: USER_ID });
  });

  it("stops working once the old key is removed", () => {
    useKeys(KEY_A);
    const token = unsubscribeToken(WORKSPACE_ID, USER_ID);
    useKeys(KEY_B);
    expect(readUnsubscribeToken(token)).toBeNull();
  });

  it("refuses a token moved to another member", () => {
    useKeys(KEY_A);
    const [, , keyId, signature] = unsubscribeToken(WORKSPACE_ID, USER_ID).split(".");
    const forged = [WORKSPACE_ID, "9e7d6c5b-4a39-4281-b7a6-5f4e3d2c1b09", keyId, signature].join(".");
    expect(readUnsubscribeToken(forged)).toBeNull();
  });

  it("refuses a signature with one character changed", () => {
    useKeys(KEY_A);
    const token = unsubscribeToken(WORKSPACE_ID, USER_ID);
    const last = token.at(-1) === "A" ? "B" : "A";
    expect(readUnsubscribeToken(`${token.slice(0, -1)}${last}`)).toBeNull();
  });

  it.each([null, undefined, "", "a.b.c", "a.b.c.d.e", `not-a-uuid.${USER_ID}.deadbeef.sig`, "x".repeat(500)])("refuses the malformed token %j", (token) => {
    useKeys(KEY_A);
    expect(readUnsubscribeToken(token)).toBeNull();
  });
});
