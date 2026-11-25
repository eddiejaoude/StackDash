import { describe, expect, it } from "vitest";

import { SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";

import { snapshotWindowStart, type SnapshotInput } from "./aggregate";
import {
  buildTrends,
  canonicalExpanded,
  comparisonText,
  compareToPrevious,
  defaultSeriesKeys,
  groupTrends,
  toggleExpanded,
  TREND_DAYS,
  TREND_MONTHS,
  trendBuckets,
  trendCompleteFrom,
  trendSummary,
  trendWindowStart,
  type TrendConnection,
  type TrendGranularity,
  type TrendPoint,
  type TrendRow,
} from "./trends";

// Mid January, so the 13 month window and the 30 day window both cross a year boundary.
const NOW = new Date("2026-01-15T12:00:00.000Z");
const connections: TrendConnection[] = [{ id: "c1", provider: "fake", granted_scopes: ["usage:read"] }];

function spend(overrides: Partial<TrendRow> & Pick<TrendRow, "snapshot_date" | "amount_minor">): TrendRow {
  return {
    connection_id: "c1",
    external_account_id: "a1",
    metric_key: "fake.spend.month",
    kind: "verified_spend",
    label: "Spend this month",
    value: null,
    unit: null,
    currency: "USD",
    retrieved_at: `${overrides.snapshot_date}T10:00:00.000Z`,
    provenance_source: "provider_api",
    ...overrides,
  };
}

function point(bucket: string, value: number | null): TrendPoint {
  return { bucket, value, estimated: false };
}

function daily(rows: TrendRow[]) {
  return buildTrends(rows, connections, "daily", NOW);
}

function valueOn(rows: TrendRow[], bucket: string, granularity: "daily" | "monthly" = "daily") {
  const [series] = buildTrends(rows, connections, granularity, NOW);
  return series?.points.find((entry) => entry.bucket === bucket);
}

describe("trendBuckets and trendWindowStart", () => {
  it("lists 13 months oldest first across the year boundary", () => {
    const months = trendBuckets("monthly", NOW);
    expect(months).toHaveLength(TREND_MONTHS);
    expect(months[0]).toBe("2025-01");
    expect(months.slice(-2)).toEqual(["2025-12", "2026-01"]);
    expect(trendWindowStart(NOW)).toBe("2025-01-01");
  });

  it("lists 30 UTC days ending today", () => {
    const days = trendBuckets("daily", NOW);
    expect(days).toHaveLength(TREND_DAYS);
    expect(days[0]).toBe("2025-12-17");
    expect(days.at(-1)).toBe("2026-01-15");
  });

  it("uses the UTC date just before and after midnight", () => {
    expect(trendBuckets("daily", new Date("2026-01-15T23:59:59.999Z")).at(-1)).toBe("2026-01-15");
    expect(trendBuckets("daily", new Date("2026-01-16T00:00:00.000Z")).at(-1)).toBe("2026-01-16");
  });
});

describe("trendCompleteFrom (#336)", () => {
  it.each<TrendGranularity>(["daily", "monthly"])("%s: a whole read leaves the chart whole", (granularity) => {
    expect(trendCompleteFrom(null, granularity, NOW)).toBeNull();
  });

  // The daily chart runs from 2025-12-17 to 2026-01-15.
  it.each([
    { case: "a day inside the chart", completeFrom: "2026-01-02", expected: "2026-01-02" },
    { case: "the chart's second day, so its first is partial", completeFrom: "2025-12-18", expected: "2025-12-18" },
    { case: "the chart's first day, so every day shown is whole", completeFrom: "2025-12-17", expected: null },
    { case: "a day before the chart", completeFrom: "2025-12-01", expected: null },
  ])("daily: $case", ({ completeFrom, expected }) => {
    expect(trendCompleteFrom(completeFrom, "daily", NOW)).toBe(expected);
  });

  // The monthly chart runs from January 2025 to January 2026.
  it.each([
    { case: "mid month, so that month is partial and the next is the first whole one", completeFrom: "2025-06-15", expected: "2025-07-01" },
    { case: "a month's first day, so the month before it is the partial one", completeFrom: "2025-06-01", expected: "2025-06-01" },
    { case: "the last day of a year", completeFrom: "2025-12-31", expected: "2026-01-01" },
    { case: "the chart's second day, so its first month is partial", completeFrom: "2025-01-02", expected: "2025-02-01" },
    { case: "the chart's first day, so every month shown is whole", completeFrom: "2025-01-01", expected: null },
  ])("monthly: $case", ({ completeFrom, expected }) => {
    expect(trendCompleteFrom(completeFrom, "monthly", NOW)).toBe(expected);
  });
});

describe("buildTrends month bucketing", () => {
  it("puts December 31 and January 1 in different months", () => {
    const rows = [spend({ snapshot_date: "2025-12-31", amount_minor: 900 }), spend({ snapshot_date: "2026-01-01", amount_minor: 10 })];
    expect(valueOn(rows, "2025-12", "monthly")?.value).toBe(900);
    expect(valueOn(rows, "2026-01", "monthly")?.value).toBe(10);
  });

  it("takes each account's latest value in the month", () => {
    const rows = [spend({ snapshot_date: "2025-12-31", amount_minor: 900 }), spend({ snapshot_date: "2025-12-10", amount_minor: 500 })];
    expect(valueOn(rows, "2025-12", "monthly")?.value).toBe(900);
  });
});

describe("buildTrends simulated series (#131)", () => {
  const simulated: TrendConnection = { id: "c2", provider: "fake", granted_scopes: [SIMULATED_SCOPE] };
  const both = [...connections, simulated];

  it("marks a series simulated when a simulated connection contributes a point, even beside a real one", () => {
    const rows = [
      spend({ snapshot_date: "2026-01-15", amount_minor: 100 }),
      spend({ connection_id: "c2", external_account_id: "a2", snapshot_date: "2026-01-15", amount_minor: 50 }),
    ];
    const [series, ...rest] = buildTrends(rows, both, "daily", NOW);
    expect(rest).toEqual([]);
    expect(series?.simulated).toBe(true);
    expect(series?.points.at(-1)?.value).toBe(150);
  });

  it("leaves a series of real connections unmarked", () => {
    const [series] = buildTrends([spend({ snapshot_date: "2026-01-15", amount_minor: 100 })], both, "daily", NOW);
    expect(series?.simulated).toBe(false);
  });
});

describe("buildTrends gaps", () => {
  it("shows a missing day as unavailable, never zero", () => {
    const rows = [spend({ snapshot_date: "2026-01-13", amount_minor: 100 }), spend({ snapshot_date: "2026-01-15", amount_minor: 300 })];
    expect(valueOn(rows, "2026-01-14")).toEqual({ bucket: "2026-01-14", value: null, estimated: false });
    expect(valueOn(rows, "2026-01-12")?.value).toBeNull();
    expect(valueOn(rows, "2026-01-15")?.value).toBe(300);
  });

  it("does not show a partial sum when one account is missing a day", () => {
    const rows = [
      spend({ snapshot_date: "2026-01-14", amount_minor: 100 }),
      spend({ snapshot_date: "2026-01-14", amount_minor: 50, external_account_id: "a2" }),
      spend({ snapshot_date: "2026-01-15", amount_minor: 200 }),
    ];
    expect(valueOn(rows, "2026-01-14")?.value).toBe(150);
    expect(valueOn(rows, "2026-01-15")?.value).toBeNull();
  });

  it("does not count days before an account first reported as gaps", () => {
    const rows = [
      spend({ snapshot_date: "2026-01-14", amount_minor: 100 }),
      spend({ snapshot_date: "2026-01-15", amount_minor: 200 }),
      spend({ snapshot_date: "2026-01-15", amount_minor: 5, external_account_id: "a2" }),
    ];
    expect(valueOn(rows, "2026-01-14")?.value).toBe(100);
    expect(valueOn(rows, "2026-01-15")?.value).toBe(205);
  });

  it("leaves out a series with no value in the window and rows of unknown connections", () => {
    expect(daily([spend({ snapshot_date: "2025-06-01", amount_minor: 1 })])).toEqual([]);
    expect(daily([spend({ snapshot_date: "2026-01-15", amount_minor: 1, connection_id: "other" })])).toEqual([]);
  });
});

describe("buildTrends accounts that stopped reporting (#308)", () => {
  // The dashboard's window, the first date the daily trend reads, starts on the 1st for NOW and
  // inside a month for END_OF_JANUARY, so a rule that only compared months would fail one of them.
  const END_OF_JANUARY = new Date("2026-01-31T12:00:00.000Z");

  /** a1 reports every month through `today`; a2 starts in October and last reports on `a2Last`. */
  function rowsWithA2LastOn(a2Last: string, today = "2026-01-15"): TrendRow[] {
    return [
      spend({ snapshot_date: "2025-10-31", amount_minor: 80 }),
      spend({ snapshot_date: "2025-11-30", amount_minor: 90 }),
      spend({ snapshot_date: "2025-12-31", amount_minor: 95 }),
      spend({ snapshot_date: today, amount_minor: 100 }),
      spend({ snapshot_date: "2025-10-20", amount_minor: 50, external_account_id: "a2" }),
      spend({ snapshot_date: a2Last, amount_minor: 40, external_account_id: "a2" }),
    ];
  }

  /** A bucket's value, or null when it is unavailable or the series is left out for having none. */
  function at(rows: TrendRow[], bucket: string, granularity: "daily" | "monthly", now: Date): number | null {
    return buildTrends(rows, connections, granularity, now)[0]?.points.find((entry) => entry.bucket === bucket)?.value ?? null;
  }

  it.each([
    ["the day before a window that starts on the 1st: stopped", NOW, "2025-12-01", "2025-11-30", 100],
    ["the first day of a window that starts on the 1st: still reporting", NOW, "2025-12-01", "2025-12-01", null],
    ["the day before a window that starts mid-month: stopped", END_OF_JANUARY, "2025-12-17", "2025-12-16", 100],
    ["the first day of a window that starts mid-month: still reporting", END_OF_JANUARY, "2025-12-17", "2025-12-17", null],
  ])("agrees in both views when the account's last row is on %s", (_title, now, windowStart, a2Last, expected) => {
    expect(snapshotWindowStart(now)).toBe(windowStart);
    const today = now.toISOString().slice(0, 10);
    const rows = rowsWithA2LastOn(a2Last, today);
    const loadedDaily = rows.filter((row) => row.snapshot_date >= windowStart);
    expect(at(loadedDaily, today, "daily", now)).toBe(expected);
    // Rows older than the window would change nothing, so the daily read may leave them out.
    expect(at(rows, today, "daily", now)).toBe(expected);
    expect(at(rows, today.slice(0, 7), "monthly", now)).toBe(expected);
  });

  it.each([
    ["the month's last day", "2025-11-30"],
    ["the month's first day", "2025-11-01"],
  ])("still counts a stopped account in the month of its last row, on %s, and not after it", (_title, a2Last) => {
    const rows = rowsWithA2LastOn(a2Last);
    expect(at(rows, "2025-10", "monthly", NOW)).toBe(130);
    expect(at(rows, "2025-11", "monthly", NOW)).toBe(130);
    expect(at(rows, "2025-12", "monthly", NOW)).toBe(95);
  });

  it("keeps a stopped account's missing month inside its reporting span unavailable", () => {
    const rows = rowsWithA2LastOn("2025-11-30").filter((row) => !(row.external_account_id === "a2" && row.snapshot_date === "2025-10-20"));
    rows.push(spend({ snapshot_date: "2025-09-15", amount_minor: 30, external_account_id: "a2" }));
    expect(at(rows, "2025-10", "monthly", NOW)).toBeNull();
  });
});

describe("buildTrends series", () => {
  it("keeps each currency in its own series and never adds them", () => {
    const series = daily([
      spend({ snapshot_date: "2026-01-15", amount_minor: 100, currency: "USD" }),
      spend({ snapshot_date: "2026-01-15", amount_minor: 70, currency: "EUR", external_account_id: "a2" }),
    ]);
    expect(series.map((entry) => [entry.measure, entry.points.at(-1)?.value])).toEqual([
      [{ type: "money", currency: "EUR" }, 70],
      [{ type: "money", currency: "USD" }, 100],
    ]);
  });

  it("keeps each unit in its own series", () => {
    const usage = (unit: string, account: string): TrendRow =>
      spend({ snapshot_date: "2026-01-15", amount_minor: null, currency: null, kind: "usage", value: 3, unit, external_account_id: account, metric_key: "fake.usage" });
    expect(daily([usage("GB", "a1"), usage("requests", "a2")]).map((entry) => entry.measure)).toEqual([
      { type: "quantity", unit: "GB" },
      { type: "quantity", unit: "requests" },
    ]);
  });

  it("flags a point as estimated when any row behind it is estimated", () => {
    const rows = [
      spend({ snapshot_date: "2026-01-14", amount_minor: 100 }),
      spend({ snapshot_date: "2026-01-15", amount_minor: 100 }),
      spend({ snapshot_date: "2026-01-15", amount_minor: 40, external_account_id: "a2", provenance_source: "derived" }),
    ];
    expect(valueOn(rows, "2026-01-14")?.estimated).toBe(false);
    expect(valueOn(rows, "2026-01-15")).toEqual({ bucket: "2026-01-15", value: 140, estimated: true });
    const estimate = spend({ snapshot_date: "2026-01-15", amount_minor: 1, kind: "estimated_spend", metric_key: "fake.cost.estimate" });
    expect(valueOn([estimate], "2026-01-15")?.estimated).toBe(true);
  });
});

describe("compareToPrevious and comparisonText", () => {
  const usd = { type: "money", currency: "USD" } as const;

  it("reports the percent change from the previous period", () => {
    const comparison = compareToPrevious([point("2025-12", 10_000), point("2026-01", 11_200)]);
    expect(comparison).toMatchObject({ status: "change", direction: "up", previous: 10_000 });
    expect(comparison.status === "change" ? comparison.percent : null).toBeCloseTo(12);
    expect(comparisonText(comparison, usd, "monthly")).toBe("Up 12 percent from last month");
    expect(comparisonText(compareToPrevious([point("a", 200), point("b", 150)]), usd, "daily")).toBe(
      "Down 25 percent from the previous day",
    );
  });

  it("says less than 1 percent instead of 0 percent for a tiny change", () => {
    expect(comparisonText(compareToPrevious([point("a", 1_000), point("b", 1_001)]), usd, "monthly")).toBe(
      "Up less than 1 percent from last month",
    );
  });

  it("gives no percent when the previous value is zero", () => {
    const comparison = compareToPrevious([point("a", 0), point("b", 500)]);
    expect(comparison).toEqual({ status: "change", direction: "up", percent: null, previous: 0 });
    expect(comparisonText(comparison, usd, "monthly")).toBe("Up from $0.00 last month");
    expect(comparisonText(compareToPrevious([point("a", 0), point("b", 0)]), usd, "monthly")).toBe("No change from last month");
  });

  it("gives no comparison when either period is unavailable", () => {
    expect(compareToPrevious([point("a", null), point("b", 5)])).toEqual({ status: "unavailable", missing: "previous" });
    expect(compareToPrevious([point("a", 5), point("b", null)])).toEqual({ status: "unavailable", missing: "current" });
    expect(compareToPrevious([point("b", 5)])).toEqual({ status: "unavailable", missing: "previous" });
    expect(comparisonText({ status: "unavailable", missing: "previous" }, usd, "monthly")).toBe(
      "No comparison: last month is unavailable",
    );
  });
});

describe("trendSummary", () => {
  it("names the series, its range, the comparison, the gaps, and estimates", () => {
    const [series] = daily([
      spend({ snapshot_date: "2026-01-13", amount_minor: 100 }),
      spend({ snapshot_date: "2026-01-14", amount_minor: 110, provenance_source: "derived" }),
      spend({ snapshot_date: "2026-01-15", amount_minor: 121 }),
    ]);
    expect(series === undefined ? "" : trendSummary(series)).toBe(
      "Spend this month (Example provider, USD), last 30 days. From $1.00 on 2026-01-13 to $1.21 on 2026-01-15. Up 10 percent from the previous day. 27 days unavailable. Includes estimated values.",
    );
  });
});

describe("defaultSeriesKeys and groupTrends (#263, option A2)", () => {
  const PROJECTED = ["fake.cost.estimate"];
  const twoProviders: TrendConnection[] = [
    { id: "c1", provider: "vercel", granted_scopes: [] },
    { id: "c2", provider: "resend", granted_scopes: [] },
  ];

  /** A money row for this month so far, read on NOW's day, on the Vercel connection. */
  function row(overrides: Partial<SnapshotInput> & Pick<SnapshotInput, "metric_key">): SnapshotInput {
    return {
      connection_id: "c1",
      external_account_id: "a1",
      kind: "verified_spend",
      label: overrides.metric_key,
      snapshot_date: "2026-01-15",
      value: null,
      unit: null,
      amount_minor: 100,
      currency: "USD",
      period_start: "2026-01-01T00:00:00.000Z",
      period_end: "2026-02-01T00:00:00.000Z",
      point_at: null,
      resets_at: null,
      retrieved_at: "2026-01-15T10:00:00.000Z",
      provenance_source: "provider_api",
      pricing_source: null,
      ...overrides,
    };
  }

  /** Each provider's default and other metric keys, in display order. */
  function split(rows: SnapshotInput[], connectionList: TrendConnection[] = twoProviders) {
    const series = buildTrends(rows, connectionList, "daily", NOW);
    return groupTrends(series, defaultSeriesKeys(rows, connectionList, PROJECTED, NOW)).map(({ provider, defaults, more }) => ({
      provider,
      defaults: defaults.map((entry) => entry.metricKey),
      more: more.map((entry) => entry.metricKey),
    }));
  }

  it("shows spend and revenue by default and leaves usage for the disclosure", () => {
    expect(
      split([
        row({ metric_key: "vercel.spend.total" }),
        row({ metric_key: "vercel.revenue", kind: "revenue" }),
        row({ metric_key: "vercel.estimate", kind: "estimated_spend", provenance_source: "derived" }),
        row({ metric_key: "vercel.requests", kind: "usage", amount_minor: null, currency: null, value: 5, unit: "requests" }),
      ]),
    ).toEqual([{ provider: "vercel", defaults: ["vercel.estimate", "vercel.revenue", "vercel.spend.total"], more: ["vercel.requests"] }]);
  });

  it("opens nothing by default for a provider with only usage series", () => {
    const usage = (metric: string) =>
      row({ connection_id: "c2", metric_key: metric, kind: "usage", amount_minor: null, currency: null, value: 3, unit: "emails" });
    const allowance = row({ connection_id: "c2", metric_key: "resend.quota", kind: "included_allowance", amount_minor: null, currency: null, value: 3_000, unit: "emails" });
    expect(split([usage("resend.sent"), allowance])).toEqual([{ provider: "resend", defaults: [], more: ["resend.quota", "resend.sent"] }]);
  });

  it("shows a total and leaves its breakdowns, SKUs, and days for the disclosure", () => {
    expect(
      split([
        row({ metric_key: "vercel.spend.total" }),
        row({ metric_key: "vercel.spend.builds", label: "a builds" }),
        row({ metric_key: "github.spend.actions", label: "b product" }),
        row({ metric_key: "github.spend.actions.actions_linux", label: "c sku" }),
        row({ metric_key: "github.daily_spend.actions", label: "d day", period_start: "2026-01-15T00:00:00.000Z", period_end: "2026-01-16T00:00:00.000Z" }),
      ]),
    ).toEqual([
      {
        provider: "vercel",
        defaults: ["github.spend.actions", "vercel.spend.total"],
        more: ["vercel.spend.builds", "github.spend.actions.actions_linux", "github.daily_spend.actions"],
      },
    ]);
  });

  it("keeps a breakdown that is another account's only figure", () => {
    const keys = split([row({ metric_key: "vercel.spend.total" }), row({ metric_key: "vercel.spend.builds", external_account_id: "a2" })]);
    expect(keys[0]?.defaults).toEqual(["vercel.spend.builds", "vercel.spend.total"]);
  });

  it("opens nothing by default for a provider whose only money is a declared projection", () => {
    const projection = row({ metric_key: "fake.cost.estimate", kind: "estimated_spend", provenance_source: "derived" });
    expect(split([projection], connections)).toEqual([{ provider: "fake", defaults: [], more: ["fake.cost.estimate"] }]);
  });

  it("leaves a finished period and a rolling window for the disclosure", () => {
    const invoice = row({ metric_key: "vercel.invoice", period_start: "2025-12-01T00:00:00.000Z", period_end: "2026-01-01T00:00:00.000Z" });
    const rolling = row({ metric_key: "vercel.last_30_days", kind: "revenue", period_start: "2025-12-16T10:00:00.000Z", period_end: "2026-01-15T10:00:00.000Z" });
    // A point in time value counts as current, so it stays in the default set.
    const balance = row({ metric_key: "vercel.point", period_start: null, period_end: null, point_at: "2026-01-15T10:00:00.000Z" });
    expect(split([invoice, rolling, balance])).toEqual([{ provider: "vercel", defaults: ["vercel.point"], more: ["vercel.invoice", "vercel.last_30_days"] }]);
  });

  it.each([1, 2, 14])("picks the same default set from %i days of the same metrics", (days) => {
    const rows = Array.from({ length: days }, (_, index) => {
      const date = `2026-01-${String(15 - index).padStart(2, "0")}`;
      const read = { snapshot_date: date, retrieved_at: `${date}T10:00:00.000Z` };
      return [
        row({ ...read, metric_key: "github.spend.actions", label: "a product" }),
        row({ ...read, metric_key: "github.spend.actions.actions_linux", label: "b sku" }),
        row({ ...read, metric_key: "github.daily_spend.actions", label: "c day", period_start: `${date}T00:00:00.000Z`, period_end: `${date}T23:59:59.000Z` }),
      ];
    }).flat();
    expect(split(rows)).toEqual([
      { provider: "vercel", defaults: ["github.spend.actions"], more: ["github.spend.actions.actions_linux", "github.daily_spend.actions"] },
    ]);
  });

  it("returns nothing for no rows, and ignores rows of unknown connections", () => {
    expect(defaultSeriesKeys([], twoProviders, PROJECTED, NOW).size).toBe(0);
    expect(groupTrends([], new Set())).toEqual([]);
    expect(defaultSeriesKeys([row({ metric_key: "x.spend", connection_id: "gone" })], twoProviders, PROJECTED, NOW).size).toBe(0);
  });

  it("groups providers in the order buildTrends sorted them", () => {
    const rows = [row({ metric_key: "resend.spend", connection_id: "c2" }), row({ metric_key: "vercel.spend.total" })];
    expect(split(rows).map((group) => group.provider)).toEqual(["resend", "vercel"]);
  });
});

describe("toggleExpanded and canonicalExpanded", () => {
  it("opens and closes one provider, keeping the rest sorted", () => {
    expect(toggleExpanded(["vercel"], "github")).toEqual(["github", "vercel"]);
    expect(toggleExpanded(["github", "vercel"], "github")).toEqual(["vercel"]);
  });

  it("drops duplicates, and closing the last provider leaves an empty list", () => {
    expect(canonicalExpanded(["vercel", "github", "vercel"])).toEqual(["github", "vercel"]);
    expect(toggleExpanded(["github"], "github")).toEqual([]);
    expect(canonicalExpanded([])).toEqual([]);
  });
});
