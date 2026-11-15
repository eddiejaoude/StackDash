import { z } from "zod";
import { CurrencySchema } from "../metrics";

/**
 * Response schemas for the Example Cloud endpoints the adapter calls. Example Cloud is fictional:
 * the recorded responses in `fixtures/` are its whole API description. A real adapter takes these
 * shapes from the provider's documentation and its recorded responses, and says which in a comment.
 * `z.object` ignores fields the adapter does not read, so a provider adding a field never fails a
 * sync, while a field the adapter reads changing shape does.
 */

const isoDateTime = z.iso.datetime({ offset: true }).transform((text) => new Date(text));
const count = z.int().nonnegative();

// Both the code exchange and every refresh return a refresh token: Example Cloud rotates it.
export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.int().positive(),
  refresh_token: z.string().min(1),
  scope: z.string().optional(),
});

export const AccountListResponseSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      type: z.enum(["team", "personal"]),
    }),
  ),
});

const PeriodSchema = z
  .object({ start: isoDateTime, end: isoDateTime })
  .refine((period) => period.end.getTime() > period.start.getTime(), "period end must be after start");

export const UsageResponseSchema = z.object({
  period: PeriodSchema,
  // `included` is null on plans without a request allowance.
  requests: z.object({ used: count, included: count.nullable() }),
  // Null when the account has never held credit.
  credits: z.object({ balance_minor: z.int(), currency: CurrencySchema }).nullable(),
});

export const BillingResponseSchema = z.object({
  period: PeriodSchema,
  currency: CurrencySchema,
  month_to_date_minor: count,
});

export const PaymentsSummaryResponseSchema = z.object({
  period: PeriodSchema,
  currency: CurrencySchema,
  // Net of refunds, so it can go below zero.
  net_revenue_minor: z.int(),
  mrr_minor: count,
});

export const ProviderEventSchema = z.object({
  id: z.string().min(1),
  // Read as any string: a type the adapter does not map is skipped, never a failed sync.
  type: z.string().min(1),
  created_at: isoDateTime,
  project: z.string().min(1).optional(),
  url: z.string().optional(),
});

export const EventPageResponseSchema = z.object({
  data: z.array(ProviderEventSchema),
  next_page_token: z.string().min(1).nullable(),
});

/**
 * Webhook delivery bodies (fixtures/webhook-event-created.json). An event delivery carries the same
 * event object the events endpoint lists, so the timeline maps it once for both paths. An
 * uninstall carries when it happened, so one delivered after a reconnect is not applied to the new
 * grant. Any other delivery type fails this schema and is ignored, never an error.
 */
export const WebhookBodySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event.created"), account_id: z.string().min(1), data: ProviderEventSchema }),
  z.object({ type: z.literal("installation.deleted"), account_id: z.string().min(1), created_at: isoDateTime }),
]);

export type TokenResponse = z.infer<typeof TokenResponseSchema>;
export type UsageResponse = z.infer<typeof UsageResponseSchema>;
export type BillingResponse = z.infer<typeof BillingResponseSchema>;
export type PaymentsSummaryResponse = z.infer<typeof PaymentsSummaryResponseSchema>;
export type ProviderEvent = z.infer<typeof ProviderEventSchema>;
