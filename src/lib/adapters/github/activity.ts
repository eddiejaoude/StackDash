import { z } from "zod";
import { InvalidResponseError, PermissionMissingError } from "../errors";
import type { ActivityEvent, EventType } from "../events";
import type { OAuthContext, Secret } from "../types";
import { getRepositoryJson, repositoryEndpoint, type ActivityPermission, type RepositoryPath } from "./api";
import {
  IssuesSchema,
  PullRequestsSchema,
  ReleasesSchema,
  type Issue,
  type PullRequest,
  type Release,
} from "./schemas";

/**
 * Developer activity for the timeline (#62): pull requests merged, issues opened, and releases
 * published, per docs/providers/github.md ("Timeline events"). Webhooks deliver them within a
 * minute (./webhooks.ts); the hourly sync reads the same three lists as the backfill. Both build
 * every event with the functions here, so a delivered event and the same event polled later share
 * a dedupe key and the timeline stores it once.
 *
 * Only a number, a tag, a time, and a link are kept: titles, bodies, and authors are written by
 * people (anyone can open an issue on a public repository), so they never reach an event.
 */

export const activityEventTypeIds = {
  pullRequestMerged: "github.pull_request.merged",
  issueOpened: "github.issue.opened",
  releasePublished: "github.release.published",
} as const;

// Labels, emoji, and wording follow GitLab's merge request and release types (docs/adapters.md, "Events").
export const activityEventTypes: readonly EventType[] = [
  {
    id: activityEventTypeIds.pullRequestMerged,
    label: "Pull request merged",
    description: "A pull request was merged. Only its number is kept, never its title or author.",
    shownByDefault: true,
    emoji: "🔀",
  },
  {
    id: activityEventTypeIds.issueOpened,
    label: "Issue opened",
    description: "An issue was opened. Only its number is kept, never its title or author.",
    shownByDefault: true,
    emoji: "🐛",
  },
  {
    id: activityEventTypeIds.releasePublished,
    label: "Release published",
    description: "A repository published a GitHub release.",
    shownByDefault: true,
    emoji: "📦",
  },
];

/** What an activity event needs of its repository, from the sync's list or a webhook body alike. */
export type ActivityRepository = Readonly<{ id: number; full_name: string; html_url: string }>;

// A tag name can be long; the rest of the title is bounded (a repository's full name is at most
// 140 characters), so the title stays inside the event model's 200.
const TAG_MAX = 40;
const HttpsUrlSchema = z.url({ protocol: /^https$/ });

/** The link when it is https, otherwise none: an event with any other link fails validation. */
export function httpsUrl(value: string): { url: string } | Record<string, never> {
  const parsed = HttpsUrlSchema.safeParse(value);
  return parsed.success ? { url: parsed.data } : {};
}

/** A merged pull request, dated when it was merged. Undefined for one closed without merging. */
export function pullRequestMergedEvent(
  repo: ActivityRepository,
  pullRequest: Pick<PullRequest, "number" | "merged_at" | "html_url">,
  externalAccountId: string,
): ActivityEvent | undefined {
  if (pullRequest.merged_at === null) return undefined;
  return {
    typeId: activityEventTypeIds.pullRequestMerged,
    occurredAt: new Date(pullRequest.merged_at),
    severity: "success",
    title: `Pull request #${pullRequest.number} merged in ${repo.full_name}`,
    externalAccountId,
    dedupeKey: `${activityEventTypeIds.pullRequestMerged}:${repo.id}:${pullRequest.number}`,
    ...httpsUrl(pullRequest.html_url),
  };
}

/** An opened issue, dated when it was opened. */
export function issueOpenedEvent(
  repo: ActivityRepository,
  issue: Pick<Issue, "number" | "created_at" | "html_url">,
  externalAccountId: string,
): ActivityEvent {
  return {
    typeId: activityEventTypeIds.issueOpened,
    occurredAt: new Date(issue.created_at),
    severity: "info",
    title: `Issue #${issue.number} opened in ${repo.full_name}`,
    externalAccountId,
    dedupeKey: `${activityEventTypeIds.issueOpened}:${repo.id}:${issue.number}`,
    ...httpsUrl(issue.html_url),
  };
}

/** A published release, dated when it was published. Undefined for a draft, which is not out yet. */
export function releasePublishedEvent(repo: ActivityRepository, release: Release, externalAccountId: string): ActivityEvent | undefined {
  if (release.draft || release.published_at === null) return undefined;
  const tag = release.tag_name.length > TAG_MAX ? `${release.tag_name.slice(0, TAG_MAX)}…` : release.tag_name;
  return {
    typeId: activityEventTypeIds.releasePublished,
    occurredAt: new Date(release.published_at),
    severity: "success",
    title: `Release ${tag} published in ${repo.full_name}`,
    externalAccountId,
    dedupeKey: `${activityEventTypeIds.releasePublished}:${repo.id}:${release.id}`,
    ...httpsUrl(release.html_url),
  };
}

// One page per list per repository per sync. Webhooks are the primary path, so the hourly read
// only has to catch what a delivery missed: a hundred merges or new issues in one repository
// within a poll is beyond any repository's normal hour, and a fuller page is logged.
export const ACTIVITY_PAGE_SIZE = 100;
// Release pages carry release notes and asset lists, so they are read 30 at a time, GitHub's default.
const RELEASES_PAGE_SIZE = 30;

/** One activity list: the permission it needs, its path, and what it is called in a partial error. */
type ActivityRead = Readonly<{ permission: ActivityPermission; suffix: string; what: string }>;

export const activityReads = {
  pullRequests: { permission: "pull_requests", suffix: "/pulls", what: "merged pull requests" },
  issues: { permission: "issues", suffix: "/issues", what: "opened issues" },
  releases: { permission: "contents", suffix: "/releases", what: "published releases" },
} as const satisfies Record<string, ActivityRead>;

/** The permission a timeline read needs, refused or not granted, as the partial error the sync reports. */
export function activityPermissionError(read: ActivityRead, cause?: PermissionMissingError): PermissionMissingError {
  const endpoint = repositoryEndpoint(read.suffix);
  return new PermissionMissingError(`GitHub ${read.what} from ${endpoint} are unavailable: they need ${read.permission}:read`, [`${read.permission}:read`], {
    endpoint,
    ...(cause === undefined ? {} : { cause, ...(cause.status === undefined ? {} : { status: cause.status }) }),
  });
}

type ReadResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; refused: PermissionMissingError | undefined }>;

/**
 * One activity list. A `403` is a missing permission, reported as a partial error rather than
 * failing the sync, because stars, forks, and billing do not need it. A `404` or `410` (the
 * repository went away, or the feature is turned off for it) gives no events for that repository
 * and is logged by path template. Anything else fails the sync like the other reads.
 */
async function readActivity<T>(read: () => Promise<T>, what: ActivityRead, ctx: OAuthContext): Promise<ReadResult<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (error instanceof PermissionMissingError) return { ok: false, refused: error };
    if (error instanceof InvalidResponseError && (error.status === 404 || error.status === 410)) {
      ctx.logger.warn("github.sync.activity_unavailable", { status: error.status, endpoint: repositoryEndpoint(what.suffix) });
      return { ok: false, refused: undefined };
    }
    throw error;
  }
}

export type ActivityResult = {
  events: ActivityEvent[];
  // Permissions that were granted but refused for this repository.
  refused: Map<ActivityPermission, PermissionMissingError>;
};

/**
 * Reads one repository's activity since `since` with the lists whose permission is `granted`.
 * `since` comes from the cursor: the previous sync less one poll interval, at most a week back.
 */
export async function collectActivity(
  ctx: OAuthContext,
  installationToken: Secret,
  repo: ActivityRepository & RepositoryPath,
  since: Date,
  granted: ReadonlySet<ActivityPermission>,
  externalAccountId: string,
): Promise<ActivityResult> {
  const events: ActivityEvent[] = [];
  const refused = new Map<ActivityPermission, PermissionMissingError>();
  const after = (iso: string) => Date.parse(iso) > since.getTime();
  const truncated = (what: ActivityRead) =>
    ctx.logger.warn("github.sync.activity_truncated", { endpoint: repositoryEndpoint(what.suffix), pageSize: ACTIVITY_PAGE_SIZE });

  if (granted.has(activityReads.pullRequests.permission)) {
    const what = activityReads.pullRequests;
    // Merges are found among closed pull requests by most recent update: a merge updates the pull request.
    const result = await readActivity(
      () =>
        getRepositoryJson(ctx, repo, what.suffix, installationToken, PullRequestsSchema, {
          state: "closed",
          sort: "updated",
          direction: "desc",
          per_page: String(ACTIVITY_PAGE_SIZE),
        }),
      what,
      ctx,
    );
    if (result.ok) {
      for (const pullRequest of result.value) {
        if (pullRequest.merged_at === null || !after(pullRequest.merged_at)) continue;
        const event = pullRequestMergedEvent(repo, pullRequest, externalAccountId);
        if (event !== undefined) events.push(event);
      }
      const last = result.value.at(-1);
      if (result.value.length === ACTIVITY_PAGE_SIZE && last !== undefined && after(last.updated_at)) truncated(what);
    } else if (result.refused !== undefined) {
      refused.set(what.permission, activityPermissionError(what, result.refused));
    }
  }

  if (granted.has(activityReads.issues.permission)) {
    const what = activityReads.issues;
    // `since` filters by last update, which an issue's opening also sets; newest opened first.
    const result = await readActivity(
      () =>
        getRepositoryJson(ctx, repo, what.suffix, installationToken, IssuesSchema, {
          state: "all",
          sort: "created",
          direction: "desc",
          since: since.toISOString(),
          per_page: String(ACTIVITY_PAGE_SIZE),
        }),
      what,
      ctx,
    );
    if (result.ok) {
      for (const issue of result.value) {
        // The issues list holds pull requests too; those are counted when merged instead.
        if (issue.pull_request !== undefined || !after(issue.created_at)) continue;
        events.push(issueOpenedEvent(repo, issue, externalAccountId));
      }
      const last = result.value.at(-1);
      if (result.value.length === ACTIVITY_PAGE_SIZE && last !== undefined && after(last.created_at)) truncated(what);
    } else if (result.refused !== undefined) {
      refused.set(what.permission, activityPermissionError(what, result.refused));
    }
  }

  if (granted.has(activityReads.releases.permission)) {
    const what = activityReads.releases;
    const result = await readActivity(
      () => getRepositoryJson(ctx, repo, what.suffix, installationToken, ReleasesSchema, { per_page: String(RELEASES_PAGE_SIZE) }),
      what,
      ctx,
    );
    if (result.ok) {
      for (const release of result.value) {
        if (release.published_at === null || !after(release.published_at)) continue;
        const event = releasePublishedEvent(repo, release, externalAccountId);
        if (event !== undefined) events.push(event);
      }
    } else if (result.refused !== undefined) {
      refused.set(what.permission, activityPermissionError(what, result.refused));
    }
  }

  return { events, refused };
}
