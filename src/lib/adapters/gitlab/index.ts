import { z } from "zod";
import { PROVIDER_NAMES } from "@/lib/providers";
import type { Achievement } from "../achievements";
import { AuthRevokedError, fetchJson, InvalidResponseError, PermissionMissingError, readOAuthErrorCode } from "../errors";
import type { ActivityEvent, EventType } from "../events";
import type { AdapterMetric } from "../metrics";
import {
  Secret,
  type ExternalAccount,
  type FetchLike,
  type OAuthContext,
  type OAuthCredential,
  type ProviderAdapter,
  type SyncResult,
} from "../types";
import {
  DeploymentsSchema,
  MergeRequestsSchema,
  NamespaceSchema,
  NamespacesSchema,
  PipelinesSchema,
  ProjectsSchema,
  ReleasesSchema,
  TokenResponseSchema,
  UsageResponseSchema,
  UserSchema,
  type Deployment,
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
 * OAuth authorization code flow with PKCE as a confidential application, read-only scopes only.
 * One external account per top-level namespace the user owns (a group or the personal namespace).
 * Sync reads compute minutes and storage through GraphQL, the plan through REST, and polls
 * pipelines, deployments, releases, and merged merge requests of the most recently active
 * projects. GitLab.com only: a self-managed instance would need its own OAuth app and origin.
 */

const GITLAB_ORIGIN = "https://gitlab.com";
const API_BASE = `${GITLAB_ORIGIN}/api/v4`;
const GRAPHQL_URL = `${GITLAB_ORIGIN}/api/graphql`;
const AUTHORIZE_URL = `${GITLAB_ORIGIN}/oauth/authorize`;
const TOKEN_URL = `${GITLAB_ORIGIN}/oauth/token`;
const REVOKE_URL = `${GITLAB_ORIGIN}/oauth/revoke`;

const READ_API = "read_api";
const READ_USER = "read_user";
// Never `api`: it is read and write, and webhooks (which need it) are Post-MVP.
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
  },
  {
    id: "gitlab.pipeline.failed",
    label: "Pipeline failed",
    description: "A GitLab CI/CD pipeline failed. Failures on the default branch are critical.",
    shownByDefault: true,
  },
  {
    id: "gitlab.deployment.succeeded",
    label: "Deployment succeeded",
    description: "A deployment to a GitLab environment finished successfully.",
    shownByDefault: true,
    category: "deploy_succeeded",
  },
  {
    id: "gitlab.deployment.failed",
    label: "Deployment failed",
    description: "A deployment to a GitLab environment failed. Failures in production are critical.",
    shownByDefault: true,
    category: "deploy_failed",
  },
  {
    id: "gitlab.release.published",
    label: "Release published",
    description: "A project published a GitLab release.",
    shownByDefault: true,
  },
  {
    id: "gitlab.merge_request.merged",
    label: "Merge request merged",
    description: "A merge request was merged. Only its number is kept, never its title or author.",
    shownByDefault: true,
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
    description: "Earned when DevMacro records the first successful GitLab deployment.",
    rule: { kind: "event_count", typeIds: ["gitlab.deployment.succeeded"], count: 1 },
  },
  {
    id: "gitlab.deployments.10",
    title: "10 GitLab deployments recorded",
    publicTitle: "10 GitLab deployments recorded",
    description: "Earned when DevMacro records the 10th successful GitLab deployment.",
    rule: { kind: "event_count", typeIds: ["gitlab.deployment.succeeded"], count: 10 },
  },
  {
    id: "gitlab.deployments.100",
    title: "100 GitLab deployments recorded",
    publicTitle: "100 GitLab deployments recorded",
    description: "Earned when DevMacro records the 100th successful GitLab deployment.",
    rule: { kind: "event_count", typeIds: ["gitlab.deployment.succeeded"], count: 100 },
  },
  {
    id: "gitlab.deployments.streak_10",
    title: "10 GitLab deployments in a row",
    publicTitle: "10 GitLab deployments in a row",
    description: "Earned when DevMacro records 10 successful GitLab deployments in a row, with no failed deployment between them.",
    rule: { kind: "event_streak", successTypeIds: ["gitlab.deployment.succeeded"], failureTypeIds: ["gitlab.deployment.failed"], count: 10 },
  },
  {
    id: "gitlab.deployments.night_owl",
    title: "Night owl: a GitLab deployment between midnight and 5 am",
    publicTitle: "Night owl: a GitLab deployment between midnight and 5 am",
    description: "Earned when DevMacro records a successful GitLab deployment between midnight and 5 am London time.",
    rule: { kind: "event_at_local_time", typeIds: ["gitlab.deployment.succeeded"], fromHour: 0, toHour: 5 },
  },
  {
    id: "gitlab.deployments.friday_ship",
    title: "Shipped on a Friday afternoon",
    publicTitle: "Shipped on a Friday afternoon",
    description: "Earned when DevMacro records a successful GitLab deployment on a Friday between 4 pm and midnight London time.",
    rule: { kind: "event_at_local_time", typeIds: ["gitlab.deployment.succeeded"], fromHour: 16, toHour: 24, weekdays: ["friday"] },
  },
  {
    id: "gitlab.deployments.busy_day",
    title: "Busy day: 10 GitLab deployments in one day",
    publicTitle: "Busy day: 10 GitLab deployments in one day",
    description: "Earned when DevMacro records 10 successful GitLab deployments on one London calendar day.",
    rule: { kind: "events_in_window", typeIds: ["gitlab.deployment.succeeded"], count: 10, window: "day" },
  },
  {
    id: "gitlab.deployments.weekly_rhythm",
    title: "Weekly rhythm: a GitLab deployment on 7 days in a row",
    publicTitle: "Weekly rhythm: a GitLab deployment on 7 days in a row",
    description: "Earned when DevMacro records a successful GitLab deployment on each of 7 consecutive London calendar days.",
    rule: { kind: "consecutive_days", typeIds: ["gitlab.deployment.succeeded"], days: 7 },
  },
  {
    id: "gitlab.pipelines.100",
    title: "100 GitLab pipelines passed",
    publicTitle: "100 GitLab pipelines passed",
    description: "Earned when DevMacro records the 100th successful GitLab pipeline.",
    rule: { kind: "event_count", typeIds: ["gitlab.pipeline.succeeded"], count: 100 },
  },
  {
    id: "gitlab.pipelines.green_streak",
    title: "Green streak: 25 pipelines passed in a row",
    publicTitle: "Green streak: 25 pipelines passed in a row",
    description: "Earned when DevMacro records 25 successful GitLab pipelines in a row, with no failed pipeline between them.",
    rule: { kind: "event_streak", successTypeIds: ["gitlab.pipeline.succeeded"], failureTypeIds: ["gitlab.pipeline.failed"], count: 25 },
  },
  {
    id: "gitlab.merge_requests.first",
    title: "First merge request merged",
    publicTitle: "First merge request merged",
    description: "Earned when DevMacro records the first merged GitLab merge request.",
    rule: { kind: "event_count", typeIds: ["gitlab.merge_request.merged"], count: 1 },
  },
  {
    id: "gitlab.merge_requests.100",
    title: "100 merge requests merged",
    publicTitle: "100 merge requests merged",
    description: "Earned when DevMacro records the 100th merged GitLab merge request.",
    rule: { kind: "event_count", typeIds: ["gitlab.merge_request.merged"], count: 100 },
  },
  {
    id: "gitlab.merge_requests.marathon",
    title: "Merge marathon: 10 merge requests in one day",
    publicTitle: "Merge marathon: 10 merge requests in one day",
    description: "Earned when DevMacro records 10 merged GitLab merge requests on one London calendar day.",
    rule: { kind: "events_in_window", typeIds: ["gitlab.merge_request.merged"], count: 10, window: "day" },
  },
  {
    id: "gitlab.releases.first",
    title: "First GitLab release published",
    publicTitle: "First GitLab release published",
    description: "Earned when DevMacro records the first published GitLab release.",
    rule: { kind: "event_count", typeIds: ["gitlab.release.published"], count: 1 },
  },
  {
    id: "gitlab.releases.10",
    title: "10 GitLab releases published",
    publicTitle: "10 GitLab releases published",
    description: "Earned when DevMacro records the 10th published GitLab release.",
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

/** Only finished deployments become events, one per deployment and final status. */
export function deploymentEvent(project: ProjectRef, deployment: Deployment, externalAccountId: string): ActivityEvent | undefined {
  if (deployment.status !== "success" && deployment.status !== "failed") return undefined;
  const succeeded = deployment.status === "success";
  const environment = deployment.environment.name;
  return {
    typeId: succeeded ? "gitlab.deployment.succeeded" : "gitlab.deployment.failed",
    occurredAt: deployment.updated_at,
    // `production`, `prod`, or a `production/...` review folder.
    severity: succeeded ? "success" : /^prod(uction)?(\/|$)/i.test(environment) ? "critical" : "warning",
    title: `Deployment to ${shorten(environment)} ${succeeded ? "succeeded" : "failed"} in ${shorten(project.path_with_namespace)}`,
    body: `Deployment #${deployment.iid} of ${shorten(deployment.ref)}.`,
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
    // 7200 seconds (2 hours) per the guide; taken from the response, never assumed. The sync
    // runner refreshes before expiry, one sync per connection at a time.
    expiresAt: new Date(ctx.now().getTime() + tokens.expires_in * 1000),
    // RFC 6749 section 5.1: an omitted scope means the requested (or previously granted) scope.
    scopes: tokens.scope === undefined ? fallbackScopes : tokens.scope.split(" ").filter((value) => value.length > 0),
    tokenType: tokens.token_type,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

const USAGE_QUERY = `query DevMacroUsage($fullPath: ID!, $namespaceId: NamespaceID!, $month: Date!, $projects: Int!) {
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

export const gitlabAdapter: ProviderAdapter = {
  id: "gitlab",
  displayName: PROVIDER_NAMES.gitlab,
  capabilities: {
    oauth: true,
    polling: true,
    webhooks: false,
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
        "Read the groups and projects you can see: compute minutes, storage, plan, pipelines, deployments, releases, and merged merge requests. It cannot change anything. It can also read code, issues, and the package and container registries; DevMacro does not.",
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

  buildAuthorizeUrl({ client, state, redirectUri, codeChallenge }) {
    if (codeChallenge === undefined) throw new TypeError("GitLab requires a PKCE S256 code challenge");
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    // Always explicit: never let the granted scopes depend on what an omitted `scope` means.
    url.searchParams.set("scope", SCOPES.join(" "));
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
   * replaces the stored one. The sync runner saves it before anything else runs and never runs
   * two syncs of one connection together (`refreshIfExpiring` in src/lib/jobs/sync-connection.ts).
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
