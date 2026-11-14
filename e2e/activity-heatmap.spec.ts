import type { Database } from "../src/lib/supabase/database.types";

import { expect, ownerTest } from "./fixtures/auth";
import { expectNoAxeViolations, waitForTrends } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";

// Every test seeds its own workspace with synthetic data from the fake provider only.

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

type EventInsert = Database["public"]["Tables"]["activity_events"]["Insert"];

const LONDON = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/London", weekday: "short", hour: "2-digit", hourCycle: "h23" });

/** The heatmap cell an instant lands in: London's short weekday and hour. */
function londonCell(at: Date): { day: string; hour: number } {
  const parts = LONDON.formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? "";
  return { day: part("weekday"), hour: Number(part("hour")) };
}

const hh = (hour: number) => `${String(hour).padStart(2, "0")}:00`;

type Seeded = Readonly<{ connectionId: string; accountId: string }>;

async function seedConnection(workspace: TestWorkspace): Promise<Seeded> {
  const admin = adminClient();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "fake",
      status: "active",
      display_name: "Fake heatmap account",
      poll_interval_seconds: 3_600,
      last_synced_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({ workspace_id: workspace.id, connection_id: connection.id, external_id: "acct_heatmap", display_name: "Heatmap", kind: "account" })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  return { connectionId: connection.id, accountId: account.id };
}

/**
 * Ten deployments three days ago, five in each of two adjacent hours from 12:00 UTC (the same two
 * London hours, whatever the clock change), one signup five days ago, and one DevMacro sync failure
 * seven days ago with no provider or account. Returns where each lands.
 */
async function seedEvents(workspace: TestWorkspace, seeded: Seeded) {
  const midnight = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  const deployStart = new Date(midnight - 3 * DAY_MS + 12 * 60 * MINUTE_MS);
  const signupAt = new Date(midnight - 5 * DAY_MS + 8 * 60 * MINUTE_MS + 30 * MINUTE_MS);
  const failureAt = new Date(midnight - 7 * DAY_MS + 20 * 60 * MINUTE_MS + 30 * MINUTE_MS);
  const event = (at: Date, key: string, overrides: Partial<EventInsert> = {}): EventInsert => ({
    workspace_id: workspace.id,
    connection_id: seeded.connectionId,
    external_account_id: seeded.accountId,
    provider: "fake",
    type_id: "fake.deploy.succeeded",
    severity: "success",
    title: "Deployment succeeded",
    occurred_at: at.toISOString(),
    dedupe_key: `heatmap-${key}`,
    ...overrides,
  });
  const deploys = Array.from({ length: 10 }, (_, index) => {
    const hourOffset = index < 5 ? 0 : 60;
    return event(new Date(deployStart.getTime() + (hourOffset + 5 + (index % 5) * 10) * MINUTE_MS), `deploy-${index}`);
  });
  const { error } = await adminClient()
    .from("activity_events")
    .insert([
      ...deploys,
      event(signupAt, "signup", { type_id: "fake.signup", severity: "info", title: "New signup" }),
      event(failureAt, "sync-failed", {
        external_account_id: null,
        provider: null,
        type_id: "devmacro.sync_failed",
        severity: "warning",
        title: "Sync failed",
      }),
    ]);
  if (error) throw new Error(`Seeding events failed (code ${error.code}).`);
  return { deploys: londonCell(deployStart), signup: londonCell(signupAt), failure: londonCell(failureAt) };
}

ownerTest.describe("activity heatmap", () => {
  ownerTest("shows when events happen, names the peak, and switches the event group through the URL", async ({ page }) => {
    const workspace = await createTestWorkspace("Activity heatmap");
    try {
      const seeded = await seedConnection(workspace);
      const cells = await seedEvents(workspace, seeded);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await waitForTrends(page);
      const heatmap = page.getByRole("region", { name: "When things happen" });
      const filters = heatmap.getByRole("navigation", { name: "Heatmap events" });
      const sentence = heatmap.getByRole("status");

      // Every event, by default, with nothing about it in the URL.
      await expect(filters.getByRole("link", { name: "all", exact: true })).toHaveAttribute("aria-current", "page");
      const { day, hour } = cells.deploys;
      await expect(sentence).toHaveText(`peak ${day} ${hh(hour)} to ${hh(hour + 2)} · 10 events`);
      await expect(heatmap.getByRole("cell", { name: "5 events, in the peak" })).toHaveCount(2);
      await expect(heatmap.getByTitle(`${day} ${hh(hour)}, 5 events`)).toBeVisible();
      await expect(heatmap.getByTitle(`${cells.signup.day} ${hh(cells.signup.hour)}, 1 event`)).toBeVisible();
      await expect(heatmap.getByRole("table")).toContainText("Monday");
      await expect(filters.getByRole("link", { name: "signups", exact: true })).toHaveAttribute(
        "href",
        `/w/${workspace.slug}/dashboard?heat=signups`,
      );
      await expectNoAxeViolations(page);

      await filters.getByRole("link", { name: "signups", exact: true }).click();
      await expect(page).toHaveURL(/[?&]heat=signups(&|$)/);
      await expect(filters.getByRole("link", { name: "signups", exact: true })).toHaveAttribute("aria-current", "page");
      await expect(filters.getByRole("link", { name: "all", exact: true })).not.toHaveAttribute("aria-current");
      await expect(sentence).toHaveText(`peak ${cells.signup.day} ${hh(cells.signup.hour)} to ${hh(cells.signup.hour + 1)} · 1 event`);

      // DevMacro's own sync failure counts by its type, with no provider and no account.
      await filters.getByRole("link", { name: "failures", exact: true }).click();
      await expect(page).toHaveURL(/[?&]heat=failures(&|$)/);
      await expect(sentence).toHaveText(`peak ${cells.failure.day} ${hh(cells.failure.hour)} to ${hh(cells.failure.hour + 1)} · 1 event`);
      await expectNoAxeViolations(page);

      // Keyboard only: Tab from one chip to the next, and Enter follows it.
      await filters.getByRole("link", { name: "signups", exact: true }).focus();
      await page.keyboard.press("Shift+Tab");
      await expect(filters.getByRole("link", { name: "deploys", exact: true })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/[?&]heat=deploys(&|$)/);
      await expect(sentence).toHaveText(`peak ${day} ${hh(hour)} to ${hh(hour + 2)} · 10 events`);

      // Back to every event: the default leaves the URL.
      await filters.getByRole("link", { name: "all", exact: true }).click();
      await expect(page).not.toHaveURL(/heat=/);
      await expect(sentence).toHaveText(`peak ${day} ${hh(hour)} to ${hh(hour + 2)} · 10 events`);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("follows the dashboard filter and says when nothing happened", async ({ page }) => {
    const workspace = await createTestWorkspace("Activity heatmap empty");
    try {
      const seeded = await seedConnection(workspace);
      await seedEvents(workspace, seeded);
      // The workspace has events, but none from GitHub.
      await page.goto(`/w/${workspace.slug}/dashboard?provider=github`);
      await waitForTrends(page);
      const heatmap = page.getByRole("region", { name: "When things happen" });
      const filters = heatmap.getByRole("navigation", { name: "Heatmap events" });
      await expect(heatmap.getByRole("status")).toHaveText("No events in the last 28 days");
      await expect(heatmap.getByRole("cell", { name: "0 events" })).toHaveCount(7 * 24);

      // A chip keeps the scope filter.
      await filters.getByRole("link", { name: "failures", exact: true }).click();
      await expect(page).toHaveURL(/\?provider=github&heat=failures$/);
      await expect(heatmap.getByRole("status")).toHaveText("No failure events in the last 28 days");
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
