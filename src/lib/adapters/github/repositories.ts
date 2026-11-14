import { z } from "zod";
import type { ActivityEvent, EventType } from "../events";
import type { AdapterMetric } from "../metrics";
import type { OAuthContext, Secret } from "../types";
import { getJson } from "./api";
import {
  ForksSchema,
  InstallationRepositoriesSchema,
  StargazersCountSchema,
  type Fork,
  type Repository,
} from "./schemas";

/**
 * Stars and forks of the installation's repositories, per docs/providers/github.md
 * ("Which repositories", "Star count", "Forks", "Timeline events").
 *
 * Bounded: one page of 100 repositories per sync and one page of forks per repository. State
 * between polls (daily star baseline, highest milestone fired, newest fork seen) lives in the
 * cursor, so a re-poll with the same cursor and responses yields the same dedupe keys.
 */

export const MAX_REPOSITORIES = 100;
const FORKS_PAGE_SIZE = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export const eventTypeIds = {
  starsDaily: "github.stars.daily",
  starsMilestone: "github.stars.milestone",
  forksNew: "github.forks.new",
} as const;

/** Star metric keys and labels. Exported for the local simulator (#131), so its keys cannot drift. */
export const starMetricNames = {
  repo: (repo: Pick<Repository, "id" | "full_name">) => ({
    metricKey: `github.stars.repo_${repo.id}`,
    label: `Stars on ${repo.full_name}`.slice(0, 120),
  }),
  total: { metricKey: "github.stars.total", label: "Stars across connected repositories" },
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
    id: eventTypeIds.forksNew,
    label: "New fork",
    description: "Someone forked a repository. Who forked it is not collected.",
    shownByDefault: true,
    emoji: "🍴",
  },
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
  repos: Cursor["repos"];
};

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
} {
  const today = now.toISOString().slice(0, 10);
  // First sync: no history, so set the baselines without backfilling events.
  if (previous === undefined) {
    return { events: [], state: { day: today, dayCount: count, milestone: highestMilestone(count) } };
  }
  const events: ActivityEvent[] = [];
  let state = { day: previous.day, dayCount: previous.dayCount, milestone: previous.milestone };

  if (previous.day < today) {
    // The baseline day closed: its net change runs from its first poll to the first poll today.
    // Unstars reduce it, so only a positive net change is an event.
    const net = count - previous.dayCount;
    const dayEnd = new Date(Date.parse(`${previous.day}T00:00:00Z`) + DAY_MS);
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
  return { events, state };
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

  for (const repo of page.repositories.slice(0, MAX_REPOSITORIES)) {
    const repoPath = `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}`;
    const { count } = await getJson(ctx, `${repoPath}/stargazers/count`, installationToken, StargazersCountSchema);
    const forks = await getJson(ctx, `${repoPath}/forks`, installationToken, ForksSchema, {
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
    events.push(...stars.events, ...forked.events);
    repos[String(repo.id)] = { ...stars.state, ...forked.state };
    totalStars += count;

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

  return { metrics, events, repos };
}
