import { test, type Page } from "@playwright/test";

import { E2E_USERS, expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, createTestWorkspace, cronSecret, deleteTestWorkspace } from "./fixtures/db";
import { expectTopRowFits } from "./fixtures/header";
import { expectHydrated } from "./fixtures/hydration";
import { tabTo } from "./fixtures/keyboard";
import { combobox, openWith, option, optionsOfKind, palette, resultCount, trigger } from "./fixtures/palette";

// playwright.config.ts names the e2e owner, and only the owner, in STACKDASH_SUPER_ADMIN_EMAILS.

const OWNER_ACCOUNT = `Account: ${E2E_USERS.owner.userName}`;

function adminLink(page: Page) {
  return page.getByRole("banner").getByRole("link", { name: "Admin", exact: true });
}

function accountLink(page: Page) {
  return page.getByRole("banner").getByRole("link", { name: OWNER_ACCOUNT, exact: true });
}

/**
 * Opens the palette, searches "open admin", and takes the Admin page result to the overview. The
 * result is found by label and kind, not by counting: the owner belongs to every spec's test
 * workspace, and one named with "admin" also matches. The Admin page still comes first, because
 * ties keep the list's own order and pages come before workspaces.
 */
async function openAdminFromPalette(page: Page): Promise<void> {
  await openWith(palette(page), () => trigger(page).click());
  await combobox(page).fill("open admin");
  const admin = option(page, "Admin", "Page");
  await expect(admin).toHaveAccessibleDescription("Page");
  await expect(admin).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/app/admin");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Instance overview");
}

ownerTest.describe("the instance overview as a super admin", () => {
  ownerTest("shows each section, counts a new workspace's members and events, and never shows a secret", async ({ page }) => {
    const workspace = await createTestWorkspace("Instance overview");
    try {
      const { error } = await adminClient()
        .from("activity_events")
        .insert(
          [1, 2, 3].map((n) => ({
            workspace_id: workspace.id,
            type_id: "stackdash.daily_summary",
            severity: "info" as const,
            title: "Daily summary",
            occurred_at: new Date(Date.UTC(2026, 10, n)).toISOString(),
            dedupe_key: `admin-overview-${workspace.id}-${n}`,
          })),
        );
      if (error) throw new Error(`Seeding events failed (code ${error.code}).`);

      const response = await page.goto("/app/admin");
      expect(response?.status()).toBe(200);
      await expect(page).toHaveTitle("Instance overview · StackDash");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Instance overview");
      for (const section of ["Usage", "Configuration", "Providers", "Background jobs", "Workspaces", "Deployment"]) {
        await expect(page.getByRole("heading", { level: 2, name: section })).toBeVisible();
      }

      // Newest first, so the workspace this test just made is on the first page: two members
      // (owner and viewer), no connections, three events.
      const row = page.getByRole("region", { name: "Workspace figures" }).getByRole("row").filter({ hasText: workspace.name });
      await expect(row.getByRole("cell")).toHaveText([/./, "2", "0", "3"]);

      const settings = page.getByRole("region", { name: "Settings" });
      await expect(settings.getByRole("row", { name: /Scheduler secret/ })).toContainText("Set");
      await expect(settings.getByRole("row", { name: /Simulated providers/ })).toContainText("On");
      expect(await page.content()).not.toContain(cronSecret());

      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("reaches the overview from the workspace header's Admin link, by keyboard", async ({ page }) => {
    const workspace = await createTestWorkspace("Header link");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(adminLink(page)).toHaveAttribute("href", "/app/admin");
      await expectNoAxeViolations(page);

      await expectHydrated(page);
      await tabTo(page, adminLink(page), 10);
      await expect(adminLink(page)).toHaveCSS("outline-style", "solid");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL("/app/admin");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Instance overview");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("reaches the overview from the command palette as \"open admin\"", async ({ page }) => {
    const workspace = await createTestWorkspace("Palette overview");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openAdminFromPalette(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("keeps the Admin link off a phone's header row, and the palette still reaches the overview there", async ({ page }) => {
    const workspace = await createTestWorkspace("Phone header");
    try {
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(accountLink(page)).toBeVisible();
      await expect(adminLink(page)).toBeHidden();
      await expectTopRowFits(page, OWNER_ACCOUNT);
      await openAdminFromPalette(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  // The link starts at lg: below it, the role badge and the account name leave the workspace
  // switcher too little room beside it (#364).
  ownerTest("shows the Admin link from the lg breakpoint, with the workspace name still in full", async ({ page }) => {
    const workspace = await createTestWorkspace("Header breakpoint");
    try {
      const switcherName = page.getByRole("banner").getByRole("button", { name: /^Workspace: / }).getByText(workspace.name, { exact: true });
      const nameFits = () => switcherName.evaluate((element) => element.scrollWidth <= element.clientWidth);

      await page.setViewportSize({ width: 1023, height: 720 });
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(accountLink(page)).toBeVisible();
      await expect(adminLink(page)).toBeHidden();
      await expectTopRowFits(page, OWNER_ACCOUNT);
      expect(await nameFits()).toBe(true);

      await page.setViewportSize({ width: 1024, height: 720 });
      await expect(adminLink(page)).toBeVisible();
      await expectTopRowFits(page, OWNER_ACCOUNT, { adminLink: true });
      expect(await nameFits()).toBe(true);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

// Headers that would tell /app/admin apart from a missing path: a proxy rewrite shows in both (#374).
const REWRITE_HEADERS = ["x-middleware-rewrite", "x-nextjs-rewritten-path"] as const;

function rewriteHeaders(headers: Record<string, string>): Record<string, string | undefined> {
  return Object.fromEntries(REWRITE_HEADERS.map((name) => [name, headers[name]]));
}

viewerTest("a signed-in user who is not a super admin gets page not found", async ({ page }) => {
  const response = await page.goto("/app/admin");
  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle("Page not found · StackDash");
  await expect(page.getByRole("heading", { level: 1, name: "We could not find that page" })).toBeVisible();
  await expect(page.getByText("Instance overview")).toHaveCount(0);
});

viewerTest("a signed-in user who is not a super admin cannot tell the page from a missing one by its headers", async ({ page }) => {
  for (const headers of [{}, { RSC: "1" }]) {
    const admin = await page.request.get("/app/admin", { headers, maxRedirects: 0 });
    const missing = await page.request.get("/app/no-such-page", { headers, maxRedirects: 0 });
    expect(admin.status()).toBe(404);
    expect(missing.status()).toBe(404);
    expect(rewriteHeaders(admin.headers())).toEqual(rewriteHeaders(missing.headers()));
    expect(rewriteHeaders(admin.headers())).toEqual({ "x-middleware-rewrite": undefined, "x-nextjs-rewritten-path": undefined });
  }
});

ownerTest("the page's own route answers even a super admin as a missing path", async ({ page }) => {
  for (const headers of [{}, { RSC: "1" }]) {
    const route = await page.request.get("/super-admin", { headers, maxRedirects: 0 });
    const missing = await page.request.get("/super-admin/no-such-page", { headers, maxRedirects: 0 });
    expect(route.status()).toBe(404);
    expect(missing.status()).toBe(404);
    expect(rewriteHeaders(route.headers())).toEqual(rewriteHeaders(missing.headers()));
    expect(await route.text()).not.toContain("Instance overview");
  }
});

viewerTest("a signed-in user who is not a super admin is offered no way to the overview", async ({ page }) => {
  const workspace = await createTestWorkspace("Overview hidden");
  try {
    const response = await page.goto(`/w/${workspace.slug}/timeline`);
    // The whole streamed response, HTML and RSC payload, so a link hidden only by style would fail too.
    expect(await response?.text()).not.toContain("/app/admin");
    await expect(page.getByRole("banner").getByRole("link", { name: "Account" })).toBeVisible();
    await expect(adminLink(page)).toHaveCount(0);

    await openWith(palette(page), () => trigger(page).click());
    await combobox(page).fill("admin");
    // By kind: the viewer also belongs to other specs' workspaces, some named with "admin", and no
    // other page's label or keywords hold the word.
    await expect(resultCount(page)).toBeVisible();
    await expect(optionsOfKind(page, "Page")).toHaveCount(0);
  } finally {
    await deleteTestWorkspace(workspace);
  }
});

test("a signed-out visitor is sent to sign in and back", async ({ page }) => {
  await page.goto("/app/admin");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp%2Fadmin$/);
});
