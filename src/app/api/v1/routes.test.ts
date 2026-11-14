import { notFound } from "next/navigation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";
import { API_ENDPOINTS } from "@/lib/api/endpoints";
import { generateApiKey } from "@/lib/api/keys";
import { ErrorResponseSchema, listResponseSchema } from "@/lib/api/schemas";
import { API_KEY_SCOPES, type ApiKeyScope } from "@/lib/api/scopes";
import { decodeCursor, encodeCursor } from "@/lib/data/cursor";
import { REFERENCE_ID_PATTERN } from "@/lib/log/reference";

import { GET as getConnections } from "./connections/route";
import { GET as getEvents } from "./events/route";
import { GET as getProjects } from "./projects/route";
import { GET as getTriggeredAlerts } from "./triggered-alerts/route";
import { GET as getUsageSnapshots } from "./usage-snapshots/route";
import { GET as getWorkspaces } from "./workspaces/route";

/*
 * Scope enforcement and the error contract for every /api/v1 route (#162), through the real route
 * handlers with the database calls replaced: `authenticate_api_key` answers as the key setup asks,
 * and each `api_*` read function returns sample rows. Isolation between workspaces is proven in
 * the database itself, by supabase/tests/database/13_api_keys.test.sql.
 */

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));

const ORIGIN = "http://localhost:3000";
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const CONNECTION_ID = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";
const AT = "2026-11-04T09:15:00.123456+00:00";
const RESETS = "2026-11-05T00:01:00+00:00";

type AuthSetup =
  | { status: "valid"; scopes: readonly ApiKeyScope[]; requestCount?: number }
  | { status: "revoked" | "creator_left" }
  | { status: "unknown" };

// One sample row per read function, shaped like the function's result.
const SAMPLE_ROWS: Record<string, Record<string, unknown>> = {
  api_workspaces: { id: WORKSPACE_ID, slug: "acmeseedws", name: "Acme", is_personal: false, created_at: AT },
  api_projects: { id: PROJECT_ID, name: "Acme web", created_at: AT },
  api_connections: {
    id: CONNECTION_ID,
    provider: "vercel",
    display_name: "Vercel",
    authorized_account_label: null,
    status: "active",
    last_synced_at: AT,
    granted_scopes: [SIMULATED_SCOPE],
    created_at: AT,
  },
  api_usage_snapshots: {
    id: "66666666-6666-4666-8666-666666666666",
    connection_id: CONNECTION_ID,
    provider: "vercel",
    granted_scopes: ["read"],
    external_account_id: ACCOUNT_ID,
    account_name: "Acme team",
    project_id: null,
    metric_key: "vercel.spend.estimated",
    kind: "estimated_spend",
    label: "Estimated spend",
    snapshot_date: "2026-11-04",
    value: null,
    unit: null,
    amount_minor: 1234,
    currency: "USD",
    period_start: "2026-11-01T00:00:00+00:00",
    period_end: "2026-12-01T00:00:00+00:00",
    point_at: null,
    resets_at: null,
    retrieved_at: AT,
    provenance_source: "derived",
    pricing_source: "https://vercel.com/pricing",
  },
  api_activity_events: {
    id: "77777777-7777-4777-8777-777777777777",
    type_id: "stackdash.daily_summary",
    severity: "info",
    title: "Daily summary",
    body: null,
    url: null,
    occurred_at: AT,
    provider: null,
    connection_id: null,
    granted_scopes: [],
    external_account_id: null,
    account_name: null,
  },
  api_triggered_alerts: {
    id: "88888888-8888-4888-8888-888888888888",
    rule_id: "99999999-9999-4999-8999-999999999999",
    cycle_key: "2026-11-01",
    triggered_at: AT,
    observed_value: 95,
    observed_amount_minor: null,
    currency: null,
    threshold_label: "90%",
    threshold_percent: 90,
    is_estimated: false,
    message: "Build minutes passed 90% of the allowance.",
    acknowledged_at: null,
  },
};

const ROUTES = [
  { name: "workspaces", get: getWorkspaces, endpoint: API_ENDPOINTS.workspaces, fn: "api_workspaces" },
  { name: "projects", get: getProjects, endpoint: API_ENDPOINTS.projects, fn: "api_projects" },
  { name: "connections", get: getConnections, endpoint: API_ENDPOINTS.connections, fn: "api_connections" },
  { name: "usage-snapshots", get: getUsageSnapshots, endpoint: API_ENDPOINTS.usageSnapshots, fn: "api_usage_snapshots" },
  { name: "events", get: getEvents, endpoint: API_ENDPOINTS.events, fn: "api_activity_events" },
  { name: "triggered-alerts", get: getTriggeredAlerts, endpoint: API_ENDPOINTS.triggeredAlerts, fn: "api_triggered_alerts" },
] as const;

const SCOPED_ROUTES = ROUTES.flatMap((route) => (route.endpoint.scope === null ? [] : [{ ...route, scope: route.endpoint.scope }]));
const OPEN_ROUTES = ROUTES.filter((route) => route.endpoint.scope === null);

let auth: AuthSetup;
let readRows: Record<string, unknown>[] | null;
let readError: { message: string } | null;
let logged: string;

function setUp(setup: AuthSetup, rows: Record<string, unknown>[] | null = null) {
  auth = setup;
  readRows = rows;
}

beforeEach(() => {
  auth = { status: "valid", scopes: API_KEY_SCOPES };
  readRows = null;
  readError = null;
  logged = "";
  rpc.mockReset();
  rpc.mockImplementation((fn: string) => {
    if (fn === "authenticate_api_key") {
      if (auth.status === "unknown") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({
        data: [
          {
            status: auth.status,
            key_id: KEY_ID,
            workspace_id: WORKSPACE_ID,
            scopes: auth.status === "valid" ? auth.scopes : API_KEY_SCOPES,
            request_count: auth.status === "valid" ? (auth.requestCount ?? 1) : 0,
            window_resets_at: RESETS,
          },
        ],
        error: null,
      });
    }
    if (readError !== null) return Promise.resolve({ data: null, error: readError });
    const sample = SAMPLE_ROWS[fn];
    return Promise.resolve({ data: readRows ?? (sample === undefined ? [] : [sample]), error: null });
  });
  // Capture log lines so tests can prove the key never reaches them.
  const capture = (chunk: string | Uint8Array) => {
    logged += String(chunk);
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(capture);
  vi.spyOn(process.stderr, "write").mockImplementation(capture);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function request(path: string, key: string | null, header?: string): Request {
  const headers = new Headers();
  if (header !== undefined) headers.set("authorization", header);
  else if (key !== null) headers.set("authorization", `Bearer ${key}`);
  return new Request(new URL(path, ORIGIN), { headers });
}

function readCalls(): unknown[][] {
  return rpc.mock.calls.filter(([fn]) => fn !== "authenticate_api_key");
}

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const body = ErrorResponseSchema.strict().parse(await response.json());
  expect(body.error.code).toBe(code);
  expect(body.error.reference_id).toMatch(REFERENCE_ID_PATTERN);
  // The reference id is in the log too, so support can find the details.
  expect(logged).toContain(body.error.reference_id);
  return body;
}

describe.each(SCOPED_ROUTES)("GET /api/v1/$name scope enforcement", ({ get, endpoint, fn, scope }) => {
  it(`answers 200 to a key with only the ${scope} scope`, async () => {
    const { key, tokenHash } = generateApiKey();
    setUp({ status: "valid", scopes: [scope] });
    const response = await get(request(endpoint.path, key));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-ratelimit-limit")).toBe("120");
    expect(response.headers.get("x-ratelimit-remaining")).toBe("119");
    listResponseSchema(endpoint.item).strict().parse(await response.json());
    expect(readCalls()).toEqual([[fn, expect.objectContaining({ p_token_hash: tokenHash })]]);
  });

  it(`answers 403 to a key with every scope except ${scope}, without reading any data`, async () => {
    const { key } = generateApiKey();
    setUp({ status: "valid", scopes: API_KEY_SCOPES.filter((other) => other !== scope) });
    const response = await get(request(endpoint.path, key));
    const body = await expectError(response, 403, "forbidden");
    expect(body.error.message).toContain(scope);
    expect(readCalls()).toEqual([]);
  });
});

describe.each(OPEN_ROUTES)("GET /api/v1/$name scope enforcement", ({ get, endpoint, fn }) => {
  it.each(API_KEY_SCOPES)("answers 200 to a key whose only scope is %s", async (scope) => {
    const { key, tokenHash } = generateApiKey();
    setUp({ status: "valid", scopes: [scope] });
    const response = await get(request(endpoint.path, key));
    expect(response.status).toBe(200);
    listResponseSchema(endpoint.item).strict().parse(await response.json());
    expect(readCalls()).toEqual([[fn, expect.objectContaining({ p_token_hash: tokenHash })]]);
  });
});

describe.each(ROUTES)("GET /api/v1/$name authentication", ({ get, endpoint }) => {
  it("answers 401 with a reference id and no internals to a revoked key", async () => {
    const { key } = generateApiKey();
    setUp({ status: "revoked" });
    const response = await get(request(endpoint.path, key));
    const body = await expectError(response, 401, "unauthorized");
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    // Same words as for an unknown key: nothing says the key exists or was revoked.
    expect(body.error.message).not.toMatch(/revoked|workspace|sql|postgres/i);
    expect(response.headers.get("x-ratelimit-limit")).toBeNull();
    expect(readCalls()).toEqual([]);
    expect(logged).toContain('"reason":"revoked"');
    expect(logged).not.toContain(key);
  });

  it.each<[string, AuthSetup, string | undefined, boolean]>([
    ["no Authorization header", { status: "valid", scopes: API_KEY_SCOPES }, undefined, false],
    ["a header that is not a StackDash key", { status: "valid", scopes: API_KEY_SCOPES }, "Bearer sk_test_abc", false],
    ["a key no row has", { status: "unknown" }, "key", true],
    ["a key whose creator left the workspace", { status: "creator_left" }, "key", true],
  ])("answers 401 to %s", async (_case, setup, header, sendsKey) => {
    const { key } = generateApiKey();
    setUp(setup);
    const response = await get(
      sendsKey ? request(endpoint.path, key) : request(endpoint.path, null, header),
    );
    const body = await expectError(response, 401, "unauthorized");
    expect(body.error.message).toBe("The API key is missing or no longer works. Send a working key as a bearer token.");
    expect(readCalls()).toEqual([]);
    // A malformed header never reaches the database.
    if (!sendsKey) expect(rpc).not.toHaveBeenCalled();
  });

  it("answers 200 on the 120th request of a minute and 429 on the 121st", async () => {
    const { key } = generateApiKey();
    setUp({ status: "valid", scopes: API_KEY_SCOPES, requestCount: 120 });
    const allowed = await get(request(endpoint.path, key));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("x-ratelimit-remaining")).toBe("0");

    rpc.mockClear();
    setUp({ status: "valid", scopes: API_KEY_SCOPES, requestCount: 121 });
    const limited = await get(request(endpoint.path, key));
    await expectError(limited, 429, "rate_limited");
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(readCalls()).toEqual([]);
  });

  it("answers 500 with a reference id and a generic message when the read fails", async () => {
    const { key } = generateApiKey();
    readError = { message: 'relation "public.secret_table" does not exist' };
    const response = await get(request(endpoint.path, key));
    const body = await expectError(response, 500, "internal");
    expect(body.error.message).not.toContain("secret_table");
    expect(logged).toContain("secret_table");
  });

  it("leaves a Next.js control-flow error to Next.js instead of answering 500", async () => {
    // The same path as the prerender stop Next.js throws when a handler reads the request at build.
    const { key } = generateApiKey();
    rpc.mockImplementation(() => notFound());
    await expect(get(request(endpoint.path, key))).rejects.toMatchObject({
      digest: expect.stringContaining("NEXT_HTTP_ERROR_FALLBACK"),
    });
    expect(logged).not.toContain('"referenceId"');
  });

  it("refuses an unknown query parameter with 400", async () => {
    const { key } = generateApiKey();
    const response = await get(request(`${endpoint.path}?workspace_id=${WORKSPACE_ID}`, key));
    const body = await expectError(response, 400, "invalid_request");
    expect(body.error.message).toContain("workspace_id");
    expect(readCalls()).toEqual([]);
  });
});

const PAGED_ROUTES = ROUTES.filter((route) => route.name !== "workspaces");

describe.each(PAGED_ROUTES)("GET /api/v1/$name pagination", ({ get, endpoint, fn }) => {
  it.each([
    ["1", 2],
    ["100", 101],
  ])("accepts limit=%s and asks the database for one row more", async (limit, asked) => {
    const { key } = generateApiKey();
    const response = await get(request(`${endpoint.path}?limit=${limit}`, key));
    expect(response.status).toBe(200);
    expect(readCalls()).toEqual([[fn, expect.objectContaining({ p_limit: asked })]]);
  });

  it.each(["0", "101", "-1", "1.5", "ten", ""])("refuses limit=%s with 400", async (limit) => {
    const { key } = generateApiKey();
    const response = await get(request(`${endpoint.path}?limit=${limit}`, key));
    await expectError(response, 400, "invalid_request");
  });

  it("refuses a repeated parameter with 400", async () => {
    const { key } = generateApiKey();
    const response = await get(request(`${endpoint.path}?limit=1&limit=2`, key));
    const body = await expectError(response, 400, "invalid_request");
    expect(body.error.message).toBe("Pass the limit parameter once.");
  });

  it.each(["not-a-cursor", encodeCursor(["yesterday", PROJECT_ID]), "a".repeat(201)])(
    "refuses a malformed cursor with 400 rather than restarting at page one",
    async (cursor) => {
      const { key } = generateApiKey();
      const response = await get(request(`${endpoint.path}?cursor=${encodeURIComponent(cursor)}`, key));
      await expectError(response, 400, "invalid_request");
      expect(readCalls()).toEqual([]);
    },
  );

  it("returns a next_cursor only when the database had one row more than the page", async () => {
    const { key } = generateApiKey();
    const sample = SAMPLE_ROWS[fn];
    if (sample === undefined) throw new Error(`no sample row for ${fn}`);

    setUp({ status: "valid", scopes: API_KEY_SCOPES }, [sample]);
    const lastPage = await get(request(`${endpoint.path}?limit=1`, key));
    expect(await lastPage.json()).toMatchObject({ next_cursor: null });

    setUp({ status: "valid", scopes: API_KEY_SCOPES }, [sample, { ...sample, id: KEY_ID }]);
    const firstPage = await get(request(`${endpoint.path}?limit=1`, key));
    const body = listResponseSchema(endpoint.item).parse(await firstPage.json());
    expect(body.data).toHaveLength(1);
    expect(body.next_cursor).not.toBeNull();
    const cursor = decodeCursor(body.next_cursor);
    expect(cursor?.[1]).toBe(sample.id);

    rpc.mockClear();
    const next = await get(request(`${endpoint.path}?limit=1&cursor=${body.next_cursor}`, key));
    expect(next.status).toBe(200);
    expect(readCalls()).toEqual([[fn, expect.objectContaining({ p_after_id: sample.id })]]);
  });
});

describe("response fields", () => {
  async function firstItem(get: (request: Request) => Promise<Response>, path: string) {
    const { key } = generateApiKey();
    const response = await get(request(path, key));
    const body = z.object({ data: z.array(z.record(z.string(), z.unknown())) }).parse(await response.json());
    return body.data[0];
  }

  it("labels a derived snapshot estimated, as the dashboard does, with its price list", async () => {
    expect(await firstItem(getUsageSnapshots, "/api/v1/usage-snapshots")).toMatchObject({
      provenance: "estimated",
      pricing_source: "https://vercel.com/pricing",
      amount_minor: 1234,
      currency: "USD",
      date: "2026-11-04",
      simulated: false,
    });
  });

  it("labels a provider reported snapshot verified", async () => {
    setUp({ status: "valid", scopes: API_KEY_SCOPES }, [
      { ...SAMPLE_ROWS.api_usage_snapshots, kind: "verified_spend", provenance_source: "provider_api", pricing_source: null },
    ]);
    expect(await firstItem(getUsageSnapshots, "/api/v1/usage-snapshots")).toMatchObject({ provenance: "verified" });
  });

  it("returns connection status and the simulated flag, never scopes or credentials", async () => {
    const item = await firstItem(getConnections, "/api/v1/connections");
    expect(item).toMatchObject({ status: "active", simulated: true, name: "Vercel" });
    expect(Object.keys(item ?? {}).sort()).toEqual(
      ["account", "created_at", "id", "last_synced_at", "name", "provider", "simulated", "status"].sort(),
    );
  });

  it.each<[number | null, string]>([
    [99, "warning"],
    [100, "critical"],
    [null, "warning"],
  ])("gives an alert whose rule threshold is %s percent the %s severity, as the alerts page does", async (threshold, severity) => {
    setUp({ status: "valid", scopes: API_KEY_SCOPES }, [{ ...SAMPLE_ROWS.api_triggered_alerts, threshold_percent: threshold }]);
    expect(await firstItem(getTriggeredAlerts, "/api/v1/triggered-alerts")).toMatchObject({ severity, provenance: "verified" });
  });

  it("does not mark StackDash's own events without a connection as simulated", async () => {
    expect(await firstItem(getEvents, "/api/v1/events")).toMatchObject({ type: "stackdash.daily_summary", simulated: false });
  });

  it("passes usage and event filters to the database and nothing else", async () => {
    const { key } = generateApiKey();
    await getUsageSnapshots(
      request(
        `/api/v1/usage-snapshots?from=2026-10-01&to=2026-10-31&kind=usage&provider=github&project_id=${PROJECT_ID}`,
        key,
      ),
    );
    await getEvents(request("/api/v1/events?severity=warning&type=vercel.deployment.failed", key));
    expect(readCalls()).toEqual([
      [
        "api_usage_snapshots",
        {
          p_token_hash: expect.any(String),
          p_from: "2026-10-01",
          p_to: "2026-10-31",
          p_kind: "usage",
          p_provider: "github",
          p_project_id: PROJECT_ID,
          p_limit: 51,
        },
      ],
      [
        "api_activity_events",
        { p_token_hash: expect.any(String), p_severity: "warning", p_type_id: "vercel.deployment.failed", p_limit: 51 },
      ],
    ]);
  });

  it.each([
    ["/api/v1/usage-snapshots?from=2026-02-30", "from"],
    ["/api/v1/usage-snapshots?kind=budget", "kind"],
    ["/api/v1/usage-snapshots?connection_id=1%20or%201%3D1", "connection_id"],
    ["/api/v1/events?from=yesterday", "from"],
    ["/api/v1/events?type=Vercel%20Deployment", "type"],
    ["/api/v1/triggered-alerts?acknowledged=maybe", "acknowledged"],
  ])("refuses %s with 400 naming the %s parameter", async (path, parameter) => {
    const { key } = generateApiKey();
    const get = path.startsWith("/api/v1/usage-snapshots")
      ? getUsageSnapshots
      : path.startsWith("/api/v1/events")
        ? getEvents
        : getTriggeredAlerts;
    const response = await get(request(path, key));
    const body = await expectError(response, 400, "invalid_request");
    expect(body.error.message).toContain(parameter);
  });
});
