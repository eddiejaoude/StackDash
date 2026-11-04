import { describe, expect, it } from "vitest";

import { SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";

import {
  buildTrends,
  comparisonText,
  compareToPrevious,
  TREND_DAYS,
  TREND_MONTHS,
  trendBuckets,
  trendSummary,
  trendWindowStart,
  type TrendConnection,
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
