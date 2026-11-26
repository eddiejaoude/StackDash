import AxeBuilder from "@axe-core/playwright";

import type { Database } from "../src/lib/supabase/database.types";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations, waitForTrends } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, notDueForAMonth, type TestWorkspace } from "./fixtures/db";
import { checkEvery, expectClosedFilterBarOneRow, expectFormBelowWrappedStatus, openFilters } from "./fixtures/filters";
import { dayLabel, londonDate } from "./fixtures/share";
import { EVIDENCE, HIDE_DEV_INDICATOR } from "./fixtures/webhook-panel";

// Every test seeds its own workspace with synthetic data: from the fake provider by default, and
// GitHub rows where a GitHub shape is the subject.

const HOUR_MS = 3_600_000;

type SnapshotInsert = Database["public"]["Tables"]["usage_snapshots"]["Insert"];

/**
 * One fake connection polled hourly, two accounts (Production in project Checkout, Staging
 * unassigned), USD and EUR verified spend, a USD estimate of spend so far, the provider's
 * declared projection for the month (never spend, #223), an included allowance with its usage
 * and no remaining figure, and a EUR value read five hours ago, which is past two poll intervals.
 */
async function seedDashboard(workspace: TestWorkspace): Promise<void> {
  const admin = adminClient();
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
  const fresh = new Date(now.getTime() - HOUR_MS / 6).toISOString();
  const stale = new Date(now.getTime() - 5 * HOUR_MS).toISOString();
  const today = now.toISOString().slice(0, 10);

  const { data: project, error: projectError } = await admin
    .from("projects")
    .insert({ workspace_id: workspace.id, name: "Checkout" })
    .select("id")
    .single();
  if (projectError) throw new Error(`Seeding a project failed (code ${projectError.code}).`);
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "fake",
      status: "active",
      granted_at: new Date().toISOString(),
      display_name: "Fake billing account",
      poll_interval_seconds: 3_600,
      last_synced_at: fresh,
      next_sync_at: notDueForAMonth(),
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: accounts, error: accountsError } = await admin
    .from("external_accounts")
    .insert([
      {
        workspace_id: workspace.id,
        connection_id: connection.id,
        external_id: "acct_production",
        display_name: "Production",
        kind: "account",
        project_id: project.id,
      },
      {
        workspace_id: workspace.id,
        connection_id: connection.id,
        external_id: "acct_staging",
        display_name: "Staging",
        kind: "account",
      },
    ])
    .select("id, external_id");
  if (accountsError) throw new Error(`Seeding accounts failed (code ${accountsError.code}).`);
  const production = accounts.find((account) => account.external_id === "acct_production");
  const staging = accounts.find((account) => account.external_id === "acct_staging");
  if (production === undefined || staging === undefined) throw new Error("Seeded accounts were not returned.");

  const common = {
    workspace_id: workspace.id,
    connection_id: connection.id,
    snapshot_date: today,
    period_start: monthStart,
    period_end: nextMonthStart,
  };
  const snapshots: SnapshotInsert[] = [
    {
      ...common,
      external_account_id: production.id,
      metric_key: "fake.spend.month",
      kind: "verified_spend",
      label: "Spend this month",
      amount_minor: 12_345,
      currency: "USD",
      retrieved_at: fresh,
      provenance_source: "provider_api",
    },
    {
      ...common,
      external_account_id: production.id,
      metric_key: "fake.spend.estimated",
      kind: "estimated_spend",
      label: "Estimated spend so far",
      amount_minor: 20_000,
      currency: "USD",
      retrieved_at: fresh,
      provenance_source: "derived",
      pricing_source: "Fake price list 2026",
    },
    {
      ...common,
      external_account_id: production.id,
      metric_key: "fake.cost.estimate",
      kind: "estimated_spend",
      label: "Estimated spend for the month",
      amount_minor: 30_000,
      currency: "USD",
      retrieved_at: fresh,
      provenance_source: "derived",
      pricing_source: "Fake price list 2026",
    },
    {
      ...common,
      external_account_id: staging.id,
      metric_key: "fake.spend.eur",
      kind: "verified_spend",
      label: "Spend this month in euros",
      amount_minor: 6_789,
      currency: "EUR",
      retrieved_at: stale,
      provenance_source: "provider_api",
    },
    {
      ...common,
      external_account_id: production.id,
      metric_key: "fake.requests.included",
      kind: "included_allowance",
      label: "Requests included in the plan",
      value: 1_000,
      unit: "requests",
      resets_at: nextMonthStart,
      retrieved_at: fresh,
      provenance_source: "provider_api",
    },
    {
      ...common,
      external_account_id: production.id,
      metric_key: "fake.requests.month",
      kind: "usage",
      label: "Requests this month",
      value: 250,
      unit: "requests",
      resets_at: nextMonthStart,
      retrieved_at: fresh,
      provenance_source: "provider_api",
    },
  ];
  const { error } = await admin.from("usage_snapshots").insert(snapshots);
  if (error) throw new Error(`Seeding snapshots failed (code ${error.code}).`);
}

ownerTest.describe("dashboard as the owner", () => {
  ownerTest("shows each currency apart, labels verified, estimated, and stale values, and groups by project", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard");
    try {
      await seedDashboard(workspace);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");

      const totals = page.getByRole("region", { name: "Spending this billing period" });
      await expect(totals.getByRole("region")).toHaveCount(2);
      // Nothing was unusual (one day of rows is no history), so there is no summary at all (#270).
      await expect(page.getByRole("region", { name: "What changed" })).toHaveCount(0);

      const usd = totals.getByRole("region", { name: "Spend in USD" });
      await expect(usd).toContainText("$123.45");
      await expect(usd).toContainText("$200.00");
      // The month's projection is what the month is expected to cost, not spend so far (#223).
      await expect(usd).not.toContainText("$300.00");
      await expect(usd).not.toContainText("$500.00");
      await expect(usd).not.toContainText("€");
      await expect(usd.getByText("Verified", { exact: true })).toBeVisible();
      await expect(usd.getByText("Estimated", { exact: true })).toBeVisible();
      await expect(usd).toContainText("Updated");
      // The totals print amounts only; the price list behind an estimate is named on the provider card.
      const byProvider = page.getByRole("region", { name: "By provider" });
      await expect(byProvider).toContainText("Pricing source: Fake price list 2026");
      await expect(byProvider).not.toContainText("$300.00");

      const eur = totals.getByRole("region", { name: "Spend in EUR" });
      await expect(eur).toContainText("€67.89");
      await expect(eur).not.toContainText("$");
      await expect(eur.getByText(/^Stale: last updated 5 hours ago$/)).toBeVisible();

      const allowance = page.getByRole("article", { name: "Requests included in the plan" });
      await expect(allowance).toContainText("1,000 requests");
      await expect(allowance).toContainText("250 requests");
      await expect(allowance).toContainText("25%");
      // No remaining figure was reported, so it reads as unavailable rather than 0.
      await expect(allowance.getByText("Unavailable", { exact: true })).toHaveCount(1);

      const byProject = page.getByRole("region", { name: "By project" });
      const checkout = byProject.getByRole("region", { name: "Checkout" });
      await expect(checkout).toContainText("$123.45");
      await expect(checkout).not.toContainText("€67.89");
      await expect(byProject.getByRole("region", { name: "Unassigned" })).toContainText("€67.89");

      await waitForTrends(page);
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("puts By project before Trends and opens a provider's other series by keyboard", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard trend defaults");
    try {
      await seedDashboard(workspace);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const byProject = page.getByRole("region", { name: "By project" });
      const trends = page.getByRole("region", { name: "Trends" });
      const projectBox = await byProject.boundingBox();
      const trendsBox = await trends.boundingBox();
      expect(projectBox?.y ?? Infinity).toBeLessThan(trendsBox?.y ?? 0);

      // On load, the default set only (#263): spend so far in each currency, and not the month's
      // declared projection, the allowance, or the usage.
      const provider = trends.getByRole("region", { name: "Example provider" });
      await expect(provider.getByRole("figure")).toHaveCount(3);
      await expect(provider.getByRole("figure", { name: "Spend this month (Example provider, USD)" })).toBeVisible();
      await expect(provider.getByRole("figure", { name: "Spend this month in euros (Example provider, EUR)" })).toBeVisible();
      await expect(provider.getByRole("figure", { name: "Estimated spend so far (Example provider, USD)" })).toBeVisible();
      await expect(trends.getByRole("list", { name: "Legend for every chart" })).toHaveCount(1);

      // Keyboard only: from the last chart's table control, Tab reaches the disclosure, and Enter
      // opens it, rendering the other series with their own table alternative.
      const show = provider.getByRole("link", { name: "Show 3 more Example provider series" });
      await expect(show).toHaveAttribute("aria-expanded", "false");
      await provider.getByRole("figure").last().getByText("Show the values as a table").focus();
      await page.keyboard.press("Tab");
      await expect(show).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/[?&]expand=fake(&|$)/);
      const hide = provider.getByRole("link", { name: "Hide 3 more Example provider series" });
      await expect(hide).toHaveAttribute("aria-expanded", "true");
      await expect(provider.getByRole("figure")).toHaveCount(6);
      const usage = provider.getByRole("figure", { name: "Requests this month (Example provider, requests)" });
      await expect(usage).toBeVisible();
      await expect(provider.getByRole("figure", { name: "Estimated spend for the month (Example provider, USD)" })).toBeVisible();
      await expect(page.locator(`[id="${await hide.getAttribute("aria-controls")}"]`).getByRole("figure")).toHaveCount(3);
      await usage.getByText("Show the values as a table").focus();
      await page.keyboard.press("Enter");
      await expect(usage.getByRole("table")).toBeVisible();
      await expectNoAxeViolations(page);

      await hide.focus();
      await page.keyboard.press("Enter");
      await expect(page).not.toHaveURL(/expand=/);
      await expect(provider.getByRole("figure")).toHaveCount(3);
      await expect(show).toBeFocused();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("offers to connect a first provider when nothing is connected", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard empty");
    try {
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await expect(page.getByRole("heading", { name: "Connect your first provider" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Connect a provider" })).toHaveAttribute(
        "href",
        `/w/${workspace.slug}/connections`,
      );

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("shows not found for a workspace the user cannot open", async ({ page }) => {
    await page.goto("/w/zzzzzzzzzzzzzzzz/dashboard");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("We could not find that workspace");
    await expect(page.getByRole("region", { name: "Spending this billing period" })).toHaveCount(0);
  });
});

viewerTest.describe("dashboard as a viewer", () => {
  viewerTest("reads the same totals", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard viewer");
    try {
      await seedDashboard(workspace);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const totals = page.getByRole("region", { name: "Spending this billing period" });
      await expect(totals.getByRole("region", { name: "Spend in USD" })).toContainText("$123.45");
      await expect(totals.getByRole("region", { name: "Spend in EUR" })).toContainText("€67.89");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  viewerTest("sees why they cannot connect a provider in an empty workspace", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard viewer empty");
    try {
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await expect(page.getByRole("heading", { name: "Connect your first provider" })).toBeVisible();
      await expect(page.getByText("Only owners and admins can connect providers.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Connect a provider" })).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

/** A second provider beside the fake one: a GitHub organization, unassigned, spending USD 50.00. */
async function seedSecondProvider(workspace: TestWorkspace): Promise<void> {
  const admin = adminClient();
  const now = new Date();
  const fresh = new Date(now.getTime() - HOUR_MS / 6).toISOString();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "github",
      status: "active",
      granted_at: new Date().toISOString(),
      display_name: "GitHub e2e organization",
      poll_interval_seconds: 3_600,
      last_synced_at: fresh,
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
      external_id: "org_e2e",
      display_name: "Acme organization",
      kind: "organization",
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  const { error } = await admin.from("usage_snapshots").insert({
    workspace_id: workspace.id,
    connection_id: connection.id,
    external_account_id: account.id,
    metric_key: "github.spend.month",
    kind: "verified_spend",
    label: "GitHub spend this month",
    snapshot_date: now.toISOString().slice(0, 10),
    amount_minor: 5_000,
    currency: "USD",
    period_start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    period_end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    retrieved_at: fresh,
    provenance_source: "provider_api",
  });
  if (error) throw new Error(`Seeding a snapshot failed (code ${error.code}).`);
}

ownerTest.describe("dashboard filters", () => {
  ownerTest("narrows by provider and project, keeps the filter in the URL, and announces the result", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard filters");
    try {
      await seedDashboard(workspace);
      await seedSecondProvider(workspace);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const status = page.getByRole("status").filter({ hasText: /^Showing/ });
      await expect(status).toHaveText("Showing 2 connections");
      const usd = page.getByRole("region", { name: "Spending this billing period" }).getByRole("region", { name: "Spend in USD" });
      await expect(usd).toContainText("$173.45");

      const filters = page.getByRole("region", { name: "Filters", exact: true });
      // The result sentence sits in the closed bar, so it is read before the form is opened.
      await expect(filters.getByRole("status")).toHaveText("Showing 2 connections");
      // The bar starts closed, so the data leads the page.
      await expect(filters.getByRole("button", { name: "Apply filters" })).toBeHidden();
      await openFilters(page);
      await filters.getByRole("group", { name: "Provider" }).getByRole("checkbox", { name: "Example provider" }).check();
      await filters.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/[?&]provider=fake(&|$)/);
      await expect(status).toHaveText("Showing 1 connection for provider Example provider");
      await expect(usd).toContainText("$123.45");
      await expect(usd).not.toContainText("$173.45");
      await expect(page.getByRole("region", { name: "By provider" })).not.toContainText("GitHub e2e organization");

      // Keyboard only: tick the project and submit with Enter.
      await openFilters(page);
      const checkout = filters.getByRole("group", { name: "Project" }).getByRole("checkbox", { name: "Checkout" });
      await checkout.focus();
      await page.keyboard.press("Space");
      await expect(checkout).toBeChecked();
      await filters.getByRole("button", { name: "Apply filters" }).focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/[?&]project=[0-9a-f-]{36}(&|$)/);
      await expect(status).toHaveText("Showing 1 connection for provider Example provider, project Checkout");
      const byProject = page.getByRole("region", { name: "By project" });
      await expect(byProject.getByRole("region", { name: "Checkout" })).toBeVisible();
      await expect(byProject.getByRole("region", { name: "Unassigned" })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Spending this billing period" }).getByRole("region", { name: "Spend in EUR" })).toHaveCount(0);

      // The filtered view is bookmarkable: reloading the URL shows the same result.
      await page.reload();
      await expect(status).toHaveText("Showing 1 connection for provider Example provider, project Checkout");
      await openFilters(page);
      await expect(checkout).toBeChecked();

      await waitForTrends(page);
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      await filters.getByRole("link", { name: "Clear filters" }).click();
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/dashboard$`));
      await expect(status).toHaveText("Showing 2 connections");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("opens the form below a status that wraps, on a wide screen and on a phone", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard filters wrap");
    try {
      await seedDashboard(workspace);
      await seedSecondProvider(workspace);
      const filters = page.getByRole("region", { name: "Filters", exact: true });
      const status = filters.getByRole("status");

      // 1280 wide: every provider, project, and account ticked gives a status that wraps.
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await openFilters(page);
      for (const group of ["Provider", "Project", "Account"]) await checkEvery(page, group);
      await filters.getByRole("button", { name: "Apply filters" }).click();
      await expect(status).toContainText("accounts ");
      await expectClosedFilterBarOneRow(page);
      await openFilters(page);
      await expectFormBelowWrappedStatus(page);

      // A phone: one filter is enough.
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(`/w/${workspace.slug}/dashboard?provider=fake`);
      await expect(status).toHaveText("Showing 1 connection for provider Example provider");
      await expectClosedFilterBarOneRow(page);
      await openFilters(page, "keyboard");
      await expectFormBelowWrappedStatus(page);

      await waitForTrends(page);
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

/**
 * One GitHub organization reporting Actions spend the way the adapter does (#137): USD 51.75
 * month to date for the product, the same 51.75 for its one SKU, and USD 12.52 for today.
 */
async function seedGitHubSpendLevels(workspace: TestWorkspace): Promise<void> {
  const admin = adminClient();
  const now = new Date();
  const fresh = new Date(now.getTime() - HOUR_MS / 6).toISOString();
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "github",
      status: "active",
      granted_at: new Date().toISOString(),
      display_name: "GitHub billing organization",
      poll_interval_seconds: 3_600,
      last_synced_at: fresh,
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
      external_id: "org_billing_e2e",
      display_name: "Billing organization",
      kind: "organization",
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  const common = {
    workspace_id: workspace.id,
    connection_id: connection.id,
    external_account_id: account.id,
    kind: "verified_spend",
    snapshot_date: now.toISOString().slice(0, 10),
    currency: "USD",
    period_start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(),
    period_end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    retrieved_at: fresh,
    provenance_source: "provider_api",
  } as const;
  const snapshots: SnapshotInsert[] = [
    { ...common, metric_key: "github.spend.actions", label: "GitHub Actions spend", amount_minor: 5_175 },
    { ...common, metric_key: "github.spend.actions.actions_linux", label: "GitHub Actions spend (Actions Linux)", amount_minor: 5_175 },
    {
      ...common,
      metric_key: "github.daily_spend.actions",
      label: "GitHub Actions daily spend",
      amount_minor: 1_252,
      period_start: new Date(todayStart).toISOString(),
      period_end: new Date(todayStart + 24 * HOUR_MS).toISOString(),
    },
  ];
  const { error } = await admin.from("usage_snapshots").insert(snapshots);
  if (error) throw new Error(`Seeding snapshots failed (code ${error.code}).`);
}

ownerTest.describe("dashboard GitHub spend", () => {
  ownerTest("counts the month to date product spend once and shows the month as the billing period", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard GitHub spend");
    try {
      await seedGitHubSpendLevels(workspace);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const usd = page.getByRole("region", { name: "Spending this billing period" }).getByRole("region", { name: "Spend in USD" });
      await expect(usd).toContainText("$51.75");
      await expect(usd).not.toContainText("$116.02");

      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
      const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
      const card = page.getByRole("article", { name: "GitHub billing organization" });
      await expect(card).toContainText("$51.75");
      await expect(card).toContainText(new RegExp(`Billing period:\\s*${monthStart} to ${monthEnd}`));

      await waitForTrends(page);
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

const DAY_MS = 24 * HOUR_MS;

/** The UTC date `offset` days from today, `YYYY-MM-DD`. */
function utcDay(offset: number): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + offset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * One fake account reporting a day's spend and a day's requests for each of the 20 days before
 * today, each stored the day after its own day: USD 10.00 and 200 requests a day, except USD
 * 50.00 two days ago and 900 requests three days ago. Three deployments two days ago.
 */
async function seedUnusualDays(workspace: TestWorkspace): Promise<{ connectionId: string; accountId: string }> {
  const admin = adminClient();
  const fresh = new Date(Date.now() - HOUR_MS / 6).toISOString();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "fake",
      status: "active",
      granted_at: new Date().toISOString(),
      display_name: "Fake billing account",
      poll_interval_seconds: 3_600,
      last_synced_at: fresh,
      next_sync_at: notDueForAMonth(),
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({ workspace_id: workspace.id, connection_id: connection.id, external_id: "acct_daily", display_name: "Production", kind: "account" })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  const snapshots: SnapshotInsert[] = [];
  for (let offset = -20; offset <= -1; offset += 1) {
    const common = {
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_account_id: account.id,
      snapshot_date: utcDay(offset + 1),
      period_start: `${utcDay(offset)}T00:00:00.000Z`,
      period_end: `${utcDay(offset + 1)}T00:00:00.000Z`,
      retrieved_at: fresh,
      provenance_source: "provider_api",
    } as const;
    snapshots.push(
      {
        ...common,
        metric_key: "fake.spend.daily",
        kind: "verified_spend",
        label: "Spend per day",
        amount_minor: offset === -2 ? 5_000 : 1_000,
        currency: "USD",
      },
      { ...common, metric_key: "fake.requests.daily", kind: "usage", label: "Requests per day", value: offset === -3 ? 900 : 200, unit: "requests" },
    );
  }
  const { error } = await admin.from("usage_snapshots").insert(snapshots);
  if (error) throw new Error(`Seeding snapshots failed (code ${error.code}).`);
  const { error: eventError } = await admin.from("activity_events").insert(
    [10, 11, 12].map((hour) => ({
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_account_id: account.id,
      provider: "fake" as const,
      type_id: "fake.deploy.succeeded",
      severity: "success" as const,
      title: `Deployment at ${hour}:00 succeeded`,
      occurred_at: `${utcDay(-2)}T${hour}:00:00.000Z`,
      dedupe_key: `deploy:${hour}`,
    })),
  );
  if (eventError) throw new Error(`Seeding deployments failed (code ${eventError.code}).`);
  return { connectionId: connection.id, accountId: account.id };
}

/**
 * The two `stackdash.anomaly_detected` events the daily summary job records for the days
 * `seedUnusualDays` makes unusual, each at the end of its day, as `anomalyEvent` writes them.
 */
async function seedRecordedUnusualDays(workspace: TestWorkspace, { connectionId, accountId }: { connectionId: string; accountId: string }) {
  const recorded = [
    { day: utcDay(-2), metric: "fake.spend.daily", title: "Unusual spend on Example provider: 5 times the usual daily spend" },
    { day: utcDay(-3), metric: "fake.requests.daily", title: "Unusual usage on Example provider: 4.5 times the usual daily usage" },
  ];
  const { error } = await adminClient()
    .from("activity_events")
    .insert(
      recorded.map(({ day, metric, title }) => ({
        workspace_id: workspace.id,
        connection_id: connectionId,
        external_account_id: accountId,
        provider: "fake" as const,
        type_id: "stackdash.anomaly_detected",
        severity: "warning" as const,
        title,
        occurred_at: new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString(),
        dedupe_key: `anomaly:${day}:fake:${metric}:verified`,
      })),
    );
  if (error) throw new Error(`Seeding recorded unusual days failed (code ${error.code}).`);
  return recorded.map(({ title }) => title);
}

ownerTest.describe("dashboard what changed", () => {
  ownerTest("opens with what was unusual, newest first, and each sentence leads to that day on the timeline", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard what changed");
    try {
      await seedUnusualDays(workspace);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const summary = page.getByRole("region", { name: "What changed" });
      await expect(summary).toContainText("Unusual spend and usage in the last 7 days, newest first.");
      const items = summary.getByRole("listitem");
      await expect(items).toHaveCount(2);
      await expect(items.nth(0)).toContainText(
        `Example provider: Spend per day (verified) was $50.00 on ${dayLabel(utcDay(-2))}, 5 times the usual $10.00 a day ` +
          `(the median of the 14 days from ${utcDay(-16)} to ${utcDay(-3)}), with 3 deployments that day.`,
      );
      await expect(items.nth(1)).toContainText(
        `Example provider: Requests per day (verified) was 900 requests on ${dayLabel(utcDay(-3))}, 4.5 times the usual 200 requests a day ` +
          `(the median of the 14 days from ${utcDay(-17)} to ${utcDay(-4)}).`,
      );
      // It opens the page: before the headline strip and the totals.
      const summaryBox = await summary.boundingBox();
      const totalsBox = await page.getByRole("region", { name: "Spending this billing period" }).boundingBox();
      expect(summaryBox?.y ?? Infinity).toBeLessThan(totalsBox?.y ?? 0);

      await waitForTrends(page);
      await expectNoAxeViolations(page);

      // Keyboard only: the filter bar's toggle, then each sentence's link in reading order.
      const spendLink = summary.getByRole("link", { name: `Show Example provider events on ${utcDay(-2)}` });
      const requestsLink = summary.getByRole("link", { name: `Show Example provider events on ${utcDay(-3)}` });
      await page.getByRole("region", { name: "Filters", exact: true }).locator("summary").focus();
      await page.keyboard.press("Tab");
      await expect(spendLink).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(requestsLink).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(spendLink).toBeFocused();
      await page.keyboard.press("Enter");

      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/timeline\\?from=${utcDay(-2)}&to=${utcDay(-2)}&provider=fake$`));
      await expect(page.getByText("Deployment at 10:00 succeeded")).toBeVisible();
      await expect(page.getByText("Deployment at 12:00 succeeded")).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("lists the unusual days once, and the alerts summary counts the workspace's recorded events instead", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard unusual days once");
    try {
      const titles = await seedRecordedUnusualDays(workspace, await seedUnusualDays(workspace));
      if (EVIDENCE) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
      }
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const changed = page.getByRole("region", { name: "What changed" });
      const alerts = page.getByRole("region", { name: "Alerts", exact: true });
      await expect(changed.getByRole("listitem")).toHaveCount(2);
      await expect(alerts.getByRole("heading", { name: "Unusual spend and usage" })).toBeVisible();
      await waitForTrends(page);
      if (EVIDENCE) {
        // From the top of "What changed" to the bottom of the alerts summary: both places that
        // speak about the unusual days, in one picture.
        const top = await changed.boundingBox();
        const bottom = await alerts.boundingBox();
        if (top === null || bottom === null) throw new Error("The evidence regions are not on the page.");
        const scrolled = await page.evaluate(() => window.scrollY);
        await page.screenshot({
          path: "pr-evidence/after/dashboard-unusual-days.png",
          fullPage: true,
          clip: { x: 0, y: scrolled + top.y - 16, width: 1280, height: bottom.y + bottom.height - top.y + 32 },
          animations: "disabled",
          style: `header.sticky { visibility: hidden !important; } ${HIDE_DEV_INDICATOR}`,
        });
      }

      // "What changed" is the one list of the days. The alerts summary keeps the count of what
      // was recorded, says it covers the whole workspace from which day, and leads to those events
      // from that same day (#664).
      const from = londonDate(Date.now(), 6);
      await expect(alerts).toContainText(`2 unusual spend or usage events recorded for the whole workspace from ${dayLabel(from)} through today`);
      for (const title of titles) await expect(alerts).not.toContainText(title);
      await expect(alerts.getByRole("list")).toHaveCount(0);
      await expect(alerts.getByRole("link", { name: "Show unusual days on the timeline" })).toHaveAttribute(
        "href",
        `/w/${workspace.slug}/timeline?type=stackdash.anomaly_detected&from=${from}`,
      );
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
