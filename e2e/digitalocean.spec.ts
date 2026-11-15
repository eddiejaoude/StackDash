import AxeBuilder from "@axe-core/playwright";

import { expect, ownerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, CONNECTION_URL, createTestWorkspace, deleteTestWorkspace } from "./fixtures/db";

/*
 * DigitalOcean (#116), end to end. The web server simulates the live providers
 * (STACKDASH_SIMULATE_PROVIDERS=1 in playwright.config.ts), so DigitalOcean connects from the catalog
 * through the dev consent screen without an OAuth app. Synced data is seeded rather than ticked:
 * the job tick is instance-wide and lives in the `instance-wide` project, so this spec stays in
 * `chromium`. The adapter's sync itself is covered by src/lib/adapters/digitalocean/index.test.ts
 * and the simulator's tests.
 */

ownerTest.describe("DigitalOcean", () => {
  ownerTest("connects from the catalog with the keyboard and is labeled simulated", async ({ page }) => {
    const workspace = await createTestWorkspace("DigitalOcean connect");
    try {
      await page.goto(`/w/${workspace.slug}/connections`);
      const card = page
        .getByRole("list", { name: "Providers" })
        .getByRole("listitem")
        .filter({ has: page.getByRole("heading", { name: "DigitalOcean", exact: true }) });
      await expect(card.getByText("Simulated", { exact: true })).toBeVisible();
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

      await card.getByRole("link", { name: "Connect DigitalOcean" }).focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connect DigitalOcean");
      const permissions = page.getByRole("region", { name: "Permissions DigitalOcean will ask you to grant" });
      await expect(permissions.getByText(/^Simulated\. StackDash makes up example DigitalOcean data/)).toBeVisible();
      await expectNoAxeViolations(page);

      await page.getByRole("button", { name: "Continue to DigitalOcean" }).focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(CONNECTION_URL);
      await expect(page.getByRole("region", { name: "Status" }).getByText("Simulated", { exact: true })).toBeVisible();
      // Scoped to main: the header's live indicator lists "DigitalOcean (Example team)" in a hidden tooltip.
      await expect(page.getByRole("main").getByText("Example team").first()).toBeVisible();
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("shows synced DigitalOcean events on the timeline under the DigitalOcean name", async ({ page }) => {
    const workspace = await createTestWorkspace("DigitalOcean timeline");
    const admin = adminClient();
    try {
      const { data: connection, error: connectionError } = await admin
        .from("connections")
        .insert({
          workspace_id: workspace.id,
          provider: "digitalocean",
          status: "active",
          display_name: "DigitalOcean (Example team)",
          poll_interval_seconds: 3600,
        })
        .select("id")
        .single();
      if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
      const { data: account, error: accountError } = await admin
        .from("external_accounts")
        .insert({
          workspace_id: workspace.id,
          connection_id: connection.id,
          external_id: "11111111-a636-11ec-a6ac-1323bf96ef4d",
          display_name: "Example team",
          kind: "team",
        })
        .select("id")
        .single();
      if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
      const base = {
        workspace_id: workspace.id,
        connection_id: connection.id,
        external_account_id: account.id,
        provider: "digitalocean" as const,
        url: null,
      };
      const { error: eventsError } = await admin.from("activity_events").insert([
        {
          ...base,
          type_id: "digitalocean.deployment.failed",
          severity: "critical",
          title: "Deployment of storefront failed",
          body: null,
          occurred_at: "2026-11-05T10:03:00.000Z",
          dedupe_key: "digitalocean:deployment:e2e-1:failed",
        },
        {
          ...base,
          type_id: "digitalocean.droplet.resized",
          severity: "info",
          title: "Droplet web-1 resized",
          body: "Region nyc3.",
          occurred_at: "2026-11-05T09:00:00.000Z",
          dedupe_key: "digitalocean:action:e2e-2:completed",
        },
      ]);
      if (eventsError) throw new Error(`Seeding events failed (code ${eventsError.code}).`);

      await page.goto(`/w/${workspace.slug}/timeline?provider=digitalocean`);
      await expect(page.getByRole("status").filter({ hasText: /^Showing/ })).toHaveText(
        "Showing 2 of 2 events for provider DigitalOcean",
      );
      const events = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      await expect(events).toHaveCount(2);
      const failed = events.filter({ has: page.getByRole("heading", { name: "Deployment of storefront failed" }) });
      await expect(failed).toContainText("DigitalOcean");
      await expect(failed).toContainText("Example team");
      await expect(failed).toContainText("Critical");
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
