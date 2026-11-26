import AxeBuilder from "@axe-core/playwright";
import type { Page, Route } from "@playwright/test";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { makeConnectionsNotDue } from "./fixtures/connections";
import { adminClient, createTestWorkspace, deleteTestWorkspace, notDueForAMonth } from "./fixtures/db";
import { EVIDENCE, HIDE_DEV_INDICATOR } from "./fixtures/webhook-panel";

/*
 * "Explore with sample data" (#257): the web server simulates providers (playwright.config.ts), so
 * an empty workspace's timeline offers it to owners and admins. The action runs the first sync of
 * this workspace's connections itself, never the instance-wide tick, so this spec stays in the
 * `chromium` project. The action leaves them due, so the spec makes them not due once they are
 * added (#621). With simulation off the control is absent; the server always simulates in
 * end-to-end runs, so `sampleDataRefusal`'s unit tests cover that case. Two tabs that submit at
 * once connect one set between them, and the other tab says why it added nothing (#287).
 */

const SAMPLE_BUTTON = "Explore with sample data";
const ALREADY_CONNECTED =
  "This workspace already has connections. Sample data is only added to a workspace with none, so it never mixes with real data.";

/**
 * Opens the empty timeline in `tab`, presses the sample data button from the keyboard, and holds
 * the submit (a POST with a Next-Action header) before it leaves, for the caller to release. The
 * tab's Realtime socket is answered by nobody, so live updates stay off and the tab keeps showing
 * its own submit's outcome, rather than re-rendering with the other tab's connections.
 */
async function holdSampleDataSubmit(tab: Page, timelinePath: string): Promise<Route> {
  const held = Promise.withResolvers<Route>();
  await tab.routeWebSocket(/\/realtime\/v1\/websocket/, () => {});
  await tab.route(
    (url) => url.pathname === timelinePath,
    async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"] !== undefined) held.resolve(route);
      else await route.continue();
    },
  );
  await tab.goto(timelinePath);
  await tab.getByRole("region", { name: "No activity yet" }).getByRole("button", { name: SAMPLE_BUTTON }).focus();
  await tab.keyboard.press("Enter");
  return held.promise;
}

/** "added" once the tab shows the timeline with sample data, the message its submit answered with, or null while it runs. */
async function sampleDataOutcome(tab: Page): Promise<string | null> {
  if (new URL(tab.url()).searchParams.get("sample") === "added") return "added";
  const alerts = await tab.getByRole("region", { name: "No activity yet" }).getByRole("alert").allTextContents();
  const message = alerts.join("").trim();
  return message === "" ? null : message;
}

ownerTest.describe("sample data as the owner", () => {
  ownerTest("fills an empty workspace's timeline and dashboard from the keyboard, labeled simulated", async ({ page }) => {
    ownerTest.slow();
    const workspace = await createTestWorkspace("Sample data");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      const empty = page.getByRole("region", { name: "No activity yet" });
      await expect(empty).toBeVisible();
      await expect(empty.getByText(/explore with sample data: made-up activity from simulated providers, labeled Simulated/)).toBeVisible();
      const connect = empty.getByRole("link", { name: "Connect a provider" });
      const sample = empty.getByRole("button", { name: SAMPLE_BUTTON });
      await expect(connect).toBeVisible();
      await expect(sample).toBeVisible();

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      // Keyboard only: the sample data button follows the connect link, and Enter presses it.
      await connect.focus();
      await page.keyboard.press("Tab");
      await expect(sample).toBeFocused();
      await page.keyboard.press("Enter");

      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline?sample=added`, { timeout: 60_000 });
      const banner = page.getByRole("status", { name: "Sample data added" });
      await expect(banner).toContainText("labeled Simulated");
      await expect(banner.getByRole("link", { name: "Connections page" })).toHaveAttribute("href", `/w/${workspace.slug}/connections`);
      await expect(page.getByRole("region", { name: "No activity yet" })).toHaveCount(0);
      const events = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      await expect(events.first()).toBeVisible();
      // The action's redirect rendered this page client side; the step below reloads it, so what
      // the redirect itself shows is checked first.
      await makeConnectionsNotDue(page, workspace.id);
      // Every connection is simulated, so the page says it once rather than on every row (#269).
      await expect(page.getByRole("region", { name: "Simulated data" })).toContainText("Every connection in view is simulated");
      await expect(page.getByText("Simulated", { exact: true })).toHaveCount(1);
      await expect(events.getByText("Simulated", { exact: true })).toHaveCount(0);
      await expectNoAxeViolations(page);

      // Every connection it made is simulated, and each one has synced.
      const { data: connections, error } = await adminClient()
        .from("connections")
        .select("granted_scopes, last_synced_at")
        .eq("workspace_id", workspace.id)
        .limit(50);
      if (error) throw new Error(`Reading connections failed (code ${error.code}).`);
      expect(connections.length).toBeGreaterThan(1);
      for (const connection of connections) {
        expect(connection.granted_scopes).toEqual(["simulated:read"]);
        expect(connection.last_synced_at).not.toBeNull();
      }

      await page.goto(`/w/${workspace.slug}/dashboard`);
      await expect(page.getByRole("heading", { name: "Connect your first provider" })).toHaveCount(0);
      const cards = page.getByRole("region", { name: "By provider" }).getByRole("article");
      await expect(cards.first()).toBeVisible();
      await expect(page.getByRole("region", { name: "Simulated data" })).toContainText("Every connection in view is simulated");
      await expect(page.getByText("Simulated", { exact: true })).toHaveCount(1);
      await expect(cards.first().getByText("Simulated", { exact: true })).toHaveCount(0);
      // The replayed week gives the headline strip a reading on every day it needs, so Spend has a
      // figure whatever day of the week this runs, not the "could not report" of a single sync.
      const strip = page.getByRole("region", { name: "This week so far" });
      await expect(strip.getByText("Simulated", { exact: true })).toHaveCount(0);
      await expect(strip.getByRole("definition").nth(1)).toContainText(/\$[\d,]+\.\d{2}/);
      await expect(strip.getByRole("definition").nth(1)).not.toContainText("could not report spend for this window");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("is not offered once anything is connected", async ({ page }) => {
    const workspace = await createTestWorkspace("Sample data connected");
    try {
      // A connection whose first sync has not finished: the timeline is still empty.
      const { error } = await adminClient().from("connections").insert({
        workspace_id: workspace.id,
        provider: "vercel",
        status: "active",
        granted_at: new Date().toISOString(),
        display_name: "Vercel e2e connection",
        poll_interval_seconds: 3600,
        next_sync_at: notDueForAMonth(),
      });
      if (error) throw new Error(`Seeding a connection failed (code ${error.code}).`);

      await page.goto(`/w/${workspace.slug}/timeline`);
      // The first sync is on its way (#322), so the empty state no longer asks for a provider.
      const empty = page.getByRole("region", { name: "Events are on their way" });
      await expect(empty.getByRole("link", { name: "Check connection status" })).toBeVisible();
      await expect(empty.getByRole("link", { name: "Connect a provider" })).toHaveCount(0);
      await expect(empty.getByRole("button", { name: SAMPLE_BUTTON })).toHaveCount(0);
      await expect(empty.getByText(/sample data/)).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

ownerTest.describe("sample data from two tabs at once (#287)", () => {
  // Evidence (PW_PR_EVIDENCE=1) is captured at one viewport, in London time, as the app prints times.
  ownerTest.use(EVIDENCE ? { timezoneId: "Europe/London", viewport: { width: 1280, height: 900 } } : {});

  ownerTest("connects one set of providers, and the other tab says why it added nothing", async ({ page }) => {
    ownerTest.slow();
    const workspace = await createTestWorkspace("Sample data twice");
    const timelinePath = `/w/${workspace.slug}/timeline`;
    const tabs = [page, await page.context().newPage()] as const;
    try {
      const submits = await Promise.all(tabs.map((tab) => holdSampleDataSubmit(tab, timelinePath)));
      // Released together, so the two submits usually both count zero and the database decides between
      // them; when one gets ahead, the other is refused by its count. Either way one set is connected
      // and the other tab is refused, so this tests the outcome; actions.test.ts holds the overlap itself.
      await Promise.all(submits.map((submit) => submit.continue()));
      for (const tab of tabs) await expect.poll(() => sampleDataOutcome(tab), { timeout: 60_000 }).not.toBeNull();

      if (EVIDENCE) {
        for (const [index, tab] of tabs.entries()) {
          await tab.screenshot({ path: `pr-evidence/after/sample-data-tab-${index + 1}.png`, animations: "disabled", style: HIDE_DEV_INDICATOR });
        }
        const list = await page.context().newPage();
        await list.goto(`/w/${workspace.slug}/connections`);
        // The sticky app header would cover the top of a list taller than the viewport.
        await list.getByRole("region", { name: "Connected providers" }).screenshot({
          path: "pr-evidence/after/sample-data-connections.png",
          animations: "disabled",
          style: `header.sticky { visibility: hidden !important; } ${HIDE_DEV_INDICATOR}`,
        });
        await list.close();
      }

      const outcomes = await Promise.all(tabs.map(sampleDataOutcome));
      expect(outcomes.toSorted()).toEqual([ALREADY_CONNECTED, "added"]);
      const [added, refused] = outcomes[0] === "added" ? tabs : [tabs[1], tabs[0]];
      await makeConnectionsNotDue(added, workspace.id);
      await expectNoAxeViolations(refused);

      // Every simulated provider once: one set between the two submits.
      const { data: connections, error } = await adminClient()
        .from("connections")
        .select("provider")
        .eq("workspace_id", workspace.id)
        .limit(50);
      if (error) throw new Error(`Reading connections failed (code ${error.code}).`);
      const providers = connections.map((connection) => connection.provider);
      expect(providers.length).toBeGreaterThan(1);
      expect(new Set(providers).size).toBe(providers.length);
    } finally {
      for (const tab of tabs) await tab.unrouteAll({ behavior: "ignoreErrors" });
      await deleteTestWorkspace(workspace);
    }
  });
});

viewerTest.describe("sample data as a viewer", () => {
  viewerTest("is not offered, and the reason is shown instead", async ({ page }) => {
    const workspace = await createTestWorkspace("Sample data viewer");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      const empty = page.getByRole("region", { name: "No activity yet" });
      await expect(empty.getByText("Only owners and admins can connect providers.")).toBeVisible();
      await expect(empty.getByRole("button", { name: SAMPLE_BUTTON })).toHaveCount(0);
      await expect(empty.getByText(/sample data/)).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
