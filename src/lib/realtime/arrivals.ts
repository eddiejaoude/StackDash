/**
 * What changed between two renders of a workspace page, so arriving data can be marked (#171).
 *
 * A live refresh (#129) re-renders the Server Components and React keeps client state across it
 * (`router.refresh()` in node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-router.md),
 * so a client component can hold what the previous render showed and compare. Everything here is
 * pure: the components own the state and the timers, and the tests cover the rules.
 *
 * Events are compared by id. Dashboard values are compared by a key that names the account and
 * metric (allowances), the group, currency, and provenance (money), or the metric, currency, and
 * provenance (recurring revenue), never by position, so a card that moves in the list is not
 * mistaken for a changed one.
 */
import type {
  Allowance,
  ConnectionInput,
  ConnectionStatus,
  CurrencyAmounts,
  MoneyValue,
  Provenance,
  RecurringRevenue,
} from "@/lib/dashboard/aggregate";
import type { TrendMeasure } from "@/lib/dashboard/trends";
import { formatMoney, formatPercent, formatQuantity } from "@/lib/format";

/** How long a changed item keeps its highlight and its "Updated" or "New" label. */
export const ARRIVAL_HIGHLIGHT_MS = 4_000;

/** Updated values named in one announcement; the rest are counted, so a big sync stays one sentence. */
export const ANNOUNCED_LABELS_MAX = 3;

/** Numbers a card shows, by value key. null is a value that is unavailable. */
export type ValueMap = Readonly<Record<string, number | null>>;

/**
 * Ids in this render that the previous render did not show, in render order. With no previous
 * render (first load, or the view's filters or page changed) nothing is new.
 */
export function newEventIds(previous: readonly string[] | null, current: readonly string[]): string[] {
  if (previous === null) return [];
  const seen = new Set(previous);
  return current.filter((id) => !seen.has(id));
}

/**
 * Keys whose value differs from the previous render, including keys the previous render did not
 * have. A key that is gone is not listed: there is nothing left on screen to mark.
 */
export function changedValueKeys(previous: ValueMap | null, current: ValueMap): string[] {
  if (previous === null) return [];
  return Object.keys(current).filter((key) => !(key in previous) || !Object.is(previous[key], current[key]));
}

/** Which money list a value belongs to on a card. */
export type AmountGroup = "spend" | "revenue" | "credit";

export function amountKey(group: AmountGroup, currency: string, status: Provenance["status"]): string {
  return `${group}:${currency}:${status}`;
}

/** Verified and estimated amounts per currency, each under its own key. */
export function amountValues(group: AmountGroup, amounts: readonly CurrencyAmounts[]): Record<string, number | null> {
  const values: Record<string, number | null> = {};
  for (const { currency, verified, estimated } of amounts) {
    values[amountKey(group, currency, "verified")] = verified?.amountMinor ?? null;
    values[amountKey(group, currency, "estimated")] = estimated?.amountMinor ?? null;
  }
  return values;
}

export function creditValues(credits: readonly MoneyValue[]): Record<string, number | null> {
  return Object.fromEntries(
    credits.map((credit) => [amountKey("credit", credit.currency, credit.provenance.status), credit.amountMinor]),
  );
}

/**
 * `rate.key` names the metric, currency, and provenance, so monthly and annual recurring revenue in
 * the same currency stay apart, which a currency and provenance key alone would merge.
 */
export function recurringKey(rate: Pick<RecurringRevenue, "key">): string {
  return `recurring:${rate.key}`;
}

export function recurringValues(rates: readonly RecurringRevenue[]): Record<string, number | null> {
  return Object.fromEntries(rates.map((rate) => [recurringKey(rate), rate.value.amountMinor]));
}

export type AllowancePart = "included" | "used" | "remaining" | "percent";

/** `allowance.key` already names the account and the metric, so two accounts never share a key. */
export function allowanceKey(allowance: Pick<Allowance, "key">, part: AllowancePart): string {
  return `${allowance.key}:${part}`;
}

export function allowanceValues(allowance: Allowance): ValueMap {
  return {
    [allowanceKey(allowance, "included")]: allowance.included?.value ?? null,
    [allowanceKey(allowance, "used")]: allowance.used?.value ?? null,
    [allowanceKey(allowance, "remaining")]: allowance.remaining?.value ?? null,
    [allowanceKey(allowance, "percent")]: allowance.percentUsed,
  };
}

/** What one component saw change in a refresh, for the batch announcement. */
export type ArrivalReport = Readonly<{ kind: "events"; count: number }> | Readonly<{ kind: "updated"; label: string }>;

/**
 * One polite sentence for everything a refresh changed: "3 new events. Spend in USD updated."
 * null when nothing changed, so nothing is announced.
 */
export function describeArrivals(reports: readonly ArrivalReport[]): string | null {
  let events = 0;
  const labels: string[] = [];
  for (const report of reports) {
    if (report.kind === "events") events += report.count;
    else if (!labels.includes(report.label)) labels.push(report.label);
  }
  const sentences: string[] = [];
  if (events > 0) sentences.push(`${events} new ${events === 1 ? "event" : "events"}.`);
  for (const label of labels.slice(0, ANNOUNCED_LABELS_MAX)) sentences.push(`${label} updated.`);
  const others = labels.length - ANNOUNCED_LABELS_MAX;
  if (others > 0) sentences.push(`${others} other ${others === 1 ? "value" : "values"} updated.`);
  return sentences.length === 0 ? null : sentences.join(" ");
}

/** The workspace's live channel: subscribing, subscribed, or failed. */
export type LiveStatus = "connecting" | "live" | "offline";

/**
 * The live indicator's visible word and its accessible name. The name always starts "Live updates",
 * so the button keeps one name to find it by, and it contains the word, so the name never says
 * live when the word does not and a spoken "Offline" still reaches it (WCAG 2.5.3, label in name).
 */
export function liveStatusText(status: LiveStatus): Readonly<{ word: string; name: string }> {
  switch (status) {
    case "connecting":
      return { word: "Connecting", name: "Live updates, connecting" };
    case "live":
      return { word: "Live", name: "Live updates" };
    case "offline":
      return { word: "Offline", name: "Live updates, offline" };
  }
}

/** A connection as the live indicator lists it (#392). */
export type LiveConnection = Readonly<Pick<ConnectionInput, "id" | "provider" | "display_name" | "status">>;

/** Connections the live indicator's tooltip names; the rest are counted, so a big workspace keeps a small tooltip. */
export const LIVE_CONNECTIONS_LISTED = 8;

// Problems first, so a connection that needs a look is never the one past the cap.
const LISTING_ORDER: Record<ConnectionStatus, number> = {
  failed: 0,
  needs_attention: 1,
  pending: 2,
  active: 3,
  revoked: 4,
};

export type LiveConnectionSummary = Readonly<{
  /** Active connections. */
  connected: number;
  /** Connections a member has to fix: needs attention or failed. */
  attention: number;
  /** At most LIVE_CONNECTIONS_LISTED, problems first, otherwise in the order given. */
  listed: readonly LiveConnection[];
  /** Connections past the cap, counted rather than named. */
  unlisted: number;
}>;

/**
 * What the live indicator says about the workspace's connections (#392). A disconnected (revoked)
 * connection is neither counted nor listed: it no longer syncs anything.
 */
export function summarizeLiveConnections(connections: readonly LiveConnection[]): LiveConnectionSummary {
  const current = connections
    .filter((connection) => connection.status !== "revoked")
    .toSorted((a, b) => LISTING_ORDER[a.status] - LISTING_ORDER[b.status]);
  return {
    connected: current.filter((connection) => connection.status === "active").length,
    attention: current.filter((connection) => connection.status === "needs_attention" || connection.status === "failed").length,
    listed: current.slice(0, LIVE_CONNECTIONS_LISTED),
    unlisted: Math.max(0, current.length - LIVE_CONNECTIONS_LISTED),
  };
}

/**
 * The connection count beside "Live": the visible words, and the words the indicator's name adds.
 * The name keeps the visible words, in the same order (WCAG 2.5.3, label in name), and says what
 * the attention mark beside them shows.
 */
export function liveConnectionsText(summary: Pick<LiveConnectionSummary, "connected" | "attention">): Readonly<{
  word: string;
  name: string;
}> {
  const word = `${summary.connected} connected`;
  if (summary.attention === 0) return { word, name: word };
  return { word, name: `${word}, ${summary.attention} ${summary.attention === 1 ? "needs" : "need"} attention` };
}

/** The header's read of the workspace's connections, for the live indicator. */
export type LiveConnectionsRead =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "loaded"; summary: LiveConnectionSummary }>
  | Readonly<{ state: "failed"; reference: string }>;

/** How a counted number prints: a trend measure, or a percentage on a 0 to 100 scale. */
export type CountFormat = TrendMeasure | Readonly<{ type: "percent" }>;

/**
 * The integers a count animates between. `--count` (globals.css) is a registered `<integer>`, so a
 * value with decimals counts in hundredths and `scale` divides it back for display.
 */
export type CountRange = Readonly<{ from: number; to: number; scale: number }>;

// Browsers keep CSS integers at 32 bits at best; past that the count would print wrong numbers.
const MAX_COUNT = 2 ** 31 - 1;

/** null when there is nothing to count: equal values, or values a CSS integer cannot hold. */
export function countRange(from: number, to: number): CountRange | null {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const scale = Number.isInteger(from) && Number.isInteger(to) ? 1 : 100;
  const range = { from: Math.round(from * scale), to: Math.round(to * scale), scale };
  if (range.from === range.to || Math.max(Math.abs(range.from), Math.abs(range.to)) > MAX_COUNT) return null;
  return range;
}

/** One frame of a count, printed the way the settled value prints. */
export function formatCount(count: number, scale: number, format: CountFormat): string {
  const value = count / scale;
  if (format.type === "money") return formatMoney(Math.round(value), format.currency);
  if (format.type === "quantity") return formatQuantity(value, format.unit);
  return formatPercent(value);
}

/** A percentage clamped to the bar's 0 to 100 range. */
export function barPercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

/**
 * The fill of a usage bar: danger at or past the allowance, warning from 80 percent, accent below.
 * Every usage bar takes it from here, so the dashboard and the alerts list agree on the thresholds.
 */
export function usageBarClass(percent: number): string {
  if (percent >= 100) return "bg-danger";
  return percent >= 80 ? "bg-warning" : "bg-accent";
}

/**
 * The bar's starting scale, as a fraction of its new width, so it grows or shrinks from the old
 * width with a transform and never changes layout. null when there is nothing to animate,
 * including a new width of zero, which no scale of a zero-width bar can show.
 */
export function barScaleFrom(fromPercent: number, toPercent: number): number | null {
  const from = barPercent(fromPercent);
  const to = barPercent(toPercent);
  if (to === 0 || from === to) return null;
  return from / to;
}
