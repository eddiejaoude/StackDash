import "server-only";

import { declaredProjectedSpend } from "@/lib/adapters/registry";
import { loadSnapshots } from "@/lib/alerts/run";
import { severityFor } from "@/lib/alerts/evaluate";
import { snapshotWindowStart } from "@/lib/dashboard/aggregate";
import { markerTypeIds } from "@/lib/dashboard/markers";
import {
  listDeliveryDestinations,
  loadDestinationSecret,
  updateDestinationHealth,
} from "@/lib/data/notification-destinations";
import { log } from "@/lib/log/logger";
import { PROVIDER_NAMES } from "@/lib/providers";
import { createAdminClient } from "@/lib/supabase/admin";
import type { TablesInsert } from "@/lib/supabase/database.types";
import { readAllPages } from "@/lib/supabase/paging";

import type { NotificationStore } from "./dispatch";
import { deliveryKey, sumDailyCounts, type DeliveryAlert } from "./model";

/*
 * Postgres implementation of the notification jobs' store (#152, #153). Service role, called only
 * by the tick: every query names the workspace, because row level security does not apply here.
 * Errors carry the operation and the Postgres code only, never row data.
 */

function failure(operation: string, error: { code: string }): Error {
  return new Error(`Notification store ${operation} failed (code ${error.code}).`);
}

const ALERT_COLUMNS = "id, rule_id, title, message, threshold_label, is_estimated, provider, project_id, resets_at, triggered_at";

// Bounds for the small lists one dispatch reads. A workspace in the MVP has a handful of each.
const CONNECTIONS_LIMIT = 100;
const ACCOUNTS_LIMIT = 1000;
const PROJECTS_LIMIT = 500;
// Deliveries already made for one dispatch's subjects (up to DISPATCH_ALERT_LIMIT alerts, each to
// every recipient and channel), read in pages of the Data API's row cap (readAllPages).
export const DELIVERIES_LIMIT = 5000;
// A weekly digest reads 7 days per account, and a restated day adds a row or two.
const DAILY_COUNTS_LIMIT = 1000;

// Timeline highlights in the digest, by event type: what each provider calls a deployment, a
// signup, a star, and a payment (src/lib/adapters/*/events). PostgREST `like` patterns, where `*`
// is the wildcard: https://docs.postgrest.org/en/stable/references/api/tables_views.html#operators
// Star events are the dashboard's star markers, by exact id: the daily net and the milestone. A
// `github.stars.new` event is one star, so counting it beside the daily event would count the same
// stars twice and say "star events" about stars (#62).
const HIGHLIGHT_PATTERNS = {
  deploys: ["*.deploy.succeeded", "*.deployment.succeeded"],
  signups: ["*.signup"],
  stars: markerTypeIds(["stars"]),
  payments: ["stripe.charge.succeeded", "polar.order.paid"],
} as const;

// Signups some providers report as one count per day rather than one event per person
// (src/lib/adapters/posthog: the `posthog.signups.daily` usage metric, which carries the count its
// timeline event only shows in the title). Summed from the snapshots instead of counted as events.
const DAILY_SIGNUP_METRICS = ["posthog.signups.daily"] as const;

export function createSupabaseNotificationStore(): NotificationStore {
  const db = createAdminClient();

  async function toDeliveryAlerts(
    workspaceId: string,
    rows: ReadonlyArray<{
      id: string;
      rule_id: string;
      title: string | null;
      message: string;
      threshold_label: string;
      is_estimated: boolean;
      provider: keyof typeof PROVIDER_NAMES | null;
      project_id: string | null;
      resets_at: string | null;
      triggered_at: string;
    }>,
  ): Promise<DeliveryAlert[]> {
    if (rows.length === 0) return [];
    const ruleIds = [...new Set(rows.map((row) => row.rule_id))];
    const projectIds = [...new Set(rows.flatMap((row) => (row.project_id === null ? [] : [row.project_id])))];
    const [rules, projects] = await Promise.all([
      db.from("alert_rules").select("id, threshold_percent").eq("workspace_id", workspaceId).in("id", ruleIds),
      projectIds.length === 0
        ? Promise.resolve({ data: [], error: null })
        : db.from("projects").select("id, name").eq("workspace_id", workspaceId).in("id", projectIds),
    ]);
    if (rules.error) throw failure("rules read", rules.error);
    if (projects.error) throw failure("projects read", projects.error);
    const thresholds = new Map(rules.data.map((rule) => [rule.id, rule.threshold_percent]));
    const projectNames = new Map(projects.data.map((project) => [project.id, project.name]));
    return rows.map((row) => ({
      id: row.id,
      ruleId: row.rule_id,
      title: row.title ?? "Alert",
      message: row.message,
      severity: severityFor(thresholds.get(row.rule_id) ?? null),
      thresholdLabel: row.threshold_label,
      isEstimated: row.is_estimated,
      providerName: row.provider === null ? null : PROVIDER_NAMES[row.provider],
      projectName: row.project_id === null ? null : (projectNames.get(row.project_id) ?? null),
      resetsAt: row.resets_at,
      triggeredAt: row.triggered_at,
    }));
  }

  async function countLike(workspaceId: string, patterns: readonly string[], start: string, end: string): Promise<number> {
    const { count, error } = await db
      .from("activity_events")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .gte("occurred_at", start)
      .lt("occurred_at", end)
      .or(patterns.map((pattern) => `type_id.like.${pattern}`).join(","));
    if (error) throw failure("highlights count", error);
    return count ?? 0;
  }

  /**
   * Daily signup counts whose day ended in [start, end): the moment the provider's timeline event
   * for that day is dated (`occurred_at` is the end of the day), so the digest counts the same days
   * the timeline shows in its period. Every snapshot is retrieved after its day ended, which lets
   * `snapshot_date` narrow the scan to the workspace's recent rows.
   */
  async function sumDailySignups(workspaceId: string, start: string, end: string): Promise<number> {
    const { data, error } = await db
      .from("usage_snapshots")
      .select("external_account_id, period_start, value, retrieved_at")
      .eq("workspace_id", workspaceId)
      .in("metric_key", DAILY_SIGNUP_METRICS)
      .gte("snapshot_date", start.slice(0, 10))
      .gte("period_end", start)
      .lt("period_end", end)
      .order("retrieved_at", { ascending: true })
      .limit(DAILY_COUNTS_LIMIT);
    if (error) throw failure("daily signups read", error);
    return sumDailyCounts(
      data.flatMap((row) =>
        row.value === null || row.period_start === null
          ? []
          : [{ accountId: row.external_account_id, periodStart: row.period_start, value: row.value, retrievedAt: row.retrieved_at }],
      ),
    );
  }

  return {
    async getWorkspace(workspaceId) {
      const { data, error } = await db.from("workspaces").select("id, slug, name").eq("id", workspaceId).maybeSingle();
      if (error) throw failure("workspace read", error);
      return data;
    },

    async listUndispatchedAlerts(workspaceId, limit) {
      const { data, error } = await db
        .from("triggered_alerts")
        .select(ALERT_COLUMNS)
        .eq("workspace_id", workspaceId)
        .is("dispatched_at", null)
        .order("triggered_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      if (error) throw failure("undispatched alerts read", error);
      return toDeliveryAlerts(workspaceId, data);
    },

    async listAlertsTriggeredBetween(workspaceId, start, end, limit) {
      const { data, error } = await db
        .from("triggered_alerts")
        .select(ALERT_COLUMNS)
        .eq("workspace_id", workspaceId)
        .gte("triggered_at", start)
        .lt("triggered_at", end)
        .order("triggered_at", { ascending: true })
        .order("id", { ascending: true })
        .limit(limit);
      if (error) throw failure("alerts in period read", error);
      return toDeliveryAlerts(workspaceId, data);
    },

    async listRecipients(workspaceId) {
      const { data, error } = await db.rpc("notification_recipients", { p_workspace_id: workspaceId });
      if (error) throw failure("notification_recipients", error);
      return data.map((row) => ({ userId: row.user_id, email: row.email, frequency: row.email_frequency }));
    },

    listDestinations(workspaceId) {
      return listDeliveryDestinations(workspaceId);
    },

    loadDestinationSecret(workspaceId, destinationId) {
      return loadDestinationSecret(workspaceId, destinationId);
    },

    async listDeliveries(workspaceId, subjectKeys) {
      if (subjectKeys.length === 0) return new Set();
      const { rows, complete } = await readAllPages(async (from, to) => {
        const { data, error } = await db
          .from("notification_deliveries")
          .select("subject_key, target_key")
          .eq("workspace_id", workspaceId)
          .in("subject_key", [...subjectKeys])
          // (workspace_id, subject_key, target_key) is unique, so the order is total and pages
          // neither skip nor repeat a row.
          .order("subject_key")
          .order("target_key")
          .range(from, to);
        if (error) throw failure("deliveries read", error);
        return data;
      }, DELIVERIES_LIMIT);
      // A key left out is a message sent again if this dispatch is a retry.
      if (!complete) log.warn("notifications.deliveries_truncated", { workspaceId, subjects: subjectKeys.length, rows: rows.length });
      return new Set(rows.map((row) => deliveryKey(row.subject_key, row.target_key)));
    },

    async recordDeliveries(records) {
      if (records.length === 0) return;
      const rows = records.map(
        (record): TablesInsert<"notification_deliveries"> => ({
          workspace_id: record.workspaceId,
          subject_key: record.subjectKey,
          target_key: record.target.key,
          triggered_alert_id: record.triggeredAlertId,
          user_id: record.target.kind === "email" ? record.target.recipient.userId : null,
          destination_id: record.target.kind === "destination" ? record.target.destination.id : null,
        }),
      );
      const { error } = await db
        .from("notification_deliveries")
        .upsert(rows, { onConflict: "workspace_id,subject_key,target_key", ignoreDuplicates: true });
      if (error) throw failure("deliveries insert", error);
    },

    async markDispatched(workspaceId, alertIds, at) {
      if (alertIds.length === 0) return;
      const { error } = await db
        .from("triggered_alerts")
        .update({ dispatched_at: at.toISOString() })
        .eq("workspace_id", workspaceId)
        .in("id", [...alertIds]);
      if (error) throw failure("mark dispatched", error);
    },

    updateDestinationHealth(workspaceId, destinationId, patch) {
      return updateDestinationHealth(workspaceId, destinationId, patch);
    },

    async insertEvents(rows) {
      if (rows.length === 0) return 0;
      const { data, error } = await db
        .from("activity_events")
        .upsert([...rows], { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true })
        .select("id");
      if (error) throw failure("event insert", error);
      return data.length;
    },

    async loadDashboardInput(workspaceId, now) {
      const [connections, accounts, projects, snapshots] = await Promise.all([
        db
          .from("connections")
          .select("id, provider, display_name, status, last_synced_at, last_sync_requested_at, poll_interval_seconds, granted_scopes")
          .eq("workspace_id", workspaceId)
          .neq("status", "revoked")
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .limit(CONNECTIONS_LIMIT),
        db
          .from("external_accounts")
          .select("id, connection_id, display_name, project_id")
          .eq("workspace_id", workspaceId)
          .eq("included", true)
          .order("id")
          .limit(ACCOUNTS_LIMIT),
        db.from("projects").select("id, name").eq("workspace_id", workspaceId).order("id").limit(PROJECTS_LIMIT),
        loadSnapshots(db, workspaceId, snapshotWindowStart(now)),
      ]);
      if (connections.error) throw failure("connections read", connections.error);
      if (accounts.error) throw failure("accounts read", accounts.error);
      if (projects.error) throw failure("projects read", projects.error);
      return {
        connections: connections.data,
        accounts: accounts.data,
        projects: projects.data,
        snapshots,
        projectedSpend: declaredProjectedSpend,
        now,
      };
    },

    async countHighlights(workspaceId, start, end) {
      const [deploys, signups, dailySignups, stars, payments] = await Promise.all([
        countLike(workspaceId, HIGHLIGHT_PATTERNS.deploys, start, end),
        countLike(workspaceId, HIGHLIGHT_PATTERNS.signups, start, end),
        sumDailySignups(workspaceId, start, end),
        countLike(workspaceId, HIGHLIGHT_PATTERNS.stars, start, end),
        countLike(workspaceId, HIGHLIGHT_PATTERNS.payments, start, end),
      ]);
      return { deploys, signups: signups + dailySignups, stars, payments };
    },
  };
}
