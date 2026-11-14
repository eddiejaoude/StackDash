import { describe, expect, it } from "vitest";
import type { Logger } from "@/lib/log/logger";
import { AuthRevokedError, InvalidResponseError, PermissionMissingError, RateLimitedError } from "../errors";
import { validateAdapterEvents } from "../events";
import { validateAdapterMetrics, type AdapterMetric } from "../metrics";
import { Secret, type FetchLike, type OAuthContext, type OAuthCredential, type SyncResult } from "../types";
import { deploymentEvent, gitlabAdapter, MAX_ACTIVITY_PROJECTS, metricKeys, pipelineEvent, projectMinutesKey, PRICING_SOURCE } from "./index";

// Fixtures follow the sample responses in the official API reference, checked 2026-11-05, trimmed,
// with synthetic names, emails, and tokens (docs/providers/gitlab.md, "Sample responses"):
import deployments from "./fixtures/deployments.json"; // https://docs.gitlab.com/api/deployments/ (statuses and dates changed)
import mergeRequests from "./fixtures/merge-requests.json"; // https://docs.gitlab.com/api/merge_requests/
import namespaceGroup from "./fixtures/namespace-group.json"; // https://docs.gitlab.com/api/namespaces/ (plan set to free)
import namespaces from "./fixtures/namespaces.json"; // https://docs.gitlab.com/api/namespaces/
import pipelines from "./fixtures/pipelines.json"; // https://docs.gitlab.com/api/pipelines/ (statuses and dates changed)
import projects from "./fixtures/projects.json"; // https://docs.gitlab.com/api/groups/ (list a group's projects)
import releases from "./fixtures/releases.json"; // https://docs.gitlab.com/api/releases/ (an upcoming and an old release added)
import tokenRefreshed from "./fixtures/token-refreshed.json"; // https://docs.gitlab.com/api/oauth2/ (refresh example)
import token from "./fixtures/token.json"; // https://docs.gitlab.com/api/oauth2/
import usage from "./fixtures/usage.json"; // fields from https://docs.gitlab.com/api/graphql/reference/ (no sample there; values synthetic)
import user from "./fixtures/user.json"; // https://docs.gitlab.com/api/users/ (retrieve the current user)

const NOW = new Date("2026-11-05T12:00:00Z");
const NAMESPACE_ID = "2";
const PROJECT_ID = 9;
const REDIRECT_URI = "https://stackdash.example.com/api/connections/gitlab/callback";

type Recorded = Readonly<{ method: string; url: URL; body: string | undefined }>;
type Handler = (request: Recorded) => Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const projectPath = `/api/v4/projects/${PROJECT_ID}`;

const defaults: Readonly<Record<string, Handler>> = {
  "POST /oauth/token": () => json(token),
  "POST /oauth/revoke": () => json({}),
  "GET /api/v4/user": () => json(user),
  "GET /api/v4/namespaces": () => json(namespaces),
  [`GET /api/v4/namespaces/${NAMESPACE_ID}`]: () => json(namespaceGroup),
  "POST /api/graphql": () => json(usage),
  [`GET /api/v4/groups/${NAMESPACE_ID}/projects`]: () => json(projects),
  [`GET ${projectPath}/pipelines`]: () => json(pipelines),
  [`GET ${projectPath}/deployments`]: () => json(deployments),
  [`GET ${projectPath}/merge_requests`]: () => json(mergeRequests),
  [`GET ${projectPath}/releases`]: () => json(releases),
};

function harness(overrides: Readonly<Record<string, Handler>> = {}, now: Date = NOW) {
  const handlers = { ...defaults, ...overrides };
  const calls: Recorded[] = [];
  const warnings: string[] = [];
  const infos: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    expect(url.origin).toBe("https://gitlab.com");
    const request = { method: init?.method ?? "GET", url, body: init?.body === undefined ? undefined : String(init.body) };
    calls.push(request);
    const handler = handlers[`${request.method} ${url.pathname}`];
    if (handler === undefined) throw new Error(`unexpected request ${request.method} ${url.pathname}`);
    return handler(request);
  };
  const logger: Logger = {
    info: (event) => {
      infos.push(event);
    },
    warn: (event) => {
      warnings.push(event);
    },
    error: () => undefined,
  };
  const ctx: OAuthContext = {
    fetch,
    now: () => now,
    timeoutMs: 1000,
    logger,
    client: { clientId: "synthetic-app-id", clientSecret: new Secret("synthetic-app-secret"), extra: {} },
  };
  const callsTo = (method: string, path: string) => calls.filter((call) => call.method === method && call.url.pathname === path);
  return { ctx, calls, callsTo, warnings, infos };
}

const credential: OAuthCredential = {
  accessToken: new Secret("synthetic-gitlab-access-token"),
  refreshToken: new Secret("synthetic-gitlab-refresh-token"),
  expiresAt: new Date(NOW.getTime() + 7200 * 1000),
  scopes: ["read_api", "read_user"],
  tokenType: "bearer",
  metadata: { userId: "1", username: "example_user", redirectUri: REDIRECT_URI },
};

function expectValid(result: SyncResult): void {
  const metrics = validateAdapterMetrics("gitlab", result.metrics);
  expect(metrics.ok ? [] : metrics.issues).toEqual([]);
  const events = validateAdapterEvents(gitlabAdapter.eventTypes, result.events);
  expect(events.ok ? [] : events.issues).toEqual([]);
}

function metric(result: SyncResult, key: string): AdapterMetric | undefined {
  return result.metrics.find((candidate) => candidate.metricKey === key);
}

function value(result: SyncResult, key: string): number | undefined {
  const found = metric(result, key);
  return found !== undefined && "value" in found ? found.value : undefined;
}

describe("gitlabAdapter declaration", () => {
  it("requests only read_api and read_user, never api, with PKCE, and polls hourly", () => {
    expect(gitlabAdapter.oauth.scopes).toEqual(["read_api", "read_user"]);
    expect(gitlabAdapter.oauth.scopes).not.toContain("api");
    expect(gitlabAdapter.oauth.pkce).toBe(true);
    expect(gitlabAdapter.oauth.clientIdEnv).toBe("GITLAB_CLIENT_ID");
    expect(gitlabAdapter.oauth.clientSecretEnv).toBe("GITLAB_CLIENT_SECRET");
    expect(gitlabAdapter.pollIntervalSeconds).toBe(3600);
    expect(gitlabAdapter.permissions.map((permission) => [permission.scope, permission.access])).toEqual([
      ["read_api", "read"],
      ["read_user", "read"],
    ]);
    expect(gitlabAdapter.capabilities.spending).toBe(false);
    expect(gitlabAdapter.capabilities.webhooks).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("asks for both read scopes explicitly with an S256 challenge", () => {
    const url = gitlabAdapter.buildAuthorizeUrl({
      client: { clientId: "synthetic-app-id", clientSecret: new Secret("s"), extra: {} },
      state: "synthetic-state",
      redirectUri: REDIRECT_URI,
      codeChallenge: "synthetic-challenge",
    });
    expect(`${url.origin}${url.pathname}`).toBe("https://gitlab.com/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "synthetic-app-id",
      redirect_uri: REDIRECT_URI,
      response_type: "code",
      state: "synthetic-state",
      scope: "read_api read_user",
      code_challenge: "synthetic-challenge",
      code_challenge_method: "S256",
    });
  });

  it("refuses to build a URL without a PKCE challenge", () => {
    expect(() =>
      gitlabAdapter.buildAuthorizeUrl({
        client: { clientId: "id", clientSecret: new Secret("s"), extra: {} },
        state: "s",
        redirectUri: REDIRECT_URI,
      }),
    ).toThrow(TypeError);
  });
});

describe("exchangeCode", () => {
  it("posts the code and verifier with client credentials in the body, then reads the user", async () => {
    const { ctx, callsTo } = harness();
    const result = await gitlabAdapter.exchangeCode(
      { code: "synthetic-code", redirectUri: REDIRECT_URI, codeVerifier: "synthetic-verifier", callbackParams: {} },
      ctx,
    );

    const [tokenCall] = callsTo("POST", "/oauth/token");
    expect(Object.fromEntries(new URLSearchParams(tokenCall?.body))).toEqual({
      client_id: "synthetic-app-id",
      client_secret: "synthetic-app-secret",
      grant_type: "authorization_code",
      code: "synthetic-code",
      redirect_uri: REDIRECT_URI,
      code_verifier: "synthetic-verifier",
    });
    expect(callsTo("GET", "/api/v4/user")).toHaveLength(1);

    expect(result.accessToken.reveal()).toBe(token.access_token);
    expect(result.refreshToken?.reveal()).toBe(token.refresh_token);
    // Two hours from the response, which the sync runner refreshes before.
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + 7200 * 1000));
    // The documented token response has no `scope`, so the requested scopes stand in.
    expect(result.scopes).toEqual(["read_api", "read_user"]);
    expect(result.metadata).toEqual({ userId: "1", username: "example_user", redirectUri: REDIRECT_URI });
    expect(JSON.stringify(result)).not.toContain(token.access_token);
  });

  it("keeps the scopes GitLab reports, so a narrowed grant shows what is missing", async () => {
    const { ctx } = harness({ "POST /oauth/token": () => json({ ...token, scope: "read_user" }) });
    const result = await gitlabAdapter.exchangeCode(
      { code: "c", redirectUri: REDIRECT_URI, codeVerifier: "v", callbackParams: {} },
      ctx,
    );
    expect(result.scopes).toEqual(["read_user"]);
    expect(gitlabAdapter.detectMissingPermissions(result)).toEqual(["read_api"]);
  });

  it("refuses to exchange without a PKCE verifier and sends nothing", async () => {
    const { ctx, calls } = harness();
    await expect(
      gitlabAdapter.exchangeCode({ code: "c", redirectUri: REDIRECT_URI, callbackParams: {} }, ctx),
    ).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  it("reports a spent or unknown code (invalid_grant) as revoked", async () => {
    const { ctx } = harness({ "POST /oauth/token": () => json({ error: "invalid_grant" }, 400) });
    await expect(
      gitlabAdapter.exchangeCode({ code: "c", redirectUri: REDIRECT_URI, codeVerifier: "v", callbackParams: {} }, ctx),
    ).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("refreshTokens", () => {
  it("sends the refresh token and redirect URI and returns the new pair, keeping the metadata", async () => {
    const { ctx, callsTo } = harness({ "POST /oauth/token": () => json(tokenRefreshed) });
    const refreshed = await gitlabAdapter.refreshTokens?.(credential, ctx);
    if (refreshed === undefined) throw new Error("gitlab must refresh tokens");

    expect(Object.fromEntries(new URLSearchParams(callsTo("POST", "/oauth/token")[0]?.body))).toEqual({
      client_id: "synthetic-app-id",
      client_secret: "synthetic-app-secret",
      grant_type: "refresh_token",
      refresh_token: "synthetic-gitlab-refresh-token",
      redirect_uri: REDIRECT_URI,
    });
    expect(refreshed.accessToken.reveal()).toBe(tokenRefreshed.access_token);
    expect(refreshed.refreshToken?.reveal()).toBe(tokenRefreshed.refresh_token);
    expect(refreshed.expiresAt).toEqual(new Date(NOW.getTime() + 7200 * 1000));
    expect(refreshed.scopes).toEqual(credential.scopes);
    expect(refreshed.metadata).toEqual(credential.metadata);
  });

  it("reports a refresh token GitLab already invalidated (invalid_grant) as revoked", async () => {
    const { ctx } = harness({ "POST /oauth/token": () => json({ error: "invalid_grant" }, 400) });
    await expect(gitlabAdapter.refreshTokens?.(credential, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("keeps other 400 token errors as invalid_response, not revoked", async () => {
    const { ctx } = harness({ "POST /oauth/token": () => json({ error: "invalid_request" }, 400) });
    await expect(gitlabAdapter.refreshTokens?.(credential, ctx)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it("rejects a refresh answer without a new refresh token, since the old one is already spent", async () => {
    const { refresh_token: _dropped, ...withoutRefresh } = tokenRefreshed;
    const { ctx } = harness({ "POST /oauth/token": () => json(withoutRefresh) });
    await expect(gitlabAdapter.refreshTokens?.(credential, ctx)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("refuses to refresh a credential without a refresh token and sends nothing", async () => {
    const { ctx, calls } = harness();
    const { refreshToken: _omitted, ...accessOnly } = credential;
    await expect(gitlabAdapter.refreshTokens?.(accessOnly, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
    expect(calls).toHaveLength(0);
  });
});

describe("revoke", () => {
  it("revokes the grant through the refresh token with client credentials", async () => {
    const { ctx, callsTo } = harness();
    await gitlabAdapter.revoke?.(credential, ctx);
    expect(Object.fromEntries(new URLSearchParams(callsTo("POST", "/oauth/revoke")[0]?.body))).toEqual({
      client_id: "synthetic-app-id",
      client_secret: "synthetic-app-secret",
      token: "synthetic-gitlab-refresh-token",
    });
  });

  it("falls back to the access token when no refresh token is stored", async () => {
    const { ctx, callsTo } = harness();
    const { refreshToken: _omitted, ...accessOnly } = credential;
    await gitlabAdapter.revoke?.(accessOnly, ctx);
    expect(new URLSearchParams(callsTo("POST", "/oauth/revoke")[0]?.body).get("token")).toBe("synthetic-gitlab-access-token");
  });
});

describe("listAccounts", () => {
  it("lists owned top-level namespaces only, a group and the personal namespace", async () => {
    const { ctx, callsTo } = harness();
    const accounts = await gitlabAdapter.listAccounts(credential, ctx);
    expect(accounts).toEqual([
      { externalId: "1", displayName: "example_user", kind: "user" },
      { externalId: "2", displayName: "group1", kind: "group" },
    ]);
    const [call] = callsTo("GET", "/api/v4/namespaces");
    expect(call?.url.searchParams.get("owned_only")).toBe("true");
    expect(call?.url.searchParams.get("top_level_only")).toBe("true");
    expect(call?.url.searchParams.get("page")).toBe("1");
  });

  it("stops after five full pages and warns that the list was cut", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ ...namespaces[1], id: index + 100, full_path: `group${index}` }));
    const { ctx, callsTo, warnings } = harness({ "GET /api/v4/namespaces": () => json(fullPage) });
    const accounts = await gitlabAdapter.listAccounts(credential, ctx);
    expect(callsTo("GET", "/api/v4/namespaces")).toHaveLength(5);
    expect(accounts).toHaveLength(500);
    expect(warnings).toContain("gitlab.namespaces_truncated");
  });
});

describe("sync", () => {
  it("reports compute minutes, the estimated quota, storage, and activity, all valid", async () => {
    const { ctx, callsTo } = harness();
    const result = await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx);
    expectValid(result);

    expect(value(result, metricKeys.minutesUsed)).toBe(312);
    expect(metric(result, metricKeys.minutesUsed)).toMatchObject({
      kind: "usage",
      unit: "minutes",
      timeframe: { type: "period", start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-12-01T00:00:00Z") },
      resetsAt: new Date("2026-12-01T00:00:00Z"),
      provenance: { source: "provider_api" },
    });
    expect(metric(result, metricKeys.minutesIncluded)).toMatchObject({
      kind: "included_allowance",
      value: 400,
      label: "Monthly compute minutes on the Free plan (estimated)",
      provenance: { source: "derived", pricingSource: PRICING_SOURCE },
    });
    expect(value(result, metricKeys.minutesRemaining)).toBe(88);
    expect(value(result, projectMinutesKey(9))).toBe(250);
    expect(value(result, projectMinutesKey(10))).toBe(62);
    expect(metric(result, metricKeys.storageUsed)).toMatchObject({ value: 3, unit: "GiB", timeframe: { type: "point", at: NOW } });
    expect(metric(result, metricKeys.storageLimit)).toMatchObject({ kind: "included_allowance", value: 10, unit: "GiB" });
    expect(result.partialErrors).toBeUndefined();

    const [graphql] = callsTo("POST", "/api/graphql");
    expect(JSON.parse(graphql?.body ?? "{}").variables).toEqual({
      fullPath: "group1",
      namespaceId: "gid://gitlab/Namespace/2",
      month: "2026-11-01",
      projects: 20,
    });

    expect(result.events.map((event) => [event.typeId, event.severity, event.title])).toEqual([
      ["gitlab.pipeline.failed", "critical", "Pipeline #12 failed on main in group1/html5-boilerplate"],
      ["gitlab.pipeline.succeeded", "success", "Pipeline #13 succeeded on new-pipeline in group1/html5-boilerplate"],
      ["gitlab.deployment.succeeded", "success", "Deployment to production succeeded in group1/html5-boilerplate"],
      ["gitlab.deployment.failed", "warning", "Deployment to staging failed in group1/html5-boilerplate"],
      ["gitlab.merge_request.merged", "success", "Merge request !1 merged in group1/html5-boilerplate"],
      ["gitlab.release.published", "success", "Release v0.2 published in group1/html5-boilerplate"],
    ]);
    // Merge request titles and every author field stay at GitLab.
    expect(JSON.stringify(result.events)).not.toMatch(/test1|Example User|example_user|user@example\.com/);
    expect(result.cursor).toBe(JSON.stringify({ v: 1, since: NOW.toISOString() }));
  });

  it("reads seven days back on the first sync and ten minutes before the cursor after that", async () => {
    const first = harness();
    await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, first.ctx);
    expect(first.callsTo("GET", `${projectPath}/pipelines`)[0]?.url.searchParams.get("updated_after")).toBe(
      "2026-10-29T12:00:00.000Z",
    );

    const next = harness();
    const cursor = JSON.stringify({ v: 1, since: "2026-11-05T11:00:00.000Z" });
    await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID, cursor }, next.ctx);
    const params = (path: string) => next.callsTo("GET", `${projectPath}/${path}`)[0]?.url.searchParams;
    expect(Object.fromEntries(params("pipelines") ?? [])).toMatchObject({
      scope: "finished",
      updated_after: "2026-11-05T10:50:00.000Z",
      order_by: "updated_at",
    });
    // Deployments reject `updated_after` without `order_by=updated_at`.
    expect(Object.fromEntries(params("deployments") ?? [])).toMatchObject({
      updated_after: "2026-11-05T10:50:00.000Z",
      order_by: "updated_at",
    });
    expect(Object.fromEntries(params("merge_requests") ?? [])).toMatchObject({
      state: "merged",
      merged_after: "2026-11-05T10:50:00.000Z",
      order_by: "merged_at",
    });
  });

  it("drops releases older than the window and upcoming ones", async () => {
    const { ctx } = harness();
    const cursor = JSON.stringify({ v: 1, since: "2026-11-05T11:00:00.000Z" });
    const result = await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID, cursor }, ctx);
    // v0.2 was released at 01:56, before the window; v0.3 is upcoming; v0.1 is years old.
    expect(result.events.filter((event) => event.typeId === "gitlab.release.published")).toEqual([]);
  });

  it("restarts from the lookback with a warning when the cursor is unreadable", async () => {
    const { ctx, callsTo, warnings } = harness();
    await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID, cursor: "not json" }, ctx);
    expect(warnings).toContain("gitlab.sync.cursor_reset");
    expect(callsTo("GET", `${projectPath}/pipelines`)[0]?.url.searchParams.get("updated_after")).toBe("2026-10-29T12:00:00.000Z");
  });

  it("keeps the estimated quota but reports a partial error when GitLab hides usage from a non-owner", async () => {
    const { ctx } = harness({
      "POST /api/graphql": () => json({ data: { namespace: null, ciMinutesUsage: null, ciMinutesProjectMonthlyUsage: null } }),
    });
    const result = await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx);
    expectValid(result);
    expect(metric(result, metricKeys.minutesUsed)).toBeUndefined();
    expect(metric(result, metricKeys.minutesRemaining)).toBeUndefined();
    expect(metric(result, metricKeys.storageUsed)).toBeUndefined();
    expect(value(result, metricKeys.minutesIncluded)).toBe(400);
    expect(result.partialErrors).toHaveLength(1);
    expect(result.partialErrors?.[0]).toBeInstanceOf(PermissionMissingError);
    expect(result.partialErrors?.[0]?.missingScopes).toEqual(["read_api"]);
    // Activity still arrives.
    expect(result.events.length).toBeGreaterThan(0);
  });

  it("leaves out storage without a partial error when storage statistics are absent but minutes are present", async () => {
    const { ctx, infos } = harness({
      "POST /api/graphql": () =>
        json({ data: { ...usage.data, namespace: { actualSizeLimit: 10737418240, rootStorageStatistics: null } } }),
    });
    const result = await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx);
    expectValid(result);
    expect(result.partialErrors).toBeUndefined();
    expect(infos).toContain("gitlab.usage.storage_unavailable");
    expect(metric(result, metricKeys.storageUsed)).toBeUndefined();
    expect(metric(result, metricKeys.storageLimit)).toBeUndefined();
    expect(metric(result, metricKeys.minutesUsed)).toBeDefined();
  });

  it("fails the sync on a request-level GraphQL error and logs it by count only", async () => {
    const { ctx, warnings } = harness({
      "POST /api/graphql": () =>
        json({ data: null, errors: [{ message: "The resource that you are attempting to access does not exist" }] }),
    });
    await expect(gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx)).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
    expect(warnings).toContain("gitlab.usage.graphql_errors");
  });

  it("fails the sync when one field errors beside data instead of reporting a missing scope", async () => {
    const { ctx, warnings } = harness({
      "POST /api/graphql": () =>
        json({ data: { ...usage.data, ciMinutesUsage: null }, errors: [{ message: "Internal server error" }] }),
    });
    await expect(gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx)).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
    expect(warnings).toContain("gitlab.usage.graphql_errors");
  });

  it("counts a month with no usage row yet as zero minutes used", async () => {
    const { ctx } = harness({
      "POST /api/graphql": () =>
        json({ data: { ...usage.data, ciMinutesUsage: { nodes: [] }, ciMinutesProjectMonthlyUsage: { nodes: [] } } }),
    });
    const result = await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx);
    expect(value(result, metricKeys.minutesUsed)).toBe(0);
    expect(value(result, metricKeys.minutesRemaining)).toBe(400);
  });

  it.each([
    ["a trial plan", "ultimate_trial"],
    ["no plan", null],
  ])("gives no estimated quota for %s", async (_title, plan) => {
    const { ctx } = harness({ [`GET /api/v4/namespaces/${NAMESPACE_ID}`]: () => json({ ...namespaceGroup, plan }) });
    const result = await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx);
    expectValid(result);
    expect(metric(result, metricKeys.minutesIncluded)).toBeUndefined();
    expect(metric(result, metricKeys.minutesRemaining)).toBeUndefined();
    expect(value(result, metricKeys.minutesUsed)).toBe(312);
  });

  it("never goes below zero minutes left once purchased minutes are in use", async () => {
    const { ctx } = harness({
      "POST /api/graphql": () =>
        json({ data: { ...usage.data, ciMinutesUsage: { nodes: [{ monthIso8601: "2026-11-01", minutes: 455 }] } } }),
    });
    const result = await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx);
    expect(value(result, metricKeys.minutesRemaining)).toBe(0);
  });

  it("shows no storage limit when GitLab reports none", async () => {
    const { ctx } = harness({
      "POST /api/graphql": () =>
        json({ data: { ...usage.data, namespace: { actualSizeLimit: 0, rootStorageStatistics: { storageSize: 0 } } } }),
    });
    const result = await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx);
    expect(metric(result, metricKeys.storageLimit)).toBeUndefined();
    expect(value(result, metricKeys.storageUsed)).toBe(0);
  });

  it("rejects a project id that is not a GitLab global id", async () => {
    const { ctx } = harness({
      "POST /api/graphql": () =>
        json({
          data: {
            ...usage.data,
            ciMinutesProjectMonthlyUsage: { nodes: [{ minutes: 1, project: { id: "42", fullPath: "group1/x" } }] },
          },
        }),
    });
    await expect(gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx)).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });

  it("reads a personal namespace's projects through the user's projects", async () => {
    const personal = { ...namespaces[0] };
    const { ctx, callsTo } = harness({
      "GET /api/v4/namespaces/1": () => json(personal),
      "GET /api/v4/users/example_user/projects": () => json([]),
    });
    const result = await gitlabAdapter.sync({ credential, externalAccountId: "1" }, ctx);
    expect(callsTo("GET", "/api/v4/users/example_user/projects")[0]?.url.searchParams.get("per_page")).toBe(
      String(MAX_ACTIVITY_PROJECTS),
    );
    expect(result.events).toEqual([]);
  });

  it("asks for subgroup projects of a group, excluding shared and archived ones", async () => {
    const { ctx, callsTo } = harness();
    await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx);
    expect(Object.fromEntries(callsTo("GET", `/api/v4/groups/${NAMESPACE_ID}/projects`)[0]?.url.searchParams ?? [])).toEqual({
      archived: "false",
      simple: "true",
      order_by: "last_activity_at",
      sort: "desc",
      per_page: String(MAX_ACTIVITY_PROJECTS),
      include_subgroups: "true",
      with_shared: "false",
    });
  });

  it.each([
    ["403, CI/CD disabled", 403],
    ["404, feature off", 404],
  ])("skips one project endpoint on %s and keeps the rest", async (_title, status) => {
    const { ctx } = harness({ [`GET ${projectPath}/pipelines`]: () => json({ message: "403 Forbidden" }, status) });
    const result = await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx);
    expect(result.events.some((event) => event.typeId.startsWith("gitlab.pipeline."))).toBe(false);
    expect(result.events.some((event) => event.typeId.startsWith("gitlab.deployment."))).toBe(true);
    expect(result.partialErrors).toBeUndefined();
  });

  it("fails the sync as revoked when the token is rejected", async () => {
    const { ctx } = harness({ [`GET /api/v4/namespaces/${NAMESPACE_ID}`]: () => json({ message: "401 Unauthorized" }, 401) });
    await expect(gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("passes a 429 on with GitLab's Retry-After", async () => {
    const { ctx } = harness({ [`GET ${projectPath}/releases`]: () => json({}, 429, { "Retry-After": "30" }) });
    await expect(gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx)).rejects.toMatchObject({
      constructor: RateLimitedError,
      retryAfterMs: 30_000,
    });
  });

  it("warns when a project page is full, because older items were not read", async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({ ...pipelines[1], id: 1000 + index, iid: 1000 + index }));
    const { ctx, warnings } = harness({ [`GET ${projectPath}/pipelines`]: () => json(full) });
    await gitlabAdapter.sync({ credential, externalAccountId: NAMESPACE_ID }, ctx);
    expect(warnings).toContain("gitlab.activity.page_full");
  });

  it("refuses an external account that is not a namespace id before any request", async () => {
    const { ctx, calls } = harness();
    await expect(gitlabAdapter.sync({ credential, externalAccountId: "../user" }, ctx)).rejects.toBeInstanceOf(InvalidResponseError);
    expect(calls).toHaveLength(0);
  });
});

describe("event builders", () => {
  const project = { id: 9, path_with_namespace: "group1/app", default_branch: "main" };

  it("marks a failed production deployment critical and a review app failure a warning", () => {
    const base = { id: 1, iid: 1, ref: "main", updated_at: NOW };
    const production = deploymentEvent(project, { ...base, status: "failed", environment: { id: 1, name: "production" } }, "2");
    const review = deploymentEvent(project, { ...base, status: "failed", environment: { id: 2, name: "review/fix-login" } }, "2");
    expect(production?.severity).toBe("critical");
    expect(review?.severity).toBe("warning");
    expect(deploymentEvent(project, { ...base, status: "running", environment: { id: 1, name: "production" } }, "2")).toBeUndefined();
  });

  it("warns, not alarms, on a failed pipeline off the default branch", () => {
    const failed = pipelineEvent(project, { id: 1, iid: 1, status: "failed", ref: "feature/x", web_url: "", updated_at: NOW }, "2");
    expect(failed?.severity).toBe("warning");
    // A missing or non-https link is left out rather than stored.
    expect(failed?.url).toBeUndefined();
  });

  it("shortens very long project paths and refs with an ellipsis so titles stay valid", () => {
    const long = { ...project, path_with_namespace: `group/${"a".repeat(300)}` };
    const event = pipelineEvent(long, { id: 1, iid: 1, status: "success", ref: "b".repeat(300), web_url: "", updated_at: NOW }, "2");
    expect(event?.title.length).toBeLessThanOrEqual(200);
    expect(event?.title).toContain("…");
    const events = validateAdapterEvents(gitlabAdapter.eventTypes, [event]);
    expect(events.ok).toBe(true);
  });
});
