import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page, type Response } from "@playwright/test";

import { BASELINE_CSP } from "./fixtures/csp";
import { expectHydrated } from "./fixtures/hydration";
import { E2E_OPERATOR } from "./fixtures/operator";

/*
 * The privacy policy and terms of use (#339), with the synthetic operator playwright.config.ts gives
 * the app. That the pages answer 404 and every link disappears without an operator is covered by
 * src/lib/legal.test.ts, because one e2e server cannot run both configurations.
 */

// More Tab stops than any of these pages has before the link a test looks for.
const MAX_TAB_PRESSES = 60;

/** Presses Tab from the top of the page until `target` has focus, and checks its focus ring shows. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  await page.locator("body").focus();
  for (let presses = 0; presses < MAX_TAB_PRESSES; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
  expect(await target.evaluate((element) => getComputedStyle(element).outlineStyle)).not.toBe("none");
}

/**
 * The policy's cookies section says these pages set no cookies. That holds because they are outside
 * the proxy matcher (src/proxy.ts), so no session refresh runs there and next.config.ts sends the
 * static policy: a page moved into the matcher fails here before the published claim turns false.
 */
async function expectNoCookies(page: Page, response: Response | null): Promise<void> {
  if (response === null) throw new Error("Expected a response for the navigation.");
  // headers() leaves out cookie headers (Response.headers in the Playwright types); headerValue reads them.
  expect(await response.headerValue("set-cookie")).toBeNull();
  expect(response.headers()["content-security-policy"]).toBe(BASELINE_CSP);
  expect(await page.context().cookies()).toEqual([]);
}

test.describe("privacy policy and terms of use", () => {
  test("the privacy policy names the operator, how to reach them, and who processes data", async ({ page }) => {
    const response = await page.goto("/privacy");

    expect(response?.status()).toBe(200);
    await expectNoCookies(page, response);
    await expect(page).toHaveTitle("Privacy policy · StackDash");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText("Privacy policy");
    await expect(main.getByText(`${E2E_OPERATOR.STACKDASH_OPERATOR_NAME} runs StackDash at this address`)).toBeVisible();
    await expect(main.getByRole("link", { name: E2E_OPERATOR.STACKDASH_OPERATOR_EMAIL }).first()).toHaveAttribute(
      "href",
      `mailto:${E2E_OPERATOR.STACKDASH_OPERATOR_EMAIL}`,
    );
    for (const heading of ["Cookies", "Who processes data for us", "How long we keep it", "Deleting your account"]) {
      await expect(main.getByRole("heading", { level: 2, name: heading })).toBeVisible();
    }
    await expect(main.getByRole("link", { name: "Stripe", exact: true })).toHaveAttribute("href", "/docs/providers/stripe");
  });

  test("the terms of use name the operator and the governing law", async ({ page }) => {
    const response = await page.goto("/terms");

    expect(response?.status()).toBe(200);
    await expectNoCookies(page, response);
    await expect(page).toHaveTitle("Terms of use · StackDash");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText("Terms of use");
    await expect(main.getByText(`which ${E2E_OPERATOR.STACKDASH_OPERATOR_NAME} runs`)).toBeVisible();
    await expect(main.getByText(`governed by the law of ${E2E_OPERATOR.STACKDASH_GOVERNING_LAW}`)).toBeVisible();
  });

  test("the sign-in page, the footer, and the sitemap lead to both pages", async ({ page, request }) => {
    await page.goto("/sign-in");
    const consent = page.getByRole("main").getByText("By continuing, you agree to the");
    await expect(consent.getByRole("link", { name: "terms of use" })).toHaveAttribute("href", "/terms");
    await expect(consent.getByRole("link", { name: "privacy policy" })).toHaveAttribute("href", "/privacy");

    await page.goto("/");
    const footer = page.getByRole("contentinfo");
    await expect(footer.getByRole("link", { name: "Terms of use", exact: true })).toHaveAttribute("href", "/terms");
    await footer.getByRole("link", { name: "Privacy policy", exact: true }).click();
    await expect(page).toHaveURL("/privacy");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy policy");

    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.status()).toBe(200);
    const body = await sitemap.text();
    // Each with the date its text last changed (PRIVACY_UPDATED, TERMS_UPDATED in src/lib/legal.ts).
    expect(body).toMatch(/\/privacy<\/loc>\n<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
    expect(body).toMatch(/\/terms<\/loc>\n<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/);
  });

  // Off Vercel the policy says the site runs no analytics, and the root documents (src/app/layout.tsx,
  // src/app/global-not-found.tsx) render Vercel Web Analytics only on Vercel. The e2e server never
  // runs there, so no page may load the script, from this origin or Vercel's, nor set up its queue
  // (`window.va`). The landing page and the policy use the root layout, the unmatched path the other.
  // An absence has no element to wait for, and the component sets up from an effect that can run
  // after the route announcer (`expectHydrated`): with VERCEL=1 the landing page passed that check.
  // So each page waits until the network has been idle, by when the script would have been asked for.
  test("off Vercel, no page loads Vercel Web Analytics", async ({ page }) => {
    const analyticsRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/_vercel\/insights\/|vercel-scripts\.com/.test(request.url())) analyticsRequests.push(request.url());
    });

    for (const path of ["/", "/privacy", "/no-such-page"]) {
      await page.goto(path, { waitUntil: "networkidle" });
      await expectHydrated(page);
      expect.soft(await page.evaluate(() => "va" in window), path).toBe(false);
    }
    expect(analyticsRequests).toEqual([]);
  });

  for (const path of ["/privacy", "/terms", "/sign-in"]) {
    test(`${path} has no automatically detectable accessibility violations`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    });
  }

  test("a keyboard alone goes from sign-in to the terms, to the policy, to the contact address", async ({ page }) => {
    await page.goto("/sign-in");
    const terms = page.getByRole("main").getByRole("link", { name: "terms of use" });
    await tabTo(page, terms);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/terms");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Terms of use");

    const privacy = page.getByRole("main").getByRole("link", { name: "privacy policy" });
    await tabTo(page, privacy);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/privacy");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Privacy policy");

    await tabTo(page, page.getByRole("main").getByRole("link", { name: E2E_OPERATOR.STACKDASH_OPERATOR_EMAIL }).first());
  });
});
