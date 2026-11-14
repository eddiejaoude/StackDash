import { formatQuantity } from "@/lib/format";
import { MAX_ROWS_PER_REQUEST, readAllPages } from "@/lib/supabase/paging";

import { countsProvider, DEPLOYMENT_OUTCOMES, publicMetricDefinition, type PublicMetricId } from "./definitions";
import {
  computePublicMetrics,
  snapshotsWholeFrom,
  STALE_AFTER_MS,
  type ComputedMetric,
  type PublicMetricStore,
  type SnapshotPoint,
  type StoredEvent,
} from "./engine";

/*
 * The history of published metrics and the milestones derived from it (#150). Every point is the
 * engine's own value at that moment, computed by `computePublicMetrics` with the same formulas as
 * the current value, so a history never shows a number the engine would not publish at that time.
 *
 * Computing 90 moments one by one would read the database hundreds of times, so the moments are
 * computed against `preloadHistoryStore`: a read-through cache that loads the snapshots and events
 * the window needs once, answers every query it fully covers from memory, and passes anything else
 * (a window older than what it loaded) to the real store. An answer is therefore always the real
 * store's answer; the cache only saves reads.
 */

export const HISTORY_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Events loaded at most, in pages of one request each. Older windows fall back to the real store. */
export const HISTORY_EVENT_ROWS = 5 * MAX_ROWS_PER_REQUEST;

/** A stored event with the id the cache deduplicates it by. */
export type HistoryEvent = StoredEvent & Readonly<{ id: string }>;

/** A metric store that can also page through events, newest first, for the history cache. */
export interface HistoryStore extends PublicMetricStore {
  /** Events of `typeIds` with `occurred_at <= before`, newest first (then id), from `offset`. */
  eventPage(query: Readonly<{ accountIds: readonly string[]; typeIds: readonly string[]; before: Date; offset: number; limit: number }>): Promise<readonly HistoryEvent[]>;
}

function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/** One moment per day, oldest first, ending at `asOf`. */
export function historyMoments(asOf: Date, days: number = HISTORY_DAYS): Date[] {
  return Array.from({ length: days }, (_, index) => new Date(asOf.getTime() - (days - 1 - index) * DAY_MS));
}

/** Metric keys and event types a definition reads. */
function sourceReads(metricId: PublicMetricId): Readonly<{ metricKeys: string[]; typeIds: string[] }> {
  const { source } = publicMetricDefinition(metricId);
  switch (source.type) {
    case "snapshot_total":
    case "snapshot_change":
      return { metricKeys: [source.metricKey], typeIds: [] };
    case "snapshot_percent":
      return { metricKeys: [source.numeratorKey, source.denominatorKey], typeIds: [] };
    case "event_count":
      return { metricKeys: [], typeIds: [...source.typeIds] };
    case "event_streak":
      return { metricKeys: [], typeIds: [source.successTypeId, source.failureTypeId] };
  }
}

/**
 * A read-through cache over `base` for computing `metricIds` at moments between `from` and `to`.
 * Snapshots are loaded per key back to the oldest day any formula reads; events newest first from
 * `to`, up to `HISTORY_EVENT_ROWS`. A read that stopped at its bound may be cut short, so its
 * oldest day (or moment) is treated as not loaded. Queries inside what was loaded are answered
 * from memory with the real store's filters; the rest go to `base`.
 */
export async function preloadHistoryStore(
  base: HistoryStore,
  metricIds: readonly PublicMetricId[],
  from: Date,
  to: Date,
): Promise<PublicMetricStore> {
  const accounts = await base.accounts();
  const accountIds = accounts.map((account) => account.accountId);
  const reads = metricIds.map(sourceReads);
  const metricKeys = [...new Set(reads.flatMap((read) => read.metricKeys))];
  const typeIds = [...new Set(reads.flatMap((read) => read.typeIds))];
  const longestWindowDays = Math.max(0, ...metricIds.map((id) => publicMetricDefinition(id).windowDays));
  const fromDate = utcDate(new Date(Math.min(from.getTime() - longestWindowDays * DAY_MS, from.getTime() - STALE_AFTER_MS)));
  const toDate = utcDate(to);

  const loadEvents = async (): Promise<{ events: HistoryEvent[]; complete: boolean }> => {
    if (accountIds.length === 0 || typeIds.length === 0) return { events: [], complete: true };
    const { rows, complete } = await readAllPages(
      (offset, last) => base.eventPage({ accountIds, typeIds, before: to, offset, limit: last - offset + 1 }),
      HISTORY_EVENT_ROWS,
    );
    // An event written while the pages were read shifts the later pages, so one can come twice.
    const byId = new Map(rows.map((row) => [row.id, row]));
    return { events: [...byId.values()], complete };
  };

  const [snapshotReads, eventRead] = await Promise.all([
    Promise.all(metricKeys.map((metricKey) => base.snapshots({ accountIds, metricKeys: [metricKey], fromDate, toDate }))),
    loadEvents(),
  ]);

  const points: SnapshotPoint[] = [];
  /** Per key, the oldest snapshot day loaded in full. */
  const snapshotsFrom = new Map<string, string>();
  metricKeys.forEach((metricKey, index) => {
    const rows = snapshotReads[index] ?? [];
    points.push(...rows);
    snapshotsFrom.set(metricKey, snapshotsWholeFrom(rows) ?? fromDate);
  });

  const events = [...eventRead.events].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  const oldestEvent = events.at(-1);
  // Every event at or before `to` is loaded, or every event after the oldest moment loaded.
  const eventsFrom = eventRead.complete || oldestEvent === undefined ? null : oldestEvent.occurredAt.getTime() + 1;
  const loadedTypes = new Set(typeIds);
  const typesLoaded = (ids: readonly string[]) => ids.every((id) => loadedTypes.has(id));
  const matching = (ids: readonly string[], types: readonly string[]) =>
    events.filter((event) => ids.includes(event.accountId) && types.includes(event.typeId));

  const earliest = new Map<string, Promise<Date | null>>();

  return {
    accounts: async () => accounts,

    async snapshots(query) {
      const covered =
        query.toDate <= toDate &&
        query.metricKeys.every((metricKey) => {
          const loadedFrom = snapshotsFrom.get(metricKey);
          return loadedFrom !== undefined && query.fromDate >= loadedFrom;
        });
      if (!covered) return base.snapshots(query);
      return points.filter(
        (point) =>
          query.accountIds.includes(point.accountId) &&
          query.metricKeys.includes(point.metricKey) &&
          point.snapshotDate >= query.fromDate &&
          point.snapshotDate <= query.toDate,
      );
    },

    async countEvents(query) {
      const covered =
        typesLoaded(query.typeIds) &&
        query.to.getTime() <= to.getTime() &&
        (eventsFrom === null || query.from.getTime() >= eventsFrom);
      if (!covered) return base.countEvents(query);
      return matching(query.accountIds, query.typeIds).filter(
        (event) => event.occurredAt.getTime() >= query.from.getTime() && event.occurredAt.getTime() < query.to.getTime(),
      ).length;
    },

    // Only the yearly card (#151) asks for the oldest snapshot day, never a history, so it passes
    // straight through.
    earliestSnapshotDate: (query) => base.earliestSnapshotDate(query),

    // Not windowed, so it is read from the real store once per account set and type set.
    earliestEvent(query) {
      const key = JSON.stringify([[...query.accountIds].sort(), [...query.typeIds].sort()]);
      let pending = earliest.get(key);
      if (pending === undefined) {
        pending = base.earliestEvent(query);
        earliest.set(key, pending);
      }
      return pending;
    },

    async recentEvents(query) {
      if (!typesLoaded(query.typeIds) || query.before.getTime() > to.getTime()) return base.recentEvents(query);
      const { since } = query;
      const recent = matching(query.accountIds, query.typeIds).filter(
        (event) => event.occurredAt.getTime() <= query.before.getTime() && (since === undefined || event.occurredAt.getTime() >= since.getTime()),
      );
      // Enough loaded events before `before`, or every event there is (since `since`): the real store's answer.
      if (recent.length >= query.limit || eventsFrom === null || (since !== undefined && since.getTime() >= eventsFrom)) {
        return recent.slice(0, query.limit).map(({ accountId, typeId, occurredAt }) => ({ accountId, typeId, occurredAt }));
      }
      return base.recentEvents(query);
    },
  };
}

export type HistoryRequest = Readonly<{ metricId: PublicMetricId; asOf: Date }>;

/**
 * Each request's metric at `days` daily moments ending at its `asOf`, oldest first. The newest
 * point is the request's own value. One metric is computed at a time, so a fallback to the real
 * store never sends more than `days` reads at once.
 */
export async function computeMetricHistories(
  base: HistoryStore,
  requests: readonly HistoryRequest[],
  days: number = HISTORY_DAYS,
): Promise<ComputedMetric[][]> {
  if (requests.length === 0) return [];
  const moments = requests.map((request) => historyMoments(request.asOf, days));
  const from = new Date(Math.min(...moments.map((list) => list[0]?.getTime() ?? Number.POSITIVE_INFINITY)));
  const to = new Date(Math.max(...requests.map((request) => request.asOf.getTime())));
  const store = await preloadHistoryStore(
    base,
    requests.map((request) => request.metricId),
    from,
    to,
  );
  const histories: ComputedMetric[][] = [];
  for (const [index, request] of requests.entries()) {
    const list = moments[index] ?? [];
    histories.push(await computePublicMetrics(store, list.map((asOf) => ({ metricId: request.metricId, asOf }))));
  }
  return histories;
}

export type Milestone = Readonly<{
  /** Stable key, for example `first-deployment` or `github-stars-1000`. */
  id: string;
  title: string;
  at: Date;
}>;

/**
 * "First ... recorded" milestones: the oldest stored event of a kind, shown only while a metric
 * counting those events is published exactly. "Recorded" because providers backfill a limited
 * history, so the oldest event StackDash has may not be the very first.
 */
const FIRST_EVENT_MILESTONES: readonly Readonly<{
  id: string;
  title: string;
  /**
   * Published metrics that reveal these events; the first one's success events are read, from the
   * accounts of the providers it counts (every deployment provider for the deployment counts).
   */
  metricIds: readonly PublicMetricId[];
}>[] = [
  { id: "first-deployment", title: "First deployment recorded", metricIds: ["vercel-deployments-7d", "vercel-deployments-30d", "vercel-deployment-streak"] },
  { id: "first-signup", title: "First signup recorded", metricIds: ["supabase-signups-7d", "supabase-signups-30d"] },
  { id: "first-customer", title: "First customer recorded", metricIds: ["stripe-customers-30d"] },
  { id: "first-payment", title: "First successful payment recorded", metricIds: ["stripe-payments-30d"] },
];

function successTypeIds(metricId: PublicMetricId): readonly string[] {
  const { source } = publicMetricDefinition(metricId);
  if (source.type === "event_count") return source.typeIds;
  if (source.type === "event_streak") return [source.successTypeId];
  return [];
}

/**
 * The first-event milestones of the published metrics. `published` lists each published engine
 * metric with the moment it describes and the step its rounding rounds down to. Only a publication
 * that can show a single event (step 1) reveals a milestone: a rounded one can publish 0 while
 * events exist, and a milestone must not say what the rounding hides. An event after the revealing
 * publications' moment is never shown, so a delayed publication stays delayed here too.
 */
export async function firstEventMilestones(
  store: PublicMetricStore,
  published: readonly Readonly<{ metricId: PublicMetricId; asOf: Date; roundingStep: number }>[],
): Promise<Milestone[]> {
  const candidates = FIRST_EVENT_MILESTONES.flatMap((milestone) => {
    const revealing = published.filter((entry) => entry.roundingStep === 1 && milestone.metricIds.includes(entry.metricId));
    const first = revealing[0];
    if (first === undefined) return [];
    const asOf = new Date(Math.max(...revealing.map((entry) => entry.asOf.getTime())));
    return [{ milestone, asOf, typeIds: successTypeIds(first.metricId), definition: publicMetricDefinition(first.metricId) }];
  });
  if (candidates.length === 0) return [];
  const accounts = await store.accounts();
  const found = await Promise.all(
    candidates.map(async ({ milestone, asOf, typeIds, definition }): Promise<Milestone | null> => {
      const accountIds = accounts.filter((account) => countsProvider(definition, account.provider)).map((account) => account.accountId);
      if (accountIds.length === 0) return null;
      const at = await store.earliestEvent({ accountIds, typeIds });
      return at !== null && at.getTime() <= asOf.getTime() ? { id: milestone.id, title: milestone.title, at } : null;
    }),
  );
  return found.filter((milestone) => milestone !== null);
}

/** Star counts worth marking. */
export const STAR_MILESTONES = [100, 1_000, 10_000, 100_000] as const;

/**
 * Star milestones seen in a published star history: the first moment its published (rounded)
 * value reached a threshold, after a moment below it. Only thresholds the rounding can show (a
 * multiple of `roundingStep`), so a milestone never reveals more than the published value does,
 * and only crossings inside the history, because one before it has no date to show.
 */
export function starMilestones(
  points: readonly Readonly<{ asOf: Date; value: number | null }>[],
  roundingStep: number,
): Milestone[] {
  return STAR_MILESTONES.flatMap((threshold) => {
    if (threshold % roundingStep !== 0) return [];
    let below = false;
    for (const point of points) {
      if (point.value === null) continue;
      if (point.value < threshold) {
        below = true;
      } else if (below) {
        return [{ id: `github-stars-${threshold}`, title: `Reached ${formatQuantity(threshold, "GitHub stars")}`, at: point.asOf }];
      }
    }
    return [];
  });
}

/**
 * Achievements (#413) that state the same fact as a derived milestone. The milestones keep their
 * own definitions; a page leaves one out while an achievement saying the same is published, so no
 * fact is listed twice. A one-provider milestone is the same fact as its achievement whatever the
 * dates (the milestone reads a rounded daily history, the achievement every stored reading). The
 * first deployment counts every deployment provider, so it is the same fact as one provider's
 * first deployment only when both are the same event, at the same moment.
 */
const MILESTONE_ACHIEVEMENTS: Readonly<Record<string, Readonly<{ achievementIds: readonly string[]; sameMoment: boolean }>>> = {
  "first-deployment": { achievementIds: DEPLOYMENT_OUTCOMES.map((outcome) => `${outcome.provider}.deployments.first`), sameMoment: true },
  "first-signup": { achievementIds: ["supabase.signups.first"], sameMoment: false },
  "first-customer": { achievementIds: ["stripe.customers.first"], sameMoment: false },
  "first-payment": { achievementIds: ["stripe.payments.first"], sameMoment: false },
  ...Object.fromEntries(
    STAR_MILESTONES.map((threshold) => [`github-stars-${threshold}`, { achievementIds: [`github.stars.${threshold}`], sameMoment: false }]),
  ),
};

/** The milestones no published achievement already states, in their order. */
export function milestonesBesideAchievements(
  milestones: readonly Milestone[],
  achievements: readonly Readonly<{ achievementId: string; earnedAt: Date }>[],
): Milestone[] {
  return milestones.filter((milestone) => {
    const same = MILESTONE_ACHIEVEMENTS[milestone.id];
    if (same === undefined) return true;
    return !achievements.some(
      (achievement) =>
        same.achievementIds.includes(achievement.achievementId) && (!same.sameMoment || achievement.earnedAt.getTime() === milestone.at.getTime()),
    );
  });
}

/** A history point as a chart shows it: the published (rounded) value, or null and why not. */
export type ChartPoint = Readonly<{ asOf: Date; value: number | null; text: string }>;

/**
 * A period of a metric's history in words: where it starts and ends, the highest and lowest
 * values, and how many days have no value. Used as a chart's text alternative and as visible copy
 * beside it (the last 30 days on a project page, #344), so it follows the copy rules. A period
 * with no value says so without "yet": the metric may be new, or may have stopped syncing while
 * the longer chart beside it still draws older values. Dates are UTC days, like the points.
 */
export function historySummary(title: string, period: string, points: readonly ChartPoint[]): string {
  const available = points.filter((point) => point.value !== null);
  const first = available[0];
  const last = available.at(-1);
  if (first === undefined || last === undefined) return `${title}, ${period}: no value on any day.`;
  const highest = available.reduce((best, point) => ((point.value ?? 0) > (best.value ?? 0) ? point : best), first);
  const lowest = available.reduce((best, point) => ((point.value ?? 0) < (best.value ?? 0) ? point : best), first);
  const missing = points.length - available.length;
  const range =
    first === last
      ? `${last.text} on ${utcDate(last.asOf)}.`
      : `from ${first.text} on ${utcDate(first.asOf)} to ${last.text} on ${utcDate(last.asOf)}. Highest ${highest.text} on ${utcDate(highest.asOf)}, lowest ${lowest.text} on ${utcDate(lowest.asOf)}.`;
  const gaps = missing === 0 ? "" : ` ${missing === 1 ? "1 day has" : `${missing} days have`} no value.`;
  return `${title}, ${period}: ${range}${gaps}`;
}
