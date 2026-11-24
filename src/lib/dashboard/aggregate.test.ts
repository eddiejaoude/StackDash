import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdapterMetric } from "@/lib/adapters/metrics";
import { billingMetrics as postHogBillingMetrics } from "@/lib/adapters/posthog";
import { BillingResponseSchema } from "@/lib/adapters/posthog/schemas";
import { billingMetrics as railwayBillingMetrics } from "@/lib/adapters/railway";
import { BillingDataSchema } from "@/lib/adapters/railway/schemas";
import { declaredProjectedSpend } from "@/lib/adapters/registry";
import { SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";
import { toSnapshotRow } from "@/lib/jobs/ingest";

import {
  aggregateDashboard,
  allowanceGroups,
  allowanceUsage,
  capNotice,
  capNoticeText,
  countedSnapshots,
  dropSubWindows,
  dropSupersededBreakdowns,
  freshnessLabel,
  hasSimulatedSource,
  isCurrentPeriod,
  isStale,
  laterCompleteFrom,
  latestSnapshots,
  percentUsed,
  providerCardFields,
  spendToCount,
  staleNoticeText,
  withStaleNotice,
  type AccountInput,
  type ConnectionInput,
  type CurrencyAmounts,
  type DashboardInput,
  type ProjectInput,
  type ProviderId,
  type SnapshotInput,
} from "./aggregate";

const NOW = new Date("2026-10-15T12:00:00.000Z");
const MONTH = { period_start: "2026-10-01T00:00:00.000Z", period_end: "2026-11-01T00:00:00.000Z" } as const;
const HOUR = 3_600;

const connection: ConnectionInput = {
  id: "c1",
  provider: "fake",
  display_name: "Fake account",
  status: "active",
  last_synced_at: "2026-10-15T11:30:00.000Z",
  last_sync_requested_at: null,
  poll_interval_seconds: HOUR,
  granted_scopes: ["usage:read"],
};

const accounts: AccountInput[] = [
  { id: "a1", connection_id: "c1", display_name: "Production", project_id: "p1" },
  { id: "a2", connection_id: "c1", display_name: "Staging", project_id: null },
];

const projects: ProjectInput[] = [{ id: "p1", name: "Checkout" }];

function money(
  overrides: Partial<SnapshotInput> & Pick<SnapshotInput, "metric_key" | "amount_minor" | "currency">,
): SnapshotInput {
  return {
    connection_id: "c1",
    external_account_id: "a1",
    kind: "verified_spend",
    label: "Spend this month",
    snapshot_date: "2026-10-15",
    value: null,
    unit: null,
    ...MONTH,
    point_at: null,
    resets_at: null,
    retrieved_at: "2026-10-15T11:30:00.000Z",
    provenance_source: "provider_api",
    pricing_source: null,
    ...overrides,
  };
}

function quantity(
  overrides: Partial<SnapshotInput> & Pick<SnapshotInput, "metric_key" | "kind" | "value" | "unit">,
): SnapshotInput {
  return {
    connection_id: "c1",
    external_account_id: "a1",
    label: "Requests",
    snapshot_date: "2026-10-15",
    amount_minor: null,
    currency: null,
    ...MONTH,
    point_at: null,
    resets_at: "2026-11-01T00:00:00.000Z",
    retrieved_at: "2026-10-15T11:30:00.000Z",
    provenance_source: "provider_api",
    pricing_source: null,
    ...overrides,
  };
}

function input(snapshots: SnapshotInput[], overrides: Partial<DashboardInput> = {}): DashboardInput {
  return { snapshots, connections: [connection], accounts, projects, projectedSpend: declaredProjectedSpend, now: NOW, ...overrides };
}

// An estimate of spend so far; `fake.cost.estimate` is the month's projection (#223), so not this.
const SPEND_ESTIMATE_KEY = "fake.spend.estimated";

describe("aggregateDashboard totals", () => {
  it("keeps two currencies apart and never adds them", () => {
    const view = aggregateDashboard(
      input([
        money({ metric_key: "fake.spend.usd", amount_minor: 12_345, currency: "USD" }),
        money({ metric_key: "fake.spend.eur", amount_minor: 6_789, currency: "EUR" }),
        money({ external_account_id: "a2", metric_key: "fake.spend.usd", amount_minor: 100, currency: "USD" }),
      ]),
    );
    expect(view.totals.map(({ currency, verified }) => [currency, verified?.amountMinor])).toEqual([
      ["EUR", 6_789],
      ["USD", 12_445],
    ]);
  });

  it("separates estimated from verified spend in the same currency", () => {
    const view = aggregateDashboard(
      input([
        money({ metric_key: "fake.spend.month", amount_minor: 1_000, currency: "USD" }),
        money({
          metric_key: SPEND_ESTIMATE_KEY,
          kind: "estimated_spend",
          amount_minor: 2_500,
          currency: "USD",
          provenance_source: "derived",
          pricing_source: "Fake price list 2026",
        }),
      ]),
    );
    expect(view.totals).toHaveLength(1);
    const [usd] = view.totals;
    expect(usd?.verified?.amountMinor).toBe(1_000);
    expect(usd?.verified?.provenance).toEqual({ status: "verified" });
    expect(usd?.estimated?.amountMinor).toBe(2_500);
    expect(usd?.estimated?.provenance).toEqual({ status: "estimated", pricingSources: ["Fake price list 2026"] });
  });

  it("reports a currency with only an estimate as having no verified amount, not zero", () => {
    const view = aggregateDashboard(
      input([
        money({
          metric_key: SPEND_ESTIMATE_KEY,
          kind: "estimated_spend",
          amount_minor: 2_500,
          currency: "USD",
          provenance_source: "derived",
          pricing_source: "Price list",
        }),
      ]),
    );
    expect(view.totals[0]?.verified).toBeNull();
  });

  it("uses only the latest snapshot per account and metric", () => {
    const view = aggregateDashboard(
      input([
        money({ metric_key: "fake.spend.month", amount_minor: 500, currency: "USD", snapshot_date: "2026-10-14" }),
        money({ metric_key: "fake.spend.month", amount_minor: 700, currency: "USD", snapshot_date: "2026-10-15" }),
      ]),
    );
    expect(view.totals[0]?.verified?.amountMinor).toBe(700);
  });

  it("ignores snapshots of accounts that are not included", () => {
    const view = aggregateDashboard(
      input([money({ external_account_id: "excluded", metric_key: "fake.spend.month", amount_minor: 1, currency: "USD" })]),
    );
    expect(view.totals).toEqual([]);
  });

  it("keeps revenue out of spending totals", () => {
    const view = aggregateDashboard(
      input([money({ metric_key: "fake.revenue.month", kind: "revenue", amount_minor: 9_000, currency: "USD" })]),
    );
    expect(view.totals).toEqual([]);
    expect(view.revenue[0]?.verified?.amountMinor).toBe(9_000);
  });

  it("keeps recurring revenue (MRR, ARR) out of revenue and spending totals, even as a point in time", () => {
    const view = aggregateDashboard(
      input([
        money({ metric_key: "fake.revenue.month", kind: "revenue", amount_minor: 9_000, currency: "USD" }),
        money({
          metric_key: "fake.mrr.usd",
          kind: "recurring_revenue",
          amount_minor: 4_000,
          currency: "USD",
          period_start: null,
          period_end: null,
          point_at: "2026-10-15T11:30:00.000Z",
        }),
      ]),
    );
    expect(view.totals).toEqual([]);
    expect(view.revenue.map((amounts) => amounts.verified?.amountMinor)).toEqual([9_000]);
    expect(view.byProvider[0]?.revenue.map((amounts) => amounts.verified?.amountMinor)).toEqual([9_000]);
    expect(view.byProvider[0]?.spend).toEqual([]);
  });

  it("lists each recurring revenue metric on its provider card, summed over accounts but never MRR into ARR", () => {
    const rate = { kind: "recurring_revenue", currency: "USD", period_start: null, period_end: null, point_at: "2026-10-15T11:30:00.000Z" } as const;
    const view = aggregateDashboard(
      input([
        money({ ...rate, metric_key: "fake.mrr.usd", label: "Monthly recurring revenue (USD)", amount_minor: 4_000 }),
        money({ ...rate, external_account_id: "a2", metric_key: "fake.mrr.usd", label: "Monthly recurring revenue (USD)", amount_minor: 1_000 }),
        money({ ...rate, metric_key: "fake.arr.usd", label: "Annual recurring revenue (USD)", amount_minor: 48_000 }),
        money({ ...rate, metric_key: "fake.mrr.eur", label: "Monthly recurring revenue (EUR)", currency: "EUR", amount_minor: 700 }),
      ]),
    );
    expect(view.byProvider[0]?.recurringRevenue.map(({ label, value }) => [label, value.amountMinor, value.currency])).toEqual([
      ["Annual recurring revenue (USD)", 48_000, "USD"],
      ["Monthly recurring revenue (EUR)", 700, "EUR"],
      ["Monthly recurring revenue (USD)", 5_000, "USD"],
    ]);
    expect(view.byProvider[0]?.recurringRevenue[0]?.value.provenance).toEqual({ status: "verified" });
  });

  it("lists no recurring revenue for a provider that reports none", () => {
    const view = aggregateDashboard(
      input([money({ metric_key: "fake.revenue.month", kind: "revenue", amount_minor: 9_000, currency: "USD" })]),
    );
    expect(view.byProvider[0]?.recurringRevenue).toEqual([]);
  });

  it("shows nothing for an empty workspace or a scope that matched no connection", () => {
    const view = aggregateDashboard(input([], { connections: [], accounts: [] }));
    expect(view.byProvider).toEqual([]);
    expect(view.totals).toEqual([]);
    expect(view.byProject).toEqual([]);
  });
});

describe("aggregateDashboard by project", () => {
  it("puts accounts without a project in the unassigned bucket, listed last", () => {
    const view = aggregateDashboard(
      input([
        money({ metric_key: "fake.spend.month", amount_minor: 1_000, currency: "USD" }),
        money({ external_account_id: "a2", metric_key: "fake.spend.month", amount_minor: 200, currency: "USD" }),
      ]),
    );
    expect(view.byProject.map(({ projectId, name, spend }) => [projectId, name, spend[0]?.verified?.amountMinor])).toEqual([
      ["p1", "Checkout", 1_000],
      [null, "Unassigned", 200],
    ]);
  });

  it("treats an account whose project is not visible as unassigned", () => {
    const view = aggregateDashboard(
      input([money({ metric_key: "fake.spend.month", amount_minor: 1_000, currency: "USD" })], { projects: [] }),
    );
    expect(view.byProject.map(({ projectId }) => projectId)).toEqual([null]);
  });
});

describe("aggregateDashboard GitHub spend levels (#137)", () => {
  // GitHub reports the same money per product month to date, per SKU, and per product per day.
  const github: ConnectionInput = { ...connection, provider: "github", display_name: "GitHub org" };
  const day = { period_start: "2026-10-15T00:00:00.000Z", period_end: "2026-10-16T00:00:00.000Z" } as const;
  const levels = [
    money({ metric_key: "github.daily_spend.actions", amount_minor: 1_252, currency: "USD", ...day }),
    money({ metric_key: "github.spend.actions", amount_minor: 5_175, currency: "USD" }),
    money({ metric_key: "github.spend.actions.actions_linux", amount_minor: 5_175, currency: "USD" }),
  ];

  it("counts the month to date product spend once, not the SKU and daily levels again", () => {
    const view = aggregateDashboard(input(levels, { connections: [github] }));
    expect(view.totals.map(({ currency, verified }) => [currency, verified?.amountMinor])).toEqual([["USD", 5_175]]);
    expect(view.byProvider[0]?.spend[0]?.verified?.amountMinor).toBe(5_175);
    expect(view.byProject[0]?.spend[0]?.verified?.amountMinor).toBe(5_175);
  });

  it("shows the month as the billing period, not the day, whatever order the rows arrive in", () => {
    for (const rows of [levels, [...levels].reverse()]) {
      const view = aggregateDashboard(input(rows, { connections: [github] }));
      expect(view.byProvider[0]?.billingPeriod).toEqual({ start: MONTH.period_start, end: MONTH.period_end });
    }
  });
});

describe("aggregateDashboard PostHog spend (#204)", () => {
  // The reproduction on #204: an organization billed $18.03 so far, $14.45 of it product analytics
  // and $3.58 session replay, in the shape `GET /api/billing/` returns it.
  const billing = {
    current_total_amount_usd: "18.03",
    projected_total_amount_usd: "41.20",
    billing_period: { current_period_start: MONTH.period_start, current_period_end: MONTH.period_end },
    products: [
      { type: "product_analytics", name: "Product analytics", usage_key: "events", unit: "event", current_usage: 1_289_000, free_allocation: 1_000_000, current_amount_usd: "14.45" },
      { type: "session_replay", name: "Session replay", usage_key: "recordings", unit: "recording", current_usage: 5_716, free_allocation: 5_000, current_amount_usd: "3.58" },
    ],
  };
  const posthog: ConnectionInput = { ...connection, provider: "posthog", display_name: "PostHog org" };

  /** What one sync at `at` stores: the adapter's own `billingMetrics` through the sync's `toSnapshotRow`. */
  function synced(at: string, account = "a1"): SnapshotInput[] {
    return postHogBillingMetrics(BillingResponseSchema.parse(billing), account, new Date(at), "us").map((metric) =>
      toSnapshotRow(metric, { id: "c1", workspace_id: "w1" }, { id: account }),
    );
  }

  /** The same sync as PostHog's rows were stored before #204: each product's spend as `posthog.<type>.spend`. */
  function syncedBefore204(at: string): SnapshotInput[] {
    return synced(at).map((row) => {
      const product = /^posthog\.spend\.current\.([a-z_]+)$/.exec(row.metric_key)?.[1];
      return product === undefined ? row : { ...row, metric_key: `posthog.${product}.spend` };
    });
  }

  const verifiedSum = (rows: readonly SnapshotInput[]) =>
    rows.filter((row) => row.kind === "verified_spend").reduce((sum, row) => sum + (row.amount_minor ?? 0), 0);

  it("reports each product's spend one segment below the organization total", () => {
    expect(synced("2026-10-15T11:30:00.000Z").filter((row) => row.kind === "verified_spend").map((row) => [row.metric_key, row.amount_minor])).toEqual([
      ["posthog.spend.current", 1_803],
      ["posthog.spend.current.product_analytics", 1_445],
      ["posthog.spend.current.session_replay", 358],
    ]);
  });

  it("counts one sync's verified spend as the organization total, not its products again", () => {
    const counted = countedSnapshots(synced("2026-10-15T11:30:00.000Z"), declaredProjectedSpend);
    expect(verifiedSum(counted)).toBe(1_803);
    expect(counted.filter((row) => row.kind === "verified_spend").map((row) => row.metric_key)).toEqual(["posthog.spend.current"]);
  });

  it("shows current_total_amount_usd on the spend card, the totals, and the project", () => {
    const view = aggregateDashboard(input(synced("2026-10-15T11:30:00.000Z"), { connections: [posthog] }));
    expect(view.byProvider[0]?.spend.map(({ currency, verified }) => [currency, verified?.amountMinor])).toEqual([["USD", 1_803]]);
    expect(view.totals.map(({ currency, verified }) => [currency, verified?.amountMinor])).toEqual([["USD", 1_803]]);
    expect(view.byProject[0]?.spend[0]?.verified?.amountMinor).toBe(1_803);
  });

  it.each([
    ["read on an earlier day", "2026-10-14T23:30:00.000Z"],
    ["read earlier on the same day, as on the day the new keys ship", "2026-10-15T08:00:00.000Z"],
  ])("never counts products stored under the old key beside the total, %s", (_name, before) => {
    const rows = [...syncedBefore204(before), ...synced("2026-10-15T11:30:00.000Z")];
    expect(verifiedSum(countedSnapshots(rows, declaredProjectedSpend))).toBe(1_803);
    const view = aggregateDashboard(input(rows, { connections: [posthog] }));
    expect(view.byProvider[0]?.spend[0]?.verified?.amountMinor).toBe(1_803);
  });

  it("counts an old sync on its own as its total too", () => {
    expect(verifiedSum(countedSnapshots(syncedBefore204("2026-10-14T23:30:00.000Z"), declaredProjectedSpend))).toBe(1_803);
  });

  it("keeps an old-keyed product when its account reported no total", () => {
    const [product] = syncedBefore204("2026-10-15T11:30:00.000Z").filter((row) => row.metric_key === "posthog.session_replay.spend");
    if (product === undefined) throw new Error("expected the session replay row");
    const otherAccount = synced("2026-10-15T11:30:00.000Z", "a2").filter((row) => row.metric_key === "posthog.spend.current");
    expect(dropSupersededBreakdowns([...otherAccount, product])).toContain(product);
  });
});

describe("aggregateDashboard billing period", () => {
  it("shows the whole month when the Fake provider reports month to date spend and a month estimate, in either order", () => {
    // As the Fake adapter reports them: verified spend from the month start to tomorrow, and an
    // estimate for the whole month.
    const monthToDate = money({
      metric_key: "fake.spend.month",
      amount_minor: 1_000,
      currency: "USD",
      period_start: MONTH.period_start,
      period_end: "2026-10-16T00:00:00.000Z",
    });
    const estimate = money({ metric_key: "fake.cost.estimate", kind: "estimated_spend", amount_minor: 2_500, currency: "USD" });
    for (const rows of [
      [monthToDate, estimate],
      [estimate, monthToDate],
    ]) {
      expect(aggregateDashboard(input(rows)).byProvider[0]?.billingPeriod).toEqual({ start: MONTH.period_start, end: MONTH.period_end });
    }
  });

  it("shows the period that starts first, even when it ends first, in either order", () => {
    const cycle = { period_start: "2026-09-20T00:00:00.000Z", period_end: "2026-10-20T00:00:00.000Z" } as const;
    const earlier = money({ metric_key: "fake.spend.cycle", amount_minor: 1_000, currency: "USD", ...cycle });
    const estimate = money({ metric_key: "fake.cost.estimate", kind: "estimated_spend", amount_minor: 2_500, currency: "USD" });
    for (const rows of [
      [earlier, estimate],
      [estimate, earlier],
    ]) {
      expect(aggregateDashboard(input(rows)).byProvider[0]?.billingPeriod).toEqual({ start: cycle.period_start, end: cycle.period_end });
    }
  });
});

describe("aggregateDashboard declared projections (#223)", () => {
  const november = new Date("2026-11-05T12:00:00.000Z");
  const readAt = new Date("2026-11-05T11:30:00.000Z");
  const period = { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" };
  const posthog: ConnectionInput = { ...connection, id: "c-posthog", provider: "posthog", display_name: "PostHog (Example organization)" };
  const railway: ConnectionInput = { ...connection, id: "c-railway", provider: "railway", display_name: "Railway (Example workspace)" };

  /** What one sync stores, through the adapter's own billing metrics and the sync's `toSnapshotRow`. */
  function synced(owner: ConnectionInput, metrics: readonly AdapterMetric[]): SnapshotInput[] {
    return metrics.map((metric) => toSnapshotRow(metric, { id: owner.id, workspace_id: "w1" }, { id: `a-${owner.provider}` }));
  }

  // The demo seed on 2026-11-05: PostHog has billed nothing yet and projects $29.86 for the period;
  // Railway has used $7.13 and estimates the whole period's bill.
  const posthogRows = synced(
    posthog,
    postHogBillingMetrics(
      BillingResponseSchema.parse({
        current_total_amount_usd: "0.00",
        projected_total_amount_usd: "29.86",
        billing_period: { current_period_start: period.start, current_period_end: period.end },
      }),
      "org-1",
      readAt,
      "us",
    ),
  );
  const railwayRows = synced(
    railway,
    railwayBillingMetrics(
      BillingDataSchema.parse({
        workspace: { plan: "HOBBY", customer: { billingPeriod: period, currentUsage: 7.13, creditBalance: 0 } },
        usage: [],
        estimatedUsage: [{ measurement: "CPU_USAGE", estimatedValue: 80_000, projectId: "prj-shop" }],
      }),
      "ws-1",
      readAt,
    ),
  );

  function view(owner: ConnectionInput, snapshots: SnapshotInput[]) {
    const ownerAccounts: AccountInput[] = [{ id: `a-${owner.provider}`, connection_id: owner.id, display_name: "Example", project_id: "p1" }];
    return aggregateDashboard(input(snapshots, { connections: [owner], accounts: ownerAccounts, now: november }));
  }

  const cases = [
    { name: "PostHog", owner: posthog, rows: posthogRows, verifiedMinor: 0 },
    { name: "Railway", owner: railway, rows: railwayRows, verifiedMinor: 713 },
  ];

  it.each(cases)("$name: counts only the verified spend beside a declared projection", ({ owner, rows, verifiedMinor }) => {
    // The adapter really does send a projection with an amount, so leaving it out is the rule at work.
    expect(rows.filter((row) => declaredProjectedSpend.includes(row.metric_key)).map((row) => (row.amount_minor ?? 0) > 0)).toEqual([true]);
    const result = view(owner, rows);
    const usd = (amounts: readonly CurrencyAmounts[] | undefined) =>
      amounts?.map(({ currency, verified, estimated }) => [currency, verified?.amountMinor ?? null, estimated]);
    expect(usd(result.totals)).toEqual([["USD", verifiedMinor, null]]);
    expect(usd(result.byProvider[0]?.spend)).toEqual([["USD", verifiedMinor, null]]);
    expect(usd(result.byProject[0]?.spend)).toEqual([["USD", verifiedMinor, null]]);
  });

  it.each(cases)("$name: shows no spend for a declared projection with no verified spend in its currency", ({ owner, rows }) => {
    const result = view(owner, rows.filter((row) => declaredProjectedSpend.includes(row.metric_key)));
    expect(result.totals).toEqual([]);
    expect(result.byProvider[0]?.spend).toEqual([]);
    expect(result.byProject).toEqual([]);
    // Not spend, but still the billing period it projects.
    expect(result.byProvider[0]?.billingPeriod).toEqual(period);
  });
});

describe("aggregateDashboard simulated sources (#131)", () => {
  // A real connection and a simulated one in the same workspace, each with one account.
  const simulated: ConnectionInput = { ...connection, id: "c2", display_name: "Simulated account", granted_scopes: [SIMULATED_SCOPE] };
  const mixedAccounts: AccountInput[] = [...accounts, { id: "a3", connection_id: "c2", display_name: "Example team", project_id: "p1" }];
  const mixed = (overrides: Partial<DashboardInput> = {}) =>
    input(
      [
        money({ metric_key: "fake.spend.month", amount_minor: 1_000, currency: "USD" }),
        money({ connection_id: "c2", external_account_id: "a3", metric_key: "fake.spend.month", amount_minor: 500, currency: "USD" }),
        money({ metric_key: "fake.spend.eur", amount_minor: 300, currency: "EUR" }),
        money({ connection_id: "c2", external_account_id: "a3", metric_key: "fake.revenue.month", kind: "revenue", amount_minor: 9_000, currency: "USD" }),
      ],
      { connections: [connection, simulated], accounts: mixedAccounts, ...overrides },
    );

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("marks a spend or revenue total simulated when any source is, and leaves real-only totals unmarked", () => {
    const view = aggregateDashboard(mixed());
    const byCurrency = new Map(view.totals.map((amounts) => [amounts.currency, amounts]));
    const usd = byCurrency.get("USD");
    const eur = byCurrency.get("EUR");
    if (usd === undefined || eur === undefined) throw new Error("expected USD and EUR totals");
    expect(usd.verified?.sources.map((source) => [source.connectionId, source.simulated])).toEqual([
      ["c1", false],
      ["c2", true],
    ]);
    expect(hasSimulatedSource(usd)).toBe(true);
    expect(hasSimulatedSource(eur)).toBe(false);
    expect(view.revenue.map(hasSimulatedSource)).toEqual([true]);
    // Checkout holds the real EUR spend and both USD spends; the unassigned account has none.
    expect(view.byProject.map(({ name, spend }) => [name, spend.map(hasSimulatedSource)])).toEqual([["Checkout", [false, true]]]);
  });

  it("marks each provider card from its connection, never from the process flag", () => {
    for (const flag of [undefined, "1"]) {
      vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", flag);
      const view = aggregateDashboard(mixed());
      expect(view.byProvider.map((summary) => [summary.connectionId, summary.simulated])).toEqual([
        ["c1", false],
        ["c2", true],
      ]);
    }
  });
});

describe("providerCardFields (#269)", () => {
  const summaryOf = (snapshots: SnapshotInput[]) => {
    const summary = aggregateDashboard(input(snapshots)).byProvider[0];
    if (summary === undefined) throw new Error("expected one provider card");
    return summary;
  };
  const spend = money({ metric_key: "fake.spend.month", amount_minor: 1_000, currency: "USD" });
  const credit = money({ metric_key: "fake.credit", kind: "credit_balance", amount_minor: 500, currency: "USD" });
  const reset = quantity({ metric_key: "fake.requests.included", kind: "included_allowance", value: 1_000, unit: "requests" });

  it("keeps every row a provider declares, even before it has a value", () => {
    expect(providerCardFields(summaryOf([]), { spending: true, credits: true })).toEqual({
      billingPeriod: true,
      resetsAt: false,
      spend: true,
      credits: true,
    });
  });

  it("drops every row a provider that reports no money never fills, as for Sentry", () => {
    expect(providerCardFields(summaryOf([]), { spending: false, credits: false })).toEqual({
      billingPeriod: false,
      resetsAt: false,
      spend: false,
      credits: false,
    });
  });

  it("never hides a value that is there, whatever the provider declares", () => {
    expect(providerCardFields(summaryOf([spend, credit, reset]), { spending: false, credits: false })).toEqual({
      billingPeriod: true,
      resetsAt: true,
      spend: true,
      credits: true,
    });
  });

  it("shows a reset only when a reading carries one in the future", () => {
    const past = quantity({ ...reset, resets_at: "2026-10-15T00:00:00.000Z" });
    expect(providerCardFields(summaryOf([past]), { spending: true, credits: false }).resetsAt).toBe(false);
  });
});

describe("aggregateDashboard allowances", () => {
  const included = quantity({ metric_key: "fake.requests.included", kind: "included_allowance", value: 1_000, unit: "requests", label: "Requests included" });
  const used = quantity({ metric_key: "fake.requests.month", kind: "usage", value: 250, unit: "requests" });

  it("pairs included and used in the same unit and reports remaining as unavailable when missing", () => {
    const view = aggregateDashboard(input([included, used]));
    const [allowance] = view.byProvider[0]?.allowances ?? [];
    expect(allowance?.included?.value).toBe(1_000);
    expect(allowance?.used?.value).toBe(250);
    expect(allowance?.remaining).toBeNull();
    expect(allowance?.percentUsed).toBe(25);
    expect(allowance?.resetsAt).toBe("2026-11-01T00:00:00.000Z");
  });

  it("reports percent used as unavailable when the included allowance is zero", () => {
    const view = aggregateDashboard(input([{ ...included, value: 0 }, used]));
    expect(view.byProvider[0]?.allowances[0]?.percentUsed).toBeNull();
  });

  it("does not count usage measured in a different unit against the allowance", () => {
    const view = aggregateDashboard(input([included, { ...used, unit: "GB" }]));
    const [allowance] = view.byProvider[0]?.allowances ?? [];
    expect(allowance?.used).toBeNull();
    expect(allowance?.percentUsed).toBeNull();
  });

  it("builds a card from a remaining allowance alone", () => {
    const remaining = quantity({ metric_key: "fake.requests.remaining", kind: "remaining_allowance", value: 750, unit: "requests" });
    const [allowance] = aggregateDashboard(input([remaining])).byProvider[0]?.allowances ?? [];
    expect(allowance?.remaining?.value).toBe(750);
    expect(allowance?.included).toBeNull();
    expect(allowance?.percentUsed).toBeNull();
  });
});

describe("percentUsed", () => {
  it("returns null when either part is missing", () => {
    expect(percentUsed(null, null)).toBeNull();
  });
});

describe("isStale", () => {
  const retrievedAt = "2026-10-15T10:00:00.000Z";

  it("is fresh at exactly two poll intervals", () => {
    expect(isStale(retrievedAt, HOUR, new Date("2026-10-15T12:00:00.000Z"))).toBe(false);
  });

  it("is stale one millisecond past two poll intervals", () => {
    expect(isStale(retrievedAt, HOUR, new Date("2026-10-15T12:00:00.001Z"))).toBe(true);
  });

  it("marks an aggregated value stale when any of its rows is stale", () => {
    const view = aggregateDashboard(
      input([
        money({ metric_key: "fake.spend.usd", amount_minor: 1, currency: "USD" }),
        money({
          external_account_id: "a2",
          metric_key: "fake.spend.usd",
          amount_minor: 1,
          currency: "USD",
          retrieved_at: "2026-10-15T09:59:59.000Z",
        }),
      ]),
    );
    expect(view.totals[0]?.verified?.stale).toBe(true);
    expect(view.totals[0]?.verified?.retrievedAt).toBe("2026-10-15T09:59:59.000Z");
  });
});

describe("withStaleNotice (#267)", () => {
  const threeDaysAgo = "2026-10-12T09:00:00.000Z";
  const twoDaysAgo = "2026-10-13T09:00:00.000Z";
  const second: ConnectionInput = { ...connection, id: "c2", provider: "github", display_name: "GitHub org" };
  const third: ConnectionInput = { ...connection, id: "c3", provider: "vercel", display_name: "Vercel team" };
  const secondAccount: AccountInput = { id: "a3", connection_id: "c2", display_name: "Org", project_id: null };
  const thirdAccount: AccountInput = { id: "a4", connection_id: "c3", display_name: "Team", project_id: null };
  // Every provider here is offered, as on an instance with the fake provider's flag on.
  const offered: ReadonlySet<ProviderId> = new Set(["fake", "github", "vercel"]);
  // The fake provider's flag off: its connection (c1) stays in view but cannot sync (#570).
  const fakeOff: ReadonlySet<ProviderId> = new Set(["github", "vercel"]);

  function view(connections: readonly ConnectionInput[]) {
    return aggregateDashboard(
      input(
        [
          money({ metric_key: "fake.spend.usd", amount_minor: 100, currency: "USD", retrieved_at: threeDaysAgo }),
          money({ connection_id: "c2", external_account_id: "a3", metric_key: "github.spend.month", amount_minor: 50, currency: "USD", retrieved_at: twoDaysAgo }),
          quantity({ metric_key: "fake.requests.included", kind: "included_allowance", value: 1_000, unit: "requests", retrieved_at: threeDaysAgo }),
          quantity({ metric_key: "fake.requests.month", kind: "usage", value: 250, unit: "requests", retrieved_at: threeDaysAgo }),
          // A fresh connection's metric that was last read three days ago: its own stale value.
          money({ connection_id: "c3", external_account_id: "a4", metric_key: "vercel.spend.month", amount_minor: 70, currency: "EUR", retrieved_at: threeDaysAgo }),
        ],
        { connections, accounts: [...accounts, secondAccount, thirdAccount] },
      ),
    );
  }

  it("shows one notice naming every stale connection and the newest of their syncs when all are stale, and drops each value's stale mark", () => {
    const { notice, view: shown } = withStaleNotice(
      view([
        { ...connection, last_synced_at: threeDaysAgo },
        { ...second, last_synced_at: twoDaysAgo },
      ]),
      offered,
    );
    expect(notice).toEqual({
      connections: [
        { connectionId: "c1", name: "Fake account" },
        { connectionId: "c2", name: "GitHub org" },
      ],
      total: 2,
      lastSyncedAt: twoDaysAgo,
      syncRequestedAt: null,
    });
    const stale = [
      ...shown.totals.flatMap((amounts) => [amounts.verified, amounts.estimated]),
      ...shown.byProvider.flatMap((summary) => [
        summary,
        ...summary.spend.flatMap((amounts) => [amounts.verified, amounts.estimated]),
        ...summary.allowances.flatMap((allowance) => [allowance.included, allowance.used, allowance.remaining]),
      ]),
      ...shown.byProject.flatMap((project) => project.spend.flatMap((amounts) => [amounts.verified, amounts.estimated])),
    ].filter((value) => value?.stale === true);
    expect(stale).toEqual([]);
    // Each value still says when it was read; only the warning moved to the notice.
    expect(shown.totals[0]?.verified?.retrievedAt).toBe(threeDaysAgo);
    expect(shown.byProvider[0]?.lastSyncedAt).toBe(threeDaysAgo);
  });

  it("shows the notice when most connections are stale: two of three, and a connection it does not name keeps its own stale value", () => {
    const { notice, view: shown } = withStaleNotice(
      view([{ ...connection, last_synced_at: threeDaysAgo }, { ...second, last_synced_at: twoDaysAgo }, third]),
      offered,
    );
    expect(notice).toMatchObject({ total: 3, connections: [{ connectionId: "c1" }, { connectionId: "c2" }] });
    const vercelCard = shown.byProvider.find((summary) => summary.connectionId === "c3");
    expect(vercelCard?.spend[0]?.verified?.stale).toBe(true);
    expect(shown.byProvider.find((summary) => summary.connectionId === "c1")?.spend[0]?.verified?.stale).toBe(false);
  });

  it("waits out the Sync now cooldown only while every stale connection is in it (#161)", () => {
    const asked = (owner: ConnectionInput, at: string | null) => ({ ...owner, last_synced_at: threeDaysAgo, last_sync_requested_at: at });
    const early = "2026-10-15T11:56:00.000Z";
    const late = "2026-10-15T11:58:00.000Z";
    expect(withStaleNotice(view([asked(connection, late), asked(second, early)]), offered).notice?.syncRequestedAt).toBe(early);
    // One never asked: it can sync now, so there is no cooldown to wait out.
    expect(withStaleNotice(view([asked(connection, late), asked(second, null)]), offered).notice?.syncRequestedAt).toBeNull();
  });

  it.each([
    ["one stale and the rest fresh", [{ ...connection, last_synced_at: threeDaysAgo }, second, third]],
    ["exactly half stale", [{ ...connection, last_synced_at: threeDaysAgo }, second]],
    ["nothing stale", [connection, second]],
    ["no connection synced yet", [{ ...connection, last_synced_at: null }]],
    ["no connections", []],
  ] as const)("keeps each value's own stale mark and shows no notice (boundary: %s)", (_name, connections) => {
    const before = view(connections);
    const { notice, view: shown } = withStaleNotice(before, offered);
    expect(notice).toBeNull();
    expect(shown).toBe(before);
  });

  it("is fresh at exactly two poll intervals, as every stale mark is (boundary: two intervals)", () => {
    const exactlyTwo = "2026-10-15T10:00:00.000Z";
    expect(withStaleNotice(view([{ ...connection, last_synced_at: exactlyTwo }]), offered).notice).toBeNull();
    expect(withStaleNotice(view([{ ...connection, last_synced_at: "2026-10-15T09:59:59.999Z" }]), offered).notice).not.toBeNull();
  });

  it("leaves out a disconnected connection, which no sync can bring up to date, and one never synced", () => {
    const revoked = { ...second, status: "revoked" as const, last_synced_at: threeDaysAgo };
    const neverSynced = { ...third, last_synced_at: null };
    expect(withStaleNotice(view([connection, revoked, neverSynced]), offered).notice).toBeNull();
    expect(withStaleNotice(view([{ ...connection, last_synced_at: threeDaysAgo }, revoked]), offered).notice).toMatchObject({
      total: 1,
      connections: [{ connectionId: "c1" }],
    });
  });

  it("neither names nor counts a connection whose provider this instance does not offer, which keeps its own stale mark (#588)", () => {
    const connections = [
      { ...connection, last_synced_at: threeDaysAgo },
      { ...second, last_synced_at: twoDaysAgo },
      { ...third, last_synced_at: threeDaysAgo },
    ];
    expect(withStaleNotice(view(connections), offered).notice).toMatchObject({
      total: 3,
      connections: [{ connectionId: "c1" }, { connectionId: "c2" }, { connectionId: "c3" }],
    });
    const { notice, view: shown } = withStaleNotice(view(connections), fakeOff);
    expect(notice).toEqual({
      connections: [
        { connectionId: "c2", name: "GitHub org" },
        { connectionId: "c3", name: "Vercel team" },
      ],
      total: 2,
      lastSyncedAt: twoDaysAgo,
      syncRequestedAt: null,
    });
    expect(shown.byProvider.find((summary) => summary.connectionId === "c1")?.spend[0]?.verified?.stale).toBe(true);
  });

  it("shows no notice when the only stale connection's provider is not offered (boundary: the fake provider's flag off)", () => {
    const connections = [{ ...connection, last_synced_at: threeDaysAgo }];
    expect(withStaleNotice(view(connections), offered).notice).toMatchObject({ total: 1, connections: [{ connectionId: "c1" }] });
    const before = view(connections);
    const { notice, view: shown } = withStaleNotice(before, fakeOff);
    expect(notice).toBeNull();
    expect(shown).toBe(before);
  });

  it("says since when in words, naming the stale connections only when some are fresh", () => {
    const one = { connectionId: "c1", name: "Fake account" };
    const two = { connectionId: "c2", name: "GitHub org" };
    const all = staleNoticeText({ connections: [one, two], total: 2, lastSyncedAt: twoDaysAgo, syncRequestedAt: null }, NOW);
    expect(all).toEqual({
      title: "Data last synced 2 days ago",
      body: "None of the 2 connections in view has synced since 2026-10-13 10:00 BST, so every figure on this page is from then or earlier.",
    });
    expect(staleNoticeText({ connections: [one], total: 1, lastSyncedAt: threeDaysAgo, syncRequestedAt: null }, NOW).body).toBe(
      "The only connection in view has not synced since 2026-10-12 10:00 BST, so every figure on this page is from then or earlier.",
    );
    const most = staleNoticeText({ connections: [one, two], total: 3, lastSyncedAt: twoDaysAgo, syncRequestedAt: null }, NOW);
    expect(most.body).toBe(
      "2 of 3 connections in view have not synced since 2026-10-13 10:00 BST: Fake account and GitHub org. Their figures on this page are from then or earlier.",
    );
    for (const text of [all.title, all.body, most.body]) expect(text).not.toMatch(/[\u2013\u2014!]/);
  });
});

describe("capNotice (#336)", () => {
  it.each([
    { case: "no reads", reads: [] },
    { case: "every read whole", reads: [{ part: "headline", completeFrom: null }, { part: "cards", completeFrom: null }, { part: "daily trend", completeFrom: null }] },
  ] as const)("shows no notice (boundary: $case)", ({ reads }) => {
    expect(capNotice(reads)).toBeNull();
  });

  it("names each part whose read stopped, in page order whatever the order of the reads", () => {
    expect(
      capNotice([
        { part: "monthly trend", completeFrom: "2026-03-01" },
        { part: "cards", completeFrom: "2026-10-12" },
        { part: "headline", completeFrom: null },
      ]),
    ).toEqual({
      parts: [
        { part: "cards", completeFrom: "2026-10-12" },
        { part: "monthly trend", completeFrom: "2026-03-01" },
      ],
    });
  });

  it("takes the later day of a part read twice, as the headline's window to date and last complete window are", () => {
    const read = (completeFrom: string | null) => ({ part: "headline", completeFrom }) as const;
    expect(capNotice([read("2026-10-26"), read("2026-10-20")])?.parts).toEqual([{ part: "headline", completeFrom: "2026-10-26" }]);
    expect(capNotice([read(null), read("2026-10-20")])?.parts).toEqual([{ part: "headline", completeFrom: "2026-10-20" }]);
  });

  it.each([
    { case: "neither stopped", a: null, b: null, later: null },
    { case: "only the first stopped", a: "2026-10-20", b: null, later: "2026-10-20" },
    { case: "only the second stopped", a: null, b: "2026-10-20", later: "2026-10-20" },
    { case: "the same day", a: "2026-10-20", b: "2026-10-20", later: "2026-10-20" },
    { case: "across a month and a year", a: "2026-12-31", b: "2027-01-01", later: "2027-01-01" },
  ])("laterCompleteFrom: $case", ({ a, b, later }) => {
    expect(laterCompleteFrom(a, b)).toBe(later);
    expect(laterCompleteFrom(b, a)).toBe(later);
  });

  it("says which parts are incomplete and from which day, one sentence per day, in page order", () => {
    const intro = "This workspace has more readings than the dashboard reads at once, so the oldest are left out.";
    const outro = "Anything that depends on an older reading can be missing or incomplete.";
    const cards = capNoticeText({ parts: [{ part: "cards", completeFrom: "2026-10-12" }] });
    expect(cards).toEqual({ title: "Some older readings are not shown", body: `${intro} The cards are complete from 2026-10-12. ${outro}` });
    expect(capNoticeText({ parts: [{ part: "monthly trend", completeFrom: "2026-03-01" }] }).body).toBe(
      `${intro} The monthly trend is complete from 2026-03-01. ${outro}`,
    );
    // The daily trend reads the cards' rows, so the two share a day.
    const several = capNoticeText({
      parts: [
        { part: "headline", completeFrom: "2026-11-02" },
        { part: "cards", completeFrom: "2026-10-12" },
        { part: "daily trend", completeFrom: "2026-10-12" },
      ],
    });
    expect(several.body).toBe(
      `${intro} The headline is complete from 2026-11-02. The cards and the daily trend are complete from 2026-10-12. ${outro}`,
    );
    const sameDay = capNoticeText({
      parts: [
        { part: "headline", completeFrom: "2026-10-12" },
        { part: "cards", completeFrom: "2026-10-12" },
        { part: "daily trend", completeFrom: "2026-10-12" },
      ],
    });
    expect(sameDay.body).toBe(`${intro} The headline, the cards, and the daily trend are complete from 2026-10-12. ${outro}`);
    for (const text of [cards.title, cards.body, several.body, sameDay.body]) expect(text).not.toMatch(/[\u2013\u2014!]/);
  });
});

describe("isCurrentPeriod", () => {
  const row = money({ metric_key: "fake.spend.month", amount_minor: 1, currency: "USD" });

  it("counts a month to date window that ends at the retrieval time", () => {
    expect(isCurrentPeriod({ ...row, period_end: row.retrieved_at }, NOW)).toBe(true);
  });

  it("excludes a rolling window that starts mid day", () => {
    expect(isCurrentPeriod({ ...row, period_start: "2026-09-15T11:30:00.000Z" }, NOW)).toBe(false);
  });

  it("excludes a period that ended before the value was read", () => {
    expect(
      isCurrentPeriod(
        { ...row, period_start: "2026-09-01T00:00:00.000Z", period_end: "2026-10-01T00:00:00.000Z" },
        NOW,
      ),
    ).toBe(false);
  });

  it("excludes a period that has not started", () => {
    expect(isCurrentPeriod({ ...row, period_start: "2026-11-01T00:00:00.000Z", period_end: "2026-12-01T00:00:00.000Z" }, NOW)).toBe(false);
  });
});

describe("dropSupersededBreakdowns", () => {
  it("keeps a total and drops its breakdown in the same currency", () => {
    const rows = [
      money({ metric_key: "vercel.spend.total", amount_minor: 300, currency: "USD" }),
      money({ metric_key: "vercel.spend.usage", amount_minor: 200, currency: "USD" }),
      money({ metric_key: "vercel.spend.tax", amount_minor: 100, currency: "USD" }),
      money({ metric_key: "vercel.other.usage", amount_minor: 50, currency: "USD" }),
    ];
    expect(dropSupersededBreakdowns(rows).map((row) => row.metric_key)).toEqual(["vercel.spend.total", "vercel.other.usage"]);
  });

  it("keeps a product and drops its SKUs, as GitHub reports them", () => {
    const rows = [
      money({ metric_key: "github.spend.actions", amount_minor: 5_175, currency: "USD" }),
      money({ metric_key: "github.spend.actions.actions_linux", amount_minor: 5_000, currency: "USD" }),
      money({ metric_key: "github.spend.actions.actions_macos", amount_minor: 175, currency: "USD" }),
      money({ metric_key: "github.spend.copilot", amount_minor: 100, currency: "USD" }),
    ];
    expect(dropSupersededBreakdowns(rows).map((row) => row.metric_key)).toEqual(["github.spend.actions", "github.spend.copilot"]);
  });

  it.each([
    ["there is no product row", []],
    ["the product row is another account", [{ external_account_id: "a2" }]],
    ["the product row is another currency", [{ currency: "EUR" }]],
    ["the product row is another kind", [{ kind: "estimated_spend" as const }]],
  ])("keeps a SKU when %s", (_name, parents: Partial<SnapshotInput>[]) => {
    const sku = money({ metric_key: "github.spend.actions.actions_linux", amount_minor: 5_175, currency: "USD" });
    const products = parents.map((parent) => money({ metric_key: "github.spend.actions", amount_minor: 5_175, currency: "USD", ...parent }));
    expect(dropSupersededBreakdowns([...products, sku])).toContain(sku);
  });

  it("keeps a key two segments below another one", () => {
    const rows = [
      money({ metric_key: "github.spend", amount_minor: 1, currency: "USD" }),
      money({ metric_key: "github.spend.actions.actions_linux", amount_minor: 1, currency: "USD" }),
    ];
    expect(dropSupersededBreakdowns(rows)).toHaveLength(2);
  });
});

describe("dropSubWindows", () => {
  const day = { period_start: "2026-10-15T00:00:00.000Z", period_end: "2026-10-16T00:00:00.000Z" } as const;
  const month = money({ metric_key: "github.spend.actions", amount_minor: 5_175, currency: "USD" });
  const today = money({ metric_key: "github.daily_spend.actions", amount_minor: 1_252, currency: "USD", ...day });

  it("drops a day inside a month of the same account, kind, and currency", () => {
    expect(dropSubWindows([today, month])).toEqual([month]);
  });

  it("drops a shorter window that starts with the month", () => {
    const monthToDate = { ...today, period_start: MONTH.period_start, period_end: "2026-10-15T11:30:00.000Z" };
    expect(dropSubWindows([monthToDate, month])).toEqual([month]);
  });

  it.each([
    ["there is no longer window", [today], [today]],
    ["the windows are equal, as Vercel's services and total are", [month, { ...month, metric_key: "vercel.spend.tax" }], null],
    ["the longer window is another account", [today, { ...month, external_account_id: "a2" }], null],
    ["the longer window is another currency", [today, { ...month, currency: "EUR" }], null],
    ["the longer window is another kind", [today, { ...month, kind: "estimated_spend" as const }], null],
    ["the longer window is a usage reading", [today, quantity({ metric_key: "github.usage.actions.minutes", kind: "usage", value: 1, unit: "minutes" })], null],
    ["the row is a point in time reading", [{ ...today, period_start: null, period_end: null, point_at: "2026-10-15T11:30:00.000Z" }, month], null],
  ])("keeps every row when %s", (_name, rows, expected) => {
    expect(dropSubWindows(rows)).toEqual(expected ?? rows);
  });

  it("never lets a rolling window that starts mid day hide the month inside it", () => {
    const monthToDate = money({ metric_key: "stripe.fees.month.usd", amount_minor: 100, currency: "USD", period_end: NOW.toISOString() });
    const rolling = { ...monthToDate, metric_key: "stripe.fees.last_30_days.usd", period_start: "2026-09-15T12:00:00.000Z" };
    expect(dropSubWindows([monthToDate, rolling])).toEqual([monthToDate, rolling]);
  });

  it("drops a day inside a month for revenue too", () => {
    const revenue = { ...month, kind: "revenue" as const };
    expect(dropSubWindows([{ ...today, kind: "revenue" }, revenue])).toEqual([revenue]);
  });
});

describe("spendToCount", () => {
  const verified = money({ metric_key: "fake.spend.month", amount_minor: 500, currency: "USD" });
  const estimate = money({ metric_key: "fake.cost.estimate", amount_minor: 900, currency: "USD", kind: "estimated_spend", provenance_source: "derived" });

  it("counts verified spend and leaves out an estimate for the same account and currency", () => {
    expect(spendToCount([verified, estimate], NOW)).toEqual([verified]);
  });

  it.each([
    ["another account", { external_account_id: "a2" }],
    ["another currency", { currency: "EUR" }],
  ])("counts an estimate whose verified spend is in %s", (_name, overrides) => {
    const other = { ...estimate, ...overrides };
    expect(spendToCount([verified, other], NOW)).toEqual([verified, other]);
  });

  it("leaves out spend outside the current period, with no amount, and anything that is not spend", () => {
    const ended = { ...verified, period_start: "2026-09-01T00:00:00.000Z", period_end: "2026-10-01T00:00:00.000Z" };
    const noAmount = { ...verified, amount_minor: null };
    const revenue = { ...verified, kind: "revenue" as const };
    expect(spendToCount([ended, noAmount, revenue], NOW)).toEqual([]);
  });
});

describe("allowanceGroups and allowanceUsage", () => {
  const included = quantity({ metric_key: "resend.emails.monthly.limit", kind: "included_allowance", value: 3000, unit: "emails" });
  const used = quantity({ metric_key: "resend.emails.monthly.used", kind: "usage", value: 100, unit: "emails" });

  it("pairs rows of one account whose keys share everything before the last segment", () => {
    const left = quantity({ metric_key: "resend.emails.monthly.remaining", kind: "remaining_allowance", value: 2900, unit: "emails" });
    const [group, ...rest] = allowanceGroups([used, included, left]);
    expect(rest).toEqual([]);
    expect(group).toMatchObject({ accountId: "a1", prefix: "resend.emails.monthly", included, remaining: left, usage: [used] });
    expect(group === undefined ? undefined : allowanceUsage(group, "emails")).toBe(used);
  });

  it("keeps other accounts and other prefixes apart", () => {
    const groups = allowanceGroups([included, { ...used, external_account_id: "a2" }, { ...used, metric_key: "resend.emails.daily.used" }]);
    expect(groups.map((group) => `${group.accountId} ${group.prefix}`)).toEqual(["a1 resend.emails.monthly", "a2 resend.emails.monthly", "a1 resend.emails.daily"]);
  });

  it("picks the first usage by key in the allowance's unit that the caller accepts", () => {
    const [group] = allowanceGroups([
      included,
      { ...used, metric_key: "resend.emails.monthly.a", unit: "requests" },
      { ...used, metric_key: "resend.emails.monthly.c" },
      { ...used, metric_key: "resend.emails.monthly.b", value: null },
    ]);
    if (group === undefined) throw new Error("no group");
    expect(allowanceUsage(group, "emails")?.metric_key).toBe("resend.emails.monthly.b");
    expect(allowanceUsage(group, "emails", (row) => row.value !== null)?.metric_key).toBe("resend.emails.monthly.c");
    expect(allowanceUsage(group, "minutes")).toBeUndefined();
  });
});

describe("latestSnapshots", () => {
  it("prefers the later retrieval on the same day", () => {
    const early = money({ metric_key: "k.a", amount_minor: 1, currency: "USD", retrieved_at: "2026-10-15T01:00:00.000Z" });
    const late = { ...early, amount_minor: 2, retrieved_at: "2026-10-15T02:00:00.000Z" };
    expect(latestSnapshots([late, early]).map((row) => row.amount_minor)).toEqual([2]);
  });
});

describe("freshnessLabel", () => {
  it("labels stale values with when they were last updated", () => {
    expect(freshnessLabel("2026-10-15T07:00:00.000Z", true, NOW)).toBe("Stale: last updated 5 hours ago");
    expect(freshnessLabel("2026-10-15T11:00:00.000Z", false, NOW)).toBe("Updated 1 hour ago");
  });
});
