import { describe, expect, it } from "vitest";

import { balanceMetrics, digitaloceanAdapter, invoiceMetric, skuSpendMetrics } from "@/lib/adapters/digitalocean";
import { fakeAdapter } from "@/lib/adapters/fake";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import { billingMetrics as postHogBillingMetrics } from "@/lib/adapters/posthog";
import { BillingResponseSchema } from "@/lib/adapters/posthog/schemas";
import { billingMetrics as railwayBillingMetrics } from "@/lib/adapters/railway";
import { BillingDataSchema } from "@/lib/adapters/railway/schemas";
import { declaredProjectedSpend } from "@/lib/adapters/registry";
import { Secret, type ProviderAdapter } from "@/lib/adapters/types";
import { addUtcDays, ANOMALY_TYPE_ID } from "@/lib/alerts/anomaly";
import type { Logger } from "@/lib/log/logger";
import type { Decimal } from "@/lib/money";
import { memoryNotificationDeps } from "@/lib/notifications/memory-store";

import { DAILY_SUMMARY_TYPE_ID, dailySummaryJobKey, runDailySummaryJob, summaryDate } from "./daily-summary";
import { toSnapshotRow } from "./ingest";
import { MemoryJobStore, type MemorySnapshot } from "./memory-store";
import { runTick } from "./runner";
import type { SyncDeps } from "./sync-connection";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const vercelStub: ProviderAdapter = { ...fakeAdapter, id: "vercel", displayName: "Vercel" };

function setup(start = "2026-10-15T00:05:00.000Z") {
  const clock = new Date(start);
  const now = () => clock;
  const store = new MemoryJobStore(now);
  const deps: SyncDeps = {
    store,
    getAdapter: (id) => (id === "vercel" ? vercelStub : id === "digitalocean" ? digitaloceanAdapter : fakeAdapter),
    loadOAuthClient: () => ({ clientId: "id", clientSecret: new Secret("secret"), extra: {} }),
    createOAuthContext: (client) => ({ client, fetch: () => Promise.reject(new Error("offline")), now, timeoutMs: 1000, logger: silent }),
    now,
    random: () => 0.5,
    logError: () => "REF-TEST0000",
    log: silent,
    evaluateAlerts: async () => ({ triggered: 0 }),
    evaluateAchievements: async () => 0,
    notifications: () => memoryNotificationDeps(),
  };
  return { store, deps, now };
}

function snapshot(fields: Partial<MemorySnapshot> & Pick<MemorySnapshot, "connection_id" | "metric_key" | "kind">): MemorySnapshot {
  return {
    id: crypto.randomUUID(),
    workspace_id: WORKSPACE_ID,
    external_account_id: crypto.randomUUID(),
    label: "Metric",
    snapshot_date: "2026-10-14",
    point_at: "2026-10-14T23:00:00.000Z",
    retrieved_at: "2026-10-14T23:00:00.000Z",
    provenance_source: "provider_api",
    ...fields,
  };
}

function summaries(store: MemoryJobStore) {
  return store.events.filter((event) => event.type_id === DAILY_SUMMARY_TYPE_ID);
}

describe("summaryDate", () => {
  it("reports on the previous UTC day, at both edges of the day", () => {
    expect(summaryDate(new Date("2026-10-15T00:00:00.000Z"))).toBe("2026-10-14");
    expect(summaryDate(new Date("2026-10-15T23:59:59.999Z"))).toBe("2026-10-14");
  });
});

describe("daily summary (#64)", () => {
  it("writes exactly one summary per workspace per day even if the job runs twice", async () => {
    const { store, deps } = setup();
    const connection = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "fake", status: "needs_attention" });
    store.snapshots.push(
      snapshot({ connection_id: connection.id, metric_key: "fake.spend.month", kind: "verified_spend", amount_minor: 1234, currency: "USD" }),
    );

    const first = await runTick(deps);
    expect(first.summariesQueued).toBe(1);
    const second = await runTick(deps);
    expect(second.summariesQueued).toBe(0);

    const job = store.jobs.find((row) => row.kind === "daily_summary");
    expect(job?.dedupe_key).toBe(dailySummaryJobKey(WORKSPACE_ID, "2026-10-14"));
    expect(job?.status).toBe("succeeded");
    if (job === undefined) throw new Error("no summary job");
    // The same job run again (a retry after a lost lease) still writes one event.
    await runDailySummaryJob(job, deps);

    const events = summaries(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: null,
      connection_id: null,
      url: null,
      dedupe_key: "daily_summary:2026-10-14",
      title: "Daily summary for 2026-10-14",
      occurred_at: "2026-10-15T00:00:00.000Z",
    });
  });

  it("writes no summary for a workspace without connections", async () => {
    const { store, deps } = setup();
    // Another workspace has a connection, so the scheduler runs, but not for this workspace.
    store.addConnection({ workspace_id: OTHER_WORKSPACE_ID, provider: "fake", status: "needs_attention" });
    store.addConnection({ workspace_id: WORKSPACE_ID, provider: "fake", status: "revoked" });

    const result = await runTick(deps);
    expect(result.summariesQueued).toBe(1);
    expect(summaries(store).map((event) => event.workspace_id)).toEqual([OTHER_WORKSPACE_ID]);

    const orphan = store.newJob({
      workspace_id: WORKSPACE_ID,
      connection_id: null,
      kind: "daily_summary",
      dedupe_key: dailySummaryJobKey(WORKSPACE_ID, "2026-10-14"),
    });
    expect(await runDailySummaryJob(orphan, deps)).toEqual({ status: "succeeded" });
    expect(summaries(store).filter((event) => event.workspace_id === WORKSPACE_ID)).toHaveLength(0);
  });

  it("labels every value verified, estimated, or unavailable", async () => {
    const { store, deps } = setup();
    const fake = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "fake", status: "needs_attention" });
    store.addConnection({ workspace_id: WORKSPACE_ID, provider: "vercel", status: "needs_attention" });
    store.snapshots.push(
      snapshot({ connection_id: fake.id, metric_key: "fake.spend.month", kind: "verified_spend", amount_minor: 1234, currency: "USD" }),
      // An estimate of spend so far; `fake.cost.estimate` is the month's projection (#223), so not this.
      snapshot({ connection_id: fake.id, metric_key: "fake.spend.estimated", kind: "estimated_spend", amount_minor: 4000, currency: "USD", provenance_source: "derived", pricing_source: "List" }),
      snapshot({ connection_id: fake.id, metric_key: "fake.requests.month", kind: "usage", label: "Requests this month", value: 16800, unit: "requests" }),
      // A different day is not part of the summary.
      snapshot({ connection_id: fake.id, metric_key: "fake.spend.month", kind: "verified_spend", amount_minor: 999, currency: "USD", snapshot_date: "2026-10-13" }),
    );

    await runTick(deps);
    const body = summaries(store)[0]?.body ?? "";
    expect(body.split("\n")).toEqual([
      "Example provider: Spending $40.00 (estimated)",
      "Example provider: Spending $12.34 (verified)",
      "Example provider: Requests this month 16,800 requests (verified)",
      // Point readings with no reset say nothing about when the period ends.
      "Example provider: Spending projection in USD unavailable (the end of the period is unknown)",
      "Vercel: Spending unavailable",
      "Vercel: Usage unavailable",
    ]);
  });

  it("keeps two currencies apart and never adds them together", async () => {
    const { store, deps } = setup();
    const fake = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "fake", status: "needs_attention" });
    store.snapshots.push(
      snapshot({ connection_id: fake.id, metric_key: "fake.spend.month", kind: "verified_spend", amount_minor: 1000, currency: "USD" }),
      snapshot({ connection_id: fake.id, metric_key: "fake.spend.month", kind: "verified_spend", amount_minor: 250, currency: "USD" }),
      snapshot({ connection_id: fake.id, metric_key: "fake.spend.month", kind: "verified_spend", amount_minor: 500, currency: "EUR" }),
    );

    await runTick(deps);
    const body = summaries(store)[0]?.body ?? "";
    expect(body).toContain("Example provider: Spending €5.00 (verified)");
    expect(body).toContain("Example provider: Spending $12.50 (verified)");
    expect(body).not.toContain("17.50");
  });

  describe("projection to the end of the period (#167)", () => {
    const ACCOUNT = "44444444-4444-4444-8444-444444444444";
    const NOVEMBER = { period_start: "2026-11-01T00:00:00.000Z", period_end: "2026-12-01T00:00:00.000Z", point_at: null };

    /** One reading a day at 06:00 UTC from 2026-11-01, for the summary of 2026-11-05. */
    function daily(connectionId: string, values: readonly number[], fields: Partial<MemorySnapshot> & Pick<MemorySnapshot, "metric_key" | "kind">) {
      return values.map((value, index) => {
        const date = `2026-11-0${index + 1}`;
        const at = `${date}T06:00:00.000Z`;
        return snapshot({
          connection_id: connectionId,
          external_account_id: ACCOUNT,
          snapshot_date: date,
          retrieved_at: at,
          ...NOVEMBER,
          ...(fields.kind === "verified_spend" ? { amount_minor: value, currency: "USD" } : { value, unit: "requests" }),
          ...fields,
        });
      });
    }

    it("adds the spend projection and a quota's run-out date, labeled as estimates", async () => {
      const { store, deps } = setup("2026-11-06T00:05:00.000Z");
      const fake = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "fake", status: "needs_attention" });
      const resets = { resets_at: "2026-12-01T00:00:00.000Z" };
      store.snapshots.push(
        ...daily(fake.id, [100, 200, 300, 400, 500], { metric_key: "fake.spend.month", kind: "verified_spend" }),
        ...daily(fake.id, [400, 800, 1200, 1600, 2000], { metric_key: "fake.requests.month", kind: "usage", label: "Requests this month", ...resets }),
        ...daily(fake.id, [3000], {
          metric_key: "fake.requests.included",
          kind: "included_allowance",
          label: "Requests included in the plan",
          snapshot_date: "2026-11-05",
          retrieved_at: "2026-11-05T06:00:00.000Z",
          ...resets,
        }),
        // After the summarized day: never part of it, not even of the projection.
        ...daily(fake.id, [100, 200, 300, 400, 500, 99999], { metric_key: "fake.spend.month", kind: "verified_spend" }).slice(5),
      );

      await runTick(deps);
      const body = summaries(store)[0]?.body ?? "";
      expect(body.split("\n")).toEqual([
        "Example provider: Spending $5.00 (verified)",
        "Example provider: Requests this month 2,000 requests (verified)",
        // 500 cents plus 100 a day from 2026-11-05 06:00 to 2026-12-01.
        "Example provider: Spending on track for $30.75 by 2026-11-30 (estimate by StackDash)",
        "Example provider: Requests included in the plan runs out around 2026-11-07 (estimate by StackDash)",
      ]);
    });

    it("says why there is no projection with fewer than 3 days of data", async () => {
      const { store, deps } = setup("2026-11-03T00:05:00.000Z");
      const fake = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "fake", status: "needs_attention" });
      store.snapshots.push(...daily(fake.id, [100, 200], { metric_key: "fake.spend.month", kind: "verified_spend" }));

      await runTick(deps);
      expect(summaries(store)[0]?.body).toContain("Example provider: Spending projection in USD unavailable (fewer than 3 days of data)");
    });

    it("projects GitHub's month once, not its SKU and day rows as amounts of their own (#137)", async () => {
      const { store, deps } = setup("2026-11-06T00:05:00.000Z");
      const github = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "github", status: "needs_attention" });
      const spend = { kind: "verified_spend" } as const;
      store.snapshots.push(
        ...daily(github.id, [100, 200, 300, 400, 500], { ...spend, metric_key: "github.spend.actions" }),
        ...daily(github.id, [100, 200, 300, 400, 500], { ...spend, metric_key: "github.spend.actions.actions_linux" }),
        // A one day window each day: inside the month, so never projected on its own.
        ...daily(github.id, [100, 100, 100, 100, 100], { ...spend, metric_key: "github.daily_spend.actions" }).map((row) => ({
          ...row,
          period_start: `${row.snapshot_date}T00:00:00.000Z`,
          period_end: new Date(Date.parse(`${row.snapshot_date}T00:00:00.000Z`) + 86_400_000).toISOString(),
        })),
      );

      await runTick(deps);
      expect(summaries(store)[0]?.body?.split("\n")).toEqual([
        "GitHub: Spending $5.00 (verified)",
        "GitHub: Usage unavailable",
        "GitHub: Spending on track for $30.75 by 2026-11-30 (estimate by StackDash)",
      ]);
    });

    it("says how many amounts held a sum back when only some could not be projected", async () => {
      const { store, deps } = setup("2026-11-06T00:05:00.000Z");
      const fake = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "fake", status: "needs_attention" });
      store.snapshots.push(
        ...daily(fake.id, [100, 200, 300, 400, 500], { metric_key: "fake.spend.month", kind: "verified_spend" }),
        ...daily(fake.id, [10, 20, 30, 40, 50], { metric_key: "fake.spend.month", kind: "verified_spend" })
          .slice(3)
          .map((row) => ({ ...row, external_account_id: "55555555-5555-4555-8555-555555555555" })),
      );

      await runTick(deps);
      expect(summaries(store)[0]?.body).toContain("Example provider: Spending projection in USD unavailable (1 of 2 amounts: fewer than 3 days of data)");
    });

    it("projects on the last day of the period instead of calling it ended", async () => {
      const { store, deps } = setup("2026-12-01T00:05:00.000Z");
      const fake = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "fake", status: "needs_attention" });
      store.snapshots.push(
        ...[28, 29, 30].map((day, index) =>
          snapshot({
            connection_id: fake.id,
            external_account_id: ACCOUNT,
            metric_key: "fake.spend.month",
            kind: "verified_spend",
            snapshot_date: `2026-11-${day}`,
            retrieved_at: `2026-11-${day}T06:00:00.000Z`,
            ...NOVEMBER,
            amount_minor: (index + 1) * 100,
            currency: "USD",
          }),
        ),
      );

      await runTick(deps);
      // 300 cents on 2026-11-30 06:00 plus 100 a day for the 18 hours left.
      expect(summaries(store)[0]?.body).toContain("Example provider: Spending on track for $3.75 by 2026-11-30 (estimate by StackDash)");
    });
  });

  it("counts GitHub spend once, not again per SKU and per day (#137)", async () => {
    const { store, deps } = setup();
    const github = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "github", status: "needs_attention" });
    const account = { connection_id: github.id, external_account_id: crypto.randomUUID(), kind: "verified_spend", currency: "USD", point_at: null } as const;
    const month = { period_start: "2026-10-01T00:00:00.000Z", period_end: "2026-11-01T00:00:00.000Z" };
    store.snapshots.push(
      snapshot({ ...account, metric_key: "github.spend.actions", amount_minor: 5175, ...month }),
      snapshot({ ...account, metric_key: "github.spend.actions.actions_linux", amount_minor: 5175, ...month }),
      snapshot({ ...account, metric_key: "github.daily_spend.actions", amount_minor: 1252, period_start: "2026-10-14T00:00:00.000Z", period_end: "2026-10-15T00:00:00.000Z" }),
    );

    await runTick(deps);
    // The month alone is projected (one day of it so far); the SKU and the day are not amounts of their own.
    expect(summaries(store)[0]?.body?.split("\n")).toEqual([
      "GitHub: Spending $51.75 (verified)",
      "GitHub: Usage unavailable",
      "GitHub: Spending projection in USD unavailable (fewer than 3 days of data)",
    ]);
  });

  it("still counts a GitHub day when another account reports the month (#137)", async () => {
    const { store, deps } = setup();
    const github = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "github", status: "needs_attention" });
    const common = { connection_id: github.id, kind: "verified_spend", currency: "USD", point_at: null } as const;
    const monthAccount = crypto.randomUUID();
    const dayAccount = crypto.randomUUID();
    store.snapshots.push(
      snapshot({ ...common, external_account_id: monthAccount, metric_key: "github.spend.actions", amount_minor: 5175, period_start: "2026-10-01T00:00:00.000Z", period_end: "2026-11-01T00:00:00.000Z" }),
      snapshot({ ...common, external_account_id: dayAccount, metric_key: "github.daily_spend.actions", amount_minor: 1252, period_start: "2026-10-14T00:00:00.000Z", period_end: "2026-10-15T00:00:00.000Z" }),
    );

    await runTick(deps);
    expect(summaries(store)[0]?.body).toContain("GitHub: Spending $64.27 (verified)");
    // Neither amount can be projected, each for its own reason (the day's window has no end
    // StackDash can project to, the month has one day of data), so the line names both.
    expect(summaries(store)[0]?.body).toContain(
      "GitHub: Spending projection in USD unavailable (2 amounts: the end of the period is unknown, fewer than 3 days of data)",
    );
  });

  describe("spend the dashboard counts for the current period, and nothing else (#215, #176)", () => {
    const cents = (minor: number): Decimal => ({ coefficient: BigInt(minor), scale: 2 });
    const OCTOBER_INVOICE_MINOR = 12_710;
    // The spending line's own shape, never a projection line ("Spending on track for ..." or
    // "Spending projection in USD unavailable (...)"), which the #167 tests above own.
    const SPEND_LINE = /^DigitalOcean: Spending (\$[\d,]+\.\d{2} \((verified|estimated)\)|unavailable)$/;

    /**
     * What one DigitalOcean sync at `at` stores, through the adapter's own metric builders and the
     * sync's `toSnapshotRow`: month to date usage (and the credit beside it), the last issued
     * invoice, and yesterday's spend per SKU. `balanceAt` is when DigitalOcean generated the
     * balance, which right after midnight on the 1st can still be the month before.
     */
    function digitaloceanRows(
      connectionId: string,
      at: string,
      parts: Readonly<{ usageMinor?: number; balanceAt?: string; invoice?: Readonly<{ period: string; minor: number }>; skuMinor?: readonly number[] }>,
    ): MemorySnapshot[] {
      const retrievedAt = new Date(at);
      const account = "team-1";
      const metrics: AdapterMetric[] = [];
      if (parts.usageMinor !== undefined) {
        const balance = { month_to_date_usage: cents(parts.usageMinor), account_balance: cents(-500), generated_at: new Date(parts.balanceAt ?? at) };
        metrics.push(...balanceMetrics(balance, account, retrievedAt));
      }
      if (parts.invoice !== undefined) {
        const invoice = { invoice_uuid: `inv-${parts.invoice.period}`, amount: cents(parts.invoice.minor), invoice_period: parts.invoice.period };
        const metric = invoiceMetric(invoice, account, retrievedAt);
        if (metric !== undefined) metrics.push(metric);
      }
      if (parts.skuMinor !== undefined) {
        const totals = new Map(parts.skuMinor.map((minor, index) => [`1-DO-DROP-010${index}`, cents(minor)] as const));
        metrics.push(...skuSpendMetrics(totals, new Date(retrievedAt.getTime() - 86_400_000), account, retrievedAt));
      }
      return metrics.map((metric) => ({
        id: crypto.randomUUID(),
        ...toSnapshotRow(metric, { id: connectionId, workspace_id: WORKSPACE_ID }, { id: "44444444-4444-4444-8444-444444444444" }),
      }));
    }

    async function digitaloceanSummary(summaryDay: string, rows: (connectionId: string) => MemorySnapshot[]): Promise<string[]> {
      const { store, deps } = setup(`${addUtcDays(summaryDay, 1)}T00:05:00.000Z`);
      const connection = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "digitalocean", status: "needs_attention" });
      store.snapshots.push(...rows(connection.id));
      await runTick(deps);
      return (summaries(store)[0]?.body ?? "").split("\n");
    }

    it("counts DigitalOcean's month to date once, without its last invoice or yesterday's SKU estimates", async () => {
      // The demo seed's 2026-11-05: one sync late each day, $19.91 so far in November, and
      // October's $127.10 invoice read again on every day. The summary said $147.01 (verified).
      const usage = [395, 791, 1175, 1583, 1991];
      const body = await digitaloceanSummary("2026-11-05", (id) =>
        usage.flatMap((usageMinor, index) =>
          digitaloceanRows(id, `2026-11-0${index + 1}T23:59:50.000Z`, {
            usageMinor,
            invoice: { period: "2026-10", minor: OCTOBER_INVOICE_MINOR },
            skuMinor: [96, 192],
          }),
        ),
      );
      expect(body.filter((line) => SPEND_LINE.test(line))).toEqual(["DigitalOcean: Spending $19.91 (verified)"]);
    });

    it.each([
      {
        name: "month to date only",
        day: "2026-11-05",
        parts: { usageMinor: 2104 },
        spending: "DigitalOcean: Spending $21.04 (verified)",
      },
      {
        name: "an invoice-only day (the balance read failed)",
        day: "2026-11-05",
        parts: { invoice: { period: "2026-10", minor: OCTOBER_INVOICE_MINOR } },
        spending: "DigitalOcean: Spending unavailable",
      },
      {
        name: "yesterday's SKU estimates only",
        day: "2026-11-05",
        parts: { skuMinor: [96, 192] },
        spending: "DigitalOcean: Spending unavailable",
      },
      {
        name: "period rollover: the 1st, with the month just invoiced",
        day: "2026-12-01",
        parts: { usageMinor: 96, invoice: { period: "2026-11", minor: 63_000 } },
        spending: "DigitalOcean: Spending $0.96 (verified)",
      },
      {
        name: "period rollover: last month's balance read just after midnight",
        day: "2026-12-01",
        parts: { usageMinor: 63_000, balanceAt: "2026-11-30T23:59:00.000Z", invoice: { period: "2026-10", minor: OCTOBER_INVOICE_MINOR } },
        spending: "DigitalOcean: Spending unavailable",
      },
      {
        name: "the last day of the period, its month to date still open",
        day: "2026-11-30",
        parts: { usageMinor: 62_000, invoice: { period: "2026-10", minor: OCTOBER_INVOICE_MINOR } },
        spending: "DigitalOcean: Spending $620.00 (verified)",
      },
    ])("$name", async ({ day, parts, spending }) => {
      const at = parts.balanceAt === undefined ? `${day}T06:00:00.000Z` : `${day}T00:05:00.000Z`;
      const body = await digitaloceanSummary(day, (id) => digitaloceanRows(id, at, parts));
      expect(body.filter((line) => SPEND_LINE.test(line))).toEqual([spending]);
    });

    it.each([
      { name: "the month alone", rolling: false },
      { name: "the month beside the last 30 days in the same currency", rolling: true },
    ])("counts Stripe's fees for $name once (#176)", async ({ rolling }) => {
      const { store, deps } = setup();
      const stripe = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "stripe", status: "needs_attention" });
      const fees = { connection_id: stripe.id, external_account_id: crypto.randomUUID(), kind: "verified_spend", currency: "USD", point_at: null } as const;
      store.snapshots.push(
        snapshot({ ...fees, metric_key: "stripe.fees.month.usd", amount_minor: 1000, period_start: "2026-10-01T00:00:00.000Z", period_end: "2026-10-14T23:00:00.000Z" }),
        ...(rolling
          ? [snapshot({ ...fees, metric_key: "stripe.fees.last_30_days.usd", amount_minor: 3000, period_start: "2026-09-14T23:00:00.000Z", period_end: "2026-10-14T23:00:00.000Z" })]
          : []),
      );

      await runTick(deps);
      const body = summaries(store)[0]?.body ?? "";
      expect(body).toContain("Stripe: Spending $10.00 (verified)");
      expect(body).not.toContain("$40.00");
    });

    describe("a provider's declared projection for the period is not spending (#223)", () => {
      const period = { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" };
      const readAt = new Date("2026-11-05T23:59:50.000Z");
      // The demo seed's 2026-11-05: PostHog has billed nothing yet and projects $29.86 for the period;
      // Railway has used $7.13 and estimates the whole period's bill.
      const posthog = postHogBillingMetrics(
        BillingResponseSchema.parse({
          current_total_amount_usd: "0.00",
          projected_total_amount_usd: "29.86",
          billing_period: { current_period_start: period.start, current_period_end: period.end },
        }),
        "org-1",
        readAt,
        "us",
      );
      const railway = railwayBillingMetrics(
        BillingDataSchema.parse({
          workspace: { plan: "HOBBY", customer: { billingPeriod: period, currentUsage: 7.13, creditBalance: 0 } },
          usage: [],
          estimatedUsage: [{ measurement: "CPU_USAGE", estimatedValue: 80_000, projectId: "prj-shop" }],
        }),
        "ws-1",
        readAt,
      );
      const PROVIDER_SPEND_LINE = /^(PostHog|Railway): Spending /;

      /** The spending lines of the 2026-11-05 summary, from what one sync stored through the adapters. */
      async function spendingLines(metrics: Readonly<Record<"posthog" | "railway", readonly AdapterMetric[]>>): Promise<string[]> {
        const { store, deps } = setup("2026-11-06T00:05:00.000Z");
        for (const provider of ["posthog", "railway"] as const) {
          const connection = store.addConnection({ workspace_id: WORKSPACE_ID, provider, status: "needs_attention" });
          store.snapshots.push(
            ...metrics[provider].map((metric) => ({
              id: crypto.randomUUID(),
              ...toSnapshotRow(metric, { id: connection.id, workspace_id: WORKSPACE_ID }, { id: crypto.randomUUID() }),
            })),
          );
        }
        await runTick(deps);
        return (summaries(store)[0]?.body ?? "").split("\n").filter((line) => PROVIDER_SPEND_LINE.test(line));
      }

      it("lists only the verified spend beside PostHog's and Railway's projections", async () => {
        // The adapters really do send a projection with an amount, so leaving it out is the rule at work.
        const projections = [...posthog, ...railway].filter((metric) => declaredProjectedSpend.includes(metric.metricKey));
        expect(projections.map((metric) => metric.kind === "estimated_spend" && metric.amountMinor > 0)).toEqual([true, true]);
        // The summary listed each projection beside these as "Spending $X (estimated)" (#223).
        expect(await spendingLines({ posthog, railway })).toEqual([
          "PostHog: Spending $0.00 (verified)",
          // Projected from one day of spend, not from the projection.
          "PostHog: Spending projection in USD unavailable (fewer than 3 days of data)",
          "Railway: Spending $7.13 (verified)",
          "Railway: Spending projection in USD unavailable (fewer than 3 days of data)",
        ]);
      });

      it("lists no spending for a projection with no verified spend in its currency", async () => {
        const only = (metrics: readonly AdapterMetric[]) => metrics.filter((metric) => declaredProjectedSpend.includes(metric.metricKey));
        expect(await spendingLines({ posthog: only(posthog), railway: only(railway) })).toEqual([
          "PostHog: Spending unavailable",
          "Railway: Spending unavailable",
        ]);
      });
    });
  });
});

describe("anomaly detection after the daily summary (#169)", () => {
  /** Vercel month to date spend, $100 a day from 2026-10-01, with `spike` added on 2026-10-14. */
  function seedVercelSpend(store: MemoryJobStore, spike: number) {
    const connection = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "vercel", status: "active" });
    const accountId = crypto.randomUUID();
    let total = 0;
    for (let day = 1; day <= 14; day += 1) {
      const date = `2026-10-${String(day).padStart(2, "0")}`;
      total += 10_000 + (day === 14 ? spike : 0);
      store.snapshots.push(
        snapshot({
          connection_id: connection.id,
          external_account_id: accountId,
          metric_key: "vercel.spend.total",
          kind: "verified_spend",
          label: "Vercel billed spend, month to date",
          amount_minor: total,
          currency: "USD",
          snapshot_date: date,
          point_at: null,
          period_start: "2026-10-01T00:00:00.000Z",
          period_end: `${date}T23:59:50.000Z`,
          retrieved_at: `${date}T23:59:50.000Z`,
        }),
      );
    }
    return connection;
  }

  function anomalies(store: MemoryJobStore) {
    return store.events.filter((event) => event.type_id === ANOMALY_TYPE_ID);
  }

  it("writes exactly one event for the spike day, naming the provider, metric, value, and usual value", async () => {
    const { store, deps } = setup();
    const connection = seedVercelSpend(store, 30_000);

    await runTick(deps);
    const job = store.jobs.find((row) => row.kind === "daily_summary");
    if (job === undefined) throw new Error("no summary job");
    // A retry of the same job writes nothing new.
    await runDailySummaryJob(job, deps);

    const events = anomalies(store);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "vercel",
      connection_id: connection.id,
      severity: "warning",
      title: "Unusual spend on Vercel: 4 times the usual daily spend",
      dedupe_key: "anomaly:2026-10-14:vercel:vercel.spend.total:money:USD:verified",
    });
    expect(events[0]?.body).toContain("Vercel billed spend, month to date (verified) went up by $400.00 on 2026-10-14");
    // 2026-10-01 starts the period and has no day before it, so 12 of the 14 days count.
    expect(events[0]?.body).toContain("The usual amount is $100.00 a day, the median of 12 of the 14 days before.");
    expect(summaries(store)).toHaveLength(1);
  });

  it("writes nothing on an ordinary day", async () => {
    const { store, deps } = setup();
    seedVercelSpend(store, 0);
    await runTick(deps);
    expect(anomalies(store)).toEqual([]);
    expect(summaries(store)).toHaveLength(1);
  });

  it("stops new events for a muted metric, and only for that metric", async () => {
    const { store, deps } = setup();
    seedVercelSpend(store, 30_000);
    store.anomalyMutes.push(
      { workspace_id: WORKSPACE_ID, provider: "vercel", metric_key: "vercel.spend.total" },
      { workspace_id: OTHER_WORKSPACE_ID, provider: "vercel", metric_key: "vercel.spend.other" },
    );
    await runTick(deps);
    expect(anomalies(store)).toEqual([]);
    expect(summaries(store)).toHaveLength(1);
  });

  it("writes nothing while the workspace has anomaly detection turned off", async () => {
    const { store, deps } = setup();
    seedVercelSpend(store, 30_000);
    store.anomalyDisabled.add(WORKSPACE_ID);
    await runTick(deps);
    expect(anomalies(store)).toEqual([]);
    expect(summaries(store)).toHaveLength(1);
  });

  it("checks a one day series reported the day after on the day before the summarized day, then that day the next night", async () => {
    // Supabase daily active users: each finished day is stored the day after, under the next
    // snapshot date, after the summary job for that next date's previous day has already run.
    const { store, deps } = setup();
    const connection = store.addConnection({ workspace_id: WORKSPACE_ID, provider: "supabase", status: "active" });
    const accountId = crypto.randomUUID();
    const storeDay = (day: string, users: number) =>
      store.snapshots.push(
        snapshot({
          connection_id: connection.id,
          external_account_id: accountId,
          metric_key: "supabase.auth.daily_active_users",
          kind: "usage",
          label: "Daily active users",
          value: users,
          unit: "users",
          snapshot_date: addUtcDays(day, 1),
          point_at: null,
          period_start: `${day}T00:00:00.000Z`,
          period_end: `${addUtcDays(day, 1)}T00:00:00.000Z`,
          retrieved_at: `${addUtcDays(day, 1)}T00:00:30.000Z`,
        }),
      );
    for (let day = "2026-09-29"; day <= "2026-10-13"; day = addUtcDays(day, 1)) storeDay(day, day === "2026-10-13" ? 900 : 200);

    // 2026-10-15 00:05: the summary for 2026-10-14, whose own row is not stored yet.
    await runTick(deps);
    expect(anomalies(store).map((event) => event.dedupe_key)).toEqual(["anomaly:2026-10-13:supabase:supabase.auth.daily_active_users:quantity:users:verified"]);
    expect(anomalies(store)[0]).toMatchObject({ occurred_at: "2026-10-14T00:00:00.000Z" });
    expect(anomalies(store)[0]?.body).toContain("Daily active users (verified) was 900 users on 2026-10-13.");

    // 2026-10-15 brings 2026-10-14's row, a second spike; the next night's summary checks 2026-10-14.
    storeDay("2026-10-14", 1000);
    const next = await runDailySummaryJob(
      { id: crypto.randomUUID(), kind: "daily_summary", workspace_id: WORKSPACE_ID, connection_id: null, attempts: 1, max_attempts: 3, created_at: "2026-10-16T00:00:05.000Z", dedupe_key: dailySummaryJobKey(WORKSPACE_ID, "2026-10-15"), webhook_delivery_id: null },
      deps,
    );
    expect(next).toEqual({ status: "succeeded" });
    expect(anomalies(store).map((event) => event.dedupe_key)).toEqual([
      "anomaly:2026-10-13:supabase:supabase.auth.daily_active_users:quantity:users:verified",
      "anomaly:2026-10-14:supabase:supabase.auth.daily_active_users:quantity:users:verified",
    ]);
  });
});
