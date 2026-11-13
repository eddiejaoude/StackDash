import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import { billingMetrics, deploymentEvents, measurementSpecs, railwayAdapter } from "@/lib/adapters/railway";
import { measurements, type BillingData, type Deployment } from "@/lib/adapters/railway/schemas";

import {
  accrued,
  between,
  chance,
  HOUR_MS,
  instantInSlot,
  laneParts,
  lanesAt,
  simulatedEndpoint,
  utcMonthStart,
  utcNextMonthStart,
  type SimulatedProfile,
} from "./simulation";

/*
 * Simulated Railway workspace on the Hobby plan: about 50 deployments a day across three services
 * in two environments, each one building for 30 seconds to 3 minutes before it deploys, fails, or
 * crashes, and each success removing the deployment it replaced. Resource usage accrues hour by
 * hour through a calendar month billing period. Events and metrics go through the real adapter's
 * `deploymentEvents` and `billingMetrics`, so titles, dedupe keys, and metric keys match a real sync.
 * Deploy counts are at the default event volume; a higher volume (#383) multiplies them and leaves
 * resource usage alone.
 *
 * The event mix is richer than a real sync's. The simulator emits every transition in the slot it
 * happens, while the real adapter polls hourly and sees only each deployment's latest status: a
 * deployment that succeeds and is replaced within the hour reaches a real timeline as "started
 * building" plus "succeeded, then was removed", never as a separate "succeeded" event.
 */

const PROJECT = "shop";
const SERVICES = ["web", "api", "worker"] as const;
// About 50 deployments a day (8,640 slots) at the default volume.
const DEPLOY_CHANCE = 0.006;
const MIN_BUILD_SLOTS = 3;
const MAX_BUILD_SLOTS = 18;
const ENDPOINT = simulatedEndpoint("railway", "/graphql/v2");
const CREDIT_BALANCE_USD = 3.17;

type Started = Readonly<{ slot: number; id: string; service: string; environment: string; buildSlots: number }>;

/**
 * The deployments that start in `slot`, one per lane whose chance came up. Each lane draws its own
 * service, environment, and build time, and a lane past the first suffixes its id, so a deployment's
 * start and its outcome, found later from the same lane, always describe the same deployment.
 */
function startedIn(accountId: string, slot: number, volume: number): Started[] {
  return lanesAt(DEPLOY_CHANCE, volume, accountId, "deploy", slot).map((lane) => ({
    slot,
    id: `sim-${accountId}-${slot.toString(36)}${lane === 0 ? "" : `-${lane}`}`,
    service: SERVICES[between(0, SERVICES.length - 1, ...laneParts(lane, accountId, "service", slot))] ?? SERVICES[0],
    environment: chance(0.6, ...laneParts(lane, accountId, "production", slot)) ? "production" : "staging",
    buildSlots: between(MIN_BUILD_SLOTS, MAX_BUILD_SLOTS, ...laneParts(lane, accountId, "build", slot)),
  }));
}

function deployment(started: Started, status: Deployment["status"], statusAt: Date): Deployment {
  const createdAt = instantInSlot(started.slot, started.id, "created");
  return {
    id: started.id,
    status,
    createdAt,
    updatedAt: statusAt,
    statusUpdatedAt: statusAt,
    // Only a replaced deployment is removed here, and it had succeeded within the retention window.
    canRollback: status === "REMOVED",
    service: { name: started.service },
    environment: { name: started.environment },
  };
}

function eventsInSlot(accountId: string, slot: number, volume: number): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const begun of startedIn(accountId, slot, volume)) {
    const building = deployment(begun, "BUILDING", instantInSlot(slot, begun.id, "created"));
    events.push(...deploymentEvents(building, PROJECT, accountId));
  }
  // Deployments that started earlier and finish in this slot. Their "building" event was already
  // seen in their first slot, so only the final one (and the replaced deployment) is new here.
  for (let start = slot - MAX_BUILD_SLOTS; start < slot; start += 1) {
    for (const started of startedIn(accountId, start, volume)) {
      if (start + started.buildSlots !== slot) continue;
      const roll = between(0, 99, started.id, "outcome");
      const status = roll < 80 ? "SUCCESS" : roll < 92 ? "FAILED" : "CRASHED";
      const finishedAt = instantInSlot(slot, started.id, "finished");
      const final = deploymentEvents(deployment(started, status, finishedAt), PROJECT, accountId);
      events.push(...final.filter((event) => event.typeId !== "railway.deployment.building"));
      if (status === "SUCCESS") {
        // The replaced deployment's own start is not simulated, so only its removal is new here.
        const replaced = deployment({ ...started, id: `${started.id}-previous` }, "REMOVED", finishedAt);
        events.push(...deploymentEvents(replaced, PROJECT, accountId).filter((event) => event.typeId !== "railway.deployment.building"));
      }
    }
  }
  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

/** Busier in the UTC working day, the same for the same hour. */
function perHour(accountId: string, measurement: string, low: number, high: number): (hourStartMs: number) => number {
  return (hourStartMs) => {
    const hourOfDay = new Date(hourStartMs).getUTCHours();
    const busy = hourOfDay >= 8 && hourOfDay < 20 ? Math.floor((high - low) / 2) : 0;
    return low + busy + between(0, Math.floor((high - low) / 2), accountId, measurement, hourStartMs);
  };
}

function metrics(accountId: string, at: Date): AdapterMetric[] {
  const start = utcMonthStart(at);
  const end = utcNextMonthStart(at);
  const elapsedMs = Math.max(at.getTime() - start.getTime(), HOUR_MS);
  const scale = (end.getTime() - start.getTime()) / elapsedMs;
  const sum = (measurement: string, low: number, high: number) =>
    accrued(start.getTime(), at.getTime(), perHour(accountId, measurement, low, high));

  // vCPU-minutes and GB-minutes per hour, egress in MB per hour; a 5 GB volume all month.
  const used = {
    CPU_USAGE: sum("cpu", 20, 60),
    MEMORY_USAGE_GB: sum("memory", 60, 180),
    NETWORK_TX_GB: sum("egress", 50, 400) / 1000,
    DISK_USAGE_GB: (5 * (at.getTime() - start.getTime())) / 60_000,
  } as const;
  const rows = measurements.map((measurement) => ({ measurement, value: used[measurement] }));
  const costUsd = rows.reduce((total, { measurement, value }) => total + value * Number(measurementSpecs[measurement].unitPrice), 0);

  const billing: BillingData = {
    workspace: {
      plan: "HOBBY",
      customer: { billingPeriod: { start, end }, currentUsage: costUsd, creditBalance: CREDIT_BALANCE_USD },
    },
    usage: rows,
    // Railway estimates per project; the simulated workspace has one.
    estimatedUsage: rows.map(({ measurement, value }) => ({ measurement, estimatedValue: value * scale, projectId: "sim-project" })),
  };
  return billingMetrics(billing, accountId, at, ENDPOINT);
}

export const railwayProfile: SimulatedProfile = {
  real: railwayAdapter,
  accounts: (seed) => [{ externalId: `sim${seed}`, displayName: "Example workspace", kind: "workspace" }],
  metrics,
  eventsInSlot,
};
