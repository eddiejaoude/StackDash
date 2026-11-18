import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

import { openCreateForm } from "./fixtures/alerts";
import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { expectFailureInDialog } from "./fixtures/dialogs";
import { expectHydrated } from "./fixtures/hydration";

// Each test creates its own workspace and seeds only inside it.

function rulesList(page: Page) {
  return page.getByRole("list", { name: "Alert rules" });
}

/** A fake provider connection that reports one included allowance, so suggestions appear. */
async function seedAllowanceConnection(workspace: TestWorkspace): Promise<void> {
  const admin = adminClient();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "fake",
      status: "active",
      granted_at: new Date().toISOString(),
      display_name: "Fake team",
      poll_interval_seconds: 3600,
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_id: "fake-team",
      display_name: "Fake team",
      kind: "team",
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  const { error: snapshotError } = await admin.from("usage_snapshots").insert({
    workspace_id: workspace.id,
    connection_id: connection.id,
    external_account_id: account.id,
    metric_key: "fake.build_minutes.monthly",
    kind: "included_allowance",
    label: "Build minutes",
    snapshot_date: "2026-10-31",
    value: 6000,
    unit: "minutes",
    period_start: "2026-10-01T00:00:00Z",
    period_end: "2026-11-01T00:00:00Z",
    retrieved_at: "2026-10-31T09:00:00Z",
    provenance_source: "provider_api",
  });
  if (snapshotError) throw new Error(`Seeding a snapshot failed (code ${snapshotError.code}).`);
}

ownerTest.describe("alert rules as the owner", () => {
  ownerTest("creates a percent rule from a preset, then pauses, resumes, and deletes it", async ({ page }) => {
    const workspace = await createTestWorkspace("Alert rules");
    try {
      await page.goto(`/w/${workspace.slug}/alerts/settings`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Alert settings");
      await expect(page.getByText("No alert rules yet")).toBeVisible();

      // Closed until asked for (#343); opening it lands on its first field, the chosen option.
      await expect(page.getByRole("form", { name: "Add an alert rule" })).toHaveCount(0);
      const form = await openCreateForm(page, "New alert rule", "Add an alert rule");
      await expect(form.getByRole("radio", { name: "Usage reaches a percentage of a provider allowance" })).toBeFocused();
      await expect(
        form.getByRole("radio", { name: "Usage reaches a percentage of a provider allowance" }),
      ).toBeChecked();
      await form.getByRole("radio", { name: "90%" }).check();
      await form.getByRole("button", { name: "Add alert rule" }).click();
      await expect(form.getByRole("status").filter({ hasText: "Alert rule added." })).toBeVisible();

      const item = rulesList(page).getByRole("listitem").filter({ hasText: "Alert at 90% of every allowance" });
      await expect(item).toContainText("Applies to the whole workspace");
      await expect(item.getByText("Active", { exact: true })).toBeVisible();

      await item.getByRole("button", { name: /^Pause rule/ }).click();
      await expect(item.getByText("Paused", { exact: true })).toBeVisible();
      await expect(item.getByRole("status").filter({ hasText: "Alert rule paused." })).toBeVisible();
      await item.getByRole("button", { name: /^Resume rule/ }).click();
      await expect(item.getByText("Active", { exact: true })).toBeVisible();

      await item.getByRole("button", { name: /^Delete rule/ }).click();
      const dialog = page.getByRole("dialog", { name: "Delete this alert rule?" });
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();
      await expect(item.getByRole("button", { name: /^Delete rule/ })).toBeFocused();

      await item.getByRole("button", { name: /^Delete rule/ }).click();
      await dialog.getByRole("button", { name: "Delete rule", exact: true }).click();
      await expect(item).toHaveCount(0);
      await expect(page.getByText("No alert rules yet")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Alert rules", level: 2 })).toBeFocused();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("shows a failed delete inside the open dialog", async ({ page }) => {
    const workspace = await createTestWorkspace("Alert rule delete failure");
    try {
      await page.goto(`/w/${workspace.slug}/alerts/settings`);
      const form = await openCreateForm(page, "New alert rule", "Add an alert rule");
      await form.getByRole("radio", { name: "90%" }).check();
      await form.getByRole("button", { name: "Add alert rule" }).click();
      await expect(form.getByRole("status").filter({ hasText: "Alert rule added." })).toBeVisible();

      const item = rulesList(page).getByRole("listitem").filter({ hasText: "Alert at 90% of every allowance" });
      await expectFailureInDialog(page, {
        trigger: item.getByRole("button", { name: /^Delete rule/ }),
        dialog: page.getByRole("dialog", { name: "Delete this alert rule?" }),
        confirmName: "Delete rule",
        // Deleted behind the open dialog, so the action finds nothing to delete.
        breakIt: async () => {
          const { error } = await adminClient().from("alert_rules").delete().eq("workspace_id", workspace.id);
          if (error) throw new Error(`Deleting the rule failed (code ${error.code}).`);
        },
        message: "This alert rule no longer exists. Reload the page to see the current rules.",
      });
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("rejects a zero custom spend amount, then saves 12.50 and edits it", async ({ page }) => {
    const workspace = await createTestWorkspace("Spend rule");
    try {
      await page.goto(`/w/${workspace.slug}/alerts/settings`);
      const form = await openCreateForm(page, "New alert rule", "Add an alert rule");
      await form.getByRole("radio", { name: "Spend reaches an amount" }).check();
      await expect(form.getByLabel("Currency")).toHaveValue("USD");
      await form.getByRole("radio", { name: "Custom" }).check();

      const amount = form.getByLabel("Custom amount");
      await amount.fill("0");
      await form.getByRole("button", { name: "Add alert rule" }).click();

      const summary = form.getByRole("alert");
      await expect(summary).toBeFocused();
      await expect(summary).toContainText("The alert rule was not added");
      await expect(summary.getByRole("link", { name: "Enter an amount of at least 0.01 USD." })).toBeVisible();
      await expect(amount).toHaveAttribute("aria-invalid", "true");
      await expect(amount).toHaveAccessibleDescription(/Enter an amount of at least 0\.01 USD\./);
      // The rejected value stays for correcting.
      await expect(amount).toHaveValue("0");

      await amount.fill("12.50");
      await form.getByRole("button", { name: "Add alert rule" }).click();
      const item = rulesList(page).getByRole("listitem").filter({ hasText: "Alert when spend reaches $12.50" });
      await expect(item).toBeVisible();
      await expect(item).toContainText("Counts spend in USD only.");
      await expect(form.getByRole("alert")).toHaveCount(0);

      await item.getByRole("button", { name: /^Edit rule/ }).click();
      const editForm = item.getByRole("form", { name: "Edit alert rule" });
      await expect(editForm.getByRole("radio", { name: "Custom" })).toBeChecked();
      await expect(editForm.getByLabel("Custom amount")).toHaveValue("12.50");
      await editForm.getByRole("radio", { name: "$25.00" }).check();
      await editForm.getByRole("button", { name: "Save changes" }).click();
      await expect(
        rulesList(page).getByRole("listitem").filter({ hasText: "Alert when spend reaches $25.00" }),
      ).toBeVisible();
      await expect(page.getByRole("status").filter({ hasText: "Alert rule saved." })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("adds a budget and a budget percent rule that uses it", async ({ page }) => {
    const workspace = await createTestWorkspace("Budget rule");
    try {
      await page.goto(`/w/${workspace.slug}/alerts/settings`);
      const budgetForm = await openCreateForm(page, "New budget", "Add a budget");
      await expect(budgetForm.getByLabel("Budget name")).toBeFocused();
      await budgetForm.getByLabel("Budget name").fill("Production apps");
      await budgetForm.getByLabel("Monthly amount").fill("250");
      await budgetForm.getByRole("button", { name: "Add budget" }).click();

      const budget = page.getByRole("list", { name: "Budgets" }).getByRole("listitem").filter({ hasText: "Production apps" });
      await expect(budget).toContainText("Your budget");
      await expect(budget).toContainText("$250.00 a month");

      const ruleForm = await openCreateForm(page, "New alert rule", "Add an alert rule");
      await ruleForm.getByRole("radio", { name: "Spend reaches a percentage of your budget" }).check();
      await ruleForm.getByRole("radio", { name: "100%" }).check();
      await ruleForm.getByRole("button", { name: "Add alert rule" }).click();
      // No budget chosen yet: the field explains, and the summary links to it.
      await expect(ruleForm.getByRole("alert")).toBeFocused();
      await expect(ruleForm.getByLabel("Budget", { exact: true })).toHaveAccessibleDescription(/Choose a budget/);

      await ruleForm.getByLabel("Budget", { exact: true }).selectOption({ label: "Production apps ($250.00 a month)" });
      await ruleForm.getByRole("button", { name: "Add alert rule" }).click();
      await expect(
        rulesList(page).getByRole("listitem").filter({ hasText: "Alert at 100% of the Production apps budget" }),
      ).toBeVisible();

      // Owner view with a budget, a rule, and both add forms on screen.
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("offers suggested allowance alerts and adds them only when asked", async ({ page }) => {
    const workspace = await createTestWorkspace("Suggested alerts");
    try {
      await seedAllowanceConnection(workspace);
      await page.goto(`/w/${workspace.slug}/alerts/settings`);

      const suggestions = page.getByRole("region", { name: "Suggested alerts" });
      await expect(suggestions).toContainText("Example provider: alert at 75%, 90%, and 100% of each allowance.");
      // Suggestions are never enabled on their own.
      await expect(page.getByText("No alert rules yet")).toBeVisible();

      await suggestions.getByRole("button", { name: "Add these alerts for Example provider" }).click();
      for (const percent of [75, 90, 100]) {
        await expect(
          rulesList(page).getByRole("listitem").filter({ hasText: `Alert at ${percent}% of every allowance` }),
        ).toContainText("Applies to Example provider");
      }
      await expect(suggestions).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("pages budgets from the keyboard onto the Budgets heading, with focus on it (#312, #313, #343)", async ({ page }) => {
    const workspace = await createTestWorkspace("Budget pages");
    try {
      // One more than a page of budgets (BUDGETS_PAGE_SIZE is 50), so "Show more budgets" appears.
      const { error } = await adminClient()
        .from("budgets")
        .insert(
          Array.from({ length: 51 }, (_, index) => ({
            workspace_id: workspace.id,
            name: `Budget ${String(index + 1).padStart(2, "0")}`,
            scope: "workspace" as const,
            amount_minor: 10_000,
            currency: "USD",
          })),
        );
      if (error) throw new Error(`Seeding budgets failed (code ${error.code}).`);
      // Opened by its fragment, as the inbox's "Add an alert rule" link opens it (#343).
      await page.goto(`/w/${workspace.slug}/alerts/settings#add-alert-rule`);
      // A client navigation, as a user gets once the page has hydrated: before that the link is a
      // plain anchor and the browser itself handles the fragment.
      await expectHydrated(page);
      const ruleForm = page.getByRole("form", { name: "Add an alert rule" });
      await ruleForm.getByRole("radio", { name: "90%" }).check();
      const showMore = page.getByRole("link", { name: "Show more budgets" });
      await showMore.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/[?&]budgetsAfter=[^#]+#budgets-title$/);
      await expect(page.getByRole("link", { name: "Show the first budgets" })).toBeVisible();
      const heading = page.getByRole("heading", { name: "Budgets", exact: true });
      await expect(heading).toBeInViewport();
      // Below the sticky header, not under it.
      const headerBottom = await page.getByRole("banner").evaluate((element) => element.getBoundingClientRect().bottom);
      await expect.poll(async () => (await heading.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(headerBottom);
      // The link that had focus is gone with the old list. The heading takes focus, so a screen
      // reader announces where the user landed (#313), and it is the last stop before the new list.
      await expect(heading).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("list", { name: "Budgets" }).getByRole("button", { name: /^Edit budget/ }).first()).toBeFocused();
      await expectNoAxeViolations(page);
      // The pager moved the fragment off #add-alert-rule without a hashchange. The rule form stays
      // open with what was chosen in it, and the refresh after adding keeps it and its status.
      await expect(ruleForm.getByRole("radio", { name: "90%" })).toBeChecked();
      await ruleForm.getByRole("button", { name: "Add alert rule" }).click();
      await expect(ruleForm.getByRole("status").filter({ hasText: "Alert rule added." })).toBeVisible();
      await expect(rulesList(page).getByRole("listitem").filter({ hasText: "Alert at 90% of every allowance" })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

viewerTest.describe("alert rules as a viewer", () => {
  viewerTest("shows rules and budgets read only, with the reason", async ({ page }) => {
    const workspace = await createTestWorkspace("Viewer alerts");
    try {
      const admin = adminClient();
      const { error } = await admin.from("alert_rules").insert({
        workspace_id: workspace.id,
        kind: "allowance_percent",
        scope: "workspace",
        threshold_percent: 75,
      });
      if (error) throw new Error(`Seeding a rule failed (code ${error.code}).`);

      await page.goto(`/w/${workspace.slug}/alerts/settings`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Alert settings");
      await expect(rulesList(page).getByRole("listitem").filter({ hasText: "Alert at 75% of every allowance" })).toBeVisible();
      await expect(page.getByText("Only owners and admins can manage budgets and alert rules.").first()).toBeVisible();

      await expect(page.getByRole("button", { name: /^New (alert rule|budget|channel)$/ })).toHaveCount(0);
      await expect(page.getByRole("form", { name: "Add an alert rule" })).toHaveCount(0);
      await expect(page.getByRole("form", { name: "Add a budget" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: /^(Edit|Pause|Delete) rule/ })).toHaveCount(0);
      await expect(page.getByRole("region", { name: "Suggested alerts" })).toHaveCount(0);

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
