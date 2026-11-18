import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { expect, ownerTest } from "./fixtures/auth";
import { createTestWorkspace, deleteTestWorkspace, personalWorkspace } from "./fixtures/db";

// A missing item inside a workspace the user belongs to names the item and links to its list
// (#484); a missing or inaccessible workspace keeps the one page that confirms nothing, under any
// path inside it. Each test creates its own workspace, so tests run in any order.

async function expectNotFoundPage(page: Page, heading: string, link: { name: string; href: string }): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(heading);
  await expect(page.getByRole("link", { name: link.name, exact: true })).toHaveAttribute("href", link.href);
  const scan = await new AxeBuilder({ page }).analyze();
  expect(scan.violations).toEqual([]);
}

ownerTest.describe("not found inside a workspace", () => {
  ownerTest("a missing connection says so and links to the workspace's connections", async ({ page }) => {
    const workspace = await createTestWorkspace("Missing connection");
    try {
      await page.goto(`/w/${workspace.slug}/connections/${randomUUID()}`);
      await expectNotFoundPage(page, "We could not find that connection", {
        name: "Open all connections",
        href: `/w/${workspace.slug}/connections`,
      });

      // The link is the way on, by keyboard too.
      await page.getByRole("link", { name: "Open all connections", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`/w/${workspace.slug}/connections`);
      await expect(page.getByRole("heading", { name: "Add a provider" })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("an unknown provider on the connect page says so and links to the connections catalog", async ({ page }) => {
    const workspace = await createTestWorkspace("Unknown provider");
    try {
      const catalog = { name: "Choose a provider", href: `/w/${workspace.slug}/connections` };
      await page.goto(`/w/${workspace.slug}/connections/new/not-a-provider`);
      await expectNotFoundPage(page, "We could not find that provider", catalog);

      // A reconnect link whose connection does not exist answers with the same page.
      await page.goto(`/w/${workspace.slug}/connections/new/github?connection=${randomUUID()}`);
      await expectNotFoundPage(page, "We could not find that provider", catalog);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("a missing project says so and links to the workspace's projects", async ({ page }) => {
    const workspace = await createTestWorkspace("Missing project");
    try {
      const projects = { name: "Open all projects", href: `/w/${workspace.slug}/projects` };
      for (const section of ["achievements", "public-metrics"]) {
        await page.goto(`/w/${workspace.slug}/projects/${randomUUID()}/${section}`);
        await expectNotFoundPage(page, "We could not find that project", projects);
      }
      // A malformed project id is the same answer as an unknown one.
      await page.goto(`/w/${workspace.slug}/projects/not-a-project/achievements`);
      await expectNotFoundPage(page, "We could not find that project", projects);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("a missing or inaccessible workspace keeps the workspace's page under every item path", async ({ page }) => {
    const workspace = await createTestWorkspace("Inaccessible workspace");
    try {
      // The viewer's personal workspace exists, and the owner is not a member of it.
      const inaccessible = (await personalWorkspace(workspace.viewerId)).slug;
      for (const slug of ["zzzzzzzzzzzzzzzz", inaccessible]) {
        for (const path of [
          `/w/${slug}/connections/${randomUUID()}`,
          `/w/${slug}/connections/new/github`,
          `/w/${slug}/projects/${randomUUID()}/achievements`,
          `/w/${slug}/projects/${randomUUID()}/public-metrics`,
        ]) {
          await page.goto(path);
          await expectNotFoundPage(page, "We could not find that workspace", { name: "Open your workspaces", href: "/app" });
          await expect(
            page.getByText(
              "The link may be mistyped, or you may not be a member of this workspace. Check the address, or ask a workspace owner to invite you. You can open any workspace you already belong to.",
            ),
          ).toBeVisible();
        }
      }
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
