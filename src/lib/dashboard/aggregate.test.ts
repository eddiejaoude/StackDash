import { afterEach, describe, expect, it, vi } from "vitest";

import { SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";

import {
  aggregateDashboard,
  dropSupersededBreakdowns,
  freshnessLabel,
  hasSimulatedSource,
  isCurrentPeriod,
  isStale,
  latestSnapshots,
  percentUsed,
  type AccountInput,
  type ConnectionInput,
  type DashboardInput,
  type ProjectInput,
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
  return { snapshots, connections: [connection], accounts, projects, now: NOW, ...overrides };
}

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
          metric_key: "fake.cost.estimate",
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
          metric_key: "fake.cost.estimate",
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
      vi.stubEnv("DEVMACRO_SIMULATE_PROVIDERS", flag);
      const view = aggregateDashboard(mixed());
      expect(view.byProvider.map((summary) => [summary.connectionId, summary.simulated])).toEqual([
        ["c1", false],
        ["c2", true],
      ]);
    }
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
