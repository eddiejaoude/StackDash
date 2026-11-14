import { describe, expect, it } from "vitest";

import { declaredDailyTotals, declaredProjectedSpend } from "@/lib/adapters/registry";
import type { TrendMeasure } from "@/lib/dashboard/trends";

import {
  addUtcDays,
  ANOMALY_TYPE_ID,
  anomalyEvent,
  anomalySnapshotRange,
  checkedRows,
  detectSpike,
  findAnomalies,
  minimumChange,
  modifiedZScore,
  unusualWords,
  type AnomalyConnection,
  type AnomalyRow,
} from "./anomaly";

const USD: TrendMeasure = { type: "money", currency: "USD" };
const EMAILS: TrendMeasure = { type: "quantity", unit: "emails" };
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const VERCEL: AnomalyConnection = { id: "c0000000-0000-4000-8000-000000000001", provider: "vercel" };
const RESEND: AnomalyConnection = { id: "c0000000-0000-4000-8000-000000000002", provider: "resend" };
const ACCOUNT = "a0000000-0000-4000-8000-000000000001";
const DATE = "2026-10-20";

/** Runs detection on the last day of `series`, with every earlier day (up to 14) as history. */
function lastDay(series: readonly (number | null)[], measure: TrendMeasure = USD) {
  return detectSpike(series.slice(-15, -1), series.at(-1) ?? null, measure);
}

/** Detection with the adapters' declared projections and daily totals, as the daily summary job runs it. */
function anomaliesFor(input: Omit<Parameters<typeof findAnomalies>[0], "projectedSpend" | "dailyTotals">) {
  return findAnomalies({ ...input, projectedSpend: declaredProjectedSpend, dailyTotals: declaredDailyTotals });
}

/** Which days of `series` fire, checking each day against the 14 before it. */
function firingDays(series: readonly number[], measure: TrendMeasure = USD): number[] {
  const fired: number[] = [];
  for (let day = 0; day < series.length; day += 1) {
    if (detectSpike(series.slice(Math.max(0, day - 14), day), series[day] ?? null, measure) !== null) fired.push(day);
  }
  return fired;
}

describe("detectSpike", () => {
  it("never fires on a flat series, with or without small noise", () => {
    expect(firingDays(Array.from({ length: 30 }, () => 10_000))).toEqual([]);
    expect(firingDays(Array.from({ length: 30 }, (_, day) => 10_000 + ((day * 37) % 7) * 150))).toEqual([]);
    expect(firingDays(Array.from({ length: 30 }, () => 0))).toEqual([]);
  });

  it("fires once for a single spike, and a past spike does not hide the next one", () => {
    const series = Array.from({ length: 40 }, (_, day) => (day === 20 ? 40_000 : 10_000 + (day % 3) * 200));
    expect(firingDays(series)).toEqual([20]);
    const twoSpikes = series.map((value, day) => (day === 25 ? 40_000 : value));
    expect(firingDays(twoSpikes)).toEqual([20, 25]);
  });

  it("does not fire on a gradual ramp, linear or compounding", () => {
    expect(firingDays(Array.from({ length: 40 }, (_, day) => 10_000 + day * 500))).toEqual([]);
    expect(firingDays(Array.from({ length: 40 }, (_, day) => Math.round(10_000 * 1.08 ** day)))).toEqual([]);
  });

  it("does not fire on a weekly rhythm of quiet weekends", () => {
    expect(firingDays(Array.from({ length: 40 }, (_, day) => (day % 7 >= 5 ? 4_000 : 10_000)))).toEqual([]);
  });

  it("does not fire on a workspace active three days a week, where the median deviation is 0", () => {
    // Eight quiet days and six active ones: median 0, median absolute deviation 0. The score falls
    // back to the mean absolute deviation and stays at 1.86, under the cutoff.
    expect(firingDays(Array.from({ length: 40 }, (_, day) => (day % 7 >= 4 ? 30_000 : 0)))).toEqual([]);
    const window = [0, 0, 0, 0, 0, 0, 0, 0, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000];
    expect(modifiedZScore(window, 0, 30_000)).toBeCloseTo(1.862, 3);
  });

  it("still fires on a real spike when more than half the days share one amount", () => {
    // Ten weekdays at $103.00 and four weekend days at $41.00, then $412.00: the median deviation
    // is 0 and the mean deviation scores the day at 13.9.
    const window = [...Array.from({ length: 10 }, () => 10_300), ...Array.from({ length: 4 }, () => 4_100)];
    expect(modifiedZScore(window, 10_300, 41_200)).toBeCloseTo(13.92, 2);
    expect(lastDay([...window, 41_200])).toMatchObject({ value: 41_200, usual: 10_300, ratio: 4 });
  });

  it("scores a history with no spread at all as infinite, so the ratio and the minimum change decide", () => {
    expect(modifiedZScore(Array.from({ length: 14 }, () => 1000), 1000, 1001)).toBe(Number.POSITIVE_INFINITY);
  });

  it("needs at least 7 days of history: 6 never fire, 7 do", () => {
    expect(lastDay([1000, 1000, 1000, 1000, 1000, 1000, 9000])).toBeNull();
    expect(lastDay([1000, 1000, 1000, 1000, 1000, 1000, 1000, 9000])).toMatchObject({ value: 9000, usual: 1000, historyDays: 7 });
    // Unavailable days do not count toward the 7.
    expect(lastDay([1000, null, 1000, 1000, 1000, 1000, 1000, 1000, 9000])).toMatchObject({ historyDays: 7 });
    expect(lastDay([1000, null, null, 1000, 1000, 1000, 1000, 1000, 9000])).toBeNull();
  });

  it("never fires when the day itself is unavailable", () => {
    expect(lastDay([...Array.from({ length: 14 }, () => 1000), null])).toBeNull();
  });

  it("does not fire under the minimum change, and fires at exactly the minimum", () => {
    // $0.10 a day jumping to $4.99 is fifty times the usual and still not worth an alert.
    expect(lastDay([...Array.from({ length: 14 }, () => 10), 509])).toBeNull();
    expect(lastDay([...Array.from({ length: 14 }, () => 10), 510])).toMatchObject({ value: 510, usual: 10 });
    expect(lastDay([...Array.from({ length: 14 }, () => 5), 54], EMAILS)).toBeNull();
    expect(lastDay([...Array.from({ length: 14 }, () => 5), 55], EMAILS)).not.toBeNull();
  });

  it("needs at least twice the usual amount", () => {
    const history = Array.from({ length: 14 }, () => 100_000);
    expect(lastDay([...history, 199_999])).toBeNull();
    expect(lastDay([...history, 200_000])).toMatchObject({ ratio: 2 });
  });

  it("reports no ratio when the usual amount is zero", () => {
    expect(lastDay([...Array.from({ length: 14 }, () => 0), 600], EMAILS)).toMatchObject({ usual: 0, ratio: null });
  });
});

describe("minimumChange", () => {
  it("is five whole units of the currency, in its own minor digits", () => {
    expect(minimumChange(USD)).toBe(500);
    expect(minimumChange({ type: "money", currency: "JPY" })).toBe(5);
  });

  it("is 50 for counts and smaller for data sizes", () => {
    expect(minimumChange(EMAILS)).toBe(50);
    expect(minimumChange({ type: "quantity", unit: "GB" })).toBe(1);
  });
});

function row(fields: Partial<AnomalyRow> & Pick<AnomalyRow, "snapshot_date">): AnomalyRow {
  return {
    connection_id: VERCEL.id,
    external_account_id: ACCOUNT,
    metric_key: "vercel.spend.total",
    kind: "verified_spend",
    label: "Vercel billed spend, month to date",
    value: null,
    unit: null,
    amount_minor: null,
    currency: "USD",
    period_start: "2026-10-01T00:00:00.000Z",
    period_end: "2026-11-01T00:00:00.000Z",
    point_at: null,
    resets_at: null,
    retrieved_at: `${fields.snapshot_date}T23:59:50.000Z`,
    provenance_source: "provider_api",
    pricing_source: null,
    ...fields,
  };
}

/** Month to date rows from 2026-10-01 to DATE, adding `daily(day)` minor units each day. */
function monthToDate(daily: (date: string) => number, fields: Partial<AnomalyRow> = {}): AnomalyRow[] {
  const rows: AnomalyRow[] = [];
  let total = 0;
  for (let date = "2026-10-01"; date <= DATE; date = addUtcDays(date, 1)) {
    total += daily(date);
    rows.push(row({ snapshot_date: date, amount_minor: total, ...fields }));
  }
  return rows;
}

describe("findAnomalies", () => {
  const spikeOnDate = (date: string) => (date === DATE ? 40_000 : 10_000);

  it("turns a month to date total into daily amounts and names the spike", () => {
    const anomalies = anomaliesFor({ date: DATE, rows: monthToDate(spikeOnDate), connections: [VERCEL], mutes: [] });
    expect(anomalies).toEqual([
      expect.objectContaining({
        date: DATE,
        provider: "vercel",
        metricKey: "vercel.spend.total",
        value: 40_000,
        usual: 10_000,
        ratio: 4,
        source: "verified",
        accrual: "period_to_date",
        connectionId: VERCEL.id,
        externalAccountId: ACCOUNT,
      }),
    ]);
  });

  it("finds nothing on a normal day after the spike", () => {
    const rows = monthToDate((date) => (date === "2026-10-18" ? 40_000 : 10_000));
    expect(anomaliesFor({ date: DATE, rows, connections: [VERCEL], mutes: [] })).toEqual([]);
  });

  it("skips the first day of a period, where once a period charges land", () => {
    const rows = monthToDate(() => 10_000).map((snapshot) =>
      snapshot.snapshot_date === "2026-10-01" ? { ...snapshot, amount_minor: 90_000 } : snapshot,
    );
    expect(anomaliesFor({ date: "2026-10-01", rows, connections: [VERCEL], mutes: [] })).toEqual([]);
  });

  it("reads a running total whose period ends tomorrow, one day long on the 1st, as month to date", () => {
    const rows = monthToDate(spikeOnDate).map((snapshot) => ({
      ...snapshot,
      period_end: `${addUtcDays(snapshot.snapshot_date, 1)}T00:00:00.000Z`,
    }));
    const [anomaly] = anomaliesFor({ date: DATE, rows, connections: [VERCEL], mutes: [] });
    expect(anomaly).toMatchObject({ value: 40_000, usual: 10_000, accrual: "period_to_date" });
  });

  it("treats a running total that went down as unavailable, not as a spike the day after", () => {
    const rows = monthToDate(spikeOnDate).map((snapshot) =>
      snapshot.snapshot_date === addUtcDays(DATE, -1) ? { ...snapshot, amount_minor: 0 } : snapshot,
    );
    expect(anomaliesFor({ date: DATE, rows, connections: [VERCEL], mutes: [] })).toEqual([]);
  });

  /** Resend emails a day, one row per day for the 15 days to `last`, each stored the day after its own day. */
  function emailsPerDay(last: string, daily: (day: string) => number): AnomalyRow[] {
    return Array.from({ length: 15 }, (_, index) => {
      const day = addUtcDays(last, index - 14);
      return row({
        connection_id: RESEND.id,
        metric_key: "resend.emails.daily",
        kind: "usage",
        label: "Emails sent",
        currency: null,
        unit: "emails",
        value: daily(day),
        snapshot_date: addUtcDays(day, 1),
        period_start: `${day}T00:00:00.000Z`,
        period_end: `${addUtcDays(day, 1)}T00:00:00.000Z`,
      });
    });
  }

  it("checks a one day period on the day before the summarized day, dated by its own day", () => {
    // The summary for DATE + 1 runs before DATE + 1's row exists; DATE's row was stored on DATE + 1.
    const rows = emailsPerDay(DATE, (day) => (day === DATE ? 4000 : 1000));
    const anomalies = anomaliesFor({ date: addUtcDays(DATE, 1), rows, connections: [RESEND], mutes: [] });
    expect(anomalies).toEqual([expect.objectContaining({ date: DATE, value: 4000, usual: 1000, accrual: "daily", measure: EMAILS })]);
  });

  it("leaves a one day spike on the summarized day itself to the next day's summary", () => {
    const rows = emailsPerDay(DATE, (day) => (day === DATE ? 4000 : 1000));
    // The summary for DATE checks DATE - 1, an ordinary day, even though DATE's row is in the input.
    expect(anomaliesFor({ date: DATE, rows, connections: [RESEND], mutes: [] })).toEqual([]);
  });

  it("keeps verified and estimated values apart and labels which one fired", () => {
    const estimated = monthToDate(spikeOnDate, { kind: "estimated_spend", provenance_source: "derived", metric_key: "vercel.spend.estimate" });
    const verified = monthToDate(() => 10_000);
    const anomalies = anomaliesFor({ date: DATE, rows: [...verified, ...estimated], connections: [VERCEL], mutes: [] });
    expect(anomalies.map((anomaly) => [anomaly.metricKey, anomaly.source])).toEqual([["vercel.spend.estimate", "estimated"]]);
  });

  // PostHog's projected spend, Railway's estimated bill, and the Example provider's month estimate.
  it.each(declaredProjectedSpend)("never fires %s, a declared projection, alone or beside verified spend", (metricKey) => {
    // A re-estimate that jumps fourfold on the day, read as a running total over the month.
    const projection = monthToDate(spikeOnDate, { kind: "estimated_spend", provenance_source: "derived", metric_key: metricKey });
    expect(anomaliesFor({ date: DATE, rows: projection, connections: [VERCEL], mutes: [] })).toEqual([]);
    const verified = monthToDate(() => 10_000);
    expect(anomaliesFor({ date: DATE, rows: [...verified, ...projection], connections: [VERCEL], mutes: [] })).toEqual([]);
    // The same rows under an undeclared key fire, so the declaration is what keeps them quiet.
    const undeclared = findAnomalies({ date: DATE, rows: projection, connections: [VERCEL], mutes: [], projectedSpend: [], dailyTotals: declaredDailyTotals });
    expect(undeclared.map((anomaly) => [anomaly.metricKey, anomaly.source])).toEqual([[metricKey, "estimated"]]);
  });

  // GitHub's new stars per day feeds Trending; a launch day is not usage to warn about (#413).
  it.each(declaredDailyTotals)("never fires %s, a declared daily total, on a day of 100 times the usual", (metricKey) => {
    const github: AnomalyConnection = { id: "gh", provider: "github" };
    // 5 new stars a day, then 500 on DATE; each day's total is stored the day after its own day.
    const rows = Array.from({ length: 15 }, (_, index) => {
      const day = addUtcDays(DATE, index - 14);
      return row({
        connection_id: github.id,
        metric_key: metricKey,
        kind: "usage",
        label: "New stars over one UTC day",
        currency: null,
        unit: "stars",
        value: day === DATE ? 500 : 5,
        snapshot_date: addUtcDays(day, 1),
        period_start: `${day}T00:00:00.000Z`,
        period_end: `${addUtcDays(day, 1)}T00:00:00.000Z`,
      });
    });
    const summarized = addUtcDays(DATE, 1);
    expect(anomaliesFor({ date: summarized, rows, connections: [github], mutes: [] })).toEqual([]);
    // The same rows under an undeclared key fire, so the declaration is what keeps them quiet.
    const undeclared = findAnomalies({ date: summarized, rows, connections: [github], mutes: [], projectedSpend: declaredProjectedSpend, dailyTotals: [] });
    expect(undeclared.map((anomaly) => [anomaly.metricKey, anomaly.date, anomaly.value])).toEqual([[metricKey, DATE, 500]]);
  });

  it("never fires a breakdown beside its total or its parent", () => {
    const rows = [
      ...monthToDate(spikeOnDate),
      ...monthToDate(spikeOnDate, { metric_key: "vercel.spend.usage" }),
      ...monthToDate(spikeOnDate, { metric_key: "github.spend.actions", connection_id: "gh" }),
      ...monthToDate(spikeOnDate, { metric_key: "github.spend.actions.actions_linux", connection_id: "gh" }),
    ];
    const github: AnomalyConnection = { id: "gh", provider: "github" };
    const keys = anomaliesFor({ date: DATE, rows, connections: [VERCEL, github], mutes: [] }).map((anomaly) => anomaly.metricKey);
    expect(keys).toEqual(["github.spend.actions", "vercel.spend.total"]);
  });

  it("fires once for a GitHub product, not again for its day rows inside the month", () => {
    const github: AnomalyConnection = { id: "gh", provider: "github" };
    const month = monthToDate(spikeOnDate, { metric_key: "github.spend.actions", connection_id: github.id });
    // Each sync also stores one day of the same product, a one day window inside the month.
    const days = month.map((snapshot) =>
      row({
        connection_id: github.id,
        metric_key: "github.daily_spend.actions",
        label: "GitHub Actions spend, one day",
        snapshot_date: snapshot.snapshot_date,
        amount_minor: spikeOnDate(snapshot.snapshot_date),
        period_start: `${snapshot.snapshot_date}T00:00:00.000Z`,
        period_end: `${addUtcDays(snapshot.snapshot_date, 1)}T00:00:00.000Z`,
      }),
    );
    const anomalies = anomaliesFor({ date: DATE, rows: [...month, ...days], connections: [github], mutes: [] });
    expect(anomalies.map((anomaly) => anomaly.metricKey)).toEqual(["github.spend.actions"]);
    // Without the month, the day rows are the only source and fire on their own, one day period
    // series checked by the next day's summary.
    expect(anomaliesFor({ date: addUtcDays(DATE, 1), rows: days, connections: [github], mutes: [] })).toEqual([
      expect.objectContaining({ date: DATE, metricKey: "github.daily_spend.actions" }),
    ]);
  });

  it("keeps a month to date history whose later readings cover the earlier ones", () => {
    // Each reading's window ends when it was read, so a later one spans every earlier one; the
    // sub-window rule runs per snapshot date and must not drop the history.
    const rows = monthToDate(spikeOnDate).map((snapshot) => ({ ...snapshot, period_end: snapshot.retrieved_at }));
    expect(anomaliesFor({ date: DATE, rows, connections: [VERCEL], mutes: [] })).toEqual([
      expect.objectContaining({ metricKey: "vercel.spend.total", value: 40_000, usual: 10_000 }),
    ]);
  });

  it("skips muted metrics, allowances, point in time readings, and unknown connections", () => {
    const allowance = monthToDate(spikeOnDate, { kind: "included_allowance", metric_key: "vercel.allowance.included" });
    const point = monthToDate(spikeOnDate, { metric_key: "vercel.spend.point", period_start: null, period_end: null, point_at: `${DATE}T12:00:00.000Z` });
    const stranger = monthToDate(spikeOnDate, { connection_id: "unknown", metric_key: "vercel.spend.other" });
    expect(anomaliesFor({ date: DATE, rows: [...allowance, ...point, ...stranger], connections: [VERCEL], mutes: [] })).toEqual([]);
    expect(
      anomaliesFor({ date: DATE, rows: monthToDate(spikeOnDate), connections: [VERCEL], mutes: [{ provider: "vercel", metric_key: "vercel.spend.total" }] }),
    ).toEqual([]);
  });

  it("adds accounts up, and a missing account makes the day unavailable", () => {
    const other = "a0000000-0000-4000-8000-000000000002";
    const first = monthToDate(spikeOnDate);
    const second = monthToDate(() => 10_000, { external_account_id: other });
    const [anomaly] = anomaliesFor({ date: DATE, rows: [...first, ...second], connections: [VERCEL], mutes: [] });
    expect(anomaly).toMatchObject({ value: 50_000, usual: 20_000, externalAccountId: null, connectionId: VERCEL.id });
    const gap = second.filter((snapshot) => snapshot.snapshot_date !== DATE);
    expect(anomaliesFor({ date: DATE, rows: [...first, ...gap], connections: [VERCEL], mutes: [] })).toEqual([]);
  });
});

describe("checkedRows", () => {
  it("keeps only the rows detection checks: no breakdown beside its parent, no day inside its month", () => {
    const rows = [
      row({ snapshot_date: DATE, metric_key: "github.spend.actions", amount_minor: 1000 }),
      row({ snapshot_date: DATE, metric_key: "github.spend.actions.actions_linux", amount_minor: 900 }),
      row({
        snapshot_date: DATE,
        metric_key: "github.daily_spend.actions",
        amount_minor: 100,
        period_start: `${DATE}T00:00:00.000Z`,
        period_end: `${addUtcDays(DATE, 1)}T00:00:00.000Z`,
      }),
      row({ snapshot_date: DATE, metric_key: "vercel.allowance.included", kind: "included_allowance", amount_minor: 2000 }),
    ];
    expect(checkedRows(rows, declaredProjectedSpend, declaredDailyTotals).map((snapshot) => snapshot.metric_key)).toEqual(["github.spend.actions"]);
  });

  it("keeps a lone breakdown or day row when its parent or month is missing that day", () => {
    const day = row({
      snapshot_date: DATE,
      metric_key: "github.daily_spend.actions",
      amount_minor: 100,
      period_start: `${DATE}T00:00:00.000Z`,
      period_end: `${addUtcDays(DATE, 1)}T00:00:00.000Z`,
    });
    const month = row({ snapshot_date: addUtcDays(DATE, -1), metric_key: "github.spend.actions", amount_minor: 1000 });
    expect(checkedRows([month, day], declaredProjectedSpend, declaredDailyTotals).map((snapshot) => snapshot.metric_key)).toEqual([
      "github.spend.actions",
      "github.daily_spend.actions",
    ]);
  });

  it("leaves a declared projection out, so alert settings never offers to mute it (#223)", () => {
    const spent = row({ snapshot_date: DATE, metric_key: "posthog.spend.current", amount_minor: 0 });
    const projected = row({ snapshot_date: DATE, metric_key: "posthog.spend.projected", kind: "estimated_spend", amount_minor: 2986 });
    expect(checkedRows([spent, projected], declaredProjectedSpend, declaredDailyTotals).map((snapshot) => snapshot.metric_key)).toEqual(["posthog.spend.current"]);
    expect(checkedRows([projected], declaredProjectedSpend, declaredDailyTotals)).toEqual([]);
  });

  it("leaves a declared daily total out, so alert settings never offers to mute new stars, and keeps daily signups", () => {
    // Only GitHub declares one; PostHog's daily signups are `signupDailyTotals` and stay checked.
    expect(declaredDailyTotals).toEqual(["github.stars.gained.daily"]);
    const stars = row({
      snapshot_date: DATE,
      metric_key: "github.stars.gained.daily",
      kind: "usage",
      currency: null,
      unit: "stars",
      value: 12,
      period_start: `${addUtcDays(DATE, -1)}T00:00:00.000Z`,
      period_end: `${DATE}T00:00:00.000Z`,
    });
    const signups = { ...stars, metric_key: "posthog.signups.daily", unit: "signups" };
    expect(checkedRows([stars, signups], declaredProjectedSpend, declaredDailyTotals).map((snapshot) => snapshot.metric_key)).toEqual([
      "posthog.signups.daily",
    ]);
  });
});

describe("anomaly event", () => {
  const [anomaly] = anomaliesFor({
    date: DATE,
    rows: monthToDate((date) => (date === DATE ? 41_200 : 10_300)),
    connections: [VERCEL],
    mutes: [],
  });
  if (anomaly === undefined) throw new Error("expected an anomaly");

  it("names the provider, the metric, the day's value, the usual value, and what to do next", () => {
    const event = anomalyEvent(WORKSPACE_ID, anomaly);
    expect(event).toMatchObject({
      workspace_id: WORKSPACE_ID,
      provider: "vercel",
      connection_id: VERCEL.id,
      type_id: ANOMALY_TYPE_ID,
      severity: "warning",
      title: "Unusual spend on Vercel: 4 times the usual daily spend",
      occurred_at: "2026-10-21T00:00:00.000Z",
      dedupe_key: "anomaly:2026-10-20:vercel:vercel.spend.total:money:USD:verified",
    });
    expect(event.body).toBe(
      [
        "Vercel billed spend, month to date (verified) went up by $412.00 on 2026-10-20. The usual amount is $103.00 a day, the median of the 14 days before.",
        "What to do next: open Vercel to see what drove it, check the timeline for deploys on 2026-10-20, or mute this metric in alert settings if it was expected.",
      ].join("\n"),
    );
    expect(`${event.title} ${event.body}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("words the ratio plainly at its edges", () => {
    expect(unusualWords({ ratio: 2.54, usual: 100, measure: USD })).toBe("2.5 times the usual daily spend");
    expect(unusualWords({ ratio: 12.6, usual: 100, measure: EMAILS })).toBe("13 times the usual daily usage");
    expect(unusualWords({ ratio: null, usual: 0, measure: USD })).toBe("up from a usual $0.00 a day");
  });

  it("loads one day before a running total's window, through the summarized day", () => {
    expect(anomalySnapshotRange(DATE)).toEqual({ from: "2026-10-05", to: "2026-10-20" });
  });
});
