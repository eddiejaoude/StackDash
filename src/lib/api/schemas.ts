import { z } from "zod";

import { Constants } from "@/lib/supabase/database.types";

/*
 * The public API contract (#162): query parameters every endpoint accepts and the JSON it returns.
 * The route handlers validate with these schemas and the OpenAPI document at /docs/api/openapi.json
 * is generated from them, so the two cannot drift. Field names are snake_case like the database;
 * money is integer minor units plus an ISO 4217 code, quantities are a value plus a unit, and
 * every value says whether it is verified or estimated, as the dashboard does.
 */

const Enums = Constants.public.Enums;

export const API_PAGE_SIZE_DEFAULT = 50;
export const API_PAGE_SIZE_MAX = 100;
const CURSOR_MAX_LENGTH = 200;

// Mirrors the metric_key and type_id checks in the database: dotted lowercase segments.
const DOTTED_ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;

const id = z.guid();
const timestamp = z.iso.datetime({ offset: true });
const date = z.iso.date();

const ProviderSchema = z.enum(Enums.provider_id).meta({ description: "Provider id, for example github or vercel." });
const ProvenanceSchema = z.enum(["verified", "estimated"]).meta({
  description:
    "verified: reported by the provider. estimated: calculated by StackDash from a price list. The same labels the dashboard shows.",
});
const SimulatedSchema = z.boolean().meta({
  description: "True when the provider simulator made the connection, so the data is made up.",
});

// ── Query parameters ────────────────────────────────────────────────────────────

const pageParams = {
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(API_PAGE_SIZE_MAX)
    .default(API_PAGE_SIZE_DEFAULT)
    .meta({ description: `Rows per page, 1 to ${API_PAGE_SIZE_MAX}.` }),
  cursor: z
    .string()
    .min(1)
    .max(CURSOR_MAX_LENGTH)
    .optional()
    .meta({ description: "The next_cursor of the previous page. Leave it out for the first page." }),
};

export const NoQuerySchema = z.strictObject({});
export const PageQuerySchema = z.strictObject(pageParams);

export const UsageSnapshotsQuerySchema = z.strictObject({
  ...pageParams,
  from: date.optional().meta({ description: "First UTC day to include, YYYY-MM-DD." }),
  to: date.optional().meta({ description: "Last UTC day to include, YYYY-MM-DD." }),
  metric_key: z.string().max(200).regex(DOTTED_ID).optional().meta({ description: "One metric key, for example github.spend.actions." }),
  kind: z.enum(Enums.metric_kind).optional(),
  provider: ProviderSchema.optional(),
  connection_id: id.optional(),
  project_id: id.optional(),
});

export const EventsQuerySchema = z.strictObject({
  ...pageParams,
  from: timestamp.optional().meta({ description: "Earliest occurred_at to include (inclusive), RFC 3339 with an offset." }),
  to: timestamp.optional().meta({ description: "Latest occurred_at to include (exclusive), RFC 3339 with an offset." }),
  type: z.string().max(200).regex(DOTTED_ID).optional().meta({ description: "One event type id, for example vercel.deployment.succeeded." }),
  severity: z.enum(Enums.event_severity).optional(),
  provider: ProviderSchema.optional(),
});

export const TriggeredAlertsQuerySchema = z.strictObject({
  ...pageParams,
  acknowledged: z
    .stringbool()
    .optional()
    .meta({ description: "true for acknowledged alerts only, false for unacknowledged only. Leave it out for both." }),
});

// ── Resources ───────────────────────────────────────────────────────────────────
// No `.meta({ id })`: an id registers the schema globally and moves it into `$defs`. The OpenAPI
// document inlines each response instead (src/lib/api/openapi.ts).

export const WorkspaceSchema = z
  .object({
    id,
    slug: z.string().meta({ description: "The workspace ID shown in settings and in app URLs." }),
    name: z.string(),
    is_personal: z.boolean(),
    created_at: timestamp,
  })
  .meta({ description: "The workspace the key belongs to." });

export const ProjectSchema = z
  .object({ id, name: z.string(), created_at: timestamp })
  .meta({ description: "A project groups provider accounts into one product." });

export const ConnectionSchema = z
  .object({
    id,
    provider: ProviderSchema,
    name: z.string(),
    account: z.string().nullable().meta({ description: "The provider account that granted access, as the provider names it." }),
    status: z.enum(Enums.connection_status),
    last_synced_at: timestamp.nullable(),
    simulated: SimulatedSchema,
    created_at: timestamp,
  })
  .meta({ description: "Connection status only. Credentials are never returned." });

export const UsageSnapshotSchema = z
  .object({
    id,
    date: date.meta({ description: "The UTC day this snapshot is for. The latest day per metric is the current value." }),
    metric_key: z.string(),
    kind: z.enum(Enums.metric_kind),
    label: z.string(),
    value: z.number().nullable().meta({ description: "Quantity in `unit`. Null for money." }),
    unit: z.string().nullable(),
    amount_minor: z.number().int().nullable().meta({ description: "Money in minor units of `currency`, for example cents. Null for quantities." }),
    currency: z.string().length(3).nullable().meta({ description: "ISO 4217 code." }),
    period_start: timestamp.nullable(),
    period_end: timestamp.nullable(),
    point_at: timestamp.nullable(),
    resets_at: timestamp.nullable(),
    retrieved_at: timestamp,
    provenance: ProvenanceSchema,
    pricing_source: z.string().nullable().meta({ description: "The price list behind an estimate." }),
    provider: ProviderSchema,
    connection_id: id,
    account_id: id,
    account_name: z.string(),
    project_id: id.nullable(),
    simulated: SimulatedSchema,
  })
  .meta({ description: "One metric of one provider account on one UTC day." });

export const EventSchema = z
  .object({
    id,
    type: z.string(),
    severity: z.enum(Enums.event_severity),
    title: z.string(),
    body: z.string().nullable(),
    url: z.string().nullable(),
    occurred_at: timestamp,
    provider: ProviderSchema.nullable().meta({ description: "Null for events StackDash creates itself." }),
    connection_id: id.nullable(),
    account_id: id.nullable(),
    account_name: z.string().nullable(),
    simulated: SimulatedSchema,
  })
  .meta({ description: "One event on the workspace timeline." });

export const TriggeredAlertSchema = z
  .object({
    id,
    rule_id: id,
    triggered_at: timestamp,
    cycle_key: z.string().meta({ description: "The billing cycle the alert fired in. A rule fires at most once per cycle." }),
    severity: z.enum(["warning", "critical"]),
    message: z.string(),
    threshold_label: z.string(),
    observed_value: z.number().nullable(),
    observed_amount_minor: z.number().int().nullable(),
    currency: z.string().length(3).nullable(),
    provenance: ProvenanceSchema,
    acknowledged_at: timestamp.nullable(),
  })
  .meta({ description: "An alert rule that fired." });

/** `{ data, next_cursor }`: every endpoint answers with one page of a list. */
export function listResponseSchema<Item extends z.ZodType>(item: Item) {
  return z.object({
    data: z.array(item),
    next_cursor: z.string().nullable().meta({ description: "Pass as `cursor` to read the next page. Null on the last page." }),
  });
}

export type ListResponse<Item> = { data: Item[]; next_cursor: string | null };

export type ApiWorkspace = z.infer<typeof WorkspaceSchema>;
export type ApiProject = z.infer<typeof ProjectSchema>;
export type ApiConnection = z.infer<typeof ConnectionSchema>;
export type ApiUsageSnapshot = z.infer<typeof UsageSnapshotSchema>;
export type ApiEvent = z.infer<typeof EventSchema>;
export type ApiTriggeredAlert = z.infer<typeof TriggeredAlertSchema>;

export const API_ERROR_CODES = ["invalid_request", "unauthorized", "forbidden", "rate_limited", "internal"] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    message: z.string(),
    reference_id: z.string().meta({ description: "Quote it when asking for help; the details are logged against it." }),
  }),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
