import { z } from "zod";
import { InvalidResponseError, PermissionMissingError } from "../errors";
import type { ActivityEvent, EventType } from "../events";
import type { OAuthContext, Secret } from "../types";
import { getRepositoryJson, repositoryEndpoint, type RepositoryPath } from "./api";
import {
  IssuesSchema,
  PullRequestsSchema,
  RepositoryEventsSchema,
  type Issue,
  type PullRequest,
  type Release,
} from "./schemas";

/**
 * Developer activity for the timeline (#62): pull requests merged, issues opened, and releases
 * published, per docs/providers/github.md ("Timeline events"). Webhooks deliver merges and issues
 * within a minute (./webhooks.ts), and the hourly sync reads the same lists as the backfill.
 * Releases are polled only, from the repository events feed: the `release` webhook and the release
 * list need Contents read, which also reads code, and the feed needs only Metadata read (decided by
 * Eddie on #62). Both paths build every event with the functions here, so a delivered event and the
 * same event polled later share a dedupe key and the timeline stores it once.
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

// A title is `Release `, the tag, ` published in `, and the repository's full name, which GitHub caps
// at 140 characters (a 39 character owner, a slash, and a 100 character name). 8 + 14 + 140 leaves 38
// of the event model's 200 for the tag: 37 and the ellipsis. The model counts UTF-16 units (a
// JavaScript string's length), so the tag is bounded in those, and cut only between code points.
export const TAG_MAX = 37;
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
  // Whole code points while they fit, so a tag is never left ending in half of a surrogate pair.
  let tag = "";
  for (const codePoint of release.tag_name) {
    if (tag.length + codePoint.length > TAG_MAX) break;
    tag += codePoint;
  }
  if (tag.length < release.tag_name.length) tag += "…";
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

// One page per list per repository per sync. Webhooks are the primary path for pull requests and
// issues, so the hourly read only has to catch what a delivery missed, and a fuller page is logged.
// Closed pull requests have no `since` filter, so every busy repository returns a full page every
// hour whether or not anything merged, and a page of 100 is 2 to 3 MB (measured on #62): they are
// read 30 at a time, GitHub's default. Issues are filtered by `since`, so their page stays small.
const PULLS_PAGE_SIZE = 30;
const ISSUES_PAGE_SIZE = 100;
// The events feed holds every event type and at most 300 events from the last 30 days ("REST API
// endpoints for events"), so a busy repository can need all three of its pages to reach back to
// the read window.
const EVENTS_PAGE_SIZE = 100;
const EVENTS_MAX_PAGES = 3;
// GitHub: "This API is not built to serve real-time use cases. Depending on the time of day, event
// latency can be anywhere from 30s to 6h." The feed is read back that much further than the other
// lists, so a release that reached the feed late is still inside the window; the dedupe key absorbs
// the overlap.
const EVENTS_FEED_LATENCY_MS = 6 * 60 * 60 * 1000;

/** One activity list: the permission it needs, its path, and what it is called in a partial error. */
type ActivityRead = Readonly<{ permission: string; suffix: string; what: string }>;

export const activityReads = {
  pullRequests: { permission: "pull_requests", suffix: "/pulls", what: "merged pull requests" },
  issues: { permission: "issues", suffix: "/issues", what: "opened issues" },
  releases: { permission: "metadata", suffix: "/events", what: "published releases" },
} as const satisfies Record<string, ActivityRead>;
export type ActivityList = keyof typeof activityReads;
export const activityLists = Object.keys(activityReads) as ActivityList[];

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
  refused: Map<string, PermissionMissingError>;
  // The lists that were read, so only their read times move on.
  read: Set<ActivityList>;
};

/**
 * Reads one repository's activity with the lists whose permission is `granted`, each from its own
 * `since` (repositories.ts: the list's previous read less one poll interval, at most a week back).
 */
export async function collectActivity(
  ctx: OAuthContext,
  installationToken: Secret,
  repo: ActivityRepository & RepositoryPath,
  since: Readonly<Record<ActivityList, Date>>,
  granted: ReadonlySet<string>,
  externalAccountId: string,
): Promise<ActivityResult> {
  const events: ActivityEvent[] = [];
  const refused = new Map<string, PermissionMissingError>();
  const read = new Set<ActivityList>();
  const truncated = (what: ActivityRead, pageSize: number) =>
    ctx.logger.warn("github.sync.activity_truncated", { endpoint: repositoryEndpoint(what.suffix), pageSize });
  const settle = <T>(list: ActivityList, result: ReadResult<T>) => {
    if (result.ok) read.add(list);
    else if (result.refused !== undefined) refused.set(activityReads[list].permission, activityPermissionError(activityReads[list], result.refused));
    // Gone or turned off for this repository (404 or 410): nothing to read, so the read is done.
    else read.add(list);
  };

  if (granted.has(activityReads.pullRequests.permission)) {
    const what = activityReads.pullRequests;
    const after = (iso: string) => Date.parse(iso) > since.pullRequests.getTime();
    // Merges are found among closed pull requests by most recent update: a merge updates the pull request.
    const result = await readActivity(
      () =>
        getRepositoryJson(ctx, repo, what.suffix, installationToken, PullRequestsSchema, {
          state: "closed",
          sort: "updated",
          direction: "desc",
          per_page: String(PULLS_PAGE_SIZE),
        }),
      what,
      ctx,
    );
    settle("pullRequests", result);
    if (result.ok) {
      for (const pullRequest of result.value) {
        if (pullRequest.merged_at === null || !after(pullRequest.merged_at)) continue;
        const event = pullRequestMergedEvent(repo, pullRequest, externalAccountId);
        if (event !== undefined) events.push(event);
      }
      const last = result.value.at(-1);
      if (result.value.length === PULLS_PAGE_SIZE && last !== undefined && after(last.updated_at)) truncated(what, PULLS_PAGE_SIZE);
    }
  }

  if (granted.has(activityReads.issues.permission)) {
    const what = activityReads.issues;
    const after = (iso: string) => Date.parse(iso) > since.issues.getTime();
    // `since` filters by last update, which an issue's opening also sets; newest opened first.
    const result = await readActivity(
      () =>
        getRepositoryJson(ctx, repo, what.suffix, installationToken, IssuesSchema, {
          state: "all",
          sort: "created",
          direction: "desc",
          since: since.issues.toISOString(),
          per_page: String(ISSUES_PAGE_SIZE),
        }),
      what,
      ctx,
    );
    settle("issues", result);
    if (result.ok) {
      for (const issue of result.value) {
        // The issues list holds pull requests too; those are counted when merged instead.
        if (issue.pull_request !== undefined || !after(issue.created_at)) continue;
        events.push(issueOpenedEvent(repo, issue, externalAccountId));
      }
      const last = result.value.at(-1);
      if (result.value.length === ISSUES_PAGE_SIZE && last !== undefined && after(last.created_at)) truncated(what, ISSUES_PAGE_SIZE);
    }
  }

  if (granted.has(activityReads.releases.permission)) {
    const what = activityReads.releases;
    const releasesSince = since.releases.getTime() - EVENTS_FEED_LATENCY_MS;
    for (let page = 1; page <= EVENTS_MAX_PAGES; page += 1) {
      const result = await readActivity(
        () =>
          getRepositoryJson(ctx, repo, what.suffix, installationToken, RepositoryEventsSchema, {
            per_page: String(EVENTS_PAGE_SIZE),
            page: String(page),
          }),
        what,
        ctx,
      );
      if (!result.ok) {
        settle("releases", result);
        break;
      }
      for (const feedEvent of result.value) {
        // Only a `ReleaseEvent` carries a payload (RepositoryEventsSchema); `published` is its only action.
        if (!("payload" in feedEvent) || feedEvent.payload.action !== "published") continue;
        const { release } = feedEvent.payload;
        if (release.published_at === null || Date.parse(release.published_at) <= releasesSince) continue;
        const event = releasePublishedEvent(repo, release, externalAccountId);
        if (event !== undefined) events.push(event);
      }
      const last = result.value.at(-1);
      // Newest first: a short page, or one reaching back past the window, is the end of the read.
      const done = result.value.length < EVENTS_PAGE_SIZE || last === undefined || Date.parse(last.created_at) <= releasesSince;
      if (!done && page === EVENTS_MAX_PAGES) truncated(what, EVENTS_PAGE_SIZE);
      if (done || page === EVENTS_MAX_PAGES) {
        settle("releases", result);
        break;
      }
    }
  }

  return { events, refused, read };
}
