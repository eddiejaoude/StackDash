import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import {
  errorVolumeMetrics,
  issueCreatedEvent,
  issueStatusEvent,
  releaseEvent,
  sentryAdapter,
  type ErrorOutcome,
  type IssueSnapshot,
} from "@/lib/adapters/sentry";

import {
  accrued,
  between,
  chance,
  countAtVolume,
  DAY_MS,
  instantInSlot,
  laneParts,
  lanesAt,
  SLOT_MS,
  simulatedEndpoint,
  unit,
  utcDayStart,
  type SimulatedProfile,
} from "./simulation";

/*
 * Simulated Sentry organization with three projects. Each project takes in a few hundred errors an
 * hour (more in the UTC working day), filters about a tenth, and on some days hits a rate limit
 * for an hour. About one new issue an hour, a regression or a resolution every hour or two, and a
 * release every 20 minutes, so a 30 minute backfill always holds at least one event per project. A
 * higher event volume (#383) multiplies the issue events; releases keep their cadence. Everything
 * goes through the real adapter's metric and event builders, so keys, titles, severities, and
 * dedupe keys match a real sync. No sentry.io links: they would point nowhere.
 */

const PROJECTS = ["web", "api", "ios"] as const;
// One release per project every 120 slots (20 minutes), at an offset fixed per project. A cadence,
// not a chance, so the event volume does not scale it.
const RELEASE_EVERY_SLOTS = 120;
const ENDPOINT = simulatedEndpoint("sentry", "/api/0/organizations/{organization}/stats_v2/");

function projectOf(accountId: string): (typeof PROJECTS)[number] {
  return PROJECTS[(Number(accountId) % 10) - 1] ?? PROJECTS[0];
}

function acceptedPerHour(accountId: string): (hourStartMs: number) => number {
  return (hourStartMs) => {
    const hourOfDay = new Date(hourStartMs).getUTCHours();
    const busy = hourOfDay >= 8 && hourOfDay < 20 ? 150 : 0;
    return 60 + busy + between(0, 120, accountId, "accepted", hourStartMs);
  };
}

/** On about half the days, one hour of the day goes over the project's rate limit. */
function rateLimitedPerHour(accountId: string): (hourStartMs: number) => number {
  return (hourStartMs) => {
    const day = utcDayStart(hourStartMs);
    if (!chance(0.5, accountId, "spike-day", day)) return 0;
    const spikeHour = between(9, 18, accountId, "spike-hour", day);
    return new Date(hourStartMs).getUTCHours() === spikeHour ? between(300, 900, accountId, "spike", day) : 0;
  };
}

function metrics(accountId: string, at: Date): AdapterMetric[] {
  const end = at.getTime();
  const start = end - DAY_MS;
  const accepted = accrued(start, end, acceptedPerHour(accountId));
  const counts: Record<ErrorOutcome, number> = {
    accepted,
    filtered: Math.floor((accepted * between(5, 15, accountId, "filtered-share", utcDayStart(end))) / 100),
    rate_limited: accrued(start, end, rateLimitedPerHour(accountId)),
  };
  return errorVolumeMetrics(counts, { type: "period", start: new Date(start), end: at }, accountId, at, ENDPOINT);
}

/**
 * An issue first seen in `slot`. `lane` is which of the slot's occurrences it is, a volume lane or a
 * later issue created in the same slot; above 0 it joins the id as two more digits, so no two events
 * of one kind (created, regressed, resolved) in one slot share an issue id, and none shares one with
 * the project's default volume issues, which are shorter.
 */
function issue(accountId: string, slot: number, lane: number, ...parts: readonly (string | number)[]): IssueSnapshot {
  const level = unit(accountId, slot, ...parts, "level");
  const laneDigits = lane === 0 ? "" : String(lane).padStart(2, "0");
  return {
    // Account first, so two projects or two simulated connections never share an issue id.
    id: `${accountId}${slot}${between(0, 9, accountId, slot, ...parts, "id")}${laneDigits}`,
    shortId: `${projectOf(accountId).toUpperCase()}-${Math.floor(unit(accountId, slot, ...parts, "short") * 36 ** 3).toString(36).toUpperCase()}`,
    level: level < 0.1 ? "fatal" : level < 0.8 ? "error" : "warning",
    firstSeen: instantInSlot(slot, accountId, ...parts, "first-seen"),
    permalink: null,
  };
}

function eventsInSlot(accountId: string, slot: number, volume: number): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  const windowKey = new Date(slot * SLOT_MS).toISOString();

  // About 1.4 new issues an hour (360 slots), times the volume.
  const created = countAtVolume([0.004], volume, accountId, "created", slot);
  for (let index = 0; index < created; index += 1) {
    events.push(issueCreatedEvent(issue(accountId, slot, index, "created", index), accountId));
  }
  for (const lane of lanesAt(0.0015, volume, accountId, "regressed", slot)) {
    const regressed = issue(accountId, slot, lane, ...laneParts(lane, "regressed"));
    const detectedAt = instantInSlot(slot, ...laneParts(lane, accountId, "regressed-at"));
    events.push(issueStatusEvent("regressed", regressed, accountId, detectedAt, windowKey));
  }
  for (const lane of lanesAt(0.003, volume, accountId, "resolved", slot)) {
    const resolved = issue(accountId, slot, lane, ...laneParts(lane, "resolved"));
    const detectedAt = instantInSlot(slot, ...laneParts(lane, accountId, "resolved-at"));
    events.push(issueStatusEvent("resolved", resolved, accountId, detectedAt, windowKey));
  }

  const offset = between(0, RELEASE_EVERY_SLOTS - 1, accountId, "release-offset");
  if (slot % RELEASE_EVERY_SLOTS === offset) {
    const release = Math.floor(slot / RELEASE_EVERY_SLOTS);
    const version = `${projectOf(accountId)}@1.${Math.floor(release / 10) % 100}.${release % 10}`;
    events.push(
      releaseEvent(
        { id: String(release), version, shortVersion: version, dateCreated: instantInSlot(slot, accountId, "release-at") },
        accountId,
      ),
    );
  }
  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

export const sentryProfile: SimulatedProfile = {
  real: sentryAdapter,
  // Numeric like real project ids; the last digit picks the project name.
  accounts: (seed) =>
    PROJECTS.map((name, index) => ({
      externalId: String(Number.parseInt(seed, 16) * 10 + index + 1),
      displayName: name,
      kind: "project",
    })),
  metrics,
  eventsInSlot,
};
