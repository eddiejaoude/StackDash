import type { Database } from "../src/lib/supabase/database.types";

import { expect, ownerTest } from "./fixtures/auth";
import { adminClient, createTestWorkspace, deleteTestWorkspace, notDueForAMonth, type TestWorkspace } from "./fixtures/db";

/*
 * The monthly trend of a history longer than the 10,000 row snapshot read cap (#317), kept apart
 * from e2e/trends.spec.ts because of what its seed does to Realtime. The seed writes about 22,500
 * rows to usage_snapshots, a table in the Realtime publication, and Realtime reads every one of them
 * before any live change written after them, in any workspace. In CI that held up live changes for
 * most of a minute, and the specs running beside it that wait 15 s for one failed (#621). So this
 * spec lives alone in the `bulk-writes` Playwright project (playwright.config.ts), which runs after
 * every other spec, and it waits on no live change itself.
 */

const DAY_MS = 86_400_000;

type SnapshotInsert = Database["public"]["Tables"]["usage_snapshots"]["Insert"];

// Enough daily metrics that 13 months of them pass the 10,000 row snapshot read cap (#317).
const LONG_HISTORY_METRICS = 60;
const LONG_HISTORY_BATCH = 1000;
const UTC_MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

type SeededLongHistory = { firstMonth: string; lastMonth: string; rows: number };

/**
 * Every UTC day of the 13 month trend window for one fake account: verified spend worth $1.00 in
 * the oldest month, $2.00 in the next, up to $13.00 in the current one, beside 59 usage metrics.
 * That is about 22,500 rows, so a capped read of 10,000 snapshot rows newest first never reaches
 * the oldest months (#317).
 */
async function seedLongHistory(workspace: TestWorkspace): Promise<SeededLongHistory> {
  const admin = adminClient();
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 12, 1));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "fake",
      status: "active",
      granted_at: new Date().toISOString(),
      display_name: "Fake billing account",
      poll_interval_seconds: 3_600,
      last_synced_at: now.toISOString(),
      next_sync_at: notDueForAMonth(),
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_id: "acct_long_history",
      display_name: "Production",
      kind: "account",
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);

  const rows: SnapshotInsert[] = [];
  for (let day = start.getTime(); day <= today; day += DAY_MS) {
    const month = new Date(day);
    const date = month.toISOString().slice(0, 10);
    const at = `${date}T06:00:00.000Z`;
    const monthIndex = (month.getUTCFullYear() - start.getUTCFullYear()) * 12 + month.getUTCMonth() - start.getUTCMonth();
    const base = {
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_account_id: account.id,
      snapshot_date: date,
      point_at: at,
      retrieved_at: at,
      provenance_source: "provider_api",
    } as const;
    rows.push({
      ...base,
      metric_key: "fake.spend.month",
      kind: "verified_spend",
      label: "Spend this month",
      currency: "USD",
      amount_minor: (monthIndex + 1) * 100,
    });
    for (let metric = 1; metric < LONG_HISTORY_METRICS; metric += 1) {
      const suffix = String(metric).padStart(2, "0");
      rows.push({ ...base, metric_key: `fake.filler_${suffix}.count`, kind: "usage", label: `Filler ${suffix}`, unit: "requests", value: metric });
    }
  }
  for (let from = 0; from < rows.length; from += LONG_HISTORY_BATCH) {
    const { error } = await admin.from("usage_snapshots").insert(rows.slice(from, from + LONG_HISTORY_BATCH));
    if (error) throw new Error(`Seeding snapshots failed (code ${error.code}).`);
  }
  return { firstMonth: UTC_MONTH.format(start), lastMonth: UTC_MONTH.format(today), rows: rows.length };
}

ownerTest.describe("dashboard trends", () => {
  ownerTest("shows every month of the monthly trend past the 10,000 row snapshot read cap", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard trend long history");
    try {
      const { firstMonth, lastMonth, rows } = await seedLongHistory(workspace);
      expect(rows).toBeGreaterThan(20_000);
      await page.goto(`/w/${workspace.slug}/dashboard?trend=monthly`);
      const trends = page.getByRole("region", { name: "Trends" });
      await expect(trends.getByRole("link", { name: "Monthly, last 13 months" })).toHaveAttribute("aria-current", "page");
      const chart = trends.getByRole("figure", { name: "Spend this month (Example provider, USD)" }).getByRole("img");
      // The oldest month is read: the trend starts there, and no month is unavailable.
      await expect(chart).toHaveAttribute(
        "aria-label",
        `Spend this month (Example provider, USD), last 13 months. From $1.00 on ${firstMonth} to $13.00 on ${lastMonth}. Up 8 percent from last month.`,
      );
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
