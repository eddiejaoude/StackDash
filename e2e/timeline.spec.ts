import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import type { Database } from "../src/lib/supabase/database.types";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { checkEvery, expectClosedFilterBarOneRow, expectFormBelowWrappedStatus, openFilters } from "./fixtures/filters";
import { tabTo } from "./fixtures/keyboard";

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
      await expect(page.getByRole("status").filter({ hasText: "Showing 50 of 60 events" })).toBeVisible();
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
      await expect(page.getByRole("status").filter({ hasText: "Showing 10 older events of 60" })).toBeVisible();
      await expect(eventItems(page)).toHaveCount(10);
      await expect(eventHeading(page, 50)).toBeVisible();
      await expect(eventHeading(page, 59)).toBeVisible();
      await expect(eventHeading(page, 49)).toHaveCount(0);
      await expect(page.getByRole("link", { name: "Load older events" })).toHaveCount(0);

      await page.getByRole("link", { name: "Show newest events" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Showing 50 of 60 events" })).toBeVisible();
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
        // #385: the gutter shows hours and minutes; the time's accessible text keeps the date and zone.
        await expect(time.locator('[aria-hidden="true"]')).toHaveText("23:30");
        await expect(time).toContainText("2026-06-15 23:30 BST");
        // "London time" is said once for the feed, not under every day heading.
        await expect(region.getByText("London time")).toHaveCount(1);
        await expect(region.getByText("London time")).toBeVisible();
        // An info row prints no pill; its word is screen-reader text, which is clipped to 1px.
        // A critical row keeps its visible pill.
        const infoWord = rows.first().getByText("Event", { exact: true });
        await expect(infoWord).toHaveCount(1);
        expect((await infoWord.boundingBox())?.width).toBeLessThanOrEqual(1);
        const criticalPill = region.getByRole("list", { name: "Tuesday, 2026-06-16", exact: true }).getByText("Critical", { exact: true });
        await expect(criticalPill).toBeVisible();
        expect((await criticalPill.boundingBox())?.width).toBeGreaterThan(1);
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
      await expect(page.getByRole("status").filter({ hasText: "Showing 6 of 6 events" })).toBeVisible();
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

      await expect(page.getByRole("status").filter({ hasText: "Showing 24 of 24 events" })).toBeVisible();
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
      await expect(page.getByRole("status").filter({ hasText: "Showing 50 of 60 events" })).toBeVisible();
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
      await expect(page.getByRole("status").filter({ hasText: "Showing 50 of 60 events" })).toBeVisible();
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
      await expect(page.getByRole("status").filter({ hasText: "Showing 1 of 1 event" })).toBeVisible();
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
      await expect(page.getByRole("status").filter({ hasText: "Showing 50 of 60 events" })).toBeVisible();
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

/** When `seedGitHubProject`'s releases happened: 23:00, 22:00, and 21:00 UTC on June 15. */
const GITHUB_RELEASE_MS = [0, 1, 2].map((index) => NEWEST_MS - (index * 2 + 1) * (HOUR_MS / 2));

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
  const events: EventInsert[] = GITHUB_RELEASE_MS.map((occurredMs, index) => ({
    workspace_id: workspace.id,
    connection_id: connectionId,
    external_account_id: accountId,
    provider: "github",
    type_id: "github.release_published",
    severity: "info",
    title: `GitHub release ${index}`,
    body: null,
    url: null,
    occurred_at: new Date(occurredMs).toISOString(),
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
      await expect(status).toHaveText("Showing 50 of 63 events");
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
      await expect(status).toHaveText("Showing 3 of 3 events for provider GitHub");
      await expect(eventItems(page)).toHaveCount(3);
      // The provider filter makes GitHub's badge the current view, linking back to every provider.
      await expectProviderBadges(page, ["Show every provider. Now showing only GitHub: 3 events from 1 connection"]);
      await expect(page.getByRole("heading", { name: "GitHub release 0", exact: true })).toBeVisible();
      await expect(eventHeading(page, 0)).toHaveCount(0);

      await openFilters(page);
      await filters.getByRole("link", { name: "Clear filters" }).click();
      await expect(status).toHaveText("Showing 50 of 63 events");

      // Keyboard only: open the filters, tick the Unassigned project, and submit with Enter.
      await openFilters(page, "keyboard");
      const unassigned = filters.getByRole("group", { name: "Project" }).getByRole("checkbox", { name: "Unassigned" });
      await unassigned.focus();
      await page.keyboard.press("Space");
      await filters.getByRole("button", { name: "Apply filters" }).focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/[?&]project=unassigned(&|$)/);
      await expect(status).toHaveText("Showing 50 of 60 events for project Unassigned");
      await expect(page.getByRole("heading", { name: "GitHub release 0", exact: true })).toHaveCount(0);
      await expect(eventHeading(page, 0)).toBeVisible();
      await expectProviderBadges(page, ["Show only Vercel: 60 events from 1 connection"]);

      // Paging keeps the filter.
      await page.getByRole("link", { name: "Load older events" }).click();
      await expect(status).toHaveText("Showing 10 older events of 60 for project Unassigned");
      // An older page counts the same events: the cursor narrows the list, not the badges.
      await expectProviderBadges(page, ["Show only Vercel: 60 events from 1 connection"]);

      await page.goto(`/w/${workspace.slug}/timeline`);
      await openFilters(page);
      await filters.getByRole("group", { name: "Project" }).getByRole("checkbox", { name: "Checkout" }).check();
      await filters.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/[?&]project=[0-9a-f-]{36}(&|$)/);
      await expect(status).toHaveText("Showing 3 of 3 events for project Checkout");
      await expect(eventItems(page)).toHaveCount(3);

      // The filtered view is bookmarkable: reloading the URL shows the same result.
      await page.reload();
      await expect(status).toHaveText("Showing 3 of 3 events for project Checkout");

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
      await expect(status).toHaveText("Showing 50 of 65 events");
      await expectProviderBadges(page, [
        "Show only Vercel: 62 events from 2 connections",
        "Show only GitHub: 3 events from 1 connection",
      ]);
      await expectBadgesBesideTitle(page);
      // Each chip prints its provider and event count without a hover; the connection count is in
      // the name only.
      const chips = providerBadges(page).getByRole("listitem");
      for (const [index, [name, count]] of ([["Vercel", "62"], ["GitHub", "3"]] as const).entries()) {
        await expect(chips.nth(index).getByText(name, { exact: true })).toBeVisible();
        await expect(chips.nth(index).getByText(count, { exact: true })).toBeVisible();
      }

      // A click shows only that provider.
      await providerBadges(page).getByRole("link", { name: /^Show only GitHub/ }).click();
      await expect(page).toHaveURL(/[?&]provider=github(&|$)/);
      await expect(status).toHaveText("Showing 3 of 3 events for provider GitHub");
      const current = providerBadges(page).getByRole("link");
      await expect(current).toHaveAttribute("aria-current", "page");

      // Keyboard only: the current badge links back to every provider.
      await current.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/timeline$`));
      await expect(status).toHaveText("Showing 50 of 65 events");

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("wraps ten provider chips, each with its name and count, without overflowing", async ({ page }) => {
    const workspace = await createTestWorkspace("Timeline ten providers");
    try {
      const providers = [
        ["vercel", "Vercel"],
        ["github", "GitHub"],
        ["resend", "Resend"],
        ["stripe", "Stripe"],
        ["supabase", "Supabase"],
        ["digitalocean", "DigitalOcean"],
        ["posthog", "PostHog"],
        ["polar", "Polar"],
        ["sentry", "Sentry"],
        ["railway", "Railway"],
      ] as const;
      const events: EventInsert[] = [];
      // Ten events for the first provider down to one for the last, so the order is fixed.
      for (const [index, [provider]] of providers.entries()) {
        const { connectionId, accountId } = await seedAccount(workspace, {
          provider,
          connectionName: `${provider} e2e connection`,
          externalId: `e2e_${provider}`,
          accountName: `${provider} e2e account`,
          kind: "account",
        });
        for (let event = 0; event < providers.length - index; event += 1) {
          events.push({
            workspace_id: workspace.id,
            connection_id: connectionId,
            external_account_id: accountId,
            provider,
            type_id: `${provider}.e2e_event`,
            severity: "info",
            title: `${provider} event ${event}`,
            occurred_at: new Date(NEWEST_MS - (index * 10 + event) * HOUR_MS).toISOString(),
            dedupe_key: `e2e-ten-${provider}-${event}`,
          });
        }
      }
      const { error } = await adminClient().from("activity_events").insert(events);
      if (error) throw new Error(`Seeding events failed (code ${error.code}).`);

      for (const width of [1280, 375]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/w/${workspace.slug}/timeline`);
        await expect(page.getByRole("status").filter({ hasText: /^Showing/ })).toHaveText("Showing 50 of 55 events");
        const chips = providerBadges(page).getByRole("listitem");
        await expect(chips).toHaveCount(10);
        const tops = new Set<number>();
        for (const [index, chip] of (await chips.all()).entries()) {
          await expect(chip.getByText(String(providers.length - index), { exact: true })).toBeVisible();
          // The name is printed from `sm` up; on a phone the logo and the count remain.
          const name = chip.getByText(providers[index]?.[1] ?? "", { exact: true });
          if (width >= 640) await expect(name).toBeVisible();
          else await expect(name).toBeHidden();
          const box = await chip.boundingBox();
          if (box === null) throw new Error("A provider chip is not rendered.");
          expect(box.x + box.width).toBeLessThanOrEqual(width);
          tops.add(Math.round(box.y));
        }
        expect(tops.size, "the chips wrap onto more than one row").toBeGreaterThan(1);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      }
      await expect(providerBadges(page).getByRole("link").first()).toHaveAccessibleName(
        "Show only Vercel: 10 events from 1 connection",
      );
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
      await expect(status).toHaveText("Showing 50 of 60 events for provider Vercel");
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
        await expect(page.getByRole("status").filter({ hasText: /^Showing/ })).toHaveText("Showing 11 of 11 events");
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

  // #294: Stripe declares "Payment succeeded" for `stripe.charge.succeeded`; its id reads "Charge succeeded".
  ownerTest("names event types by their adapters' declared labels in the filter, its chips, and the details", async ({ page }) => {
    const workspace = await seedBursts("Timeline declared labels");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      // The details name the type as the collapsed run's heading does.
      const burst = eventItems(page).nth(0);
      await burst.getByRole("link", { name: "Payment succeeded", exact: true }).click();
      const inspector = page.getByRole("dialog", { name: "Event details" });
      await expect(inspector.getByRole("heading", { name: "Payment succeeded: $10.00", exact: true })).toBeVisible();
      await expect(inspector.getByRole("definition").first()).toHaveText("Payment succeeded");
      await page.keyboard.press("Escape");
      await expect(inspector).toBeHidden();

      await openFilters(page);
      const types = page.getByRole("group", { name: "Event type" }).getByRole("checkbox");
      await expect(types).toHaveCount(2);
      await expect(types.nth(0)).toHaveAccessibleName("Stripe: Payment refunded");
      await expect(types.nth(1)).toHaveAccessibleName("Stripe: Payment succeeded");
      await types.nth(1).check();
      await page.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/[?&]type=stripe\.charge\.succeeded(&|$)/);
      // The chip names the type exactly as the box that set it.
      const chips = activeFilterChips(page).getByRole("link");
      await expect(chips).toHaveCount(1);
      await expect(chips.first()).toHaveAccessibleName("Remove filter: event type Stripe: Payment succeeded");
      await expect(page.getByRole("status").filter({ hasText: /^Showing/ })).toHaveText("Showing 10 of 10 events");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("searches event titles from the visible search box, keeping every other filter and starting from the newest events", async ({ page }) => {
    const workspace = await seedTimeline("Timeline search");
    try {
      await seedGitHubProject(workspace);
      // Info only: 54 of the Vercel events and the 3 GitHub releases.
      await page.goto(`/w/${workspace.slug}/timeline?severity=info`);
      const status = page.getByRole("status").filter({ hasText: /^Showing/ });
      await expect(status).toHaveText("Showing 50 of 57 events");
      await page.getByRole("link", { name: "Load older events" }).click();
      await expect(status).toHaveText("Showing 7 older events of 57");
      await expect(page).toHaveURL(/[?&]cursor=/);

      // The one search box is in view with the filter form closed.
      const filters = page.getByRole("region", { name: "Filters", exact: true });
      await expect(filters.getByRole("button", { name: "Apply filters" })).toBeHidden();
      await expect(page.getByRole("searchbox")).toHaveCount(1);
      const search = page.getByRole("search").getByRole("searchbox", { name: "Search event titles" });
      await expect(search).toBeVisible();

      // Keyboard only: Tab to the box, type a search in any case, and submit with Enter.
      await page.getByRole("heading", { level: 1 }).focus();
      await tabTo(page, search, 20);
      await page.keyboard.type("SYNTHETIC");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/[?&]q=SYNTHETIC(&|$)/);
      // It keeps the severity and drops the older page's cursor.
      expect(new URL(page.url()).searchParams.getAll("severity")).toEqual(["info"]);
      expect(new URL(page.url()).searchParams.has("cursor")).toBe(false);
      await expect(status).toHaveText("Showing 50 of 54 events with “SYNTHETIC” in the title");
      await expect(eventHeading(page, 1)).toBeVisible();
      await expect(page.getByRole("heading", { name: "GitHub release 0", exact: true })).toHaveCount(0);
      // The badges count the same matches across every page: the GitHub releases drop out.
      await expectProviderBadges(page, ["Show only Vercel: 54 events from 1 connection"]);
      await expect(search).toHaveValue("SYNTHETIC");

      // Paging keeps the search.
      await page.getByRole("link", { name: "Load older events" }).click();
      await expect(page).toHaveURL(/[?&]q=SYNTHETIC(&|$)/);
      await expect(status).toHaveText("Showing 4 older events of 54 with “SYNTHETIC” in the title");
      await expect(eventHeading(page, 59)).toBeVisible();
      await expectProviderBadges(page, ["Show only Vercel: 54 events from 1 connection"]);

      // The collapsed form carries the search too, so applying other filters does not drop it.
      await openFilters(page);
      await filters.getByRole("checkbox", { name: "Critical" }).check();
      await filters.getByRole("button", { name: "Apply filters" }).click();
      await expect(page).toHaveURL(/[?&]severity=critical(&|$)/);
      expect(new URL(page.url()).searchParams.get("q")).toBe("SYNTHETIC");
      expect(new URL(page.url()).searchParams.getAll("severity").sort()).toEqual(["critical", "info"]);
      await expect(status).toHaveText("Showing 50 of 60 events with “SYNTHETIC” in the title");
      await expect(search).toHaveValue("SYNTHETIC");

      // A narrower search: "event 5" is in events 5 and 50 to 59.
      await page.goto(`/w/${workspace.slug}/timeline?q=event+5`);
      await expect(status).toHaveText("Showing 11 of 11 events with “event 5” in the title");
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

function activeFilterChips(page: Page) {
  return page.getByRole("list", { name: "Active filters", exact: true });
}

ownerTest.describe("timeline active filters", () => {
  ownerTest("names each active filter in a chip and removes only that one, from the keyboard", async ({ page }) => {
    const workspace = await seedTimeline("Timeline filter chips");
    try {
      await seedGitHubProject(workspace);
      const { data: account, error } = await adminClient().from("external_accounts").select("id")
        .eq("workspace_id", workspace.id).eq("external_id", "team_e2e").single();
      if (error) throw new Error(`Finding the synthetic account failed (code ${error.code}).`);

      // No filter: no chip row.
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(page.getByRole("status").filter({ hasText: /^Showing/ })).toHaveText("Showing 50 of 63 events");
      await expect(activeFilterChips(page)).toHaveCount(0);

      // One of every filter. Critical Vercel events on the London days June 13 to 15 are 10 to 50;
      // the hand-written period, 01:00 to 13:00 in London on June 15, holds only event 20. The period
      // is not one bar of the overview, so the status has no total to give.
      const params = new URLSearchParams([
        ["q", "Synthetic"],
        ["type", "vercel.deployment_ready"],
        ["severity", "critical"],
        ["from", "2026-06-13"],
        ["to", "2026-06-15"],
        ["start", "2026-06-15T00:00:00.000Z"],
        ["until", "2026-06-15T12:00:00.000Z"],
        ["provider", "vercel"],
        ["project", "unassigned"],
        ["account", account.id],
      ]);
      await page.goto(`/w/${workspace.slug}/timeline?${params}`);
      const status = page.getByRole("status").filter({ hasText: /^Showing/ });
      await expect(status).toHaveText(
        "Showing 1 event with “Synthetic” in the title for provider Vercel, project Unassigned, account Acme e2e team (Vercel e2e connection)",
      );
      // The filter form stays closed: every filter is named without opening it.
      await expect(page.getByRole("button", { name: "Apply filters" })).toBeHidden();
      const chips = activeFilterChips(page).getByRole("link");
      const names = [
        "Remove filter: search “Synthetic”",
        "Remove filter: event type Vercel: Deployment ready",
        "Remove filter: severity Critical",
        "Remove filter: from date 2026-06-13",
        "Remove filter: to date 2026-06-15",
        "Remove filter: period 2026-06-15 01:00 BST to before 2026-06-15 13:00 BST",
        "Remove filter: provider Vercel",
        "Remove filter: project Unassigned",
        "Remove filter: account Acme e2e team (Vercel e2e connection)",
      ];
      await expect(chips).toHaveCount(names.length);
      for (const [index, name] of names.entries()) await expect(chips.nth(index)).toHaveAccessibleName(name);
      await expect(chips.first()).toHaveText("Search “Synthetic”");

      // Keyboard only: removing the provider keeps every other filter.
      const provider = activeFilterChips(page).getByRole("link", { name: "Remove filter: provider Vercel", exact: true });
      await provider.focus();
      await page.keyboard.press("Enter");
      await expect(provider).toHaveCount(0);
      const kept = new URL(page.url()).searchParams;
      expect(kept.has("provider")).toBe(false);
      params.delete("provider");
      expect([...kept].sort()).toEqual([...params].sort());
      await expect(chips).toHaveCount(8);

      // Removing the period gives a total again: events 10 to 50 in the dated range.
      await activeFilterChips(page).getByRole("link", { name: /^Remove filter: period / }).click();
      await expect(status).toHaveText(
        "Showing 5 of 5 events with “Synthetic” in the title for project Unassigned, account Acme e2e team (Vercel e2e connection)",
      );
      expect(new URL(page.url()).searchParams.has("start")).toBe(false);
      expect(new URL(page.url()).searchParams.get("q")).toBe("Synthetic");

      // Removing the search empties the search box too.
      await activeFilterChips(page).getByRole("link", { name: "Remove filter: search “Synthetic”", exact: true }).click();
      await expect(page.getByRole("searchbox", { name: "Search event titles" })).toHaveValue("");
      await expect(chips).toHaveCount(6);

      // Removing the rest one by one ends with no chip row and the bare timeline.
      for (let remaining = 6; remaining > 0; remaining -= 1) {
        await expect(chips).toHaveCount(remaining);
        await chips.first().click();
      }
      await expect(activeFilterChips(page)).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/timeline$`));
      await expect(status).toHaveText("Showing 50 of 63 events");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  for (const width of [1280, 375, 320]) {
    ownerTest(`keeps the search, the severity links, and the chips usable at ${width}px`, async ({ page }) => {
      const workspace = await seedTimeline("Timeline toolbar fit");
      try {
        await seedGitHubProject(workspace);
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(`/w/${workspace.slug}/timeline?q=Synthetic&severity=critical&provider=vercel&from=2026-06-13`);
        await expect(page.getByRole("status").filter({ hasText: /^Showing/ })).toHaveText(
          "Showing 6 of 6 events with “Synthetic” in the title for provider Vercel",
        );
        const severity = page.getByRole("navigation", { name: "Severity" });
        const links = severity.getByRole("link");
        await expect(links).toHaveCount(5);
        const search = page.getByRole("searchbox", { name: "Search event titles" });
        await expect(search).toBeVisible();
        await expect(search).toHaveValue("Synthetic");
        const severityBox = await severity.boundingBox();
        const searchBox = await page.getByRole("search").boundingBox();
        if (severityBox === null || searchBox === null) throw new Error("The toolbar is not rendered.");
        // The five severity links stay on one row; below `sm` that row scrolls sideways.
        const tops = await links.evaluateAll((elements) => elements.map((element) => Math.round(element.getBoundingClientRect().top)));
        expect(new Set(tops).size).toBe(1);
        if (width >= 768) {
          // The search shares the severity links' row.
          expect(Math.abs(searchBox.y + searchBox.height / 2 - (severityBox.y + severityBox.height / 2))).toBeLessThan(2);
        } else {
          expect(searchBox.y).toBeGreaterThanOrEqual(severityBox.y + severityBox.height);
        }
        // The last severity link is reachable: scrolled into view when focused.
        await links.last().focus();
        await expect(links.last()).toBeInViewport();

        const chips = activeFilterChips(page).getByRole("link");
        await expect(chips).toHaveCount(4);
        for (const chip of await chips.all()) {
          const box = await chip.boundingBox();
          if (box === null) throw new Error("A chip is not rendered.");
          expect(box.height).toBeGreaterThanOrEqual(24);
          expect(box.width).toBeGreaterThanOrEqual(24);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
        const scan = await new AxeBuilder({ page }).analyze();
        expect(scan.violations).toEqual([]);
      } finally {
        await deleteTestWorkspace(workspace);
      }
    });
  }
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
        // The open event's row is marked in the feed, for sight as well as for assistive tech.
        const currentRow = page.locator('a[aria-haspopup="dialog"][aria-current="location"]');
        await expect(currentRow).toHaveText(["Synthetic event 0"]);
        const otherColor = await page.locator('a[aria-haspopup="dialog"]:not([aria-current])').first()
          .evaluate((element) => getComputedStyle(element).color);
        await expect(currentRow).not.toHaveCSS("color", otherColor);

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
        await expect(currentRow).toHaveText(["Synthetic event 1"]);
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
      // A shared link has no opener and its event is not on this page, so focus goes to the page's heading.
      await expect(page.getByRole("heading", { level: 1, name: "Timeline", exact: true })).toBeFocused();
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline?severity=critical`);
      await expect(page.getByRole("status").filter({ hasText: "Showing 6 of 6 events" })).toBeVisible();
      await expect(eventItems(page)).toHaveCount(6);

      // When the shared event is on the loaded page, focus returns to its row.
      const { data: onPage, error: onPageError } = await adminClient().from("activity_events").select("id")
        .eq("workspace_id", workspace.id).eq("dedupe_key", "e2e-timeline-10").single();
      if (onPageError) throw new Error(`Finding the synthetic event failed (code ${onPageError.code}).`);
      await page.goto(`/w/${workspace.slug}/timeline?severity=critical&event=${onPage.id}`);
      await expect(inspector.getByRole("heading", { name: "Synthetic event 10", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline?severity=critical`);
      await expect(page.getByRole("link", { name: "Synthetic event 10", exact: true })).toBeFocused();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  // #394: the details offer the timeline narrowed to the event's type, account, or time.
  ownerTest("links from the details to the timeline for the event's type, account, and time, and Back reopens them", async ({ page }) => {
    const workspace = await seedTimeline("Inspector filter links");
    try {
      await seedGitHubProject(workspace);
      const admin = adminClient();
      const { data: github, error: githubError } = await admin.from("external_accounts").select("id")
        .eq("workspace_id", workspace.id).eq("external_id", "org_e2e").single();
      if (githubError) throw new Error(`Finding the synthetic account failed (code ${githubError.code}).`);
      // DevMacro's own event: no connection and no account, and microseconds, as Postgres keeps them.
      const { data: summary, error: summaryError } = await admin.from("activity_events").insert({
        workspace_id: workspace.id,
        connection_id: null,
        external_account_id: null,
        provider: null,
        type_id: "devmacro.daily_summary",
        severity: "info",
        title: "Microsecond summary",
        occurred_at: "2026-06-15T12:00:00.123456Z",
        dedupe_key: "e2e-timeline-microsecond",
      }).select("id").single();
      if (summaryError) throw new Error(`Seeding the summary failed (code ${summaryError.code}).`);
      const { data: oldest, error: oldestError } = await admin.from("activity_events").select("id")
        .eq("workspace_id", workspace.id).eq("dedupe_key", "e2e-timeline-59").single();
      if (oldestError) throw new Error(`Finding the synthetic event failed (code ${oldestError.code}).`);

      const inspector = page.getByRole("dialog", { name: "Event details" });
      const related = inspector.getByRole("region", { name: "Related events" });
      const status = page.getByRole("status").filter({ hasText: /^Showing/ });

      // Keyboard only, from a filtered timeline: the type link drops the other filters.
      await page.goto(`/w/${workspace.slug}/connections`);
      await page.goto(`/w/${workspace.slug}/timeline?severity=critical`);
      const trigger = page.getByRole("link", { name: "Synthetic event 10", exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      await expect(inspector.getByRole("heading", { name: "Synthetic event 10", exact: true })).toBeVisible();
      await expect(related.getByRole("link")).toHaveText([
        "Show only this event type",
        "Show only this account",
        "Show events around this time",
      ]);
      const byType = related.getByRole("link", { name: "Show only this event type", exact: true });
      await tabTo(page, byType, 10);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline?type=vercel.deployment_ready`);
      await expect(inspector).toBeHidden();
      await expect(status).toHaveText("Showing 50 of 60 events");
      await expect(activeFilterChips(page).getByRole("link")).toHaveAccessibleName("Remove filter: event type Vercel: Deployment ready");

      // Back returns to the open details; closing them then adds no entry, so Back leaves the timeline.
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/timeline\\?severity=critical&event=`));
      await expect(inspector.getByRole("heading", { name: "Synthetic event 10", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(inspector).toBeHidden();
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline?severity=critical`);
      await page.goBack();
      await expect(page).toHaveURL(`/w/${workspace.slug}/connections`);

      // The account link narrows to that account alone.
      await page.goto(`/w/${workspace.slug}/timeline`);
      await page.getByRole("link", { name: "GitHub release 0", exact: true }).click();
      await related.getByRole("link", { name: "Show only this account", exact: true }).click();
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline?account=${github.id}`);
      await expect(inspector).toBeHidden();
      await expect(status).toHaveText("Showing 3 of 3 events for account Acme e2e organization (GitHub e2e connection)");

      // An event with no account has no account link, and its window keeps it despite microseconds:
      // 11:00:00.123 to before 13:00:00.123 UTC holds it and events 11 and 12.
      await page.goto(`/w/${workspace.slug}/timeline?event=${summary.id}`);
      await expect(inspector.getByRole("heading", { name: "Microsecond summary", exact: true })).toBeVisible();
      await expect(related.getByRole("link")).toHaveText(["Show only this event type", "Show events around this time"]);
      await related.getByRole("link", { name: "Show events around this time", exact: true }).click();
      await expect(page).toHaveURL(
        `/w/${workspace.slug}/timeline?start=2026-06-15T11%3A00%3A00.123Z&until=2026-06-15T13%3A00%3A00.123Z`,
      );
      await expect(inspector).toBeHidden();
      await expect(eventItems(page)).toHaveCount(3);
      await expect(page.getByRole("heading", { name: "Microsecond summary", exact: true })).toBeVisible();
      await expect(activeFilterChips(page).getByRole("link")).toHaveAccessibleName(
        "Remove filter: period 2026-06-15 12:00 BST to before 2026-06-15 14:00 BST",
      );

      // A shared event outside the loaded page and the current filters: its links still show it.
      await page.goto(`/w/${workspace.slug}/timeline?severity=critical&event=${oldest.id}`);
      await expect(inspector.getByRole("heading", { name: "Synthetic event 59", exact: true })).toBeVisible();
      await related.getByRole("link", { name: "Show events around this time", exact: true }).click();
      await expect(inspector).toBeHidden();
      await expect(eventItems(page)).toHaveCount(1);
      await expect(eventHeading(page, 59)).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("keeps the details' related event links usable at every width", async ({ page }) => {
    const workspace = await seedTimeline("Inspector related widths");
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`/w/${workspace.slug}/timeline`);
      await page.getByRole("link", { name: "Synthetic event 0", exact: true }).click();
      const inspector = page.getByRole("dialog", { name: "Event details" });
      const links = inspector.getByRole("region", { name: "Related events" }).getByRole("link");
      await expect(links).toHaveCount(3);
      for (const width of [1280, 375, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const link of await links.all()) {
          const box = await link.boundingBox();
          if (box === null) throw new Error("A related event link is not rendered.");
          expect(box.height).toBeGreaterThanOrEqual(24);
          expect(box.width).toBeGreaterThanOrEqual(24);
        }
        expect(await inspector.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      }
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("shows a winter event in GMT as its row does, and closing leaves no extra Back entry", async ({ page }) => {
    const workspace = await createTestWorkspace("Inspector winter event");
    try {
      const { connectionId, accountId } = await seedAccount(workspace, {
        provider: "vercel",
        connectionName: "Vercel e2e connection",
        externalId: "team_e2e",
        accountName: "Acme e2e team",
        kind: "team",
      });
      // 11:59 UTC on November 12 is 11:59 in London, which is on Greenwich Mean Time in winter.
      const { error } = await adminClient().from("activity_events").insert({
        ...syntheticEvent(workspace, connectionId, accountId, 0),
        title: "Winter deployment",
        occurred_at: "2026-11-12T11:59:00.000Z",
        dedupe_key: "e2e-timeline-winter",
      });
      if (error) throw new Error(`Seeding the winter event failed (code ${error.code}).`);
      await page.goto(`/w/${workspace.slug}/connections`);
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(page.locator('time[title="2026-11-12 11:59 GMT"]')).toHaveCount(1);
      await page.getByRole("link", { name: "Winter deployment", exact: true }).click();

      // Written on the server like the row's time: a browser would name the zone "GMT+0".
      const inspector = page.getByRole("dialog", { name: "Event details" });
      await expect(inspector.getByText("2026-11-12 11:59 GMT", { exact: true })).toBeVisible();

      // Closing goes back to the entry opening pushed, so Back then leaves the timeline.
      await page.keyboard.press("Escape");
      await expect(inspector).toBeHidden();
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline`);
      await page.goBack();
      await expect(page).toHaveURL(`/w/${workspace.slug}/connections`);

      // A second activation can land before the dialog opens; it must not stack a second entry,
      // or closing would go back to the first and leave the selection in the URL. Two clicks in
      // one browser task always land before React renders, so the race is forced, not hoped for.
      await page.goto(`/w/${workspace.slug}/timeline`);
      await page.getByRole("link", { name: "Winter deployment", exact: true }).evaluate((link: HTMLElement) => {
        link.click();
        link.click();
      });
      await expect(inspector).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(inspector).toBeHidden();
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline`);
      await page.goBack();
      await expect(page).toHaveURL(`/w/${workspace.slug}/connections`);
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

// #377: the activity overview counts every matching event in at most 12 equal buckets.
const SEEDED_VERCEL_MS = Array.from({ length: EVENT_COUNT }, (_, index) => NEWEST_MS - index * HOUR_MS);
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MINUTE_MS = 60 * 1000;
const LONDON_MINUTE = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2} BST`;

function activityOverview(page: Page) {
  return page.getByRole("region", { name: "Activity overview", exact: true });
}

function bucketLinks(page: Page) {
  return activityOverview(page).getByRole("link", { name: /^Show [\d,]+ events? from / });
}

/** "1 event" or "60 events", the way the overview counts a bucket. */
function eventCount(count: number): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? "event" : "events"}`;
}

/** The count, London start, and exclusive end a bucket link names, as the page prints them. */
async function bucketPeriod(link: Locator): Promise<Readonly<{ count: string; from: string; until: string }>> {
  const name = await link.getAttribute("aria-label");
  const match = name?.match(new RegExp(`^Show ([\\d,]+ events?) from (${LONDON_MINUTE}) to before (${LONDON_MINUTE})$`));
  const count = match?.[1];
  const from = match?.[2];
  const until = match?.[3];
  if (count === undefined || from === undefined || until === undefined) throw new Error(`The bucket link names no period: ${name}`);
  return { count, from, until };
}

/** A bucket link, its position among the bucket links, and the half-open range its URL selects. */
type Bucket = Readonly<{ link: Locator; position: number; href: string; start: number; until: number }>;

/**
 * Reads every bucket link, oldest first. Each selects a canonical millisecond UTC `start` and an
 * exclusive `until`, and never carries the feed's cursor.
 */
async function readBuckets(page: Page): Promise<Bucket[]> {
  await expect(bucketLinks(page).first()).toBeVisible();
  const buckets: Bucket[] = [];
  for (const [position, link] of (await bucketLinks(page).all()).entries()) {
    const href = await link.getAttribute("href");
    if (href === null) throw new Error(`Bucket ${position} has no link.`);
    const params = new URL(href, page.url()).searchParams;
    const start = params.get("start");
    const until = params.get("until");
    if (start === null || until === null) throw new Error(`Bucket ${position} selects no time range: ${href}`);
    expect(start).toMatch(CANONICAL_INSTANT);
    expect(until).toMatch(CANONICAL_INSTANT);
    expect(params.has("cursor"), `bucket ${position} keeps the cursor`).toBe(false);
    buckets.push({ link, position, href, start: Date.parse(start), until: Date.parse(until) });
  }
  return buckets.sort((a, b) => a.start - b.start);
}

function countIn(times: readonly number[], bucket: Pick<Bucket, "start" | "until">): number {
  return times.filter((time) => time >= bucket.start && time < bucket.until).length;
}

/** The first and last items, failing when there are none. */
function firstAndLast<T>(items: readonly T[], what: string): readonly [T, T] {
  const first = items.at(0);
  const last = items.at(-1);
  if (first === undefined || last === undefined) throw new Error(`There are no ${what}.`);
  return [first, last];
}

/**
 * At most 12 contiguous buckets of one whole-minute width; only the last may be clipped. Each link
 * names how many of `times` its range holds, with London times and their zone.
 */
async function expectEvenBuckets(buckets: readonly Bucket[], times: readonly number[]): Promise<void> {
  expect(buckets.length).toBeLessThanOrEqual(12);
  const [first] = firstAndLast(buckets, "buckets");
  const width = first.until - first.start;
  expect(width).toBeGreaterThanOrEqual(MINUTE_MS);
  expect(width % MINUTE_MS).toBe(0);
  for (const [index, bucket] of buckets.entries()) {
    const next = buckets[index + 1];
    if (next === undefined) {
      expect(bucket.until).toBeGreaterThan(bucket.start);
      expect(bucket.until - bucket.start).toBeLessThanOrEqual(width);
    } else {
      expect(bucket.until - bucket.start).toBe(width);
      expect(next.start).toBe(bucket.until);
    }
    // The seeded week is summer, so London times carry British Summer Time.
    await expect(bucket.link).toHaveAccessibleName(new RegExp(`^Show ${eventCount(countIn(times, bucket))} from ${LONDON_MINUTE} to before ${LONDON_MINUTE}$`));
  }
}

/** The seeded Vercel event indexes, newest first, whose time falls in the bucket. */
function vercelIndexesIn(bucket: Pick<Bucket, "start" | "until">, keep: (index: number) => boolean = () => true): number[] {
  return SEEDED_VERCEL_MS.flatMap((time, index) => (time >= bucket.start && time < bucket.until && keep(index) ? [index] : []));
}

/** Exactly these seeded Vercel events are listed, and their neighbors outside the bucket are not. */
async function expectFeedHolds(page: Page, indexes: readonly number[], extra = 0): Promise<void> {
  await expect(eventItems(page)).toHaveCount(indexes.length + extra);
  for (const index of indexes) await expect(eventHeading(page, index)).toBeVisible();
  const [newest, oldest] = firstAndLast(indexes, "expected events");
  const outside = [newest - 1, oldest + 1].filter((index) => index >= 0 && index < EVENT_COUNT);
  for (const index of outside) await expect(eventHeading(page, index)).toHaveCount(0);
}

/**
 * Which bucket is current, and the selection's live region: mounted and empty with nothing
 * selected, and naming the selected period and its count otherwise, so a touch user, who cannot
 * hover a bar, still reads how many events it holds.
 */
async function expectSelected(page: Page, bucket: Bucket | null): Promise<void> {
  const selected = activityOverview(page).locator('[aria-current="true"]');
  const clear = activityOverview(page).getByRole("link", { name: "Clear time selection", exact: true });
  const status = activityOverview(page).getByRole("status");
  if (bucket === null) {
    await expect(selected).toHaveCount(0);
    await expect(clear).toHaveCount(0);
    await expect(status).toBeEmpty();
    return;
  }
  await expect(selected).toHaveCount(1);
  const link = bucketLinks(page).nth(bucket.position);
  await expect(link).toHaveAttribute("aria-current", "true");
  const { count, from, until } = await bucketPeriod(link);
  await expect(status).toHaveText(`Selected: ${count} from ${from} to before ${until}`);
  await expect(clear).toBeVisible();
}

/** The URL's filters, ignoring the time selection and the page. */
function filterParams(url: string): string[] {
  return [...new URL(url).searchParams.entries()]
    .filter(([key]) => !["start", "until", "cursor"].includes(key))
    .map(([key, value]) => `${key}=${value}`)
    .sort();
}

/**
 * The page never scrolls sideways and the overview region does not overflow (on a narrow screen
 * only its chart scrolls, inside the region); every bucket link and the clear link are at least
 * 24 by 24 pixels.
 */
async function expectOverviewFits(page: Page, width: number): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  const overview = activityOverview(page);
  expect(await overview.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const targets = [
    ...(await bucketLinks(page).all()),
    ...(await overview.getByRole("link", { name: "Clear time selection", exact: true }).all()),
  ];
  for (const [index, target] of targets.entries()) {
    const box = await target.boundingBox();
    if (box === null) throw new Error(`Overview link ${index} is not rendered.`);
    expect(box.width, `overview link ${index} width`).toBeGreaterThanOrEqual(24);
    expect(box.height, `overview link ${index} height`).toBeGreaterThanOrEqual(24);
  }
}

/** The count and period a bucket shows over the caption row while its link is hovered or has keyboard focus. */
function shownPeriod(page: Page, { count, from }: Readonly<{ count: string; from: string }>): Locator {
  return activityOverview(page).getByTestId("activity-period").filter({ has: page.getByText(`${count} from ${from}`, { exact: true }) });
}

/**
 * The period lies exactly over the caption row, so its opaque box hides the whole caption and never
 * grows over the chart, and neither overflows its own box.
 */
async function expectPeriodCoversCaption(page: Page, period: Locator, at: string): Promise<void> {
  const caption = activityOverview(page).getByTestId("activity-caption");
  await expect(period).toBeVisible();
  const periodBox = await period.boundingBox();
  const captionBox = await caption.boundingBox();
  if (periodBox === null || captionBox === null) throw new Error(`The period or the caption is not rendered at ${at}.`);
  for (const side of ["x", "y", "width", "height"] as const) {
    expect(periodBox[side], `period ${side} at ${at}`).toBeCloseTo(captionBox[side], 1);
  }
  for (const [name, box] of [["period", period], ["caption", caption]] as const) {
    expect(await box.evaluate((element) => element.scrollWidth <= element.clientWidth), `${name} overflows at ${at}`).toBe(true);
  }
}

const overviewEvidenceTest = ownerTest.extend({ video: process.env.PW_PR_EVIDENCE === "1" ? "on" : "off" });

ownerTest.describe("timeline activity overview", () => {
  ownerTest("counts all 60 matching events beyond the first page and stays the same while paging", async ({ page }) => {
    const workspace = await seedTimeline("Overview counts");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      const overview = activityOverview(page);
      await expect(overview.getByText("60 matching events across all pages", { exact: true })).toBeVisible();
      await expect(eventItems(page)).toHaveCount(50);
      const buckets = await readBuckets(page);
      await expectEvenBuckets(buckets, SEEDED_VERCEL_MS);
      // No dates chosen: the bounds are the oldest event's UTC hour and the hour after the newest.
      const oldest = NEWEST_MS - (EVENT_COUNT - 1) * HOUR_MS;
      const [firstBucket, lastBucket] = firstAndLast(buckets, "buckets");
      expect(firstBucket.start).toBe(oldest - (oldest % HOUR_MS));
      expect(lastBucket.until).toBe(NEWEST_MS - (NEWEST_MS % HOUR_MS) + HOUR_MS);
      await expectSelected(page, null);
      const hrefs = buckets.map((bucket) => bucket.href);

      await page.getByRole("link", { name: "Load older events" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Showing 10 older events of 60" })).toBeVisible();
      await expect(page).toHaveURL(/[?&]cursor=/);
      await expect(overview.getByText("60 matching events across all pages", { exact: true })).toBeVisible();
      expect((await readBuckets(page)).map((bucket) => bucket.href)).toEqual(hrefs);
      await expectSelected(page, null);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("selects a bucket from the keyboard, narrowing the feed and badges, across reload, Back, and Forward", async ({ page }) => {
    const workspace = await seedTimeline("Overview selection");
    try {
      await seedGitHubProject(workspace);
      const allTimes = [...SEEDED_VERCEL_MS, ...GITHUB_RELEASE_MS];
      await page.goto(`/w/${workspace.slug}/timeline`);
      const overview = activityOverview(page);
      await expect(overview.getByText("63 matching events across all pages", { exact: true })).toBeVisible();
      // Start on an older page: selecting a bucket must drop the cursor.
      await page.getByRole("link", { name: "Load older events" }).click();
      await expect(page).toHaveURL(/[?&]cursor=/);
      const buckets = await readBuckets(page);
      await expectEvenBuckets(buckets, allTimes);
      const [oldest, newest] = firstAndLast(buckets, "buckets");
      const oldestIndexes = vercelIndexesIn(oldest);
      const newestIndexes = vercelIndexesIn(newest);
      expect(oldestIndexes.length).toBeGreaterThan(0);
      expect(countIn(GITHUB_RELEASE_MS, oldest)).toBe(0);
      const newestReleases = countIn(GITHUB_RELEASE_MS, newest);
      expect(newestReleases).toBeGreaterThan(0);
      expect(newestIndexes.length).toBeGreaterThan(newestReleases);

      // Keyboard only: the oldest bucket shows exactly its events, on the first page. The
      // selection's live region is already mounted, so selecting only changes its text.
      const selection = overview.getByRole("status");
      await selection.evaluate((element) => {
        element.dataset.e2eMounted = "true";
      });
      await oldest.link.focus();
      await page.keyboard.press("Enter");
      const oldestUrl = new URL(oldest.href, page.url()).href;
      await expect(page).toHaveURL(oldestUrl);
      await expectFeedHolds(page, oldestIndexes);
      await expectSelected(page, oldest);
      await expect(selection).toHaveAttribute("data-e2e-mounted", "true");
      // The overview keeps its full context; the badges count only the selected range.
      await expect(overview.getByText("63 matching events across all pages", { exact: true })).toBeVisible();
      await expect(bucketLinks(page)).toHaveCount(buckets.length);
      await expectProviderBadges(page, [`Show only Vercel: ${oldestIndexes.length} events from 1 connection`]);

      await bucketLinks(page).nth(newest.position).click();
      const newestUrl = new URL(newest.href, page.url()).href;
      await expect(page).toHaveURL(newestUrl);
      await expectFeedHolds(page, newestIndexes, newestReleases);
      await expectSelected(page, newest);
      const newestBadges = [
        `Show only Vercel: ${newestIndexes.length} events from 1 connection`,
        `Show only GitHub: ${newestReleases} events from 1 connection`,
      ];
      await expectProviderBadges(page, newestBadges);

      // The selection is the URL: reload, Back, and Forward restore it.
      await page.reload();
      await expect(page).toHaveURL(newestUrl);
      await expectFeedHolds(page, newestIndexes, newestReleases);
      await expectSelected(page, newest);
      await expectProviderBadges(page, newestBadges);
      await page.goBack();
      await expect(page).toHaveURL(oldestUrl);
      await expectFeedHolds(page, oldestIndexes);
      await expectSelected(page, oldest);
      await expectProviderBadges(page, [`Show only Vercel: ${oldestIndexes.length} events from 1 connection`]);
      await page.goForward();
      await expect(page).toHaveURL(newestUrl);
      await expectSelected(page, newest);
      await page.goBack();
      await page.goBack();
      await expect(page).toHaveURL(/[?&]cursor=/);
      await expectSelected(page, null);
      await expect(overview.getByText("63 matching events across all pages", { exact: true })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("clears only the time selection, keeping the search, severity, provider, and date filters", async ({ page }) => {
    const workspace = await seedTimeline("Overview clear");
    try {
      // London June 13 to 15 holds events 1 to 59; the critical ones are 10, 20, 30, 40, and 50.
      await page.goto(`/w/${workspace.slug}/timeline?severity=critical&from=2026-06-13&to=2026-06-15&q=Synthetic&provider=vercel`);
      const filters = filterParams(page.url());
      const critical = (index: number) => index % 10 === 0 && index > 0;
      const overview = activityOverview(page);
      await expect(overview.getByText("5 matching events across all pages", { exact: true })).toBeVisible();
      await expect(eventItems(page)).toHaveCount(5);
      const buckets = await readBuckets(page);
      const criticalTimes = SEEDED_VERCEL_MS.filter((_, index) => critical(index));
      await expectEvenBuckets(buckets, criticalTimes);
      // Chosen dates are the bounds: London midnight June 13 to London midnight June 16, zero buckets included.
      const [firstBucket, lastBucket] = firstAndLast(buckets, "buckets");
      expect(firstBucket.start).toBe(Date.UTC(2026, 5, 12, 23));
      expect(lastBucket.until).toBe(Date.UTC(2026, 5, 15, 23));
      expect(buckets).toHaveLength(12);

      const busy = buckets.find((bucket) => countIn(criticalTimes, bucket) > 0);
      if (busy === undefined) throw new Error("No bucket holds a critical event.");
      await busy.link.click();
      await expect(page).toHaveURL(new URL(busy.href, page.url()).href);
      expect(filterParams(page.url())).toEqual(filters);
      await expectFeedHolds(page, vercelIndexesIn(busy, critical));
      await expectSelected(page, busy);
      await expect(overview.getByText("5 matching events across all pages", { exact: true })).toBeVisible();

      await overview.getByRole("link", { name: "Clear time selection", exact: true }).click();
      await expect(page).not.toHaveURL(/[?&](start|until)=/);
      expect(filterParams(page.url())).toEqual(filters);
      await expect(eventItems(page)).toHaveCount(5);
      for (const index of [10, 20, 30, 40, 50]) await expect(eventHeading(page, index)).toBeVisible();
      await expectSelected(page, null);
      await expect(overview.getByText("5 matching events across all pages", { exact: true })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("shows zero matching events, selects an empty period, and ignores an unordered time pair", async ({ page }) => {
    const workspace = await seedTimeline("Overview empty");
    try {
      const overview = activityOverview(page);

      // Nothing matches and no dates bound the overview: no buckets, and a way forward.
      await page.goto(`/w/${workspace.slug}/timeline?severity=success`);
      await expect(overview.getByText("0 matching events across all pages", { exact: true })).toBeVisible();
      await expect(overview).toContainText("No activity matches these filters. Change or clear the filters to see activity.");
      await expect(bucketLinks(page)).toHaveCount(0);

      // Chosen dates bound it: every bucket is an empty, selectable period.
      await page.goto(`/w/${workspace.slug}/timeline?severity=success&from=2026-06-15&to=2026-06-15`);
      await expect(overview.getByText("0 matching events across all pages", { exact: true })).toBeVisible();
      const buckets = await readBuckets(page);
      await expectEvenBuckets(buckets, []);
      expect(buckets).toHaveLength(12);
      const [quiet] = firstAndLast(buckets, "buckets");
      await quiet.link.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new URL(quiet.href, page.url()).href);
      await expect(page.getByRole("heading", { name: "No events match these filters" })).toBeVisible();
      await expectSelected(page, quiet);

      // A quiet period outside every bucket: the feed is empty, the overview keeps its context.
      await page.goto(`/w/${workspace.slug}/timeline?start=2020-01-01T00:00:00.000Z&until=2020-01-01T01:00:00.000Z`);
      await expect(page.getByRole("heading", { name: "No events match these filters" })).toBeVisible();
      await expect(overview.getByText("60 matching events across all pages", { exact: true })).toBeVisible();
      await expect(overview.locator('[aria-current="true"]')).toHaveCount(0);
      // No bar is selected, so there is no count to repeat, only the period.
      await expect(overview.getByRole("status")).toHaveText("Selected: 2020-01-01 00:00 GMT to before 2020-01-01 01:00 GMT");
      await overview.getByRole("link", { name: "Clear time selection", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/timeline$`));
      await expect(eventItems(page)).toHaveCount(50);

      // An unordered pair selects nothing.
      await page.goto(`/w/${workspace.slug}/timeline?start=2026-06-15T00:00:00.000Z&until=2026-06-14T00:00:00.000Z`);
      await expect(page.getByRole("status").filter({ hasText: "Showing 50 of 60 events" })).toBeVisible();
      await expectSelected(page, null);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("covers the caption row with a bar's period at every width, and shows a hovered bar's over a focused bar's", async ({ page }) => {
    const workspace = await seedTimeline("Overview period");
    try {
      // Three London days in 12 six-hour bars: on a phone the caption's whole days wrap to two
      // lines while a six-hour period would fit on one, unless both share one layout.
      await page.setViewportSize({ width: 375, height: 900 });
      await page.goto(`/w/${workspace.slug}/timeline?from=2026-06-13&to=2026-06-15`);
      const buckets = await readBuckets(page);
      expect(buckets).toHaveLength(12);
      const third = buckets.at(2);
      if (third === undefined) throw new Error("There is no third bucket.");
      const thirdPeriod = shownPeriod(page, await bucketPeriod(third.link));
      await expect(thirdPeriod).toBeHidden();
      await tabTo(page, third.link, 120);
      await expectPeriodCoversCaption(page, thirdPeriod, "375px");
      for (const width of [320, 640, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await expectPeriodCoversCaption(page, thirdPeriod, `${width}px`);
      }

      // With the newest bar focused, hovering the oldest shows the oldest bar's period on top.
      await page.setViewportSize({ width: 375, height: 900 });
      const [oldest, newest] = firstAndLast(buckets, "buckets");
      const newestPeriod = shownPeriod(page, await bucketPeriod(newest.link));
      const oldestPeriod = shownPeriod(page, await bucketPeriod(oldest.link));
      await tabTo(page, newest.link, 120);
      await expect(newestPeriod).toBeVisible();
      await expect(oldestPeriod).toBeHidden();
      await oldest.link.hover();
      await expect(newest.link).toBeFocused();
      await expect(newestPeriod).toBeVisible();
      await expectPeriodCoversCaption(page, oldestPeriod, "375px while hovered");
      // Periods let the pointer through, which hit testing skips, so let them take it just for this check.
      const periods = activityOverview(page).getByTestId("activity-period");
      await periods.evaluateAll((elements) => {
        for (const element of elements) if (element instanceof HTMLElement) element.style.pointerEvents = "auto";
      });
      const hoveredOnTop = await oldestPeriod.evaluate((element) => {
        const box = element.getBoundingClientRect();
        const topmost = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return topmost !== null && element.contains(topmost);
      });
      await periods.evaluateAll((elements) => {
        for (const element of elements) if (element instanceof HTMLElement) element.style.removeProperty("pointer-events");
      });
      expect(hoveredOnTop, "the hovered bar's period is the topmost element at its center").toBe(true);

      // Moving the pointer away leaves the focused bar's period.
      await page.mouse.move(0, 0);
      await expect(oldestPeriod).toBeHidden();
      await expect(newestPeriod).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  for (const width of [1280, 375, 320]) {
    overviewEvidenceTest(`fits the overview at ${width}px with 24px keyboard targets and no axe violations`, async ({ page }) => {
      // The same label, clock, and viewport as the baseline feed capture, so before and after compare.
      const workspace = await seedTimeline("Activity overview");
      try {
        await page.clock.setFixedTime(new Date("2026-11-12T12:00:00Z"));
        await page.setViewportSize({ width, height: 900 });
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.goto(`/w/${workspace.slug}/timeline`);
        const overview = activityOverview(page);
        await expect(overview.getByText("60 matching events across all pages", { exact: true })).toBeVisible();
        await expectOverviewFits(page, width);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        if (process.env.PW_PR_EVIDENCE === "1") {
          // Unselected, before any paging, scrolled to the top like the baseline.
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
          await page.screenshot({ path: `pr-evidence/after/overview-${width}.png`, animations: "disabled" });
        }

        // Tab to the newest bucket: the chart scrolls it into view, its count and period show in
        // the caption row, and Enter selects it.
        const buckets = await readBuckets(page);
        const [, newest] = firstAndLast(buckets, "buckets");
        const named = await bucketPeriod(newest.link);
        const { count, from, until } = named;
        // The period is the link's sibling, so the bar itself prints nothing at rest and the
        // link's name is all it says.
        await expect(newest.link).toHaveText("");
        const period = shownPeriod(page, named);
        const periodStart = period.getByText(`${count} from ${from}`, { exact: true });
        const periodEnd = period.getByText(`Before ${until}`, { exact: true });
        await expect(periodStart).toBeHidden();
        await expect(periodEnd).toBeHidden();
        await tabTo(page, newest.link, 120);
        const focused = await newest.link.boundingBox();
        if (focused === null) throw new Error("The focused bucket is not rendered.");
        expect(focused.x).toBeGreaterThanOrEqual(0);
        expect(focused.x + focused.width).toBeLessThanOrEqual(width);
        for (const shown of [periodStart, periodEnd]) {
          await expect(shown).toBeVisible();
          const box = await shown.boundingBox();
          if (box === null) throw new Error("The focused bucket's period is not rendered.");
          expect(box.x).toBeGreaterThanOrEqual(0);
          expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        await expectPeriodCoversCaption(page, period, `${width}px`);
        await expectOverviewFits(page, width);
        await page.keyboard.press("Enter");
        await expect(page).toHaveURL(new URL(newest.href, page.url()).href);
        await expectSelected(page, newest);
        await expectFeedHolds(page, vercelIndexesIn(newest));
        await expectOverviewFits(page, width);
        await expectNoAxeViolations(page);
        if (process.env.PW_PR_EVIDENCE === "1") {
          await overview.scrollIntoViewIfNeeded();
          await page.screenshot({ path: `pr-evidence/after/overview-selected-${width}.png`, animations: "disabled" });
        }
      } finally {
        await deleteTestWorkspace(workspace);
      }
    });
  }
});
