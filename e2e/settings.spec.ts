import type { Page } from "@playwright/test";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import {
  activeApiKeyCount,
  adminClient,
  createTestWorkspace,
  deleteTestWorkspace,
  seedApiKeys,
  type TestWorkspace,
} from "./fixtures/db";

// Each test renames its own workspace, so tests never see each other's names.

ownerTest.describe("renaming a workspace as the owner", () => {
  ownerTest("saves a new name, keeps the URL, and updates the switcher", async ({ page }) => {
    const workspace = await createTestWorkspace("Rename");
    try {
      const settingsUrl = `/w/${workspace.slug}/settings`;
      await page.goto(settingsUrl);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");

      const newName = `Renamed ${workspace.slug}`;
      const field = page.getByLabel("Workspace name");
      await expect(field).toHaveValue(workspace.name);
      await field.fill(`  ${newName}  `);
      await page.getByRole("button", { name: "Save name" }).click();

      await expect(page.getByRole("status").filter({ hasText: "Workspace renamed." })).toBeVisible();
      await expect(page.getByRole("button", { name: `Workspace: ${newName}` })).toBeVisible();
      await expect(page).toHaveURL(new RegExp(`${settingsUrl}$`));

      await page.reload();
      await expect(page.getByLabel("Workspace name")).toHaveValue(newName);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("rejects an empty name and an 81 character name, and accepts 80", async ({ page }) => {
    const workspace = await createTestWorkspace("Rename bounds");
    try {
      await page.goto(`/w/${workspace.slug}/settings`);
      const field = page.getByLabel("Workspace name");
      const save = page.getByRole("button", { name: "Save name" });

      await field.fill("   ");
      await save.click();
      await expect(field).toHaveAttribute("aria-invalid", "true");
      await expect(field).toHaveAccessibleDescription(/Enter a workspace name\./);
      await expect(page.getByRole("alert").filter({ hasText: "The name was not saved." })).toBeVisible();

      await field.fill("a".repeat(81));
      await save.click();
      await expect(field).toHaveAccessibleDescription(/Use 80 characters or fewer\./);
      // The rejected value stays in the field so it can be corrected.
      await expect(field).toHaveValue("a".repeat(81));

      await field.fill("b".repeat(80));
      await save.click();
      await expect(page.getByRole("status").filter({ hasText: "Workspace renamed." })).toBeVisible();
      await expect(field).not.toHaveAttribute("aria-invalid", "true");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("keeps focus on Save name through a keyboard save and blocks a second save while pending", async ({ page }) => {
    const workspace = await createTestWorkspace("Rename focus");
    try {
      const settingsUrl = `/w/${workspace.slug}/settings`;
      // Hold the Server Action request, so the pending state can be checked before it settles.
      const { promise: held, resolve: release } = Promise.withResolvers<void>();
      let saves = 0;
      await page.route(new RegExp(`${settingsUrl}$`), async (route) => {
        if (route.request().method() !== "POST") return route.fallback();
        saves += 1;
        await held;
        return route.fallback();
      });
      await page.goto(settingsUrl);
      await page.getByLabel("Workspace name").fill(`Kept focus ${workspace.slug}`);
      const save = page.getByRole("button", { name: "Save name" });
      await save.focus();
      await page.keyboard.press("Enter");

      // Pending: announced as unavailable, still focused, and a second Enter sends nothing.
      const saving = page.getByRole("button", { name: "Saving" });
      await expect(saving).toHaveAttribute("aria-disabled", "true");
      await expect(saving).toBeFocused();
      await page.keyboard.press("Enter");
      release();

      await expect(page.getByRole("status").filter({ hasText: "Workspace renamed." })).toBeVisible();
      await expect(save).not.toHaveAttribute("aria-disabled");
      await expect(save).toBeFocused();
      expect(saves).toBe(1);
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

viewerTest.describe("renaming a workspace as a viewer", () => {
  viewerTest("shows the name and the reason, with no form", async ({ page }) => {
    const workspace = await createTestWorkspace("Viewer rename");
    try {
      await page.goto(`/w/${workspace.slug}/settings`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Settings");

      // Scoped to main: the header switcher shows the name too.
      await expect(page.getByRole("main").getByText(workspace.name, { exact: true })).toBeVisible();
      await expect(page.getByText("Only owners and admins can rename this workspace.")).toBeVisible();
      await expect(page.getByLabel("Workspace name")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Save name" })).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

// The one-step assistant key in Settings, AI assistants (#254). Each test makes its own workspace.

const KEY_PATTERN = /^sd_[A-Za-z0-9_-]{43}$/;
const LIMIT_MESSAGE =
  "This workspace already has 20 keys that are not revoked. Revoke one you no longer use, then create the new one.";

function assistantsSection(page: Page) {
  return page.getByRole("region", { name: "AI assistants" });
}

async function setViewerRole(workspace: TestWorkspace, role: "admin" | "viewer"): Promise<void> {
  const { error } = await adminClient()
    .from("workspace_members")
    .update({ role })
    .eq("workspace_id", workspace.id)
    .eq("user_id", workspace.viewerId);
  if (error) throw new Error(`Setting the viewer's role failed (code ${error.code}).`);
}

/** Presses the focused "Create assistant key", then returns the key the section shows once. */
async function createAssistantKey(page: Page): Promise<string> {
  const section = assistantsSection(page);
  await expect(section.getByRole("button", { name: "Create assistant key" })).toBeFocused();
  await page.keyboard.press("Enter");
  // Focus moves to the one-time key so it is the next thing read.
  await expect(section.getByRole("heading", { name: "Copy the key for AI assistant now" })).toBeFocused();
  await expect(section.getByRole("status")).toHaveText("Created the key AI assistant.");
  const key = await section.getByLabel("API key", { exact: true }).inputValue();
  expect(key).toMatch(KEY_PATTERN);
  return key;
}

ownerTest.describe("creating an assistant key as the owner", () => {
  ownerTest("creates a key with every scope in one action and fills it into the snippets", async ({ page, request }) => {
    const workspace = await createTestWorkspace("Assistant key");
    try {
      await page.goto(`/w/${workspace.slug}/settings`);
      const section = assistantsSection(page);
      // Keyboard only: from the guide link, Tab reaches the button.
      await section.getByRole("link", { name: "Read the MCP guide" }).focus();
      await page.keyboard.press("Tab");
      const key = await createAssistantKey(page);

      await expect(section.getByRole("region", { name: "Claude Desktop", exact: true })).toContainText(
        `"AUTH_HEADER": "Bearer ${key}"`,
      );
      await expect(section.getByRole("region", { name: "Other clients", exact: true })).toContainText(
        `Authorization: Bearer ${key}`,
      );
      // These two read the key from STACKDASH_API_KEY, so it never lands in their config.
      await expect(section.getByRole("region", { name: "Claude Code", exact: true })).not.toContainText(key);
      await expect(section.getByRole("region", { name: "Cursor", exact: true })).not.toContainText(key);

      // One key, with every scope, listed under API keys, and it works.
      const { data, error } = await adminClient().from("api_keys").select("name, scopes").eq("workspace_id", workspace.id);
      if (error) throw new Error(`Reading keys failed (code ${error.code}).`);
      expect(data).toEqual([{ name: "AI assistant", scopes: ["usage:read", "events:read", "alerts:read", "connections:read"] }]);
      await expect(
        page.getByRole("region", { name: "API keys" }).getByRole("listitem").filter({ hasText: "AI assistant" }),
      ).toContainText("Reads: Usage and spend, Timeline events, Triggered alerts, Connection status");
      const response = await request.get("/api/v1/workspaces", { headers: { authorization: `Bearer ${key}` } });
      expect(response.status()).toBe(200);
      await expectNoAxeViolations(page);

      // Keyboard through the one-time key: the field, Copy key, Hide key. Hiding it returns focus
      // to the button and puts the placeholders back.
      await page.keyboard.press("Tab");
      await expect(section.getByLabel("API key", { exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(section.getByRole("button", { name: "Copy key" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(section.getByRole("button", { name: "Hide key" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(section.getByRole("button", { name: "Create assistant key" })).toBeFocused();
      await expect(section.getByRole("status")).toHaveText("The new key is hidden. It cannot be shown again.");
      await expect(section.getByRole("region", { name: "Other clients", exact: true })).toContainText("Bearer <your key>");
      await expect(page.getByText(key)).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("creates the 20th key, then refuses the 21st and says how to make room", async ({ page }) => {
    const workspace = await createTestWorkspace("Assistant key limit");
    try {
      await seedApiKeys(workspace, 19);
      await page.goto(`/w/${workspace.slug}/settings`);
      const section = assistantsSection(page);
      await section.getByRole("button", { name: "Create assistant key" }).focus();
      await createAssistantKey(page);
      expect(await activeApiKeyCount(workspace)).toBe(20);

      await section.getByRole("button", { name: "Hide key" }).click();
      await expect(section.getByRole("button", { name: "Create assistant key" })).toBeFocused();
      await page.keyboard.press("Enter");
      // The error summary takes focus so keyboard and screen reader users land on it.
      await expect(page.locator(":focus")).toHaveText(LIMIT_MESSAGE);
      await expect(section.getByRole("heading", { name: "Copy the key for AI assistant now" })).toHaveCount(0);
      await expect(section.getByRole("region", { name: "Other clients", exact: true })).toContainText("Bearer <your key>");
      expect(await activeApiKeyCount(workspace)).toBe(20);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

viewerTest.describe("creating an assistant key as a viewer or admin", () => {
  viewerTest("a viewer gets no button and is told to ask an owner or admin", async ({ page }) => {
    const workspace = await createTestWorkspace("Assistant key viewer");
    try {
      await page.goto(`/w/${workspace.slug}/settings`);
      const section = assistantsSection(page);
      await expect(section).toContainText("Ask an owner or admin of this workspace for an API key for the assistant.");
      await expect(section.getByRole("button", { name: "Create assistant key" })).toHaveCount(0);
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  viewerTest("an admin creates one, and once demoted to viewer the server refuses the next", async ({ page }) => {
    const workspace = await createTestWorkspace("Assistant key admin");
    try {
      await setViewerRole(workspace, "admin");
      await page.goto(`/w/${workspace.slug}/settings`);
      const section = assistantsSection(page);
      await section.getByRole("button", { name: "Create assistant key" }).focus();
      await createAssistantKey(page);
      await section.getByRole("button", { name: "Hide key" }).click();

      // The page still shows the button; the action checks the role again and refuses.
      await setViewerRole(workspace, "viewer");
      await section.getByRole("button", { name: "Create assistant key" }).click();
      await expect(page.locator(":focus")).toHaveText("Only owners and admins can create, see, or revoke API keys.");
      expect(await activeApiKeyCount(workspace)).toBe(1);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
