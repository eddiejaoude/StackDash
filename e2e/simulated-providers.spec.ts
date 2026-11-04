import { existsSync } from "node:fs";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { z } from "zod";

import { expect, ownerTest } from "./fixtures/auth";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";

/*
 * Simulated providers (#131), end to end: the web server runs with DEVMACRO_SIMULATE_PROVIDERS=1
 * (playwright.config.ts), so Vercel and Stripe connect from the catalog through the dev consent
 * screen without an OAuth app, a tick through POST /api/jobs/tick syncs their made-up data, and
 * every screen labels it "Simulated". Nothing leaves the machine.
 *
 * The tick is instance-wide: it also syncs the connections other specs seed, in their workspaces.
 * So this spec runs in the `instance-wide` Playwright project, after every `chromium` spec has
 * finished (playwright.config.ts). Any spec that runs the tick must live in that project too, and
 * only those: a test here that never ticks belongs in `chromium` (see
 * real-connection-while-simulating.spec.ts).
 */

const CONNECTION_URL = /\/connections\/([0-9a-f-]{36})(\?|$)/;
const VERCEL_CONNECTION = "Vercel (Example team)";
const STRIPE_CONNECTION = "Stripe (Example Stripe account (test mode))";

function cronSecret(): string {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  return z.string().min(32).parse(process.env.CRON_SECRET);
}

/** Connects a simulated provider from the catalog with the keyboard and lands on the connection. */
async function connectFromCatalog(page: Page, slug: string, provider: "Vercel" | "Stripe"): Promise<void> {
  await page.goto(`/w/${slug}/connections`);
  const card = page
    .getByRole("list", { name: "Providers" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: provider, exact: true }) });
  await expect(card.getByText("Simulated", { exact: true })).toBeVisible();
  await card.getByRole("link", { name: `Connect ${provider}` }).click();

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Connect ${provider}`);
  const permissions = page.getByRole("region", { name: `Permissions ${provider} will ask you to grant` });
  await expect(permissions.getByText("Simulated", { exact: true })).toBeVisible();
  await expect(permissions.getByText(/^Simulated\. DevMacro makes up example/)).toBeVisible();
  await page.getByRole("button", { name: `Continue to ${provider}` }).focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(CONNECTION_URL);
  await expect(page.getByRole("region", { name: "Status" }).getByText("Simulated", { exact: true })).toBeVisible();
}

/** Ticks until both simulated connections have synced; other specs' jobs may share a tick. */
async function tickUntilSynced(page: Page, workspace: TestWorkspace): Promise<void> {
  const authorization = `Bearer ${cronSecret()}`;
  await expect(async () => {
    const response = await page.request.post("/api/jobs/tick", { headers: { Authorization: authorization }, timeout: 120_000 });
    expect(response.status()).toBe(200);
    const { data, error } = await adminClient()
      .from("connections")
      .select("provider, last_synced_at")
      .eq("workspace_id", workspace.id)
      .limit(10);
    if (error) throw new Error(`Reading connections failed (code ${error.code}).`);
    expect(data.filter((row) => row.last_synced_at !== null).map((row) => row.provider).sort()).toEqual(["stripe", "vercel"]);
  }).toPass({ timeout: 90_000 });
}

ownerTest.describe("simulated providers", () => {
  ownerTest("connect from the catalog, sync on a tick, and show as simulated everywhere", async ({ page }) => {
    ownerTest.slow();
    const workspace = await createTestWorkspace("Simulated providers");
    try {
      await connectFromCatalog(page, workspace.slug, "Vercel");
      await connectFromCatalog(page, workspace.slug, "Stripe");

      await page.goto(`/w/${workspace.slug}/connections`);
      const connections = page.getByRole("list", { name: "Connections" }).getByRole("listitem");
      await expect(connections).toHaveCount(2);
      for (const name of [VERCEL_CONNECTION, STRIPE_CONNECTION]) {
        const row = connections.filter({ has: page.getByRole("link", { name, exact: true }) });
        await expect(row.getByText("Simulated", { exact: true })).toBeVisible();
      }
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      await tickUntilSynced(page, workspace);

      // Each provider is checked on its own filtered timeline (the shared scope filter's
      // `provider` parameter), so Stripe's volume never pushes Vercel off the first page.
      const events = page.getByRole("list", { name: "Events" }).getByRole("listitem");
      const status = page.getByRole("status").filter({ hasText: /^Showing/ });

      // Stripe's 30 minute backfill always holds events (about one every two slots).
      await page.goto(`/w/${workspace.slug}/timeline?provider=stripe`);
      await expect(status).toHaveText(/^Showing \d+ events? for provider Stripe$/);
      await expect(events.first()).toBeVisible();
      await expect(events.first()).toContainText(/^Stripe/);
      await expect(events.first().getByText("Simulated", { exact: true })).toBeVisible();

      // A Vercel deployment is not guaranteed in the backfill, so the filtered page may be empty;
      // every Vercel row that is there is labeled. The Vercel dashboard card below always is.
      await page.goto(`/w/${workspace.slug}/timeline?provider=vercel`);
      await expect(status).toHaveText(/^Showing (no events|\d+ events?) for provider Vercel$/);
      const vercelRows = await events.count();
      for (let index = 0; index < vercelRows; index += 1) {
        await expect(events.nth(index)).toContainText(/^Vercel/);
        await expect(events.nth(index).getByText("Simulated", { exact: true })).toBeVisible();
      }

      await page.goto(`/w/${workspace.slug}/dashboard`);
      const byProvider = page.getByRole("region", { name: "By provider" });
      for (const name of [VERCEL_CONNECTION, STRIPE_CONNECTION]) {
        await expect(byProvider.getByRole("article", { name }).getByText("Simulated", { exact: true })).toBeVisible();
      }
      // Every total the simulated connections contribute to says so, not only their own cards.
      const spendCards = page
        .getByRole("region", { name: "Spending this billing period" })
        .getByRole("region", { name: /^Spend in [A-Z]{3}$/ });
      for (let index = 0; index < (await spendCards.count()); index += 1) {
        await expect(spendCards.nth(index).getByText("Simulated", { exact: true })).toBeVisible();
      }
      // Stripe's made-up payments arrive as revenue, kept apart per currency.
      const revenueCards = page
        .getByRole("region", { name: "Revenue this billing period" })
        .getByRole("region", { name: /^Revenue in [A-Z]{3}$/ });
      await expect(revenueCards.first()).toBeVisible();
      for (let index = 0; index < (await revenueCards.count()); index += 1) {
        await expect(revenueCards.nth(index).getByText("Simulated", { exact: true })).toBeVisible();
      }
      const trends = page.getByRole("region", { name: "Trends" }).getByRole("figure");
      await expect(trends.first()).toBeVisible();
      for (let index = 0; index < (await trends.count()); index += 1) {
        await expect(trends.nth(index).getByText("Simulated", { exact: true })).toBeVisible();
      }
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
