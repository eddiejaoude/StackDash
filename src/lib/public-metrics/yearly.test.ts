import { describe, expect, it } from "vitest";

import { declaredEventTypes, revenueProviderIds } from "@/lib/adapters/registry";

import { STALE_AFTER_MS, type SnapshotPoint, type SourceAccount, type StoredEvent } from "./engine";
import { MemoryMetricStore } from "./memory-store";
import {
  busiestDay,
  computeYearReview,
  computeYearSummary,
  hasYearStarted,
  isYearComplete,
  latestCardYear,
  mostActiveProvider,
  parseCardYear,
  parseYearSlideFile,
  PAYMENT_EVENT_TYPE_IDS,
  YEAR_SLIDE_IDS,
  yearCardAltText,
  yearFigureNote,
  yearFigures,
  yearLabel,
  yearPartialNote,
  yearShareText,
  yearSlideAltText,
  yearSlideDownloadName,
  yearSlideFile,
  yearSlides,
  yearSlideShareText,
  yearToDateNote,
  type YearReview,
  type YearReviewStore,
  type YearSlide,
} from "./yearly";

const NOW = new Date("2026-11-05T12:00:00Z");
const SYNCED = new Date("2026-11-05T11:50:00Z");

function account(provider: SourceAccount["provider"], connectedAt: string, overrides: Partial<SourceAccount> = {}): SourceAccount {
  return {
    accountId: `${provider}-acct`,
    provider,
    connectionCreatedAt: new Date(connectedAt),
    lastSyncedAt: SYNCED,
    simulated: false,
    ...overrides,
  };
}

function stars(retrievedAt: string, value: number): SnapshotPoint {
  return {
    accountId: "github-acct",
    metricKey: "github.stars.total",
    snapshotDate: retrievedAt.slice(0, 10),
    value,
    periodStart: null,
    periodEnd: null,
    resetsAt: null,
    retrievedAt: new Date(retrievedAt),
  };
}

const deploy = (at: string): StoredEvent => ({ typeId: "vercel.deployment.succeeded", occurredAt: new Date(at), accountId: "vercel-acct" });

describe("computeYearSummary", () => {
  it("counts a past year from where its history starts, says since when, and ignores the next year", async () => {
    const store = new MemoryMetricStore(
      [account("vercel", "2025-08-07T10:00:00Z"), account("github", "2025-03-09T12:00:00Z"), account("stripe", "2026-02-01T00:00:00Z")],
      [stars("2025-03-10T06:00:00Z", 20), stars("2025-12-31T23:00:00Z", 50), stars("2026-01-01T05:00:00Z", 90)],
      // The June deployment is history the adapter backfilled on connecting in August.
      [deploy("2025-06-01T09:00:00Z"), deploy("2025-09-01T09:00:00Z"), deploy("2026-01-05T09:00:00Z")],
    );

    const summary = await computeYearSummary(store, 2025, NOW);

    expect(summary.asOf).toEqual(new Date("2026-01-01T00:00:00Z"));
    expect(summary.stats).toEqual([
      { label: "Deployments shipped", status: "available", value: 2, since: new Date("2025-06-01T09:00:00Z"), countedUpTo: null, simulated: false },
      { label: "Stars gained", status: "available", value: 30, since: new Date("2025-03-10T00:00:00Z"), countedUpTo: null, simulated: false },
      { label: "Signups", status: "unavailable", text: "Not connected" },
    ]);
    // Stripe was connected after the year ended, so it is not one of the year's providers.
    expect(summary.providers).toBe(2);
    expect(summary.simulated).toBe(false);
  });

  it("counts from 1 January with no since note when the history starts earlier", async () => {
    const store = new MemoryMetricStore(
      [account("vercel", "2024-05-01T00:00:00Z")],
      [],
      [deploy("2024-12-31T23:59:59Z"), deploy("2025-01-01T00:00:00Z"), deploy("2025-07-01T00:00:00Z")],
    );
    const [deployments] = (await computeYearSummary(store, 2025, NOW)).stats;
    expect(deployments).toEqual({ label: "Deployments shipped", status: "available", value: 2, since: null, countedUpTo: null, simulated: false });
  });

  it("runs this year's card up to now and labels it the year to date (boundary: the year is not over)", async () => {
    const store = new MemoryMetricStore([account("vercel", "2026-01-10T00:00:00Z")], [], [deploy("2026-03-01T00:00:00Z"), deploy("2026-11-05T11:00:00Z")]);
    const summary = await computeYearSummary(store, 2026, NOW);
    expect(summary.asOf).toEqual(NOW);
    expect(summary.stats[0]).toMatchObject({ status: "available", value: 2 });
    expect(yearShareText(summary)).toBe("My stack in 2026 so far on StackDash: 2 deployments shipped.");
    expect(yearCardAltText(summary)).toMatch(/^StackDash card: your stack in 2026 so far, 2026-01-01 to 2026-11-05\. /);
  });

  it("says there is no data in the year when the provider was connected after it (boundary: history after the year)", async () => {
    const store = new MemoryMetricStore([account("supabase", "2026-02-01T00:00:00Z")], [], []);
    const summary = await computeYearSummary(store, 2025, NOW);
    expect(summary.stats[2]).toEqual({ label: "Signups", status: "unavailable", text: "No data in 2025" });
    expect(summary.providers).toBe(0);
  });

  it("marks the whole card simulated when any figure rests on simulated data", async () => {
    const store = new MemoryMetricStore([account("vercel", "2026-01-10T00:00:00Z", { simulated: true })], [], [deploy("2026-03-01T00:00:00Z")]);
    const summary = await computeYearSummary(store, 2026, NOW);
    expect(summary.simulated).toBe(true);
    expect(yearShareText(summary)).toBe("My stack in 2026 so far on StackDash: 1 deployment shipped. Simulated data.");
  });

  it("refuses a year that has not started", async () => {
    await expect(computeYearSummary(new MemoryMetricStore([], [], []), 2027, NOW)).rejects.toThrow(RangeError);
  });
});

describe("computeYearSummary with stale data (#267)", () => {
  const threeDaysAgo = new Date("2026-11-02T09:00:00Z");
  const history = [deploy("2026-03-01T00:00:00Z"), deploy("2026-11-01T10:00:00Z"), deploy("2026-11-02T08:00:00Z")];
  const starHistory = [stars("2026-01-01T06:00:00Z", 100), stars("2026-11-02T08:30:00Z", 160)];

  it("counts a provider that has not synced for three days up to its last sync and says so", async () => {
    const store = new MemoryMetricStore([account("vercel", "2025-12-01T00:00:00Z", { lastSyncedAt: threeDaysAgo })], [], history);
    const summary = await computeYearSummary(store, 2026, NOW);
    expect(summary.stats[0]).toEqual({
      label: "Deployments shipped",
      status: "available",
      value: 3,
      since: null,
      countedUpTo: threeDaysAgo,
      simulated: false,
    });
    const [deployments] = yearFigures(summary);
    expect(deployments).toEqual({ label: "Deployments shipped", value: "3", since: null, countedUpTo: "2026-11-02" });
    expect(yearFigureNote(deployments ?? { since: null, countedUpTo: null })).toBe("counted up to 2026-11-02");
    expect(yearCardAltText(summary)).toContain("Deployments shipped: 3, counted up to 2026-11-02.");
  });

  it.each([
    ["exactly 48 hours ago is still counted up to now", 0, null],
    ["one millisecond past 48 hours is counted up to the sync", 1, "2026-11-03"],
  ])("%s (boundary: the 48 hour rule)", async (_title, extraMs, countedUpTo) => {
    const lastSyncedAt = new Date(NOW.getTime() - STALE_AFTER_MS - extraMs);
    const store = new MemoryMetricStore([account("vercel", "2025-12-01T00:00:00Z", { lastSyncedAt })], [], history);
    const [deployments] = yearFigures(await computeYearSummary(store, 2026, NOW));
    expect(deployments).toMatchObject({ value: "3", countedUpTo });
  });

  it("counts only the stale provider up to its sync when the others are fresh (boundary: one stale, the rest fresh)", async () => {
    const store = new MemoryMetricStore(
      [account("vercel", "2025-12-01T00:00:00Z", { lastSyncedAt: threeDaysAgo }), account("github", "2025-12-01T00:00:00Z")],
      [...starHistory, stars("2026-11-05T11:40:00Z", 175)],
      history,
    );
    const figures = yearFigures(await computeYearSummary(store, 2026, NOW));
    expect(figures.slice(0, 2)).toEqual([
      { label: "Deployments shipped", value: "3", since: null, countedUpTo: "2026-11-02" },
      { label: "Stars gained", value: "75", since: null, countedUpTo: null },
    ]);
  });

  it("reads a stale snapshot change from the readings up to the sync, never a number beside the text", async () => {
    const store = new MemoryMetricStore([account("github", "2025-12-01T00:00:00Z", { lastSyncedAt: threeDaysAgo })], starHistory, []);
    const [, gained] = yearFigures(await computeYearSummary(store, 2026, NOW));
    expect(gained).toEqual({ label: "Stars gained", value: "60", since: null, countedUpTo: "2026-11-02" });
  });

  it("joins both notes when the history starts after 1 January and the data is stale", () => {
    expect(yearFigureNote({ since: "2026-08-07", countedUpTo: "2026-11-02" })).toBe("since 2026-08-07, counted up to 2026-11-02");
    expect(yearFigureNote({ since: "2026-08-07", countedUpTo: null })).toBe("since 2026-08-07");
    expect(yearFigureNote({ since: null, countedUpTo: null })).toBeNull();
  });
});

describe("the year card's words", () => {
  it("lists every figure with its note, then the provider count, and says it all in the alt text of a whole year", async () => {
    const synced = { lastSyncedAt: new Date("2026-12-01T23:00:00Z") };
    const store = new MemoryMetricStore([account("vercel", "2025-08-07T10:00:00Z", synced)], [], [deploy("2025-09-01T00:00:00Z")]);
    const summary = await computeYearSummary(store, 2025, NOW);
    expect(yearFigures(summary)).toEqual([
      { label: "Deployments shipped", value: "1", since: "2025-08-07", countedUpTo: null },
      { label: "Stars gained", value: "Not connected", since: null, countedUpTo: null },
      { label: "Signups", value: "Not connected", since: null, countedUpTo: null },
      { label: "Providers connected", value: "1", since: null, countedUpTo: null },
    ]);
    expect(yearCardAltText(summary)).toBe(
      "StackDash card: your stack in 2025, 2025-01-01 to 2025-12-31. Deployments shipped: 1, since 2025-08-07. Stars gained: Not connected. Signups: Not connected. Providers connected: 1. Counted by StackDash from stored data.",
    );
    expect(yearShareText(summary)).toBe("My stack in 2025 on StackDash: 1 deployment shipped.");
  });
});

describe("which years have a card", () => {
  it("shows a year from its first moment and the current year at any time (boundary: midnight on 1 January)", () => {
    expect(hasYearStarted(2027, new Date("2027-01-01T00:00:00.000Z"))).toBe(false);
    expect(hasYearStarted(2027, new Date("2027-01-01T00:00:00.001Z"))).toBe(true);
    expect(hasYearStarted(2026, NOW)).toBe(true);
    expect(latestCardYear(NOW)).toBe(2026);
    expect(latestCardYear(new Date("2027-01-01T00:00:00.000Z"))).toBe(2026);
  });

  it("labels the year to date until the year ends, then the whole year (boundary: the last millisecond of December)", () => {
    expect(isYearComplete(2026, new Date("2026-12-31T23:59:59.999Z"))).toBe(false);
    expect(yearLabel(2026, new Date("2026-12-31T23:59:59.999Z"))).toBe("2026 so far");
    expect(isYearComplete(2026, new Date("2027-01-01T00:00:00.000Z"))).toBe(true);
    expect(yearLabel(2026, new Date("2027-01-01T00:00:00.000Z"))).toBe("2026");
    expect(yearLabel(2025, NOW)).toBe("2025");
  });

  it("dates the end of the year to date as the next 1 January in ISO form (boundary: 2099 rolls into 2100)", () => {
    expect(yearToDateNote(2026)).toBe("2026 is not over yet. These slides count up to today and cover the whole year from 2027-01-01.");
    expect(yearToDateNote(2099)).toContain("cover the whole year from 2100-01-01.");
    expect(yearToDateNote(2026)).not.toContain("January");
  });

  it.each([
    ["2025", 2025],
    ["2026", 2026],
    ["2027", null],
    ["0999", null],
    ["25", null],
    ["2025.png", null],
    ["", null],
  ])("parses the URL segment %s as %s", (segment, expected) => {
    expect(parseCardYear(segment, NOW)).toBe(expected);
  });
});

// ── The year in review (#262) ──────────────────────────────────────────────────

const at = (accountId: string, typeId: string, occurredAt: string): StoredEvent => ({ accountId, typeId, occurredAt: new Date(occurredAt) });
const SUCCEEDED = "vercel.deployment.succeeded";
const FAILED = "vercel.deployment.failed";

/** Every word the four slides show, for checks that hold across all of them. */
function slideWords(slides: readonly YearSlide[]): string[] {
  return slides.flatMap((slide) =>
    slide.id === "totals"
      ? [slide.title, ...slide.figures.flatMap((figure) => [figure.label, figure.value])]
      : [slide.title, slide.value, slide.detail],
  );
}

function valuesAndDetails(review: YearReview): (readonly [string, string] | null)[] {
  return yearSlides(review).map((slide) => (slide.id === "totals" ? null : ([slide.value, slide.detail] as const)));
}

describe("computeYearReview", () => {
  it("says in words that a year with no data has nothing to show (boundary: no accounts, no events)", async () => {
    const review = await computeYearReview(new MemoryMetricStore([], [], []), 2025, NOW);
    expect(review).toMatchObject({ busiestDay: null, longestRun: { status: "not_connected" }, topProvider: null, dataFrom: null });
    expect(valuesAndDetails(review)).toEqual([
      ["No events", "Your connected providers sent no events in 2025."],
      ["Not connected", "Connect DigitalOcean, GitLab, Railway, or Vercel to count your deployments."],
      ["No provider activity", "No connected provider sent events in 2025."],
      null,
    ]);
    const slides = yearSlides(review);
    expect(slides.map((slide) => slide.id)).toEqual(YEAR_SLIDE_IDS);
    // A value is never a dash, and no copy carries one.
    for (const word of slideWords(slides)) expect(word).not.toMatch(/^[-\u2013\u2014]$|[\u2013\u2014]/);
    expect(yearPartialNote(review)).toBeNull();
    expect(slides.slice(0, 3).map((slide) => yearSlideShareText(review, slide))).toEqual([
      "My stack in 2025 on StackDash.",
      "My stack in 2025 on StackDash.",
      "My stack in 2025 on StackDash.",
    ]);
  });

  it("says no deployment succeeded when Vercel is connected but only failed (boundary: a run of 0)", async () => {
    const store = new MemoryMetricStore([account("vercel", "2025-01-01T00:00:00Z")], [], [at("vercel-acct", FAILED, "2025-05-01T10:00:00Z")]);
    const review = await computeYearReview(store, 2025, NOW);
    expect(review.longestRun).toEqual({ status: "available", connected: ["vercel"], longest: null });
    expect(valuesAndDetails(review)[1]).toEqual(["No successful deployments", "No Vercel deployment succeeded in 2025."]);
  });

  it("counts the year to date of a workspace connected in August and says the slides may cover part of the year", async () => {
    const store = new MemoryMetricStore(
      [account("vercel", "2026-08-07T10:00:00Z")],
      [],
      [
        at("vercel-acct", SUCCEEDED, "2026-09-01T09:00:00Z"),
        at("vercel-acct", SUCCEEDED, "2026-11-05T11:00:00Z"),
        at("vercel-acct", SUCCEEDED, "2026-11-05T11:30:00Z"),
        // After now: not counted yet, or 5 November would have three.
        at("vercel-acct", SUCCEEDED, "2026-11-05T13:00:00Z"),
      ],
    );
    const review = await computeYearReview(store, 2026, NOW);
    expect(review.busiestDay).toEqual({ day: "2026-11-05", events: 2 });
    expect(review.longestRun).toEqual({ status: "available", connected: ["vercel"], longest: { provider: "vercel", events: 3, tiedWith: [] } });
    expect(review.dataFrom).toBe("2026-08-07");
    expect(yearPartialNote(review)).toBe("Nothing is stored for 2026 before 2026-08-07, so these slides may cover only part of it.");
    const [busiest, run, provider] = yearSlides(review);
    expect(busiest).toMatchObject({ value: "Thursday, 2026-11-05", detail: "2 events on your timeline that day, not counting payments." });
    expect(run).toMatchObject({
      value: "3 in a row on Vercel",
      detail: "Vercel deployments that succeeded one after another, with no failed Vercel deployment between them.",
    });
    expect(provider).toMatchObject({ value: "Vercel", detail: "3 events on your timeline, more than any other provider, not counting payments." });
    expect(YEAR_SLIDE_IDS.map((id) => yearSlideDownloadName(review.summary, id))).toEqual([
      "stackdash-2026-so-far-busiest-day.png",
      "stackdash-2026-so-far-deployment-run.png",
      "stackdash-2026-so-far-top-provider.png",
      "stackdash-2026-so-far.png",
    ]);
    expect(busiest === undefined ? "" : yearSlideShareText(review, busiest)).toBe("My busiest day of 2026 so far on StackDash: 2 events on 2026-11-05.");
    expect(busiest === undefined ? "" : yearSlideAltText(review, busiest)).toBe(
      "StackDash slide for your stack in 2026 so far, 2026-01-01 to 2026-11-05. Busiest day: Thursday, 2026-11-05. 2 events on your timeline that day, not counting payments. Counted by StackDash from stored data.",
    );
  });

  it.each([
    ["a connection within the first day of the year covers the whole year", "2026-01-01T23:59:59.999Z", [], null],
    ["a connection a day after the year began covers part of it", "2026-01-02T00:00:00.000Z", [], "2026-01-02"],
    ["a connection after the year ended is no part of it", "2027-02-01T00:00:00.000Z", [], null],
    // A provider sends some history on connecting, so the data starts at its first event.
    ["history sent on connecting starts the data before the connection", "2026-08-07T10:00:00Z", ["2026-06-01T09:00:00Z"], "2026-06-01"],
    ["history sent on connecting from the year before leaves the year's first stored day at the connection", "2026-08-07T10:00:00Z", ["2025-12-31T09:00:00Z"], "2026-08-07"],
    // 23:30 UTC on 1 June is 2 June in London.
    ["the first event's day is a London day", "2026-08-07T10:00:00Z", ["2026-06-01T23:30:00Z"], "2026-06-02"],
  ])("the data starts: %s (boundary: partial year)", async (_title, connectedAt, events, dataFrom) => {
    const store = new MemoryMetricStore(
      [account("github", connectedAt)],
      [],
      events.map((time) => at("github-acct", "github.stars.daily", time)),
    );
    expect((await computeYearReview(store, 2026, new Date("2027-03-01T00:00:00Z"))).dataFrom).toBe(dataFrom);
  });

  it("leaves payments out of the busiest day and the most active provider, and breaks a tie on the earliest day", async () => {
    const store = new MemoryMetricStore(
      [account("vercel", "2025-12-01T00:00:00Z"), account("supabase", "2025-12-01T00:00:00Z"), account("stripe", "2025-12-01T00:00:00Z")],
      [],
      [
        at("vercel-acct", SUCCEEDED, "2026-03-02T09:00:00Z"),
        at("vercel-acct", SUCCEEDED, "2026-03-02T10:00:00Z"),
        at("supabase-acct", "supabase.auth.signup", "2026-03-01T09:00:00Z"),
        at("supabase-acct", "supabase.auth.signup", "2026-03-01T10:00:00Z"),
        // Five payments and a refund on 1 April would make it the busiest day, and Stripe the most active provider.
        ...["stripe.charge.succeeded", "stripe.charge.succeeded", "stripe.charge.failed", "stripe.charge.refunded", "stripe.charge.succeeded"].map(
          (typeId, index) => at("stripe-acct", typeId, `2026-04-01T0${index}:00:00Z`),
        ),
        at("stripe-acct", "stripe.customer.created", "2026-04-01T08:00:00Z"),
      ],
    );
    const review = await computeYearReview(store, 2026, NOW);
    // 1 and 2 March both have two events; 1 March is the earlier.
    expect(review.busiestDay).toEqual({ day: "2026-03-01", events: 2 });
    expect(valuesAndDetails(review)[0]).toEqual(["Sunday, 2026-03-01", "2 events on your timeline that day, not counting payments."]);
    // Supabase and Vercel tie at two events; Stripe's one new customer counts, its payments do not.
    expect(review.topProvider).toEqual({ provider: "supabase", events: 2, tiedWith: ["vercel"] });
    expect(valuesAndDetails(review)[2]).toEqual([
      "Supabase",
      "2 events on your timeline, as many as Vercel, not counting payments. On a tie the first by name is shown.",
    ]);
  });

  it("resets the run on a failure, takes a failure first when it shares an instant, and counts only the year's deployments", async () => {
    const store = new MemoryMetricStore(
      [account("vercel", "2025-01-01T00:00:00Z")],
      [],
      [
        // The run before 1 January belongs to 2025.
        at("vercel-acct", SUCCEEDED, "2025-12-31T22:00:00Z"),
        at("vercel-acct", SUCCEEDED, "2025-12-31T23:00:00Z"),
        at("vercel-acct", SUCCEEDED, "2026-01-01T09:00:00Z"),
        at("vercel-acct", SUCCEEDED, "2026-01-02T09:00:00Z"),
        at("vercel-acct", FAILED, "2026-01-03T09:00:00Z"),
        at("vercel-acct", SUCCEEDED, "2026-02-01T09:00:00Z"),
        // Other event types neither extend nor break a run.
        at("vercel-acct", "github.stars.daily", "2026-02-01T10:00:00Z"),
        at("vercel-acct", SUCCEEDED, "2026-02-02T09:00:00Z"),
        at("vercel-acct", SUCCEEDED, "2026-02-03T09:00:00Z"),
        // A success and a failure at one instant: the failure goes first, so this is not a run of four.
        at("vercel-acct", SUCCEEDED, "2026-03-01T09:00:00Z"),
        at("vercel-acct", FAILED, "2026-03-01T09:00:00Z"),
      ],
    );
    const run = (longest: number) => ({ status: "available", connected: ["vercel"], longest: { provider: "vercel", events: longest, tiedWith: [] } });
    expect((await computeYearReview(store, 2026, NOW)).longestRun).toEqual(run(3));
    expect((await computeYearReview(store, 2025, NOW)).longestRun).toEqual(run(2));
  });

  it("counts a workspace that deploys only on Railway, in the run and in Deployments shipped (boundary: no Vercel)", async () => {
    const store = new MemoryMetricStore(
      [account("railway", "2025-12-01T00:00:00Z")],
      [],
      [
        at("railway-acct", "railway.deployment.deployed", "2026-02-01T09:00:00Z"),
        at("railway-acct", "railway.deployment.deployed", "2026-02-02T09:00:00Z"),
        // A crash is what became of a deployment later, not an outcome: it neither counts nor breaks the run.
        at("railway-acct", "railway.deployment.crashed", "2026-02-02T10:00:00Z"),
        at("railway-acct", "railway.deployment.deployed", "2026-02-03T09:00:00Z"),
      ],
    );
    const review = await computeYearReview(store, 2026, NOW);
    expect(review.summary.stats[0]).toMatchObject({ label: "Deployments shipped", status: "available", value: 3 });
    expect(valuesAndDetails(review)[1]).toEqual([
      "3 in a row on Railway",
      "Railway deployments that succeeded one after another, with no failed Railway deployment between them.",
    ]);
    const [, run] = yearSlides(review);
    expect(run === undefined ? "" : yearSlideShareText(review, run)).toBe("My longest run of successful deployments in 2026 so far on StackDash: 3 in a row on Railway.");
  });

  it("keeps each provider's run its own: a failure on one never breaks another's", async () => {
    const store = new MemoryMetricStore(
      [account("vercel", "2025-12-01T00:00:00Z"), account("gitlab", "2025-12-01T00:00:00Z")],
      [],
      [
        at("vercel-acct", SUCCEEDED, "2026-02-01T09:00:00Z"),
        at("gitlab-acct", "gitlab.deployment.failed", "2026-02-01T10:00:00Z"),
        at("vercel-acct", SUCCEEDED, "2026-02-02T09:00:00Z"),
        at("gitlab-acct", "gitlab.deployment.succeeded", "2026-02-02T10:00:00Z"),
        at("vercel-acct", SUCCEEDED, "2026-02-03T09:00:00Z"),
        at("vercel-acct", FAILED, "2026-02-04T09:00:00Z"),
        at("gitlab-acct", "gitlab.deployment.succeeded", "2026-02-04T10:00:00Z"),
      ],
    );
    // Mixed into one sequence the run would be 2; per provider, Vercel's is 3 and GitLab's is 2.
    expect((await computeYearReview(store, 2026, NOW)).longestRun).toEqual({
      status: "available",
      connected: ["gitlab", "vercel"],
      longest: { provider: "vercel", events: 3, tiedWith: [] },
    });
  });

  it("breaks a tie between providers' runs on the first name from A to Z and names the others", async () => {
    const store = new MemoryMetricStore(
      [account("vercel", "2025-12-01T00:00:00Z"), account("railway", "2025-12-01T00:00:00Z"), account("digitalocean", "2025-12-01T00:00:00Z")],
      [],
      [
        ...["2026-02-01", "2026-02-02"].map((day) => at("vercel-acct", SUCCEEDED, `${day}T09:00:00Z`)),
        ...["2026-02-01", "2026-02-02"].map((day) => at("railway-acct", "railway.deployment.deployed", `${day}T09:00:00Z`)),
        at("digitalocean-acct", "digitalocean.deployment.succeeded", "2026-02-01T09:00:00Z"),
      ],
    );
    const review = await computeYearReview(store, 2026, NOW);
    expect(review.longestRun).toMatchObject({ longest: { provider: "railway", events: 2, tiedWith: ["vercel"] } });
    expect(valuesAndDetails(review)[1]).toEqual([
      "2 in a row on Railway",
      "Railway deployments that succeeded one after another, with no failed Railway deployment between them. Vercel had a run as long. On a tie the first by name is shown.",
    ]);
  });

  it.each([
    // British Summer Time: 23:30 UTC on 30 June is 00:30 on 1 July in London.
    ["summer, an hour after UTC midnight", ["2026-06-30T22:30:00Z", "2026-06-30T23:30:00Z", "2026-07-01T10:00:00Z"], { day: "2026-07-01", events: 2 }],
    // Greenwich Mean Time: London is UTC, so 23:30 UTC on 15 January stays 15 January.
    ["winter, on UTC midnight", ["2026-01-15T00:10:00Z", "2026-01-15T23:30:00Z", "2026-01-16T00:30:00Z"], { day: "2026-01-15", events: 2 }],
    // The clocks go forward at 01:00 UTC on 29 March 2026; 23:30 UTC on 29 March is 00:30 on 30 March.
    ["the day the clocks go forward", ["2026-03-29T00:30:00Z", "2026-03-29T23:30:00Z", "2026-03-30T08:00:00Z"], { day: "2026-03-30", events: 2 }],
  ])("counts Europe/London days in %s (boundary: day edges)", async (_title, times, expected) => {
    const store = new MemoryMetricStore(
      [account("github", "2025-12-01T00:00:00Z")],
      [],
      times.map((time) => at("github-acct", "github.stars.daily", time)),
    );
    expect((await computeYearReview(store, 2026, NOW)).busiestDay).toEqual(expected);
  });

  it("counts the last London evening of December in its own year (boundary: the year edge in winter)", async () => {
    const store = new MemoryMetricStore(
      [account("github", "2025-12-01T00:00:00Z")],
      [],
      [at("github-acct", "github.stars.daily", "2025-12-31T23:30:00Z"), at("github-acct", "github.stars.daily", "2026-01-01T00:30:00Z")],
    );
    expect((await computeYearReview(store, 2025, NOW)).busiestDay).toEqual({ day: "2025-12-31", events: 1 });
    expect((await computeYearReview(store, 2026, NOW)).busiestDay).toEqual({ day: "2026-01-01", events: 1 });
  });
});

describe("the year in review's tie rules", () => {
  it.each([
    ["no days", [], null],
    ["only empty days", [{ day: "2026-02-01", events: 0 }], null],
    ["one day", [{ day: "2026-02-01", events: 1 }], { day: "2026-02-01", events: 1 }],
    [
      "a tie, in any order, goes to the earliest day",
      [
        { day: "2026-05-01", events: 4 },
        { day: "2026-02-01", events: 4 },
        { day: "2026-03-01", events: 3 },
      ],
      { day: "2026-02-01", events: 4 },
    ],
  ])("busiestDay: %s", (_title, days, expected) => {
    expect(busiestDay(days)).toEqual(expected);
  });

  it.each([
    ["no providers", [], null],
    ["only providers with no events", [{ provider: "vercel" as const, events: 0 }], null],
    [
      "a clear winner",
      [
        { provider: "vercel" as const, events: 3 },
        { provider: "github" as const, events: 5 },
      ],
      { provider: "github", events: 5, tiedWith: [] },
    ],
    [
      "a three way tie goes to the first name from A to Z",
      [
        { provider: "vercel" as const, events: 5 },
        { provider: "posthog" as const, events: 5 },
        { provider: "digitalocean" as const, events: 5 },
      ],
      { provider: "digitalocean", events: 5, tiedWith: ["posthog", "vercel"] },
    ],
  ])("mostActiveProvider: %s", (_title, providers, expected) => {
    expect(mostActiveProvider(providers)).toEqual(expected);
  });

  it("names at most two tied providers, then how many more (boundary: a tie of six)", async () => {
    const providers = ["vercel", "github", "gitlab", "posthog", "sentry", "digitalocean"] as const;
    const store = new MemoryMetricStore(
      providers.map((provider) => account(provider, "2025-12-01T00:00:00Z")),
      [],
      providers.map((provider) => at(`${provider}-acct`, `${provider}.thing.happened`, "2026-02-01T09:00:00Z")),
    );
    const [, , provider] = yearSlides(await computeYearReview(store, 2026, NOW));
    expect(provider).toMatchObject({
      value: "DigitalOcean",
      detail: "1 event on your timeline, as many as GitHub, GitLab, and 3 more, not counting payments. On a tie the first by name is shown.",
    });
  });
});

describe("the year in review's privacy rules", () => {
  it("leaves out every payment and refund a revenue provider declares, and names only declared types", () => {
    const declared = new Set(declaredEventTypes.map((eventType) => eventType.id));
    const excluded: readonly string[] = PAYMENT_EVENT_TYPE_IDS;
    expect(excluded.filter((typeId) => !declared.has(typeId))).toEqual([]);
    const moneyEvents = declaredEventTypes.filter(
      (eventType) => revenueProviderIds.some((provider) => eventType.id.startsWith(`${provider}.`)) && /payment|order|refund/i.test(eventType.label),
    );
    expect(moneyEvents.map((eventType) => eventType.id).filter((typeId) => !excluded.includes(typeId))).toEqual([]);
  });

  it.each([
    ["totals", false, false],
    ["busiest-day", true, false],
    ["top-provider", true, false],
    ["deployment-run", false, true],
  ] as const)("reads only what the %s slide shows", async (slide, readsActivity, readsRun) => {
    const memory = new MemoryMetricStore([account("vercel", "2025-12-01T00:00:00Z")], [], [at("vercel-acct", SUCCEEDED, "2026-02-01T09:00:00Z")]);
    const reads: string[] = [];
    const store: YearReviewStore = {
      accounts: () => memory.accounts(),
      snapshots: (query) => memory.snapshots(query),
      earliestSnapshotDate: (query) => memory.earliestSnapshotDate(query),
      countEvents: (query) => memory.countEvents(query),
      earliestEvent: (query) => memory.earliestEvent(query),
      recentEvents: (query) => memory.recentEvents(query),
      eventActivity: (query) => {
        reads.push("eventActivity");
        return memory.eventActivity(query);
      },
      longestRun: (query) => {
        reads.push("longestRun");
        return memory.longestRun(query);
      },
    };
    const review = await computeYearReview(store, 2026, NOW, [slide]);
    expect(reads).toEqual([...(readsActivity ? ["eventActivity"] : []), ...(readsRun ? ["longestRun"] : [])]);
    // Only the slide asked for comes back, so a figure that was not read is never worded as empty.
    expect(yearSlides(review).map((candidate) => candidate.id)).toEqual([slide]);
    expect(review.summary.stats[0]).toMatchObject({ status: "available", value: 1 });
  });

  it("names a provider by its product name only, never an account", async () => {
    const store = new MemoryMetricStore(
      [account("vercel", "2025-12-01T00:00:00Z", { accountId: "acme-secret-team" })],
      [],
      [at("acme-secret-team", SUCCEEDED, "2026-02-01T09:00:00Z")],
    );
    const review = await computeYearReview(store, 2026, NOW);
    const words = slideWords(yearSlides(review)).join(" ");
    expect(words).toContain("Vercel");
    expect(words).not.toContain("acme-secret-team");
  });
});

describe("slide images", () => {
  it("keeps the yearly card's address for the totals and names every other slide by its id", () => {
    expect(YEAR_SLIDE_IDS.map(yearSlideFile)).toEqual(["busiest-day.png", "deployment-run.png", "top-provider.png", "card.png"]);
    for (const id of YEAR_SLIDE_IDS) expect(parseYearSlideFile(yearSlideFile(id))).toBe(id);
  });

  it.each(["totals.png", "busiest-day", "Busiest-day.png", "busiest-day.png.png", "", "../card.png"])(
    "refuses the segment %s (boundary: unknown slide)",
    (segment) => {
      expect(parseYearSlideFile(segment)).toBeNull();
    },
  );

  it("downloads a whole year's slides without so far", async () => {
    const review = await computeYearReview(new MemoryMetricStore([], [], []), 2025, NOW);
    expect(yearSlideDownloadName(review.summary, "busiest-day")).toBe("stackdash-2025-busiest-day.png");
    expect(yearSlideDownloadName(review.summary, "totals")).toBe("stackdash-2025.png");
  });
});
