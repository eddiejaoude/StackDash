import { afterEach, describe, expect, it, vi } from "vitest";

import { clientIpEnv, type ClientIpEnv } from "@/lib/env";

import {
  clientIp,
  hashClientIp,
  PUBLIC_REQUESTS_PER_MINUTE,
  rateLimitDecision,
  rateLimitedPageHtml,
  secondsUntilNextMinute,
} from "./requests";

const KEY = Buffer.alloc(32, 7);

const VERCEL: ClientIpEnv = { header: "x-vercel-forwarded-for", trustedProxies: 1 };
const ONE_PROXY: ClientIpEnv = { header: "x-forwarded-for", trustedProxies: 1 };
const TWO_PROXIES: ClientIpEnv = { header: "x-forwarded-for", trustedProxies: 2 };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("clientIp", () => {
  it.each([
    ["Vercel's own header, ignoring what the client put in x-forwarded-for and x-real-ip", VERCEL, { "x-vercel-forwarded-for": "203.0.113.7", "x-forwarded-for": "198.51.100.1", "x-real-ip": "198.51.100.2" }, "203.0.113.7"],
    ["the entry one proxy appended, not the one the client prepended", ONE_PROXY, { "x-forwarded-for": "198.51.100.66, 203.0.113.7" }, "203.0.113.7"],
    ["the entry the outer of two proxies appended, trimmed", TWO_PROXIES, { "x-forwarded-for": "198.51.100.66 , 203.0.113.7 , 10.0.0.2" }, "203.0.113.7"],
    ["IPv6 as given", ONE_PROXY, { "x-forwarded-for": "2001:db8::1" }, "2001:db8::1"],
    ["the appended address and never x-real-ip, which a client can send", ONE_PROXY, { "x-real-ip": "198.51.100.2", "x-forwarded-for": "203.0.113.7" }, "203.0.113.7"],
    // Boundaries: fewer entries than trusted proxies, and empty or blank values.
    ["the leftmost entry when a trusted proxy did not append", TWO_PROXIES, { "x-forwarded-for": "203.0.113.7" }, "203.0.113.7"],
    ["the last address, skipping a trailing blank entry", ONE_PROXY, { "x-forwarded-for": "198.51.100.66, 203.0.113.7, " }, "203.0.113.7"],
    ["null on Vercel when only x-forwarded-for is present", VERCEL, { "x-forwarded-for": "203.0.113.7" }, null],
    ["null when the header is missing", ONE_PROXY, {}, null],
    ["null when the header is empty", ONE_PROXY, { "x-forwarded-for": " , " }, null],
  ])("reads %s", (_title, source, headers, expected) => {
    expect(clientIp(new Headers(headers), source)).toBe(expected);
  });
});

describe("clientIpEnv", () => {
  it("reads Vercel's header on Vercel, whatever the proxy count says", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("STACKDASH_TRUSTED_PROXY_COUNT", "3");
    expect(clientIpEnv()).toEqual(VERCEL);
  });

  it("trusts one proxy when self-hosted and unset, and the configured count when set", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("STACKDASH_TRUSTED_PROXY_COUNT", "");
    expect(clientIpEnv()).toEqual(ONE_PROXY);
    vi.stubEnv("STACKDASH_TRUSTED_PROXY_COUNT", "2");
    expect(clientIpEnv()).toEqual(TWO_PROXIES);
  });

  it.each(["0", "10", "two", "1.5"])("refuses STACKDASH_TRUSTED_PROXY_COUNT=%s (boundary: 1 to 9)", (value) => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("STACKDASH_TRUSTED_PROXY_COUNT", value);
    expect(() => clientIpEnv()).toThrow("STACKDASH_TRUSTED_PROXY_COUNT is invalid");
  });
});

describe("hashClientIp", () => {
  it("is the lowercase 64 character hex digest the counter table accepts, never the address", () => {
    const hash = hashClientIp("203.0.113.7", KEY);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain("203");
  });

  it("is stable for one address and key, and differs across addresses and keys", () => {
    expect(hashClientIp("203.0.113.7", KEY)).toBe(hashClientIp("203.0.113.7", KEY));
    expect(hashClientIp("203.0.113.8", KEY)).not.toBe(hashClientIp("203.0.113.7", KEY));
    expect(hashClientIp("203.0.113.7", Buffer.alloc(32, 8))).not.toBe(hashClientIp("203.0.113.7", KEY));
  });

  it("counts one IPv6 address once whatever its letter case (boundary: case)", () => {
    expect(hashClientIp("2001:DB8::1", KEY)).toBe(hashClientIp("2001:db8::1", KEY));
  });
});

describe("rateLimitDecision", () => {
  const at = new Date("2026-11-05T12:00:45.000Z");

  it("allows up to and including the limit", () => {
    expect(rateLimitDecision(1, at)).toEqual({ allowed: true });
    expect(rateLimitDecision(PUBLIC_REQUESTS_PER_MINUTE, at)).toEqual({ allowed: true });
  });

  it("refuses the request after the limit until the next minute (boundary: limit plus one)", () => {
    expect(rateLimitDecision(PUBLIC_REQUESTS_PER_MINUTE + 1, at)).toEqual({ allowed: false, retryAfterSeconds: 15 });
  });
});

describe("secondsUntilNextMinute", () => {
  it.each([
    ["2026-11-05T12:00:00.000Z", 60],
    ["2026-11-05T12:00:30.500Z", 30],
    ["2026-11-05T12:00:59.999Z", 1],
  ])("at %s is %d", (at, expected) => {
    expect(secondsUntilNextMinute(new Date(at))).toBe(expected);
  });
});

describe("rateLimitedPageHtml", () => {
  it("says what happened, names the wait, and links home", () => {
    const html = rateLimitedPageHtml({ retryAfterSeconds: 42 });
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Too many requests · StackDash</title>");
    expect(html).toContain(">Too many requests from this address</h1>");
    expect(html).toContain(`up to ${PUBLIC_REQUESTS_PER_MINUTE} requests a minute`);
    expect(html).toContain("Try again in 42 seconds");
    expect(html).toMatch(/<a href="\/"[^>]*>Go to the home page<\/a>/);
  });

  it.each([
    [1, "Try again in 1 second,"],
    [60, "Try again in 60 seconds,"],
  ])("names a wait of %d (boundary: the first and last second of a minute)", (retryAfterSeconds, expected) => {
    expect(rateLimitedPageHtml({ retryAfterSeconds })).toContain(expected);
  });

  it("carries no script or style element, which the page's nonce policy would block", () => {
    expect(rateLimitedPageHtml({ retryAfterSeconds: 30 })).not.toMatch(/<script|<style/);
  });
});
