import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { evaluateAchievements } from "@/lib/achievements/evaluate";
import { toSnapshotRow } from "@/lib/jobs/ingest";
import { achievementRuleMetricKey } from "../achievements";
import { AuthRevokedError, InvalidResponseError, PermissionMissingError, RateLimitedError } from "../errors";
import { validateAdapterEvents } from "../events";
import { checkSyncResult } from "../harness";
import { validateAdapterMetrics, type AdapterMetric } from "../metrics";
import { Secret, type FetchLike, type OAuthContext, type OAuthCredential, type SyncResult } from "../types";
import { monthsToSync } from "./billing";
import { buildUserAuthorizeUrl, githubAdapter, readCallback, type GitHubCallback } from "./index";
import { starMetricNames, starMilestones, type Cursor } from "./repositories";

// Every fixture below is from documentation (docs/providers/github.md, "Sample responses"), not
// recorded: trimmed, with synthetic ids, logins, tokens, and amounts.
import aiCreditUsage from "./fixtures/ai-credit-usage.json";
import billingUsage from "./fixtures/billing-usage.json";
import billingSummary from "./fixtures/billing-usage-summary.json";
import forks from "./fixtures/forks.json";
import installation from "./fixtures/installation.json";
import installationRepositories from "./fixtures/installation-repositories.json";
import installationToken from "./fixtures/installation-token.json";
import premiumRequestUsage from "./fixtures/premium-request-usage.json";
import stargazersCount from "./fixtures/stargazers-count.json";
import userInstallations from "./fixtures/user-installations.json";
import userToken from "./fixtures/user-token.json";

const NOW = new Date("2026-10-31T12:00:00Z");
const APP_ID = "424242";
const CLIENT_ID = "Iv1.fixtureclientid";
const INSTALLATION_ID = "12345678";
const ACCOUNT_ID = "9000001";
const REDIRECT_URI = "https://devmacro.example/api/connections/github/callback";

// Throwaway key generated per run: the JWT is signed and verified without any real app secret.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

type Call = { method: string; url: URL; headers: Headers; body: string | undefined };
type Handler = (call: Call) => Response;
type Routes = Record<string, Handler>;

const api = (path: string) => `api.github.com${path}`;
const json = (body: unknown, init?: ResponseInit): Handler => () => Response.json(structuredClone(body), init);

const orgBilling = "/organizations/example-org/settings/billing";
const repoPath = "/repos/example-org/example-repo";

function orgRoutes(): Routes {
  return {
    [`GET ${api(`/app/installations/${INSTALLATION_ID}`)}`]: json(installation),
    [`POST ${api(`/app/installations/${INSTALLATION_ID}/access_tokens`)}`]: json(installationToken, { status: 201 }),
    [`GET ${api("/installation/repositories")}`]: json(installationRepositories),
    [`GET ${api(`${repoPath}/stargazers/count`)}`]: json(stargazersCount),
    [`GET ${api(`${repoPath}/forks`)}`]: json(forks),
    [`GET ${api(`${orgBilling}/usage/summary`)}`]: json(billingSummary),
    [`GET ${api(`${orgBilling}/usage`)}`]: json(billingUsage),
    [`GET ${api(`${orgBilling}/ai_credit/usage`)}`]: json(aiCreditUsage),
    [`GET ${api(`${orgBilling}/premium_request/usage`)}`]: json(premiumRequestUsage),
    "POST github.com/login/oauth/access_token": json(userToken),
    [`GET ${api("/user/installations")}`]: json(userInstallations),
    [`DELETE ${api(`/applications/${CLIENT_ID}/token`)}`]: () => new Response(null, { status: 204 }),
  };
}

function harness(overrides: Routes = {}, options: { now?: Date; privateKeyPem?: string } = {}) {
  const routes = { ...orgRoutes(), ...overrides };
  const calls: Call[] = [];
  const warnings: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const method = init?.method ?? "GET";
    const call: Call = {
      method,
      url,
      headers: new Headers(init?.headers),
      body: init?.body === undefined || init.body === null ? undefined : String(init.body),
    };
    calls.push(call);
    const handler = routes[`${method} ${url.host}${url.pathname}`];
    return handler === undefined ? new Response("not mocked", { status: 418 }) : handler(call);
  };
  const ctx: OAuthContext = {
    fetch,
    now: () => options.now ?? NOW,
    timeoutMs: 1000,
    logger: {
      info: () => undefined,
      warn: (event) => warnings.push(event),
      error: () => undefined,
    },
    client: {
      clientId: CLIENT_ID,
      clientSecret: new Secret("fixture-client-secret"),
      extra: {
        appSlug: new Secret("devmacro-example"),
        appId: new Secret(APP_ID),
        privateKey: new Secret(options.privateKeyPem ?? privateKey),
      },
    },
  };
  const callsTo = (method: string, path: string) =>
    calls.filter((call) => call.method === method && `${call.url.host}${call.url.pathname}` === path);
  return { ctx, calls, callsTo, warnings };
}

const orgCredential: OAuthCredential = {
  accessToken: new Secret("ghu_revokedverificationtoken"),
  scopes: ["metadata:read", "organization_administration:read"],
  tokenType: "bearer",
  metadata: { installationId: INSTALLATION_ID, accountId: ACCOUNT_ID, accountLogin: "example-org", accountType: "Organization" },
};

const personalInstallation = {
  ...installation,
  account: { login: "example-user", id: 9000002, type: "User" },
  permissions: { metadata: "read", plan: "read" },
};

function personalRoutes(): Routes {
  const userBilling = "/users/example-user/settings/billing";
  return {
    [`GET ${api(`/app/installations/${INSTALLATION_ID}`)}`]: json(personalInstallation),
    [`GET ${api(`${userBilling}/usage/summary`)}`]: json(billingSummary),
    [`GET ${api(`${userBilling}/usage`)}`]: json(billingUsage),
    [`GET ${api(`${userBilling}/ai_credit/usage`)}`]: json(aiCreditUsage),
    [`GET ${api(`${userBilling}/premium_request/usage`)}`]: json(premiumRequestUsage),
  };
}

function metric(metrics: readonly AdapterMetric[], metricKey: string): AdapterMetric | undefined {
  return metrics.find((candidate) => candidate.metricKey === metricKey);
}

function decodeJwtPart(part: string | undefined): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8")));
}

function syncInput(cursor?: string) {
  return {
    credential: orgCredential,
    externalAccountId: ACCOUNT_ID,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

describe("githubAdapter descriptor", () => {
  it("polls hourly and declares stable event type ids", () => {
    expect(githubAdapter.pollIntervalSeconds).toBe(3600);
    expect(githubAdapter.eventTypes.map((eventType) => eventType.id)).toEqual([
      "github.stars.daily",
      "github.stars.milestone",
      "github.forks.new",
    ]);
    expect(githubAdapter.oauth.extraEnv).toEqual({
      appSlug: "GITHUB_APP_SLUG",
      appId: "GITHUB_APP_ID",
      privateKey: "GITHUB_APP_PRIVATE_KEY",
    });
  });
});

describe("connect flow URLs", () => {
  it("builds the app install URL with the state and no scopes or redirect", () => {
    const { ctx } = harness();
    const url = githubAdapter.buildAuthorizeUrl({ client: ctx.client, state: "state-1", redirectUri: REDIRECT_URI });
    expect(url.origin + url.pathname).toBe("https://github.com/apps/devmacro-example/installations/new");
    expect([...url.searchParams.entries()]).toEqual([["state", "state-1"]]);
  });

  it("builds the user authorize URL with redirect, state, and S256 PKCE, and sends no scope", () => {
    const { ctx } = harness();
    const url = buildUserAuthorizeUrl({
      client: ctx.client,
      state: "state-2",
      redirectUri: REDIRECT_URI,
      codeChallenge: "challenge-abc",
    });
    expect(url.origin + url.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      state: "state-2",
      code_challenge: "challenge-abc",
      code_challenge_method: "S256",
    });
  });

  it("refuses a user authorize URL without a PKCE challenge (boundary: missing challenge)", () => {
    const { ctx } = harness();
    expect(() => buildUserAuthorizeUrl({ client: ctx.client, state: "s", redirectUri: REDIRECT_URI })).toThrow(TypeError);
  });

  it.each<{ name: string; params: Record<string, string>; expected: GitHubCallback }>([
    { name: "install redirect", params: { installation_id: "123", setup_action: "install", state: "s" }, expected: { step: "installed", installationId: "123" } },
    { name: "authorization redirect", params: { code: "abc", state: "s" }, expected: { step: "authorized", code: "abc" } },
    { name: "owner approval requested (no installation id)", params: { setup_action: "request", state: "s" }, expected: { step: "requested" } },
    { name: "user declined", params: { error: "access_denied", state: "s" }, expected: { step: "denied" } },
    { name: "non-numeric installation id", params: { installation_id: "12;drop" }, expected: { step: "requested" } },
  ])("reads the callback: $name", ({ params, expected }) => {
    expect(readCallback(params)).toEqual(expected);
  });
});

describe("app JWT", () => {
  it("is RS256 signed with iat 60 s in the past, exp within 10 minutes, and iss = app id", async () => {
    const { ctx, callsTo } = harness();
    await githubAdapter.listAccounts(orgCredential, ctx);
    const [call] = callsTo("GET", api(`/app/installations/${INSTALLATION_ID}`));
    const jwt = call?.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const [header, payload, signature] = jwt.split(".");

    expect(decodeJwtPart(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const nowSeconds = NOW.getTime() / 1000;
    const claims = decodeJwtPart(payload);
    expect(claims).toEqual({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: APP_ID });
    expect(Number(claims.exp) - nowSeconds).toBeLessThanOrEqual(600);
    const verified = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, signature ?? "", "base64url");
    expect(verified).toBe(true);
  });

  it("accepts a private key stored with \\n escapes (boundary: single-line env value)", async () => {
    const { ctx } = harness({}, { privateKeyPem: privateKey.replaceAll("\n", "\\n") });
    await expect(githubAdapter.listAccounts(orgCredential, ctx)).resolves.toHaveLength(1);
  });
});

describe("exchangeCode", () => {
  const exchangeInput = {
    code: "code-123",
    redirectUri: REDIRECT_URI,
    codeVerifier: "verifier-xyz",
    callbackParams: { code: "code-123", state: "s", installation_id: INSTALLATION_ID },
  };

  it("verifies the installation, revokes the user token, and stores no refresh token for an organization", async () => {
    const { ctx, callsTo } = harness();
    const credential = await githubAdapter.exchangeCode(exchangeInput, ctx);

    const [tokenCall] = callsTo("POST", "github.com/login/oauth/access_token");
    expect(Object.fromEntries(new URLSearchParams(tokenCall?.body))).toEqual({
      client_id: CLIENT_ID,
      client_secret: "fixture-client-secret",
      code: "code-123",
      redirect_uri: REDIRECT_URI,
      code_verifier: "verifier-xyz",
    });
    expect(tokenCall?.headers.get("accept")).toBe("application/json");
    expect(callsTo("GET", api("/user/installations"))[0]?.headers.get("authorization")).toBe(
      `Bearer ${userToken.access_token}`,
    );

    const [revokeCall] = callsTo("DELETE", api(`/applications/${CLIENT_ID}/token`));
    expect(revokeCall?.headers.get("authorization")).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:fixture-client-secret`).toString("base64")}`,
    );
    expect(JSON.parse(revokeCall?.body ?? "{}")).toEqual({ access_token: userToken.access_token });

    expect(credential.refreshToken).toBeUndefined();
    expect(credential.expiresAt).toBeUndefined();
    expect(credential.metadata).toEqual({
      installationId: INSTALLATION_ID,
      accountId: ACCOUNT_ID,
      accountLogin: "example-org",
      accountType: "Organization",
    });
    expect(credential.scopes).toEqual(["metadata:read", "organization_administration:read"]);
    expect(JSON.stringify(credential)).not.toContain("ghu_");
  });

  it("keeps the rotating user refresh token for a personal account", async () => {
    const { ctx, callsTo } = harness({
      [`GET ${api("/user/installations")}`]: json({ total_count: 1, installations: [personalInstallation] }),
    });
    const credential = await githubAdapter.exchangeCode(exchangeInput, ctx);

    expect(credential.accessToken.reveal()).toBe(userToken.access_token);
    expect(credential.refreshToken?.reveal()).toBe(userToken.refresh_token);
    expect(credential.expiresAt).toEqual(new Date(NOW.getTime() + 28800 * 1000));
    expect(credential.metadata?.accountType).toBe("User");
    expect(callsTo("DELETE", api(`/applications/${CLIENT_ID}/token`))).toHaveLength(0);
  });

  it("rejects an installation id the user cannot access (boundary: spoofed callback param)", async () => {
    const { ctx } = harness();
    const spoofed = { ...exchangeInput, callbackParams: { ...exchangeInput.callbackParams, installation_id: "999" } };
    await expect(githubAdapter.exchangeCode(spoofed, ctx)).rejects.toBeInstanceOf(PermissionMissingError);
  });

  it.each<{ name: string; params: Record<string, string> }>([
    { name: "missing", params: { code: "code-123" } },
    { name: "not numeric", params: { code: "code-123", installation_id: "abc" } },
  ])("rejects a callback whose installation id is $name", async ({ params }) => {
    const { ctx, calls } = harness();
    await expect(githubAdapter.exchangeCode({ ...exchangeInput, callbackParams: params }, ctx)).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
    expect(calls).toHaveLength(0);
  });

  it("finds the installation on a later page of /user/installations (boundary: pagination)", async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({ ...installation, id: 1000 + index }));
    const { ctx, callsTo } = harness({
      [`GET ${api("/user/installations")}`]: ({ url }) =>
        Response.json({
          total_count: 101,
          installations: url.searchParams.get("page") === "1" ? filler : [installation],
        }),
    });
    await expect(githubAdapter.exchangeCode(exchangeInput, ctx)).resolves.toMatchObject({
      metadata: { installationId: INSTALLATION_ID },
    });
    expect(callsTo("GET", api("/user/installations"))).toHaveLength(2);
  });

  it("stops searching after 10 pages of installations (boundary: pagination cap)", async () => {
    const filler = Array.from({ length: 100 }, (_, index) => ({ ...installation, id: 1000 + index }));
    const { ctx, callsTo } = harness({
      [`GET ${api("/user/installations")}`]: json({ total_count: 5000, installations: filler }),
    });
    await expect(githubAdapter.exchangeCode(exchangeInput, ctx)).rejects.toBeInstanceOf(PermissionMissingError);
    expect(callsTo("GET", api("/user/installations"))).toHaveLength(10);
  });

  it("maps bad_verification_code (HTTP 200 error body) to auth revoked", async () => {
    const { ctx } = harness({ "POST github.com/login/oauth/access_token": json({ error: "bad_verification_code" }) });
    await expect(githubAdapter.exchangeCode(exchangeInput, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("rejects a suspended installation", async () => {
    const { ctx } = harness({
      [`GET ${api("/user/installations")}`]: json({
        total_count: 1,
        installations: [{ ...installation, suspended_at: "2026-10-01T00:00:00Z" }],
      }),
    });
    await expect(githubAdapter.exchangeCode(exchangeInput, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("refreshTokens", () => {
  const personalCredential: OAuthCredential = {
    accessToken: new Secret("ghu_oldaccess"),
    refreshToken: new Secret("ghr_oldrefresh"),
    expiresAt: NOW,
    scopes: ["metadata:read", "plan:read"],
    tokenType: "bearer",
    metadata: { installationId: INSTALLATION_ID, accountId: "9000002", accountLogin: "example-user", accountType: "User" },
  };

  it("rotates the access and refresh token pair and keeps the metadata", async () => {
    const { ctx, callsTo } = harness();
    const refreshed = await githubAdapter.refreshTokens?.(personalCredential, ctx);
    const [call] = callsTo("POST", "github.com/login/oauth/access_token");
    expect(Object.fromEntries(new URLSearchParams(call?.body))).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "ghr_oldrefresh",
    });
    expect(refreshed?.accessToken.reveal()).toBe(userToken.access_token);
    expect(refreshed?.refreshToken?.reveal()).toBe(userToken.refresh_token);
    expect(refreshed?.expiresAt).toEqual(new Date(NOW.getTime() + 28800 * 1000));
    expect(refreshed?.metadata).toEqual(personalCredential.metadata);
  });

  it("maps bad_refresh_token to auth revoked (boundary: expired refresh token)", async () => {
    const { ctx } = harness({ "POST github.com/login/oauth/access_token": json({ error: "bad_refresh_token" }) });
    await expect(githubAdapter.refreshTokens?.(personalCredential, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("refuses to refresh an organization credential that holds no refresh token", async () => {
    const { ctx, calls } = harness();
    await expect(githubAdapter.refreshTokens?.(orgCredential, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
    expect(calls).toHaveLength(0);
  });
});

describe("listAccounts", () => {
  it("returns the installation account as an organization", async () => {
    const { ctx } = harness();
    await expect(githubAdapter.listAccounts(orgCredential, ctx)).resolves.toEqual([
      { externalId: ACCOUNT_ID, displayName: "example-org", kind: "organization" },
    ]);
  });

  it("returns a personal installation as a user", async () => {
    const { ctx } = harness(personalRoutes());
    await expect(githubAdapter.listAccounts(orgCredential, ctx)).resolves.toEqual([
      { externalId: "9000002", displayName: "example-user", kind: "user" },
    ]);
  });

  it("maps a 404 for a deleted installation to auth revoked", async () => {
    const { ctx } = harness({
      [`GET ${api(`/app/installations/${INSTALLATION_ID}`)}`]: json({ message: "Not Found" }, { status: 404 }),
    });
    await expect(githubAdapter.listAccounts(orgCredential, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("asks for reconnection when the credential lacks installation metadata", async () => {
    const { ctx } = harness();
    const withoutMetadata: OAuthCredential = {
      accessToken: orgCredential.accessToken,
      scopes: orgCredential.scopes,
      tokenType: orgCredential.tokenType,
    };
    await expect(githubAdapter.listAccounts(withoutMetadata, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("detectMissingPermissions", () => {
  it.each<{ name: string; scopes: string[]; missing: string[] }>([
    { name: "organization grant", scopes: ["metadata:read", "organization_administration:read"], missing: [] },
    { name: "personal grant", scopes: ["metadata:read", "plan:read"], missing: [] },
    { name: "write level counts as read", scopes: ["metadata:write", "plan:read"], missing: [] },
    { name: "no metadata", scopes: ["organization_administration:read"], missing: ["metadata:read"] },
    {
      name: "empty grant",
      scopes: [],
      missing: ["metadata:read", "organization_administration:read", "plan:read"],
    },
  ])("$name", ({ scopes, missing }) => {
    expect(githubAdapter.detectMissingPermissions({ scopes })).toEqual(missing);
  });
});

describe("sync", () => {
  it("collects verified billing, usage, and stars for an organization (happy path, first sync)", async () => {
    const { ctx, callsTo } = harness();
    const result = await githubAdapter.sync(syncInput(), ctx);

    const metrics = validateAdapterMetrics("github", result.metrics);
    expect(metrics.ok).toBe(true);
    expect(validateAdapterEvents(githubAdapter.eventTypes, result.events).ok).toBe(true);
    expect(result.partialErrors).toBeUndefined();

    expect(metric(result.metrics, "github.spend.actions")).toMatchObject({
      kind: "verified_spend",
      amountMinor: 802,
      currency: "USD",
      timeframe: { type: "period", start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") },
      provenance: { source: "provider_api", endpoint: "/organizations/{org}/settings/billing/usage/summary" },
      retrievedAt: NOW,
      externalAccountId: ACCOUNT_ID,
    });
    expect(metric(result.metrics, "github.spend.actions.actions_linux_4_core")).toMatchObject({ amountMinor: 0 });
    expect(metric(result.metrics, "github.usage.actions.minutes")).toMatchObject({
      kind: "usage",
      value: 1000.546875,
      unit: "minutes",
    });
    expect(metric(result.metrics, "github.spend.copilot")).toMatchObject({
      amountMinor: 100,
      provenance: { endpoint: "/organizations/{org}/settings/billing/ai_credit/usage" },
    });
    expect(metric(result.metrics, "github.usage.copilot.credits")).toMatchObject({ value: 100, unit: "credits" });
    expect(metric(result.metrics, "github.daily_spend.actions")).toMatchObject({
      amountMinor: 96,
      timeframe: { type: "period", start: new Date("2026-10-30T00:00:00Z"), end: new Date("2026-10-31T00:00:00Z") },
    });
    expect(metric(result.metrics, "github.stars.repo_5000001")).toMatchObject({ value: 95, unit: "stars" });
    expect(metric(result.metrics, "github.stars.total")).toMatchObject({ value: 95 });
    // The harness checks only that an achievement's metric key has the adapter's prefix; this
    // proves every key the achievements read is one a sync emits, so none waits on a misspelling.
    // New stars per day are reported once a baseline day closes, so the next day's first sync counts too.
    const achievementKeys = new Set((githubAdapter.achievements ?? []).flatMap((achievement) => achievementRuleMetricKey(achievement.rule) ?? []));
    expect([...achievementKeys]).toEqual(["github.stars.total", "github.stars.gained.daily"]);
    const nextDay = await githubAdapter.sync(syncInput(result.cursor), harness({}, { now: new Date("2026-11-01T00:10:00Z") }).ctx);
    for (const key of achievementKeys) expect(metric([...result.metrics, ...nextDay.metrics], key), key).toBeDefined();

    // First sync sets baselines without backfilling old forks or milestones.
    expect(result.events).toEqual([]);
    const cursor = JSON.parse(result.cursor ?? "{}") as Cursor;
    expect(cursor.repos["5000001"]).toEqual({
      day: "2026-10-31",
      dayCount: 95,
      milestone: 0,
      forksSeenAt: "2026-10-30T09:00:00.000Z",
      forkIdsAtSeenAt: [7000002],
    });

    // Organization billing uses the installation token, never the stored verification token.
    const summaryCall = callsTo("GET", api(`${orgBilling}/usage/summary`))[0];
    expect(summaryCall?.headers.get("authorization")).toBe(`Bearer ${installationToken.token}`);
    expect(Object.fromEntries(summaryCall?.url.searchParams ?? [])).toEqual({ year: "2026", month: "10" });
    const [mint] = callsTo("POST", api(`/app/installations/${INSTALLATION_ID}/access_tokens`));
    expect(JSON.parse(mint?.body ?? "{}")).toEqual({
      permissions: { metadata: "read", organization_administration: "read" },
    });
    // Premium requests are only the fallback when AI credits have no rows.
    expect(callsTo("GET", api(`${orgBilling}/premium_request/usage`))).toHaveLength(0);
  });

  it("rounds money once on the exact sum, not per line item (boundary: sub-cent amounts)", async () => {
    // 8 + 3 x 0.005 = 8.015, rounded half to even once = 8.02. Rounding each item first gives 8.00.
    const { ctx } = harness();
    const result = await githubAdapter.sync(syncInput(), ctx);
    expect(metric(result.metrics, "github.spend.actions")).toMatchObject({ amountMinor: 802 });
  });

  it("emits daily stars, milestones, and new forks after the first sync, with no fork owner data", async () => {
    const previous: Cursor = {
      v: 1,
      repos: {
        "5000001": {
          day: "2026-10-30",
          dayCount: 90,
          milestone: 0,
          forksSeenAt: "2026-10-29T09:00:00.000Z",
          forkIdsAtSeenAt: [7000001],
        },
      },
    };
    // Closed at 00:10, within the bound a day's star event needs (`DAY_CLOSE_MAX_DELAY_MS`).
    const { ctx } = harness({ [`GET ${api(`${repoPath}/stargazers/count`)}`]: json({ count: 105 }) }, { now: new Date("2026-10-31T00:10:00Z") });
    const result = await githubAdapter.sync(syncInput(JSON.stringify(previous)), ctx);

    expect(validateAdapterEvents(githubAdapter.eventTypes, result.events).ok).toBe(true);
    expect(result.events.map((event) => event.dedupeKey)).toEqual([
      "github.stars.daily:5000001:2026-10-30",
      "github.stars.milestone:5000001:100",
      "github.forks.new:5000001:7000002",
    ]);
    expect(result.events[0]).toMatchObject({
      title: "example-org/example-repo gained 15 stars on 2026-10-30",
      occurredAt: new Date("2026-10-31T00:00:00Z"),
      url: "https://github.com/example-org/example-repo",
    });
    expect(result.events[2]).toMatchObject({
      occurredAt: new Date("2026-10-30T09:00:00Z"),
      url: "https://github.com/example-org/example-repo/forks",
    });
    expect(JSON.stringify(result.events)).not.toContain("fork-owner");
  });

  it("produces identical dedupe keys when the same poll repeats, and no repeats from the next cursor (boundary: duplicate events)", async () => {
    const previous: Cursor = {
      v: 1,
      repos: {
        "5000001": { day: "2026-10-30", dayCount: 90, milestone: 0, forksSeenAt: null, forkIdsAtSeenAt: [] },
      },
    };
    const overrides = { [`GET ${api(`${repoPath}/stargazers/count`)}`]: json({ count: 105 }) };
    const first = await githubAdapter.sync(syncInput(JSON.stringify(previous)), harness(overrides).ctx);
    const again = await githubAdapter.sync(syncInput(JSON.stringify(previous)), harness(overrides).ctx);
    expect(again.events.map((event) => event.dedupeKey)).toEqual(first.events.map((event) => event.dedupeKey));
    expect(again.metrics.map((item) => item.metricKey)).toEqual(first.metrics.map((item) => item.metricKey));

    const next = await githubAdapter.sync(syncInput(first.cursor), harness(overrides).ctx);
    expect(next.events).toEqual([]);
  });

  it("does not refire a milestone after the count dips and recovers (boundary: milestone once)", async () => {
    const previous: Cursor = {
      v: 1,
      repos: {
        "5000001": { day: "2026-10-31", dayCount: 99, milestone: 100, forksSeenAt: null, forkIdsAtSeenAt: [] },
      },
    };
    const { ctx } = harness({
      [`GET ${api(`${repoPath}/stargazers/count`)}`]: json({ count: 100 }),
      [`GET ${api(`${repoPath}/forks`)}`]: json([]),
    });
    const result = await githubAdapter.sync(syncInput(JSON.stringify(previous)), ctx);
    expect(result.events).toEqual([]);
  });

  it.each<{ after: number; upTo: number; expected: number[] }>([
    { after: 0, upTo: 99, expected: [] },
    { after: 0, upTo: 100, expected: [100] },
    { after: 99, upTo: 2500, expected: [100, 500, 1000, 2000] },
    { after: 1000, upTo: 1999, expected: [] },
    { after: 1000, upTo: 3000, expected: [2000, 3000] },
  ])("star milestones in ($after, $upTo] are $expected (boundary: off-by-one)", ({ after, upTo, expected }) => {
    expect(starMilestones(after, upTo)).toEqual(expected);
  });

  it("falls back to premium requests when AI credits have no rows (boundary: empty list)", async () => {
    const { ctx } = harness({ [`GET ${api(`${orgBilling}/ai_credit/usage`)}`]: json({ usageItems: [] }) });
    const result = await githubAdapter.sync(syncInput(), ctx);
    expect(metric(result.metrics, "github.spend.copilot")).toMatchObject({
      amountMinor: 400,
      provenance: { endpoint: "/organizations/{org}/settings/billing/premium_request/usage" },
    });
    expect(metric(result.metrics, "github.usage.copilot.requests")).toMatchObject({ value: 100, unit: "requests" });
    expect(result.partialErrors).toBeUndefined();
  });

  it.each([
    { name: "403", response: json({ message: "Forbidden" }, { status: 403 }) },
    { name: "400", response: json({ message: "Not on enhanced billing" }, { status: 400 }) },
    { name: "404", response: json({ message: "Not Found" }, { status: 404 }) },
  ])(
    "reports billing as a partial permission error and still collects stars (boundary: non-enhanced billing $name)",
    async ({ response }) => {
      const { ctx } = harness({
        [`GET ${api(`${orgBilling}/usage/summary`)}`]: response,
        [`GET ${api(`${orgBilling}/usage`)}`]: response,
        [`GET ${api(`${orgBilling}/ai_credit/usage`)}`]: response,
        [`GET ${api(`${orgBilling}/premium_request/usage`)}`]: response,
      });
      const result = await githubAdapter.sync(syncInput(), ctx);

      expect(validateAdapterMetrics("github", result.metrics).ok).toBe(true);
      expect(result.metrics.filter((item) => item.kind === "verified_spend")).toEqual([]);
      expect(metric(result.metrics, "github.stars.repo_5000001")).toMatchObject({ value: 95 });
      expect(result.partialErrors).toHaveLength(4);
      for (const error of result.partialErrors ?? []) {
        expect(error).toBeInstanceOf(PermissionMissingError);
        expect(error.missingScopes).toEqual(["organization_administration:read"]);
      }
    },
  );

  it("reads personal billing with the user token and stars with an installation token", async () => {
    const { ctx, callsTo } = harness(personalRoutes());
    const personalCredential: OAuthCredential = {
      ...orgCredential,
      accessToken: new Secret("ghu_personalusertoken"),
      metadata: { installationId: INSTALLATION_ID, accountId: "9000002", accountLogin: "example-user", accountType: "User" },
    };
    const result = await githubAdapter.sync(
      { credential: personalCredential, externalAccountId: "9000002" },
      ctx,
    );

    expect(validateAdapterMetrics("github", result.metrics).ok).toBe(true);
    expect(metric(result.metrics, "github.spend.actions")).toMatchObject({
      amountMinor: 802,
      provenance: { endpoint: "/users/{username}/settings/billing/usage/summary" },
    });
    expect(
      callsTo("GET", api("/users/example-user/settings/billing/usage/summary"))[0]?.headers.get("authorization"),
    ).toBe("Bearer ghu_personalusertoken");
    expect(callsTo("GET", api("/installation/repositories"))[0]?.headers.get("authorization")).toBe(
      `Bearer ${installationToken.token}`,
    );
    const [mint] = callsTo("POST", api(`/app/installations/${INSTALLATION_ID}/access_tokens`));
    expect(JSON.parse(mint?.body ?? "{}")).toEqual({ permissions: { metadata: "read" } });
  });

  it("names plan:read when personal billing is unavailable", async () => {
    const forbidden = json({ message: "Forbidden" }, { status: 403 });
    const userBilling = "/users/example-user/settings/billing";
    const { ctx } = harness({
      ...personalRoutes(),
      [`GET ${api(`${userBilling}/usage/summary`)}`]: forbidden,
      [`GET ${api(`${userBilling}/usage`)}`]: forbidden,
      [`GET ${api(`${userBilling}/ai_credit/usage`)}`]: forbidden,
      [`GET ${api(`${userBilling}/premium_request/usage`)}`]: forbidden,
    });
    const result = await githubAdapter.sync({ credential: orgCredential, externalAccountId: "9000002" }, ctx);
    expect(result.partialErrors?.[0]?.missingScopes).toEqual(["plan:read"]);
  });

  it("throws auth revoked on a 401 (boundary: revoked token)", async () => {
    const { ctx } = harness({
      [`GET ${api("/installation/repositories")}`]: json({ message: "Bad credentials" }, { status: 401 }),
    });
    await expect(githubAdapter.sync(syncInput(), ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("throws rate limited with Retry-After on a 429, even on a billing endpoint (boundary: 429)", async () => {
    const { ctx } = harness({
      [`GET ${api(`${orgBilling}/usage/summary`)}`]: json({ message: "slow down" }, { status: 429, headers: { "Retry-After": "30" } }),
    });
    const error = await githubAdapter.sync(syncInput(), ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error instanceof RateLimitedError ? error.retryAfterMs : undefined).toBe(30_000);
  });

  it("maps a 403 when minting the installation token to auth revoked (boundary: suspended or removed install)", async () => {
    const { ctx } = harness({
      [`POST ${api(`/app/installations/${INSTALLATION_ID}/access_tokens`)}`]: json({ message: "Forbidden" }, { status: 403 }),
    });
    await expect(githubAdapter.sync(syncInput(), ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("returns only the stars total when there are no repositories and no billing rows (boundary: empty lists)", async () => {
    const empty = json({ usageItems: [] });
    const { ctx } = harness({
      [`GET ${api("/installation/repositories")}`]: json({ total_count: 0, repositories: [] }),
      [`GET ${api(`${orgBilling}/usage/summary`)}`]: empty,
      [`GET ${api(`${orgBilling}/usage`)}`]: empty,
      [`GET ${api(`${orgBilling}/ai_credit/usage`)}`]: empty,
      [`GET ${api(`${orgBilling}/premium_request/usage`)}`]: empty,
    });
    const result = await githubAdapter.sync(syncInput(), ctx);
    expect(result.metrics.map((item) => item.metricKey)).toEqual(["github.stars.total"]);
    expect(metric(result.metrics, "github.stars.total")).toMatchObject({ value: 0 });
    expect(result.events).toEqual([]);
    expect(JSON.parse(result.cursor ?? "{}")).toEqual({ v: 1, repos: {} });
  });

  it("reads at most 100 repositories per sync and logs the truncation (boundary: pagination cap)", async () => {
    const repositories = Array.from({ length: 100 }, (_, index) => ({
      ...installationRepositories.repositories[0],
      id: 6000000 + index,
      name: "example-repo",
    }));
    const { ctx, callsTo, warnings } = harness({
      [`GET ${api("/installation/repositories")}`]: json({ total_count: 150, repositories }),
    });
    const result = await githubAdapter.sync(syncInput(), ctx);
    const [listCall] = callsTo("GET", api("/installation/repositories"));
    expect(listCall?.url.searchParams.get("per_page")).toBe("100");
    expect(callsTo("GET", api("/installation/repositories"))).toHaveLength(1);
    expect(callsTo("GET", api(`${repoPath}/stargazers/count`))).toHaveLength(100);
    expect(Object.keys((JSON.parse(result.cursor ?? "{}") as Cursor).repos)).toHaveLength(100);
    expect(warnings).toContain("github.sync.repositories_truncated");
  });

  it("fails with invalid_response when a billing response drifts from the schema", async () => {
    const drifted = structuredClone(billingSummary);
    const drift = { ...drifted, usageItems: drifted.usageItems.map((item) => ({ ...item, netAmount: String(item.netAmount) })) };
    const { ctx } = harness({ [`GET ${api(`${orgBilling}/usage/summary`)}`]: json(drift) });
    await expect(githubAdapter.sync(syncInput(), ctx)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it("treats a corrupt cursor as a first sync without backfilled events (boundary: bad cursor)", async () => {
    const { ctx, warnings } = harness();
    const result = await githubAdapter.sync(syncInput("not json"), ctx);
    expect(result.events).toEqual([]);
    expect(warnings).toContain("github.sync.cursor_reset");
  });

  it("also reads the previous month during the first days of a month (boundary: month rollover)", async () => {
    expect(monthsToSync(new Date("2026-11-03T23:59:59Z"))).toEqual([
      { year: 2026, month: 10 },
      { year: 2026, month: 11 },
    ]);
    expect(monthsToSync(new Date("2026-11-04T00:00:00Z"))).toEqual([{ year: 2026, month: 11 }]);
    expect(monthsToSync(new Date("2027-01-01T00:00:00Z"))).toEqual([
      { year: 2026, month: 12 },
      { year: 2027, month: 1 },
    ]);

    const { ctx, callsTo } = harness({}, { now: new Date("2026-11-02T08:00:00Z") });
    const result = await githubAdapter.sync(syncInput(), ctx);
    expect(
      callsTo("GET", api(`${orgBilling}/usage/summary`)).map((call) => call.url.searchParams.get("month")),
    ).toEqual(["10", "11"]);
    expect(validateAdapterMetrics("github", result.metrics).ok).toBe(true);
  });
});

describe("sync: new stars over one UTC day", () => {
  const GAINED = starMetricNames.gainedDaily.metricKey;
  const YESTERDAY = "2026-10-30";
  // The first sync of 2026-10-31, ten minutes after 2026-10-30 ended, so it closes that day.
  const CLOSED_AT = new Date("2026-10-31T00:10:00Z");

  type StarRepo = Readonly<{ id: number; name: string; count: number }>;

  function baseline(day: string, dayCount: number): Cursor["repos"][string] {
    return { day, dayCount, milestone: 0, forksSeenAt: null, forkIdsAtSeenAt: [] };
  }

  /** One sync over `repos` from the cursor `previous` at `now`. */
  async function syncStars(repos: readonly StarRepo[], previous: Cursor["repos"], now: Date): Promise<SyncResult> {
    const repositories = repos.map((repo) => ({
      ...installationRepositories.repositories[0],
      id: repo.id,
      name: repo.name,
      full_name: `example-org/${repo.name}`,
      html_url: `https://github.com/example-org/${repo.name}`,
    }));
    const routes: Routes = { [`GET ${api("/installation/repositories")}`]: json({ total_count: repos.length, repositories }) };
    for (const repo of repos) {
      routes[`GET ${api(`/repos/example-org/${repo.name}/stargazers/count`)}`] = json({ count: repo.count });
      routes[`GET ${api(`/repos/example-org/${repo.name}/forks`)}`] = json([]);
    }
    const cursor: Cursor = { v: 1, repos: previous };
    const result = await githubAdapter.sync(syncInput(JSON.stringify(cursor)), harness(routes, { now }).ctx);
    // The sync runner's gates, including that a new stars reading covers one whole UTC day.
    expect(checkSyncResult(githubAdapter, ACCOUNT_ID, result)).toEqual([]);
    return result;
  }

  /** The new stars readings of the sync at `CLOSED_AT`. */
  async function gained(repos: readonly StarRepo[], previous: Cursor["repos"]): Promise<AdapterMetric[]> {
    return (await syncStars(repos, previous, CLOSED_AT)).metrics.filter((item) => item.metricKey === GAINED);
  }

  it("adds the repositories' new stars into one reading of the closed day, which earns Trending on that day", async () => {
    const readings = await gained(
      [
        { id: 5000001, name: "api", count: 96 },
        { id: 5000002, name: "web", count: 44 },
      ],
      { "5000001": baseline(YESTERDAY, 90), "5000002": baseline(YESTERDAY, 40) },
    );
    expect(readings).toEqual([
      {
        kind: "usage",
        metricKey: "github.stars.gained.daily",
        label: "New stars over one UTC day",
        value: 10,
        unit: "stars",
        timeframe: { type: "period", start: new Date("2026-10-30T00:00:00Z"), end: new Date("2026-10-31T00:00:00Z") },
        externalAccountId: ACCOUNT_ID,
        retrievedAt: CLOSED_AT,
        provenance: { source: "provider_api", endpoint: "/repos/{owner}/{repo}/stargazers/count" },
      },
    ]);

    // Stored in today's row and read back the way `loadReadings` does, it is dated to the day it counts.
    const [reading] = readings;
    if (reading === undefined) throw new Error("expected a reading");
    const row = toSnapshotRow(reading, { id: "connection-1", workspace_id: "workspace-1" }, { id: "account-1" });
    expect(row).toMatchObject({ snapshot_date: "2026-10-31", period_start: "2026-10-30T00:00:00.000Z", point_at: null });
    const earned = evaluateAchievements({
      achievements: (githubAdapter.achievements ?? []).filter((achievement) => achievement.id === "github.stars.hot_day"),
      earnedIds: new Set(),
      events: [],
      readings: [
        {
          accountId: row.external_account_id,
          metricKey: row.metric_key,
          snapshotDate: row.snapshot_date,
          value: row.value ?? 0,
          observedAt: new Date(row.retrieved_at),
          periodStart: row.period_start === null ? null : new Date(row.period_start),
        },
      ],
    });
    expect(earned).toMatchObject([{ achievementId: "github.stars.hot_day", earnedAt: new Date("2026-10-30T00:00:00Z"), earnedPrecision: "day" }]);
  });

  it("counts nothing for a repository newly added to the installation, however many stars it has (boundary: no baseline)", async () => {
    const newRepo = { id: 5000002, name: "popular", count: 5000 };
    // Beside a repository that closed the day with no new stars: a stored 0, not the new stars.
    expect(await gained([{ id: 5000001, name: "api", count: 90 }, newRepo], { "5000001": baseline(YESTERDAY, 90) })).toMatchObject([
      { value: 0 },
    ]);
    // On its own: no repository closed a day, so nothing is reported.
    expect(await gained([newRepo], {})).toEqual([]);
  });

  it("adds 0 for a repository that lost stars, so it does not cancel another's gain (boundary: unstars)", async () => {
    const readings = await gained(
      [
        { id: 5000001, name: "api", count: 80 },
        { id: 5000002, name: "web", count: 52 },
      ],
      { "5000001": baseline(YESTERDAY, 90), "5000002": baseline(YESTERDAY, 40) },
    );
    expect(readings).toMatchObject([{ value: 12 }]);
  });

  it("adds nothing for a repository whose baseline is older than yesterday, because its change spans several days (boundary: missed syncs)", async () => {
    const stale = { id: 5000001, name: "api", count: 80 };
    const readings = await gained([stale, { id: 5000002, name: "web", count: 43 }], {
      "5000001": baseline("2026-10-28", 50),
      "5000002": baseline(YESTERDAY, 40),
    });
    expect(readings).toMatchObject([{ value: 3 }]);
    // On its own it closes no single day, so nothing is reported rather than a 0 or a 30.
    expect(await gained([stale], { "5000001": baseline("2026-10-28", 50) })).toEqual([]);
  });

  it.each<{ closedAt: string; counted: boolean }>([
    { closedAt: "2026-10-31T01:59:00Z", counted: true },
    { closedAt: "2026-10-31T02:00:00Z", counted: true },
    { closedAt: "2026-10-31T02:01:00Z", counted: false },
    { closedAt: "2026-10-31T23:50:00Z", counted: false },
  ])(
    "closes a day at $closedAt only within two poll intervals of its end: $counted (boundary: late first sync)",
    async ({ closedAt, counted }) => {
      const now = new Date(closedAt);
      const repos = [
        { id: 5000001, name: "api", count: 96 },
        { id: 5000002, name: "web", count: 44 },
      ];
      const previous = { "5000001": baseline(YESTERDAY, 90), "5000002": baseline(YESTERDAY, 40) };
      const result = await syncStars(repos, previous, now);
      // A late close would take in the next day's stars too, so it reports neither a total nor the
      // per-repository day events, which Weekend stargazers and Steady glow read, rather than up to
      // ~48 hours as one day.
      expect(result.metrics.filter((item) => item.metricKey === GAINED)).toEqual(
        counted ? [expect.objectContaining({ value: 10, retrievedAt: now })] : [],
      );
      expect(result.events.map((event) => event.dedupeKey)).toEqual(
        counted ? ["github.stars.daily:5000001:2026-10-30", "github.stars.daily:5000002:2026-10-30"] : [],
      );
    },
  );

  it("reports nothing on a later sync the same day, so the first sync's total stands (boundary: hourly polls)", async () => {
    expect(await gained([{ id: 5000001, name: "api", count: 120 }], { "5000001": baseline("2026-10-31", 90) })).toEqual([]);
  });
});
