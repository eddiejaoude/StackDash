import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Secret } from "@/lib/adapters/types";
import { DELIVERY_ID_MAX_LENGTH, hmacHex, isFresh, readDeliveryId, safeEqual } from "./signature";

// Made up, and built from parts so CI's secret scan (gitleaks) does not read it as a credential.
const SECRET_VALUE = ["synthetic", "webhook", "secret"].join("-");
const SECRET = new Secret(SECRET_VALUE);
const NOW = new Date("2026-11-15T12:00:00.000Z");
const NOW_SECONDS = NOW.getTime() / 1000;

describe("hmacHex", () => {
  it.each(["sha1", "sha256"] as const)("signs a string with %s as lowercase hex", (algorithm) => {
    const expected = createHmac(algorithm, SECRET_VALUE).update("payload", "utf8").digest("hex");
    expect(hmacHex(algorithm, SECRET, "payload")).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]+$/);
  });

  it("signs raw body bytes and the same text as a string identically (boundary: unicode body bytes)", () => {
    const body = '{"title":"Déploiement réussi 🚀"}';
    const bytes = new TextEncoder().encode(body);
    expect(bytes.length).toBeGreaterThan(body.length);
    expect(hmacHex("sha256", SECRET, bytes)).toBe(hmacHex("sha256", SECRET, body));
  });

  it("signs an empty body (boundary: empty body)", () => {
    const expected = createHmac("sha256", SECRET_VALUE).update(new Uint8Array(0)).digest("hex");
    expect(hmacHex("sha256", SECRET, new Uint8Array(0))).toBe(expected);
  });

  it("gives a different signature for a different secret (boundary: wrong secret)", () => {
    expect(hmacHex("sha256", new Secret("another-secret"), "payload")).not.toBe(hmacHex("sha256", SECRET, "payload"));
  });
});

describe("safeEqual", () => {
  it("is true for the same signature computed twice", () => {
    expect(safeEqual(hmacHex("sha256", SECRET, "payload"), hmacHex("sha256", SECRET, "payload"))).toBe(true);
  });

  it.each([
    ["one character differs", "abcdef", "abcdee"],
    ["different lengths", "abcdef", "abcde"],
    ["an empty signature", "", "abcdef"],
    ["a unicode lookalike", "a", "\u00e1"],
  ])("is false when %s (boundary)", (_case, a, b) => {
    expect(safeEqual(a, b)).toBe(false);
    expect(safeEqual(b, a)).toBe(false);
  });

  it("is true for two empty strings (boundary: empty)", () => {
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("isFresh", () => {
  const TOLERANCE = 300;

  it("accepts a timestamp of now", () => {
    expect(isFresh(NOW_SECONDS, NOW, TOLERANCE)).toBe(true);
  });

  it.each([
    ["exactly at the tolerance in the past", NOW_SECONDS - TOLERANCE, true],
    ["exactly at the tolerance in the future", NOW_SECONDS + TOLERANCE, true],
    ["one second past the tolerance", NOW_SECONDS - TOLERANCE - 1, false],
    ["one second of future skew past the tolerance", NOW_SECONDS + TOLERANCE + 1, false],
    ["zero", 0, false],
    ["negative", -1, false],
    ["NaN", Number.NaN, false],
    ["infinity", Number.POSITIVE_INFINITY, false],
  ])("treats a timestamp %s as %s (boundary)", (_case, timestamp, fresh) => {
    expect(isFresh(timestamp, NOW, TOLERANCE)).toBe(fresh);
  });

  it("compares against now at sub-second precision (boundary: now has milliseconds)", () => {
    const later = new Date(NOW.getTime() + 500);
    expect(isFresh(NOW_SECONDS - TOLERANCE, later, TOLERANCE)).toBe(false);
    expect(isFresh(NOW_SECONDS - TOLERANCE + 1, later, TOLERANCE)).toBe(true);
  });
});

describe("readDeliveryId", () => {
  const HEADER = "x-provider-delivery";

  it("reads the delivery id, trimmed", () => {
    expect(readDeliveryId(new Headers({ [HEADER]: " 72d3162e-cc78-11e3-81ab-4c9367dc0958 " }), HEADER)).toBe(
      "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    );
  });

  it.each([
    ["an absent header", new Headers()],
    ["an empty header", new Headers({ [HEADER]: "" })],
    ["a blank header", new Headers({ [HEADER]: "   " })],
    ["one character over the maximum", new Headers({ [HEADER]: "d".repeat(DELIVERY_ID_MAX_LENGTH + 1) })],
  ])("is undefined for %s (boundary)", (_case, headers) => {
    expect(readDeliveryId(headers, HEADER)).toBeUndefined();
  });

  it("accepts an id of exactly the maximum length (boundary)", () => {
    const id = "d".repeat(DELIVERY_ID_MAX_LENGTH);
    expect(readDeliveryId(new Headers({ [HEADER]: id }), HEADER)).toBe(id);
  });
});
