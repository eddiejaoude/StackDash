import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, notDueForAMonth, seededKey, type TestWorkspace } from "./fixtures/db";
import { tabTo } from "./fixtures/keyboard";
import { EVIDENCE, HIDE_DEV_INDICATOR } from "./fixtures/webhook-panel";

/*
 * The Timeline's first-run setup checklist (#674): four steps read from the workspace's own state,
 * each linking to the control that completes it, denied reasons for a viewer, and a hide that is
 * per member and survives a reload.
 */

const STEPS = [
  { title: "Connect a provider", link: "Go to Connections", href: (slug: string) => `/w/${slug}/connections` },
  { title: "Choose where alerts go", link: "Go to alert settings", href: (slug: string) => `/w/${slug}/alerts/settings#alert-emails` },
  { title: "Connect your assistant", link: "Go to AI assistants", href: (slug: string) => `/w/${slug}/settings#assistants-title` },
  { title: "Share a badge", link: "Go to Projects", href: (slug: string) => `/w/${slug}/projects` },
] as const;

function checklist(page: Page): Locator {
  return page.getByRole("region", { name: "Set up this workspace" });
}

function step(page: Page, title: string): Locator {
  return checklist(page).getByRole("listitem").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
}

async function expectStatus(page: Page, title: string, status: "Done" | "To do"): Promise<void> {
  await expect(step(page, title).getByText(status, { exact: true })).toBeVisible();
}

async function dismissalCount(workspace: TestWorkspace): Promise<number> {
  const { count, error } = await adminClient()
    .from("onboarding_checklist_dismissals")
    .select("user_id", { count: "exact", head: true })
    .eq("workspace_id", workspace.id);
  if (error) throw new Error(`Counting dismissals failed (code ${error.code}).`);
  return count ?? 0;
}

/** A named element screenshot for the pull request (PW_PR_EVIDENCE=1). */
async function capture(of: Locator, name: string): Promise<void> {
  if (!EVIDENCE) return;
  await of.screenshot({ path: `pr-evidence/after/${name}.png`, animations: "disabled", style: HIDE_DEV_INDICATOR });
}

/** One synthetic Vercel deploy on the workspace's connection, so the Timeline shows its feed. */
async function seedEvent(workspace: TestWorkspace): Promise<void> {
  const admin = adminClient();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .select("id")
    .eq("workspace_id", workspace.id)
    .single();
  if (connectionError) throw new Error(`Reading the connection failed (code ${connectionError.code}).`);
  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_id: "team_checklist",
      display_name: "Checklist team",
      kind: "team",
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  const { error } = await admin.from("activity_events").insert({
    workspace_id: workspace.id,
    connection_id: connection.id,
    external_account_id: account.id,
    provider: "vercel",
    type_id: "vercel.deployment_ready",
    severity: "info",
    title: "Checklist deploy ready",
    body: "Synthetic deploy",
    occurred_at: new Date().toISOString(),
    dedupe_key: `e2e-checklist-${randomUUID()}`,
  });
  if (error) throw new Error(`Seeding an event failed (code ${error.code}).`);
}

/** Sets up each step the way the app records it: a connection, a channel, an assistant key, and a badge. */
async function completeEveryStep(workspace: TestWorkspace): Promise<void> {
  const admin = adminClient();
  const { error: connectionError } = await admin.from("connections").insert({
    workspace_id: workspace.id,
    provider: "vercel",
    status: "active",
    granted_at: new Date().toISOString(),
    display_name: "Checklist Vercel",
    poll_interval_seconds: 3600,
    next_sync_at: notDueForAMonth(),
  });
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);

  // The channel's sealed URL is never read here, so placeholder bytes stand in for the ciphertext.
  const { error: channelError } = await admin.rpc("create_notification_destination", {
    p_id: randomUUID(),
    p_workspace_id: workspace.id,
    p_kind: "discord",
    p_name: "#checklist",
    p_url_host: "discord.com",
    p_all_rules: true,
    p_digest: "off",
    p_rule_ids: [],
    p_key_id: "e2e",
    p_iv: "\\x00",
    p_ciphertext: "\\x01",
    p_auth_tag: "\\x02",
    p_created_by: workspace.ownerId,
  });
  if (channelError) throw new Error(`Seeding a channel failed (code ${channelError.code}).`);

  const { token_hash, token_prefix } = seededKey();
  const { error: keyError } = await admin.from("api_keys").insert({
    workspace_id: workspace.id,
    name: "AI assistant",
    token_hash,
    token_prefix,
    scopes: ["usage:read"],
    created_by: workspace.ownerId,
  });
  if (keyError) throw new Error(`Seeding the assistant key failed (code ${keyError.code}).`);

  const { data: project, error: projectError } = await admin
    .from("projects")
    .insert({ workspace_id: workspace.id, name: "Checklist project" })
    .select("id")
    .single();
  if (projectError) throw new Error(`Seeding a project failed (code ${projectError.code}).`);
  const { error: publishError } = await admin.from("published_metrics").insert({
    workspace_id: workspace.id,
    project_id: project.id,
    metric_id: "stripe-customers-30d",
    published_by: workspace.ownerId,
  });
  if (publishError) throw new Error(`Seeding a published metric failed (code ${publishError.code}).`);
}

/**
 * With every step set up and an event in the feed, the panel sits above the populated Timeline at
 * each width the Timeline's own specs use, and nothing scrolls sideways. A viewer's denied reasons
 * are the longest text the panel holds. The 375px state is captured in context for the PR.
 */
async function expectFitsAboveTheFeed(page: Page, workspace: TestWorkspace, evidence: string): Promise<void> {
  for (const width of [1280, 375, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/w/${workspace.slug}/timeline`);
    await expect(checklist(page)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Checklist deploy ready", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    // The whole page, so the sticky workspace header sits at the top as it does on a phone.
    if (width === 375 && EVIDENCE) {
      await page.screenshot({ path: `pr-evidence/after/${evidence}.png`, fullPage: true, animations: "disabled", style: HIDE_DEV_INDICATOR });
    }
  }
}

ownerTest.describe("setup checklist as the owner", () => {
  ownerTest("lists four steps to do, each linking to its control, from the keyboard", async ({ page }) => {
    const workspace = await createTestWorkspace("Checklist empty");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(checklist(page).getByRole("listitem")).toHaveCount(STEPS.length);
      for (const { title, link, href } of STEPS) {
        await expectStatus(page, title, "To do");
        await expect(step(page, title).getByRole("link", { name: link })).toHaveAttribute("href", href(workspace.slug));
      }
      await capture(checklist(page), "checklist-owner-to-do");

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      // From the heading, the hide button and then every step's link, one Tab each.
      await page.getByRole("heading", { level: 1, name: "Timeline" }).focus();
      await tabTo(page, checklist(page).getByRole("button", { name: "Hide checklist" }), 1);
      for (const { link } of STEPS) await tabTo(page, checklist(page).getByRole("link", { name: link }), 1);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`/w/${workspace.slug}/projects`);

      // The AI assistants section streams in behind Suspense: arriving on its link still lands on
      // its heading, scrolled into view and focused.
      await page.goto(`/w/${workspace.slug}/timeline`);
      await checklist(page).getByRole("link", { name: "Go to AI assistants" }).click();
      await expect(page).toHaveURL(`/w/${workspace.slug}/settings#assistants-title`);
      const assistants = page.getByRole("heading", { level: 2, name: "AI assistants", exact: true });
      await expect(assistants).toBeFocused();
      await expect(assistants).toBeInViewport();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("marks each step done from the workspace's state and keeps its link", async ({ page }) => {
    const workspace = await createTestWorkspace("Checklist done");
    try {
      await completeEveryStep(workspace);
      await page.goto(`/w/${workspace.slug}/timeline`);
      // A connection whose first sync has not run: the panel sits above "Events are on their way".
      await expect(page.getByRole("heading", { name: "Events are on their way" })).toBeVisible();
      for (const { title, link, href } of STEPS) {
        await expectStatus(page, title, "Done");
        await expect(step(page, title).getByRole("link", { name: link })).toHaveAttribute("href", href(workspace.slug));
      }
      await capture(checklist(page), "checklist-owner-done");

      // And above the feed once an event has arrived.
      await seedEvent(workspace);
      await page.reload();
      await expect(page.getByRole("heading", { name: "Checklist deploy ready", exact: true })).toBeVisible();
      await expectStatus(page, "Share a badge", "Done");

      // The member's own alert email setting counts as well as a channel.
      const admin = adminClient();
      const { error: deleteError } = await admin.from("notification_destinations").delete().eq("workspace_id", workspace.id);
      if (deleteError) throw new Error(`Removing the channel failed (code ${deleteError.code}).`);
      await page.reload();
      await expectStatus(page, "Choose where alerts go", "To do");
      const { error: preferenceError } = await admin
        .from("notification_preferences")
        .insert({ workspace_id: workspace.id, user_id: workspace.ownerId, email_frequency: "daily" });
      if (preferenceError) throw new Error(`Seeding the email setting failed (code ${preferenceError.code}).`);
      await page.reload();
      await expectStatus(page, "Choose where alerts go", "Done");

      // A revoked assistant key and a disconnected provider no longer count.
      const { error: revokeError } = await admin
        .from("api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("workspace_id", workspace.id);
      if (revokeError) throw new Error(`Revoking the key failed (code ${revokeError.code}).`);
      const { error: disconnectError } = await admin
        .from("connections")
        .update({ status: "revoked", next_sync_at: null })
        .eq("workspace_id", workspace.id);
      if (disconnectError) throw new Error(`Disconnecting failed (code ${disconnectError.code}).`);
      await page.reload();
      await expectStatus(page, "Connect your assistant", "To do");
      await expectStatus(page, "Connect a provider", "To do");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("fits above a populated feed at every width", async ({ page }) => {
    const workspace = await createTestWorkspace("Checklist widths");
    try {
      await completeEveryStep(workspace);
      await seedEvent(workspace);
      await expectFitsAboveTheFeed(page, workspace, "timeline-checklist-owner-375");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("hides the checklist for the owner only, across a reload", async ({ page }) => {
    const workspace = await createTestWorkspace("Checklist hide");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      const hide = checklist(page).getByRole("button", { name: "Hide checklist" });
      await hide.focus();
      await page.keyboard.press("Enter");
      await expect(checklist(page)).toHaveCount(0);
      await expect(page.getByRole("heading", { level: 1, name: "Timeline" })).toBeFocused();
      await expectNoAxeViolations(page);

      await page.reload();
      await expect(page.getByRole("heading", { name: "No activity yet" })).toBeVisible();
      await expect(checklist(page)).toHaveCount(0);
      await capture(page.locator("main"), "timeline-checklist-hidden");
      // Only the owner's row: the viewer of this workspace has not hidden it.
      expect(await dismissalCount(workspace)).toBe(1);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

viewerTest.describe("setup checklist as a viewer", () => {
  viewerTest("shows the denied reasons, and still shows after the owner hid it", async ({ page }) => {
    const workspace = await createTestWorkspace("Checklist viewer");
    try {
      const { error } = await adminClient()
        .from("onboarding_checklist_dismissals")
        .insert({ workspace_id: workspace.id, user_id: workspace.ownerId });
      if (error) throw new Error(`Hiding the checklist for the owner failed (code ${error.code}).`);

      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(checklist(page).getByRole("link")).toHaveCount(0);
      await expect(step(page, "Connect a provider")).toContainText("Only owners and admins can connect providers.");
      await expect(step(page, "Choose where alerts go")).toContainText("Only owners and admins can add or change where alerts are posted.");
      await expect(step(page, "Connect your assistant")).toContainText("Only owners and admins can create, see, or revoke API keys.");
      await expect(step(page, "Share a badge")).toContainText("Only owners and admins can publish or unpublish metrics.");
      // API keys are hidden from viewers, so the assistant step claims neither state.
      await expect(step(page, "Connect your assistant").getByText(/^(Done|To do)$/)).toHaveCount(0);
      await expectStatus(page, "Connect a provider", "To do");
      await capture(checklist(page), "checklist-viewer");

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      await checklist(page).getByRole("button", { name: "Hide checklist" }).click();
      await expect(checklist(page)).toHaveCount(0);
      await page.reload();
      await expect(page.getByRole("heading", { name: "No activity yet" })).toBeVisible();
      await expect(checklist(page)).toHaveCount(0);
      expect(await dismissalCount(workspace)).toBe(2);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  viewerTest("fits above a populated feed at every width, with the denied reasons", async ({ page }) => {
    const workspace = await createTestWorkspace("Checklist viewer widths");
    try {
      await completeEveryStep(workspace);
      await seedEvent(workspace);
      await expectFitsAboveTheFeed(page, workspace, "timeline-checklist-viewer-375");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
