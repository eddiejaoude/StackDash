import AxeBuilder from "@axe-core/playwright";
import { test, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";

import { expect } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { tabTo } from "./fixtures/keyboard";
import { publishStars, seedProjectWithHistory, turnOnPage } from "./fixtures/public-pages";
import { anonymous, pngSize } from "./fixtures/share";

// Published achievements on public surfaces (#413): the public project page's Achievements
// section, the achievement badge and card, the share dialog, and unpublishing. Achievements are
// recorded and published through the same database functions the evaluator and the publish
// actions call, so this spec covers what strangers see, not how achievements are earned
// (e2e/achievements-earning.spec.ts). Each test creates its own workspace and seeds only inside it.

// The badge's own policy as served (next.config.ts): opened directly, it loads and runs nothing.
const BADGE_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

// What only members may see: the private title names the account seeded by
// seedProjectWithHistory ("example-org"), and the description carries an amount.
const PRIVATE_TITLE = "10 Vercel deployments recorded on example-org";
const PRIVATE_DESCRIPTION = "Earned when DevMacro records 10 successful Vercel deployments for example-org, worth $1,234.00.";

type SeededAchievement = Readonly<{
  achievement_id: string;
  provider: "vercel" | "github" | "posthog";
  title: string;
  public_title: string;
  description: string;
  earned_at: string;
  earned_precision: "instant" | "day";
  evidence: "crossed" | "at_least";
  threshold: number | null;
}>;

const DEPLOYMENTS: SeededAchievement = {
  achievement_id: "vercel.deployments.10",
  provider: "vercel",
  title: PRIVATE_TITLE,
  public_title: "10 Vercel deployments recorded",
  description: PRIVATE_DESCRIPTION,
  earned_at: "2026-10-20T09:15:00Z",
  earned_precision: "instant",
  evidence: "crossed",
  threshold: 10,
};

// "Recorded at least": the first stored reading was already past the threshold.
const LUCKY_SEVENS: SeededAchievement = {
  achievement_id: "github.stars.777",
  provider: "github",
  title: "Lucky sevens: 777 GitHub stars",
  public_title: "Lucky sevens: 777 GitHub stars",
  description: "Earned when DevMacro records 777 or more stars across the connected GitHub repositories.",
  earned_at: "2026-10-21T12:00:00Z",
  earned_precision: "instant",
  evidence: "at_least",
  threshold: 777,
};

// The same fact as the derived milestone "Reached 1,000 GitHub stars" the seeded history reveals.
const STARS_1000: SeededAchievement = {
  achievement_id: "github.stars.1000",
  provider: "github",
  title: "1,000 GitHub stars",
  public_title: "1,000 GitHub stars",
  description: "Earned when DevMacro records 1,000 or more stars across the connected GitHub repositories.",
  earned_at: "2026-10-22T18:30:00Z",
  earned_precision: "instant",
  evidence: "crossed",
  threshold: 1000,
};

// A daily total: a day, never a time.
const FIRST_SIGNUP: SeededAchievement = {
  achievement_id: "posthog.signups.first",
  provider: "posthog",
  title: "First PostHog signup recorded",
  public_title: "First PostHog signup recorded",
  description: "Earned when PostHog reports the first signup.",
  earned_at: "2026-10-23T00:00:00Z",
  earned_precision: "day",
  evidence: "crossed",
  threshold: 1,
};

// Earned, never published.
const PRIVATE_ONLY: SeededAchievement = {
  achievement_id: "vercel.deployments.first",
  provider: "vercel",
  title: "First Vercel deployment recorded",
  public_title: "First Vercel deployment recorded",
  description: "Earned when DevMacro records the first successful Vercel deployment.",
  earned_at: "2026-10-19T08:00:00Z",
  earned_precision: "instant",
  evidence: "crossed",
  threshold: 1,
};

const PUBLISHED = [DEPLOYMENTS, LUCKY_SEVENS, STARS_1000, FIRST_SIGNUP] as const;

type Seeded = Readonly<{ workspace: TestWorkspace; projectId: string; address: string }>;

/**
 * Acme web with its page on (GitHub stars published, so the page answers), every achievement
 * above earned, and all but PRIVATE_ONLY published, as the owner.
 */
async function seedPublishedAchievements(label: string): Promise<Seeded> {
  const workspace = await createTestWorkspace(label);
  const projectId = await seedProjectWithHistory(workspace);
  await publishStars(workspace, projectId);
  await turnOnPage(workspace, projectId, "acme-web", false);

  const all = [...PUBLISHED, PRIVATE_ONLY];
  const { data: earned, error } = await adminClient().rpc("record_project_achievements", {
    p_workspace_id: workspace.id,
    p_project_id: projectId,
    p_achievements: all,
  });
  if (error) throw new Error(`Recording achievements failed (code ${error.code}).`);
  expect([...(earned ?? [])].sort()).toEqual(all.map((achievement) => achievement.achievement_id).sort());
  for (const achievement of PUBLISHED) await setPublished(workspace, projectId, achievement.achievement_id, true);
  return { workspace, projectId, address: `/@${workspace.slug}/acme-web` };
}

/** Publishes or unpublishes one earned achievement as the owner, the way the publish actions do. */
async function setPublished(workspace: TestWorkspace, projectId: string, achievementId: string, published: boolean): Promise<void> {
  const args = { p_workspace_id: workspace.id, p_project_id: projectId, p_actor_id: workspace.ownerId, p_achievement_id: achievementId };
  const { data, error } = await adminClient().rpc(published ? "publish_achievement" : "unpublish_achievement", args);
  if (error) throw new Error(`Changing the publication failed (code ${error.code}).`);
  expect(data).toBe(published ? "published" : "unpublished");
}

/** A signed-out browser context, as a stranger reads the page. */
async function strangerContext(browser: Browser, baseURL: string | undefined, permissions: string[] = []): Promise<BrowserContext> {
  if (baseURL === undefined) throw new Error("baseURL is not configured");
  return browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, permissions });
}

/** The achievement badge as served, with `label` and `message` as the text of its two halves. */
async function expectBadge(api: APIRequestContext, path: string, label: string, message: string): Promise<string> {
  const response = await api.get(path);
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["content-type"]).toBe("image/svg+xml; charset=utf-8");
  expect(headers["cache-control"]).toBe("public, max-age=60, s-maxage=60");
  expect(headers["content-security-policy"]).toBe(BADGE_CSP);
  expect(headers["cross-origin-resource-policy"]).toBe("cross-origin");
  expect(headers["set-cookie"]).toBeUndefined();
  const svg = await response.text();
  expect([...svg.matchAll(/<text [^>]*>([^<]*)<\/text>/g)].map((match) => match[1])).toEqual([label, message]);
  return svg;
}

async function expectCard(api: APIRequestContext, path: string): Promise<void> {
  const response = await api.get(path);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
  expect(response.headers()["cache-control"]).toBe("public, max-age=60, s-maxage=60");
  expect(response.headers()["cross-origin-resource-policy"]).toBe("cross-origin");
  expect(response.headers()["set-cookie"]).toBeUndefined();
  expect(pngSize(await response.body())).toEqual({ width: 1200, height: 630 });
}

function expectNothingPrivate(text: string): void {
  expect(text).not.toContain(PRIVATE_TITLE);
  expect(text).not.toContain(PRIVATE_DESCRIPTION);
  expect(text).not.toContain("example-org");
  expect(text).not.toContain("1,234.00");
}

async function openPage(context: BrowserContext, address: string): Promise<Page> {
  const page = await context.newPage();
  const response = await page.goto(address);
  expect(response?.status()).toBe(200);
  return page;
}

test.describe("published achievements on public surfaces", () => {
  test("the project page lists only published achievements, oldest first, with their dates and nothing private", async ({ browser, baseURL }) => {
    const { workspace, address } = await seedPublishedAchievements("Achievements page");
    const context = await strangerContext(browser, baseURL);
    try {
      const page = await openPage(context, address);
      const section = page.getByRole("region", { name: "Achievements" });
      const items = section.getByRole("listitem");
      await expect(items.getByRole("heading", { level: 3 })).toHaveText([
        "10 Vercel deployments recorded",
        "Lucky sevens: 777 GitHub stars",
        "1,000 GitHub stars",
        "First PostHog signup recorded",
      ]);
      await expect(items.nth(0)).toContainText("Vercel achievement. Earned 2026-10-20 10:15 BST.");
      await expect(items.nth(1)).toContainText("GitHub achievement. Recorded at least 777 on 2026-10-21 13:00 BST.");
      await expect(items.nth(2)).toContainText("GitHub achievement. Earned 2026-10-22 19:30 BST.");
      // A daily total has a day and no time.
      await expect(items.nth(3)).toContainText("PostHog achievement. Earned 2026-10-23.");
      await expect(items.nth(3).locator("time")).toHaveAttribute("datetime", "2026-10-23");
      await expect(section).not.toContainText("First Vercel deployment recorded");

      // No fact twice: the published 1,000 star achievement replaces its derived milestone, and the
      // 100 star milestone, which no published achievement states, stays.
      const milestones = page.getByRole("region", { name: "Milestones" });
      await expect(milestones).toContainText("Reached 100 GitHub stars");
      await expect(milestones).not.toContainText("Reached 1,000 GitHub stars");

      expectNothingPrivate(await page.content());
      await expectNoAxeViolations(page);
    } finally {
      await context.close();
      await deleteTestWorkspace(workspace);
    }
  });

  test("the achievement badge and card show only published achievements, with a metric badge's headers", async ({ baseURL }) => {
    const { workspace, projectId } = await seedPublishedAchievements("Achievements badge");
    const api = await anonymous(baseURL);
    try {
      const svg = await expectBadge(api, `/badge/${projectId}/achievement-vercel.deployments.10.svg`, "Vercel", "10 Vercel deployments recorded");
      expect(svg).toContain("<title>Vercel achievement on DevMacro: 10 Vercel deployments recorded. Earned 2026-10-20 10:15 BST.</title>");
      expectNothingPrivate(svg);
      await expectCard(api, `/card/${projectId}/achievement-vercel.deployments.10.png`);

      // Earned but not published, never earned, and malformed all answer the same neutral badge.
      for (const path of [
        `/badge/${projectId}/achievement-vercel.deployments.first.svg`,
        `/badge/${projectId}/achievement-vercel.deployments.999.svg`,
        `/badge/${projectId}/achievement-Not%20an%20id.svg`,
        `/badge/not-a-uuid/achievement-vercel.deployments.10.svg`,
        `/badge/30000000-0000-4000-8000-000000000001/achievement-vercel.deployments.10.svg`,
      ]) {
        await test.step(path, async () => {
          const unpublished = await expectBadge(api, path, "DevMacro", "Unpublished");
          expect(unpublished).not.toContain("First Vercel deployment recorded");
        });
      }
      // The unpublished card is the neutral card, still a 1200 by 630 PNG with a 200.
      await expectCard(api, `/card/${projectId}/achievement-vercel.deployments.first.png`);
    } finally {
      await api.dispose();
      await deleteTestWorkspace(workspace);
    }
  });

  test("the share dialog offers the badge Markdown with a Copy button, from the keyboard", async ({ browser, baseURL }) => {
    const { workspace, projectId, address } = await seedPublishedAchievements("Achievements share");
    const context = await strangerContext(browser, baseURL, ["clipboard-read", "clipboard-write"]);
    try {
      const page = await openPage(context, address);
      const trigger = page.getByRole("button", { name: "Share 10 Vercel deployments recorded", exact: true });
      await tabTo(page, trigger, 60);
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Share 10 Vercel deployments recorded" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();

      const markdown = dialog.getByLabel("Badge Markdown for a README");
      const badgePath = `/badge/${projectId}/achievement-vercel.deployments.10.svg`;
      // The links use the public origin; the badge links to the project page, which is public.
      const snippet = await markdown.inputValue();
      const match = /^\[!\[10 Vercel deployments recorded\]\((https?:\/\/[^/]+)(\/badge\/[^)]+)\)\]\((https?:\/\/[^/]+)(\/[^)]+)\)$/.exec(snippet);
      expect(match?.[2]).toBe(badgePath);
      expect(match?.[3]).toBe(match?.[1]);
      expect(match?.[4]).toBe(address);
      await expect(dialog.getByLabel("Card URL")).toHaveValue(new RegExp(`/card/${projectId}/achievement-vercel\\.deployments\\.10\\.png$`));
      await expect(dialog.getByRole("img", { name: "Vercel achievement on DevMacro: 10 Vercel deployments recorded." })).toBeVisible();
      await expect(dialog.getByLabel("Alt text for the card")).toHaveValue(
        "DevMacro achievement card for Acme web. Vercel achievement: 10 Vercel deployments recorded.",
      );
      expect(await new AxeBuilder({ page }).include("dialog[open]").analyze().then((scan) => scan.violations)).toEqual([]);

      const copy = dialog.getByRole("button", { name: "Copy badge Markdown" });
      await tabTo(page, copy, 5);
      await page.keyboard.press("Enter");
      await expect(dialog.getByRole("status")).toHaveText("Copied the badge Markdown.");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(snippet);

      // Nothing is posted: Share to X is a link to a prefilled post the person still sends.
      const shareToX = dialog.getByRole("link", { name: "Share to X (opens in a new tab)" });
      const intent = new URL((await shareToX.getAttribute("href")) ?? "");
      expect(intent.origin + intent.pathname).toBe("https://x.com/intent/tweet");
      expect(intent.searchParams.get("text")).toBe("Achievement for Acme web: 10 Vercel deployments recorded. Earned from Vercel data on DevMacro.");

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    } finally {
      await context.close();
      await deleteTestWorkspace(workspace);
    }
  });

  test("unpublishing removes an achievement from the page and its badge and card, and brings back its milestone", async ({ browser, baseURL }) => {
    const { workspace, projectId, address } = await seedPublishedAchievements("Achievements unpublish");
    const context = await strangerContext(browser, baseURL);
    const api = await anonymous(baseURL);
    try {
      await setPublished(workspace, projectId, DEPLOYMENTS.achievement_id, false);
      await setPublished(workspace, projectId, STARS_1000.achievement_id, false);

      const page = await openPage(context, address);
      const section = page.getByRole("region", { name: "Achievements" });
      await expect(section.getByRole("heading", { level: 3 })).toHaveText(["Lucky sevens: 777 GitHub stars", "First PostHog signup recorded"]);
      // The milestone the 1,000 star achievement stood for is listed again, once.
      await expect(page.getByRole("region", { name: "Milestones" }).getByText("Reached 1,000 GitHub stars")).toHaveCount(1);
      await expectBadge(api, `/badge/${projectId}/achievement-vercel.deployments.10.svg`, "DevMacro", "Unpublished");
      await expectCard(api, `/card/${projectId}/achievement-vercel.deployments.10.png`);

      // With nothing published, the section is gone and the page still answers for its metric.
      await setPublished(workspace, projectId, LUCKY_SEVENS.achievement_id, false);
      await setPublished(workspace, projectId, FIRST_SIGNUP.achievement_id, false);
      await page.reload();
      await expect(page.getByRole("heading", { level: 1, name: "Acme web" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Achievements" })).toHaveCount(0);
      await expectNoAxeViolations(page);
    } finally {
      await api.dispose();
      await context.close();
      await deleteTestWorkspace(workspace);
    }
  });
});
