/**
 * Pure alert evaluation (#65): rules plus the stored metrics in, the thresholds crossed out. No I/O
 * and no clock: the caller passes `now`, so every rule here is unit tested at its boundaries.
 * `run.ts` loads the inputs and records the results.
 *
 * Rules decided here, once:
 * - Metrics are reduced the way the dashboard reduces them (`countedSnapshots`: declared
 *   projections left out, the latest row per metric, breakdowns and sub-windows dropped), so an
 *   alert never disagrees with the number on screen, a provider's projection for the period never
 *   counts as spend, and a GitHub day never moves the cycle key off its month.
 * - A threshold is crossed at or above it: 90 of 100 crosses a 90 percent rule, 89.99 does not.
 *   Percentages are compared in exact cross multiplication (`used * 100 >= threshold * included`),
 *   never as a rounded float.
 * - Unavailable data never triggers anything and never clears anything: a missing allowance or
 *   usage reading, an allowance of zero, or no reading in the current billing cycle produces no
 *   trigger, and nothing here ever removes a recorded alert.
 * - Money is compared in the rule's (or budget's) currency only. Amounts in other currencies are
 *   ignored, never converted, never added.
 * - Verified and estimated spend are never added together (the dashboard keeps them apart, and a
 *   provider can report both for the same money). Spend rules count verified spend; an external
 *   account with no current verified spend in the currency counts its estimated spend instead, and
 *   the trigger is then marked estimated.
 * - `cycleKey` identifies the billing cycle the reading belongs to: the start date (`YYYY-MM-DD`,
 *   UTC) of the metric's period when it has one; else, for a point reading with a reset time,
 *   `resets:<reset instant, UTC, to the minute>` (a Resend daily quota gets a new key every day);
 *   else the UTC month start of `now`. The table `triggered_alerts` is unique on
 *   (rule_id, cycle_key), so each rule fires at most once per cycle and fires again after the reset.
 * - A rule edited mid-cycle is evaluated with its current values. Its cycle key does not change,
 *   so a rule that already fired this cycle does not fire again after its threshold is raised: the
 *   insert hits the unique key and is skipped. Lowering a threshold that has not fired yet fires at
 *   the next evaluation.
 * - A rule that covers several allowances or accounts still records one alert per cycle (the
 *   unique key is per rule): when several cross at once, the one furthest past its allowance wins.
 */
import {
  allowanceGroups,
  allowanceUsage,
  countedSnapshots,
  spendToCount,
  type AccountInput,
  type ConnectionInput,
  type SnapshotInput,
} from "@/lib/dashboard/aggregate";
import { formatDateTime, formatMoney, formatQuantity } from "@/lib/format";
import type { Database } from "@/lib/supabase/database.types";

type Tables = Database["public"]["Tables"];
type Enums = Database["public"]["Enums"];

export type ProviderId = Enums["provider_id"];
export type AlertSeverity = Extract<Enums["event_severity"], "warning" | "critical">;

export const ALERT_TRIGGERED_TYPE_ID = "stackdash.alert_triggered";

export type AlertRuleInput = Pick<
  Tables["alert_rules"]["Row"],
  | "id"
  | "kind"
  | "scope"
  | "provider"
  | "project_id"
  | "connection_id"
  | "metric_key"
  | "budget_id"
  | "threshold_percent"
  | "threshold_amount_minor"
  | "currency"
  | "paused"
>;

export type BudgetInput = Pick<
  Tables["budgets"]["Row"],
  "id" | "name" | "scope" | "provider" | "project_id" | "connection_id" | "amount_minor" | "currency"
>;

/** A stored snapshot with its connection's provider and its external account's project joined. */
export type AlertSnapshotInput = SnapshotInput & Readonly<{ provider: ProviderId; projectId: string | null }>;

/** Display names for the words in titles and messages. Ids are never shown. */
export type AlertNames = Readonly<{
  providers: ReadonlyMap<ProviderId, string>;
  projects: ReadonlyMap<string, string>;
  connections: ReadonlyMap<string, string>;
}>;

export type EvaluateInput = Readonly<{
  rules: readonly AlertRuleInput[];
  /** Raw rows; the latest per (external account, metric key) is taken here. */
  snapshots: readonly AlertSnapshotInput[];
  budgets: readonly BudgetInput[];
  names: AlertNames;
  /** Estimated spend metric keys the adapters declare projections (`ProviderAdapter.projectedSpend`). */
  projectedSpend: readonly string[];
  now: Date;
}>;

export type AlertTrigger = Readonly<{
  ruleId: string;
  cycleKey: string;
  /** `value` is the percent observed for percent rules; money is the spend observed, with its currency. */
  observed: Readonly<{ value: number | null; amountMinor: number | null; currency: string | null }>;
  thresholdLabel: string;
  isEstimated: boolean;
  /** Short line for the timeline. */
  title: string;
  /** Full sentence for the alert and the timeline body; says so when estimated values contributed. */
  message: string;
  severity: AlertSeverity;
  /** The provider and project behind the reading, or null when it spans several (or none). */
  provider: ProviderId | null;
  projectId: string | null;
  /** When the allowance or quota resets, as the provider reports it; null when not reported. */
  resetsAt: string | null;
}>;

type ScopeTarget = Pick<AlertRuleInput, "scope" | "provider" | "project_id" | "connection_id">;
type ScopedItem = Readonly<{ provider: ProviderId; projectId: string | null; connectionId: string }>;

const PERCENT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const ESTIMATED_ALLOWANCE_NOTE = " These figures include values estimated by StackDash, not reported by the provider.";
const ESTIMATED_SPEND_NOTE =
  " This total includes amounts estimated by StackDash from a price list, so the provider's invoice may differ.";

/** `YYYY-MM-DD` (UTC) of an instant. */
function utcDateOf(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

/** `YYYY-MM-01` (UTC): the cycle key of a reading with neither a billing period nor a reset time. */
function utcMonthStart(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

const RESETS_CYCLE_PREFIX = "resets:";

/** The cycle in words, for messages: a billing period start date, or the reset time in Europe/London. */
function cyclePhrase(cycleKey: string): string {
  return cycleKey.startsWith(RESETS_CYCLE_PREFIX)
    ? `for the period that resets ${formatDateTime(cycleKey.slice(RESETS_CYCLE_PREFIX.length))}`
    : `for the billing period starting ${cycleKey}`;
}

/** Whether a rule's or budget's scope covers an item. Also used for budget projections (#167). */
export function inScope(target: ScopeTarget, item: ScopedItem): boolean {
  switch (target.scope) {
    case "workspace":
      return true;
    case "provider":
      return target.provider !== null && target.provider === item.provider;
    case "project":
      return target.project_id !== null && target.project_id === item.projectId;
    case "connection":
      return target.connection_id !== null && target.connection_id === item.connectionId;
  }
}

export function scopedItem(row: AlertSnapshotInput): ScopedItem {
  return { provider: row.provider, projectId: row.projectId, connectionId: row.connection_id };
}

/**
 * Joins each stored row to its connection's provider and its external account's project. Rows of
 * an account not in `accounts` (excluded from the workspace's views), of a connection not in
 * `connections`, or whose account moved connection are skipped, as on the dashboard.
 */
export function joinAlertSnapshots(
  rows: readonly SnapshotInput[],
  connections: readonly Pick<ConnectionInput, "id" | "provider">[],
  accounts: readonly Pick<AccountInput, "id" | "connection_id" | "project_id">[],
): AlertSnapshotInput[] {
  const providerOf = new Map(connections.map((connection) => [connection.id, connection.provider]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const joined: AlertSnapshotInput[] = [];
  for (const row of rows) {
    const account = accountById.get(row.external_account_id);
    const provider = providerOf.get(row.connection_id);
    if (account === undefined || provider === undefined || account.connection_id !== row.connection_id) continue;
    joined.push({ ...row, provider, projectId: account.project_id });
  }
  return joined;
}

/**
 * The cycle key of an allowance or usage reading, or null when it does not describe the current
 * cycle. A period reading counts while its period has started and was still open when it was read
 * (month to date windows end at the retrieval time). A point reading with a reset time counts until
 * that reset and is keyed by it, truncated to the minute so seconds of jitter between syncs do not
 * open a new cycle; a reading from before a reset describes the cycle that ended. A point reading
 * with no reset time counts when it was taken this UTC month.
 */
export function quantityCycleKey(row: SnapshotInput, now: Date): string | null {
  const nowMs = now.getTime();
  if (row.period_start !== null && row.period_end !== null) {
    const start = Date.parse(row.period_start);
    const end = Date.parse(row.period_end);
    if (start > nowMs) return null;
    // A window that closed before it was read is a past period; month to date windows end at the
    // retrieval time, so they still count.
    if (end <= nowMs && end < Date.parse(row.retrieved_at)) return null;
    return utcDateOf(row.period_start);
  }
  if (row.point_at === null) return null;
  const at = Date.parse(row.point_at);
  if (at > nowMs) return null;
  if (row.resets_at !== null) {
    const resetsAt = new Date(row.resets_at);
    if (resetsAt.getTime() <= nowMs) return null;
    return `${RESETS_CYCLE_PREFIX}${resetsAt.toISOString().slice(0, 16)}Z`;
  }
  if (at < Date.parse(`${utcMonthStart(now)}T00:00:00Z`)) return null;
  return utcMonthStart(now);
}

function isEstimatedRow(row: SnapshotInput): boolean {
  return row.kind === "estimated_spend" || row.provenance_source === "derived";
}

/** "94.3 percent": one decimal place at most, as every alert sentence and title writes it. */
export function formatPercentNumber(percent: number): string {
  return `${PERCENT_FORMAT.format(percent)} percent`;
}

/** Warning below a 100 percent threshold, critical at or above it. Spend amount rules have no percent, so they warn. */
export function severityFor(thresholdPercent: number | null): AlertSeverity {
  return thresholdPercent !== null && thresholdPercent >= 100 ? "critical" : "warning";
}

function providerName(names: AlertNames, provider: ProviderId): string {
  return names.providers.get(provider) ?? provider;
}

/** What a scope covers, in words: "Workspace", "Vercel", "Project Acme", "Connection Acme Stripe". */
function scopeSubject(target: ScopeTarget, names: AlertNames): string {
  switch (target.scope) {
    case "workspace":
      return "Workspace";
    case "provider":
      return target.provider === null ? "Provider" : providerName(names, target.provider);
    case "project":
      return `Project ${(target.project_id === null ? undefined : names.projects.get(target.project_id)) ?? "unnamed"}`;
    case "connection":
      return `Connection ${(target.connection_id === null ? undefined : names.connections.get(target.connection_id)) ?? "unnamed"}`;
  }
}

/**
 * One allowance with a usable reading. Pairing rule (the dashboard's, `allowanceGroups`): an
 * `included_allowance` and a `usage` metric of the same external account whose keys share
 * everything before the last segment (`resend.emails.monthly.limit` with `resend.emails.monthly.used`)
 * and whose units match. With no such usage metric, a `remaining_allowance` in the same group stands
 * in: used = included minus remaining. Both readings must be in the current cycle.
 */
type AllowanceReading = Readonly<{
  item: ScopedItem;
  prefix: string;
  keys: ReadonlySet<string>;
  label: string;
  unit: string;
  included: number;
  used: number;
  isEstimated: boolean;
  cycleKey: string;
  resetsAt: string | null;
}>;

function allowanceReadings(rows: readonly AlertSnapshotInput[], now: Date): AllowanceReading[] {
  const readings: AllowanceReading[] = [];
  for (const group of allowanceGroups(rows)) {
    const included = group.included;
    if (included === undefined || included.unit === null || included.value === null) continue;
    // An allowance of zero (or a nonsense negative one) has no percentage to cross.
    if (!(included.value > 0)) continue;
    const cycleKey = quantityCycleKey(included, now);
    if (cycleKey === null) continue;
    const unit = included.unit;
    const usage = allowanceUsage(group, unit, (row) => row.value !== null && quantityCycleKey(row, now) !== null);
    let used: number;
    let usedRow: AlertSnapshotInput;
    if (usage !== undefined && usage.value !== null) {
      used = usage.value;
      usedRow = usage;
    } else {
      const remaining = group.remaining;
      if (
        remaining === undefined ||
        remaining.unit !== unit ||
        remaining.value === null ||
        quantityCycleKey(remaining, now) === null
      ) {
        continue;
      }
      used = Math.max(0, included.value - remaining.value);
      usedRow = remaining;
    }

    readings.push({
      item: scopedItem(included),
      prefix: group.prefix,
      keys: group.keys,
      label: included.label,
      unit,
      included: included.value,
      used,
      isEstimated: isEstimatedRow(included) || isEstimatedRow(usedRow),
      cycleKey,
      // The allowance row describes the whole period, so its end is the reset when none is given.
      resetsAt: included.resets_at ?? included.period_end,
    });
  }
  return readings;
}

/** A rule's `metric_key` names the allowance by its shared prefix or by any of its metric keys. */
function matchesMetricKey(metricKey: string | null, reading: AllowanceReading): boolean {
  return metricKey === null || metricKey === reading.prefix || reading.keys.has(metricKey);
}

function evaluateAllowanceRule(
  rule: AlertRuleInput,
  readings: readonly AllowanceReading[],
  names: AlertNames,
): AlertTrigger[] {
  const threshold = rule.threshold_percent;
  if (threshold === null) return [];
  // One trigger per cycle: when several allowances cross, the one furthest past its allowance.
  const best = new Map<string, { reading: AllowanceReading; percent: number }>();
  for (const reading of readings) {
    if (!inScope(rule, reading.item) || !matchesMetricKey(rule.metric_key, reading)) continue;
    if (reading.used * 100 < threshold * reading.included) continue;
    // Multiplied first: 9200 / 10000 * 100 is 92.00000000000001 in floating point, 920000 / 10000 is 92.
    const percent = (reading.used * 100) / reading.included;
    const current = best.get(reading.cycleKey);
    if (current === undefined || percent > current.percent) best.set(reading.cycleKey, { reading, percent });
  }
  return [...best.values()].map(({ reading, percent }) => {
    const label = reading.label.charAt(0).toLowerCase() + reading.label.slice(1);
    const subject = `${providerName(names, reading.item.provider)} ${label}`;
    const thresholdLabel = formatPercentNumber(threshold);
    const message =
      `${subject} is at ${formatPercentNumber(percent)} of the allowance ` +
      `(${formatQuantity(reading.used, reading.unit)} of ${formatQuantity(reading.included, reading.unit)}) ` +
      `${cyclePhrase(reading.cycleKey)}. The alert threshold is ${thresholdLabel}.` +
      (reading.isEstimated ? ESTIMATED_ALLOWANCE_NOTE : "");
    return {
      ruleId: rule.id,
      cycleKey: reading.cycleKey,
      observed: { value: percent, amountMinor: null, currency: null },
      thresholdLabel,
      isEstimated: reading.isEstimated,
      title: `${subject} passed ${thresholdLabel} of the allowance`,
      message,
      severity: severityFor(threshold),
      provider: reading.item.provider,
      projectId: reading.item.projectId,
      resetsAt: reading.resetsAt,
    };
  });
}

type SpendTotal = Readonly<{
  amountMinor: number;
  currency: string;
  isEstimated: boolean;
  cycleKey: string;
  /** Set when every counted row shares it. */
  provider: ProviderId | null;
  projectId: string | null;
  /** The earliest reset any counted row reports; spend rows rarely carry one. */
  resetsAt: string | null;
}>;

/** The one value every item shares, or null when they differ or there are none. */
function shared<T>(values: readonly T[]): T | null {
  const first = values[0];
  return first !== undefined && values.every((value) => value === first) ? first : null;
}

/**
 * Spend in one currency for the current billing period, over the rows every target covers. Per
 * external account, verified spend is counted; estimated spend is counted only for an account with
 * no current verified spend in that currency, and marks the total estimated. The two are never added
 * for the same account. Null when no spend reading in that currency is current: unavailable, not
 * zero. The cycle key is the latest period start among the rows counted, so the threshold re-arms
 * when any of the counted billing periods resets and its total starts again.
 */
function spendTotal(
  rows: readonly AlertSnapshotInput[],
  targets: readonly ScopeTarget[],
  currency: string,
  now: Date,
): SpendTotal | null {
  const counted = spendToCount(
    rows.filter((row) => row.currency === currency && targets.every((target) => inScope(target, scopedItem(row)))),
    now,
  );
  if (counted.length === 0) return null;
  let amountMinor = 0;
  let isEstimated = false;
  let latestStart: string | null = null;
  for (const row of counted) {
    amountMinor += row.amount_minor ?? 0;
    isEstimated ||= isEstimatedRow(row);
    if (row.period_start !== null && (latestStart === null || Date.parse(row.period_start) > Date.parse(latestStart))) {
      latestStart = row.period_start;
    }
  }
  const resets = counted.flatMap((row) => (row.resets_at === null ? [] : [row.resets_at])).sort((a, b) => Date.parse(a) - Date.parse(b));
  return {
    amountMinor,
    currency,
    isEstimated,
    cycleKey: latestStart === null ? utcMonthStart(now) : utcDateOf(latestStart),
    provider: shared(counted.map((row) => row.provider)),
    projectId: shared(counted.map((row) => row.projectId)),
    resetsAt: resets[0] ?? null,
  };
}

function evaluateSpendRule(
  rule: AlertRuleInput,
  rows: readonly AlertSnapshotInput[],
  names: AlertNames,
  now: Date,
): AlertTrigger[] {
  const { threshold_amount_minor: threshold, currency } = rule;
  if (threshold === null || currency === null) return [];
  const total = spendTotal(rows, [rule], currency, now);
  if (total === null || total.amountMinor < threshold) return [];
  const subject = `${scopeSubject(rule, names)} spend`;
  const thresholdLabel = formatMoney(threshold, currency);
  const message =
    `${subject} is ${formatMoney(total.amountMinor, currency)} for the billing period starting ${total.cycleKey}, ` +
    `at or above the ${thresholdLabel} threshold. Only ${currency} amounts are counted.` +
    (total.isEstimated ? ESTIMATED_SPEND_NOTE : "");
  return [
    {
      ruleId: rule.id,
      cycleKey: total.cycleKey,
      observed: { value: null, amountMinor: total.amountMinor, currency },
      thresholdLabel,
      isEstimated: total.isEstimated,
      title: `${subject} passed ${thresholdLabel}`,
      message,
      severity: "warning",
      provider: total.provider,
      projectId: total.projectId,
      resetsAt: total.resetsAt,
    },
  ];
}

/**
 * Spend in the budget's scope and currency against its amount. The rule's own scope narrows it
 * further when it is not the whole workspace.
 */
function evaluateBudgetRule(
  rule: AlertRuleInput,
  budgets: ReadonlyMap<string, BudgetInput>,
  rows: readonly AlertSnapshotInput[],
  now: Date,
): AlertTrigger[] {
  const threshold = rule.threshold_percent;
  const budget = rule.budget_id === null ? undefined : budgets.get(rule.budget_id);
  if (threshold === null || budget === undefined || !(budget.amount_minor > 0)) return [];
  const total = spendTotal(rows, [budget, rule], budget.currency, now);
  if (total === null || total.amountMinor * 100 < threshold * budget.amount_minor) return [];
  const percent = (total.amountMinor * 100) / budget.amount_minor;
  const thresholdLabel = formatPercentNumber(threshold);
  const message =
    `Spend against the ${budget.name} budget is ${formatMoney(total.amountMinor, budget.currency)} of ` +
    `${formatMoney(budget.amount_minor, budget.currency)} (${formatPercentNumber(percent)}) for the billing period ` +
    `starting ${total.cycleKey}. The alert threshold is ${thresholdLabel}. Only ${budget.currency} amounts are counted.` +
    (total.isEstimated ? ESTIMATED_SPEND_NOTE : "");
  return [
    {
      ruleId: rule.id,
      cycleKey: total.cycleKey,
      observed: { value: percent, amountMinor: total.amountMinor, currency: budget.currency },
      thresholdLabel,
      isEstimated: total.isEstimated,
      title: `Budget ${budget.name} passed ${thresholdLabel}`,
      message,
      severity: severityFor(threshold),
      provider: total.provider,
      projectId: total.projectId,
      resetsAt: total.resetsAt,
    },
  ];
}

/** Every threshold crossed by the current readings, one per (rule, cycle). Paused rules are skipped. */
export function evaluateAlerts(input: EvaluateInput): AlertTrigger[] {
  const { now, names } = input;
  const rows = countedSnapshots(input.snapshots, input.projectedSpend);
  const readings = allowanceReadings(rows, now);
  const budgets = new Map(input.budgets.map((budget) => [budget.id, budget]));
  return input.rules.flatMap((rule): AlertTrigger[] => {
    if (rule.paused) return [];
    switch (rule.kind) {
      case "allowance_percent":
        return evaluateAllowanceRule(rule, readings, names);
      case "spend_amount":
        return evaluateSpendRule(rule, rows, names, now);
      case "budget_percent":
        return evaluateBudgetRule(rule, budgets, rows, now);
    }
  });
}

/** The activity event dedupe key: one timeline entry per triggered alert. */
export function alertDedupeKey(ruleId: string, cycleKey: string): string {
  return `alert:${ruleId}:${cycleKey}`;
}
