import { openCreateForm } from "./fixtures/alerts";
import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace } from "./fixtures/db";
import { startReceiver, stopReceiver } from "./fixtures/webhook-receiver";

/*
 * Alert channels (#153), end to end: an owner adds a generic webhook channel, sends a test message
 * that reaches a receiver on this machine with a Standard Webhooks signature, and removes the
 * channel, which deletes its sealed URL (the receiver is e2e/fixtures/webhook-receiver.ts).
 * No tick runs here, so it stays in the `chromium` project.
 */

ownerTest.describe("alert channels as the owner", () => {
  ownerTest("adds a webhook, sends a test message to it, and removing it deletes the URL", async ({ page }) => {
    const workspace = await createTestWorkspace("Alert channels");
    const receiver = await startReceiver();
    try {
      await page.goto(`/w/${workspace.slug}/alerts/settings`);
      const channels = page.getByRole("region", { name: "Channels" });
      await expect(channels.getByText("No channels yet")).toBeVisible();

      // Closed until asked for (#343); opening it lands on its first field.
      const form = await openCreateForm(page, "New channel", "Add a channel", channels);
      await expect(form.getByLabel("Where to post")).toBeFocused();
      await form.getByLabel("Where to post").selectOption({ label: "Webhook" });
      await form.getByLabel("Channel name").fill("Ops webhook");
      await form.getByLabel("Webhook URL").fill(receiver.url);
      await form.getByRole("button", { name: "Add channel" }).click();
      await expect(form.getByRole("status")).toContainText("Channel added. Send a test message to check it.");
      // The signing secret is shown once, for the receiver to verify signatures with.
      await expect(form.getByText(/^whsec_/)).toBeVisible();

      const row = channels.getByRole("list", { name: "Channels" }).getByRole("listitem").filter({ hasText: "Ops webhook" });
      await expect(row.getByText("Webhook at 127.0.0.1", { exact: false })).toBeVisible();
      await expect(row.getByText(receiver.url)).toHaveCount(0);
      await expectNoAxeViolations(page);

      const { data: destination, error } = await adminClient()
        .from("notification_destinations")
        .select("id")
        .eq("workspace_id", workspace.id)
        .single();
      if (error) throw new Error(`Reading the channel failed (code ${error.code}).`);
      const secrets = () =>
        adminClient().from("notification_destination_secrets").select("destination_id", { count: "exact", head: true }).eq("destination_id", destination.id);
      expect((await secrets()).count).toBe(1);

      await row.getByRole("button", { name: /^Send test message/ }).click();
      await expect(row.getByText("Test message sent to Ops webhook.")).toBeVisible();
      expect(receiver.received).toHaveLength(1);
      const [delivery] = receiver.received;
      expect(delivery?.headers["webhook-signature"]).toMatch(/^v1,/);
      expect(delivery?.headers["webhook-id"]).toBeTruthy();
      expect(delivery?.body).toContain(`Test message from StackDash for ${workspace.name}`);
      expect(delivery?.body).not.toContain(receiver.url);

      // Keyboard: the remove button opens the dialog, and Enter on its confirm button removes it.
      await row.getByRole("button", { name: /^Remove channel/ }).focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Remove this channel?" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Remove channel", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(channels.getByText("No channels yet")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Channels" })).toBeFocused();

      expect((await secrets()).count).toBe(0);

      // Keyboard: Cancel closes the form and hands focus back to the button that opened it.
      await form.getByRole("button", { name: "Cancel" }).focus();
      await page.keyboard.press("Enter");
      await expect(form).toHaveCount(0);
      await expect(channels.getByRole("button", { name: "New channel" })).toBeFocused();
    } finally {
      await stopReceiver(receiver.server);
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("refuses a webhook URL that is not https and keeps every choice in the form", async ({ page }) => {
    const workspace = await createTestWorkspace("Alert channel errors");
    try {
      await page.goto(`/w/${workspace.slug}/alerts/settings`);
      const form = await openCreateForm(page, "New channel", "Add a channel");
      await form.getByLabel("Where to post").selectOption({ label: "Webhook" });
      await form.getByLabel("Channel name").fill("Ops webhook");
      await form.getByLabel("Webhook URL").fill("ftp://example.com/hook");
      await form.getByRole("radio", { name: "Only the rules I choose" }).check();
      await form.getByLabel("Digest", { exact: true }).selectOption({ label: "Weekly digest" });
      await form.getByRole("button", { name: "Add channel" }).click();
      await expect(form.getByRole("alert")).toContainText("The channel was not added");
      await expect(form.getByLabel("Webhook URL")).toHaveAttribute("aria-invalid", "true");
      // What the user chose survives the failed submit, so fixing the URL is the only step left.
      await expect(form.getByLabel("Where to post")).toHaveValue("webhook");
      await expect(form.getByLabel("Channel name")).toHaveValue("Ops webhook");
      await expect(form.getByRole("radio", { name: "Only the rules I choose" })).toBeChecked();
      await expect(form.getByLabel("Digest", { exact: true })).toHaveValue("weekly");
      const { count } = await adminClient()
        .from("notification_destinations")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace.id);
      expect(count).toBe(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("keeps the chosen alert email option selected after saving it", async ({ page }) => {
    const workspace = await createTestWorkspace("Alert email setting");
    try {
      await page.goto(`/w/${workspace.slug}/alerts/settings`);
      const emails = page.getByRole("form", { name: "Alert emails" });
      await expect(emails.getByRole("radio", { name: /^As each alert happens/ })).toBeChecked();
      await emails.getByRole("radio", { name: /^Weekly digest/ }).check();
      await emails.getByRole("button", { name: "Save alert emails" }).click();
      await expect(emails.getByRole("status")).toHaveText("Alert email setting saved.");
      await expect(emails.getByRole("radio", { name: /^Weekly digest/ })).toBeChecked();
      await page.reload();
      await expect(page.getByRole("form", { name: "Alert emails" }).getByRole("radio", { name: /^Weekly digest/ })).toBeChecked();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

viewerTest.describe("alert channels and emails as a viewer", () => {
  viewerTest("sees why they cannot add a channel or receive alert emails", async ({ page }) => {
    const workspace = await createTestWorkspace("Alert channels viewer");
    try {
      await page.goto(`/w/${workspace.slug}/alerts/settings`);
      await expect(page.getByRole("region", { name: "Alert emails" }).getByText("Only owners and admins receive alert emails for this workspace.")).toBeVisible();
      const channels = page.getByRole("region", { name: "Channels" });
      await expect(channels.getByText("Only owners and admins can add or change where alerts are posted.")).toBeVisible();
      await expect(channels.getByRole("button", { name: "New channel" })).toHaveCount(0);
      await expect(channels.getByRole("form", { name: "Add a channel" })).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
