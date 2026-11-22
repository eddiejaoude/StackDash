import { z } from "zod";
import { PROVIDER_NAMES } from "@/lib/providers";
import { readDeliveryId, safeEqual } from "@/lib/webhooks/signature";
import { STANDARD_WEBHOOK_HEADERS, verifyStandardWebhook } from "@/lib/webhooks/standard-webhooks";
import type { Achievement } from "../achievements";
import {
  AuthRevokedError,
  fetchJson,
  fetchNoContent,
  InvalidResponseError,
  PermissionMissingError,
  readOAuthErrorCode,
} from "../errors";
import type { ActivityEvent, EventType } from "../events";
import type { AdapterMetric } from "../metrics";
import {
  Secret,
  type AdapterContext,
  type ExternalAccount,
  type FetchLike,
  type FullAccessPermission,
  type OAuthContext,
  type OAuthCredential,
  type ProviderAdapter,
  type SyncResult,
  type WebhookConnection,
  type WebhookDescriptor,
  type WebhookOutcome,
  type WebhookRequest,
  type WebhookSource,
  type WebhookVerification,
} from "../types";
import {
  DeploymentHookSchema,
  DeploymentsSchema,
  HookEnvelopeSchema,
  MergeRequestHookSchema,
  MergeRequestsSchema,
  NamespaceSchema,
  NamespacesSchema,
  PipelineHookSchema,
  PipelinesSchema,
  ProjectHookSchema,
  ProjectIdSchema,
  ProjectsSchema,
  ReleaseHookSchema,
  ReleasesSchema,
  TokenResponseSchema,
  UpdatedProjectHookSchema,
  UsageResponseSchema,
  UserSchema,
  type Deployment,
  type HookProject,
  type MergeRequest,
  type Namespace,
  type Pipeline,
  type Project,
  type Release,
  type TokenResponse,
} from "./schemas";

/**
 * GitLab.com adapter (docs/providers/gitlab.md, issue #112).
 *
 * OAuth authorization code flow with PKCE as a confidential application, read-only scopes only
 * unless the user opts in to automatic webhook setup, which adds `api` (#428).
 * One external account per top-level namespace the user owns (a group or the personal namespace).
 * Sync reads compute minutes and storage through GraphQL, the plan through REST, and polls
 * pipelines, deployments, releases, and merged merge requests of the most recently active
 * projects; project webhooks push the same events (see "Webhook" below). GitLab.com only: a
 * self-managed instance would need its own OAuth app and origin.
 */

const GITLAB_ORIGIN = "https://gitlab.com";
const API_BASE = `${GITLAB_ORIGIN}/api/v4`;
const GRAPHQL_URL = `${GITLAB_ORIGIN}/api/graphql`;
const AUTHORIZE_URL = `${GITLAB_ORIGIN}/oauth/authorize`;
const TOKEN_URL = `${GITLAB_ORIGIN}/oauth/token`;
const REVOKE_URL = `${GITLAB_ORIGIN}/oauth/revoke`;

const READ_API = "read_api";
const READ_USER = "read_user";
// Never `api` in the base request: it is read and write. Automatic webhook setup adds it only when
// the user opts in (`webhookWritePermission`, #424, #428).
const SCOPES = [READ_API, READ_USER] as const;

// Non-secret values kept on the credential. The refresh request repeats the authorize request's
// redirect URI, as GitLab's OAuth guide shows (page, "Token lifetimes and refresh").
export const metadataKeys = { userId: "userId", username: "username", redirectUri: "redirectUri" } as const;

const NAMESPACE_PAGE_SIZE = 100;
const MAX_NAMESPACE_PAGES = 5;
// Activity is read for this many projects per namespace, most recently active first.
export const MAX_ACTIVITY_PROJECTS = 10;
// One page per endpoint per project; a full page is logged because older items were skipped.
const ACTIVITY_PAGE_SIZE = 100;
const RELEASE_PAGE_SIZE = 20;
const MAX_USAGE_PROJECTS = 20;
const FIRST_SYNC_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
// Re-read a little before the cursor so an item written while the last sync ran is not missed.
// Dedupe keys make the overlap idempotent.
const CURSOR_OVERLAP_MS = 10 * 60 * 1000;
// Two shortened parts plus the fixed words stay inside the event model's 200 character title.
const TITLE_PART_MAX = 70;
const BYTES_PER_GIB = 2 ** 30;

const HttpsUrlSchema = z.url({ protocol: /^https$/ });

// Exported, like the plan vocabulary and event builders below, for the local simulator.
export const PRICING_SOURCE = "https://about.gitlab.com/pricing/ (checked 2026-11-05)";

/**
 * Monthly compute minutes per GitLab.com plan, from the pricing page. The quota itself is only
 * returned to GitLab.com administrators (`shared_runners_minutes_limit`), so it is derived from the
 * plan and labeled estimated. Trial and legacy plan names have no published figure and get none.
 */
export const PLAN_COMPUTE_MINUTES: Readonly<Record<string, Readonly<{ name: string; minutes: number }>>> = {
  free: { name: "Free", minutes: 400 },
  premium: { name: "Premium", minutes: 10_000 },
  ultimate: { name: "Ultimate", minutes: 50_000 },
};

export const metricKeys = {
  minutesUsed: "gitlab.compute_minutes.month.used",
  minutesIncluded: "gitlab.compute_minutes.month.limit",
  minutesRemaining: "gitlab.compute_minutes.month.remaining",
  storageUsed: "gitlab.storage.namespace.used",
  storageLimit: "gitlab.storage.namespace.limit",
} as const;

/** Its own key prefix, so a project's minutes never pair with the namespace quota as an allowance. */
export function projectMinutesKey(projectId: number): string {
  return `gitlab.compute_minutes.project.p${projectId}.month`;
}

// The headline's deploys (#173) count deployments to an environment, by outcome. Pipelines are CI
// runs, which may deploy nothing; a release and a merge are not deployments either.
export const eventTypes = [
  {
    id: "gitlab.pipeline.succeeded",
    label: "Pipeline succeeded",
    description: "A GitLab CI/CD pipeline finished successfully.",
    shownByDefault: true,
    emoji: "✅",
  },
  {
    id: "gitlab.pipeline.failed",
    label: "Pipeline failed",
    description: "A GitLab CI/CD pipeline failed. Failures on the default branch are critical.",
    shownByDefault: true,
    emoji: "❌",
  },
  {
    id: "gitlab.deployment.succeeded",
    label: "Deployment succeeded",
    description: "A deployment to a GitLab environment finished successfully.",
    shownByDefault: true,
    category: "deploy_succeeded",
    emoji: "🚀",
  },
  {
    id: "gitlab.deployment.failed",
    label: "Deployment failed",
    description: "A deployment to a GitLab environment failed. Failures in production are critical.",
    shownByDefault: true,
    category: "deploy_failed",
    emoji: "💥",
  },
  {
    id: "gitlab.release.published",
    label: "Release published",
    description: "A project published a GitLab release.",
    shownByDefault: true,
    emoji: "📦",
  },
  {
    id: "gitlab.merge_request.merged",
    label: "Merge request merged",
    description: "A merge request was merged. Only its number is kept, never its title or author.",
    shownByDefault: true,
    emoji: "🔀",
  },
] as const satisfies readonly EventType[];

// Achievements (#413). The deployment ladder is shared with Vercel, Railway, and DigitalOcean: keep the ids,
// thresholds, and wording in step with theirs (docs/adapters.md, "Achievements").
// The pipeline, merge request, and release ones are GitLab's own.
const achievements: readonly Achievement[] = [
  {
    id: "gitlab.deployments.first",
    title: "First GitLab deployment recorded",
    publicTitle: "First GitLab deployment recorded",
    description: "Earned when StackDash records the first successful GitLab deployment.",
    rule: { kind: "event_count", typeIds: ["gitlab.deployment.succeeded"], count: 1 },
  },
  {
    id: "gitlab.deployments.10",
    title: "10 GitLab deployments recorded",
    publicTitle: "10 GitLab deployments recorded",
    description: "Earned when StackDash records the 10th successful GitLab deployment.",
    rule: { kind: "event_count", typeIds: ["gitlab.deployment.succeeded"], count: 10 },
  },
  {
    id: "gitlab.deployments.100",
    title: "100 GitLab deployments recorded",
    publicTitle: "100 GitLab deployments recorded",
    description: "Earned when StackDash records the 100th successful GitLab deployment.",
    rule: { kind: "event_count", typeIds: ["gitlab.deployment.succeeded"], count: 100 },
  },
  {
    id: "gitlab.deployments.streak_10",
    title: "10 GitLab deployments in a row",
    publicTitle: "10 GitLab deployments in a row",
    description: "Earned when StackDash records 10 successful GitLab deployments in a row, with no failed deployment between them.",
    rule: { kind: "event_streak", successTypeIds: ["gitlab.deployment.succeeded"], failureTypeIds: ["gitlab.deployment.failed"], count: 10 },
  },
  {
    id: "gitlab.deployments.night_owl",
    title: "Night owl: a GitLab deployment between midnight and 5 am",
    publicTitle: "Night owl: a GitLab deployment between midnight and 5 am",
    description: "Earned when StackDash records a successful GitLab deployment between midnight and 5 am London time.",
    rule: { kind: "event_at_local_time", typeIds: ["gitlab.deployment.succeeded"], fromHour: 0, toHour: 5 },
  },
  {
    id: "gitlab.deployments.friday_ship",
    title: "Shipped on a Friday afternoon",
    publicTitle: "Shipped on a Friday afternoon",
    description: "Earned when StackDash records a successful GitLab deployment on a Friday between 4 pm and midnight London time.",
    rule: { kind: "event_at_local_time", typeIds: ["gitlab.deployment.succeeded"], fromHour: 16, toHour: 24, weekdays: ["friday"] },
  },
  {
    id: "gitlab.deployments.busy_day",
    title: "Busy day: 10 GitLab deployments in one day",
    publicTitle: "Busy day: 10 GitLab deployments in one day",
    description: "Earned when StackDash records 10 successful GitLab deployments on one London calendar day.",
    rule: { kind: "events_in_window", typeIds: ["gitlab.deployment.succeeded"], count: 10, window: "day" },
  },
  {
    id: "gitlab.deployments.weekly_rhythm",
    title: "Weekly rhythm: a GitLab deployment on 7 days in a row",
    publicTitle: "Weekly rhythm: a GitLab deployment on 7 days in a row",
    description: "Earned when StackDash records a successful GitLab deployment on each of 7 consecutive London calendar days.",
    rule: { kind: "consecutive_days", typeIds: ["gitlab.deployment.succeeded"], days: 7 },
  },
  {
    id: "gitlab.pipelines.100",
    title: "100 GitLab pipelines passed",
    publicTitle: "100 GitLab pipelines passed",
    description: "Earned when StackDash records the 100th successful GitLab pipeline.",
    rule: { kind: "event_count", typeIds: ["gitlab.pipeline.succeeded"], count: 100 },
  },
  {
    id: "gitlab.pipelines.green_streak",
    title: "Green streak: 25 pipelines passed in a row",
    publicTitle: "Green streak: 25 pipelines passed in a row",
    description: "Earned when StackDash records 25 successful GitLab pipelines in a row, with no failed pipeline between them.",
    rule: { kind: "event_streak", successTypeIds: ["gitlab.pipeline.succeeded"], failureTypeIds: ["gitlab.pipeline.failed"], count: 25 },
  },
  {
    id: "gitlab.merge_requests.first",
    title: "First merge request merged",
    publicTitle: "First merge request merged",
    description: "Earned when StackDash records the first merged GitLab merge request.",
    rule: { kind: "event_count", typeIds: ["gitlab.merge_request.merged"], count: 1 },
  },
  {
    id: "gitlab.merge_requests.100",
    title: "100 merge requests merged",
    publicTitle: "100 merge requests merged",
    description: "Earned when StackDash records the 100th merged GitLab merge request.",
    rule: { kind: "event_count", typeIds: ["gitlab.merge_request.merged"], count: 100 },
  },
  {
    id: "gitlab.merge_requests.marathon",
    title: "Merge marathon: 10 merge requests in one day",
    publicTitle: "Merge marathon: 10 merge requests in one day",
    description: "Earned when StackDash records 10 merged GitLab merge requests on one London calendar day.",
    rule: { kind: "events_in_window", typeIds: ["gitlab.merge_request.merged"], count: 10, window: "day" },
  },
  {
    id: "gitlab.releases.first",
    title: "First GitLab release published",
    publicTitle: "First GitLab release published",
    description: "Earned when StackDash records the first published GitLab release.",
    rule: { kind: "event_count", typeIds: ["gitlab.release.published"], count: 1 },
  },
  {
    id: "gitlab.releases.10",
    title: "10 GitLab releases published",
    publicTitle: "10 GitLab releases published",
    description: "Earned when StackDash records the 10th published GitLab release.",
    rule: { kind: "event_count", typeIds: ["gitlab.release.published"], count: 10 },
  },
];

export type ProjectRef = Pick<Project, "id" | "path_with_namespace" | "default_branch">;

function shorten(text: string, max: number = TITLE_PART_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function httpsUrl(value: string | undefined): { url: string } | Record<string, never> {
  const parsed = HttpsUrlSchema.safeParse(value);
  return parsed.success ? { url: parsed.data } : {};
}

/** Only finished pipelines become events. Dated by `updated_at`, the list's closest to finish time. */
export function pipelineEvent(project: ProjectRef, pipeline: Pipeline, externalAccountId: string): ActivityEvent | undefined {
  if (pipeline.status !== "success" && pipeline.status !== "failed") return undefined;
  const succeeded = pipeline.status === "success";
  const onDefaultBranch = project.default_branch === pipeline.ref;
  return {
    typeId: succeeded ? "gitlab.pipeline.succeeded" : "gitlab.pipeline.failed",
    occurredAt: pipeline.updated_at,
    severity: succeeded ? "success" : onDefaultBranch ? "critical" : "warning",
    title: `Pipeline #${pipeline.iid} ${succeeded ? "succeeded" : "failed"} on ${shorten(pipeline.ref)} in ${shorten(project.path_with_namespace)}`,
    externalAccountId,
    dedupeKey: `gitlab.pipeline:${project.id}:${pipeline.id}:${pipeline.status}`,
    ...httpsUrl(pipeline.web_url),
  };
}

/**
 * What a deployment event needs. A webhook delivery carries no iid, ref, or environment id, so its
 * event leaves out the body that names them, and the next poll fills it in (#499).
 */
type DeploymentFacts = Pick<Deployment, "id" | "status" | "updated_at"> &
  Readonly<{ environment: Pick<Deployment["environment"], "name"> & Partial<Pick<Deployment["environment"], "id">> }> &
  Partial<Pick<Deployment, "iid" | "ref">>;

/** Only finished deployments become events, one per deployment and final status. */
export function deploymentEvent(project: ProjectRef, deployment: DeploymentFacts, externalAccountId: string): ActivityEvent | undefined {
  if (deployment.status !== "success" && deployment.status !== "failed") return undefined;
  const succeeded = deployment.status === "success";
  const environment = deployment.environment.name;
  return {
    typeId: succeeded ? "gitlab.deployment.succeeded" : "gitlab.deployment.failed",
    occurredAt: deployment.updated_at,
    // `production`, `prod`, or a `production/...` review folder.
    severity: succeeded ? "success" : /^prod(uction)?(\/|$)/i.test(environment) ? "critical" : "warning",
    title: `Deployment to ${shorten(environment)} ${succeeded ? "succeeded" : "failed"} in ${shorten(project.path_with_namespace)}`,
    ...(deployment.iid === undefined || deployment.ref === undefined
      ? {}
      : { body: `Deployment #${deployment.iid} of ${shorten(deployment.ref)}.` }),
    externalAccountId,
    // No link: the API returns none, and a built environments URL would be a guess.
    dedupeKey: `gitlab.deployment:${project.id}:${deployment.id}:${deployment.status}`,
  };
}

/** A release counts once it is out: an upcoming release (future `released_at`) waits. */
export function releaseEvent(
  project: ProjectRef,
  release: Release,
  externalAccountId: string,
  now: Date,
): ActivityEvent | undefined {
  if (release.upcoming_release === true || release.released_at.getTime() > now.getTime()) return undefined;
  return {
    typeId: "gitlab.release.published",
    occurredAt: release.released_at,
    severity: "success",
    title: `Release ${shorten(release.tag_name)} published in ${shorten(project.path_with_namespace)}`,
    externalAccountId,
    dedupeKey: `gitlab.release:${project.id}:${shorten(release.tag_name, 120)}`,
    ...httpsUrl(release._links?.self),
  };
}

/** Merged merge requests only. The title is user-written and may name people, so it is not kept. */
export function mergeRequestEvent(
  project: ProjectRef,
  mergeRequest: MergeRequest,
  externalAccountId: string,
): ActivityEvent | undefined {
  if (mergeRequest.state !== "merged" || mergeRequest.merged_at === null) return undefined;
  return {
    typeId: "gitlab.merge_request.merged",
    occurredAt: mergeRequest.merged_at,
    severity: "success",
    title: `Merge request !${mergeRequest.iid} merged in ${shorten(project.path_with_namespace)}`,
    externalAccountId,
    dedupeKey: `gitlab.merge_request:${project.id}:${mergeRequest.iid}`,
    ...httpsUrl(mergeRequest.web_url),
  };
}

function monthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

function nextMonthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

function gibibytes(bytes: number): number {
  return Math.round((bytes / BYTES_PER_GIB) * 1000) / 1000;
}

/** What one sync learned about a namespace's usage; any part may be unavailable. */
export type UsageFacts = Readonly<{
  plan: string | null | undefined;
  minutesUsed: number | undefined;
  projectMinutes: readonly Readonly<{ projectId: number; fullPath: string; minutes: number }>[];
  storageBytes: number | undefined;
  storageLimitBytes: number | undefined;
}>;

/**
 * Compute minutes this month (used, the plan's quota, and what is left), minutes per project, and
 * namespace storage. Usage resets on the first of each month (page, "Compute minutes"); the
 * period is the UTC month, which is unverified against GitLab's own reset time.
 */
export function usageMetrics(facts: UsageFacts, externalAccountId: string, at: Date, endpoint: string): AdapterMetric[] {
  const month = { type: "period", start: monthStart(at), end: nextMonthStart(at) } as const;
  const resetsAt = nextMonthStart(at);
  const base = { externalAccountId, retrievedAt: at } as const;
  const fromApi = { source: "provider_api", endpoint } as const;
  const metrics: AdapterMetric[] = [];

  if (facts.minutesUsed !== undefined) {
    metrics.push({
      ...base,
      kind: "usage",
      metricKey: metricKeys.minutesUsed,
      label: "Compute minutes used this month",
      value: facts.minutesUsed,
      unit: "minutes",
      timeframe: month,
      resetsAt,
      provenance: fromApi,
    });
  }

  const quota = facts.plan === null || facts.plan === undefined ? undefined : PLAN_COMPUTE_MINUTES[facts.plan];
  if (quota !== undefined) {
    const estimated = { source: "derived", pricingSource: PRICING_SOURCE } as const;
    metrics.push({
      ...base,
      kind: "included_allowance",
      metricKey: metricKeys.minutesIncluded,
      label: `Monthly compute minutes on the ${quota.name} plan (estimated)`,
      value: quota.minutes,
      unit: "minutes",
      timeframe: month,
      resetsAt,
      provenance: estimated,
    });
    if (facts.minutesUsed !== undefined) {
      metrics.push({
        ...base,
        kind: "remaining_allowance",
        metricKey: metricKeys.minutesRemaining,
        label: "Compute minutes left this month (estimated)",
        // Purchased minutes are used after the quota, so remaining never goes below zero.
        value: Math.max(0, quota.minutes - facts.minutesUsed),
        unit: "minutes",
        timeframe: month,
        resetsAt,
        provenance: estimated,
      });
    }
  }

  for (const project of facts.projectMinutes) {
    metrics.push({
      ...base,
      kind: "usage",
      metricKey: projectMinutesKey(project.projectId),
      label: `Compute minutes this month, ${shorten(project.fullPath, 80)}`,
      value: project.minutes,
      unit: "minutes",
      timeframe: month,
      resetsAt,
      provenance: fromApi,
    });
  }

  const point = { type: "point", at } as const;
  if (facts.storageBytes !== undefined) {
    metrics.push({
      ...base,
      kind: "usage",
      metricKey: metricKeys.storageUsed,
      label: "Namespace storage used",
      value: gibibytes(facts.storageBytes),
      unit: "GiB",
      timeframe: point,
      provenance: fromApi,
    });
  }
  // Zero or absent means no limit applies to this namespace, so no allowance is shown.
  if (facts.storageLimitBytes !== undefined && facts.storageLimitBytes > 0) {
    metrics.push({
      ...base,
      kind: "included_allowance",
      metricKey: metricKeys.storageLimit,
      label: "Storage limit",
      value: gibibytes(facts.storageLimitBytes),
      unit: "GiB",
      timeframe: point,
      provenance: fromApi,
    });
  }
  return metrics;
}

function apiUrl(path: string, query: Readonly<Record<string, string>> = {}): URL {
  const url = new URL(`${API_BASE}${path}`);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

function bearer(credential: OAuthCredential): Record<string, string> {
  return { Accept: "application/json", Authorization: `Bearer ${credential.accessToken.reveal()}` };
}

function getJson<T>(ctx: OAuthContext, credential: OAuthCredential, url: URL, schema: z.ZodType<T>): Promise<T> {
  return fetchJson(ctx, url, { method: "GET", headers: bearer(credential) }, schema);
}

/**
 * Token endpoint call, client credentials in the body as GitLab's guide shows (never also in a
 * Basic header: GitLab answers 400 to both). `invalid_grant` means the grant is gone (revoked, or a
 * refresh token already spent), so it is reported as revoked and never retried.
 */
async function requestTokens(ctx: OAuthContext, form: Readonly<Record<string, string>>): Promise<TokenResponse> {
  let oauthError: string | undefined;
  const capturingFetch: FetchLike = async (input, init) => {
    const response = await ctx.fetch(input, init);
    if (response.status === 400) oauthError = await readOAuthErrorCode(response.clone());
    return response;
  };
  const body = new URLSearchParams({ client_id: ctx.client.clientId, client_secret: ctx.client.clientSecret.reveal(), ...form });
  try {
    return await fetchJson(
      { ...ctx, fetch: capturingFetch },
      TOKEN_URL,
      { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() },
      TokenResponseSchema,
    );
  } catch (error) {
    if (error instanceof InvalidResponseError && error.status === 400 && oauthError === "invalid_grant") {
      throw new AuthRevokedError("GitLab rejected the authorization grant (invalid_grant); connect GitLab again", {
        cause: error,
        status: 400,
        endpoint: TOKEN_URL,
      });
    }
    throw error;
  }
}

function toCredential(
  tokens: TokenResponse,
  ctx: OAuthContext,
  fallbackScopes: readonly string[],
  metadata: Readonly<Record<string, string>> | undefined,
): OAuthCredential {
  return {
    accessToken: new Secret(tokens.access_token),
    refreshToken: new Secret(tokens.refresh_token),
    // 7200 seconds (2 hours) per the guide; taken from the response, never assumed. StackDash
    // refreshes before expiry, one refresh per connection at a time (`refreshIfExpiring` in
    // src/lib/connections/credential-refresh.ts).
    expiresAt: new Date(ctx.now().getTime() + tokens.expires_in * 1000),
    // RFC 6749 section 5.1: an omitted scope means the requested (or previously granted) scope.
    scopes: tokens.scope === undefined ? fallbackScopes : tokens.scope.split(" ").filter((value) => value.length > 0),
    tokenType: tokens.token_type,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

const USAGE_QUERY = `query StackDashUsage($fullPath: ID!, $namespaceId: NamespaceID!, $month: Date!, $projects: Int!) {
  namespace(fullPath: $fullPath) { actualSizeLimit rootStorageStatistics { storageSize } }
  ciMinutesUsage(namespaceId: $namespaceId, date: $month, first: 1) { nodes { monthIso8601 minutes } }
  ciMinutesProjectMonthlyUsage(namespaceId: $namespaceId, date: $month, first: $projects) {
    nodes { minutes project { id fullPath } }
  }
}`;

// GraphQL global ids look like `gid://gitlab/Project/42` (GraphQL API, "Global IDs").
const PROJECT_GID = /^gid:\/\/gitlab\/Project\/(\d+)$/;

const USAGE_ROLE_MESSAGE =
  "GitLab did not share compute minutes for this namespace. Reading them needs the Owner role on the group";

type UsageRead = Readonly<{ facts: Omit<UsageFacts, "plan">; partialErrors: PermissionMissingError[] }>;

async function readUsage(ctx: OAuthContext, credential: OAuthCredential, namespace: Namespace, now: Date): Promise<UsageRead> {
  const month = monthStart(now).toISOString().slice(0, 10);
  const response = await fetchJson(
    ctx,
    GRAPHQL_URL,
    {
      method: "POST",
      headers: { ...bearer(credential), "Content-Type": "application/json" },
      body: JSON.stringify({
        query: USAGE_QUERY,
        variables: {
          fullPath: namespace.full_path,
          namespaceId: `gid://gitlab/Namespace/${namespace.id}`,
          month,
          projects: MAX_USAGE_PROJECTS,
        },
      }),
    },
    UsageResponseSchema,
  );
  if (response.errors !== undefined && response.errors.length > 0) {
    // GitLab answers a refused query field with `null` and no error (GraphQL API, "Authorization"),
    // so an `errors` entry is a parse, validation, complexity, or resolver failure, not a missing
    // role. Fail the read so the sync retries instead of reporting a scope gap. The messages are
    // GitLab's own and may echo the query; only the count is logged.
    ctx.logger.warn("gitlab.usage.graphql_errors", { namespaceId: namespace.id, errors: response.errors.length });
    throw new InvalidResponseError(`${GRAPHQL_URL} answered the usage query with errors`, { endpoint: GRAPHQL_URL });
  }

  const data = response.data;
  const storage = data?.namespace?.rootStorageStatistics?.storageSize ?? undefined;
  const limit = data?.namespace?.actualSizeLimit ?? undefined;
  const minutesNode = data?.ciMinutesUsage?.nodes.find((node) => node.monthIso8601 === null || node.monthIso8601 === month);
  // No row yet this month means no minutes used; a null connection means the field was refused.
  const minutesUsed = data?.ciMinutesUsage === null || data?.ciMinutesUsage === undefined ? undefined : (minutesNode?.minutes ?? 0);

  const projectMinutes: { projectId: number; fullPath: string; minutes: number }[] = [];
  for (const node of data?.ciMinutesProjectMonthlyUsage?.nodes ?? []) {
    if (node.project === null || node.minutes === null) continue;
    const id = PROJECT_GID.exec(node.project.id)?.[1];
    if (id === undefined) {
      throw new InvalidResponseError(`${GRAPHQL_URL} returned a project id that is not a GitLab global id`, {
        endpoint: GRAPHQL_URL,
      });
    }
    projectMinutes.push({ projectId: Number(id), fullPath: node.project.fullPath, minutes: node.minutes });
  }

  // Only a refused ciMinutesUsage means the role is missing. rootStorageStatistics is nullable on
  // its own: GitLab builds the row asynchronously, so a namespace with nothing stored yet (or not
  // yet counted) has none while minutes still answer. That is not a permission gap, so the storage
  // metrics are left out instead.
  const partialErrors: PermissionMissingError[] = [];
  if (minutesUsed === undefined) {
    partialErrors.push(new PermissionMissingError(USAGE_ROLE_MESSAGE, [READ_API], { endpoint: GRAPHQL_URL }));
  } else if (storage === undefined) {
    ctx.logger.info("gitlab.usage.storage_unavailable", { namespaceId: namespace.id });
  }
  return {
    facts: {
      minutesUsed,
      projectMinutes,
      storageBytes: storage,
      storageLimitBytes: storage === undefined ? undefined : limit,
    },
    partialErrors,
  };
}

async function listProjects(ctx: OAuthContext, credential: OAuthCredential, namespace: Namespace): Promise<Project[]> {
  const query = {
    archived: "false",
    simple: "true",
    order_by: "last_activity_at",
    sort: "desc",
    per_page: String(MAX_ACTIVITY_PROJECTS),
  };
  const url =
    namespace.kind === "group"
      ? apiUrl(`/groups/${namespace.id}/projects`, { ...query, include_subgroups: "true", with_shared: "false" })
      : apiUrl(`/users/${encodeURIComponent(namespace.path)}/projects`, query);
  return getJson(ctx, credential, url, ProjectsSchema);
}

/**
 * One project endpoint, where a 403 or 404 means the feature is off or the role is too low for
 * that project (for example CI/CD disabled). That skips the endpoint for the project only.
 */
async function readProjectList<T>(
  ctx: OAuthContext,
  credential: OAuthCredential,
  url: URL,
  schema: z.ZodType<T[]>,
  pageSize: number,
): Promise<T[]> {
  try {
    const items = await getJson(ctx, credential, url, schema);
    if (items.length >= pageSize) ctx.logger.warn("gitlab.activity.page_full", { endpoint: url.pathname.replace(/\d+/g, ":id") });
    return items;
  } catch (error) {
    const skipped =
      error instanceof PermissionMissingError || (error instanceof InvalidResponseError && error.status === 404);
    if (!skipped) throw error;
    ctx.logger.info("gitlab.activity.endpoint_skipped", {
      endpoint: url.pathname.replace(/\d+/g, ":id"),
      ...(error.status === undefined ? {} : { status: error.status }),
    });
    return [];
  }
}

async function projectActivity(
  ctx: OAuthContext,
  credential: OAuthCredential,
  project: Project,
  externalAccountId: string,
  since: Date,
  now: Date,
): Promise<ActivityEvent[]> {
  const path = `/projects/${project.id}`;
  const after = since.toISOString();
  const page = String(ACTIVITY_PAGE_SIZE);
  const [pipelines, deployments, mergeRequests, releases] = await Promise.all([
    readProjectList(
      ctx,
      credential,
      apiUrl(`${path}/pipelines`, { scope: "finished", updated_after: after, order_by: "updated_at", sort: "desc", per_page: page }),
      PipelinesSchema,
      ACTIVITY_PAGE_SIZE,
    ),
    // `updated_after` needs `order_by=updated_at`, or GitLab answers 400 (Deployments API).
    readProjectList(
      ctx,
      credential,
      apiUrl(`${path}/deployments`, { updated_after: after, order_by: "updated_at", sort: "desc", per_page: page }),
      DeploymentsSchema,
      ACTIVITY_PAGE_SIZE,
    ),
    readProjectList(
      ctx,
      credential,
      apiUrl(`${path}/merge_requests`, { state: "merged", merged_after: after, order_by: "merged_at", sort: "desc", per_page: page }),
      MergeRequestsSchema,
      ACTIVITY_PAGE_SIZE,
    ),
    // No date filter exists for releases, so the newest page is read and filtered here.
    readProjectList(
      ctx,
      credential,
      apiUrl(`${path}/releases`, { order_by: "released_at", sort: "desc", per_page: String(RELEASE_PAGE_SIZE) }),
      ReleasesSchema,
      RELEASE_PAGE_SIZE,
    ),
  ]);

  const events: ActivityEvent[] = [];
  const push = (event: ActivityEvent | undefined) => {
    if (event !== undefined) events.push(event);
  };
  for (const pipeline of pipelines) push(pipelineEvent(project, pipeline, externalAccountId));
  for (const deployment of deployments) push(deploymentEvent(project, deployment, externalAccountId));
  for (const mergeRequest of mergeRequests) push(mergeRequestEvent(project, mergeRequest, externalAccountId));
  for (const release of releases) {
    if (release.released_at.getTime() <= since.getTime()) continue;
    push(releaseEvent(project, release, externalAccountId, now));
  }
  return events;
}

const CursorSchema = z.strictObject({ v: z.literal(1), since: z.iso.datetime() });

function readCursor(raw: string | undefined, ctx: OAuthContext): Date | undefined {
  if (raw === undefined) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    json = undefined;
  }
  const parsed = CursorSchema.safeParse(json);
  if (parsed.success) return new Date(parsed.data.since);
  // Our own value came back unreadable: start over with the first-sync lookback.
  ctx.logger.warn("gitlab.sync.cursor_reset", {});
  return undefined;
}

/* Webhook -------------------------------------------------------------------------------------- */

/*
 * Project webhooks (#428, docs/providers/gitlab.md "Webhooks"): one per project, every one pointing
 * at the connection's own URL with the one secret StackDash generates. Created by automatic setup
 * on each project the sync reads (needs `api`, the opt-in write access), or added by hand per
 * project. Group webhooks would need a paid GitLab tier, so they are not used.
 *
 * Verification (#512): automatic setup creates each webhook with a signing token, the connection's
 * secret as `whsec_<base64>`, and no secret token. GitLab then signs every delivery the Standard
 * Webhooks way (HMAC-SHA256 over `{webhook-id}.{webhook-timestamp}.{body}` in `webhook-signature`),
 * checked with the shared verifier: a forged body or a delivery older than five minutes is refused.
 * Setup by hand cannot use it, because GitLab's form only generates a signing token and shows it
 * once, while a connection holds one secret for all its projects; so a webhook added by hand
 * carries the secret as its secret token, sent back as plain text in `X-Gitlab-Token` and compared
 * in constant time. That is a shared secret, not a signature: whoever reads one such delivery's
 * headers can send any body under a new delivery id. A delivery carrying `webhook-signature` is
 * judged by it alone, and only one without it falls back to the token, as GitLab's "Backward
 * compatibility" section describes. So a webhook added by hand must leave GitLab's signing token
 * empty: one GitLab generated signs with a key StackDash never sees, and is refused (the manual
 * steps say so). A webhook automatic setup adds never sends the token. Those it added before #512
 * did, and the first sync after #617 gives each a signing token and clears its secret token
 * (`updateProjectWebhook`); until then the token is also the signing key on such a connection.
 *
 * Delivery id: `webhook-id`, which GitLab documents as unique per delivery and the same across its
 * retries, and which equals `Idempotency-Key` (sent since GitLab 17.4). A delivery checked by its
 * token falls back to `Idempotency-Key` when `webhook-id` is absent; a signed one cannot, because
 * the signature covers `webhook-id`. Not `X-Gitlab-Event-UUID`: webhooks triggered by an earlier
 * webhook share it.
 *
 * Account: no delivery names the namespace id `sync` reads, only the project's path, so `parse`
 * matches the path's top-level namespace against the connection's accounts by name (their
 * `displayName` is the namespace's full path, `listAccounts`). A namespace renamed since the
 * connection was made matches nothing until it is reconnected; its deliveries are acknowledged and
 * dropped, and polling still brings its events.
 */

export const GITLAB_TOKEN_HEADER = "x-gitlab-token";
const DELIVERY_ID_HEADERS = ["webhook-id", "idempotency-key"] as const;
const API = "api";
// The trigger flags of `POST /projects/:id/hooks` StackDash needs. `push_events` is on unless
// turned off, so it is sent too.
const HOOK_TRIGGERS = {
  pipeline_events: true,
  deployment_events: true,
  releases_events: true,
  merge_requests_events: true,
  push_events: false,
} as const;
// `X-Gitlab-Event` of the deliveries those triggers send.
export const WEBHOOK_SUBSCRIPTIONS = ["Pipeline Hook", "Deployment Hook", "Release Hook", "Merge Request Hook"] as const;
// A source's name is the project's path, shortened to fit `webhook_sources.source_name`.
const SOURCE_NAME_MAX = 250;

export const webhookWritePermission: FullAccessPermission = {
  scope: API,
  access: "full",
  description:
    "Add a webhook to each project StackDash reads, and delete those webhooks when you disconnect, so pipelines, deployments, releases, and merges reach the timeline as they happen. StackDash uses it for nothing else.",
  fullAccessReason:
    "GitLab has no read-only access that can create a webhook. The api scope can read and change every group and project you can reach, not only webhooks.",
};

export const webhookManualSteps = [
  "In GitLab, open a project StackDash reads, then Settings, then Webhooks, and choose Add new webhook. You need the Maintainer or Owner role in the project.",
  "Paste the address below into URL and the secret below into Secret token. Leave Signing token empty: StackDash cannot read a token GitLab generates, so deliveries signed with one are refused.",
  "Under Trigger, select Pipeline events, Deployment events, Releases events, and Merge request events, then choose Add webhook.",
  "Repeat for each project you want events from. Projects without the webhook still reach the timeline on the schedule.",
] as const;

export const webhookRemovalSteps = [
  "In GitLab, open each project you added it to, then Settings, then Webhooks, and choose Delete next to the StackDash webhook.",
] as const;

/** A GitLab id taken from our own stored values, checked before it goes into a URL path. */
function numericId(value: string, what: string): string {
  if (!/^\d+$/.test(value)) throw new TypeError(`GitLab ${what} must be a numeric id`);
  return value;
}

function toSource(project: Pick<Project, "id" | "path_with_namespace">): WebhookSource {
  return { id: String(project.id), name: shorten(project.path_with_namespace, SOURCE_NAME_MAX) };
}

// GitLab's `signing_token` must be `whsec_` and the base64 of exactly 32 bytes (Project webhooks API,
// "Add a webhook to a project"). The connection's secret is 32 random bytes as base64url, with no
// prefix (`newWebhookSecret`).
const SIGNING_KEY_BYTES = 32;

/** The 32 bytes the connection's secret encodes, or null for a secret StackDash did not make. */
function signingKey(secret: Secret): Buffer | null {
  const key = Buffer.from(secret.reveal(), "base64url");
  return key.length === SIGNING_KEY_BYTES ? key : null;
}

/** The connection's secret as GitLab's `signing_token`. */
function signingToken(secret: Secret): string {
  const key = signingKey(secret);
  if (key === null) throw new TypeError("GitLab signing tokens need a 32-byte webhook secret");
  return `whsec_${key.toString("base64")}`;
}

function verifyWebhook(request: WebhookRequest, secret: Secret, now: Date): WebhookVerification {
  const { headers } = request;
  if (headers.has(STANDARD_WEBHOOK_HEADERS.signature)) {
    const key = signingKey(secret);
    return verifyStandardWebhook(request, key === null ? [] : [key], STANDARD_WEBHOOK_HEADERS, now);
  }
  const token = headers.get(GITLAB_TOKEN_HEADER);
  if (token === null || token === "") return { ok: false, reason: "missing_signature" };
  if (!safeEqual(token, secret.reveal())) return { ok: false, reason: "bad_signature" };
  for (const name of DELIVERY_ID_HEADERS) {
    const deliveryId = readDeliveryId(headers, name);
    if (deliveryId !== undefined) return { ok: true, deliveryId };
  }
  return { ok: false, reason: "malformed" };
}

/** The decoded JSON body, or undefined when it is not JSON. Only read once the delivery verifies. */
function readJsonBody(rawBody: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(rawBody));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

/** The connection's account a project belongs to: its top-level namespace, matched by path. */
function accountOf(project: HookProject, connection: WebhookConnection | undefined): string | undefined {
  // GitLab paths are unique regardless of case, and a delivery spells them as GitLab stores them.
  const topLevel = project.path_with_namespace.split("/")[0]?.toLowerCase();
  return connection?.accounts.find((account) => account.displayName.toLowerCase() === topLevel)?.externalId;
}

type HookResult = Readonly<{ event: ActivityEvent } | { reason: string }>;

/**
 * One delivery through the sync's own builders, so the event has the dedupe key a poll of the same
 * pipeline, deployment, release, or merge gives it and is stored once whichever arrives first. A
 * deployment delivery carries no iid or ref, so pushed first it is stored without its body until
 * the next poll of the deployment fills that in (#499).
 */
function hookEvent(raw: unknown, kind: string, project: HookProject, externalAccountId: string, ctx: AdapterContext): HookResult {
  const unreadable = (): HookResult => {
    // A subscribed kind StackDash cannot read means GitLab changed the payload. `kind` is one of
    // the mapped names below, so it quotes nothing else from the body.
    ctx.logger.warn("gitlab.webhook.unreadable", { kind });
    return { reason: "not a delivery GitLab maps" };
  };
  const outcome = (event: ActivityEvent | undefined, reason: string): HookResult => (event === undefined ? { reason } : { event });
  switch (kind) {
    case "pipeline": {
      const parsed = PipelineHookSchema.safeParse(raw);
      if (!parsed.success) return unreadable();
      const { id, iid, status, ref, finished_at: finishedAt, url } = parsed.data.object_attributes;
      if (finishedAt === null || finishedAt === undefined) return { reason: "pipeline has not finished" };
      const pipeline = { id, iid, status, ref, web_url: url ?? "", updated_at: finishedAt };
      return outcome(pipelineEvent(project, pipeline, externalAccountId), "pipeline neither succeeded nor failed");
    }
    case "deployment": {
      const parsed = DeploymentHookSchema.safeParse(raw);
      if (!parsed.success) return unreadable();
      const delivery = parsed.data;
      const deployment = {
        id: delivery.deployment_id,
        status: delivery.status,
        updated_at: delivery.status_changed_at,
        environment: { name: delivery.environment },
      };
      return outcome(deploymentEvent(project, deployment, externalAccountId), "deployment neither succeeded nor failed");
    }
    case "merge_request": {
      const parsed = MergeRequestHookSchema.safeParse(raw);
      if (!parsed.success) return unreadable();
      const { iid, state, action, merged_at: mergedAt, updated_at: updatedAt, url } = parsed.data.object_attributes;
      // Every later update of a merged merge request is sent with state `merged` too.
      if (action !== "merge") return { reason: "merge request action is not a merge" };
      const mergeRequest = { iid, state, merged_at: mergedAt ?? updatedAt, web_url: url ?? "" };
      return outcome(mergeRequestEvent(project, mergeRequest, externalAccountId), "merge request is not merged");
    }
    case "release": {
      const parsed = ReleaseHookSchema.safeParse(raw);
      if (!parsed.success) return unreadable();
      const { action, tag, released_at: releasedAt, url } = parsed.data;
      if (action === "delete") return { reason: "release deleted" };
      const release = { tag_name: tag, released_at: releasedAt, ...(url === undefined ? {} : { _links: { self: url } }) };
      // An upcoming release is left to the sync, which reads it once it is out.
      return outcome(releaseEvent(project, release, externalAccountId, ctx.now()), "release is upcoming");
    }
    default:
      return { reason: "event kind is not on the timeline" };
  }
}

function parseWebhook({ rawBody }: WebhookRequest, ctx: AdapterContext, connection?: WebhookConnection): WebhookOutcome {
  const raw = readJsonBody(rawBody);
  const envelope = HookEnvelopeSchema.safeParse(raw);
  if (!envelope.success) return { kind: "ignored", reason: "not a GitLab project delivery" };
  const { object_kind: kind, project } = envelope.data;
  const externalAccountId = accountOf(project, connection);
  // No source either: a project outside the connection's namespaces (one the user only maintains, or
  // a namespace renamed since connecting) can never put an event on the timeline, so the panel must
  // not list it as delivering.
  if (externalAccountId === undefined) return { kind: "ignored", reason: "project is outside the connection's namespaces" };
  const source = toSource(project);
  const result = hookEvent(raw, kind, project, externalAccountId, ctx);
  return "event" in result
    ? { kind: "events", externalAccountId, events: [result.event], source }
    : { kind: "ignored", reason: result.reason, source };
}

/** The projects each included namespace's sync reads, most recently active first. */
async function listWebhookSources(
  { credential, externalAccountIds }: Readonly<{ credential: OAuthCredential; externalAccountIds: readonly string[] }>,
  ctx: OAuthContext,
): Promise<WebhookSource[]> {
  const perNamespace = await Promise.all(
    externalAccountIds.map(async (externalAccountId) => {
      const namespace = await getJson(ctx, credential, apiUrl(`/namespaces/${numericId(externalAccountId, "namespace")}`), NamespaceSchema);
      return listProjects(ctx, credential, namespace);
    }),
  );
  return perNamespace.flat().map(toSource);
}

async function createProjectWebhook(
  { credential, url, secret, sourceId }: Readonly<{ credential: OAuthCredential; url: string; secret: Secret; sourceId: string }>,
  ctx: OAuthContext,
): Promise<Readonly<{ webhookId: string }>> {
  const hook = await fetchJson(
    ctx,
    apiUrl(`/projects/${numericId(sourceId, "project")}/hooks`),
    {
      method: "POST",
      headers: { ...bearer(credential), "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        signing_token: signingToken(secret),
        name: "StackDash",
        description: "Pipelines, deployments, releases, and merged merge requests for the StackDash timeline.",
        enable_ssl_verification: true,
        ...HOOK_TRIGGERS,
      }),
    },
    ProjectHookSchema,
  );
  return { webhookId: String(hook.id) };
}

/**
 * Gives a webhook automatic setup made before #512 a signing token and clears its secret token, so
 * GitLab stops sending the secret in plain text (#617). `PUT /projects/:id/hooks/:hook_id` requires
 * `url`, so the webhook is pointed at the URL given, the instance's public origin; GitLab sends
 * `X-Gitlab-Token` only for a present token, so an empty one stops it. GitLab's answer must report
 * a signing token and no secret token (`UpdatedProjectHookSchema`), or the update fails.
 *
 * A 404 means either the webhook was deleted or the project is out of the user's reach, where the
 * webhook may still send the secret. `GET /projects/:id` tells them apart: a project the user can
 * still read means the webhook is gone and needs nothing; one it cannot read fails the update, so
 * the webhook stays marked and is tried again once access returns.
 */
async function updateProjectWebhook(
  { credential, url, secret, sourceId, webhookId }: Readonly<{ credential: OAuthCredential; url: string; secret: Secret; sourceId: string; webhookId: string }>,
  ctx: OAuthContext,
): Promise<void> {
  const projectPath = `/projects/${numericId(sourceId, "project")}`;
  const hookUrl = apiUrl(`${projectPath}/hooks/${numericId(webhookId, "webhook")}`);
  const body = JSON.stringify({ url, signing_token: signingToken(secret), token: "" });
  try {
    await fetchJson(ctx, hookUrl, { method: "PUT", headers: { ...bearer(credential), "Content-Type": "application/json" }, body }, UpdatedProjectHookSchema);
  } catch (error) {
    if (!(error instanceof InvalidResponseError && error.status === 404)) throw error;
    // Throws on a 404 for the project itself, which keeps the mark.
    await fetchJson(ctx, apiUrl(projectPath), { headers: bearer(credential) }, ProjectIdSchema);
  }
}

/** GitLab documents the delete as idempotent; a webhook already gone (404) is removed all the same. */
async function removeProjectWebhook(
  { credential, webhookId, sourceId }: Readonly<{ credential: OAuthCredential; webhookId: string; sourceId: string }>,
  ctx: OAuthContext,
): Promise<void> {
  const url = apiUrl(`/projects/${numericId(sourceId, "project")}/hooks/${numericId(webhookId, "webhook")}`);
  try {
    await fetchNoContent(ctx, url, { method: "DELETE", headers: bearer(credential) });
  } catch (error) {
    if (error instanceof InvalidResponseError && error.status === 404) return;
    throw error;
  }
}

const webhooks: WebhookDescriptor = {
  registration: {
    kind: "connection",
    setup: {
      manualSteps: webhookManualSteps,
      removalSteps: webhookRemovalSteps,
      sourceNoun: { one: "project", many: "projects" },
      secretSource: "stackdash",
      automatic: {
        per: "source",
        extraPermissions: [webhookWritePermission],
        listSources: listWebhookSources,
        create: createProjectWebhook,
        remove: removeProjectWebhook,
        update: updateProjectWebhook,
      },
    },
  },
  subscriptions: WEBHOOK_SUBSCRIPTIONS,
  verify: verifyWebhook,
  parse: parseWebhook,
};

export const gitlabAdapter: ProviderAdapter = {
  id: "gitlab",
  displayName: PROVIDER_NAMES.gitlab,
  capabilities: {
    oauth: true,
    polling: true,
    usage: true,
    // GitLab exposes no dollar cost through these scopes (page, "Verified, estimated, unavailable").
    spending: false,
    allowance: true,
    credits: false,
    revenue: false,
    events: true,
  },
  permissions: [
    {
      scope: READ_API,
      access: "read",
      description:
        "Read the groups and projects you can see: compute minutes, storage, plan, pipelines, deployments, releases, and merged merge requests. It cannot change anything. It can also read code, issues, and the package and container registries; StackDash does not.",
    },
    {
      scope: READ_USER,
      access: "read",
      description: "Read your GitLab username and user id, to tie the connection to your account.",
    },
  ],
  dataCollected: [
    "Compute minutes used this month, per namespace and per project",
    "Monthly compute minutes included in your plan (estimated from the plan)",
    "Namespace storage used and its limit",
    "Pipelines that succeeded or failed",
    "Deployments per environment",
    "Releases",
    "Merged merge requests (numbers only, never titles or authors)",
  ],
  eventTypes,
  achievements,
  oauth: {
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    revokeUrl: REVOKE_URL,
    scopes: SCOPES,
    pkce: true,
    clientIdEnv: "GITLAB_CLIENT_ID",
    clientSecretEnv: "GITLAB_CLIENT_SECRET",
  },
  // Hourly, the contract default: compute minutes are monthly and activity is not urgent.
  pollIntervalSeconds: 3600,
  webhooks,

  buildAuthorizeUrl({ client, state, redirectUri, codeChallenge, extraScopes = [] }) {
    if (codeChallenge === undefined) throw new TypeError("GitLab requires a PKCE S256 code challenge");
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    // Always explicit: never let the granted scopes depend on what an omitted `scope` means. `api`
    // only when the user chose automatic webhook setup (#428).
    url.searchParams.set("scope", [...SCOPES, ...extraScopes].join(" "));
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  },

  async exchangeCode({ code, redirectUri, codeVerifier }, ctx) {
    if (codeVerifier === undefined) throw new TypeError("GitLab requires a PKCE code verifier");
    const tokens = await requestTokens(ctx, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    const credential = toCredential(tokens, ctx, SCOPES, undefined);
    const user = await getJson(ctx, credential, apiUrl("/user"), UserSchema);
    return {
      ...credential,
      metadata: {
        [metadataKeys.userId]: String(user.id),
        [metadataKeys.username]: user.username,
        [metadataKeys.redirectUri]: redirectUri,
      },
    };
  },

  /**
   * GitLab invalidates the old access and refresh token on every refresh, so the returned pair
   * replaces the stored one. StackDash saves it before anything else runs and never runs two
   * refreshes of one connection together (`refreshIfExpiring` in src/lib/connections/credential-refresh.ts).
   */
  async refreshTokens(credential, ctx) {
    if (credential.refreshToken === undefined) {
      throw new AuthRevokedError("This GitLab connection has no refresh token; connect GitLab again", { endpoint: TOKEN_URL });
    }
    const redirectUri = credential.metadata?.[metadataKeys.redirectUri];
    const tokens = await requestTokens(ctx, {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken.reveal(),
      ...(redirectUri === undefined ? {} : { redirect_uri: redirectUri }),
    });
    return toCredential(tokens, ctx, credential.scopes, credential.metadata);
  },

  /**
   * `POST /oauth/revoke` answers 200 with `{}`. That revoking the refresh token also ends its
   * access token is Doorkeeper behavior not yet confirmed on GitLab.com (page, Unverified).
   */
  async revoke(credential, ctx) {
    const token = credential.refreshToken ?? credential.accessToken;
    await fetchJson(
      ctx,
      REVOKE_URL,
      {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: ctx.client.clientId,
          client_secret: ctx.client.clientSecret.reveal(),
          token: token.reveal(),
        }).toString(),
      },
      z.unknown(),
    );
  },

  async listAccounts(credential, ctx): Promise<ExternalAccount[]> {
    const accounts: ExternalAccount[] = [];
    for (let page = 1; page <= MAX_NAMESPACE_PAGES; page += 1) {
      const namespaces = await getJson(
        ctx,
        credential,
        apiUrl("/namespaces", {
          owned_only: "true",
          top_level_only: "true",
          per_page: String(NAMESPACE_PAGE_SIZE),
          page: String(page),
        }),
        NamespacesSchema,
      );
      for (const namespace of namespaces) {
        if (namespace.parent_id !== null) continue;
        accounts.push({ externalId: String(namespace.id), displayName: namespace.full_path, kind: namespace.kind });
      }
      if (namespaces.length < NAMESPACE_PAGE_SIZE) return accounts;
    }
    ctx.logger.warn("gitlab.namespaces_truncated", { kept: accounts.length });
    return accounts;
  },

  detectMissingPermissions(grant) {
    return SCOPES.filter((scope) => !grant.scopes.includes(scope));
  },

  async sync({ credential, externalAccountId, cursor }, ctx): Promise<SyncResult> {
    const now = ctx.now();
    if (!/^\d+$/.test(externalAccountId)) {
      throw new InvalidResponseError("GitLab sync was handed an external account that is not a namespace id");
    }
    const namespace = await getJson(ctx, credential, apiUrl(`/namespaces/${externalAccountId}`), NamespaceSchema);
    const previous = readCursor(cursor, ctx);
    const since = new Date(
      previous === undefined ? now.getTime() - FIRST_SYNC_LOOKBACK_MS : previous.getTime() - CURSOR_OVERLAP_MS,
    );

    const [usage, projects] = await Promise.all([
      readUsage(ctx, credential, namespace, now),
      listProjects(ctx, credential, namespace),
    ]);

    const events: ActivityEvent[] = [];
    // One project at a time: each already sends four requests at once.
    for (const project of projects) {
      events.push(...(await projectActivity(ctx, credential, project, externalAccountId, since, now)));
    }

    const metrics = usageMetrics({ ...usage.facts, plan: namespace.plan }, externalAccountId, now, "POST /api/graphql");
    return {
      metrics,
      events,
      cursor: JSON.stringify({ v: 1, since: now.toISOString() }),
      ...(usage.partialErrors.length === 0 ? {} : { partialErrors: usage.partialErrors }),
    };
  },
};
