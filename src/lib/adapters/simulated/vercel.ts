import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import { deploymentEvent, spendCategories, TOTAL_METRIC_KEY, vercelAdapter } from "@/lib/adapters/vercel";

import {
  accrued,
  between,
  chance,
  countOf,
  DAY_MS,
  instantInSlot,
  simulatedEndpoint,
  unit,
  utcDayStart,
  utcMonthStart,
  type SimulatedProfile,
} from "./simulation";

/*
 * Simulated Vercel team: about 60 deployments finish a day (mostly succeeded, some failed),
 * and month-to-date spend grows hour by hour. Deployments go through the real adapter's
 * `deploymentEvent`, so titles, severities, and dedupe keys match a real sync.
 */

const PROJECTS = ["web", "docs", "api"] as const;
const CURRENCY = "USD";
// A Pro seat, charged on the first of the month.
const MONTHLY_PURCHASE_MINOR = 2000;
// 20 percent VAT on usage and purchases, rounded down.
const TAX_PERCENT = 20;
const ENDPOINT = simulatedEndpoint("vercel", "/v1/billing/charges");

function usagePerHour(accountId: string): (hourStartMs: number) => number {
  // Busier in the UTC working day; 30 cents to $1.50 an hour, so the total moves on most ticks.
  return (hourStartMs) => {
    const hourOfDay = new Date(hourStartMs).getUTCHours();
    const busy = hourOfDay >= 8 && hourOfDay < 20 ? 60 : 0;
    return 30 + busy + between(0, 60, accountId, "usage", hourStartMs);
  };
}

function metrics(accountId: string, at: Date): AdapterMetric[] {
  const monthStart = utcMonthStart(at);
  const tomorrowStart = new Date(utcDayStart(at.getTime()) + DAY_MS);
  const usage = accrued(monthStart.getTime(), at.getTime(), usagePerHour(accountId));
  const amounts: Record<(typeof spendCategories)[number]["category"], number> = {
    Usage: usage,
    Purchase: MONTHLY_PURCHASE_MINOR,
    Tax: Math.floor(((usage + MONTHLY_PURCHASE_MINOR) * TAX_PERCENT) / 100),
  };
  const base = {
    kind: "verified_spend",
    timeframe: { type: "period", start: monthStart, end: tomorrowStart },
    externalAccountId: accountId,
    retrievedAt: at,
    provenance: { source: "provider_api", endpoint: ENDPOINT },
    currency: CURRENCY,
  } as const;
  const spend: AdapterMetric[] = spendCategories.map(({ category, metricKey, label }) => ({
    ...base,
    metricKey,
    label,
    amountMinor: amounts[category],
  }));
  spend.push({
    ...base,
    metricKey: TOTAL_METRIC_KEY,
    label: "Vercel billed spend, month to date",
    amountMinor: amounts.Usage + amounts.Purchase + amounts.Tax,
  });
  return spend;
}

function eventsInSlot(accountId: string, slot: number): ActivityEvent[] {
  // About 60 finished deployments a day (8,640 slots).
  const count = countOf([0.006, 0.001], accountId, "deployments", slot);
  const events: ActivityEvent[] = [];
  for (let index = 0; index < count; index += 1) {
    const parts = [accountId, "deployment", slot, index] as const;
    const ready = instantInSlot(slot, ...parts);
    const failed = chance(0.15, ...parts, "failed");
    const project = PROJECTS[between(0, PROJECTS.length - 1, ...parts, "project")] ?? PROJECTS[0];
    const event = deploymentEvent(
      {
        uid: `dpl_sim${Math.floor(unit(...parts, "uid") * 1e12).toString(36)}${slot.toString(36)}${index}`,
        name: project,
        readyState: failed ? "ERROR" : "READY",
        target: chance(0.4, ...parts, "target") ? "production" : "preview",
        created: ready.getTime() - between(30, 240, ...parts, "build") * 1000,
        ready: ready.getTime(),
        errorCode: failed ? "BUILD_FAILED" : null,
        // No inspector link: a vercel.com URL for a deployment that never existed would mislead.
        inspectorUrl: null,
      },
      accountId,
    );
    if (event !== undefined) events.push(event);
  }
  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

export const vercelProfile: SimulatedProfile = {
  real: vercelAdapter,
  accounts: (seed) => [{ externalId: `team_sim${seed}`, displayName: "Example team", kind: "team" }],
  metrics,
  eventsInSlot,
};
