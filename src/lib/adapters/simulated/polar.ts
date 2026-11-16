import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import {
  analyticsMetrics,
  newCustomersMetric,
  orderEvent,
  polarAdapter,
  refundEvent,
  subscriptionCanceledEvent,
  subscriptionStartedEvent,
} from "@/lib/adapters/polar";
import type { MetricPeriod, Order, Subscription } from "@/lib/adapters/polar/schemas";
import type { AdapterContext } from "@/lib/adapters/types";

import {
  between,
  chance,
  countAtVolume,
  dailyCountInHour,
  DAY_MS,
  HOUR_MS,
  instantInSlot,
  unit,
  utcDayStart,
  utcMonthStart,
  type SimulatedProfile,
} from "./simulation";

/*
 * Simulated Polar organization of a small product (#264) selling a software subscription and a few
 * one-time products: a paid order (mostly renewals) or two a day, about a thousand dollars of
 * MRR, a new subscription most days, and the odd cancellation and refund. Revenue, fees, and order
 * counts accrue hour by hour into the daily periods Polar's metrics endpoint returns. Both go
 * through the real adapter's `analyticsMetrics` and event builders, so amounts are rounded once
 * into USD cents and kinds stay apart exactly as in a real sync: revenue as revenue, Polar fees as
 * spend, MRR and ARR as recurring revenue.
 */

type Stream = "order" | "started" | "canceled" | "refund";

// Chance of each event in one 10 second slot (8,640 a day), in line with the hourly totals below:
// about 1.5 paid orders, 0.7 new and 0.3 canceled subscriptions a day, and a refund a month.
const EVENT_CHANCES: Readonly<Record<Stream, readonly number[]>> = {
  order: [0.00017],
  started: [0.00008],
  canceled: [0.00003],
  refund: [0.000004],
};

const BILLING_REASONS = ["subscription_cycle", "subscription_cycle", "subscription_create", "purchase"] as const;
const CANCELLATION_REASONS = ["too_expensive", "unused", "missing_features", "switched_service", "other"] as const;
const REFUND_REASONS = ["customer_request", "duplicate", "satisfaction_guarantee", "other"] as const;

// The monthly plan, in cents. MRR moves by one plan for each subscription gained or lost. A paid
// order is a plan payment, or a one-time product at ONE_TIME_CENTS, so the timeline prints amounts
// (#261) in line with the revenue below; a refund returns one plan.
const PLAN_CENTS = 1900;
const ONE_TIME_CENTS = 4900;

function pick<T>(values: readonly T[], ...parts: readonly (string | number)[]): T {
  const value = values[Math.floor(unit(...parts) * values.length)];
  if (value === undefined) throw new Error("pick needs at least one value");
  return value;
}

function subscription(id: string, overrides: Partial<Subscription>): Subscription {
  return {
    id,
    status: "active",
    started_at: null,
    canceled_at: null,
    cancel_at_period_end: false,
    customer_cancellation_reason: null,
    ...overrides,
  };
}

function paidOrder(id: string, at: Date, parts: readonly (string | number)[]): Order {
  const billingReason = pick(BILLING_REASONS, ...parts, "reason");
  return {
    id,
    created_at: at,
    status: "paid",
    billing_reason: billingReason,
    total_amount: billingReason === "purchase" ? ONE_TIME_CENTS : PLAN_CENTS,
    currency: "USD",
  };
}

// Volume's extra occurrences follow the default volume's in `index`, which keeps every id in the slot apart.
function eventsInSlot(accountId: string, slot: number, volume: number): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const stream of ["order", "started", "canceled", "refund"] as const) {
    const count = countAtVolume(EVENT_CHANCES[stream], volume, accountId, stream, slot);
    for (let index = 0; index < count; index += 1) {
      const parts = [accountId, stream, slot, index] as const;
      const id = `sim-${Math.floor(unit(...parts, "id") * 1e14).toString(36)}-${slot.toString(36)}-${index}`;
      const at = instantInSlot(slot, ...parts, "at");
      const event =
        stream === "order"
          ? orderEvent(paidOrder(id, at, parts), accountId)
          : stream === "started"
            ? subscriptionStartedEvent(subscription(id, { started_at: at }), accountId)
            : stream === "canceled"
              ? subscriptionCanceledEvent(
                  subscription(id, {
                    canceled_at: at,
                    cancel_at_period_end: chance(0.8, ...parts, "period-end"),
                    customer_cancellation_reason: pick(CANCELLATION_REASONS, ...parts, "reason"),
                  }),
                  accountId,
                )
              : refundEvent(
                  {
                    id,
                    created_at: at,
                    status: "succeeded",
                    reason: pick(REFUND_REASONS, ...parts, "reason"),
                    amount: PLAN_CENTS,
                    tax_amount: 0,
                    currency: "USD",
                  },
                  accountId,
                );
      if (event !== undefined) events.push(event);
    }
  }
  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

type HourTotals = {
  orders: number;
  revenue: number;
  netRevenue: number;
  newSubscriptions: number;
  canceledSubscriptions: number;
  newCustomers: number;
};

const EMPTY_TOTALS: Readonly<HourTotals> = {
  orders: 0,
  revenue: 0,
  netRevenue: 0,
  newSubscriptions: 0,
  canceledSubscriptions: 0,
  newCustomers: 0,
};

/** One hour's orders, gross revenue, and revenue after Polar's fees (cents), plus counts. */
function hourOf(accountId: string, hourMs: number): HourTotals {
  // One or two orders a day at $9 to $49: roughly $1,300 a month, in line with the MRR below. A
  // day's fees never pass $6, so they never look like a spend spike (#169).
  const orders = dailyCountInHour(1, 2, hourMs, accountId, "orders");
  const revenue = orders * between(900, 4900, accountId, "price", hourMs);
  // Polar's Starter rate, 5% + 50¢ per transaction (Polar, Merchant of Record, Fees,
  // https://polar.sh/docs/merchant-of-record/fees, checked 2026-11-05).
  const fees = Math.floor(revenue / 20) + orders * 50;
  return {
    orders,
    revenue,
    netRevenue: Math.max(0, revenue - fees),
    newSubscriptions: chance(0.03, accountId, "new-subs", hourMs) ? 1 : 0,
    canceledSubscriptions: chance(0.012, accountId, "canceled-subs", hourMs) ? 1 : 0,
    newCustomers: chance(0.05, accountId, "customers", hourMs) ? 1 : 0,
  };
}

const HOUR_FIELDS = [
  "orders",
  "revenue",
  "netRevenue",
  "newSubscriptions",
  "canceledSubscriptions",
  "newCustomers",
] as const satisfies readonly (keyof HourTotals)[];

/**
 * Daily totals from the first of the month to `at`, each hour computed once. The hour still
 * running counts pro rata, rounded down, so no total shrinks as the clock moves on.
 */
function dailyTotals(accountId: string, monthStartMs: number, nowMs: number): Map<number, HourTotals> {
  const days = new Map<number, HourTotals>();
  for (let dayMs = monthStartMs; dayMs <= nowMs; dayMs += DAY_MS) days.set(dayMs, { ...EMPTY_TOTALS });
  for (let hourMs = monthStartMs; hourMs < nowMs; hourMs += HOUR_MS) {
    const hour = hourOf(accountId, hourMs);
    const share = Math.min(HOUR_MS, nowMs - hourMs);
    const day = days.get(utcDayStart(hourMs));
    if (day === undefined) continue;
    for (const field of HOUR_FIELDS) day[field] += Math.floor((hour[field] * share) / HOUR_MS);
  }
  return days;
}

function metrics(accountId: string, at: Date, ctx: AdapterContext): AdapterMetric[] {
  const nowMs = at.getTime();
  const monthStartMs = utcMonthStart(at).getTime();
  // $800 to $2,000 of MRR, the order of the month's revenue from the orders above.
  const baseMrrCents = between(80_000, 200_000, accountId, "mrr");
  // A yearly plan counts a twelfth of its price, so MRR carries a fraction of a cent like Polar's.
  const yearlyCents = 19_000 * between(1, 5, accountId, "yearly");
  const periods: MetricPeriod[] = [];
  let netSubscriptions = 0;
  let newCustomers = 0;
  for (const [dayMs, day] of dailyTotals(accountId, monthStartMs, nowMs)) {
    netSubscriptions += day.newSubscriptions - day.canceledSubscriptions;
    newCustomers += day.newCustomers;
    const mrr = Math.max(0, baseMrrCents + netSubscriptions * PLAN_CENTS + yearlyCents / 12);
    periods.push({
      timestamp: new Date(dayMs),
      revenue: day.revenue,
      net_revenue: day.netRevenue,
      orders: day.orders,
      new_subscriptions: day.newSubscriptions,
      canceled_subscriptions: day.canceledSubscriptions,
      active_subscriptions: Math.round(mrr / PLAN_CENTS),
      monthly_recurring_revenue: mrr,
      annual_recurring_revenue: mrr * 12,
    });
  }
  return [...analyticsMetrics({ periods }, at, accountId, ctx), ...newCustomersMetric(newCustomers, at, accountId)];
}

export const polarProfile: SimulatedProfile = {
  real: polarAdapter,
  accounts: (seed) => [{ externalId: `sim-org-${seed}`, displayName: "Example organization", kind: "organization" }],
  metrics,
  eventsInSlot,
  // No `webhooks`: the live adapter's declaration (#429) is forwarded, with automatic setup kept in
  // this process and its `webhooks:write` swapped for the simulated write scope
  // (simulated/webhooks.ts). A signed delivery runs the live `verify` and `parse`, so one naming the
  // twin's `sim-org-<seed>` organization is stored on that connection like a real one.
};
