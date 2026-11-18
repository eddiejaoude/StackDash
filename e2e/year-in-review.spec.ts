import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, ownerTest } from "./fixtures/auth";
import { createTestWorkspace, deleteTestWorkspace, personalWorkspace } from "./fixtures/db";
import { anonymous, HISTORY_DAYS, pngSize, seedShareProject } from "./fixtures/share";

// The year in review (#151, slides #262): four slides of the workspace's year, walked by keyboard,
// each downloadable as a PNG of the same figure, members only. Each test creates its own workspace
// and seeds only inside it (seedShareProject: 36 days of synthetic events), so tests run in any order.

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Scans once every finite animation has finished: mid-entrance, a slide's text is still fading in,
 * which axe reads as low contrast. A looping one never finishes, such as the header's live dot.
 */
async function axeViolations(page: Page, selector?: string) {
  await page.evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
  const builder = new AxeBuilder({ page });
  return (await (selector === undefined ? builder : builder.include(selector)).analyze()).violations;
}

ownerTest.describe("year in review", () => {
  ownerTest("walks the slides by keyboard, downloads each as an image, shares the totals, and stays private", async ({ page, baseURL }, testInfo) => {
    const workspace = await createTestWorkspace("Year in review");
    const api = await anonymous(baseURL);
    const year = new Date().getUTCFullYear();
    // Every seeded event falls in this year unless the run is in its first weeks.
    const wholeHistoryThisYear = Date.now() - (HISTORY_DAYS + 1) * DAY_MS > Date.UTC(year, 0, 1);
    try {
      await seedShareProject(workspace);
      await page.setViewportSize({ width: 1280, height: 900 });

      await page.goto(`/w/${workspace.slug}/dashboard`);
      await page.getByRole("link", { name: `Your ${year} so far` }).click();
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/year/${year}$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Your stack in ${year} so far`);
      await expect(page.getByRole("heading", { level: 2, name: new RegExp(`^Year to date: ${year}-01-01 to `) })).toBeVisible();
      await expect(page.getByText(`${year} is not over yet.`)).toHaveText(
        `${year} is not over yet. These slides count up to today and cover the whole year from ${year + 1}-01-01.`,
      );

      // Slide 1: two deployments, a signup, and a new customer on every third day; the payments
      // seeded on every other day are not counted.
      const slide = (title: string) => page.getByRole("group", { name: title });
      await expect(page.getByText("Slide 1 of 4")).toBeVisible();
      await expect(slide("Busiest day")).toContainText(/(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, \d{4}-\d{2}-\d{2}/);
      await expect(slide("Busiest day")).toContainText("4 events on your timeline that day, not counting payments.");
      expect(await axeViolations(page)).toEqual([]);
      await testInfo.attach("year-in-review-busiest-day", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

      // Keyboard only, from the year links: Previous slide cannot move yet but keeps focus.
      await page.getByRole("navigation", { name: "Years" }).getByRole("link").first().focus();
      await page.keyboard.press("Tab");
      const previous = page.getByRole("button", { name: "Previous slide" });
      const next = page.getByRole("button", { name: "Next slide" });
      await expect(previous).toBeFocused();
      await expect(previous).toHaveAttribute("aria-disabled", "true");
      await page.keyboard.press("Enter");
      await expect(slide("Busiest day")).toBeVisible();
      await page.keyboard.press("Tab");
      await expect(next).toBeFocused();

      await page.keyboard.press("Enter");
      await expect(page.getByText("Slide 2 of 4: Longest run of successful deployments")).toBeAttached();
      await expect(slide("Longest run of successful deployments")).toContainText(
        wholeHistoryThisYear ? `${2 * HISTORY_DAYS} in a row on Vercel` : /\d+ in a row on Vercel/,
      );
      await expect(next).toBeFocused();

      await page.keyboard.press("Enter");
      await expect(slide("Most active provider")).toContainText("Vercel");
      await expect(slide("Most active provider")).not.toContainText("example-vercel");

      await page.keyboard.press("Enter");
      await expect(page.getByText("Slide 4 of 4", { exact: true })).toBeVisible();
      await expect(slide("Totals").getByRole("term")).toHaveText(["Deployments shipped", "Stars gained", "Signups", "Providers connected"]);
      await expect(slide("Totals").getByRole("definition").last()).toHaveText("5");
      await expect(next).toHaveAttribute("aria-disabled", "true");
      await page.keyboard.press("Enter");
      await expect(page.getByText("Slide 4 of 4", { exact: true })).toBeVisible();
      await expect(next).toBeFocused();
      expect(await axeViolations(page)).toEqual([]);

      await page.keyboard.press("Shift+Tab");
      await expect(previous).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByText("Slide 3 of 4: Most active provider")).toBeAttached();
      // GuardedButton drops the attribute while the button can act.
      await expect(previous).not.toHaveAttribute("aria-disabled");

      // Back to the first slide; each slide downloads as a 1200 by 630 PNG of the same figure,
      // private to members. The totals keep the yearly card's address and file name.
      await previous.click();
      await previous.click();
      const download = page.getByRole("link", { name: /^Download slide/ });
      const files = [
        ["busiest-day.png", `stackdash-${year}-so-far-busiest-day.png`],
        ["deployment-run.png", `stackdash-${year}-so-far-deployment-run.png`],
        ["top-provider.png", `stackdash-${year}-so-far-top-provider.png`],
        ["card.png", `stackdash-${year}-so-far.png`],
      ] as const;
      for (const [index, [file, downloadName]] of files.entries()) {
        if (index > 0) await next.click();
        await expect(page.getByText(`Slide ${index + 1} of 4`, { exact: true })).toBeVisible();
        await expect(download).toHaveAttribute("download", downloadName);
        await expect(download).toHaveAttribute("href", `/w/${workspace.slug}/year/${year}/${file}`);
        const image = await page.request.get(`/w/${workspace.slug}/year/${year}/${file}`);
        expect(image.status()).toBe(200);
        expect(image.headers()["content-type"]).toBe("image/png");
        expect(image.headers()["cache-control"]).toBe("private, no-store");
        expect(pngSize(await image.body())).toEqual({ width: 1200, height: 630 });
      }

      await expect(slide("Totals")).toBeVisible();
      const trigger = page.getByRole("button", { name: `Share your ${year} year to date totals slide` });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: `Share your ${year} year to date totals slide` });
      await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
      await expect(dialog.getByRole("link", { name: "Download card" })).toHaveAttribute("download", `stackdash-${year}-so-far.png`);
      // Private: no public URL to copy, only the image to download and post.
      await expect(dialog.getByLabel("Card URL")).toHaveCount(0);
      await expect(dialog.getByLabel("Alt text for the card")).toHaveValue(new RegExp(`^StackDash card: your stack in ${year} so far, `));
      await expect(dialog.getByRole("link", { name: "Share to X (opens in a new tab)" })).toHaveAttribute(
        "href",
        new RegExp(`text=My\\+stack\\+in\\+${year}\\+so\\+far\\+on\\+StackDash`),
      );
      expect(await axeViolations(page, "dialog[open]")).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();

      // Last year is a whole year: no "so far".
      await page.getByRole("navigation", { name: "Years" }).getByRole("link", { name: String(year - 1) }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Your stack in ${year - 1}`);
      await expect(page.getByRole("heading", { level: 2, name: `${year - 1}-01-01 to ${year - 1}-12-31` })).toBeVisible();
      await expect(page.getByRole("button", { name: `Share your ${year - 1} busiest day slide` })).toBeVisible();

      // Members only: without a session an image sends you to sign in; an unknown slide and next
      // year do not exist.
      const stranger = await api.get(`/w/${workspace.slug}/year/${year}/busiest-day.png`, { maxRedirects: 0 });
      expect(stranger.status()).toBe(307);
      expect(stranger.headers()["location"]).toMatch(/\/sign-in\?next=/);
      expect((await page.request.get(`/w/${workspace.slug}/year/${year}/totals.png`)).status()).toBe(404);
      expect((await page.request.get(`/w/${workspace.slug}/year/${year + 1}/card.png`)).status()).toBe(404);
    } finally {
      await api.dispose();
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("a workspace with nothing connected says so in words, and a slide does not animate under reduced motion", async ({ page }) => {
    const workspace = await createTestWorkspace("Empty year in review");
    const year = new Date().getUTCFullYear();
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`/w/${workspace.slug}/year/${year}`);
      await expect(page.getByText(`No provider was connected in ${year} so far.`)).toBeVisible();
      await expect(page.getByRole("link", { name: "Connect a provider" })).toHaveAttribute("href", `/w/${workspace.slug}/connections`);
      const busiest = page.getByRole("group", { name: "Busiest day" });
      await expect(busiest).toContainText("No events");
      await expect(busiest).toContainText(`Your connected providers sent no events in ${year} so far.`);
      expect(await busiest.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
      const empty = [
        ["Longest run of successful deployments", "Not connected", "Connect DigitalOcean, GitLab, Railway, or Vercel to count your deployments."],
        ["Most active provider", "No provider activity", `No connected provider sent events in ${year} so far.`],
      ] as const;
      for (const [title, value, detail] of empty) {
        await page.getByRole("button", { name: "Next slide" }).click();
        await expect(page.getByRole("group", { name: title })).toContainText(value);
        await expect(page.getByRole("group", { name: title })).toContainText(detail);
      }
      await page.getByRole("button", { name: "Next slide" }).click();
      await expect(page.getByRole("group", { name: "Totals" }).getByRole("definition").last()).toHaveText("0");
      expect(await axeViolations(page)).toEqual([]);

      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.getByRole("button", { name: "Previous slide" }).click();
      const provider = page.getByRole("group", { name: "Most active provider" });
      await expect(provider).toContainText("No provider activity");
      expect(await provider.evaluate((element) => getComputedStyle(element).animationName)).toBe("feed-content-in");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("a year that has not started says so and links to this year, by keyboard too", async ({ page }) => {
    const workspace = await createTestWorkspace("Future year in review");
    const year = new Date().getUTCFullYear();
    try {
      // Next year has not started, and a malformed year is the same answer.
      for (const path of [`/w/${workspace.slug}/year/${year + 1}`, `/w/${workspace.slug}/year/not-a-year`]) {
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("We could not find that year");
        await expect(page.getByText("The link may be mistyped, or the year may not have started yet.")).toBeVisible();
        await expect(page.getByRole("link", { name: "Open the latest year in review", exact: true })).toHaveAttribute(
          "href",
          `/w/${workspace.slug}/year/${year}`,
        );
        expect(await axeViolations(page)).toEqual([]);
      }

      // The link is the way on, by keyboard.
      await page.getByRole("link", { name: "Open the latest year in review", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`/w/${workspace.slug}/year/${year}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Your stack in ${year} so far`);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("a missing or inaccessible workspace keeps the workspace's page on a year path", async ({ page }) => {
    const workspace = await createTestWorkspace("Inaccessible year in review");
    const year = new Date().getUTCFullYear();
    try {
      // The viewer's personal workspace exists, and the owner is not a member of it.
      const inaccessible = (await personalWorkspace(workspace.viewerId)).slug;
      for (const slug of ["zzzzzzzzzzzzzzzz", inaccessible]) {
        for (const path of [`/w/${slug}/year/${year}`, `/w/${slug}/year/${year + 1}`]) {
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 1 })).toHaveText("We could not find that workspace");
          await expect(page.getByRole("link", { name: "Open your workspaces", exact: true })).toHaveAttribute("href", "/app");
          expect(await axeViolations(page)).toEqual([]);
        }
      }
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
