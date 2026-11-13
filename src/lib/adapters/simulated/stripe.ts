import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import { moneyMetrics, stripeAdapter, timelineEvents, toActivityEvent } from "@/lib/adapters/stripe";
import type { BalanceTransaction, StripeEvent } from "@/lib/adapters/stripe/schemas";
import type { AdapterContext } from "@/lib/adapters/types";

import {
  between,
  chance,
  countAtVolume,
  dailyCountInHour,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  SLOT_MS,
  instantInSlot,
  unit,
  utcMonthStart,
  type SimulatedProfile,
} from "./simulation";

/*
 * Simulated Stripe account of a small product selling in USD and EUR (#264): about three payments a
 * day, a few thousand dollars a month, the odd failure and refund, about 50 new customers and a
 * subscription started most days. Fees and revenue accrue hour by hour as balance transactions per
 * currency. Both go through the real adapter's `toActivityEvent` and `moneyMetrics`, so currencies
 * stay apart and amounts are integer minor units exactly as in a real sync.
 */

/**
 * New Stripe customers a day (#264, decided on pull request #290): in line with the simulated
 * Supabase signups (about 52 on a weekday). A `customer.created` event carries no amount, but it is
 * counted in more than the timeline, so its rate has to stay believable beside the money:
 * - the "Signups" trend marker category (`src/lib/dashboard/markers.ts`), which also names the
 *   events in the dashboard's "What changed" sentences (`src/lib/dashboard/what-changed.ts`);
 * - the public metric "New customers in 30 days" (`stripe-customers-30d` in
 *   `src/lib/public-metrics/definitions.ts`), which the demo seed publishes on its project page.
 * The headline's signups leave it out (`eventTypes` in src/lib/adapters/stripe/index.ts).
 */
export const NEW_CUSTOMERS_PER_DAY = 50;

type StripeType = (typeof timelineEvents)[number]["stripeType"];

// Chance of each event type in one 10 second slot (8,640 a day). Payments match CURRENCIES below,
// about 3 a day, and the money events are scaled to them.
const EVENT_CHANCES: Readonly<Record<StripeType, readonly number[]>> = {
  "charge.succeeded": [0.00036],
  "charge.failed": [0.00003],
  "charge.refunded": [0.00001],
  "customer.created": [NEW_CUSTOMERS_PER_DAY / (DAY_MS / SLOT_MS)],
  "customer.subscription.created": [0.00012],
  "customer.subscription.deleted": [0.00004],
};

type CurrencyShape = Readonly<{
  currency: "USD" | "EUR";
  /** The fewest and most payments in a UTC day. */
  paymentsPerDay: readonly [number, number];
  refundChancePerHour: number;
  feePerThousand: number;
  fixedFeeMinor: number;
}>;

// 1 to 3 USD and up to 2 EUR payments a day at 19 to 49 a payment: roughly $2,000 and €1,000 a
// month, the order of the demo's $600 Vercel budget (src/lib/demo/workspace.ts), with a refund
// every few weeks. A day's fees never pass $6, so they never look like a spend spike (#169).
const CURRENCIES: readonly CurrencyShape[] = [
  { currency: "USD", paymentsPerDay: [1, 3], refundChancePerHour: 0.002, feePerThousand: 29, fixedFeeMinor: 30 },
  { currency: "EUR", paymentsPerDay: [0, 2], refundChancePerHour: 0.001, feePerThousand: 15, fixedFeeMinor: 25 },
];
const PRICE_MINOR = [1900, 4900] as const;

// Long enough for the real adapter's month and last 30 days windows.
const MONEY_LOOKBACK_MS = 31 * DAY_MS;

/**
 * A charge at one of PRICE_MINOR's prices, in USD twice as often as EUR like CURRENCIES, so the
 * timeline prints amounts (#261) on the same scale as the revenue they add up to.
 */
function chargeFor(id: string, parts: readonly (string | number)[]): { id: string; amount: number; currency: string } {
  return {
    id: `ch_${id}`,
    amount: chance(0.5, ...parts, "price") ? PRICE_MINOR[0] : PRICE_MINOR[1],
    currency: chance(1 / 3, ...parts, "currency") ? "eur" : "usd",
  };
}

function objectFor(type: StripeType, id: string, parts: readonly (string | number)[]): Record<string, unknown> {
  switch (type) {
    case "charge.succeeded":
      return chargeFor(id, parts);
    case "charge.failed":
      return { ...chargeFor(id, parts), failure_code: chance(0.5, ...parts, "code") ? "card_declined" : "insufficient_funds" };
    case "charge.refunded": {
      const charge = chargeFor(id, parts);
      const full = chance(0.7, ...parts, "full");
      // A partial refund is a whole number of units, at least one and short of the price.
      const refundedMinor = full ? charge.amount : 100 * between(1, charge.amount / 100 - 1, ...parts, "refunded");
      return { ...charge, refunded: full, amount_refunded: refundedMinor };
    }
    case "customer.created":
      return { id: `cus_${id}` };
    case "customer.subscription.created":
      return { id: `sub_${id}`, status: "active" };
    case "customer.subscription.deleted":
      return { id: `sub_${id}`, status: "canceled" };
  }
}

// Volume's extra occurrences follow the default volume's in `index`, which keeps every id in the slot apart.
function eventsInSlot(accountId: string, slot: number, volume: number): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const { stripeType } of timelineEvents) {
    const count = countAtVolume(EVENT_CHANCES[stripeType], volume, accountId, stripeType, slot);
    for (let index = 0; index < count; index += 1) {
      const parts = [accountId, stripeType, slot, index] as const;
      const id = `sim${Math.floor(unit(...parts, "id") * 1e14).toString(36)}${slot.toString(36)}`;
      const raw: StripeEvent = {
        id: `evt_${id}${index}`,
        type: stripeType,
        created: Math.floor(instantInSlot(slot, ...parts, "at").getTime() / 1000),
        data: { object: objectFor(stripeType, id, parts) },
      };
      const event = toActivityEvent(raw, accountId);
      if (event !== undefined) events.push(event);
    }
  }
  return events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
}

/** One hour of payments and refunds per currency, pro rata for the hour still running. */
function hourTransactions(accountId: string, hourMs: number, nowMs: number): BalanceTransaction[] {
  const share = Math.min(1, (nowMs - hourMs) / HOUR_MS);
  const created = Math.floor(hourMs / 1000);
  const transactions: BalanceTransaction[] = [];
  for (const shape of CURRENCIES) {
    const parts = [accountId, shape.currency, hourMs] as const;
    const payments = dailyCountInHour(shape.paymentsPerDay[0], shape.paymentsPerDay[1], hourMs, accountId, shape.currency, "payments");
    if (payments > 0) {
      const gross = Math.floor(payments * between(PRICE_MINOR[0], PRICE_MINOR[1], ...parts, "price") * share);
      const fee = Math.floor((gross * shape.feePerThousand) / 1000) + Math.floor(payments * shape.fixedFeeMinor * share);
      transactions.push({
        id: `txn_sim${shape.currency}${hourMs.toString(36)}`,
        amount: gross,
        created,
        currency: shape.currency,
        fee_details: [{ amount: fee, currency: shape.currency, type: "stripe_fee" }],
        type: "charge",
      });
    }
    // A refund of one payment lands at a fixed minute of the hour, once that minute has passed.
    const refundAt = hourMs + between(0, 59, ...parts, "refund-at") * MINUTE_MS;
    if (chance(shape.refundChancePerHour, ...parts, "refund") && refundAt <= nowMs) {
      transactions.push({
        id: `txn_simrefund${shape.currency}${hourMs.toString(36)}`,
        amount: -between(PRICE_MINOR[0], PRICE_MINOR[1], ...parts, "refund-amount"),
        created: Math.floor(refundAt / 1000),
        currency: shape.currency,
        fee_details: [],
        type: "refund",
      });
    }
  }
  return transactions;
}

function metrics(accountId: string, at: Date, ctx: AdapterContext): AdapterMetric[] {
  const now = at.getTime();
  const from = Math.min(utcMonthStart(at).getTime(), now - MONEY_LOOKBACK_MS);
  const transactions: BalanceTransaction[] = [];
  for (let hour = Math.floor(from / HOUR_MS) * HOUR_MS; hour < now; hour += HOUR_MS) {
    transactions.push(...hourTransactions(accountId, hour, now));
  }
  return moneyMetrics(transactions, at, accountId, ctx);
}

export const stripeProfile: SimulatedProfile = {
  real: stripeAdapter,
  accounts: (seed) => [{ externalId: `acct_sim${seed}`, displayName: "Example Stripe account (test mode)", kind: "account" }],
  metrics,
  eventsInSlot,
};
