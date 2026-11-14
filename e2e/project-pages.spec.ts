import { randomBytes } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { request as playwrightRequest, type Browser, type Page } from "@playwright/test";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { claimHandle, publishStars, seedIncludedAccounts, seedProjectWithHistory, STARS_TODAY, turnOnPage } from "./fixtures/public-pages";
import { watchLiveRefresh } from "./fixtures/realtime";

// Public project pages (#150). Each test creates its own workspace and seeds only inside it, so
// tests run in any order. Public reads go through a fresh browser context or request context with
// no session, as a stranger would see them.

function settingsPath(workspace: TestWorkspace, projectId: string): string {
  return `/w/${workspace.slug}/projects/${projectId}/public-metrics`;
}

async function readPublic(baseURL: string, path: string): Promise<{ status: number; body: string }> {
  const context = await playwrightRequest.newContext({ baseURL });
  try {
    const response = await context.get(path);
    return { status: response.status(), body: await response.text() };
  } finally {
    await context.dispose();
  }
}

/** Opens `path` signed out, runs `check` on the page, and closes the context. */
async function asStranger(browser: Browser, baseURL: string, path: string, check: (page: Page, status: number | undefined) => Promise<void>): Promise<void> {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  try {
    const page = await context.newPage();
    const response = await page.goto(path);
    await check(page, response?.status());
  } finally {
    await context.close();
  }
}

async function expectNotFound(page: Page, status: number | undefined): Promise<void> {
  expect(status).toBe(404);
  await expect(page).toHaveTitle("Page not found · StackDash");
  await expect(page.getByRole("heading", { level: 1, name: "We could not find that page" })).toBeVisible();
}

/** The status and Location of `path` without following a redirect, signed out. */
async function readRedirect(baseURL: string, path: string): Promise<{ status: number; location: string | null }> {
  const context = await playwrightRequest.newContext({ baseURL });
  try {
    const response = await context.get(path, { maxRedirects: 0 });
    const location = response.headers()["location"];
    if (location === undefined) return { status: response.status(), location: null };
    const target = new URL(location, baseURL);
    return { status: response.status(), location: `${target.pathname}${target.search}` };
  } finally {
    await context.dispose();
  }
}

/** A workspace with Acme web's page on at acme-web and GitHub stars published, so the page answers. */
async function createPublicPageWorkspace(label: string): Promise<{ workspace: TestWorkspace; projectId: string }> {
  const workspace = await createTestWorkspace(label);
  const projectId = await seedProjectWithHistory(workspace);
  await publishStars(workspace, projectId);
  await turnOnPage(workspace, projectId, "acme-web", false);
  return { workspace, projectId };
}

ownerTest.describe("project pages as the owner", () => {
  ownerTest("turns a page on, shows only what is published, and turns it off", async ({ page, browser, baseURL }) => {
    if (baseURL === undefined) throw new Error("baseURL is not configured");
    const workspace = await createTestWorkspace("Project page");
    try {
      const projectId = await seedProjectWithHistory(workspace);
      await publishStars(workspace, projectId);
      const address = `/@${workspace.slug}/acme-web`;

      await page.goto(settingsPath(workspace, projectId));
      const settings = page.getByRole("region", { name: "Project page" });
      await expect(settings).toContainText("Off. Nothing is public at a project page address until an owner or admin turns it on.");
      // Nothing is public by default: the address answers the same 404 as any unknown one.
      expect((await readPublic(baseURL, address)).status).toBe(404);

      await expect(settings.getByLabel("Address")).toHaveValue("acme-web");
      await settings.getByLabel("Let search engines index this page").check();
      await settings.getByRole("button", { name: "Turn on the project page" }).click();
      await expect(page.getByRole("status").filter({ hasText: `The project page is on at ${address}.` })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Project page" })).toBeFocused();
      await expect(settings.getByRole("link", { name: address })).toHaveAttribute("href", address);
      await expect(settings).toContainText("Search engines may index it.");

      const { data: events, error } = await adminClient()
        .from("activity_events")
        .select("title, body, provider")
        .eq("workspace_id", workspace.id)
        .eq("type_id", "stackdash.project_page_enabled");
      if (error) throw new Error(`Reading events failed (code ${error.code}).`);
      expect(events).toEqual([
        { title: "Turned on the public project page", body: `Project Acme web. Address ${address}. Search engines may index it.`, provider: null },
      ]);

      await asStranger(browser, baseURL, address, async (publicPage, status) => {
        expect(status).toBe(200);
        await expect(publicPage).toHaveTitle("Acme web: public metrics · StackDash");
        await expect(publicPage.getByRole("heading", { level: 1 })).toHaveText("Acme web");
        await expect(publicPage.locator('meta[name="robots"]')).toHaveAttribute("content", "index, follow");

        const published = publicPage.getByRole("region", { name: "Published metrics" });
        await expect(published.getByRole("listitem")).toHaveCount(1);
        await expect(published).toContainText("GitHub stars");
        await expect(published).toContainText(`${STARS_TODAY.toLocaleString("en-US")} stars`);
        await expect(published).toContainText("Verified");
        await expect(published.getByRole("link", { name: "How it is counted for GitHub stars" })).toHaveAttribute(
          "href",
          "/docs/architecture/public-metrics#github-stars",
        );

        // Providers as icons with their names, and only the provider behind a published value.
        await expect(publicPage.getByRole("img", { name: "GitHub", exact: true })).toBeVisible();
        await expect(publicPage.getByRole("img", { name: "Vercel", exact: true })).toHaveCount(0);

        // One history chart per published metric (#344), with a text alternative, the last 30 days
        // stated in words beside it, and the values as a table. Each metric in the section has its
        // own level 3 heading, so the charts are counted against those headings; the fixture
        // publishes one metric with history.
        const history = publicPage.getByRole("region", { name: "History" });
        const metrics = history.getByRole("heading", { level: 3 });
        await expect(metrics).toHaveText(["GitHub stars"]);
        const metricCount = await metrics.count();
        await expect(history.getByRole("figure")).toHaveCount(metricCount);
        await expect(history.getByRole("img")).toHaveCount(metricCount);
        // The two windows differ in the fixture's 35 days of stars: the 90 day history starts with
        // days that have no value and its first value is the oldest reading, 14 stars, while the
        // last 30 days have a value every day, so that sentence ends after the lowest value. The
        // 30 day start is left loose because it moves with the hour the run starts (the fixture
        // stamps earlier days at 23:00 UTC).
        await expect(
          history.getByRole("img", { name: /^GitHub stars, last 90 days: from 14 stars on \d{4}-\d{2}-\d{2} to 1,204 stars on .*\. \d+ days have no value\.$/ }),
        ).toBeVisible();
        await expect(
          history.getByText(
            /^GitHub stars, last 30 days: from \S+ stars on \d{4}-\d{2}-\d{2} to 1,204 stars on \d{4}-\d{2}-\d{2}\. Highest 1,204 stars on \d{4}-\d{2}-\d{2}, lowest \S+ stars on \d{4}-\d{2}-\d{2}\.$/,
          ),
        ).toBeVisible();

        const milestones = publicPage.getByRole("region", { name: "Milestones" });
        await expect(milestones).toContainText("Reached 100 GitHub stars");
        await expect(milestones).toContainText("Reached 1,000 GitHub stars");

        // Deployments are stored but not published, so nothing about them shows. Nor do account names.
        const text = await publicPage.locator("main").innerText();
        expect(text).not.toContain("Deployment");
        expect(text).not.toContain("example-org");

        const scan = await new AxeBuilder({ page: publicPage }).analyze();
        expect(scan.violations).toEqual([]);

        // Keyboard: the table behind a chart opens from its summary with Enter.
        const summary = publicPage.getByText("Show the values as a table").first();
        await summary.focus();
        await expect(summary).toBeFocused();
        await publicPage.keyboard.press("Enter");
        await expect(publicPage.getByRole("table", { name: "GitHub stars: daily values for the last 90 days" })).toBeVisible();
        await publicPage.keyboard.press("Tab");
        await expect(publicPage.getByRole("region", { name: "GitHub stars, last 90 days, values" })).toBeFocused();
      });

      const sitemap = await readPublic(baseURL, "/sitemap.xml");
      expect(sitemap.status).toBe(200);
      expect(sitemap.body).toContain(`${address}</loc>`);
      // The route behind the address never answers under its own path.
      expect((await readPublic(baseURL, `/p/${workspace.slug}/acme-web`)).status).toBe(404);

      await settings.getByRole("button", { name: "Turn off the project page" }).click();
      await expect(page.getByRole("status").filter({ hasText: "The project page is off. Its address now answers page not found." })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Project page" })).toBeFocused();
      await expect(settings).toContainText(`Off. Its address, ${address}, answers page not found.`);

      // Off: the next request answers 404, the same page as an address that never existed.
      await asStranger(browser, baseURL, address, expectNotFound);
      await asStranger(browser, baseURL, `/@${workspace.slug}/no-such-page`, expectNotFound);
      // A slug longer than any page can have answers the same 404, refused before any query.
      await asStranger(browser, baseURL, `/@${workspace.slug}/${"a".repeat(41)}`, expectNotFound);
      expect((await readPublic(baseURL, "/sitemap.xml")).body).not.toContain(address);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("keeps a page offline until something is published, and out of search when asked", async ({ browser, baseURL }) => {
    if (baseURL === undefined) throw new Error("baseURL is not configured");
    const workspace = await createTestWorkspace("Project page empty");
    try {
      const projectId = await seedProjectWithHistory(workspace);
      const address = `/@${workspace.slug}/acme-web`;
      await turnOnPage(workspace, projectId, "acme-web", false);

      // On, but nothing published: the same 404.
      await asStranger(browser, baseURL, address, expectNotFound);

      await publishStars(workspace, projectId);
      await asStranger(browser, baseURL, address, async (publicPage, status) => {
        expect(status).toBe(200);
        await expect(publicPage.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
      });
      expect((await readPublic(baseURL, "/sitemap.xml")).body).not.toContain(address);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("past 200 included accounts, shows no number anywhere and keeps the owner's controls", async ({ page, browser, baseURL }) => {
    if (baseURL === undefined) throw new Error("baseURL is not configured");
    const workspace = await createTestWorkspace("Project page many accounts");
    try {
      const projectId = await seedProjectWithHistory(workspace);
      await publishStars(workspace, projectId);
      await turnOnPage(workspace, projectId, "acme-web", false);
      // Two accounts from the history seed plus 199: one past the bound (#220).
      await seedIncludedAccounts(workspace, projectId, 199);

      // A visitor gets the page's error, never a number computed from part of the accounts.
      await asStranger(browser, baseURL, `/@${workspace.slug}/acme-web`, async (publicPage) => {
        await expect(publicPage.getByRole("heading", { level: 1, name: "This project page could not be loaded" })).toBeVisible();
        await expect(publicPage.getByRole("button", { name: "Try again" })).toBeVisible();
        await expect(publicPage.getByText(STARS_TODAY.toLocaleString("en-US"))).toHaveCount(0);
      });

      // The owner keeps the settings page, with the reason and the control to unpublish.
      await page.goto(settingsPath(workspace, projectId));
      const metrics = page.getByRole("region", { name: "Metrics from your connected providers" });
      await expect(metrics).toContainText("These metrics cannot be computed");
      await expect(metrics).toContainText("This project has more than 200 included accounts");
      await expect(metrics.getByRole("link", { name: "Connections" })).toHaveAttribute("href", `/w/${workspace.slug}/connections`);
      await expect(metrics.getByRole("listitem").filter({ hasText: "GitHub stars" }).first()).toContainText(
        "Now: Not computed: too many accounts",
      );
      await expect(metrics.getByRole("button", { name: "Unpublish GitHub stars", exact: true })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("answers 429 past the public rate limit that badges and cards share, and renders under it", async ({ browser, baseURL }) => {
    // Up to two spends of the limit and a page render or three: slower than most tests.
    ownerTest.slow();
    if (baseURL === undefined) throw new Error("baseURL is not configured");
    const { workspace } = await createPublicPageWorkspace("Project page rate limit");
    // A client address of its own (documentation range), so no other test or person shares the
    // count. Reached directly, the app reads the client from x-forwarded-for (clientIp in
    // src/lib/public-metrics/requests.ts), which Next.js keeps when the client sends it.
    const client = `2001:db8::${randomBytes(4).toString("hex").replace(/(.{4})(.{4})/, "$1:$2")}`;
    const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { "x-forwarded-for": client } });
    // The limit is 120 a minute (PUBLIC_REQUESTS_PER_MINUTE, in a server-only module this spec cannot
    // import). A spend that a new minute interrupts restarts the count, so one spend may need up to
    // two minutes' worth plus one, and a margin of one.
    const spendBound = 2 * 120 + 2;
    /** Spends the address's count for this minute on badges, which a malformed project id answers without another read. */
    async function spendOnBadges(): Promise<void> {
      let status = 0;
      for (let sent = 0; status !== 429 && sent < spendBound; sent += 1) {
        status = (await context.request.get("/badge/not-a-project/github-stars.svg", { headers: { "x-forwarded-for": client } })).status();
      }
      expect(status).toBe(429);
    }
    try {
      const address = `/@${workspace.slug}/acme-web`;
      const publicPage = await context.newPage();
      const under = await publicPage.goto(address);
      expect(under?.status()).toBe(200);
      await expect(publicPage.getByRole("heading", { level: 1 })).toHaveText("Acme web");

      // The page is refused from the same address. When a new minute began between the last badge
      // and the page, that minute is spent on badges too, once: the next rollover is a minute away.
      await spendOnBadges();
      let limited = await publicPage.goto(address);
      if (limited?.status() !== 429) {
        await spendOnBadges();
        limited = await publicPage.goto(address);
      }
      expect(limited?.status()).toBe(429);
      const headers = limited?.headers() ?? {};
      expect(Number(headers["retry-after"])).toBeGreaterThanOrEqual(1);
      expect(Number(headers["retry-after"])).toBeLessThanOrEqual(60);
      expect(headers["cache-control"]).toBe("no-store");
      expect(headers["content-security-policy"]).toContain("default-src 'self'");
      await expect(publicPage).toHaveTitle("Too many requests · StackDash");
      await expect(publicPage.getByRole("heading", { level: 1, name: "Too many requests from this address" })).toBeVisible();
      await expect(publicPage.getByText(/Try again in \d+ seconds?, when the next minute starts\./)).toBeVisible();
      await expect(publicPage.getByRole("link", { name: "Go to the home page" })).toHaveAttribute("href", "/");
      await expectNoAxeViolations(publicPage);
      // Keyboard only: the one control is reachable and leads home.
      await publicPage.keyboard.press("Tab");
      await expect(publicPage.getByRole("link", { name: "Go to the home page" })).toBeFocused();
      await publicPage.keyboard.press("Enter");
      await expect(publicPage).toHaveURL(`${baseURL}/`);

      // Any other address is still under its own limit and gets the page.
      expect((await readPublic(baseURL, address)).status).toBe(200);
    } finally {
      await context.close();
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("explains a refused address and works with the keyboard alone", async ({ page }) => {
    const workspace = await createTestWorkspace("Project page form");
    try {
      const projectId = await seedProjectWithHistory(workspace);
      const { data: other, error } = await adminClient()
        .from("projects")
        .insert({ workspace_id: workspace.id, name: "Acme docs" })
        .select("id")
        .single();
      if (error) throw new Error(`Seeding a project failed (code ${error.code}).`);
      await turnOnPage(workspace, other.id, "taken", false);

      const live = watchLiveRefresh(page, workspace.id);
      await page.goto(settingsPath(workspace, projectId));
      const settings = page.getByRole("region", { name: "Project page" });
      const slug = settings.getByLabel("Address");

      await slug.fill("Acme Web");
      await settings.getByRole("button", { name: "Turn on the project page" }).click();
      await expect(slug).toHaveAttribute("aria-invalid", "true");
      await expect(slug).toHaveAccessibleDescription(/Use lowercase letters and numbers, with single hyphens between words\./);
      await expect(slug).toBeFocused();

      await slug.fill("taken");
      await settings.getByRole("button", { name: "Turn on the project page" }).click();
      await expect(slug).toHaveAccessibleDescription(/Another project in this workspace uses this address\. Choose another one\./);

      // Keyboard only: address, then the indexing choice, then the button.
      await slug.fill("acme-web");
      await page.keyboard.press("Tab");
      await expect(settings.getByLabel("Let search engines index this page")).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(settings.getByRole("button", { name: "Turn on the project page" })).toBeFocused();
      // Turning the page on records an activity event, so a live refresh follows the action's own.
      const liveRefresh = await live.next();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status").filter({ hasText: `The project page is on at /@${workspace.slug}/acme-web.` })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Project page" })).toBeFocused();

      await liveRefresh();
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

ownerTest.describe("workspace handles as the owner", () => {
  ownerTest("claims a handle in settings with the keyboard, and explains a refused one", async ({ page }) => {
    const { workspace, projectId } = await createPublicPageWorkspace("Handle settings");
    const other = await createTestWorkspace("Handle taken");
    try {
      // Workspace slugs are random, so handles built from them never collide between runs.
      const handle = `acme-${workspace.slug}`;
      const taken = `taken-${other.slug}`;
      await claimHandle(other, taken);

      await page.goto(`/w/${workspace.slug}/settings`);
      const section = page.getByRole("region", { name: "Public handle" });
      await expect(section).toContainText(`No handle yet. Public project pages open at /@${workspace.slug}/ followed by the page address.`);
      const field = section.getByRole("textbox", { name: "Handle" });
      const save = section.getByRole("button", { name: "Save handle" });
      await expect(field).toHaveAccessibleDescription(/3 to 32 characters: lowercase letters, numbers, and single hyphens between words\./);

      // Each refusal is tied to the field and moves focus back to it.
      for (const [input, message] of [
        ["ab", "Use at least 3 characters."],
        ["docs", "This handle is reserved. Choose another one."],
        [taken, "Another workspace uses this handle. Choose another one."],
      ] as const) {
        await field.fill(input);
        await save.click();
        await expect(field).toHaveAttribute("aria-invalid", "true");
        await expect(field).toHaveAccessibleDescription(new RegExp(message.replaceAll(".", "\\.")));
        await expect(field).toBeFocused();
        await expect(page.getByRole("alert").filter({ hasText: `The handle was not saved. ${message}` })).toBeVisible();
      }

      // Keyboard only: the field, then Save handle. Capitals and spaces are tidied, not refused.
      await field.fill(`  ${handle.toUpperCase()} `);
      await page.keyboard.press("Tab");
      await expect(save).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status").filter({ hasText: `Saved. Public project pages now open at /@${handle}/ followed by the page address.` })).toBeVisible();
      await expect(field).toHaveValue(handle);
      await expect(field).not.toHaveAttribute("aria-invalid", "true");
      await expect(section).toContainText(`Public project pages open at /@${handle}/ followed by the page address. Addresses with the workspace ID lead there too.`);
      await page.keyboard.press("Tab");
      await expect(section.getByRole("button", { name: "Remove handle" })).toBeFocused();
      await expectNoAxeViolations(page);

      // The publishing page links to the handle address.
      await page.goto(settingsPath(workspace, projectId));
      const pageSettings = page.getByRole("region", { name: "Project page" });
      await expect(pageSettings.getByRole("link", { name: `/@${handle}/acme-web` })).toHaveAttribute("href", `/@${handle}/acme-web`);
      await expect(pageSettings).toContainText(`The page opens at /@${handle}/ followed by this.`);

      // Changing it asks first. Escape keeps the handle and returns focus to Save handle.
      const renamed = `acme-two-${workspace.slug}`;
      await page.goto(`/w/${workspace.slug}/settings`);
      await field.fill(renamed);
      await field.press("Enter");
      const change = page.getByRole("dialog", { name: `Change the handle to ${renamed}?` });
      await expect(change).toBeVisible();
      await expect(change).toHaveAccessibleDescription(
        `Links that use /@${handle}/ stop working at once, and any workspace can claim ${handle}. Public project pages will open at /@${renamed}/ instead.`,
      );
      await expect(change.getByRole("button", { name: "Cancel" })).toBeFocused();
      await expectNoAxeViolations(page);
      await page.keyboard.press("Escape");
      await expect(change).toBeHidden();
      await expect(save).toBeFocused();
      await expect(section).toContainText(`Public project pages open at /@${handle}/ followed by the page address.`);
      await save.click();
      await change.getByRole("button", { name: "Change handle" }).click();
      await expect(page.getByRole("status").filter({ hasText: `Saved. Public project pages now open at /@${renamed}/ followed by the page address.` })).toBeVisible();
      await expect(section).toContainText(`Public project pages open at /@${renamed}/ followed by the page address.`);

      // Removing it asks too. Cancel returns focus to the button; after removing, focus stays in the
      // section and the workspace ID address is back.
      const removeButton = section.getByRole("button", { name: "Remove handle" });
      await removeButton.click();
      const remove = page.getByRole("dialog", { name: `Remove the handle ${renamed}?` });
      await expect(remove).toHaveAccessibleDescription(
        `Links that use /@${renamed}/ stop working at once, and any workspace can claim ${renamed}. Public project pages go back to the workspace ID address, /@${workspace.slug}/.`,
      );
      await remove.getByRole("button", { name: "Cancel" }).click();
      await expect(remove).toBeHidden();
      await expect(removeButton).toBeFocused();
      await removeButton.click();
      await remove.getByRole("button", { name: "Remove handle" }).click();
      await expect(
        page.getByRole("status").filter({ hasText: `Removed the handle. Public project pages open at /@${workspace.slug}/ followed by the page address again.` }),
      ).toBeVisible();
      await expect(field).toBeFocused();
      await expect(field).toHaveValue("");
      await expect(removeButton).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
      await deleteTestWorkspace(other);
    }
  });

  ownerTest("answers at the handle address, sends the ID address there, and frees a changed handle", async ({ browser, baseURL }) => {
    if (baseURL === undefined) throw new Error("baseURL is not configured");
    const { workspace } = await createPublicPageWorkspace("Handle address");
    const other = await createTestWorkspace("Handle other");
    try {
      const handle = `acme-${workspace.slug}`;
      const otherHandle = `other-${other.slug}`;
      await claimHandle(workspace, handle);
      await claimHandle(other, otherHandle);

      await asStranger(browser, baseURL, `/@${handle}/acme-web`, async (publicPage, status) => {
        expect(status).toBe(200);
        await expect(publicPage.getByRole("heading", { level: 1 })).toHaveText("Acme web");
      });

      // The ID address answers a temporary redirect to the handle address, query string kept.
      expect(await readRedirect(baseURL, `/@${workspace.slug}/acme-web?ref=readme`)).toEqual({
        status: 307,
        location: `/@${handle}/acme-web?ref=readme`,
      });
      await asStranger(browser, baseURL, `/@${workspace.slug}/acme-web`, async (publicPage, status) => {
        expect(status).toBe(200);
        expect(new URL(publicPage.url()).pathname).toBe(`/@${handle}/acme-web`);
      });

      // Another workspace's handle with this page answers exactly like a handle nobody has.
      await asStranger(browser, baseURL, `/@${otherHandle}/acme-web`, expectNotFound);
      await asStranger(browser, baseURL, `/@nobody-${workspace.slug}/acme-web`, expectNotFound);
      // An address with no page never redirects, so it never reveals a handle.
      expect(await readRedirect(baseURL, `/@${workspace.slug}/no-such-page`)).toEqual({ status: 404, location: null });

      // A changed handle stops answering at once, and another workspace may claim it straight away.
      const renamed = `acme-two-${workspace.slug}`;
      await claimHandle(workspace, renamed);
      await claimHandle(other, handle);
      await asStranger(browser, baseURL, `/@${handle}/acme-web`, expectNotFound);
      expect((await readPublic(baseURL, `/@${renamed}/acme-web`)).status).toBe(200);

      // Without a handle the ID address answers the page itself again.
      const { data, error } = await adminClient().rpc("remove_workspace_handle", {
        p_workspace_id: workspace.id,
        p_actor_id: workspace.ownerId,
      });
      if (error) throw new Error(`Removing the handle failed (code ${error.code}).`);
      expect(data).toBe("removed");
      expect(await readRedirect(baseURL, `/@${workspace.slug}/acme-web`)).toEqual({ status: 200, location: null });
      await asStranger(browser, baseURL, `/@${renamed}/acme-web`, expectNotFound);
    } finally {
      await deleteTestWorkspace(workspace);
      await deleteTestWorkspace(other);
    }
  });
});

viewerTest.describe("project pages as a viewer", () => {
  viewerTest("sees whether the page is on and no controls", async ({ page }) => {
    const workspace = await createTestWorkspace("Project page viewer");
    try {
      const projectId = await seedProjectWithHistory(workspace);
      await publishStars(workspace, projectId);
      await turnOnPage(workspace, projectId, "acme-web", false);

      await page.goto(settingsPath(workspace, projectId));
      const settings = page.getByRole("region", { name: "Project page" });
      await expect(settings).toContainText(`On. Anyone can open it at /@${workspace.slug}/acme-web.`);
      await expect(settings).toContainText("It asks search engines not to index it.");
      await expect(settings.getByRole("button")).toHaveCount(0);
      await expect(settings.getByLabel("Address")).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  viewerTest("sees the workspace's handle and why they cannot change it", async ({ page }) => {
    const workspace = await createTestWorkspace("Handle viewer");
    try {
      const handle = `acme-${workspace.slug}`;
      await claimHandle(workspace, handle);

      await page.goto(`/w/${workspace.slug}/settings`);
      const section = page.getByRole("region", { name: "Public handle" });
      await expect(section).toContainText(`Public project pages open at /@${handle}/ followed by the page address.`);
      await expect(section).toContainText("Only owners and admins can change this workspace's handle.");
      await expect(section.getByRole("textbox")).toHaveCount(0);
      await expect(section.getByRole("button")).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
