import { describe, expect, it } from "vitest";
import {
  AuthRevokedError,
  InvalidResponseError,
  PermissionMissingError,
  RateLimitedError,
} from "../errors";
import { validateAdapterEvents } from "../events";
import { validateAdapterMetrics } from "../metrics";
import { Secret, type FetchLike, type OAuthContext, type OAuthCredential } from "../types";
import { MAX_DOMAIN_PAGES, RESEND_TEAM_EXTERNAL_ID, RESEND_USER_AGENT, resendAdapter } from "./index";
import { parseResendTimestamp, RESEND_ISSUER } from "./schemas";
// Every fixture below is from documentation, not recorded: the sample responses in
// docs/providers/resend.md, trimmed, with synthetic ids, tokens, and values.
import domainsFixture from "./fixtures/domains.json";
// From documentation, not recorded: `GET /emails/metrics` sample, totals for the three counts we read.
import emailMetricsFixture from "./fixtures/email-metrics.json";
// From documentation, not recorded: `POST /oauth/token` sample after a refresh (rotated tokens).
import tokenRefreshedFixture from "./fixtures/token-refreshed.json";
// From documentation, not recorded: `POST /oauth/token` sample with scope set to full_access.
import tokenFixture from "./fixtures/token.json";
// From documentation, not recorded: `GET /usage` sample (Free plan limits).
import usageFixture from "./fixtures/usage.json";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const CLIENT_ID = "client-123";
const CLIENT_SECRET = "client-secret-xyz";
const EXPECTED_BASIC = `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;

type Call = { method: string; url: URL; headers: Headers; body: string | undefined };
type Route = (call: Call) => Response;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function harness(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const warnings: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    calls.push(call);
    // Resend blocks requests without a User-Agent with 403 (error 1010) before the API.
    if (!call.headers.has("user-agent")) {
      return json({ name: "missing_user_agent", message: "error code: 1010" }, 403);
    }
    const route = routes[`${call.method} ${call.url.pathname}`];
    if (route === undefined) return json({ message: "not found" }, 404);
    return route(call);
  };
  const ctx: OAuthContext = {
    fetch,
    now: () => NOW,
    timeoutMs: 5000,
    logger: {
      info: () => undefined,
      warn: (event) => {
        warnings.push(event);
      },
      error: () => undefined,
    },
    client: { clientId: CLIENT_ID, clientSecret: new Secret(CLIENT_SECRET), extra: {} },
  };
  return { ctx, calls, warnings };
}

const syncRoutes = (overrides: Record<string, Route> = {}): Record<string, Route> => ({
  "GET /usage": () => json(usageFixture),
  "GET /emails/metrics": () => json(emailMetricsFixture),
  "GET /domains": () => json(domainsFixture),
  ...overrides,
});

const credential: OAuthCredential = {
  accessToken: new Secret("synthetic-access-token-1"),
  refreshToken: new Secret("synthetic-refresh-token-1"),
  expiresAt: new Date(NOW.getTime() + 900_000),
  scopes: ["full_access"],
  tokenType: "Bearer",
};

const allPendingDomains = {
  ...domainsFixture,
  data: domainsFixture.data.map((domain) => ({ ...domain, status: "pending" })),
};

async function baselineCursor(): Promise<string> {
  const { ctx } = harness(syncRoutes({ "GET /domains": () => json(allPendingDomains) }));
  const result = await resendAdapter.sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID }, ctx);
  if (result.cursor === undefined) throw new Error("baseline sync returned no cursor");
  return result.cursor;
}

const verifier = "a".repeat(43);

describe("resendAdapter.buildAuthorizeUrl", () => {
  it("builds the authorize URL with state, redirect, full_access scope, and PKCE S256", () => {
    const url = resendAdapter.buildAuthorizeUrl({
      client: { clientId: CLIENT_ID, clientSecret: new Secret(CLIENT_SECRET), extra: {} },
      state: "state-abc",
      redirectUri: "https://stackdash.example/api/connections/resend/callback",
      codeChallenge: "challenge-xyz",
    });
    expect(`${url.origin}${url.pathname}`).toBe("https://api.resend.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: "https://stackdash.example/api/connections/resend/callback",
      scope: "full_access",
      state: "state-abc",
      code_challenge: "challenge-xyz",
      code_challenge_method: "S256",
    });
    expect(url.searchParams.has("client_secret")).toBe(false);
  });

  it.each<[string, { state: string; codeChallenge?: string }]>([
    ["missing PKCE challenge", { state: "s" }],
    ["empty state", { state: "", codeChallenge: "c" }],
    ["state over 1024 characters", { state: "s".repeat(1025), codeChallenge: "c" }],
  ])("rejects %s", (_title, params) => {
    expect(() =>
      resendAdapter.buildAuthorizeUrl({
        client: { clientId: CLIENT_ID, clientSecret: new Secret(CLIENT_SECRET), extra: {} },
        redirectUri: "https://stackdash.example/cb",
        ...params,
      }),
    ).toThrow();
  });

  it("declares full_access as full access with a plain reason", () => {
    const [permission] = resendAdapter.permissions;
    expect(permission?.scope).toBe("full_access");
    expect(permission?.access).toBe("full");
    if (permission?.access !== "full") throw new Error("expected a full access permission");
    expect(permission.fullAccessReason).toMatch(/send and delete email/);
    expect(permission.fullAccessReason).toMatch(/API keys/);
    expect(permission.fullAccessReason).toMatch(/only reads usage/);
  });
});

describe("resendAdapter.exchangeCode", () => {
  it("exchanges the code with Basic client auth, the PKCE verifier, and a User-Agent", async () => {
    const { ctx, calls } = harness({ "POST /oauth/token": () => json(tokenFixture) });
    const result = await resendAdapter.exchangeCode(
      {
        code: "code-1",
        redirectUri: "https://stackdash.example/cb",
        codeVerifier: verifier,
        callbackParams: { code: "code-1", state: "s", iss: RESEND_ISSUER },
      },
      ctx,
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.headers.get("authorization")).toBe(EXPECTED_BASIC);
    expect(call?.headers.get("user-agent")).toBe(RESEND_USER_AGENT);
    expect(call?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call?.body);
    expect(Object.fromEntries(form)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://stackdash.example/cb",
      code_verifier: verifier,
    });
    // Basic header plus a body secret fails with invalid_request at Resend.
    expect(form.has("client_secret")).toBe(false);

    expect(result.accessToken.reveal()).toBe("synthetic-access-token-1");
    expect(result.refreshToken?.reveal()).toBe("synthetic-refresh-token-1");
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + 900_000));
    expect(result.scopes).toEqual(["full_access"]);
    expect(result.tokenType).toBe("Bearer");
    expect(JSON.stringify(result)).not.toContain("synthetic-access-token-1");
  });

  it("falls back to the requested scope when the token response omits scope", async () => {
    const { scope: _omitted, ...withoutScope } = tokenFixture;
    const { ctx } = harness({ "POST /oauth/token": () => json(withoutScope) });
    const result = await resendAdapter.exchangeCode(
      { code: "c", redirectUri: "https://stackdash.example/cb", codeVerifier: verifier, callbackParams: { iss: RESEND_ISSUER } },
      ctx,
    );
    expect(result.scopes).toEqual(["full_access"]);
  });

  it.each([
    ["another issuer", { iss: "https://evil.example" }],
    ["no issuer", {}],
    ["an empty issuer", { iss: "" }],
  ])("refuses a callback with %s before calling the token endpoint", async (_title, callbackParams) => {
    const { ctx, calls } = harness({ "POST /oauth/token": () => json(tokenFixture) });
    await expect(
      resendAdapter.exchangeCode(
        { code: "c", redirectUri: "https://stackdash.example/cb", codeVerifier: verifier, callbackParams },
        ctx,
      ),
    ).rejects.toBeInstanceOf(InvalidResponseError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["missing verifier", undefined],
    ["verifier shorter than 43 characters", "a".repeat(42)],
    ["verifier with reserved characters", `${"a".repeat(42)}+`],
  ])("rejects a %s", async (_title, codeVerifier) => {
    const { ctx } = harness({ "POST /oauth/token": () => json(tokenFixture) });
    await expect(
      resendAdapter.exchangeCode(
        {
          code: "c",
          redirectUri: "https://stackdash.example/cb",
          callbackParams: { iss: RESEND_ISSUER },
          ...(codeVerifier === undefined ? {} : { codeVerifier }),
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("maps 400 invalid_grant (used or expired code) to auth revoked", async () => {
    const { ctx } = harness({
      "POST /oauth/token": () => json({ error: "invalid_grant", error_description: "expired" }, 400),
    });
    await expect(
      resendAdapter.exchangeCode(
        { code: "c", redirectUri: "https://stackdash.example/cb", codeVerifier: verifier, callbackParams: { iss: RESEND_ISSUER } },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("reports a token response schema mismatch as invalid_response", async () => {
    const { refresh_token: _omitted, ...withoutRefresh } = tokenFixture;
    const { ctx } = harness({ "POST /oauth/token": () => json(withoutRefresh) });
    await expect(
      resendAdapter.exchangeCode(
        { code: "c", redirectUri: "https://stackdash.example/cb", codeVerifier: verifier, callbackParams: { iss: RESEND_ISSUER } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("resendAdapter.refreshTokens", () => {
  it("rotates: sends the current refresh token and returns the NEW one", async () => {
    const { ctx, calls } = harness({ "POST /oauth/token": () => json(tokenRefreshedFixture) });
    const result = await resendAdapter.refreshTokens?.({ ...credential, metadata: { note: "kept" } }, ctx);
    if (result === undefined) throw new Error("resend must refresh tokens");

    const [call] = calls;
    expect(call?.headers.get("authorization")).toBe(EXPECTED_BASIC);
    expect(call?.headers.get("user-agent")).toBe(RESEND_USER_AGENT);
    expect(Object.fromEntries(new URLSearchParams(call?.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "synthetic-refresh-token-1",
    });
    expect(result.accessToken.reveal()).toBe("synthetic-access-token-2");
    expect(result.refreshToken?.reveal()).toBe("synthetic-refresh-token-2");
    expect(result.refreshToken?.reveal()).not.toBe(credential.refreshToken?.reveal());
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + 900_000));
    expect(result.metadata).toEqual({ note: "kept" });
  });

  it("maps a reused (already rotated) refresh token, 400 invalid_grant, to auth revoked", async () => {
    const { ctx } = harness({
      "POST /oauth/token": () => json({ error: "invalid_grant", error_description: "reused" }, 400),
    });
    await expect(resendAdapter.refreshTokens?.(credential, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("keeps other 400 token errors as invalid_response, not auth revoked", async () => {
    const { ctx } = harness({ "POST /oauth/token": () => json({ error: "invalid_request" }, 400) });
    await expect(resendAdapter.refreshTokens?.(credential, ctx)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it("rejects a refresh response without a rotated refresh token as invalid_response", async () => {
    const { refresh_token: _omitted, ...withoutRefresh } = tokenRefreshedFixture;
    const { ctx } = harness({ "POST /oauth/token": () => json(withoutRefresh) });
    await expect(resendAdapter.refreshTokens?.(credential, ctx)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("fails as auth revoked without a network call when there is no refresh token", async () => {
    const { ctx, calls } = harness({ "POST /oauth/token": () => json(tokenRefreshedFixture) });
    const { refreshToken: _omitted, ...accessOnly } = credential;
    await expect(resendAdapter.refreshTokens?.(accessOnly, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
    expect(calls).toHaveLength(0);
  });
});

describe("resendAdapter.revoke", () => {
  it("revokes the grant with the refresh token and accepts the documented empty 200 body", async () => {
    const { ctx, calls } = harness({ "POST /oauth/revoke": () => new Response("", { status: 200 }) });
    await expect(resendAdapter.revoke?.(credential, ctx)).resolves.toBeUndefined();
    const [call] = calls;
    expect(call?.headers.get("authorization")).toBe(EXPECTED_BASIC);
    expect(call?.headers.get("user-agent")).toBe(RESEND_USER_AGENT);
    expect(Object.fromEntries(new URLSearchParams(call?.body))).toEqual({
      token: "synthetic-refresh-token-1",
      token_type_hint: "refresh_token",
    });
  });

  it("surfaces a 5xx on revoke as provider unavailable", async () => {
    const { ctx } = harness({ "POST /oauth/revoke": () => json({}, 503) });
    await expect(resendAdapter.revoke?.(credential, ctx)).rejects.toMatchObject({ code: "provider_unavailable" });
  });
});

describe("resendAdapter.listAccounts", () => {
  it("returns one team per grant, labeled by the oldest domain (Postgres timestamps parsed)", async () => {
    const { ctx, calls } = harness(syncRoutes());
    const accounts = await resendAdapter.listAccounts(credential, ctx);
    expect(accounts).toEqual([
      { externalId: RESEND_TEAM_EXTERNAL_ID, displayName: "Resend team (news.example.org)", kind: "team" },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer synthetic-access-token-1");
  });

  it("labels the team generically when it has no domains (empty list)", async () => {
    const { ctx } = harness(syncRoutes({ "GET /domains": () => json({ ...domainsFixture, data: [] }) }));
    const accounts = await resendAdapter.listAccounts(credential, ctx);
    expect(accounts).toEqual([{ externalId: RESEND_TEAM_EXTERNAL_ID, displayName: "Resend team", kind: "team" }]);
  });
});

describe("resendAdapter.detectMissingPermissions", () => {
  it.each([
    ["full_access granted", ["full_access"], []],
    ["only emails:send granted", ["emails:send"], ["full_access"]],
    ["no scopes", [], ["full_access"]],
  ])("%s", (_title, scopes, missing) => {
    expect(resendAdapter.detectMissingPermissions({ scopes })).toEqual(missing);
  });
});

describe("resendAdapter.sync", () => {
  it("returns valid usage, allowance, and delivery metrics with a baseline cursor and no events", async () => {
    const { ctx, calls } = harness(syncRoutes());
    const result = await resendAdapter.sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID }, ctx);

    const metrics = validateAdapterMetrics("resend", result.metrics);
    expect(metrics.ok).toBe(true);
    expect(validateAdapterEvents(resendAdapter.eventTypes, result.events).ok).toBe(true);

    const byKey = new Map(result.metrics.map((metric) => [metric.metricKey, metric]));
    expect([...byKey.keys()]).toEqual([
      "resend.emails.daily.used",
      "resend.emails.daily.limit",
      "resend.emails.daily.remaining",
      "resend.emails.monthly.used",
      "resend.emails.monthly.limit",
      "resend.emails.monthly.remaining",
      "resend.delivery.delivered",
      "resend.delivery.bounced",
      "resend.delivery.complained",
    ]);
    expect(byKey.get("resend.emails.daily.used")).toMatchObject({
      kind: "usage",
      value: 10,
      unit: "emails",
      resetsAt: new Date("2026-07-29T00:00:00.000Z"),
      retrievedAt: NOW,
      provenance: { source: "provider_api", endpoint: "https://api.resend.com/usage" },
    });
    expect(byKey.get("resend.emails.monthly.limit")).toMatchObject({ kind: "included_allowance", value: 3000 });
    expect(byKey.get("resend.emails.monthly.remaining")).toMatchObject({
      kind: "remaining_allowance",
      value: 2900,
      resetsAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    expect(byKey.get("resend.delivery.bounced")).toMatchObject({
      kind: "usage",
      value: 20,
      timeframe: {
        type: "period",
        start: new Date("2026-07-21T12:00:00.000Z"),
        end: new Date("2026-07-28T12:00:00.000Z"),
      },
      provenance: { source: "provider_api", endpoint: "https://api.resend.com/emails/metrics" },
    });

    // First sync records a baseline only.
    expect(result.events).toEqual([]);
    expect(result.cursor).toBeDefined();
    expect(result.partialErrors).toBeUndefined();

    // Only the three documented GET routes, each with the bearer token and a User-Agent.
    expect(calls.map((call) => `${call.method} ${call.url.pathname}`)).toEqual([
      "GET /usage",
      "GET /emails/metrics",
      "GET /domains",
    ]);
    for (const call of calls) {
      expect(call.headers.get("user-agent")).toBe(RESEND_USER_AGENT);
      expect(call.headers.get("authorization")).toBe("Bearer synthetic-access-token-1");
    }
    const metricsQuery = calls[1]?.url.searchParams;
    expect(metricsQuery?.get("start_date")).toBe("2026-07-21T12:00:00.000Z");
    expect(metricsQuery?.get("end_date")).toBe("2026-07-28T12:00:00.000Z");
    expect(metricsQuery?.get("metrics")).toBe("delivered,bounced,complained");
  });

  it("collects no spend metrics (Resend has no billing API), so nothing is rounded", async () => {
    const { ctx } = harness(syncRoutes());
    const result = await resendAdapter.sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID }, ctx);
    for (const metric of result.metrics) {
      expect(["usage", "included_allowance", "remaining_allowance"]).toContain(metric.kind);
      expect(metric).not.toHaveProperty("amountMinor");
    }
  });

  it("floors remaining allowance at 0 when monthly used exceeds the limit (overage)", async () => {
    const overage = {
      ...usageFixture,
      emails: { ...usageFixture.emails, monthly: { ...usageFixture.emails.monthly, used: 3500 } },
    };
    const { ctx } = harness(syncRoutes({ "GET /usage": () => json(overage) }));
    const result = await resendAdapter.sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID }, ctx);
    const remaining = result.metrics.find((metric) => metric.metricKey === "resend.emails.monthly.remaining");
    expect(remaining).toMatchObject({ kind: "remaining_allowance", value: 0 });
    expect(validateAdapterMetrics("resend", result.metrics).ok).toBe(true);
  });

  it("omits daily allowance metrics when the daily limit is null (no cap on paid plans)", async () => {
    const paid = {
      ...usageFixture,
      emails: { ...usageFixture.emails, daily: { ...usageFixture.emails.daily, limit: null } },
    };
    const { ctx } = harness(syncRoutes({ "GET /usage": () => json(paid) }));
    const result = await resendAdapter.sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID }, ctx);
    const keys = result.metrics.map((metric) => metric.metricKey);
    expect(keys).toContain("resend.emails.daily.used");
    expect(keys).not.toContain("resend.emails.daily.limit");
    expect(keys).not.toContain("resend.emails.daily.remaining");
  });

  it("emits verified and failed domain events on status change, deduped by domain id and status", async () => {
    const cursor = await baselineCursor();
    const { ctx } = harness(syncRoutes());
    const result = await resendAdapter.sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID, cursor }, ctx);

    const events = validateAdapterEvents(resendAdapter.eventTypes, result.events);
    expect(events.ok).toBe(true);
    expect(result.events).toEqual([
      {
        typeId: "resend.domain.verified",
        occurredAt: NOW,
        severity: "success",
        title: "Domain example.com verified",
        externalAccountId: RESEND_TEAM_EXTERNAL_ID,
        dedupeKey: "resend.domain:00000000-0000-4000-8000-000000000001:verified",
      },
      {
        typeId: "resend.domain.failed",
        occurredAt: NOW,
        severity: "critical",
        title: "Domain mail.example.net failed verification",
        body: expect.stringContaining("72 hours"),
        externalAccountId: RESEND_TEAM_EXTERNAL_ID,
        dedupeKey: "resend.domain:00000000-0000-4000-8000-000000000002:failed",
      },
    ]);
    expect(result.events.every((event) => event.url === undefined)).toBe(true);
  });

  it("duplicate events across two syncs of the same input produce identical dedupe keys", async () => {
    const cursor = await baselineCursor();
    const first = await resendAdapter.sync(
      { credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID, cursor },
      harness(syncRoutes()).ctx,
    );
    const second = await resendAdapter.sync(
      { credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID, cursor },
      harness(syncRoutes()).ctx,
    );
    expect(second.events.map((event) => event.dedupeKey)).toEqual(first.events.map((event) => event.dedupeKey));
    expect(second.metrics.map((metric) => metric.metricKey)).toEqual(first.metrics.map((metric) => metric.metricKey));
    expect(second.cursor).toBe(first.cursor);
  });

  it("emits nothing new once the cursor has recorded the changed statuses", async () => {
    const cursor = await baselineCursor();
    const first = await resendAdapter.sync(
      { credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID, cursor },
      harness(syncRoutes()).ctx,
    );
    const next = await resendAdapter.sync(
      {
        credential,
        externalAccountId: RESEND_TEAM_EXTERNAL_ID,
        ...(first.cursor === undefined ? {} : { cursor: first.cursor }),
      },
      harness(syncRoutes()).ctx,
    );
    expect(first.events).toHaveLength(2);
    expect(next.events).toEqual([]);
  });

  it("re-baselines on an unreadable cursor instead of failing", async () => {
    const { ctx, warnings } = harness(syncRoutes());
    const result = await resendAdapter.sync(
      { credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID, cursor: "not json" },
      ctx,
    );
    expect(result.events).toEqual([]);
    expect(result.cursor).toBeDefined();
    expect(warnings).toContain("resend.sync.cursor_unreadable");
  });

  it("handles empty lists: no domains and zero delivery totals", async () => {
    const { ctx } = harness(
      syncRoutes({
        "GET /domains": () => json({ ...domainsFixture, data: [] }),
        "GET /emails/metrics": () =>
          json({ ...emailMetricsFixture, totals: { delivered: 0, bounced: 0, complained: 0 } }),
      }),
    );
    const result = await resendAdapter.sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID }, ctx);
    expect(validateAdapterMetrics("resend", result.metrics).ok).toBe(true);
    expect(result.events).toEqual([]);
    expect(result.cursor).toBeDefined();
  });

  it(`stops domain pagination at the cap of ${MAX_DOMAIN_PAGES} pages and keeps unreached statuses`, async () => {
    let page = 0;
    const endless: Route = () => {
      page += 1;
      return json({
        object: "list",
        has_more: true,
        data: [
          {
            id: `11111111-0000-4000-8000-${String(page).padStart(12, "0")}`,
            name: `d${page}.example.com`,
            status: "pending",
            created_at: "2026-04-26 20:21:26+00",
          },
        ],
      });
    };
    const cursor = await baselineCursor();
    const { ctx, calls, warnings } = harness(syncRoutes({ "GET /domains": endless }));
    const result = await resendAdapter.sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID, cursor }, ctx);

    const domainCalls = calls.filter((call) => call.url.pathname === "/domains");
    expect(domainCalls).toHaveLength(MAX_DOMAIN_PAGES);
    expect(domainCalls[0]?.url.searchParams.has("after")).toBe(false);
    expect(domainCalls[1]?.url.searchParams.get("after")).toBe("11111111-0000-4000-8000-000000000001");
    expect(warnings).toContain("resend.sync.domain_page_cap");

    // The fixture domains were not reached; a later complete listing must still diff against them.
    const later = await resendAdapter.sync(
      {
        credential,
        externalAccountId: RESEND_TEAM_EXTERNAL_ID,
        ...(result.cursor === undefined ? {} : { cursor: result.cursor }),
      },
      harness(syncRoutes()).ctx,
    );
    expect(later.events.map((event) => event.typeId)).toEqual(["resend.domain.verified", "resend.domain.failed"]);
  });

  it("returns the rest of the data with a partial error when /emails/metrics is refused (403)", async () => {
    const { ctx } = harness(
      syncRoutes({ "GET /emails/metrics": () => json({ name: "invalid_permission" }, 403) }),
    );
    const result = await resendAdapter.sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID }, ctx);
    expect(result.metrics.some((metric) => metric.metricKey === "resend.emails.monthly.used")).toBe(true);
    expect(result.metrics.some((metric) => metric.metricKey.startsWith("resend.delivery."))).toBe(false);
    expect(result.cursor).toBeDefined();
    expect(result.partialErrors).toHaveLength(1);
    expect(result.partialErrors?.[0]).toBeInstanceOf(PermissionMissingError);
    expect(result.partialErrors?.[0]?.missingScopes).toEqual(["full_access"]);
  });

  it("throws auth revoked on 401", async () => {
    const { ctx } = harness(syncRoutes({ "GET /usage": () => json({ name: "unauthorized" }, 401) }));
    await expect(
      resendAdapter.sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID }, ctx),
    ).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws rate limited on 429 with Retry-After in seconds", async () => {
    const { ctx } = harness(
      syncRoutes({
        "GET /domains": () => json({ name: "rate_limit_exceeded" }, 429, { "retry-after": "30" }),
      }),
    );
    const error = await resendAdapter
      .sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID }, ctx)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    if (!(error instanceof RateLimitedError)) throw new Error("expected RateLimitedError");
    expect(error.retryAfterMs).toBe(30_000);
  });

  it.each([
    ["/usage missing emails", "GET /usage", { object: "usage" }],
    ["/domains unknown status", "GET /domains", {
      ...domainsFixture,
      data: [{ ...domainsFixture.data[0], status: "mystery" }],
    }],
    ["/domains unparseable created_at", "GET /domains", {
      ...domainsFixture,
      data: [{ ...domainsFixture.data[0], created_at: "yesterday" }],
    }],
  ])("reports a response schema mismatch (%s) as invalid_response", async (_title, route, body) => {
    const { ctx } = harness(syncRoutes({ [route]: () => json(body) }));
    await expect(
      resendAdapter.sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID }, ctx),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("is refused with 403 when the User-Agent is missing (fake mirrors Resend), and the adapter always sends it", async () => {
    const { ctx, calls } = harness(syncRoutes());
    await resendAdapter.sync({ credential, externalAccountId: RESEND_TEAM_EXTERNAL_ID }, ctx);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.headers.get("user-agent") === RESEND_USER_AGENT)).toBe(true);

    const bare = await ctx.fetch("https://api.resend.com/usage", { method: "GET" });
    expect(bare.status).toBe(403);
  });
});

describe("parseResendTimestamp", () => {
  it.each([
    ["Postgres microseconds and +00", "2026-04-26 20:21:26.347412+00", "2026-04-26T20:21:26.347Z"],
    ["no fraction", "2026-05-02 08:00:00+00", "2026-05-02T08:00:00.000Z"],
    ["one digit fraction", "2026-03-10 09:15:00.5+00", "2026-03-10T09:15:00.500Z"],
    ["non-UTC offset with minutes", "2026-03-10 09:15:00+05:30", "2026-03-10T03:45:00.000Z"],
    ["strict ISO with Z", "2026-03-10T09:15:00.000Z", "2026-03-10T09:15:00.000Z"],
  ])("parses %s as UTC", (_title, input, expected) => {
    expect(parseResendTimestamp(input)?.toISOString()).toBe(expected);
  });

  it.each([
    ["empty string", ""],
    ["missing zone", "2026-04-26 20:21:26"],
    ["impossible date", "2026-13-40 20:21:26+00"],
    ["prose", "yesterday"],
  ])("rejects %s", (_title, input) => {
    expect(parseResendTimestamp(input)).toBeUndefined();
  });
});
