import { describe, expect, it } from "vitest";

import type { AdapterMetric } from "@/lib/adapters/metrics";
import { githubProfile } from "@/lib/adapters/simulated/github";
import { resendProfile } from "@/lib/adapters/simulated/resend";
import { DAY_MS, DEFAULT_EVENT_VOLUME, SLOT_MS, type SimulatedProfile } from "@/lib/adapters/simulated/simulation";
import { stripeProfile } from "@/lib/adapters/simulated/stripe";
import { supabaseProfile } from "@/lib/adapters/simulated/supabase";
import { vercelProfile } from "@/lib/adapters/simulated/vercel";
import type { AdapterContext, LiveProviderId } from "@/lib/adapters/types";

import { PUBLIC_METRIC_IDS, type PublicMetricId } from "./definitions";
import { computePublicMetrics, type SnapshotPoint, type SourceAccount, type StoredEvent } from "./engine";
import { MemoryMetricStore } from "./memory-store";

/*
 * Every metric against stored data shaped exactly like a sync writes it: 35 days of the simulated
 * providers (#131), which build their metrics and events with the real adapters' helpers. It is the
 * unit twin of the demo seed (#166): the same simulators, with a fixed clock and no database.
 * Expected values are worked out here straight from the generated rows, not through the engine.
 */

const AS_OF = new Date("2026-11-05T12:00:00Z");
const HISTORY_DAYS = 35;
const SYNCED_AT = new Date(AS_OF.getTime() - 5 * 60_000);
const ctx: AdapterContext = {
  fetch: () => Promise.reject(new Error("no network in tests")),
  now: () => AS_OF,
  timeoutMs: 1000,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

const accountId = (provider: LiveProviderId) => `sim-${provider}`;

const accounts: SourceAccount[] = (["github", "vercel", "supabase", "resend", "stripe"] as const).map((provider) => ({
  accountId: accountId(provider),
  provider,
  connectionCreatedAt: new Date(AS_OF.getTime() - HISTORY_DAYS * DAY_MS),
  lastSyncedAt: SYNCED_AT,
  simulated: true,
}));

/** A quantity metric as `usage_snapshots` stores it. */
function toPoint(metric: AdapterMetric): SnapshotPoint | null {
  if (!("value" in metric) || !("unit" in metric)) return null;
  const period = metric.timeframe.type === "period" ? metric.timeframe : null;
  return {
    accountId: metric.externalAccountId,
    metricKey: metric.metricKey,
    snapshotDate: metric.retrievedAt.toISOString().slice(0, 10),
    value: metric.value,
    periodStart: period?.start ?? null,
    periodEnd: period?.end ?? null,
    resetsAt: "resetsAt" in metric && metric.resetsAt !== undefined ? metric.resetsAt : null,
    retrievedAt: metric.retrievedAt,
  };
}

/** One row per UTC day, as the last sync of the day left it, and today's row as of SYNCED_AT. */
function dailySnapshots(profile: SimulatedProfile, provider: LiveProviderId): SnapshotPoint[] {
  const points: SnapshotPoint[] = [];
  for (let daysAgo = HISTORY_DAYS; daysAgo >= 0; daysAgo -= 1) {
    const dayStart = Math.floor((AS_OF.getTime() - daysAgo * DAY_MS) / DAY_MS) * DAY_MS;
    const at = daysAgo === 0 ? SYNCED_AT : new Date(dayStart + DAY_MS - 10 * SLOT_MS);
    for (const metric of profile.metrics(accountId(provider), at, ctx)) {
      const point = toPoint(metric);
      if (point !== null) points.push(point);
    }
  }
  return points;
}

/** Every event a sync stored over the history, up to SYNCED_AT. */
function storedEvents(profile: SimulatedProfile, provider: LiveProviderId): StoredEvent[] {
  const events: StoredEvent[] = [];
  const first = Math.floor((AS_OF.getTime() - HISTORY_DAYS * DAY_MS) / SLOT_MS);
  const last = Math.floor(SYNCED_AT.getTime() / SLOT_MS);
  for (let slot = first; slot < last; slot += 1) {
    for (const event of profile.eventsInSlot(accountId(provider), slot, DEFAULT_EVENT_VOLUME)) {
      events.push({ typeId: event.typeId, occurredAt: event.occurredAt, accountId: accountId(provider) });
    }
  }
  return events;
}

const points = [...dailySnapshots(githubProfile, "github"), ...dailySnapshots(resendProfile, "resend")];
const events = [
  ...storedEvents(vercelProfile, "vercel"),
  ...storedEvents(supabaseProfile, "supabase"),
  ...storedEvents(stripeProfile, "stripe"),
];
const store = new MemoryMetricStore(accounts, points, events);

function latest(metricKey: string): SnapshotPoint {
  const rows = points.filter((point) => point.metricKey === metricKey).sort((a, b) => b.retrievedAt.getTime() - a.retrievedAt.getTime());
  const row = rows[0];
  if (row === undefined) throw new Error(`no ${metricKey} rows`);
  return row;
}

function onDay(metricKey: string, daysAgo: number): number {
  const date = new Date(AS_OF.getTime() - daysAgo * DAY_MS).toISOString().slice(0, 10);
  const row = points.find((point) => point.metricKey === metricKey && point.snapshotDate === date);
  if (row === undefined) throw new Error(`no ${metricKey} row on ${date}`);
  return row.value;
}

function countIn(typeId: string, days: number): number {
  const from = AS_OF.getTime() - days * DAY_MS;
  return events.filter((event) => event.typeId === typeId && event.occurredAt.getTime() >= from && event.occurredAt.getTime() < AS_OF.getTime()).length;
}

function streak(): number {
  const deployments = events
    .filter((event) => event.typeId.startsWith("vercel.deployment."))
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
  const failed = deployments.findIndex((event) => event.typeId === "vercel.deployment.failed");
  return failed === -1 ? deployments.length : failed;
}

const stars = "github.stars.total";
const expected: Record<PublicMetricId, () => number> = {
  "github-stars": () => latest(stars).value,
  "github-stars-gained-7d": () => latest(stars).value - onDay(stars, 7),
  "github-stars-gained-30d": () => latest(stars).value - onDay(stars, 30),
  "vercel-deployments-7d": () => countIn("vercel.deployment.succeeded", 7),
  "vercel-deployments-30d": () => countIn("vercel.deployment.succeeded", 30),
  "vercel-deployment-streak": streak,
  "supabase-signups-7d": () => countIn("supabase.auth.signup", 7),
  "supabase-signups-30d": () => countIn("supabase.auth.signup", 30),
  "resend-emails-month": () => latest("resend.emails.monthly.used").value,
  "resend-quota-percent-month": () =>
    Math.floor((latest("resend.emails.monthly.used").value / latest("resend.emails.monthly.limit").value) * 100),
  "github-actions-minutes-month": () => latest("github.usage.actions.minutes").value,
  "stripe-customers-30d": () => countIn("stripe.customer.created", 30),
  "stripe-payments-30d": () => countIn("stripe.charge.succeeded", 30),
};

describe("every public metric from simulated provider history", () => {
  it.each(PUBLIC_METRIC_IDS.map((id) => [id]))("%s is computed from the stored rows", async (metricId) => {
    const [result] = await computePublicMetrics(store, [{ metricId, asOf: AS_OF }]);
    const value = expected[metricId]();
    expect(result?.result).toEqual({ status: "available", value, lowerBound: false, lastSyncedAt: expect.any(Date), simulated: true });
    // A metric with nothing behind it would pass vacuously at zero; the simulation always has some.
    if (metricId !== "vercel-deployment-streak") expect(value).toBeGreaterThan(0);
  });

  it("is not enough history for 30 day counts one week into the history", async () => {
    const asOf = new Date(AS_OF.getTime() - (HISTORY_DAYS - 7) * DAY_MS);
    const young = new MemoryMetricStore(
      accounts.map((account) => ({ ...account, lastSyncedAt: asOf })),
      points,
      events,
    );
    const results = await computePublicMetrics(young, [
      { metricId: "vercel-deployments-7d", asOf },
      { metricId: "vercel-deployments-30d", asOf },
      { metricId: "github-stars-gained-30d", asOf },
    ]);
    expect(results.map((result) => (result.result.status === "available" ? "available" : result.result.reason))).toEqual([
      "available",
      "not_enough_history",
      "not_enough_history",
    ]);
  });
});
