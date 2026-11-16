import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import type { AdapterContext, ExternalAccount, ProviderAdapter, WebhookSource } from "@/lib/adapters/types";
import type { SimulatedWebhookSetup } from "@/lib/adapters/simulated/webhooks";
import { TREND_DAYS } from "@/lib/dashboard/trends";

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
   * `volume` (DEFAULT_EVENT_VOLUME to MAX_EVENT_VOLUME) multiplies the chance of every random
   * occurrence, through `countAtVolume` and `lanesAt`; calendar events (daily summaries, monthly
   * invoices, fixed cadences) do not scale. At DEFAULT_EVENT_VOLUME only lane 0 occurs, so the
   * volume adds and changes nothing.
   */
  eventsInSlot: (accountId: string, slot: number, volume: number) => ActivityEvent[];
  /**
   * A per-connection webhook for a provider whose real adapter declares none yet (#426), used only
   * while `real.webhooks` is undefined. #427 (Resend) replaces it.
   */
  webhooks?: SimulatedWebhookSetup;
  /**
   * The sources of one account that the live adapter's per-source automatic setup lists (#428,
   * GitLab projects), so the twin's automatic setup gives each one a webhook.
   */
  webhookSources?: (accountId: string) => readonly WebhookSource[];
}>;

/**
 * Simulated event volume (#383), chosen with `npm run jobs:tick -- --watch --volume <n>` so live
 * screens can be tested without waiting. The default is the small product of #264.
 */
export const DEFAULT_EVENT_VOLUME = 1;
export const MAX_EVENT_VOLUME = 20;

/**
 * One thing made to happen on cue by `npm run demo:event` (#256), on top of what the profile makes
 * up. Its events are added to the sync it is built into, whatever slots that sync covers, and
 * its metrics, when given, are read instead of the profile's.
 */
export type SimulatedIncident = Readonly<{
  /** Events at `at`, the sync's clock. */
  events: (accountId: string, at: Date) => ActivityEvent[];
  metrics?: SimulatedProfile["metrics"];
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

type Part = string | number;

/**
 * The hash parts of occurrence `lane` (0 to volume - 1) of a random event. Lane 0 is the default
 * volume's occurrence and keeps its parts, so DEFAULT_EVENT_VOLUME changes nothing; every other
 * lane appends a marker, so its randomness differs and anything derived from its parts (ids,
 * dedupe keys) never repeats lane 0's.
 */
export function laneParts(lane: number, ...parts: readonly Part[]): Part[] {
  return lane === 0 ? [...parts] : [...parts, "volume", lane];
}

/** The lanes, 0 to volume - 1, in which an event with chance `p` per slot occurs, ascending. */
export function lanesAt(p: number, volume: number, ...parts: readonly Part[]): number[] {
  const lanes: number[] = [];
  for (let lane = 0; lane < volume; lane += 1) {
    if (chance(p, ...laneParts(lane, ...parts))) lanes.push(lane);
  }
  return lanes;
}

/** `countOf` with every chance taken `volume` times, independently; at volume 1, `countOf` itself. */
export function countAtVolume(probabilities: readonly number[], volume: number, ...parts: readonly Part[]): number {
  let count = 0;
  for (let lane = 0; lane < volume; lane += 1) count += countOf(probabilities, ...laneParts(lane, ...parts));
  return count;
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

/** True on a UTC Saturday or Sunday, when the simulated teams work less (#166). */
export function isWeekend(ms: number): boolean {
  const weekday = new Date(ms).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/**
 * True on the account's launch day: one UTC day in every TREND_DAYS, at a phase set by the account
 * id, so any window of that many days, such as the dashboard's daily trend, holds exactly one
 * (#166). A profile raises its usage and its activity together on that day, so the spend spike
 * lines up with a burst of events.
 */
export function isLaunchDay(accountId: string, ms: number): boolean {
  const day = Math.floor(ms / DAY_MS);
  return (day + between(0, TREND_DAYS - 1, accountId, "launch-day")) % TREND_DAYS === 0;
}

/**
 * How many of a UTC day's `between(min, max)` occurrences land in the hour starting at `hourMs`,
 * each at a stable hour of its day. Unlike independent hourly chances, the day's total is bounded,
 * so a small product's few payments a day never add up to a spend spike by chance alone (#264),
 * which anomaly detection (#169) would flag.
 */
export function dailyCountInHour(min: number, max: number, hourMs: number, ...parts: readonly (string | number)[]): number {
  const dayMs = utcDayStart(hourMs);
  const hour = new Date(hourMs).getUTCHours();
  const count = between(min, max, ...parts, dayMs, "count");
  let inHour = 0;
  for (let index = 0; index < count; index += 1) {
    if (between(0, 23, ...parts, dayMs, index, "hour") === hour) inHour += 1;
  }
  return inHour;
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
