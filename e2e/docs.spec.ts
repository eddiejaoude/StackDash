import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { tabTo } from "./fixtures/keyboard";

// `#` and digits that are not part of a word (`PKCS#1`) or an entity: an issue number.
const ISSUE_REFERENCE = /(?<![\w&])#\d+\b/;

// More Tab stops than any docs page has before its first code block: header, docs list, then content.
const MAX_TAB_PRESSES = 100;

test.describe("docs", () => {
  test("the landing page leads to an index that starts with getting started", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("banner").getByRole("link", { name: "Docs", exact: true }).click();

    await expect(page).toHaveURL("/docs");
    await expect(page).toHaveTitle("Docs · StackDash");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Documentation");

    const main = page.getByRole("main");
    // The leading four only: any other top-level page adds a Developers group after Architecture.
    const groupHeadings = main.getByRole("heading", { level: 2 });
    const leadingGroups = ["Using StackDash", "Providers", "Self-hosting and operations", "Architecture"];
    for (const [index, name] of leadingGroups.entries()) {
      await expect(groupHeadings.nth(index)).toHaveText(name);
    }
    await expect(main.getByRole("link").first()).toHaveText("Getting started");
    await expect(page.getByRole("region", { name: "Using StackDash" }).getByRole("link")).toHaveText([
      "Getting started",
      "Connect providers",
      "REST API",
      "MCP server",
      "Roadmap",
    ]);

    const providers = page.getByRole("region", { name: "Providers" });
    for (const name of ["DigitalOcean", "GitHub", "GitLab", "Polar", "PostHog", "Railway", "Resend", "Sentry", "Stripe", "Supabase", "Vercel"]) {
      await expect(providers.getByRole("link", { name, exact: true })).toBeVisible();
    }
    const operations = page.getByRole("region", { name: "Self-hosting and operations" });
    for (const name of [
      "Deploy to Vercel and Supabase",
      "Jobs: scheduled syncs, retries, and retention",
      "Register the OAuth apps",
      "Self-host StackDash",
    ]) {
      await expect(operations.getByRole("link", { name, exact: true })).toBeVisible();
    }
    await expect(
      page.getByRole("region", { name: "Architecture" }).getByRole("link", { name: "Database schema", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Developers" }).getByRole("link", { name: "Write a provider adapter", exact: true }),
    ).toBeVisible();
    await expect(main.getByText("Hosted instance runbook")).toHaveCount(0);
  });

  test("each provider card says what StackDash reads and how far it was tested", async ({ page }) => {
    await page.goto("/docs");
    const providers = page.getByRole("region", { name: "Providers" });
    const cards = providers.getByRole("listitem");
    await expect(cards).toHaveCount(11);

    for (const card of await cards.all()) {
      await expect(card.getByRole("paragraph")).toHaveText(/^StackDash reads /);
      await expect(card.getByText(/^(Not yet tested|Tested) with a real account$/)).toHaveCount(1);
    }
    // Only provider pages carry a status.
    await expect(
      page.getByRole("region", { name: "Self-hosting and operations" }).getByText(/tested with a real account/),
    ).toHaveCount(0);
  });

  for (const path of [
    "/docs",
    "/docs/getting-started",
    "/docs/api",
    "/docs/mcp",
    "/docs/connect-providers",
    "/docs/roadmap",
    "/docs/operations/self-hosting",
    "/docs/adapters",
    "/docs/development",
    "/docs/providers/digitalocean",
    "/docs/architecture/schema",
  ]) {
    test(`${path} shows no issue numbers`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect(await page.getByRole("main").innerText()).not.toMatch(ISSUE_REFERENCE);
    });
  }

  test("a code block copies by keyboard and announces it", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/docs/api");
    const main = page.getByRole("main");
    const copyButtons = main.getByRole("button", { name: "Copy code" });
    await expect(copyButtons).toHaveCount(await main.locator("pre").count());

    // Visible text "Copy code" on every button; the accessible name says which block it copies.
    const copyButton = copyButtons.first();
    await expect(copyButton).toHaveAccessibleName("Copy code: bash, block 1");
    await expect(copyButtons.nth(1)).toHaveAccessibleName("Copy code: bash, block 2");
    const box = await copyButton.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(24);
    expect(box?.height).toBeGreaterThanOrEqual(24);

    // Count each time the live region's text becomes the message, the way a screen reader hears it.
    const status = main.getByRole("status").first();
    await status.evaluate((element) => {
      element.dataset.announcements = "0";
      new MutationObserver(() => {
        if (element.textContent === "Copied the code.") {
          element.dataset.announcements = String(Number(element.dataset.announcements) + 1);
        }
      }).observe(element, { childList: true, characterData: true, subtree: true });
    });

    await tabTo(page, copyButton, MAX_TAB_PRESSES);
    await page.keyboard.press("Enter");

    await expect(status).toHaveText("Copied the code.");
    await expect(status).toHaveAttribute("data-announcements", "1");
    const code = await main.locator("pre").first().innerText();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code.replace(/\n$/, ""));

    // Copying again while the message still shows announces it again.
    await page.keyboard.press("Enter");
    await expect(status).toHaveAttribute("data-announcements", "2");
    await expect(status).toHaveText("Copied the code.");
  });

  test("a code block says so when the clipboard refuses the copy", async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
      });
    });
    await page.goto("/docs/api");
    const main = page.getByRole("main");
    const copyButton = main.getByRole("button", { name: "Copy code" }).first();

    await tabTo(page, copyButton, MAX_TAB_PRESSES);
    await page.keyboard.press("Space");

    await expect(main.getByRole("alert").first()).toHaveText(
      "Could not copy the code. Select the text in the block and copy it yourself.",
    );
  });

  test("a provider page renders its heading, its tables, and marks itself in the docs list", async ({ page }) => {
    await page.goto("/docs");
    await page.getByRole("link", { name: "Vercel", exact: true }).click();

    await expect(page).toHaveURL("/docs/providers/vercel");
    await expect(page).toHaveTitle("Vercel · StackDash");
    const main = page.getByRole("main");
    await expect(main.getByRole("heading", { level: 1 })).toHaveText("Vercel");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(main.getByRole("table").first()).toBeVisible();
    await expect(main.getByRole("columnheader", { name: "Item", exact: true }).first()).toBeVisible();

    const docsList = page.getByRole("navigation", { name: "Docs" });
    await expect(docsList.getByRole("link", { name: "Vercel", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(docsList.getByRole("link", { name: "GitHub", exact: true })).not.toHaveAttribute("aria-current");
  });

  test("a link to another doc opens that doc at the linked heading", async ({ page }) => {
    await page.goto("/docs/operations/oauth-apps");
    await page.getByRole("main").getByRole("link", { name: "Deploy, environment variables", exact: true }).click();

    await expect(page).toHaveURL("/docs/operations/deploy#environment-variables");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Deploy to Vercel and Supabase");
    await expect(page.getByRole("heading", { name: "Environment variables", exact: true })).toBeInViewport();
  });

  for (const path of [
    "/docs/providers/not-a-provider",
    "/docs/Providers/Vercel",
    "/docs/providers/vercel/extra",
    // In the repository, never published.
    "/docs/internal/hosted-instance",
  ]) {
    test(`answers 404 for ${path}`, async ({ page }) => {
      const response = await page.goto(path);

      expect(response?.status()).toBe(404);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("We could not find that doc");
      await page.getByRole("link", { name: "Browse all docs" }).click();
      await expect(page).toHaveURL("/docs");
    });
  }

  for (const path of [
    "/docs",
    "/docs/getting-started",
    "/docs/connect-providers",
    "/docs/roadmap",
    "/docs/operations/self-hosting",
    "/docs/api",
    "/docs/adapters",
    "/docs/development",
    "/docs/providers/vercel",
    "/docs/providers/gitlab",
  ]) {
    test(`${path} has no automatically detectable accessibility violations`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    });
  }

  test("keyboard focus reaches the docs list and opens a doc", async ({ page }) => {
    await page.goto("/docs/providers/vercel");
    const firstDoc = page.getByRole("navigation", { name: "Docs" }).getByRole("link").first();
    await expect(firstDoc).toHaveText("Getting started");

    // Tab from the top of the page until focus lands on the first doc in the list.
    await tabTo(page, firstDoc, MAX_TAB_PRESSES);

    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/docs/getting-started");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Getting started");
  });

  test("keyboard focus follows the home page roadmap to the full roadmap", async ({ page }) => {
    // The fragment makes the roadmap section the starting point of sequential focus navigation.
    await page.goto("/#roadmap");
    const fullRoadmap = page.getByRole("region", { name: "Small first release, clear next steps" }).getByRole("link", {
      name: "Read the full roadmap",
    });

    await tabTo(page, fullRoadmap, MAX_TAB_PRESSES);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/docs/roadmap");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Roadmap");
    await expect(page.getByRole("main").getByRole("heading", { name: "How this page maps to the board", exact: true })).toBeVisible();
  });

  test("keyboard focus opens the adapter guide and follows a link to one of its sections", async ({ page }) => {
    await page.goto("/docs");
    const guide = page.getByRole("region", { name: "Developers" }).getByRole("link", { name: "Write a provider adapter", exact: true });

    await tabTo(page, guide, MAX_TAB_PRESSES);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/docs/adapters");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Write a provider adapter");

    const sectionLink = page.getByRole("main").getByRole("link", { name: "Register the provider", exact: true }).first();
    await tabTo(page, sectionLink, MAX_TAB_PRESSES);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/docs/adapters#register-the-provider");
    await expect(page.getByRole("heading", { name: "Register the provider", exact: true })).toBeInViewport();
  });
});
