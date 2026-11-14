import { z } from "zod";
import { formatMoney } from "@/lib/format";
import {
  AdapterScopedKeySchema,
  issuesFromZod,
  type BatchValidation,
  type ValidationIssue,
} from "./types";

/**
 * What an event stands for across providers, for figures that count one kind of event (the
 * dashboard headline's signups and deploys, #173). Declared by the adapter, so a new provider's
 * events are counted without a second list to keep in step. Only for one event per signup or
 * deploy: the figures count events, so a daily summary (`supabase.auth.daily_summary`,
 * `posthog.signups.daily`) has no category. A provider that reports signups only as a daily total
 * declares the usage metric holding it instead (`ProviderAdapter.signupDailyTotals`), and the
 * headline sums that metric's daily readings.
 */
export const EventCategorySchema = z.enum(["signup", "deploy_succeeded", "deploy_failed"]);

/** One emoji, with its optional presentation selector: `🚀`, `⚠️`. */
export const EventEmojiSchema = z.string().regex(/^\p{Extended_Pictographic}\uFE0F?$/u, "must be one emoji");

/**
 * Declared by each adapter. Events carry the id so members can hide event
 * types later (#119) without reworking stored events. `category` is left out
 * for events that are none of the categories.
 */
export const EventTypeSchema = z.strictObject({
  id: AdapterScopedKeySchema,
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(280),
  shownByDefault: z.boolean(),
  category: EventCategorySchema.optional(),
  // One emoji for what happened (🚀 a deployment went live, 💳 a payment), shown in the corner of
  // the provider's logo on the timeline. Decorative: the label and title say it in words.
  emoji: EventEmojiSchema,
});

export const EventSeveritySchema = z.enum(["info", "success", "warning", "critical"]);

/**
 * Strict so an adapter cannot attach fields the model does not name: there is
 * deliberately no field for an author, email, or other personal data.
 */
export const ActivityEventSchema = z.strictObject({
  typeId: AdapterScopedKeySchema,
  occurredAt: z.date(),
  severity: EventSeveritySchema,
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(2000).optional(),
  externalAccountId: z.string().min(1),
  // Unique per adapter; the store upserts on it so a repeated poll never duplicates an event.
  dedupeKey: z.string().min(1).max(200),
  // https only: the link is rendered in the dashboard and must not downgrade or run script.
  url: z.url({ protocol: /^https$/ }).optional(),
});

export type EventCategory = z.infer<typeof EventCategorySchema>;
export type EventType = z.infer<typeof EventTypeSchema>;
export type EventSeverity = z.infer<typeof EventSeveritySchema>;
export type ActivityEvent = z.infer<typeof ActivityEventSchema>;

/**
 * The ids of the types in any of `categories`, each once, in declaration order: what the headline
 * strip and the activity heatmap count as signups and deploys.
 */
export function typeIdsOfCategory(
  types: readonly Readonly<Pick<EventType, "id" | "category">>[],
  categories: readonly EventCategory[],
): string[] {
  return [...new Set(types.filter((type) => type.category !== undefined && categories.includes(type.category)).map((type) => type.id))];
}

/**
 * Gate between an adapter's `sync` output and storage. All or nothing, like
 * metrics: an undeclared type id means the adapter and its declaration drifted.
 */
export function validateAdapterEvents(
  eventTypes: readonly EventType[],
  candidates: readonly unknown[],
): BatchValidation<ActivityEvent> {
  const declared = new Set(eventTypes.map((eventType) => eventType.id));
  const items: ActivityEvent[] = [];
  const issues: ValidationIssue[] = [];

  candidates.forEach((candidate, index) => {
    const parsed = ActivityEventSchema.safeParse(candidate);
    if (!parsed.success) {
      issues.push(...issuesFromZod(index, parsed.error));
      return;
    }
    if (!declared.has(parsed.data.typeId)) {
      issues.push({ index, path: "typeId", message: "is not one of the adapter's declared event types" });
      return;
    }
    items.push(parsed.data);
  });

  return issues.length === 0 ? { ok: true, items } : { ok: false, issues };
}

/**
 * An event title with the money the event moved (#261): "Payment succeeded: $49.00". The amount is
 * integer minor units in `currency` (ISO 4217), formatted with that currency's own minor digits,
 * so 1900 JPY is "¥1,900". One amount per title, never a sum. Without the amount or its currency
 * the title stands alone: no placeholder, no zero.
 */
export function titleWithAmount(title: string, amountMinor: number | undefined, currency: string | undefined): string {
  return amountMinor === undefined || currency === undefined ? title : `${title}: ${formatMoney(amountMinor, currency)}`;
}
