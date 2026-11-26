import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { availableProviders, declaredProjectedSpend } from "@/lib/adapters/registry";
import type { SnapshotInput } from "@/lib/dashboard/aggregate";
import { log } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { readAllPages } from "@/lib/supabase/paging";

import {
  ALERT_TRIGGERED_TYPE_ID,
  alertDedupeKey,
  evaluateAlerts,
  joinAlertSnapshots,
  type ProviderId,
} from "./evaluate";

/*
 * Records the thresholds crossed in one workspace (#65). Called by the sync runner after a
 * successful sync; it runs as the service role, so every query is scoped to the workspace by hand.
 *
 * Idempotent by construction, so a retried or repeated run never duplicates anything:
 * - The timeline event is inserted first, on conflict (workspace_id, dedupe_key) do nothing, with
 *   the dedupe key `alert:<rule_id>:<cycle_key>`.
 * - The alert is inserted second, on conflict (rule_id, cycle_key) do nothing.
 * Both keys name the same (rule, cycle), so a crash between the two writes is repaired by the next
 * run (the event is skipped, the alert is written) and neither ever appears twice.
 */

type Tables = Database["public"]["Tables"];

/** Snapshots older than this cannot belong to a current billing cycle; retention keeps 13 months. */
const SNAPSHOT_WINDOW_DAYS = 45;

// Snapshots are read in pages of PostgREST's row cap (readAllPages), up to a hard cap.
const SNAPSHOT_MAX_ROWS = 10_000;

// Bounds for the small lists. A workspace in the MVP has a handful of each.
const RULES_LIMIT = 500;
const BUDGETS_LIMIT = 500;
const CONNECTIONS_LIMIT = 100;
const ACCOUNTS_LIMIT = 1000;
const PROJECTS_LIMIT = 500;

const RULE_COLUMNS =
  "id, kind, scope, provider, project_id, connection_id, metric_key, budget_id, threshold_percent, threshold_amount_minor, currency, paused";
const BUDGET_COLUMNS = "id, name, scope, provider, project_id, connection_id, amount_minor, currency";
const SNAPSHOT_COLUMNS =
  "connection_id, external_account_id, metric_key, kind, label, snapshot_date, value, unit, amount_minor, currency, period_start, period_end, point_at, resets_at, retrieved_at, provenance_source, pricing_source";

/** The workspace's snapshots dated `sinceDate` or later, newest first, as the service role. */
export async function loadSnapshots(
  db: SupabaseClient<Database>,
  workspaceId: string,
  sinceDate: string,
): Promise<SnapshotInput[]> {
  const { rows, complete } = await readAllPages(async (from, to) => {
    const { data, error } = await db
      .from("usage_snapshots")
      .select(SNAPSHOT_COLUMNS)
      .eq("workspace_id", workspaceId)
      .gte("snapshot_date", sinceDate)
      .order("snapshot_date", { ascending: false })
      .order("id", { ascending: true })
      .range(from, to);
    if (error) throw new Error("Failed to load usage snapshots for alerts", { cause: error });
    return data;
  }, SNAPSHOT_MAX_ROWS);
  // Newest first, so what was left out is the oldest history; current values are still evaluated.
  if (!complete) log.warn("alerts.snapshots_truncated", { workspaceId, rows: rows.length });
  return rows;
}

/**
 * Evaluates the workspace's active rules against its current metrics and records each threshold
 * crossed for the first time this billing cycle: one `triggered_alerts` row and one
 * `stackdash.alert_triggered` timeline event. Returns how many alerts were newly recorded.
 */
export async function evaluateWorkspaceAlerts(workspaceId: string, now: Date): Promise<{ triggered: number }> {
  const db = createAdminClient();

  // Rules first: most syncs run in workspaces with no rules, and then nothing else is read.
  const rules = await db
    .from("alert_rules")
    .select(RULE_COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("paused", false)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(RULES_LIMIT);
  if (rules.error) throw new Error("Failed to load alert rules", { cause: rules.error });
  if (rules.data.length === 0) return { triggered: 0 };

  const sinceDate = new Date(now.getTime() - SNAPSHOT_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const [budgets, connections, accounts, projects, snapshots] = await Promise.all([
    db.from("budgets").select(BUDGET_COLUMNS).eq("workspace_id", workspaceId).order("id").limit(BUDGETS_LIMIT),
    db
      .from("connections")
      .select("id, provider, display_name")
      .eq("workspace_id", workspaceId)
      .order("id")
      .limit(CONNECTIONS_LIMIT),
    db
      .from("external_accounts")
      .select("id, connection_id, project_id")
      .eq("workspace_id", workspaceId)
      .eq("included", true)
      .order("id")
      .limit(ACCOUNTS_LIMIT),
    db.from("projects").select("id, name").eq("workspace_id", workspaceId).order("id").limit(PROJECTS_LIMIT),
    loadSnapshots(db, workspaceId, sinceDate),
  ]);
  if (budgets.error) throw new Error("Failed to load budgets", { cause: budgets.error });
  if (connections.error) throw new Error("Failed to load connections", { cause: connections.error });
  if (accounts.error) throw new Error("Failed to load external accounts", { cause: accounts.error });
  if (projects.error) throw new Error("Failed to load projects", { cause: projects.error });

  // Excluded accounts and rows whose account moved connection are skipped, as on the dashboard.
  const joined = joinAlertSnapshots(snapshots, connections.data, accounts.data);

  const triggers = evaluateAlerts({
    rules: rules.data,
    snapshots: joined,
    budgets: budgets.data,
    names: {
      providers: new Map<ProviderId, string>(availableProviders().map((adapter) => [adapter.id, adapter.displayName])),
      projects: new Map(projects.data.map((project) => [project.id, project.name])),
      connections: new Map(connections.data.map((connection) => [connection.id, connection.display_name])),
    },
    projectedSpend: declaredProjectedSpend,
    now,
  });
  if (triggers.length === 0) return { triggered: 0 };

  const occurredAt = now.toISOString();
  const events = await db
    .from("activity_events")
    .upsert(
      triggers.map(
        (trigger): Tables["activity_events"]["Insert"] => ({
          workspace_id: workspaceId,
          connection_id: null,
          external_account_id: null,
          provider: null,
          type_id: ALERT_TRIGGERED_TYPE_ID,
          severity: trigger.severity,
          title: trigger.title,
          body: trigger.message,
          occurred_at: occurredAt,
          dedupe_key: alertDedupeKey(trigger.ruleId, trigger.cycleKey),
        }),
      ),
      { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true },
    );
  if (events.error) throw new Error("Failed to record alert events", { cause: events.error });

  // With ignoreDuplicates the returned rows are only the ones inserted now.
  const inserted = await db
    .from("triggered_alerts")
    .upsert(
      triggers.map(
        (trigger): Tables["triggered_alerts"]["Insert"] => ({
          workspace_id: workspaceId,
          rule_id: trigger.ruleId,
          cycle_key: trigger.cycleKey,
          triggered_at: occurredAt,
          observed_value: trigger.observed.value,
          observed_amount_minor: trigger.observed.amountMinor,
          currency: trigger.observed.currency,
          threshold_label: trigger.thresholdLabel,
          is_estimated: trigger.isEstimated,
          message: trigger.message,
          title: trigger.title,
          subject: trigger.subject,
          provider: trigger.provider,
          project_id: trigger.projectId,
          resets_at: trigger.resetsAt,
          // dispatched_at stays null: the next tick's alert dispatch sends it (src/lib/notifications).
        }),
      ),
      { onConflict: "rule_id,cycle_key", ignoreDuplicates: true },
    )
    .select("id");
  if (inserted.error) throw new Error("Failed to record triggered alerts", { cause: inserted.error });

  if (inserted.data.length > 0) {
    log.info("alerts.triggered", { workspaceId, triggered: inserted.data.length });
  }
  return { triggered: inserted.data.length };
}
