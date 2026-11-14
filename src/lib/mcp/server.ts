import "server-only";

import { McpServer, type AuthInfo, type CallToolResult, type GetPromptResult } from "@modelcontextprotocol/server";
import { z } from "zod";

import { addUtcDays, ANOMALY_TYPE_ID } from "@/lib/alerts/anomaly";
import { requireApiScope, type ApiPrincipal } from "@/lib/api/auth";
import { API_ENDPOINTS } from "@/lib/api/endpoints";
import { reportApiError } from "@/lib/api/errors";
import {
  API_PAGE_SIZE_MAX,
  ConnectionSchema,
  EventSchema,
  EventsQuerySchema,
  PageQuerySchema,
  ProjectSchema,
  TriggeredAlertSchema,
  TriggeredAlertsQuerySchema,
  UsageSnapshotSchema,
  UsageSnapshotsQuerySchema,
  WorkspaceSchema,
  type ApiTriggeredAlert,
} from "@/lib/api/schemas";
import { API_KEY_SCOPES, type ApiKeyScope } from "@/lib/api/scopes";
import { listDocs, type DocPage } from "@/lib/docs";
import { formatMoney, formatQuantity } from "@/lib/format";
import { utcDate } from "@/lib/jobs/ingest";
import { providerName } from "@/lib/providers";

/*
 * The read-only MCP server (#163). Every tool reads through the REST API's loaders
 * (src/lib/api/resources.ts, listed with their scopes in API_ENDPOINTS) with the hash of the key
 * that authenticateApiRequest already checked, so the database decides which workspace a key reads
 * exactly as it does for /api/v1. Nothing here looks a key up or writes anything.
 *
 * Spend never reaches a key without usage:read: get_usage needs that scope, and list_events and
 * list_alerts withhold the fields that can quote an amount (event text written by providers and by
 * StackDash's own alerts and daily summaries, an alert's message and money). The decision and its
 * evidence are on #163.
 *
 * The prompts (#254) read nothing: each is a message naming the tools to call, with their exact
 * arguments, so every number in the answer still comes through a tool and its scope check.
 */

export const MCP_SERVER_INFO = { name: "stackdash", title: "StackDash", version: "1.0.0" } as const;

/** URI of a provider page from docs/providers, as a resource. */
export const PROVIDER_DOC_URI_PREFIX = "stackdash://docs/providers/";

const INSTRUCTIONS = [
  "StackDash reads one workspace's developer stack: usage, spend, allowances, revenue, timeline events, triggered alerts, and connection status. Every tool only reads.",
  "Money is amount_minor, an integer in the minor unit of currency (cents for USD), and display shows it formatted. Never add amounts in different currencies.",
  "provenance is verified when the provider reported a number and estimated when StackDash calculated it from a price list (pricing_source). Say which when you quote a number.",
  "retrieved_at on a usage row is when StackDash fetched it from the provider. read_at is when this answer was read. simulated true means the provider simulator made the data up.",
  "Usage rows are one per account, metric, and UTC day, newest day first: the latest day of a metric is its current value. Lists are paged: pass next_cursor back as cursor, with the same filters.",
  "withheld names fields this key cannot read and the scope that would return them.",
  "The provider pages under stackdash://docs/providers/ explain each metric and whether it is verified or estimated.",
].join("\n");

/** The tools' names, so a prompt can only name a tool this server registers. */
export const MCP_TOOLS = {
  listProjects: "list_projects",
  getUsage: "get_usage",
  listEvents: "list_events",
  listAlerts: "list_alerts",
  getConnectionStatus: "get_connection_status",
} as const;

type McpToolName = (typeof MCP_TOOLS)[keyof typeof MCP_TOOLS];

// Every tool reads, never changes anything, and answers from StackDash's own database.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const timestamp = z.iso.datetime({ offset: true });

const readAt = timestamp.meta({ description: "When StackDash read this answer from its database." });
const nextCursor = z
  .string()
  .nullable()
  .meta({ description: "Pass as cursor, with the same filters, to read the next page. Null on the last page." });
const display = z
  .string()
  .nullable()
  .meta({ description: "The amount or quantity formatted for people, for example $12.50 or 1,200 emails." });
const withheld = z
  .object({
    fields: z.array(z.string()),
    scope: z.enum(API_KEY_SCOPES),
    reason: z.string(),
  })
  .nullable()
  .meta({ description: "Fields this key cannot read, set to null in every item, and the scope that would return them." });

const WithheldText = z.string().nullable();

const McpUsageSnapshotSchema = UsageSnapshotSchema.extend({ display });
const McpEventSchema = EventSchema.extend({
  title: WithheldText.meta({ description: "Null when withheld." }),
  body: WithheldText,
});
const McpTriggeredAlertSchema = TriggeredAlertSchema.extend({
  message: WithheldText.meta({ description: "Null when withheld." }),
  threshold_label: WithheldText,
  display,
});

// Tool arguments arrive as JSON, so `acknowledged` is a boolean here rather than the query string's "true".
const AlertsInputSchema = TriggeredAlertsQuerySchema.extend({
  acknowledged: z
    .boolean()
    .optional()
    .meta({ description: "true for acknowledged alerts only, false for unacknowledged only. Leave it out for both." }),
});

function page<Item extends z.ZodType>(item: Item) {
  return { read_at: readAt, data: z.array(item), next_cursor: nextCursor };
}

const ProjectsOutputSchema = z.object({ workspace: WorkspaceSchema, ...page(ProjectSchema) });
const ConnectionsOutputSchema = z.object(page(ConnectionSchema));
const UsageOutputSchema = z.object(page(McpUsageSnapshotSchema));
const EventsOutputSchema = z.object({ ...page(McpEventSchema), withheld });
const AlertsOutputSchema = z.object({ ...page(McpTriggeredAlertSchema), withheld });

type Withheld = z.infer<typeof withheld>;

const SPEND_SCOPE: ApiKeyScope = "usage:read";
const EVENT_TEXT_FIELDS = ["title", "body"] as const;
const ALERT_MONEY_FIELDS = ["message", "threshold_label", "observed_amount_minor", "currency", "display"] as const;

function withheldFor(principal: ApiPrincipal, fields: readonly string[], reason: string): Withheld {
  return principal.scopes.includes(SPEND_SCOPE) ? null : { fields: [...fields], scope: SPEND_SCOPE, reason };
}

/** The amount or the quantity formatted for people, or null when the row carries neither. */
function displayOf(amountMinor: number | null, currency: string | null, value: number | null, unit: string | null) {
  if (amountMinor !== null && currency !== null) return formatMoney(amountMinor, currency);
  if (value !== null && unit !== null) return formatQuantity(value, unit);
  return null;
}

function alertItem(row: ApiTriggeredAlert, hideMoney: boolean): z.infer<typeof McpTriggeredAlertSchema> {
  if (hideMoney) {
    return { ...row, message: null, threshold_label: null, observed_amount_minor: null, currency: null, display: null };
  }
  return { ...row, display: displayOf(row.observed_amount_minor, row.currency, null, null) };
}

/**
 * Runs one tool call: the scope check first (requireApiScope, the same 403 the REST API answers),
 * then the read. A refusal or failure becomes a tool error the model can read, with the reference
 * id the log carries; internals stay in the log.
 */
async function runTool<Output extends Record<string, unknown>>(
  principal: ApiPrincipal,
  scope: ApiKeyScope | null,
  read: () => Promise<Output>,
): Promise<CallToolResult> {
  try {
    if (scope !== null) requireApiScope(principal, scope);
    const output = await read();
    return { content: [{ type: "text", text: JSON.stringify(output) }], structuredContent: output };
  } catch (error) {
    const { apiError, referenceId } = reportApiError(error);
    return { content: [{ type: "text", text: `${apiError.message} Reference ${referenceId}.` }], isError: true };
  }
}

function readAtNow(): string {
  return new Date().toISOString();
}

// docs/ ships with the deployment and never changes while it runs, so it is read once per process.
let providerDocsMemo: readonly DocPage[] | undefined;
function providerDocs(): readonly DocPage[] {
  providerDocsMemo ??= listDocs().filter((doc) => doc.group === "providers");
  return providerDocsMemo;
}

/** The ApiPrincipal the route handler authenticated, carried through the SDK's pass-through authInfo. */
export function authInfoFor(principal: ApiPrincipal): AuthInfo {
  // `token` holds the key's hash, never the key: the read functions take the hash.
  return {
    token: principal.tokenHash,
    clientId: principal.keyId,
    scopes: [...principal.scopes],
    extra: { workspaceId: principal.workspaceId },
  };
}

export function principalFrom(authInfo: AuthInfo | undefined): ApiPrincipal {
  const workspaceId = authInfo?.extra?.workspaceId;
  if (authInfo === undefined || typeof workspaceId !== "string") {
    throw new Error("The MCP server was called without an authenticated API key.");
  }
  return {
    keyId: authInfo.clientId,
    workspaceId,
    scopes: API_KEY_SCOPES.filter((scope) => authInfo.scopes.includes(scope)),
    tokenHash: authInfo.token,
  };
}

/** Prompt names, as prompts/list gives them. */
export const WEEKLY_STACK_REVIEW = "weekly_stack_review";
export const WHY_DID_SPEND_CHANGE = "why_did_spend_change";

const WEEK_DAYS = 7;
// The prompts ask for the largest page, so the assistant follows as few cursors as it can.
const PROMPT_PAGE = { limit: API_PAGE_SIZE_MAX } as const;

// Prompt arguments are strings in MCP. 90 days keeps each call to a few pages of daily rows.
const SpendChangeArgsSchema = z.strictObject({
  days: z
    .string()
    .regex(/^(?:[1-9]|[1-8][0-9]|90)$/, "Use a whole number of days from 1 to 90.")
    .optional()
    .meta({ description: "How many days to look back, from 1 to 90. Leave it out for 7." }),
  provider: UsageSnapshotsQuerySchema.shape.provider,
});

type MetricKind = NonNullable<z.infer<typeof UsageSnapshotsQuerySchema>["kind"]>;

/** A step of a prompt: one call of a registered tool, with the arguments to pass. */
type PromptToolCall = Readonly<{
  tool: McpToolName;
  arguments: Readonly<Record<string, string | number | boolean>>;
  purpose: string;
}>;

/**
 * The `days` UTC days ending today, plus the day before them: `from` is that earlier day, read as
 * the baseline each day's change is measured against, so the calls cover `days + 1` dates. `label`
 * names the period that way for the prompt text, and `since` is the start of `from` in RFC 3339.
 */
function lookBack(now: Date, days: number): { from: string; to: string; since: string; label: string } {
  const to = utcDate(now);
  const from = addUtcDays(to, -days);
  const period = days === 1 ? "the day" : `the ${days} days`;
  return { from, to, since: `${from}T00:00:00Z`, label: `${period} ending ${to}, starting from the ${from} reading (UTC days)` };
}

/**
 * One user message: the task, the tool calls in order with their exact arguments, then how to
 * answer. Every number in the answer comes from those calls; the prompt adds no data of its own.
 */
function promptResult(task: string, calls: readonly PromptToolCall[], answer: readonly string[]): GetPromptResult {
  const text = [
    task,
    "",
    "Call these StackDash tools in order. When a result has a next_cursor, call the same tool again with the same arguments plus that cursor, until next_cursor is null.",
    ...calls.map((call, index) => `${index + 1}. Call \`${call.tool}\` with \`${JSON.stringify(call.arguments)}\`: ${call.purpose}`),
    "",
    ...answer,
    "",
    "Quote only numbers the tools returned, using display where a row has it, and say whether each is verified or estimated. Never add amounts in different currencies.",
    "If a tool answers that the key lacks a scope, or a result lists withheld fields, say which scope would show that part instead of guessing it.",
  ].join("\n");
  return { messages: [{ role: "user", content: { type: "text", text } }] };
}

function weeklyStackReview(now: Date): GetPromptResult {
  const { from, to, since, label } = lookBack(now, WEEK_DAYS);
  return promptResult(
    `Review this StackDash workspace's developer stack for ${label}.`,
    [
      { tool: MCP_TOOLS.listProjects, arguments: {}, purpose: "the workspace and its projects, to group the review by." },
      { tool: MCP_TOOLS.getConnectionStatus, arguments: {}, purpose: "connections that are not active need attention first." },
      {
        tool: MCP_TOOLS.getUsage,
        arguments: { from, to, ...PROMPT_PAGE },
        purpose: "spend, usage, and allowances for each day, plus the starting reading.",
      },
      {
        tool: MCP_TOOLS.listEvents,
        arguments: { from: since, ...PROMPT_PAGE },
        purpose: "deployments, failures, payments, and unusual spend and usage events in the same days.",
      },
      { tool: MCP_TOOLS.listAlerts, arguments: { acknowledged: false, ...PROMPT_PAGE }, purpose: "alerts nobody has acknowledged yet." },
    ],
    [
      "Then write the review under these headings, leaving out any heading with nothing to report:",
      "- Connections: each one that is not active, and what to do about it.",
      `- Spend: each spend metric on its newest day beside its ${from} reading, per provider and currency.`,
      "- Allowances: each remaining_allowance that is running low, and its resets_at.",
      `- Events: failed deployments, sync failures, and unusual spend and usage events (type ${ANOMALY_TYPE_ID}), with the day of each.`,
      "- Alerts: each unacknowledged alert and what it measured.",
      "Finish with the one thing most worth doing next.",
    ],
  );
}

function whyDidSpendChange({ days, provider }: z.infer<typeof SpendChangeArgsSchema>, now: Date): GetPromptResult {
  const span = days === undefined ? WEEK_DAYS : Number(days);
  const { from, to, since, label } = lookBack(now, span);
  const usage = (kind: MetricKind) => ({ kind, from, to, ...(provider === undefined ? {} : { provider }), ...PROMPT_PAGE });
  const scope = provider === undefined ? "" : ` for ${providerName(provider)}`;
  return promptResult(
    `Explain why spend changed in this StackDash workspace${scope} over ${label}.`,
    [
      { tool: MCP_TOOLS.getUsage, arguments: usage("verified_spend"), purpose: "spend each provider reported." },
      { tool: MCP_TOOLS.getUsage, arguments: usage("estimated_spend"), purpose: "spend StackDash estimated from a price list." },
      {
        tool: MCP_TOOLS.getUsage,
        arguments: usage("usage"),
        purpose: "the usage that estimated spend is priced from, and that often drives reported spend.",
      },
      {
        tool: MCP_TOOLS.listEvents,
        arguments: { from: since, ...PROMPT_PAGE },
        purpose: `deployments, usage warnings, unusual spend and usage events (type ${ANOMALY_TYPE_ID}), and daily summaries in the same days.`,
      },
      { tool: MCP_TOOLS.listAlerts, arguments: PROMPT_PAGE, purpose: "spend and usage alerts; keep the ones whose triggered_at falls in the period." },
    ],
    [
      "How to read spend: a spend row is a running total for its billing period (period_start to period_end), so a day's spend is its reading minus the previous day's reading in the same period. When period_start changes, a new period began: a drop is not a saving, and the first day of a period includes charges billed once per period, such as a plan fee.",
      "Then answer:",
      "- For each provider and currency: spend at the start and at the end of the period, and how much it changed.",
      "- The days with the biggest increases, each tied to the usage metric that grew and to any event or alert on that day.",
      "- If spend did not change, say so plainly.",
    ],
  );
}

/** One server instance for one authenticated request (the SDK's per-request factory). */
export function createStackDashMcpServer(principal: ApiPrincipal): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, { instructions: INSTRUCTIONS });
  const { tokenHash } = principal;

  server.registerTool(
    MCP_TOOLS.listProjects,
    {
      title: "List projects",
      description:
        "The workspace this key belongs to and its projects, oldest first. A project groups provider accounts into one product; pass its id as project_id to get_usage. Any working key may call it.",
      inputSchema: PageQuerySchema,
      outputSchema: ProjectsOutputSchema,
      annotations: READ_ONLY,
    },
    (query) =>
      runTool(principal, API_ENDPOINTS.projects.scope, async () => {
        const [workspaces, projects] = await Promise.all([
          API_ENDPOINTS.workspaces.load(tokenHash, {}),
          API_ENDPOINTS.projects.load(tokenHash, query),
        ]);
        const workspace = workspaces.data[0];
        if (workspace === undefined) throw new Error("The authenticated key's workspace was not found.");
        return { workspace, read_at: readAtNow(), ...projects };
      }),
  );

  server.registerTool(
    MCP_TOOLS.getUsage,
    {
      title: "Get usage and spend",
      description:
        "Daily snapshots of usage, spend, allowances, credit balances, and revenue: one row per provider account, metric, and UTC day, newest day first. The latest day of a metric is its current value, so remaining_allowance on the newest day answers how much quota is left. Filter by provider, project_id, a period (from and to, UTC days), metric_key, or kind. Needs the usage:read scope.",
      inputSchema: UsageSnapshotsQuerySchema,
      outputSchema: UsageOutputSchema,
      annotations: READ_ONLY,
    },
    (query) =>
      runTool(principal, API_ENDPOINTS.usageSnapshots.scope, async () => {
        const result = await API_ENDPOINTS.usageSnapshots.load(tokenHash, query);
        return {
          read_at: readAtNow(),
          data: result.data.map((row) => ({ ...row, display: displayOf(row.amount_minor, row.currency, row.value, row.unit) })),
          next_cursor: result.next_cursor,
        };
      }),
  );

  server.registerTool(
    MCP_TOOLS.listEvents,
    {
      title: "List timeline events",
      description:
        "The workspace timeline, newest first: deployments, payments, sync failures, alerts, and daily summaries. Filter by from (inclusive) and to (exclusive) as RFC 3339 times, type, severity, or provider. Needs the events:read scope; without usage:read, titles and bodies are withheld because they can quote amounts.",
      inputSchema: EventsQuerySchema,
      outputSchema: EventsOutputSchema,
      annotations: READ_ONLY,
    },
    (query) =>
      runTool(principal, API_ENDPOINTS.events.scope, async () => {
        const result = await API_ENDPOINTS.events.load(tokenHash, query);
        const hidden = withheldFor(
          principal,
          EVENT_TEXT_FIELDS,
          "Event titles and bodies can quote spend, for example a daily summary or a spend alert.",
        );
        return {
          read_at: readAtNow(),
          data: hidden === null ? result.data : result.data.map((row) => ({ ...row, title: null, body: null })),
          next_cursor: result.next_cursor,
          withheld: hidden,
        };
      }),
  );

  server.registerTool(
    MCP_TOOLS.listAlerts,
    {
      title: "List triggered alerts",
      description:
        "Alerts that fired, newest first, with the severity the alerts page shows. acknowledged false lists only the ones nobody has acknowledged yet. Needs the alerts:read scope; without usage:read, each alert's message, threshold, and amount are withheld because a spend alert quotes money.",
      inputSchema: AlertsInputSchema,
      outputSchema: AlertsOutputSchema,
      annotations: READ_ONLY,
    },
    (query) =>
      runTool(principal, API_ENDPOINTS.triggeredAlerts.scope, async () => {
        const result = await API_ENDPOINTS.triggeredAlerts.load(tokenHash, query);
        const hidden = withheldFor(principal, ALERT_MONEY_FIELDS, "A spend or budget alert quotes the amount it measured.");
        return {
          read_at: readAtNow(),
          data: result.data.map((row) => alertItem(row, hidden !== null)),
          next_cursor: result.next_cursor,
          withheld: hidden,
        };
      }),
  );

  server.registerTool(
    MCP_TOOLS.getConnectionStatus,
    {
      title: "Get connection status",
      description:
        "Each provider connection's status (pending, active, needs_attention, revoked, or failed) and last sync, oldest first. Credentials are never returned. Needs the connections:read scope.",
      inputSchema: PageQuerySchema,
      outputSchema: ConnectionsOutputSchema,
      annotations: READ_ONLY,
    },
    (query) =>
      runTool(principal, API_ENDPOINTS.connections.scope, async () => ({
        read_at: readAtNow(),
        ...(await API_ENDPOINTS.connections.load(tokenHash, query)),
      })),
  );

  for (const doc of providerDocs()) {
    const provider = doc.slug.at(-1) ?? doc.slug.join("-");
    server.registerResource(
      `provider-${provider}`,
      `${PROVIDER_DOC_URI_PREFIX}${provider}`,
      { title: doc.title, description: doc.description, mimeType: "text/markdown" },
      (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: doc.source }] }),
    );
  }

  server.registerPrompt(
    WEEKLY_STACK_REVIEW,
    {
      title: "Weekly stack review",
      description:
        "Reviews the last 7 days of this workspace: connections that need attention, spend, allowances running low, failures, and open alerts.",
    },
    () => weeklyStackReview(new Date()),
  );

  server.registerPrompt(
    WHY_DID_SPEND_CHANGE,
    {
      title: "Why did spend change",
      description:
        "Explains how spend moved over the last few days and ties each change to the usage and events behind it.",
      argsSchema: SpendChangeArgsSchema,
    },
    (args) => whyDidSpendChange(args, new Date()),
  );

  return server;
}
