import type { z } from "zod";
import { addDecimals, toMinorUnits, type Decimal } from "@/lib/money";
import { InvalidResponseError, PermissionMissingError } from "../errors";
import type { AdapterMetric, Provenance, Timeframe } from "../metrics";
import type { OAuthContext, Secret } from "../types";
import { getJson } from "./api";
import {
  AggregatedUsageSchema,
  BillingUsageSchema,
  type AccountType,
  type AggregatedUsageItem,
  type BillingUsageItem,
} from "./schemas";

/**
 * Billing usage for one organization or personal account, per docs/providers/github.md
 * ("Billing usage", "AI credits", "Premium requests", "Personal account equivalents").
 *
 * Money rule: GitHub returns USD amounts as JSON numbers with sub-cent precision. They are parsed
 * to exact decimals, summed at full precision per metric, and rounded once with `toMinorUnits`.
 */

// No currency field is returned; USD is the page's inference from GitHub's billing docs.
const CURRENCY = "USD";
// Late usage for the previous month is still picked up during the first days of a new month.
const PREVIOUS_MONTH_GRACE_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_SLUG_LENGTH = 40;
const MAX_UNIT_LENGTH = 32;
const MAX_NAME_LENGTH = 40;

export type BillingTarget = Readonly<{
  accountType: AccountType;
  login: string;
  // Installation token for organizations, the user access token for personal accounts.
  token: Secret;
  externalAccountId: string;
}>;

export type BillingResult = {
  metrics: AdapterMetric[];
  partialErrors: PermissionMissingError[];
};

type Month = Readonly<{ year: number; month: number }>;

type Endpoint = Readonly<{ path: string; template: string }>;

function endpointsFor(target: BillingTarget) {
  const [base, template] =
    target.accountType === "Organization"
      ? [`/organizations/${encodeURIComponent(target.login)}/settings/billing`, "/organizations/{org}/settings/billing"]
      : [`/users/${encodeURIComponent(target.login)}/settings/billing`, "/users/{username}/settings/billing"];
  const endpoint = (suffix: string): Endpoint => ({ path: `${base}${suffix}`, template: `${template}${suffix}` });
  return {
    usage: endpoint("/usage"),
    summary: endpoint("/usage/summary"),
    aiCredit: endpoint("/ai_credit/usage"),
    premiumRequest: endpoint("/premium_request/usage"),
  };
}

export function monthsToSync(now: Date): Month[] {
  const current = { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  if (now.getUTCDate() > PREVIOUS_MONTH_GRACE_DAYS) return [current];
  const previous =
    current.month === 1 ? { year: current.year - 1, month: 12 } : { year: current.year, month: current.month - 1 };
  return [previous, current];
}

function monthTimeframe({ year, month }: Month): Timeframe {
  return {
    type: "period",
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 1)),
  };
}

/** Lowercase key segment: `Actions Linux` and `actions_linux` both become `actions_linux`. */
function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_SLUG_LENGTH);
  return cleaned.length === 0 ? "unknown" : cleaned;
}

/** Metric units must start with a letter and use a narrow alphabet; `unitType` is free text. */
function metricUnit(unitType: string): string {
  const cleaned = unitType
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, MAX_UNIT_LENGTH);
  return cleaned.length === 0 ? "units" : cleaned;
}

function displayName(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_NAME_LENGTH ? `${trimmed.slice(0, MAX_NAME_LENGTH - 1)}…` : trimmed;
}

type MetricName = Readonly<{ metricKey: string; label: string }>;

/**
 * The billing metric vocabulary: one key and label per product, SKU, unit, and day. Exported for
 * the local simulator (#131), so its keys cannot drift from the ones synced here.
 */
export const billingMetricNames = {
  spend: (product: string): MetricName => ({
    metricKey: `github.spend.${slug(product)}`,
    label: `GitHub ${displayName(product)} spend`,
  }),
  skuSpend: (product: string, sku: string): MetricName => ({
    metricKey: `github.spend.${slug(product)}.${slug(sku)}`,
    label: `GitHub ${displayName(product)} spend (${displayName(sku)})`,
  }),
  usage: (product: string, unitType: string): MetricName & Readonly<{ unit: string }> => {
    const unit = metricUnit(unitType);
    return {
      metricKey: `github.usage.${slug(product)}.${slug(unit)}`,
      label: `GitHub ${displayName(product)} usage (${unit})`,
      unit,
    };
  },
  dailySpend: (product: string): MetricName => ({
    metricKey: `github.daily_spend.${slug(product)}`,
    label: `GitHub ${displayName(product)} daily spend`,
  }),
};

type Group = { label: string; values: Decimal[] };

function addTo(groups: Map<string, Group>, key: string, label: string, value: Decimal): void {
  const group = groups.get(key);
  if (group === undefined) groups.set(key, { label, values: [value] });
  else group.values.push(value);
}

type MetricBase = {
  externalAccountId: string;
  retrievedAt: Date;
  provenance: Provenance;
  timeframe: Timeframe;
};

class MetricCollector {
  readonly metrics: AdapterMetric[] = [];

  constructor(
    private readonly ctx: OAuthContext,
    private readonly target: BillingTarget,
  ) {}

  base(endpoint: Endpoint, timeframe: Timeframe): MetricBase {
    return {
      externalAccountId: this.target.externalAccountId,
      retrievedAt: this.ctx.now(),
      provenance: { source: "provider_api", endpoint: endpoint.template },
      timeframe,
    };
  }

  /** Rounds each group's exact sum once. Credits and adjustments are netted into the total. */
  spend(groups: Map<string, Group>, endpoint: Endpoint, timeframe: Timeframe): void {
    for (const [metricKey, group] of groups) {
      const amountMinor = toMinorUnits(addDecimals(group.values), CURRENCY);
      if (amountMinor < 0) {
        // Spend cannot be below zero in the metric model; a net credit is reported, not stored.
        this.ctx.logger.warn("github.billing.negative_net_spend", { metricKey, endpoint: endpoint.template });
        continue;
      }
      this.metrics.push({
        ...this.base(endpoint, timeframe),
        kind: "verified_spend",
        metricKey,
        label: group.label,
        amountMinor,
        currency: CURRENCY,
      });
    }
  }

  usage(groups: Map<string, Group & { unit: string }>, endpoint: Endpoint, timeframe: Timeframe): void {
    for (const [metricKey, group] of groups) {
      const total = addDecimals(group.values);
      const value = Number(`${total.coefficient}e-${total.scale}`);
      if (value < 0) continue;
      this.metrics.push({
        ...this.base(endpoint, timeframe),
        kind: "usage",
        metricKey,
        label: group.label,
        value,
        unit: group.unit,
      });
    }
  }
}

function addUsageTo(
  groups: Map<string, Group & { unit: string }>,
  key: string,
  label: string,
  unit: string,
  value: Decimal,
): void {
  const group = groups.get(key);
  if (group === undefined) groups.set(key, { label, unit, values: [value] });
  else group.values.push(value);
}

function collectSummary(collector: MetricCollector, items: readonly AggregatedUsageItem[], endpoint: Endpoint, month: Month): void {
  const spend = new Map<string, Group>();
  const usage = new Map<string, Group & { unit: string }>();
  for (const item of items) {
    // Copilot is reported from the AI credit endpoints, so its summary rows are skipped to avoid
    // counting it twice. Product strings are in the page's Unverified list.
    if (/^copilot/i.test(item.product.trim())) continue;
    const spendName = billingMetricNames.spend(item.product);
    const skuName = billingMetricNames.skuSpend(item.product, item.sku);
    const usageName = billingMetricNames.usage(item.product, item.unitType);
    addTo(spend, spendName.metricKey, spendName.label, item.netAmount);
    addTo(spend, skuName.metricKey, skuName.label, item.netAmount);
    addUsageTo(usage, usageName.metricKey, usageName.label, usageName.unit, item.grossQuantity);
  }
  collector.spend(spend, endpoint, monthTimeframe(month));
  collector.usage(usage, endpoint, monthTimeframe(month));
}

function collectDaily(collector: MetricCollector, items: readonly BillingUsageItem[], endpoint: Endpoint): void {
  const byDay = new Map<string, Map<string, Group>>();
  for (const item of items) {
    const day = byDay.get(item.date) ?? new Map<string, Group>();
    byDay.set(item.date, day);
    const name = billingMetricNames.dailySpend(item.product);
    addTo(day, name.metricKey, name.label, item.netAmount);
  }
  for (const [date, groups] of byDay) {
    const start = new Date(`${date}T00:00:00Z`);
    collector.spend(groups, endpoint, { type: "period", start, end: new Date(start.getTime() + DAY_MS) });
  }
}

function collectCopilot(collector: MetricCollector, items: readonly AggregatedUsageItem[], endpoint: Endpoint, month: Month): void {
  const spend = new Map<string, Group>();
  const usage = new Map<string, Group & { unit: string }>();
  for (const item of items) {
    const spendName = billingMetricNames.spend("Copilot");
    const usageName = billingMetricNames.usage("Copilot", item.unitType);
    addTo(spend, spendName.metricKey, spendName.label, item.netAmount);
    addUsageTo(usage, usageName.metricKey, usageName.label, usageName.unit, item.grossQuantity);
  }
  collector.spend(spend, endpoint, monthTimeframe(month));
  collector.usage(usage, endpoint, monthTimeframe(month));
}

/**
 * Billing endpoints answer for accounts that cannot use them (no enhanced billing platform, a
 * missing permission) with 403, or with 400 or 404 (exact code is in the page's Unverified list).
 * Those become partial errors so stars and forks are still collected. 401, 429, 5xx, timeouts,
 * and schema drift propagate and fail the sync.
 */
async function optional<T>(
  read: () => Promise<T>,
  endpoint: Endpoint,
  permission: string,
): Promise<{ ok: true; value: T } | { ok: false; error: PermissionMissingError }> {
  try {
    return { ok: true, value: await read() };
  } catch (error) {
    if (
      !(error instanceof PermissionMissingError) &&
      !(error instanceof InvalidResponseError && (error.status === 400 || error.status === 404))
    ) {
      throw error;
    }
    return {
      ok: false,
      error: new PermissionMissingError(
        `GitHub billing data from ${endpoint.template} is unavailable: it needs ${permission} and the enhanced billing platform`,
        [permission],
        { cause: error, ...(error.status === undefined ? {} : { status: error.status }), endpoint: endpoint.template },
      ),
    };
  }
}

export async function collectBilling(ctx: OAuthContext, target: BillingTarget): Promise<BillingResult> {
  const endpoints = endpointsFor(target);
  // Organization billing needs Organization Administration read; personal billing needs Account Plan read.
  const permission = target.accountType === "Organization" ? "organization_administration:read" : "plan:read";
  const collector = new MetricCollector(ctx, target);
  // One partial error per endpoint, however many months were read.
  const partialErrors = new Map<string, PermissionMissingError>();
  const read = <T>(endpoint: Endpoint, schema: z.ZodType<T>, month: Month) =>
    optional(
      () => getJson(ctx, endpoint.path, target.token, schema, { year: String(month.year), month: String(month.month) }),
      endpoint,
      permission,
    );

  for (const month of monthsToSync(ctx.now())) {
    const summary = await read(endpoints.summary, AggregatedUsageSchema, month);
    if (summary.ok) collectSummary(collector, summary.value.usageItems, endpoints.summary, month);
    else partialErrors.set(endpoints.summary.template, summary.error);

    const daily = await read(endpoints.usage, BillingUsageSchema, month);
    if (daily.ok) collectDaily(collector, daily.value.usageItems, endpoints.usage);
    else partialErrors.set(endpoints.usage.template, daily.error);

    // Copilot is billed in AI credits since 2026-06-01; premium requests are the legacy fallback
    // for earlier months and for accounts that still have premium request rows.
    const aiCredit = await read(endpoints.aiCredit, AggregatedUsageSchema, month);
    if (aiCredit.ok && aiCredit.value.usageItems.length > 0) {
      collectCopilot(collector, aiCredit.value.usageItems, endpoints.aiCredit, month);
      continue;
    }
    const premium = await read(endpoints.premiumRequest, AggregatedUsageSchema, month);
    if (premium.ok) {
      collectCopilot(collector, premium.value.usageItems, endpoints.premiumRequest, month);
      if (premium.value.usageItems.length > 0) continue;
    } else {
      partialErrors.set(endpoints.premiumRequest.template, premium.error);
    }
    if (!aiCredit.ok) partialErrors.set(endpoints.aiCredit.template, aiCredit.error);
  }

  return { metrics: collector.metrics, partialErrors: [...partialErrors.values()] };
}
