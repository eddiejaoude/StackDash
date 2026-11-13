import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import {
  billingMetrics,
  postHogAdapter,
  signupEvents,
  signupMetric,
  usageLimitEvents,
  type SignupDay,
} from "@/lib/adapters/posthog";
import type { BillingResponse } from "@/lib/adapters/posthog/schemas";

import {
  accrued,
  between,
  chance,
  DAY_MS,
  instantInSlot,
  laneParts,
  lanesAt,
  SLOT_MS,
  utcMonthStart,
  utcNextMonthStart,
  type SimulatedProfile,
} from "./simulation";

/*
 * Simulated PostHog organization on the pay-as-you-go plan with two projects, billed monthly in
 * US Cloud. Product analytics events outgrow the free million around the third week, session
 * replay has a billing limit it nears late in the month, and feature flags stay inside the free
 * tier. Signups for the day before land at UTC midnight, one event per project, and now and then a
 * usage limit warning comes in. Spend so far is the organization's total with each product's spend
 * beside it, as PostHog's billing overview reports them; the real `billingMetrics` stores the
 * products one segment below the total, so the dashboard counts the total once (#204). Every number
 * goes through the real adapter's builders, so keys, labels, and event types match a real sync.
 */

const REGION = "us";
const PROJECTS = [
  { id: 10001, name: "Example app", signups: [40, 120] },
  { id: 10002, name: "Example app staging", signups: [0, 6] },
] as const;

// Unit prices in micro dollars, so spend is integer arithmetic until it becomes a decimal string.
const PRODUCTS = [
  {
    type: "product_analytics",
    name: "Product analytics",
    unit: "event",
    perHour: [1500, 2500],
    free: 1_000_000,
    microUsdPerUnit: 50,
    usageLimit: null,
  },
  {
    type: "session_replay",
    name: "Session replay",
    unit: "recording",
    perHour: [6, 12],
    free: 5_000,
    microUsdPerUnit: 5_000,
    usageLimit: 7_000,
  },
  {
    type: "feature_flags",
    name: "Feature flags",
    unit: "request",
    perHour: [800, 1200],
    free: 1_000_000,
    microUsdPerUnit: 100,
    usageLimit: null,
  },
] as const;

type SimulatedProduct = (typeof PRODUCTS)[number];

function usdFromMicros(micros: number): string {
  return `${Math.floor(micros / 1_000_000)}.${String(micros % 1_000_000).padStart(6, "0")}`;
}

function usageBetween(accountId: string, product: SimulatedProduct, fromMs: number, toMs: number): number {
  const [min, max] = product.perHour;
  return accrued(fromMs, toMs, (hourMs) => between(min, max, accountId, product.type, hourMs));
}

function spendMicros(product: SimulatedProduct, used: number): number {
  return Math.max(0, used - product.free) * product.microUsdPerUnit;
}

function billingAt(accountId: string, at: Date): BillingResponse {
  const start = utcMonthStart(at);
  const end = utcNextMonthStart(at);
  let currentMicros = 0;
  let projectedMicros = 0;
  const products = PRODUCTS.map((product) => {
    const used = usageBetween(accountId, product, start.getTime(), at.getTime());
    // The rate is a pure function of the hour, so the whole period's usage is known in advance.
    const projectedUsage = usageBetween(accountId, product, start.getTime(), end.getTime());
    currentMicros += spendMicros(product, used);
    projectedMicros += spendMicros(product, projectedUsage);
    return {
      type: product.type,
      name: product.name,
      usage_key: `${product.unit}s`,
      unit: product.unit,
      current_usage: used,
      free_allocation: product.free,
      usage_limit: product.usageLimit,
      has_exceeded_limit: product.usageLimit !== null && used >= product.usageLimit,
      current_amount_usd: usdFromMicros(spendMicros(product, used)),
      projected_amount_usd: usdFromMicros(spendMicros(product, projectedUsage)),
    };
  });
  return {
    current_total_amount_usd: usdFromMicros(currentMicros),
    projected_total_amount_usd: usdFromMicros(projectedMicros),
    billing_period: { current_period_start: start, current_period_end: end },
    products,
  };
}

function signupsOn(accountId: string, dayStartMs: number): SignupDay[] {
  const date = new Date(dayStartMs).toISOString().slice(0, 10);
  return PROJECTS.map((project) => ({
    project: { id: project.id, name: project.name },
    date,
    signups: between(project.signups[0], project.signups[1], accountId, "signups", project.id, dayStartMs),
  }));
}

function metrics(accountId: string, at: Date): AdapterMetric[] {
  const yesterdayStart = Math.floor(at.getTime() / DAY_MS) * DAY_MS - DAY_MS;
  const yesterday = signupsOn(accountId, yesterdayStart);
  return [
    ...billingMetrics(billingAt(accountId, at), accountId, at, REGION),
    signupMetric(yesterday, new Date(yesterdayStart).toISOString().slice(0, 10), accountId, at, REGION),
  ];
}

/**
 * A usage limit warning for session replay, built by the real adapter from usage at 85 percent or
 * at 100 percent of its limit. The slot and, above lane 0, the volume lane join the dedupe key,
 * since the simulator raises the same level more than once a period, and sometimes in one slot.
 */
function limitWarning(accountId: string, slot: number, lane: number): ActivityEvent[] {
  const detectedAt = instantInSlot(slot, ...laneParts(lane, accountId, "limit-at"));
  const reached = chance(0.3, ...laneParts(lane, accountId, "limit-reached", slot));
  const limit = 7_000;
  const billing: BillingResponse = {
    billing_period: { current_period_start: utcMonthStart(detectedAt), current_period_end: utcNextMonthStart(detectedAt) },
    products: [
      {
        type: "session_replay",
        name: "Session replay",
        usage_key: "recordings",
        current_usage: reached ? limit : Math.floor(limit * 0.85),
        usage_limit: limit,
      },
    ],
  };
  return usageLimitEvents(billing, accountId, detectedAt, REGION).map((event) => ({
    ...event,
    dedupeKey: `${event.dedupeKey}:${laneParts(lane, slot).join(":")}`,
  }));
}

function eventsInSlot(accountId: string, slot: number, volume: number): ActivityEvent[] {
  const slotStart = slot * SLOT_MS;
  const events: ActivityEvent[] = [];
  // The day before is complete at UTC midnight, the moment the real adapter dates its signups. A
  // calendar event, so the volume does not scale it.
  if (slotStart % DAY_MS === 0) events.push(...signupEvents(signupsOn(accountId, slotStart - DAY_MS), accountId, REGION));
  // About 4 usage limit warnings a day (8,640 slots), times the volume.
  for (const lane of lanesAt(0.0005, volume, accountId, "limit", slot)) events.push(...limitWarning(accountId, slot, lane));
  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

export const postHogProfile: SimulatedProfile = {
  real: postHogAdapter,
  accounts: (seed) => [{ externalId: `sim${seed}`, displayName: "Example organization", kind: "organization" }],
  metrics,
  eventsInSlot,
};
