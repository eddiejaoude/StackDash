import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import { deliveryMetrics, eventTypes, resendAdapter, usageMetrics } from "@/lib/adapters/resend";

import {
  between,
  chance,
  DAY_MS,
  instantInSlot,
  utcDayStart,
  utcMonthStart,
  utcNextMonthStart,
  type SimulatedProfile,
} from "./simulation";

/*
 * Simulated Resend team on the free plan (100 emails a day, 3,000 a month). Each UTC day sends
 * 93 to 100 percent of the daily quota at a steady pace, so the daily quota crosses 75 percent in
 * the evening and 90 percent a few hours later; the monthly quota fills up over the month. A
 * domain is verified or fails verification now and then. The numbers go through the real
 * adapter's `usageMetrics` and `deliveryMetrics`, so keys, labels, and allowances match a sync.
 */

const DAILY_LIMIT = 100;
const MONTHLY_LIMIT = 3000;
const DELIVERY_WINDOW_MS = 7 * DAY_MS;
type DomainTypeId = (typeof eventTypes)[number]["id"];

/** Emails sent on the UTC day starting at `dayStartMs`, up to `untilMs`. */
function sentOnDay(accountId: string, dayStartMs: number, untilMs: number): number {
  const share = between(93, 100, accountId, "daily-share", dayStartMs) / 100;
  const elapsed = Math.min(1, Math.max(0, (untilMs - dayStartMs) / DAY_MS));
  return Math.floor(DAILY_LIMIT * share * elapsed);
}

/** Emails sent in [fromMs, toMs). */
function sentBetween(accountId: string, fromMs: number, toMs: number): number {
  let total = 0;
  for (let day = utcDayStart(fromMs); day < toMs; day += DAY_MS) {
    total += sentOnDay(accountId, day, Math.min(toMs, day + DAY_MS)) - sentOnDay(accountId, day, Math.max(fromMs, day));
  }
  return total;
}

function metrics(accountId: string, at: Date): AdapterMetric[] {
  const now = at.getTime();
  const dayStart = utcDayStart(now);
  const usage = usageMetrics(
    {
      object: "usage",
      emails: {
        daily: { used: sentOnDay(accountId, dayStart, now), limit: DAILY_LIMIT, resets_at: new Date(dayStart + DAY_MS) },
        monthly: {
          used: sentBetween(accountId, utcMonthStart(at).getTime(), now),
          limit: MONTHLY_LIMIT,
          resets_at: utcNextMonthStart(at),
        },
      },
    },
    accountId,
    at,
  );
  const start = new Date(now - DELIVERY_WINDOW_MS);
  const sent = sentBetween(accountId, start.getTime(), now);
  const delivery = deliveryMetrics(
    {
      object: "metrics",
      start_date: start,
      end_date: at,
      totals: {
        delivered: Math.floor((sent * 97) / 100),
        bounced: Math.floor((sent * 25) / 1000),
        complained: Math.floor((sent * 2) / 1000),
      },
    },
    accountId,
    at,
  );
  return [...usage, ...delivery];
}

function eventsInSlot(accountId: string, slot: number): ActivityEvent[] {
  // About 20 domain status changes a day (8,640 slots).
  if (!chance(0.0023, accountId, "domain", slot)) return [];
  const domain = `mail${between(1, 99, accountId, "domain-name", slot)}.example.com`;
  const typeId: DomainTypeId = chance(0.8, accountId, "domain-verified", slot)
    ? "resend.domain.verified"
    : "resend.domain.failed";
  const verified = typeId === "resend.domain.verified";
  return [
    {
      typeId,
      occurredAt: instantInSlot(slot, accountId, "domain-at"),
      severity: verified ? "success" : "critical",
      title: verified ? `Domain ${domain} verified` : `Domain ${domain} failed verification`,
      ...(verified
        ? {}
        : { body: "Resend could not find the domain's DNS records within 72 hours. Check its DNS settings in Resend." }),
      externalAccountId: accountId,
      // The slot keeps two changes of the same simulated domain apart.
      dedupeKey: `resend.domain:${accountId}:${domain}:${typeId}:${slot}`,
    },
  ];
}

export const resendProfile: SimulatedProfile = {
  real: resendAdapter,
  accounts: (seed) => [{ externalId: `sim${seed}`, displayName: "Resend team (mail.example.com)", kind: "team" }],
  metrics,
  eventsInSlot,
};
