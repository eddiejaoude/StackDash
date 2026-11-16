import { afterEach, describe, expect, it, vi } from "vitest";

import { fakeAdapter } from "@/lib/adapters/fake";
import { simulatedAdapters } from "@/lib/adapters/simulated";
import { SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";
import { SIMULATED_WEBHOOK_WRITE_SCOPE } from "@/lib/adapters/simulated/webhooks";
import { Secret } from "@/lib/adapters/types";

import { GET } from "./route";

const ORIGIN = "http://localhost:3000";
const CALLBACK = `${ORIGIN}/api/connections/fake/callback`;

function authorizeRequest(params: Record<string, string>): Request {
  const url = new URL("/api/dev/fake-provider/authorize", ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url);
}

const validParams = { state: "state-123", redirect_uri: CALLBACK, scope: "usage:read admin" };

function location(response: Response): URL {
  const header = response.headers.get("location");
  if (header === null) throw new Error("expected a redirect");
  return new URL(header);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/dev/fake-provider/authorize guard", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["0", "0"],
    ["true", "true"],
    ["padded 1", " 1"],
  ])("answers 404 when STACKDASH_ENABLE_FAKE_PROVIDER is %s", (_title, value) => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", value);
    const response = GET(authorizeRequest(validParams));
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("GET /api/dev/fake-provider/authorize when enabled", () => {
  it("redirects to the fake callback with a fake code, the state, and every requested scope", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    const response = GET(authorizeRequest(validParams));
    expect(response.status).toBe(302);
    const target = location(response);
    expect(`${target.origin}${target.pathname}`).toBe(CALLBACK);
    expect(target.searchParams.get("state")).toBe("state-123");
    expect(target.searchParams.get("code")).toMatch(/^fake-[0-9a-f-]{36}$/);
    expect(target.searchParams.get("granted_scope")).toBe("usage:read admin");
    expect(target.searchParams.has("mode")).toBe(false);
  });

  it("issues a different code on each approval", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    const first = location(GET(authorizeRequest(validParams))).searchParams.get("code");
    const second = location(GET(authorizeRequest(validParams))).searchParams.get("code");
    expect(first).not.toBe(second);
  });

  it("omits a declined scope from granted_scope", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    const target = location(GET(authorizeRequest({ ...validParams, decline: "usage:read" })));
    expect(target.searchParams.get("granted_scope")).toBe("admin");
  });

  it("simulates cancel with error=access_denied and no code", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    const target = location(GET(authorizeRequest({ ...validParams, error: "access_denied" })));
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.get("state")).toBe("state-123");
    expect(target.searchParams.has("code")).toBe(false);
  });

  it("forwards a valid mode to the callback", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    const target = location(GET(authorizeRequest({ ...validParams, mode: "unavailable" })));
    expect(target.searchParams.get("mode")).toBe("unavailable");
  });

  it.each([
    ["redirect_uri missing", { state: "s", scope: "usage:read" }],
    ["redirect_uri on another origin", { ...validParams, redirect_uri: "https://evil.example/api/connections/fake/callback" }],
    ["redirect_uri on another path", { ...validParams, redirect_uri: `${ORIGIN}/api/connections/vercel/callback` }],
    ["redirect_uri with a query", { ...validParams, redirect_uri: `${CALLBACK}?next=/admin` }],
    ["redirect_uri not a URL", { ...validParams, redirect_uri: "not a url" }],
    ["state missing", { redirect_uri: CALLBACK, scope: "usage:read" }],
    ["state empty", { ...validParams, state: "" }],
    ["scope missing", { state: "s", redirect_uri: CALLBACK }],
    ["unknown scope", { ...validParams, scope: "usage:read write:all" }],
    ["unknown declined scope", { ...validParams, decline: "billing" }],
    ["unsupported error", { ...validParams, error: "server_error" }],
    ["unknown mode", { ...validParams, mode: "explode" }],
  ])("answers 400 without redirecting when %s", (_title, params) => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    const response = GET(authorizeRequest(params));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("connect round trip through the route", () => {
  it("buildAuthorizeUrl -> route -> exchangeCode yields a credential with the granted scopes", async () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    const authorizeUrl = fakeAdapter.buildAuthorizeUrl({
      client: { clientId: "fake-client", clientSecret: new Secret("fake-client-secret"), extra: {} },
      state: "state-xyz",
      redirectUri: CALLBACK,
    });
    authorizeUrl.searchParams.set("decline", "admin");
    authorizeUrl.searchParams.set("mode", "rate_limited");
    const target = location(GET(new Request(authorizeUrl)));
    const callbackParams = Object.fromEntries(target.searchParams);
    const code = callbackParams.code;
    if (code === undefined) throw new Error("expected a code");

    const credential = await fakeAdapter.exchangeCode(
      { code, redirectUri: CALLBACK, callbackParams },
      {
        fetch: vi.fn(() => Promise.reject(new Error("network is not allowed"))),
        now: () => new Date("2026-10-02T15:00:00.000Z"),
        timeoutMs: 5000,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        client: { clientId: "fake-client", clientSecret: new Secret("fake-client-secret"), extra: {} },
      },
    );
    expect(credential.scopes).toEqual(["usage:read"]);
    expect(credential.metadata).toEqual({ mode: "rate_limited" });
    expect(fakeAdapter.detectMissingPermissions(credential)).toEqual([]);
  });
});

const STRIPE_CALLBACK = `${ORIGIN}/api/connections/stripe/callback`;
const GITLAB_CALLBACK = `${ORIGIN}/api/connections/gitlab/callback`;
const simulatedParams = { provider: "stripe", state: "state-sim", redirect_uri: STRIPE_CALLBACK, scope: SIMULATED_SCOPE };

describe("GET /api/dev/fake-provider/authorize?provider=<live id> guard", () => {
  it.each([
    ["unset", undefined, undefined],
    ["0", "0", undefined],
    ["true", "true", undefined],
    ["padded 1", " 1", undefined],
    ["1 on Vercel production", "1", "production"],
  ])("answers 404 when STACKDASH_SIMULATE_PROVIDERS is %s", (_title, value, vercelEnv) => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", value);
    vi.stubEnv("VERCEL_ENV", vercelEnv);
    // The fake provider's flag does not open the simulated screen.
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    const response = GET(authorizeRequest(simulatedParams));
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not open the fake provider's screen with only the simulation flag", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "");
    expect(GET(authorizeRequest(validParams)).status).toBe(404);
  });
});

describe("GET /api/dev/fake-provider/authorize?provider=<live id> when simulating", () => {
  it("redirects to that provider's callback with a simulated code and the simulated scope", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    vi.stubEnv("VERCEL_ENV", undefined);
    const target = location(GET(authorizeRequest(simulatedParams)));
    expect(`${target.origin}${target.pathname}`).toBe(STRIPE_CALLBACK);
    expect(target.searchParams.get("state")).toBe("state-sim");
    expect(target.searchParams.get("code")).toMatch(/^simulated-[0-9a-f-]{36}$/);
    expect(target.searchParams.get("granted_scope")).toBe(SIMULATED_SCOPE);
  });

  it("simulates cancel with error=access_denied and no code", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    const target = location(GET(authorizeRequest({ ...simulatedParams, error: "access_denied" })));
    expect(target.searchParams.get("error")).toBe("access_denied");
    expect(target.searchParams.has("code")).toBe(false);
  });

  it.each([
    ["an unknown provider", { ...simulatedParams, provider: "heroku" }],
    ["the fake provider named explicitly", { ...simulatedParams, provider: "fake" }],
    ["another provider's callback", { ...simulatedParams, redirect_uri: `${ORIGIN}/api/connections/vercel/callback` }],
    ["the callback on another origin", { ...simulatedParams, redirect_uri: "https://evil.example/api/connections/stripe/callback" }],
    ["a callback with a query", { ...simulatedParams, redirect_uri: `${STRIPE_CALLBACK}?next=/admin` }],
    ["state missing", { provider: "stripe", redirect_uri: STRIPE_CALLBACK, scope: SIMULATED_SCOPE }],
    ["a real scope", { ...simulatedParams, scope: "charge_read" }],
    ["scope missing", { provider: "stripe", state: "s", redirect_uri: STRIPE_CALLBACK }],
    ["a decline switch", { ...simulatedParams, decline: SIMULATED_SCOPE }],
    ["a mode switch", { ...simulatedParams, mode: "revoked" }],
    ["an unsupported error", { ...simulatedParams, error: "server_error" }],
    // Automatic webhook setup's write scope (#426): Stripe's twin declares none.
    ["a write scope the simulated adapter did not declare", { ...simulatedParams, scope: `${SIMULATED_SCOPE} ${SIMULATED_WEBHOOK_WRITE_SCOPE}` }],
    [
      "the write scope without the read scope",
      { ...simulatedParams, provider: "gitlab", redirect_uri: GITLAB_CALLBACK, scope: SIMULATED_WEBHOOK_WRITE_SCOPE },
    ],
    [
      "the declared write scope with another scope",
      { ...simulatedParams, provider: "gitlab", redirect_uri: GITLAB_CALLBACK, scope: `${SIMULATED_SCOPE} ${SIMULATED_WEBHOOK_WRITE_SCOPE} admin` },
    ],
  ])("answers 400 without redirecting for %s", (_title, params) => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    const response = GET(authorizeRequest(params));
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  it("grants the write scope a simulated adapter declares for automatic webhook setup (#426)", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    const scope = `${SIMULATED_SCOPE} ${SIMULATED_WEBHOOK_WRITE_SCOPE}`;
    const target = location(GET(authorizeRequest({ ...simulatedParams, provider: "gitlab", redirect_uri: GITLAB_CALLBACK, scope })));
    expect(target.searchParams.get("granted_scope")).toBe(scope);
  });

  it("round trips buildAuthorizeUrl -> route -> exchangeCode -> listAccounts for every live provider", async () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    const client = { clientId: "simulated", clientSecret: new Secret("simulated"), extra: {} };
    for (const adapter of Object.values(simulatedAdapters)) {
      const redirectUri = `${ORIGIN}/api/connections/${adapter.id}/callback`;
      const authorizeUrl = adapter.buildAuthorizeUrl({ client, state: "state-rt", redirectUri });
      const callbackParams = Object.fromEntries(location(GET(new Request(authorizeUrl))).searchParams);
      const code = callbackParams.code;
      if (code === undefined) throw new Error(`expected a code for ${adapter.id}`);
      const ctx = {
        fetch: vi.fn(() => Promise.reject(new Error("network is not allowed"))),
        now: () => new Date("2026-11-04T21:00:00.000Z"),
        timeoutMs: 5000,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        client,
      };
      const credential = await adapter.exchangeCode({ code, redirectUri, callbackParams }, ctx);
      expect(adapter.detectMissingPermissions(credential), adapter.id).toEqual([]);
      expect((await adapter.listAccounts(credential, ctx)).length, adapter.id).toBeGreaterThan(0);
      expect(ctx.fetch).not.toHaveBeenCalled();
    }
  });
});
