import { z } from "zod";

/**
 * Allowlist schemas for every Polar response the adapter reads (docs/providers/polar.md), API
 * version 2026-10. `z.object` drops unknown keys, so the personal data Polar embeds in orders,
 * subscriptions, and customers (names, emails, billing addresses, tax ids, metadata, custom field
 * data, cancellation comments) never leaves the parse boundary.
 */

const PolarIdSchema = z.string().min(1).max(255);
const isoDateTime = z.iso.datetime({ offset: true }).transform((text) => new Date(text));
// Polar's enums, kept as strings: an unknown value is shown generically rather than failing the sync.
const PolarEnumSchema = z.string().regex(/^[a-z0-9_]{1,64}$/, "must be a lowercase enum value");
// Integer cents (the currency's minor units) on a single order or refund, which the timeline title
// prints (#261). Optional: without one the title carries no amount.
const PolarAmountMinorSchema = z.int().nonnegative().optional();
// Polar returns lowercase ISO 4217 codes ("usd"); StackDash stores uppercase.
const PolarCurrencySchema = z
  .string()
  .regex(/^[a-z]{3}$/i, "must be a three-letter currency code")
  .transform((currency) => currency.toUpperCase())
  .optional();

/** `POST /v1/oauth2/token`, for the code exchange and the refresh. `id_token` is not kept. */
export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.int().positive(),
  refresh_token: z.string().min(1).nullable().optional(),
  scope: z.string(),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

/** `POST /v1/oauth2/revoke` answers an empty object. */
export const RevokeResponseSchema = z.object({});

export type PolarList<T> = { items: T[]; pagination: { total_count: number; max_page: number } };

/** Every list endpoint: `page` and `limit` in, `items` and `pagination` out. */
export function polarListSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    pagination: z.object({ total_count: z.int().nonnegative(), max_page: z.int().nonnegative() }),
  });
}

/** `GET /v1/organizations/`. Only the id and the display name. */
export const OrganizationSchema = z.object({ id: PolarIdSchema, name: z.string().trim().min(1).max(255) });
export type Organization = z.infer<typeof OrganizationSchema>;

// "integer | number | null" in the reference. Currency values are in cents and may carry a
// fraction (MRR normalizes yearly plans by twelve), so they stay numbers until StackDash rounds once.
const MetricValueSchema = z.number().nonnegative().nullable().optional();

/**
 * `GET /v1/metrics/`, one period per day. Only the fields StackDash reads; a missing or null field
 * makes that metric unavailable, never zero.
 */
export const MetricPeriodSchema = z.object({
  timestamp: isoDateTime,
  revenue: MetricValueSchema,
  net_revenue: MetricValueSchema,
  orders: MetricValueSchema,
  new_subscriptions: MetricValueSchema,
  canceled_subscriptions: MetricValueSchema,
  active_subscriptions: MetricValueSchema,
  monthly_recurring_revenue: MetricValueSchema,
  annual_recurring_revenue: MetricValueSchema,
});
export type MetricPeriod = z.infer<typeof MetricPeriodSchema>;

export const MetricsResponseSchema = z.object({ periods: z.array(MetricPeriodSchema) });
export type MetricsResponse = z.infer<typeof MetricsResponseSchema>;

/**
 * `GET /v1/orders/`. No customer or billing fields. `total_amount` (the order's value after
 * discounts and tax; a customer's applied balance can make the amount charged differ) and its
 * `currency` are shown on the order's timeline title, one order at a time and never summed:
 * revenue still comes from `GET /v1/metrics/`.
 */
export const OrderSchema = z.object({
  id: PolarIdSchema,
  created_at: isoDateTime,
  status: PolarEnumSchema,
  billing_reason: PolarEnumSchema,
  total_amount: PolarAmountMinorSchema,
  currency: PolarCurrencySchema,
});
export type Order = z.infer<typeof OrderSchema>;

/** `GET /v1/subscriptions/`. `customer_cancellation_comment` is free text and is never read. */
export const SubscriptionSchema = z.object({
  id: PolarIdSchema,
  status: PolarEnumSchema,
  started_at: isoDateTime.nullable(),
  canceled_at: isoDateTime.nullable(),
  cancel_at_period_end: z.boolean(),
  customer_cancellation_reason: PolarEnumSchema.nullable().optional(),
});
export type Subscription = z.infer<typeof SubscriptionSchema>;

/**
 * `GET /v1/refunds/`. `amount` is the refund before tax and `tax_amount` the tax Polar refunds with
 * it (https://polar.sh/docs/features/refunds, "Amount"); their sum, what the customer got back, is
 * shown on the refund's timeline title. Revenue still comes from `GET /v1/metrics/`.
 */
export const RefundSchema = z.object({
  id: PolarIdSchema,
  created_at: isoDateTime,
  status: PolarEnumSchema,
  reason: PolarEnumSchema,
  amount: PolarAmountMinorSchema,
  tax_amount: PolarAmountMinorSchema,
  currency: PolarCurrencySchema,
});
export type Refund = z.infer<typeof RefundSchema>;

/** `GET /v1/customers/`, read only to count new customers. Never the email, name, or address. */
export const CustomerSchema = z.object({ id: PolarIdSchema, created_at: isoDateTime });
export type Customer = z.infer<typeof CustomerSchema>;
