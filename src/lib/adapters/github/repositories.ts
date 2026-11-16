import { z } from "zod";
import type { PermissionMissingError } from "../errors";
import type { ActivityEvent, EventType } from "../events";
import type { AdapterMetric } from "../metrics";
import type { OAuthContext, Secret } from "../types";
import { activityEventTypes, activityPermissionError, activityReads, collectActivity, httpsUrl, type ActivityRepository } from "./activity";
import { activityPermissions, getJson, getRepositoryJson, grantsRead, type ActivityPermission } from "./api";
import {
  ForksSchema,
  InstallationRepositoriesSchema,
  StargazersCountSchema,
  type Fork,
  type Installation,
  type Repository,
} from "./schemas";

/**
 * Stars, forks, and activity of the installation's repositories, per docs/providers/github.md
 * ("Which repositories", "Star count", "Forks", "Timeline events").
 *
 * Bounded: one page of 100 repositories per sync, one page of forks per repository, and one page
 * of each activity list (./activity.ts). State between polls (daily star baseline, highest
 * milestone fired, newest fork seen, when activity was last read) lives in the cursor, so a
 * re-poll with the same cursor and responses yields the same dedupe keys.
 */

export const MAX_REPOSITORIES = 100;
const FORKS_PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
// Activity on the first sync, or after a long gap, is read back a week at most: the backfill
// window docs/adapters.md asks for. Later syncs read back to the previous sync less one poll
// interval, so an item GitHub listed late is still caught; the dedupe key absorbs the overlap.
const ACTIVITY_BACKFILL_MS = 7 * DAY_MS;
/** How often GitHub is polled: the adapter's `pollIntervalSeconds`. */
export const POLL_INTERVAL_SECONDS = 3600;
// A repository's baseline is its count at the first sync of a day, and the first sync of the next
// day closes it, so a late close (a connection waiting in needs_attention, a job runner down across
// midnight) folds the next day's stars into the closed one: up to ~48 hours read as one day. That
// could earn Trending, Weekend stargazers, or Steady glow for a day with no new star. So a closed
// day produces its `github.stars.daily` event and adds to `github.stars.gained.daily` only when the
// closing sync ran within two poll intervals of the day's end (one missed or slow poll), and neither
// ever covers more than 26 hours. A later close leaves the day without either (the stars still show
// in the star counts), so it undercounts a day and never overclaims one.
// Decided by Eddie on #413.
const DAY_CLOSE_MAX_DELAY_MS = 2 * POLL_INTERVAL_SECONDS * 1000;

export const eventTypeIds = {
  starsDaily: "github.stars.daily",
  starsMilestone: "github.stars.milestone",
  starsNew: "github.stars.new",
  forksNew: "github.forks.new",
} as const;

/** Star metric keys and labels. Exported for the local simulator (#131), so its keys cannot drift. */
export const starMetricNames = {
  repo: (repo: Pick<Repository, "id" | "full_name">) => ({
    metricKey: `github.stars.repo_${repo.id}`,
    label: `Stars on ${repo.full_name}`.slice(0, 120),
  }),
  total: { metricKey: "github.stars.total", label: "Stars across connected repositories" },
  // A daily total (`ProviderAdapter.dailyTotals`): its timeframe carries the UTC day it counts, so
  // the label holds on any day the dashboard shows.
  gainedDaily: { metricKey: "github.stars.gained.daily", label: "New stars over one UTC day" },
} as const;

export const eventTypes: readonly EventType[] = [
  {
    id: eventTypeIds.starsDaily,
    label: "New stars",
    description: "Net new stars on a repository over one UTC day, from hourly star count snapshots.",
    shownByDefault: true,
    emoji: "⭐",
  },
  {
    id: eventTypeIds.starsMilestone,
    label: "Star milestone",
    description: "A repository reached 100, 500, 1,000, or another multiple of 1,000 stars.",
    shownByDefault: true,
    emoji: "🌟",
  },
  {
    // Webhook only (#62): GitHub sends `star` with the time and the stargazer, and the stargazer
    // list that could backfill it is restricted and personal (docs/providers/github.md).
    id: eventTypeIds.starsNew,
    label: "Repository starred",
    description: "Someone starred a repository, sent by GitHub as it happens. Who starred it is not collected.",
    shownByDefault: true,
    emoji: "⭐",
  },
  {
    id: eventTypeIds.forksNew,
    label: "New fork",
    description: "Someone forked a repository. Who forked it is not collected.",
    shownByDefault: true,
    emoji: "🍴",
  },
  ...activityEventTypes,
];

const RepoStateSchema = z.object({
  // UTC day of the baseline and the star count at the first poll of that day.
  day: z.iso.date(),
  dayCount: z.int().nonnegative(),
  // Highest milestone already fired (0 when none), so a dip and recovery never fires it again.
  milestone: z.int().nonnegative(),
  // Creation time of the newest fork seen, and the fork ids created at exactly that time.
  forksSeenAt: z.iso.datetime({ offset: true }).nullable(),
  forkIdsAtSeenAt: z.array(z.int().positive()),
});
type RepoState = z.infer<typeof RepoStateSchema>;

export const CursorSchema = z.object({
  v: z.literal(1),
  repos: z.record(z.string(), RepoStateSchema),
  // When the previous sync read activity (./activity.ts). Absent before #62 and on a first sync.
  activityReadAt: z.iso.datetime({ offset: true }).optional(),
});
export type Cursor = z.infer<typeof CursorSchema>;

/** 100, 500, 1000, then every further 1000. Returns milestones in (after, upTo], ascending. */
export function starMilestones(after: number, upTo: number): number[] {
  const milestones: number[] = [];
  for (const fixed of [100, 500]) if (fixed > after && fixed <= upTo) milestones.push(fixed);
  for (let thousand = Math.max(1000, (Math.floor(after / 1000) + 1) * 1000); thousand <= upTo; thousand += 1000) {
    milestones.push(thousand);
  }
  return milestones;
}

function highestMilestone(count: number): number {
  return starMilestones(0, count).at(-1) ?? 0;
}

export type RepositoriesResult = {
  metrics: AdapterMetric[];
  events: ActivityEvent[];
  cursor: Cursor;
  // An activity list the installation has not been granted, or that GitHub refused.
  partialErrors: PermissionMissingError[];
};

/**
 * One star, from a `star` delivery (./webhooks.ts). Dated and deduplicated by `starred_at`, so a
 * redelivery stores it once; the stargazer is never read.
 */
export function newStarEvent(repo: ActivityRepository, starredAt: Date, externalAccountId: string): ActivityEvent {
  return {
    typeId: eventTypeIds.starsNew,
    occurredAt: starredAt,
    severity: "info",
    title: `New star on ${repo.full_name}`,
    externalAccountId,
    dedupeKey: `${eventTypeIds.starsNew}:${repo.id}:${starredAt.toISOString()}`,
    ...httpsUrl(repo.html_url),
  };
}

/** Where this sync's activity reads start: see ACTIVITY_BACKFILL_MS. */
export function activitySince(previousReadAt: string | undefined, now: Date): Date {
  const backfill = now.getTime() - ACTIVITY_BACKFILL_MS;
  if (previousReadAt === undefined) return new Date(backfill);
  const overlapped = Date.parse(previousReadAt) - POLL_INTERVAL_SECONDS * 1000;
  // A read time from the future means the clock moved back: read the last poll interval again.
  return new Date(Math.max(backfill, Math.min(overlapped, now.getTime() - POLL_INTERVAL_SECONDS * 1000)));
}

type RepoContext = Readonly<{
  repo: Repository;
  count: number;
  forks: readonly Fork[];
  previous: RepoState | undefined;
  externalAccountId: string;
  now: Date;
}>;

function starEvents({ repo, count, previous, externalAccountId, now }: RepoContext): {
  events: ActivityEvent[];
  state: Pick<RepoState, "day" | "dayCount" | "milestone">;
  // The repository's new stars over yesterday (UTC): its net change from the baseline taken
  // yesterday to this sync, or 0 when not positive. Set only when this sync closed a baseline taken
  // yesterday within `DAY_CLOSE_MAX_DELAY_MS` of midnight. Undefined on a first sync (no baseline),
  // for a later close, and for an older baseline (missed syncs), whose net spans more than one day.
  yesterdayGain: number | undefined;
} {
  const today = now.toISOString().slice(0, 10);
  // First sync: no history, so set the baselines without backfilling events.
  if (previous === undefined) {
    return { events: [], state: { day: today, dayCount: count, milestone: highestMilestone(count) }, yesterdayGain: undefined };
  }
  const events: ActivityEvent[] = [];
  let state = { day: previous.day, dayCount: previous.dayCount, milestone: previous.milestone };
  let yesterdayGain: number | undefined;

  if (previous.day < today) {
    // The baseline day closed: its net change runs from its first poll to the first poll today.
    // Unstars reduce it, so only a positive net change is an event. Only a close soon after the day
    // ended covers about one UTC day (`DAY_CLOSE_MAX_DELAY_MS`); a later one, or an older baseline,
    // gives no event and adds to no day's total. A loss adds 0 rather than cancelling another
    // repository's gain.
    const net = count - previous.dayCount;
    const dayEnd = new Date(Date.parse(`${previous.day}T00:00:00Z`) + DAY_MS);
    if (now.getTime() - dayEnd.getTime() <= DAY_CLOSE_MAX_DELAY_MS) {
      if (net > 0) {
        events.push({
          typeId: eventTypeIds.starsDaily,
          occurredAt: dayEnd,
          severity: "info",
          title: `${repo.full_name} gained ${net} ${net === 1 ? "star" : "stars"} on ${previous.day}`,
          externalAccountId,
          dedupeKey: `${eventTypeIds.starsDaily}:${repo.id}:${previous.day}`,
          url: repo.html_url,
        });
      }
      yesterdayGain = Math.max(net, 0);
    }
    state = { ...state, day: today, dayCount: count };
  } else if (previous.day > today) {
    // A baseline from the future means the clock moved back; start the day again.
    state = { ...state, day: today, dayCount: count };
  }

  for (const milestone of starMilestones(previous.milestone, count)) {
    events.push({
      typeId: eventTypeIds.starsMilestone,
      occurredAt: now,
      severity: "success",
      title: `${repo.full_name} reached ${milestone.toLocaleString("en-GB")} stars`,
      externalAccountId,
      dedupeKey: `${eventTypeIds.starsMilestone}:${repo.id}:${milestone}`,
      url: repo.html_url,
    });
    state = { ...state, milestone };
  }
  return { events, state, yesterdayGain };
}

function forkEvents({ repo, forks, previous, externalAccountId }: RepoContext): {
  events: ActivityEvent[];
  state: Pick<RepoState, "forksSeenAt" | "forkIdsAtSeenAt">;
} {
  let newestAt: number | undefined;
  for (const fork of forks) {
    const createdAt = Date.parse(fork.created_at);
    if (newestAt === undefined || createdAt > newestAt) newestAt = createdAt;
  }
  const state =
    newestAt === undefined
      ? { forksSeenAt: previous?.forksSeenAt ?? null, forkIdsAtSeenAt: previous?.forkIdsAtSeenAt ?? [] }
      : {
          forksSeenAt: new Date(newestAt).toISOString(),
          forkIdsAtSeenAt: forks.filter((fork) => Date.parse(fork.created_at) === newestAt).map((fork) => fork.id),
        };
  // First sync sets the baseline without reporting old forks.
  if (previous === undefined) return { events: [], state };

  const seenAt = previous.forksSeenAt === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.forksSeenAt);
  const seenIds = new Set(previous.forkIdsAtSeenAt);
  if (newestAt !== undefined && newestAt < seenAt) {
    // Newest fork older than the baseline (forks deleted): keep the baseline.
    return { events: [], state: { forksSeenAt: previous.forksSeenAt, forkIdsAtSeenAt: previous.forkIdsAtSeenAt } };
  }
  const events = forks
    .filter((fork) => {
      const createdAt = Date.parse(fork.created_at);
      return createdAt > seenAt || (createdAt === seenAt && !seenIds.has(fork.id));
    })
    .map(
      (fork): ActivityEvent => ({
        typeId: eventTypeIds.forksNew,
        occurredAt: new Date(fork.created_at),
        severity: "info",
        title: `New fork of ${repo.full_name}`,
        externalAccountId,
        // Fork id only: the fork's name carries its owner's login, which is personal data.
        dedupeKey: `${eventTypeIds.forksNew}:${repo.id}:${fork.id}`,
        url: `${repo.html_url}/forks`,
      }),
    );
  return { events, state };
}

export async function collectRepositories(
  ctx: OAuthContext,
  installationToken: Secret,
  installation: Installation,
  externalAccountId: string,
  previous: Cursor | undefined,
): Promise<RepositoriesResult> {
  const page = await getJson(ctx, "/installation/repositories", installationToken, InstallationRepositoriesSchema, {
    per_page: String(MAX_REPOSITORIES),
    page: "1",
  });
  if (page.total_count > MAX_REPOSITORIES) {
    ctx.logger.warn("github.sync.repositories_truncated", {
      totalCount: page.total_count,
      readCount: page.repositories.length,
    });
  }

  const now = ctx.now();
  const metrics: AdapterMetric[] = [];
  const events: ActivityEvent[] = [];
  const repos: Cursor["repos"] = {};
  let totalStars = 0;
  // Yesterday's new stars across the repositories whose baseline from yesterday this sync closed
  // soon after midnight; undefined when none did (nothing to report, so no reading is written).
  let starsGainedYesterday: number | undefined;
  const since = activitySince(previous?.activityReadAt, now);
  const granted = new Set<ActivityPermission>(activityPermissions.filter((permission) => grantsRead(installation, permission)));
  // One partial error per permission, however many repositories it was missing on.
  const partialErrors = new Map<ActivityPermission, PermissionMissingError>();
  for (const read of Object.values(activityReads)) {
    if (!granted.has(read.permission)) partialErrors.set(read.permission, activityPermissionError(read));
  }

  for (const repo of page.repositories.slice(0, MAX_REPOSITORIES)) {
    const { count } = await getRepositoryJson(ctx, repo, "/stargazers/count", installationToken, StargazersCountSchema);
    const forks = await getRepositoryJson(ctx, repo, "/forks", installationToken, ForksSchema, {
      sort: "newest",
      per_page: String(FORKS_PAGE_SIZE),
    });
    const repoContext: RepoContext = {
      repo,
      count,
      forks,
      previous: previous?.repos[String(repo.id)],
      externalAccountId,
      now,
    };
    const stars = starEvents(repoContext);
    const forked = forkEvents(repoContext);
    const activity = await collectActivity(ctx, installationToken, repo, since, granted, externalAccountId);
    events.push(...stars.events, ...forked.events, ...activity.events);
    for (const [permission, error] of activity.refused) if (!partialErrors.has(permission)) partialErrors.set(permission, error);
    repos[String(repo.id)] = { ...stars.state, ...forked.state };
    totalStars += count;
    if (stars.yesterdayGain !== undefined) starsGainedYesterday = (starsGainedYesterday ?? 0) + stars.yesterdayGain;

    metrics.push({
      kind: "usage",
      ...starMetricNames.repo(repo),
      value: count,
      unit: "stars",
      timeframe: { type: "point", at: now },
      externalAccountId,
      retrievedAt: now,
      provenance: { source: "provider_api", endpoint: "/repos/{owner}/{repo}/stargazers/count" },
    });
  }

  metrics.push({
    kind: "usage",
    ...starMetricNames.total,
    value: totalStars,
    unit: "stars",
    timeframe: { type: "point", at: now },
    externalAccountId,
    retrievedAt: now,
    provenance: { source: "provider_api", endpoint: "/repos/{owner}/{repo}/stargazers/count" },
  });

  if (starsGainedYesterday !== undefined) {
    // Shaped like PostHog's daily signups: a period of one whole UTC day, stored in today's row,
    // so a `daily_total_threshold` rule dates it to yesterday. A repository added to the
    // installation starts from a baseline, so its existing stars never count as new.
    const dayStart = Date.parse(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`) - DAY_MS;
    metrics.push({
      kind: "usage",
      ...starMetricNames.gainedDaily,
      value: starsGainedYesterday,
      unit: "stars",
      timeframe: { type: "period", start: new Date(dayStart), end: new Date(dayStart + DAY_MS) },
      externalAccountId,
      retrievedAt: now,
      provenance: { source: "provider_api", endpoint: "/repos/{owner}/{repo}/stargazers/count" },
    });
  }

  return {
    metrics,
    events,
    cursor: { v: 1, repos, activityReadAt: now.toISOString() },
    partialErrors: [...partialErrors.values()],
  };
}
