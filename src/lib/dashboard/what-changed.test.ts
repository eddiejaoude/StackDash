import { describe, expect, it } from "vitest";

import { declaredDailyTotals, declaredProjectedSpend } from "@/lib/adapters/registry";
import { addUtcDays, type Anomaly, type AnomalyConnection, type AnomalyRow } from "@/lib/alerts/anomaly";
import type { ConnectionInput } from "@/lib/dashboard/aggregate";
import { EMPTY_SCOPE } from "@/lib/filters/scope";

import type { EventBucketCount } from "./markers";
import { recentAnomalies, WHAT_CHANGED_LIMIT, whatChanged } from "./what-changed";

const TIMELINE = "/w/acme/timeline";
type Connection = AnomalyConnection & Pick<ConnectionInput, "status">;

const VERCEL: Connection = { id: "c0000000-0000-4000-8000-000000000001", provider: "vercel", status: "active" };
const RESEND: Connection = { id: "c0000000-0000-4000-8000-000000000002", provider: "resend", status: "active" };
const ACCOUNT = "a0000000-0000-4000-8000-000000000001";
// A Tuesday in November (GMT), so "yesterday" is Monday 2026-11-09.
const NOW = new Date("2026-11-10T12:00:00.000Z");
const TODAY = "2026-11-10";

function anomaly(fields: Partial<Anomaly> = {}): Anomaly {
  return {
    date: "2026-11-08",
    provider: "vercel",
    metricKey: "vercel.spend.total",
    label: "Billed spend, month to date",
    measure: { type: "money", currency: "USD" },
    source: "verified",
    accrual: "period_to_date",
    value: 41_200,
    usual: 10_300,
    ratio: 4,
    historyDays: 14,
    connectionId: VERCEL.id,
    externalAccountId: ACCOUNT,
    ...fields,
  };
}

function count(fields: Partial<EventBucketCount> = {}): EventBucketCount {
  return { provider: "vercel", category: "deployments", bucket: "2026-11-08", count: 14, ...fields };
}

const link = { timelinePath: TIMELINE, scope: EMPTY_SCOPE };

describe("whatChanged", () => {
  it("has no sentences when nothing was unusual (boundary: none)", () => {
    expect(whatChanged([], [count()], link)).toEqual({ sentences: [], total: 0 });
  });

  it("names the metric, the size of the change, the days compared, and its provenance, and links to the provider's day (one)", () => {
    const { sentences, total } = whatChanged([anomaly()], [count()], link);
    expect(total).toBe(1);
    expect(sentences).toEqual([
      {
        key: "anomaly:2026-11-08:vercel:vercel.spend.total:money:USD:verified",
        text:
          "Vercel: Billed spend, month to date (verified) went up by $412.00 on Sunday, 2026-11-08, 4 times the usual $103.00 a day " +
          "(the median of the 14 days from 2026-10-25 to 2026-11-07), with 14 deployments that day.",
        linkText: "Show Vercel events on 2026-11-08",
        href: `${TIMELINE}?from=2026-11-08&to=2026-11-08&provider=vercel`,
      },
    ]);
  });

  it("keeps the three newest, biggest first within a day, and counts the rest (many: more than three)", () => {
    const input = [
      anomaly({ date: "2026-11-05", metricKey: "a.oldest", label: "Oldest" }),
      anomaly({ date: "2026-11-08", metricKey: "b.smaller", label: "Smaller", ratio: 2.5 }),
      anomaly({ date: "2026-11-09", metricKey: "c.newest", label: "Newest", ratio: 2 }),
      anomaly({ date: "2026-11-08", metricKey: "d.from_zero", label: "From zero", ratio: null, usual: 0 }),
      anomaly({ date: "2026-11-08", metricKey: "e.bigger", label: "Bigger", ratio: 6 }),
    ];
    const { sentences, total } = whatChanged(input, [], link);
    expect(total).toBe(5);
    expect(sentences).toHaveLength(WHAT_CHANGED_LIMIT);
    // Newest day first; on one day a rise from zero, then the larger ratio.
    expect(sentences.map((sentence) => sentence.key.split(":")[3])).toEqual(["c.newest", "d.from_zero", "e.bigger"]);
  });

  it("keeps all of exactly three (boundary: the limit)", () => {
    const input = [1, 2, 3].map((day) => anomaly({ date: `2026-11-0${day}`, metricKey: `m.${day}` }));
    const { sentences, total } = whatChanged(input, [], link);
    expect(total).toBe(3);
    expect(sentences.map((sentence) => sentence.key.split(":")[1])).toEqual(["2026-11-03", "2026-11-02", "2026-11-01"]);
  });

  it("breaks ties on the same day and size by provider name, then label, then source", () => {
    const input = [
      anomaly({ provider: "vercel", label: "B", source: "verified" }),
      anomaly({ provider: "vercel", label: "B", source: "estimated" }),
      anomaly({ provider: "vercel", label: "A" }),
      anomaly({ provider: "resend", label: "Z", measure: { type: "quantity", unit: "emails" } }),
    ];
    const { sentences } = whatChanged(input, [], link);
    expect(sentences.map((sentence) => sentence.text.slice(0, sentence.text.indexOf(")") + 1))).toEqual([
      "Resend: Z (verified)",
      "Vercel: A (verified)",
      "Vercel: B (estimated)",
    ]);
  });

  it("names only the provider's own events of that day, in category order", () => {
    const events = [
      count({ category: "payments", count: 1 }),
      count({ category: "deployments", count: 3 }),
      count({ category: "deployments", count: 9, bucket: "2026-11-07" }),
      count({ category: "deployments", count: 5, provider: "github" }),
      count({ category: "alerts", count: 2, provider: null }),
    ];
    const [sentence] = whatChanged([anomaly()], events, link).sentences;
    // The comparison stays beside the amount, so it is never read as being about the events.
    expect(sentence?.text).toBe(
      "Vercel: Billed spend, month to date (verified) went up by $412.00 on Sunday, 2026-11-08, 4 times the usual $103.00 a day " +
        "(the median of the 14 days from 2026-10-25 to 2026-11-07), with 3 deployments and 1 payment that day.",
    );
  });

  it("leaves the events out when the day had none", () => {
    const [sentence] = whatChanged([anomaly()], [count({ bucket: "2026-11-07" })], link).sentences;
    expect(sentence?.text).toMatch(/2026-11-07\)\.$/);
    expect(sentence?.text).not.toContain("that day");
  });

  it.each([
    {
      name: "a day's own amount says was",
      fields: { accrual: "daily", value: 900, usual: 200, ratio: 4.5, measure: { type: "quantity", unit: "requests" } },
      expected: "was 900 requests on Sunday, 2026-11-08, 4.5 times the usual 200 requests a day (the median",
    },
    {
      name: "a usual of zero has no ratio",
      fields: { usual: 0, ratio: null, value: 1_000 },
      expected: "went up by $10.00 on Sunday, 2026-11-08, up from a usual $0.00 a day (the median",
    },
    {
      name: "a short history says how many days had an amount",
      fields: { historyDays: 9 },
      expected: "(the median of 9 of the 14 days from 2026-10-25 to 2026-11-07).",
    },
    { name: "a ratio of 10 or more is whole", fields: { ratio: 12.46 }, expected: "12 times the usual" },
    { name: "a large ratio is grouped", fields: { ratio: 1234.4 }, expected: "1,234 times the usual" },
    { name: "an estimate says so", fields: { source: "estimated" }, expected: "month to date (estimated) went up" },
  ] satisfies { name: string; fields: Partial<Anomaly>; expected: string }[])("$name", ({ fields, expected }) => {
    const [sentence] = whatChanged([anomaly(fields)], [], link).sentences;
    expect(sentence?.text).toContain(expected);
  });

  it("keeps the rest of the dashboard scope and narrows its providers to the anomaly's", () => {
    const scope = { providers: ["github" as const], projects: ["p1"], accounts: [] };
    const [sentence] = whatChanged([anomaly()], [], { timelinePath: TIMELINE, scope }).sentences;
    expect(sentence?.href).toBe(`${TIMELINE}?from=2026-11-08&to=2026-11-08&provider=vercel&project=p1`);
  });
});

function row(fields: Partial<AnomalyRow> & Pick<AnomalyRow, "snapshot_date">): AnomalyRow {
  return {
    connection_id: VERCEL.id,
    external_account_id: ACCOUNT,
    metric_key: "vercel.spend.total",
    kind: "verified_spend",
    label: "Billed spend, month to date",
    value: null,
    unit: null,
    amount_minor: null,
    currency: "USD",
    period_start: "2026-11-01T00:00:00.000Z",
    period_end: "2026-12-01T00:00:00.000Z",
    point_at: null,
    resets_at: null,
    retrieved_at: `${fields.snapshot_date}T23:59:50.000Z`,
    provenance_source: "provider_api",
    pricing_source: null,
    ...fields,
  };
}

/** Resend emails a day for the 30 days to today, each stored the day after its own day; `spike` sends 900, the rest 200. */
function emailsPerDay(spike: string): AnomalyRow[] {
  return Array.from({ length: 30 }, (_, index) => {
    const day = addUtcDays(TODAY, index - 29);
    return row({
      connection_id: RESEND.id,
      metric_key: "resend.emails.daily",
      kind: "usage",
      label: "Emails sent",
      currency: null,
      unit: "emails",
      value: day === spike ? 900 : 200,
      snapshot_date: addUtcDays(day, 1),
      period_start: `${day}T00:00:00.000Z`,
      period_end: `${addUtcDays(day, 1)}T00:00:00.000Z`,
    });
  });
}

/** Month to date spend in October and November up to today, $100.00 a day and `spikes` days $400.00. */
function monthToDate(...spikes: string[]): AnomalyRow[] {
  const rows: AnomalyRow[] = [];
  let total = 0;
  for (let date = "2026-10-01"; date <= TODAY; date = addUtcDays(date, 1)) {
    const month = date.slice(0, 7);
    if (date.endsWith("-01")) total = 0;
    total += spikes.includes(date) ? 40_000 : 10_000;
    rows.push(
      row({
        snapshot_date: date,
        amount_minor: total,
        period_start: `${month}-01T00:00:00.000Z`,
        period_end: month === "2026-10" ? "2026-11-01T00:00:00.000Z" : "2026-12-01T00:00:00.000Z",
      }),
    );
  }
  return rows;
}

function recent(rows: readonly AnomalyRow[], fields: Partial<Parameters<typeof recentAnomalies>[0]> = {}) {
  return recentAnomalies({
    now: NOW,
    days: 7,
    enabled: true,
    rows,
    connections: [VERCEL, RESEND],
    mutes: [],
    projectedSpend: declaredProjectedSpend,
    dailyTotals: declaredDailyTotals,
    ...fields,
  });
}

describe("recentAnomalies", () => {
  it("finds a running total's spike once, on the day it happened, whatever order the rows come in", () => {
    const found = recent(monthToDate("2026-11-08").reverse());
    expect(found).toEqual([expect.objectContaining({ date: "2026-11-08", provider: "vercel", value: 40_000, usual: 10_000 })]);
  });

  it("never checks today, whose day is not over (boundary: today)", () => {
    expect(recent(monthToDate(TODAY))).toEqual([]);
  });

  it("finds yesterday's running total, the newest day a job has checked (boundary: yesterday)", () => {
    expect(recent(monthToDate("2026-11-09")).map((found) => found.date)).toEqual(["2026-11-09"]);
  });

  it("keeps a day 7 days back and drops one 8 days back (boundary: the window)", () => {
    expect(recent(emailsPerDay("2026-11-03")).map((found) => found.date)).toEqual(["2026-11-03"]);
    expect(recent(emailsPerDay("2026-11-02"))).toEqual([]);
  });

  it("checks a one day period on the day before the job, so yesterday's has not been checked yet", () => {
    expect(recent(emailsPerDay("2026-11-09"))).toEqual([]);
    expect(recent(emailsPerDay("2026-11-08")).map((found) => found.date)).toEqual(["2026-11-08"]);
  });

  it("finds nothing when detection is off, or the metric is muted", () => {
    const rows = monthToDate("2026-11-08");
    expect(recent(rows, { enabled: false })).toEqual([]);
    expect(recent(rows, { mutes: [{ provider: "vercel", metric_key: "vercel.spend.total" }] })).toEqual([]);
  });

  it("leaves out a revoked connection, which the daily summary job no longer reads", () => {
    const rows = monthToDate("2026-11-08");
    expect(recent(rows, { connections: [{ ...VERCEL, status: "revoked" }, RESEND] })).toEqual([]);
    for (const status of ["pending", "needs_attention", "failed"] as const) {
      expect(recent(rows, { connections: [{ ...VERCEL, status }] }), status).toHaveLength(1);
    }
  });

  it("never names GitHub's new stars per day, a declared daily total, however big the day", () => {
    const github: Connection = { id: "c0000000-0000-4000-8000-000000000003", provider: "github", status: "active" };
    const stars = emailsPerDay("2026-11-08").map((snapshot) => ({
      ...snapshot,
      connection_id: github.id,
      metric_key: "github.stars.gained.daily",
      label: "New stars over one UTC day",
      unit: "stars",
    }));
    expect(recent(stars, { connections: [github] })).toEqual([]);
    // Undeclared, the same day is named, so the declaration is what keeps it out.
    expect(recent(stars, { connections: [github], dailyTotals: [] }).map((found) => found.date)).toEqual(["2026-11-08"]);
  });

  it("finds nothing with no rows or no days (boundary: empty)", () => {
    expect(recent([])).toEqual([]);
    expect(recent(monthToDate("2026-11-08"), { days: 0 })).toEqual([]);
  });

  it("finds several days and metrics in one week", () => {
    const found = recent([...monthToDate("2026-11-05", "2026-11-09"), ...emailsPerDay("2026-11-06")]);
    expect(found.map((entry) => `${entry.date} ${entry.provider}`).sort()).toEqual(["2026-11-05 vercel", "2026-11-06 resend", "2026-11-09 vercel"]);
  });
});
