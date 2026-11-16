import { z } from "zod";
import { DELIVERY_ID_MAX_LENGTH } from "@/lib/webhooks/signature";

/**
 * Allowlist schemas for every Stripe response the adapter reads (docs/providers/stripe.md).
 * `z.object` drops unknown keys, so personal data in Stripe objects (names, emails, addresses,
 * card details, descriptions, metadata) never leaves the parse boundary.
 */

const StripeIdSchema = z.string().min(1).max(255);
// Unix seconds, UTC.
const UnixSecondsSchema = z.int().nonnegative();
// Integers in the smallest currency unit; negative for refunds and fees billed on their own.
const AmountMinorSchema = z.int();
// Stripe returns lowercase ISO 4217 codes; StackDash stores uppercase.
const StripeCurrencySchema = z
  .string()
  .regex(/^[a-z]{3}$/, "must be a lowercase three-letter currency code")
  .transform((currency) => currency.toUpperCase());

/** `POST /v1/oauth/token`, same shape for the code exchange and refresh. `stripe_publishable_key` is not kept. */
export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  stripe_user_id: StripeIdSchema,
  livemode: z.boolean(),
  scope: z.string(),
  token_type: z.string().min(1),
});
export type TokenResponse = z.infer<typeof TokenResponseSchema>;

export type StripeList<T> = { data: T[]; has_more: boolean };

export function stripeListSchema<T extends z.ZodType>(item: T) {
  return z.object({ data: z.array(item), has_more: z.boolean() });
}

const FeeDetailSchema = z.object({
  amount: AmountMinorSchema,
  currency: StripeCurrencySchema,
  type: z.string().min(1),
});

/** `GET /v1/balance_transactions`. `description`, `source`, and `exchange_rate` are deliberately absent. */
export const BalanceTransactionSchema = z.object({
  id: StripeIdSchema,
  amount: AmountMinorSchema,
  created: UnixSecondsSchema,
  currency: StripeCurrencySchema,
  fee_details: z.array(FeeDetailSchema),
  type: z.string().min(1),
});
export type BalanceTransaction = z.infer<typeof BalanceTransactionSchema>;

/**
 * `GET /v1/events`. `data.object` is a full snapshot with personal data, so it stays `unknown`
 * here and is parsed per event type with the allowlists below, then dropped.
 */
export const EventSchema = z.object({
  id: StripeIdSchema,
  type: z.string().min(1),
  created: UnixSecondsSchema,
  data: z.object({ object: z.unknown() }),
});
export type StripeEvent = z.infer<typeof EventSchema>;

/**
 * A webhook delivery's body (#423): the event `GET /v1/events` returns, plus `account`, the connected
 * account it happened on (absent for an event on the app owner's own account), and `livemode`.
 * `data.object` stays `unknown` and goes through the same allowlists as a polled event.
 */
export const WebhookEventSchema = EventSchema.extend({
  account: StripeIdSchema.optional(),
  livemode: z.boolean(),
});

/**
 * Only the event id, read from a verified body as the delivery id. Stripe retries an event under
 * the same id, and the id is inside the signed body, so it cannot be swapped on a replay. Bounded
 * by DELIVERY_ID_MAX_LENGTH because it becomes a unique key in the database.
 */
export const WebhookEventIdSchema = z.object({ id: StripeIdSchema.max(DELIVERY_ID_MAX_LENGTH) });

// Only the fields the timeline uses. Since #261 that includes the charge's amount, the total refunded
// so far, and their currency, which the event title prints; each is optional, and a title without
// one simply has no amount. `failure_code` is a Stripe enum shown as a sentence, never as the code;
// free-text `failure_message` is never read.
export const ChargeObjectSchema = z.object({
  id: StripeIdSchema,
  amount: z.int().nonnegative().optional(),
  amount_refunded: z.int().nonnegative().optional(),
  currency: StripeCurrencySchema.optional(),
  refunded: z.boolean().optional(),
  failure_code: z.string().nullable().optional(),
});

export const CustomerObjectSchema = z.object({ id: StripeIdSchema });

export const SubscriptionObjectSchema = z.object({ id: StripeIdSchema, status: z.string().min(1) });
