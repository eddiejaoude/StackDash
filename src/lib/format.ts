/**
 * User-facing formatting, in one place so every surface reads a value the same way (house rules):
 * US English wording, ISO dates (`YYYY-MM-DD`), and times in Europe/London with the zone named.
 * Format only at the edge: compare and sort real dates and numbers, never these strings.
 */
import { currencyMinorDigits } from "@/lib/money";

const TIME_ZONE = "Europe/London";

/** An instant as an ISO timestamp string or a `Date`. */
export type Instant = string | Date;

/** Formats an amount in minor units, using the currency's own number of minor digits. */
export function formatMoney(amountMinor: number, currency: string): string {
  const digits = currencyMinorDigits(currency);
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amountMinor / 10 ** digits);
}

const QUANTITY_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const PERCENT_FORMAT = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const LIST_FORMAT = new Intl.ListFormat("en-US", { type: "conjunction" });

/** "1,234.5 requests". */
export function formatQuantity(value: number, unit: string): string {
  return `${QUANTITY_FORMAT.format(value)} ${unit}`;
}

/** "33.3%". `percent` is on a 0 to 100 scale. */
export function formatPercent(percent: number): string {
  return PERCENT_FORMAT.format(percent / 100);
}

/** "GitHub, Stripe, and Vercel", with the serial comma; "GitHub and Vercel" for two. */
export function formatList(values: readonly string[]): string {
  return LIST_FORMAT.format(values);
}

// en-CA formats a date as YYYY-MM-DD, the house date format.
const UTC_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "UTC",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** "2026-11-05": the UTC calendar day of an instant, for windows that start on UTC day boundaries. */
export function formatUtcDate(at: Instant): string {
  return UTC_DATE_FORMAT.format(typeof at === "string" ? new Date(at) : at);
}

// en-GB writes the hour on a 24 hour clock. Its own date order is day first, so the parts are
// assembled into the ISO order below. The zone is named from the offset rather than by Intl:
// runtimes name it differently (Node says "GMT" where Chromium says "GMT+0"), and a client
// component's server render must match the browser's (#680).
const DATE_TIME_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** "2026-10-31 14:05 GMT", in Europe/London, the same on the server and in every browser. */
export function formatDateTime(at: Instant): string {
  const instant = typeof at === "string" ? new Date(at) : at;
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of DATE_TIME_FORMAT.formatToParts(instant)) {
    parts[part.type] = part.value;
  }
  // London's wall clock is UTC (GMT) or an hour ahead of it (BST); the minute shown says which.
  const wallClock = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  const zone = wallClock > Math.floor(instant.getTime() / 60_000) * 60_000 ? "BST" : "GMT";
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${zone}`;
}

const TIME_OF_DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

/**
 * "14:05:09", the London time of day to the second. It carries no zone name because browsers name
 * the London zone differently (Chromium says "GMT+0" where Node says "GMT"), so the caller says
 * "London time" in words. For text rendered in the browser.
 */
export function formatLondonTime(at: Instant): string {
  return TIME_OF_DAY_FORMAT.format(typeof at === "string" ? new Date(at) : at);
}

const HOUR_MINUTE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * "14:05", the London time of day to the minute, for the timeline's compact time gutter. Like
 * `formatLondonTime` it names no zone, so the caller says it nearby (the gutter's accessible text
 * carries `formatDateTime`, which names GMT or BST).
 */
export function formatLondonHourMinute(at: Instant): string {
  return HOUR_MINUTE_FORMAT.format(typeof at === "string" ? new Date(at) : at);
}

/**
 * "2026-10-01 to 2026-10-31". Billing periods are calendar facts on UTC day boundaries, so they are
 * shown as UTC dates; in Europe/London summer time a period ending at UTC midnight would otherwise
 * end a day late. The end is exclusive, so the last day shown is the day before it.
 */
export function formatPeriod(period: Readonly<{ start: string; end: string }>): string {
  const lastDay = new Date(Date.parse(period.end) - 1);
  return `${UTC_DATE_FORMAT.format(new Date(period.start))} to ${UTC_DATE_FORMAT.format(lastDay)}`;
}

const UTC_MONTH_FORMAT = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });

/** "October 2026": the UTC calendar month of an instant, for monthly buckets of UTC snapshot days. */
export function formatUtcMonth(at: Instant): string {
  return UTC_MONTH_FORMAT.format(typeof at === "string" ? new Date(at) : at);
}

const RELATIVE_FORMAT = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });

// Months and years are approximate (30 and 365 days): a relative time is a glance, and the exact
// instant is always shown beside it.
const RELATIVE_UNITS = [
  { unit: "year", seconds: 365 * 86_400 },
  { unit: "month", seconds: 30 * 86_400 },
  { unit: "week", seconds: 7 * 86_400 },
  { unit: "day", seconds: 86_400 },
  { unit: "hour", seconds: 3_600 },
  { unit: "minute", seconds: 60 },
] as const satisfies readonly { unit: Intl.RelativeTimeFormatUnit; seconds: number }[];

/**
 * "5 minutes ago", "yesterday", in the largest whole unit, rounded down so it never claims more
 * time has passed than has. A time in the future (clock skew) reads as now; an invalid one as
 * "unknown".
 */
export function formatRelative(at: Instant, now: Date): string {
  const time = typeof at === "string" ? Date.parse(at) : at.getTime();
  if (Number.isNaN(time)) return "unknown";
  const seconds = Math.max(0, Math.floor((now.getTime() - time) / 1000));
  for (const { unit, seconds: size } of RELATIVE_UNITS) {
    if (seconds >= size) return RELATIVE_FORMAT.format(-Math.floor(seconds / size), unit);
  }
  return RELATIVE_FORMAT.format(-seconds, "second");
}
