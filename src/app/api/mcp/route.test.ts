import { readFileSync } from "node:fs";
import path from "node:path";

import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type GetPromptResult,
} from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/lib/api/keys";
import { ErrorResponseSchema } from "@/lib/api/schemas";
import { API_KEY_SCOPES, type ApiKeyScope } from "@/lib/api/scopes";
import { REFERENCE_ID_PATTERN } from "@/lib/log/reference";
import { PROVIDER_DOC_URI_PREFIX, WEEKLY_STACK_REVIEW, WHY_DID_SPEND_CHANGE } from "@/lib/mcp/server";

import { POST } from "./route";

/*
 * The MCP endpoint (#163) driven by the SDK's real Client in process, as the SDK's testing guide
 * does (https://ts.sdk.modelcontextprotocol.io/v2/testing): the client's fetch calls the route's
 * POST, so every request passes the same Origin check, key check, and handler as in production.
 * The database calls are replaced: `authenticate_api_key` answers as each test sets up the key, and
 * the `api_*` read functions return rows shaped like supabase/seed.sql (the workspace Acme, the
 * project Acme web, the Fake provider connection, three metrics, four events), plus two triggered
 * alerts, which the seed does not have. Isolation between workspaces is proven in the database by
 * supabase/tests/database/13_api_keys.test.sql.
 */

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc }) }));

const ORIGIN = "http://localhost:3000";
const ENDPOINT = `${ORIGIN}/api/mcp`;
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "20000000-0000-4000-8000-000000000001";
const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const CONNECTION_ID = "40000000-0000-4000-8000-000000000001";
const ACCOUNT_ID = "50000000-0000-4000-8000-000000000001";
const TODAY = "2026-11-05";
const RETRIEVED = "2026-11-05T09:50:00.000000+00:00";
const RESETS = "2026-11-05T10:01:00+00:00";

const snapshot = (id: string, fields: Record<string, unknown>) => ({
  id,
  connection_id: CONNECTION_ID,
  provider: "fake",
  granted_scopes: ["read"],
  external_account_id: ACCOUNT_ID,
  account_name: "Acme team",
  project_id: PROJECT_ID,
  snapshot_date: TODAY,
  value: null,
  unit: null,
  amount_minor: null,
  currency: null,
  period_start: "2026-11-01T00:00:00+00:00",
  period_end: "2026-12-01T00:00:00+00:00",
  point_at: null,
  resets_at: null,
  retrieved_at: RETRIEVED,
  provenance_source: "provider_api",
  pricing_source: null,
  ...fields,
});

const event = (id: string, fields: Record<string, unknown>) => ({
  id,
  url: null,
  connection_id: CONNECTION_ID,
  provider: "fake",
  granted_scopes: ["read"],
  external_account_id: ACCOUNT_ID,
  account_name: "Acme team",
  ...fields,
});

const SEED_ROWS: Record<string, Record<string, unknown>[]> = {
  api_workspaces: [{ id: WORKSPACE_ID, slug: "acmeseedws", name: "Acme", is_personal: false, created_at: "2026-11-01T09:00:00+00:00" }],
  api_projects: [{ id: PROJECT_ID, name: "Acme web", created_at: "2026-11-01T09:00:00+00:00" }],
  api_connections: [
    {
      id: CONNECTION_ID,
      provider: "fake",
      display_name: "Fake provider",
      authorized_account_label: "acme-team",
      status: "active",
      last_synced_at: RETRIEVED,
      granted_scopes: ["read"],
      created_at: "2026-11-01T09:00:00+00:00",
    },
  ],
  api_usage_snapshots: [
    snapshot("60000000-0000-4000-8000-000000000001", {
      metric_key: "fake.spend",
      kind: "verified_spend",
      label: "Spend this month",
      amount_minor: 1250,
      currency: "USD",
    }),
    snapshot("60000000-0000-4000-8000-000000000004", {
      metric_key: "fake.emails_included",
      kind: "included_allowance",
      label: "Emails included",
      value: 3000,
      unit: "emails",
    }),
    snapshot("60000000-0000-4000-8000-000000000007", {
      metric_key: "fake.emails_sent",
      kind: "usage",
      label: "Emails sent",
      value: 1200,
      unit: "emails",
    }),
  ],
  api_activity_events: [
    event("70000000-0000-4000-8000-000000000001", {
      type_id: "fake.deployment_succeeded",
      severity: "success",
      title: "Deployment succeeded",
      body: "Acme web deployed to production.",
      url: "https://example.com/deployments/1",
      occurred_at: "2026-11-05T08:00:00+00:00",
    }),
    event("70000000-0000-4000-8000-000000000002", {
      type_id: "fake.usage_warning",
      severity: "warning",
      title: "Email usage at 40 percent",
      body: "1,200 of 3,000 included emails sent.",
      occurred_at: "2026-11-05T05:00:00+00:00",
    }),
    event("70000000-0000-4000-8000-000000000004", {
      type_id: "stackdash.daily_summary",
      severity: "info",
      title: "Daily summary",
      body: "Spend so far this month: 10.75 USD.",
      occurred_at: "2026-11-04T10:00:00+00:00",
      connection_id: null,
      provider: null,
      granted_scopes: null,
      external_account_id: null,
      account_name: null,
    }),
    event("70000000-0000-4000-8000-000000000003", {
      type_id: "fake.deployment_failed",
      severity: "critical",
      title: "Deployment failed",
      body: "The build step exited with an error.",
      url: "https://example.com/deployments/0",
      occurred_at: "2026-11-04T07:00:00+00:00",
    }),
  ],
  api_triggered_alerts: [
    {
      id: "80000000-0000-4000-8000-000000000001",
      rule_id: "90000000-0000-4000-8000-000000000001",
      cycle_key: "2026-11-01",
      triggered_at: "2026-11-05T09:00:00+00:00",
      observed_value: null,
      observed_amount_minor: 1250,
      currency: "USD",
      threshold_label: "$10.00",
      threshold_percent: null,
      is_estimated: false,
      message: "Fake provider spend is $12.50 for the billing period starting 2026-11-01, at or above the $10.00 threshold. Only USD amounts are counted.",
      acknowledged_at: null,
    },
    {
      id: "80000000-0000-4000-8000-000000000002",
      rule_id: "90000000-0000-4000-8000-000000000002",
      cycle_key: "2026-11-01",
      triggered_at: "2026-11-04T09:00:00+00:00",
      observed_value: 40,
      observed_amount_minor: null,
      currency: null,
      threshold_label: "40%",
      threshold_percent: 40,
      is_estimated: false,
      message: "Fake provider emails sent is at 40% of the allowance (1,200 emails of 3,000 emails).",
      acknowledged_at: "2026-11-04T12:00:00+00:00",
    },
  ],
};

const TOOLS = {
  list_projects: { scope: null, fn: "api_projects" },
  get_usage: { scope: "usage:read", fn: "api_usage_snapshots" },
  list_events: { scope: "events:read", fn: "api_activity_events" },
  list_alerts: { scope: "alerts:read", fn: "api_triggered_alerts" },
  get_connection_status: { scope: "connections:read", fn: "api_connections" },
} as const satisfies Record<string, { scope: ApiKeyScope | null; fn: string }>;

const SCOPED_TOOLS = Object.entries(TOOLS).flatMap(([name, tool]) =>
  tool.scope === null ? [] : [{ name, scope: tool.scope, fn: tool.fn }],
);

type KeySetup =
  | { status: "valid"; scopes: readonly ApiKeyScope[]; requestCount?: number }
  | { status: "revoked" }
  | { status: "unknown" };

let keySetup: KeySetup;
let readError: { message: string } | null;
let logged: string;
const clients: Client[] = [];

beforeEach(() => {
  keySetup = { status: "valid", scopes: API_KEY_SCOPES };
  readError = null;
  logged = "";
  rpc.mockReset();
  rpc.mockImplementation((fn: string) => {
    if (fn === "authenticate_api_key") {
      if (keySetup.status === "unknown") return Promise.resolve({ data: [], error: null });
      return Promise.resolve({
        data: [
          {
            status: keySetup.status,
            key_id: KEY_ID,
            workspace_id: WORKSPACE_ID,
            scopes: keySetup.status === "valid" ? keySetup.scopes : API_KEY_SCOPES,
            request_count: keySetup.status === "valid" ? (keySetup.requestCount ?? 1) : 0,
            window_resets_at: RESETS,
          },
        ],
        error: null,
      });
    }
    if (readError !== null) return Promise.resolve({ data: null, error: readError });
    return Promise.resolve({ data: SEED_ROWS[fn] ?? [], error: null });
  });
  const capture = (chunk: string | Uint8Array) => {
    logged += String(chunk);
    return true;
  };
  vi.spyOn(process.stdout, "write").mockImplementation(capture);
  vi.spyOn(process.stderr, "write").mockImplementation(capture);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  vi.restoreAllMocks();
});

const ERAS = [
  { era: "2025 (initialize handshake)", mode: "legacy" },
  { era: "2026-07-28", mode: "auto" },
] as const;

async function connect(key: string, mode: (typeof ERAS)[number]["mode"] = "auto"): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), {
    authProvider: { token: async () => key },
    fetch: (url, init) => POST(new Request(url, init)),
  });
  const client = new Client({ name: "stackdash-test", version: "1.0.0" }, { versionNegotiation: { mode } });
  await client.connect(transport);
  clients.push(client);
  return client;
}

function readCalls(): unknown[][] {
  return rpc.mock.calls.filter(([fn]) => fn !== "authenticate_api_key");
}

function textOf(result: CallToolResult): string {
  const [first] = result.content;
  return first?.type === "text" ? first.text : "";
}

// A prompt step reads "Call `tool` with `{json}`"; this pulls each call out to run it.
const PROMPT_TOOL_CALL = /Call `(\w+)` with `(\{[^`]*\})`/g;

function promptTextOf(result: GetPromptResult): string {
  return result.messages.map((message) => (message.content.type === "text" ? message.content.text : "")).join("\n");
}

function toolCallsOf(result: GetPromptResult): { name: string; arguments: Record<string, unknown> }[] {
  return [...promptTextOf(result).matchAll(PROMPT_TOOL_CALL)].map(([, name = "", args = "{}"]) => ({
    name,
    arguments: JSON.parse(args) as Record<string, unknown>,
  }));
}

describe.each(ERAS)("MCP over Streamable HTTP, $era", ({ mode }) => {
  it("lists the two prompts with their arguments, reading nothing", async () => {
    const client = await connect(generateApiKey().key, mode);
    const { prompts } = await client.listPrompts();
    expect(prompts).toEqual([
      { name: WEEKLY_STACK_REVIEW, title: "Weekly stack review", description: expect.any(String) },
      {
        name: WHY_DID_SPEND_CHANGE,
        title: "Why did spend change",
        description: expect.any(String),
        arguments: [
          { name: "days", description: "How many days to look back, from 1 to 90. Leave it out for 7.", required: false },
          { name: "provider", description: expect.stringContaining("Provider id"), required: false },
        ],
      },
    ]);
    expect(readCalls()).toEqual([]);
  });

  it("lists the five read-only tools with their input and output schemas", async () => {
    const client = await connect(generateApiKey().key, mode);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(Object.keys(TOOLS).sort());
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.outputSchema?.type).toBe("object");
    }
  });

  it("answers a usage question from the seed: spend with its unit, provenance, and retrieved_at", async () => {
    const { key, tokenHash } = generateApiKey();
    const client = await connect(key, mode);
    const result = await client.callTool({ name: "get_usage", arguments: { provider: "fake", from: TODAY } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      read_at: expect.any(String),
      next_cursor: null,
      data: [
        {
          metric_key: "fake.spend",
          amount_minor: 1250,
          currency: "USD",
          display: "$12.50",
          provenance: "verified",
          retrieved_at: RETRIEVED,
          simulated: false,
        },
        { metric_key: "fake.emails_included", value: 3000, unit: "emails", display: "3,000 emails" },
        { metric_key: "fake.emails_sent", value: 1200, unit: "emails", display: "1,200 emails" },
      ],
    });
    expect(readCalls()).toEqual([
      ["api_usage_snapshots", { p_token_hash: tokenHash, p_provider: "fake", p_from: TODAY, p_limit: 51 }],
    ]);
  });
});

describe("tools against the seed data", () => {
  it("list_projects returns the key's workspace and its projects", async () => {
    const { key, tokenHash } = generateApiKey();
    const client = await connect(key);
    const result = await client.callTool({ name: "list_projects", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      workspace: { id: WORKSPACE_ID, slug: "acmeseedws", name: "Acme" },
      data: [{ id: PROJECT_ID, name: "Acme web" }],
      next_cursor: null,
    });
    // Both reads take the key's hash; neither is given a workspace id.
    expect(readCalls()).toEqual([
      ["api_workspaces", { p_token_hash: tokenHash }],
      ["api_projects", { p_token_hash: tokenHash, p_limit: 51 }],
    ]);
  });

  it("list_events returns the timeline with its text to a key that can read spend", async () => {
    const client = await connect(generateApiKey().key);
    const result = await client.callTool({ name: "list_events", arguments: { severity: "critical" } });
    expect(result.structuredContent).toMatchObject({ withheld: null });
    expect(textOf(result)).toContain("Spend so far this month: 10.75 USD.");
    expect(readCalls()).toEqual([["api_activity_events", expect.objectContaining({ p_severity: "critical" })]]);
  });

  it("list_alerts returns each alert's message and amount to a key that can read spend", async () => {
    const client = await connect(generateApiKey().key);
    const result = await client.callTool({ name: "list_alerts", arguments: { acknowledged: false } });
    expect(result.structuredContent).toMatchObject({
      withheld: null,
      data: [
        { observed_amount_minor: 1250, currency: "USD", display: "$12.50", threshold_label: "$10.00", provenance: "verified" },
        { observed_value: 40, observed_amount_minor: null, display: null, severity: "warning" },
      ],
    });
    expect(readCalls()).toEqual([["api_triggered_alerts", expect.objectContaining({ p_acknowledged: false })]]);
  });

  it("get_connection_status returns status and last sync, never credentials or granted scopes", async () => {
    const client = await connect(generateApiKey().key);
    const result = await client.callTool({ name: "get_connection_status", arguments: {} });
    expect(result.structuredContent).toEqual({
      read_at: expect.any(String),
      next_cursor: null,
      data: [
        {
          id: CONNECTION_ID,
          provider: "fake",
          name: "Fake provider",
          account: "acme-team",
          status: "active",
          last_synced_at: RETRIEVED,
          simulated: false,
          created_at: "2026-11-01T09:00:00+00:00",
        },
      ],
    });
    expect(textOf(result)).not.toMatch(/granted_scopes|token|secret|credential/i);
  });

  it("serves the provider pages from docs/providers as Markdown resources", async () => {
    const client = await connect(generateApiKey().key);
    const { resources } = await client.listResources();
    const github = resources.find((resource) => resource.uri === `${PROVIDER_DOC_URI_PREFIX}github`);
    expect(github).toMatchObject({ mimeType: "text/markdown", title: expect.any(String) });
    const { contents } = await client.readResource({ uri: `${PROVIDER_DOC_URI_PREFIX}github` });
    expect(contents).toEqual([
      {
        uri: `${PROVIDER_DOC_URI_PREFIX}github`,
        mimeType: "text/markdown",
        text: readFileSync(path.join(process.cwd(), "docs", "providers", "github.md"), "utf8"),
      },
    ]);
    // Docs are public, so reading them touches no workspace data.
    expect(readCalls()).toEqual([]);
  });
});

describe("prompts", () => {
  // The prompts date their window from the server's clock, so it is fixed to a seed day.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${TODAY}T12:00:00Z`));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs every tool call a prompt asks for, as an assistant would, and returns the results. */
  async function runPrompt(client: Client, prompt: GetPromptResult): Promise<CallToolResult[]> {
    const calls = toolCallsOf(prompt);
    const { tools } = await client.listTools();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((call) => call.name).every((name) => tools.some((tool) => tool.name === name))).toBe(true);
    const results: CallToolResult[] = [];
    for (const call of calls) results.push(await client.callTool(call));
    return results;
  }

  it("weekly_stack_review answers from the seed through the five tools, over the last 7 UTC days", async () => {
    const { key, tokenHash } = generateApiKey();
    const client = await connect(key);
    const prompt = await client.getPrompt({ name: WEEKLY_STACK_REVIEW });
    expect(readCalls()).toEqual([]);
    expect(promptTextOf(prompt)).toContain(
      "for the 7 days ending 2026-11-05, starting from the 2026-10-29 reading (UTC days).",
    );

    const results = await runPrompt(client, prompt);
    expect(results.every((result) => !result.isError)).toBe(true);
    expect(readCalls()).toEqual([
      ["api_workspaces", { p_token_hash: tokenHash }],
      ["api_projects", { p_token_hash: tokenHash, p_limit: 51 }],
      ["api_connections", { p_token_hash: tokenHash, p_limit: 51 }],
      ["api_usage_snapshots", { p_token_hash: tokenHash, p_from: "2026-10-29", p_to: TODAY, p_limit: 101 }],
      ["api_activity_events", expect.objectContaining({ p_from: "2026-10-29T00:00:00Z", p_limit: 101 })],
      ["api_triggered_alerts", expect.objectContaining({ p_acknowledged: false, p_limit: 101 })],
    ]);
    // The answer has the seed's spend, events, and alerts to work from.
    const text = results.map(textOf).join("\n");
    expect(text).toContain("$12.50");
    expect(text).toContain("Deployment failed");
    expect(text).toContain("acme-team");
  });

  it("why_did_spend_change reads both spend kinds, usage, events, and alerts for one provider", async () => {
    const { key } = generateApiKey();
    const client = await connect(key);
    const prompt = await client.getPrompt({ name: WHY_DID_SPEND_CHANGE, arguments: { provider: "fake", days: "30" } });
    expect(promptTextOf(prompt)).toContain(
      "for Example provider over the 30 days ending 2026-11-05, starting from the 2026-10-06 reading (UTC days).",
    );

    const results = await runPrompt(client, prompt);
    expect(results.every((result) => !result.isError)).toBe(true);
    const usage = { p_from: "2026-10-06", p_to: TODAY, p_provider: "fake", p_limit: 101 };
    expect(readCalls()).toEqual([
      ["api_usage_snapshots", expect.objectContaining({ ...usage, p_kind: "verified_spend" })],
      ["api_usage_snapshots", expect.objectContaining({ ...usage, p_kind: "estimated_spend" })],
      ["api_usage_snapshots", expect.objectContaining({ ...usage, p_kind: "usage" })],
      ["api_activity_events", expect.objectContaining({ p_from: "2026-10-06T00:00:00Z" })],
      ["api_triggered_alerts", expect.objectContaining({ p_limit: 101 })],
    ]);
    expect(results.map(textOf).join("\n")).toContain("Spend so far this month: 10.75 USD.");
  });

  it.each([
    ["no days, the 7 day default", {}, "the 7 days", "2026-10-29"],
    ["1 day, the minimum, named in the singular", { days: "1" }, "the day", "2026-11-04"],
    ["90 days, the maximum", { days: "90" }, "the 90 days", "2026-08-07"],
  ])("why_did_spend_change accepts %s", async (_case, args, period, from) => {
    const client = await connect(generateApiKey().key);
    const prompt = await client.getPrompt({ name: WHY_DID_SPEND_CHANGE, arguments: args });
    expect(promptTextOf(prompt)).toContain(
      `spend changed in this StackDash workspace over ${period} ending ${TODAY}, starting from the ${from} reading (UTC days).`,
    );
    expect(toolCallsOf(prompt)[0]?.arguments).toEqual({ kind: "verified_spend", from, to: TODAY, limit: 100 });
  });

  it.each([
    ["0 days", { days: "0" }],
    ["91 days, one over the maximum", { days: "91" }],
    ["a fraction of a day", { days: "7.5" }],
    ["an empty number of days", { days: "" }],
    ["a provider StackDash does not have", { provider: "not-a-provider" }],
    ["an unknown argument", { workspace_id: WORKSPACE_ID }],
  ])("why_did_spend_change refuses %s with an invalid params error and reads nothing", async (_case, args) => {
    const client = await connect(generateApiKey().key);
    await expect(client.getPrompt({ name: WHY_DID_SPEND_CHANGE, arguments: args })).rejects.toMatchObject({ code: -32602 });
    expect(readCalls()).toEqual([]);
  });

  it("gives a key without usage:read the prompt, and its spend steps answer with the scope to ask for", async () => {
    keySetup = { status: "valid", scopes: ["events:read", "alerts:read"] };
    const client = await connect(generateApiKey().key);
    const prompt = await client.getPrompt({ name: WHY_DID_SPEND_CHANGE });
    expect(promptTextOf(prompt)).toContain("say which scope would show that part instead of guessing it");

    const results = await runPrompt(client, prompt);
    expect(results.map((result) => result.isError === true)).toEqual([true, true, true, false, false]);
    expect(textOf(results[0] ?? { content: [] })).toContain("does not have the usage:read scope");
    expect(readCalls().map(([fn]) => fn)).toEqual(["api_activity_events", "api_triggered_alerts"]);
  });
});

describe("scopes", () => {
  it.each(SCOPED_TOOLS)("$name answers a key without $scope with a tool error and reads nothing", async ({ name, scope }) => {
    const { key } = generateApiKey();
    keySetup = { status: "valid", scopes: API_KEY_SCOPES.filter((other) => other !== scope) };
    const client = await connect(key);
    const result = await client.callTool({ name, arguments: {} });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(`does not have the ${scope} scope`);
    expect(textOf(result)).toMatch(/Reference REF-[0-9A-Z]{8}\./);
    expect(readCalls()).toEqual([]);
  });

  it.each(SCOPED_TOOLS)("$name answers a key whose only scope is $scope", async ({ name, scope, fn }) => {
    const { key, tokenHash } = generateApiKey();
    keySetup = { status: "valid", scopes: [scope] };
    const client = await connect(key);
    const result = await client.callTool({ name, arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(readCalls()).toEqual([[fn, expect.objectContaining({ p_token_hash: tokenHash })]]);
  });

  it.each(API_KEY_SCOPES)("list_projects answers a key whose only scope is %s", async (scope) => {
    keySetup = { status: "valid", scopes: [scope] };
    const client = await connect(generateApiKey().key);
    const result = await client.callTool({ name: "list_projects", arguments: {} });
    expect(result.isError).toBeFalsy();
  });

  it("list_events withholds every title and body from a key without usage:read", async () => {
    keySetup = { status: "valid", scopes: ["events:read"] };
    const client = await connect(generateApiKey().key);
    const result = await client.callTool({ name: "list_events", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      withheld: { fields: ["title", "body"], scope: "usage:read" },
      data: [
        { type: "fake.deployment_succeeded", severity: "success", title: null, body: null },
        { type: "fake.usage_warning", title: null, body: null },
        { type: "stackdash.daily_summary", title: null, body: null },
        { type: "fake.deployment_failed", severity: "critical", title: null, body: null },
      ],
    });
    expect(textOf(result)).not.toMatch(/10\.75|USD|Spend so far/);
  });

  it("list_alerts withholds the message, threshold, and amount from a key without usage:read", async () => {
    keySetup = { status: "valid", scopes: ["alerts:read"] };
    const client = await connect(generateApiKey().key);
    const result = await client.callTool({ name: "list_alerts", arguments: {} });
    expect(result.structuredContent).toMatchObject({
      withheld: { fields: ["message", "threshold_label", "observed_amount_minor", "currency", "display"], scope: "usage:read" },
      data: [
        { severity: "warning", message: null, threshold_label: null, observed_amount_minor: null, currency: null, display: null },
        { observed_value: 40, message: null, threshold_label: null, acknowledged_at: "2026-11-04T12:00:00+00:00" },
      ],
    });
    expect(textOf(result)).not.toMatch(/12\.50|10\.00|1250|USD/);
  });
});

describe("arguments", () => {
  it.each([
    ["an unknown argument", "get_usage", { workspace_id: WORKSPACE_ID }],
    ["a page size of 101, one over the maximum", "list_projects", { limit: 101 }],
    ["a page size of 0", "list_events", { limit: 0 }],
    ["a period start that is not a date", "get_usage", { from: "last week" }],
    ["acknowledged as the string true", "list_alerts", { acknowledged: "true" }],
  ])("refuses %s before reading anything", async (_case, name, args) => {
    const client = await connect(generateApiKey().key);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).toBe(true);
    expect(readCalls()).toEqual([]);
  });

  it("accepts a page size of 100, the maximum", async () => {
    const client = await connect(generateApiKey().key);
    const result = await client.callTool({ name: "list_events", arguments: { limit: 100 } });
    expect(result.isError).toBeFalsy();
    expect(readCalls()).toEqual([["api_activity_events", expect.objectContaining({ p_limit: 101 })]]);
  });

  it("answers a changed cursor with a tool error that says what to do", async () => {
    const client = await connect(generateApiKey().key);
    const result = await client.callTool({ name: "get_usage", arguments: { cursor: "not-a-cursor" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Pass the next_cursor of the previous page unchanged.");
    expect(readCalls()).toEqual([]);
  });

  it("answers a failed read with a generic tool error and logs the detail against its reference id", async () => {
    readError = { message: 'relation "public.secret_table" does not exist' };
    const client = await connect(generateApiKey().key);
    const result = await client.callTool({ name: "get_usage", arguments: {} });
    expect(result.isError).toBe(true);
    const reference = /Reference (REF-[0-9A-Z]{8})\./.exec(textOf(result))?.[1];
    expect(reference).toMatch(REFERENCE_ID_PATTERN);
    expect(textOf(result)).not.toContain("secret_table");
    expect(logged).toContain("secret_table");
    expect(logged).toContain(reference);
  });
});

function rawPost(headers: Record<string, string>): Promise<Response> {
  return POST(
    new Request(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        ...headers,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }),
  );
}

describe("the HTTP endpoint", () => {
  it.each<[string, KeySetup, (key: string) => Record<string, string>]>([
    ["no Authorization header", { status: "valid", scopes: API_KEY_SCOPES }, () => ({})],
    ["a header that is not a StackDash key", { status: "valid", scopes: API_KEY_SCOPES }, () => ({ authorization: "Bearer sk_test_abc" })],
    ["a key no row has", { status: "unknown" }, (key) => ({ authorization: `Bearer ${key}` })],
    ["a revoked key", { status: "revoked" }, (key) => ({ authorization: `Bearer ${key}` })],
  ])("answers 401 with the API error envelope to %s", async (_case, setup, headers) => {
    const { key } = generateApiKey();
    keySetup = setup;
    const response = await rawPost(headers(key));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    const body = ErrorResponseSchema.strict().parse(await response.json());
    expect(body.error.code).toBe("unauthorized");
    expect(readCalls()).toEqual([]);
    expect(logged).not.toContain(key);
  });

  it("answers the 120th request of a minute and refuses the 121st with 429, the API's limit", async () => {
    const { key } = generateApiKey();
    keySetup = { status: "valid", scopes: API_KEY_SCOPES, requestCount: 120 };
    const allowed = await rawPost({ authorization: `Bearer ${key}` });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(allowed.headers.get("cache-control")).toBe("no-store, no-transform");

    keySetup = { status: "valid", scopes: API_KEY_SCOPES, requestCount: 121 };
    const limited = await rawPost({ authorization: `Bearer ${key}` });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(ErrorResponseSchema.parse(await limited.json()).error.code).toBe("rate_limited");
  });

  it("refuses a request from another site's page with 403 before checking the key", async () => {
    const { key } = generateApiKey();
    const response = await rawPost({ authorization: `Bearer ${key}`, origin: "https://evil.example" });
    expect(response.status).toBe(403);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("accepts a request whose Origin is this site", async () => {
    const { key } = generateApiKey();
    const response = await rawPost({ authorization: `Bearer ${key}`, origin: ORIGIN });
    expect(response.status).toBe(200);
  });

  it("refuses a body over 64 KiB with 413 and reads no workspace data", async () => {
    const { key } = generateApiKey();
    const response = await POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "list_events", arguments: { type: "a".repeat(64 * 1024) } },
        }),
      }),
    );
    expect(response.status).toBe(413);
    expect(readCalls()).toEqual([]);
  });

  it.each(["2025-03-26", "2025-11-25", "2026-07-28"])(
    "refuses a JSON-RPC batch of two tool calls with 400 and reads no workspace data (protocol %s)",
    async (version) => {
      const { key } = generateApiKey();
      const call = (id: number) => ({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "list_projects", arguments: {} },
      });
      const response = await POST(
        new Request(ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${key}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": version,
          },
          body: JSON.stringify([call(1), call(2)]),
        }),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("x-ratelimit-remaining")).not.toBeNull();
      const body = ErrorResponseSchema.strict().parse(await response.json());
      expect(body.error).toMatchObject({ code: "invalid_request", message: "Send one JSON-RPC message per request." });
      expect(readCalls()).toEqual([]);
    },
  );

  it("still answers a single tool call sent as one JSON-RPC message", async () => {
    const { key } = generateApiKey();
    const response = await POST(
      new Request(ENDPOINT, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-03-26",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_projects", arguments: {} } }),
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, no-transform");
    expect(readCalls().map(([fn]) => fn)).toEqual(["api_workspaces", "api_projects"]);
  });
});
