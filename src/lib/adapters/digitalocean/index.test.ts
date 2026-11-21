import { describe, expect, it, vi } from "vitest";
import { AuthRevokedError, InvalidResponseError, PermissionMissingError } from "../errors";
import { validateAdapterEvents, type ActivityEvent } from "../events";
import { dashboardSpendAfterSync } from "../harness";
import { validateAdapterMetrics, type AdapterMetric } from "../metrics";
import { Secret, type FetchLike, type OAuthContext, type OAuthCredential, type SyncResult } from "../types";
import {
  CREDIT_BALANCE_METRIC_KEY,
  digitaloceanAdapter,
  LATEST_INVOICE_METRIC_KEY,
  MAX_NEW_INVOICES,
  MAX_PAGES,
  MAX_SKU_METRICS,
  MONTH_TO_DATE_METRIC_KEY,
  SCOPES,
} from "./index";

// Every fixture below is from documentation, not recorded: the response examples in the
// DigitalOcean OpenAPI specification (github.com/digitalocean/openapi, commit ace42c4, checked
// 2026-11-05) and the OAuth API page (docs.digitalocean.com/reference/api/oauth/, checked
// 2026-11-05), trimmed, with synthetic ids, names, tokens, amounts, and dates moved to
// November 2026. Replace them with sanitized recordings from a test team once one exists (#141).
// - token.json / token-refreshed.json: POST /v1/oauth/token, the documented grant with its
//   personal `info` fields (synthetic), so the tests prove only the team id is kept.
import tokenFixture from "./fixtures/token.json";
import tokenRefreshedFixture from "./fixtures/token-refreshed.json";
// - account.json: GET /v2/account, with the user's email and name the adapter must drop.
import accountFixture from "./fixtures/account.json";
// - balance.json: GET /v2/customers/my/balance.
import balanceFixture from "./fixtures/balance.json";
// - invoices.json / invoice-items.json: GET /v2/customers/my/invoices and one invoice's items.
import invoiceItemsFixture from "./fixtures/invoice-items.json";
import invoicesFixture from "./fixtures/invoices.json";
// - insights.json: GET /v2/billing/{urn}/insights/{start}/{end}, with two data points for one SKU
//   on one day (summed, rounded once) and one point for another team (skipped).
import insightsFixture from "./fixtures/insights.json";
// - actions.json / droplets.json: GET /v2/actions and GET /v2/droplets.
import actionsFixture from "./fixtures/actions.json";
import dropletsFixture from "./fixtures/droplets.json";
// - apps.json / deployments.json: GET /v2/apps and GET /v2/apps/{id}/deployments. The pending
//   deployment carries the zero time from the documentation example.
import appsFixture from "./fixtures/apps.json";
import deploymentsFixture from "./fixtures/deployments.json";

const NOW = new Date("2026-11-05T12:00:00Z");
const TEAM = "11111111-a636-11ec-a6ac-1323bf96ef4d";
const APP_ID = "4f6c71e2-1e90-4762-9fee-6cc4a0a9f2cf";
const INVOICE_UUID = "22737513-0ea7-4206-8ceb-98a575af7681";
const DAY_MS = 24 * 60 * 60 * 1000;

type Call = { url: URL; init: RequestInit | undefined };
type Route = (url: URL, init: RequestInit | undefined) => Response;

const forbidden = () => Response.json({ id: "Forbidden", message: "You are not authorized to perform this operation" }, { status: 403 });

/** Fake DigitalOcean serving the fixtures by path, with overrides and a call log. No network. */
function fakeDigitalOcean(overrides: Readonly<Record<string, Route>> = {}) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    calls.push({ url, init });
    const key = `${url.host}${url.pathname}`;
    const override = overrides[url.pathname] ?? overrides[key];
    if (override !== undefined) return override(url, init);
    if (url.host === "cloud.digitalocean.com") {
      if (url.pathname === "/v1/oauth/token") return Response.json(tokenFixture);
      if (url.pathname === "/v1/oauth/revoke") return Response.json({});
    }
    if (url.pathname.startsWith("/v2/billing/")) return Response.json(insightsFixture);
    switch (url.pathname) {
      case "/v2/account":
        return Response.json(accountFixture);
      case "/v2/customers/my/balance":
        return Response.json(balanceFixture);
      case "/v2/customers/my/invoices":
        return Response.json(invoicesFixture);
      case `/v2/customers/my/invoices/${INVOICE_UUID}`:
        return Response.json(invoiceItemsFixture);
      case "/v2/actions":
        return Response.json(actionsFixture);
      case "/v2/droplets":
        return Response.json(dropletsFixture);
      case "/v2/apps":
        return Response.json(appsFixture);
      case `/v2/apps/${APP_ID}/deployments`:
        return Response.json(deploymentsFixture);
      default:
        return Response.json({ id: "not_found", message: "The resource you were accessing could not be found." }, { status: 404 });
    }
  };
  const callsTo = (pathname: string) => calls.filter((call) => call.url.pathname === pathname);
  return { fetch, calls, callsTo };
}

function makeCtx(fetch: FetchLike, now: Date = NOW) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const ctx: OAuthContext = {
    fetch,
    now: () => now,
    timeoutMs: 1000,
    logger,
    client: { clientId: "do-client-id", clientSecret: new Secret("do-client-secret"), extra: {} },
  };
  return { ctx, logger };
}

function form(call: Call | undefined): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(String(call?.init?.body)));
}

const credential: OAuthCredential = {
  accessToken: new Secret("doo_v1_fixture_access_1"),
  refreshToken: new Secret("dor_v1_fixture_refresh_1"),
  expiresAt: new Date(NOW.getTime() + 60_000),
  scopes: [...SCOPES],
  tokenType: "bearer",
  metadata: { teamUuid: TEAM },
};

const syncInput = { credential, externalAccountId: TEAM };

function expectValid(result: SyncResult): void {
  const metrics = validateAdapterMetrics("digitalocean", result.metrics);
  expect(metrics.ok ? [] : metrics.issues).toEqual([]);
  const events = validateAdapterEvents(digitaloceanAdapter.eventTypes, result.events);
  expect(events.ok ? [] : events.issues).toEqual([]);
}

function metric(metrics: readonly AdapterMetric[], key: string): AdapterMetric {
  const found = metrics.find((candidate) => candidate.metricKey === key);
  if (found === undefined) throw new Error(`metric ${key} missing`);
  return found;
}

function titles(events: readonly ActivityEvent[], prefix: string): string[] {
  return events.filter((event) => event.typeId.startsWith(prefix)).map((event) => event.title).sort();
}

describe("digitaloceanAdapter declaration", () => {
  it("asks for exactly the five read-only scopes, polls hourly, and refreshes and revokes", () => {
    expect(digitaloceanAdapter.oauth.scopes).toEqual(["billing:read", "actions:read", "app:read", "droplet:read", "account:read"]);
    expect(digitaloceanAdapter.permissions.map((permission) => [permission.scope, permission.access])).toEqual(
      SCOPES.map((scope) => [scope, "read"]),
    );
    expect(digitaloceanAdapter.pollIntervalSeconds).toBe(3600);
    expect(digitaloceanAdapter.oauth.pkce).toBe(true);
    expect(digitaloceanAdapter.refreshTokens).toBeDefined();
    expect(digitaloceanAdapter.revoke).toBeDefined();
    expect(digitaloceanAdapter.oauth.clientIdEnv).toBe("DIGITALOCEAN_CLIENT_ID");
    expect(digitaloceanAdapter.oauth.clientSecretEnv).toBe("DIGITALOCEAN_CLIENT_SECRET");
  });

  it("discloses that app:read reaches logs and environment values before connecting", () => {
    const appRead = digitaloceanAdapter.permissions.find((permission) => permission.scope === "app:read");
    expect(appRead?.description).toMatch(/logs, which can contain secrets/);
    expect(appRead?.description).toMatch(/environment variable values/);
  });
});

describe("buildAuthorizeUrl", () => {
  const client = { clientId: "do-client-id", clientSecret: new Secret("do-client-secret"), extra: {} };

  it("sends the explicit read-only scopes, state, and an S256 challenge to DigitalOcean", () => {
    const url = digitaloceanAdapter.buildAuthorizeUrl({
      client,
      state: "state-1",
      redirectUri: "https://stackdash.example/api/connections/digitalocean/callback",
      codeChallenge: "challenge-1",
    });
    expect(`${url.origin}${url.pathname}`).toBe("https://cloud.digitalocean.com/v1/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "do-client-id",
      redirect_uri: "https://stackdash.example/api/connections/digitalocean/callback",
      response_type: "code",
      scope: "billing:read actions:read app:read droplet:read account:read",
      state: "state-1",
      code_challenge: "challenge-1",
      code_challenge_method: "S256",
    });
  });

  it("refuses to build a URL without a code challenge", () => {
    expect(() =>
      digitaloceanAdapter.buildAuthorizeUrl({ client, state: "state-1", redirectUri: "https://stackdash.example/cb" }),
    ).toThrow(TypeError);
  });
});

describe("exchangeCode", () => {
  const input = {
    code: "code-1",
    redirectUri: "https://stackdash.example/api/connections/digitalocean/callback",
    codeVerifier: "v".repeat(43),
    callbackParams: {},
  };

  it("posts a form body, keeps the team id only, and stores both tokens with a 30 day expiry", async () => {
    const api = fakeDigitalOcean();
    const result = await digitaloceanAdapter.exchangeCode(input, makeCtx(api.fetch).ctx);

    const [call] = api.callsTo("/v1/oauth/token");
    expect(call?.url.search).toBe("");
    expect(call?.init?.method).toBe("POST");
    expect(form(call)).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      client_id: "do-client-id",
      client_secret: "do-client-secret",
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    expect(result.accessToken.reveal()).toBe("doo_v1_fixture_access_1");
    expect(result.refreshToken?.reveal()).toBe("dor_v1_fixture_refresh_1");
    expect(result.expiresAt).toEqual(new Date(NOW.getTime() + 30 * DAY_MS));
    expect(result.metadata).toEqual({ teamUuid: TEAM });
    expect(JSON.stringify(result)).not.toContain("sammy");
    // The documentation's grant says `read`, the legacy read-only scope, which covers all five.
    expect(result.scopes).toEqual(["read"]);
    expect(digitaloceanAdapter.detectMissingPermissions(result)).toEqual([]);
    expect(api.callsTo("/v2/account")).toHaveLength(0);
  });

  it("reads the team from /v2/account when the token response does not name it", async () => {
    const { info: _info, ...withoutInfo } = tokenFixture;
    const api = fakeDigitalOcean({ "/v1/oauth/token": () => Response.json(withoutInfo) });
    const result = await digitaloceanAdapter.exchangeCode(input, makeCtx(api.fetch).ctx);
    expect(result.metadata).toEqual({ teamUuid: TEAM });
    const [account] = api.callsTo("/v2/account");
    expect(new Headers(account?.init?.headers).get("authorization")).toBe("Bearer doo_v1_fixture_access_1");
  });

  it("rejects a grant that names no team anywhere as invalid_response", async () => {
    const { info: _info, ...withoutInfo } = tokenFixture;
    const api = fakeDigitalOcean({
      "/v1/oauth/token": () => Response.json(withoutInfo),
      "/v2/account": () => Response.json({ account: { email: "sammy@example.com", uuid: "u" } }),
    });
    await expect(digitaloceanAdapter.exchangeCode(input, makeCtx(api.fetch).ctx)).rejects.toBeInstanceOf(InvalidResponseError);
  });

  it.each([
    ["a token type other than bearer", { ...tokenFixture, token_type: "mac" }],
    ["a team id that could reach a URL path", { ...tokenFixture, info: { team_uuid: "../v2/droplets" } }],
    ["no refresh token", { ...tokenFixture, refresh_token: undefined }],
  ])("rejects %s as invalid_response", async (_title, body) => {
    const api = fakeDigitalOcean({ "/v1/oauth/token": () => Response.json(body) });
    await expect(digitaloceanAdapter.exchangeCode(input, makeCtx(api.fetch).ctx)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("refuses to exchange without the PKCE verifier and never calls DigitalOcean", async () => {
    const api = fakeDigitalOcean();
    const { codeVerifier: _verifier, ...withoutVerifier } = input;
    await expect(digitaloceanAdapter.exchangeCode(withoutVerifier, makeCtx(api.fetch).ctx)).rejects.toThrow(TypeError);
    expect(api.calls).toHaveLength(0);
  });

  it("maps a 400 invalid_grant code to auth revoked and a 400 invalid_client to invalid_response", async () => {
    const grant = fakeDigitalOcean({
      "/v1/oauth/token": () => Response.json({ error: "invalid_grant" }, { status: 400 }),
    });
    await expect(digitaloceanAdapter.exchangeCode(input, makeCtx(grant.fetch).ctx)).rejects.toBeInstanceOf(
      AuthRevokedError,
    );
    const client = fakeDigitalOcean({
      "/v1/oauth/token": () => Response.json({ error: "invalid_client" }, { status: 400 }),
    });
    await expect(digitaloceanAdapter.exchangeCode(input, makeCtx(client.fetch).ctx)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("refreshTokens", () => {
  it("spends the refresh token once and returns the NEW access and refresh token together", async () => {
    const api = fakeDigitalOcean({ "/v1/oauth/token": () => Response.json(tokenRefreshedFixture) });
    const later = new Date(NOW.getTime() + 29 * DAY_MS);
    const refreshed = await digitaloceanAdapter.refreshTokens?.(credential, makeCtx(api.fetch, later).ctx);
    if (refreshed === undefined) throw new Error("digitalocean must refresh tokens");

    expect(api.calls).toHaveLength(1);
    expect(form(api.calls[0])).toEqual({
      grant_type: "refresh_token",
      refresh_token: "dor_v1_fixture_refresh_1",
      client_id: "do-client-id",
      client_secret: "do-client-secret",
    });
    expect(refreshed.accessToken.reveal()).toBe("doo_v1_fixture_access_2");
    expect(refreshed.refreshToken?.reveal()).toBe("dor_v1_fixture_refresh_2");
    expect(refreshed.expiresAt).toEqual(new Date(later.getTime() + 30 * DAY_MS));
    expect(refreshed.metadata).toEqual({ teamUuid: TEAM });
    expect(refreshed.scopes).toEqual([...SCOPES]);
  });

  it.each([
    ["400 invalid_grant (used or expired refresh token)", 400, "invalid_grant"],
    ["401 invalid_grant (revoked grant)", 401, "invalid_grant"],
  ])("maps a %s to auth revoked, so the connection asks to reconnect", async (_title, status, error) => {
    const api = fakeDigitalOcean({
      "/v1/oauth/token": () => Response.json({ error, error_description: "used" }, { status }),
    });
    await expect(digitaloceanAdapter.refreshTokens?.(credential, makeCtx(api.fetch).ctx)).rejects.toBeInstanceOf(
      AuthRevokedError,
    );
  });

  // Bodies from the OAuth troubleshooting page (docs.digitalocean.com/support/im-getting-an-error-
  // when-using-the-digitalocean-oauth-api., checked 2026-11-05): instance configuration, not the grant.
  it.each([
    ["400 invalid_client (wrong client id or secret)", 400, { error: "invalid_client", error_description: "Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method." }],
    ["401 invalid_client (wrong client id or secret)", 401, { error: "invalid_client", error_description: "Client authentication failed due to unknown client, no client authentication included, or unsupported authentication method." }],
    ["400 invalid_request (malformed request)", 400, { error: "invalid_request", error_description: "The request is missing a required parameter, includes an unsupported parameter value, or is otherwise malformed." }],
    ["400 without an OAuth error body", 400, { message: "bad request" }],
  ])("keeps a %s as invalid_response, not auth revoked", async (_title, status, body) => {
    const api = fakeDigitalOcean({ "/v1/oauth/token": () => Response.json(body, { status }) });
    await expect(digitaloceanAdapter.refreshTokens?.(credential, makeCtx(api.fetch).ctx)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects a refresh answered without a new refresh token as invalid_response", async () => {
    const { refresh_token: _spent, ...withoutRefresh } = tokenRefreshedFixture;
    const api = fakeDigitalOcean({ "/v1/oauth/token": () => Response.json(withoutRefresh) });
    await expect(digitaloceanAdapter.refreshTokens?.(credential, makeCtx(api.fetch).ctx)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects a refresh answered for a different team as invalid_response", async () => {
    const otherTeam = { ...tokenRefreshedFixture, info: { ...tokenRefreshedFixture.info, team_uuid: "22222222-0000-4000-8000-000000000000" } };
    const api = fakeDigitalOcean({ "/v1/oauth/token": () => Response.json(otherTeam) });
    await expect(digitaloceanAdapter.refreshTokens?.(credential, makeCtx(api.fetch).ctx)).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });

  it("asks to reconnect without calling DigitalOcean when there is no refresh token", async () => {
    const api = fakeDigitalOcean();
    const { refreshToken: _none, ...accessOnly } = credential;
    await expect(digitaloceanAdapter.refreshTokens?.(accessOnly, makeCtx(api.fetch).ctx)).rejects.toBeInstanceOf(
      AuthRevokedError,
    );
    expect(api.calls).toHaveLength(0);
  });
});

describe("revoke", () => {
  it("revokes the access token with a bearer header and the token in the body", async () => {
    const api = fakeDigitalOcean();
    await digitaloceanAdapter.revoke?.(credential, makeCtx(api.fetch).ctx);
    const [call] = api.callsTo("/v1/oauth/revoke");
    expect(new Headers(call?.init?.headers).get("authorization")).toBe("Bearer doo_v1_fixture_access_1");
    expect(form(call)).toEqual({ token: "doo_v1_fixture_access_1" });
  });

  it("reports a rejected revoke instead of claiming success", async () => {
    const api = fakeDigitalOcean({ "/v1/oauth/revoke": () => new Response(null, { status: 401 }) });
    await expect(digitaloceanAdapter.revoke?.(credential, makeCtx(api.fetch).ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });
});

describe("listAccounts", () => {
  it("returns the one team the grant covers, named, and nothing personal", async () => {
    const api = fakeDigitalOcean();
    const accounts = await digitaloceanAdapter.listAccounts(credential, makeCtx(api.fetch).ctx);
    expect(accounts).toEqual([{ externalId: TEAM, displayName: "My Team", kind: "team" }]);
  });

  it.each([
    ["no team in the account", { account: { email: "sammy@example.com" } }],
    ["a blank team name", { account: { team: { uuid: TEAM, name: "  " } } }],
  ])("falls back to a generic name for %s", async (_title, body) => {
    const api = fakeDigitalOcean({ "/v2/account": () => Response.json(body) });
    const accounts = await digitaloceanAdapter.listAccounts(credential, makeCtx(api.fetch).ctx);
    expect(accounts).toEqual([{ externalId: TEAM, displayName: "DigitalOcean team", kind: "team" }]);
  });

  it("rejects an account whose team is not the grant's team", async () => {
    const api = fakeDigitalOcean({
      "/v2/account": () => Response.json({ account: { team: { uuid: "22222222-0000-4000-8000-000000000000", name: "Other" } } }),
    });
    await expect(digitaloceanAdapter.listAccounts(credential, makeCtx(api.fetch).ctx)).rejects.toBeInstanceOf(
      InvalidResponseError,
    );
  });

  it("asks to reconnect when the credential lost its team", async () => {
    const api = fakeDigitalOcean();
    await expect(
      digitaloceanAdapter.listAccounts({ ...credential, metadata: {} }, makeCtx(api.fetch).ctx),
    ).rejects.toBeInstanceOf(AuthRevokedError);
    expect(api.calls).toHaveLength(0);
  });
});

describe("detectMissingPermissions", () => {
  it.each([
    ["every requested scope", [...SCOPES], []],
    ["the api:read alias", ["api:read"], []],
    ["the legacy read scope", ["read"], []],
    ["no scopes", [], [...SCOPES]],
    ["all but app:read", SCOPES.filter((scope) => scope !== "app:read"), ["app:read"]],
  ])("with %s", (_title, scopes, missing) => {
    expect(digitaloceanAdapter.detectMissingPermissions({ scopes })).toEqual(missing);
  });
});

describe("sync", () => {
  it("reads spend, invoices, daily SKU spend, Droplet actions, and deployments on a first sync", async () => {
    const api = fakeDigitalOcean();
    const result = await digitaloceanAdapter.sync(syncInput, makeCtx(api.fetch).ctx);
    expectValid(result);
    expect(result.partialErrors).toBeUndefined();

    expect(metric(result.metrics, MONTH_TO_DATE_METRIC_KEY)).toMatchObject({
      kind: "verified_spend",
      amountMinor: 1121,
      currency: "USD",
      timeframe: { type: "period", start: new Date("2026-11-01T00:00:00Z"), end: new Date("2026-11-06T00:00:00Z") },
    });
    // account_balance "12.23" is owed, so the credit is negative.
    expect(metric(result.metrics, CREDIT_BALANCE_METRIC_KEY)).toMatchObject({
      kind: "credit_balance",
      amountMinor: -1223,
      timeframe: { type: "point", at: new Date("2026-11-05T09:01:12Z") },
    });
    expect(metric(result.metrics, LATEST_INVOICE_METRIC_KEY)).toMatchObject({
      kind: "verified_spend",
      amountMinor: 5813,
      timeframe: { type: "period", start: new Date("2026-10-01T00:00:00Z"), end: new Date("2026-11-01T00:00:00Z") },
    });
    // The latest day only (2026-11-04); 0.86 + 0.425 is summed exactly, then rounded half to even
    // once, and the other team's point is skipped.
    const daily = result.metrics.filter((item) => item.metricKey.startsWith("digitalocean.daily_spend."));
    expect(daily.map((item) => [item.metricKey, item.kind, "amountMinor" in item ? item.amountMinor : null])).toEqual([
      ["digitalocean.daily_spend.sku_1_ks_k8swn_00109", "estimated_spend", 257],
      ["digitalocean.daily_spend.sku_1_do_drop_0109", "estimated_spend", 128],
    ]);
    expect(daily[0]?.timeframe).toEqual({
      type: "period",
      start: new Date("2026-11-04T00:00:00Z"),
      end: new Date("2026-11-05T00:00:00Z"),
    });
    expect(daily[0]?.provenance.source).toBe("derived");
    const [insights] = api.calls.filter((call) => call.url.pathname.startsWith("/v2/billing/"));
    expect(insights?.url.pathname).toBe(`/v2/billing/do:team:${TEAM}/insights/2026-11-02/2026-11-04`);

    // First sync: only the latest invoice, with its products ranked by amount.
    const invoices = result.events.filter((event) => event.typeId === "digitalocean.invoice.issued");
    expect(invoices).toEqual([
      {
        typeId: "digitalocean.invoice.issued",
        occurredAt: new Date("2026-11-01T00:00:00Z"),
        severity: "info",
        title: "Invoice for 2026-10 issued: $58.13",
        body: "Spaces Subscription $34.45, Kubernetes Clusters $12.34, Droplets $11.34.",
        externalAccountId: TEAM,
        dedupeKey: `invoice:${INVOICE_UUID}`,
      },
    ]);

    // Droplet actions in the last 7 days, named from the Droplet list; a deleted Droplet keeps its
    // id, in-progress and non-Droplet actions are skipped.
    expect(titles(result.events, "digitalocean.droplet.")).toEqual([
      "Droplet 3164499 deleted",
      "Droplet example.com created",
      "Droplet example.com resize failed",
      "Droplet worker power cycled",
    ]);
    const failed = result.events.find((event) => event.typeId === "digitalocean.droplet.action_failed");
    expect(failed).toMatchObject({ severity: "critical", occurredAt: new Date("2026-11-04T16:31:06Z"), body: "Region nyc3." });

    // Deployments of the recently deployed app only; the October one is outside the window.
    expect(api.callsTo(`/v2/apps/c2a93513-8d9b-4223-9d61-5e7272c81cf5/deployments`)).toHaveLength(0);
    const deployments = result.events.filter((event) => event.typeId.startsWith("digitalocean.deployment."));
    expect(deployments.map((event) => [event.dedupeKey, event.occurredAt.toISOString()]).sort()).toEqual(
      [
        ["deployment:3aa4d20e-5527-4c00-b496-601fbd22520a:started", "2026-11-05T09:10:00.000Z"],
        ["deployment:3aa4d20e-5527-4c00-b496-601fbd22520a:succeeded", "2026-11-05T09:14:00.000Z"],
        ["deployment:7c1d2e3f-0000-4000-8000-000000000001:started", "2026-11-04T11:00:00.000Z"],
        ["deployment:7c1d2e3f-0000-4000-8000-000000000002:started", "2026-11-04T12:00:00.000Z"],
        ["deployment:7c1d2e3f-0000-4000-8000-000000000002:succeeded", "2026-11-04T12:05:00.000Z"],
        // The zero phase time falls back to updated_at.
        ["deployment:7c1d2e3f-0000-4000-8000-000000000003:failed", "2026-11-04T18:03:00.000Z"],
        ["deployment:7c1d2e3f-0000-4000-8000-000000000003:started", "2026-11-04T18:00:00.000Z"],
        ["deployment:b6bdf840-2854-4f87-a36c-5f231c617c84:started", "2026-11-05T10:30:00.000Z"],
      ].sort(),
    );
    expect(titles(result.events, "digitalocean.deployment.failed")).toEqual(["Deployment of sample-php failed"]);
    // Nothing from the app spec or the deployment cause reaches an event.
    expect(JSON.stringify(result)).not.toMatch(/internal\.example|9a4df0b|sammy/);

    expect(JSON.parse(result.cursor ?? "")).toEqual({
      v: 1,
      actions: Date.parse("2026-11-05T11:40:00Z"),
      deployments: Date.parse("2026-11-05T10:30:00Z"),
      invoice: "2026-10",
    });
    // GET only, apart from nothing: sync never writes.
    expect(api.calls.every((call) => call.init?.method === "GET")).toBe(true);
  });

  it("counts DigitalOcean spend once on the dashboard: month to date, not the last invoice nor the daily SKU estimates", async () => {
    const result = await digitaloceanAdapter.sync(syncInput, makeCtx(fakeDigitalOcean().fetch).ctx);
    // Three readings of the same team's spend: this month so far, October's invoice, and what each
    // SKU cost on the latest day, estimated.
    const money = result.metrics.filter((item) => item.kind === "verified_spend" || item.kind === "estimated_spend");
    expect(Object.fromEntries(money.map((item) => [item.metricKey, [item.kind, "amountMinor" in item ? item.amountMinor : null]]))).toEqual({
      [MONTH_TO_DATE_METRIC_KEY]: ["verified_spend", 1121],
      [LATEST_INVOICE_METRIC_KEY]: ["verified_spend", 5813],
      "digitalocean.daily_spend.sku_1_ks_k8swn_00109": ["estimated_spend", 257],
      "digitalocean.daily_spend.sku_1_do_drop_0109": ["estimated_spend", 128],
    });
    // balance.json's month_to_date_usage "11.21" is 1121 cents. The invoice (5813) bills a closed
    // month and the SKU estimates (257 + 128) a closed day, so neither is spend this month on top.
    const MONTH_TO_DATE_MINOR = 1121;
    const once = [{ currency: "USD", verifiedMinor: MONTH_TO_DATE_MINOR, estimatedMinor: null }];
    expect(dashboardSpendAfterSync(digitaloceanAdapter, result.metrics, NOW)).toEqual({ provider: once, totals: once });
  });

  it("announces only invoices newer than the cursor and reads events from an hour before it", async () => {
    const api = fakeDigitalOcean();
    const cursor = JSON.stringify({
      v: 1,
      actions: Date.parse("2026-11-05T10:30:00Z"),
      deployments: Date.parse("2026-11-05T10:00:00Z"),
      invoice: "2026-10",
    });
    const result = await digitaloceanAdapter.sync({ ...syncInput, cursor }, makeCtx(api.fetch).ctx);
    expectValid(result);
    expect(result.events.filter((event) => event.typeId === "digitalocean.invoice.issued")).toEqual([]);
    expect(api.callsTo(`/v2/customers/my/invoices/${INVOICE_UUID}`)).toHaveLength(0);
    // Since 09:30: the 10:00 delete only (the 09:30 volume attach is not a Droplet action).
    expect(titles(result.events, "digitalocean.droplet.")).toEqual(["Droplet 3164499 deleted"]);
    // Since 09:00: the 09:10 and 10:30 deployments.
    expect(titles(result.events, "digitalocean.deployment.")).toEqual([
      "Deployment of sample-php started",
      "Deployment of sample-php started",
      "Deployment of sample-php succeeded",
    ]);
  });

  describe("new invoice cap", () => {
    // Invoices for 2026-10 back to 2026-(10 - count + 1), each with its own items route.
    function monthlyInvoices(count: number) {
      const invoices = Array.from({ length: count }, (_, index) => ({
        invoice_uuid: `00000000-0000-4000-8000-00000000000${index}`,
        invoice_id: `1000000${index}`,
        amount: "10.00",
        invoice_period: `2026-${String(10 - index).padStart(2, "0")}`,
      }));
      const routes: Record<string, Route> = {
        "/v2/customers/my/invoices": () => Response.json({ ...invoicesFixture, invoices }),
      };
      for (const invoice of invoices) {
        routes[`/v2/customers/my/invoices/${invoice.invoice_uuid}`] = () => Response.json(invoiceItemsFixture);
      }
      return fakeDigitalOcean(routes);
    }
    const cursor = JSON.stringify({ v: 1, invoice: "2026-04" });
    // An invoice event is dated the 1st of the month after its billing period.
    const issuedAt = (events: readonly ActivityEvent[]) =>
      events
        .filter((event) => event.typeId === "digitalocean.invoice.issued")
        .map((event) => event.occurredAt.toISOString());
    const newestThree = ["2026-11-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z"];

    it("announces the newest three, logs the older ones it skips, and moves the cursor past them", async () => {
      const api = monthlyInvoices(MAX_NEW_INVOICES + 2);
      const { ctx, logger } = makeCtx(api.fetch);
      const result = await digitaloceanAdapter.sync({ ...syncInput, cursor }, ctx);
      expectValid(result);
      expect(issuedAt(result.events)).toEqual(newestThree);
      expect(logger.warn).toHaveBeenCalledWith("digitalocean.invoices.new_cap_reached", {
        skipped: 2,
        maxNewInvoices: MAX_NEW_INVOICES,
      });
      expect(JSON.parse(result.cursor ?? "").invoice).toBe("2026-10");
    });

    it("logs nothing when exactly the cap of invoices is new", async () => {
      const api = monthlyInvoices(MAX_NEW_INVOICES);
      const { ctx, logger } = makeCtx(api.fetch);
      const result = await digitaloceanAdapter.sync({ ...syncInput, cursor }, ctx);
      expectValid(result);
      expect(issuedAt(result.events)).toEqual(newestThree);
      expect(logger.warn).not.toHaveBeenCalledWith("digitalocean.invoices.new_cap_reached", expect.anything());
    });
  });

  it("keeps syncing the rest when billing is refused, and keeps the invoice cursor", async () => {
    const api = fakeDigitalOcean({
      "/v2/customers/my/balance": forbidden,
      "/v2/customers/my/invoices": forbidden,
      [`/v2/billing/do:team:${TEAM}/insights/2026-11-02/2026-11-04`]: forbidden,
    });
    const cursor = JSON.stringify({ v: 1, invoice: "2026-09" });
    const result = await digitaloceanAdapter.sync({ ...syncInput, cursor }, makeCtx(api.fetch).ctx);
    expectValid(result);
    expect(result.metrics).toEqual([]);
    expect(result.partialErrors?.map((error) => [error.code, error.missingScopes])).toEqual([
      ["permission_missing", ["billing:read"]],
      ["permission_missing", ["billing:read"]],
      ["permission_missing", ["billing:read"]],
    ]);
    expect(result.events.some((event) => event.typeId.startsWith("digitalocean.deployment."))).toBe(true);
    expect(JSON.parse(result.cursor ?? "").invoice).toBe("2026-09");
  });

  it("names Droplets by id when the Droplet list is refused, and reports droplet:read", async () => {
    const api = fakeDigitalOcean({ "/v2/droplets": forbidden });
    const result = await digitaloceanAdapter.sync(syncInput, makeCtx(api.fetch).ctx);
    expectValid(result);
    expect(titles(result.events, "digitalocean.droplet.")).toEqual([
      "Droplet 3164444 created",
      "Droplet 3164444 resize failed",
      "Droplet 3164445 power cycled",
      "Droplet 3164499 deleted",
    ]);
    expect(result.partialErrors?.flatMap((error) => error.missingScopes)).toEqual(["droplet:read"]);
  });

  it("reports actions:read and app:read gaps and keeps those cursors where they were", async () => {
    const api = fakeDigitalOcean({ "/v2/actions": forbidden, "/v2/apps": forbidden });
    const cursor = JSON.stringify({ v: 1, actions: 1, deployments: 2, invoice: "2026-10" });
    const result = await digitaloceanAdapter.sync({ ...syncInput, cursor }, makeCtx(api.fetch).ctx);
    expectValid(result);
    expect(result.partialErrors?.flatMap((error) => error.missingScopes)).toEqual(["actions:read", "app:read"]);
    expect(JSON.parse(result.cursor ?? "")).toMatchObject({ actions: 1, deployments: 2 });
  });

  it("treats missing Billing Insights (404) as a gap, not a failed sync", async () => {
    const api = fakeDigitalOcean({
      [`/v2/billing/do:team:${TEAM}/insights/2026-11-02/2026-11-04`]: () => Response.json({ id: "not_found" }, { status: 404 }),
    });
    const result = await digitaloceanAdapter.sync(syncInput, makeCtx(api.fetch).ctx);
    expectValid(result);
    expect(result.metrics.some((item) => item.metricKey.startsWith("digitalocean.daily_spend."))).toBe(false);
    expect(result.partialErrors).toHaveLength(1);
    expect(result.partialErrors?.[0]).toBeInstanceOf(PermissionMissingError);
    expect(result.partialErrors?.[0]?.missingScopes).toEqual([]);
  });

  it("fails the whole sync as auth revoked when the token is rejected", async () => {
    const api = fakeDigitalOcean({ "/v2/customers/my/balance": () => new Response(null, { status: 401 }) });
    await expect(digitaloceanAdapter.sync(syncInput, makeCtx(api.fetch).ctx)).rejects.toBeInstanceOf(AuthRevokedError);
  });

  it("refuses an external account the grant does not cover, before any request", async () => {
    const api = fakeDigitalOcean();
    await expect(
      digitaloceanAdapter.sync({ credential, externalAccountId: "22222222-0000-4000-8000-000000000000" }, makeCtx(api.fetch).ctx),
    ).rejects.toThrow(/does not cover/);
    expect(api.calls).toHaveLength(0);
  });

  it("starts over with a warning when the cursor is unreadable", async () => {
    const api = fakeDigitalOcean();
    const { ctx, logger } = makeCtx(api.fetch);
    const result = await digitaloceanAdapter.sync({ ...syncInput, cursor: "{not json" }, ctx);
    expect(logger.warn).toHaveBeenCalledWith("digitalocean.sync.cursor_unreadable", { provider: "digitalocean" });
    expect(result.events.filter((event) => event.typeId === "digitalocean.invoice.issued")).toHaveLength(1);
  });

  it("rejects negative month-to-date usage as invalid_response", async () => {
    const api = fakeDigitalOcean({
      "/v2/customers/my/balance": () => Response.json({ ...balanceFixture, month_to_date_usage: "-0.01" }),
    });
    await expect(digitaloceanAdapter.sync(syncInput, makeCtx(api.fetch).ctx)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("dates last month's balance to last month when it has not been regenerated yet", async () => {
    const api = fakeDigitalOcean({
      "/v2/customers/my/balance": () => Response.json({ ...balanceFixture, generated_at: "2026-10-31T23:50:00Z" }),
    });
    const result = await digitaloceanAdapter.sync(syncInput, makeCtx(api.fetch).ctx);
    expect(metric(result.metrics, MONTH_TO_DATE_METRIC_KEY).timeframe).toEqual({
      type: "period",
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-11-01T00:00:00Z"),
    });
  });

  it("keeps the largest SKUs up to the cap and skips a SKU that nets below zero", async () => {
    const points = Array.from({ length: MAX_SKU_METRICS + 5 }, (_, index) => ({
      usage_team_urn: `do:team:${TEAM}`,
      start_date: "2026-11-04",
      total_amount: `${index + 1}.00`,
      sku: `SKU-${index}`,
    }));
    points.push({ usage_team_urn: `do:team:${TEAM}`, start_date: "2026-11-04", total_amount: "-3.00", sku: "CREDIT-1" });
    const api = fakeDigitalOcean({
      [`/v2/billing/do:team:${TEAM}/insights/2026-11-02/2026-11-04`]: () =>
        Response.json({ data_points: points, total_items: points.length, total_pages: 1, current_page: 1 }),
    });
    const { ctx, logger } = makeCtx(api.fetch);
    const result = await digitaloceanAdapter.sync(syncInput, ctx);
    expectValid(result);
    const daily = result.metrics.filter((item) => item.metricKey.startsWith("digitalocean.daily_spend."));
    expect(daily).toHaveLength(MAX_SKU_METRICS);
    expect(daily[0]?.metricKey).toBe(`digitalocean.daily_spend.sku_sku_${MAX_SKU_METRICS + 4}`);
    expect(daily.some((item) => item.metricKey.includes("credit"))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith("digitalocean.insights.skus_skipped", expect.objectContaining({ kept: MAX_SKU_METRICS }));
  });

  it("stops reading actions at the page cap and says so", async () => {
    const recent = (page: number) => ({
      actions: Array.from({ length: 2 }, (_, index) => ({
        id: page * 10 + index,
        status: "completed",
        type: "power_cycle",
        started_at: "2026-11-05T11:00:00Z",
        completed_at: "2026-11-05T11:00:30Z",
        resource_id: 3164444,
        resource_type: "droplet",
        region_slug: "nyc3",
      })),
      links: { pages: { next: `https://api.digitalocean.com/v2/actions?page=${page + 1}` } },
    });
    const api = fakeDigitalOcean({ "/v2/actions": (url) => Response.json(recent(Number(url.searchParams.get("page")))) });
    const { ctx, logger } = makeCtx(api.fetch);
    const result = await digitaloceanAdapter.sync(syncInput, ctx);
    expect(api.callsTo("/v2/actions")).toHaveLength(MAX_PAGES);
    expect(api.callsTo("/v2/actions").map((call) => call.url.searchParams.get("per_page"))).toEqual(Array(MAX_PAGES).fill("200"));
    expect(logger.warn).toHaveBeenCalledWith("digitalocean.actions.page_cap_reached", { pages: MAX_PAGES });
    expect(titles(result.events, "digitalocean.droplet.")).toHaveLength(MAX_PAGES * 2);
  });
});
