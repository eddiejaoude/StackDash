import type { Database } from "../src/lib/supabase/database.types";

import { expect, ownerTest } from "./fixtures/auth";
import { expectNoAxeViolations, waitForTrends } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, notDueForAMonth, type TestWorkspace } from "./fixtures/db";
import { HIDE_DEV_INDICATOR } from "./fixtures/webhook-panel";

/*
 * The dashboard's one notice when a snapshot read stops at its 10,000 row cap, newest first (#336).
 * Each test seeds its own workspace with synthetic rows from the fake provider: one account with a
 * verified spend total and enough usage metrics that one of the dashboard's reads stops at the cap.
 * The seeds write about 10,000 and 18,000 rows in 1,000 row inserts, as trends-long-history.spec.ts
 * does.
 */

const DAY_MS = 86_400_000;
const BATCH = 1000;
const NOTICE = "Some older readings are not shown";
const EVIDENCE = process.env.PW_PR_EVIDENCE === "1";

type SnapshotInsert = Database["public"]["Tables"]["usage_snapshots"]["Insert"];

// Evidence (PW_PR_EVIDENCE=1) is captured in London time, as the app prints times.
ownerTest.use(EVIDENCE ? { timezoneId: "Europe/London", viewport: { width: 1280, height: 900 } } : {});

function isoDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

type Account = Readonly<{ connectionId: string; accountId: string }>;

/** One fake connection with one account, synced just now and never due during the run. */
async function seedAccount(workspace: TestWorkspace): Promise<Account> {
  const admin = adminClient();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "fake",
      status: "active",
      granted_at: new Date().toISOString(),
      display_name: "Fake billing account",
      poll_interval_seconds: 3_600,
      last_synced_at: new Date().toISOString(),
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
      external_id: "acct_snapshot_cap",
      display_name: "Production",
      kind: "account",
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  return { connectionId: connection.id, accountId: account.id };
}

/**
 * The account's readings of `date`: its month to date spend, 150 a day, then usage metrics up to
 * `metrics` in all. Read at 06:00, or now for today's, so the current values are fresh.
 */
function readings(workspace: TestWorkspace, { connectionId, accountId }: Account, date: string, metrics: number): SnapshotInsert[] {
  const at = date === isoDate(Date.now()) ? new Date().toISOString() : `${date}T06:00:00.000Z`;
  const day = Date.parse(`${date}T00:00:00.000Z`);
  const monthStart = Date.UTC(new Date(day).getUTCFullYear(), new Date(day).getUTCMonth(), 1);
  const base = {
    workspace_id: workspace.id,
    connection_id: connectionId,
    external_account_id: accountId,
    snapshot_date: date,
    retrieved_at: at,
    provenance_source: "provider_api",
  } as const;
  const rows: SnapshotInsert[] = [
    {
      ...base,
      metric_key: "fake.spend.month",
      kind: "verified_spend",
      label: "Spend this month",
      currency: "USD",
      amount_minor: 150 * ((day - monthStart) / DAY_MS + 1),
      period_start: new Date(monthStart).toISOString(),
      period_end: at,
    },
  ];
  for (let metric = 1; metric < metrics; metric += 1) {
    const suffix = String(metric).padStart(3, "0");
    rows.push({ ...base, metric_key: `fake.filler_${suffix}.count`, kind: "usage", label: `Filler ${suffix}`, unit: "requests", value: metric, point_at: at });
  }
  return rows;
}

async function insertSnapshots(rows: readonly SnapshotInsert[]): Promise<void> {
  const admin = adminClient();
  for (let from = 0; from < rows.length; from += BATCH) {
    const { error } = await admin.from("usage_snapshots").insert(rows.slice(from, from + BATCH));
    if (error) throw new Error(`Seeding snapshots failed (code ${error.code}).`);
  }
}

// 400 readings a day for today and the 45 days before it, the dashboard's window: the cards' read of
// 10,000 rows, newest first, holds the newest 25 days. It cannot tell whether its oldest day, 24
// days ago, was read whole, so the cards and the 30 day chart are whole from 23 days ago.
const DAILY_METRICS = 400;
const WINDOW_DAYS = 46;

async function seedDailyHistory(workspace: TestWorkspace): Promise<Readonly<{ completeFrom: string }>> {
  const account = await seedAccount(workspace);
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const rows: SnapshotInsert[] = [];
  for (let back = 0; back < WINDOW_DAYS; back += 1) rows.push(...readings(workspace, account, isoDate(today - back * DAY_MS), DAILY_METRICS));
  await insertSnapshots(rows);
  return { completeFrom: isoDate(today - 23 * DAY_MS) };
}

// 800 readings on the first day of each of the monthly trend's 13 months: 10,400 rows, one per metric
// and month, so the monthly read of 10,000 rows, newest first, reads half of the oldest month and the
// month after it is the first whole one. The dashboard's 45 days hold at most two of those days, and
// the headline reads only the spend rows, so both are whole.
const MONTHLY_METRICS = 800;
const TREND_MONTHS = 13;

async function seedMonthlyHistory(workspace: TestWorkspace): Promise<Readonly<{ completeFrom: string }>> {
  const account = await seedAccount(workspace);
  const now = new Date();
  const monthStart = (back: number) => isoDate(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  const rows: SnapshotInsert[] = [];
  for (let back = 0; back < TREND_MONTHS; back += 1) rows.push(...readings(workspace, account, monthStart(back), MONTHLY_METRICS));
  await insertSnapshots(rows);
  return { completeFrom: monthStart(TREND_MONTHS - 2) };
}

ownerTest.describe("dashboard snapshot read cap", () => {
  ownerTest("says once which parts a read stopped at the cap leaves incomplete, from which day, with nothing to tab through", async ({
    page,
  }) => {
    const workspace = await createTestWorkspace("Snapshot cap daily");
    try {
      const { completeFrom } = await seedDailyHistory(workspace);
      if (EVIDENCE) await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await waitForTrends(page);
      if (EVIDENCE) {
        // The top of the page, where the notice sits, and the daily spend chart its first days are missing from.
        await page.screenshot({ path: "pr-evidence/after/dashboard-cap-top.png", animations: "disabled", style: HIDE_DEV_INDICATOR });
        await page
          .getByRole("region", { name: "Trends" })
          .getByRole("figure", { name: "Spend this month (Example provider, USD)" })
          .screenshot({
            path: "pr-evidence/after/dashboard-cap-daily-trend.png",
            animations: "disabled",
            style: `header.sticky { visibility: hidden !important; } ${HIDE_DEV_INDICATOR}`,
          });
      }

      // One notice for the page, inside the region that announces it.
      const notice = page.getByRole("region", { name: NOTICE });
      await expect(notice).toHaveCount(1);
      await expect(notice).toContainText(
        "This workspace has more readings than the dashboard reads at once, so the oldest are left out.",
      );
      await expect(notice).toContainText(`The cards and the daily trend are complete from ${completeFrom} in UTC.`);
      await expect(notice).toContainText("Anything that depends on an older reading can be missing or incomplete.");
      // The headline reads only the spend rows, which fit, so it is not named.
      await expect(notice).not.toContainText("headline");
      await expect(page.getByRole("status").filter({ has: notice })).toHaveCount(1);

      // Keyboard only: the notice has nothing to operate, so Tab goes from the page header's last
      // link straight to the filter bar, and back.
      const yearLink = page.getByRole("link", { name: /^Your \d{4}/ });
      const filters = page.getByRole("region", { name: "Filters", exact: true }).locator("summary");
      await yearLink.focus();
      await page.keyboard.press("Tab");
      await expect(filters).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(yearLink).toBeFocused();

      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("adds the monthly trend once its own read streams in, and only in the monthly view", async ({ page }) => {
    const workspace = await createTestWorkspace("Snapshot cap monthly");
    try {
      const { completeFrom } = await seedMonthlyHistory(workspace);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await waitForTrends(page);
      // The daily view reads only the dashboard's 45 days, which fit.
      await expect(page.getByRole("region", { name: NOTICE })).toHaveCount(0);

      // Keyboard only: from the daily period link to the monthly one, then Enter.
      const trends = page.getByRole("region", { name: "Trends" });
      await trends.getByRole("link", { name: "Daily, last 30 days" }).focus();
      await page.keyboard.press("Tab");
      const monthly = trends.getByRole("link", { name: "Monthly, last 13 months" });
      await expect(monthly).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(monthly).toHaveAttribute("aria-current", "page");

      const notice = page.getByRole("region", { name: NOTICE });
      await expect(notice).toContainText(`The monthly trend is complete from ${completeFrom} in UTC.`);
      await expect(notice).not.toContainText("cards");
      // In the region that stayed mounted, so a screen reader hears the notice arrive.
      await expect(page.getByRole("status").filter({ has: notice })).toHaveCount(1);
      await waitForTrends(page);
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
