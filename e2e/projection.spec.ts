import AxeBuilder from "@axe-core/playwright";

import type { Database } from "../src/lib/supabase/database.types";

import { expect, ownerTest } from "./fixtures/auth";
import { waitForTrends } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";

// Every test seeds its own workspace with synthetic data from the fake provider only (#167).

const DAY_MS = 86_400_000;

type SnapshotInsert = Database["public"]["Tables"]["usage_snapshots"]["Insert"];

function utcDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

/** A fake provider connection, synced half a day ago, with one included account. */
async function seedConnection(workspace: TestWorkspace, name: string, externalId: string) {
  const admin = adminClient();
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "fake",
      status: "active",
      granted_at: new Date().toISOString(),
      display_name: name,
      poll_interval_seconds: 86_400,
      last_synced_at: new Date(todayStart - DAY_MS / 2).toISOString(),
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({ workspace_id: workspace.id, connection_id: connection.id, external_id: externalId, display_name: "Production", kind: "account" })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  return { connectionId: connection.id, accountId: account.id };
}

/**
 * A 30 day billing period that started five UTC days ago, with one reading at noon on each of the
 * last five days: spend rising $1.00 a day to $5.00, and requests rising 400 a day to 2,000 of a
 * 3,000 allowance that resets at the end of the period. Readings are all in the past, so the
 * expected figures do not depend on the time of day the test runs.
 */
async function seedProjection(workspace: TestWorkspace) {
  const admin = adminClient();
  const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const periodStart = todayStart - 5 * DAY_MS;
  const periodEnd = periodStart + 30 * DAY_MS;
  const period = { period_start: new Date(periodStart).toISOString(), period_end: new Date(periodEnd).toISOString() };
  const { connectionId, accountId } = await seedConnection(workspace, "Fake billing account", "acct_projection");

  const rows: SnapshotInsert[] = [];
  for (let day = 1; day <= 5; day += 1) {
    const dayStart = periodStart + (day - 1) * DAY_MS;
    const at = new Date(dayStart + DAY_MS / 2).toISOString();
    const base = {
      workspace_id: workspace.id,
      connection_id: connectionId,
      external_account_id: accountId,
      snapshot_date: utcDate(dayStart),
      retrieved_at: at,
      provenance_source: "provider_api",
      ...period,
    } as const;
    rows.push(
      { ...base, metric_key: "fake.spend.month", kind: "verified_spend", label: "Spend this month", amount_minor: day * 100, currency: "USD" },
      {
        ...base,
        metric_key: "fake.requests.month",
        kind: "usage",
        label: "Requests this month",
        value: day * 400,
        unit: "requests",
        resets_at: period.period_end,
      },
      {
        ...base,
        metric_key: "fake.requests.included",
        kind: "included_allowance",
        label: "Requests included in the plan",
        value: 3000,
        unit: "requests",
        resets_at: period.period_end,
      },
    );
  }
  const { error } = await admin.from("usage_snapshots").insert(rows);
  if (error) throw new Error(`Seeding snapshots failed (code ${error.code}).`);

  const { error: budgetError } = await admin
    .from("budgets")
    .insert({ workspace_id: workspace.id, name: "Production apps", scope: "workspace", amount_minor: 2000, currency: "USD" });
  if (budgetError) throw new Error(`Seeding a budget failed (code ${budgetError.code}).`);

  return {
    // $5.00 plus $1.00 a day from yesterday noon to the end of the period: 25.5 days.
    spend: "$30.50",
    lastDay: utcDate(periodEnd - 1),
    // 2,000 plus 400 a day reaches 3,000 two and a half days after yesterday noon.
    runsOut: utcDate(todayStart - DAY_MS / 2 + 2.5 * DAY_MS),
  };
}

ownerTest.describe("projection to the end of the period", () => {
  ownerTest("shows spend and quota projections as estimates, and a budget projected to cross", async ({ page }) => {
    const workspace = await createTestWorkspace("Projection");
    try {
      const expected = await seedProjection(workspace);
      await page.goto(`/w/${workspace.slug}/dashboard`);

      const totals = page.getByRole("region", { name: "Spending this billing period" }).getByRole("region", { name: "Spend in USD" });
      await expect(totals).toContainText(`On track for ${expected.spend} by ${expected.lastDay}`);
      await expect(totals.getByText("Estimate by StackDash", { exact: true })).toBeVisible();
      // How it was worked out sits behind the info button (#269): out of the way until asked for,
      // the button's description for a screen reader, and opened and closed from the keyboard.
      const totalsMethod = totals.getByRole("button", { name: "How this projection is worked out" });
      await expect(totalsMethod).toHaveAccessibleDescription(/the average daily increase over the last 5 days with data/);
      await expect(totals.getByText(/the average daily increase/)).toBeHidden();
      await totalsMethod.focus();
      await expect(totals.getByRole("tooltip")).toBeVisible();
      await expect(totals.getByRole("tooltip")).toContainText("the average daily increase over the last 5 days with data");
      await page.keyboard.press("Escape");
      await expect(totals.getByRole("tooltip")).toBeHidden();
      await page.keyboard.press("Enter");
      await expect(totals.getByRole("tooltip")).toBeVisible();
      await page.keyboard.press("Escape");
      // The projection sits beside the verified amount and is never added to it.
      await expect(totals).toContainText("$5.00");

      const card = page.getByRole("region", { name: "By provider" }).getByRole("article", { name: "Fake billing account" });
      await expect(card).toContainText(`On track for ${expected.spend} by ${expected.lastDay}`);
      const allowance = card.getByRole("article", { name: "Requests included in the plan" });
      await expect(allowance).toContainText(`Runs out around ${expected.runsOut}`);
      await expect(allowance.getByText("Estimate by StackDash", { exact: true })).toBeVisible();
      await expect(allowance.getByRole("button", { name: "How this projection is worked out" })).toHaveAccessibleDescription(/400 requests a day/);

      await waitForTrends(page);
      const dashboardScan = await new AxeBuilder({ page }).analyze();
      expect(dashboardScan.violations).toEqual([]);

      await page.goto(`/w/${workspace.slug}/alerts/settings`);
      const budget = page.getByRole("list", { name: "Budgets" }).getByRole("listitem").filter({ hasText: "Production apps" });
      await expect(budget.getByText("Projected to cross", { exact: true })).toBeVisible();
      await expect(budget).toContainText(`On track for ${expected.spend} by ${expected.lastDay}, at or above the $20.00 budget`);

      const alertsScan = await new AxeBuilder({ page }).analyze();
      expect(alertsScan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("says how many amounts hold a total back, and gives a daily quota no projection", async ({ page }) => {
    const workspace = await createTestWorkspace("Projection partial");
    try {
      const expected = await seedProjection(workspace);
      // A second connection with one day of spend, and a daily quota read on each of the last five
      // days that resets at the next UTC midnight: too short a period to project.
      const { connectionId, accountId } = await seedConnection(workspace, "Second fake account", "acct_second");
      const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
      const base = { workspace_id: workspace.id, connection_id: connectionId, external_account_id: accountId, provenance_source: "provider_api" } as const;
      const rows: SnapshotInsert[] = [
        {
          ...base,
          metric_key: "fake.spend.month",
          kind: "verified_spend",
          label: "Spend this month",
          snapshot_date: utcDate(todayStart - DAY_MS),
          retrieved_at: new Date(todayStart - DAY_MS / 2).toISOString(),
          amount_minor: 100,
          currency: "USD",
          period_start: new Date(todayStart - DAY_MS).toISOString(),
          period_end: new Date(todayStart + 29 * DAY_MS).toISOString(),
        },
      ];
      for (let day = 5; day >= 1; day -= 1) {
        const dayStart = todayStart - day * DAY_MS;
        const at = new Date(dayStart + DAY_MS / 2).toISOString();
        const point = { ...base, snapshot_date: utcDate(dayStart), retrieved_at: at, point_at: at, resets_at: new Date(dayStart + DAY_MS).toISOString(), unit: "emails" };
        rows.push(
          { ...point, metric_key: "fake.emails.daily.used", kind: "usage", label: "Emails sent today", value: 40 },
          { ...point, metric_key: "fake.emails.daily.limit", kind: "included_allowance", label: "Daily email quota", value: 100 },
        );
      }
      const { error } = await adminClient().from("usage_snapshots").insert(rows);
      if (error) throw new Error(`Seeding snapshots failed (code ${error.code}).`);

      await page.goto(`/w/${workspace.slug}/dashboard`);
      const totals = page.getByRole("region", { name: "Spending this billing period" }).getByRole("region", { name: "Spend in USD" });
      await expect(totals).toContainText("Projection unavailable");
      await expect(totals).toContainText(
        "StackDash cannot project 1 of the 2 amounts in this total (fewer than 3 days of data), so it does not project the total. Each provider card shows its own projection or the reason there is none.",
      );

      const providers = page.getByRole("region", { name: "By provider" });
      await expect(providers.getByRole("article", { name: "Fake billing account" })).toContainText(`On track for ${expected.spend} by ${expected.lastDay}`);
      const second = providers.getByRole("article", { name: "Second fake account" });
      await expect(second).toContainText("StackDash needs at least 3 days of data in the current period to project it.");
      const daily = second.getByRole("article", { name: "Daily email quota" });
      await expect(daily).toBeVisible();
      await expect(daily).not.toContainText("Projection");

      await waitForTrends(page);
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("names every reason when no amount of a total can be projected, and says nothing on a quota's first day", async ({ page }) => {
    const workspace = await createTestWorkspace("Projection reasons");
    try {
      const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
      const yesterday = { snapshot_date: utcDate(todayStart - DAY_MS), retrieved_at: new Date(todayStart - DAY_MS / 2).toISOString() };
      const spend = { metric_key: "fake.spend.month", kind: "verified_spend", label: "Spend this month", currency: "USD", provenance_source: "provider_api" } as const;
      // One connection billed in 2 day periods: too short to project.
      const short = await seedConnection(workspace, "Fake billing account", "acct_short");
      // Another with one day of spend in a 30 day period, and a daily quota read once, today, so the
      // reset before it is unknown and with it how long the quota's period lasts.
      const second = await seedConnection(workspace, "Second fake account", "acct_first_day");
      const quotaAt = Math.max(todayStart, Date.now() - 60_000);
      const quotaPoint = {
        workspace_id: workspace.id,
        connection_id: second.connectionId,
        external_account_id: second.accountId,
        provenance_source: "provider_api",
        snapshot_date: utcDate(quotaAt),
        retrieved_at: new Date(quotaAt).toISOString(),
        point_at: new Date(quotaAt).toISOString(),
        resets_at: new Date(todayStart + DAY_MS).toISOString(),
        unit: "emails",
      } as const;
      const rows: SnapshotInsert[] = [
        {
          ...spend,
          ...yesterday,
          workspace_id: workspace.id,
          connection_id: short.connectionId,
          external_account_id: short.accountId,
          amount_minor: 100,
          period_start: new Date(todayStart - DAY_MS).toISOString(),
          period_end: new Date(todayStart + DAY_MS).toISOString(),
        },
        {
          ...spend,
          ...yesterday,
          workspace_id: workspace.id,
          connection_id: second.connectionId,
          external_account_id: second.accountId,
          amount_minor: 200,
          period_start: new Date(todayStart - DAY_MS).toISOString(),
          period_end: new Date(todayStart + 29 * DAY_MS).toISOString(),
        },
        { ...quotaPoint, metric_key: "fake.emails.daily.used", kind: "usage", label: "Emails sent today", value: 40 },
        { ...quotaPoint, metric_key: "fake.emails.daily.limit", kind: "included_allowance", label: "Daily email quota", value: 100 },
      ];
      const { error } = await adminClient().from("usage_snapshots").insert(rows);
      if (error) throw new Error(`Seeding snapshots failed (code ${error.code}).`);

      await page.goto(`/w/${workspace.slug}/dashboard`);
      const totals = page.getByRole("region", { name: "Spending this billing period" }).getByRole("region", { name: "Spend in USD" });
      await expect(totals).toContainText("Projection unavailable");
      await expect(totals).toContainText(
        "StackDash cannot project any of the 2 amounts in this total (the period is shorter than 3 days, fewer than 3 days of data), so it does not project the total. Each provider card shows its own projection or the reason there is none.",
      );

      const providers = page.getByRole("region", { name: "By provider" });
      await expect(providers.getByRole("article", { name: "Fake billing account" })).toContainText(
        "The period is shorter than 3 days, so there is nothing to project.",
      );
      const secondCard = providers.getByRole("article", { name: "Second fake account" });
      await expect(secondCard).toContainText("StackDash needs at least 3 days of data in the current period to project it.");
      const daily = secondCard.getByRole("article", { name: "Daily email quota" });
      await expect(daily).toBeVisible();
      await expect(daily).not.toContainText("Projection");
      await expect(daily).not.toContainText("3 days");

      await waitForTrends(page);
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("says why there is no projection before 3 days of data", async ({ page }) => {
    const workspace = await createTestWorkspace("Projection early");
    try {
      const todayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
      const { connectionId, accountId } = await seedConnection(workspace, "Fake billing account", "acct_early");
      const at = new Date(todayStart - DAY_MS / 2).toISOString();
      const { error } = await adminClient().from("usage_snapshots").insert({
        workspace_id: workspace.id,
        connection_id: connectionId,
        external_account_id: accountId,
        metric_key: "fake.spend.month",
        kind: "verified_spend",
        label: "Spend this month",
        snapshot_date: utcDate(todayStart - DAY_MS),
        amount_minor: 100,
        currency: "USD",
        period_start: new Date(todayStart - DAY_MS).toISOString(),
        period_end: new Date(todayStart + 29 * DAY_MS).toISOString(),
        retrieved_at: at,
        provenance_source: "provider_api",
      });
      if (error) throw new Error(`Seeding snapshots failed (code ${error.code}).`);

      await page.goto(`/w/${workspace.slug}/dashboard`);
      const totals = page.getByRole("region", { name: "Spending this billing period" }).getByRole("region", { name: "Spend in USD" });
      await expect(totals).toContainText("Projection unavailable");
      await expect(totals).toContainText("StackDash needs at least 3 days of data in the current period to project it.");
      await expect(totals.getByText("Estimate by StackDash", { exact: true })).toHaveCount(0);
      // The reason there is no projection is the whole note, so it stays in view, not in a tooltip.
      await expect(totals.getByText("StackDash needs at least 3 days of data in the current period to project it.")).toBeVisible();
      await expect(totals.getByRole("button", { name: "How this projection is worked out" })).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
