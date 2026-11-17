import { describe, expect, it } from "vitest";

import { simulatedAdapters } from "@/lib/adapters/simulated";
import { SIMULATED_SCOPE, simulatedCredentialMetadata } from "@/lib/adapters/simulated/marker";
import { Secret, type OAuthClient, type OAuthCredential } from "@/lib/adapters/types";
import { TOTAL_METRIC_KEY } from "@/lib/adapters/vercel";
import { evaluateAlerts, joinAlertSnapshots, type AlertRuleInput, type BudgetInput } from "@/lib/alerts/evaluate";
import type { SnapshotInput } from "@/lib/dashboard/aggregate";
import { utcDate } from "@/lib/jobs/ingest";
import { MemoryJobStore, type MemoryConnection, type MemorySnapshot } from "@/lib/jobs/memory-store";
import { runSyncJob } from "@/lib/jobs/sync-connection";
import type { Logger } from "@/lib/log/logger";
import { memoryNotificationDeps } from "@/lib/notifications/memory-store";

import {
  budgetCrossingTarget,
  DEMO_EVENT_USAGE,
  demoIncident,
  parseDemoEventArgs,
  runDemoEvent,
  vercelCycleKey,
  type BudgetRow,
  type DemoEventDeps,
  type DemoEventTarget,
} from "./event";
import { demoAccountSeed, oneShotJob } from "./history";

const WORKSPACE_ID = "25625625-6256-4256-8256-256256256256";
const BUDGET_ID = "b0d6e700-0000-4000-8000-000000000256";
const PROJECT_ID = "9a0e0000-0000-4000-8000-000000000256";
const OTHER_PROJECT_ID = "9a0e0000-0000-4000-8000-000000000999";
// Early in the month, so the usual Vercel spend is well below the $540 the budget alert waits for.
const NOW = new Date("2026-11-10T14:00:03.000Z");
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const client: OAuthClient = { clientId: "simulated", clientSecret: new Secret("simulated"), extra: {} };
const FAILED_TYPE_ID = "vercel.deployment.failed";

describe("parseDemoEventArgs", () => {
  it.each([
    [["--type", "failed-deployment"], { kind: "run", type: "failed-deployment", workspaceSlug: null }],
    [["--type", "budget-crossing"], { kind: "run", type: "budget-crossing", workspaceSlug: null }],
    [["--type=budget-crossing", "--workspace", " demo-1a2b "], { kind: "run", type: "budget-crossing", workspaceSlug: "demo-1a2b" }],
  ])("reads %j", (argv, expected) => {
    expect(parseDemoEventArgs(argv)).toEqual(expected);
  });

  it.each([
    ["no arguments", [], /^Give --type\./],
    ["an unknown type", ["--type", "outage"], /^There is no event type "outage"\./],
    ["a type in another case", ["--type", "Failed-Deployment"], /no event type/],
    ["--type without a value", ["--type"], /--type/],
    ["an empty workspace", ["--type", "failed-deployment", "--workspace", ""], /^Give --workspace a workspace slug/],
    ["a whitespace workspace", ["--type", "failed-deployment", "--workspace", "   "], /^Give --workspace a workspace slug/],
    ["an unknown option", ["--type", "failed-deployment", "--force"], /--force/],
    ["a positional argument", ["failed-deployment"], /positional/],
  ])("refuses %s and shows the usage", (_title, argv, message) => {
    const args = parseDemoEventArgs(argv);
    expect(args.kind).toBe("invalid");
    if (args.kind !== "invalid") return;
    expect(args.message).toMatch(message);
    expect(args.message.endsWith(DEMO_EVENT_USAGE)).toBe(true);
  });
});

function rule(fields: Partial<AlertRuleInput> = {}): AlertRuleInput {
  return {
    id: crypto.randomUUID(),
    kind: "budget_percent",
    scope: "provider",
    provider: "vercel",
    project_id: null,
    connection_id: null,
    metric_key: null,
    budget_id: BUDGET_ID,
    threshold_percent: 90,
    threshold_amount_minor: null,
    currency: null,
    paused: false,
    ...fields,
  };
}

function budget(fields: Partial<BudgetRow> = {}): BudgetInput {
  return {
    id: BUDGET_ID,
    name: "Vercel monthly",
    scope: "provider",
    provider: "vercel",
    project_id: null,
    connection_id: null,
    amount_minor: 60_000,
    currency: "USD",
    ...fields,
  };
}

describe("budgetCrossingTarget", () => {
  const connectionId = "c0000000-0000-4000-8000-000000000256";
  const target: DemoEventTarget = { workspace: { id: WORKSPACE_ID, slug: "demo", name: "Demo workspace" }, connectionId, projectIds: [PROJECT_ID] };

  it("is the threshold's share of the budget that covers Vercel", () => {
    const only = rule();
    expect(budgetCrossingTarget([only], [budget()], target)).toEqual({
      totalMinor: 54_000,
      budgetName: "Vercel monthly",
      budgetMinor: 60_000,
      thresholdPercent: 90,
      ruleIds: [only.id],
    });
  });

  it("rounds a share that is not a whole cent up, as the evaluator compares", () => {
    expect(budgetCrossingTarget([rule({ threshold_percent: 87.5 })], [budget({ amount_minor: 333 })], target)?.totalMinor).toBe(292);
  });

  it("takes the highest of several, so every budget alert on Vercel crosses, and lists only the ones that cover it", () => {
    const capId = "b0d6e700-0000-4000-8000-000000000999";
    const monthly = rule({ threshold_percent: 90 });
    const cap = rule({ threshold_percent: 100, budget_id: capId });
    const elsewhere = rule({ scope: "project", provider: null, project_id: OTHER_PROJECT_ID });
    const crossing = budgetCrossingTarget(
      [monthly, cap, elsewhere],
      [budget(), budget({ id: capId, name: "Vercel cap", amount_minor: 80_000, scope: "workspace", provider: null })],
      target,
    );
    expect(crossing).toMatchObject({ totalMinor: 80_000, budgetName: "Vercel cap", ruleIds: [monthly.id, cap.id] });
  });

  it.each([
    ["the account's project", { scope: "project", provider: null, project_id: PROJECT_ID }],
    ["this connection", { scope: "connection", provider: null, connection_id: connectionId }],
    ["the whole workspace", { scope: "workspace", provider: null }],
  ] as const)("counts a budget on %s", (_title, scope) => {
    expect(budgetCrossingTarget([rule()], [budget(scope)], target)?.totalMinor).toBe(54_000);
  });

  it.each([
    ["no rule", [], [budget()]],
    ["a rule whose budget is gone", [rule()], []],
    ["a rule with no budget", [rule({ budget_id: null })], [budget()]],
    ["a rule with no threshold", [rule({ threshold_percent: null })], [budget()]],
    ["a budget of zero", [rule()], [budget({ amount_minor: 0 })]],
    ["a budget in another currency", [rule()], [budget({ currency: "GBP" })]],
    ["a budget on another provider", [rule()], [budget({ provider: "stripe" })]],
    ["a budget on another project", [rule()], [budget({ scope: "project", provider: null, project_id: OTHER_PROJECT_ID })]],
    ["a budget on another connection", [rule()], [budget({ scope: "connection", provider: null, connection_id: OTHER_PROJECT_ID })]],
    ["a rule narrowed to another project", [rule({ scope: "project", provider: null, project_id: OTHER_PROJECT_ID })], [budget()]],
  ])("is null for %s", (_title, rules, budgets) => {
    expect(budgetCrossingTarget(rules, budgets, target)).toBeNull();
  });

  it("is null for a project budget when the account is in no project", () => {
    const noProject: DemoEventTarget = { ...target, projectIds: [null] };
    expect(budgetCrossingTarget([rule()], [budget({ scope: "project", provider: null, project_id: PROJECT_ID })], noProject)).toBeNull();
  });
});

describe("vercelCycleKey", () => {
  it.each([
    ["mid month", "2026-11-10T14:00:03.000Z", "2026-11-01"],
    ["at the first instant of a month", "2026-11-01T00:00:00.000Z", "2026-11-01"],
    ["at the last instant of a month", "2026-10-31T23:59:59.999Z", "2026-10-01"],
    ["just after UTC midnight on New Year's Day", "2027-01-01T00:30:00.000Z", "2027-01-01"],
  ])("is the UTC month start %s", (_title, now, expected) => {
    expect(vercelCycleKey(new Date(now))).toBe(expected);
  });
});

function alertRow(row: MemorySnapshot): SnapshotInput {
  return {
    connection_id: row.connection_id,
    external_account_id: row.external_account_id,
    metric_key: row.metric_key,
    kind: row.kind,
    label: row.label,
    snapshot_date: row.snapshot_date,
    value: row.value ?? null,
    unit: row.unit ?? null,
    amount_minor: row.amount_minor ?? null,
    currency: row.currency ?? null,
    period_start: row.period_start ?? null,
    period_end: row.period_end ?? null,
    point_at: row.point_at ?? null,
    resets_at: row.resets_at ?? null,
    retrieved_at: row.retrieved_at,
    provenance_source: row.provenance_source,
    pricing_source: row.pricing_source ?? null,
  };
}

type Harness = Readonly<{
  store: MemoryJobStore;
  connection: MemoryConnection;
  target: DemoEventTarget;
  deps: DemoEventDeps;
  setNow: (at: Date) => void;
  logged: string[];
}>;

/**
 * A workspace with one simulated Vercel connection in a project, wired like a tick. Alerts are
 * evaluated by the real evaluator over the stored snapshots, and each (rule, cycle) counts once,
 * as `triggered_alerts` keeps it.
 */
async function setup(
  options: Readonly<{ status?: MemoryConnection["status"]; credential?: boolean; rules?: AlertRuleInput[]; budgets?: BudgetInput[]; alertsFail?: boolean }> = {},
): Promise<Harness> {
  let clock = NOW;
  const now = () => clock;
  const store = new MemoryJobStore(now);
  const connection = store.addConnection({
    workspace_id: WORKSPACE_ID,
    provider: "vercel",
    granted_scopes: [SIMULATED_SCOPE],
    poll_interval_seconds: 60,
    status: options.status ?? "active",
  });
  const credential: OAuthCredential = {
    accessToken: new Secret("simulated-at-test"),
    scopes: [SIMULATED_SCOPE],
    tokenType: "bearer",
    metadata: simulatedCredentialMetadata(demoAccountSeed("test", "vercel")),
  };
  if (options.credential !== false) store.credentials.set(connection.id, credential);
  const ctx = { client, fetch: () => Promise.reject(new Error("no network in tests")), now, timeoutMs: 1000, logger: silent };
  for (const account of await simulatedAdapters.vercel.listAccounts(credential, ctx)) {
    store.addAccount({ workspace_id: WORKSPACE_ID, connection_id: connection.id, external_id: account.externalId, project_id: PROJECT_ID });
  }

  const recorded = new Set<string>();
  const logged: string[] = [];
  const deps: DemoEventDeps = {
    store,
    getAdapter: (id) => {
      if (id === "fake") throw new Error("the demo never uses the fake provider");
      return simulatedAdapters[id];
    },
    loadOAuthClient: () => client,
    createOAuthContext: (oauthClient) => ({ ...ctx, client: oauthClient }),
    now,
    random: () => 0.5,
    logError: (event) => {
      logged.push(event);
      return `REF-TEST${String(logged.length).padStart(4, "0")}`;
    },
    log: silent,
    evaluateAlerts: async (_workspaceId, at) => {
      if (options.alertsFail === true) throw new Error("alert evaluation failed");
      const triggers = evaluateAlerts({
        rules: options.rules ?? [],
        snapshots: joinAlertSnapshots(store.snapshots.map(alertRow), store.connections, store.accounts),
        budgets: options.budgets ?? [],
        names: { providers: new Map([["vercel", "Vercel"]]), projects: new Map(), connections: new Map() },
        projectedSpend: [],
        now: at,
      });
      const fresh = triggers.filter((trigger) => !recorded.has(`${trigger.ruleId}:${trigger.cycleKey}`));
      for (const trigger of fresh) recorded.add(`${trigger.ruleId}:${trigger.cycleKey}`);
      return { triggered: fresh.length };
    },
    evaluateAchievements: async () => 0,
    addMissingSourceWebhooks: async () => 0,
    notifications: () => memoryNotificationDeps(),
  };
  const target: DemoEventTarget = {
    workspace: { id: WORKSPACE_ID, slug: "demo", name: "Demo workspace" },
    connectionId: connection.id,
    projectIds: [PROJECT_ID],
  };
  return {
    store,
    connection,
    target,
    deps,
    setNow: (at) => {
      clock = at;
    },
    logged,
  };
}

function failedDeployments(store: MemoryJobStore) {
  return store.events.filter((event) => event.type_id === FAILED_TYPE_ID && event.dedupe_key.includes("dpl_simevent"));
}

function vercelTotal(store: MemoryJobStore): number | null | undefined {
  return store.snapshots.find((row) => row.metric_key === TOTAL_METRIC_KEY && row.snapshot_date === utcDate(NOW))?.amount_minor;
}

describe("runDemoEvent: failed deployment", () => {
  it("writes one failed production deployment at now through the sync, beside the usual events", async () => {
    const { store, target, deps, connection } = await setup();
    const outcome = await runDemoEvent({ deps, target, incident: demoIncident({ type: "failed-deployment" }) });

    expect(outcome).toEqual({ status: "written", triggered: 0 });
    expect(failedDeployments(store)).toEqual([
      expect.objectContaining({
        workspace_id: WORKSPACE_ID,
        connection_id: connection.id,
        provider: "vercel",
        severity: "critical",
        title: "Production deployment of web failed",
        body: "Error code: BUILD_FAILED",
        occurred_at: NOW.toISOString(),
      }),
    ]);
    // The rest of the sync is the usual one: the backfill's own events, and the connection marked synced.
    expect(store.events.length).toBeGreaterThan(1);
    expect(store.connections[0]).toMatchObject({ status: "active", last_synced_at: NOW.toISOString() });
  });

  it("arrives even when a tick already synced this slot", async () => {
    const { store, target, deps } = await setup();
    const tick = oneShotJob({ kind: "sync", workspace_id: WORKSPACE_ID, connection_id: target.connectionId, dedupe_key: null }, NOW);
    expect(await runSyncJob(tick, { ...deps, evaluateAlerts: async () => {} })).toEqual({ status: "succeeded" });
    const before = store.events.length;

    await runDemoEvent({ deps, target, incident: demoIncident({ type: "failed-deployment" }) });
    expect(store.events.length).toBe(before + 1);
    expect(failedDeployments(store)).toHaveLength(1);
  });

  it("adds a new deployment on each run at a later instant, and none on a rerun at the same instant", async () => {
    const { store, target, deps, setNow } = await setup();
    const incident = demoIncident({ type: "failed-deployment" });
    await runDemoEvent({ deps, target, incident });
    await runDemoEvent({ deps, target, incident });
    expect(failedDeployments(store)).toHaveLength(1);

    setNow(new Date(NOW.getTime() + 1000));
    await runDemoEvent({ deps, target, incident });
    expect(failedDeployments(store)).toHaveLength(2);
  });
});

describe("runDemoEvent: budget crossing", () => {
  const rules = [rule()];
  const budgets = [budget()];

  it("raises Vercel spend to the threshold, and the real evaluator triggers the budget alert once", async () => {
    const harness = await setup({ rules, budgets });
    const { store, target, deps } = harness;
    // The usual sync first: spend this early in the month is below the threshold, so nothing triggers.
    const usual = oneShotJob({ kind: "sync", workspace_id: WORKSPACE_ID, connection_id: target.connectionId, dedupe_key: null }, NOW);
    await runSyncJob(usual, { ...deps, evaluateAlerts: async (workspaceId, at) => expect(await deps.evaluateAlerts(workspaceId, at)).toEqual({ triggered: 0 }) });
    expect(vercelTotal(store)).toBeLessThan(54_000);

    const crossing = budgetCrossingTarget(rules, budgets, target);
    if (crossing === null) throw new Error("expected the budget to cover Vercel");
    const incident = demoIncident({ type: "budget-crossing", crossing });
    expect(await runDemoEvent({ deps, target, incident })).toEqual({ status: "written", triggered: 1 });
    expect(vercelTotal(store)).toBe(54_000);

    // Already triggered this billing period: a second crossing records nothing new.
    expect(await runDemoEvent({ deps, target, incident })).toEqual({ status: "written", triggered: 0 });
  });

  it("leaves spend as it was when the target is below it", async () => {
    const usualHarness = await setup();
    await runSyncJob(
      oneShotJob({ kind: "sync", workspace_id: WORKSPACE_ID, connection_id: usualHarness.target.connectionId, dedupe_key: null }, NOW),
      { ...usualHarness.deps, evaluateAlerts: async () => {} },
    );
    const usual = vercelTotal(usualHarness.store);

    const { store, target, deps } = await setup();
    const crossing = { totalMinor: 1, budgetName: "Tiny", budgetMinor: 1, thresholdPercent: 100, ruleIds: [] };
    await runDemoEvent({ deps, target, incident: demoIncident({ type: "budget-crossing", crossing }) });
    expect(vercelTotal(store)).toBe(usual);
  });
});

describe("runDemoEvent: outcomes", () => {
  const incident = demoIncident({ type: "failed-deployment" });

  it("keeps the event and gives the reference when the alert check fails", async () => {
    const { store, target, deps, logged } = await setup({ alertsFail: true });
    expect(await runDemoEvent({ deps, target, incident })).toEqual({ status: "alerts_not_checked", errorReference: "REF-TEST0001" });
    expect(logged).toEqual(["demo_event.alert_evaluation_failed"]);
    expect(failedDeployments(store)).toHaveLength(1);
  });

  it.each(["needs_attention", "revoked", "pending"] as const)("writes nothing for a connection that is %s", async (status) => {
    const { store, target, deps } = await setup({ status });
    expect(await runDemoEvent({ deps, target, incident })).toEqual({ status: "not_synced" });
    expect(store.events).toEqual([]);
  });

  it("reports a failed sync with its code and reference, and writes no incident", async () => {
    const { store, target, deps } = await setup({ credential: false });
    expect(await runDemoEvent({ deps, target, incident })).toEqual({
      status: "sync_failed",
      errorCode: "credential_missing",
      errorReference: "REF-TEST0001",
    });
    expect(failedDeployments(store)).toEqual([]);
  });
});
