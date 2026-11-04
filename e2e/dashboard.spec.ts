import AxeBuilder from "@axe-core/playwright";

import type { Database } from "../src/lib/supabase/database.types";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { openFilters } from "./fixtures/filters";

// Every test seeds its own workspace with synthetic data from the fake provider only.

const HOUR_MS = 3_600_000;

type SnapshotInsert = Database["public"]["Tables"]["usage_snapshots"]["Insert"];

/**
 * One fake connection polled hourly, two accounts (Production in project Checkout, Staging
 * unassigned), USD and EUR verified spend, a USD estimate, an included allowance with its usage
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
      display_name: "Fake billing account",
      poll_interval_seconds: 3_600,
      last_synced_at: fresh,
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
      metric_key: "fake.cost.estimate",
      kind: "estimated_spend",
      label: "Estimated spend for the month",
      amount_minor: 20_000,
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

      const usd = totals.getByRole("region", { name: "Spend in USD" });
      await expect(usd).toContainText("$123.45");
      await expect(usd).toContainText("$200.00");
      await expect(usd).not.toContainText("€");
      await expect(usd.getByText("Verified", { exact: true })).toBeVisible();
      await expect(usd.getByText("Estimated", { exact: true })).toBeVisible();
      await expect(usd).toContainText("Updated");
      // The totals print amounts only; the price list behind an estimate is named on the provider card.
      await expect(page.getByRole("region", { name: "By provider" })).toContainText("Pricing source: Fake price list 2026");

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

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
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
      display_name: "GitHub e2e organization",
      poll_interval_seconds: 3_600,
      last_synced_at: fresh,
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

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      await filters.getByRole("link", { name: "Clear filters" }).click();
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/dashboard$`));
      await expect(status).toHaveText("Showing 2 connections");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
