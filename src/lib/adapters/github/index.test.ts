import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { evaluateAchievements } from "@/lib/achievements/evaluate";
import { toSnapshotRow } from "@/lib/jobs/ingest";
import { achievementRuleMetricKey } from "../achievements";
import { AuthRevokedError, InvalidResponseError, PermissionMissingError, ProviderUnavailableError, RateLimitedError } from "../errors";
import { validateAdapterEvents } from "../events";
import { checkAdapterDeclaration, checkSyncResult, checkWebhookOutcome } from "../harness";
import { validateAdapterMetrics, type AdapterMetric } from "../metrics";
import { Secret, type FetchLike, type OAuthContext, type OAuthCredential, type SyncResult, type WebhookDescriptor, type WebhookRequest } from "../types";
import { monthsToSync } from "./billing";
import { buildUserAuthorizeUrl, githubAdapter, readCallback, type GitHubCallback } from "./index";
import { activitySince, starMetricNames, starMilestones, type Cursor } from "./repositories";
import { githubWebhookSignature } from "./webhooks";

// Every fixture below is from documentation (docs/providers/github.md, "Sample responses"), not
// recorded: trimmed, with synthetic ids, logins, tokens, and amounts.
import aiCreditUsage from "./fixtures/ai-credit-usage.json";
import billingUsage from "./fixtures/billing-usage.json";
import billingSummary from "./fixtures/billing-usage-summary.json";
import forks from "./fixtures/forks.json";
import installation from "./fixtures/installation.json";
import installationRepositories from "./fixtures/installation-repositories.json";
import installationToken from "./fixtures/installation-token.json";
import issues from "./fixtures/issues.json";
import premiumRequestUsage from "./fixtures/premium-request-usage.json";
import pulls from "./fixtures/pulls.json";
// Shaped like "GitHub event types" (common properties, `ReleaseEvent` with the release object),
// with synthetic ids and people.
import repositoryEvents from "./fixtures/repository-events.json";
import stargazersCount from "./fixtures/stargazers-count.json";
import userInstallations from "./fixtures/user-installations.json";
import userToken from "./fixtures/user-token.json";
// Webhook bodies: GitHub's documented example payloads (docs.github.com, "Webhook events and
// payloads", and the octokit/webhooks examples it is generated from), trimmed, with the
// repository, accounts, and people replaced by the synthetic ones above.
import appAuthorizationRevoked from "./fixtures/webhook-github-app-authorization-revoked.json";
import installationDeleted from "./fixtures/webhook-installation-deleted.json";
import installationSuspend from "./fixtures/webhook-installation-suspend.json";
import issueOpenedDelivery from "./fixtures/webhook-issues-opened.json";
import pullRequestClosedDelivery from "./fixtures/webhook-pull-request-closed.json";
import starCreatedDelivery from "./fixtures/webhook-star-created.json";

const NOW = new Date("2026-10-31T12:00:00Z");
const APP_ID = "424242";
const CLIENT_ID = "Iv1.fixtureclientid";
const INSTALLATION_ID = "12345678";
const ACCOUNT_ID = "9000001";
const REDIRECT_URI = "https://stackdash.example/api/connections/github/callback";

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
    // Activity lists are empty by default, so the star, fork, and billing cases see only their own
    // events; "sync: timeline activity" below reads the recorded lists.
    [`GET ${api(`${repoPath}/pulls`)}`]: json([]),
    [`GET ${api(`${repoPath}/issues`)}`]: json([]),
    [`GET ${api(`${repoPath}/events`)}`]: json([]),
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
        appSlug: new Secret("stackdash-example"),
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
      "github.stars.new",
      "github.forks.new",
      "github.pull_request.merged",
      "github.issue.opened",
      "github.release.published",
    ]);
    expect(githubAdapter.oauth.extraEnv).toEqual({
      appSlug: "GITHUB_APP_SLUG",
      appId: "GITHUB_APP_ID",
      privateKey: "GITHUB_APP_PRIVATE_KEY",
    });
  });

  it("discloses every read permission before connecting, with what each activity permission also allows", () => {
    // GitHub Apps have no OAuth scopes: the connect screen lists the app's permissions instead.
    expect(githubAdapter.oauth.scopes).toEqual([]);
    // No Contents read: it also reads code, so releases come from the events feed (Metadata read).
    expect(githubAdapter.permissions.map((permission) => [permission.scope, permission.access])).toEqual([
      ["metadata:read", "read"],
      ["organization_administration:read", "read"],
      ["plan:read", "read"],
      ["pull_requests:read", "read"],
      ["issues:read", "read"],
    ]);
    const descriptionOf = (scope: string) => githubAdapter.permissions.find((permission) => permission.scope === scope)?.description ?? "";
    expect(descriptionOf("metadata:read")).toMatch(/published releases from each repository's event feed/);
    expect(descriptionOf("pull_requests:read")).toMatch(/keeps only the number/);
    expect(descriptionOf("issues:read")).toMatch(/keeps only the number/);
    // The activity permissions are optional: a grant without them is not missing anything at connect.
    expect(githubAdapter.detectMissingPermissions({ scopes: ["metadata:read", "organization_administration:read"] })).toEqual([]);
  });
});

describe("connect flow URLs", () => {
  it("builds the app install URL with the state and no scopes or redirect", () => {
    const { ctx } = harness();
    const url = githubAdapter.buildAuthorizeUrl({ client: ctx.client, state: "state-1", redirectUri: REDIRECT_URI });
    expect(url.origin + url.pathname).toBe("https://github.com/apps/stackdash-example/installations/new");
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
      permissions: { metadata: "read", organization_administration: "read", pull_requests: "read", issues: "read" },
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
    expect(JSON.parse(result.cursor ?? "{}")).toEqual({ v: 1, repos: {}, activityReadAt: NOW.toISOString() });
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

describe("sync: timeline activity", () => {
  const recorded = {
    [`GET ${api(`${repoPath}/pulls`)}`]: json(pulls),
    [`GET ${api(`${repoPath}/issues`)}`]: json(issues),
    [`GET ${api(`${repoPath}/events`)}`]: json(repositoryEvents),
  };
  const activityKeys = (events: SyncResult["events"]) =>
    events.filter((event) => !event.typeId.startsWith("github.stars.") && !event.typeId.startsWith("github.forks.")).map((event) => event.dedupeKey);
  // The fixture's release v1.2.0 event, written out so each boundary case can bend one field of it.
  const releaseEvent = {
    type: "ReleaseEvent",
    actor: { id: 8300001, login: "maintainer-a" },
    created_at: "2026-10-31T08:00:01Z",
    payload: {
      action: "published",
      release: { id: 6000002, tag_name: "v1.2.0", draft: false, published_at: "2026-10-31T08:00:00Z", html_url: "https://github.com/example-org/example-repo/releases/tag/v1.2.0" },
    },
  };

  it("backfills a week of merges, opened issues, and published releases on the first sync (happy path)", async () => {
    const { ctx, callsTo } = harness(recorded);
    const result = await githubAdapter.sync(syncInput(), ctx);

    expect(checkSyncResult(githubAdapter, ACCOUNT_ID, result)).toEqual([]);
    expect(result.partialErrors).toBeUndefined();
    // Pull request 41 was closed unmerged, 40 merged before the week, issue 42 is pull request 42,
    // issue 39 was opened before the week, release v1.1.0 was published before the week, and the
    // watch and push events in the feed are not releases.
    expect(activityKeys(result.events)).toEqual([
      "github.pull_request.merged:5000001:42",
      "github.issue.opened:5000001:43",
      "github.release.published:5000001:6000002",
    ]);
    expect(result.events.filter((event) => event.typeId.startsWith("github.pull_") || event.typeId.startsWith("github.issue") || event.typeId.startsWith("github.release"))).toEqual([
      {
        typeId: "github.pull_request.merged",
        occurredAt: new Date("2026-10-31T10:00:00Z"),
        severity: "success",
        title: "Pull request #42 merged in example-org/example-repo",
        externalAccountId: ACCOUNT_ID,
        dedupeKey: "github.pull_request.merged:5000001:42",
        url: "https://github.com/example-org/example-repo/pull/42",
      },
      {
        typeId: "github.issue.opened",
        occurredAt: new Date("2026-10-31T11:00:00Z"),
        severity: "info",
        title: "Issue #43 opened in example-org/example-repo",
        externalAccountId: ACCOUNT_ID,
        dedupeKey: "github.issue.opened:5000001:43",
        url: "https://github.com/example-org/example-repo/issues/43",
      },
      {
        typeId: "github.release.published",
        occurredAt: new Date("2026-10-31T08:00:00Z"),
        severity: "success",
        title: "Release v1.2.0 published in example-org/example-repo",
        externalAccountId: ACCOUNT_ID,
        dedupeKey: "github.release.published:5000001:6000002",
        url: "https://github.com/example-org/example-repo/releases/tag/v1.2.0",
      },
    ]);
    // Titles, notes, and people (authors, the feed's actors) are never read.
    for (const text of ["Synthetic", "contributor-a", "reporter-a", "maintainer-a", "stargazer-a"]) expect(JSON.stringify(result.events)).not.toContain(text);

    const query = (path: string) => Object.fromEntries(callsTo("GET", api(`${repoPath}${path}`))[0]?.url.searchParams ?? []);
    expect(query("/pulls")).toEqual({ state: "closed", sort: "updated", direction: "desc", per_page: "100" });
    expect(query("/issues")).toEqual({ state: "all", sort: "created", direction: "desc", since: "2026-10-24T12:00:00.000Z", per_page: "100" });
    expect(query("/events")).toEqual({ per_page: "100", page: "1" });
    // No Contents read: the release list is never called.
    expect(callsTo("GET", api(`${repoPath}/releases`))).toEqual([]);
    expect((JSON.parse(result.cursor ?? "{}") as Cursor).activityReadAt).toBe(NOW.toISOString());
  });

  it("reads back to the previous sync less one poll interval, and the events feed six hours further, so the overlap is the same keys (boundary: chained syncs)", async () => {
    const first = await githubAdapter.sync(syncInput(), harness(recorded).ctx);
    // Half an hour later: the lists read from 11:00 less an hour, so only issue 43 (11:00) is in
    // them. The events feed reads from 04:00, GitHub's documented 6 hour latency earlier, so release
    // v1.2.0 (08:00) is read again; its key is the one already stored.
    const later = new Date("2026-10-31T12:30:00Z");
    const previous = { ...(JSON.parse(first.cursor ?? "{}") as Cursor), activityReadAt: "2026-10-31T11:00:00.000Z" };
    const next = await githubAdapter.sync(syncInput(JSON.stringify(previous)), harness(recorded, { now: later }).ctx);
    expect(activityKeys(next.events)).toEqual(["github.issue.opened:5000001:43", "github.release.published:5000001:6000002"]);
    expect(activityKeys(first.events)).toEqual(expect.arrayContaining(activityKeys(next.events)));
  });

  it.each([
    { name: "published inside the latency allowance", publishedAt: "2026-10-31T04:00:01Z", read: true },
    { name: "published exactly at the allowance's start", publishedAt: "2026-10-31T04:00:00Z", read: false },
  ])("reads a release that reached the feed late (boundary: $name)", async ({ publishedAt, read }) => {
    // The previous sync ran at 11:00, so the lists read from 10:00 and the feed from 04:00.
    const late = { ...releaseEvent, payload: { ...releaseEvent.payload, release: { ...releaseEvent.payload.release, published_at: publishedAt } } };
    const previous: Cursor = { v: 1, repos: {}, activityReadAt: "2026-10-31T11:00:00.000Z" };
    const { ctx } = harness({ ...recorded, [`GET ${api(`${repoPath}/events`)}`]: json([late]) });
    const result = await githubAdapter.sync(syncInput(JSON.stringify(previous)), ctx);
    expect(activityKeys(result.events).includes("github.release.published:5000001:6000002")).toBe(read);
  });

  it("reads further pages of the feed until it reaches back past the window, at most three (boundary: busy repository)", async () => {
    const watch = repositoryEvents[0];
    if (watch === undefined) throw new Error("expected the watch event fixture");
    const busy = Array.from({ length: 100 }, () => ({ ...watch, created_at: "2026-10-31T11:00:00Z" }));
    const pages: Record<string, unknown[]> = { "1": busy, "2": [...busy.slice(0, 99), releaseEvent], "3": busy };
    const { ctx, callsTo, warnings } = harness({
      ...recorded,
      [`GET ${api(`${repoPath}/events`)}`]: (call) => Response.json(pages[call.url.searchParams.get("page") ?? ""] ?? []),
    });
    const result = await githubAdapter.sync(syncInput(), ctx);
    expect(activityKeys(result.events)).toContain("github.release.published:5000001:6000002");
    // Page 2 ends with an event inside the window, so page 3 is read, and it is still full and inside: logged, and no page 4.
    expect(callsTo("GET", api(`${repoPath}/events`)).map((call) => call.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    expect(warnings).toContain("github.sync.activity_truncated");
  });

  it("stops at the first page that is short or reaches back past the window (boundary: one page)", async () => {
    const { ctx, callsTo, warnings } = harness(recorded);
    await githubAdapter.sync(syncInput(), ctx);
    expect(callsTo("GET", api(`${repoPath}/events`))).toHaveLength(1);
    expect(warnings).not.toContain("github.sync.activity_truncated");
  });

  it("fails the sync on a release event that lost its id or publish time, naming the template (boundary: feed payload drift)", async () => {
    const { id: _dropped, ...withoutId } = releaseEvent.payload.release;
    const drifted = { ...releaseEvent, payload: { ...releaseEvent.payload, release: withoutId } };
    const { ctx } = harness({ ...recorded, [`GET ${api(`${repoPath}/events`)}`]: json([drifted]) });
    const error = await githubAdapter.sync(syncInput(), ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect(error instanceof InvalidResponseError ? error.endpoint : undefined).toBe("https://api.github.com/repos/{owner}/{repo}/events");
  });

  it.each([
    { name: "first sync", previous: undefined, since: "2026-10-24T12:00:00.000Z" },
    { name: "previous sync an hour ago", previous: "2026-10-31T11:00:00.000Z", since: "2026-10-31T10:00:00.000Z" },
    { name: "previous sync more than a week ago", previous: "2026-10-01T00:00:00.000Z", since: "2026-10-24T12:00:00.000Z" },
    { name: "previous sync in the future (clock moved back)", previous: "2026-11-02T00:00:00.000Z", since: "2026-10-31T11:00:00.000Z" },
  ])("starts the activity read at the right time (boundary: $name)", ({ previous, since }) => {
    expect(activitySince(previous, NOW).toISOString()).toBe(since);
  });

  it("reports each activity permission an older installation lacks once, and still syncs stars and billing (boundary: permissions not accepted)", async () => {
    const repositories = [0, 1].map((index) => ({ ...installationRepositories.repositories[0], id: 5000001 + index }));
    const { ctx, calls, callsTo } = harness({
      ...recorded,
      [`GET ${api(`/app/installations/${INSTALLATION_ID}`)}`]: json({ ...installation, permissions: { metadata: "read", organization_administration: "read" } }),
      [`GET ${api("/installation/repositories")}`]: json({ total_count: 2, repositories }),
    });
    const result = await githubAdapter.sync(syncInput(), ctx);

    // Releases need only Metadata read, so they are still read.
    expect(result.partialErrors?.map((error) => error.missingScopes)).toEqual([["pull_requests:read"], ["issues:read"]]);
    expect(calls.some((call) => /\/(pulls|issues)$/.test(call.url.pathname))).toBe(false);
    expect(activityKeys(result.events)).toEqual(["github.release.published:5000001:6000002", "github.release.published:5000002:6000002"]);
    expect(metric(result.metrics, "github.stars.total")).toMatchObject({ value: 190 });
    expect(metric(result.metrics, "github.spend.actions")).toBeDefined();
    // The token asks only for what the installation holds: GitHub cannot grant more.
    const [mint] = callsTo("POST", api(`/app/installations/${INSTALLATION_ID}/access_tokens`));
    expect(JSON.parse(mint?.body ?? "{}")).toEqual({ permissions: { metadata: "read", organization_administration: "read" } });
  });

  it("reports a refused list as a partial error naming its permission and keeps the others (boundary: 403)", async () => {
    const { ctx } = harness({ ...recorded, [`GET ${api(`${repoPath}/issues`)}`]: json({ message: "Resource not accessible by integration" }, { status: 403 }) });
    const result = await githubAdapter.sync(syncInput(), ctx);
    expect(result.partialErrors).toHaveLength(1);
    const [refused] = result.partialErrors ?? [];
    expect(refused).toBeInstanceOf(PermissionMissingError);
    expect(refused?.missingScopes).toEqual(["issues:read"]);
    expect(refused?.endpoint).toBe("/repos/{owner}/{repo}/issues");
    expect(activityKeys(result.events)).toEqual(["github.pull_request.merged:5000001:42", "github.release.published:5000001:6000002"]);
  });

  it.each([404, 410])("skips a list that is gone or turned off for a repository without failing the sync (boundary: %d)", async (status) => {
    const { ctx, warnings } = harness({ ...recorded, [`GET ${api(`${repoPath}/issues`)}`]: json({ message: "Gone" }, { status }) });
    const result = await githubAdapter.sync(syncInput(), ctx);
    expect(result.partialErrors).toBeUndefined();
    expect(activityKeys(result.events)).toEqual(["github.pull_request.merged:5000001:42", "github.release.published:5000001:6000002"]);
    expect(warnings).toContain("github.sync.activity_unavailable");
  });

  it("fails on an outage naming the path template, never the repository, which can be private (boundary: 5xx)", async () => {
    const { ctx } = harness({ ...recorded, [`GET ${api(`${repoPath}/pulls`)}`]: json({ message: "boom" }, { status: 502 }) });
    const error = await githubAdapter.sync(syncInput(), ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    const failure = error instanceof ProviderUnavailableError ? error : undefined;
    expect(failure?.endpoint).toBe("https://api.github.com/repos/{owner}/{repo}/pulls");
    expect(failure?.message).toBe("https://api.github.com/repos/{owner}/{repo}/pulls is unavailable (502)");
    expect(failure?.status).toBe(502);
  });

  it("names the template when a star count read fails too (boundary: private repository in an error)", async () => {
    const { ctx } = harness({ [`GET ${api(`${repoPath}/stargazers/count`)}`]: json({ message: "Not Found" }, { status: 404 }) });
    const error = await githubAdapter.sync(syncInput(), ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidResponseError);
    expect(JSON.stringify({ message: error instanceof Error ? error.message : "", endpoint: error instanceof InvalidResponseError ? error.endpoint : "" })).not.toContain("example-repo");
  });

  it("logs a full page of merges that still reaches into the read window (boundary: page cap)", async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({
      ...pulls[0],
      number: 1000 + index,
      merged_at: "2026-10-31T11:00:00Z",
      updated_at: "2026-10-31T11:00:00Z",
    }));
    const { ctx, warnings } = harness({ ...recorded, [`GET ${api(`${repoPath}/pulls`)}`]: json(full) });
    const result = await githubAdapter.sync(syncInput(), ctx);
    expect(result.events.filter((event) => event.typeId === "github.pull_request.merged")).toHaveLength(100);
    expect(warnings).toContain("github.sync.activity_truncated");

    const { ctx: shortCtx, warnings: shortWarnings } = harness({ ...recorded, [`GET ${api(`${repoPath}/pulls`)}`]: json(full.slice(0, 99)) });
    await githubAdapter.sync(syncInput(), shortCtx);
    expect(shortWarnings).not.toContain("github.sync.activity_truncated");
  });

  it("keeps an event and drops a link that is not https (boundary: non-https html_url)", async () => {
    const { ctx } = harness({ ...recorded, [`GET ${api(`${repoPath}/pulls`)}`]: json([{ ...pulls[0], html_url: "http://github.example/pull/42" }]) });
    const result = await githubAdapter.sync(syncInput(), ctx);
    const merged = result.events.find((event) => event.typeId === "github.pull_request.merged");
    expect(merged?.dedupeKey).toBe("github.pull_request.merged:5000001:42");
    expect(merged?.url).toBeUndefined();
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
      for (const list of ["pulls", "issues", "events"]) routes[`GET ${api(`/repos/example-org/${repo.name}/${list}`)}`] = json([]);
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

describe("webhooks", () => {
  // Made up, and built from parts so CI's secret scan (gitleaks) does not read it as a credential.
  const WEBHOOK_SECRET = new Secret(["github", "webhook", "value"].join("-"));
  const DELIVERY_ID = "72d3162e-cc78-11e3-81ab-4c9367dc0958";

  function descriptor(): WebhookDescriptor {
    const { webhooks } = githubAdapter;
    if (webhooks === undefined) throw new Error("the GitHub adapter declares no webhook");
    return webhooks;
  }

  type Delivery = Partial<{ secret: Secret; signedBody: string; signature: string | null; deliveryId: string | null }>;

  // A delivery as GitHub sends it; each option bends one part of it for a boundary test.
  function delivery(event: string | null, body: unknown, options: Delivery = {}): WebhookRequest {
    const rawBody = typeof body === "string" ? body : JSON.stringify(body);
    const headers = new Headers({ "content-type": "application/json" });
    if (event !== null) headers.set("x-github-event", event);
    const deliveryId = options.deliveryId === undefined ? DELIVERY_ID : options.deliveryId;
    if (deliveryId !== null) headers.set("x-github-delivery", deliveryId);
    const signature = options.signature === undefined ? githubWebhookSignature(options.secret ?? WEBHOOK_SECRET, options.signedBody ?? rawBody) : options.signature;
    if (signature !== null) headers.set("x-hub-signature-256", signature);
    return { headers, rawBody: new TextEncoder().encode(rawBody) };
  }

  /** Verifies, then parses, as the route does. */
  function received(event: string | null, body: unknown, now: Date = NOW) {
    const request = delivery(event, body);
    expect(descriptor().verify(request, WEBHOOK_SECRET, now)).toEqual({ ok: true, deliveryId: DELIVERY_ID });
    const { ctx, warnings } = harness({}, { now });
    const outcome = descriptor().parse(request, ctx);
    // Parsing is synchronous and network free, and logs nothing: a body never reaches a log.
    expect(warnings).toEqual([]);
    return outcome;
  }

  it("is an app registration whose secret is GITHUB_APP_WEBHOOK_SECRET, subscribed to the timeline and app events", () => {
    expect(descriptor().registration).toEqual({ kind: "app", secretEnv: "GITHUB_APP_WEBHOOK_SECRET" });
    // No `release`: it needs Contents read, so releases are polled from the events feed.
    expect(descriptor().subscriptions).toEqual(["pull_request", "issues", "star", "installation", "github_app_authorization"]);
    expect(checkAdapterDeclaration(githubAdapter)).toEqual([]);
  });

  it("signs like GitHub's documented test vector", () => {
    // docs.github.com, "Validating webhook deliveries", "Testing the webhook payload validation".
    expect(githubWebhookSignature(new Secret("It's a Secret to Everybody"), "Hello, World!")).toBe(
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    );
  });

  it("verifies the raw bytes before anything parses them, whatever they hold", () => {
    expect(descriptor().verify(delivery("ping", "not json at all"), WEBHOOK_SECRET, NOW)).toEqual({ ok: true, deliveryId: DELIVERY_ID });
  });

  it.each<[string, Delivery, string]>([
    ["no signature", { signature: null }, "missing_signature"],
    ["an empty signature", { signature: "" }, "missing_signature"],
    ["a signature made with another secret", { secret: new Secret("another-webhook-value") }, "bad_signature"],
    ["a tampered body", { signedBody: JSON.stringify(pullRequestClosedDelivery).replace("9000001", "9000003") }, "bad_signature"],
    ["the legacy SHA-1 header format", { signature: "sha1=7d38cdd689735b008b3c702edd92eea23791c5f6" }, "bad_signature"],
    ["the hex digest without its sha256= prefix", { signature: githubWebhookSignature(new Secret(["github", "webhook", "value"].join("-")), JSON.stringify(pullRequestClosedDelivery)).slice("sha256=".length) }, "bad_signature"],
    ["no delivery id", { deliveryId: null }, "malformed"],
    ["a blank delivery id", { deliveryId: "   " }, "malformed"],
    ["a delivery id over 200 characters", { deliveryId: "d".repeat(201) }, "malformed"],
  ])("rejects a delivery with %s (boundary)", (_case, options, reason) => {
    expect(descriptor().verify(delivery("pull_request", pullRequestClosedDelivery, options), WEBHOOK_SECRET, NOW)).toEqual({ ok: false, reason });
  });

  it("maps a merge and an opened issue to the events the sync stores for them", async () => {
    const { ctx } = harness({
      [`GET ${api(`${repoPath}/pulls`)}`]: json(pulls),
      [`GET ${api(`${repoPath}/issues`)}`]: json(issues),
    });
    const polled = (await githubAdapter.sync(syncInput(), ctx)).events;

    for (const [event, body, dedupeKey] of [
      ["pull_request", pullRequestClosedDelivery, "github.pull_request.merged:5000001:42"],
      ["issues", issueOpenedDelivery, "github.issue.opened:5000001:43"],
    ] as const) {
      const outcome = received(event, body);
      expect(checkWebhookOutcome(githubAdapter, outcome), event).toEqual([]);
      // One dedupe key and one event whichever path brings it, so the timeline stores it once.
      const same = polled.find((candidate) => candidate.dedupeKey === dedupeKey);
      expect(same, event).toBeDefined();
      expect(outcome, event).toEqual({ kind: "events", externalAccountId: ACCOUNT_ID, events: [same] });
      // The repository owner is the installation account, so the delivery lands where the sync does.
      // Titles, notes, and people (the sender, the author) never reach the event.
      for (const text of ["Synthetic", "contributor-a", "reporter-a", "maintainer-a"]) expect(JSON.stringify(outcome), event).not.toContain(text);
    }
  });

  it("puts a new star on the timeline at once, without the stargazer", () => {
    const outcome = received("star", starCreatedDelivery);
    expect(checkWebhookOutcome(githubAdapter, outcome)).toEqual([]);
    expect(outcome).toEqual({
      kind: "events",
      externalAccountId: ACCOUNT_ID,
      events: [
        {
          typeId: "github.stars.new",
          occurredAt: new Date("2026-10-31T11:30:00Z"),
          severity: "info",
          title: "New star on example-org/example-repo",
          externalAccountId: ACCOUNT_ID,
          dedupeKey: "github.stars.new:5000001:2026-10-31T11:30:00.000Z",
          url: "https://github.com/example-org/example-repo",
        },
      ],
    });
    expect(JSON.stringify(outcome)).not.toContain("stargazer-a");
    // A redelivery, or a replay under a new delivery id, is the same star.
    expect(received("star", starCreatedDelivery)).toEqual(outcome);
  });

  it("marks the account's connections as needing a reconnect when the app is uninstalled, at the time it arrives", () => {
    const outcome = received("installation", installationDeleted);
    // GitHub gives no removal time (the installation's own `updated_at` predates it).
    expect(outcome).toEqual({ kind: "uninstalled", externalAccountId: ACCOUNT_ID, occurredAt: NOW });
    expect(checkWebhookOutcome(githubAdapter, outcome)).toEqual([]);
  });

  it("marks them when the installation is suspended, at the signed suspension time", () => {
    const outcome = received("installation", installationSuspend);
    expect(outcome).toEqual({ kind: "uninstalled", externalAccountId: ACCOUNT_ID, occurredAt: new Date("2026-10-31T11:45:00Z") });
  });

  it("falls back to the arrival time for a suspension without its time (boundary: suspended_at null)", () => {
    const body = { ...installationSuspend, installation: { ...installationSuspend.installation, suspended_at: null } };
    expect(received("installation", body)).toEqual({ kind: "uninstalled", externalAccountId: ACCOUNT_ID, occurredAt: NOW });
  });

  it("marks the revoking user's own account when they revoke the app's authorization (personal account connection)", () => {
    // Only a personal account connection holds a user token, and its account id is the user's.
    const outcome = received("github_app_authorization", appAuthorizationRevoked);
    expect(outcome).toEqual({ kind: "uninstalled", externalAccountId: "9000002", occurredAt: NOW });
    expect(checkWebhookOutcome(githubAdapter, outcome)).toEqual([]);
    // Never the organization: its connection syncs with installation tokens a revoked authorization does not touch.
    expect(outcome.kind === "uninstalled" ? outcome.externalAccountId : undefined).not.toBe(ACCOUNT_ID);
  });

  it.each<[string, string | null, unknown]>([
    ["a pull request closed without merging", "pull_request", { ...pullRequestClosedDelivery, pull_request: { ...pullRequestClosedDelivery.pull_request, merged: false, merged_at: null } }],
    ["a pull request opened", "pull_request", { ...pullRequestClosedDelivery, action: "opened" }],
    ["an issue edited", "issues", { ...issueOpenedDelivery, action: "edited" }],
    // Not subscribed (it needs Contents read): a delivery that arrives anyway is ignored, and the
    // events feed brings the release.
    ["a release, which the app does not subscribe to", "release", { action: "published", repository: pullRequestClosedDelivery.repository, release: { id: 6000002, tag_name: "v1.2.0", draft: false, published_at: "2026-10-31T08:00:00Z", html_url: "https://github.com/example-org/example-repo/releases/tag/v1.2.0" } }],
    ["an unstar, which the daily net counts", "star", { ...starCreatedDelivery, action: "deleted", starred_at: null }],
    ["a star without its time", "star", { ...starCreatedDelivery, starred_at: null }],
    ["an installation unsuspended", "installation", { ...installationSuspend, action: "unsuspend" }],
    ["an installation created", "installation", { ...installationDeleted, action: "created" }],
    ["new permissions accepted", "installation", { ...installationDeleted, action: "new_permissions_accepted" }],
    ["an event StackDash does not subscribe to", "push", pullRequestClosedDelivery],
    ["GitHub's ping", "ping", { zen: "Keep it logically awesome.", hook_id: 1 }],
    ["no event name", null, pullRequestClosedDelivery],
    // The event header is not signed: a signed issue body sent as a pull request matches no schema.
    ["a signed body under another event's name", "pull_request", issueOpenedDelivery],
    ["a revoked authorization with no sender", "github_app_authorization", { action: "revoked" }],
    ["a body that is not JSON (a form-encoded registration)", "pull_request", "payload=%7B%7D"],
  ])("ignores %s (boundary)", (_case, event, body) => {
    expect(received(event, body)).toMatchObject({ kind: "ignored" });
  });

  it("keeps the event and drops a link that is not https (boundary: non-https html_url)", () => {
    const body = { ...issueOpenedDelivery, issue: { ...issueOpenedDelivery.issue, html_url: "http://github.example/issues/43" } };
    const outcome = received("issues", body);
    expect(outcome.kind === "events" ? outcome.events[0]?.url : "not events").toBeUndefined();
  });
});
