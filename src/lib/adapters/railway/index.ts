import type { z } from "zod";
import {
  addDecimals,
  InvalidDecimalError,
  multiplyDecimals,
  parseDecimal,
  toMinorUnits,
  type Decimal,
} from "@/lib/money";
import { PROVIDER_NAMES } from "@/lib/providers";
import type { Achievement } from "../achievements";
import {
  AuthRevokedError,
  fetchJson,
  InvalidResponseError,
  PermissionMissingError,
  readOAuthErrorCode,
} from "../errors";
import type { ActivityEvent, EventSeverity, EventType } from "../events";
import type { AdapterMetric } from "../metrics";
import {
  Secret,
  type ExternalAccount,
  type FetchLike,
  type OAuthContext,
  type OAuthCredential,
  type ProviderAdapter,
  type SyncInput,
  type SyncResult,
} from "../types";
import {
  BillingDataSchema,
  DeploymentsDataSchema,
  GraphqlEnvelopeSchema,
  measurements,
  ProjectsDataSchema,
  RAILWAY_ISSUER,
  TokenResponseSchema,
  WorkspacesDataSchema,
  type BillingData,
  type Deployment,
  type Measurement,
  type RailwayPlan,
  type RailwayProject,
  type TokenResponse,
} from "./schemas";

/**
 * Railway adapter (adapter pattern over the Railway Public GraphQL API), per
 * docs/providers/railway.md and issue #113.
 *
 * "Login with Railway": OAuth 2.0 authorization code flow with PKCE (S256) as a confidential
 * client (client_secret_basic). Access tokens last an hour; refresh tokens rotate and are only
 * issued with `offline_access` plus `prompt=consent`. Railway has no revocation endpoint.
 *
 * The adapter only ever sends the four read queries below. GraphQL could carry mutations over the
 * same endpoint, so the query text is fixed here and only variables change.
 */

const API_ORIGIN = "https://backboard.railway.com";
const AUTHORIZE_URL = `${API_ORIGIN}/oauth/auth`;
const TOKEN_URL = `${API_ORIGIN}/oauth/token`;
export const GRAPHQL_URL = `${API_ORIGIN}/graphql/v2`;

// `email` and `profile` are required by Railway before `me { workspaces }` lists the granted
// workspaces; their claims are never read (decision on #113, docs/providers/railway.md, Scopes).
const REQUESTED_SCOPES = ["openid", "email", "profile", "offline_access", "workspace:viewer"] as const;
const WORKSPACE_SCOPE = "workspace:viewer";

const STATE_MAX_LENGTH = 1024;
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

// Bounded sync. Projects beyond the cap are skipped with a warning. Each project's deployment
// history is paged newest first (the order the "Get latest active deployment" example relies on)
// until a page reaches deployments created before the sync window, so every deployment created in
// the window is read, however many there are, up to the page cap.
const MAX_PROJECTS = 50;
const PROJECT_PAGE_SIZE = MAX_PROJECTS;
const DEPLOYMENT_PAGE_SIZE = 50;
// 250 deployments per project per sync: a week of the first sync's lookback at about 35 a day.
const MAX_DEPLOYMENT_PAGES = 5;
// Aliased `deployments` fields per request, so a large workspace costs a handful of requests
// against plans with 100 requests per hour, without one very large query.
const PROJECTS_PER_DEPLOYMENTS_REQUEST = 10;
// Re-read an hour before the cursor so a deployment whose status changed just before the last
// poll is seen again; dedupe keys make the re-read idempotent.
const DEPLOYMENT_OVERLAP_MS = 60 * 60 * 1000;
const FIRST_SYNC_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const NAME_MAX = 60;

const BILLING_CURRENCY = "USD";
export const PRICING_SOURCE = "https://docs.railway.com/pricing/plans";
// The bill estimated for the whole billing period, declared as projected spend.
const PROJECTED_SPEND_METRIC_KEY = "railway.estimate.bill";

type QueryName = "workspaces" | "projects" | "deployments" | "billing";

const WORKSPACES_QUERY = "query StackDashWorkspaces { me { workspaces { id name } } }";

const PROJECTS_QUERY = `query StackDashProjects($workspaceId: String!) {
  workspace(workspaceId: $workspaceId) {
    projects(first: ${PROJECT_PAGE_SIZE}) { edges { node { id name } } pageInfo { hasNextPage } }
  }
}`;

const DEPLOYMENT_FIELDS = "id status createdAt updatedAt statusUpdatedAt canRollback service { name } environment { name }";

/**
 * One aliased `deployments` field per project; project ids and page cursors only ever travel as
 * variables. `includeDeleted: true` asks for removed deployments too (whether the default leaves
 * them out is unverified), so a deployment that succeeded and was replaced between two polls still
 * reaches the timeline.
 */
function deploymentsQuery(count: number): string {
  const indexes = Array.from({ length: count }, (_, index) => index);
  const variables = indexes.map((index) => `$p${index}: String!, $a${index}: String`).join(", ");
  const fields = indexes
    .map(
      (index) =>
        `d${index}: deployments(first: ${DEPLOYMENT_PAGE_SIZE}, after: $a${index}, input: { projectId: $p${index}, includeDeleted: true }) { edges { node { ${DEPLOYMENT_FIELDS} } } pageInfo { hasNextPage endCursor } }`,
    )
    .join("\n  ");
  return `query StackDashDeployments(${variables}) {\n  ${fields}\n}`;
}

const BILLING_QUERY = `query StackDashBilling($workspaceId: String!, $measurements: [MetricMeasurement!]!) {
  workspace(workspaceId: $workspaceId) {
    plan
    customer { billingPeriod { start end } currentUsage creditBalance }
  }
  usage(workspaceId: $workspaceId, measurements: $measurements, includeDeleted: true) { measurement value }
  estimatedUsage(workspaceId: $workspaceId, measurements: $measurements, includeDeleted: true) {
    measurement estimatedValue projectId
  }
}`;

// Exported, like `deploymentEvents` and `billingMetrics` below, for the local simulator.
// The headline's deploys (#173) count "deployed" as a success and "failed" as a failure. The
// others have no category. "Building" only says a build started, and the same deployment's final
// event says how it ended. A crash comes after the deployment went live, dated when it crashed,
// and a poll that saw it running already counted it. A removal usually follows a "deployed" event
// for the same deployment, so counting it would count most deployments twice; the cost is that a
// deployment that succeeded and was replaced before any poll saw it (only its removal reaches the
// timeline) is not counted.
export const eventTypes = [
  {
    id: "railway.deployment.building",
    label: "Deployment building",
    description: "A Railway deployment started building.",
    shownByDefault: true,
    emoji: "🏗️",
  },
  {
    id: "railway.deployment.deployed",
    label: "Deployment deployed",
    description: "A Railway deployment finished and is running.",
    shownByDefault: true,
    category: "deploy_succeeded",
    emoji: "🚀",
  },
  {
    id: "railway.deployment.failed",
    label: "Deployment failed",
    description: "A Railway deployment failed to build or deploy.",
    shownByDefault: true,
    category: "deploy_failed",
    emoji: "💥",
  },
  {
    id: "railway.deployment.crashed",
    label: "Deployment crashed",
    description: "A Railway deployment crashed after it started.",
    shownByDefault: true,
    emoji: "🔥",
  },
  {
    id: "railway.deployment.removed",
    label: "Deployment removed",
    description: "A Railway deployment was removed, usually because a newer one replaced it.",
    shownByDefault: true,
    emoji: "🗑️",
  },
] as const satisfies readonly EventType[];

// Achievements (#413). The deployment ladder is shared with Vercel, DigitalOcean, and GitLab: keep the ids,
// thresholds, and wording in step with theirs (docs/adapters.md, "Achievements").
const achievements: readonly Achievement[] = [
  {
    id: "railway.deployments.first",
    title: "First Railway deployment recorded",
    publicTitle: "First Railway deployment recorded",
    description: "Earned when StackDash records the first successful Railway deployment.",
    rule: { kind: "event_count", typeIds: ["railway.deployment.deployed"], count: 1 },
  },
  {
    id: "railway.deployments.10",
    title: "10 Railway deployments recorded",
    publicTitle: "10 Railway deployments recorded",
    description: "Earned when StackDash records the 10th successful Railway deployment.",
    rule: { kind: "event_count", typeIds: ["railway.deployment.deployed"], count: 10 },
  },
  {
    id: "railway.deployments.100",
    title: "100 Railway deployments recorded",
    publicTitle: "100 Railway deployments recorded",
    description: "Earned when StackDash records the 100th successful Railway deployment.",
    rule: { kind: "event_count", typeIds: ["railway.deployment.deployed"], count: 100 },
  },
  {
    id: "railway.deployments.streak_10",
    title: "10 Railway deployments in a row",
    publicTitle: "10 Railway deployments in a row",
    description: "Earned when StackDash records 10 successful Railway deployments in a row, with no failed deployment between them.",
    rule: { kind: "event_streak", successTypeIds: ["railway.deployment.deployed"], failureTypeIds: ["railway.deployment.failed"], count: 10 },
  },
  {
    id: "railway.deployments.night_owl",
    title: "Night owl: a Railway deployment between midnight and 5 am",
    publicTitle: "Night owl: a Railway deployment between midnight and 5 am",
    description: "Earned when StackDash records a successful Railway deployment between midnight and 5 am London time.",
    rule: { kind: "event_at_local_time", typeIds: ["railway.deployment.deployed"], fromHour: 0, toHour: 5 },
  },
  {
    id: "railway.deployments.friday_ship",
    title: "Shipped on a Friday afternoon",
    publicTitle: "Shipped on a Friday afternoon",
    description: "Earned when StackDash records a successful Railway deployment on a Friday between 4 pm and midnight London time.",
    rule: { kind: "event_at_local_time", typeIds: ["railway.deployment.deployed"], fromHour: 16, toHour: 24, weekdays: ["friday"] },
  },
  {
    id: "railway.deployments.busy_day",
    title: "Busy day: 10 Railway deployments in one day",
    publicTitle: "Busy day: 10 Railway deployments in one day",
    description: "Earned when StackDash records 10 successful Railway deployments on one London calendar day.",
    rule: { kind: "events_in_window", typeIds: ["railway.deployment.deployed"], count: 10, window: "day" },
  },
  {
    id: "railway.deployments.weekly_rhythm",
    title: "Weekly rhythm: a Railway deployment on 7 days in a row",
    publicTitle: "Weekly rhythm: a Railway deployment on 7 days in a row",
    description: "Earned when StackDash records a successful Railway deployment on each of 7 consecutive London calendar days.",
    rule: { kind: "consecutive_days", typeIds: ["railway.deployment.deployed"], days: 7 },
  },
];

type EventKind = "building" | "deployed" | "failed" | "crashed" | "removed";

// The status a deployment is in now decides its final event; QUEUED, WAITING, INITIALIZING,
// NEEDS_APPROVAL, and SKIPPED never built, so they produce none. SLEEPING only follows a deploy.
const finalEventOf: Partial<Record<Deployment["status"], EventKind>> = {
  SUCCESS: "deployed",
  SLEEPING: "deployed",
  FAILED: "failed",
  CRASHED: "crashed",
  REMOVING: "removed",
  REMOVED: "removed",
};

// Statuses that prove the build started, so the deployment also gets a "building" event at its
// creation time. REMOVING and REMOVED prove nothing alone (a removed deployment may have been
// stopped before it built), so they count only when it can still be rolled back to (see `ran`).
const builtStatuses: Partial<Record<Deployment["status"], true>> = {
  BUILDING: true,
  DEPLOYING: true,
  SUCCESS: true,
  SLEEPING: true,
  FAILED: true,
  CRASHED: true,
};

function shorten(name: string): string {
  const trimmed = name.trim();
  const value = trimmed.length === 0 ? "unnamed" : trimmed;
  return value.length > NAME_MAX ? `${value.slice(0, NAME_MAX)}…` : value;
}

function titleOf(kind: EventKind, service: string, environment: string, ran: boolean): string {
  switch (kind) {
    case "building":
      return `Deployment of ${service} to ${environment} started building`;
    case "deployed":
      return `Deployment of ${service} to ${environment} succeeded`;
    case "failed":
      return `Deployment of ${service} to ${environment} failed`;
    case "crashed":
      return `Deployment of ${service} in ${environment} crashed`;
    case "removed":
      return ran
        ? `Deployment of ${service} to ${environment} succeeded, then was removed`
        : `Deployment of ${service} in ${environment} was removed`;
  }
}

function severityOf(kind: EventKind, production: boolean): EventSeverity {
  if (kind === "deployed") return "success";
  if (kind === "failed" || kind === "crashed") return production ? "critical" : "warning";
  return "info";
}

/** When the deployment entered its current status; `statusUpdatedAt` is nullable in the schema. */
export function statusTime(deployment: Deployment): Date {
  return deployment.statusUpdatedAt ?? deployment.updatedAt;
}

/**
 * The timeline events one deployment stands for, as seen now: a "building" event at creation when
 * the build has started, plus one event for its current final status. Railway keeps no status
 * history per deployment, only the current status and when it was entered, so a deployment that
 * succeeded and was removed before a poll saw it gets no separate "succeeded" event: its removal
 * says it succeeded instead, because there is no time to date a success by. Dedupe keys are per
 * deployment and kind, so re-polls and status changes never duplicate an event. No creator or
 * commit fields are selected, so nothing personal can reach an event.
 */
export function deploymentEvents(
  deployment: Deployment,
  projectName: string,
  externalAccountId: string,
): ActivityEvent[] {
  const service = shorten(deployment.service.name);
  const environment = shorten(deployment.environment.name);
  // "production" is the name Railway gives a new project's first environment.
  const production = deployment.environment.name.trim().toLowerCase() === "production";
  // A removed deployment Railway can still roll back to had deployed successfully: rollback restores
  // "the previously successful deployment" and is offered on removed deployments within the plan's
  // image retention, 24 hours at the least (Deployment actions, Rollback; Pricing plans, Image
  // retention policy). So one replaced between two polls still shows that it built and succeeded.
  const ran = (deployment.status === "REMOVING" || deployment.status === "REMOVED") && deployment.canRollback;
  const body = `Project: ${shorten(projectName)}`;
  const event = (kind: EventKind, occurredAt: Date): ActivityEvent => ({
    typeId: `railway.deployment.${kind}`,
    occurredAt,
    severity: severityOf(kind, production),
    title: titleOf(kind, service, environment, ran),
    body,
    externalAccountId,
    dedupeKey: `railway.deployment:${deployment.id}:${kind}`,
  });

  const events: ActivityEvent[] = [];
  if (builtStatuses[deployment.status] === true || ran) events.push(event("building", deployment.createdAt));
  const final = finalEventOf[deployment.status];
  if (final !== undefined) events.push(event(final, statusTime(deployment)));
  return events;
}

type MeasurementSpec = Readonly<{
  metricKey: string;
  label: string;
  unit: string;
  // USD per unit, from the pricing page (PRICING_SOURCE, checked 2026-11-05).
  unitPrice: string;
}>;

/**
 * Units are inferred from the per-minute prices on the pricing page: CPU and memory are billed per
 * minute, so their measurements are read as vCPU-minutes and GB-minutes (docs/providers/railway.md,
 * Unverified). DISK_USAGE_GB is priced as volume storage.
 */
export const measurementSpecs: Readonly<Record<Measurement, MeasurementSpec>> = {
  CPU_USAGE: { metricKey: "railway.usage.cpu", label: "Railway CPU used this billing period", unit: "vCPU-minutes", unitPrice: "0.000463" },
  MEMORY_USAGE_GB: {
    metricKey: "railway.usage.memory",
    label: "Railway memory used this billing period",
    unit: "GB-minutes",
    unitPrice: "0.000231",
  },
  NETWORK_TX_GB: {
    metricKey: "railway.usage.network_egress",
    label: "Railway network egress this billing period",
    unit: "GB",
    unitPrice: "0.05",
  },
  DISK_USAGE_GB: {
    metricKey: "railway.usage.volume",
    label: "Railway volume storage used this billing period",
    unit: "GB-minutes",
    unitPrice: "0.000003472222222",
  },
};

type PlanSpec = Readonly<{
  // Subscription fee and the resource usage it includes, in cents; null for a plan that never bills.
  bill: Readonly<{ feeMinor: number; includedUsageMinor: number }> | null;
  // Default resources per service, replicas included (pricing page, "Default plan resources").
  perService: Readonly<{ memoryGb: number; vcpu: number; replicas: number; volumeGb: number }>;
}>;

export const planSpecs: Readonly<Record<RailwayPlan, PlanSpec>> = {
  // Free is $0 a month with $1 of credit and stops workloads instead of billing more.
  FREE: { bill: null, perService: { memoryGb: 0.5, vcpu: 1, replicas: 1, volumeGb: 0.5 } },
  HOBBY: {
    bill: { feeMinor: 500, includedUsageMinor: 500 },
    perService: { memoryGb: 48, vcpu: 48, replicas: 6, volumeGb: 5 },
  },
  PRO: {
    bill: { feeMinor: 2000, includedUsageMinor: 2000 },
    perService: { memoryGb: 1000, vcpu: 1000, replicas: 42, volumeGb: 1000 },
  },
};

function storableRange(error: InvalidDecimalError): InvalidResponseError {
  return new InvalidResponseError("Railway billing returned an amount outside the storable range", {
    cause: error,
    endpoint: GRAPHQL_URL,
  });
}

/**
 * A JSON number read at 12 decimal places: far below a cent for any amount or unit price here,
 * and never in exponent notation, which a float such as 3e-20 would otherwise need.
 */
function decimalOf(value: number): Decimal {
  try {
    return parseDecimal(value.toFixed(12));
  } catch (error) {
    if (error instanceof InvalidDecimalError) throw storableRange(error);
    throw error;
  }
}

function minorUnits(value: Decimal): number {
  try {
    return toMinorUnits(value, BILLING_CURRENCY);
  } catch (error) {
    if (error instanceof InvalidDecimalError) throw storableRange(error);
    throw error;
  }
}

/**
 * Billing period metrics from one billing response. Amounts arrive as JSON numbers in US dollars
 * (unverified, docs/providers/railway.md); each is converted exactly and rounded once, half to
 * even (src/lib/money.ts). The bill estimate sums every project's estimated quantity times its
 * unit price at full precision, rounds that once, and adds the plan's fee for usage beyond what
 * the fee includes. It is the only estimated spend metric, and it is declared a projection for the
 * whole period (`projectedSpend`), so no reading of spend counts it as spent so far (#223).
 */
export function billingMetrics(
  billing: BillingData,
  externalAccountId: string,
  retrievedAt: Date,
  endpoint: string = GRAPHQL_URL,
): AdapterMetric[] {
  const { plan, customer } = billing.workspace;
  const { start, end } = customer.billingPeriod;
  if (end.getTime() <= start.getTime()) {
    throw new InvalidResponseError("Railway returned a billing period that ends before it starts", { endpoint });
  }
  const provenance = { source: "provider_api", endpoint } as const;
  // Everything measured over the billing period starts again when it ends.
  const periodBase = { externalAccountId, retrievedAt, timeframe: { type: "period", start, end }, resetsAt: end } as const;
  const pointBase = { externalAccountId, retrievedAt, timeframe: { type: "point", at: retrievedAt } } as const;

  const metrics: AdapterMetric[] = [];
  for (const measurement of measurements) {
    const spec = measurementSpecs[measurement];
    const rows = billing.usage.filter((row) => row.measurement === measurement);
    if (rows.length === 0) continue;
    metrics.push({
      ...periodBase,
      kind: "usage",
      metricKey: spec.metricKey,
      label: spec.label,
      provenance,
      value: rows.reduce((sum, row) => sum + row.value, 0),
      unit: spec.unit,
    });
  }

  metrics.push({
    ...periodBase,
    kind: "verified_spend",
    metricKey: "railway.spend.usage",
    label: "Railway usage cost so far this billing period",
    provenance,
    amountMinor: minorUnits(decimalOf(customer.currentUsage)),
    currency: BILLING_CURRENCY,
  });

  const { bill, perService } = planSpecs[plan];
  const estimatedUsageMinor = minorUnits(
    addDecimals(
      billing.estimatedUsage.map((row) =>
        multiplyDecimals(decimalOf(row.estimatedValue), parseDecimal(measurementSpecs[row.measurement].unitPrice)),
      ),
    ),
  );
  metrics.push({
    ...periodBase,
    kind: "estimated_spend",
    metricKey: PROJECTED_SPEND_METRIC_KEY,
    label: "Railway bill, estimated for the billing period, before credits",
    provenance: { source: "derived", endpoint, pricingSource: PRICING_SOURCE },
    // The fee covers usage up to the included amount; only usage beyond it is added.
    amountMinor: bill === null ? 0 : bill.feeMinor + Math.max(0, estimatedUsageMinor - bill.includedUsageMinor),
    currency: BILLING_CURRENCY,
  });

  metrics.push({
    ...pointBase,
    kind: "credit_balance",
    metricKey: "railway.credits.balance",
    label: "Railway credit balance",
    provenance,
    amountMinor: minorUnits(decimalOf(customer.creditBalance)),
    currency: BILLING_CURRENCY,
  });

  const limits = [
    { key: "memory_per_service", label: "Memory per service (estimated)", value: perService.memoryGb, unit: "GB" },
    { key: "vcpu_per_service", label: "vCPU per service (estimated)", value: perService.vcpu, unit: "vCPU" },
    { key: "replicas_per_service", label: "Replicas per service (estimated)", value: perService.replicas, unit: "replicas" },
    { key: "volume_per_service", label: "Volume storage per service (estimated)", value: perService.volumeGb, unit: "GB" },
  ] as const;
  for (const limit of limits) {
    metrics.push({
      ...pointBase,
      kind: "included_allowance",
      metricKey: `railway.plan.${limit.key}`,
      label: limit.label,
      provenance: { source: "derived", pricingSource: PRICING_SOURCE },
      value: limit.value,
      unit: limit.unit,
    });
  }
  return metrics;
}

function basicAuthorization(ctx: OAuthContext): string {
  return `Basic ${btoa(`${ctx.client.clientId}:${ctx.client.clientSecret.reveal()}`)}`;
}

/**
 * Token endpoint call. `invalid_grant` (400) means the code or refresh token is gone: revoked, or a
 * rotated refresh token used again. That is reported as auth revoked so the connection asks to
 * reconnect and is never retried; `fetchJson` alone would call it an invalid response.
 */
async function requestTokens(ctx: OAuthContext, form: Record<string, string>): Promise<TokenResponse> {
  let oauthError: string | undefined;
  const capturingFetch: FetchLike = async (input, init) => {
    const response = await ctx.fetch(input, init);
    if (response.status === 400) oauthError = await readOAuthErrorCode(response.clone());
    return response;
  };
  try {
    return await fetchJson(
      { ...ctx, fetch: capturingFetch },
      TOKEN_URL,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: basicAuthorization(ctx),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(form).toString(),
      },
      TokenResponseSchema,
    );
  } catch (error) {
    if (error instanceof InvalidResponseError && error.status === 400 && oauthError === "invalid_grant") {
      throw new AuthRevokedError("Railway rejected the authorization grant (invalid_grant)", {
        cause: error,
        status: 400,
        endpoint: TOKEN_URL,
      });
    }
    throw error;
  }
}

function toCredential(tokens: TokenResponse, ctx: OAuthContext, fallbackScopes: readonly string[]): OAuthCredential {
  if (tokens.token_type.toLowerCase() !== "bearer") {
    throw new InvalidResponseError("Railway returned a token type other than Bearer", { endpoint: TOKEN_URL });
  }
  return {
    accessToken: new Secret(tokens.access_token),
    refreshToken: new Secret(tokens.refresh_token),
    // 3600 seconds per the docs; taken from the response, never assumed.
    expiresAt: new Date(ctx.now().getTime() + tokens.expires_in * 1000),
    // RFC 6749 section 5.1: an omitted scope means the requested (or previously granted) scope.
    scopes: tokens.scope === undefined ? fallbackScopes : tokens.scope.split(" ").filter((scope) => scope.length > 0),
    tokenType: "Bearer",
  };
}

const NOT_AUTHORIZED = /not authori[sz]ed/i;

/**
 * One GraphQL read. HTTP failures keep `fetchJson`'s mapping. An `errors` entry saying "Not
 * Authorized" (Railway's denial, answered with HTTP 200) becomes a permission gap; any other
 * GraphQL error, or data in an unexpected shape, is an invalid response. Error messages are never
 * copied into ours: they can echo arguments.
 */
async function graphql<T>(
  ctx: OAuthContext,
  credential: OAuthCredential,
  name: QueryName,
  query: string,
  variables: Readonly<Record<string, unknown>>,
  schema: z.ZodType<T>,
): Promise<T> {
  const envelope = await fetchJson(
    ctx,
    GRAPHQL_URL,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${credential.accessToken.reveal()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    },
    GraphqlEnvelopeSchema,
  );
  const errors = envelope.errors ?? [];
  if (errors.some((error) => NOT_AUTHORIZED.test(error.message))) {
    throw new PermissionMissingError(`Railway refused the ${name} query (Not Authorized)`, [WORKSPACE_SCOPE], {
      status: 200,
      endpoint: GRAPHQL_URL,
    });
  }
  if (errors.length > 0) {
    const codes = [...new Set(errors.map((error) => error.extensions?.code ?? "unknown"))].join(", ");
    throw new InvalidResponseError(`Railway answered the ${name} query with GraphQL errors (${codes})`, {
      status: 200,
      endpoint: GRAPHQL_URL,
    });
  }
  const parsed = schema.safeParse(envelope.data);
  if (!parsed.success) {
    throw new InvalidResponseError(`Railway returned an unexpected shape for the ${name} query`, {
      cause: parsed.error,
      status: 200,
      endpoint: GRAPHQL_URL,
    });
  }
  return parsed.data;
}

async function listProjects(ctx: OAuthContext, input: SyncInput): Promise<RailwayProject[]> {
  const data = await graphql(
    ctx,
    input.credential,
    "projects",
    PROJECTS_QUERY,
    { workspaceId: input.externalAccountId },
    ProjectsDataSchema,
  );
  if (data.workspace.projects.pageInfo.hasNextPage) {
    ctx.logger.warn("railway.projects.cap_reached", { maxProjects: MAX_PROJECTS });
  }
  return data.workspace.projects.edges.map((edge) => edge.node);
}

/** The cursor is the latest deployment status time seen, as an ISO timestamp. */
function parseCursor(cursor: string | undefined, ctx: OAuthContext): number | undefined {
  if (cursor === undefined) return undefined;
  const at = Date.parse(cursor);
  if (/^\d{4}-\d{2}-\d{2}T/.test(cursor) && !Number.isNaN(at)) return at;
  ctx.logger.warn("railway.deployments.cursor_ignored", { reason: "not an ISO timestamp" });
  return undefined;
}

type DeploymentPage = Readonly<{ project: RailwayProject; after: string | undefined; page: number }>;

async function syncDeployments(
  ctx: OAuthContext,
  input: SyncInput,
  projects: readonly RailwayProject[],
): Promise<{ events: ActivityEvent[]; latest: number | undefined }> {
  const previous = parseCursor(input.cursor, ctx);
  const since =
    previous === undefined ? ctx.now().getTime() - FIRST_SYNC_LOOKBACK_MS : Math.max(0, previous - DEPLOYMENT_OVERLAP_MS);
  const events = new Map<string, ActivityEvent>();
  let latest = previous;
  const pending: DeploymentPage[] = projects.map((project) => ({ project, after: undefined, page: 1 }));

  // Sequential on purpose: the plan's hourly request budget is shared with the user's own tokens.
  while (pending.length > 0) {
    const chunk = pending.splice(0, PROJECTS_PER_DEPLOYMENTS_REQUEST);
    const variables: Record<string, string> = {};
    chunk.forEach(({ project, after }, index) => {
      variables[`p${index}`] = project.id;
      if (after !== undefined) variables[`a${index}`] = after;
    });
    const data = await graphql(
      ctx,
      input.credential,
      "deployments",
      deploymentsQuery(chunk.length),
      variables,
      DeploymentsDataSchema,
    );
    chunk.forEach(({ project, page }, index) => {
      const connection = data[`d${index}`];
      if (connection === undefined) {
        throw new InvalidResponseError("Railway left out a project's deployments", { status: 200, endpoint: GRAPHQL_URL });
      }
      let reachedOlder = false;
      for (const { node } of connection.edges) {
        latest = Math.max(latest ?? 0, statusTime(node).getTime());
        if (node.createdAt.getTime() < since) reachedOlder = true;
        // Kept or dropped as a whole, by when it entered its current status: a deployment that sat
        // queued for longer than the overlap still gets its "building" event with its final one.
        if (statusTime(node).getTime() < since) continue;
        for (const event of deploymentEvents(node, project.name, input.externalAccountId)) {
          events.set(event.dedupeKey, event);
        }
      }
      const { hasNextPage, endCursor } = connection.pageInfo;
      if (!hasNextPage || reachedOlder) return;
      if (endCursor === null || endCursor === undefined) {
        throw new InvalidResponseError("Railway reported more deployments without a page cursor", {
          status: 200,
          endpoint: GRAPHQL_URL,
        });
      }
      if (page >= MAX_DEPLOYMENT_PAGES) {
        ctx.logger.warn("railway.deployments.page_cap_reached", { maxPages: MAX_DEPLOYMENT_PAGES });
        return;
      }
      pending.push({ project, after: endCursor, page: page + 1 });
    });
  }
  return { events: [...events.values()], latest };
}

/**
 * Billing for the workspace, or the reason it is unavailable. Whether a `workspace:viewer` token
 * can read the customer fields is unverified, and Railway's dashboard limits billing settings to
 * workspace admins, so a "Not Authorized" denial leaves billing unavailable while deployments
 * still sync, as Vercel and Supabase do. Anything else fails the sync so the runner retries it
 * and records it: a timeout, rate limit, outage, or revoked token, and an invalid response, which
 * is breakage (a schema change, an unknown plan) rather than a permission gap.
 */
async function syncBilling(ctx: OAuthContext, input: SyncInput): Promise<AdapterMetric[] | PermissionMissingError> {
  try {
    const billing = await graphql(
      ctx,
      input.credential,
      "billing",
      BILLING_QUERY,
      { workspaceId: input.externalAccountId, measurements: [...measurements] },
      BillingDataSchema,
    );
    return billingMetrics(billing, input.externalAccountId, ctx.now());
  } catch (error) {
    if (error instanceof PermissionMissingError) {
      ctx.logger.warn("railway.billing.unavailable", { code: error.code });
      return new PermissionMissingError(
        "Railway billing is unavailable with viewer access to this workspace; deployments still sync",
        // A scope the user did grant: the permission billing is read through (decision on #113).
        [WORKSPACE_SCOPE],
        { cause: error, endpoint: GRAPHQL_URL, ...(error.status === undefined ? {} : { status: error.status }) },
      );
    }
    throw error;
  }
}

export const railwayAdapter: ProviderAdapter = {
  id: "railway",
  displayName: PROVIDER_NAMES.railway,
  capabilities: {
    oauth: true,
    polling: true,
    usage: true,
    spending: true,
    allowance: true,
    credits: true,
    revenue: false,
    events: true,
  },
  permissions: [
    {
      scope: "openid",
      access: "read",
      description: "Your Railway user id. Railway requires it for every app.",
    },
    {
      scope: "email",
      access: "read",
      description:
        "Your email address. Railway only lists the workspaces you share when an app asks for email and profile. StackDash never reads them.",
    },
    {
      scope: "profile",
      access: "read",
      description: "Your name and picture, needed with email to list the workspaces you share. StackDash never reads them.",
    },
    {
      scope: "offline_access",
      access: "read",
      description: "Keeps the connection syncing after the one hour access token expires, without signing in again.",
    },
    {
      scope: WORKSPACE_SCOPE,
      access: "read",
      description:
        "Viewer access to the workspaces you pick on Railway's consent screen: projects, deployments, usage, and billing where viewer access allows it. It may also allow reading logs and service settings, which StackDash never reads.",
    },
  ],
  dataCollected: [
    "Deployments per service and environment: building, deployed, failed, crashed, and removed",
    "CPU, memory, network egress, and volume storage used this billing period",
    "Usage cost so far, and an estimated bill for the whole billing period",
    "Credit balance, billing period, plan, and plan limits per service",
  ],
  eventTypes,
  achievements,
  projectedSpend: [PROJECTED_SPEND_METRIC_KEY],
  oauth: {
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    scopes: REQUESTED_SCOPES,
    pkce: true,
    clientIdEnv: "RAILWAY_CLIENT_ID",
    clientSecretEnv: "RAILWAY_CLIENT_SECRET",
  },
  // Hourly: Free plans allow 100 API requests per hour, and a sync costs about four per workspace.
  pollIntervalSeconds: 3600,
  // No `webhooks`: Railway notification webhooks are not signed, so they are never used (#113).

  buildAuthorizeUrl({ client, state, redirectUri, codeChallenge }) {
    if (codeChallenge === undefined) throw new TypeError("Railway requires a PKCE S256 code challenge");
    if (state.length === 0 || state.length > STATE_MAX_LENGTH) {
      throw new RangeError(`state must be 1 to ${STATE_MAX_LENGTH} characters`);
    }
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", REQUESTED_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    // Without it a returning user can skip consent and Railway issues no refresh token.
    url.searchParams.set("prompt", "consent");
    return url;
  },

  async exchangeCode({ code, redirectUri, codeVerifier, callbackParams }, ctx) {
    // RFC 9207 section 2.4: Railway's discovery document sets
    // `authorization_response_iss_parameter_supported`, so a callback without `iss`, or with
    // another issuer, is refused as a possible mix-up attack.
    if (callbackParams["iss"] !== RAILWAY_ISSUER) {
      throw new InvalidResponseError("Railway callback did not carry Railway as its issuer");
    }
    if (codeVerifier === undefined || !CODE_VERIFIER.test(codeVerifier)) {
      throw new TypeError("Railway requires a PKCE code verifier of 43 to 128 unreserved characters");
    }
    const tokens = await requestTokens(ctx, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    return toCredential(tokens, ctx, REQUESTED_SCOPES);
  },

  /**
   * Returns the NEW refresh token: Railway rotates it and a rotated one fails with invalid_grant.
   * The sync runner persists the returned credential before anything else runs and never runs two
   * syncs of one connection together (src/lib/jobs/sync-connection.ts, refreshIfExpiring).
   */
  async refreshTokens(credential, ctx) {
    if (credential.refreshToken === undefined) {
      throw new AuthRevokedError("Railway connection has no refresh token; reconnect required", { endpoint: TOKEN_URL });
    }
    const tokens = await requestTokens(ctx, {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken.reveal(),
    });
    const refreshed = toCredential(tokens, ctx, credential.scopes);
    return credential.metadata === undefined ? refreshed : { ...refreshed, metadata: credential.metadata };
  },

  async listAccounts(credential, ctx): Promise<ExternalAccount[]> {
    const data = await graphql(ctx, credential, "workspaces", WORKSPACES_QUERY, {}, WorkspacesDataSchema);
    return data.me.workspaces.map((workspace) => {
      const name = workspace.name.trim();
      return { externalId: workspace.id, displayName: name.length > 0 ? name : "Railway workspace", kind: "workspace" };
    });
  },

  detectMissingPermissions(grant) {
    return REQUESTED_SCOPES.filter((scope) => !grant.scopes.includes(scope));
  },

  async sync(input, ctx): Promise<SyncResult> {
    // Deployments first, Eddie's priority for the timeline: a workspace the grant no longer covers
    // fails here, as a permission gap, instead of being read as billing being unavailable.
    const projects = await listProjects(ctx, input);
    const { events, latest } = await syncDeployments(ctx, input, projects);
    const billing = await syncBilling(ctx, input);
    const result: SyncResult =
      billing instanceof PermissionMissingError
        ? { metrics: [], events, partialErrors: [billing] }
        : { metrics: billing, events };
    if (latest !== undefined) result.cursor = new Date(latest).toISOString();
    return result;
  },
};
