import {
  balanceMetrics,
  deploymentEvents,
  digitaloceanAdapter,
  dropletActionEvent,
  dropletActionTypes,
  invoiceEvent,
  invoiceMetric,
  productTotals,
  skuSpendMetrics,
} from "@/lib/adapters/digitalocean";
import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import type { Decimal } from "@/lib/money";

import {
  accrued,
  between,
  chance,
  DAY_MS,
  instantInSlot,
  laneParts,
  lanesAt,
  SLOT_MS,
  simulatedEndpoint,
  unit,
  utcDayStart,
  utcMonthStart,
  type SimulatedProfile,
} from "./simulation";

/*
 * Simulated DigitalOcean team: two App Platform apps deploy about 35 times a day (one or two minutes
 * to build, some fail), Droplets are created, resized, power cycled, and deleted a dozen times a
 * day, usage grows hour by hour through the month, yesterday's spend is split by SKU, and an
 * invoice for the month before lands at 00:00 UTC on the 1st. A higher event volume (#383) multiplies
 * the deployments and Droplet actions; the invoice keeps its date. Everything goes through the real
 * adapter's metric and event builders, so keys, titles, severities, and dedupe keys match a real
 * sync; only the provenance endpoints say "simulated".
 */

const PROVIDER = "digitalocean";
const APPS = ["storefront", "admin"] as const;
const DROPLETS = ["web-1", "web-2", "worker-1", "db-proxy"] as const;
const REGIONS = ["nyc3", "ams3", "lon1"] as const;
// Cents a day per SKU before the per-day wobble, with the product the invoice names it under.
const SKUS = [
  { sku: "1-DO-DROP-0109", product: "Droplets", baseMinor: 96, wobbleMinor: 8 },
  { sku: "1-DO-DROP-0112", product: "Droplets", baseMinor: 192, wobbleMinor: 12 },
  { sku: "1-AP-PRO-0002", product: "App Platform", baseMinor: 40, wobbleMinor: 10 },
  { sku: "1-SP-SUB-0001", product: "Spaces Subscription", baseMinor: 16, wobbleMinor: 0 },
  { sku: "1-DB-PG-0003", product: "Managed Databases", baseMinor: 50, wobbleMinor: 4 },
] as const;
const DEPLOYMENT_CHANCE = 0.004;
const DEPLOYMENT_FAILURE_CHANCE = 0.12;
// Builds take 1 to 6 minutes, in whole slots.
const MIN_BUILD_SLOTS = 6;
const MAX_BUILD_SLOTS = 36;
const DROPLET_ACTION_CHANCE = 0.0015;
const DROPLET_ACTION_FAILURE_CHANCE = 0.05;

function cents(minor: number): Decimal {
  return { coefficient: BigInt(minor), scale: 2 };
}

function skuDayMinor(accountId: string, sku: (typeof SKUS)[number], dayStartMs: number): number {
  return sku.baseMinor + between(0, sku.wobbleMinor, accountId, "sku", sku.sku, dayStartMs);
}

/** An hour's share of its day, rounded down, so month-to-date usage grows within the day. */
function usagePerHour(accountId: string): (hourStartMs: number) => number {
  return (hourStartMs) => {
    const dayStart = utcDayStart(hourStartMs);
    return Math.floor(SKUS.reduce((sum, sku) => sum + skuDayMinor(accountId, sku, dayStart), 0) / 24);
  };
}

/** The real builder's metric, with a provenance endpoint that says nobody read it from an API. */
function withSimulatedEndpoint(metric: AdapterMetric, path: string): AdapterMetric {
  const endpoint = simulatedEndpoint(PROVIDER, path);
  // Narrowed first: an estimate's provenance has its own, stricter type.
  if (metric.kind === "estimated_spend") return { ...metric, provenance: { ...metric.provenance, endpoint } };
  return { ...metric, provenance: { ...metric.provenance, endpoint } };
}

function previousInvoice(accountId: string, at: Date) {
  const end = utcMonthStart(at);
  const start = utcMonthStart(new Date(end.getTime() - DAY_MS));
  const totals = new Map<string, number>();
  for (let day = start.getTime(); day < end.getTime(); day += DAY_MS) {
    for (const sku of SKUS) totals.set(sku.product, (totals.get(sku.product) ?? 0) + skuDayMinor(accountId, sku, day));
  }
  const amountMinor = [...totals.values()].reduce((sum, value) => sum + value, 0);
  return {
    invoice: {
      invoice_uuid: `inv-sim-${accountId}-${start.toISOString().slice(0, 7)}`,
      amount: cents(amountMinor),
      invoice_period: start.toISOString().slice(0, 7),
    },
    items: [...totals].map(([product, minor]) => ({ product, amount: cents(minor) })),
  };
}

function metrics(accountId: string, at: Date): AdapterMetric[] {
  const monthStart = utcMonthStart(at);
  const usage = accrued(monthStart.getTime(), at.getTime(), usagePerHour(accountId));
  // A monthly promotional credit that the month's usage draws down.
  const creditMinor = Math.max(0, between(2000, 6000, accountId, "credit", monthStart.getTime()) - usage);
  const result = balanceMetrics(
    { month_to_date_usage: cents(usage), account_balance: cents(-creditMinor), generated_at: at },
    accountId,
    at,
  ).map((metric) => withSimulatedEndpoint(metric, "/v2/customers/my/balance"));

  const latest = invoiceMetric(previousInvoice(accountId, at).invoice, accountId, at);
  if (latest !== undefined) result.push(withSimulatedEndpoint(latest, "/v2/customers/my/invoices"));

  const yesterday = utcDayStart(at.getTime()) - DAY_MS;
  const daily = new Map(SKUS.map((sku) => [sku.sku, cents(skuDayMinor(accountId, sku, yesterday))] as const));
  for (const metric of skuSpendMetrics(daily, new Date(yesterday), accountId, at)) {
    result.push(withSimulatedEndpoint(metric, "/v2/billing/{account_urn}/insights/{start_date}/{end_date}"));
  }
  return result;
}

/** How long the deployment in volume lane `lane` of `startSlot` builds, in whole slots. */
function buildSlots(accountId: string, startSlot: number, lane: number): number {
  return between(MIN_BUILD_SLOTS, MAX_BUILD_SLOTS, ...laneParts(lane, accountId, "build", startSlot));
}

/**
 * The deployment that started in volume lane `lane` of `startSlot`, as the real API would show it
 * once `finished` is known. Its id hashes the lane's parts, so lanes never share one.
 */
function deploymentEventsFrom(accountId: string, startSlot: number, lane: number, finished: boolean): ActivityEvent[] {
  const parts = laneParts(lane, accountId, "deployment", startSlot);
  const app = APPS[between(0, APPS.length - 1, ...parts, "app")] ?? APPS[0];
  const endSlot = startSlot + buildSlots(accountId, startSlot, lane);
  const failed = chance(DEPLOYMENT_FAILURE_CHANCE, ...parts, "failed");
  const endedAt = instantInSlot(endSlot, ...parts, "end");
  return deploymentEvents(
    {
      id: `dep-sim-${Math.floor(unit(...parts, "id") * 1e12).toString(36)}${startSlot.toString(36)}`,
      phase: finished ? (failed ? "ERROR" : "ACTIVE") : "BUILDING",
      created_at: instantInSlot(startSlot, ...parts, "start"),
      ...(finished ? { phase_last_updated_at: endedAt, updated_at: endedAt } : {}),
    },
    app,
    accountId,
  );
}

/** The Droplet action in volume lane `lane` of `slot`; its id is drawn from the lane's parts. */
function dropletActionIn(accountId: string, slot: number, lane: number): ActivityEvent | undefined {
  const parts = laneParts(lane, accountId, "droplet", slot);
  const type = dropletActionTypes[between(0, dropletActionTypes.length - 1, ...parts, "type")] ?? "power_cycle";
  const droplet = between(0, DROPLETS.length - 1, ...parts, "name");
  const startedAt = new Date(slot * SLOT_MS);
  return dropletActionEvent(
    {
      id: between(100_000_000, 999_999_999, ...parts, "id"),
      status: chance(DROPLET_ACTION_FAILURE_CHANCE, ...parts, "failed") ? "errored" : "completed",
      type,
      started_at: startedAt,
      completed_at: instantInSlot(slot, ...parts, "done"),
      resource_id: 300_000_000 + droplet,
      resource_type: "droplet",
      region_slug: REGIONS[between(0, REGIONS.length - 1, ...parts, "region")] ?? REGIONS[0],
    },
    DROPLETS[droplet],
    accountId,
  );
}

function eventsInSlot(accountId: string, slot: number, volume: number): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const lane of lanesAt(DEPLOYMENT_CHANCE, volume, accountId, "deployment", slot)) {
    events.push(...deploymentEventsFrom(accountId, slot, lane, false));
  }
  // Deployments that started a build ago finish in this slot; their started event is already out.
  // Each lane of a start slot has its own build length, so every lane is checked against this slot.
  for (let start = slot - MAX_BUILD_SLOTS; start <= slot - MIN_BUILD_SLOTS; start += 1) {
    for (const lane of lanesAt(DEPLOYMENT_CHANCE, volume, accountId, "deployment", start)) {
      if (start + buildSlots(accountId, start, lane) !== slot) continue;
      events.push(
        ...deploymentEventsFrom(accountId, start, lane, true).filter((event) => event.typeId !== "digitalocean.deployment.started"),
      );
    }
  }
  for (const lane of lanesAt(DROPLET_ACTION_CHANCE, volume, accountId, "droplet", slot)) {
    const action = dropletActionIn(accountId, slot, lane);
    if (action !== undefined) events.push(action);
  }

  // The invoice for the month before is issued at 00:00 UTC on the 1st, a calendar event the
  // volume does not scale.
  const slotStart = new Date(slot * SLOT_MS);
  if (slotStart.getTime() === utcMonthStart(slotStart).getTime()) {
    const { invoice, items } = previousInvoice(accountId, slotStart);
    events.push(invoiceEvent(invoice, productTotals(items), accountId));
  }
  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

export const digitaloceanProfile: SimulatedProfile = {
  real: digitaloceanAdapter,
  accounts: (seed) => [{ externalId: `team-sim-${seed}`, displayName: "Example team", kind: "team" }],
  metrics,
  eventsInSlot,
};
