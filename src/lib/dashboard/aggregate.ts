/**
 * Pure reductions from stored snapshots to what the dashboard shows. No I/O and no clock: the
 * caller passes `now`, so every rule here is unit tested at its boundaries.
 *
 * Rules decided here, once:
 * - The latest row per (external account, metric key) is the current value.
 * - A declared projection (`ProviderAdapter.projectedSpend`) is what the whole billing period is
 *   expected to cost, not money spent so far, so no reading of current values counts it
 *   (`isDeclaredProjection`, applied by `countedSnapshots` and the headline strip alike).
 * - Each amount is counted once (`countedSnapshots`): a total supersedes its breakdown, and a
 *   longer billing window supersedes a day inside it.
 * - Money is grouped by currency and never added across currencies. Verified (from the provider)
 *   and estimated (calculated by StackDash from a price list) amounts are kept apart.
 * - One spend total (spend and budget alerts, projections) counts verified spend per account and
 *   currency, and estimated spend only for an account with none (`spendToCount`).
 * - Allowance rows pair by account, key prefix, and unit (`allowanceGroups`, `allowanceUsage`).
 * - A value that is missing is `null` and shown as "Unavailable", never as 0.
 * - A value is stale when it was retrieved more than two poll intervals ago.
 */
import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import type { AdapterCapabilities } from "@/lib/adapters/types";
import { formatDateTime, formatList, formatRelative } from "@/lib/format";
import type { Database } from "@/lib/supabase/database.types";

type Tables = Database["public"]["Tables"];

export type ProviderId = Database["public"]["Enums"]["provider_id"];
export type ConnectionStatus = Database["public"]["Enums"]["connection_status"];

/**
 * Snapshots older than this cannot hold a current value worth showing; retention keeps 13 months.
 * The dashboard reads this window, and the daily trends read the same rows (#263); their 30 day
 * chart sits inside it. An account with no row in it has stopped reporting (#308).
 */
const SNAPSHOT_WINDOW_DAYS = 45;

/** First UTC date (`YYYY-MM-DD`) of the snapshot window ending at `now`; snapshot dates are UTC dates. */
export function snapshotWindowStart(now: Date): string {
  return new Date(now.getTime() - SNAPSHOT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
}

export type SnapshotInput = Pick<
  Tables["usage_snapshots"]["Row"],
  | "connection_id"
  | "external_account_id"
  | "metric_key"
  | "kind"
  | "label"
  | "snapshot_date"
  | "value"
  | "unit"
  | "amount_minor"
  | "currency"
  | "period_start"
  | "period_end"
  | "point_at"
  | "resets_at"
  | "retrieved_at"
  | "provenance_source"
  | "pricing_source"
>;

export type ConnectionInput = Pick<
  Tables["connections"]["Row"],
  | "id"
  | "provider"
  | "display_name"
  | "status"
  | "last_synced_at"
  | "last_sync_requested_at"
  | "poll_interval_seconds"
  | "granted_scopes"
>;

export type AccountInput = Pick<Tables["external_accounts"]["Row"], "id" | "connection_id" | "display_name" | "project_id">;

export type ProjectInput = Pick<Tables["projects"]["Row"], "id" | "name">;

export type DashboardInput = Readonly<{
  snapshots: readonly SnapshotInput[];
  connections: readonly ConnectionInput[];
  /** Only the accounts included in the dashboard; snapshots of any other account are ignored. */
  accounts: readonly AccountInput[];
  projects: readonly ProjectInput[];
  /** Estimated spend metric keys the adapters declare projections (`ProviderAdapter.projectedSpend`). */
  projectedSpend: readonly string[];
  now: Date;
}>;

/** Verified comes from the provider; estimated is calculated by StackDash. */
export type Provenance =
  | Readonly<{ status: "verified" }>
  | Readonly<{ status: "estimated"; pricingSources: readonly string[] }>;

/** One connection behind a value. `simulated` when the provider simulator made it (#131). */
export type ValueSource = Readonly<{ connectionId: string; provider: ProviderId; connectionName: string; simulated: boolean }>;

type Freshness = {
  /** The oldest retrieval among the rows behind the value, so "Updated" never overstates. */
  retrievedAt: string;
  stale: boolean;
};

export type MoneyValue = Readonly<
  Freshness & {
    amountMinor: number;
    currency: string;
    provenance: Provenance;
    sources: readonly ValueSource[];
  }
>;

export type QuantityValue = Readonly<
  Freshness & {
    value: number;
    unit: string;
    provenance: Provenance;
    source: ValueSource;
  }
>;

/** One currency's amounts. Verified and estimated are never added together. */
export type CurrencyAmounts = Readonly<{
  currency: string;
  verified: MoneyValue | null;
  estimated: MoneyValue | null;
}>;

/** True when any connection behind these amounts was made by the provider simulator (#131). */
export function hasSimulatedSource(amounts: CurrencyAmounts): boolean {
  return [amounts.verified, amounts.estimated].some((value) => value?.sources.some((source) => source.simulated) === true);
}

export type Period = Readonly<{ start: string; end: string }>;

export type Allowance = Readonly<{
  key: string;
  accountName: string;
  label: string;
  unit: string;
  included: QuantityValue | null;
  used: QuantityValue | null;
  remaining: QuantityValue | null;
  /** 0 to 100 and beyond; null when included or used is missing, or included is zero. */
  percentUsed: number | null;
  period: Period | null;
  resetsAt: string | null;
}>;

/**
 * One run rate (MRR, ARR) per metric, currency, and provenance, summed over the connection's
 * accounts. A rate is not money earned in a period, so it is never added into revenue or spend,
 * and two rates (MRR and ARR) are never added to each other.
 */
export type RecurringRevenue = Readonly<{ key: string; label: string; value: MoneyValue }>;

export type ProviderSummary = Readonly<{
  connectionId: string;
  provider: ProviderId;
  name: string;
  /** True when the provider simulator made this connection, so its data is made up (#131). */
  simulated: boolean;
  status: ConnectionStatus;
  lastSyncedAt: string | null;
  /** The last "Sync now" request, for the dashboard's cooldown hint (#267); null when never asked. */
  lastSyncRequestedAt: string | null;
  /** True when the connection has synced before but not within two poll intervals. */
  stale: boolean;
  spend: readonly CurrencyAmounts[];
  revenue: readonly CurrencyAmounts[];
  recurringRevenue: readonly RecurringRevenue[];
  credits: readonly MoneyValue[];
  allowances: readonly Allowance[];
  billingPeriod: Period | null;
  resetsAt: string | null;
}>;

/** What a provider's adapter declares it reports (`ProviderAdapter.capabilities`), as its card reads it. */
export type DeclaredFields = Pick<AdapterCapabilities, "spending" | "credits">;

/** Which of a provider card's fixed rows to show (#269). */
export type ProviderCardFields = Readonly<{ billingPeriod: boolean; resetsAt: boolean; spend: boolean; credits: boolean }>;

/**
 * A provider card shows a row only when it can hold a value for that provider (#269), so no row
 * reads "Unavailable" forever. Spend, the billing period it is read over, and the credit balance
 * show when the adapter declares them, with "Unavailable" until the first reading. A reset comes
 * with the reading itself (a quota reading carries when it resets) and no adapter declares one up
 * front, so it shows only with a value. A row that has a value always shows, whatever the
 * declaration says, so nothing a provider reported is ever hidden.
 */
export function providerCardFields(summary: ProviderSummary, declared: DeclaredFields): ProviderCardFields {
  return {
    billingPeriod: summary.billingPeriod !== null || declared.spending,
    resetsAt: summary.resetsAt !== null,
    spend: summary.spend.length > 0 || declared.spending,
    credits: summary.credits.length > 0 || declared.credits,
  };
}

export type ProjectSpend = Readonly<{
  /** null is the bucket for accounts not assigned to a project. */
  projectId: string | null;
  name: string;
  spend: readonly CurrencyAmounts[];
}>;

export type DashboardView = Readonly<{
  totals: readonly CurrencyAmounts[];
  revenue: readonly CurrencyAmounts[];
  byProvider: readonly ProviderSummary[];
  byProject: readonly ProjectSpend[];
}>;

export const UNASSIGNED_PROJECT_NAME = "Unassigned";

/** True when `now` is more than two poll intervals after `retrievedAt`. Exactly two is fresh. */
export function isStale(retrievedAt: string, pollIntervalSeconds: number, now: Date): boolean {
  return now.getTime() - Date.parse(retrievedAt) > 2 * pollIntervalSeconds * 1000;
}

/** Latest row per (external account, metric key): newest snapshot date, then newest retrieval. */
export function latestSnapshots<T extends SnapshotInput>(rows: readonly T[]): T[] {
  const latest = new Map<string, T>();
  for (const row of rows) {
    const key = `${row.external_account_id} ${row.metric_key}`;
    const current = latest.get(key);
    if (
      current === undefined ||
      row.snapshot_date > current.snapshot_date ||
      (row.snapshot_date === current.snapshot_date && Date.parse(row.retrieved_at) > Date.parse(current.retrieved_at))
    ) {
      latest.set(key, row);
    }
  }
  return [...latest.values()];
}

const DAY_MS = 86_400_000;

/**
 * Whether a money row counts toward the current billing period. A point in time value is
 * current by definition. A period counts when it has started, was still open when it was read
 * (month to date windows end at the retrieval time), and starts on a UTC day boundary: billing
 * periods do, while rolling windows such as "last 30 days" start at an arbitrary instant and
 * would count the same spend twice.
 */
export function isCurrentPeriod(row: SnapshotInput, now: Date): boolean {
  if (row.point_at !== null) return true;
  if (row.period_start === null || row.period_end === null) return false;
  const start = Date.parse(row.period_start);
  const end = Date.parse(row.period_end);
  if (start > now.getTime()) return false;
  if (end < Date.parse(row.retrieved_at)) return false;
  return start % DAY_MS === 0;
}

/**
 * Rows PostHog stored before #204 named each product's spend `posthog.<type>.spend`; it is now
 * `posthog.spend.current.<type>`, a breakdown of the organization's `posthog.spend.current`. Old rows
 * stay in the read windows for weeks (`SNAPSHOT_WINDOW_DAYS` on the dashboard), so they are read as
 * the breakdowns they are. Decided on #204: delete this once no stored row carries the old name.
 */
const LEGACY_POSTHOG_PRODUCT_SPEND = /^posthog\.[a-z0-9_]+\.spend$/;

/**
 * Breakdowns are dropped so nothing is counted twice. Within one account, kind, and currency:
 * - a total (`<prefix>.total`) supersedes its parts (`<prefix>.<part>`), as Vercel reports them;
 * - a metric supersedes the keys one segment below it, as GitHub reports per product
 *   (`github.spend.actions`) and per SKU (`github.spend.actions.actions_linux`), and PostHog per
 *   organization (`posthog.spend.current`) and per product (`posthog.spend.current.session_replay`).
 */
export function dropSupersededBreakdowns<T extends SnapshotInput>(rows: readonly T[]): T[] {
  const groupOf = (row: T, key: string) => `${row.external_account_id} ${row.kind} ${row.currency ?? ""} ${key}`;
  const parents = new Set<string>();
  for (const row of rows) {
    parents.add(groupOf(row, row.metric_key.endsWith(".total") ? row.metric_key.slice(0, -".total".length) : row.metric_key));
  }
  return rows.filter((row) => {
    const key = row.metric_key;
    if (key.endsWith(".total")) return true;
    const parent = LEGACY_POSTHOG_PRODUCT_SPEND.test(key) ? "posthog.spend.current" : key.slice(0, key.lastIndexOf("."));
    return !parents.has(groupOf(row, parent));
  });
}

/** Money spent and money coming in: the kinds that accumulate over a period, and the trends' default set (#263). */
export const ACCUMULATING_KINDS: ReadonlySet<SnapshotInput["kind"]> = new Set(["verified_spend", "estimated_spend", "revenue"]);

/**
 * Drops money that another row of the same account, kind, and currency already covers for a
 * longer window: GitHub reports each product's spend for the month and again for each day of it
 * (`github.daily_spend.<product>`), and the day is part of the month. Only a window that starts on
 * a UTC day boundary covers others, so a rolling window (Stripe's last 30 days) never hides the
 * month inside it; `isCurrentPeriod` then leaves the rolling window out. No clock, so it holds for
 * one day of history as well as for the latest rows.
 */
export function dropSubWindows<T extends SnapshotInput>(rows: readonly T[]): T[] {
  type Span = Readonly<{ group: string; start: number; end: number }>;
  const spanOf = (row: T): Span | null =>
    !ACCUMULATING_KINDS.has(row.kind) || row.currency === null || row.period_start === null || row.period_end === null
      ? null
      : {
          group: `${row.external_account_id} ${row.kind} ${row.currency}`,
          start: Date.parse(row.period_start),
          end: Date.parse(row.period_end),
        };
  const covering = new Map<string, Span[]>();
  for (const row of rows) {
    const span = spanOf(row);
    if (span === null || span.start % DAY_MS !== 0) continue;
    const list = covering.get(span.group);
    if (list === undefined) covering.set(span.group, [span]);
    else list.push(span);
  }
  return rows.filter((row) => {
    const span = spanOf(row);
    if (span === null) return true;
    return !(covering.get(span.group) ?? []).some(
      (outer) => outer.start <= span.start && span.end <= outer.end && (outer.start < span.start || span.end < outer.end),
    );
  });
}

/**
 * Whether an adapter declares the row's metric a projection for the whole billing period (PostHog's
 * projected spend, Railway's estimated bill, the Example provider's month estimate): what the
 * period is expected to cost, not money spent so far, on every day it is read, its period's last
 * day included. The one rule for every reading of spend, the headline strip's included.
 */
export function isDeclaredProjection(row: Pick<SnapshotInput, "metric_key">, projectedSpend: readonly string[]): boolean {
  return projectedSpend.includes(row.metric_key);
}

/**
 * The rows every reading of current values starts from (dashboard, digests, alerts, projections,
 * daily summary): declared projections left out, then the latest row per account and metric, with
 * breakdowns and sub-windows dropped so each amount is counted once. A projection goes first, so
 * its whole-period window never hides a day's estimate inside it.
 */
export function countedSnapshots<T extends SnapshotInput>(rows: readonly T[], projectedSpend: readonly string[]): T[] {
  return dropSubWindows(dropSupersededBreakdowns(latestSnapshots(rows.filter((row) => !isDeclaredProjection(row, projectedSpend)))));
}

/**
 * The spend one total counts, for spend and budget alerts and for projections (the dashboard shows
 * verified and estimated apart instead): money rows of the current billing period, and per
 * external account and currency verified spend, with estimated spend only for an account that has
 * no current verified spend in that currency, so the two are never added for the same money.
 * Expects rows already reduced by `countedSnapshots`.
 */
export function spendToCount<T extends SnapshotInput>(rows: readonly T[], now: Date): T[] {
  const accountCurrency = (row: T) => `${row.external_account_id} ${row.currency ?? ""}`;
  const current = rows.filter(
    (row) =>
      (row.kind === "verified_spend" || row.kind === "estimated_spend") &&
      row.currency !== null &&
      row.amount_minor !== null &&
      isCurrentPeriod(row, now),
  );
  const verified = new Set(current.filter((row) => row.kind === "verified_spend").map(accountCurrency));
  return current.filter((row) => row.kind === "verified_spend" || !verified.has(accountCurrency(row)));
}

/** One allowance's rows, paired by `allowanceGroups`, before any value is read. */
export type AllowanceGroup<T extends SnapshotInput> = Readonly<{
  accountId: string;
  /** The metric key without its last segment, shared by every row of the group. */
  prefix: string;
  keys: ReadonlySet<string>;
  included: T | undefined;
  remaining: T | undefined;
  usage: readonly T[];
}>;

/**
 * The allowance pairing rule, shared by the dashboard, alerts, and projections: `included_allowance`,
 * `remaining_allowance`, and `usage` rows of one external account belong to one allowance when
 * their keys share everything before the last segment (`resend.emails.month.limit` with
 * `resend.emails.month.used`). The first included and remaining row of a group are kept; see
 * `allowanceUsage` for the used amount.
 */
export function allowanceGroups<T extends SnapshotInput>(rows: readonly T[]): AllowanceGroup<T>[] {
  type Group = { accountId: string; prefix: string; keys: Set<string>; included: T | undefined; remaining: T | undefined; usage: T[] };
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (row.kind !== "included_allowance" && row.kind !== "remaining_allowance" && row.kind !== "usage") continue;
    const prefix = row.metric_key.slice(0, row.metric_key.lastIndexOf("."));
    const key = `${row.external_account_id} ${prefix}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { accountId: row.external_account_id, prefix, keys: new Set(), included: undefined, remaining: undefined, usage: [] };
      groups.set(key, group);
    }
    group.keys.add(row.metric_key);
    if (row.kind === "included_allowance") group.included ??= row;
    else if (row.kind === "remaining_allowance") group.remaining ??= row;
    else group.usage.push(row);
  }
  return [...groups.values()];
}

/**
 * The usage row an allowance counts against: the first by key among the group's usage rows in the
 * allowance's unit (a used amount only counts against an allowance measured in the same unit) that
 * `usable` accepts.
 */
export function allowanceUsage<T extends SnapshotInput>(
  group: AllowanceGroup<T>,
  unit: string,
  usable: (row: T) => boolean = () => true,
): T | undefined {
  return group.usage.filter((row) => row.unit === unit && usable(row)).sort((a, b) => a.metric_key.localeCompare(b.metric_key))[0];
}

/** Calculated by StackDash from a price list (or otherwise derived), not reported by the provider. */
export function isEstimated(row: Pick<SnapshotInput, "kind" | "provenance_source">): boolean {
  return row.kind === "estimated_spend" || row.provenance_source === "derived";
}

type Entry = Readonly<{ row: SnapshotInput; connection: ConnectionInput }>;

function sourceOf(connection: ConnectionInput): ValueSource {
  return {
    connectionId: connection.id,
    provider: connection.provider,
    connectionName: connection.display_name,
    simulated: isSimulatedConnection(connection),
  };
}

function moneyValue(entries: readonly Entry[], estimated: boolean, now: Date): MoneyValue | null {
  const first = entries[0];
  if (first === undefined || first.row.currency === null) return null;
  let amountMinor = 0;
  let oldest = first.row.retrieved_at;
  let stale = false;
  const sources = new Map<string, ValueSource>();
  for (const { row, connection } of entries) {
    amountMinor += row.amount_minor ?? 0;
    if (Date.parse(row.retrieved_at) < Date.parse(oldest)) oldest = row.retrieved_at;
    stale ||= isStale(row.retrieved_at, connection.poll_interval_seconds, now);
    sources.set(connection.id, sourceOf(connection));
  }
  const provenance: Provenance = estimated
    ? {
        status: "estimated",
        pricingSources: [
          ...new Set(entries.flatMap(({ row }) => (row.pricing_source === null ? [] : [row.pricing_source]))),
        ].sort(),
      }
    : { status: "verified" };
  return {
    amountMinor,
    currency: first.row.currency,
    provenance,
    sources: [...sources.values()].sort((a, b) => a.connectionName.localeCompare(b.connectionName)),
    retrievedAt: oldest,
    stale,
  };
}

/** Sums money rows per currency, verified and estimated apart. Sorted by currency code. */
function sumByCurrency(entries: readonly Entry[], now: Date): CurrencyAmounts[] {
  const byCurrency = new Map<string, { verified: Entry[]; estimated: Entry[] }>();
  for (const entry of entries) {
    const { currency, amount_minor: amountMinor } = entry.row;
    if (currency === null || amountMinor === null) continue;
    let bucket = byCurrency.get(currency);
    if (bucket === undefined) {
      bucket = { verified: [], estimated: [] };
      byCurrency.set(currency, bucket);
    }
    (isEstimated(entry.row) ? bucket.estimated : bucket.verified).push(entry);
  }
  return [...byCurrency.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, bucket]) => ({
      currency,
      verified: moneyValue(bucket.verified, false, now),
      estimated: moneyValue(bucket.estimated, true, now),
    }));
}

function quantityValue(row: SnapshotInput | undefined, connection: ConnectionInput, now: Date): QuantityValue | null {
  if (row === undefined) return null;
  if (row.value === null || row.unit === null) return null;
  return {
    value: row.value,
    unit: row.unit,
    provenance: isEstimated(row)
      ? { status: "estimated", pricingSources: row.pricing_source === null ? [] : [row.pricing_source] }
      : { status: "verified" },
    source: sourceOf(connection),
    retrievedAt: row.retrieved_at,
    stale: isStale(row.retrieved_at, connection.poll_interval_seconds, now),
  };
}

/** Share of the allowance used, or null when it cannot be worked out honestly. */
export function percentUsed(included: QuantityValue | null, used: QuantityValue | null): number | null {
  if (included === null || used === null) return null;
  if (included.unit !== used.unit) return null;
  if (!(included.value > 0)) return null;
  return (used.value / included.value) * 100;
}

function periodOf(row: SnapshotInput): Period | null {
  return row.period_start === null || row.period_end === null ? null : { start: row.period_start, end: row.period_end };
}

/** Allowance cards for one connection, from its rows, paired by `allowanceGroups`. */
function buildAllowances(
  connection: ConnectionInput,
  rows: readonly SnapshotInput[],
  accountNames: ReadonlyMap<string, string>,
  now: Date,
): Allowance[] {
  const allowances: Allowance[] = [];
  for (const group of allowanceGroups(rows)) {
    const anchor = group.included ?? group.remaining;
    if (anchor === undefined || anchor.unit === null) continue;
    const unit = anchor.unit;
    const usedRow = allowanceUsage(group, unit);
    const remainingRow = group.remaining?.unit === unit ? group.remaining : undefined;
    const included = quantityValue(group.included, connection, now);
    const used = quantityValue(usedRow, connection, now);
    const remaining = quantityValue(remainingRow, connection, now);
    const resetsAt =
      [group.included, usedRow, remainingRow].map((row) => row?.resets_at ?? null).find((value) => value !== null) ?? null;
    allowances.push({
      key: `${group.accountId}:${group.prefix}`,
      accountName: accountNames.get(group.accountId) ?? "Unknown account",
      label: anchor.label,
      unit,
      included,
      used,
      remaining,
      percentUsed: percentUsed(included, used),
      period: periodOf(anchor),
      resetsAt,
    });
  }
  return allowances.sort((a, b) => a.accountName.localeCompare(b.accountName) || a.label.localeCompare(b.label));
}

function earliestFutureReset(entries: readonly Entry[], now: Date): string | null {
  let earliest: string | null = null;
  for (const { row } of entries) {
    if (row.resets_at === null || Date.parse(row.resets_at) <= now.getTime()) continue;
    if (earliest === null || Date.parse(row.resets_at) < Date.parse(earliest)) earliest = row.resets_at;
  }
  return earliest;
}

function recurringRevenueOf(entries: readonly Entry[], now: Date): RecurringRevenue[] {
  const byMetric = new Map<string, { label: string; estimated: boolean; entries: Entry[] }>();
  for (const entry of entries) {
    const { row } = entry;
    if (row.kind !== "recurring_revenue" || row.currency === null || row.amount_minor === null) continue;
    const estimated = isEstimated(row);
    const key = `${row.metric_key} ${row.currency} ${estimated ? "estimated" : "verified"}`;
    const group = byMetric.get(key);
    if (group === undefined) byMetric.set(key, { label: row.label, estimated, entries: [entry] });
    else group.entries.push(entry);
  }
  const rates: RecurringRevenue[] = [];
  for (const [key, group] of byMetric) {
    const value = moneyValue(group.entries, group.estimated, now);
    if (value !== null) rates.push({ key, label: group.label, value });
  }
  return rates.sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
}

function providerSummary(
  connection: ConnectionInput,
  entries: readonly Entry[],
  projections: readonly Entry[],
  accountNames: ReadonlyMap<string, string>,
  now: Date,
): ProviderSummary {
  const currentMoney = entries.filter(({ row }) => isCurrentPeriod(row, now));
  const spend = currentMoney.filter(({ row }) => row.kind === "verified_spend" || row.kind === "estimated_spend");
  // The widest period of the spend and of the declared projections (earliest start, then latest
  // end), so row order never decides it. A projection is not spend, but the period it projects is
  // the billing period: the Example provider's spend so far ends tomorrow, its estimate with the month.
  const periodRows = [...spend, ...projections.filter(({ row }) => isCurrentPeriod(row, now))];
  const spendPeriod = periodRows.reduce<Period | null>((widest, { row }) => {
    const period = periodOf(row);
    if (period === null) return widest;
    if (widest === null) return period;
    const start = Date.parse(period.start) - Date.parse(widest.start);
    return start < 0 || (start === 0 && Date.parse(period.end) > Date.parse(widest.end)) ? period : widest;
  }, null);
  const allowances = buildAllowances(connection, entries.map(({ row }) => row), accountNames, now);
  return {
    connectionId: connection.id,
    provider: connection.provider,
    name: connection.display_name,
    simulated: isSimulatedConnection(connection),
    status: connection.status,
    lastSyncedAt: connection.last_synced_at,
    lastSyncRequestedAt: connection.last_sync_requested_at,
    stale: connection.last_synced_at !== null && isStale(connection.last_synced_at, connection.poll_interval_seconds, now),
    spend: sumByCurrency(spend, now),
    revenue: sumByCurrency(
      currentMoney.filter(({ row }) => row.kind === "revenue"),
      now,
    ),
    recurringRevenue: recurringRevenueOf(currentMoney, now),
    credits: sumByCurrency(
      entries.filter(({ row }) => row.kind === "credit_balance"),
      now,
    ).flatMap(({ verified, estimated }) => [verified, estimated].filter((value) => value !== null)),
    allowances,
    billingPeriod: spendPeriod ?? allowances.map((allowance) => allowance.period).find((p) => p !== null) ?? null,
    resetsAt: earliestFutureReset(entries, now),
  };
}

export function aggregateDashboard(input: DashboardInput): DashboardView {
  const { now } = input;
  // The caller has already narrowed connections, accounts, and snapshots to the scope filter.
  const visible = [...input.connections].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.display_name.localeCompare(b.display_name) || a.id.localeCompare(b.id),
  );
  const connections = new Map(visible.map((connection) => [connection.id, connection]));
  const accounts = new Map(
    input.accounts.filter((account) => connections.has(account.connection_id)).map((account) => [account.id, account]),
  );
  const accountNames = new Map([...accounts.values()].map((account) => [account.id, account.display_name]));
  const projectNames = new Map(input.projects.map((project) => [project.id, project.name]));

  // Excluded accounts and rows whose account moved connection are skipped.
  const joined = (rows: readonly SnapshotInput[]): Entry[] =>
    rows.flatMap((row) => {
      const account = accounts.get(row.external_account_id);
      const connection = connections.get(row.connection_id);
      return account === undefined || connection === undefined || account.connection_id !== connection.id ? [] : [{ row, connection }];
    });
  const entries = joined(countedSnapshots(input.snapshots, input.projectedSpend));
  // Read for the billing period only (`providerSummary`), never counted.
  const projections = joined(latestSnapshots(input.snapshots.filter((row) => isDeclaredProjection(row, input.projectedSpend))));

  const currentSpend = entries.filter(
    ({ row }) => (row.kind === "verified_spend" || row.kind === "estimated_spend") && isCurrentPeriod(row, now),
  );

  const byConnection = (list: readonly Entry[]): Map<string, Entry[]> => {
    const grouped = new Map<string, Entry[]>();
    for (const entry of list) {
      const group = grouped.get(entry.connection.id);
      if (group === undefined) grouped.set(entry.connection.id, [entry]);
      else group.push(entry);
    }
    return grouped;
  };
  const entriesByConnection = byConnection(entries);
  const projectionsByConnection = byConnection(projections);

  const byProjectEntries = new Map<string | null, Entry[]>();
  for (const entry of currentSpend) {
    const projectId = accounts.get(entry.row.external_account_id)?.project_id ?? null;
    // A project the user cannot see (or just deleted) falls into the unassigned bucket.
    const key = projectId !== null && projectNames.has(projectId) ? projectId : null;
    const list = byProjectEntries.get(key);
    if (list === undefined) byProjectEntries.set(key, [entry]);
    else list.push(entry);
  }
  const byProject: ProjectSpend[] = [...byProjectEntries.entries()]
    .map(([projectId, list]) => ({
      projectId,
      name: projectId === null ? UNASSIGNED_PROJECT_NAME : (projectNames.get(projectId) ?? UNASSIGNED_PROJECT_NAME),
      spend: sumByCurrency(list, now),
    }))
    .sort((a, b) => {
      if (a.projectId === null) return 1;
      if (b.projectId === null) return -1;
      return a.name.localeCompare(b.name);
    });

  return {
    totals: sumByCurrency(currentSpend, now),
    revenue: sumByCurrency(
      entries.filter(({ row }) => row.kind === "revenue" && isCurrentPeriod(row, now)),
      now,
    ),
    byProvider: visible.map((connection) =>
      providerSummary(
        connection,
        entriesByConnection.get(connection.id) ?? [],
        projectionsByConnection.get(connection.id) ?? [],
        accountNames,
        now,
      ),
    ),
    byProject,
  };
}

/** "Updated 5 minutes ago", or "Stale: last updated 3 hours ago". */
export function freshnessLabel(retrievedAt: string, stale: boolean, now: Date): string {
  const relative = formatRelative(retrievedAt, now);
  return stale ? `Stale: last updated ${relative}` : `Updated ${relative}`;
}

/**
 * The dashboard's one stale notice (#267), shown when most or all of the connections in view that
 * can sync have not synced within two poll intervals (`ProviderSummary.stale`). A connection that
 * never synced, is disconnected, or belongs to a provider this instance does not offer (#588)
 * cannot be brought up to date by a sync, so it is not counted.
 */
export type StaleNotice = Readonly<{
  connections: readonly Readonly<{ connectionId: string; name: string }>[];
  /** Connections in view that have synced and can sync again. */
  total: number;
  /** The newest last sync among the stale connections: none of them has synced since. */
  lastSyncedAt: string;
  /**
   * The earliest of the stale connections' last "Sync now" requests, or null when one has none: the
   * button waits out the cooldown only while every one of them is in it (#161).
   */
  syncRequestedAt: string | null;
}>;

function withoutStaleMark<T extends Freshness>(value: T): T {
  return { ...value, stale: false };
}

function amountsWithoutStaleMarks(list: readonly CurrencyAmounts[]): CurrencyAmounts[] {
  return list.map((amounts) => ({
    ...amounts,
    verified: amounts.verified === null ? null : withoutStaleMark(amounts.verified),
    estimated: amounts.estimated === null ? null : withoutStaleMark(amounts.estimated),
  }));
}

/**
 * The notice for `view`, and the view to show under it. With a notice, the stale connections' cards
 * and values, and the totals that mix connections, carry no stale mark of their own, because the
 * notice says it once for the page; each still says when it was read. A connection the notice does
 * not name keeps its own marks. Without a notice (half or fewer stale), the view is returned as it
 * is, so a lone stale value stands out. `offeredProviders` is `offeredProviderIds()`: `syncNow`
 * skips a connection to any other provider (#570), so the notice neither names nor counts it.
 */
export function withStaleNotice(
  view: DashboardView,
  offeredProviders: ReadonlySet<ProviderId>,
): Readonly<{ view: DashboardView; notice: StaleNotice | null }> {
  const syncable = view.byProvider.flatMap((summary) =>
    summary.lastSyncedAt === null || summary.status === "revoked" || !offeredProviders.has(summary.provider)
      ? []
      : [{ summary, lastSyncedAt: summary.lastSyncedAt }],
  );
  const stale = syncable.filter(({ summary }) => summary.stale);
  if (stale.length === 0 || stale.length * 2 <= syncable.length) return { view, notice: null };
  const newest = stale.reduce((latest, entry) => (Date.parse(entry.lastSyncedAt) > Date.parse(latest.lastSyncedAt) ? entry : latest));
  const requests = stale.flatMap(({ summary }) => (summary.lastSyncRequestedAt === null ? [] : [summary.lastSyncRequestedAt]));
  const named = new Set(stale.map(({ summary }) => summary.connectionId));
  return {
    notice: {
      connections: stale.map(({ summary }) => ({ connectionId: summary.connectionId, name: summary.name })),
      total: syncable.length,
      lastSyncedAt: newest.lastSyncedAt,
      syncRequestedAt:
        requests.length < stale.length ? null : requests.reduce((earliest, at) => (Date.parse(at) < Date.parse(earliest) ? at : earliest)),
    },
    view: {
      totals: amountsWithoutStaleMarks(view.totals),
      revenue: amountsWithoutStaleMarks(view.revenue),
      byProvider: view.byProvider.map((summary) =>
        named.has(summary.connectionId)
          ? {
              ...summary,
              stale: false,
              spend: amountsWithoutStaleMarks(summary.spend),
              revenue: amountsWithoutStaleMarks(summary.revenue),
              recurringRevenue: summary.recurringRevenue.map((rate) => ({ ...rate, value: withoutStaleMark(rate.value) })),
              credits: summary.credits.map(withoutStaleMark),
              allowances: summary.allowances.map((allowance) => ({
                ...allowance,
                included: allowance.included === null ? null : withoutStaleMark(allowance.included),
                used: allowance.used === null ? null : withoutStaleMark(allowance.used),
                remaining: allowance.remaining === null ? null : withoutStaleMark(allowance.remaining),
              })),
            }
          : summary,
      ),
      byProject: view.byProject.map((project) => ({ ...project, spend: amountsWithoutStaleMarks(project.spend) })),
    },
  };
}

/**
 * The notice in words: "Data last synced 3 days ago", and which connections, since when. The time
 * is in Europe/London, as every time the app prints.
 */
export function staleNoticeText(notice: StaleNotice, now: Date): Readonly<{ title: string; body: string }> {
  const count = notice.connections.length;
  const since = formatDateTime(notice.lastSyncedAt);
  const title = `Data last synced ${formatRelative(notice.lastSyncedAt, now)}`;
  if (count === notice.total) {
    const who = count === 1 ? "The only connection in view has" : `None of the ${count} connections in view has`;
    return { title, body: `${who} ${count === 1 ? "not synced" : "synced"} since ${since}, so every figure on this page is from then or earlier.` };
  }
  const names = formatList(notice.connections.map((connection) => connection.name));
  return {
    title,
    body: `${count} of ${notice.total} connections in view have not synced since ${since}: ${names}. Their figures on this page are from then or earlier.`,
  };
}

/**
 * The parts of the dashboard that a snapshot read with a row cap feeds (#336), in page order: the
 * headline strip, the cards (the billing period totals, By provider, and By project), and the trend
 * the page shows.
 */
export const CAPPED_PARTS = ["headline", "cards", "daily trend", "monthly trend"] as const;
export type CappedPart = (typeof CAPPED_PARTS)[number];

/** One read behind a part, and the first UTC day from which the part is whole: null when it is whole throughout. */
export type CappedRead = Readonly<{ part: CappedPart; completeFrom: string | null }>;

/**
 * The dashboard's one notice when a snapshot read stopped at its row cap (#336), in place of a line
 * on every card, as the stale notice is (#267): each part whose read stopped, in page order, with
 * the first UTC day from which it is whole.
 */
export type CapNotice = Readonly<{ parts: readonly Readonly<{ part: CappedPart; completeFrom: string }>[] }>;

/** The later of two reads' first whole days, so rows from it on are whole in both; null when neither stopped. */
export function laterCompleteFrom(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * The notice for the page's reads, or null when every part is whole. A part read more than once
 * (the headline's window to date and its last complete window) is whole from the later day.
 */
export function capNotice(reads: readonly CappedRead[]): CapNotice | null {
  const parts = CAPPED_PARTS.flatMap((part) => {
    const completeFrom = reads.reduce<string | null>((day, read) => (read.part === part ? laterCompleteFrom(day, read.completeFrom) : day), null);
    return completeFrom === null ? [] : [{ part, completeFrom }];
  });
  return parts.length === 0 ? null : { parts };
}

const CAPPED_PART_NAMES: Record<CappedPart, string> = {
  headline: "the headline",
  cards: "the cards",
  "daily trend": "the daily trend",
  "monthly trend": "the monthly trend",
};

/**
 * The notice in words: why older readings are missing, and from which day each part is whole, in
 * one sentence per day. Days are the UTC dates snapshots are kept by, so each says "in UTC", as the
 * headline strip's windows do (`windowDescription`).
 */
export function capNoticeText(notice: CapNotice): Readonly<{ title: string; body: string }> {
  const byDay = new Map<string, CappedPart[]>();
  for (const { part, completeFrom } of notice.parts) byDay.set(completeFrom, [...(byDay.get(completeFrom) ?? []), part]);
  const days = [...byDay].map(([day, parts]) => {
    const names = formatList(parts.map((part) => CAPPED_PART_NAMES[part]));
    const verb = parts.length > 1 || parts[0] === "cards" ? "are" : "is";
    return `${names.charAt(0).toUpperCase()}${names.slice(1)} ${verb} complete from ${day} in UTC.`;
  });
  return {
    title: "Some older readings are not shown",
    body: `This workspace has more readings than the dashboard reads at once, so the oldest are left out. ${days.join(" ")} Anything that depends on an older reading can be missing or incomplete.`,
  };
}
