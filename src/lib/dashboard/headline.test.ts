import { describe, expect, it } from "vitest";

import type { EventType } from "@/lib/adapters/events";
import { billingMetrics, signupMetric } from "@/lib/adapters/posthog";
import { BillingResponseSchema } from "@/lib/adapters/posthog/schemas";
import {
  declaredEventTypes,
  declaredProjectedSpend,
  declaredSignupDailyTotals,
  revenueProviderIds,
  spendProviderIds,
} from "@/lib/adapters/registry";
import { SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";
import { toSnapshotRow } from "@/lib/jobs/ingest";
import { providerName } from "@/lib/providers";

import type { ConnectionInput, SnapshotInput } from "./aggregate";
import {
  buildHeadline,
  chooseHeadline,
  costPerSignupExplanation,
  fallbackWindows,
  hasFigure,
  headlineComparisonText,
  headlineEmptyNote,
  headlineEventTypes,
  headlineFallbackNote,
  headlineTitle,
  headlineWindows,
  moneyFormatter,
  wholeDaysNote,
  windowDescription,
  type EventCount,
  type HeadlineEvents,
  type HeadlineInput,
  type HeadlineWindowKind,
  type HeadlineWindows,
  type MoneyLine,
} from "./headline";

// Thursday. This week is 2026-11-02 to 2026-11-05; the same days last week are 2026-10-26 to
// 2026-10-29. This month is 2026-11-01 to 2026-11-05 against 2026-10-01 to 2026-10-05.
const NOW = new Date("2026-11-05T12:00:00.000Z");
const DAY_MS = 86_400_000;

function connection(id: string, provider: ConnectionInput["provider"], overrides: Partial<ConnectionInput> = {}): ConnectionInput {
  return {
    id,
    provider,
    display_name: `${provider} connection`,
    status: "active",
    last_synced_at: "2026-11-05T11:00:00.000Z",
    last_sync_requested_at: null,
    poll_interval_seconds: 3_600,
    granted_scopes: [],
    ...overrides,
  };
}

const vercel = connection("c-vercel", "vercel");
const stripe = connection("c-stripe", "stripe");
const supabase = connection("c-supabase", "supabase");
const github = connection("c-github", "github");
const fake = connection("c-fake", "fake");
const digitalocean = connection("c-digitalocean", "digitalocean");
const posthog = connection("c-posthog", "posthog");
const polar = connection("c-polar", "polar");

function dates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`); time += DAY_MS) {
    out.push(new Date(time).toISOString().slice(0, 10));
  }
  return out;
}

function monthStart(date: string): string {
  return `${date.slice(0, 7)}-01T00:00:00.000Z`;
}

function nextMonthStart(date: string): string {
  const start = new Date(monthStart(date));
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)).toISOString();
}

type SeriesOptions = Readonly<{
  connectionId: string;
  metricKey: string;
  kind?: SnapshotInput["kind"];
  currency?: string;
  /** Amount added on every day of the month; the reading on day N holds N times this. */
  perDay: number;
  from: string;
  to: string;
  skip?: readonly string[];
  estimated?: boolean;
}>;

/** One reading per day of a month to date running total, as an adapter's hourly sync leaves it. */
function runningTotal(options: SeriesOptions): SnapshotInput[] {
  return dates(options.from, options.to)
    .filter((date) => !(options.skip ?? []).includes(date))
    .map((date) => ({
      connection_id: options.connectionId,
      external_account_id: `${options.connectionId}-account`,
      metric_key: options.metricKey,
      kind: options.kind ?? "verified_spend",
      label: "Running total",
      snapshot_date: date,
      value: null,
      unit: null,
      amount_minor: options.perDay * Number(date.slice(8, 10)),
      currency: options.currency ?? "USD",
      period_start: monthStart(date),
      period_end: `${date}T23:00:00.000Z`,
      point_at: null,
      resets_at: null,
      retrieved_at: `${date}T23:00:00.000Z`,
      provenance_source: options.estimated === true ? "derived" : "provider_api",
      pricing_source: options.estimated === true ? "https://example.com/pricing" : null,
    }));
}

/** A projection, read daily: the whole month's expected bill, its period running to the month's end. */
function projection(connectionId: string, metricKey: string, from: string, to: string): SnapshotInput[] {
  return runningTotal({ connectionId, metricKey, perDay: 0, from, to, estimated: true }).map((row) => ({
    ...row,
    kind: "estimated_spend" as const,
    amount_minor: 155_000,
    period_end: nextMonthStart(row.snapshot_date),
  }));
}

/** A point in time reading, which says only that the connection was reporting that day. */
function allowance(connectionId: string, date: string): SnapshotInput {
  return {
    connection_id: connectionId,
    external_account_id: `${connectionId}-account`,
    metric_key: `${connectionId}.plan.limit`,
    kind: "included_allowance",
    label: "Plan limit",
    snapshot_date: date,
    value: 100,
    unit: "users",
    amount_minor: null,
    currency: null,
    period_start: null,
    period_end: null,
    point_at: `${date}T09:00:00.000Z`,
    resets_at: null,
    retrieved_at: `${date}T09:00:00.000Z`,
    provenance_source: "provider_api",
    pricing_source: null,
  };
}

/**
 * PostHog's daily signup totals, one per day, read the next morning: the real adapter's
 * `signupMetric` as the sync stores it (`toSnapshotRow`, dated by when it was retrieved).
 */
function postHogTotals(
  options: Readonly<{ from: string; to: string; signupsOn: (date: string) => number; skip?: readonly string[]; account?: string }>,
): SnapshotInput[] {
  return dates(options.from, options.to)
    .filter((date) => !(options.skip ?? []).includes(date))
    .map((date) => {
      const retrievedAt = new Date(Date.parse(`${date}T01:00:00.000Z`) + DAY_MS);
      const day = { project: { id: 1, name: "Web" }, date, signups: options.signupsOn(date) };
      const metric = signupMetric([day], date, "org", retrievedAt, "us");
      if (metric.kind !== "usage" || metric.timeframe.type !== "period") throw new Error("A daily signup total is usage over one day.");
      return {
        connection_id: posthog.id,
        external_account_id: options.account ?? `${posthog.id}-account`,
        metric_key: metric.metricKey,
        kind: metric.kind,
        label: metric.label,
        snapshot_date: retrievedAt.toISOString().slice(0, 10),
        value: metric.value,
        unit: metric.unit,
        amount_minor: null,
        currency: null,
        period_start: metric.timeframe.start.toISOString(),
        period_end: metric.timeframe.end.toISOString(),
        point_at: null,
        resets_at: null,
        retrieved_at: retrievedAt.toISOString(),
        provenance_source: metric.provenance.source,
        pricing_source: null,
      };
    });
}

/**
 * PostHog's spend so far, read late every day: the real adapter's `billingMetrics` as the sync stores
 * it (`toSnapshotRow`), the organization total and each product's spend below it, 70 and 30 percent
 * of the total. Days before `renamedOn` keep each product's spend under the key used before #204,
 * `posthog.<type>.spend`, as rows stored then still are.
 */
function postHogSpend(options: Readonly<{ perDay: number; from: string; to: string; renamedOn: string }>): SnapshotInput[] {
  const usd = (minor: number) => (minor / 100).toFixed(2);
  return dates(options.from, options.to).flatMap((date) => {
    const total = options.perDay * Number(date.slice(8, 10));
    const analytics = Math.round(total * 0.7);
    const billing = BillingResponseSchema.parse({
      current_total_amount_usd: usd(total),
      billing_period: { current_period_start: monthStart(date), current_period_end: nextMonthStart(date) },
      products: [
        { type: "product_analytics", name: "Product analytics", usage_key: "events", unit: "event", current_usage: total * 100, current_amount_usd: usd(analytics) },
        { type: "session_replay", name: "Session replay", usage_key: "recordings", unit: "recording", current_usage: total, current_amount_usd: usd(total - analytics) },
      ],
    });
    const account = { id: `${posthog.id}-account` };
    return billingMetrics(billing, account.id, new Date(`${date}T23:00:00.000Z`), "us").map((metric) => {
      const row: SnapshotInput = toSnapshotRow(metric, { id: posthog.id, workspace_id: "w1" }, account);
      const product = /^posthog\.spend\.current\.([a-z_]+)$/.exec(row.metric_key)?.[1];
      return product === undefined || date >= options.renamedOn ? row : { ...row, metric_key: `posthog.${product}.spend` };
    });
  });
}

const NO_EVENTS = { current: [], previous: [] } as const;
const EVENT_TYPES = headlineEventTypes(declaredEventTypes, declaredSignupDailyTotals);

/** What `getHeadlineEvents` reads on its own: each connection's oldest reading. */
function firstReadings(snapshots: readonly SnapshotInput[]): Map<string, string> {
  const first = new Map<string, string>();
  for (const row of snapshots) {
    const known = first.get(row.connection_id);
    if (known === undefined || row.snapshot_date < known) first.set(row.connection_id, row.snapshot_date);
  }
  return first;
}

type HeadlineOverrides = Partial<Omit<HeadlineInput, "events">> &
  Pick<HeadlineInput, "snapshots" | "connections"> &
  Readonly<{
    /** Shorthand for `windows`: the window to date of this kind at `now`. */
    kind?: HeadlineWindowKind;
    now?: Date;
    events?: Pick<HeadlineEvents, "current" | "previous">;
    firstReadings?: HeadlineEvents["firstReadings"];
  }>;

/** First readings default to the oldest snapshot passed in, as when the history is not truncated. */
function headline({ events = NO_EVENTS, firstReadings: readings, kind = "week", now = NOW, ...overrides }: HeadlineOverrides) {
  return buildHeadline({
    windows: headlineWindows(kind, now),
    eventTypes: EVENT_TYPES,
    projectedSpend: declaredProjectedSpend,
    revenueProviders: revenueProviderIds,
    spendProviders: spendProviderIds,
    ...overrides,
    events: { ...events, firstReadings: readings ?? firstReadings(overrides.snapshots) },
  });
}

function line(lines: readonly MoneyLine[] | null, currency: string): MoneyLine | undefined {
  return lines?.find((entry) => entry.currency === currency);
}

describe("headlineWindows", () => {
  it.each<[string, HeadlineWindowKind, string, [string, string], [string, string]]>([
    ["a Thursday: Monday to today against the same days last week", "week", "2026-11-05T12:00:00.000Z", ["2026-11-02", "2026-11-05"], ["2026-10-26", "2026-10-29"]],
    ["the first instant of a Monday (UTC): one day", "week", "2026-11-02T00:00:00.000Z", ["2026-11-02", "2026-11-02"], ["2026-10-26", "2026-10-26"]],
    ["the last instant of a Sunday (UTC): the whole week", "week", "2026-11-01T23:59:59.999Z", ["2026-10-26", "2026-11-01"], ["2026-10-19", "2026-10-25"]],
    ["a week across a new year", "week", "2027-01-01T08:00:00.000Z", ["2026-12-28", "2027-01-01"], ["2026-12-21", "2026-12-25"]],
    ["the first instant of a month (UTC): one day", "month", "2026-11-01T00:00:00.000Z", ["2026-11-01", "2026-11-01"], ["2026-10-01", "2026-10-01"]],
    ["the last instant of a month (UTC)", "month", "2026-10-31T23:59:59.999Z", ["2026-10-01", "2026-10-31"], ["2026-09-01", "2026-09-30"]],
    ["a longer month than the one before: cut at its last day", "month", "2026-03-31T12:00:00.000Z", ["2026-03-01", "2026-03-31"], ["2026-02-01", "2026-02-28"]],
    ["a month across a new year", "month", "2026-01-15T12:00:00.000Z", ["2026-01-01", "2026-01-15"], ["2025-12-01", "2025-12-15"]],
  ])("%s", (_name, kind, now, current, previous) => {
    const windows = headlineWindows(kind, new Date(now));
    expect(windows.current).toEqual({ start: current[0], end: current[1] });
    expect(windows.previous).toEqual({ start: previous[0], end: previous[1] });
  });

  it("uses the UTC day, not the server's local one, an hour either side of midnight", () => {
    expect(headlineWindows("week", new Date("2026-11-01T23:00:00.000-01:00")).current.start).toBe("2026-11-02");
    expect(headlineWindows("week", new Date("2026-11-02T00:30:00.000+01:00")).current.start).toBe("2026-10-26");
  });
});

describe("buildHeadline money", () => {
  const vercelSpend = runningTotal({ connectionId: vercel.id, metricKey: "vercel.spend.total", perDay: 100, from: "2026-10-01", to: "2026-11-05" });

  it("counts the days in the window from daily readings of a running total", () => {
    const strip = headline({ snapshots: vercelSpend, connections: [vercel] });
    expect(line(strip.spend.lines, "USD")?.verified).toEqual({
      value: 400,
      comparison: { status: "change", direction: "same", percent: 0, previous: 400 },
    });
    expect(strip.spend.included).toEqual(["Vercel"]);
    expect(strip.spend.unavailable).toEqual([]);
  });

  it("adds both months for a week across a month boundary, the new month counted from its first reading", () => {
    const strip = headline({ snapshots: vercelSpend.filter((row) => row.snapshot_date <= "2026-11-01"), connections: [vercel], now: new Date("2026-11-01T23:30:00.000Z") });
    // 2026-10-26 to 2026-10-31 is 6 days at 100, plus 100 for 2026-11-01.
    expect(line(strip.spend.lines, "USD")?.verified?.value).toBe(700);
  });

  it("counts the month window from the first reading of the month, which covers everything since it began", () => {
    const strip = headline({ snapshots: vercelSpend, connections: [vercel], kind: "month" });
    expect(line(strip.spend.lines, "USD")?.verified).toEqual({
      value: 500,
      comparison: { status: "change", direction: "same", percent: 0, previous: 500 },
    });
  });

  it("shows a window with no revenue as zero from a source that reported it, and no figure without a source", () => {
    const flat = runningTotal({ connectionId: stripe.id, metricKey: "stripe.revenue.month.usd", kind: "revenue", perDay: 0, from: "2026-10-01", to: "2026-11-05" });
    const withStripe = headline({ snapshots: [...flat, ...vercelSpend], connections: [stripe, vercel] });
    expect(withStripe.revenue.lines).toEqual([
      { currency: "USD", verified: { value: 0, comparison: { status: "change", direction: "same", percent: null, previous: 0 } }, estimated: null },
    ]);
    expect(line(withStripe.net.lines, "USD")?.verified?.value).toBe(-400);

    const withoutRevenue = headline({ snapshots: vercelSpend, connections: [vercel] });
    expect(withoutRevenue.revenue).toMatchObject({ lines: null, included: [], unavailable: [] });
    expect(withoutRevenue.net.lines).toBeNull();
  });

  it("names a connected revenue provider with no readings as unavailable, not zero", () => {
    const strip = headline({ snapshots: vercelSpend, connections: [stripe, vercel] });
    expect(strip.revenue).toMatchObject({ lines: null, included: [], unavailable: ["Stripe"] });
    expect(strip.net.lines).toBeNull();
    // Which providers report revenue comes from the adapters' capabilities, Polar's included.
    expect(headline({ snapshots: vercelSpend, connections: [polar, stripe, vercel] }).revenue).toMatchObject({ unavailable: ["Polar", "Stripe"] });
    expect(headline({ snapshots: vercelSpend, connections: [stripe, vercel], revenueProviders: [] }).revenue).toMatchObject({ lines: null, unavailable: [] });
  });

  it("keeps spend in two currencies on separate lines, never converted or added", () => {
    const euro = runningTotal({ connectionId: fake.id, metricKey: "fake.spend.month", currency: "EUR", perDay: 70, from: "2026-10-01", to: "2026-11-05" });
    const strip = headline({ snapshots: [...vercelSpend, ...euro], connections: [vercel, fake] });
    expect(strip.spend.lines?.map((entry) => [entry.currency, entry.verified?.value])).toEqual([
      ["EUR", 280],
      ["USD", 400],
    ]);
    expect(strip.spend.included).toEqual(["Example provider", "Vercel"]);
  });

  it("names a provider that reports spend but has none for the window as unavailable and leaves it out of the sum", () => {
    const strip = headline({ snapshots: [...vercelSpend, allowance(github.id, "2026-10-01")], connections: [vercel, github] });
    expect(line(strip.spend.lines, "USD")?.verified?.value).toBe(400);
    expect(strip.spend.unavailable).toEqual(["GitHub"]);
    expect(strip.spend.included).toEqual(["Vercel"]);
  });

  it("leaves out a provider that never reports spend instead of naming it unavailable (#286)", () => {
    const nonSpending = (["gitlab", "resend", "sentry", "supabase"] as const).map((provider) => connection(`c-${provider}`, provider));
    const readings = nonSpending.map((owner) => allowance(owner.id, "2026-10-01"));
    const strip = headline({ snapshots: [...vercelSpend, ...readings], connections: [vercel, ...nonSpending] });
    expect(strip.spend).toMatchObject({ included: ["Vercel"], unavailable: [], previousUnavailable: [] });
    expect(strip.costPerSignup).toMatchObject({ spendUnavailable: [] });
    // Boundary: with only those in view, no provider reports spend, so none is named as failing.
    expect(headline({ snapshots: readings, connections: nonSpending }).spend).toMatchObject({ lines: null, included: [], unavailable: [] });
    // Boundary: one that declares spend and has no reading at all is still named.
    expect(headline({ snapshots: readings, connections: [vercel, ...nonSpending] }).spend).toMatchObject({ lines: null, unavailable: ["Vercel"] });
  });

  it("counts a spend reading from a provider whatever its adapter declares", () => {
    const strip = headline({ snapshots: vercelSpend, connections: [vercel], spendProviders: [] });
    expect(strip.spend).toMatchObject({ included: ["Vercel"], unavailable: [] });
    expect(line(strip.spend.lines, "USD")?.verified?.value).toBe(400);
  });

  it("keeps verified and estimated amounts apart in spend, revenue minus spend, and cost per signup", () => {
    // An estimate of spend so far; `fake.cost.estimate` is the month's projection, so not this.
    const estimate = runningTotal({ connectionId: fake.id, metricKey: "fake.cost.so_far", kind: "estimated_spend", estimated: true, perDay: 30, from: "2026-10-01", to: "2026-11-05" });
    const revenue = runningTotal({ connectionId: stripe.id, metricKey: "stripe.revenue.month.usd", kind: "revenue", perDay: 1_000, from: "2026-10-01", to: "2026-11-05" });
    const signups: EventCount[] = [{ connection_id: fake.id, type_id: "fake.signup", events: 8 }];
    const strip = headline({
      snapshots: [...vercelSpend, ...estimate, ...revenue],
      connections: [vercel, fake, stripe],
      events: { current: signups, previous: signups },
    });
    expect(line(strip.spend.lines, "USD")).toMatchObject({ verified: { value: 400 }, estimated: { value: 120 } });
    expect(line(strip.net.lines, "USD")).toMatchObject({ verified: { value: 3_600 }, estimated: { value: -120 } });
    expect(line(strip.costPerSignup.lines, "USD")).toMatchObject({ verified: { value: 50 }, estimated: { value: 15 } });
  });

  it("makes a connection unavailable when its first reading spans the window start, and fine for the month", () => {
    const late = vercelSpend.filter((row) => row.snapshot_date >= "2026-11-04");
    const week = headline({ snapshots: late, connections: [vercel] });
    expect(week.spend).toMatchObject({ lines: null, unavailable: ["Vercel"] });
    const month = headline({ snapshots: late, connections: [vercel], kind: "month" });
    expect(line(month.spend.lines, "USD")?.verified).toMatchObject({ value: 500, comparison: { status: "unavailable", missing: "previous" } });
    expect(month.spend.previousUnavailable).toEqual(["Vercel"]);
  });

  it("counts a missed day inside the window from the next reading, but not a missing last required day", () => {
    const gapInside = headline({ snapshots: vercelSpend.filter((row) => row.snapshot_date !== "2026-11-03"), connections: [vercel] });
    expect(line(gapInside.spend.lines, "USD")?.verified?.value).toBe(400);
    // Yesterday (2026-11-04) has no reading and nothing after it, so the week is incomplete.
    const stopped = headline({ snapshots: vercelSpend.filter((row) => row.snapshot_date <= "2026-11-03"), connections: [vercel] });
    expect(stopped.spend).toMatchObject({ lines: null, unavailable: ["Vercel"] });
  });

  it("does not need today's reading for the current window", () => {
    const strip = headline({ snapshots: vercelSpend.filter((row) => row.snapshot_date <= "2026-11-04"), connections: [vercel] });
    expect(line(strip.spend.lines, "USD")?.verified?.value).toBe(300);
  });

  it("gives no comparison when a reading spans the previous window's end", () => {
    const strip = headline({ snapshots: vercelSpend.filter((row) => !["2026-10-29", "2026-10-30"].includes(row.snapshot_date)), connections: [vercel] });
    expect(line(strip.spend.lines, "USD")?.verified).toEqual({ value: 400, comparison: { status: "unavailable", missing: "previous" } });
    expect(strip.spend.previousUnavailable).toEqual(["Vercel"]);
  });

  it("counts GitHub's daily spend inside its month once, and skips rolling windows", () => {
    // GitHub's month runs to the start of the next month, so its daily rows sit strictly inside it.
    const month = runningTotal({ connectionId: github.id, metricKey: "github.spend.actions", perDay: 50, from: "2026-10-01", to: "2026-11-05" }).map(
      (row) => ({ ...row, period_end: nextMonthStart(row.snapshot_date) }),
    );
    const daily = month.map((row) => ({
      ...row,
      metric_key: "github.daily_spend.actions",
      amount_minor: 50,
      period_start: `${row.snapshot_date}T00:00:00.000Z`,
      period_end: new Date(Date.parse(`${row.snapshot_date}T00:00:00.000Z`) + DAY_MS).toISOString(),
    }));
    const rolling = month.map((row) => ({
      ...row,
      metric_key: "github.spend.last_30_days",
      period_start: new Date(Date.parse(row.retrieved_at) - 30 * DAY_MS).toISOString(),
    }));
    const strip = headline({ snapshots: [...month, ...daily, ...rolling], connections: [github] });
    expect(line(strip.spend.lines, "USD")?.verified?.value).toBe(200);
  });

  // PostHog reports its organization's spend so far and each product's spend in the same period.
  it.each([
    ["every day stored under the current keys", "2026-10-01"],
    ["the days before the rename stored under the old product keys (#204)", "2026-11-03"],
  ])("counts PostHog's spend once, the organization total and not its products again: %s", (_name, renamedOn) => {
    const spend = postHogSpend({ perDay: 100, from: "2026-10-01", to: "2026-11-05", renamedOn });
    const week = headline({ snapshots: spend, connections: [posthog] });
    expect(line(week.spend.lines, "USD")?.verified).toEqual({
      value: 400,
      comparison: { status: "change", direction: "same", percent: 0, previous: 400 },
    });
    expect(week.spend.included).toEqual(["PostHog"]);
    const month = headline({ snapshots: spend, connections: [posthog], kind: "month" });
    expect(line(month.spend.lines, "USD")?.verified?.value).toBe(500);
  });

  it("leaves out a final total read after its period ended, such as DigitalOcean's last invoice", () => {
    const monthToDate = runningTotal({ connectionId: digitalocean.id, metricKey: "digitalocean.spend.month_to_date", perDay: 100, from: "2026-10-01", to: "2026-11-05" });
    // October's invoice, read every day of November: its period ended before each reading.
    const invoice = runningTotal({ connectionId: digitalocean.id, metricKey: "digitalocean.invoice.latest", perDay: 0, from: "2026-11-01", to: "2026-11-05" }).map(
      (row) => ({ ...row, amount_minor: 3_100, period_start: "2026-10-01T00:00:00.000Z", period_end: "2026-11-01T00:00:00.000Z" }),
    );
    const strip = headline({ snapshots: [...monthToDate, ...invoice], connections: [digitalocean] });
    expect(strip.spend).toMatchObject({ included: ["DigitalOcean"], unavailable: [], previousUnavailable: [] });
    expect(line(strip.spend.lines, "USD")?.verified?.value).toBe(400);
  });

  // PostHog's projected spend, Railway's estimated bill, and the Example provider's month estimate.
  it.each(declaredProjectedSpend)("never counts %s, a declared projection, as spend, even first read on its period's last day", (metricKey) => {
    const provider = metricKey.slice(0, metricKey.indexOf(".")) as ConnectionInput["provider"];
    const owner = connection(`c-${provider}`, provider);
    const spentSoFar = runningTotal({ connectionId: owner.id, metricKey: `${provider}.spend.month_to_date`, perDay: 100, from: "2026-10-01", to: "2026-11-05" });
    // First read on 2026-10-31, the last day of October's period, where its period looks like a
    // total that is still running, then on every day of November's.
    const strip = headline({ snapshots: [...spentSoFar, ...projection(owner.id, metricKey, "2026-10-31", "2026-11-05")], connections: [owner] });
    expect(strip.spend).toMatchObject({ included: [providerName(provider)], unavailable: [], previousUnavailable: [] });
    expect(line(strip.spend.lines, "USD")).toEqual({
      currency: "USD",
      verified: { value: 400, comparison: { status: "change", direction: "same", percent: 0, previous: 400 } },
      estimated: null,
    });
  });

  it("declares the projections of every merged adapter that reports one", () => {
    expect([...declaredProjectedSpend].sort()).toEqual(["fake.cost.estimate", "posthog.spend.projected", "railway.estimate.bill"]);
  });

  it("goes by the declaration, not the period: an undeclared estimate of spend so far over the whole month counts", () => {
    const estimate = runningTotal({ connectionId: vercel.id, metricKey: "vercel.spend.estimated", perDay: 10, from: "2026-10-01", to: "2026-11-05", estimated: true }).map(
      (row) => ({ ...row, kind: "estimated_spend" as const, period_end: nextMonthStart(row.snapshot_date) }),
    );
    const strip = headline({ snapshots: [...vercelSpend, ...estimate], connections: [vercel] });
    expect(line(strip.spend.lines, "USD")?.estimated).toEqual({ value: 40, comparison: { status: "change", direction: "same", percent: 0, previous: 40 } });
    // The same rows declared a projection count nothing.
    const declared = headline({ snapshots: [...vercelSpend, ...estimate], connections: [vercel], projectedSpend: ["vercel.spend.estimated"] });
    expect(line(declared.spend.lines, "USD")?.estimated).toBeNull();
  });

  it("ignores rows of connections outside the scope", () => {
    const strip = headline({ snapshots: vercelSpend, connections: [stripe] });
    expect(strip.spend).toMatchObject({ lines: null, unavailable: ["Stripe"] });
  });

  it("names providers billed on another period than the window", () => {
    const github15 = runningTotal({ connectionId: github.id, metricKey: "github.spend.actions", perDay: 10, from: "2026-10-01", to: "2026-11-05" }).map((row) => ({
      ...row,
      period_start: row.snapshot_date >= "2026-10-15" ? "2026-10-15T00:00:00.000Z" : "2026-09-15T00:00:00.000Z",
    }));
    expect(headline({ snapshots: [...vercelSpend, ...github15], connections: [vercel, github], kind: "week" }).otherBillingPeriods).toEqual(["GitHub", "Vercel"]);
    expect(headline({ snapshots: [...vercelSpend, ...github15], connections: [vercel, github], kind: "month" }).otherBillingPeriods).toEqual(["GitHub"]);
  });
});

describe("buildHeadline counts", () => {
  const history = [allowance(supabase.id, "2026-10-01"), allowance(vercel.id, "2026-10-01")];
  const spend = runningTotal({ connectionId: vercel.id, metricKey: "vercel.spend.total", perDay: 125, from: "2026-10-01", to: "2026-11-05" });

  it("counts signups and deploys, with failed deploys named, against the same days last week", () => {
    const strip = headline({
      snapshots: [...history, ...spend],
      connections: [vercel, supabase],
      events: {
        current: [
          { connection_id: supabase.id, type_id: "supabase.auth.signup", events: 4 },
          { connection_id: vercel.id, type_id: "vercel.deployment.succeeded", events: 9 },
          { connection_id: vercel.id, type_id: "vercel.deployment.failed", events: 3 },
        ],
        previous: [
          { connection_id: supabase.id, type_id: "supabase.auth.signup", events: 2 },
          { connection_id: vercel.id, type_id: "vercel.deployment.succeeded", events: 12 },
        ],
      },
    });
    expect(strip.signups).toMatchObject({
      value: { value: 4, comparison: { status: "change", direction: "up", percent: 100, previous: 2 } },
      included: ["Supabase"],
    });
    expect(strip.deploys).toMatchObject({
      value: { value: 12, comparison: { status: "change", direction: "same", previous: 12 } },
      failed: 3,
    });
    // 500 cents over 4 signups now, against 500 over 2 before.
    expect(line(strip.costPerSignup.lines, "USD")?.verified).toEqual({
      value: 125,
      comparison: { status: "change", direction: "down", percent: 50, previous: 250 },
    });
    // Supabase reports no spend, so it is not named among the spend left out while its signups count.
    expect(strip.costPerSignup).toMatchObject({
      missing: null,
      spendFrom: ["Vercel"],
      signupsFrom: ["Supabase"],
      spendUnavailable: [],
      signupsUnavailable: [],
      comparisonGap: null,
    });
  });

  it("rounds cost per signup once, half to even", () => {
    const events = (count: number) => ({ current: [{ connection_id: supabase.id, type_id: "supabase.auth.signup", events: count }], previous: [] });
    // 500 over 8 is 62.5, rounded to the even 62; 500 over 3 is 166.67, rounded to 167.
    expect(line(headline({ snapshots: [...history, ...spend], connections: [vercel, supabase], events: events(8) }).costPerSignup.lines, "USD")?.verified?.value).toBe(62);
    expect(line(headline({ snapshots: [...history, ...spend], connections: [vercel, supabase], events: events(3) }).costPerSignup.lines, "USD")?.verified?.value).toBe(167);
  });

  it("says the previous window had no signups rather than calling cost per signup unavailable", () => {
    const strip = headline({
      snapshots: [...history, ...spend],
      connections: [vercel, supabase],
      events: { current: [{ connection_id: supabase.id, type_id: "supabase.auth.signup", events: 4 }], previous: [] },
    });
    expect(strip.costPerSignup).toMatchObject({ missing: null, comparisonGap: { reason: "no_signups" } });
    expect(line(strip.costPerSignup.lines, "USD")?.verified).toEqual({ value: 125, comparison: { status: "unavailable", missing: "previous" } });
    // A source that could not report the previous window is the reason instead.
    const late = headline({
      snapshots: [allowance(supabase.id, "2026-10-28"), ...spend],
      connections: [vercel, supabase],
      events: { current: [{ connection_id: supabase.id, type_id: "supabase.auth.signup", events: 4 }], previous: [] },
    });
    expect(late.costPerSignup).toMatchObject({ missing: null, comparisonGap: { reason: "providers", names: ["Supabase"] } });
  });

  it("shows no cost per signup with zero signups, without signups, or without spend", () => {
    expect(headline({ snapshots: [...history, ...spend], connections: [vercel, supabase] }).costPerSignup).toMatchObject({ lines: null, missing: "no_signups" });
    expect(headline({ snapshots: [...history, ...spend], connections: [vercel] }).costPerSignup).toMatchObject({ lines: null, missing: "signups" });
    expect(headline({ snapshots: history, connections: [supabase] }).costPerSignup).toMatchObject({ lines: null, missing: "spend" });
  });

  it("makes a source unavailable when it was connected after the window began or has not synced since yesterday", () => {
    const newcomer = headline({ snapshots: [allowance(supabase.id, "2026-11-03")], connections: [supabase] });
    expect(newcomer.signups).toMatchObject({ value: null, unavailable: ["Supabase"] });
    const silent = headline({ snapshots: history, connections: [connection(supabase.id, "supabase", { last_synced_at: "2026-11-03T23:59:00.000Z" })] });
    expect(silent.signups).toMatchObject({ value: null, unavailable: ["Supabase"] });
    const neverSynced = headline({ snapshots: history, connections: [connection(supabase.id, "supabase", { last_synced_at: null })] });
    expect(neverSynced.signups).toMatchObject({ value: null, unavailable: ["Supabase"] });
  });

  it("compares only when the same sources reported the previous window", () => {
    const strip = headline({ snapshots: [allowance(supabase.id, "2026-10-28")], connections: [supabase] });
    expect(strip.signups).toMatchObject({
      value: { value: 0, comparison: { status: "unavailable", missing: "previous" } },
      previousUnavailable: ["Supabase"],
    });
  });

  it("has no signup figure when no connected provider reports signups", () => {
    expect(headline({ snapshots: spend, connections: [vercel] }).signups).toMatchObject({ value: null, included: [], unavailable: [] });
  });

  it("is simulated when a connection behind a figure was made by the provider simulator", () => {
    const simulated = connection(vercel.id, "vercel", { granted_scopes: [SIMULATED_SCOPE] });
    expect(headline({ snapshots: spend, connections: [simulated] }).simulated).toBe(true);
    expect(headline({ snapshots: spend, connections: [vercel] }).simulated).toBe(false);
  });

  it("counts DigitalOcean's deploys and names its failed ones", () => {
    const strip = headline({
      snapshots: [allowance(digitalocean.id, "2026-10-01")],
      connections: [digitalocean],
      events: {
        current: [
          { connection_id: digitalocean.id, type_id: "digitalocean.deployment.succeeded", events: 4 },
          { connection_id: digitalocean.id, type_id: "digitalocean.deployment.failed", events: 1 },
        ],
        previous: [{ connection_id: digitalocean.id, type_id: "digitalocean.deployment.succeeded", events: 5 }],
      },
    });
    expect(strip.deploys).toMatchObject({
      value: { value: 5, comparison: { status: "change", direction: "same", previous: 5 } },
      failed: 1,
      included: ["DigitalOcean"],
    });
  });

  it("takes when a connection first reported from its own first reading, not the snapshot history passed in", () => {
    // The history page starts this week, as a capped newest first read would leave it.
    const thisWeek = [allowance(supabase.id, "2026-11-03")];
    const signups = { current: [{ connection_id: supabase.id, type_id: "supabase.auth.signup", events: 3 }], previous: [] };
    const strip = headline({ snapshots: thisWeek, connections: [supabase], events: signups, firstReadings: new Map([[supabase.id, "2026-10-01"]]) });
    expect(strip.signups).toMatchObject({ value: { value: 3, comparison: { status: "change", direction: "up", previous: 0 } }, previousUnavailable: [] });
    // No first reading at all: connected after the window began.
    const unknown = headline({ snapshots: history, connections: [supabase], events: signups, firstReadings: new Map() });
    expect(unknown.signups).toMatchObject({ value: null, unavailable: ["Supabase"] });
  });
});

describe("buildHeadline daily signup totals", () => {
  // This week's whole days are 2026-11-02 to 2026-11-04; last week's as many, 2026-10-26 to 2026-10-28.
  const history = [allowance(supabase.id, "2026-10-01")];
  const spend = runningTotal({ connectionId: vercel.id, metricKey: "vercel.spend.total", perDay: 125, from: "2026-10-01", to: "2026-11-05" });
  const totals = (overrides: Partial<Parameters<typeof postHogTotals>[0]> = {}) =>
    postHogTotals({
      from: "2026-10-01",
      to: "2026-11-04",
      // 2026-10-29 is in last week's window but is the same weekday as today, so it never counts.
      signupsOn: (date) => (date >= "2026-11-02" ? 40 : date === "2026-10-29" ? 900 : 20),
      ...overrides,
    });

  it("counts PostHog's signups from its daily totals over the whole days, against as many days last week", () => {
    const strip = headline({
      snapshots: [...history, ...spend, ...totals()],
      connections: [vercel, supabase, posthog],
      events: {
        current: [{ connection_id: supabase.id, type_id: "supabase.auth.signup", events: 4 }],
        previous: [{ connection_id: supabase.id, type_id: "supabase.auth.signup", events: 2 }],
      },
    });
    // 4 events and 3 days of 40 now; 2 events and 3 days of 20 before.
    expect(strip.signups).toMatchObject({
      value: { value: 124, comparison: { status: "change", direction: "up", percent: 100, previous: 62 } },
      included: ["PostHog", "Supabase"],
      unavailable: [],
      wholeDays: ["PostHog"],
    });
    // 500 cents over 124 signups now, against 500 over 62 before.
    expect(line(strip.costPerSignup.lines, "USD")?.verified).toEqual({
      value: 4,
      comparison: { status: "change", direction: "down", percent: 50, previous: 8 },
    });
    expect(strip.costPerSignup).toMatchObject({
      signupsFrom: ["PostHog", "Supabase"],
      signupsWholeDays: ["PostHog"],
      spendUnavailable: ["PostHog"],
    });
  });

  it("names PostHog unavailable when a whole day has no reading, and gives no comparison when last week misses one", () => {
    const missingNow = headline({ snapshots: totals({ skip: ["2026-11-03"] }), connections: [posthog] });
    expect(missingNow.signups).toMatchObject({ value: null, included: [], unavailable: ["PostHog"], wholeDays: ["PostHog"] });
    const missingBefore = headline({ snapshots: totals({ skip: ["2026-10-27"] }), connections: [posthog] });
    expect(missingBefore.signups).toMatchObject({
      value: { value: 120, comparison: { status: "unavailable", missing: "previous" } },
      previousUnavailable: ["PostHog"],
    });
  });

  it("has no whole day on a window's first day, so PostHog is unavailable rather than zero", () => {
    const monday = new Date("2026-11-02T08:00:00.000Z");
    const synced = connection(supabase.id, "supabase", { last_synced_at: "2026-11-02T07:00:00.000Z" });
    const strip = headline({
      now: monday,
      snapshots: [...history, ...totals({ to: "2026-11-01" })],
      connections: [synced, posthog],
      events: { current: [{ connection_id: supabase.id, type_id: "supabase.auth.signup", events: 3 }], previous: [] },
    });
    expect(strip.signups).toMatchObject({ value: { value: 3 }, included: ["Supabase"], unavailable: ["PostHog"], wholeDays: ["PostHog"] });
    expect(strip.costPerSignup).toMatchObject({ signupsUnavailable: ["PostHog"], signupsWholeDays: [] });
  });

  it("counts as many days of a shorter previous month", () => {
    // 2026-03-01 to 2026-03-30 against all 28 days of February.
    const strip = headline({
      kind: "month",
      now: new Date("2026-03-31T12:00:00.000Z"),
      snapshots: totals({ from: "2026-01-31", to: "2026-03-30", signupsOn: () => 1 }),
      connections: [posthog],
    });
    expect(strip.signups.value).toMatchObject({ value: 30, comparison: { status: "change", direction: "up", previous: 28 } });
  });

  it("skips a series that stopped before the window, and a reading that is not one whole UTC day", () => {
    const stopped = totals({ to: "2026-10-15", account: "c-posthog-old-account", signupsOn: () => 1_000 });
    expect(headline({ snapshots: [...totals(), ...stopped], connections: [posthog] }).signups.value).toMatchObject({ value: 120, comparison: { previous: 60 } });
    // Two days in one reading cannot be split, so 2026-11-03 has no reading of its own.
    const twoDays = totals().map((row) =>
      row.period_start === "2026-11-03T00:00:00.000Z" ? { ...row, period_end: "2026-11-05T00:00:00.000Z" } : row,
    );
    expect(headline({ snapshots: twoDays, connections: [posthog] }).signups).toMatchObject({ value: null, unavailable: ["PostHog"] });
  });
});

describe("the last complete window when the window to date has no figure (#267)", () => {
  // Every connection last synced on Monday 2026-11-02, three days before NOW (Thursday). The last
  // complete week is 2026-10-26 to 2026-11-01, against 2026-10-19 to 2026-10-25.
  const syncedAt = "2026-11-02T09:00:00.000Z";
  const stale = (owner: ConnectionInput) => ({ ...owner, last_synced_at: syncedAt });
  const untilSync = runningTotal({ connectionId: vercel.id, metricKey: "vercel.spend.total", perDay: 100, from: "2026-10-01", to: "2026-11-02" });
  const supabaseHistory = [allowance(supabase.id, "2026-10-01")];
  const connections = [stale(vercel), stale(supabase)];

  /** The strip of the window to date with nothing to read, so it has no figure. */
  const emptyStrip = (owners: readonly ConnectionInput[], kind: HeadlineWindowKind = "week", now = NOW) =>
    headline({ snapshots: [], connections: owners, kind, now });

  function lastWeek(): HeadlineWindows {
    const windows = fallbackWindows(emptyStrip(connections), connections, NOW);
    if (windows === null) throw new Error("expected a last complete week");
    return windows;
  }

  it("reports nothing for the week so far when every connection is three days stale, and the last complete week instead", () => {
    const current = headline({ snapshots: [...untilSync, ...supabaseHistory], connections });
    expect(hasFigure(current)).toBe(false);
    expect(current.spend).toMatchObject({ lines: null, unavailable: ["Vercel"] });

    const windows = fallbackWindows(current, connections, NOW);
    expect(windows).toEqual({
      kind: "week",
      complete: true,
      current: { start: "2026-10-26", end: "2026-11-01" },
      previous: { start: "2026-10-19", end: "2026-10-25" },
    });
    if (windows === null) throw new Error("expected a last complete week");
    const fallback = headline({
      snapshots: [...untilSync, ...supabaseHistory],
      connections,
      windows,
      events: {
        current: [{ connection_id: supabase.id, type_id: "supabase.auth.signup", events: 6 }],
        previous: [{ connection_id: supabase.id, type_id: "supabase.auth.signup", events: 3 }],
      },
    });
    // 2026-10-26 to 2026-10-31 at 100 a day, plus November's first reading: every day of the whole
    // week, against every day of the week before.
    expect(line(fallback.spend.lines, "USD")?.verified).toEqual({
      value: 700,
      comparison: { status: "change", direction: "same", percent: 0, previous: 700 },
    });
    expect(fallback.signups).toMatchObject({ value: { value: 6, comparison: { status: "change", direction: "up", percent: 100 } }, unavailable: [] });
    expect(chooseHeadline(current, fallback)).toEqual({ status: "fallback", strip: fallback, current: current.windows });
  });

  it("takes the last whole month, and the whole month before it, for the month view", () => {
    expect(fallbackWindows(emptyStrip(connections, "month"), connections, NOW)).toEqual({
      kind: "month",
      complete: true,
      current: { start: "2026-10-01", end: "2026-10-31" },
      previous: { start: "2026-09-01", end: "2026-09-30" },
    });
    const lastDay = [connection(vercel.id, "vercel", { last_synced_at: "2026-12-01T09:00:00.000Z" })];
    // Synced on 1 December: November is whole, and compares with all of October.
    const december = new Date("2026-12-03T12:00:00.000Z");
    expect(fallbackWindows(emptyStrip(lastDay, "month", december), lastDay, december)).toMatchObject({
      current: { start: "2026-11-01", end: "2026-11-30" },
      previous: { start: "2026-10-01", end: "2026-10-31" },
    });
  });

  it.each([
    ["synced exactly 48 hours before now", "2026-11-03T12:00:00.000Z", ["2026-10-26", "2026-11-01"]],
    ["synced in the first minute of Monday, so Sunday is whole", "2026-11-02T00:01:00.000Z", ["2026-10-26", "2026-11-01"]],
    ["synced in the last minute of Sunday, so Sunday is not whole", "2026-11-01T23:59:00.000Z", ["2026-10-19", "2026-10-25"]],
    ["synced one millisecond before Wednesday, the last required day", "2026-11-03T23:59:59.999Z", ["2026-10-26", "2026-11-01"]],
  ])("boundary: %s", (_name, lastSyncedAt, [start, end]) => {
    const owners = [connection(vercel.id, "vercel", { last_synced_at: lastSyncedAt })];
    expect(fallbackWindows(emptyStrip(owners), owners, NOW)?.current).toEqual({ start, end });
  });

  it("takes no fallback when no connection is stale: a sync at the start of the last required day (boundary)", () => {
    const owners = [connection(vercel.id, "vercel", { last_synced_at: "2026-11-04T00:00:00.000Z" })];
    expect(fallbackWindows(emptyStrip(owners), owners, NOW)).toBeNull();
  });

  it("keeps a fresh strip's own reasons, with no second read, when its providers report none of the figures (boundary: GitHub only)", () => {
    const current = headline({ snapshots: [allowance(github.id, "2026-10-01")], connections: [github] });
    expect(hasFigure(current)).toBe(false);
    expect(current.spend).toMatchObject({ lines: null, unavailable: ["GitHub"] });
    expect(fallbackWindows(current, [github], NOW)).toBeNull();
    expect(chooseHeadline(current, null)).toEqual({ status: "current", strip: current });
  });

  it("takes no fallback for a disconnected connection, which no sync brings up to date (boundary: revoked)", () => {
    const revoked = connection(vercel.id, "vercel", { status: "revoked", last_synced_at: "2026-10-20T09:00:00.000Z" });
    expect(fallbackWindows(emptyStrip([revoked]), [revoked], NOW)).toBeNull();
    // Beside a connection that is stale and can sync, the window follows that one alone.
    const owners = [revoked, connection(supabase.id, "supabase", { last_synced_at: "2026-11-02T09:00:00.000Z" })];
    expect(fallbackWindows(emptyStrip(owners), owners, NOW)?.current).toEqual({ start: "2026-10-26", end: "2026-11-01" });
  });

  it("goes by the stale connections only, so a fresh one behind no figure does not keep the window too recent", () => {
    // GitHub reports nothing the strip counts and synced an hour ago; Vercel last synced on 2026-10-20.
    const owners = [github, connection(vercel.id, "vercel", { last_synced_at: "2026-10-20T09:00:00.000Z" })];
    expect(fallbackWindows(emptyStrip(owners), owners, NOW)?.current).toEqual({ start: "2026-10-12", end: "2026-10-18" });
  });

  it("has no last complete window when nothing in view has synced (boundary: no complete window at all)", () => {
    const neverSynced = [connection(vercel.id, "vercel", { last_synced_at: null })];
    expect(fallbackWindows(emptyStrip(neverSynced), neverSynced, NOW)).toBeNull();
    expect(fallbackWindows(emptyStrip([]), [], NOW)).toBeNull();
  });

  it("explains once instead of six unavailable figures when the last complete week has none either (boundary: no complete window at all)", () => {
    // Connected on 2026-10-30, after the last complete week began.
    const late = runningTotal({ connectionId: vercel.id, metricKey: "vercel.spend.total", perDay: 100, from: "2026-10-30", to: "2026-11-02" });
    const current = headline({ snapshots: late, connections: [stale(vercel)] });
    const fallback = headline({ snapshots: late, connections: [stale(vercel)], windows: lastWeek() });
    expect(hasFigure(fallback)).toBe(false);
    expect(chooseHeadline(current, fallback)).toEqual({ status: "empty", current: current.windows });
    // Without a fallback taken, the strip keeps its own reasons.
    expect(chooseHeadline(current, null)).toEqual({ status: "current", strip: current });
  });

  it("keeps the week so far when one connection is stale and the rest are fresh (boundary: one stale)", () => {
    const fakeUntilSync = runningTotal({ connectionId: fake.id, metricKey: "fake.spend.month", perDay: 30, from: "2026-10-01", to: "2026-11-02" });
    const vercelSpend = runningTotal({ connectionId: vercel.id, metricKey: "vercel.spend.total", perDay: 100, from: "2026-10-01", to: "2026-11-05" });
    const current = headline({ snapshots: [...vercelSpend, ...fakeUntilSync], connections: [vercel, stale(fake)] });
    expect(hasFigure(current)).toBe(true);
    expect(current.spend).toMatchObject({ included: ["Vercel"], unavailable: ["Example provider"] });
    expect(fallbackWindows(current, [vercel, stale(fake)], NOW)).toBeNull();
    expect(chooseHeadline(current, null)).toEqual({ status: "current", strip: current });
  });
});

describe("headline copy", () => {
  const usd = moneyFormatter("USD");
  const week = headlineWindows("week", NOW);
  const month = headlineWindows("month", NOW);
  const lastWeek = { kind: "week", complete: true } as const;

  it.each([
    ["up with a percent", { status: "change", direction: "up", percent: 12.4, previous: 1_000 } as const, "Up 12 percent from $10.00 on the same days last week"],
    ["down by less than 1 percent", { status: "change", direction: "down", percent: 0.3, previous: 1_000 } as const, "Down less than 1 percent from $10.00 on the same days last week"],
    ["up from zero, with no percent", { status: "change", direction: "up", percent: null, previous: 0 } as const, "Up from $0.00 on the same days last week"],
    ["no change", { status: "change", direction: "same", percent: 0, previous: 1_000 } as const, "No change from $10.00 on the same days last week"],
    ["no previous value", { status: "unavailable", missing: "previous" } as const, "No comparison: the same days last week are unavailable"],
  ])("comparison text: %s", (_name, comparison, expected) => {
    expect(headlineComparisonText(comparison, usd, week)).toBe(expected);
  });

  it("names the providers that could not report the previous window", () => {
    expect(
      headlineComparisonText({ status: "unavailable", missing: "previous" }, usd, month, { reason: "providers", names: ["Stripe", "Vercel"] }),
    ).toBe("No comparison: Stripe and Vercel could not report the same days last month");
    expect(headlineComparisonText({ status: "unavailable", missing: "previous" }, usd, week, { reason: "no_signups" })).toBe(
      "No comparison: there were no signups on the same days last week",
    );
  });

  it("compares a last complete window with the whole one before it", () => {
    expect(headlineTitle(week)).toBe("This week so far");
    expect(headlineTitle(lastWeek)).toBe("Last complete week");
    expect(headlineTitle({ kind: "month", complete: true })).toBe("Last complete month");
    expect(headlineComparisonText({ status: "change", direction: "up", percent: 50, previous: 1_000 }, usd, lastWeek)).toBe(
      "Up 50 percent from $10.00 in the week before",
    );
    expect(headlineComparisonText({ status: "unavailable", missing: "previous" }, usd, { kind: "month", complete: true })).toBe(
      "No comparison: the month before is unavailable",
    );
    expect(headlineFallbackNote(week)).toBe(
      "Nothing can be shown for this week so far: no connection in this view has a reading for every day of it yet. These figures are for the last complete week instead.",
    );
    expect(headlineEmptyNote(month)).toBe(
      "Nothing can be shown for this month so far or for the last complete month: each figure needs a reading for every day of its window, and no connection in this view has one. Figures appear once a connection has synced every day of a month.",
    );
  });

  it("describes the windows as UTC dates, a single day once", () => {
    expect(windowDescription(week)).toBe("2026-11-02 to 2026-11-05 in UTC, compared with 2026-10-26 to 2026-10-29.");
    expect(windowDescription(headlineWindows("week", new Date("2026-11-02T08:00:00.000Z")))).toBe("2026-11-02 in UTC, compared with 2026-10-26.");
  });

  it("explains cost per signup with exactly the providers in it and the ones left out", () => {
    expect(
      costPerSignupExplanation({
        spendFrom: ["GitHub", "Vercel"],
        signupsFrom: ["Supabase"],
        spendUnavailable: ["Resend", "Supabase"],
        signupsUnavailable: ["Example provider"],
        signupsWholeDays: [],
      }),
    ).toBe(
      "Spend from GitHub and Vercel, divided by signups from Supabase. Leaves out spend from Resend and Supabase, unavailable for this window. Leaves out signups from Example provider, unavailable for this window. Each currency on its own, verified and estimated spend apart, rounded once to the currency's smallest unit.",
    );
  });

  it("says which signup sources count whole UTC days, so today is not in their count", () => {
    expect(
      costPerSignupExplanation({
        spendFrom: ["Vercel"],
        signupsFrom: ["PostHog", "Supabase"],
        spendUnavailable: [],
        signupsUnavailable: [],
        signupsWholeDays: ["PostHog"],
      }),
    ).toBe(
      "Spend from Vercel, divided by signups from PostHog and Supabase. PostHog counts signups by whole UTC day, so today is not in its count yet. Each currency on its own, verified and estimated spend apart, rounded once to the currency's smallest unit.",
    );
    expect(wholeDaysNote(["Acme", "PostHog"])).toBe("Acme and PostHog count signups by whole UTC day, so today is not in their count yet.");
  });

  it("never prints a dash or an exclamation mark", () => {
    const texts = [
      headlineComparisonText({ status: "change", direction: "down", percent: 50, previous: -500 }, usd, week),
      headlineComparisonText({ status: "unavailable", missing: "previous" }, usd, lastWeek),
      windowDescription(month),
      costPerSignupExplanation({ spendFrom: ["Vercel"], signupsFrom: ["PostHog"], spendUnavailable: [], signupsUnavailable: [], signupsWholeDays: ["PostHog"] }),
      wholeDaysNote(["PostHog"]),
      headlineFallbackNote(month),
      headlineEmptyNote(week),
    ];
    for (const text of texts) expect(text).not.toMatch(/[\u2013\u2014!]/);
  });
});

describe("headlineEventTypes", () => {
  const declaration = (id: string, category?: EventType["category"]): EventType => ({
    id,
    label: "Event",
    description: "An event.",
    shownByDefault: true,
    emoji: "🚀",
    ...(category === undefined ? {} : { category }),
  });

  it("counts what adapters declare, so a new provider's signups and deploys need no list here", () => {
    expect(
      headlineEventTypes(
        [
          declaration("acme.user.created", "signup"),
          declaration("acme.release.done", "deploy_succeeded"),
          declaration("acme.release.broke", "deploy_failed"),
        ],
        ["acme.signups.day"],
      ),
    ).toEqual({
      signups: ["acme.user.created"],
      deploys: ["acme.release.done", "acme.release.broke"],
      failedDeploys: ["acme.release.broke"],
      signupDailyTotals: ["acme.signups.day"],
    });
  });

  it("leaves out event types declared with no category", () => {
    expect(headlineEventTypes([declaration("acme.domain.verified"), declaration("acme.invoice.issued")], [])).toEqual({
      signups: [],
      deploys: [],
      failedDeploys: [],
      signupDailyTotals: [],
    });
  });

  it("counts the registered adapters' signups and deploys, DigitalOcean's, Railway's, and GitLab's included", () => {
    expect(EVENT_TYPES.signups).toEqual(expect.arrayContaining(["fake.signup", "supabase.auth.signup"]));
    expect(EVENT_TYPES.deploys).toEqual(
      expect.arrayContaining([
        "fake.deploy.succeeded",
        "vercel.deployment.succeeded",
        "vercel.deployment.failed",
        "digitalocean.deployment.succeeded",
        "digitalocean.deployment.failed",
        "railway.deployment.deployed",
        "railway.deployment.failed",
        "gitlab.deployment.succeeded",
        "gitlab.deployment.failed",
      ]),
    );
    expect(EVENT_TYPES.failedDeploys).toEqual(
      expect.arrayContaining(["vercel.deployment.failed", "digitalocean.deployment.failed", "railway.deployment.failed", "gitlab.deployment.failed"]),
    );
    expect(EVENT_TYPES.failedDeploys).not.toContain("railway.deployment.deployed");
    // A start says nothing about how a deployment ended; a Railway crash or removal comes after a
    // deployment already counted; a CI pipeline may deploy nothing; releases are not deployments.
    const notDeploys = [
      "digitalocean.deployment.started",
      "railway.deployment.building",
      "railway.deployment.crashed",
      "railway.deployment.removed",
      "sentry.release.created",
      "gitlab.pipeline.succeeded",
      "gitlab.pipeline.failed",
      "gitlab.release.published",
      "gitlab.merge_request.merged",
    ];
    expect([...EVENT_TYPES.signups, ...EVENT_TYPES.deploys].filter((id) => notDeploys.includes(id))).toEqual([]);
    // Daily summaries are one event a day, not one per signup, so they are not counted as signups;
    // PostHog's signups come from its declared daily total instead.
    expect(EVENT_TYPES.signups).not.toContain("supabase.auth.daily_summary");
    expect(EVENT_TYPES.signups).not.toContain("posthog.signups.daily");
    expect(EVENT_TYPES.signupDailyTotals).toEqual(expect.arrayContaining(["posthog.signups.daily"]));
    // Payments are not signups: Stripe's customer and subscription events and Polar's orders and
    // subscriptions have no category.
    const payments = ["stripe.customer.created", "stripe.customer.subscription.created", "polar.order.paid", "polar.subscription.started"];
    expect([...EVENT_TYPES.signups, ...EVENT_TYPES.deploys].filter((id) => payments.includes(id))).toEqual([]);
    expect(revenueProviderIds).toEqual(expect.arrayContaining(["stripe", "polar"]));
  });
});
