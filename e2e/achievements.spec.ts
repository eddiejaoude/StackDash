import type { Page } from "@playwright/test";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { openFilters } from "./fixtures/filters";
import { tabTo } from "./fixtures/keyboard";

/*
 * A project's earned achievements as members see them (#413): the private Achievements section,
 * publishing and unpublishing one at a time, and the "Achievement earned" timeline entry with the
 * action each role gets. Each test creates its own workspace and seeds achievements the way the
 * evaluator records them, through record_project_achievements(), which also writes the entries.
 */

type Seeded = Readonly<{
  achievement_id: string;
  provider: "vercel" | "github" | "posthog";
  title: string;
  public_title: string;
  description: string;
  earned_at: string;
  earned_precision: "instant" | "day";
  evidence: "crossed" | "at_least";
  threshold: number | null;
  simulated: boolean;
}>;

// On four different days, so no two entries join one timeline run. All in British Summer Time.
const ACHIEVEMENTS: readonly Seeded[] = [
  {
    achievement_id: "vercel.deployments.first",
    provider: "vercel",
    title: "First Vercel deployment recorded",
    public_title: "First Vercel deployment recorded",
    description: "The first deployment StackDash recorded.",
    earned_at: "2026-06-01T08:15:00Z",
    earned_precision: "instant",
    evidence: "crossed",
    threshold: null,
    simulated: false,
  },
  {
    achievement_id: "github.stars.1024",
    provider: "github",
    title: "Kilostar: 1,024 GitHub stars",
    public_title: "1,024 GitHub stars",
    description: "The first stored count of 1,024 stars or more.",
    earned_at: "2026-06-10T12:00:00Z",
    earned_precision: "instant",
    evidence: "at_least",
    threshold: 1024,
    simulated: false,
  },
  {
    achievement_id: "posthog.signups.100",
    provider: "posthog",
    title: "100 PostHog signups recorded",
    public_title: "100 PostHog signups recorded",
    description: "The day the daily signup totals StackDash stored reached 100.",
    // A daily total is stored at the start of its UTC day and shown as the day alone.
    earned_at: "2026-06-15T00:00:00Z",
    earned_precision: "day",
    evidence: "crossed",
    threshold: null,
    // Earned from a provider simulator's made-up data, so every surface says Simulated.
    simulated: true,
  },
  {
    achievement_id: "vercel.deployments.10",
    provider: "vercel",
    title: "10 Vercel deployments recorded",
    public_title: "10 Vercel deployments recorded",
    description: "The 10th deployment StackDash recorded.",
    earned_at: "2026-06-20T22:30:00Z",
    earned_precision: "instant",
    evidence: "crossed",
    threshold: null,
    simulated: false,
  },
];

async function seedProject(workspace: TestWorkspace, name = "Acme web"): Promise<string> {
  const { data, error } = await adminClient().from("projects").insert({ workspace_id: workspace.id, name }).select("id").single();
  if (error) throw new Error(`Seeding a project failed (code ${error.code}).`);
  return data.id;
}

/** A project that has earned every achievement in ACHIEVEMENTS. Returns the project id. */
async function seedAchievements(workspace: TestWorkspace): Promise<string> {
  const projectId = await seedProject(workspace);
  const { data, error } = await adminClient().rpc("record_project_achievements", {
    p_workspace_id: workspace.id,
    p_project_id: projectId,
    p_achievements: [...ACHIEVEMENTS],
  });
  if (error) throw new Error(`Recording achievements failed (code ${error.code}).`);
  expect(data).toHaveLength(ACHIEVEMENTS.length);
  return projectId;
}

async function publishAsOwner(workspace: TestWorkspace, projectId: string, achievementId: string): Promise<void> {
  const { data, error } = await adminClient().rpc("publish_achievement", {
    p_workspace_id: workspace.id,
    p_project_id: projectId,
    p_actor_id: workspace.ownerId,
    p_achievement_id: achievementId,
  });
  if (error) throw new Error(`Publishing an achievement failed (code ${error.code}).`);
  expect(data).toBe("published");
}

async function publicAchievementIds(projectId: string): Promise<string[]> {
  const { data, error } = await adminClient().rpc("public_published_achievements", { p_project_id: projectId });
  if (error) throw new Error(`Reading published achievements failed (code ${error.code}).`);
  return data.map((row) => row.achievement_id);
}

function achievementsPath(workspace: TestWorkspace, projectId: string): string {
  return `/w/${workspace.slug}/projects/${projectId}/achievements`;
}

function section(page: Page) {
  return page.getByRole("region", { name: "Achievements", exact: true });
}

function item(page: Page, achievementId: string) {
  return page.locator(`li[id="${achievementId}"]`);
}

function entry(page: Page, title: string) {
  return page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem").filter({
    has: page.getByRole("heading", { name: title, exact: true }),
  });
}

async function openEntry(page: Page, title: string) {
  await entry(page, title).getByRole("link", { name: title, exact: true }).click();
  const inspector = page.getByRole("dialog", { name: "Event details" });
  await expect(inspector.getByRole("heading", { name: title, exact: true })).toBeVisible();
  return inspector;
}

async function expectFocusVisible(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.activeElement?.matches(":focus-visible") ?? false)).toBe(true);
}

ownerTest.describe("achievements as the owner", () => {
  ownerTest("lists earned achievements by provider, oldest first, with dates and evidence", async ({ page }) => {
    const workspace = await createTestWorkspace("Achievements list");
    try {
      const projectId = await seedAchievements(workspace);
      await page.goto(`/w/${workspace.slug}/projects`);
      await page.getByRole("link", { name: "Achievements for Acme web" }).click();
      await expect(page).toHaveURL(achievementsPath(workspace, projectId));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Achievements for Acme web");

      // Providers by name, each a heading over its own oldest-first list.
      await expect(section(page).getByRole("heading", { level: 3 })).toHaveText(["GitHub", "PostHog", "Vercel"]);
      const vercel = section(page).getByRole("region", { name: "Vercel" }).getByRole("listitem");
      await expect(vercel).toHaveCount(2);
      await expect(vercel.nth(0)).toContainText("First Vercel deployment recorded");
      await expect(vercel.nth(1)).toContainText("10 Vercel deployments recorded");

      // An event is dated in London time, which can be the day after in UTC.
      await expect(item(page, "vercel.deployments.10")).toContainText("Earned 2026-06-20 23:30 BST");
      await expect(item(page, "vercel.deployments.10")).toContainText("The 10th deployment StackDash recorded.");
      await expect(item(page, "vercel.deployments.10").getByText("Simulated", { exact: true })).toHaveCount(0);
      // A daily total is dated to its day, never a time.
      const signups = item(page, "posthog.signups.100");
      await expect(signups.locator("time")).toHaveText("Earned 2026-06-15");
      await expect(signups.locator("time")).toHaveAttribute("datetime", "2026-06-15");
      // Earned from simulator data, so it says so in words.
      await expect(signups.getByText("Simulated", { exact: true })).toBeVisible();
      // A threshold StackDash first saw already passed says what it saw, in the public page's words,
      // never that it was earned then.
      const stars = item(page, "github.stars.1024");
      await expect(stars.locator("time")).toHaveText("Recorded at least 1,024 on 2026-06-10 13:00 BST");
      await expect(stars).not.toContainText("Earned");
      await expect(stars).toContainText("The first stored count of 1,024 stars or more.");
      await expect(stars).toContainText("Not published");
      await expect(stars).toContainText("Public title: 1,024 GitHub stars");
      await expect(stars.getByRole("button", { name: "Share 1,024 GitHub stars" })).toHaveCount(0);

      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("publishes and unpublishes an achievement with the keyboard alone", async ({ page }) => {
    const workspace = await createTestWorkspace("Achievements keyboard");
    try {
      const projectId = await seedAchievements(workspace);
      await page.goto(achievementsPath(workspace, projectId));
      const stars = item(page, "github.stars.1024");

      await page.getByRole("link", { name: "All projects" }).focus();
      const publish = stars.getByRole("button", { name: "Publish achievement Kilostar: 1,024 GitHub stars" });
      await tabTo(page, publish, 20);
      await expectFocusVisible(page);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status").filter({ hasText: "Published Kilostar: 1,024 GitHub stars." })).toBeVisible();
      // The button is replaced by Unpublish and Share; focus lands on the section heading.
      await expect(page.getByRole("heading", { name: "Achievements", exact: true })).toBeFocused();
      await expect(stars).toContainText("Published");
      await expect(stars.getByRole("button", { name: "Share 1,024 GitHub stars" })).toBeVisible();
      expect(await publicAchievementIds(projectId)).toEqual(["github.stars.1024"]);
      await expectNoAxeViolations(page);

      const unpublish = stars.getByRole("button", { name: "Unpublish achievement Kilostar: 1,024 GitHub stars" });
      await tabTo(page, unpublish, 20);
      await expectFocusVisible(page);
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("status").filter({ hasText: "Unpublished Kilostar: 1,024 GitHub stars. It is no longer public." }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Achievements", exact: true })).toBeFocused();
      await expect(stars).toContainText("Not published");
      await expect(stars.getByRole("button", { name: "Share 1,024 GitHub stars" })).toHaveCount(0);
      // Earned is permanent: unpublishing keeps it here and keeps its timeline entry.
      expect(await publicAchievementIds(projectId)).toEqual([]);
      const { count, error } = await adminClient()
        .from("activity_events")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace.id)
        .eq("type_id", "stackdash.achievement_earned");
      if (error) throw new Error(`Counting entries failed (code ${error.code}).`);
      expect(count).toBe(ACHIEVEMENTS.length);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("shows an entry with its label and link, and publishes from it", async ({ page }) => {
    const workspace = await createTestWorkspace("Achievements timeline");
    try {
      const projectId = await seedAchievements(workspace);
      await page.goto(`/w/${workspace.slug}/timeline`);

      // The label is words beside the private title, not part of it and not color alone. The row
      // names the provider that earned it, whose logo it shows, and its pill says Achievement.
      const row = entry(page, "10 Vercel deployments recorded");
      await expect(row).toContainText("Achievement earned");
      await expect(row.getByText("Vercel", { exact: true })).toBeVisible();
      await expect(row.getByText("Achievement", { exact: true })).toBeVisible();

      const inspector = await openEntry(page, "10 Vercel deployments recorded");
      // One gold label says what it is; no severity pill repeats it.
      await expect(inspector).toContainText("Achievement earned");
      await expect(inspector.getByText("Achievement", { exact: true })).toHaveCount(0);
      await expect(inspector.getByText("Success", { exact: true })).toHaveCount(0);
      await expect(inspector.getByRole("definition").first()).toHaveText("Achievement earned");
      await expect(inspector).toContainText("Acme web");
      await expect(inspector.getByRole("link", { name: "View in project achievements" })).toHaveAttribute(
        "href",
        `${achievementsPath(workspace, projectId)}#vercel.deployments.10`,
      );
      await expect(inspector).toContainText("Not published. Only members of this workspace can see it.");
      await expect(inspector.getByRole("button", { name: /^Share/ })).toHaveCount(0);
      await expectNoAxeViolations(page);

      await inspector.getByRole("button", { name: "Publish achievement 10 Vercel deployments recorded" }).click();
      await expect(inspector.getByRole("status").filter({ hasText: "Published 10 Vercel deployments recorded." })).toBeVisible();
      await expect(inspector.getByRole("heading", { name: "Publication" })).toBeFocused();
      await expect(inspector).toContainText("Published. Anyone can see it as 10 Vercel deployments recorded.");
      await expect(inspector.getByRole("button", { name: "Share 10 Vercel deployments recorded" })).toBeVisible();
      await expect(inspector.getByRole("button", { name: /^Publish achievement/ })).toHaveCount(0);
      expect(await publicAchievementIds(projectId)).toEqual(["vercel.deployments.10"]);

      // The link lands on the achievement's own item in the project's Achievements section.
      await inspector.getByRole("link", { name: "View in project achievements" }).click();
      await expect(page).toHaveURL(`${achievementsPath(workspace, projectId)}#vercel.deployments.10`);
      await expect(item(page, "vercel.deployments.10")).toContainText("Published");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("says Simulated on the entry of an achievement earned from simulator data", async ({ page }) => {
    const workspace = await createTestWorkspace("Achievements simulated entry");
    try {
      await seedAchievements(workspace);
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(entry(page, "100 PostHog signups recorded").getByText("Simulated", { exact: true })).toBeVisible();
      await expect(entry(page, "10 Vercel deployments recorded").getByText("Simulated", { exact: true })).toHaveCount(0);
      const inspector = await openEntry(page, "100 PostHog signups recorded");
      await expect(inspector.getByText("Simulated", { exact: true })).toBeVisible();
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("names the entry type in the type filter, so it can be filtered out", async ({ page }) => {
    const workspace = await createTestWorkspace("Achievements filter");
    try {
      await seedAchievements(workspace);
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openFilters(page);
      await expect(
        page.getByRole("group", { name: "Event type" }).getByRole("checkbox", { name: "StackDash: Achievement earned" }),
      ).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("explains where achievements come from when there are none", async ({ page }) => {
    const workspace = await createTestWorkspace("Achievements empty");
    try {
      const projectId = await seedProject(workspace);
      await page.goto(achievementsPath(workspace, projectId));
      await expect(page.getByRole("heading", { name: "No achievements yet" })).toBeVisible();
      await expect(page.getByText(/Achievements come from the connected provider accounts assigned to this project\./)).toBeVisible();
      const assign = page.getByRole("link", { name: "Assign provider accounts" });
      await expect(assign).toHaveAttribute("href", `/w/${workspace.slug}/connections`);
      await page.getByRole("link", { name: "All projects" }).focus();
      await tabTo(page, assign, 10);
      await expectFocusVisible(page);
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

viewerTest.describe("achievements as a viewer", () => {
  viewerTest("sees earned achievements and Share, and can neither publish nor unpublish", async ({ page }) => {
    const workspace = await createTestWorkspace("Achievements viewer");
    try {
      const projectId = await seedAchievements(workspace);
      await publishAsOwner(workspace, projectId, "vercel.deployments.10");
      await page.goto(achievementsPath(workspace, projectId));

      await expect(page.getByText("Only owners and admins can publish or unpublish achievements.")).toBeVisible();
      await expect(section(page).getByRole("listitem")).toHaveCount(ACHIEVEMENTS.length);
      await expect(item(page, "vercel.deployments.10")).toContainText("Published");
      await expect(item(page, "vercel.deployments.10").getByRole("button", { name: "Share 10 Vercel deployments recorded" })).toBeVisible();
      await expect(page.getByRole("button", { name: /^(Publish|Unpublish) achievement/ })).toHaveCount(0);
      await expectNoAxeViolations(page);

      // The database refuses a viewer too, whatever the page shows.
      const { error } = await adminClient().rpc("publish_achievement", {
        p_workspace_id: workspace.id,
        p_project_id: projectId,
        p_actor_id: workspace.viewerId,
        p_achievement_id: "github.stars.1024",
      });
      expect(error?.code).toBe("42501");
      expect(await publicAchievementIds(projectId)).toEqual(["vercel.deployments.10"]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  viewerTest("gets Share on a published entry and nothing on an unpublished one", async ({ page }) => {
    const workspace = await createTestWorkspace("Achievements viewer timeline");
    try {
      const projectId = await seedAchievements(workspace);
      await publishAsOwner(workspace, projectId, "vercel.deployments.10");
      await page.goto(`/w/${workspace.slug}/timeline`);

      await expect(entry(page, "Kilostar: 1,024 GitHub stars")).toContainText("Achievement earned");
      const unpublished = await openEntry(page, "Kilostar: 1,024 GitHub stars");
      await expect(unpublished).toContainText("Not published. Only members of this workspace can see it.");
      await expect(unpublished.getByRole("button", { name: /^(Share|Publish achievement)/ })).toHaveCount(0);
      await expect(unpublished.getByRole("link", { name: "View in project achievements" })).toBeVisible();
      await expectNoAxeViolations(page);
      await page.keyboard.press("Escape");
      await expect(unpublished).toBeHidden();

      const published = await openEntry(page, "10 Vercel deployments recorded");
      await expect(published.getByRole("button", { name: "Share 10 Vercel deployments recorded" })).toBeVisible();
      await expect(published.getByRole("button", { name: /^Publish achievement/ })).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  viewerTest("is told who can connect providers when the project has no achievements", async ({ page }) => {
    const workspace = await createTestWorkspace("Achievements viewer empty");
    try {
      const projectId = await seedProject(workspace);
      await page.goto(achievementsPath(workspace, projectId));
      await expect(page.getByRole("heading", { name: "No achievements yet" })).toBeVisible();
      await expect(page.getByText("Only owners and admins can connect providers.")).toBeVisible();
      await expect(page.getByRole("link", { name: "Assign provider accounts" })).toHaveCount(0);
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
