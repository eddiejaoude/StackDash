/*
 * Makes one simulated incident happen now (#256), so a presenter can show an alert firing on cue
 * instead of waiting for the simulation to produce one.
 *
 *   npm run demo:event -- --type failed-deployment
 *   npm run demo:event -- --type budget-crossing [--workspace <slug>]
 *
 * `failed-deployment` adds a failed production deployment to the simulated Vercel connection.
 * `budget-crossing` raises its month-to-date spend past every budget alert that covers Vercel, so
 * those alerts trigger; when every one of them already triggered this billing period it says so
 * and writes nothing. The next sync reads the usual spend again; the alert and its timeline event
 * stay. Either way the connection syncs once through the real sync and alert path, so an open
 * timeline shows the event without a reload, and the next tick (`npm run jobs:tick`, or the one
 * `--watch` runs) emails and posts the alert.
 *
 * Writes to the demo workspace that `npm run demo:seed` built, or to the workspace `--workspace`
 * names; nothing else. Refuses to run unless STACKDASH_SIMULATE_PROVIDERS=1 and
 * NEXT_PUBLIC_SUPABASE_URL points at this computer, like the demo seed. Reads `.env.local` when
 * present.
 */
import { existsSync } from "node:fs";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isProviderSimulationEnabled } from "@/lib/adapters/simulated";
import { SIMULATED_VERCEL_CURRENCY } from "@/lib/adapters/simulated/vercel";
import { evaluateWorkspaceAlerts } from "@/lib/alerts/run";
import { connectOrigin } from "@/lib/connections/oauth-state";
import {
  budgetCrossingTarget,
  demoIncident,
  findDemoEventTarget,
  findWorkspaceBySlug,
  loadBudgetAlerts,
  parseDemoEventArgs,
  runDemoEvent,
  triggeredRuleIds,
  vercelCycleKey,
  type DemoEventPlan,
  type DemoEventTarget,
} from "@/lib/demo/event";
import { demoCommandRefusal } from "@/lib/demo/history";
import { findDemoWorkspace } from "@/lib/demo/workspace";
import { formatMoney } from "@/lib/format";
import { createJobDeps } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";
import { workspacePath } from "@/lib/workspaces/paths";

const DEFAULT_ORIGIN = "http://localhost:3000";
const SEND_HINT = "The next tick emails and posts it: keep `npm run jobs:tick -- --watch` running, or run `npm run jobs:tick` now.";

/** Why the command stops before writing anything, and its exit code: 2 for a refusal, 0 when there is nothing to do. */
type Stop = Readonly<{ stop: string; code: 0 | 2 }>;

async function plan(
  admin: SupabaseClient<Database>,
  input: Readonly<{ target: DemoEventTarget; type: DemoEventPlan["type"]; demoWorkspace: boolean }>,
): Promise<DemoEventPlan | Stop> {
  const { target, type } = input;
  if (type === "failed-deployment") return { type };
  const { rules, budgets } = await loadBudgetAlerts(admin, target.workspace.id);
  const crossing = budgetCrossingTarget(rules, budgets, target);
  if (crossing === null) {
    // The seed deletes and rebuilds the demo workspace, and never touches a --workspace target.
    const rebuild = input.demoWorkspace ? " Or rebuild the demo workspace with npm run demo:seed, which replaces it and its history and adds one." : "";
    return {
      stop: `No budget alert in ${target.workspace.name} covers Vercel spend in ${SIMULATED_VERCEL_CURRENCY}. Add a budget and an alert on it in alert settings.${rebuild}`,
      code: 2,
    };
  }
  const cycleKey = vercelCycleKey(new Date());
  const triggered = await triggeredRuleIds(admin, target.workspace.id, crossing.ruleIds, cycleKey);
  if (crossing.ruleIds.every((ruleId) => triggered.has(ruleId))) {
    return {
      stop: `Nothing written: every budget alert covering Vercel in ${target.workspace.name} already triggered for the billing period starting ${cycleKey}. They trigger again when the next one starts.`,
      code: 0,
    };
  }
  return { type, crossing };
}

/** What happened, in one sentence, with the page that shows it. */
function summary(chosen: DemoEventPlan, workspaceName: string, timeline: string): string {
  if (chosen.type === "failed-deployment") {
    return `A failed production deployment of web is on the timeline of ${workspaceName}: ${timeline}`;
  }
  const { crossing } = chosen;
  return (
    `Simulated Vercel spend in ${workspaceName} rose to at least ${formatMoney(crossing.totalMinor, SIMULATED_VERCEL_CURRENCY)} this month, ` +
    `${crossing.thresholdPercent} percent of the ${crossing.budgetName} budget of ${formatMoney(crossing.budgetMinor, SIMULATED_VERCEL_CURRENCY)}.`
  );
}

async function main(): Promise<number> {
  const args = parseDemoEventArgs(process.argv.slice(2));
  if (args.kind === "invalid") {
    console.error(args.message);
    return 2;
  }

  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const refusal = demoCommandRefusal({
    simulationEnabled: isProviderSimulationEnabled(),
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
  });
  if (refusal !== null) {
    console.error(`Demo event refused. ${refusal}`);
    return 2;
  }

  const admin = createAdminClient();
  const workspace = args.workspaceSlug === null ? await findDemoWorkspace(admin) : await findWorkspaceBySlug(admin, args.workspaceSlug);
  if (workspace === null) {
    console.error(
      args.workspaceSlug === null
        ? "There is no demo workspace yet. Build it with npm run demo:seed, or name another workspace with --workspace <slug>."
        : `There is no workspace with the slug ${JSON.stringify(args.workspaceSlug)} on this stack.`,
    );
    return 2;
  }
  const lookup = await findDemoEventTarget(admin, workspace);
  if (lookup.kind === "missing") {
    console.error(lookup.message);
    return 2;
  }
  const chosen = await plan(admin, { target: lookup.target, type: args.type, demoWorkspace: args.workspaceSlug === null });
  if ("stop" in chosen) {
    (chosen.code === 0 ? console.log : console.error)(chosen.stop);
    return chosen.code;
  }

  const outcome = await runDemoEvent({
    deps: { ...createJobDeps(), evaluateAlerts: evaluateWorkspaceAlerts },
    target: lookup.target,
    incident: demoIncident(chosen),
  });
  const timeline = `${connectOrigin(DEFAULT_ORIGIN, process.env.NEXT_PUBLIC_SITE_URL)}${workspacePath(workspace.slug, "timeline")}`;
  switch (outcome.status) {
    case "sync_failed": {
      const reference = outcome.errorReference === null ? "" : ` Reference ${outcome.errorReference}.`;
      console.error(`The Vercel sync failed (${outcome.errorCode}), so nothing was added. Its connection page says what to do next.${reference}`);
      return 1;
    }
    case "not_synced":
      console.error(`The simulated Vercel connection in ${workspace.name} stopped syncing before the event ran. Open its connection page, then run the command again.`);
      return 1;
    case "alerts_not_checked":
      console.log(summary(chosen, workspace.name, timeline));
      console.error(`The alert check failed, so no alert was recorded. Reference ${outcome.errorReference}.`);
      return 1;
    case "written":
      console.log(summary(chosen, workspace.name, timeline));
      if (outcome.triggered > 0) {
        console.log(`${outcome.triggered === 1 ? "1 alert" : `${outcome.triggered} alerts`} triggered, on the timeline: ${timeline}`);
        console.log(SEND_HINT);
      } else if (chosen.type === "budget-crossing") {
        // Zero new rows is all the evaluator reports: a watcher's sync or a rule edited since the
        // check above also ends here, so this says what is known rather than why.
        console.log("No new alert was recorded. The alerts page shows whether the budget alert already triggered this billing period.");
      }
      return 0;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Errors raised on this path carry Postgres codes and messages, never secrets.
    console.error(error instanceof Error && error.message.length > 0 ? `Demo event failed: ${error.message}` : "Demo event failed.");
    process.exitCode = 1;
  },
);
