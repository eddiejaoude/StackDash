import { describe, expect, it } from "vitest";
import type { Logger } from "@/lib/log/logger";
import {
  AuthRevokedError,
  InvalidResponseError,
  PermissionMissingError,
  ProviderUnavailableError,
  RateLimitedError,
} from "../errors";
import { validateAdapterEvents } from "../events";
import { validateAdapterMetrics } from "../metrics";
import { Secret, type FetchLike, type OAuthContext, type OAuthCredential, type SyncResult } from "../types";
import { supabaseAdapter } from "./index";

// Every fixture below is from documentation, not recorded: shapes follow the sample responses
// and OpenAPI schemas on docs/providers/supabase.md ("Sample responses"), trimmed, with synthetic
// ids and values.
import entitlementsFree from "./fixtures/entitlements-free.json"; // from documentation, not recorded
import entitlementsPro from "./fixtures/entitlements-pro.json"; // from documentation, not recorded (Pro values from the page's retention table)
import healthHealthy from "./fixtures/health-healthy.json"; // from documentation, not recorded
import healthUnhealthy from "./fixtures/health-unhealthy.json"; // from documentation, not recorded (status values from the documented enum)
import logsActiveUsers from "./fixtures/logs-active-users.json"; // from documentation, not recorded (shape of the page's uniqExact query)
import logsCounts from "./fixtures/logs-counts.json"; // from documentation, not recorded (page sample plus logout and user_deleted rows)
import logsRawAuditEvent from "./fixtures/logs-raw-audit-event.json"; // from documentation, not recorded (documented audit event format, synthetic personal values)
import logsSignups from "./fixtures/logs-signups.json"; // from documentation, not recorded (shape of the page's signup query)
import organizationFree from "./fixtures/organization-free.json"; // from documentation, not recorded
import organizationProjects from "./fixtures/organization-projects.json"; // from documentation, not recorded
import organizations from "./fixtures/organizations.json"; // from documentation, not recorded
import project from "./fixtures/project.json"; // from documentation, not recorded (fields of GET /v1/projects on the page)
import token from "./fixtures/token.json"; // from documentation, not recorded

const REF = "abcdefghijklmnopqrst";
const LOGS_PATH = `/v1/projects/${REF}/analytics/endpoints/logs`;
const NOW_FREE = new Date("2026-10-31T12:07:30Z");
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

type LogsWindow = Readonly<{ start: string; end: string }>;

type Handlers = {
  token: (form: URLSearchParams) => Response;
  revoke: () => Response;
  organizations: () => Response;
  projects: (offset: number) => Response;
  project: () => Response;
  organization: () => Response;
  entitlements: () => Response;
  health: () => Response;
  counts: (window: LogsWindow) => Response;
  signups: (window: LogsWindow) => Response;
  activeUsers: (window: LogsWindow) => Response;
};

type Recorded = Readonly<{ url: URL; init: RequestInit | undefined }>;

const defaults: Handlers = {
  token: () => Response.json(token),
  revoke: () => new Response(null, { status: 204 }),
  organizations: () => Response.json(organizations),
  projects: () => Response.json(organizationProjects),
  project: () => Response.json(project),
  organization: () => Response.json(organizationFree),
  entitlements: () => Response.json(entitlementsFree),
  health: () => Response.json(healthHealthy),
  counts: () => Response.json(logsCounts),
  signups: () => Response.json(logsSignups),
  activeUsers: () => Response.json(logsActiveUsers),
};

function fakeApi(overrides: Partial<Handlers> = {}) {
  const handlers: Handlers = { ...defaults, ...overrides };
  const requests: Recorded[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    expect(url.origin).toBe("https://api.supabase.com");
    const path = url.pathname;
    if (path === "/v1/oauth/token") return handlers.token(new URLSearchParams(String(init?.body)));
    if (path === "/v1/oauth/revoke") return handlers.revoke();
    if (path === "/v1/organizations") return handlers.organizations();
    if (path === "/v1/organizations/examplecorp/projects") {
      return handlers.projects(Number(url.searchParams.get("offset")));
    }
    if (path === "/v1/organizations/examplecorp") return handlers.organization();
    if (path === "/v1/organizations/examplecorp/entitlements") return handlers.entitlements();
    if (path === `/v1/projects/${REF}`) return handlers.project();
    if (path === `/v1/projects/${REF}/health`) return handlers.health();
    if (path === LOGS_PATH) {
      const sql = url.searchParams.get("sql") ?? "";
      const window = {
        start: url.searchParams.get("iso_timestamp_start") ?? "",
        end: url.searchParams.get("iso_timestamp_end") ?? "",
      };
      if (sql.includes("uniqExact")) return handlers.activeUsers(window);
      if (sql.includes("group by action")) return handlers.counts(window);
      return handlers.signups(window);
    }
    throw new Error(`unexpected request to ${path}`);
  };

  const logsRequests = (kind: "counts" | "signups" | "activeUsers"): LogsWindow[] =>
    requests
      .filter(({ url }) => url.pathname === LOGS_PATH)
      .filter(({ url }) => {
        const sql = url.searchParams.get("sql") ?? "";
        if (kind === "activeUsers") return sql.includes("uniqExact");
        if (kind === "counts") return sql.includes("group by action");
        return !sql.includes("uniqExact") && !sql.includes("group by action");
      })
      .map(({ url }) => ({
        start: url.searchParams.get("iso_timestamp_start") ?? "",
        end: url.searchParams.get("iso_timestamp_end") ?? "",
      }));

  return { fetch, requests, logsRequests };
}

function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      info: () => undefined,
      warn: (event) => {
        warnings.push(event);
      },
      error: () => undefined,
    },
  };
}

const client = {
  clientId: "00000000-0000-4000-8000-000000000001",
  clientSecret: new Secret("synthetic-client-secret"),
  extra: {},
};

function contextFor(fetch: FetchLike, now: Date, logger: Logger = recordingLogger().logger): OAuthContext {
  return { fetch, now: () => now, timeoutMs: 1000, logger, client };
}

const credential: OAuthCredential = {
  accessToken: new Secret("synthetic-access-token"),
  refreshToken: new Secret("synthetic-refresh-token"),
  expiresAt: new Date("2026-10-31T13:00:00Z"),
  scopes: ["organizations:read", "projects:read", "analytics:read"],
  tokenType: "Bearer",
};

const organizationPro = { ...organizationFree, plan: "pro" };
const organizationTeam = { ...organizationFree, plan: "team" };
const entitlementsTeam = {
  entitlements: entitlementsPro.entitlements.map((entitlement) =>
    entitlement.feature.key === "security.audit_logs_days"
      ? { ...entitlement, config: { ...entitlement.config, value: 28 } }
      : entitlement,
  ),
};
const emptyLogs = () => Response.json({ result: [] });

function expectValid(result: SyncResult): void {
  const metrics = validateAdapterMetrics("supabase", result.metrics);
  if (!metrics.ok) throw new Error(`invalid metrics: ${JSON.stringify(metrics.issues)}`);
  const events = validateAdapterEvents(supabaseAdapter.eventTypes, result.events);
  if (!events.ok) throw new Error(`invalid events: ${JSON.stringify(events.issues)}`);
}

function parsedCursor(result: SyncResult): unknown {
  return result.cursor === undefined ? undefined : JSON.parse(result.cursor);
}

describe("supabaseAdapter declaration", () => {
  it("requests only the three read scopes, never database:read, and polls every 15 minutes", () => {
    expect(supabaseAdapter.oauth.scopes).toEqual(["organizations:read", "projects:read", "analytics:read"]);
    expect(supabaseAdapter.oauth.scopes).not.toContain("database:read");
    expect(supabaseAdapter.oauth.pkce).toBe(true);
    expect(supabaseAdapter.oauth.clientIdEnv).toBe("SUPABASE_OAUTH_CLIENT_ID");
    expect(supabaseAdapter.oauth.clientSecretEnv).toBe("SUPABASE_OAUTH_CLIENT_SECRET");
    expect(supabaseAdapter.pollIntervalSeconds).toBe(900);
    expect(supabaseAdapter.permissions.every((permission) => permission.access === "read")).toBe(true);
    expect(supabaseAdapter.capabilities.spending).toBe(false);
  });
});

describe("buildAuthorizeUrl", () => {
  it("sends state, redirect, and an S256 PKCE challenge, and no deprecated scope parameter", () => {
    const url = supabaseAdapter.buildAuthorizeUrl({
      client,
      state: "synthetic-state",
      redirectUri: "https://stackdash.example.com/api/connections/supabase/callback",
      codeChallenge: "synthetic-challenge",
    });
    expect(`${url.origin}${url.pathname}`).toBe("https://api.supabase.com/v1/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: client.clientId,
      redirect_uri: "https://stackdash.example.com/api/connections/supabase/callback",
      response_type: "code",
      state: "synthetic-state",
      code_challenge: "synthetic-challenge",
      code_challenge_method: "S256",
    });
  });

  it("refuses to build a URL without a PKCE challenge", () => {
    expect(() =>
      supabaseAdapter.buildAuthorizeUrl({ client, state: "s", redirectUri: "https://stackdash.example.com/cb" }),
    ).toThrow(TypeError);
  });
});

describe("exchangeCode", () => {
  it("posts the code and verifier with Basic client auth and returns a credential expiring from expires_in", async () => {
    const api = fakeApi();
    const result = await supabaseAdapter.exchangeCode(
      {
        code: "synthetic-code",
        redirectUri: "https://stackdash.example.com/api/connections/supabase/callback",
        codeVerifier: "synthetic-verifier",
        // Supabase sends only code and state; nothing provider-specific is read from the callback.
        callbackParams: { code: "synthetic-code", state: "synthetic-state" },
      },
      contextFor(api.fetch, NOW_FREE),
    );

    const [request] = api.requests;
    expect(request?.init?.method).toBe("POST");
    const headers = new Headers(request?.init?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa(`${client.clientId}:synthetic-client-secret`)}`);
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(request?.init?.body)))).toEqual({
      grant_type: "authorization_code",
      code: "synthetic-code",
      redirect_uri: "https://stackdash.example.com/api/connections/supabase/callback",
      code_verifier: "synthetic-verifier",
    });

    expect(result.accessToken.reveal()).toBe(token.access_token);
    expect(result.refreshToken?.reveal()).toBe(token.refresh_token);
    expect(result.expiresAt).toEqual(new Date(NOW_FREE.getTime() + 3600 * 1000));
    expect(result.scopes).toEqual(["organizations:read", "projects:read", "analytics:read"]);
    expect(result.tokenType).toBe("Bearer");
    expect(result.metadata).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(token.access_token);
  });

  it("refuses to exchange without a PKCE verifier", async () => {
    const api = fakeApi();
    await expect(
      supabaseAdapter.exchangeCode(
        { code: "c", redirectUri: "https://stackdash.example.com/cb", callbackParams: {} },
        contextFor(api.fetch, NOW_FREE),
      ),
    ).rejects.toThrow(TypeError);
    expect(api.requests).toHaveLength(0);
  });
});

describe("refreshTokens", () => {
  it("stores a rotated refresh token when Supabase returns one", async () => {
    const api = fakeApi({ token: () => Response.json({ ...token, refresh_token: "synthetic-rotated-refresh" }) });
    const refreshed = await supabaseAdapter.refreshTokens?.(credential, contextFor(api.fetch, NOW_FREE));
    expect(refreshed?.refreshToken?.reveal()).toBe("synthetic-rotated-refresh");
    expect(Object.fromEntries(new URLSearchParams(String(api.requests[0]?.init?.body)))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "synthetic-refresh-token",
    });
  });

  it("keeps the old refresh token when the response has none", async () => {
    const withoutRefresh = { access_token: token.access_token, expires_in: token.expires_in, token_type: token.token_type };
    const api = fakeApi({ token: () => Response.json(withoutRefresh) });
    const refreshed = await supabaseAdapter.refreshTokens?.(credential, contextFor(api.fetch, NOW_FREE));
    expect(refreshed?.refreshToken?.reveal()).toBe("synthetic-refresh-token");
    expect(refreshed?.accessToken.reveal()).toBe(token.access_token);
  });

  it("401 on refresh -> auth revoked error", async () => {
    const api = fakeApi({ token: () => new Response(null, { status: 401 }) });
    await expect(supabaseAdapter.refreshTokens?.(credential, contextFor(api.fetch, NOW_FREE))).rejects.toBeInstanceOf(
      AuthRevokedError,
    );
  });
});

describe("revoke", () => {
  it("posts the client credentials and refresh token as JSON and accepts 204", async () => {
    const api = fakeApi();
    await expect(supabaseAdapter.revoke?.(credential, contextFor(api.fetch, NOW_FREE))).resolves.toBeUndefined();
    expect(api.requests[0]?.url.pathname).toBe("/v1/oauth/revoke");
    expect(JSON.parse(String(api.requests[0]?.init?.body))).toEqual({
      client_id: client.clientId,
      client_secret: "synthetic-client-secret",
      refresh_token: "synthetic-refresh-token",
    });
  });

  it("does nothing without a refresh token and reports a 5xx", async () => {
    const api = fakeApi({ revoke: () => new Response(null, { status: 503 }) });
    const accessOnly: OAuthCredential = {
      accessToken: credential.accessToken,
      scopes: credential.scopes,
      tokenType: credential.tokenType,
    };
    await supabaseAdapter.revoke?.(accessOnly, contextFor(api.fetch, NOW_FREE));
    expect(api.requests).toHaveLength(0);
    await expect(supabaseAdapter.revoke?.(credential, contextFor(api.fetch, NOW_FREE))).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});

describe("listAccounts", () => {
  it("lists every non-branch project as a project account named after the project", async () => {
    const branch = { ...organizationProjects.projects[0], ref: "branchbranchbranchbr", name: "example-app-preview", is_branch: true };
    const api = fakeApi({
      projects: () =>
        Response.json({ ...organizationProjects, projects: [...organizationProjects.projects, branch], pagination: { count: 2, limit: 100, offset: 0 } }),
    });
    const accounts = await supabaseAdapter.listAccounts(credential, contextFor(api.fetch, NOW_FREE));
    expect(accounts).toEqual([{ externalId: REF, displayName: "example-app", kind: "project" }]);
    expect(api.requests[1]?.url.searchParams.get("limit")).toBe("100");
    expect(new Headers(api.requests[0]?.init?.headers).get("authorization")).toBe("Bearer synthetic-access-token");
  });

  it("empty lists: no organizations, or an organization without projects, give no accounts", async () => {
    const noOrganizations = fakeApi({ organizations: () => Response.json([]) });
    await expect(supabaseAdapter.listAccounts(credential, contextFor(noOrganizations.fetch, NOW_FREE))).resolves.toEqual([]);

    const noProjects = fakeApi({
      projects: () => Response.json({ projects: [], pagination: { count: 0, limit: 100, offset: 0 } }),
    });
    await expect(supabaseAdapter.listAccounts(credential, contextFor(noProjects.fetch, NOW_FREE))).resolves.toEqual([]);
  });

  it("pagination cap: stops after 10 pages of 100 projects and logs the truncation", async () => {
    const api = fakeApi({
      projects: (offset) =>
        Response.json({
          projects: Array.from({ length: 100 }, (_, index) => ({
            ref: `ref${String(offset + index).padStart(17, "0")}`,
            name: `project-${offset + index}`,
            status: "ACTIVE_HEALTHY",
            is_branch: false,
          })),
          pagination: { count: 5000, limit: 100, offset },
        }),
    });
    const { logger, warnings } = recordingLogger();
    const accounts = await supabaseAdapter.listAccounts(credential, contextFor(api.fetch, NOW_FREE, logger));
    expect(accounts).toHaveLength(1000);
    expect(api.requests.filter(({ url }) => url.pathname.endsWith("/projects"))).toHaveLength(10);
    expect(warnings).toContain("supabase.projects_truncated");
  });

  it("response schema mismatch -> invalid_response", async () => {
    const api = fakeApi({ projects: () => Response.json({ projects: [{ name: "no-ref" }], pagination: { count: 1, limit: 100, offset: 0 } }) });
    await expect(supabaseAdapter.listAccounts(credential, contextFor(api.fetch, NOW_FREE))).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("detectMissingPermissions", () => {
  it("returns requested scopes absent from the grant", () => {
    expect(supabaseAdapter.detectMissingPermissions({ scopes: credential.scopes })).toEqual([]);
    expect(supabaseAdapter.detectMissingPermissions({ scopes: ["projects:read"] })).toEqual([
      "organizations:read",
      "analytics:read",
    ]);
  });
});

describe("sync", () => {
  it("first sync on Free: one window inside the 1 hour retention, a signup event per row, plan limits, no daily active users", async () => {
    const api = fakeApi();
    const result = await supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(api.fetch, NOW_FREE));
    expectValid(result);

    // Retention 1 hour minus a 10 minute margin, ending 5 minutes in the past, on whole minutes.
    expect(api.logsRequests("counts")).toEqual([{ start: "2026-10-31T11:18:00Z", end: "2026-10-31T12:02:00Z" }]);
    expect(api.logsRequests("activeUsers")).toEqual([]);

    // The row exactly on the window end belongs to the next window.
    expect(result.events.map((event) => event.dedupeKey)).toEqual([
      `supabase.auth.signup:${REF}:2026-10-31T11:20:05.123456Z:0`,
      `supabase.auth.signup:${REF}:2026-10-31T11:45:00.000001Z:0`,
      `supabase.auth.signup:${REF}:2026-10-31T11:45:00.000001Z:1`,
    ]);
    expect(result.events[0]).toMatchObject({
      typeId: "supabase.auth.signup",
      occurredAt: new Date("2026-10-31T11:20:05.123Z"),
      title: "New signup",
      url: `https://supabase.com/dashboard/project/${REF}`,
    });

    expect(result.metrics.map((metric) => [metric.metricKey, metric.kind, "value" in metric ? metric.value : undefined])).toEqual([
      ["supabase.plan.log_retention", "included_allowance", 1],
      ["supabase.plan.database_size", "included_allowance", 500],
      ["supabase.plan.monthly_active_users", "included_allowance", 50_000],
    ]);
    expect(result.metrics.some((metric) => metric.metricKey === "supabase.auth.daily_active_users")).toBe(false);
    expect(result.metrics[0]).toMatchObject({
      externalAccountId: REF,
      retrievedAt: NOW_FREE,
      provenance: { source: "provider_api", endpoint: "GET /v1/organizations/{slug}/entitlements" },
    });
    expect(result.metrics[1]?.provenance).toEqual({ source: "derived", pricingSource: "https://supabase.com/pricing (checked 2026-10-31)" });

    expect(parsedCursor(result)).toEqual({
      v: 1,
      windowEnd: "2026-10-31T12:02:00Z",
      day: { date: "2026-10-31", complete: false, logins: 42, logouts: 7, signups: 3, deletedUsers: 1 },
      health: "healthy",
    });
    expect(result.partialErrors).toBeUndefined();
  });

  it("day rollover on Pro: one daily summary with an exact daily active user count over exactly 24 hours", async () => {
    const now = new Date("2026-11-01T00:20:00Z");
    const api = fakeApi({
      organization: () => Response.json(organizationPro),
      entitlements: () => Response.json(entitlementsPro),
      health: () => Response.json(healthUnhealthy),
      signups: emptyLogs,
    });
    const cursor = JSON.stringify({
      v: 1,
      windowEnd: "2026-10-31T23:45:00Z",
      day: { date: "2026-10-31", complete: true, logins: 100, logouts: 10, signups: 5, deletedUsers: 2 },
      health: "healthy",
    });
    const result = await supabaseAdapter.sync({ credential, externalAccountId: REF, cursor }, contextFor(api.fetch, now));
    expectValid(result);

    expect(api.logsRequests("counts")).toEqual([
      { start: "2026-10-31T23:45:00Z", end: "2026-11-01T00:00:00Z" },
      { start: "2026-11-01T00:00:00Z", end: "2026-11-01T00:15:00Z" },
    ]);
    expect(api.logsRequests("activeUsers")).toEqual([{ start: "2026-10-31T00:00:00Z", end: "2026-11-01T00:00:00Z" }]);

    expect(result.events).toEqual([
      {
        typeId: "supabase.project.unhealthy",
        occurredAt: now,
        severity: "critical",
        title: "example-app is unhealthy",
        body: "Unhealthy services: auth.",
        externalAccountId: REF,
        dedupeKey: `supabase.project.unhealthy:${REF}:2026-11-01`,
        url: `https://supabase.com/dashboard/project/${REF}`,
      },
      {
        typeId: "supabase.auth.daily_summary",
        occurredAt: new Date("2026-10-31T00:00:00Z"),
        severity: "info",
        title: "142 logins, 57 active users",
        body: "8 new signups, 17 logouts, 3 deleted users.",
        externalAccountId: REF,
        dedupeKey: `supabase.auth.daily_summary:${REF}:2026-10-31`,
        url: `https://supabase.com/dashboard/project/${REF}`,
      },
    ]);

    const activeUsers = result.metrics.find((metric) => metric.metricKey === "supabase.auth.daily_active_users");
    expect(activeUsers).toEqual({
      kind: "usage",
      metricKey: "supabase.auth.daily_active_users",
      label: "Daily active users",
      value: 57,
      unit: "users",
      timeframe: { type: "period", start: new Date("2026-10-31T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") },
      externalAccountId: REF,
      retrievedAt: now,
      provenance: { source: "provider_api", endpoint: "GET /v1/projects/{ref}/analytics/endpoints/logs" },
    });
    expect(result.metrics.map((metric) => metric.metricKey)).toEqual([
      "supabase.plan.audit_log_retention",
      "supabase.plan.log_retention",
      "supabase.plan.edge_functions",
      "supabase.plan.disk_size",
      "supabase.plan.monthly_active_users",
      "supabase.auth.daily_active_users",
    ]);

    expect(parsedCursor(result)).toEqual({
      v: 1,
      windowEnd: "2026-11-01T00:15:00Z",
      day: { date: "2026-11-01", complete: true, logins: 42, logouts: 7, signups: 3, deletedUsers: 1 },
      health: "unhealthy",
    });
  });

  it("24h window rule and pagination cap: windows split at UTC midnight, never over 24 hours, at most 8 per sync", async () => {
    const api = fakeApi({
      organization: () => Response.json(organizationTeam),
      entitlements: () => Response.json(entitlementsTeam),
      signups: emptyLogs,
    });
    const cursor = JSON.stringify({ v: 1, windowEnd: "2026-10-20T06:00:00Z" });
    const result = await supabaseAdapter.sync({ credential, externalAccountId: REF, cursor }, contextFor(api.fetch, NOW_FREE));
    expectValid(result);

    const counts = api.logsRequests("counts");
    expect(counts).toHaveLength(8);
    expect(counts[0]).toEqual({ start: "2026-10-20T06:00:00Z", end: "2026-10-21T00:00:00Z" });
    for (const window of [...counts, ...api.logsRequests("signups"), ...api.logsRequests("activeUsers")]) {
      const length = Date.parse(window.end) - Date.parse(window.start);
      expect(length).toBeGreaterThan(0);
      expect(length).toBeLessThanOrEqual(DAY_MS);
      expect(Date.parse(window.end)).toBeLessThanOrEqual(NOW_FREE.getTime() - 5 * MINUTE_MS);
    }
    for (const window of api.logsRequests("activeUsers")) {
      expect(Date.parse(window.end) - Date.parse(window.start)).toBe(DAY_MS);
    }

    const summaries = result.events.filter((event) => event.typeId === "supabase.auth.daily_summary");
    expect(summaries.map((event) => event.dedupeKey)).toEqual(
      ["20", "21", "22", "23", "24", "25", "26", "27"].map((day) => `supabase.auth.daily_summary:${REF}:2026-10-${day}`),
    );
    // The first day was only counted from 06:00.
    expect(summaries[0]?.body).toContain("Partial day");
    expect(summaries[1]?.body).not.toContain("Partial day");
    expect(result.metrics.filter((metric) => metric.metricKey === "supabase.auth.daily_active_users")).toHaveLength(8);
    expect(parsedCursor(result)).toEqual({ v: 1, windowEnd: "2026-10-28T00:00:00Z", health: "healthy" });
  });

  it("Free gap past retention: skips to the retained hour, finishes the earlier day as partial, daily active users unavailable", async () => {
    const now = new Date("2026-10-31T02:00:00Z");
    const api = fakeApi({ signups: emptyLogs });
    const { logger, warnings } = recordingLogger();
    const cursor = JSON.stringify({
      v: 1,
      windowEnd: "2026-10-30T23:00:00Z",
      day: { date: "2026-10-30", complete: true, logins: 9, logouts: 1, signups: 2, deletedUsers: 0 },
    });
    const result = await supabaseAdapter.sync({ credential, externalAccountId: REF, cursor }, contextFor(api.fetch, now, logger));
    expectValid(result);

    expect(warnings).toContain("supabase.auth_logs_gap");
    expect(api.logsRequests("counts")).toEqual([{ start: "2026-10-31T01:10:00Z", end: "2026-10-31T01:55:00Z" }]);
    expect(api.logsRequests("activeUsers")).toEqual([]);
    expect(result.events).toEqual([
      expect.objectContaining({
        typeId: "supabase.auth.daily_summary",
        title: "9 logins",
        body:
          "2 new signups, 1 logout, 0 deleted users. Daily active users unavailable: Supabase keeps auth logs for 1 hour on the Free plan. " +
          "Partial day: part of this day was outside Supabase's auth log retention when StackDash polled.",
        dedupeKey: `supabase.auth.daily_summary:${REF}:2026-10-30`,
      }),
    ]);
    expect(result.metrics.some((metric) => metric.metricKey === "supabase.auth.daily_active_users")).toBe(false);
    expect(parsedCursor(result)).toMatchObject({ day: { date: "2026-10-31", complete: false } });
  });

  it("is idempotent, and duplicate events across two syncs of the same window produce identical dedupe keys", async () => {
    const first = await supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(fakeApi().fetch, NOW_FREE));
    const again = await supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(fakeApi().fetch, NOW_FREE));
    expect(again).toEqual(first);
    expect(again.events.map((event) => event.dedupeKey)).toEqual(first.events.map((event) => event.dedupeKey));
    expect(new Set(first.events.map((event) => event.dedupeKey)).size).toBe(first.events.length);

    // The next poll at the same minute has no new window, so nothing is emitted twice.
    const api = fakeApi();
    const next = await supabaseAdapter.sync(
      { credential, externalAccountId: REF, ...(first.cursor === undefined ? {} : { cursor: first.cursor }) },
      contextFor(api.fetch, NOW_FREE),
    );
    expect(next.events).toEqual([]);
    expect(api.logsRequests("counts")).toEqual([]);
    expect(next.cursor).toBe(first.cursor);
  });

  it("emits project health events only on status change", async () => {
    const recovered = await supabaseAdapter.sync(
      { credential, externalAccountId: REF, cursor: JSON.stringify({ v: 1, windowEnd: "2026-10-31T12:02:00Z", health: "unhealthy" }) },
      contextFor(fakeApi().fetch, NOW_FREE),
    );
    expect(recovered.events).toEqual([
      expect.objectContaining({
        typeId: "supabase.project.healthy",
        severity: "success",
        title: "example-app is healthy again",
        dedupeKey: `supabase.project.healthy:${REF}:2026-10-31`,
      }),
    ]);

    const unchanged = await supabaseAdapter.sync(
      { credential, externalAccountId: REF, cursor: JSON.stringify({ v: 1, windowEnd: "2026-10-31T12:02:00Z", health: "healthy" }) },
      contextFor(fakeApi().fetch, NOW_FREE),
    );
    expect(unchanged.events).toEqual([]);
  });

  it("splits a window in half when the signup query returns its full limit of 1000 rows", async () => {
    const rows = (count: number, minute: string) =>
      Response.json({ result: Array.from({ length: count }, () => ({ timestamp: `2026-10-31 ${minute}:00.000000` })) });
    const api = fakeApi({
      signups: (window) => {
        if (window.start === "2026-10-31T11:18:00Z" && window.end === "2026-10-31T12:02:00Z") return rows(1000, "11:30");
        if (window.end === "2026-10-31T11:40:00Z") return rows(2, "11:30");
        return rows(1, "11:50");
      },
    });
    const result = await supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(api.fetch, NOW_FREE));
    expect(api.logsRequests("signups")).toEqual([
      { start: "2026-10-31T11:18:00Z", end: "2026-10-31T12:02:00Z" },
      { start: "2026-10-31T11:18:00Z", end: "2026-10-31T11:40:00Z" },
      { start: "2026-10-31T11:40:00Z", end: "2026-10-31T12:02:00Z" },
    ]);
    expect(result.events.map((event) => event.dedupeKey)).toEqual([
      `supabase.auth.signup:${REF}:2026-10-31T11:30:00.000000Z:0`,
      `supabase.auth.signup:${REF}:2026-10-31T11:30:00.000000Z:1`,
      `supabase.auth.signup:${REF}:2026-10-31T11:50:00.000000Z:0`,
    ]);
  });

  it("skips logs and health for a paused (INACTIVE) project and keeps the cursor", async () => {
    const api = fakeApi({ project: () => Response.json({ ...project, status: "INACTIVE" }) });
    const cursor = JSON.stringify({ v: 1, windowEnd: "2026-10-31T11:00:00Z", health: "healthy" });
    const result = await supabaseAdapter.sync({ credential, externalAccountId: REF, cursor }, contextFor(api.fetch, NOW_FREE));
    expectValid(result);
    expect(api.requests.some(({ url }) => url.pathname === LOGS_PATH || url.pathname.endsWith("/health"))).toBe(false);
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe(cursor);
  });

  it("entitlements 403 -> partial error naming organizations:read, the rest of the sync still returns", async () => {
    const api = fakeApi({
      organization: () => Response.json(organizationPro),
      entitlements: () => new Response(null, { status: 403 }),
    });
    const result = await supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(api.fetch, NOW_FREE));
    expectValid(result);
    expect(result.partialErrors).toHaveLength(1);
    expect(result.partialErrors?.[0]).toBeInstanceOf(PermissionMissingError);
    expect(result.partialErrors?.[0]?.missingScopes).toEqual(["organizations:read"]);
    expect(result.events.filter((event) => event.typeId === "supabase.auth.signup")).toHaveLength(3);
    // Retention unknown, so windows stay inside the shortest (1 hour) retention.
    expect(api.logsRequests("counts")).toEqual([{ start: "2026-10-31T11:18:00Z", end: "2026-10-31T12:02:00Z" }]);
  });

  it("no spend or money metrics: nothing is rounded because Supabase exposes no billing to OAuth apps", async () => {
    const result = await supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(fakeApi().fetch, NOW_FREE));
    for (const metric of result.metrics) {
      expect(["included_allowance", "usage"]).toContain(metric.kind);
      expect("amountMinor" in metric).toBe(false);
    }
  });

  it("empty lists: no log rows give zero counts and no signup events", async () => {
    const api = fakeApi({ counts: emptyLogs, signups: emptyLogs });
    const result = await supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(api.fetch, NOW_FREE));
    expectValid(result);
    expect(result.events).toEqual([]);
    expect(parsedCursor(result)).toMatchObject({
      day: { date: "2026-10-31", complete: false, logins: 0, logouts: 0, signups: 0, deletedUsers: 0 },
    });
  });

  it("401 -> auth revoked error", async () => {
    const api = fakeApi({ project: () => new Response(null, { status: 401 }) });
    await expect(
      supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(api.fetch, NOW_FREE)),
    ).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("429 with Retry-After -> rate limited error with the delay", async () => {
    const api = fakeApi({ counts: () => new Response(null, { status: 429, headers: { "Retry-After": "30" } }) });
    const error = await supabaseAdapter
      .sync({ credential, externalAccountId: REF }, contextFor(api.fetch, NOW_FREE))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitedError);
    expect(error).toMatchObject({ retryAfterMs: 30_000 });
  });

  it("429 with only X-RateLimit-Reset -> rate limited error with the reset delay", async () => {
    const api = fakeApi({ counts: () => new Response(null, { status: 429, headers: { "X-RateLimit-Reset": "12" } }) });
    await expect(
      supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(api.fetch, NOW_FREE)),
    ).rejects.toMatchObject({ code: "rate_limited", retryAfterMs: 12_000 });
  });

  it("402 Logs Query allowance exceeded -> invalid_response, not retried", async () => {
    const api = fakeApi({ counts: () => Response.json({ message: "Usage exceeded" }, { status: 402 }) });
    await expect(
      supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(api.fetch, NOW_FREE)),
    ).rejects.toMatchObject({ code: "invalid_response", status: 402 });
    expect(api.logsRequests("counts")).toHaveLength(1);
  });

  it("logs response with an error field -> invalid_response", async () => {
    const api = fakeApi({ counts: () => Response.json({ result: [], error: { message: "synthetic query error" } }) });
    await expect(
      supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(api.fetch, NOW_FREE)),
    ).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it("response schema mismatch -> invalid_response", async () => {
    const api = fakeApi({ counts: () => Response.json({ result: [{ action: "login", events: -1 }] }) });
    await expect(
      supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(api.fetch, NOW_FREE)),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("personal fields: a raw audit row is rejected, and no personal value or identifying column reaches output or SQL", async () => {
    const rejected = fakeApi({ signups: () => Response.json(logsRawAuditEvent) });
    await expect(
      supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(rejected.fetch, NOW_FREE)),
    ).rejects.toMatchObject({ code: "invalid_response" });

    const api = fakeApi();
    const result = await supabaseAdapter.sync({ credential, externalAccountId: REF }, contextFor(api.fetch, NOW_FREE));
    const output = JSON.stringify(result);
    const [raw] = logsRawAuditEvent.result;
    for (const personal of [raw?.user_id, raw?.ip_address, raw?.user_agent, raw?.actor_username]) {
      expect(personal).toBeDefined();
      expect(output).not.toContain(String(personal));
    }
    expect(output).not.toContain("@");
    expect(output).not.toContain("synthetic-access-token");

    for (const { url } of api.requests.filter((request) => request.url.pathname === LOGS_PATH)) {
      const sql = url.searchParams.get("sql") ?? "";
      expect(sql).not.toMatch(/select \*|count\(\*\)|actor_username|actor_name|ip_address|user_agent|event_message/);
      expect(sql).toContain("source = 'auth_audit_logs'");
      expect(sql).toMatch(/limit \d+/);
    }
  });
});
