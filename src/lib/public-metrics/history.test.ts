import { describe, expect, it } from "vitest";

import { MAX_ROWS_PER_REQUEST } from "@/lib/supabase/paging";

import type { PublicMetricId } from "./definitions";
import { computePublicMetrics, SNAPSHOT_READ_MAX_ROWS, type SnapshotPoint, type SourceAccount, type StoredEvent } from "./engine";
import {
  computeMetricHistories,
  firstEventMilestones,
  HISTORY_DAYS,
  HISTORY_EVENT_ROWS,
  historyMoments,
  historySummary,
  milestonesBesideAchievements,
  preloadHistoryStore,
  starMilestones,
  type HistoryStore,
} from "./history";
import { MemoryMetricStore } from "./memory-store";

const AS_OF = new Date("2026-11-05T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function account(overrides: Partial<SourceAccount> = {}): SourceAccount {
  return {
    accountId: "gh-1",
    provider: "github",
    connectionCreatedAt: new Date(AS_OF.getTime() - 200 * DAY_MS),
    lastSyncedAt: new Date(AS_OF.getTime() - 10 * 60_000),
    simulated: false,
    ...overrides,
  };
}

/** The end-of-day star reading `daysAgo` UTC days before AS_OF (today's is from this morning). */
function starPoint(daysAgo: number, value: number, accountId = "gh-1"): SnapshotPoint {
  const retrievedAt =
    daysAgo === 0 ? new Date(AS_OF.getTime() - 10 * 60_000) : new Date(Date.parse(`${AS_OF.toISOString().slice(0, 10)}T23:00:00Z`) - daysAgo * DAY_MS);
  return {
    accountId,
    metricKey: "github.stars.total",
    snapshotDate: retrievedAt.toISOString().slice(0, 10),
    value,
    periodStart: null,
    periodEnd: null,
    resetsAt: null,
    retrievedAt,
  };
}

function deployment(hoursAgo: number, failed = false, accountId = "vc-1"): StoredEvent {
  return {
    typeId: failed ? "vercel.deployment.failed" : "vercel.deployment.succeeded",
    occurredAt: new Date(AS_OF.getTime() - hoursAgo * HOUR_MS),
    accountId,
  };
}

/** Wraps a store and counts the reads that reach it. */
function counted(base: HistoryStore): { store: HistoryStore; reads: () => number } {
  let reads = 0;
  const count = <T>(result: Promise<T>) => {
    reads += 1;
    return result;
  };
  return {
    reads: () => reads,
    store: {
      accounts: () => count(base.accounts()),
      snapshots: (query) => count(base.snapshots(query)),
      earliestSnapshotDate: (query) => count(base.earliestSnapshotDate(query)),
      countEvents: (query) => count(base.countEvents(query)),
      earliestEvent: (query) => count(base.earliestEvent(query)),
      recentEvents: (query) => count(base.recentEvents(query)),
      eventPage: (query) => count(base.eventPage(query)),
    },
  };
}

/** Wraps a store so a snapshot read stops at SNAPSHOT_READ_MAX_ROWS rows, newest days first, as the Supabase store's does. */
function capped(base: HistoryStore): HistoryStore {
  return {
    accounts: () => base.accounts(),
    snapshots: async (query) =>
      (await base.snapshots(query)).toSorted((a, b) => b.snapshotDate.localeCompare(a.snapshotDate)).slice(0, SNAPSHOT_READ_MAX_ROWS),
    earliestSnapshotDate: (query) => base.earliestSnapshotDate(query),
    countEvents: (query) => base.countEvents(query),
    earliestEvent: (query) => base.earliestEvent(query),
    recentEvents: (query) => base.recentEvents(query),
    eventPage: (query) => base.eventPage(query),
  };
}

/** What the engine answers at each moment when asked one by one, without the cache. */
async function computedOneByOne(store: HistoryStore, metricId: PublicMetricId, asOf: Date, days = HISTORY_DAYS) {
  return computePublicMetrics(
    store,
    historyMoments(asOf, days).map((moment) => ({ metricId, asOf: moment })),
  );
}

const STAR_POINTS = Array.from({ length: 130 }, (_, daysAgo) => starPoint(daysAgo, 2000 - daysAgo * 10));
// A deployment every 6 hours for 130 days, with a failure once every 3 days.
const DEPLOYMENTS = Array.from({ length: 130 * 4 }, (_, index) => deployment(index * 6 + 1, index % 12 === 5));
const ACCOUNTS = [account(), account({ accountId: "vc-1", provider: "vercel" })];

describe("historyMoments", () => {
  it("returns one moment per day, oldest first, ending at asOf", () => {
    const moments = historyMoments(AS_OF);
    expect(moments).toHaveLength(90);
    expect(moments.at(-1)).toEqual(AS_OF);
    expect(moments[0]).toEqual(new Date(AS_OF.getTime() - 89 * DAY_MS));
  });

  it("returns just asOf for a one day history (boundary)", () => {
    expect(historyMoments(AS_OF, 1)).toEqual([AS_OF]);
  });
});

describe("computeMetricHistories", () => {
  const metricIds: PublicMetricId[] = ["github-stars", "github-stars-gained-7d", "github-stars-gained-30d", "vercel-deployments-7d", "vercel-deployment-streak"];

  it("answers exactly what the engine answers moment by moment, with a handful of reads", async () => {
    const base = new MemoryMetricStore(ACCOUNTS, STAR_POINTS, DEPLOYMENTS);
    const { store, reads } = counted(base);
    const histories = await computeMetricHistories(
      store,
      metricIds.map((metricId) => ({ metricId, asOf: AS_OF })),
    );
    for (const [index, metricId] of metricIds.entries()) {
      expect(histories[index], metricId).toEqual(await computedOneByOne(base, metricId, AS_OF));
    }
    expect(histories[0]?.at(-1)?.result).toMatchObject({ status: "available", value: 2000 });
    // One accounts read, one snapshot read per key, one event page, one earliest event per type set.
    expect(reads()).toBeLessThanOrEqual(5);
  });

  it("ends a delayed publication's history at its own asOf", async () => {
    const base = new MemoryMetricStore(ACCOUNTS, STAR_POINTS, DEPLOYMENTS);
    const delayed = new Date(AS_OF.getTime() - 7 * DAY_MS);
    const [history] = await computeMetricHistories(base, [{ metricId: "github-stars", asOf: delayed }]);
    expect(history?.at(-1)?.asOf).toEqual(delayed);
    expect(history).toEqual(await computedOneByOne(base, "github-stars", delayed));
  });

  it("falls back to the real store, and still agrees, when the events are more than it loads (boundary)", async () => {
    const many = HISTORY_EVENT_ROWS + 500;
    // Every 15 minutes, newest first, so the loaded pages stop well inside the 90 day window.
    const events = Array.from({ length: many }, (_, index) => deployment(index / 4 + 0.1, index % 900 === 450));
    const base = new MemoryMetricStore(ACCOUNTS, [], events);
    const { store, reads } = counted(base);
    const [counts, streaks] = await computeMetricHistories(store, [
      { metricId: "vercel-deployments-30d", asOf: AS_OF },
      { metricId: "vercel-deployment-streak", asOf: AS_OF },
    ]);
    expect(counts).toEqual(await computedOneByOne(base, "vercel-deployments-30d", AS_OF));
    expect(streaks).toEqual(await computedOneByOne(base, "vercel-deployment-streak", AS_OF));
    expect(reads()).toBeGreaterThan(HISTORY_EVENT_ROWS / MAX_ROWS_PER_REQUEST + 2);
  });

  it("treats the oldest day of a snapshot read stopped at its bound as not loaded, and still agrees (boundary: SNAPSHOT_READ_MAX_ROWS)", async () => {
    // 90 accounts over the 120 days a 30 day history reads (from 2026-07-09): 10,800 rows, so the
    // read stops part way through a day, with some of its accounts read and the rest not.
    const accounts = Array.from({ length: 90 }, (_, index) => account({ accountId: `gh-${index}` }));
    const points = accounts.flatMap((entry) => Array.from({ length: 130 }, (_, daysAgo) => starPoint(daysAgo, 500 - daysAgo, entry.accountId)));
    const base = capped(new MemoryMetricStore(accounts, points, []));
    const window = { accountIds: accounts.map((entry) => entry.accountId), metricKeys: ["github.stars.total"], fromDate: "2026-07-09", toDate: "2026-11-05" };
    expect(await base.snapshots(window)).toHaveLength(SNAPSHOT_READ_MAX_ROWS);
    const [history] = await computeMetricHistories(base, [{ metricId: "github-stars-gained-30d", asOf: AS_OF }]);
    expect(history).toEqual(await computedOneByOne(base, "github-stars-gained-30d", AS_OF));
  });

  it("loads a snapshot read of more than one request's rows in full (boundary: max_rows)", async () => {
    // 12 accounts of 130 days: more rows than one request returns, far fewer than the bound.
    const accounts = Array.from({ length: 12 }, (_, index) => account({ accountId: `gh-${index}` }));
    const points = accounts.flatMap((entry) => Array.from({ length: 130 }, (_, daysAgo) => starPoint(daysAgo, 500 - daysAgo, entry.accountId)));
    expect(points.length).toBeGreaterThan(MAX_ROWS_PER_REQUEST);
    const base = new MemoryMetricStore(accounts, points, []);
    const { store, reads } = counted(capped(base));
    const [history] = await computeMetricHistories(store, [{ metricId: "github-stars-gained-30d", asOf: AS_OF }]);
    // One accounts read and one snapshot read: nothing fell back to the store.
    expect(reads()).toBe(2);
    expect(history).toEqual(await computedOneByOne(base, "github-stars-gained-30d", AS_OF));
  });

  it("returns nothing for no requests (boundary)", async () => {
    expect(await computeMetricHistories(new MemoryMetricStore([], [], []), [])).toEqual([]);
  });
});

describe("preloadHistoryStore", () => {
  const STREAK: PublicMetricId[] = ["vercel-deployment-streak"];
  // More than every event loaded, so only `since` decides whether the cache has them all.
  const query = (since: Date) => ({ accountIds: ["vc-1"], typeIds: ["vercel.deployment.succeeded"], since, before: AS_OF, limit: 10_000 });

  it("answers recent events since a moment it loaded from memory, as the real store does", async () => {
    const base = new MemoryMetricStore(ACCOUNTS, STAR_POINTS, DEPLOYMENTS);
    const { store, reads } = counted(base);
    const cached = await preloadHistoryStore(store, STREAK, new Date(AS_OF.getTime() - 30 * DAY_MS), AS_OF);
    const loaded = reads();
    const since = new Date(AS_OF.getTime() - 10 * DAY_MS);
    expect(await cached.recentEvents(query(since))).toEqual(await base.recentEvents(query(since)));
    expect(reads()).toBe(loaded);
    // The yearly card's read, not a history's: passed through unchanged.
    expect(await cached.earliestSnapshotDate({ accountIds: ["gh-1"], metricKey: "github.stars.total" })).toBe(
      await base.earliestSnapshotDate({ accountIds: ["gh-1"], metricKey: "github.stars.total" }),
    );
  });

  it("reads the real store for events since a moment older than it loaded, and still agrees (boundary)", async () => {
    const events = Array.from({ length: HISTORY_EVENT_ROWS + 500 }, (_, index) => deployment(index / 4 + 0.1));
    const base = new MemoryMetricStore(ACCOUNTS, [], events);
    const { store, reads } = counted(base);
    const cached = await preloadHistoryStore(store, STREAK, new Date(AS_OF.getTime() - 30 * DAY_MS), AS_OF);
    const loaded = reads();
    // Inside the loaded pages (about 52 days at four an hour), fewer than the limit: still from memory.
    const recent = new Date(AS_OF.getTime() - 10 * DAY_MS);
    expect(await cached.recentEvents(query(recent))).toEqual(await base.recentEvents(query(recent)));
    expect(reads()).toBe(loaded);
    const old = new Date(AS_OF.getTime() - 80 * DAY_MS);
    expect(await cached.recentEvents(query(old))).toEqual(await base.recentEvents(query(old)));
    expect(reads()).toBe(loaded + 1);
  });
});

describe("firstEventMilestones", () => {
  const base = new MemoryMetricStore(ACCOUNTS, [], [deployment(24 * 40), deployment(24 * 3)]);

  it("dates the first recorded deployment while a deployments metric is published exactly", async () => {
    expect(await firstEventMilestones(base, [{ metricId: "vercel-deployments-30d", asOf: AS_OF, roundingStep: 1 }])).toEqual([
      { id: "first-deployment", title: "First deployment recorded", at: new Date(AS_OF.getTime() - 40 * DAY_MS) },
    ]);
  });

  it("dates the first deployment on any deployment provider the published count reads (boundary: Railway only)", async () => {
    const railway = { accountId: "railway-1", provider: "railway" as const, connectionCreatedAt: new Date("2026-01-01T00:00:00Z"), lastSyncedAt: AS_OF, simulated: false };
    const store = new MemoryMetricStore([railway], [], [{ accountId: "railway-1", typeId: "railway.deployment.deployed", occurredAt: new Date(AS_OF.getTime() - 5 * DAY_MS) }]);
    expect(await firstEventMilestones(store, [{ metricId: "vercel-deployments-30d", asOf: AS_OF, roundingStep: 1 }])).toEqual([
      { id: "first-deployment", title: "First deployment recorded", at: new Date(AS_OF.getTime() - 5 * DAY_MS) },
    ]);
    // The streak still counts Vercel only, so it reveals nothing here.
    expect(await firstEventMilestones(store, [{ metricId: "vercel-deployment-streak", asOf: AS_OF, roundingStep: 1 }])).toEqual([]);
  });

  it("shows nothing for an event after a delayed publication's moment (boundary)", async () => {
    const recent = new MemoryMetricStore(ACCOUNTS, [], [deployment(24 * 3)]);
    expect(
      await firstEventMilestones(recent, [{ metricId: "vercel-deployments-7d", asOf: new Date(AS_OF.getTime() - 7 * DAY_MS), roundingStep: 1 }]),
    ).toEqual([]);
  });

  it("shows nothing when the revealing publication rounds a single event away (boundary)", async () => {
    expect(await firstEventMilestones(base, [{ metricId: "vercel-deployments-30d", asOf: AS_OF, roundingStep: 10 }])).toEqual([]);
  });

  it("reveals only through the exact publication when another one is rounded (boundary)", async () => {
    const recent = new MemoryMetricStore(ACCOUNTS, [], [deployment(24 * 3)]);
    const delayedExact = { metricId: "vercel-deployments-7d", asOf: new Date(AS_OF.getTime() - 7 * DAY_MS), roundingStep: 1 } as const;
    const currentRounded = { metricId: "vercel-deployments-30d", asOf: AS_OF, roundingStep: 100 } as const;
    expect(await firstEventMilestones(recent, [delayedExact, currentRounded])).toEqual([]);
    expect(await firstEventMilestones(recent, [{ ...delayedExact, asOf: AS_OF }, currentRounded])).toEqual([
      { id: "first-deployment", title: "First deployment recorded", at: new Date(AS_OF.getTime() - 3 * DAY_MS) },
    ]);
  });

  it("shows nothing when no metric revealing the events is published (boundary)", async () => {
    expect(await firstEventMilestones(base, [{ metricId: "github-stars", asOf: AS_OF, roundingStep: 1 }])).toEqual([]);
    expect(await firstEventMilestones(base, [])).toEqual([]);
  });

  it("shows nothing when the provider is no longer connected (boundary)", async () => {
    const disconnected = new MemoryMetricStore(
      [account(), { ...account({ accountId: "vc-1", provider: "vercel" }), connectionStatus: "revoked" }],
      [],
      [deployment(24 * 40)],
    );
    expect(await firstEventMilestones(disconnected, [{ metricId: "vercel-deployment-streak", asOf: AS_OF, roundingStep: 1 }])).toEqual([]);
  });
});

describe("starMilestones", () => {
  const day = (index: number) => new Date(AS_OF.getTime() - (10 - index) * DAY_MS);
  const series = (values: readonly (number | null)[]) => values.map((value, index) => ({ asOf: day(index), value }));

  it("marks the first moment the published value reaches a threshold after being below it", () => {
    expect(starMilestones(series([90, 95, 100, 120, 99, 130]), 1)).toEqual([
      { id: "github-stars-100", title: "Reached 100 GitHub stars", at: day(2) },
    ]);
  });

  it("counts a crossing across a day with no value", () => {
    expect(starMilestones(series([990, null, 1000]), 10)).toEqual([
      { id: "github-stars-1000", title: "Reached 1,000 GitHub stars", at: day(2) },
    ]);
  });

  it("marks nothing for a threshold already reached when the history starts (boundary)", () => {
    expect(starMilestones(series([150, 160, 170]), 1)).toEqual([]);
  });

  it("marks only thresholds the rounding can show (boundary)", () => {
    expect(starMilestones(series([0, 1000]), 1000).map((milestone) => milestone.id)).toEqual(["github-stars-1000"]);
    expect(starMilestones(series([0, 1000]), 1).map((milestone) => milestone.id)).toEqual(["github-stars-100", "github-stars-1000"]);
  });
});

describe("milestonesBesideAchievements (#413)", () => {
  const FIRST_DEPLOY = new Date("2026-10-01T09:00:00Z");
  const milestones = [
    { id: "first-deployment", title: "First deployment recorded", at: FIRST_DEPLOY },
    { id: "first-signup", title: "First signup recorded", at: new Date("2026-10-02T09:00:00Z") },
    { id: "github-stars-1000", title: "Reached 1,000 GitHub stars", at: new Date("2026-10-10T12:00:00Z") },
    { id: "github-stars-100000", title: "Reached 100,000 GitHub stars", at: new Date("2026-10-20T12:00:00Z") },
  ];
  const ids = (achievements: { achievementId: string; earnedAt: Date }[]) =>
    milestonesBesideAchievements(milestones, achievements).map((milestone) => milestone.id);

  it("keeps every milestone while no achievement is published", () => {
    expect(ids([])).toEqual(["first-deployment", "first-signup", "github-stars-1000", "github-stars-100000"]);
  });

  it("leaves out a milestone a published achievement states, even when the achievement is dated from a finer reading", () => {
    expect(
      ids([
        { achievementId: "supabase.signups.first", earnedAt: new Date("2026-10-02T09:00:00Z") },
        { achievementId: "github.stars.1000", earnedAt: new Date("2026-10-09T18:30:00Z") },
      ]),
    ).toEqual(["first-deployment", "github-stars-100000"]);
  });

  it("leaves out the first deployment only when one provider's first deployment is the same event", () => {
    expect(ids([{ achievementId: "railway.deployments.first", earnedAt: FIRST_DEPLOY }])).not.toContain("first-deployment");
    // Boundary: another provider's later first deployment is a different fact, so both stay.
    expect(ids([{ achievementId: "vercel.deployments.first", earnedAt: new Date("2026-10-05T09:00:00Z") }])).toContain("first-deployment");
  });

  it("keeps a milestone when the published achievement is another provider's or another threshold's", () => {
    expect(
      ids([
        { achievementId: "posthog.signups.first", earnedAt: new Date("2026-10-02T09:00:00Z") },
        { achievementId: "github.stars.100", earnedAt: new Date("2026-10-03T09:00:00Z") },
      ]),
    ).toEqual(["first-deployment", "first-signup", "github-stars-1000", "github-stars-100000"]);
  });
});

describe("historySummary", () => {
  const at = (index: number) => new Date(Date.UTC(2026, 10, 1 + index, 12));

  it("says where the period starts and ends, its highest and lowest values, and the days with no value", () => {
    expect(
      historySummary("GitHub stars", "last 30 days", [
        { asOf: at(0), value: 120, text: "120 stars" },
        { asOf: at(1), value: null, text: "Not synced in the last 2 days" },
        { asOf: at(2), value: 140, text: "140 stars" },
        { asOf: at(3), value: 90, text: "90 stars" },
        { asOf: at(4), value: 130, text: "130 stars" },
      ]),
    ).toBe(
      "GitHub stars, last 30 days: from 120 stars on 2026-11-01 to 130 stars on 2026-11-05. Highest 140 stars on 2026-11-03, lowest 90 stars on 2026-11-04. 1 day has no value.",
    );
  });

  it("names the earliest day of a tied highest or lowest value (boundary)", () => {
    const flat = [0, 1, 2].map((index) => ({ asOf: at(index), value: 5, text: "5 stars" }));
    expect(historySummary("GitHub stars", "last 30 days", flat)).toBe(
      "GitHub stars, last 30 days: from 5 stars on 2026-11-01 to 5 stars on 2026-11-03. Highest 5 stars on 2026-11-01, lowest 5 stars on 2026-11-01.",
    );
  });

  it("names the one value of a period with a single value (boundary)", () => {
    expect(historySummary("Signups in 7 days", "last 90 days", [{ asOf: at(0), value: 3, text: "3 signups" }])).toBe(
      "Signups in 7 days, last 90 days: 3 signups on 2026-11-01.",
    );
  });

  it("says no day has a value, for a new metric and one that lapsed alike (boundary)", () => {
    const lapsed = [0, 1, 2].map((index) => ({ asOf: at(index), value: null, text: "Not synced in the last 2 days" }));
    expect(historySummary("GitHub stars", "last 30 days", lapsed)).toBe("GitHub stars, last 30 days: no value on any day.");
    expect(historySummary("GitHub stars", "last 30 days", [{ asOf: at(0), value: null, text: "No data yet" }])).toBe(
      "GitHub stars, last 30 days: no value on any day.",
    );
    expect(historySummary("GitHub stars", "last 30 days", [])).toBe("GitHub stars, last 30 days: no value on any day.");
  });
});
