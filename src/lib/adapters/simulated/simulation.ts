import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import type { AdapterContext, ExternalAccount, ProviderAdapter } from "@/lib/adapters/types";

/*
 * Shared clock and randomness for the simulated providers (#131). Every value is a pure function
 * of the account id and a whole 10 second slot, hour, or UTC day, so the same clock always produces
 * the same numbers, events, and dedupe keys, and tests pin the clock instead of the randomness.
 * Slots are short so `npm run jobs:tick -- --watch`, which ticks every 10 seconds, sees new data on
 * most ticks.
 */

export const SLOT_MS = 10_000;
export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
export const SLOTS_PER_HOUR = HOUR_MS / SLOT_MS;

/** What one provider's simulation adds to the shared factory in `index.ts`. */
export type SimulatedProfile = Readonly<{
  /** The real adapter: its id, capabilities, event types, and data list are reused unchanged. */
  real: ProviderAdapter;
  /** The accounts a grant covers, derived from the random seed minted with the credential. */
  accounts: (seed: string) => readonly ExternalAccount[];
  /** Metrics as read at `at`, the start of a slot. */
  metrics: (accountId: string, at: Date, ctx: AdapterContext) => AdapterMetric[];
  /**
   * Events a sync first sees in `slot` (10 second slots since the Unix epoch), oldest first. Most
   * happen in that slot; a daily summary is seen at UTC midnight and dated like the real adapter's.
   */
  eventsInSlot: (accountId: string, slot: number) => ActivityEvent[];
}>;

/** 32-bit FNV-1a over the parts, then the murmur3 finalizer so nearby inputs spread apart. */
function hash32(parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  const text = parts.join("|");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** A number in [0, 1), the same for the same parts. */
export function unit(...parts: readonly (string | number)[]): number {
  return hash32(parts) / 0x1_0000_0000;
}

/** An integer in [min, max], inclusive, the same for the same parts. */
export function between(min: number, max: number, ...parts: readonly (string | number)[]): number {
  return min + Math.floor(unit(...parts) * (max - min + 1));
}

/** True with probability `p`, the same for the same parts. */
export function chance(p: number, ...parts: readonly (string | number)[]): boolean {
  return unit(...parts) < p;
}

/** How many of `p.length` independent chances came up, e.g. events in one slot. */
export function countOf(probabilities: readonly number[], ...parts: readonly (string | number)[]): number {
  return probabilities.filter((p, index) => chance(p, ...parts, index)).length;
}

export function slotOf(at: Date): number {
  return Math.floor(at.getTime() / SLOT_MS);
}

/** An instant inside `slot`, offset by a stable whole number of seconds. */
export function instantInSlot(slot: number, ...parts: readonly (string | number)[]): Date {
  return new Date(slot * SLOT_MS + between(0, SLOT_MS / 1000 - 1, ...parts) * 1000);
}

export function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function utcMonthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

export function utcNextMonthStart(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
}

/**
 * A running total from `startMs` to `atMs` (both whole slots) of an amount that accrues hour by
 * hour: whole hours count in full and the current hour pro rata to the millisecond, rounded down,
 * so the total never shrinks as the clock moves forward within a period.
 */
export function accrued(startMs: number, atMs: number, perHour: (hourStartMs: number) => number): number {
  let total = 0;
  let hour = Math.floor(startMs / HOUR_MS) * HOUR_MS;
  for (; hour + HOUR_MS <= atMs; hour += HOUR_MS) total += perHour(hour);
  if (hour < atMs) total += Math.floor((perHour(hour) * (atMs - hour)) / HOUR_MS);
  return total;
}

/** "simulated:<provider>/<path>", the provenance endpoint for numbers nobody read from an API. */
export function simulatedEndpoint(provider: string, path: string): string {
  return `simulated:${provider}${path}`;
}
