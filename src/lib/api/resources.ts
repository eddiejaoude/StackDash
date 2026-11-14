import "server-only";

import type { z } from "zod";

import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import { severityFor } from "@/lib/alerts/evaluate";
import { invalidRequest } from "@/lib/api/errors";
import type {
  ApiConnection,
  ApiEvent,
  ApiProject,
  ApiTriggeredAlert,
  ApiUsageSnapshot,
  ApiWorkspace,
  EventsQuerySchema,
  ListResponse,
  PageQuerySchema,
  TriggeredAlertsQuerySchema,
  UsageSnapshotsQuerySchema,
} from "@/lib/api/schemas";
import { isEstimated } from "@/lib/dashboard/aggregate";
import { decodeCursor, encodeCursor, type Cursor } from "@/lib/data/cursor";
import type { Database } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";

/*
 * Data access for the public API (#162), one loader per endpoint. Each calls the matching
 * `public.api_*` function with the hash of the presented key; the function resolves the workspace
 * and checks the scope from that hash inside the database, so no loader takes a workspace id and
 * none can read another workspace (supabase/tests/database/13_api_keys.test.sql). Lists are keyset
 * paginated with the opaque cursor from src/lib/data/cursor.ts.
 */

type Returns<Name extends keyof Database["public"]["Functions"]> =
  Database["public"]["Functions"][Name]["Returns"] extends readonly (infer Row)[] ? Row : never;

// Generated types mark every column a set-returning function returns as non-null. These can be
// null, so they are typed as such before anything reads them.
type WithNullable<Row, Key extends keyof Row> = Omit<Row, Key> & { [Field in Key]: Row[Field] | null };

type ConnectionRow = WithNullable<Returns<"api_connections">, "authorized_account_label" | "last_synced_at">;
type UsageSnapshotRow = WithNullable<
  Returns<"api_usage_snapshots">,
  | "project_id"
  | "value"
  | "unit"
  | "amount_minor"
  | "currency"
  | "period_start"
  | "period_end"
  | "point_at"
  | "resets_at"
  | "pricing_source"
>;
type EventRow = WithNullable<
  Returns<"api_activity_events">,
  "body" | "url" | "provider" | "connection_id" | "external_account_id" | "account_name"
>;
type TriggeredAlertRow = WithNullable<
  Returns<"api_triggered_alerts">,
  "observed_value" | "observed_amount_minor" | "currency" | "threshold_percent" | "acknowledged_at"
>;

export type PageQuery = z.infer<typeof PageQuerySchema>;

/** The decoded `cursor` parameter, or null for the first page. A malformed cursor is a 400. */
function afterCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined) return null;
  const cursor = decodeCursor(raw);
  if (cursor === null) {
    throw invalidRequest("The cursor parameter is not valid. Pass the next_cursor of the previous page unchanged.");
  }
  return cursor;
}

/**
 * One page from rows fetched with `limit + 1`: the extra row only says that another page exists,
 * and the last row shown becomes the cursor.
 */
function toPage<Row, Item>(
  rows: readonly Row[],
  limit: number,
  toItem: (row: Row) => Item,
  cursorOf: (row: Row) => Cursor,
): ListResponse<Item> {
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    data: shown.map(toItem),
    next_cursor: rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null,
  };
}

function failed(what: string, cause: unknown): Error {
  return new Error(`Failed to read ${what} for the API`, { cause });
}

export async function loadWorkspaces(tokenHash: string): Promise<ListResponse<ApiWorkspace>> {
  const { data, error } = await createAdminClient().rpc("api_workspaces", { p_token_hash: tokenHash });
  if (error) throw failed("workspaces", error);
  // Field by field, so a column added to the function later is not published by accident.
  return {
    data: data.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      is_personal: row.is_personal,
      created_at: row.created_at,
    })),
    next_cursor: null,
  };
}

export async function loadProjects(tokenHash: string, query: PageQuery): Promise<ListResponse<ApiProject>> {
  const after = afterCursor(query.cursor);
  const { data, error } = await createAdminClient().rpc("api_projects", {
    p_token_hash: tokenHash,
    ...(after === null ? {} : { p_after_created_at: after[0], p_after_id: after[1] }),
    p_limit: query.limit + 1,
  });
  if (error) throw failed("projects", error);
  return toPage(
    data,
    query.limit,
    (row) => ({ id: row.id, name: row.name, created_at: row.created_at }),
    (row) => [row.created_at, row.id],
  );
}

export async function loadConnections(tokenHash: string, query: PageQuery): Promise<ListResponse<ApiConnection>> {
  const after = afterCursor(query.cursor);
  const { data, error } = await createAdminClient().rpc("api_connections", {
    p_token_hash: tokenHash,
    ...(after === null ? {} : { p_after_created_at: after[0], p_after_id: after[1] }),
    p_limit: query.limit + 1,
  });
  if (error) throw failed("connections", error);
  const rows: ConnectionRow[] = data;
  return toPage(
    rows,
    query.limit,
    (row) => ({
      id: row.id,
      provider: row.provider,
      name: row.display_name,
      account: row.authorized_account_label,
      status: row.status,
      last_synced_at: row.last_synced_at,
      simulated: isSimulatedConnection(row),
      created_at: row.created_at,
    }),
    (row) => [row.created_at, row.id],
  );
}

// A snapshot is keyed by its UTC day, and the shared cursor carries a timestamp, so the day is
// encoded as its UTC midnight and read back as the date part.
const UTC_MIDNIGHT = "T00:00:00Z";

export async function loadUsageSnapshots(
  tokenHash: string,
  query: z.infer<typeof UsageSnapshotsQuerySchema>,
): Promise<ListResponse<ApiUsageSnapshot>> {
  const after = afterCursor(query.cursor);
  const { data, error } = await createAdminClient().rpc("api_usage_snapshots", {
    p_token_hash: tokenHash,
    ...(query.from === undefined ? {} : { p_from: query.from }),
    ...(query.to === undefined ? {} : { p_to: query.to }),
    ...(query.metric_key === undefined ? {} : { p_metric_key: query.metric_key }),
    ...(query.kind === undefined ? {} : { p_kind: query.kind }),
    ...(query.provider === undefined ? {} : { p_provider: query.provider }),
    ...(query.connection_id === undefined ? {} : { p_connection_id: query.connection_id }),
    ...(query.project_id === undefined ? {} : { p_project_id: query.project_id }),
    ...(after === null ? {} : { p_after_date: after[0].slice(0, "YYYY-MM-DD".length), p_after_id: after[1] }),
    p_limit: query.limit + 1,
  });
  if (error) throw failed("usage snapshots", error);
  const rows: UsageSnapshotRow[] = data;
  return toPage(
    rows,
    query.limit,
    (row) => ({
      id: row.id,
      date: row.snapshot_date,
      metric_key: row.metric_key,
      kind: row.kind,
      label: row.label,
      value: row.value,
      unit: row.unit,
      amount_minor: row.amount_minor,
      currency: row.currency,
      period_start: row.period_start,
      period_end: row.period_end,
      point_at: row.point_at,
      resets_at: row.resets_at,
      retrieved_at: row.retrieved_at,
      provenance: isEstimated(row) ? "estimated" : "verified",
      pricing_source: row.pricing_source,
      provider: row.provider,
      connection_id: row.connection_id,
      account_id: row.external_account_id,
      account_name: row.account_name,
      project_id: row.project_id,
      simulated: isSimulatedConnection(row),
    }),
    (row) => [`${row.snapshot_date}${UTC_MIDNIGHT}`, row.id],
  );
}

export async function loadEvents(
  tokenHash: string,
  query: z.infer<typeof EventsQuerySchema>,
): Promise<ListResponse<ApiEvent>> {
  const after = afterCursor(query.cursor);
  const { data, error } = await createAdminClient().rpc("api_activity_events", {
    p_token_hash: tokenHash,
    ...(query.from === undefined ? {} : { p_from: query.from }),
    ...(query.to === undefined ? {} : { p_to: query.to }),
    ...(query.type === undefined ? {} : { p_type_id: query.type }),
    ...(query.severity === undefined ? {} : { p_severity: query.severity }),
    ...(query.provider === undefined ? {} : { p_provider: query.provider }),
    ...(after === null ? {} : { p_after_occurred_at: after[0], p_after_id: after[1] }),
    p_limit: query.limit + 1,
  });
  if (error) throw failed("events", error);
  const rows: EventRow[] = data;
  return toPage(
    rows,
    query.limit,
    (row) => ({
      id: row.id,
      type: row.type_id,
      severity: row.severity,
      title: row.title,
      body: row.body,
      url: row.url,
      occurred_at: row.occurred_at,
      provider: row.provider,
      connection_id: row.connection_id,
      account_id: row.external_account_id,
      account_name: row.account_name,
      // The same rule as the timeline: StackDash's own events about a simulated connection count.
      simulated: row.connection_id !== null && isSimulatedConnection(row),
    }),
    (row) => [row.occurred_at, row.id],
  );
}

export async function loadTriggeredAlerts(
  tokenHash: string,
  query: z.infer<typeof TriggeredAlertsQuerySchema>,
): Promise<ListResponse<ApiTriggeredAlert>> {
  const after = afterCursor(query.cursor);
  const { data, error } = await createAdminClient().rpc("api_triggered_alerts", {
    p_token_hash: tokenHash,
    ...(query.acknowledged === undefined ? {} : { p_acknowledged: query.acknowledged }),
    ...(after === null ? {} : { p_after_triggered_at: after[0], p_after_id: after[1] }),
    p_limit: query.limit + 1,
  });
  if (error) throw failed("triggered alerts", error);
  const rows: TriggeredAlertRow[] = data;
  return toPage(
    rows,
    query.limit,
    (row) => ({
      id: row.id,
      rule_id: row.rule_id,
      triggered_at: row.triggered_at,
      cycle_key: row.cycle_key,
      // The rule's threshold decides it, the same way the alerts page does.
      severity: severityFor(row.threshold_percent),
      message: row.message,
      threshold_label: row.threshold_label,
      observed_value: row.observed_value,
      observed_amount_minor: row.observed_amount_minor,
      currency: row.currency,
      provenance: row.is_estimated ? "estimated" : "verified",
      acknowledged_at: row.acknowledged_at,
    }),
    (row) => [row.triggered_at, row.id],
  );
}
