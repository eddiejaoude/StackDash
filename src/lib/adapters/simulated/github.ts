import type { ActivityEvent } from "@/lib/adapters/events";
import { githubAdapter } from "@/lib/adapters/github";
import { activityEventTypeIds } from "@/lib/adapters/github/activity";
import { billingMetricNames } from "@/lib/adapters/github/billing";
import { eventTypeIds, starMetricNames, starMilestones } from "@/lib/adapters/github/repositories";
import type { AdapterMetric } from "@/lib/adapters/metrics";

import {
  accrued,
  between,
  DAY_MS,
  instantInSlot,
  isWeekend,
  laneParts,
  lanesAt,
  MAX_EVENT_VOLUME,
  SLOT_MS,
  simulatedEndpoint,
  utcDayStart,
  utcMonthStart,
  utcNextMonthStart,
  type SimulatedProfile,
} from "./simulation";

/*
 * Simulated GitHub organization with three repositories: stars grow at a steady rate per
 * repository (so the 100, 500, and 1,000 milestones are crossed now and then), forks trickle in
 * (about 65 a day across the three), and a daily stars event lands at UTC midnight for the day
 * before, and every sync reports the day before's new stars. Pull requests are merged (about 8 a
 * day) and issues opened (about 4), the events GitHub's webhooks push (#62), releases are published
 * (about 1, which the real adapter polls from the events feed), and the two quieter repositories
 * send one "Repository starred" event per star. The
 * trending `api` repository's 240 stars a day reach only its counts, daily total, and milestones:
 * one event per star there would outpace a small product's timeline (#264). Actions minutes and
 * spend accrue hour by hour, at under a third of the pace on weekends (#166). Keys and milestones
 * come from the real adapter's modules. Fork and activity counts are at the default event volume;
 * a higher volume (#383) multiplies them and leaves stars alone.
 *
 * The account id is numeric, like a real GitHub account id, because a webhook names its account by
 * the repository owner's numeric id: a signed delivery for a simulated connection (#479) carries it.
 */

const ORGANIZATION = "example-org";
const CURRENCY = "USD";
const WEEKEND_ACTIONS_PERCENT = 30;
const PRODUCT = "Actions";
const SKU = "actions_linux";
const UNIT_TYPE = "Minutes";
// Star counts are anchored here, so a count is a pure function of the clock.
const STAR_ANCHOR_MS = Date.UTC(2026, 0, 1);
// Net price per Actions minute, in tenths of a cent (Linux runners, $0.008 a minute).
const PRICE_TENTHS_OF_CENT_PER_MINUTE = 8;

type SimulatedRepo = Readonly<{
  id: number;
  full_name: string;
  baseStars: number;
  starsPerDay: number;
  forkChance: number;
  starEvents: boolean;
  mergeChance: number;
  issueChance: number;
  releaseChance: number;
}>;

// Chances are per 10 second slot. Forks: about 50, 12, and 3 a day. Merges: about 4, 2.6, and 0.9.
// Issues: about 2.6, 1.3, and 0.4. Releases: about 0.5, 0.3, and 0.1.
const REPO_SHAPES = [
  { name: "api", baseStars: 60, starsPerDay: 240, forkChance: 0.0058, starEvents: false, mergeChance: 0.0005, issueChance: 0.0003, releaseChance: 0.00006 },
  { name: "web", baseStars: 420, starsPerDay: 24, forkChance: 0.0014, starEvents: true, mergeChance: 0.0003, issueChance: 0.00015, releaseChance: 0.00003 },
  { name: "cli", baseStars: 75, starsPerDay: 6, forkChance: 0.00035, starEvents: true, mergeChance: 0.0001, issueChance: 0.00005, releaseChance: 0.00001 },
] as const;
// Pull request and issue numbers count slots from here, so each is unique and stable for a repository.
const NUMBER_ANCHOR_SLOT = STAR_ANCHOR_MS / SLOT_MS;
const SLOTS_PER_DAY = DAY_MS / SLOT_MS;

function repositories(accountId: string): SimulatedRepo[] {
  return REPO_SHAPES.map((shape, index) => ({
    ...shape,
    id: between(100_000_000, 999_999_999, accountId, "repo", index),
    full_name: `${ORGANIZATION}/${shape.name}`,
  }));
}

function starsAt(repo: SimulatedRepo, atMs: number): number {
  const days = Math.max(0, atMs - STAR_ANCHOR_MS) / DAY_MS;
  return repo.baseStars + Math.floor(days * repo.starsPerDay);
}

function actionsMinutesPerHour(accountId: string): (hourStartMs: number) => number {
  return (hourStartMs) => {
    const hourOfDay = new Date(hourStartMs).getUTCHours();
    const weekday = (hourOfDay >= 7 && hourOfDay < 21 ? 60 : 10) + between(0, 60, accountId, "actions", hourStartMs);
    return isWeekend(hourStartMs) ? Math.floor((weekday * WEEKEND_ACTIONS_PERCENT) / 100) : weekday;
  };
}

function metrics(accountId: string, at: Date): AdapterMetric[] {
  const now = at.getTime();
  const monthStart = utcMonthStart(at);
  const dayStart = utcDayStart(now);
  const perHour = actionsMinutesPerHour(accountId);
  const monthMinutes = accrued(monthStart.getTime(), now, perHour);
  const dayMinutes = accrued(dayStart, now, perHour);
  const minor = (minutes: number) => Math.floor((minutes * PRICE_TENTHS_OF_CENT_PER_MINUTE) / 10);
  const month = { type: "period", start: monthStart, end: utcNextMonthStart(at) } as const;
  const common = { externalAccountId: accountId, retrievedAt: at } as const;
  const billing = { ...common, provenance: { source: "provider_api", endpoint: simulatedEndpoint("github", "/settings/billing/usage/summary") } } as const;
  const usageName = billingMetricNames.usage(PRODUCT, UNIT_TYPE);

  const result: AdapterMetric[] = [
    { ...billing, ...billingMetricNames.spend(PRODUCT), kind: "verified_spend", timeframe: month, amountMinor: minor(monthMinutes), currency: CURRENCY },
    { ...billing, ...billingMetricNames.skuSpend(PRODUCT, SKU), kind: "verified_spend", timeframe: month, amountMinor: minor(monthMinutes), currency: CURRENCY },
    { ...billing, metricKey: usageName.metricKey, label: usageName.label, kind: "usage", timeframe: month, value: monthMinutes, unit: usageName.unit },
    {
      ...common,
      ...billingMetricNames.dailySpend(PRODUCT),
      kind: "verified_spend",
      timeframe: { type: "period", start: new Date(dayStart), end: new Date(dayStart + DAY_MS) },
      amountMinor: minor(dayMinutes),
      currency: CURRENCY,
      provenance: { source: "provider_api", endpoint: simulatedEndpoint("github", "/settings/billing/usage") },
    },
  ];

  const stars = { ...common, kind: "usage", unit: "stars", timeframe: { type: "point", at }, provenance: { source: "provider_api", endpoint: simulatedEndpoint("github", "/repos/{owner}/{repo}/stargazers/count") } } as const;
  let total = 0;
  let gainedYesterday = 0;
  for (const repo of repositories(accountId)) {
    const count = starsAt(repo, now);
    total += count;
    gainedYesterday += Math.max(0, starsAt(repo, dayStart) - starsAt(repo, dayStart - DAY_MS));
    result.push({ ...stars, ...starMetricNames.repo(repo), value: count });
  }
  result.push({ ...stars, ...starMetricNames.total, value: total });
  // Yesterday's new stars over exactly that UTC day, the reading the real adapter writes when a sync
  // closes the day soon after midnight. Star counts here are a pure function of the clock, so the
  // count is exact at any hour and every sync reports the same total for the day.
  result.push({
    ...stars,
    ...starMetricNames.gainedDaily,
    value: gainedYesterday,
    timeframe: { type: "period", start: new Date(dayStart - DAY_MS), end: new Date(dayStart) },
  });
  return result;
}

function eventsInSlot(accountId: string, slot: number, volume: number): ActivityEvent[] {
  const startMs = slot * SLOT_MS;
  const events: ActivityEvent[] = [];
  // The daily and milestone star events follow the star counts the metrics report, so they do not
  // scale with the volume: more of them would contradict the stars count beside them.
  for (const repo of repositories(accountId)) {
    // The day that just ended, reported at UTC midnight like the real adapter's first poll of a day.
    if (startMs % DAY_MS === 0) {
      const date = new Date(startMs - DAY_MS).toISOString().slice(0, 10);
      const net = starsAt(repo, startMs) - starsAt(repo, startMs - DAY_MS);
      if (net > 0) {
        events.push({
          typeId: eventTypeIds.starsDaily,
          occurredAt: new Date(startMs),
          severity: "info",
          title: `${repo.full_name} gained ${net} ${net === 1 ? "star" : "stars"} on ${date}`,
          externalAccountId: accountId,
          dedupeKey: `${eventTypeIds.starsDaily}:${repo.id}:${date}`,
        });
      }
    }

    const before = starsAt(repo, startMs);
    const after = starsAt(repo, startMs + SLOT_MS);
    for (const milestone of starMilestones(before, after)) {
      events.push({
        typeId: eventTypeIds.starsMilestone,
        occurredAt: instantInSlot(slot, accountId, repo.id, "milestone"),
        severity: "success",
        title: `${repo.full_name} reached ${milestone.toLocaleString("en-GB")} stars`,
        externalAccountId: accountId,
        dedupeKey: `${eventTypeIds.starsMilestone}:${repo.id}:${milestone}`,
      });
    }

    // One per star, dated and keyed like the real `star` delivery's `starred_at` (whole seconds).
    if (repo.starEvents) {
      for (let star = 0; star < after - before; star += 1) {
        const starredAt = instantInSlot(slot, accountId, repo.id, "star", star);
        events.push({
          typeId: eventTypeIds.starsNew,
          occurredAt: starredAt,
          severity: "info",
          title: `New star on ${repo.full_name}`,
          externalAccountId: accountId,
          dedupeKey: `${eventTypeIds.starsNew}:${repo.id}:${starredAt.toISOString()}`,
        });
      }
    }

    // Later lanes number past every slot's lane 0 number, so a higher volume never repeats a key.
    const numberOf = (lane: number) => slot - NUMBER_ANCHOR_SLOT + lane * 10_000_000;
    for (const lane of lanesAt(repo.mergeChance, volume, accountId, repo.id, "merge", slot)) {
      const number = numberOf(lane);
      events.push({
        typeId: activityEventTypeIds.pullRequestMerged,
        occurredAt: instantInSlot(slot, ...laneParts(lane, accountId, repo.id, "merge-at")),
        severity: "success",
        title: `Pull request #${number} merged in ${repo.full_name}`,
        externalAccountId: accountId,
        dedupeKey: `${activityEventTypeIds.pullRequestMerged}:${repo.id}:${number}`,
      });
    }
    for (const lane of lanesAt(repo.issueChance, volume, accountId, repo.id, "issue", slot)) {
      const number = numberOf(lane);
      events.push({
        typeId: activityEventTypeIds.issueOpened,
        occurredAt: instantInSlot(slot, ...laneParts(lane, accountId, repo.id, "issue-at")),
        severity: "info",
        title: `Issue #${number} opened in ${repo.full_name}`,
        externalAccountId: accountId,
        dedupeKey: `${activityEventTypeIds.issueOpened}:${repo.id}:${number}`,
      });
    }
    for (const lane of lanesAt(repo.releaseChance, volume, accountId, repo.id, "release", slot)) {
      const sinceAnchor = slot - NUMBER_ANCHOR_SLOT;
      const tag = `v1.${Math.floor(sinceAnchor / SLOTS_PER_DAY)}.${(sinceAnchor % SLOTS_PER_DAY) * MAX_EVENT_VOLUME + lane}`;
      events.push({
        typeId: activityEventTypeIds.releasePublished,
        occurredAt: instantInSlot(slot, ...laneParts(lane, accountId, repo.id, "release-at")),
        severity: "success",
        title: `Release ${tag} published in ${repo.full_name}`,
        externalAccountId: accountId,
        // The real key holds GitHub's release id; the tag is unique here, so it stands in for one.
        dedupeKey: `${activityEventTypeIds.releasePublished}:${repo.id}:${tag}`,
      });
    }

    for (const lane of lanesAt(repo.forkChance, volume, accountId, repo.id, "fork", slot)) {
      // Later lanes number their forks past the first lane's nine digit ids, one number per slot and
      // lane, so a higher volume never repeats a fork's dedupe key.
      const forkId =
        lane === 0
          ? between(100_000_000, 999_999_999, accountId, repo.id, "fork-id", slot)
          : 1_000_000_000 + slot * MAX_EVENT_VOLUME + lane;
      events.push({
        typeId: eventTypeIds.forksNew,
        occurredAt: instantInSlot(slot, ...laneParts(lane, accountId, repo.id, "fork-at")),
        severity: "info",
        title: `New fork of ${repo.full_name}`,
        externalAccountId: accountId,
        dedupeKey: `${eventTypeIds.forksNew}:${repo.id}:${forkId}`,
      });
    }
  }
  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

export const githubProfile: SimulatedProfile = {
  real: githubAdapter,
  accounts: (seed) => [{ externalId: String(parseInt(seed, 16)), displayName: ORGANIZATION, kind: "organization" }],
  metrics,
  eventsInSlot,
};
