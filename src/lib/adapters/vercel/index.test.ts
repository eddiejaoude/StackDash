import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  AuthRevokedError,
  InvalidResponseError,
  PermissionMissingError,
  RateLimitedError,
} from "../errors";
import { validateAdapterEvents } from "../events";
import { validateAdapterMetrics } from "../metrics";
import { Secret, type FetchLike, type OAuthContext, type OAuthCredential } from "../types";
import { MAX_DEPLOYMENT_PAGES, vercelAdapter } from "./index";

// Every fixture below is from documentation, not recorded: the sample payloads on
// docs/providers/vercel.md (Vercel REST API reference examples), trimmed, with synthetic ids and
// amounts. Replace them with sanitized recordings from a Pro test team once one exists (#47).
// - token-team.json / token-hobby.json: POST /v2/oauth/access_token, team and Hobby installs.
import tokenHobby from "./fixtures/token-hobby.json";
import tokenTeam from "./fixtures/token-team.json";
// - team.json: GET /v2/teams/{teamId}.
import team from "./fixtures/team.json";
// - deployments-page-1.json / deployments-page-2.json: GET /v7/deployments, two pages. Page 1
//   carries creator and Git meta fields so the tests prove they are dropped; page 2 uses the
//   documentation's string-typed timestamps.
import deploymentsPage1 from "./fixtures/deployments-page-1.json";
import deploymentsPage2 from "./fixtures/deployments-page-2.json";

// - billing-charges.jsonl: GET /v1/billing/charges FOCUS rows, one per line, with sub-cent usage
//   amounts so the single rounding step is observable.
const billingJsonl = readFileSync(new URL("./fixtures/billing-charges.jsonl", import.meta.url), "utf8");

const NOW = new Date("2026-10-31T12:00:00Z");
const ACCESS_TOKEN = tokenTeam.access_token;
const TEAM_ID = "team_LLHUOMOoDlqOp8wPE4kFo9pE";
const USER_ID = "2tUzTmv4ljvFVHifEf9TGdpH";
const CONFIGURATION_ID = "icfg_6uKSUQ359QCbPfECTAY9murE";
const HOUR_MS = 60 * 60 * 1000;

type Call = { url: URL; init: RequestInit | undefined };
type Route = (url: URL) => Response;

function emptyDeployments(): Response {
  return Response.json({ deployments: [], pagination: { count: 0, next: null, prev: null } });
}

function jsonl(rows: readonly object[]): Response {
  return new Response(rows.map((row) => JSON.stringify(row)).join("\n"), {
    headers: { "content-type": "application/jsonl" },
  });
}

/** Fake Vercel API serving the fixtures, with per-path overrides and a call log. */
function fakeVercel(overrides: Readonly<Record<string, Route>> = {}) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const override = overrides[url.pathname];
    if (override !== undefined) return override(url);
    switch (url.pathname) {
      case "/v2/oauth/access_token":
        return Response.json(tokenTeam);
      case `/v2/teams/${TEAM_ID}`:
        return Response.json(team);
      case "/v7/deployments":
        return Response.json(url.searchParams.has("until") ? deploymentsPage2 : deploymentsPage1);
      case "/v1/billing/charges":
        return new Response(billingJsonl, { headers: { "content-type": "application/jsonl" } });
      default:
        return new Response(null, { status: 404 });
    }
  };
  const callsTo = (pathname: string) => calls.filter((call) => call.url.pathname === pathname);
  return { fetch, calls, callsTo };
}

function makeCtx(fetch: FetchLike, extra: Record<string, Secret> = { integrationSlug: new Secret("stackdash-local") }) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: OAuthContext = {
    fetch,
    now: () => NOW,
    timeoutMs: 1000,
    logger,
    client: { clientId: "oac_exampleClientId", clientSecret: new Secret("example-client-secret"), extra },
  };
  return { ctx, logger };
}

const teamCredential: OAuthCredential = {
  accessToken: new Secret(ACCESS_TOKEN),
  scopes: [...vercelAdapter.oauth.scopes],
  tokenType: "Bearer",
  metadata: { configurationId: CONFIGURATION_ID, userId: USER_ID, teamId: TEAM_ID },
};

const hobbyCredential: OAuthCredential = {
  ...teamCredential,
  metadata: { configurationId: "icfg_ijgU3GzRxyz7nGpwwsSmbNkI", userId: USER_ID },
};

const teamSync = { credential: teamCredential, externalAccountId: TEAM_ID };

function amounts(metrics: readonly { metricKey: string }[]) {
  return Object.fromEntries(
    metrics.map((metric) => [metric.metricKey, "amountMinor" in metric ? metric.amountMinor : undefined]),
  );
}

describe("vercelAdapter declaration", () => {
  it("polls hourly, declares no refresh or revoke, and discloses that deployment read includes build logs", () => {
    expect(vercelAdapter.pollIntervalSeconds).toBe(3600);
    expect(vercelAdapter.refreshTokens).toBeUndefined();
    expect(vercelAdapter.revoke).toBeUndefined();
    expect(vercelAdapter.oauth.pkce).toBe(false);
    expect(vercelAdapter.oauth.extraEnv).toEqual({ integrationSlug: "VERCEL_INTEGRATION_SLUG" });
    const deployment = vercelAdapter.permissions.find((permission) => permission.scope === "deployment:read");
    expect(deployment?.description).toMatch(/build logs/);
    expect(vercelAdapter.permissions.every((permission) => permission.access === "read")).toBe(true);
  });
});

describe("vercelAdapter.buildAuthorizeUrl", () => {
  it("builds the integration install URL from the slug with state only (no PKCE, no redirect)", () => {
    const { ctx } = makeCtx(fakeVercel().fetch);
    const url = vercelAdapter.buildAuthorizeUrl({
      client: ctx.client,
      state: "xyzABC123",
      redirectUri: "https://stackdash.example/api/connections/vercel/callback",
      codeChallenge: "ignored-challenge",
    });

    expect(url.origin + url.pathname).toBe("https://vercel.com/integrations/stackdash-local/new");
    expect([...url.searchParams.entries()]).toEqual([["state", "xyzABC123"]]);
  });

  it.each([
    { name: "missing slug", extra: {} },
    { name: "whitespace-only slug", extra: { integrationSlug: new Secret("   ") } },
    { name: "slug longer than 32 characters", extra: { integrationSlug: new Secret("a".repeat(33)) } },
  ])("rejects a $name", ({ extra }) => {
    const { ctx } = makeCtx(fakeVercel().fetch, extra);
    expect(() =>
      vercelAdapter.buildAuthorizeUrl({ client: ctx.client, state: "s", redirectUri: "https://x.example/cb" }),
    ).toThrow(/VERCEL_INTEGRATION_SLUG/);
  });
});

describe("vercelAdapter.exchangeCode", () => {
  const callbackParams = {
    code: "jMIukZ1DBCKXHje3X14BCkU0",
    configurationId: CONFIGURATION_ID,
    teamId: TEAM_ID,
    state: "xyzABC123",
    next: "https://vercel.com/acme",
    source: "external",
  };
  const exchangeInput = {
    code: "jMIukZ1DBCKXHje3X14BCkU0",
    redirectUri: "https://stackdash.example/api/connections/vercel/callback",
    callbackParams,
  };

  it("posts the form-encoded code and stores team and configuration ids as metadata", async () => {
    const api = fakeVercel();
    const { ctx } = makeCtx(api.fetch);

    const credential = await vercelAdapter.exchangeCode(exchangeInput, ctx);

    const [call] = api.callsTo("/v2/oauth/access_token");
    expect(call?.init?.method).toBe("POST");
    const body = call?.init?.body;
    if (!(body instanceof URLSearchParams)) throw new Error("expected a form body");
    expect(Object.fromEntries(body.entries())).toEqual({
      client_id: "oac_exampleClientId",
      client_secret: "example-client-secret",
      code: "jMIukZ1DBCKXHje3X14BCkU0",
      redirect_uri: "https://stackdash.example/api/connections/vercel/callback",
    });
    expect(credential.accessToken.reveal()).toBe(ACCESS_TOKEN);
    expect(credential.metadata).toEqual({ configurationId: CONFIGURATION_ID, userId: USER_ID, teamId: TEAM_ID });
    expect(credential.tokenType).toBe("Bearer");
    expect(credential.scopes).toEqual(vercelAdapter.oauth.scopes);
    expect(credential.refreshToken).toBeUndefined();
    expect(credential.expiresAt).toBeUndefined();
    expect(JSON.stringify(credential)).not.toContain(ACCESS_TOKEN);
  });

  it("omits teamId from metadata for a Hobby install (team_id null, no teamId callback param)", async () => {
    const api = fakeVercel({ "/v2/oauth/access_token": () => Response.json(tokenHobby) });
    const { ctx } = makeCtx(api.fetch);
    const hobbyParams = {
      code: callbackParams.code,
      configurationId: tokenHobby.installation_id,
      state: callbackParams.state,
      next: callbackParams.next,
      source: callbackParams.source,
    };

    const credential = await vercelAdapter.exchangeCode(
      { ...exchangeInput, callbackParams: hobbyParams },
      ctx,
    );

    expect(credential.metadata).toEqual({ configurationId: tokenHobby.installation_id, userId: USER_ID });
  });

  it.each([
    { name: "callback configurationId differs from installation_id", params: { configurationId: "icfg_other" } },
    { name: "callback teamId differs from team_id", params: { teamId: "team_other" } },
  ])("rejects a tampered callback: $name", async ({ params }) => {
    const { ctx } = makeCtx(fakeVercel().fetch);
    await expect(
      vercelAdapter.exchangeCode({ ...exchangeInput, callbackParams: { ...callbackParams, ...params } }, ctx),
    ).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it("maps a token response schema mismatch (no access_token) to invalid_response", async () => {
    const api = fakeVercel({
      "/v2/oauth/access_token": () => Response.json({ ...tokenTeam, access_token: undefined }),
    });
    const { ctx } = makeCtx(api.fetch);
    await expect(vercelAdapter.exchangeCode(exchangeInput, ctx)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("vercelAdapter.listAccounts", () => {
  it("returns the team the grant covers, read with the bearer token and teamId", async () => {
    const api = fakeVercel();
    const { ctx } = makeCtx(api.fetch);

    await expect(vercelAdapter.listAccounts(teamCredential, ctx)).resolves.toEqual([
      { externalId: TEAM_ID, displayName: "My Team", kind: "team" },
    ]);
    const [call] = api.calls;
    expect(call?.url.searchParams.get("teamId")).toBe(TEAM_ID);
    expect(new Headers(call?.init?.headers).get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
  });

  it("returns the personal account without a request for a Hobby install", async () => {
    const api = fakeVercel();
    const { ctx } = makeCtx(api.fetch);

    await expect(vercelAdapter.listAccounts(hobbyCredential, ctx)).resolves.toEqual([
      { externalId: USER_ID, displayName: "Vercel personal account", kind: "user" },
    ]);
    expect(api.calls).toHaveLength(0);
  });

  it("falls back to the slug when the team name is empty", async () => {
    const api = fakeVercel({ [`/v2/teams/${TEAM_ID}`]: () => Response.json({ ...team, name: "" }) });
    const { ctx } = makeCtx(api.fetch);
    await expect(vercelAdapter.listAccounts(teamCredential, ctx)).resolves.toEqual([
      { externalId: TEAM_ID, displayName: "my-team", kind: "team" },
    ]);
  });

  it("asks for reconnection when the credential has no installation metadata", async () => {
    const { ctx } = makeCtx(fakeVercel().fetch);
    const bare: OAuthCredential = {
      accessToken: teamCredential.accessToken,
      scopes: teamCredential.scopes,
      tokenType: teamCredential.tokenType,
    };
    await expect(vercelAdapter.listAccounts(bare, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("vercelAdapter.detectMissingPermissions", () => {
  it("reports nothing for the full grant", () => {
    expect(vercelAdapter.detectMissingPermissions({ scopes: [...vercelAdapter.oauth.scopes] })).toEqual([]);
  });

  it("reports the scopes absent from an empty or partial grant", () => {
    expect(vercelAdapter.detectMissingPermissions({ scopes: [] })).toEqual(vercelAdapter.oauth.scopes);
    expect(
      vercelAdapter.detectMissingPermissions({ scopes: ["deployment:read", "project:read", "team:read"] }),
    ).toEqual(["billing:read"]);
  });
});

describe("vercelAdapter.sync", () => {
  it("returns validated month-to-date spend per category, deployment events, and the latest created cursor", async () => {
    const api = fakeVercel();
    const { ctx } = makeCtx(api.fetch);

    const result = await vercelAdapter.sync(teamSync, ctx);

    const metrics = validateAdapterMetrics("vercel", result.metrics);
    expect(metrics.ok).toBe(true);
    // Usage rows 12.345 + 0.004 + 0.004 + 0.004 = 12.357 USD, rounded once to 1236 cents.
    // Credit (-5.10) and Adjustment (-0.25) are netted into the total: 29.507 -> 2951.
    expect(amounts(result.metrics)).toEqual({
      "vercel.spend.usage": 1236,
      "vercel.spend.purchase": 2000,
      "vercel.spend.tax": 250,
      "vercel.spend.total": 2951,
    });
    for (const metric of result.metrics) {
      expect(metric).toMatchObject({
        kind: "verified_spend",
        currency: "USD",
        externalAccountId: TEAM_ID,
        retrievedAt: NOW,
        provenance: { source: "provider_api", endpoint: "https://api.vercel.com/v1/billing/charges" },
        timeframe: {
          type: "period",
          start: new Date("2026-10-01T00:00:00Z"),
          end: new Date("2026-11-01T00:00:00Z"),
        },
      });
    }

    const events = validateAdapterEvents(vercelAdapter.eventTypes, result.events);
    expect(events.ok).toBe(true);
    expect(result.events.map((event) => [event.typeId, event.dedupeKey])).toEqual([
      ["vercel.deployment.succeeded", "dpl_2euZBFqxYdDMDG1jTrHFnNZ2eUVa:READY"],
      ["vercel.deployment.failed", "dpl_3fErC2xYdDMDG1jTrHFnNZ2eUVc:ERROR"],
      ["vercel.deployment.succeeded", "dpl_5gOlD2xYdDMDG1jTrHFnNZ2eUVd:READY"],
    ]);
    expect(result.events[0]).toMatchObject({
      title: "Production deployment of docs succeeded",
      severity: "success",
      occurredAt: new Date("2026-10-31T11:05:00Z"),
      url: "https://vercel.com/acme/docs/J1hXN00qjUeoYfpEEf7dnDtpSiVq",
    });
    expect(result.events[1]).toEqual({
      typeId: "vercel.deployment.failed",
      occurredAt: new Date(1793441100000),
      severity: "critical",
      title: "Production deployment of web failed",
      body: "Error code: BUILD_FAILED",
      externalAccountId: TEAM_ID,
      dedupeKey: "dpl_3fErC2xYdDMDG1jTrHFnNZ2eUVc:ERROR",
    });
    const serialized = JSON.stringify(result.events);
    for (const personal of ["dev@example.com", "example-dev", "usr_example", "example commit"]) {
      expect(serialized).not.toContain(personal);
    }
    expect(result.cursor).toBe("1793444400000");
    expect(result.partialErrors).toBeUndefined();

    const deploymentCalls = api.callsTo("/v7/deployments");
    expect(deploymentCalls.map((call) => Object.fromEntries(call.url.searchParams))).toEqual([
      { since: String(NOW.getTime() - 7 * 24 * HOUR_MS), limit: "100", teamId: TEAM_ID },
      { since: String(NOW.getTime() - 7 * 24 * HOUR_MS), limit: "100", until: "1793440799999", teamId: TEAM_ID },
    ]);
    const [billingCall] = api.callsTo("/v1/billing/charges");
    expect(Object.fromEntries(billingCall?.url.searchParams ?? [])).toEqual({
      from: "2026-10-01T00:00:00.000Z",
      to: "2026-11-01T00:00:00.000Z",
      teamId: TEAM_ID,
    });
    for (const call of api.calls) {
      expect(new Headers(call.init?.headers).get("authorization")).toBe(`Bearer ${ACCESS_TOKEN}`);
      expect(call.url.pathname).not.toMatch(/^\/v\d+\/projects\/|\/env/);
    }
  });

  it("produces identical metric keys and event dedupe keys for duplicate events across two syncs", async () => {
    const api = fakeVercel();
    const { ctx } = makeCtx(api.fetch);

    const first = await vercelAdapter.sync(teamSync, ctx);
    const second = await vercelAdapter.sync({ ...teamSync, ...(first.cursor === undefined ? {} : { cursor: first.cursor }) }, ctx);

    expect(second.events.map((event) => event.dedupeKey)).toEqual(first.events.map((event) => event.dedupeKey));
    expect(second.metrics.map((metric) => metric.metricKey)).toEqual(first.metrics.map((metric) => metric.metricKey));
    expect(second.cursor).toBe(first.cursor);
    // The second sync reads from the cursor minus the one hour overlap, not the first-sync lookback.
    const secondSyncFirstPage = api.callsTo("/v7/deployments")[2];
    expect(secondSyncFirstPage?.url.searchParams.get("since")).toBe(String(1793444400000 - HOUR_MS));
  });

  it("returns zero spend, no events, and no cursor for empty lists on the first sync", async () => {
    const api = fakeVercel({
      "/v7/deployments": emptyDeployments,
      "/v1/billing/charges": () => new Response(""),
    });
    const { ctx } = makeCtx(api.fetch);

    const result = await vercelAdapter.sync(teamSync, ctx);

    expect(amounts(result.metrics)).toEqual({
      "vercel.spend.usage": 0,
      "vercel.spend.purchase": 0,
      "vercel.spend.tax": 0,
      "vercel.spend.total": 0,
    });
    expect(result.events).toEqual([]);
    expect(result.cursor).toBeUndefined();
    expect(api.callsTo("/v7/deployments")).toHaveLength(1);
  });

  it("keeps the previous cursor when an empty list follows a sync", async () => {
    const api = fakeVercel({ "/v7/deployments": emptyDeployments });
    const { ctx } = makeCtx(api.fetch);
    const result = await vercelAdapter.sync({ ...teamSync, cursor: "1793444400000" }, ctx);
    expect(result.cursor).toBe("1793444400000");
  });

  it(`stops at the pagination cap of ${MAX_DEPLOYMENT_PAGES} pages and reports the cursor`, async () => {
    let page = 0;
    const api = fakeVercel({
      "/v7/deployments": () => {
        page += 1;
        const created = 1793444400000 - page * 1000;
        return Response.json({
          deployments: [{ uid: `dpl_page${page}`, name: "docs", readyState: "READY", created, ready: created }],
          pagination: { next: created - 1 },
        });
      },
    });
    const { ctx, logger } = makeCtx(api.fetch);

    const result = await vercelAdapter.sync(teamSync, ctx);

    expect(api.callsTo("/v7/deployments")).toHaveLength(MAX_DEPLOYMENT_PAGES);
    expect(result.events).toHaveLength(MAX_DEPLOYMENT_PAGES);
    expect(result.cursor).toBe(String(1793444400000 - 1000));
    expect(logger.warn).toHaveBeenCalledWith("vercel.deployments.page_cap_reached", { pages: MAX_DEPLOYMENT_PAGES });
  });

  it("returns events with a billing permission_missing partial error and no metrics on billing 403 (Hobby plan or role)", async () => {
    const api = fakeVercel({
      "/v1/billing/charges": () => Response.json({ error: { code: "forbidden" } }, { status: 403 }),
    });
    const { ctx } = makeCtx(api.fetch);

    const result = await vercelAdapter.sync(teamSync, ctx);

    expect(result.metrics).toEqual([]);
    expect(result.events).toHaveLength(3);
    expect(result.cursor).toBe("1793444400000");
    expect(result.partialErrors).toHaveLength(1);
    const [partial] = result.partialErrors ?? [];
    expect(partial).toBeInstanceOf(PermissionMissingError);
    expect(partial?.missingScopes).toEqual(["billing:read"]);
    expect(partial?.status).toBe(403);
    expect(partial?.message).toMatch(/Pro or Enterprise/);
    expect(partial?.message).not.toContain(ACCESS_TOKEN);
  });

  it("skips billing for a Hobby account and reports it as a partial error, without teamId on requests", async () => {
    const api = fakeVercel();
    const { ctx } = makeCtx(api.fetch);

    const result = await vercelAdapter.sync({ credential: hobbyCredential, externalAccountId: USER_ID }, ctx);

    expect(api.callsTo("/v1/billing/charges")).toHaveLength(0);
    expect(api.calls.every((call) => !call.url.searchParams.has("teamId"))).toBe(true);
    expect(result.metrics).toEqual([]);
    expect(result.events.every((event) => event.externalAccountId === USER_ID)).toBe(true);
    expect(result.partialErrors?.[0]?.missingScopes).toEqual(["billing:read"]);
  });

  it("fails the whole sync on a deployments 403 (disabled installation)", async () => {
    const api = fakeVercel({
      "/v7/deployments": () =>
        Response.json({ error: { code: "integration_configuration_disabled" } }, { status: 403 }),
    });
    const { ctx } = makeCtx(api.fetch);
    await expect(vercelAdapter.sync(teamSync, ctx)).rejects.toBeInstanceOf(PermissionMissingError);
  });

  it.each([
    { name: "deployments", path: "/v7/deployments" },
    { name: "billing", path: "/v1/billing/charges" },
  ])("maps a $name 401 to an auth revoked error", async ({ path }) => {
    const api = fakeVercel({ [path]: () => new Response(null, { status: 401 }) });
    const { ctx } = makeCtx(api.fetch);
    await expect(vercelAdapter.sync(teamSync, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it.each([
    { name: "deployments", path: "/v7/deployments" },
    { name: "billing", path: "/v1/billing/charges" },
  ])("maps a $name 429 with Retry-After to rate_limited with the delay", async ({ path }) => {
    const api = fakeVercel({
      [path]: () =>
        Response.json(
          { error: { code: "rate_limited", limit: { remaining: 0, resetMs: 1793448030000 } } },
          { status: 429, headers: { "Retry-After": "30" } },
        ),
    });
    const { ctx } = makeCtx(api.fetch);
    const error = await vercelAdapter.sync(teamSync, ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ code: "rate_limited", retryAfterMs: 30_000 });
  });

  it.each([
    {
      name: "deployment without uid",
      path: "/v7/deployments",
      route: () => Response.json({ deployments: [{ name: "docs", readyState: "READY", created: 1 }], pagination: { next: null } }),
    },
    { name: "billing line that is not JSON", path: "/v1/billing/charges", route: () => new Response('{"BilledCost":1\nnot json') },
    {
      name: "billing row with an unknown charge category",
      path: "/v1/billing/charges",
      route: () => jsonl([{ BilledCost: 1, BillingCurrency: "USD", ChargeCategory: "Refund" }]),
    },
    {
      name: "billing row with a non-decimal amount",
      path: "/v1/billing/charges",
      route: () => jsonl([{ BilledCost: "12,50", BillingCurrency: "USD", ChargeCategory: "Usage" }]),
    },
  ])("maps a response schema mismatch ($name) to invalid_response", async ({ path, route }) => {
    const api = fakeVercel({ [path]: route });
    const { ctx } = makeCtx(api.fetch);
    await expect(vercelAdapter.sync(teamSync, ctx)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("skips non-USD billing rows instead of summing them as dollars", async () => {
    const api = fakeVercel({
      "/v1/billing/charges": () =>
        jsonl([
          { BilledCost: 10, BillingCurrency: "EUR", ChargeCategory: "Usage" },
          { BilledCost: 1.5, BillingCurrency: "USD", ChargeCategory: "Usage" },
        ]),
    });
    const { ctx, logger } = makeCtx(api.fetch);

    const result = await vercelAdapter.sync(teamSync, ctx);

    expect(amounts(result.metrics)["vercel.spend.usage"]).toBe(150);
    expect(logger.warn).toHaveBeenCalledWith("vercel.billing.non_usd_rows_skipped", { count: 1 });
  });

  it("omits the total when credits exceed charges (negative net) and keeps the category metrics", async () => {
    const api = fakeVercel({
      "/v1/billing/charges": () =>
        jsonl([
          { BilledCost: 1, BillingCurrency: "USD", ChargeCategory: "Usage" },
          { BilledCost: -5, BillingCurrency: "USD", ChargeCategory: "Credit" },
        ]),
    });
    const { ctx } = makeCtx(api.fetch);

    const result = await vercelAdapter.sync(teamSync, ctx);

    expect(amounts(result.metrics)).toEqual({
      "vercel.spend.usage": 100,
      "vercel.spend.purchase": 0,
      "vercel.spend.tax": 0,
    });
    expect(validateAdapterMetrics("vercel", result.metrics).ok).toBe(true);
  });

  it("rounds money once, half to even, on the exact sum (0.005 + 0.005 + 0.0049 -> 1 cent, not 0 per row)", async () => {
    const api = fakeVercel({
      "/v1/billing/charges": () =>
        jsonl([
          { BilledCost: 0.005, BillingCurrency: "USD", ChargeCategory: "Usage" },
          { BilledCost: 0.005, BillingCurrency: "USD", ChargeCategory: "Usage" },
          { BilledCost: "0.0049", BillingCurrency: "USD", ChargeCategory: "Usage" },
        ]),
    });
    const { ctx } = makeCtx(api.fetch);

    const result = await vercelAdapter.sync(teamSync, ctx);

    // Exact sum 0.0149 -> 1 cent; rounding each row half to even first would give 0 + 0 + 0.
    expect(amounts(result.metrics)["vercel.spend.usage"]).toBe(1);
  });

  it("ignores a malformed cursor and falls back to the first-sync lookback", async () => {
    const api = fakeVercel();
    const { ctx, logger } = makeCtx(api.fetch);

    await vercelAdapter.sync({ ...teamSync, cursor: "not-a-timestamp" }, ctx);

    expect(api.callsTo("/v7/deployments")[0]?.url.searchParams.get("since")).toBe(
      String(NOW.getTime() - 7 * 24 * HOUR_MS),
    );
    expect(logger.warn).toHaveBeenCalledWith("vercel.deployments.cursor_ignored", expect.any(Object));
  });

  it("rejects an external account the credential does not cover", async () => {
    const { ctx } = makeCtx(fakeVercel().fetch);
    await expect(vercelAdapter.sync({ ...teamSync, externalAccountId: "team_other" }, ctx)).rejects.toThrow(
      /does not cover/,
    );
  });
});
