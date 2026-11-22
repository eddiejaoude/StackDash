import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuthRevokedError,
  InvalidResponseError,
  PermissionMissingError,
  RateLimitedError,
} from "../errors";
import { validateAdapterEvents, type ActivityEvent } from "../events";
import { dashboardSpendAfterSync } from "../harness";
import { validateAdapterMetrics, type AdapterMetric } from "../metrics";
import { Secret, type FetchLike, type OAuthContext, type OAuthCredential } from "../types";
import { billingMetrics, deploymentEvents, GRAPHQL_URL, PRICING_SOURCE, railwayAdapter } from "./index";
import { BillingDataSchema, DeploymentSchema, RAILWAY_ISSUER, type BillingData, type Deployment } from "./schemas";
// Every fixture below is from documentation, not recorded: no Railway account exists yet (#141).
// Checked 2026-11-05, values synthetic.
// - token.json, token-refreshed.json: POST /oauth/token responses from "Login & Tokens"
//   (https://docs.railway.com/integrations/oauth/login-and-tokens), with workspace:viewer added.
import tokenRefreshedFixture from "./fixtures/token-refreshed.json";
import tokenFixture from "./fixtures/token.json";
// - workspaces.json: `me { workspaces { id name } }` response from "Fetching Workspaces or Projects"
//   (https://docs.railway.com/integrations/oauth/fetching-workspaces-or-projects).
import workspacesFixture from "./fixtures/workspaces.json";
// - projects.json, deployments.json, billing.json: shaped from the Public API schema (introspection
//   of https://backboard.railway.com/graphql/v2) and the deployment statuses in "Manage Deployments"
//   (https://docs.railway.com/integrations/api/manage-deployments). deployments.json carries
//   creator and commit fields the query never selects, so the tests prove they are dropped.
import billingFixture from "./fixtures/billing.json";
import deploymentsFixture from "./fixtures/deployments.json";
import projectsFixture from "./fixtures/projects.json";
// - not-authorized.json: the error shape from "Public API, Errors"
//   (https://docs.railway.com/integrations/api), with Railway's documented "Not Authorized" message.
import notAuthorizedFixture from "./fixtures/not-authorized.json";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const CLIENT_ID = "client-railway-1";
const CLIENT_SECRET = "synthetic-client-secret";
const WORKSPACE = "ws-synthetic-1";
const REDIRECT_URI = "https://stackdash.example/api/connections/railway/callback";
const VERIFIER = "v".repeat(43);

type Call = { method: string; url: URL; headers: Headers; body: string };
type Route = (call: Call) => Response;
type Operation = "StackDashWorkspaces" | "StackDashProjects" | "StackDashDeployments" | "StackDashBilling";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const GraphqlRequestSchema = z.object({ query: z.string(), variables: z.record(z.string(), z.unknown()) });

function graphqlBody(call: Call): z.infer<typeof GraphqlRequestSchema> {
  return GraphqlRequestSchema.parse(JSON.parse(call.body));
}

/** Routes the token endpoint by path and GraphQL calls by operation name. */
function harness(routes: Partial<Record<Operation | "token", Route>>) {
  const operations: Partial<Record<string, Route>> = routes;
  const calls: Call[] = [];
  const warnings: string[] = [];
  const fetch: FetchLike = async (input, init) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url: new URL(input),
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : "",
    };
    calls.push(call);
    if (call.method === "POST" && call.url.href === "https://backboard.railway.com/oauth/token") {
      return routes.token?.(call) ?? json({ error: "unexpected" }, 500);
    }
    if (call.method === "POST" && call.url.href === GRAPHQL_URL) {
      const operation = /query (StackDash\w+)/.exec(graphqlBody(call).query)?.[1] ?? "";
      const route = operations[operation];
      return route === undefined ? json({ errors: [{ message: "unexpected operation" }] }, 400) : route(call);
    }
    return json({ message: "not found" }, 404);
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
  const graphqlCalls = (operation: Operation) =>
    calls.filter((call) => call.url.href === GRAPHQL_URL && graphqlBody(call).query.includes(`query ${operation}`));
  return { ctx, calls, warnings, graphqlCalls };
}

const syncRoutes = (overrides: Partial<Record<Operation, Route>> = {}): Partial<Record<Operation, Route>> => ({
  StackDashProjects: () => json(projectsFixture),
  StackDashDeployments: () => json(deploymentsFixture),
  StackDashBilling: () => json(billingFixture),
  ...overrides,
});

const oneProject = { data: { workspace: { projects: { edges: [{ node: { id: "prj-shop", name: "shop" } }], pageInfo: { hasNextPage: false } } } } };

/** A deployment node as the deployments query returns it: JSON, with ISO timestamps. */
type DeploymentNode = Readonly<{
  id: string;
  status: Deployment["status"];
  createdAt: string;
  updatedAt: string;
  statusUpdatedAt: string;
  canRollback: boolean;
  service: { name: string };
  environment: { name: string };
}>;

function node(id: string, status: Deployment["status"], createdAt: string, statusAt: string, canRollback = false): DeploymentNode {
  return {
    id,
    status,
    createdAt,
    updatedAt: statusAt,
    statusUpdatedAt: statusAt,
    canRollback,
    service: { name: "web" },
    environment: { name: "production" },
  };
}

/** One page for project `d0`: a cursor means Railway reports more, `null` reports more without one. */
function deploymentsPage(nodes: readonly DeploymentNode[], endCursor: string | null | undefined) {
  return {
    data: {
      d0: {
        edges: nodes.map((item) => ({ node: item })),
        pageInfo: { hasNextPage: endCursor !== undefined, endCursor: endCursor ?? null },
      },
    },
  };
}

const credential: OAuthCredential = {
  accessToken: new Secret("synthetic-access-token-1"),
  refreshToken: new Secret("synthetic-refresh-token-1"),
  expiresAt: new Date(NOW.getTime() + 3_600_000),
  scopes: ["openid", "email", "profile", "offline_access", "workspace:viewer"],
  tokenType: "Bearer",
};

function form(call: Call | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call?.body));
}

function expectValid(metrics: readonly AdapterMetric[], events: readonly ActivityEvent[]): void {
  const checkedMetrics = validateAdapterMetrics("railway", metrics);
  expect(checkedMetrics.ok ? [] : checkedMetrics.issues).toEqual([]);
  const checkedEvents = validateAdapterEvents(railwayAdapter.eventTypes, events);
  expect(checkedEvents.ok ? [] : checkedEvents.issues).toEqual([]);
}

function metric(metrics: readonly AdapterMetric[], key: string): AdapterMetric {
  const found = metrics.find((candidate) => candidate.metricKey === key);
  if (found === undefined) throw new Error(`metric ${key} missing`);
  return found;
}

function amount(value: AdapterMetric): number {
  if (!("amountMinor" in value)) throw new Error(`${value.metricKey} is not money`);
  return value.amountMinor;
}

function billing(overrides: { plan?: BillingData["workspace"]["plan"]; estimatedUsage?: BillingData["estimatedUsage"] } = {}): BillingData {
  const parsed = BillingDataSchema.parse(billingFixture.data);
  return {
    ...parsed,
    workspace: { ...parsed.workspace, plan: overrides.plan ?? parsed.workspace.plan },
    estimatedUsage: overrides.estimatedUsage ?? parsed.estimatedUsage,
  };
}

describe("railwayAdapter declaration", () => {
  it("connects through OAuth with PKCE, read-only permissions, hourly polling, and no revoke endpoint", () => {
    expect(railwayAdapter.id).toBe("railway");
    expect(railwayAdapter.displayName).toBe("Railway");
    expect(railwayAdapter.oauth.pkce).toBe(true);
    expect(railwayAdapter.oauth.scopes).toEqual(["openid", "email", "profile", "offline_access", "workspace:viewer"]);
    expect(railwayAdapter.permissions.map((permission) => permission.access)).toEqual(["read", "read", "read", "read", "read"]);
    expect(railwayAdapter.permissions.map((permission) => permission.scope)).toEqual([...railwayAdapter.oauth.scopes]);
    expect(railwayAdapter.pollIntervalSeconds).toBe(3600);
    expect(railwayAdapter.revoke).toBeUndefined();
    expect(railwayAdapter.webhooks).toBeUndefined();
  });
});

describe("railwayAdapter.buildAuthorizeUrl", () => {
  it("asks for consent every time, so Railway issues a refresh token, with PKCE S256 and every scope", () => {
    const url = railwayAdapter.buildAuthorizeUrl({
      client: { clientId: CLIENT_ID, clientSecret: new Secret(CLIENT_SECRET), extra: {} },
      state: "state-abc",
      redirectUri: REDIRECT_URI,
      codeChallenge: "challenge-xyz",
    });
    expect(`${url.origin}${url.pathname}`).toBe("https://backboard.railway.com/oauth/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid email profile offline_access workspace:viewer",
      state: "state-abc",
      code_challenge: "challenge-xyz",
      code_challenge_method: "S256",
      prompt: "consent",
    });
  });

  it.each<[string, { state: string; codeChallenge?: string }]>([
    ["a missing PKCE challenge", { state: "s" }],
    ["an empty state", { state: "", codeChallenge: "c" }],
    ["a state over 1024 characters", { state: "s".repeat(1025), codeChallenge: "c" }],
  ])("rejects %s", (_title, params) => {
    expect(() =>
      railwayAdapter.buildAuthorizeUrl({
        client: { clientId: CLIENT_ID, clientSecret: new Secret(CLIENT_SECRET), extra: {} },
        redirectUri: REDIRECT_URI,
        ...params,
      }),
    ).toThrow();
  });
});

describe("railwayAdapter.exchangeCode", () => {
  it("exchanges the code with Basic client auth and the verifier, keeping the refresh token and expiry", async () => {
    const { ctx, calls } = harness({ token: () => json(tokenFixture) });
    const result = await railwayAdapter.exchangeCode(
      {
        code: "code-1",
        redirectUri: REDIRECT_URI,
        codeVerifier: VERIFIER,
        callbackParams: { code: "code-1", state: "s", iss: "https://backboard.railway.com" },
      },
      ctx,
    );
    const [call] = calls;
    expect(call?.headers.get("authorization")).toBe(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
    expect(form(call)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
    });
    expect(result.accessToken.reveal()).toBe("synthetic-access-token-1");
    expect(result.refreshToken?.reveal()).toBe("synthetic-refresh-token-1");
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + 3_600_000));
    expect(result.scopes).toEqual(["openid", "email", "profile", "offline_access", "workspace:viewer"]);
    // The id_token is not kept anywhere on the credential.
    expect(JSON.stringify({ ...result, accessToken: "", refreshToken: "" })).not.toContain("synthetic-id-token");
  });

  it("falls back to the requested scopes when the response omits scope", async () => {
    const { scope: _omitted, ...withoutScope } = tokenFixture;
    const { ctx } = harness({ token: () => json(withoutScope) });
    const result = await railwayAdapter.exchangeCode(
      { code: "c", redirectUri: REDIRECT_URI, codeVerifier: VERIFIER, callbackParams: { iss: RAILWAY_ISSUER } },
      ctx,
    );
    expect(railwayAdapter.detectMissingPermissions(result)).toEqual([]);
  });

  it("reports a grant without workspace:viewer or offline_access as missing permissions", async () => {
    const { ctx } = harness({ token: () => json({ ...tokenFixture, scope: "openid email profile" }) });
    const result = await railwayAdapter.exchangeCode(
      { code: "c", redirectUri: REDIRECT_URI, codeVerifier: VERIFIER, callbackParams: { iss: RAILWAY_ISSUER } },
      ctx,
    );
    expect(railwayAdapter.detectMissingPermissions(result)).toEqual(["offline_access", "workspace:viewer"]);
  });

  it.each([
    ["another issuer", { iss: "https://evil.example" }],
    ["no issuer", {}],
    ["an empty issuer", { iss: "" }],
  ])("refuses a callback with %s before calling the token endpoint", async (_title, callbackParams) => {
    const { ctx, calls } = harness({ token: () => json(tokenFixture) });
    await expect(
      railwayAdapter.exchangeCode({ code: "c", redirectUri: REDIRECT_URI, codeVerifier: VERIFIER, callbackParams }, ctx),
    ).rejects.toBeInstanceOf(InvalidResponseError);
    expect(calls).toHaveLength(0);
  });

  it.each([
    ["missing", undefined],
    ["too short", "v".repeat(42)],
    ["with a space", `${"v".repeat(42)} `],
  ])("refuses a %s code verifier", async (_title, codeVerifier) => {
    const { ctx } = harness({ token: () => json(tokenFixture) });
    await expect(
      railwayAdapter.exchangeCode(
        {
          code: "c",
          redirectUri: REDIRECT_URI,
          callbackParams: { iss: RAILWAY_ISSUER },
          ...(codeVerifier === undefined ? {} : { codeVerifier }),
        },
        ctx,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it.each([
    ["without a refresh token", (() => {
      const { refresh_token: _dropped, ...rest } = tokenFixture;
      return rest;
    })()],
    ["with a token type other than Bearer", { ...tokenFixture, token_type: "mac" }],
  ])("rejects a token response %s as invalid_response", async (_title, body) => {
    const { ctx } = harness({ token: () => json(body) });
    await expect(
      railwayAdapter.exchangeCode(
        { code: "c", redirectUri: REDIRECT_URI, codeVerifier: VERIFIER, callbackParams: { iss: RAILWAY_ISSUER } },
        ctx,
      ),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("reports invalid_grant as auth revoked and other 400 errors as invalid_response", async () => {
    const input = { code: "c", redirectUri: REDIRECT_URI, codeVerifier: VERIFIER, callbackParams: { iss: RAILWAY_ISSUER } };
    await expect(
      railwayAdapter.exchangeCode(input, harness({ token: () => json({ error: "invalid_grant" }, 400) }).ctx),
    ).rejects.toBeInstanceOf(AuthRevokedError);
    await expect(
      railwayAdapter.exchangeCode(input, harness({ token: () => json({ error: "invalid_request" }, 400) }).ctx),
    ).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe("railwayAdapter.refreshTokens", () => {
  it("rotates: sends the current refresh token and returns the new one, keeping metadata", async () => {
    const { ctx, calls } = harness({ token: () => json(tokenRefreshedFixture) });
    const result = await railwayAdapter.refreshTokens?.({ ...credential, metadata: { note: "kept" } }, ctx);
    if (result === undefined) throw new Error("railway must refresh tokens");
    expect(form(calls[0])).toEqual({ grant_type: "refresh_token", refresh_token: "synthetic-refresh-token-1" });
    expect(result.accessToken.reveal()).toBe("synthetic-access-token-2");
    expect(result.refreshToken?.reveal()).toBe("synthetic-refresh-token-2");
    expect(result.metadata).toEqual({ note: "kept" });
  });

  it("keeps the same refresh token when Railway has not rotated it yet", async () => {
    const { ctx } = harness({ token: () => json({ ...tokenRefreshedFixture, refresh_token: "synthetic-refresh-token-1" }) });
    const result = await railwayAdapter.refreshTokens?.(credential, ctx);
    expect(result?.refreshToken?.reveal()).toBe("synthetic-refresh-token-1");
  });

  it("reports a reused, rotated refresh token (invalid_grant) as auth revoked", async () => {
    const { ctx } = harness({ token: () => json({ error: "invalid_grant" }, 400) });
    await expect(railwayAdapter.refreshTokens?.(credential, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("asks for a reconnect without calling Railway when no refresh token is stored", async () => {
    const { ctx, calls } = harness({ token: () => json(tokenRefreshedFixture) });
    const { refreshToken: _omitted, ...accessOnly } = credential;
    await expect(railwayAdapter.refreshTokens?.(accessOnly, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
    expect(calls).toHaveLength(0);
  });
});

describe("railwayAdapter.listAccounts", () => {
  it("lists the workspaces picked at consent, without selecting any personal field", async () => {
    const { ctx, calls } = harness({ StackDashWorkspaces: () => json(workspacesFixture) });
    const accounts = await railwayAdapter.listAccounts(credential, ctx);
    expect(accounts).toEqual([
      { externalId: "ws-synthetic-1", displayName: "My Workspace", kind: "workspace" },
      { externalId: "ws-synthetic-2", displayName: "ACME Inc.", kind: "workspace" },
    ]);
    const [call] = calls;
    expect(call?.headers.get("authorization")).toBe("Bearer synthetic-access-token-1");
    expect(graphqlBody(call ?? { method: "", url: new URL(GRAPHQL_URL), headers: new Headers(), body: "{}" }).query).not.toMatch(
      /email|avatar|name\s*email|profile/,
    );
  });

  it.each([
    ["no workspaces", [], []],
    [
      "a blank workspace name",
      [{ id: "ws-blank", name: "   " }],
      [{ externalId: "ws-blank", displayName: "Railway workspace", kind: "workspace" }],
    ],
  ])("handles %s", async (_title, workspaces, expected) => {
    const { ctx } = harness({ StackDashWorkspaces: () => json({ data: { me: { workspaces } } }) });
    expect(await railwayAdapter.listAccounts(credential, ctx)).toEqual(expected);
  });

  it("reports Railway's Not Authorized answer (HTTP 200) as a missing permission", async () => {
    const { ctx } = harness({ StackDashWorkspaces: () => json(notAuthorizedFixture) });
    await expect(railwayAdapter.listAccounts(credential, ctx)).rejects.toMatchObject({
      code: "permission_missing",
      missingScopes: ["workspace:viewer"],
    });
  });

  it("reports a 401 as auth revoked", async () => {
    const { ctx } = harness({ StackDashWorkspaces: () => json({}, 401) });
    await expect(railwayAdapter.listAccounts(credential, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("railwayAdapter.sync", () => {
  it("turns deployments into timeline events and billing into metrics, with the latest status time as the cursor", async () => {
    const { ctx, graphqlCalls } = harness(syncRoutes());
    const result = await railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, ctx);
    expectValid(result.metrics, result.events);
    expect(result.partialErrors).toBeUndefined();

    const byKey = Object.fromEntries(result.events.map((event) => [event.dedupeKey, event]));
    expect(Object.keys(byKey).sort()).toEqual([
      "railway.deployment:dep-api-failed:building",
      "railway.deployment:dep-api-failed:failed",
      "railway.deployment:dep-docs-building:building",
      "railway.deployment:dep-docs-crashed:building",
      "railway.deployment:dep-docs-crashed:crashed",
      "railway.deployment:dep-preview-sleeping:building",
      "railway.deployment:dep-preview-sleeping:deployed",
      "railway.deployment:dep-web-removed:building",
      "railway.deployment:dep-web-removed:removed",
      "railway.deployment:dep-web-success:building",
      "railway.deployment:dep-web-success:deployed",
    ]);
    expect(byKey["railway.deployment:dep-web-success:deployed"]).toEqual({
      typeId: "railway.deployment.deployed",
      occurredAt: new Date("2026-11-05T11:03:00.000Z"),
      severity: "success",
      title: "Deployment of web to production succeeded",
      body: "Project: shop",
      externalAccountId: WORKSPACE,
      dedupeKey: "railway.deployment:dep-web-success:deployed",
    });
    expect(byKey["railway.deployment:dep-web-success:building"]?.occurredAt).toEqual(new Date("2026-11-05T11:00:00.000Z"));
    expect(byKey["railway.deployment:dep-api-failed:failed"]).toMatchObject({ severity: "warning", title: "Deployment of api to staging failed" });
    // "Production" matches whatever its case: a production crash is critical.
    expect(byKey["railway.deployment:dep-docs-crashed:crashed"]).toMatchObject({
      severity: "critical",
      title: "Deployment of docs in Production crashed",
      body: "Project: docs",
    });
    // Replaced between two polls: Railway can still roll back to it, so it built and succeeded.
    expect(byKey["railway.deployment:dep-web-removed:building"]?.occurredAt).toEqual(new Date("2026-11-04T09:00:00.000Z"));
    expect(byKey["railway.deployment:dep-web-removed:removed"]).toMatchObject({
      severity: "info",
      title: "Deployment of web to production succeeded, then was removed",
      occurredAt: new Date("2026-11-05T11:03:05.000Z"),
    });
    // Nothing personal from the deployment reaches an event.
    expect(JSON.stringify(result.events)).not.toMatch(/someone@example\.com|Someone|synthetic commit/);
    expect(result.cursor).toBe("2026-11-05T11:59:30.000Z");

    // One request each: projects, deployments for both projects, billing. Never a mutation. The
    // shop page reports more, but it already reaches deployments older than the window.
    expect(graphqlCalls("StackDashDeployments")).toHaveLength(1);
    const [deployments] = graphqlCalls("StackDashDeployments");
    if (deployments === undefined) throw new Error("expected a deployments call");
    expect(graphqlBody(deployments).variables).toEqual({ p0: "prj-shop", p1: "prj-docs" });
    expect(graphqlBody(deployments).query).toContain("includeDeleted: true");
    for (const call of graphqlCalls("StackDashProjects").concat(graphqlCalls("StackDashBilling"), [deployments])) {
      expect(graphqlBody(call).query).not.toMatch(/mutation|creator|meta|email/);
    }
    expect(graphqlBody(graphqlCalls("StackDashBilling")[0] ?? deployments).variables).toEqual({
      workspaceId: WORKSPACE,
      measurements: ["CPU_USAGE", "MEMORY_USAGE_GB", "NETWORK_TX_GB", "DISK_USAGE_GB"],
    });

    expect(result.metrics.map((item) => item.metricKey).sort()).toEqual([
      "railway.credits.balance",
      "railway.estimate.bill",
      "railway.plan.memory_per_service",
      "railway.plan.replicas_per_service",
      "railway.plan.vcpu_per_service",
      "railway.plan.volume_per_service",
      "railway.spend.usage",
      "railway.usage.cpu",
      "railway.usage.memory",
      "railway.usage.network_egress",
      "railway.usage.volume",
    ]);
  });

  it("counts Railway spend once on the dashboard: usage so far, not the projected bill", async () => {
    const result = await railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, harness(syncRoutes()).ctx);
    // The usage so far and the whole period's estimated bill, both in this billing period.
    const money = result.metrics.filter((item) => item.kind === "verified_spend" || item.kind === "estimated_spend");
    expect(money.map((item) => [item.metricKey, item.kind, amount(item)])).toEqual([
      ["railway.spend.usage", "verified_spend", 346],
      ["railway.estimate.bill", "estimated_spend", 580],
    ]);
    // billing.json's currentUsage 3.456 USD rounds once to 346 cents. The bill (580) is what the
    // whole period is expected to cost, not money spent on top of the usage.
    const USAGE_MINOR = 346;
    const once = [{ currency: "USD", verifiedMinor: USAGE_MINOR, estimatedMinor: null }];
    expect(dashboardSpendAfterSync(railwayAdapter, result.metrics, NOW)).toEqual({ provider: once, totals: once });
  });

  it("re-reads an hour before the cursor, and only that far", async () => {
    const { ctx } = harness(syncRoutes());
    const result = await railwayAdapter.sync(
      { credential, externalAccountId: WORKSPACE, cursor: "2026-11-05T11:30:00.000Z" },
      ctx,
    );
    // From 10:30 onwards, by when each deployment entered its status: the 09:15 crash and 02:00
    // sleep are not re-read; the deployment removed at 11:03 keeps its build start from the day before.
    expect(result.events.map((event) => event.dedupeKey).sort()).toEqual([
      "railway.deployment:dep-api-failed:building",
      "railway.deployment:dep-api-failed:failed",
      "railway.deployment:dep-docs-building:building",
      "railway.deployment:dep-web-removed:building",
      "railway.deployment:dep-web-removed:removed",
      "railway.deployment:dep-web-success:building",
      "railway.deployment:dep-web-success:deployed",
    ]);
    expect(result.cursor).toBe("2026-11-05T11:59:30.000Z");
  });

  it("keeps a cursor newer than every deployment, so a re-read never moves it back", async () => {
    const { ctx } = harness(syncRoutes());
    const result = await railwayAdapter.sync({ credential, externalAccountId: WORKSPACE, cursor: "2026-11-05T13:00:00.000Z" }, ctx);
    expect(result.cursor).toBe("2026-11-05T13:00:00.000Z");
  });

  it("ignores an unreadable cursor with a warning and falls back to the last 7 days", async () => {
    const { ctx, warnings } = harness(syncRoutes());
    const result = await railwayAdapter.sync({ credential, externalAccountId: WORKSPACE, cursor: "1730800000000" }, ctx);
    expect(warnings).toContain("railway.deployments.cursor_ignored");
    expect(result.events.some((event) => event.dedupeKey.includes("dep-web-old"))).toBe(false);
    expect(result.events).toHaveLength(11);
  });

  it.each([
    ["Not Authorized", () => json(notAuthorizedFixture)],
    ["an HTTP 403", () => json({}, 403)],
  ])("leaves billing unavailable on %s while deployments still sync", async (_title, billingRoute) => {
    const { ctx, warnings } = harness(syncRoutes({ StackDashBilling: billingRoute }));
    const result = await railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, ctx);
    expect(result.metrics).toEqual([]);
    expect(result.events).toHaveLength(11);
    expect(result.cursor).toBe("2026-11-05T11:59:30.000Z");
    const [gap] = result.partialErrors ?? [];
    expect(gap).toBeInstanceOf(PermissionMissingError);
    expect(gap?.missingScopes).toEqual(["workspace:viewer"]);
    expect(warnings).toContain("railway.billing.unavailable");
  });

  it.each([
    ["a null customer", () => json({ data: { ...billingFixture.data, workspace: { plan: "HOBBY", customer: null } } })],
    ["an unknown plan", () => json({ data: { ...billingFixture.data, workspace: { ...billingFixture.data.workspace, plan: "ENTERPRISE" } } })],
    ["a GraphQL validation error", () => json({ data: null, errors: [{ message: "Cannot query field", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }] })],
  ])("fails the sync as an invalid response on %s in billing, never as a missing permission", async (_title, billingRoute) => {
    const { ctx, warnings } = harness(syncRoutes({ StackDashBilling: billingRoute }));
    await expect(railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, ctx)).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(warnings).not.toContain("railway.billing.unavailable");
  });

  it("fails the whole sync on a billing rate limit, so the runner retries instead of losing billing", async () => {
    const { ctx } = harness(syncRoutes({ StackDashBilling: () => json({}, 429, { "Retry-After": "120" }) }));
    await expect(railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, ctx)).rejects.toMatchObject({
      code: "rate_limited",
      retryAfterMs: 120_000,
    });
    await expect(railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, ctx)).rejects.toBeInstanceOf(RateLimitedError);
  });

  it("fails as a missing permission when the grant no longer covers the workspace", async () => {
    const { ctx } = harness(syncRoutes({ StackDashProjects: () => json(notAuthorizedFixture) }));
    await expect(railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, ctx)).rejects.toMatchObject({
      code: "permission_missing",
      missingScopes: ["workspace:viewer"],
    });
  });

  it("fails as an invalid response on any other GraphQL error, without copying Railway's message", async () => {
    const { ctx } = harness(
      syncRoutes({
        StackDashDeployments: () =>
          json({ data: null, errors: [{ message: "Problem with project prj-shop", extensions: { code: "BAD_USER_INPUT" } }] }),
      }),
    );
    const failure = railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, ctx);
    await expect(failure).rejects.toBeInstanceOf(InvalidResponseError);
    await expect(failure).rejects.toThrow("Railway answered the deployments query with GraphQL errors (BAD_USER_INPUT)");
  });

  it("skips the deployments request for a workspace with no projects and still reads billing", async () => {
    const empty = { data: { workspace: { projects: { edges: [], pageInfo: { hasNextPage: false } } } } };
    const { ctx, graphqlCalls } = harness(syncRoutes({ StackDashProjects: () => json(empty) }));
    const result = await railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, ctx);
    expect(graphqlCalls("StackDashDeployments")).toHaveLength(0);
    expect(result.events).toEqual([]);
    expect(result.cursor).toBeUndefined();
    expect(result.metrics.length).toBeGreaterThan(0);
  });

  it("asks for at most 10 projects' deployments per request and warns when the project list is capped", async () => {
    const projects = Array.from({ length: 11 }, (_, index) => ({ node: { id: `prj-${index}`, name: `project ${index}` } }));
    const page = { data: { workspace: { projects: { edges: projects, pageInfo: { hasNextPage: true } } } } };
    const { ctx, warnings, graphqlCalls } = harness(
      syncRoutes({
        StackDashProjects: () => json(page),
        StackDashDeployments: (call) =>
          json({
            data: Object.fromEntries(
              Object.keys(graphqlBody(call).variables).map((key) => [
                key.replace("p", "d"),
                { edges: [], pageInfo: { hasNextPage: false, endCursor: null } },
              ]),
            ),
          }),
      }),
    );
    await railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, ctx);
    const requests = graphqlCalls("StackDashDeployments").map((call) => Object.keys(graphqlBody(call).variables).length);
    expect(requests).toEqual([10, 1]);
    expect(warnings).toContain("railway.projects.cap_reached");
  });

  it("pages through a project's history until a page reaches deployments older than the window", async () => {
    const { ctx, graphqlCalls } = harness(
      syncRoutes({
        StackDashProjects: () => json(oneProject),
        StackDashDeployments: (call) =>
          graphqlBody(call).variables["a0"] === undefined
            ? json(deploymentsPage([node("dep-new", "SUCCESS", "2026-11-05T11:00:00.000Z", "2026-11-05T11:04:00.000Z")], "after-1"))
            : json(
                deploymentsPage([
                  node("dep-replaced", "REMOVED", "2026-11-05T10:40:00.000Z", "2026-11-05T11:04:00.000Z", true),
                  node("dep-older", "REMOVED", "2026-11-05T09:00:00.000Z", "2026-11-05T10:00:00.000Z", true),
                ], "after-2"),
              ),
      }),
    );
    const result = await railwayAdapter.sync(
      { credential, externalAccountId: WORKSPACE, cursor: "2026-11-05T11:30:00.000Z" },
      ctx,
    );
    expect(graphqlCalls("StackDashDeployments").map((call) => graphqlBody(call).variables)).toEqual([
      { p0: "prj-shop" },
      { p0: "prj-shop", a0: "after-1" },
    ]);
    // The second page reached 09:00, before the 10:30 window start, so no third page is asked for;
    // the deployment removed at 10:00 is outside the window and adds nothing.
    expect(result.events.map((event) => event.dedupeKey).sort()).toEqual([
      "railway.deployment:dep-new:building",
      "railway.deployment:dep-new:deployed",
      "railway.deployment:dep-replaced:building",
      "railway.deployment:dep-replaced:removed",
    ]);
  });

  it("reads at most five pages per project and warns when it stops there", async () => {
    let served = 0;
    const { ctx, warnings, graphqlCalls } = harness(
      syncRoutes({
        StackDashProjects: () => json(oneProject),
        StackDashDeployments: () => {
          served += 1;
          return json(
            deploymentsPage([node(`dep-${served}`, "SUCCESS", "2026-11-05T11:00:00.000Z", "2026-11-05T11:05:00.000Z")], `after-${served}`),
          );
        },
      }),
    );
    const result = await railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, ctx);
    expect(graphqlCalls("StackDashDeployments")).toHaveLength(5);
    expect(warnings).toContain("railway.deployments.page_cap_reached");
    expect(result.events).toHaveLength(10);
  });

  it("fails as an invalid response when a page reports more deployments without a cursor", async () => {
    const { ctx } = harness(
      syncRoutes({
        StackDashProjects: () => json(oneProject),
        StackDashDeployments: () =>
          json(deploymentsPage([node("dep-new", "SUCCESS", "2026-11-05T11:00:00.000Z", "2026-11-05T11:04:00.000Z")], null)),
      }),
    );
    await expect(railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, ctx)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it("keeps the build start of a deployment that waited longer than the overlap before it finished", async () => {
    const route = (statusAt: string) => () =>
      json(deploymentsPage([node("dep-waited", "SUCCESS", "2026-11-05T08:00:00.000Z", statusAt)], undefined));
    const sync = async (statusAt: string) => {
      const { ctx } = harness(syncRoutes({ StackDashProjects: () => json(oneProject), StackDashDeployments: route(statusAt) }));
      const result = await railwayAdapter.sync({ credential, externalAccountId: WORKSPACE, cursor: "2026-11-05T11:30:00.000Z" }, ctx);
      return result.events.map((event) => event.dedupeKey).sort();
    };
    // Window from 10:30: finished at 10:30 exactly, both events; a second before, neither.
    expect(await sync("2026-11-05T10:30:00.000Z")).toEqual([
      "railway.deployment:dep-waited:building",
      "railway.deployment:dep-waited:deployed",
    ]);
    expect(await sync("2026-11-05T10:29:59.000Z")).toEqual([]);
  });

  it("fails as an invalid response when Railway leaves out a project's deployments", async () => {
    const { ctx } = harness(syncRoutes({ StackDashDeployments: () => json({ data: { d0: deploymentsFixture.data.d0 } }) }));
    await expect(railwayAdapter.sync({ credential, externalAccountId: WORKSPACE }, ctx)).rejects.toBeInstanceOf(InvalidResponseError);
  });
});

describe("deploymentEvents", () => {
  // dep-web-success: a SUCCESS deployment that cannot be rolled back to.
  const base: Deployment = DeploymentSchema.parse(deploymentsFixture.data.d0.edges[1]?.node);

  it.each<[Deployment["status"], string[]]>([
    ["QUEUED", []],
    ["WAITING", []],
    ["NEEDS_APPROVAL", []],
    ["INITIALIZING", []],
    ["SKIPPED", []],
    ["BUILDING", ["building"]],
    ["DEPLOYING", ["building"]],
    ["SUCCESS", ["building", "deployed"]],
    ["SLEEPING", ["building", "deployed"]],
    ["FAILED", ["building", "failed"]],
    ["CRASHED", ["building", "crashed"]],
    ["REMOVING", ["removed"]],
    ["REMOVED", ["removed"]],
  ])("%s gives %j", (status, kinds) => {
    const events = deploymentEvents({ ...base, status }, "shop", WORKSPACE);
    expect(events.map((event) => event.typeId.replace("railway.deployment.", ""))).toEqual(kinds);
  });

  it.each<Deployment["status"]>(["REMOVING", "REMOVED"])(
    "%s that can still be rolled back to also built and says it succeeded",
    (status) => {
      const [building, removed] = deploymentEvents({ ...base, status, canRollback: true }, "shop", WORKSPACE);
      expect(building).toMatchObject({ typeId: "railway.deployment.building", occurredAt: base.createdAt });
      expect(removed).toMatchObject({
        typeId: "railway.deployment.removed",
        occurredAt: base.statusUpdatedAt,
        title: "Deployment of web to production succeeded, then was removed",
      });
    },
  );

  it("titles a removed deployment that cannot be rolled back to as removed only", () => {
    const [removed] = deploymentEvents({ ...base, status: "REMOVED", canRollback: false }, "shop", WORKSPACE);
    expect(removed?.title).toBe("Deployment of web in production was removed");
  });

  it("ignores canRollback on statuses other than removal", () => {
    const events = deploymentEvents({ ...base, status: "FAILED", canRollback: true }, "shop", WORKSPACE);
    expect(events.map((event) => event.title)).toEqual([
      "Deployment of web to production started building",
      "Deployment of web to production failed",
    ]);
  });

  it("dates the final event by updatedAt when statusUpdatedAt is null", () => {
    const [, final] = deploymentEvents({ ...base, statusUpdatedAt: null }, "shop", WORKSPACE);
    expect(final?.occurredAt).toEqual(base.updatedAt);
  });

  it("shortens long names and names a blank service, keeping titles within the event limit", () => {
    const events = deploymentEvents(
      { ...base, service: { name: "s".repeat(500) }, environment: { name: " " } },
      "p".repeat(500),
      WORKSPACE,
    );
    expectValid([], events);
    expect(events[1]?.title).toBe(`Deployment of ${"s".repeat(60)}… to unnamed succeeded`);
    expect(events[1]?.body).toBe(`Project: ${"p".repeat(60)}…`);
  });
});

describe("billingMetrics", () => {
  it("converts dollars to cents once, sums the estimate exactly, and adds usage beyond the Hobby allowance", () => {
    const metrics = billingMetrics(billing(), WORKSPACE, NOW);
    expectValid(metrics, []);
    // 3.456 dollars rounds half to even once: 346 cents.
    expect(amount(metric(metrics, "railway.spend.usage"))).toBe(346);
    // 6,000 vCPU-min x 0.000463 + 12,000 GB-min x 0.000231 + 2 GB x 0.05 + 43,200 GB-min x 0.000003472222222
    // is $5.7999999999904, 580 cents: the $5 fee plus 80 cents beyond the $5 it includes.
    expect(amount(metric(metrics, "railway.estimate.bill"))).toBe(580);
    expect(amount(metric(metrics, "railway.credits.balance"))).toBe(125);
    expect(metric(metrics, "railway.estimate.bill").provenance).toEqual({
      source: "derived",
      endpoint: GRAPHQL_URL,
      pricingSource: PRICING_SOURCE,
    });
    // One estimate only: the dashboard adds up every estimated spend of a currency.
    expect(metrics.filter((item) => item.kind === "estimated_spend")).toHaveLength(1);
    // The bill for the whole period, so the dashboard headline (#173) never counts it as spend so far.
    expect(railwayAdapter.projectedSpend).toEqual(["railway.estimate.bill"]);
    expect(metric(metrics, "railway.usage.cpu")).toMatchObject({ kind: "usage", value: 4200.5, unit: "vCPU-minutes" });
    const periodEnd = new Date("2026-11-20T00:00:00.000Z");
    expect(metric(metrics, "railway.spend.usage")).toMatchObject({
      timeframe: { type: "period", start: new Date("2026-10-20T00:00:00.000Z"), end: periodEnd },
      resetsAt: periodEnd,
    });
    expect(metric(metrics, "railway.plan.memory_per_service")).toMatchObject({ kind: "included_allowance", value: 48, unit: "GB" });
  });

  it("rounds the estimate once: three sub-cent projects tip the bill over by a cent", () => {
    // $5.00 of egress plus three projects at 10 vCPU-minutes ($0.00463 each, 0 cents alone): the
    // exact sum $5.01389 is 501 cents, one over the Hobby allowance. Rounding each row would give 500.
    const estimatedUsage = [
      { measurement: "NETWORK_TX_GB" as const, estimatedValue: 100, projectId: "a" },
      ...["a", "b", "c"].map((projectId) => ({ measurement: "CPU_USAGE" as const, estimatedValue: 10, projectId })),
    ];
    expect(amount(metric(billingMetrics(billing({ estimatedUsage }), WORKSPACE, NOW), "railway.estimate.bill"))).toBe(501);
  });

  it.each([
    ["Hobby, no usage", "HOBBY", 0, 500],
    ["Hobby, usage under the allowance", "HOBBY", 300, 500],
    ["Hobby, usage exactly at the allowance", "HOBBY", 500, 500],
    ["Hobby, one cent over", "HOBBY", 501, 501],
    ["Pro, usage under the allowance", "PRO", 1999, 2000],
    ["Pro, usage over the allowance", "PRO", 2500, 2500],
    ["Free, usage over its credit", "FREE", 300, 0],
  ] as const)("bills %s", (_title, plan, usageMinor, billMinor) => {
    // An egress estimate whose cost is exactly usageMinor cents: 1 GB egress is 5 cents.
    const estimatedUsage = [{ measurement: "NETWORK_TX_GB" as const, estimatedValue: usageMinor / 5, projectId: "p" }];
    const metrics = billingMetrics(billing({ plan, estimatedUsage }), WORKSPACE, NOW);
    expect(amount(metric(metrics, "railway.estimate.bill"))).toBe(billMinor);
  });

  it("reads the Free plan's limits per service", () => {
    const metrics = billingMetrics(billing({ plan: "FREE" }), WORKSPACE, NOW);
    expect(metric(metrics, "railway.plan.memory_per_service")).toMatchObject({ value: 0.5 });
  });

  it("keeps a negative credit balance, and leaves out usage rows Railway did not return", () => {
    const parsed = billing();
    const metrics = billingMetrics(
      { ...parsed, usage: [], workspace: { ...parsed.workspace, customer: { ...parsed.workspace.customer, creditBalance: -2.5 } } },
      WORKSPACE,
      NOW,
    );
    expectValid(metrics, []);
    expect(amount(metric(metrics, "railway.credits.balance"))).toBe(-250);
    expect(metrics.some((item) => item.kind === "usage")).toBe(false);
  });

  it.each([
    ["a billing period that ends when it starts", { billingPeriod: { start: NOW, end: NOW } }],
    ["an amount beyond the storable range", { currentUsage: 1e20 }],
  ])("rejects %s as invalid_response", (_title, customer) => {
    const parsed = billing();
    expect(() =>
      billingMetrics({ ...parsed, workspace: { ...parsed.workspace, customer: { ...parsed.workspace.customer, ...customer } } }, WORKSPACE, NOW),
    ).toThrow(InvalidResponseError);
  });
});
