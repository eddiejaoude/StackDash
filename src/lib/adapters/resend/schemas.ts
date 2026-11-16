import { z } from "zod";

/**
 * Response schemas for the Resend endpoints the adapter calls. Shapes and field meanings are from
 * docs/providers/resend.md; unknown fields are ignored by `z.object`.
 */

// Resend's own OAuth server; the callback `iss` must match it (docs/providers/resend.md, Authorize request).
export const RESEND_ISSUER = "https://api.resend.com";

const isoDateTime = z.iso.datetime({ offset: true }).transform((text) => new Date(text));

// `/emails/metrics` accepts a date or a datetime for `start_date` and `end_date`; accept either on the
// way back too. A bare ISO date parses as UTC midnight.
const isoDateOrDateTime = z
  .union([z.iso.datetime({ offset: true }), z.iso.date()])
  .transform((text) => new Date(text));

const POSTGRES_TIMESTAMP =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/;
const UTC_OFFSET = /^([+-]\d{2}):?(\d{2})?$/;

/**
 * Domain `created_at` is a Postgres style timestamp (`2026-04-26 20:21:26.347412+00`), not strict
 * ISO 8601, so `Date.parse` cannot be trusted with it. Rewrites it to ISO 8601 with millisecond
 * precision and an explicit `+HH:MM` offset, then parses. Returns undefined for anything else.
 */
export function parseResendTimestamp(text: string): Date | undefined {
  const match = POSTGRES_TIMESTAMP.exec(text);
  if (match === null) return undefined;
  const [, date, time, fraction = "", zone] = match;
  if (date === undefined || time === undefined || zone === undefined) return undefined;
  let offset = "Z";
  if (zone !== "Z") {
    const zoneMatch = UTC_OFFSET.exec(zone);
    if (zoneMatch === null) return undefined;
    const [, hours, minutes = "00"] = zoneMatch;
    if (hours === undefined) return undefined;
    offset = `${hours}:${minutes}`;
  }
  const milliseconds = fraction.padEnd(3, "0").slice(0, 3);
  const parsed = new Date(`${date}T${time}.${milliseconds}${offset}`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

const resendTimestamp = z.string().transform((text, ctx) => {
  const parsed = parseResendTimestamp(text);
  if (parsed === undefined) {
    ctx.addIssue({ code: "custom", message: "is not a Resend timestamp" });
    return z.NEVER;
  }
  return parsed;
});

const count = z.int().nonnegative();

// Both authorization code and refresh responses always carry a refresh token: Resend rotates it on
// every refresh, so a response without one is a shape change, not "keep the old one".
export const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.int().positive(),
  refresh_token: z.string().min(1),
  scope: z.string().optional(),
});

// `limit` is null when the plan has no cap. Daily is null on paid sending plans; monthly is
// documented as always a number, but paid-plan shapes are unverified (docs/providers/resend.md,
// Unverified 11), so null is accepted for both.
const EmailWindowSchema = z.object({
  used: count,
  limit: count.nullable(),
  resets_at: isoDateTime,
});

export const UsageResponseSchema = z.object({
  object: z.literal("usage"),
  emails: z.object({
    daily: EmailWindowSchema,
    monthly: EmailWindowSchema,
  }),
});

export const EmailMetricsResponseSchema = z.object({
  object: z.literal("metrics"),
  start_date: isoDateOrDateTime,
  end_date: isoDateOrDateTime,
  totals: z.object({
    delivered: count,
    bounced: count,
    complained: count,
  }),
});

export const domainStatuses = [
  "not_started",
  "pending",
  "verified",
  "partially_verified",
  "partially_failed",
  "failed",
  "temporary_failure",
] as const;

export const DomainStatusSchema = z.enum(domainStatuses);
export type DomainStatus = z.infer<typeof DomainStatusSchema>;

export const DomainSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  status: DomainStatusSchema,
  created_at: resendTimestamp,
});

export type Domain = z.infer<typeof DomainSchema>;

export const DomainListResponseSchema = z.object({
  object: z.literal("list"),
  has_more: z.boolean(),
  data: z.array(DomainSchema),
});

// `POST /webhooks` (#427): the new webhook's id and the signing secret Resend generated for it. The
// API reference's response sample carries both, so automatic setup needs no second call.
export const CreateWebhookResponseSchema = z.object({
  object: z.literal("webhook"),
  id: z.string().min(1),
  signing_secret: z.string().min(1),
});

// `DELETE /webhooks/:id`.
export const DeleteWebhookResponseSchema = z.object({
  object: z.literal("webhook"),
  deleted: z.literal(true),
});

// Every webhook delivery's envelope: `{ type, created_at, data }` (Resend's event type pages).
export const WebhookTypeSchema = z.object({ type: z.string() });

// `domain.updated`: only the fields the timeline shows. `status` is read as text, so a status
// Resend adds later is ignored rather than refused (a refused delivery is retried, and an endpoint
// that keeps failing is disabled by Resend).
export const DomainUpdatedDeliverySchema = z.object({
  type: z.literal("domain.updated"),
  created_at: isoDateTime,
  data: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: z.string(),
  }),
});

export type TokenResponse = z.infer<typeof TokenResponseSchema>;
export type UsageResponse = z.infer<typeof UsageResponseSchema>;
export type EmailMetricsResponse = z.infer<typeof EmailMetricsResponseSchema>;
