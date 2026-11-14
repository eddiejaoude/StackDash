import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, ownerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import { adminClient, createTestWorkspace, cronSecret, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";

/*
 * Simulated providers (#131), end to end: the web server runs with STACKDASH_SIMULATE_PROVIDERS=1
 * (playwright.config.ts), so Vercel, Stripe, Polar, Railway, and Sentry connect from the catalog
 * through the dev consent screen without an OAuth app, a tick through POST /api/jobs/tick syncs
 * their made-up data, and every screen labels it "Simulated": once per page while every connection
 * in view is simulated, and on each simulated item once a real connection joins them (#269).
 * Nothing leaves the machine. Sentry is here because its releases are the only events a 30 minute
 * backfill holds by construction: the others make up a small product's activity (#264), a few
 * payments and about 50 new customers a day, so their first sync may bring none.
 *
 * The tick is instance-wide: it also syncs the connections other specs seed, in their workspaces.
 * So this spec runs in the `instance-wide` Playwright project, after every `chromium` spec has
 * finished (playwright.config.ts). Any spec that runs the tick must live in that project too, and
 * only those: a test here that never ticks belongs in `chromium` (see
 * real-connection-while-simulating.spec.ts).
 */

const VERCEL_CONNECTION = "Vercel (Example team)";
const STRIPE_CONNECTION = "Stripe (Example Stripe account (test mode))";
const POLAR_CONNECTION = "Polar (Example organization)";
const RAILWAY_CONNECTION = "Railway (Example workspace)";
// Three simulated projects: `authorizedAccountLabel` names the first two and counts the rest.
const SENTRY_CONNECTION = "Sentry (web, api and 1 more)";
const SIMULATED_CONNECTIONS = [VERCEL_CONNECTION, STRIPE_CONNECTION, POLAR_CONNECTION, RAILWAY_CONNECTION, SENTRY_CONNECTION];
const REAL_CONNECTION = "Vercel (real team)";
const REAL_EVENT = "Real deployment ready";

/** Ticks until every simulated connection has synced; other specs' jobs may share a tick. */
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
    expect(data.filter((row) => row.last_synced_at !== null).map((row) => row.provider).sort()).toEqual([
      "polar",
      "railway",
      "sentry",
      "stripe",
      "vercel",
    ]);
  }).toPass({ timeout: 90_000 });
}

/** The page's one "Simulated" notice (#269), a region, so a screen reader can reach it by landmark. */
function simulatedNotice(page: Page) {
  return page.getByRole("region", { name: "Simulated data" });
}

/** A page that says "Simulated" exactly once, in its notice, which assistive technology can read. */
async function expectOneSimulatedNotice(page: Page): Promise<void> {
  await expect(simulatedNotice(page)).toMatchAriaSnapshot(`
    - region "Simulated data":
      - text: Simulated
      - paragraph: /^Every connection in view is simulated/
  `);
  await expect(page.getByText("Simulated", { exact: true })).toHaveCount(1);
}

/** A real Vercel connection with one event that happened just now, so it leads the timeline. */
async function seedRealConnection(workspace: TestWorkspace): Promise<void> {
  const admin = adminClient();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({ workspace_id: workspace.id, provider: "vercel", status: "active", display_name: REAL_CONNECTION, poll_interval_seconds: 3600 })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({ workspace_id: workspace.id, connection_id: connection.id, external_id: "team_real", display_name: "Real team", kind: "team" })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  const { error } = await admin.from("activity_events").insert({
    workspace_id: workspace.id,
    connection_id: connection.id,
    external_account_id: account.id,
    provider: "vercel",
    type_id: "vercel.deployment_ready",
    severity: "info",
    title: REAL_EVENT,
    occurred_at: new Date().toISOString(),
    dedupe_key: "e2e-simulated-providers-real",
  });
  if (error) throw new Error(`Seeding an event failed (code ${error.code}).`);
}

ownerTest.describe("simulated providers", () => {
  ownerTest("connect from the catalog, sync on a tick, and show as simulated everywhere", async ({ page }) => {
    ownerTest.slow();
    const workspace = await createTestWorkspace("Simulated providers");
    try {
      await connectSimulated(page, workspace.slug, "Vercel");
      await connectSimulated(page, workspace.slug, "Stripe");
      await connectSimulated(page, workspace.slug, "Polar");
      await connectSimulated(page, workspace.slug, "Railway");
      await connectSimulated(page, workspace.slug, "Sentry");

      await page.goto(`/w/${workspace.slug}/connections`);
      const connections = page.getByRole("list", { name: "Connections" }).getByRole("listitem");
      await expect(connections).toHaveCount(5);
      for (const name of SIMULATED_CONNECTIONS) {
        const row = connections.filter({ has: page.getByRole("link", { name, exact: true }) });
        await expect(row.getByText("Simulated", { exact: true })).toBeVisible();
      }
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      await tickUntilSynced(page, workspace);

      // Each provider is checked on its own filtered timeline (the shared scope filter's
      // `provider` parameter), so one provider's volume never pushes another off the first page.
      // Every connection in view is simulated, so the page says so once and no row repeats it (#269).
      const events = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      const status = page.getByRole("status").filter({ hasText: /^Showing/ });

      // Every Sentry project releases every 20 minutes, so the 30 minute backfill always holds one.
      await page.goto(`/w/${workspace.slug}/timeline?provider=sentry`);
      await expect(status).toHaveText(/^Showing \d+ of [\d,]+ events? for provider Sentry$/);
      await expect(events.first()).toBeVisible();
      await expect(events.first().getByText("Sentry", { exact: true })).toBeVisible();
      await expectOneSimulatedNotice(page);
      await expect(events.getByText("Simulated", { exact: true })).toHaveCount(0);
      const timelineScan = await new AxeBuilder({ page }).analyze();
      expect(timelineScan.violations).toEqual([]);

      // Nothing else is guaranteed in the backfill by construction, so a filtered page may be empty,
      // and then nothing is in view to call simulated. The dashboard below always is.
      for (const [slug, name] of [["stripe", "Stripe"], ["polar", "Polar"], ["vercel", "Vercel"], ["railway", "Railway"]] as const) {
        await page.goto(`/w/${workspace.slug}/timeline?provider=${slug}`);
        await expect(status).toHaveText(new RegExp(`^Showing (no events|\\d+ of [\\d,]+ events?) for provider ${name}$`));
        const rows = await events.count();
        for (let index = 0; index < rows; index += 1) {
          await expect(events.nth(index).getByText(name, { exact: true })).toBeVisible();
        }
        if (rows > 0) await expectOneSimulatedNotice(page);
        else await expect(simulatedNotice(page)).toHaveCount(0);
      }

      await page.goto(`/w/${workspace.slug}/dashboard`);
      const byProvider = page.getByRole("region", { name: "By provider" });
      for (const name of SIMULATED_CONNECTIONS) {
        await expect(byProvider.getByRole("article", { name })).toBeVisible();
      }
      await expect(page.getByRole("region", { name: "Trends" }).getByRole("figure").first()).toBeVisible();
      // Every card, total, and chart is simulated, so only the notice says so.
      await expectOneSimulatedNotice(page);
      // Polar's revenue shows as revenue and its fees as spend on its own card, never mixed.
      const polarCard = byProvider.getByRole("article", { name: POLAR_CONNECTION });
      await expect(polarCard.getByRole("heading", { name: "Revenue this billing period", level: 4 })).toBeVisible();
      await expect(polarCard.getByRole("heading", { name: "Spend this billing period", level: 4 })).toBeVisible();
      // MRR and ARR are run rates under their own heading, never added into the revenue above.
      await expect(polarCard.getByRole("heading", { name: "Recurring revenue", level: 4 })).toBeVisible();
      for (const label of ["Monthly recurring revenue (USD)", "Annual recurring revenue (USD)"]) {
        await expect(polarCard.getByText(label, { exact: true })).toBeVisible();
      }
      // A card lists only what its provider can report (#269): Railway declares a credit balance,
      // Vercel does not, and Vercel reports no allowance reset, so no row of its card is a
      // permanent "Unavailable".
      const railwayCard = byProvider.getByRole("article", { name: RAILWAY_CONNECTION });
      await expect(railwayCard.getByRole("heading", { name: "Credit balance", level: 4 })).toBeVisible();
      const vercelCard = byProvider.getByRole("article", { name: VERCEL_CONNECTION });
      await expect(vercelCard.getByRole("heading", { name: "Spend this billing period", level: 4 })).toBeVisible();
      await expect(vercelCard.getByRole("heading", { name: "Credit balance", level: 4 })).toHaveCount(0);
      await expect(vercelCard.getByText("Next reset:", { exact: true })).toHaveCount(0);
      await expect(vercelCard.getByText("Unavailable", { exact: true })).toHaveCount(0);
      const dashboardScan = await new AxeBuilder({ page }).analyze();
      expect(dashboardScan.violations).toEqual([]);

      // A real connection joins: the workspace is mixed, so the notice goes and every simulated
      // row, card, total, and chart carries its own badge again, while the real ones carry none.
      await seedRealConnection(workspace);
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(events.first()).toBeVisible();
      await expect(simulatedNotice(page)).toHaveCount(0);
      const realRow = events.filter({ has: page.getByRole("heading", { name: REAL_EVENT, exact: true }) });
      await expect(realRow).toBeVisible();
      await expect(realRow.getByText("Simulated", { exact: true })).toHaveCount(0);
      const simulatedRow = events.filter({ hasNot: page.getByRole("heading", { name: REAL_EVENT, exact: true }) }).first();
      await expect(simulatedRow.getByText("Simulated", { exact: true })).toBeVisible();

      await page.goto(`/w/${workspace.slug}/dashboard`);
      await expect(byProvider.getByRole("article", { name: REAL_CONNECTION })).toBeVisible();
      await expect(simulatedNotice(page)).toHaveCount(0);
      await expect(byProvider.getByRole("article", { name: REAL_CONNECTION }).getByText("Simulated", { exact: true })).toHaveCount(0);
      for (const name of SIMULATED_CONNECTIONS) {
        await expect(byProvider.getByRole("article", { name }).getByText("Simulated", { exact: true })).toBeVisible();
      }
      // Every total the simulated connections contribute to says so, not only their own cards.
      const spendCards = page
        .getByRole("region", { name: "Spending this billing period" })
        .getByRole("region", { name: /^Spend in [A-Z]{3}$/ });
      for (let index = 0; index < (await spendCards.count()); index += 1) {
        await expect(spendCards.nth(index).getByText("Simulated", { exact: true })).toBeVisible();
      }
      // Stripe's and Polar's made-up payments arrive as revenue, kept apart per currency.
      const revenueCards = page
        .getByRole("region", { name: "Revenue this billing period" })
        .getByRole("region", { name: /^Revenue in [A-Z]{3}$/ });
      await expect(revenueCards.first()).toBeVisible();
      for (let index = 0; index < (await revenueCards.count()); index += 1) {
        await expect(revenueCards.nth(index).getByText("Simulated", { exact: true })).toBeVisible();
      }
      // The real connection has not synced, so every chart is the simulated connections'.
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
