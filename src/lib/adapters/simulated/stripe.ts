import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import { moneyMetrics, stripeAdapter, timelineEvents, toActivityEvent } from "@/lib/adapters/stripe";
import type { BalanceTransaction, StripeEvent } from "@/lib/adapters/stripe/schemas";
import type { AdapterContext } from "@/lib/adapters/types";

import {
  between,
  chance,
  countOf,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  instantInSlot,
  unit,
  utcMonthStart,
  type SimulatedProfile,
} from "./simulation";

/*
 * Simulated Stripe account selling in USD and EUR. Payments, the odd failure and refund, new
 * customers, and subscriptions trickle in every few seconds (about 4,300 payments a day); fees
 * and revenue accrue hour by hour as balance transactions per currency. Both go through the real
 * adapter's `toActivityEvent` and `moneyMetrics`, so currencies stay apart and amounts are integer
 * minor units exactly as in a real sync.
 */

type StripeType = (typeof timelineEvents)[number]["stripeType"];

// Chance of each event type in one 10 second slot; payments can come two or three at a time.
const EVENT_CHANCES: Readonly<Record<StripeType, readonly number[]>> = {
  "charge.succeeded": [0.35, 0.12, 0.03],
  "charge.failed": [0.02],
  "charge.refunded": [0.015],
  "customer.created": [0.15],
  "customer.subscription.created": [0.04],
  "customer.subscription.deleted": [0.01],
};

type CurrencyShape = Readonly<{
  currency: "USD" | "EUR";
  maxPaymentsPerHour: number;
  feePerThousand: number;
  fixedFeeMinor: number;
}>;

// About 180 payments an hour across both currencies, in line with the payment events above.
const CURRENCIES: readonly CurrencyShape[] = [
  { currency: "USD", maxPaymentsPerHour: 240, feePerThousand: 29, fixedFeeMinor: 30 },
  { currency: "EUR", maxPaymentsPerHour: 120, feePerThousand: 15, fixedFeeMinor: 25 },
];

// Long enough for the real adapter's month and last 30 days windows.
const MONEY_LOOKBACK_MS = 31 * DAY_MS;

function objectFor(type: StripeType, id: string, parts: readonly (string | number)[]): Record<string, unknown> {
  switch (type) {
    case "charge.succeeded":
      return { id: `ch_${id}` };
    case "charge.failed":
      return { id: `ch_${id}`, failure_code: chance(0.5, ...parts, "code") ? "card_declined" : "insufficient_funds" };
    case "charge.refunded":
      return { id: `ch_${id}`, refunded: chance(0.7, ...parts, "full") };
    case "customer.created":
      return { id: `cus_${id}` };
    case "customer.subscription.created":
      return { id: `sub_${id}`, status: "active" };
    case "customer.subscription.deleted":
      return { id: `sub_${id}`, status: "canceled" };
  }
}

function eventsInSlot(accountId: string, slot: number): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  for (const { stripeType } of timelineEvents) {
    const count = countOf(EVENT_CHANCES[stripeType], accountId, stripeType, slot);
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
    const payments = between(0, shape.maxPaymentsPerHour, ...parts, "payments");
    if (payments > 0) {
      const gross = Math.floor(payments * between(1900, 7900, ...parts, "price") * share);
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
    // Refunds for the hour land at a fixed minute of it, once that minute has passed.
    const refundAt = hourMs + between(0, 59, ...parts, "refund-at") * MINUTE_MS;
    if (chance(0.9, ...parts, "refund") && refundAt <= nowMs) {
      transactions.push({
        id: `txn_simrefund${shape.currency}${hourMs.toString(36)}`,
        amount: -between(2000, 20000, ...parts, "refund-amount"),
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
