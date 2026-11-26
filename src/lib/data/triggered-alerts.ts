import "server-only";

import { cache } from "react";

import { severityFor, type AlertSeverity } from "@/lib/alerts/evaluate";
import { alertHeadline, type AlertHeadline } from "@/lib/alerts/headline";
import { beforeCursorFilter, decodeCursor, encodeCursor, type Page } from "@/lib/data/cursor";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

/**
 * Triggered alerts (#69): the history the evaluator records, read as the signed-in user, plus the
 * one write members make to it, acknowledging. Row level security lets viewers read and admins
 * update, and the column grant limits that update to `acknowledged_at` and `acknowledged_by`, so
 * nothing here can change or delete an alert's history. Lists read newest first through the
 * `triggered_alerts_workspace_triggered_at_idx` index (workspace_id, triggered_at desc).
 */

type Row = Database["public"]["Tables"]["triggered_alerts"]["Row"];

type ListedColumns =
  | "id"
  | "triggered_at"
  | "threshold_label"
  | "is_estimated"
  | "message"
  | "acknowledged_at"
  | "acknowledged_by";

export type TriggeredAlert = Pick<Row, ListedColumns> & { severity: AlertSeverity; headline: AlertHeadline };

export type UnacknowledgedSummary = { count: number; newest: TriggeredAlert[] };

export const TRIGGERED_ALERTS_PAGE_SIZE = 50;
export const SUMMARY_NEWEST_COUNT = 3;
/**
 * The most alerts one "Acknowledge all" acknowledges. The ids travel in the update's URL
 * (`id=in.(…)`), so 100 keeps it near 4 KB; PostgREST's own `limit` on an update is not usable here
 * (with an `order` it fails with 42703 on the local stack, checked 2026-11-10).
 */
export const ACKNOWLEDGE_ALL_LIMIT = 100;

// The rule's threshold decides the severity, the same way the evaluator decides it; the stored
// subject, the rule's kind, and the observed columns make the short title (src/lib/alerts/headline.ts).
const COLUMNS =
  "id, triggered_at, threshold_label, is_estimated, message, acknowledged_at, acknowledged_by, provider, subject, observed_value, observed_amount_minor, currency, alert_rules!triggered_alerts_rule_fkey(threshold_percent, kind)" as const;

type SelectedRow = Pick<Row, ListedColumns | "provider" | "subject" | "observed_value" | "observed_amount_minor" | "currency"> & {
  alert_rules: Pick<Database["public"]["Tables"]["alert_rules"]["Row"], "threshold_percent" | "kind"> | null;
};

function toAlert({
  alert_rules: rule,
  provider,
  subject,
  observed_value,
  observed_amount_minor,
  currency,
  ...row
}: SelectedRow): TriggeredAlert {
  return {
    ...row,
    severity: severityFor(rule?.threshold_percent ?? null),
    headline: alertHeadline({ kind: rule?.kind ?? null, provider, subject, observed_value, observed_amount_minor, currency }),
  };
}

/**
 * One page of the workspace's triggered alerts, newest first. Acknowledged alerts are left out
 * unless `includeAcknowledged`; a missing or malformed `after` cursor means the first page.
 */
export const listTriggeredAlerts = cache(
  async (workspaceId: string, includeAcknowledged: boolean, after: string | null): Promise<Page<TriggeredAlert>> => {
    const supabase = await createClient();
    let query = supabase.from("triggered_alerts").select(COLUMNS).eq("workspace_id", workspaceId);
    if (!includeAcknowledged) query = query.is("acknowledged_at", null);
    const cursor = decodeCursor(after);
    if (cursor !== null) query = query.or(beforeCursorFilter("triggered_at", cursor));
    const { data, error } = await query
      .order("triggered_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(TRIGGERED_ALERTS_PAGE_SIZE + 1);
    if (error) throw new Error("Failed to list triggered alerts", { cause: error });
    const items = data.slice(0, TRIGGERED_ALERTS_PAGE_SIZE).map(toAlert);
    const last = items.at(-1);
    return {
      items,
      nextCursor:
        data.length > TRIGGERED_ALERTS_PAGE_SIZE && last !== undefined
          ? encodeCursor([last.triggered_at, last.id])
          : null,
    };
  },
);

/** True when any alert has ever fired in this workspace, acknowledged or not. */
export const hasTriggeredAlerts = cache(async (workspaceId: string): Promise<boolean> => {
  const supabase = await createClient();
  const { data, error } = await supabase.from("triggered_alerts").select("id").eq("workspace_id", workspaceId).limit(1);
  if (error) throw new Error("Failed to check for triggered alerts", { cause: error });
  return data.length > 0;
});

/** How many alerts nobody has acknowledged yet. */
export const countUnacknowledgedAlerts = cache(async (workspaceId: string): Promise<number> => {
  const supabase = await createClient();
  const { count, error } = await supabase
    .from("triggered_alerts")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId)
    .is("acknowledged_at", null);
  if (error) throw new Error("Failed to count unacknowledged alerts", { cause: error });
  return count ?? 0;
});

/** How many alerts nobody has acknowledged yet, and the newest few of them, for the dashboard. */
export const getUnacknowledgedSummary = cache(async (workspaceId: string): Promise<UnacknowledgedSummary> => {
  const supabase = await createClient();
  const [count, newest] = await Promise.all([
    countUnacknowledgedAlerts(workspaceId),
    supabase
      .from("triggered_alerts")
      .select(COLUMNS)
      .eq("workspace_id", workspaceId)
      .is("acknowledged_at", null)
      .order("triggered_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(SUMMARY_NEWEST_COUNT),
  ]);
  if (newest.error) throw new Error("Failed to list unacknowledged alerts", { cause: newest.error });
  return { count, newest: newest.data.map(toAlert) };
});

/**
 * Marks an alert acknowledged by `userId`, now. Idempotent: an alert that is already acknowledged
 * keeps its first acknowledgement and still counts as success. False when no alert with `id`
 * exists in this workspace, so another workspace's id reads exactly like a missing one.
 */
export async function acknowledgeTriggeredAlert(workspaceId: string, id: string, userId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("triggered_alerts")
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: userId })
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .is("acknowledged_at", null)
    .select("id");
  if (error) throw new Error("Failed to acknowledge alert", { cause: error });
  if (data.length > 0) return true;
  // Nothing updated: either someone acknowledged it first, or it does not exist here.
  const { data: existing, error: readError } = await supabase
    .from("triggered_alerts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("id", id)
    .maybeSingle();
  if (readError) throw new Error("Failed to read alert", { cause: readError });
  return existing !== null;
}

/**
 * Marks this workspace's unacknowledged alerts acknowledged by `userId`, now: the newest
 * `ACKNOWLEDGE_ALL_LIMIT` of them, so one call is bounded however many have piled up. Returns how
 * many this call acknowledged. An alert someone else acknowledged in between keeps their
 * acknowledgement and is not counted, and another workspace's alerts are never read or written.
 */
export async function acknowledgeAllTriggeredAlerts(workspaceId: string, userId: string): Promise<number> {
  const supabase = await createClient();
  const { data: pending, error: readError } = await supabase
    .from("triggered_alerts")
    .select("id")
    .eq("workspace_id", workspaceId)
    .is("acknowledged_at", null)
    .order("triggered_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ACKNOWLEDGE_ALL_LIMIT);
  if (readError) throw new Error("Failed to list unacknowledged alerts", { cause: readError });
  if (pending.length === 0) return 0;
  const { data, error } = await supabase
    .from("triggered_alerts")
    .update({ acknowledged_at: new Date().toISOString(), acknowledged_by: userId })
    .eq("workspace_id", workspaceId)
    .in(
      "id",
      pending.map((row) => row.id),
    )
    .is("acknowledged_at", null)
    .select("id");
  if (error) throw new Error("Failed to acknowledge alerts", { cause: error });
  return data.length;
}
