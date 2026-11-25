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
import type { Database } from "@/lib/supabase/database.types";

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
 * connection is neither counted nor listed: it no longer syncs anything. The listed connections
 * carry only the fields the tooltip shows, because the summary is a prop of a client component and
 * a caller's wider row (granted scopes, sync times) would otherwise ship to the browser.
 */
export function summarizeLiveConnections(connections: readonly LiveConnection[]): LiveConnectionSummary {
  const current = connections
    .filter((connection) => connection.status !== "revoked")
    .toSorted((a, b) => LISTING_ORDER[a.status] - LISTING_ORDER[b.status]);
  return {
    connected: current.filter((connection) => connection.status === "active").length,
    attention: current.filter((connection) => connection.status === "needs_attention" || connection.status === "failed").length,
    listed: current
      .slice(0, LIVE_CONNECTIONS_LISTED)
      .map(({ id, provider, display_name, status }) => ({ id, provider, display_name, status })),
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

/**
 * The private Broadcast topic of a workspace's live changes. The database sends one message on it
 * for each statement that writes the workspace's synced rows, and only the workspace's members may
 * join it (supabase/migrations/20261122210934_live_refresh_broadcast.sql, #628).
 */
export function liveTopic(workspaceId: string): string {
  return `workspace-live:${workspaceId}`;
}

/** The Broadcast event of every live change. */
export const LIVE_CHANGE_EVENT = "change";

/**
 * The tables whose inserts and updates the database broadcasts on a workspace's live topic, one
 * message per statement (supabase/migrations/20261122210934_live_refresh_broadcast.sql).
 */
export const LIVE_TABLES = [
  "activity_events",
  "usage_snapshots",
  "connections",
  "triggered_alerts",
] as const satisfies readonly (keyof Database["public"]["Tables"])[];

export type LiveTable = (typeof LIVE_TABLES)[number];

function isLiveTable(value: unknown): value is LiveTable {
  return LIVE_TABLES.some((table) => table === value);
}

/**
 * What one live change tells the page: when its write happened (`changed_at`, the transaction's
 * start on the database clock), which connections it brought provider data from (#392), and the
 * table it wrote, which decides the pages that refresh for it (#650). The database decides the
 * connections: the connection of a usage snapshot or of an activity event a provider sent. None of
 * the rest is data received from a connection: a `connections` row changes on a sync request, a
 * failed retry, or a demo tick; StackDash's own events (a sync failure carries the connection with
 * a null provider) and triggered alerts come from StackDash. `table` is null for a table this build
 * does not know, such as one a later migration broadcasts, and every page refreshes for that.
 */
export type LiveChange = Readonly<{ changedAt: string; connectionIds: readonly string[]; table: LiveTable | null }>;

/** A live change's payload, read; null for a payload of another shape. */
export function liveChange(payload: unknown): LiveChange | null {
  if (typeof payload !== "object" || payload === null) return null;
  const changedAt = Reflect.get(payload, "changed_at");
  const connectionIds = Reflect.get(payload, "connection_ids");
  const table = Reflect.get(payload, "table");
  if (typeof changedAt !== "string" || Number.isNaN(Date.parse(changedAt))) return null;
  if (!isStringArray(connectionIds)) return null;
  return { changedAt, connectionIds, table: isLiveTable(table) ? table : null };
}

// The workspace layout's own read, on every page: its live indicator and command palette read the
// workspace's connections (`getWorkspaceScope` in src/app/w/[workspace]/layout.tsx), and
// `router.refresh()` renders the layout again with the page.
const LAYOUT_TABLES: readonly LiveTable[] = ["connections"];

/**
 * The live tables each workspace page reads itself, beside its layout's (#650). A route names the
 * page's folder under src/app, where a bracketed segment matches any one segment. The tables are
 * those of every query the page's Server Components run, including those read through a view, a
 * database function, or a table kept by an activity_events or usage_snapshots trigger. The year
 * slides (`year/[year]/[slide]`) are a route handler that no refresh renders, so they have no entry.
 */
const PAGE_TABLES: readonly Readonly<{ route: string; tables: readonly LiveTable[] }>[] = [
  // Trends, the heatmap, headline numbers, the cards, unacknowledged alerts, and recent anomalies.
  { route: "/w/[workspace]/dashboard", tables: ["activity_events", "usage_snapshots", "connections", "triggered_alerts"] },
  // Events and their counts per connection. A project achievement has no message of its own: the
  // statement that records it inserts an activity_events row too (record_project_achievements), so
  // the events stand for the achievements here and on the achievements page.
  { route: "/w/[workspace]/timeline", tables: ["activity_events", "connections"] },
  { route: "/w/[workspace]/alerts", tables: ["triggered_alerts"] },
  // Allowance metrics, currencies, budget spend, and the anomaly metrics come from usage snapshots.
  { route: "/w/[workspace]/alerts/settings", tables: ["usage_snapshots", "connections"] },
  { route: "/w/[workspace]/connections", tables: ["connections"] },
  { route: "/w/[workspace]/connections/[connectionId]", tables: ["connections"] },
  { route: "/w/[workspace]/connections/new/[provider]", tables: ["connections"] },
  { route: "/w/[workspace]/projects", tables: [] },
  { route: "/w/[workspace]/projects/[projectId]/achievements", tables: ["activity_events"] },
  // The public metrics' values, read through the metric store, as on the year in review.
  { route: "/w/[workspace]/projects/[projectId]/public-metrics", tables: ["activity_events", "usage_snapshots", "connections"] },
  { route: "/w/[workspace]/settings", tables: [] },
  { route: "/w/[workspace]/year/[year]", tables: ["activity_events", "usage_snapshots", "connections"] },
];

function matchesRoute(route: string, pathname: string): boolean {
  const expected = route.split("/");
  const actual = pathname.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) => {
      const value = actual[index];
      return segment.startsWith("[") ? value !== undefined && value !== "" : segment === value;
    })
  );
}

/**
 * The live tables the page at `pathname` reads, its layout's included. A path that matches no
 * page, such as a not-found page in the workspace shell, reads every table, so it refreshes for
 * every change, as every page did before #650.
 */
export function liveTablesRead(pathname: string): ReadonlySet<LiveTable> {
  const page = PAGE_TABLES.find(({ route }) => matchesRoute(route, pathname));
  return new Set(page === undefined ? LIVE_TABLES : [...LAYOUT_TABLES, ...page.tables]);
}

/** What the changes due at once ask of the page (`PendingChanges.take`). */
export type DueChanges = Readonly<{
  /**
   * What the live indicator records: when the newest change was written and the connections that
   * sent provider data. null when no change arrived, only a step back or forward in history.
   */
  arrival: Readonly<{ at: string | null; connectionIds: ReadonlySet<string> }> | null;
  /**
   * Whether the page reads a table the changes may have written, or a step in history landed on a
   * page that does (`PendingChanges.traversed`), so it refreshes.
   */
  refresh: boolean;
}>;

export type PendingChanges = Readonly<{
  /** A message arrived on the live topic: its change, or null for a payload of another shape. */
  heard: (change: LiveChange | null) => void;
  /** Changes may have been written to any table while the channel was down. */
  missed: () => void;
  /**
   * The browser went back or forward to the page at `pathname` (the location on `popstate`).
   * Next.js shows that page from its history cache, as it was last rendered, without asking the
   * server, and a refresh is what empties that cache (`invalidateBfCache` in
   * node_modules/next/dist/client/components/segment-cache/bfcache.js). A change that has refreshed
   * nothing yet, skipped or still in this batch, can be missing from it, so when the page reads a
   * table such a change wrote, the next batch refreshes, whatever page it is taken for: it can come
   * due before React renders the step, and Next.js applies the step to its router state at once
   * (`ACTION_RESTORE` in app-router-instance.js), so the refresh still reaches the page the step
   * landed on. Returns whether the page needs it, so a batch is worth scheduling.
   */
  traversed: (pathname: string) => boolean;
  /** Ends the batch for the page at `pathname` and says what it asks of that page. */
  take: (pathname: string) => DueChanges;
}>;

/**
 * The live changes a page heard since its last batch, and the tables of the changes it skipped
 * since its last refresh (#650). A batch refreshes the page only when one of its changes wrote a
 * table the page reads (`liveTablesRead`), but the live indicator records every batch all the same.
 * A payload of another shape, a table this build does not know, and changes missed while the
 * channel was down could have written any table, so they refresh every page. Changes collect
 * until the batch is taken, however long the scheduler defers it (a hidden tab, a hold, a running
 * refresh), so a change a page reads is never dropped for one it does not read.
 *
 * The skipped tables are kept in `skipped`, which can outlive this object: LiveRefresh keeps one
 * set per workspace for the life of the document, so it still knows them once the workspace shell
 * mounts it again, as a step back into the shell from a page outside it does.
 */
export function createPendingChanges(skipped = new Set<LiveTable>()): PendingChanges {
  let arrived = false;
  let newestAt: string | null = null;
  let connectionIds = new Set<string>();
  let tables = new Set<LiveTable>();
  let anyTable = false;
  // A step in history landed on a page that reads a table a change wrote since the last refresh.
  let landedStale = false;

  return {
    heard(change) {
      arrived = true;
      if (change === null) {
        anyTable = true;
        return;
      }
      if (newestAt === null || Date.parse(change.changedAt) > Date.parse(newestAt)) newestAt = change.changedAt;
      for (const connectionId of change.connectionIds) connectionIds.add(connectionId);
      if (change.table === null) anyTable = true;
      else tables.add(change.table);
    },
    missed() {
      arrived = true;
      anyTable = true;
    },
    traversed(pathname) {
      const read = liveTablesRead(pathname);
      const stale = [...skipped, ...tables].some((table) => read.has(table));
      if (stale) landedStale = true;
      return stale;
    },
    take(pathname) {
      const read = liveTablesRead(pathname);
      const refresh = anyTable || landedStale || [...tables].some((table) => read.has(table));
      const due: DueChanges = { arrival: arrived ? { at: newestAt, connectionIds } : null, refresh };
      if (refresh) {
        // A refresh clears the history cache of every page, so nothing skipped before it is stale,
        // and neither is the page a step in history landed on.
        skipped.clear();
        landedStale = false;
      } else {
        for (const table of tables) skipped.add(table);
      }
      arrived = false;
      newestAt = null;
      connectionIds = new Set();
      tables = new Set();
      anyTable = false;
      return due;
    },
  };
}

/**
 * A `system` message Realtime sends on the live channel, read. With `broadcast.replication_ready`,
 * an `ok` one arrives once the stream that carries the database's messages is up for this join.
 * An error one arrives just before Realtime closes the channel, and its message says why: an
 * expired token, a lost membership, a stream that did not start within a minute, or too many
 * messages per second (`shutdown_response` in Realtime's realtime_channel.ex).
 */
export type LiveSystemMessage = Readonly<{ ok: boolean; message: string }>;

/** A channel's system payload, read; null for a payload of another shape or another extension. */
export function liveSystemMessage(payload: unknown): LiveSystemMessage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const extension = Reflect.get(payload, "extension");
  const status = Reflect.get(payload, "status");
  const message = Reflect.get(payload, "message");
  if (extension !== "system" || (status !== "ok" && status !== "error") || typeof message !== "string") return null;
  return { ok: status === "ok", message };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === "string");
}

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
