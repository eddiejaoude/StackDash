import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AuthRevokedError,
  InvalidResponseError,
  PermissionMissingError,
  ProviderUnavailableError,
  RateLimitedError,
} from "../errors";
import { validateAdapterEvents } from "../events";
import { checkWebhookOutcome } from "../harness";
import { validateAdapterMetrics } from "../metrics";
import {
  Secret,
  type FetchLike,
  type OAuthContext,
  type OAuthCredential,
  type SyncResult,
  type WebhookDescriptor,
  type WebhookRequest,
} from "../types";
import {
  MAX_PROJECT_PAGES,
  MAX_TRACKED_ISSUES,
  nextPageCursor,
  SENTRY_WEBHOOK_HEADERS,
  SENTRY_WEBHOOK_TOLERANCE_SECONDS,
  sentryAdapter,
  sentryWebhookSignature,
} from "./index";

// Every fixture below is from documentation, not recorded: the response samples in the Sentry API
// reference and integration platform docs (checked 2026-11-05, URLs in docs/providers/sentry.md,
// Sources), trimmed, with synthetic ids, times, and placeholder tokens. The issue and release
// samples keep the documented assignee, author, and title fields so the tests prove they are
// dropped. Replace them with sanitized recordings once a test organization exists (#141).
// - token.json / token-refreshed.json: POST /api/0/sentry-app-installations/{uuid}/authorizations/
//   (public integration docs, "Refreshing Tokens Manually").
import tokenRefreshed from "./fixtures/token-refreshed.json";
import token from "./fixtures/token.json";
// - projects.json: GET /api/0/organizations/{org}/projects/ (List an Organization's Projects).
import projects from "./fixtures/projects.json";
// - stats.json: GET /api/0/organizations/{org}/stats_v2/ grouped by outcome (Retrieve Event Counts
//   for an Organization (v2)); no rate_limited group, so the missing outcome reads as zero.
import stats from "./fixtures/stats.json";
// - issues-*.json: GET /api/0/organizations/{org}/issues/ (List an Organization's Issues), one file
//   per search the adapter runs: new issues, unresolved issues seen recently, and resolved ones.
import issuesActive from "./fixtures/issues-active.json";
import issuesCreated from "./fixtures/issues-created.json";
import issuesResolved from "./fixtures/issues-resolved.json";
// - releases.json: GET /api/0/organizations/{org}/releases/ (List an Organization's Releases).
import releases from "./fixtures/releases.json";
// - webhook-*.json: webhook bodies from the integration platform's Issues and Installation pages
//   (the documented `issue.created` and `installation` samples, the resolved and regressed bodies
//   built from the created one with the documented `status` and `substatus`), on the issues above,
//   keeping the title, culprit, assignee, and actor so the tests prove they are dropped.
import webhookInstallationDeleted from "./fixtures/webhook-installation-deleted.json";
import webhookIssueCreated from "./fixtures/webhook-issue-created.json";
import webhookIssueRegressed from "./fixtures/webhook-issue-regressed.json";
import webhookIssueResolved from "./fixtures/webhook-issue-resolved.json";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const CLIENT_ID = "sentry-client-id";
const CLIENT_SECRET = "sentry-client-secret";
const INSTALLATION_ID = "7a485448-a9e2-4c85-8a3c-4f44175783c9";
const ORG_SLUG = "the-interstellar-jurisdiction";
const PROJECT_ID = "3";
const API = "/api/0";
const ORG = `${API}/organizations/${ORG_SLUG}`;
const TOKEN_PATH = `${API}/sentry-app-installations/${INSTALLATION_ID}/authorizations/`;

type Call = { method: string; url: URL; headers: Headers; body: string | undefined };
type Route = (call: Call) => Response;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

function issuesFor(call: Call): Response {
  const query = call.url.searchParams.get("query") ?? "";
  if (query.startsWith("firstSeen:")) return json(issuesCreated);
  if (query.startsWith("is:unresolved")) return json(issuesActive);
  if (query.startsWith("is:resolved")) return json(issuesResolved);
  return json([]);
}

const defaultRoutes: Record<string, Route> = {
  [`POST ${TOKEN_PATH}`]: () => json(token, 201),
  [`GET ${ORG}/projects/`]: () => json(projects),
  [`GET ${ORG}/stats_v2/`]: () => json(stats),
  [`GET ${ORG}/issues/`]: issuesFor,
  [`GET ${ORG}/releases/`]: () => json(releases),
};

function harness(overrides: Record<string, Route> = {}) {
  const routes = { ...defaultRoutes, ...overrides };
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
    if (call.url.origin !== "https://sentry.io") return json({ detail: "wrong host" }, 404);
    const route = routes[`${call.method} ${call.url.pathname}`];
    return route === undefined ? json({ detail: "not found" }, 404) : route(call);
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
    client: {
      clientId: CLIENT_ID,
      clientSecret: new Secret(CLIENT_SECRET),
      extra: { integrationSlug: new Secret("stackdash-local") },
    },
  };
  const callsTo = (method: string, pathname: string) =>
    calls.filter((call) => call.method === method && call.url.pathname === pathname);
  const issueQueries = () => callsTo("GET", `${ORG}/issues/`).map((call) => call.url.searchParams.get("query"));
  return { ctx, calls, callsTo, issueQueries, warnings };
}

const credential: OAuthCredential = {
  accessToken: new Secret("doc-sample-installation-token-1"),
  expiresAt: new Date("2026-11-05T17:00:00.000Z"),
  scopes: ["org:read", "event:read", "project:read"],
  tokenType: "Bearer",
  metadata: { installationId: INSTALLATION_ID, organizationSlug: ORG_SLUG },
};

const exchangeInput = {
  code: "doc-sample-grant-code",
  redirectUri: "https://stackdash.example/api/connections/sentry/callback",
  callbackParams: { code: "doc-sample-grant-code", installationId: INSTALLATION_ID, orgSlug: ORG_SLUG, state: "s" },
};

type Tracked = Record<string, { shortId: string; regressed: boolean; lastSeen: string }>;

function cursorOf(since: string, issues: Tracked): string {
  return JSON.stringify({ v: 1, since, issues });
}

const StoredCursorSchema = z.strictObject({
  v: z.literal(1),
  since: z.string(),
  issues: z.record(z.string(), z.strictObject({ shortId: z.string(), regressed: z.boolean(), lastSeen: z.string() })),
});

function readCursor(result: SyncResult): z.infer<typeof StoredCursorSchema> {
  if (result.cursor === undefined) throw new Error("expected a cursor");
  return StoredCursorSchema.parse(JSON.parse(result.cursor));
}

// The state a sync an hour earlier would have left: three unresolved issues, none regressed yet.
const previousCursor = cursorOf("2026-11-05T11:00:00.000Z", {
  "80": { shortId: "PRIME-MOVER-19", regressed: false, lastSeen: "2026-11-04T22:00:00.000Z" },
  "90": { shortId: "PRIME-MOVER-1A", regressed: false, lastSeen: "2026-11-05T10:00:00.000Z" },
  "91": { shortId: "PRIME-MOVER-1B", regressed: false, lastSeen: "2026-11-05T10:30:00.000Z" },
});

function decodeJwtPart(part: string | undefined): Record<string, unknown> {
  if (part === undefined) throw new Error("expected a JWT part");
  return z.record(z.string(), z.unknown()).parse(JSON.parse(Buffer.from(part, "base64url").toString("utf8")));
}

describe("sentryAdapter declaration", () => {
  it("polls hourly, refreshes, has no revoke, and asks only for the three read scopes", () => {
    expect(sentryAdapter.pollIntervalSeconds).toBe(3600);
    expect(sentryAdapter.refreshTokens).toBeDefined();
    expect(sentryAdapter.revoke).toBeUndefined();
    expect(sentryAdapter.oauth.pkce).toBe(false);
    expect(sentryAdapter.oauth.scopes).toEqual(["org:read", "event:read", "project:read"]);
    expect(sentryAdapter.oauth.extraEnv).toEqual({ integrationSlug: "SENTRY_INTEGRATION_SLUG" });
    expect(sentryAdapter.permissions.map((permission) => permission.scope)).toEqual(sentryAdapter.oauth.scopes);
    expect(sentryAdapter.permissions.every((permission) => permission.access === "read")).toBe(true);
    const events = sentryAdapter.permissions.find((permission) => permission.scope === "event:read");
    expect(events?.description).toMatch(/never titles, messages, or events/);
    expect(sentryAdapter.capabilities).toMatchObject({ usage: true, spending: false, allowance: false, events: true });
  });
});

describe("sentryAdapter.buildAuthorizeUrl", () => {
  it("builds the external install URL from the slug with state only", () => {
    const { ctx } = harness();
    const url = sentryAdapter.buildAuthorizeUrl({ client: ctx.client, state: "xyzABC123", redirectUri: exchangeInput.redirectUri });
    expect(url.origin + url.pathname).toBe("https://sentry.io/sentry-apps/stackdash-local/external-install/");
    expect([...url.searchParams.entries()]).toEqual([["state", "xyzABC123"]]);
  });

  it.each([
    ["missing", undefined],
    ["only whitespace", "   "],
    ["a path", "stackdash/../admin"],
    ["uppercase", "StackDash"],
    ["longer than 64 characters", "a".repeat(65)],
  ])("refuses the slug when it is %s", (_title, slug) => {
    const { ctx } = harness();
    const client = { ...ctx.client, extra: slug === undefined ? {} : { integrationSlug: new Secret(slug) } };
    expect(() => sentryAdapter.buildAuthorizeUrl({ client, state: "s", redirectUri: exchangeInput.redirectUri })).toThrow(
      /SENTRY_INTEGRATION_SLUG/,
    );
  });
});

describe("sentryAdapter.exchangeCode", () => {
  it("exchanges the code for the installation and proves the organization before storing it", async () => {
    const { ctx, calls } = harness();
    const result = await sentryAdapter.exchangeCode(exchangeInput, ctx);

    const [tokenCall, projectsCall] = calls;
    expect(tokenCall?.method).toBe("POST");
    expect(tokenCall?.url.pathname).toBe(TOKEN_PATH);
    expect(tokenCall?.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(tokenCall?.body ?? "{}")).toEqual({
      grant_type: "authorization_code",
      code: "doc-sample-grant-code",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    });
    expect(projectsCall?.url.pathname).toBe(`${ORG}/projects/`);
    expect(projectsCall?.headers.get("authorization")).toBe(`Bearer ${token.token}`);
    expect(calls).toHaveLength(2);

    expect(result.accessToken.reveal()).toBe(token.token);
    expect(result.expiresAt).toEqual(new Date(token.expiresAt));
    // Refreshes use the JWT bearer grant, so the refresh token Sentry returns is never kept.
    expect(result.refreshToken).toBeUndefined();
    expect(result.scopes).toEqual(["org:read", "event:read", "project:read"]);
    expect(result.metadata).toEqual({ installationId: INSTALLATION_ID, organizationSlug: ORG_SLUG });
    expect(sentryAdapter.detectMissingPermissions(result)).toEqual([]);
  });

  it.each<{ name: string; params: Record<string, string> }>([
    { name: "no installation id", params: { code: "c", orgSlug: ORG_SLUG } },
    { name: "an installation id that walks the path", params: { code: "c", installationId: "../../organizations", orgSlug: ORG_SLUG } },
    { name: "an empty installation id", params: { code: "c", installationId: "", orgSlug: ORG_SLUG } },
    { name: "no organization slug", params: { code: "c", installationId: INSTALLATION_ID } },
    { name: "an organization slug with a slash", params: { code: "c", installationId: INSTALLATION_ID, orgSlug: "acme/../other" } },
    { name: "a very long organization slug", params: { code: "c", installationId: INSTALLATION_ID, orgSlug: "a".repeat(65) } },
  ])("rejects a callback with $name before any request", async ({ params }) => {
    const { ctx, calls } = harness();
    await expect(sentryAdapter.exchangeCode({ ...exchangeInput, callbackParams: params }, ctx)).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
    expect(calls).toHaveLength(0);
  });

  it("refuses an organization slug the installation does not cover", async () => {
    const { ctx } = harness({ [`GET ${ORG}/projects/`]: () => json({ detail: "You do not have permission" }, 403) });
    await expect(sentryAdapter.exchangeCode(exchangeInput, ctx)).rejects.toBeInstanceOf(PermissionMissingError);
  });

  it("reports a rejected grant code as revoked", async () => {
    const { ctx } = harness({ [`POST ${TOKEN_PATH}`]: () => json({ detail: "Invalid grant" }, 401) });
    await expect(sentryAdapter.exchangeCode(exchangeInput, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("rejects a token response without an expiry", async () => {
    const { ctx } = harness({ [`POST ${TOKEN_PATH}`]: () => json({ ...token, expiresAt: null }, 201) });
    await expect(sentryAdapter.exchangeCode(exchangeInput, ctx)).rejects.toMatchObject({ code: "invalid_response" });
  });
});

describe("sentryAdapter.refreshTokens", () => {
  const refresh = (ctx: OAuthContext, current: OAuthCredential = credential) => {
    const refreshTokens = sentryAdapter.refreshTokens;
    if (refreshTokens === undefined) throw new Error("expected refreshTokens");
    return refreshTokens(current, ctx);
  };

  it("signs a one minute HS256 JWT with the client secret and keeps the installation", async () => {
    const { ctx, calls } = harness({ [`POST ${TOKEN_PATH}`]: () => json(tokenRefreshed, 201) });
    const result = await refresh(ctx);

    const [call] = calls;
    expect(JSON.parse(call?.body ?? "{}")).toEqual({ grant_type: "urn:sentry:params:oauth:grant-type:jwt-bearer" });
    const jwt = call?.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const [header, claims, signature] = jwt.split(".");
    expect(decodeJwtPart(header)).toEqual({ alg: "HS256", typ: "JWT" });
    const nowSeconds = NOW.getTime() / 1000;
    expect(decodeJwtPart(claims)).toEqual({
      iss: CLIENT_ID,
      sub: CLIENT_ID,
      iat: nowSeconds,
      exp: nowSeconds + 60,
      jti: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(signature).toBe(createHmac("sha256", CLIENT_SECRET).update(`${header}.${claims}`).digest("base64url"));
    // The client secret signs the JWT and is never sent.
    expect(call?.body).not.toContain(CLIENT_SECRET);

    expect(result.accessToken.reveal()).toBe(tokenRefreshed.token);
    expect(result.expiresAt).toEqual(new Date(tokenRefreshed.expiresAt));
    expect(result.refreshToken).toBeUndefined();
    expect(result.metadata).toEqual(credential.metadata);
    expect(result.scopes).toEqual(credential.scopes);
  });

  it("asks for a reconnect, without a request, when the installation metadata is missing", async () => {
    const { ctx, calls } = harness();
    const bare: OAuthCredential = { accessToken: credential.accessToken, scopes: credential.scopes, tokenType: "Bearer" };
    await expect(refresh(ctx, bare)).rejects.toBeInstanceOf(AuthRevokedError);
    expect(calls).toHaveLength(0);
  });

  it.each([401, 403, 404])("treats %i from the token endpoint as an uninstalled integration", async (status) => {
    const { ctx } = harness({ [`POST ${TOKEN_PATH}`]: () => json({ detail: "gone" }, status) });
    await expect(refresh(ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("keeps a Sentry outage retryable", async () => {
    const { ctx } = harness({ [`POST ${TOKEN_PATH}`]: () => json({ detail: "down" }, 503) });
    await expect(refresh(ctx)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe("nextPageCursor", () => {
  const next = (results: boolean, cursor: string) =>
    `<https://sentry.io/api/0/organizations/acme/projects/?&cursor=0:0:1>; rel="previous"; results="false"; cursor="0:0:1", <https://sentry.io/api/0/organizations/acme/projects/?&cursor=${cursor}>; rel="next"; results="${String(results)}"; cursor="${cursor}"`;

  it.each([
    ["no Link header", null, undefined],
    ["a next page with results", next(true, "0:100:0"), "0:100:0"],
    ["a next link with no results", next(false, "0:200:0"), undefined],
    ["only a previous link", '<https://sentry.io/x>; rel="previous"; results="true"; cursor="0:0:1"', undefined],
  ])("reads %s", (_title, header, expected) => {
    expect(nextPageCursor(header)).toBe(expected);
  });
});

describe("sentryAdapter.listAccounts", () => {
  it("lists every project as an account, falling back to the slug for an empty name", async () => {
    const { ctx, callsTo } = harness();
    await expect(sentryAdapter.listAccounts(credential, ctx)).resolves.toEqual([
      { externalId: "3", displayName: "Prime Mover", kind: "project" },
      { externalId: "4", displayName: "pump-station", kind: "project" },
    ]);
    expect(callsTo("GET", `${ORG}/projects/`)[0]?.url.searchParams.get("per_page")).toBe("100");
  });

  it("follows the Link cursor and stops when Sentry says there are no more results", async () => {
    const { ctx, callsTo } = harness({
      [`GET ${ORG}/projects/`]: (call) => {
        const first = call.url.searchParams.get("cursor") === null;
        return json([{ id: first ? "3" : "4", slug: first ? "p1" : "p2", name: first ? "Project 1" : "Project 2" }], 200, {
          Link: `<https://sentry.io${ORG}/projects/?cursor=0:100:0>; rel="next"; results="${String(first)}"; cursor="0:100:0"`,
        });
      },
    });
    const accounts = await sentryAdapter.listAccounts(credential, ctx);
    expect(accounts.map((account) => account.externalId)).toEqual(["3", "4"]);
    const pageCalls = callsTo("GET", `${ORG}/projects/`);
    expect(pageCalls.map((call) => call.url.searchParams.get("cursor"))).toEqual([null, "0:100:0"]);
  });

  it(`stops after ${MAX_PROJECT_PAGES} pages and says so`, async () => {
    let served = 0;
    const { ctx, callsTo, warnings } = harness({
      [`GET ${ORG}/projects/`]: () => {
        served += 1;
        return json([{ id: String(served), slug: `p${served}`, name: null }], 200, {
          Link: `<https://sentry.io${ORG}/projects/>; rel="next"; results="true"; cursor="0:${served * 100}:0"`,
        });
      },
    });
    const accounts = await sentryAdapter.listAccounts(credential, ctx);
    expect(accounts).toHaveLength(MAX_PROJECT_PAGES);
    expect(callsTo("GET", `${ORG}/projects/`)).toHaveLength(MAX_PROJECT_PAGES);
    expect(warnings).toContain("sentry.projects.page_cap");
  });
});

describe("sentryAdapter.sync, first sync", () => {
  async function firstSync() {
    const h = harness();
    const result = await sentryAdapter.sync({ credential, externalAccountId: PROJECT_ID }, h.ctx);
    return { ...h, result };
  }

  it("reports accepted, filtered, and rate limited errors for the period Sentry returned", async () => {
    const { result, callsTo } = await firstSync();
    expect(result.metrics).toEqual(
      ["accepted", "filtered", "rate_limited"].map((outcome) => ({
        kind: "usage",
        metricKey: `sentry.errors.${outcome}`,
        label: expect.stringMatching(/, last 24 hours$/),
        // The fixture has no rate_limited group: Sentry omits outcomes with no events.
        value: { accepted: 1520, filtered: 87, rate_limited: 0 }[outcome],
        unit: "errors",
        timeframe: { type: "period", start: new Date(stats.start), end: new Date(stats.end) },
        externalAccountId: PROJECT_ID,
        retrievedAt: NOW,
        provenance: { source: "provider_api", endpoint: "https://sentry.io/api/0/organizations/{organization}/stats_v2/" },
      })),
    );
    const [statsCall] = callsTo("GET", `${ORG}/stats_v2/`);
    expect(statsCall?.url.searchParams.getAll("groupBy")).toEqual(["outcome"]);
    expect(Object.fromEntries(statsCall?.url.searchParams ?? [])).toMatchObject({
      field: "sum(quantity)",
      category: "error",
      project: PROJECT_ID,
      statsPeriod: "24h",
      interval: "1h",
    });
    expect(validateAdapterMetrics("sentry", result.metrics)).toMatchObject({ ok: true });
  });

  it("backfills a day of new issues and releases and records a baseline instead of status changes", async () => {
    const { result, issueQueries, callsTo } = await firstSync();
    expect(issueQueries()).toEqual(["firstSeen:>=2026-11-04T12:00:00Z", "is:unresolved lastSeen:>=2026-11-04T12:00:00Z"]);
    const [createdCall] = callsTo("GET", `${ORG}/issues/`);
    expect(createdCall?.url.searchParams.get("sort")).toBe("new");
    expect(createdCall?.url.searchParams.get("project")).toBe(PROJECT_ID);
    expect(createdCall?.url.searchParams.get("statsPeriod")).toBe("14d");

    expect(result.events.map((event) => [event.typeId, event.title, event.severity])).toEqual([
      ["sentry.issue.created", "New issue PRIME-MOVER-2F", "critical"],
      ["sentry.issue.created", "New issue PRIME-MOVER-2G", "info"],
      // Release 6 was created four days ago, before the first sync's one day window.
      ["sentry.release.created", "Release frontend@1.2.0 created", "info"],
    ]);
    const [fatal] = result.events;
    expect(fatal).toMatchObject({
      occurredAt: new Date("2026-11-05T11:40:00Z"),
      body: "Level: fatal",
      dedupeKey: "sentry.issue.created:101",
      url: "https://sentry.io/the-interstellar-jurisdiction/pump-station/issues/101/",
    });
    expect(result.events[2]).toMatchObject({
      occurredAt: new Date("2026-11-05T10:30:00Z"),
      dedupeKey: `sentry.release.created:${PROJECT_ID}:7`,
    });
    expect(validateAdapterEvents(sentryAdapter.eventTypes, result.events)).toMatchObject({ ok: true });
    expect(result.partialErrors).toBeUndefined();
  });

  it("never carries issue titles, messages, assignees, or release authors into its output", async () => {
    const { result } = await firstSync();
    const output = JSON.stringify({ metrics: result.metrics, events: result.events, cursor: result.cursor });
    for (const text of ["ZeroDivisionError", "jane@example.com", "john.doe@example.com", "John Doe", "raven.scripts"]) {
      expect(output).not.toContain(text);
    }
  });

  it("remembers the unresolved issues it saw so a later sync can see them change", async () => {
    const { result } = await firstSync();
    expect(readCursor(result)).toEqual({
      v: 1,
      since: NOW.toISOString(),
      issues: {
        "101": { shortId: "PRIME-MOVER-2F", regressed: false, lastSeen: "2026-11-05T11:58:00.000Z" },
        "102": { shortId: "PRIME-MOVER-2G", regressed: false, lastSeen: "2026-11-05T11:21:00.000Z" },
        "90": { shortId: "PRIME-MOVER-1A", regressed: true, lastSeen: "2026-11-05T11:50:00.000Z" },
        "91": { shortId: "PRIME-MOVER-1B", regressed: false, lastSeen: "2026-11-05T11:45:00.000Z" },
      },
    });
  });
});

describe("sentryAdapter.sync, later syncs", () => {
  it("reports a regression and a resolution once, dated when this sync saw them", async () => {
    const { ctx, issueQueries } = harness();
    const result = await sentryAdapter.sync({ credential, externalAccountId: PROJECT_ID, cursor: previousCursor }, ctx);

    // Ten minutes of overlap before the last sync; only the quiet tracked issue is looked up.
    expect(issueQueries()).toEqual([
      "firstSeen:>=2026-11-05T10:50:00Z",
      "is:unresolved lastSeen:>=2026-11-05T10:50:00Z",
      "is:resolved issue:[PRIME-MOVER-19]",
    ]);
    const changes = result.events.filter((event) => event.typeId !== "sentry.issue.created");
    expect(changes).toEqual([
      {
        typeId: "sentry.issue.regressed",
        occurredAt: NOW,
        severity: "critical",
        title: "Issue PRIME-MOVER-1A regressed",
        body: "Level: error",
        externalAccountId: PROJECT_ID,
        dedupeKey: "sentry.issue.regressed:90:2026-11-05",
        url: "https://sentry.io/the-interstellar-jurisdiction/pump-station/issues/90/",
      },
      {
        typeId: "sentry.issue.resolved",
        occurredAt: NOW,
        severity: "success",
        title: "Issue PRIME-MOVER-19 resolved",
        externalAccountId: PROJECT_ID,
        dedupeKey: "sentry.issue.resolved:80:2026-11-05",
        url: "https://sentry.io/the-interstellar-jurisdiction/pump-station/issues/80/",
      },
    ]);
    // Release 7 (10:30) is older than this window: it was reported by the earlier sync.
    expect(result.events.some((event) => event.typeId === "sentry.release.created")).toBe(false);

    const next = readCursor(result);
    expect(next.issues["80"]).toBeUndefined();
    expect(next.issues["90"]?.regressed).toBe(true);

    // The next sync sees the same regressed issue and stays quiet about it.
    const again = await sentryAdapter.sync(
      { credential, externalAccountId: PROJECT_ID, cursor: JSON.stringify(next) },
      harness().ctx,
    );
    expect(again.events.filter((event) => event.typeId === "sentry.issue.regressed")).toEqual([]);
  });

  it("skips the resolved lookup when every tracked issue is still active", async () => {
    const { ctx, issueQueries } = harness();
    const cursor = cursorOf("2026-11-05T11:00:00.000Z", {
      "90": { shortId: "PRIME-MOVER-1A", regressed: true, lastSeen: "2026-11-05T10:00:00.000Z" },
    });
    const result = await sentryAdapter.sync({ credential, externalAccountId: PROJECT_ID, cursor }, ctx);
    expect(issueQueries()).toHaveLength(2);
    expect(result.events.filter((event) => event.typeId !== "sentry.issue.created")).toEqual([]);
  });

  it("catches up at most a week after a long pause", async () => {
    const { ctx, issueQueries } = harness();
    await sentryAdapter.sync(
      { credential, externalAccountId: PROJECT_ID, cursor: cursorOf("2026-09-01T00:00:00.000Z", {}) },
      ctx,
    );
    expect(issueQueries()[0]).toBe("firstSeen:>=2026-10-29T12:00:00Z");
  });

  it("keeps at most the newest 100 tracked issues and forgets ones not seen for 13 days", async () => {
    const tracked: Tracked = {};
    for (let index = 0; index < 150; index += 1) {
      tracked[String(1000 + index)] = {
        shortId: `OLD-${index}`,
        regressed: false,
        lastSeen: new Date(NOW.getTime() - (index + 1) * 60_000).toISOString(),
      };
    }
    tracked["999"] = { shortId: "STALE-1", regressed: false, lastSeen: "2026-10-20T00:00:00.000Z" };
    const { ctx } = harness({ [`GET ${ORG}/issues/`]: () => json([]) });
    const result = await sentryAdapter.sync(
      { credential, externalAccountId: PROJECT_ID, cursor: cursorOf("2026-11-05T11:00:00.000Z", tracked) },
      ctx,
    );
    const kept = Object.keys(readCursor(result).issues);
    expect(kept).toHaveLength(MAX_TRACKED_ISSUES);
    expect(kept).not.toContain("999");
    expect(kept).toContain("1000");
    expect(kept).not.toContain("1149");
  });

  it("re-baselines with a warning when the cursor is unreadable", async () => {
    const { ctx, warnings } = harness();
    const result = await sentryAdapter.sync({ credential, externalAccountId: PROJECT_ID, cursor: "{not json" }, ctx);
    expect(warnings).toContain("sentry.sync.cursor_unreadable");
    expect(result.events.filter((event) => event.typeId === "sentry.issue.regressed")).toEqual([]);
    expect(readCursor(result).since).toBe(NOW.toISOString());
  });
});

describe("sentryAdapter.sync boundaries", () => {
  it.each([
    ["the usage stats", `GET ${ORG}/stats_v2/`, "org:read"],
    ["the issue list", `GET ${ORG}/issues/`, "event:read"],
    ["the release list", `GET ${ORG}/releases/`, "project:read"],
  ])("reports a refused %s as a missing scope and keeps the rest", async (_what, route, scope) => {
    const { ctx } = harness({ [route]: () => json({ detail: "You do not have permission" }, 403) });
    const result = await sentryAdapter.sync({ credential, externalAccountId: PROJECT_ID }, ctx);
    expect(result.partialErrors?.map((error) => error.missingScopes)).toEqual([[scope]]);
    expect(result.metrics.length + result.events.length).toBeGreaterThan(0);
    expect(result.cursor).toBeDefined();
  });

  it("fails the sync when the token is rejected", async () => {
    const { ctx } = harness({ [`GET ${ORG}/stats_v2/`]: () => json({ detail: "Invalid token" }, 401) });
    await expect(sentryAdapter.sync({ credential, externalAccountId: PROJECT_ID }, ctx)).rejects.toBeInstanceOf(
      AuthRevokedError,
    );
  });

  it("passes Sentry's rate limit on with its Retry-After", async () => {
    const { ctx } = harness({ [`GET ${ORG}/issues/`]: () => json({ detail: "slow down" }, 429, { "Retry-After": "30" }) });
    await expect(sentryAdapter.sync({ credential, externalAccountId: PROJECT_ID }, ctx)).rejects.toMatchObject({
      constructor: RateLimitedError,
      retryAfterMs: 30_000,
    });
  });

  it("refuses a stats period that does not move forward", async () => {
    const { ctx } = harness({ [`GET ${ORG}/stats_v2/`]: () => json({ ...stats, end: stats.start }) });
    await expect(sentryAdapter.sync({ credential, externalAccountId: PROJECT_ID }, ctx)).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });

  it("refuses an account that is not a project id", async () => {
    const { ctx, calls } = harness();
    await expect(sentryAdapter.sync({ credential, externalAccountId: "prime-mover" }, ctx)).rejects.toThrow(/project id/);
    expect(calls).toHaveLength(0);
  });

  it("asks for a reconnect when the credential lost its installation", async () => {
    const { ctx } = harness();
    await expect(
      sentryAdapter.sync({ credential: { ...credential, metadata: {} }, externalAccountId: PROJECT_ID }, ctx),
    ).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("drops a link that is not an https sentry.io address", async () => {
    const elsewhere = issuesCreated.map((issue) => ({ ...issue, permalink: "https://sentry.io.evil.example/issues/1/" }));
    const plain = issuesCreated.map((issue) => ({ ...issue, permalink: "http://sentry.io/issues/1/" }));
    for (const page of [elsewhere, plain]) {
      const { ctx } = harness({
        [`GET ${ORG}/issues/`]: (call) => (call.url.searchParams.get("query")?.startsWith("firstSeen:") ? json(page) : json([])),
      });
      const result = await sentryAdapter.sync({ credential, externalAccountId: PROJECT_ID }, ctx);
      const created = result.events.filter((event) => event.typeId === "sentry.issue.created");
      expect(created).toHaveLength(2);
      for (const event of created) expect(event.url).toBeUndefined();
    }
  });

  it("warns when a page of new issues is full, since older ones may be cut off", async () => {
    const full = Array.from({ length: 100 }, (_, index) => ({
      ...issuesCreated[0],
      id: String(5000 + index),
      shortId: `PRIME-MOVER-${index}`,
    }));
    const { ctx, warnings } = harness({
      [`GET ${ORG}/issues/`]: (call) => (call.url.searchParams.get("query")?.startsWith("firstSeen:") ? json(full) : json([])),
    });
    const result = await sentryAdapter.sync({ credential, externalAccountId: PROJECT_ID }, ctx);
    expect(warnings).toContain("sentry.issues.page_cap");
    expect(result.events.filter((event) => event.typeId === "sentry.issue.created")).toHaveLength(100);
  });

  it("rejects a short id that could break out of the resolved lookup", async () => {
    const injected = [{ ...issuesCreated[0], shortId: "WEB-1] is:unresolved" }];
    const { ctx } = harness({ [`GET ${ORG}/issues/`]: () => json(injected) });
    await expect(sentryAdapter.sync({ credential, externalAccountId: PROJECT_ID }, ctx)).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });
});

describe("sentryAdapter.webhooks", () => {
  // Made up, and built from parts so CI's secret scan (gitleaks) does not read it as a credential.
  const WEBHOOK_SECRET = new Secret(["sentry", "webhook", "value"].join("-"));
  const NOW_SECONDS = NOW.getTime() / 1000;
  const REQUEST_ID = "1f4c6a2b9e8d4c3ba7f05e6d2c1b0a99";
  const CREATED_BODY = JSON.stringify(webhookIssueCreated);

  function descriptor(): WebhookDescriptor {
    const { webhooks } = sentryAdapter;
    if (webhooks === undefined) throw new Error("the Sentry adapter declares no webhook");
    return webhooks;
  }

  type Delivery = Partial<{
    resource: string;
    timestamp: string;
    requestId: string;
    secret: Secret;
    // Signs this body while sending the real one, as a tampered delivery would.
    signedBody: string;
    omit: keyof typeof SENTRY_WEBHOOK_HEADERS;
  }>;

  // A delivery as Sentry sends it; each option bends one part of it for a boundary test.
  function delivery(rawBody: string, options: Delivery = {}): WebhookRequest {
    const headers = new Headers({
      "content-type": "application/json",
      [SENTRY_WEBHOOK_HEADERS.delivery]: options.requestId ?? REQUEST_ID,
      [SENTRY_WEBHOOK_HEADERS.resource]: options.resource ?? "issue",
      [SENTRY_WEBHOOK_HEADERS.timestamp]: options.timestamp ?? String(NOW_SECONDS),
      [SENTRY_WEBHOOK_HEADERS.signature]: sentryWebhookSignature(options.secret ?? WEBHOOK_SECRET, options.signedBody ?? rawBody),
    });
    if (options.omit !== undefined) headers.delete(SENTRY_WEBHOOK_HEADERS[options.omit]);
    return { headers, rawBody: new TextEncoder().encode(rawBody) };
  }

  function parsed(rawBody: string, options: Delivery = {}) {
    const request = delivery(rawBody, options);
    expect(descriptor().verify(request, WEBHOOK_SECRET, NOW)).toEqual({ ok: true, deliveryId: REQUEST_ID });
    return descriptor().parse(request, harness().ctx);
  }

  async function laterSyncEvents(routes: Record<string, Route> = {}) {
    const result = await sentryAdapter.sync({ credential, externalAccountId: PROJECT_ID, cursor: previousCursor }, harness(routes).ctx);
    return result.events;
  }

  it("is registered on the integration and signed with the client secret", () => {
    expect(descriptor().registration).toEqual({ kind: "app", secretEnv: sentryAdapter.oauth.clientSecretEnv });
  });

  it("maps the documented issue.created delivery to the event the sync stores for the same issue", async () => {
    const outcome = parsed(CREATED_BODY);
    expect(checkWebhookOutcome(sentryAdapter, outcome)).toEqual([]);
    expect(outcome).toEqual({
      kind: "events",
      externalAccountId: PROJECT_ID,
      // The installation that sent it, which the credential records, so only its connections receive it (#497).
      installationId: INSTALLATION_ID,
      events: [
        {
          typeId: "sentry.issue.created",
          occurredAt: new Date("2026-11-05T11:40:00.679Z"),
          severity: "critical",
          title: "New issue PRIME-MOVER-2F",
          body: "Level: fatal",
          externalAccountId: PROJECT_ID,
          dedupeKey: "sentry.issue.created:101",
          url: "https://sentry.io/the-interstellar-jurisdiction/pump-station/issues/101/",
        },
      ],
    });
    // Polled later: the same dedupe key, so the timeline stores the issue once.
    const polled = (await laterSyncEvents()).filter((event) => event.dedupeKey === "sentry.issue.created:101");
    expect(polled).toHaveLength(1);
  });

  it("maps a delivery whose status and lastSeen are missing or null, since no event reads them (boundary)", () => {
    const { status: _status, ...withoutStatus } = webhookIssueResolved.data.issue;
    const body = JSON.stringify({ ...webhookIssueResolved, data: { issue: { ...withoutStatus, lastSeen: null } } });
    expect(parsed(body)).toMatchObject({
      kind: "events",
      events: [{ typeId: "sentry.issue.resolved", dedupeKey: "sentry.issue.resolved:80:2026-11-05" }],
    });
  });

  it("dates a resolution by the delivery and keys it as a sync on the same UTC day does", async () => {
    const sentSeconds = NOW_SECONDS - 120;
    const outcome = parsed(JSON.stringify(webhookIssueResolved), { timestamp: String(sentSeconds) });
    expect(checkWebhookOutcome(sentryAdapter, outcome)).toEqual([]);
    const polled = (await laterSyncEvents()).find((event) => event.typeId === "sentry.issue.resolved");
    expect(polled?.dedupeKey).toBe("sentry.issue.resolved:80:2026-11-05");
    expect(outcome).toEqual({
      kind: "events",
      externalAccountId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      events: [{ ...polled, occurredAt: new Date(sentSeconds * 1000) }],
    });
  });

  it("keys a resolution as the sync does when the issue keeps receiving events while resolved (boundary: release resolution)", async () => {
    // Resolved for the next release: events from older releases keep arriving and move lastSeen,
    // so the sync reads a later lastSeen than the delivery carried.
    const outcome = parsed(JSON.stringify(webhookIssueResolved));
    const stillFiring = [{ ...issuesResolved[0], lastSeen: "2026-11-05T11:55:00Z" }];
    const routes: Record<string, Route> = {
      [`GET ${ORG}/issues/`]: (call) => (call.url.searchParams.get("query")?.startsWith("is:resolved") ? json(stillFiring) : issuesFor(call)),
    };
    const polled = (await laterSyncEvents(routes)).find((event) => event.typeId === "sentry.issue.resolved");
    expect(polled).toBeDefined();
    expect(outcome).toMatchObject({ kind: "events", events: [{ dedupeKey: polled?.dedupeKey }] });
  });

  it("dates a regression by the delivery and keys it as a sync on the same UTC day does", async () => {
    const sentSeconds = NOW_SECONDS - 120;
    const outcome = parsed(JSON.stringify(webhookIssueRegressed), { timestamp: String(sentSeconds) });
    expect(checkWebhookOutcome(sentryAdapter, outcome)).toEqual([]);
    const polled = (await laterSyncEvents()).find((event) => event.typeId === "sentry.issue.regressed");
    expect(polled?.dedupeKey).toBe("sentry.issue.regressed:90:2026-11-05");
    expect(outcome).toEqual({
      kind: "events",
      externalAccountId: PROJECT_ID,
      installationId: INSTALLATION_ID,
      events: [{ ...polled, occurredAt: new Date(sentSeconds * 1000) }],
    });
  });

  it.each([
    ["the first second of a UTC day", "2026-11-05T00:00:00Z", "sentry.issue.regressed:90:2026-11-05"],
    ["the last second of the UTC day before", "2026-11-04T23:59:59Z", "sentry.issue.regressed:90:2026-11-04"],
  ])("keys a regression delivered at %s by that day (boundary)", (_case, sentAt, dedupeKey) => {
    const at = new Date(sentAt);
    const request = delivery(JSON.stringify(webhookIssueRegressed), { timestamp: String(at.getTime() / 1000) });
    expect(descriptor().verify(request, WEBHOOK_SECRET, at).ok).toBe(true);
    expect(descriptor().parse(request, harness().ctx)).toMatchObject({ kind: "events", events: [{ dedupeKey, occurredAt: at }] });
  });

  it("names the installation that sent an issue delivery, whichever it is, so a later install's deliveries reach only its connections (#497)", () => {
    const reinstalled = "0c6f3a0e-5d1b-4e61-9f7a-2b8d4c1e9a70";
    const outcome = parsed(JSON.stringify({ ...webhookIssueCreated, installation: { uuid: reinstalled } }));
    expect(outcome).toMatchObject({ kind: "events", externalAccountId: PROJECT_ID, installationId: reinstalled });
    expect(checkWebhookOutcome(sentryAdapter, outcome)).toEqual([]);
    // Not the installation the existing credential was granted for.
    expect(sentryAdapter.installationIdOf?.(credential)).not.toBe(reinstalled);
  });

  it.each([
    ["no installation", (body: Record<string, unknown>) => ({ ...body, installation: undefined })],
    ["an installation id that could change a path", (body: Record<string, unknown>) => ({ ...body, installation: { uuid: "../7a485448" } })],
    ["an empty installation id", (body: Record<string, unknown>) => ({ ...body, installation: { uuid: "" } })],
  ])("ignores an issue delivery with %s, since it cannot say which connections it is for (boundary)", (_case, bend) => {
    expect(parsed(JSON.stringify(bend(webhookIssueCreated)))).toEqual({ kind: "ignored", reason: "not an issue delivery StackDash reads" });
  });

  it("reports installation.deleted as an uninstall of the installation the credential was granted for, dated when sent", () => {
    const sentSeconds = NOW_SECONDS - 120;
    const outcome = parsed(JSON.stringify(webhookInstallationDeleted), { resource: "installation", timestamp: String(sentSeconds) });
    expect(outcome).toEqual({ kind: "uninstalled", by: "installation", installationId: INSTALLATION_ID, occurredAt: new Date(sentSeconds * 1000) });
    expect(checkWebhookOutcome(sentryAdapter, outcome)).toEqual([]);
    // The same id the connection records for its credential, so the uninstall finds it.
    expect(sentryAdapter.installationIdOf?.(credential)).toBe(INSTALLATION_ID);
    // Never the grant code or who uninstalled.
    const output = JSON.stringify(outcome);
    for (const text of ["doc-sample-grant-code", "Meredith Heller"]) expect(output).not.toContain(text);
  });

  it.each<[string, OAuthCredential["metadata"]]>([
    ["no metadata", undefined],
    ["no installation id", { organizationSlug: ORG_SLUG }],
    ["an empty installation id", { installationId: "", organizationSlug: ORG_SLUG }],
    ["an installation id that could change a path", { installationId: "../7a485448", organizationSlug: ORG_SLUG }],
  ])("names no installation for a credential with %s (boundary)", (_case, metadata) => {
    const { metadata: _dropped, ...rest } = credential;
    expect(sentryAdapter.installationIdOf?.(metadata === undefined ? rest : { ...rest, metadata })).toBeNull();
  });

  it("never carries the issue title, culprit, assignee, or actor into the outcome", () => {
    const outcomes = [webhookIssueCreated, webhookIssueResolved, webhookIssueRegressed].map((body) => parsed(JSON.stringify(body)));
    const output = JSON.stringify(outcomes);
    for (const text of ["ZeroDivisionError", "ValueError", "KeyError", "jane@example.com", "John Doe", "john.doe@example.com", "Meredith Heller", "raven.scripts"]) {
      expect(output).not.toContain(text);
    }
  });

  it.each<[string, Delivery, string]>([
    ["no signature", { omit: "signature" }, "missing_signature"],
    ["no timestamp", { omit: "timestamp" }, "missing_signature"],
    ["a timestamp that is not whole seconds", { timestamp: "1762344000.5" }, "malformed"],
    ["a timestamp one second past the tolerance", { timestamp: String(NOW_SECONDS - SENTRY_WEBHOOK_TOLERANCE_SECONDS - 1) }, "stale"],
    ["a timestamp one second past the tolerance in the future", { timestamp: String(NOW_SECONDS + SENTRY_WEBHOOK_TOLERANCE_SECONDS + 1) }, "stale"],
    ["no Request-ID", { omit: "delivery" }, "malformed"],
    ["a Request-ID longer than 200 characters", { requestId: "a".repeat(201) }, "malformed"],
    ["a signature made with another secret", { secret: new Secret("another-webhook-value") }, "bad_signature"],
    ["a body changed after signing", { signedBody: CREATED_BODY.replace("PRIME-MOVER-2F", "PRIME-MOVER-2G") }, "bad_signature"],
  ])("rejects a delivery with %s (boundary)", (_case, options, reason) => {
    expect(descriptor().verify(delivery(CREATED_BODY, options), WEBHOOK_SECRET, NOW)).toEqual({ ok: false, reason });
  });

  it.each([
    ["the past", -SENTRY_WEBHOOK_TOLERANCE_SECONDS],
    ["the future", SENTRY_WEBHOOK_TOLERANCE_SECONDS],
  ])("accepts a timestamp exactly at the tolerance in %s (boundary)", (_case, offsetSeconds) => {
    const request = delivery(CREATED_BODY, { timestamp: String(NOW_SECONDS + offsetSeconds) });
    expect(descriptor().verify(request, WEBHOOK_SECRET, NOW).ok).toBe(true);
  });

  const issueBody = (action: string, substatus: string | null) =>
    JSON.stringify({ ...webhookIssueRegressed, action, data: { issue: { ...webhookIssueRegressed.data.issue, substatus } } });

  it.each<[string, string, Delivery]>([
    ["issue.assigned", issueBody("assigned", "ongoing"), {}],
    ["issue.archived", issueBody("archived", "archived_forever"), {}],
    ["issue.unresolved that is escalating, not regressed", issueBody("unresolved", "escalating"), {}],
    ["issue.unresolved without a substatus", issueBody("unresolved", null), {}],
    ["an issue without its project", JSON.stringify({ ...webhookIssueCreated, data: { issue: { ...webhookIssueCreated.data.issue, project: null } } }), {}],
    ["a feedback issue, which the issue search never returns", JSON.stringify({ ...webhookIssueCreated, data: { issue: { ...webhookIssueCreated.data.issue, issueCategory: "feedback" } } }), {}],
    ["an issue body under the installation resource", CREATED_BODY, { resource: "installation" }],
    // Every Sentry body has a top-level installation.uuid; only the signed body may say it is an uninstall.
    ["a deleted body without the installation under data, under the installation resource", JSON.stringify({ ...webhookIssueCreated, action: "deleted" }), { resource: "installation" }],
    [
      "installation.deleted whose data names another installation",
      JSON.stringify({ ...webhookInstallationDeleted, data: { installation: { ...webhookInstallationDeleted.data.installation, uuid: "0b6d8f2e-1c3a-4e5f-9a7b-2d4c6e8f0a1b" } } }),
      { resource: "installation" },
    ],
    ["installation.created", JSON.stringify({ ...webhookInstallationDeleted, action: "created" }), { resource: "installation" }],
    ["a resource StackDash does not subscribe to", CREATED_BODY, { resource: "error" }],
    ["no resource header", CREATED_BODY, { omit: "resource" }],
    ["a body that is not JSON", "action=created", {}],
  ])("ignores %s (boundary)", (_case, body, options) => {
    const outcome = parsed(body, options);
    expect(outcome).toMatchObject({ kind: "ignored" });
    expect(checkWebhookOutcome(sentryAdapter, outcome)).toEqual([]);
  });
});
