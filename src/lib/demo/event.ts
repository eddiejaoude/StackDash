import "server-only";

import { parseArgs } from "node:util";

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSimulatedAdapter } from "@/lib/adapters/simulated";
import { SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";
import { utcMonthStart, type SimulatedIncident } from "@/lib/adapters/simulated/simulation";
import { SIMULATED_VERCEL_CURRENCY, vercelFailedDeployment, vercelProfile, vercelSpendSurge } from "@/lib/adapters/simulated/vercel";
import { inScope } from "@/lib/alerts/evaluate";
import { runSyncJob, SYNCABLE_CONNECTION_STATUSES, type SyncDeps } from "@/lib/jobs/sync-connection";
import type { Database } from "@/lib/supabase/database.types";

import { oneShotJob } from "./history";

/*
 * One simulated incident on cue (#256), for a presenter who wants an alert to fire during a demo
 * instead of waiting for the simulation to produce one. The incident is built into the simulated
 * Vercel adapter (`SimulatedIncident`) and the workspace's simulated Vercel connection syncs once
 * through `runSyncJob`, as on a tick: the real validation, ingest, and alert evaluation, so the
 * event reaches an open timeline through Realtime and an alert it triggers is sent by the next
 * tick like any other. Written with the service role on the local stack only (the caller checks
 * `demoCommandRefusal` first), and only into the one workspace it targets.
 */

type Admin = SupabaseClient<Database>;
type Tables = Database["public"]["Tables"];

export const DEMO_EVENT_TYPES = ["failed-deployment", "budget-crossing"] as const;
export type DemoEventType = (typeof DEMO_EVENT_TYPES)[number];

export const DEMO_EVENT_USAGE = `Usage: npm run demo:event -- --type ${DEMO_EVENT_TYPES.join("|")} [--workspace <slug>]`;

// Bounds for the small lists read here. A demo workspace has a handful of each.
const ACCOUNTS_LIMIT = 100;
const RULES_LIMIT = 500;
const BUDGETS_LIMIT = 500;

export type DemoEventArgs =
  | Readonly<{ kind: "run"; type: DemoEventType; workspaceSlug: string | null }>
  | Readonly<{ kind: "invalid"; message: string }>;

/** `--type <kind>`, required, and `--workspace <slug>`, which defaults to the demo workspace. */
export function parseDemoEventArgs(argv: readonly string[]): DemoEventArgs {
  let values: { type?: string | undefined; workspace?: string | undefined };
  try {
    ({ values } = parseArgs({ args: [...argv], options: { type: { type: "string" }, workspace: { type: "string" } } }));
  } catch (error) {
    // parseArgs only throws for arguments it cannot read (an unknown option, a missing value).
    return { kind: "invalid", message: `${error instanceof Error ? error.message : "The arguments could not be read."} ${DEMO_EVENT_USAGE}` };
  }
  const type = DEMO_EVENT_TYPES.find((candidate) => candidate === values.type);
  if (type === undefined) {
    const given = values.type === undefined ? "Give --type." : `There is no event type ${JSON.stringify(values.type)}.`;
    return { kind: "invalid", message: `${given} ${DEMO_EVENT_USAGE}` };
  }
  const workspaceSlug = values.workspace?.trim();
  if (workspaceSlug === "") {
    return { kind: "invalid", message: `Give --workspace a workspace slug, or leave it out for the demo workspace. ${DEMO_EVENT_USAGE}` };
  }
  return { kind: "run", type, workspaceSlug: workspaceSlug ?? null };
}

export type DemoEventWorkspace = Readonly<{ id: string; slug: string; name: string }>;

/** The workspace with this slug, or null when there is none. */
export async function findWorkspaceBySlug(admin: Admin, slug: string): Promise<DemoEventWorkspace | null> {
  const { data, error } = await admin.from("workspaces").select("id, slug, name").eq("slug", slug).maybeSingle();
  if (error) throw new Error(`Reading the workspace failed (code ${error.code}).`);
  return data;
}

export type DemoEventTarget = Readonly<{
  workspace: DemoEventWorkspace;
  connectionId: string;
  /** The project of each account the connection syncs, null for none: what a budget's scope is matched against. */
  projectIds: readonly (string | null)[];
}>;

export type TargetLookup = Readonly<{ kind: "found"; target: DemoEventTarget }> | Readonly<{ kind: "missing"; message: string }>;

/**
 * The workspace's simulated Vercel connection that a sync would run for (active, or failed and
 * retrying), with at least one included account. Never a real connection, so the incident is
 * labeled simulated like the rest of the made-up data.
 */
export async function findDemoEventTarget(admin: Admin, workspace: DemoEventWorkspace): Promise<TargetLookup> {
  const { data: connection, error } = await admin
    .from("connections")
    .select("id")
    .eq("workspace_id", workspace.id)
    .eq("provider", "vercel")
    .contains("granted_scopes", [SIMULATED_SCOPE])
    .in("status", [...SYNCABLE_CONNECTION_STATUSES])
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Reading the Vercel connection failed (code ${error.code}).`);
  if (connection === null) {
    return {
      kind: "missing",
      message: `${workspace.name} has no simulated Vercel connection that syncs. Connect Vercel there with provider simulation on (README step 10), or reconnect it if it needs attention.`,
    };
  }
  const { data: accounts, error: accountsError } = await admin
    .from("external_accounts")
    .select("project_id")
    .eq("workspace_id", workspace.id)
    .eq("connection_id", connection.id)
    .eq("included", true)
    .limit(ACCOUNTS_LIMIT);
  if (accountsError) throw new Error(`Reading the Vercel accounts failed (code ${accountsError.code}).`);
  if (accounts.length === 0) {
    return { kind: "missing", message: `The simulated Vercel connection in ${workspace.name} syncs no account. Include its team on the connection page.` };
  }
  return { kind: "found", target: { workspace, connectionId: connection.id, projectIds: accounts.map((account) => account.project_id) } };
}

export type BudgetRule = Pick<Tables["alert_rules"]["Row"], "id" | "scope" | "provider" | "project_id" | "connection_id" | "budget_id" | "threshold_percent">;
export type BudgetRow = Pick<Tables["budgets"]["Row"], "id" | "name" | "scope" | "provider" | "project_id" | "connection_id" | "amount_minor" | "currency">;

export type BudgetCrossing = Readonly<{
  /** The month-to-date Vercel spend that crosses it, in minor units of SIMULATED_VERCEL_CURRENCY. */
  totalMinor: number;
  budgetName: string;
  budgetMinor: number;
  thresholdPercent: number;
  /** Every budget alert the surge crosses: what `triggeredRuleIds` checks before the sync. */
  ruleIds: readonly string[];
}>;

/**
 * The Vercel spend that crosses every budget alert (`budget_percent` rules, not paused) whose rule
 * and budget both cover one of the connection's accounts in Vercel's currency: the highest of
 * their thresholds, as an amount of each budget, rounded up to the cent as the evaluator compares
 * (spend * 100 >= threshold * budget). Spend of other providers in a wider budget only adds to it.
 * Null when no budget alert covers Vercel.
 */
export function budgetCrossingTarget(rules: readonly BudgetRule[], budgets: readonly BudgetRow[], target: DemoEventTarget): BudgetCrossing | null {
  const budgetsById = new Map(budgets.map((budget) => [budget.id, budget]));
  const items = target.projectIds.map((projectId) => ({ provider: "vercel" as const, projectId, connectionId: target.connectionId }));
  let highest: Omit<BudgetCrossing, "ruleIds"> | null = null;
  const ruleIds: string[] = [];
  for (const rule of rules) {
    const budget = rule.budget_id === null ? undefined : budgetsById.get(rule.budget_id);
    const threshold = rule.threshold_percent;
    if (threshold === null || budget === undefined || budget.currency !== SIMULATED_VERCEL_CURRENCY || !(budget.amount_minor > 0)) continue;
    if (!items.some((item) => inScope(budget, item) && inScope(rule, item))) continue;
    ruleIds.push(rule.id);
    const totalMinor = Math.ceil((threshold * budget.amount_minor) / 100);
    if (highest === null || totalMinor > highest.totalMinor) {
      highest = { totalMinor, budgetName: budget.name, budgetMinor: budget.amount_minor, thresholdPercent: threshold };
    }
  }
  return highest === null ? null : { ...highest, ruleIds };
}

/**
 * The billing cycle a simulated Vercel reading belongs to, as `triggered_alerts.cycle_key` names
 * it: the start date of the UTC month, which is the period start the evaluator keys a budget alert by.
 */
export function vercelCycleKey(now: Date): string {
  return utcMonthStart(now).toISOString().slice(0, 10);
}

/** Which of these budget alerts already triggered in the cycle, so a crossing would send nothing new. */
export async function triggeredRuleIds(admin: Admin, workspaceId: string, ruleIds: readonly string[], cycleKey: string): Promise<Set<string>> {
  const { data, error } = await admin
    .from("triggered_alerts")
    .select("rule_id")
    .eq("workspace_id", workspaceId)
    .eq("cycle_key", cycleKey)
    .in("rule_id", [...ruleIds])
    .limit(RULES_LIMIT);
  if (error) throw new Error(`Reading the triggered alerts failed (code ${error.code}).`);
  return new Set(data.map((row) => row.rule_id));
}

/** The workspace's budget alerts and budgets, read for `budgetCrossingTarget`. */
export async function loadBudgetAlerts(admin: Admin, workspaceId: string): Promise<{ rules: BudgetRule[]; budgets: BudgetRow[] }> {
  const [rules, budgets] = await Promise.all([
    admin
      .from("alert_rules")
      .select("id, scope, provider, project_id, connection_id, budget_id, threshold_percent")
      .eq("workspace_id", workspaceId)
      .eq("kind", "budget_percent")
      .eq("paused", false)
      .order("id")
      .limit(RULES_LIMIT),
    admin
      .from("budgets")
      .select("id, name, scope, provider, project_id, connection_id, amount_minor, currency")
      .eq("workspace_id", workspaceId)
      .order("id")
      .limit(BUDGETS_LIMIT),
  ]);
  if (rules.error) throw new Error(`Reading the budget alerts failed (code ${rules.error.code}).`);
  if (budgets.error) throw new Error(`Reading the budgets failed (code ${budgets.error.code}).`);
  return { rules: rules.data, budgets: budgets.data };
}

export type DemoEventPlan = Readonly<{ type: "failed-deployment" }> | Readonly<{ type: "budget-crossing"; crossing: BudgetCrossing }>;

/** What the sync carries: a failed production deployment, or Vercel spend surging past the budget. */
export function demoIncident(plan: DemoEventPlan): SimulatedIncident {
  switch (plan.type) {
    case "failed-deployment":
      return { events: (accountId, at) => [vercelFailedDeployment(accountId, at)] };
    case "budget-crossing":
      return { events: () => [], metrics: (accountId, at) => vercelSpendSurge(accountId, at, plan.crossing.totalMinor) };
  }
}

/** The live job wiring, with an evaluator that says how many alerts it recorded. */
export type DemoEventDeps = Omit<SyncDeps, "evaluateAlerts"> &
  Readonly<{ evaluateAlerts: (workspaceId: string, now: Date) => Promise<Readonly<{ triggered: number }>> }>;

export type DemoEventOutcome =
  | Readonly<{ status: "written"; triggered: number }>
  /** The sync stored the incident, but the alert check failed, so no alert was recorded. */
  | Readonly<{ status: "alerts_not_checked"; errorReference: string }>
  /** The connection stopped syncing (disconnected or needing attention) after it was looked up. */
  | Readonly<{ status: "not_synced" }>
  | Readonly<{ status: "sync_failed"; errorCode: string; errorReference: string | null }>;

/** Syncs the target's connection once with the incident, as a tick would, and says what came of it. */
export async function runDemoEvent(
  input: Readonly<{ deps: DemoEventDeps; target: DemoEventTarget; incident: SimulatedIncident }>,
): Promise<DemoEventOutcome> {
  const { deps, target } = input;
  const adapter = createSimulatedAdapter(vercelProfile, "vercel", { incident: input.incident });
  // A holder, not a `let`: it is set inside the callback, which control flow analysis cannot see.
  const alerts: { result: Readonly<{ triggered: number }> | Readonly<{ errorReference: string }> | null } = { result: null };
  const job = oneShotJob({ kind: "sync", workspace_id: target.workspace.id, connection_id: target.connectionId, dedupe_key: null }, deps.now());
  const outcome = await runSyncJob(job, {
    ...deps,
    getAdapter: (id) => (id === adapter.id ? adapter : deps.getAdapter(id)),
    evaluateAlerts: async (workspaceId, now) => {
      try {
        alerts.result = await deps.evaluateAlerts(workspaceId, now);
      } catch (error) {
        // Reported with its reference rather than only logged by the sync, so the presenter learns
        // that no alert was checked.
        alerts.result = { errorReference: deps.logError("demo_event.alert_evaluation_failed", error, { workspaceId, jobId: job.id }) };
      }
    },
  });
  if (outcome.status !== "succeeded") {
    return { status: "sync_failed", errorCode: outcome.errorCode, errorReference: outcome.errorReference };
  }
  if (alerts.result === null) return { status: "not_synced" };
  if ("errorReference" in alerts.result) return { status: "alerts_not_checked", errorReference: alerts.result.errorReference };
  return { status: "written", triggered: alerts.result.triggered };
}
