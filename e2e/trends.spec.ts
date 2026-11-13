import AxeBuilder from "@axe-core/playwright";

import type { Database } from "../src/lib/supabase/database.types";

import { expect, ownerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";

// Every test seeds its own workspace with synthetic data from the fake provider only.

const DAY_MS = 86_400_000;

type SnapshotInsert = Database["public"]["Tables"]["usage_snapshots"]["Insert"];

function utcDate(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

type SeededTrends = { today: string; yesterday: string; twoDaysAgo: string; connectionId: string; accountId: string };

/**
 * One fake account with verified spend today and two days ago, but nothing yesterday (a gap), and
 * an estimate reported both today and yesterday.
 */
async function seedTrends(workspace: TestWorkspace): Promise<SeededTrends> {
  const admin = adminClient();
  const now = Date.now();
  const today = utcDate(now);
  const yesterday = utcDate(now - DAY_MS);
  const twoDaysAgo = utcDate(now - 2 * DAY_MS);

  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "fake",
      status: "active",
      display_name: "Fake billing account",
      poll_interval_seconds: 3_600,
      last_synced_at: new Date(now).toISOString(),
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_id: "acct_trends",
      display_name: "Production",
      kind: "account",
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);

  const row = (date: string, overrides: Partial<SnapshotInsert>): SnapshotInsert => {
    const at = `${date}T06:00:00.000Z`;
    return {
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_account_id: account.id,
      metric_key: "fake.spend.month",
      kind: "verified_spend",
      label: "Spend this month",
      snapshot_date: date,
      currency: "USD",
      point_at: at,
      retrieved_at: at,
      provenance_source: "provider_api",
      ...overrides,
    };
  };
  const estimate = {
    metric_key: "fake.cost.estimate",
    kind: "estimated_spend",
    label: "Estimated spend for the month",
    provenance_source: "derived",
    pricing_source: "Fake price list 2026",
  } as const;
  const { error } = await admin.from("usage_snapshots").insert([
    row(twoDaysAgo, { amount_minor: 100 }),
    row(today, { amount_minor: 300 }),
    row(yesterday, { ...estimate, amount_minor: 450 }),
    row(today, { ...estimate, amount_minor: 500 }),
  ]);
  if (error) throw new Error(`Seeding snapshots failed (code ${error.code}).`);
  return { today, yesterday, twoDaysAgo, connectionId: connection.id, accountId: account.id };
}

type EventInsert = Database["public"]["Tables"]["activity_events"]["Insert"];

/**
 * A burst of 14 deployments two days ago, one signup today, and one triggered alert today (DevMacro's
 * own event, with no provider), all at midday UTC so the UTC and London days agree.
 */
async function seedEvents(workspace: TestWorkspace, seeded: SeededTrends): Promise<void> {
  const event = (date: string, key: string, overrides: Partial<EventInsert>): EventInsert => ({
    workspace_id: workspace.id,
    connection_id: seeded.connectionId,
    external_account_id: seeded.accountId,
    provider: "fake",
    type_id: "fake.deploy.succeeded",
    severity: "success",
    title: "Deployment succeeded",
    occurred_at: `${date}T12:00:00.000Z`,
    dedupe_key: `markers-${key}`,
    ...overrides,
  });
  const { error } = await adminClient()
    .from("activity_events")
    .insert([
      ...Array.from({ length: 14 }, (_, index) => event(seeded.twoDaysAgo, `deploy-${index}`, {})),
      event(seeded.today, "signup", { type_id: "fake.signup", severity: "info", title: "New signup" }),
      event(seeded.today, "alert", {
        connection_id: null,
        external_account_id: null,
        provider: null,
        type_id: "devmacro.alert_triggered",
        severity: "warning",
        title: "Spend passed 80 percent of the budget",
      }),
    ]);
  if (error) throw new Error(`Seeding events failed (code ${error.code}).`);
}

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
      display_name: "Fake billing account",
      poll_interval_seconds: 3_600,
      last_synced_at: now.toISOString(),
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
    const date = utcDate(day);
    const at = `${date}T06:00:00.000Z`;
    const month = new Date(day);
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

// Further back than the start of the previous month can ever be (61 days on the 31st), and past
// the dashboard's 45 day window, so the account has stopped reporting.
const STOPPED_DAYS_AGO = 75;

/**
 * Two accounts of one fake connection: "Production" reports $2.00 on the last day of the previous
 * UTC month and $3.00 today; "Staging" reported $0.50 once, 75 days ago, and stopped (#308).
 */
async function seedStoppedAccount(workspace: TestWorkspace): Promise<{ today: string }> {
  const admin = adminClient();
  const now = new Date();
  const today = utcDate(now.getTime());
  const previousMonthEnd = utcDate(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  const stopped = utcDate(now.getTime() - STOPPED_DAYS_AGO * DAY_MS);

  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "fake",
      status: "active",
      display_name: "Fake billing account",
      poll_interval_seconds: 3_600,
      last_synced_at: now.toISOString(),
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: accounts, error: accountError } = await admin
    .from("external_accounts")
    .insert(
      ["Production", "Staging"].map((name) => ({
        workspace_id: workspace.id,
        connection_id: connection.id,
        external_id: `acct_${name.toLowerCase()}`,
        display_name: name,
        kind: "account",
      })),
    )
    .select("id, display_name");
  if (accountError) throw new Error(`Seeding accounts failed (code ${accountError.code}).`);
  const idOf = (name: string): string => {
    const id = accounts.find((account) => account.display_name === name)?.id;
    if (id === undefined) throw new Error(`Seeded account ${name} is missing.`);
    return id;
  };

  const row = (account: string, date: string, amountMinor: number): SnapshotInsert => {
    const at = `${date}T06:00:00.000Z`;
    return {
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_account_id: idOf(account),
      metric_key: "fake.spend.month",
      kind: "verified_spend",
      label: "Spend this month",
      snapshot_date: date,
      currency: "USD",
      amount_minor: amountMinor,
      point_at: at,
      retrieved_at: at,
      provenance_source: "provider_api",
    };
  };
  const { error } = await admin
    .from("usage_snapshots")
    .insert([row("Production", previousMonthEnd, 200), row("Production", today, 300), row("Staging", stopped, 50)]);
  if (error) throw new Error(`Seeding snapshots failed (code ${error.code}).`);
  return { today };
}

ownerTest.describe("dashboard trends", () => {
  ownerTest("charts each metric with a table, shows a gap as unavailable, and marks estimates", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard trends");
    try {
      const { today, yesterday } = await seedTrends(workspace);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const trends = page.getByRole("region", { name: "Trends" });
      await expect(trends.getByRole("link", { name: "Daily, last 30 days" })).toHaveAttribute("aria-current", "page");
      // One legend for the section, naming only what the charts on the page draw (#263).
      const legend = trends.getByRole("list", { name: "Legend for every chart" });
      await expect(legend).toContainText("Break in the line, mark on the baseline: unavailable");
      await expect(legend).not.toContainText("Dashed line, hollow points: estimated");

      const spend = trends.getByRole("figure", { name: "Spend this month (Example provider, USD)" });
      await expect(spend).toContainText("No comparison: the previous day is unavailable");
      await expect(spend.getByRole("img")).toHaveAttribute("aria-label", /28 days unavailable\./);
      await expect(spend).not.toContainText("Break in the line");

      await spend.getByText("Show the values as a table").click();
      const spendTable = spend.getByRole("table", { name: /daily values for the last 30 days/ });
      await expect(spendTable).toBeVisible();
      const gapRow = spendTable.getByRole("row", { name: new RegExp(`^${yesterday}`) });
      await expect(gapRow.getByRole("cell", { name: "Unavailable", exact: true })).toBeVisible();
      await expect(gapRow).not.toContainText("$0.00");
      const todayRow = spendTable.getByRole("row", { name: new RegExp(`^${today}`) });
      await expect(todayRow).toContainText("$3.00");
      await expect(todayRow.getByRole("cell", { name: "Verified", exact: true })).toBeVisible();

      // The month's estimate is the provider's declared projection, so it waits behind the
      // provider's disclosure until opened.
      const estimated = trends.getByRole("figure", { name: "Estimated spend for the month (Example provider, USD)" });
      await expect(estimated).toHaveCount(0);
      await trends.getByRole("link", { name: "Show 1 more Example provider series" }).click();
      await expect(page).toHaveURL(/[?&]expand=fake(&|$)/);
      await expect(estimated).toContainText("Up 11 percent from the previous day");
      await expect(legend).toContainText("Dashed line, hollow points: estimated");
      await expect(estimated.getByRole("img")).toHaveAttribute("aria-label", /Includes estimated values\./);
      await estimated.getByText("Show the values as a table").click();
      const estimatedRow = estimated.getByRole("table").getByRole("row", { name: new RegExp(`^${today}`) });
      await expect(estimatedRow.getByRole("cell", { name: "Estimated", exact: true })).toBeVisible();

      await expectNoAxeViolations(page);

      // The period links keep the open disclosure.
      await trends.getByRole("link", { name: "Monthly, last 13 months" }).click();
      await expect(page).toHaveURL(/[?&]trend=monthly(&|$)/);
      await expect(page).toHaveURL(/[?&]expand=fake(&|$)/);
      const monthly = page.getByRole("region", { name: "Trends" });
      await expect(monthly.getByRole("link", { name: "Monthly, last 13 months" })).toHaveAttribute("aria-current", "page");
      await expect(
        monthly.getByRole("figure", { name: "Spend this month (Example provider, USD)" }).getByRole("img"),
      ).toHaveAttribute("aria-label", /last 13 months/);
      await expect(monthly.getByRole("figure", { name: "Estimated spend for the month (Example provider, USD)" })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("marks events under the charts, by keyboard in date order, with a table column and a URL toggle", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard trend markers");
    try {
      const seeded = await seedTrends(workspace);
      await seedEvents(workspace, seeded);
      const { today, twoDaysAgo } = seeded;
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const trends = page.getByRole("region", { name: "Trends" });
      const toggles = trends.getByRole("navigation", { name: "Event markers" });
      await expect(toggles.getByRole("link", { name: "Hide deployments" })).toBeVisible();

      // The month's estimate is a declared projection, so the spend chart is the only one on load.
      const spend = trends.getByRole("figure", { name: "Spend this month (Example provider, USD)" });
      const burst = spend.getByRole("link", { name: `14 deployments on ${twoDaysAgo}` });
      await expect(burst).toHaveAttribute(
        "href",
        `/w/${workspace.slug}/timeline?type=fake.deploy.succeeded&from=${twoDaysAgo}&to=${twoDaysAgo}&provider=fake`,
      );
      await expect(spend.getByRole("link", { name: `1 triggered alert on ${today}` })).toHaveAttribute(
        "href",
        `/w/${workspace.slug}/timeline?type=devmacro.alert_triggered&from=${today}&to=${today}`,
      );
      const legend = trends.getByRole("list", { name: "Legend for every chart" });
      await expect(legend).toContainText("Marker: deployments");
      await expect(legend).toContainText("Marker: triggered alerts");
      await expect(spend).not.toContainText("Marker: deployments");
      const box = await burst.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(24);
      expect(box?.height).toBeGreaterThanOrEqual(24);

      // Keyboard only: from the last toggle, Tab reaches the first chart's skip link, shown on focus,
      // and then that chart's markers oldest day first.
      const firstChart = trends.getByRole("figure").first();
      await toggles.getByRole("link", { name: "Hide triggered alerts" }).focus();
      await page.keyboard.press("Tab");
      const skip = firstChart.getByRole("link", { name: "Skip the event markers" });
      await expect(skip).toBeFocused();
      const skipBox = await skip.boundingBox();
      expect(skipBox?.width).toBeGreaterThanOrEqual(24);
      expect(skipBox?.height).toBeGreaterThanOrEqual(24);
      const reached: string[] = [];
      for (let step = 0; step < 3; step += 1) {
        await page.keyboard.press("Tab");
        reached.push(await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? ""));
      }
      expect(reached).toEqual([`14 deployments on ${twoDaysAgo}`, `1 signup on ${today}`, `1 triggered alert on ${today}`]);
      const outline = await page.evaluate(() =>
        document.activeElement === null ? "none" : getComputedStyle(document.activeElement).outlineStyle,
      );
      expect(outline).not.toBe("none");

      // The skip link jumps past every marker onto the chart's table disclosure, which is not
      // outlined, as #main is not: a skip target is not a control. The next stop is its control.
      await skip.focus();
      await page.keyboard.press("Enter");
      const skipTarget = firstChart.locator("details[data-skip-focused]");
      await expect(skipTarget).toBeFocused();
      expect(await skipTarget.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
      await page.keyboard.press("Tab");
      await expect(skipTarget).toHaveCount(0);
      await expect(firstChart.getByText("Show the values as a table")).toBeFocused();

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      await spend.getByText("Show the values as a table").click();
      const table = spend.getByRole("table");
      await expect(table.getByRole("columnheader", { name: "Events" })).toBeVisible();
      const burstRow = table.getByRole("row", { name: new RegExp(`^${twoDaysAgo}`) });
      await expect(burstRow.getByRole("link", { name: "14 deployments" })).toBeVisible();
      await expect(table.getByRole("row", { name: new RegExp(`^${seeded.yesterday}`) })).toContainText("No events");

      // Hiding a category is URL state: the marker and its table entry go, the toggle flips. The
      // page stays where the toggles are rather than jumping to the top (#312). Reduced motion turns
      // off the page's smooth scrolling, so any scroll the navigation makes has finished by the time
      // the flipped toggle shows. The toggles are the check, not the exact offset: the open values
      // table below them closes on navigation, so the page gets shorter.
      await page.emulateMedia({ reducedMotion: "reduce" });
      await toggles.evaluate((element) => element.scrollIntoView({ block: "center" }));
      expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
      await toggles.getByRole("link", { name: "Hide deployments" }).click();
      await expect(page).toHaveURL(/[?&]hide_marker=deployments(&|$)/);
      await expect(toggles.getByRole("link", { name: "Show deployments" })).toBeInViewport();
      await expect(spend.getByRole("link", { name: `14 deployments on ${twoDaysAgo}` })).toHaveCount(0);
      await expect(spend.getByRole("link", { name: `1 signup on ${today}` })).toBeVisible();
      await expect(trends.getByRole("link", { name: "Monthly, last 13 months" })).toHaveAttribute(
        "href",
        /hide_marker=deployments/,
      );

      // The same link reproduces the view, and a marker opens the timeline filtered to its events.
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await trends
        .getByRole("figure", { name: "Spend this month (Example provider, USD)" })
        .getByRole("link", { name: `14 deployments on ${twoDaysAgo}` })
        .click();
      await expect(page).toHaveURL(new RegExp(`/timeline\\?type=fake\\.deploy\\.succeeded&from=${twoDaysAgo}&to=${twoDaysAgo}&provider=fake$`));
      await expect(page.getByText("Showing 14 of 14 events for provider Example provider", { exact: true })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

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

  ownerTest("leaves an account that stopped reporting out of later days and months alike (#308)", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard trend stopped account");
    try {
      const { today } = await seedStoppedAccount(workspace);
      const name = "Spend this month (Example provider, USD)";

      await page.goto(`/w/${workspace.slug}/dashboard`);
      const daily = page.getByRole("region", { name: "Trends" }).getByRole("figure", { name });
      await daily.getByText("Show the values as a table").click();
      await expect(daily.getByRole("table").getByRole("row", { name: new RegExp(`^${today}`) })).toContainText("$3.00");

      await page.goto(`/w/${workspace.slug}/dashboard?trend=monthly`);
      const monthly = page.getByRole("region", { name: "Trends" }).getByRole("figure", { name });
      // Staging is not expected after its last month, so this month and last month have values.
      await expect(monthly).toContainText("Up 50 percent from last month");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
