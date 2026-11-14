import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { expect, ownerTest } from "./fixtures/auth";
import { createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { turnOffPage, turnOnPage } from "./fixtures/public-pages";
import { ALL_METRIC_IDS, anonymous, pngSize, publishMetrics, seedShareProject, STARS_TODAY } from "./fixtures/share";

// Badges, milestone cards, and the share dialog (#149), and links to the project page (#255). The
// yearly card (#151) is a year in review slide now, in year-in-review.spec.ts. Each test creates
// its own workspace and seeds only inside it, so tests run in any order.

const STARS_TEXT = new Intl.NumberFormat("en-US").format(STARS_TODAY);

// The badge's own policy as served (next.config.ts): opened directly, it loads and runs nothing.
const BADGE_CSP = "default-src 'none'; frame-ancestors 'none'; sandbox";

/** The badge as served, with `message` as the text of its right half. */
async function expectBadge(api: APIRequestContext, projectId: string, metricId: string, message: string | RegExp): Promise<string> {
  const response = await api.get(`/badge/${projectId}/${metricId}.svg`);
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["content-type"]).toBe("image/svg+xml; charset=utf-8");
  expect(headers["cache-control"]).toBe("public, max-age=60, s-maxage=60");
  expect(headers["content-security-policy"]).toBe(BADGE_CSP);
  expect(headers["cross-origin-resource-policy"]).toBe("cross-origin");
  expect(headers["set-cookie"]).toBeUndefined();
  const svg = await response.text();
  const shown = /<text [^>]*>([^<]*)<\/text>\s*<\/g>/.exec(svg)?.[1];
  if (typeof message === "string") expect(shown).toBe(message);
  else expect(shown).toMatch(message);
  return svg;
}

async function expectCard(api: APIRequestContext, projectId: string, metricId: string): Promise<Buffer> {
  const response = await api.get(`/card/${projectId}/${metricId}.png`);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/png");
  expect(response.headers()["set-cookie"]).toBeUndefined();
  const body = await response.body();
  expect(pngSize(body)).toEqual({ width: 1200, height: 630 });
  return body;
}

/** The image finished loading and decoded to its intrinsic size. */
async function expectImageLoaded(image: Locator, width: number): Promise<void> {
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth)).toBe(width);
}

/** The RGB of the image's pixels at its four corners, drawn on a canvas at full size. */
async function cornerColors(image: Locator): Promise<number[][]> {
  return image.evaluate((element: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("No 2D canvas");
    context.drawImage(element, 0, 0);
    const { width, height } = canvas;
    return [
      [2, 2],
      [width - 3, 2],
      [2, height - 3],
      [width - 3, height - 3],
    ].map(([x = 0, y = 0]) => [...context.getImageData(x, y, 1, 1).data.slice(0, 3)]);
  });
}

function publicMetricsPath(workspace: TestWorkspace, projectId: string): string {
  return `/w/${workspace.slug}/projects/${projectId}/public-metrics`;
}

async function axeViolations(page: Page, selector?: string) {
  const builder = new AxeBuilder({ page });
  return (await (selector === undefined ? builder : builder.include(selector)).analyze()).violations;
}

/** The `url` parameter of a share link's `href`: what the post would link to. */
async function sharedUrl(link: Locator): Promise<string | null> {
  const href = await link.getAttribute("href");
  return href === null ? null : new URL(href).searchParams.get("url");
}

ownerTest.describe("badges and cards", () => {
  ownerTest("publishing serves a live badge and card, and unpublishing turns the badge Unpublished", async ({ page, baseURL }) => {
    const workspace = await createTestWorkspace("Share badge");
    const api = await anonymous(baseURL);
    try {
      const { projectId } = await seedShareProject(workspace);
      // Not published yet: the same neutral badge as an unknown project, with a 200.
      await expectBadge(api, projectId, "github-stars", "Unpublished");

      await page.goto(publicMetricsPath(workspace, projectId));
      await page.getByRole("button", { name: "Publish GitHub stars", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Published GitHub stars." })).toBeVisible();

      const svg = await expectBadge(api, projectId, "github-stars", `${STARS_TEXT} verified`);
      expect(svg).not.toContain("example-github");
      await expectCard(api, projectId, "github-stars");

      await page.getByRole("button", { name: "Unpublish GitHub stars", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Unpublished GitHub stars. It is no longer public." })).toBeVisible();
      await expectBadge(api, projectId, "github-stars", "Unpublished");
      // The card turns into the neutral card, still a 1200 by 630 PNG with a 200.
      await expectCard(api, projectId, "github-stars");
    } finally {
      await api.dispose();
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("every metric in the engine has a badge and a card", async ({ page, baseURL }, testInfo) => {
    const workspace = await createTestWorkspace("Share every metric");
    const api = await anonymous(baseURL);
    try {
      const { projectId } = await seedShareProject(workspace);
      await publishMetrics(workspace, projectId, ALL_METRIC_IDS);
      await page.setViewportSize({ width: 1200, height: 630 });

      for (const metricId of ALL_METRIC_IDS) {
        await ownerTest.step(metricId, async () => {
          // Every seeded metric has a number: the badge shows it as verified, never "Not connected".
          const svg = await expectBadge(api, projectId, metricId, /^[0-9,%]+ verified$/);
          expect(svg).not.toMatch(/Not connected|Not enough history|No data|Stale/);
          // Public surfaces never carry spend, amounts, or account names.
          expect(svg).not.toMatch(/\$|USD|example-/);
          await expectCard(api, projectId, metricId);

          // The card as a browser renders it, attached to the report as this metric's screenshot.
          await page.goto(`/card/${projectId}/${metricId}.png`);
          const image = page.getByRole("img");
          await expectImageLoaded(image, 1200);
          // The card's background reaches every corner: no band of empty image under short content.
          expect(await cornerColors(image)).toEqual(Array.from({ length: 4 }, () => [10, 10, 10]));
          await testInfo.attach(`card-${metricId}`, { body: await page.screenshot(), contentType: "image/png" });
        });
      }
    } finally {
      await api.dispose();
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("the share dialog passes axe and works from the keyboard", async ({ page }) => {
    const workspace = await createTestWorkspace("Share dialog");
    try {
      const { projectId } = await seedShareProject(workspace);
      await publishMetrics(workspace, projectId, ["github-stars"]);
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto(publicMetricsPath(workspace, projectId));

      const trigger = page.getByRole("button", { name: "Share GitHub stars", exact: true });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Share GitHub stars" });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
      await expect(dialog).toContainText("In the last 7 days StackDash served the badge");

      const markdown = dialog.getByLabel("Badge Markdown for a README");
      await expect(markdown).toHaveValue(new RegExp(`/badge/${projectId}/github-stars\\.svg`));
      const cardUrl = dialog.getByLabel("Card URL");
      await expect(cardUrl).toHaveValue(new RegExp(`/card/${projectId}/github-stars\\.png$`));
      await expect(dialog.getByLabel("Alt text for the card")).toHaveValue(/^StackDash card\. GitHub stars/);
      await expectImageLoaded(dialog.getByRole("img", { name: /^StackDash card/ }), 1200);
      const shareToX = dialog.getByRole("link", { name: "Share to X (opens in a new tab)" });
      const shareToLinkedIn = dialog.getByRole("link", { name: "Share to LinkedIn (opens in a new tab)" });
      await expect(shareToX).toHaveAttribute("href", /^https:\/\/x\.com\/intent\/tweet\?text=/);
      await expect(shareToLinkedIn).toHaveAttribute("href", /^https:\/\/www\.linkedin\.com\/sharing\/share-offsite\/\?url=/);
      // The project page is off, so posts link to the card itself and the badge to its formula.
      const link = dialog.getByLabel("Link for a post");
      await expect(link).toHaveValue(await cardUrl.inputValue());
      expect(await sharedUrl(shareToX)).toBe(await cardUrl.inputValue());
      expect(await sharedUrl(shareToLinkedIn)).toBe(await cardUrl.inputValue());
      await expect(markdown).toHaveValue(/\/docs\/architecture\/public-metrics#github-stars\)$/);

      expect(await axeViolations(page, "dialog[open]")).toEqual([]);

      // Every control in reading order, by Tab alone.
      const order = [
        markdown,
        dialog.getByRole("button", { name: "Copy badge Markdown" }),
        cardUrl,
        dialog.getByRole("button", { name: "Copy card URL" }),
        dialog.getByLabel("Alt text for the card"),
        dialog.getByRole("button", { name: "Copy alt text" }),
        link,
        dialog.getByRole("button", { name: "Copy link" }),
        shareToX,
        shareToLinkedIn,
      ];
      for (const control of order) {
        await page.keyboard.press("Tab");
        await expect(control).toBeFocused();
      }
      await page.keyboard.press("Shift+Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(dialog.getByRole("button", { name: "Copy link" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(dialog.getByRole("status")).toHaveText("Copied the link.");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await cardUrl.inputValue());

      await dialog.getByRole("button", { name: "Copy alt text" }).focus();
      await page.keyboard.press("Enter");
      await expect(dialog.getByRole("status")).toHaveText("Copied the alt text.");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^StackDash card\. GitHub stars/);

      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
      expect(await axeViolations(page)).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("with the project page on, the card names the project and posts and the badge lead to the page", async ({ page, baseURL }) => {
    const workspace = await createTestWorkspace("Share project page");
    const api = await anonymous(baseURL);
    try {
      const { projectId } = await seedShareProject(workspace);
      await publishMetrics(workspace, projectId, ["github-stars"]);
      const unnamed = await expectCard(api, projectId, "github-stars");
      await turnOnPage(workspace, projectId, "acme-web", false);
      // The same card with the project's name added: the route reads the page, not only the metric.
      const named = await expectCard(api, projectId, "github-stars");
      expect(named.equals(unnamed)).toBe(false);

      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.goto(publicMetricsPath(workspace, projectId));
      await page.getByRole("button", { name: "Share GitHub stars", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Share GitHub stars" });
      const pageUrl = new RegExp(`/@${workspace.slug}/acme-web$`);
      const link = dialog.getByLabel("Link for a post");
      await expect(link).toHaveValue(pageUrl);
      const address = await link.inputValue();
      const shareToX = dialog.getByRole("link", { name: "Share to X (opens in a new tab)" });
      expect(await sharedUrl(shareToX)).toBe(address);
      const xText = new URL((await shareToX.getAttribute("href")) ?? "").searchParams.get("text");
      expect(xText).toBe(`GitHub stars for Acme web: ${STARS_TEXT} stars. Verified by StackDash.`);
      expect(await sharedUrl(dialog.getByRole("link", { name: "Share to LinkedIn (opens in a new tab)" }))).toBe(address);
      expect(await dialog.getByLabel("Badge Markdown for a README").inputValue()).toMatch(new RegExp(`/badge/${projectId}/github-stars\\.svg\\)\\]\\(`));
      expect((await dialog.getByLabel("Badge Markdown for a README").inputValue()).endsWith(`](${address})`)).toBe(true);
      await expect(dialog.getByLabel("Alt text for the card")).toHaveValue(/^StackDash card for Acme web\. GitHub stars/);
      await expect(dialog).toContainText(`Posts and the badge link to the project page at /@${workspace.slug}/acme-web.`);
      await expectImageLoaded(dialog.getByRole("img", { name: /^StackDash card for Acme web\./ }), 1200);

      await dialog.getByRole("button", { name: "Copy link" }).click();
      await expect(dialog.getByRole("status")).toHaveText("Copied the link.");
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(address);

      // Turned off, the page answers 404 again: nothing links to it, and the card drops the name.
      await turnOffPage(workspace, projectId);
      expect((await expectCard(api, projectId, "github-stars")).equals(unnamed)).toBe(true);
      await page.reload();
      await page.getByRole("button", { name: "Share GitHub stars", exact: true }).click();
      await expect(link).toHaveValue(new RegExp(`/card/${projectId}/github-stars\\.png$`));
      expect(await sharedUrl(shareToX)).not.toContain("/@");
      await expect(dialog.getByLabel("Badge Markdown for a README")).not.toHaveValue(/\/@/);
    } finally {
      await api.dispose();
      await deleteTestWorkspace(workspace);
    }
  });
});
