import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const requestHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.current }));

import { SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";

import {
  callbackRedirectUri,
  connectErrorCodes,
  connectErrorMessage,
  ConnectFeedbackSchema,
  connectFeedbackQuery,
  connectOrigin,
  createPkcePair,
  isStateExpired,
  isStateToken,
  newStateToken,
  OAUTH_STATE_TTL_SECONDS,
  pkceChallenge,
  reconnectMismatch,
  requestPublicOrigin,
  stateExpiresAt,
} from "./oauth-state";

describe("connectOrigin and callbackRedirectUri", () => {
  const request = "http://localhost:3100/api/connections/fake/start";

  it("uses the request origin when NEXT_PUBLIC_SITE_URL is unset", () => {
    expect(connectOrigin(request, undefined)).toBe("http://localhost:3100");
  });

  it("uses the request origin when NEXT_PUBLIC_SITE_URL is blank", () => {
    expect(connectOrigin(request, "  ")).toBe("http://localhost:3100");
  });

  it("prefers the site URL origin, dropping any path", () => {
    expect(connectOrigin(request, "https://stackdash.example.com/some/path")).toBe("https://stackdash.example.com");
  });

  it("ignores a site URL that is not http or https", () => {
    expect(connectOrigin(request, "javascript:alert(1)")).toBe("http://localhost:3100");
  });

  it("ignores a site URL that does not parse", () => {
    expect(connectOrigin(request, "not a url")).toBe("http://localhost:3100");
  });

  it("builds the provider callback URL on that origin", () => {
    expect(callbackRedirectUri("https://stackdash.example.com", "resend")).toBe(
      "https://stackdash.example.com/api/connections/resend/callback",
    );
  });
});

describe("requestPublicOrigin", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the forwarded host and protocol a proxy sets", async () => {
    requestHeaders.current = new Headers({ host: "10.0.0.5:3000", "x-forwarded-host": "stackdash.example.com", "x-forwarded-proto": "https" });
    expect(await requestPublicOrigin()).toBe("https://stackdash.example.com");
  });

  it("uses the Host header over http without a proxy", async () => {
    requestHeaders.current = new Headers({ host: "localhost:3100" });
    expect(await requestPublicOrigin()).toBe("http://localhost:3100");
  });

  it("falls back to localhost with no Host header at all", async () => {
    requestHeaders.current = new Headers();
    expect(await requestPublicOrigin()).toBe("http://localhost");
  });

  it("prefers NEXT_PUBLIC_SITE_URL, without its trailing slash, over the request", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://stackdash.example.com/");
    requestHeaders.current = new Headers({ host: "10.0.0.5:3000" });
    expect(await requestPublicOrigin()).toBe("https://stackdash.example.com");
  });
});

describe("newStateToken and isStateToken", () => {
  it("makes a 43 character base64url token that isStateToken accepts", () => {
    const token = newStateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isStateToken(token)).toBe(true);
  });

  it("makes a different token every call", () => {
    expect(newStateToken()).not.toBe(newStateToken());
  });

  it("rejects an empty value", () => {
    expect(isStateToken("")).toBe(false);
  });

  it("rejects a value one character short", () => {
    expect(isStateToken("a".repeat(42))).toBe(false);
  });

  it("rejects a value one character long", () => {
    expect(isStateToken("a".repeat(44))).toBe(false);
  });

  it("rejects characters outside base64url", () => {
    expect(isStateToken(`${"a".repeat(42)}.`)).toBe(false);
  });
});

describe("PKCE", () => {
  it("makes a 43 character verifier whose challenge is its base64url SHA-256", () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("matches the RFC 7636 appendix B example", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });
});

describe("state expiry", () => {
  const now = new Date("2026-10-31T12:00:00.000Z");

  it("expires ten minutes after creation", () => {
    expect(OAUTH_STATE_TTL_SECONDS).toBe(600);
    expect(stateExpiresAt(now).toISOString()).toBe("2026-10-31T12:10:00.000Z");
  });

  it("is still valid one millisecond before expiry", () => {
    expect(isStateExpired(stateExpiresAt(now), new Date(now.getTime() + 599_999))).toBe(false);
  });

  it("is expired exactly at expiry", () => {
    expect(isStateExpired(stateExpiresAt(now), new Date(now.getTime() + 600_000))).toBe(true);
  });
});

describe("connect feedback", () => {
  it("round trips through the query string", () => {
    const query = connectFeedbackQuery({ error: "failed", provider: "fake", ref: "REF-ABCDEFGH" });
    const parsed = ConnectFeedbackSchema.parse(Object.fromEntries(new URLSearchParams(query)));
    expect(parsed).toEqual({ error: "failed", provider: "fake", ref: "REF-ABCDEFGH" });
  });

  it("rejects an unknown error code", () => {
    expect(ConnectFeedbackSchema.safeParse({ error: "<script>" }).success).toBe(false);
  });

  it("rejects a reference that does not match the reference format", () => {
    expect(ConnectFeedbackSchema.safeParse({ error: "failed", ref: "stack trace" }).success).toBe(false);
  });

  it("names the provider in the cancelled message", () => {
    expect(connectErrorMessage("cancelled", "Example provider")).toMatch(/^You cancelled connecting Example provider\./);
  });

  it("asks for the instance operator when the provider is not set up", () => {
    expect(connectErrorMessage("not_configured", "Resend")).toContain(
      "Ask the person who runs this StackDash instance to register the Resend app.",
    );
  });

  it("never uses em or en dashes or exclamation marks in any message", () => {
    for (const code of connectErrorCodes) {
      expect(connectErrorMessage(code, "Vercel")).not.toMatch(/[\u2013\u2014!]/);
    }
  });
});

describe("reconnectMismatch (#131)", () => {
  const real = { granted_scopes: ["read:project"] };
  const simulated = { granted_scopes: [SIMULATED_SCOPE] };

  it("allows a real connection through a real adapter and a simulated one through the simulator", () => {
    expect(reconnectMismatch(real, false)).toBeNull();
    expect(reconnectMismatch(simulated, true)).toBeNull();
  });

  it("refuses a real connection through the simulator, and says to connect a new simulated one", () => {
    expect(reconnectMismatch(real, true)).toBe("reconnect_real_connection");
    expect(connectErrorMessage("reconnect_real_connection", "Vercel")).toBe(
      "This connection was made with the real Vercel app. Connect a new simulated one instead.",
    );
  });

  it("refuses a simulated connection through a real adapter, and says to connect a new real one", () => {
    expect(reconnectMismatch(simulated, false)).toBe("reconnect_simulated_connection");
    expect(connectErrorMessage("reconnect_simulated_connection", "Stripe")).toBe(
      "This connection was made with the simulated Stripe. Connect a new real one instead.",
    );
  });
});
