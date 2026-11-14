import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { describe, expect, it } from "vitest";
import { achievementRuleMetricKey } from "../achievements";
import { AuthRevokedError, InvalidResponseError, PermissionMissingError, ProviderUnavailableError } from "../errors";
import { validateAdapterEvents } from "../events";
import { validateAdapterMetrics, type AdapterMetric } from "../metrics";
import { Secret, type FetchLike, type OAuthContext, type OAuthCredential } from "../types";
import { ASSERTION_AUDIENCE, CLIENT_ASSERTION_TYPE } from "./client-auth";
import { billingMetrics, MAX_SIGNUP_PROJECTS, postHogAdapter, SCOPES, usageLimitEvents } from "./index";
import { BillingResponseSchema } from "./schemas";
// Every fixture below is from documentation, not recorded (no PostHog account yet, #141): the
// sample shapes in docs/providers/posthog.md, trimmed, with synthetic ids, tokens, and values.
// `POST /oauth/token/` per the OAuth development guide, "Response includes".
import tokenFixture from "./fixtures/token.json";
// The same after a refresh that returns no new refresh token.
import tokenRefreshedFixture from "./fixtures/token-refreshed.json";
// `GET /api/organizations/` (PaginatedOrganizationList).
import organizationsFixture from "./fixtures/organizations.json";
// `GET /api/organizations/{id}/projects/` (PaginatedProjectBackwardCompatBasicList).
import projectsFixture from "./fixtures/projects.json";
// `GET /api/billing/` (BillingOverviewResponse, products as BillingProductV2Type).
import billingFixture from "./fixtures/billing.json";
// `POST /api/projects/{id}/query/` with the signup HogQL query.
import querySignupsFixture from "./fixtures/query-signups.json";

const NOW = new Date("2026-11-05T09:00:00.000Z");
const CLIENT_ID = "https://devmacro.example.com/oauth/posthog/client-metadata";
const ORG_ID = "0191c2d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d";
const US = "https://us.posthog.com";
const EU = "https://eu.posthog.com";
const OAUTH = "https://oauth.posthog.com";
const verifier = "v".repeat(43);

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

type Call = { method: string; url: URL; headers: Headers; body: string | undefined };
type Route = (call: Call) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Routes are keyed by method, origin, and path, because the adapter talks to three hosts. */
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
    const route = routes[`${call.method} ${call.url.origin}${call.url.pathname}`];
    if (route === undefined) return json({ detail: "Not found." }, 404);
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
    client: { clientId: CLIENT_ID, clientSecret: new Secret(PRIVATE_PEM), extra: {} },
  };
  return { ctx, calls, warnings };
}

const credential: OAuthCredential = {
  accessToken: new Secret("synthetic-access-token"),
  refreshToken: new Secret("synthetic-refresh-token"),
  expiresAt: new Date(NOW.getTime() + 36_000_000),
  scopes: SCOPES,
  tokenType: "Bearer",
  metadata: { region: "us" },
};

const syncRoutes = (overrides: Record<string, Route> = {}): Record<string, Route> => ({
  [`GET ${US}/api/billing/`]: () => json(billingFixture),
  [`GET ${US}/api/organizations/${ORG_ID}/projects/`]: () => json(projectsFixture),
  [`POST ${US}/api/projects/10001/query/`]: () => json(querySignupsFixture),
  [`POST ${US}/api/projects/10002/query/`]: () => json({ ...querySignupsFixture, results: [] }),
  ...overrides,
});

function form(call: Call | undefined): URLSearchParams {
  if (call?.body === undefined) throw new Error("expected a form body");
  return new URLSearchParams(call.body);
}

/** Verifies an ES256 client assertion against `key` and returns its claims. */
function assertionClaims(assertion: string | null, key: KeyObject): Record<string, unknown> {
  if (assertion === null) throw new Error("expected a client assertion");
  const [header, payload, signature] = assertion.split(".");
  if (header === undefined || payload === undefined || signature === undefined) throw new Error("not a JWS");
  const valid = verify(
    "sha256",
    Buffer.from(`${header}.${payload}`),
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
  expect(valid).toBe(true);
  expect(JSON.parse(Buffer.from(header, "base64url").toString())).toMatchObject({ alg: "ES256", typ: "JWT" });
  return JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
}

function byKey(metrics: readonly AdapterMetric[], key: string): AdapterMetric {
  const found = metrics.find((metric) => metric.metricKey === key);
  if (found === undefined) throw new Error(`metric ${key} missing`);
  return found;
}

describe("postHogAdapter declaration", () => {
  it("requests the four read-only scopes from #115 and nothing else", () => {
    expect(postHogAdapter.oauth.scopes).toEqual(["billing:read", "organization:read", "project:read", "query:read"]);
    expect(postHogAdapter.permissions.map((permission) => permission.scope)).toEqual([...SCOPES]);
    expect(postHogAdapter.permissions.every((permission) => permission.access === "read")).toBe(true);
    expect(postHogAdapter.oauth.pkce).toBe(true);
    expect(postHogAdapter.oauth.clientIdEnv).toBe("POSTHOG_OAUTH_CLIENT_ID");
    expect(postHogAdapter.oauth.clientSecretEnv).toBe("POSTHOG_OAUTH_PRIVATE_KEY");
    expect(postHogAdapter.capabilities).toMatchObject({ spending: true, usage: true, allowance: true, events: true, webhooks: false });
  });
});

describe("buildAuthorizeUrl", () => {
  const client = { clientId: CLIENT_ID, clientSecret: new Secret(PRIVATE_PEM), extra: {} };

  it("sends the metadata URL as client id, the scopes, PKCE, and organization level access", () => {
    const url = postHogAdapter.buildAuthorizeUrl({
      client,
      state: "state-1",
      redirectUri: "https://devmacro.example.com/api/connections/posthog/callback",
      codeChallenge: "challenge-1",
    });
    expect(`${url.origin}${url.pathname}`).toBe(`${OAUTH}/oauth/authorize/`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: "https://devmacro.example.com/api/connections/posthog/callback",
      scope: "billing:read organization:read project:read query:read",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
      required_access_level: "organization",
    });
  });

  it.each([
    ["without a code challenge", { state: "s" }],
    ["with an empty state", { state: "", codeChallenge: "c" }],
  ])("refuses to build a URL %s", (_title, params) => {
    expect(() => postHogAdapter.buildAuthorizeUrl({ client, redirectUri: "https://x.example/cb", ...params })).toThrow();
  });
});

describe("exchangeCode", () => {
  const input = { code: "code-1", redirectUri: "https://devmacro.example.com/cb", codeVerifier: verifier, callbackParams: {} };

  it("signs a fresh client assertion and stores the region that accepts the token", async () => {
    const { ctx, calls } = harness({
      [`POST ${OAUTH}/oauth/token/`]: () => json(tokenFixture),
      [`GET ${US}/api/organizations/`]: () => json(organizationsFixture),
    });
    const result = await postHogAdapter.exchangeCode(input, ctx);

    const body = form(calls[0]);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toBe(verifier);
    expect(body.get("client_id")).toBe(CLIENT_ID);
    expect(body.get("client_assertion_type")).toBe(CLIENT_ASSERTION_TYPE);
    expect(body.has("client_secret")).toBe(false);
    const claims = assertionClaims(body.get("client_assertion"), publicKey);
    expect(claims).toMatchObject({ iss: CLIENT_ID, sub: CLIENT_ID, aud: [...ASSERTION_AUDIENCE] });
    expect(Number(claims.exp) - Number(claims.iat)).toBe(60);
    expect(claims.iat).toBe(NOW.getTime() / 1000);
    expect(typeof claims.jti).toBe("string");

    expect(result.accessToken.reveal()).toBe("fixture-access-token");
    expect(result.refreshToken?.reveal()).toBe("fixture-refresh-token");
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + 36_000_000));
    expect(result.scopes).toEqual([...SCOPES]);
    // The organization picked on the consent screen, from `scoped_organizations`.
    expect(result.metadata).toEqual({ region: "us", organizations: ORG_ID });
    expect(JSON.stringify(result)).not.toContain("fixture-access-token");
  });

  it("falls through to EU Cloud when US Cloud does not know the token", async () => {
    const { ctx, calls } = harness({
      [`POST ${OAUTH}/oauth/token/`]: () => json(tokenFixture),
      [`GET ${US}/api/organizations/`]: () => json({ detail: "Invalid token" }, 401),
      [`GET ${EU}/api/organizations/`]: () => json(organizationsFixture),
    });
    const result = await postHogAdapter.exchangeCode(input, ctx);
    expect(result.metadata).toMatchObject({ region: "eu" });
    expect(calls.map((call) => call.url.origin)).toEqual([OAUTH, US, EU]);
  });

  it("takes a 403 as the token's region: the token is known there, it only lacks a permission", async () => {
    const { ctx } = harness({
      [`POST ${OAUTH}/oauth/token/`]: () => json(tokenFixture),
      [`GET ${US}/api/organizations/`]: () => json({ detail: "forbidden" }, 403),
    });
    expect((await postHogAdapter.exchangeCode(input, ctx)).metadata).toMatchObject({ region: "us" });
  });

  it.each([
    ["empty", []],
    ["null", null],
  ])("stores no organization list when scoped_organizations is %s, so every organization is listed", async (_title, scoped) => {
    const { ctx } = harness({
      [`POST ${OAUTH}/oauth/token/`]: () => json({ ...tokenFixture, scoped_organizations: scoped }),
      [`GET ${US}/api/organizations/`]: () => json(organizationsFixture),
    });
    expect((await postHogAdapter.exchangeCode(input, ctx)).metadata).toEqual({ region: "us" });
  });

  it("connects whatever shape the token fields it does not read arrive in", async () => {
    const { ctx } = harness({
      [`POST ${OAUTH}/oauth/token/`]: () => json({ ...tokenFixture, scoped_teams: ["10001"], id_token: 5 }),
      [`GET ${US}/api/organizations/`]: () => json(organizationsFixture),
    });
    expect((await postHogAdapter.exchangeCode(input, ctx)).accessToken.reveal()).toBe("fixture-access-token");
  });

  it("reports auth revoked when neither region accepts the token", async () => {
    const { ctx } = harness({
      [`POST ${OAUTH}/oauth/token/`]: () => json(tokenFixture),
      [`GET ${US}/api/organizations/`]: () => json({}, 401),
      [`GET ${EU}/api/organizations/`]: () => json({}, 401),
    });
    await expect(postHogAdapter.exchangeCode(input, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("maps invalid_grant to auth revoked and other 400s to an invalid response", async () => {
    const revoked = harness({ [`POST ${OAUTH}/oauth/token/`]: () => json({ error: "invalid_grant" }, 400) });
    await expect(postHogAdapter.exchangeCode(input, revoked.ctx)).rejects.toBeInstanceOf(AuthRevokedError);
    const invalid = harness({ [`POST ${OAUTH}/oauth/token/`]: () => json({ error: "invalid_request" }, 400) });
    await expect(postHogAdapter.exchangeCode(input, invalid.ctx)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  // A rejected client assertion is the deployment's key or clock, not the user's grant: retried,
  // never a revoked connection (Provisioning, Troubleshoot assertion errors).
  it.each([
    ["a 401 invalid_client", () => json({ error: "invalid_client", error_description: "Client keys could not be retrieved" }, 401)],
    ["a 401 without an error body", () => new Response("", { status: 401 })],
    ["a 400 invalid_client", () => json({ error: "invalid_client" }, 400)],
  ])("reports %s as provider unavailable, not auth revoked", async (_title, route) => {
    const { ctx } = harness({ [`POST ${OAUTH}/oauth/token/`]: route });
    await expect(postHogAdapter.exchangeCode(input, ctx)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it.each([
    ["missing", undefined],
    ["too short", "v".repeat(42)],
    ["with a reserved character", `${"v".repeat(42)}+`],
  ])("refuses a code verifier that is %s before any request", async (_title, codeVerifier) => {
    const { ctx, calls } = harness({});
    const { codeVerifier: _valid, ...withoutVerifier } = input;
    const attempt = codeVerifier === undefined ? withoutVerifier : { ...withoutVerifier, codeVerifier };
    await expect(postHogAdapter.exchangeCode(attempt, ctx)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toEqual([]);
  });

  it("fails on a signing key that is not a PEM private key, before any request", async () => {
    const { ctx, calls } = harness({});
    const broken = { ...ctx, client: { ...ctx.client, clientSecret: new Secret("not a key") } };
    await expect(postHogAdapter.exchangeCode(input, broken)).rejects.toThrow(/POSTHOG_OAUTH_PRIVATE_KEY/);
    expect(calls).toEqual([]);
  });
});

describe("refreshTokens", () => {
  it("keeps the old refresh token and the region when PostHog returns no new refresh token", async () => {
    const { ctx, calls } = harness({ [`POST ${OAUTH}/oauth/token/`]: () => json(tokenRefreshedFixture) });
    const refreshed = await postHogAdapter.refreshTokens?.(credential, ctx);
    expect(form(calls[0]).get("grant_type")).toBe("refresh_token");
    expect(form(calls[0]).get("refresh_token")).toBe("synthetic-refresh-token");
    expect(form(calls[0]).get("client_assertion")).not.toBeNull();
    expect(refreshed?.accessToken.reveal()).toBe("fixture-access-token-2");
    expect(refreshed?.refreshToken?.reveal()).toBe("synthetic-refresh-token");
    expect(refreshed?.metadata).toEqual({ region: "us" });
  });

  it("keeps the granted organizations when the refresh response does not name them", async () => {
    const { ctx } = harness({ [`POST ${OAUTH}/oauth/token/`]: () => json(tokenRefreshedFixture) });
    const scoped = { ...credential, metadata: { region: "eu", organizations: ORG_ID } };
    expect((await postHogAdapter.refreshTokens?.(scoped, ctx))?.metadata).toEqual({ region: "eu", organizations: ORG_ID });
  });

  it("uses a rotated refresh token when PostHog returns one", async () => {
    const { ctx } = harness({ [`POST ${OAUTH}/oauth/token/`]: () => json(tokenFixture) });
    expect((await postHogAdapter.refreshTokens?.(credential, ctx))?.refreshToken?.reveal()).toBe("fixture-refresh-token");
  });

  it("keeps the connection retryable when PostHog cannot verify the client assertion on a refresh", async () => {
    const { ctx } = harness({ [`POST ${OAUTH}/oauth/token/`]: () => json({ error: "invalid_client" }, 401) });
    await expect(postHogAdapter.refreshTokens?.(credential, ctx)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("asks to reconnect when PostHog reports the refresh token gone", async () => {
    const { ctx } = harness({ [`POST ${OAUTH}/oauth/token/`]: () => json({ error: "invalid_grant" }, 400) });
    await expect(postHogAdapter.refreshTokens?.(credential, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it.each([
    ["has no refresh token", { ...credential, refreshToken: undefined }],
    ["has no region", { ...credential, metadata: {} }],
    ["names an unknown region", { ...credential, metadata: { region: "ap" } }],
  ])("asks to reconnect when the credential %s", async (_title, broken) => {
    const { ctx, calls } = harness({});
    const { refreshToken, ...rest } = broken;
    const input: OAuthCredential = refreshToken === undefined ? rest : { ...rest, refreshToken };
    await expect(postHogAdapter.refreshTokens?.(input, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
    expect(calls).toEqual([]);
  });
});

describe("revoke", () => {
  it("revokes the grant through the refresh token with a signed assertion, accepting an empty 200", async () => {
    const { ctx, calls } = harness({ [`POST ${OAUTH}/oauth/revoke/`]: () => new Response("", { status: 200 }) });
    await postHogAdapter.revoke?.(credential, ctx);
    const body = form(calls[0]);
    expect(body.get("token")).toBe("synthetic-refresh-token");
    expect(body.get("token_type_hint")).toBe("refresh_token");
    assertionClaims(body.get("client_assertion"), publicKey);
  });

  it("does nothing but warn without a refresh token", async () => {
    const { ctx, calls, warnings } = harness({});
    const { refreshToken: _unused, ...withoutRefresh } = credential;
    await postHogAdapter.revoke?.(withoutRefresh, ctx);
    expect(calls).toEqual([]);
    expect(warnings).toEqual(["posthog.revoke.no_refresh_token"]);
  });
});

describe("listAccounts", () => {
  it("lists organizations from the credential's region, keeping only the id and name", async () => {
    const { ctx, calls } = harness({ [`GET ${EU}/api/organizations/`]: () => json(organizationsFixture) });
    const accounts = await postHogAdapter.listAccounts({ ...credential, metadata: { region: "eu" } }, ctx);
    expect(accounts).toEqual([{ externalId: ORG_ID, displayName: "Example organization", kind: "organization" }]);
    expect(calls[0]?.url.searchParams.get("limit")).toBe("100");
  });

  it("lists only the organizations the grant names when the user picked some", async () => {
    const other = { ...organizationsFixture.results[0], id: "0191c2d4-5e6f-7a8b-9c0d-ffffffffffff", name: "Other organization" };
    const { ctx } = harness({
      [`GET ${US}/api/organizations/`]: () => json({ ...organizationsFixture, count: 2, results: [...organizationsFixture.results, other] }),
    });
    const scoped = await postHogAdapter.listAccounts({ ...credential, metadata: { region: "us", organizations: ORG_ID } }, ctx);
    expect(scoped.map((account) => account.displayName)).toEqual(["Example organization"]);
    // Without a list the grant covers every organization.
    const all = await postHogAdapter.listAccounts(credential, ctx);
    expect(all.map((account) => account.displayName)).toEqual(["Example organization", "Other organization"]);
  });

  it("warns when there are more organizations than one page", async () => {
    const { ctx, warnings } = harness({
      [`GET ${US}/api/organizations/`]: () => json({ ...organizationsFixture, next: `${US}/api/organizations/?offset=100` }),
    });
    await postHogAdapter.listAccounts(credential, ctx);
    expect(warnings).toEqual(["posthog.organizations_truncated"]);
  });
});

describe("detectMissingPermissions", () => {
  it.each([
    ["the full grant", [...SCOPES], []],
    ["a grant without billing:read, as a metadata document app may get (#11)", ["organization:read", "project:read", "query:read"], ["billing:read"]],
    ["an empty grant", [], [...SCOPES]],
  ])("reports what %s lacks", (_title, scopes, missing) => {
    expect(postHogAdapter.detectMissingPermissions({ scopes })).toEqual(missing);
  });
});

describe("sync", () => {
  it("reads billing, usage limits, and a week of signups on the first sync", async () => {
    const { ctx, calls } = harness(syncRoutes());
    const result = await postHogAdapter.sync({ credential, externalAccountId: ORG_ID }, ctx);

    const metrics = validateAdapterMetrics("posthog", result.metrics);
    expect(metrics.ok ? [] : metrics.issues).toEqual([]);
    const events = validateAdapterEvents(postHogAdapter.eventTypes, result.events);
    expect(events.ok ? [] : events.issues).toEqual([]);
    expect(result.partialErrors).toBeUndefined();

    const billingCall = calls.find((call) => call.url.pathname === "/api/billing/");
    expect(billingCall?.url.searchParams.get("organization_id")).toBe(ORG_ID);
    expect(billingCall?.url.searchParams.get("include_forecasting")).toBe("true");

    // Discounted totals, rounded once to cents.
    expect(byKey(result.metrics, "posthog.spend.current")).toMatchObject({ kind: "verified_spend", amountMinor: 1872, currency: "USD" });
    expect(byKey(result.metrics, "posthog.spend.projected")).toMatchObject({
      kind: "estimated_spend",
      amountMinor: 4104,
      // The user reads the pricing source; the endpoint stays in provenance only.
      provenance: {
        source: "derived",
        endpoint: `${US}/api/billing/`,
        pricingSource: "PostHog's own projection for the billing period, from its billing overview",
      },
    });
    // A projection for the whole period, so the dashboard headline (#173) never counts it as spend so far.
    expect(postHogAdapter.projectedSpend).toEqual(["posthog.spend.projected"]);
    expect(byKey(result.metrics, "posthog.spend.current").timeframe).toEqual({
      type: "period",
      start: new Date("2026-11-01T00:00:00.000Z"),
      end: new Date("2026-12-01T00:00:00.000Z"),
    });
    expect(byKey(result.metrics, "posthog.product_analytics.usage")).toMatchObject({ value: 1_250_000, unit: "events" });
    expect(byKey(result.metrics, "posthog.product_analytics.free")).toMatchObject({ kind: "included_allowance", value: 1_000_000 });
    expect(byKey(result.metrics, "posthog.product_analytics.free_remaining")).toMatchObject({ value: 0 });
    // Each product's spend is a breakdown one segment below the organization total (#204).
    expect(byKey(result.metrics, "posthog.spend.current.session_replay")).toMatchObject({ amountMinor: 550 });
    expect(byKey(result.metrics, "posthog.surveys.usage")).toMatchObject({ unit: "survey responses" });
    // Inclusion-only products carry no usage key and produce nothing.
    expect(result.metrics.some((metric) => metric.metricKey.startsWith("posthog.platform_and_support"))).toBe(false);

    expect(result.events.filter((event) => event.typeId.startsWith("posthog.usage_limit")).map((event) => [event.typeId, event.title])).toEqual([
      ["posthog.usage_limit.near", "Session replay is at 87 percent of its PostHog billing limit"],
      ["posthog.usage_limit.reached", "Surveys reached its PostHog billing limit"],
    ]);

    const queries = calls.filter((call) => call.url.pathname.endsWith("/query/"));
    expect(queries.map((call) => call.url.pathname)).toEqual(["/api/projects/10001/query/", "/api/projects/10002/query/"]);
    const hogql = JSON.parse(queries[0]?.body ?? "{}").query;
    expect(hogql.kind).toBe("HogQLQuery");
    expect(hogql.query).toContain("toDateTime('2026-10-29 00:00:00', 'UTC')");
    expect(hogql.query).toContain("toDateTime('2026-11-05 00:00:00', 'UTC')");
    expect(calls.find((call) => call.url.pathname.endsWith("/projects/"))?.url.searchParams.get("limit")).toBe(String(MAX_SIGNUP_PROJECTS));

    const signups = result.events.filter((event) => event.typeId === "posthog.signups.daily");
    expect(signups.map((event) => [event.title, event.occurredAt.toISOString(), event.dedupeKey])).toEqual([
      ["14 signups in Example app on 2026-11-03", "2026-11-04T00:00:00.000Z", "posthog.signups:10001:2026-11-03"],
      ["9 signups in Example app on 2026-11-04", "2026-11-05T00:00:00.000Z", "posthog.signups:10001:2026-11-04"],
    ]);
    // The timeframe names the day, so the label does not have to.
    expect(byKey(result.metrics, "posthog.signups.daily")).toMatchObject({
      label: "Daily signups",
      value: 9,
      unit: "signups",
      timeframe: { type: "period", start: new Date("2026-11-04T00:00:00.000Z"), end: new Date("2026-11-05T00:00:00.000Z") },
    });
    // Declared as a daily signup total, so the dashboard headline counts it as PostHog's signups (#173).
    expect(postHogAdapter.signupDailyTotals).toEqual(["posthog.signups.daily"]);
    // The harness checks only that an achievement's metric key has the adapter's prefix; this
    // proves every key the achievements read is one a sync emits.
    const achievementKeys = new Set((postHogAdapter.achievements ?? []).flatMap((achievement) => achievementRuleMetricKey(achievement.rule) ?? []));
    expect([...achievementKeys]).toEqual(["posthog.signups.daily"]);
    for (const key of achievementKeys) expect(byKey(result.metrics, key).metricKey).toBe(key);
    expect(result.cursor).toBe(JSON.stringify({ v: 1, through: "2026-11-04" }));
  });

  it("does not query signups again until another UTC day has ended", async () => {
    const { ctx, calls } = harness(syncRoutes());
    const result = await postHogAdapter.sync(
      { credential, externalAccountId: ORG_ID, cursor: JSON.stringify({ v: 1, through: "2026-11-04" }) },
      ctx,
    );
    expect(calls.map((call) => call.url.pathname)).toEqual(["/api/billing/"]);
    expect(result.cursor).toBe(JSON.stringify({ v: 1, through: "2026-11-04" }));
    expect(result.metrics.some((metric) => metric.metricKey === "posthog.signups.daily")).toBe(false);
  });

  it.each([
    ["one day behind", "2026-11-03", "2026-11-04"],
    // SIGNUP_BACKFILL_DAYS (7) complete days before 2026-11-05.
    ["far behind, capped to the backfill window", "2026-09-01", "2026-10-29"],
  ])("queries from the day after the cursor when it is %s", async (_title, through, from) => {
    const { ctx, calls } = harness(syncRoutes());
    await postHogAdapter.sync({ credential, externalAccountId: ORG_ID, cursor: JSON.stringify({ v: 1, through }) }, ctx);
    const query = calls.find((call) => call.url.pathname.endsWith("/query/"));
    expect(JSON.parse(query?.body ?? "{}").query.query).toContain(`toDateTime('${from} 00:00:00', 'UTC')`);
  });

  it("starts again from the backfill window when the cursor is unreadable", async () => {
    const { ctx, warnings } = harness(syncRoutes());
    const result = await postHogAdapter.sync({ credential, externalAccountId: ORG_ID, cursor: "not json" }, ctx);
    expect(warnings).toContain("posthog.sync.cursor_unreadable");
    expect(result.cursor).toBe(JSON.stringify({ v: 1, through: "2026-11-04" }));
  });

  it("reports a billing refusal as a missing billing:read and still syncs signups", async () => {
    const { ctx } = harness(syncRoutes({ [`GET ${US}/api/billing/`]: () => json({ detail: "forbidden" }, 403) }));
    const result = await postHogAdapter.sync({ credential, externalAccountId: ORG_ID }, ctx);
    expect(result.partialErrors?.map((error) => error.missingScopes)).toEqual([["billing:read"]]);
    expect(result.metrics.map((metric) => metric.metricKey)).toEqual(["posthog.signups.daily"]);
    expect(result.cursor).toBe(JSON.stringify({ v: 1, through: "2026-11-04" }));
  });

  it.each([
    ["the member lacks billing access when billing:read is granted", SCOPES, /for this member\. Reading billing needs billing access/],
    ["the grant lacks billing:read when it was not granted", ["organization:read", "project:read", "query:read"], /the grant needs billing:read$/],
  ])("says %s", async (_title, scopes, message) => {
    const { ctx } = harness(syncRoutes({ [`GET ${US}/api/billing/`]: () => json({ detail: "forbidden" }, 403) }));
    const result = await postHogAdapter.sync({ credential: { ...credential, scopes }, externalAccountId: ORG_ID }, ctx);
    expect(result.partialErrors?.map((error) => error.message)).toEqual([expect.stringMatching(message)]);
  });

  it("keeps the cursor and reports query:read once when the signup queries are refused", async () => {
    const refused = () => json({ detail: "forbidden" }, 403);
    const { ctx } = harness(
      syncRoutes({ [`POST ${US}/api/projects/10001/query/`]: refused, [`POST ${US}/api/projects/10002/query/`]: refused }),
    );
    const cursor = JSON.stringify({ v: 1, through: "2026-11-02" });
    const result = await postHogAdapter.sync({ credential, externalAccountId: ORG_ID, cursor }, ctx);
    expect(result.partialErrors?.map((error) => error.missingScopes)).toEqual([["query:read"]]);
    expect(result.cursor).toBe(cursor);
    expect(result.events.some((event) => event.typeId === "posthog.signups.daily")).toBe(false);
  });

  it("reports a refused project list as a missing project:read", async () => {
    const { ctx } = harness(
      syncRoutes({ [`GET ${US}/api/organizations/${ORG_ID}/projects/`]: () => json({ detail: "forbidden" }, 403) }),
    );
    const result = await postHogAdapter.sync({ credential, externalAccountId: ORG_ID }, ctx);
    expect(result.partialErrors?.map((error) => error.missingScopes)).toEqual([["project:read"]]);
    expect(result.cursor).toBeUndefined();
  });

  it("fails the sync on a revoked token rather than reporting partial data", async () => {
    const { ctx } = harness(syncRoutes({ [`GET ${US}/api/billing/`]: () => json({ detail: "Invalid token" }, 401) }));
    await expect(postHogAdapter.sync({ credential, externalAccountId: ORG_ID }, ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("warns when an organization has more projects than one sync queries", async () => {
    const { ctx, warnings } = harness(
      syncRoutes({
        [`GET ${US}/api/organizations/${ORG_ID}/projects/`]: () => json({ ...projectsFixture, next: `${US}/next` }),
      }),
    );
    await postHogAdapter.sync({ credential, externalAccountId: ORG_ID }, ctx);
    expect(warnings).toContain("posthog.sync.project_cap");
  });

  it("refuses a billing response with an amount that is not a decimal", async () => {
    const { ctx } = harness(
      syncRoutes({ [`GET ${US}/api/billing/`]: () => json({ ...billingFixture, current_total_amount_usd_after_discount: 18.72 }) }),
    );
    await expect(postHogAdapter.sync({ credential, externalAccountId: ORG_ID }, ctx)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it("reads the right regional API for an EU credential", async () => {
    const eu = Object.fromEntries(Object.entries(syncRoutes()).map(([key, route]) => [key.replace(US, EU), route]));
    const { ctx, calls } = harness(eu);
    await postHogAdapter.sync({ credential: { ...credential, metadata: { region: "eu" } }, externalAccountId: ORG_ID }, ctx);
    expect(new Set(calls.map((call) => call.url.origin))).toEqual(new Set([EU]));
  });
});

describe("billingMetrics", () => {
  const metricsFor = (billing: Record<string, unknown>) =>
    billingMetrics(BillingResponseSchema.parse(billing), ORG_ID, NOW, "us");
  const product = (fields: Record<string, unknown>) => ({
    products: [{ type: "data_warehouse", name: "Data warehouse", usage_key: "rows_synced", current_usage: 10, ...fields }],
  });

  it.each([
    ["a singular noun", "row", "rows"],
    ["a noun already plural", "rows", "rows"],
    ["a symbol", "GB", "GB"],
    ["no unit", null, "units"],
    ["a unit the metric model cannot store", "rows!", "units"],
    ["a unit too long to store", "a".repeat(40), "units"],
  ])("stores %s as a unit DevMacro can show", (_title, unit, expected) => {
    expect(byKey(metricsFor(product({ unit })), "posthog.data_warehouse.usage")).toMatchObject({ unit: expected });
  });

  it("sends no allowance metrics for a product without a free allocation", () => {
    for (const free of [null, 0]) {
      const keys = metricsFor(product({ free_allocation: free })).map((metric) => metric.metricKey);
      expect(keys).toEqual(["posthog.data_warehouse.usage"]);
    }
  });

  it("never goes below zero free allocation left", () => {
    const metrics = metricsFor(product({ free_allocation: 5, current_usage: 9 }));
    expect(byKey(metrics, "posthog.data_warehouse.free_remaining")).toMatchObject({ value: 0 });
  });

  it("dates billing metrics at the read time when PostHog sends no billing period", () => {
    const [spend] = metricsFor({ current_total_amount_usd: "0.00" });
    expect(spend).toMatchObject({ metricKey: "posthog.spend.current", amountMinor: 0, timeframe: { type: "point", at: NOW } });
    expect(spend).not.toHaveProperty("resetsAt");
  });

  it("sends PostHog's projection beside the current total", () => {
    const keys = metricsFor({ current_total_amount_usd: "1.00", projected_total_amount_usd: "3.00" }).map((metric) => metric.metricKey);
    expect(keys).toEqual(["posthog.spend.current", "posthog.spend.projected"]);
  });

  // Declared a projection, so nothing counts it as spend so far; it needs no current total beside it (#223).
  it("sends PostHog's projection when PostHog reports no current total", () => {
    for (const current of [{}, { current_total_amount_usd: null }]) {
      const billing = { ...current, projected_total_amount_usd: "3.00", projected_total_amount_usd_after_discount: "2.40" };
      expect(metricsFor(billing)).toEqual([expect.objectContaining({ metricKey: "posthog.spend.projected", amountMinor: 240 })]);
    }
  });

  it("reads a billing period whatever its interval says", () => {
    const [spend] = metricsFor({
      current_total_amount_usd: "1.00",
      billing_period: { current_period_start: "2026-11-01T00:00:00Z", current_period_end: "2027-02-01T00:00:00Z", interval: "quarter" },
    });
    expect(spend?.timeframe).toEqual({
      type: "period",
      start: new Date("2026-11-01T00:00:00.000Z"),
      end: new Date("2027-02-01T00:00:00.000Z"),
    });
  });

  it.each([
    ["with Z", "2026-11-01T00:00:00Z", "2026-12-01T00:00:00Z"],
    ["with an offset", "2026-11-01T01:00:00+01:00", "2026-12-01T01:00:00+01:00"],
    ["without a zone, read as UTC", "2026-11-01T00:00:00", "2026-12-01T00:00:00.000000"],
  ])("reads billing period timestamps %s", (_title, start, end) => {
    const [spend] = metricsFor({ current_total_amount_usd: "1.00", billing_period: { current_period_start: start, current_period_end: end } });
    expect(spend?.timeframe).toEqual({
      type: "period",
      start: new Date("2026-11-01T00:00:00.000Z"),
      end: new Date("2026-12-01T00:00:00.000Z"),
    });
  });

  it("refuses a billing period that is a date with no time", () => {
    expect(() => metricsFor({ billing_period: { current_period_start: "2026-11-01", current_period_end: "2026-12-01" } })).toThrow();
  });

  it("skips a product whose type cannot be part of a metric key", () => {
    expect(metricsFor({ products: [{ type: "Data-Warehouse", name: "x", usage_key: "rows", current_usage: 1 }] })).toEqual([]);
  });

  it("sends nothing for an empty billing overview", () => {
    expect(metricsFor({})).toEqual([]);
  });
});

describe("usageLimitEvents", () => {
  const period = { current_period_start: new Date("2026-11-01T00:00:00Z"), current_period_end: new Date("2026-12-01T00:00:00Z") };
  const at = (product: Record<string, unknown>) =>
    usageLimitEvents(
      BillingResponseSchema.parse({
        billing_period: { current_period_start: period.current_period_start.toISOString(), current_period_end: period.current_period_end.toISOString() },
        products: [{ type: "session_replay", name: "Session replay", usage_key: "recordings", ...product }],
      }),
      ORG_ID,
      NOW,
      "us",
    ).map((event) => event.typeId);

  it.each([
    ["just under 80 percent", { current_usage: 799, usage_limit: 1000 }, []],
    ["exactly 80 percent", { current_usage: 800, usage_limit: 1000 }, ["posthog.usage_limit.near"]],
    ["just under the limit", { current_usage: 999, usage_limit: 1000 }, ["posthog.usage_limit.near"]],
    ["at the limit", { current_usage: 1000, usage_limit: 1000 }, ["posthog.usage_limit.reached"]],
    ["flagged exceeded below the limit", { current_usage: 10, usage_limit: 1000, has_exceeded_limit: true }, ["posthog.usage_limit.reached"]],
    ["with no limit", { current_usage: 5000, usage_limit: null }, []],
    ["with a zero limit", { current_usage: 5000, usage_limit: 0 }, []],
    ["with no usage reported", { usage_limit: 1000 }, []],
  ])("is %s", (_title, product, expected) => {
    expect(at(product)).toEqual(expected);
  });

  it("dedupes each level once per product and billing period", () => {
    const billing = BillingResponseSchema.parse(billingFixture);
    const keys = usageLimitEvents(billing, ORG_ID, NOW, "us").map((event) => event.dedupeKey);
    const later = usageLimitEvents(billing, ORG_ID, new Date(NOW.getTime() + 3_600_000), "us").map((event) => event.dedupeKey);
    expect(later).toEqual(keys);
    expect(keys[0]).toBe(`posthog.usage_limit:${ORG_ID}:session_replay:2026-11-01T00:00:00.000Z:near`);
  });
});

describe("errors never carry the token", () => {
  it("keeps the access token out of a refused request's error", async () => {
    const { ctx } = harness(syncRoutes({ [`GET ${US}/api/billing/`]: () => json({ detail: "x" }, 500) }));
    const error = await postHogAdapter.sync({ credential, externalAccountId: ORG_ID }, ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("synthetic-access-token");
    expect(error).not.toBeInstanceOf(PermissionMissingError);
  });
});
