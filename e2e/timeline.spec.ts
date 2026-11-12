import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import type { Database } from "../src/lib/supabase/database.types";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { checkEvery, expectClosedFilterBarOneRow, expectFormBelowWrappedStatus, openFilters } from "./fixtures/filters";

type EventInsert = Database["public"]["Tables"]["activity_events"]["Insert"];
type AccountInsert = Database["public"]["Tables"]["external_accounts"]["Insert"];

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

type SeededAccount = Readonly<{ connectionId: string; accountId: string }>;

/** One active connection with one account, the parents every seeded event points at. */
async function seedAccount(
  workspace: TestWorkspace,
  seed: Readonly<{
    provider: Database["public"]["Enums"]["provider_id"];
    connectionName: string;
    externalId: string;
    accountName: string;
    kind: AccountInsert["kind"];
    projectId?: string;
  }>,
): Promise<SeededAccount> {
  const admin = adminClient();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: seed.provider,
      status: "active",
      display_name: seed.connectionName,
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
      external_id: seed.externalId,
      display_name: seed.accountName,
      kind: seed.kind,
      ...(seed.projectId === undefined ? {} : { project_id: seed.projectId }),
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  return { connectionId: connection.id, accountId: account.id };
}

/** A fresh workspace holding 60 synthetic Vercel events, plus one repeat of event 5's key. */
async function seedTimeline(label: string): Promise<TestWorkspace> {
  const workspace = await createTestWorkspace(label);
  const admin = adminClient();
  const { connectionId, accountId } = await seedAccount(workspace, {
    provider: "vercel",
    connectionName: "Vercel e2e connection",
    externalId: "team_e2e",
    accountName: "Acme e2e team",
    kind: "team",
  });

  const events = Array.from({ length: EVENT_COUNT }, (_, index) => syntheticEvent(workspace, connectionId, accountId, index));
  const { error: eventsError } = await admin.from("activity_events").insert(events);
  if (eventsError) throw new Error(`Seeding events failed (code ${eventsError.code}).`);

  // The same provider event ingested again, the way the sync store writes it, must be ignored.
  const repeat = { ...syntheticEvent(workspace, connectionId, accountId, 5), title: "Synthetic event 5" };
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

function providerBadges(page: Page) {
  return page.getByRole("list", { name: "Events by provider", exact: true });
}

/**
 * The provider badges (#245): exactly these links, in this order, each named for what it does and
 * the exact counts, such as "Show only Vercel: 60 events from 1 connection".
 */
async function expectProviderBadges(page: Page, expected: string[]) {
  const links = providerBadges(page).getByRole("link");
  await expect(links).toHaveCount(expected.length);
  for (const [index, name] of expected.entries()) await expect(links.nth(index)).toHaveAccessibleName(name);
}

/** The badges sit in the title's row: their vertical middle falls within the heading's box. */
async function expectBadgesBesideTitle(page: Page) {
  const title = await page.getByRole("heading", { level: 1 }).boundingBox();
  const badges = await providerBadges(page).boundingBox();
  if (title === null || badges === null) throw new Error("The title or the badges are not rendered.");
  const middle = badges.y + badges.height / 2;
  expect(middle).toBeGreaterThanOrEqual(title.y);
  expect(middle).toBeLessThanOrEqual(title.y + title.height);
  expect(badges.x).toBeGreaterThan(title.x + title.width);
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
      await newest.getByRole("link", { name: "Synthetic event 0", exact: true }).click();
      const inspector = page.getByRole("dialog", { name: "Event details" });
      const link = inspector.getByRole("link", { name: /View in Vercel/ });
      await expect(link).toHaveAttribute("href", "https://example.com/deployments/0");
      await expect(link).toHaveAttribute("rel", "noopener noreferrer");
      await inspector.getByRole("button", { name: "Close event" }).click();

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

  for (const width of [1280, 375, 320]) {
    ownerTest(`keeps timeline times aligned and day labels visible while scrolling at ${width}px`, async ({ page }) => {
      const workspace = await seedTimeline("Timeline spine");
      try {
        const longTitle = `Deployment ${"with-a-long-unbroken-name".repeat(8)}`;
        const { error } = await adminClient().from("activity_events")
          .update({ title: longTitle })
          .eq("workspace_id", workspace.id)
          .eq("dedupe_key", "e2e-timeline-1");
        if (error) throw new Error(`Updating the synthetic title failed (code ${error.code}).`);

        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(`/w/${workspace.slug}/timeline`);
        const region = page.getByRole("region", { name: "Events", exact: true });
        const day = region.getByRole("list", { name: "Monday, 2026-06-15", exact: true });
        const rows = day.getByRole("listitem");
        const time = rows.first().locator("time");
        await expect(time).toHaveAttribute("datetime", "2026-06-15T22:30:00.000Z");
        await expect(time).toHaveAttribute("title", "2026-06-15 23:30 BST");
        const title = page.getByRole("heading", { name: longTitle, exact: true });
        await expect(title).toBeVisible();
        const timeBox = await time.boundingBox();
        const nextTimeBox = await rows.nth(1).locator("time").boundingBox();
        const titleBox = await title.boundingBox();
        if (!timeBox || !nextTimeBox || !titleBox) throw new Error("Timeline content is not rendered.");
        expect(Math.abs(timeBox.x - nextTimeBox.x)).toBeLessThan(1);
        if (width >= 1024) {
          expect(timeBox.x + timeBox.width).toBeLessThan(titleBox.x);
        } else {
          expect(timeBox.y + timeBox.height).toBeLessThan(titleBox.y);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);

        // Scroll within a long day, then into the next one: the active label stays below the shell.
        const heading = region.getByRole("heading", { name: "Monday, 2026-06-15", exact: true });
        await rows.nth(5).evaluate((row) => row.scrollIntoView({ block: "start", behavior: "instant" }));
        const header = await page.getByRole("banner").boundingBox();
        const headingBox = await heading.boundingBox();
        if (!header || !headingBox) throw new Error("The sticky heading or shell is not rendered.");
        expect(headingBox.y).toBeGreaterThanOrEqual(header.y + header.height);
        expect(headingBox.y).toBeLessThan(header.y + header.height + 24);
        const nextDay = region.getByRole("list", { name: "Sunday, 2026-06-14", exact: true });
        await nextDay.getByRole("listitem").nth(3).evaluate((row) => row.scrollIntoView({ block: "start", behavior: "instant" }));
        const nextHeading = await region.getByRole("heading", { name: "Sunday, 2026-06-14", exact: true }).boundingBox();
        if (!nextHeading) throw new Error("The next day heading is not rendered.");
        expect(nextHeading.y).toBeGreaterThanOrEqual(header.y + header.height);
        expect(nextHeading.y).toBeLessThan(header.y + header.height + 24);

        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        const scan = await new AxeBuilder({ page }).analyze();
        expect(scan.violations).toEqual([]);
      } finally {
        await deleteTestWorkspace(workspace);
      }
    });
  }

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
      // The badge counts the matching events, not the connection's total.
      await expectProviderBadges(page, ["Show only Vercel: 6 events from 1 connection"]);
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
      await expect(providerBadges(page)).toHaveCount(0);

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

  // #319: the type filter used to read only the newest 1,000 events for its choices.
  ownerTest("offers an event type whose only event is older than the newest 1,000 events", async ({ page }) => {
    const workspace = await createTestWorkspace("Timeline rare type");
    try {
      const { connectionId, accountId } = await seedAccount(workspace, {
        provider: "vercel",
        connectionName: "Vercel e2e connection",
        externalId: "team_e2e",
        accountName: "Acme e2e team",
        kind: "team",
      });
      const recent = Array.from({ length: 1000 }, (_, index) => syntheticEvent(workspace, connectionId, accountId, index));
      const rare = {
        ...syntheticEvent(workspace, connectionId, accountId, 1000),
        type_id: "vercel.deployment.failed",
        title: "Rare failed deployment",
      };
      const { error } = await adminClient().from("activity_events").insert([...recent, rare]);
      if (error) throw new Error(`Seeding events failed (code ${error.code}).`);

      await page.goto(`/w/${workspace.slug}/timeline`);
      await openFilters(page);
      const types = page.getByRole("group", { name: "Event type" }).getByRole("checkbox");
      await expect(types).toHaveCount(2);
      // Sorted by type id, and "." sorts before "_".
      await expect(types.nth(0)).toHaveAccessibleName("Vercel: Deployment failed");
      await expect(types.nth(1)).toHaveAccessibleName("Vercel: Deployment ready");
      await types.nth(0).check();
      await page.getByRole("button", { name: "Apply filters" }).click();

      await expect(page).toHaveURL(/type=vercel\.deployment\.failed/);
      await expect(page.getByRole("status").filter({ hasText: "Showing 1 event" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Rare failed deployment", exact: true })).toBeVisible();
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

  // #322: a connection whose first sync has not run yet. The timeline says events are coming
  // instead of asking for a provider that is already connected.
  ownerTest("says events are on their way while the first sync runs, from the keyboard", async ({ page }) => {
    const workspace = await createTestWorkspace("Timeline first sync");
    try {
      await seedAccount(workspace, {
        provider: "vercel",
        connectionName: "Vercel first sync",
        externalId: "team_first_sync",
        accountName: "First sync team",
        kind: "team",
      });
      await page.goto(`/w/${workspace.slug}/timeline`);
      const empty = page.getByRole("region", { name: "Events are on their way" });
      await expect(empty).toContainText("The first sync is queued or running.");
      await expect(page.getByRole("heading", { name: "No activity yet" })).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Connect a provider" })).toHaveCount(0);
      const status = empty.getByRole("link", { name: "Check connection status" });
      await expect(status).toHaveAttribute("href", `/w/${workspace.slug}/connections`);

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      await status.focus();
      await expect(status).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`/w/${workspace.slug}/connections`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connections");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("says nothing has been reported once every connection has synced", async ({ page }) => {
    const workspace = await createTestWorkspace("Timeline synced quiet");
    try {
      const { connectionId } = await seedAccount(workspace, {
        provider: "vercel",
        connectionName: "Vercel synced",
        externalId: "team_synced",
        accountName: "Synced team",
        kind: "team",
      });
      const { error } = await adminClient()
        .from("connections")
        .update({ last_synced_at: new Date().toISOString() })
        .eq("id", connectionId);
      if (error) throw new Error(`Marking the connection synced failed (code ${error.code}).`);

      await page.goto(`/w/${workspace.slug}/timeline`);
      const empty = page.getByRole("region", { name: "No activity yet" });
      await expect(empty).toContainText("Your connected providers have not reported any events yet.");
      await expect(empty.getByRole("link", { name: "Check connections" })).toHaveAttribute(
        "href",
        `/w/${workspace.slug}/connections`,
      );
      await expect(page.getByRole("link", { name: "Connect a provider" })).toHaveCount(0);
      await expect(page.getByRole("heading", { name: "Events are on their way" })).toHaveCount(0);

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
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

  // Viewers cannot connect providers, but they can read the Connections page, so the control stays.
  viewerTest("offers the connection status link while the first sync runs, with no role reason", async ({ page }) => {
    const workspace = await createTestWorkspace("Timeline first sync viewer");
    try {
      await seedAccount(workspace, {
        provider: "vercel",
        connectionName: "Vercel first sync",
        externalId: "team_first_sync_viewer",
        accountName: "First sync team",
        kind: "team",
      });
      await page.goto(`/w/${workspace.slug}/timeline`);
      const empty = page.getByRole("region", { name: "Events are on their way" });
      await expect(empty.getByRole("link", { name: "Check connection status" })).toHaveAttribute(
        "href",
        `/w/${workspace.slug}/connections`,
      );
      await expect(empty.getByText("Only owners and admins can connect providers.")).toHaveCount(0);
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
  const { connectionId, accountId } = await seedAccount(workspace, {
    provider: "github",
    connectionName: "GitHub e2e connection",
    externalId: "org_e2e",
    accountName: "Acme e2e organization",
    kind: "organization",
    projectId: project.id,
  });
  const events: EventInsert[] = [0, 1, 2].map((index) => ({
    workspace_id: workspace.id,
    connection_id: connectionId,
    external_account_id: accountId,
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
      // Every page's events count, and the repeated event only once: 60, not the 50 on screen.
      await expectProviderBadges(page, [
        "Show only Vercel: 60 events from 1 connection",
        "Show only GitHub: 3 events from 1 connection",
      ]);
      await expectBadgesBesideTitle(page);
      const filters = page.getByRole("region", { name: "Filters", exact: true });
      // The bar starts closed, so the events lead the page.
      await expect(filters.getByRole("button", { name: "Apply filters" })).toBeHidden();

      await openFilters(page);
      await filters.getByRole("group", { name: "Provider" }).getByRole("checkbox", { name: "GitHub" }).check();
      await filters.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/[?&]provider=github(&|$)/);
      await expect(status).toHaveText("Showing 3 events for provider GitHub");
      await expect(eventItems(page)).toHaveCount(3);
      // The provider filter makes GitHub's badge the current view, linking back to every provider.
      await expectProviderBadges(page, ["Show every provider. Now showing only GitHub: 3 events from 1 connection"]);
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
      await expectProviderBadges(page, ["Show only Vercel: 60 events from 1 connection"]);

      // Paging keeps the filter.
      await page.getByRole("link", { name: "Load older events" }).click();
      await expect(status).toHaveText("Showing 10 older events for project Unassigned");
      // An older page counts the same events: the cursor narrows the list, not the badges.
      await expectProviderBadges(page, ["Show only Vercel: 60 events from 1 connection"]);

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

  ownerTest("groups connections by provider in the title badges, and filters by badge", async ({ page }) => {
    const workspace = await seedTimeline("Timeline provider badges");
    try {
      await seedGitHubProject(workspace);
      // A second Vercel connection with two events of its own.
      const admin = adminClient();
      const { data: connection, error: connectionError } = await admin
        .from("connections")
        .insert({
          workspace_id: workspace.id,
          provider: "vercel",
          status: "active",
          display_name: "Vercel second connection",
          poll_interval_seconds: 3600,
        })
        .select("id")
        .single();
      if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
      const { error: eventsError } = await admin.from("activity_events").insert(
        [0, 1].map((index) => ({
          workspace_id: workspace.id,
          connection_id: connection.id,
          provider: "vercel" as const,
          type_id: "vercel.deployment_ready",
          severity: "info" as const,
          title: `Second Vercel event ${index}`,
          occurred_at: new Date(NEWEST_MS - (100 + index) * HOUR_MS).toISOString(),
          dedupe_key: `e2e-timeline-second-vercel-${index}`,
        })),
      );
      if (eventsError) throw new Error(`Seeding events failed (code ${eventsError.code}).`);

      await page.goto(`/w/${workspace.slug}/timeline`);
      const status = page.getByRole("status").filter({ hasText: /^Showing/ });
      await expect(status).toHaveText("Showing 50 events");
      await expectProviderBadges(page, [
        "Show only Vercel: 62 events from 2 connections",
        "Show only GitHub: 3 events from 1 connection",
      ]);
      await expectBadgesBesideTitle(page);

      // A click shows only that provider.
      await providerBadges(page).getByRole("link", { name: /^Show only GitHub/ }).click();
      await expect(page).toHaveURL(/[?&]provider=github(&|$)/);
      await expect(status).toHaveText("Showing 3 events for provider GitHub");
      const current = providerBadges(page).getByRole("link");
      await expect(current).toHaveAttribute("aria-current", "page");

      // Keyboard only: the current badge links back to every provider.
      await current.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/timeline$`));
      await expect(status).toHaveText("Showing 50 events");

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("opens the form below a status that wraps, on a wide screen and on a phone", async ({ page }) => {
    const workspace = await seedTimeline("Timeline filters wrap");
    try {
      await seedGitHubProject(workspace);
      const filters = page.getByRole("region", { name: "Filters", exact: true });
      const status = filters.getByRole("status");

      // 1280 wide: every provider, project, and account ticked gives a status that wraps.
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openFilters(page);
      for (const group of ["Provider", "Project", "Account"]) await checkEvery(page, group);
      await filters.getByRole("button", { name: "Apply filters" }).click();
      await expect(status).toContainText("accounts ");
      await expectClosedFilterBarOneRow(page);
      await openFilters(page);
      await expectFormBelowWrappedStatus(page);

      // A phone: one filter is enough.
      await page.setViewportSize({ width: 375, height: 667 });
      await page.goto(`/w/${workspace.slug}/timeline?provider=vercel`);
      await expect(status).toHaveText("Showing 50 events for provider Vercel");
      await expectClosedFilterBarOneRow(page);
      await openFilters(page, "keyboard");
      await expectFormBelowWrappedStatus(page);

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

const SECOND_MS = 1000;
// Noon in London (summer time) on Monday 2026-06-15.
const BURST_MS = Date.UTC(2026, 5, 15, 11, 0);

/**
 * One Stripe account with, newest first: five payments 30 seconds apart, a refund, three more
 * payments, then two payments one minute apart either side of London midnight. Eleven events in
 * five rows: the two bursts, the refund that breaks them, and the midnight pair, one row a day.
 * Titles are the Stripe adapter's, each with its own amount (#261).
 */
async function seedBursts(label: string): Promise<TestWorkspace> {
  const workspace = await createTestWorkspace(label);
  const { connectionId, accountId } = await seedAccount(workspace, {
    provider: "stripe",
    connectionName: "Stripe e2e connection",
    externalId: "acct_e2e",
    accountName: "Acme e2e Stripe account",
    kind: "account",
  });

  const event = (key: string, occurredMs: number, fields: Pick<EventInsert, "type_id" | "severity" | "title">): EventInsert => ({
    workspace_id: workspace.id,
    connection_id: connectionId,
    external_account_id: accountId,
    provider: "stripe",
    occurred_at: new Date(occurredMs).toISOString(),
    dedupe_key: `e2e-burst-${key}`,
    ...fields,
  });
  const payment = (index: number, occurredMs: number) =>
    event(`payment-${index}`, occurredMs, {
      type_id: "stripe.charge.succeeded",
      severity: "success",
      title: `Payment succeeded: $${10 + index}.00`,
    });
  const { error } = await adminClient().from("activity_events").insert([
    ...[0, 1, 2, 3, 4].map((index) => payment(index, BURST_MS - index * 30 * SECOND_MS)),
    event("refund", BURST_MS - 150 * SECOND_MS, { type_id: "stripe.charge.refunded", severity: "info", title: "Payment refunded: $20.00" }),
    ...[5, 6, 7].map((index) => payment(index, BURST_MS - (180 + (index - 5) * 30) * SECOND_MS)),
    // 23:00:30 UTC on June 14 is 00:00:30 on June 15 in London; 22:59:30 UTC is still June 14.
    payment(8, Date.UTC(2026, 5, 14, 23, 0, 30)),
    payment(9, Date.UTC(2026, 5, 14, 22, 59, 30)),
  ]);
  if (error) throw new Error(`Seeding events failed (code ${error.code}).`);
  return workspace;
}

ownerTest.describe("timeline bursts and search", () => {
  for (const width of [1280, 375]) {
    ownerTest(`collapses a run of identical events into one row that opens to each event at ${width}px`, async ({ page }) => {
      const workspace = await seedBursts("Timeline bursts");
      try {
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(`/w/${workspace.slug}/timeline`);
        await expect(page.getByRole("status").filter({ hasText: /^Showing/ })).toHaveText("Showing 11 events");
        const rows = eventItems(page);
        await expect(rows).toHaveCount(5);

        // The first burst: one row named by the type Stripe's adapter declares, "Payment succeeded"
        // rather than its id's "Charge succeeded", since the amounts differ, with the count, account,
        // and latest time.
        const burst = rows.nth(0);
        await expect(burst.getByRole("heading", { name: "Payment succeeded", exact: true })).toBeVisible();
        await expect(burst.getByText("5 events", { exact: true })).toBeVisible();
        await expect(burst).toContainText("Acme e2e Stripe account");
        // The first time is the row's own; each event inside the closed disclosure has one too.
        await expect(burst.locator("time").first()).toHaveAttribute("datetime", new Date(BURST_MS).toISOString());
        // The refund in between breaks the run, so the three payments after it are a run of their own.
        await expect(rows.nth(1).getByRole("heading", { name: "Payment refunded: $20.00", exact: true })).toBeVisible();
        await expect(rows.nth(2).getByText("3 events", { exact: true })).toBeVisible();
        // One minute apart, but either side of London midnight: one row under each day.
        const region = page.getByRole("region", { name: "Events", exact: true });
        await expect(region.getByRole("heading", { level: 2 })).toHaveText(["Monday, 2026-06-15", "Sunday, 2026-06-14"]);
        await expect(rows.nth(3).getByRole("heading", { name: "Payment succeeded: $18.00", exact: true })).toBeVisible();
        const dayBefore = region.getByRole("list", { name: "Sunday, 2026-06-14", exact: true });
        await expect(dayBefore.getByRole("listitem")).toHaveCount(1);
        await expect(dayBefore.getByRole("heading", { name: "Payment succeeded: $19.00", exact: true })).toBeVisible();

        // The individual events stay closed until asked for. Keyboard only: focus and press Enter.
        const members = burst.getByRole("list", { name: "Payment succeeded: 5 events", exact: true });
        await expect(members).toBeHidden();
        await burst.locator("summary").focus();
        await page.keyboard.press("Enter");
        await expect(burst.getByText("Hide the 5 events", { exact: true })).toBeVisible();
        await expect(members.getByRole("heading", { level: 4 })).toHaveText(
          [10, 11, 12, 13, 14].map((amount) => `Payment succeeded: $${amount}.00`),
        );
        const memberLink = members.getByRole("link", { name: "Payment succeeded: $13.00", exact: true });
        await memberLink.focus();
        await page.keyboard.press("Enter");
        const inspector = page.getByRole("dialog", { name: "Event details" });
        await expect(inspector.getByRole("heading", { name: "Payment succeeded: $13.00", exact: true })).toBeVisible();
        await expect(inspector).toContainText("This event has no additional details.");
        await expect(inspector.getByRole("link", { name: /View in/ })).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(memberLink).toBeFocused();
        await expect(members).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        const scan = await new AxeBuilder({ page }).analyze();
        expect(scan.violations).toEqual([]);

        await burst.locator("summary").focus();
        await page.keyboard.press("Enter");
        await expect(members).toBeHidden();
        await expect(burst.getByText("Show the 5 events", { exact: true })).toBeVisible();
      } finally {
        await deleteTestWorkspace(workspace);
      }
    });
  }

  ownerTest("searches event titles, narrowing the list and the badges together and across pages", async ({ page }) => {
    const workspace = await seedTimeline("Timeline search");
    try {
      await seedGitHubProject(workspace);
      await page.goto(`/w/${workspace.slug}/timeline`);
      const status = page.getByRole("status").filter({ hasText: /^Showing/ });
      await expect(status).toHaveText("Showing 50 events");

      // Keyboard only: open the filters, type a search in any case, and submit with Enter.
      await openFilters(page, "keyboard");
      const search = page.getByRole("searchbox", { name: "Search event titles" });
      await search.focus();
      await page.keyboard.type("SYNTHETIC");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/[?&]q=SYNTHETIC(&|$)/);
      await expect(status).toHaveText("Showing 50 events with “SYNTHETIC” in the title");
      await expect(page.getByRole("heading", { name: "GitHub release 0", exact: true })).toHaveCount(0);
      // The badges count the same matches across every page: the GitHub releases drop out.
      await expectProviderBadges(page, ["Show only Vercel: 60 events from 1 connection"]);

      // Paging keeps the search.
      await page.getByRole("link", { name: "Load older events" }).click();
      await expect(page).toHaveURL(/[?&]q=SYNTHETIC(&|$)/);
      await expect(status).toHaveText("Showing 10 older events with “SYNTHETIC” in the title");
      await expect(eventHeading(page, 59)).toBeVisible();
      await expectProviderBadges(page, ["Show only Vercel: 60 events from 1 connection"]);
      await openFilters(page);
      await expect(search).toHaveValue("SYNTHETIC");

      // A narrower search: "event 5" is in events 5 and 50 to 59.
      await page.goto(`/w/${workspace.slug}/timeline?q=event+5`);
      await expect(status).toHaveText("Showing 11 events with “event 5” in the title");
      await expect(eventItems(page)).toHaveCount(11);
      await expectProviderBadges(page, ["Show only Vercel: 11 events from 1 connection"]);
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      // The search is literal: a dot is a dot, not any character.
      await page.goto(`/w/${workspace.slug}/timeline?q=event.5`);
      await expect(page.getByRole("heading", { name: "No events match these filters" })).toBeVisible();
      await expect(providerBadges(page)).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

const inspectorEvidenceTest = ownerTest.extend({ video: process.env.PW_PR_EVIDENCE === "1" ? "on" : "off" });

ownerTest.describe("timeline event inspector", () => {
  for (const width of [1280, 375]) {
    inspectorEvidenceTest(`opens, shares, navigates, and restores the timeline from the keyboard at ${width}px`, async ({ page, context }) => {
      const workspace = await seedTimeline("Event inspector");
      try {
        await context.grantPermissions(["clipboard-read", "clipboard-write"]);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(`/w/${workspace.slug}/timeline`);
        const trigger = page.getByRole("link", { name: "Synthetic event 0", exact: true });
        const href = await trigger.getAttribute("href");
        if (href === null) throw new Error("The event has no shareable link.");
        await trigger.focus();
        const scrollBefore = await page.evaluate(() => window.scrollY);
        await page.keyboard.press("Enter");

        const inspector = page.getByRole("dialog", { name: "Event details" });
        const close = inspector.getByRole("button", { name: "Close event" });
        await expect(inspector).toBeVisible();
        await expect(close).toBeFocused();
        await expect(inspector.getByRole("heading", { name: "Synthetic event 0", exact: true })).toBeVisible();
        await expect(inspector).toContainText("Synthetic body 0");
        await expect(inspector).toContainText("2026-06-16 00:30 BST");
        await expect(inspector.locator("time")).toHaveAttribute("datetime", /^2026-06-15T23:30:00/);
        const source = inspector.getByRole("link", { name: /View in Vercel/ });
        await expect(source).toHaveAttribute("href", "https://example.com/deployments/0");
        await expect(source).toHaveAttribute("rel", "noopener noreferrer");
        await expect(page).toHaveURL(new RegExp(`event=${new URL(href, page.url()).searchParams.get("event")}$`));

        const box = await inspector.boundingBox();
        if (box === null) throw new Error("The inspector is not rendered.");
        expect(box.y).toBe(0);
        expect(box.height).toBe(900);
        expect(Math.round(box.x + box.width)).toBe(width);
        if (width < 640) expect(box.width).toBe(width);
        else expect(box.width).toBeLessThan(width / 2);
        expect(await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        if (process.env.PW_PR_EVIDENCE === "1") {
          await page.screenshot({ path: `pr-evidence/after/inspector-${width}.png`, animations: "disabled" });
        }

        // Both ends of the modal tab order stay in the inspector.
        await page.keyboard.press("Shift+Tab");
        await expect(inspector.getByRole("button", { name: "Older event" })).toBeFocused();
        await page.keyboard.press("Tab");
        await expect(close).toBeFocused();
        await inspector.getByRole("button", { name: "Copy event link" }).focus();
        await page.keyboard.press("Enter");
        await expect(inspector.getByRole("status").filter({ hasText: "Copied the event link." })).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL(href, page.url()).href);

        await inspector.getByRole("button", { name: "Older event" }).focus();
        await page.keyboard.press("Enter");
        await expect(inspector.getByRole("heading", { name: "Synthetic event 1", exact: true })).toBeVisible();
        await inspector.getByRole("button", { name: "Newer event" }).focus();
        await page.keyboard.press("Enter");
        await expect(inspector.getByRole("heading", { name: "Synthetic event 0", exact: true })).toBeVisible();

        await page.goBack();
        await expect(inspector).toBeHidden();
        await expect(trigger).toBeFocused();
        expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
        await page.goForward();
        await expect(inspector).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(inspector).toBeHidden();
        await expect(trigger).toBeFocused();
        await expect(page).toHaveURL(`/w/${workspace.slug}/timeline`);

        // Opening a scrolled row must not jump to the top on either open or close.
        const scrolled = page.getByRole("link", { name: "Synthetic event 15", exact: true });
        await scrolled.focus();
        const scrolledY = await page.evaluate(() => window.scrollY);
        expect(scrolledY).toBeGreaterThan(0);
        await page.keyboard.press("Enter");
        await expect(inspector.getByRole("heading", { name: "Synthetic event 15", exact: true })).toBeVisible();
        expect(await page.evaluate(() => window.scrollY)).toBe(scrolledY);
        await page.keyboard.press("Escape");
        await expect(scrolled).toBeFocused();
        expect(await page.evaluate(() => window.scrollY)).toBe(scrolledY);
      } finally {
        await deleteTestWorkspace(workspace);
      }
    });
  }

  ownerTest("opens a shared event outside the loaded page and filters, including after reload", async ({ page }) => {
    const workspace = await seedTimeline("Inspector shared link");
    try {
      const { data: event, error } = await adminClient().from("activity_events").select("id")
        .eq("workspace_id", workspace.id).eq("dedupe_key", "e2e-timeline-59").single();
      if (error) throw new Error(`Finding the synthetic event failed (code ${error.code}).`);
      await page.goto(`/w/${workspace.slug}/timeline?severity=critical&event=${event.id}`);
      const inspector = page.getByRole("dialog", { name: "Event details" });
      await expect(inspector.getByRole("heading", { name: "Synthetic event 59", exact: true })).toBeVisible();
      await expect(inspector).toContainText("Synthetic body 59");
      await expect(inspector.getByRole("button", { name: "Older event" })).toHaveAttribute("aria-disabled", "true");
      await page.reload();
      await expect(inspector.getByRole("heading", { name: "Synthetic event 59", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline?severity=critical`);
      await expect(page.getByRole("status").filter({ hasText: "Showing 6 events" })).toBeVisible();
      await expect(eventItems(page)).toHaveCount(6);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("does not expose an event from another workspace or a deleted event", async ({ page }) => {
    const workspace = await seedTimeline("Inspector private source");
    const other = await createTestWorkspace("Inspector empty target");
    try {
      const { data: event, error } = await adminClient().from("activity_events").select("id")
        .eq("workspace_id", workspace.id).eq("dedupe_key", "e2e-timeline-0").single();
      if (error) throw new Error(`Finding the synthetic event failed (code ${error.code}).`);
      await page.goto(`/w/${other.slug}/timeline?event=${event.id}`);
      const inspector = page.getByRole("dialog", { name: "Event details" });
      await expect(inspector.getByRole("heading", { name: "Event unavailable" })).toBeVisible();
      await expect(page.getByText("Synthetic body 0", { exact: true })).toHaveCount(0);
      await expect(inspector.getByRole("button", { name: "Copy event link" })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(page.getByRole("heading", { name: "No activity yet" })).toBeVisible();
      const { error: deleteError } = await adminClient().from("activity_events").delete()
        .eq("workspace_id", workspace.id).eq("id", event.id);
      if (deleteError) throw new Error(`Removing the synthetic event failed (code ${deleteError.code}).`);
      await page.goto(`/w/${workspace.slug}/timeline?event=${event.id}`);
      await expect(inspector.getByRole("heading", { name: "Event unavailable" })).toBeVisible();
      await page.keyboard.press("Escape");
      await page.goto(`/w/${workspace.slug}/timeline?event=not-a-uuid`);
      await expect(inspector).toBeHidden();
      await expect(page.getByRole("heading", { name: "Timeline", exact: true })).toBeVisible();
    } finally {
      await deleteTestWorkspace(other);
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("offers a selectable event link when clipboard access is denied", async ({ page }) => {
    const workspace = await seedTimeline("Inspector clipboard");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.reject(new DOMException("Permission denied", "NotAllowedError")) },
        });
      });
      await page.getByRole("link", { name: "Synthetic event 0", exact: true }).click();
      const inspector = page.getByRole("dialog", { name: "Event details" });
      await inspector.getByRole("button", { name: "Copy event link" }).click();
      await expect(inspector.getByRole("alert")).toContainText("Could not copy the event link.");
      const manual = inspector.getByRole("textbox", { name: "Event link", exact: true });
      await expect(manual).toHaveValue(page.url());
      await manual.focus();
      expect(await manual.evaluate((input: HTMLInputElement) => input.selectionEnd === input.value.length && input.selectionStart === 0)).toBe(true);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
