import { z } from "zod";
import {
  AdapterScopedKeySchema,
  issuesFromZod,
  type BatchValidation,
  type ValidationIssue,
} from "./types";

/**
 * Normalized metric model. The zod schemas are the single source of truth;
 * every type below is inferred from them.
 */

export const CurrencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/, "must be an ISO 4217 code of three uppercase letters");

// z.int() only accepts safe integers, so a float or an overflowed amount fails here.
const nonNegativeMoneyShape = {
  amountMinor: z.int().nonnegative(),
  currency: CurrencySchema,
};

// Revenue nets refunds and a credit balance can be owed, so both may go below zero.
const signedMoneyShape = {
  amountMinor: z.int(),
  currency: CurrencySchema,
};

// Exported so an adapter that maps a provider's unit can test it against the same rule.
export const UnitSchema = z
  .string()
  .max(32)
  .regex(/^[A-Za-z][A-Za-z0-9_/-]*(?: [A-Za-z0-9_/-]+)*$/, "must be a unit like emails, minutes, GB");

const quantityShape = {
  // z.number() already rejects NaN and Infinity.
  value: z.number().nonnegative(),
  unit: UnitSchema,
};

export const TimeframeSchema = z.discriminatedUnion("type", [
  z
    .strictObject({ type: z.literal("period"), start: z.date(), end: z.date() })
    .refine((period) => period.end.getTime() > period.start.getTime(), {
      message: "period end must be after start",
      path: ["end"],
    }),
  z.strictObject({ type: z.literal("point"), at: z.date() }),
]);

export const ProvenanceSchema = z.strictObject({
  source: z.enum(["provider_api", "derived"]),
  endpoint: z.string().min(1).optional(),
  pricingSource: z.string().trim().min(1).optional(),
});

// An estimate is calculated by StackDash, so it is always derived and must name its price list.
const EstimatedProvenanceSchema = z.strictObject({
  source: z.literal("derived"),
  endpoint: z.string().min(1).optional(),
  pricingSource: z.string().trim().min(1),
});

const baseShape = {
  metricKey: AdapterScopedKeySchema,
  label: z.string().trim().min(1).max(120),
  timeframe: TimeframeSchema,
  externalAccountId: z.string().min(1),
  retrievedAt: z.date(),
  provenance: ProvenanceSchema,
  resetsAt: z.date().optional(),
};

const VerifiedSpendSchema = z.strictObject({
  ...baseShape,
  ...nonNegativeMoneyShape,
  kind: z.literal("verified_spend"),
});

const EstimatedSpendSchema = z.strictObject({
  ...baseShape,
  ...nonNegativeMoneyShape,
  kind: z.literal("estimated_spend"),
  provenance: EstimatedProvenanceSchema,
});

const IncludedAllowanceSchema = z.strictObject({
  ...baseShape,
  ...quantityShape,
  kind: z.literal("included_allowance"),
});

const RemainingAllowanceSchema = z.strictObject({
  ...baseShape,
  ...quantityShape,
  kind: z.literal("remaining_allowance"),
});

const UsageSchema = z.strictObject({
  ...baseShape,
  ...quantityShape,
  kind: z.literal("usage"),
});

const CreditBalanceSchema = z.strictObject({
  ...baseShape,
  ...signedMoneyShape,
  kind: z.literal("credit_balance"),
});

const RevenueSchema = z.strictObject({
  ...baseShape,
  ...signedMoneyShape,
  kind: z.literal("revenue"),
});

// A run rate at a point in time (Polar MRR and ARR), not money earned in a period. Its own kind so
// it can never be summed into revenue or spend, which the dashboard selects by kind (#114).
const RecurringRevenueSchema = z.strictObject({
  ...baseShape,
  ...nonNegativeMoneyShape,
  kind: z.literal("recurring_revenue"),
});

// Set by a user in StackDash. Part of the model so budgets compare against spend, never adapter output.
const BudgetSchema = z.strictObject({
  ...baseShape,
  ...nonNegativeMoneyShape,
  kind: z.literal("budget"),
});

const adapterMetricSchemas = [
  VerifiedSpendSchema,
  EstimatedSpendSchema,
  IncludedAllowanceSchema,
  RemainingAllowanceSchema,
  UsageSchema,
  CreditBalanceSchema,
  RevenueSchema,
  RecurringRevenueSchema,
] as const;

export const MetricSchema = z.discriminatedUnion("kind", [...adapterMetricSchemas, BudgetSchema]);
export const AdapterMetricSchema = z.discriminatedUnion("kind", adapterMetricSchemas);

export type Metric = z.infer<typeof MetricSchema>;
export type AdapterMetric = z.infer<typeof AdapterMetricSchema>;
export type MetricKind = Metric["kind"];
export type Timeframe = z.infer<typeof TimeframeSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * Gate between an adapter's `sync` output and storage. All or nothing: a
 * batch with one malformed metric points at an adapter bug, and storing the
 * rest would show a dashboard that looks complete but is not.
 * `providerId` is the adapter's id, registered or not (`ProviderAdapter`), so
 * the contract harness applies the same gate to an adapter before it is registered.
 */
export function validateAdapterMetrics(
  providerId: string,
  candidates: readonly unknown[],
): BatchValidation<AdapterMetric> {
  const items: AdapterMetric[] = [];
  const issues: ValidationIssue[] = [];
  const keyPrefix = `${providerId}.`;

  candidates.forEach((candidate, index) => {
    // Checked before parsing so a budget is reported as a budget, not as a generic shape error.
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "kind" in candidate &&
      candidate.kind === "budget"
    ) {
      issues.push({ index, path: "kind", message: "budget is set in StackDash and never comes from a provider" });
      return;
    }
    const parsed = AdapterMetricSchema.safeParse(candidate);
    if (!parsed.success) {
      issues.push(...issuesFromZod(index, parsed.error));
      return;
    }
    if (!parsed.data.metricKey.startsWith(keyPrefix)) {
      issues.push({ index, path: "metricKey", message: `must start with ${keyPrefix}` });
      return;
    }
    items.push(parsed.data);
  });

  return issues.length === 0 ? { ok: true, items } : { ok: false, issues };
}
