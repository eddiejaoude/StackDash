import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { ownerTest } from "./fixtures/auth";
import { createTestWorkspace, deleteTestWorkspace } from "./fixtures/db";

// textContent, not innerText: toHaveText compares textContent, and innerText applies CSS such as
// line breaks.
async function newestEvent(rows: Locator): Promise<string> {
  const text = await rows.first().textContent();
  if (!text) throw new Error("The newest live event has no text");
  return text;
}

// Waits until every animation inside the element has finished, so a measurement starts and ends on
// a settled layout. It runs in the page, so it must not reference anything outside itself.
async function settleAnimations(element: Element): Promise<void> {
  await Promise.all(element.getAnimations({ subtree: true }).map((animation) => animation.finished));
}

test.describe("landing page", () => {
  test("states the product and sends the primary action to the GitHub repository", async ({ page }) => {
    await page.goto("/");

    // The promise, not the brand tagline, in both the heading and the tab title (#305).
    await expect(page).toHaveTitle("StackDash · One timeline and one alert for your whole developer stack");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("One timeline and one alert for your whole developer stack.");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);

    const ctas = page.getByRole("link", { name: "Follow on GitHub" });
    await expect(ctas).toHaveCount(3);
    for (const cta of await ctas.all()) {
      await expect(cta).toHaveAttribute("href", "https://github.com/eddiejaoude/StackDash");
    }
  });

  test("the header and footer show the same brand and lead to the docs and sign in", async ({ page }) => {
    await page.goto("/");

    for (const region of [page.getByRole("banner"), page.getByRole("contentinfo")]) {
      await expect(region.getByRole("img", { name: "StackDash", exact: true })).toBeVisible();
      await expect(region.getByRole("link", { name: "Docs", exact: true })).toHaveAttribute("href", "/docs");
      await expect(region.getByRole("link", { name: "Sign in", exact: true })).toHaveAttribute("href", "/sign-in");
    }
    // The footer wordmark is the header's image, so it reads "StackDash" as one word (#127).
    const [headerSrc, footerSrc] = await Promise.all(
      [page.getByRole("banner"), page.getByRole("contentinfo")].map((region) =>
        region.getByRole("img", { name: "StackDash", exact: true }).getAttribute("src"),
      ),
    );
    expect(headerSrc).toBeTruthy();
    expect(footerSrc).toBe(headerSrc);

    await page.getByRole("banner").getByRole("link", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/sign-in");
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
  });

  test("the brand, sign in, and GitHub share one header row on a phone", async ({ page }) => {
    const banner = page.getByRole("banner");
    const brand = banner.getByRole("img", { name: "StackDash", exact: true });
    const signIn = banner.getByRole("link", { name: "Sign in", exact: true });
    // Icon only below sm: the label is sr-only, so the role and name still find it.
    const github = banner.getByRole("link", { name: "Follow on GitHub", exact: true });

    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/");
      await expect(brand).toBeVisible();
      await expect(signIn).toBeVisible();
      await expect(github).toBeVisible();

      // When the actions wrap below the brand, their boxes stop overlapping the brand vertically.
      const brandBox = await brand.boundingBox();
      if (!brandBox) throw new Error("The header brand has no layout box");
      for (const [name, action] of [["Sign in", signIn], ["Follow on GitHub", github]] as const) {
        const box = await action.boundingBox();
        if (!box) throw new Error(`The header ${name} link has no layout box at ${width} px`);
        expect(box.y, `${name} at ${width} px`).toBeLessThan(brandBox.y + brandBox.height);
        expect(brandBox.y, `${name} at ${width} px`).toBeLessThan(box.y + box.height);
        expect(box.width, `${name} target width at ${width} px`).toBeGreaterThanOrEqual(24);
        expect(box.height, `${name} target height at ${width} px`).toBeGreaterThanOrEqual(24);
      }
    }
  });

  test("every in-page navigation link lands on a section that exists", async ({ page }) => {
    await page.goto("/");

    const hrefs = await page
      .getByRole("navigation")
      .getByRole("link")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""));
    const anchors = [...new Set(hrefs.filter((href) => href.startsWith("#")))];
    expect(anchors.length).toBeGreaterThan(0);

    for (const anchor of anchors) {
      await expect(page.locator(anchor), `${anchor} has no matching section`).toHaveCount(1);
    }
  });

  test("labels the illustrative dashboard as example data", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("Example data.", { exact: false }).first()).toBeVisible();
  });

  test("the preview names Copilot spend in AI Credits, not premium requests", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByText("AI Credits beyond the plan")).toBeVisible();
    await expect(page.getByText(/premium requests/i)).toHaveCount(0);
  });

  test("every built integration states its spend requirement and links to its provider page", async ({ page }) => {
    await page.goto("/");

    const integrations = page.locator("#integrations");
    const built = await integrations
      .getByRole("region", { name: "Available" })
      .getByRole("listitem")
      .allTextContents();
    // "GitHub and GitHub Actions" is one connection, listed as GitHub in the spend list.
    const builtProviders = built.map((name) => name.replace(/ and GitHub Actions$/, ""));
    const spendProviders = await integrations.getByRole("term").allTextContents();
    expect(spendProviders).toEqual(builtProviders);
    await expect(integrations.getByRole("definition")).toHaveCount(spendProviders.length);
    for (const answer of await integrations.getByRole("definition").all()) {
      await expect(answer).toContainText("Spend:");
      await expect(answer).toContainText("Every plan:");
    }

    // Boundary: a planned provider gets no spend line until its adapter is built.
    const planned = await integrations.getByRole("region", { name: "Planned" }).getByRole("listitem").allTextContents();
    expect(planned.length).toBeGreaterThan(0);
    for (const provider of planned) expect(spendProviders).not.toContain(provider);

    await integrations.getByRole("term").getByRole("link", { name: "Vercel", exact: true }).click();
    await expect(page).toHaveURL("/docs/providers/vercel");
    await expect(page.getByRole("heading", { level: 1, name: "Vercel" })).toBeVisible();
  });

  test.describe("live events feed", () => {
    // A fake clock drives the feed's interval, so no test waits on real seconds. The feed only
    // ticks once hydrated, so each step retries until the hydrated feed responds.
    test.beforeEach(async ({ page }) => {
      await page.clock.install();
    });

    test("a new event arrives on top while streaming, and pausing stops it", async ({ page }) => {
      await page.goto("/");
      const rows = page.getByRole("list", { name: "Example live events" }).getByRole("listitem");
      await expect(rows).toHaveCount(10);
      const firstEvent = await newestEvent(rows);

      await expect(async () => {
        await page.clock.runFor(2_000);
        await expect(rows.first()).not.toHaveText(firstEvent, { timeout: 500 });
      }).toPass();
      await expect(rows, "the leaving row stays out of the accessibility tree").toHaveCount(10);

      await page.getByRole("button", { name: "Pause live events" }).click();
      await expect(page.getByRole("button", { name: "Resume live events" })).toBeVisible();
      const pausedEvent = await newestEvent(rows);
      await page.clock.runFor(30_000);
      await expect(rows.first()).toHaveText(pausedEvent);
    });

    test("starts paused when the visitor prefers reduced motion", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      const rows = page.getByRole("list", { name: "Example live events" }).getByRole("listitem");
      await expect(page.getByRole("button", { name: "Resume live events" })).toBeVisible();
      // #415 matches its center count to this starting figure.
      const counter = page.getByText("1,287 events today", { exact: true });
      await expect(counter).toBeVisible();
      const firstEvent = await newestEvent(rows);

      await page.clock.runFor(30_000);
      await expect(rows.first()).toHaveText(firstEvent);
      await expect(counter).toBeVisible();

      await page.getByRole("button", { name: "Resume live events" }).click();
      await expect(async () => {
        await page.clock.runFor(2_000);
        await expect(rows.first()).not.toHaveText(firstEvent, { timeout: 500 });
      }).toPass();
    });

    test("shows project achievements among the events, each labeled in words", async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto("/");
      const rows = page.getByRole("list", { name: "Example live events" }).getByRole("listitem");
      const achievements = rows.filter({ has: page.getByText("Achievement", { exact: true }) });
      await expect(rows).toHaveCount(10);
      expect(await achievements.count()).toBeGreaterThanOrEqual(3);
      await expect(achievements.filter({ hasText: "Payday: 10 payments in one day" })).toHaveCount(1);
      // #596: the trophy sits inside the pill, not on the logo's corner.
      await expect(achievements.filter({ hasText: "Payday: 10 payments in one day" }).getByText(/^🏆\s*Achievement$/)).toBeVisible();
    });

    // 64rem is the lg breakpoint: from it the feed sits beside the allowances and spend column and
    // shows ten rows, below it the columns stack and the feed shows six.
    const layouts = [
      { name: "a phone", viewport: { width: 390, height: 844 }, rows: 6 },
      { name: "one pixel below the lg breakpoint", viewport: { width: 1023, height: 900 }, rows: 6 },
      { name: "the lg breakpoint", viewport: { width: 1024, height: 900 }, rows: 10 },
    ] as const;

    for (const layout of layouts) {
      test(`the feed height never dips while an event arrives on ${layout.name}`, async ({ page }) => {
        await page.setViewportSize(layout.viewport);
        await page.goto("/");
        // Jump the page clock a minute ahead and freeze it, so no real-time tick lands mid-measurement.
        // pauseAt fires each due timer at most once, so a feed tick already due can fire during the
        // jump; settleAnimations below absorbs it before the controlled 2-second tick.
        await page.clock.pauseAt(Date.now() + 60_000);
        const list = page.getByRole("list", { name: "Example live events" });
        const rows = list.getByRole("listitem");
        await list.evaluate(settleAnimations);
        await expect(rows).toHaveCount(layout.rows);
        const firstEvent = await newestEvent(rows);

        // Every height the list takes while the rows open and close, starting with the settled one.
        const heights = await list.evaluateHandle((element) => {
          const seen = [element.getBoundingClientRect().height];
          new ResizeObserver(() => seen.push(element.getBoundingClientRect().height)).observe(element);
          return seen;
        });

        await expect(async () => {
          await page.clock.runFor(2_000);
          await expect(rows.first()).not.toHaveText(firstEvent, { timeout: 500 });
        }).toPass();
        await list.evaluate(settleAnimations);

        // The opening and closing rows move together, so the height only travels between the
        // settled heights before and after, which differ when the two rows wrap differently.
        const seen = await heights.jsonValue();
        const before = seen[0];
        if (before === undefined) throw new Error("The settled list height was not recorded");
        const after = await list.evaluate((element) => element.getBoundingClientRect().height);
        const lowest = Math.min(before, after) - 1;
        const highest = Math.max(before, after) + 1;
        for (const height of seen) {
          expect(height, `list height ${height} left the range ${lowest} to ${highest}`).toBeGreaterThanOrEqual(lowest);
          expect(height, `list height ${height} left the range ${lowest} to ${highest}`).toBeLessThanOrEqual(highest);
        }
        await expect(rows, "the closed row leaves the accessibility tree").toHaveCount(layout.rows);
      });
    }
  });
});

/**
 * Keyboard only, from a fresh load: the first Tab reaches the skip link, Enter moves focus onto
 * the main landmark, and the next Tab continues inside it rather than at the page navigation.
 * Focus leaving the landmark takes its tabindex with it, and the skip costs no accessibility
 * violation either.
 */
async function expectSkipToContent(page: Page): Promise<void> {
  const skip = page.getByRole("link", { name: "Skip to content" });
  const main = page.getByRole("main");
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  // Focus only moves once the link has hydrated; before that Enter only scrolls, so retry.
  await expect(async () => {
    await skip.focus();
    await page.keyboard.press("Enter");
    await expect(main).toBeFocused({ timeout: 1000 });
  }).toPass();
  await expect(page).toHaveURL(/#main$/);
  // A landmark, not a control: the skip target is not outlined (src/app/globals.css).
  expect(await main.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("none");
  await page.keyboard.press("Tab");
  await expect(page.locator("main :focus")).toHaveCount(1);
  await expect(main).not.toHaveAttribute("tabindex");
  const scan = await new AxeBuilder({ page }).analyze();
  expect(scan.violations).toEqual([]);
}

test.describe("skip to content", () => {
  // The landing page fades its hero in; a scan mid-fade reports contrast the settled page has not.
  test.use({ reducedMotion: "reduce" });

  for (const route of ["/", "/docs", "/sign-in", "/privacy", "/terms"]) {
    test(`moves keyboard focus to the main content on ${route}`, async ({ page }) => {
      await page.goto(route);
      await expectSkipToContent(page);
    });
  }

  test("moves focus again when the address already ends in #main", async ({ page }) => {
    await page.goto("/");
    await expectSkipToContent(page);
    // A second press is a navigation to the fragment already in the address bar.
    await page.getByRole("link", { name: "Skip to content" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
  });

  test("a click inside the content after a skip does not focus the landmark", async ({ page }) => {
    await page.goto("/docs");
    await expectSkipToContent(page);
    const main = page.getByRole("main");
    await main.getByRole("heading", { level: 1 }).click();
    await expect(main).not.toBeFocused();
    await expect(main).not.toHaveAttribute("tabindex");
  });

  ownerTest("moves keyboard focus past the workspace navigation", async ({ page }) => {
    const workspace = await createTestWorkspace("Skip link");
    try {
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectSkipToContent(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
