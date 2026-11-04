import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import type { Database } from "../src/lib/supabase/database.types";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { openFilters } from "./fixtures/filters";

type EventInsert = Database["public"]["Tables"]["activity_events"]["Insert"];

const EVENT_COUNT = 60;
// Event 0 is the newest; each later event is one hour older. 23:30 UTC on June 15 is 00:30 on
// June 16 in London (summer time), so the London day June 15 holds events 1 to 24 exactly.
const NEWEST_MS = Date.UTC(2026, 5, 15, 23, 30);
const HOUR_MS = 60 * 60 * 1000;

function syntheticEvent(workspace: TestWorkspace, connectionId: string, accountId: string, index: number): EventInsert {
  return {
    workspace_id: workspace.id,
    connection_id: connectionId,
    external_account_id: accountId,
    provider: "vercel",
    type_id: "vercel.deployment_ready",
    // Every tenth event is critical: 0, 10, 20, 30, 40, 50.
    severity: index % 10 === 0 ? "critical" : "info",
    title: `Synthetic event ${index}`,
    body: `Synthetic body ${index}`,
    url: index === 0 ? "https://example.com/deployments/0" : null,
    occurred_at: new Date(NEWEST_MS - index * HOUR_MS).toISOString(),
    dedupe_key: `e2e-timeline-${index}`,
  };
}

/** A fresh workspace holding 60 synthetic Vercel events, plus one repeat of event 5's key. */
async function seedTimeline(label: string): Promise<TestWorkspace> {
  const workspace = await createTestWorkspace(label);
  const admin = adminClient();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "vercel",
      status: "active",
      display_name: "Vercel e2e connection",
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
      external_id: "team_e2e",
      display_name: "Acme e2e team",
      kind: "team",
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);

  const events = Array.from({ length: EVENT_COUNT }, (_, index) =>
    syntheticEvent(workspace, connection.id, account.id, index),
  );
  const { error: eventsError } = await admin.from("activity_events").insert(events);
  if (eventsError) throw new Error(`Seeding events failed (code ${eventsError.code}).`);

  // The same provider event ingested again, the way the sync store writes it, must be ignored.
  const repeat = { ...syntheticEvent(workspace, connection.id, account.id, 5), title: "Synthetic event 5" };
  const { error: repeatError } = await admin
    .from("activity_events")
    .upsert(repeat, { onConflict: "workspace_id,dedupe_key", ignoreDuplicates: true });
  if (repeatError) throw new Error(`Repeating an event failed (code ${repeatError.code}).`);
  return workspace;
}

/** Every event on the page, across all of its day groups. */
function eventItems(page: Page) {
  return page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
}

function eventHeading(page: Page, index: number) {
  return page.getByRole("heading", { name: `Synthetic event ${index}`, exact: true });
}

ownerTest.describe("timeline as the owner", () => {
  ownerTest("shows the 50 newest events, then the 10 older ones", async ({ page }) => {
    const workspace = await seedTimeline("Timeline pages");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Timeline");
      await expect(page.getByRole("status").filter({ hasText: "Showing 50 events" })).toBeVisible();
      await expect(eventItems(page)).toHaveCount(50);
      await expect(eventHeading(page, 0)).toBeVisible();
      await expect(eventHeading(page, 49)).toBeVisible();
      await expect(eventHeading(page, 50)).toHaveCount(0);

      const newest = eventItems(page).first();
      await expect(newest).toContainText("Vercel");
      await expect(newest).toContainText("Acme e2e team");
      await expect(newest).toContainText("Critical");
      await expect(newest.locator("time")).toHaveAttribute("datetime", "2026-06-15T23:30:00.000Z");
      const link = newest.getByRole("link", { name: /View in Vercel/ });
      await expect(link).toHaveAttribute("href", "https://example.com/deployments/0");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");

      await page.getByRole("link", { name: "Load older events" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Showing 10 older events" })).toBeVisible();
      await expect(eventItems(page)).toHaveCount(10);
      await expect(eventHeading(page, 50)).toBeVisible();
      await expect(eventHeading(page, 59)).toBeVisible();
      await expect(eventHeading(page, 49)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Load older events" })).toHaveCount(0);

      await page.getByRole("link", { name: "Show newest events" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Showing 50 events" })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("shows an event ingested twice only once", async ({ page }) => {
    const workspace = await seedTimeline("Timeline dedupe");
    try {
      const { count, error } = await adminClient()
        .from("activity_events")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace.id);
      expect(error).toBeNull();
      expect(count).toBe(EVENT_COUNT);

      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(eventHeading(page, 5)).toHaveCount(1);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("filters by severity", async ({ page }) => {
    const workspace = await seedTimeline("Timeline severity");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openFilters(page);
      await page.getByRole("checkbox", { name: "Critical" }).check();
      await page.getByRole("button", { name: "Apply filters" }).click();

      await expect(page).toHaveURL(/severity=critical/);
      await expect(page.getByRole("status").filter({ hasText: "Showing 6 events" })).toBeVisible();
      for (const index of [0, 10, 20, 30, 40, 50]) await expect(eventHeading(page, index)).toBeVisible();
      await expect(eventHeading(page, 1)).toHaveCount(0);
      const severityLinks = page.getByRole("navigation", { name: "Severity" });
      await expect(severityLinks.getByRole("link", { name: "Critical" })).toHaveAttribute("aria-current", "page");
      await expect(severityLinks.getByRole("link", { name: "All" })).not.toHaveAttribute("aria-current", "page");
      await openFilters(page);
      await expect(page.getByRole("checkbox", { name: "Critical" })).toBeChecked();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("includes whole London days at both ends of a date range", async ({ page }) => {
    const workspace = await seedTimeline("Timeline dates");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openFilters(page);
      await page.getByLabel("From date", { exact: true }).fill("2026-06-15");
      await page.getByLabel("To date", { exact: true }).fill("2026-06-15");
      await page.getByRole("button", { name: "Apply filters" }).click();

      await expect(page.getByRole("status").filter({ hasText: "Showing 24 events" })).toBeVisible();
      // 23:30 UTC on June 15 is already June 16 in London; 23:30 UTC on June 14 is the 15th.
      await expect(eventHeading(page, 0)).toHaveCount(0);
      await expect(eventHeading(page, 1)).toBeVisible();
      await expect(eventHeading(page, 24)).toBeVisible();
      await expect(eventHeading(page, 25)).toHaveCount(0);
      // The list is grouped by the same London days, so all 24 events sit under one day heading.
      await expect(
        page.getByRole("region", { name: "Events", exact: true }).getByRole("heading", { level: 2 }),
      ).toHaveText(["Monday, 2026-06-15"]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("explains when no events match, and clears the filters", async ({ page }) => {
    const workspace = await seedTimeline("Timeline no match");
    try {
      await page.goto(`/w/${workspace.slug}/timeline?severity=success`);
      await expect(page.getByRole("heading", { name: "No events match these filters" })).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Showing no events" })).toBeVisible();

      await page.getByRole("link", { name: "Clear filters" }).first().click();
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/timeline$`));
      await expect(page.getByRole("status").filter({ hasText: "Showing 50 events" })).toBeVisible();
      await openFilters(page);
      await expect(page.getByRole("checkbox", { name: "Success" })).not.toBeChecked();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("ignores invalid filter values instead of failing", async ({ page }) => {
    const workspace = await seedTimeline("Timeline invalid");
    try {
      await page.goto(`/w/${workspace.slug}/timeline?severity=bogus&type=DROP&from=2026-02-30&cursor=not-a-cursor`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Timeline");
      await expect(page.getByRole("status").filter({ hasText: "Showing 50 events" })).toBeVisible();
      await expect(eventHeading(page, 0)).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("offers to connect a provider when there is no activity", async ({ page }) => {
    const workspace = await createTestWorkspace("Timeline empty");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(page.getByRole("heading", { name: "No activity yet" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Connect a provider" })).toHaveAttribute(
        "href",
        `/w/${workspace.slug}/connections`,
      );
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

viewerTest.describe("timeline as a viewer", () => {
  viewerTest("reads the events and pages through them", async ({ page }) => {
    const workspace = await seedTimeline("Timeline viewer");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(page.getByRole("status").filter({ hasText: "Showing 50 events" })).toBeVisible();
      await expect(eventHeading(page, 0)).toBeVisible();
      await page.getByRole("link", { name: "Load older events" }).click();
      await expect(eventHeading(page, 59)).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

/**
 * Adds a project "Checkout" holding a GitHub organization with three release events, beside the
 * 60 unassigned Vercel events from `seedTimeline`.
 */
async function seedGitHubProject(workspace: TestWorkspace): Promise<void> {
  const admin = adminClient();
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
      provider: "github",
      status: "active",
      display_name: "GitHub e2e connection",
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
      external_id: "org_e2e",
      display_name: "Acme e2e organization",
      kind: "organization",
      project_id: project.id,
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  const events: EventInsert[] = [0, 1, 2].map((index) => ({
    workspace_id: workspace.id,
    connection_id: connection.id,
    external_account_id: account.id,
    provider: "github",
    type_id: "github.release_published",
    severity: "info",
    title: `GitHub release ${index}`,
    body: null,
    url: null,
    occurred_at: new Date(NEWEST_MS - (index * 2 + 1) * (HOUR_MS / 2)).toISOString(),
    dedupe_key: `e2e-timeline-github-${index}`,
  }));
  const { error } = await admin.from("activity_events").insert(events);
  if (error) throw new Error(`Seeding events failed (code ${error.code}).`);
}

ownerTest.describe("timeline scope filters", () => {
  ownerTest("narrows by provider and by project, keeps the filter in the URL, and announces the result", async ({ page }) => {
    const workspace = await seedTimeline("Timeline scope");
    try {
      await seedGitHubProject(workspace);
      await page.goto(`/w/${workspace.slug}/timeline`);
      const status = page.getByRole("status").filter({ hasText: /^Showing/ });
      await expect(status).toHaveText("Showing 50 events");
      const filters = page.getByRole("region", { name: "Filters", exact: true });
      // The bar starts closed, so the events lead the page.
      await expect(filters.getByRole("button", { name: "Apply filters" })).toBeHidden();

      await openFilters(page);
      await filters.getByRole("group", { name: "Provider" }).getByRole("checkbox", { name: "GitHub" }).check();
      await filters.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/[?&]provider=github(&|$)/);
      await expect(status).toHaveText("Showing 3 events for provider GitHub");
      await expect(eventItems(page)).toHaveCount(3);
      await expect(page.getByRole("heading", { name: "GitHub release 0", exact: true })).toBeVisible();
      await expect(eventHeading(page, 0)).toHaveCount(0);

      await openFilters(page);
      await filters.getByRole("link", { name: "Clear filters" }).click();
      await expect(status).toHaveText("Showing 50 events");

      // Keyboard only: open the filters, tick the Unassigned project, and submit with Enter.
      await openFilters(page, "keyboard");
      const unassigned = filters.getByRole("group", { name: "Project" }).getByRole("checkbox", { name: "Unassigned" });
      await unassigned.focus();
      await page.keyboard.press("Space");
      await filters.getByRole("button", { name: "Apply filters" }).focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/[?&]project=unassigned(&|$)/);
      await expect(status).toHaveText("Showing 50 events for project Unassigned");
      await expect(page.getByRole("heading", { name: "GitHub release 0", exact: true })).toHaveCount(0);
      await expect(eventHeading(page, 0)).toBeVisible();

      // Paging keeps the filter.
      await page.getByRole("link", { name: "Load older events" }).click();
      await expect(status).toHaveText("Showing 10 older events for project Unassigned");

      await page.goto(`/w/${workspace.slug}/timeline`);
      await openFilters(page);
      await filters.getByRole("group", { name: "Project" }).getByRole("checkbox", { name: "Checkout" }).check();
      await filters.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/[?&]project=[0-9a-f-]{36}(&|$)/);
      await expect(status).toHaveText("Showing 3 events for project Checkout");
      await expect(eventItems(page)).toHaveCount(3);

      // The filtered view is bookmarkable: reloading the URL shows the same result.
      await page.reload();
      await expect(status).toHaveText("Showing 3 events for project Checkout");

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
