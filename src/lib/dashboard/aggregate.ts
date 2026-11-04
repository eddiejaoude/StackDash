/**
 * Pure reductions from stored snapshots to what the dashboard shows. No I/O and no clock: the
 * caller passes `now`, so every rule here is unit tested at its boundaries.
 *
 * Rules decided here, once:
 * - The latest row per (external account, metric key) is the current value.
 * - Money is grouped by currency and never added across currencies. Verified (from the provider)
 *   and estimated (calculated by DevMacro from a price list) amounts are kept apart.
 * - A value that is missing is `null` and shown as "Unavailable", never as 0.
 * - A value is stale when it was retrieved more than two poll intervals ago.
 */
import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import { formatRelative } from "@/lib/format";
import type { Database } from "@/lib/supabase/database.types";

type Tables = Database["public"]["Tables"];

export type ProviderId = Database["public"]["Enums"]["provider_id"];
export type ConnectionStatus = Database["public"]["Enums"]["connection_status"];

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
  "id" | "provider" | "display_name" | "status" | "last_synced_at" | "poll_interval_seconds" | "granted_scopes"
>;

export type AccountInput = Pick<Tables["external_accounts"]["Row"], "id" | "connection_id" | "display_name" | "project_id">;

export type ProjectInput = Pick<Tables["projects"]["Row"], "id" | "name">;

export type DashboardInput = Readonly<{
  snapshots: readonly SnapshotInput[];
  connections: readonly ConnectionInput[];
  /** Only the accounts included in the dashboard; snapshots of any other account are ignored. */
  accounts: readonly AccountInput[];
  projects: readonly ProjectInput[];
  now: Date;
}>;

/** Verified comes from the provider; estimated is calculated by DevMacro. */
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

export type ProviderSummary = Readonly<{
  connectionId: string;
  provider: ProviderId;
  name: string;
  /** True when the provider simulator made this connection, so its data is made up (#131). */
  simulated: boolean;
  status: ConnectionStatus;
  lastSyncedAt: string | null;
  /** True when the connection has synced before but not within two poll intervals. */
  stale: boolean;
  spend: readonly CurrencyAmounts[];
  revenue: readonly CurrencyAmounts[];
  credits: readonly MoneyValue[];
  allowances: readonly Allowance[];
  billingPeriod: Period | null;
  resetsAt: string | null;
}>;

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
 * When an account reports both a total (`<prefix>.total`) and its breakdown (`<prefix>.<part>`)
 * for the same kind and currency, only the total is kept, so nothing is counted twice.
 */
export function dropSupersededBreakdowns<T extends SnapshotInput>(rows: readonly T[]): T[] {
  const totals = new Set<string>();
  const groupOf = (row: T, prefix: string) => `${row.external_account_id} ${row.kind} ${row.currency ?? ""} ${prefix}`;
  for (const row of rows) {
    if (row.metric_key.endsWith(".total")) totals.add(groupOf(row, row.metric_key.slice(0, -".total".length)));
  }
  if (totals.size === 0) return [...rows];
  return rows.filter((row) => {
    if (row.metric_key.endsWith(".total")) return true;
    const prefix = row.metric_key.slice(0, row.metric_key.lastIndexOf("."));
    return !totals.has(groupOf(row, prefix));
  });
}

/** Calculated by DevMacro from a price list (or otherwise derived), not reported by the provider. */
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

function quantityValue(entry: Entry | undefined, now: Date): QuantityValue | null {
  if (entry === undefined) return null;
  const { row, connection } = entry;
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

/**
 * Allowance cards for one connection. Metrics pair by account and key prefix (the key without its
 * last segment, as in `resend.emails.month.limit` and `resend.emails.month.used`) and by unit: a
 * used amount only counts against an allowance measured in the same unit.
 */
function buildAllowances(
  entries: readonly Entry[],
  accountNames: ReadonlyMap<string, string>,
  now: Date,
): Allowance[] {
  type Group = { accountId: string; prefix: string; included?: Entry; remaining?: Entry; usage: Entry[] };
  const groups = new Map<string, Group>();
  for (const entry of entries) {
    const { kind, metric_key: metricKey, external_account_id: accountId } = entry.row;
    if (kind !== "included_allowance" && kind !== "remaining_allowance" && kind !== "usage") continue;
    const prefix = metricKey.slice(0, metricKey.lastIndexOf("."));
    const key = `${accountId} ${prefix}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { accountId, prefix, usage: [] };
      groups.set(key, group);
    }
    if (kind === "included_allowance") group.included ??= entry;
    else if (kind === "remaining_allowance") group.remaining ??= entry;
    else group.usage.push(entry);
  }

  const allowances: Allowance[] = [];
  for (const group of groups.values()) {
    const anchor = group.included ?? group.remaining;
    if (anchor === undefined || anchor.row.unit === null) continue;
    const unit = anchor.row.unit;
    const usedEntry = group.usage
      .filter(({ row }) => row.unit === unit)
      .sort((a, b) => a.row.metric_key.localeCompare(b.row.metric_key))[0];
    const remainingEntry = group.remaining?.row.unit === unit ? group.remaining : undefined;
    const included = quantityValue(group.included, now);
    const used = quantityValue(usedEntry, now);
    const remaining = quantityValue(remainingEntry, now);
    const resetsAt =
      [group.included, usedEntry, remainingEntry].map((entry) => entry?.row.resets_at ?? null).find((value) => value !== null) ??
      null;
    allowances.push({
      key: `${group.accountId}:${group.prefix}`,
      accountName: accountNames.get(group.accountId) ?? "Unknown account",
      label: anchor.row.label,
      unit,
      included,
      used,
      remaining,
      percentUsed: percentUsed(included, used),
      period: periodOf(anchor.row),
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

function providerSummary(
  connection: ConnectionInput,
  entries: readonly Entry[],
  accountNames: ReadonlyMap<string, string>,
  now: Date,
): ProviderSummary {
  const currentMoney = entries.filter(({ row }) => isCurrentPeriod(row, now));
  const spend = currentMoney.filter(({ row }) => row.kind === "verified_spend" || row.kind === "estimated_spend");
  const firstSpendPeriod = spend.map(({ row }) => periodOf(row)).find((period) => period !== null) ?? null;
  const allowances = buildAllowances(entries, accountNames, now);
  return {
    connectionId: connection.id,
    provider: connection.provider,
    name: connection.display_name,
    simulated: isSimulatedConnection(connection),
    status: connection.status,
    lastSyncedAt: connection.last_synced_at,
    stale: connection.last_synced_at !== null && isStale(connection.last_synced_at, connection.poll_interval_seconds, now),
    spend: sumByCurrency(spend, now),
    revenue: sumByCurrency(
      currentMoney.filter(({ row }) => row.kind === "revenue"),
      now,
    ),
    credits: sumByCurrency(
      entries.filter(({ row }) => row.kind === "credit_balance"),
      now,
    ).flatMap(({ verified, estimated }) => [verified, estimated].filter((value) => value !== null)),
    allowances,
    billingPeriod: firstSpendPeriod ?? allowances.map((allowance) => allowance.period).find((p) => p !== null) ?? null,
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

  const entries: Entry[] = [];
  for (const row of dropSupersededBreakdowns(latestSnapshots(input.snapshots))) {
    const account = accounts.get(row.external_account_id);
    const connection = connections.get(row.connection_id);
    // Excluded accounts and rows whose account moved connection are skipped.
    if (account === undefined || connection === undefined || account.connection_id !== connection.id) continue;
    entries.push({ row, connection });
  }

  const currentSpend = entries.filter(
    ({ row }) => (row.kind === "verified_spend" || row.kind === "estimated_spend") && isCurrentPeriod(row, now),
  );

  const byConnection = new Map<string, Entry[]>();
  for (const entry of entries) {
    const list = byConnection.get(entry.connection.id);
    if (list === undefined) byConnection.set(entry.connection.id, [entry]);
    else list.push(entry);
  }

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
    byProvider: visible.map((connection) => providerSummary(connection, byConnection.get(connection.id) ?? [], accountNames, now)),
    byProject,
  };
}

/** "Updated 5 minutes ago", or "Stale: last updated 3 hours ago". */
export function freshnessLabel(retrievedAt: string, stale: boolean, now: Date): string {
  const relative = formatRelative(retrievedAt, now);
  return stale ? `Stale: last updated ${relative}` : `Updated ${relative}`;
}
