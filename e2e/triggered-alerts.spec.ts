import type { Page } from "@playwright/test";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { expectHydrated } from "./fixtures/hydration";
import { tabTo } from "./fixtures/keyboard";

// Each test creates its own workspace and seeds only inside it.

const EVENT_TITLE = "Example provider build minutes passed 100 percent of the allowance";
// The short title the alerts page and dashboard lead with (#268), built from the stored columns.
const ALERT_TITLE = "Example provider allowance at 104 percent";
const ALERT_VALUE = "104 percent of the allowance";
const ALERT_MESSAGE =
  "Example provider build minutes is at 104 percent of the allowance (6,240 minutes of 6,000 minutes) for the billing period starting 2026-10-01. The alert threshold is 100 percent.";

/** A 100 percent allowance rule that fired (critical, estimated), plus its timeline event. */
async function seedTriggeredAlert(workspace: TestWorkspace): Promise<string> {
  const admin = adminClient();
  const { data: rule, error: ruleError } = await admin
    .from("alert_rules")
    .insert({ workspace_id: workspace.id, kind: "allowance_percent", scope: "workspace", threshold_percent: 100 })
    .select("id")
    .single();
  if (ruleError) throw new Error(`Seeding a rule failed (code ${ruleError.code}).`);
  const cycleKey = "2026-10-01";
  const { data: alert, error: alertError } = await admin
    .from("triggered_alerts")
    .insert({
      workspace_id: workspace.id,
      rule_id: rule.id,
      cycle_key: cycleKey,
      triggered_at: "2026-10-31T09:30:00Z",
      observed_value: 104,
      provider: "fake",
      threshold_label: "100 percent",
      is_estimated: true,
      message: ALERT_MESSAGE,
    })
    .select("id")
    .single();
  if (alertError) throw new Error(`Seeding a triggered alert failed (code ${alertError.code}).`);
  const { error: eventError } = await admin.from("activity_events").insert({
    workspace_id: workspace.id,
    type_id: "stackdash.alert_triggered",
    severity: "critical",
    title: EVENT_TITLE,
    body: ALERT_MESSAGE,
    occurred_at: "2026-10-31T09:30:00Z",
    dedupe_key: `alert:${rule.id}:${cycleKey}`,
  });
  if (eventError) throw new Error(`Seeding the alert event failed (code ${eventError.code}).`);
  return alert.id;
}

async function acknowledgedBy(alertIds: readonly string[]): Promise<Array<string | null>> {
  const { data, error } = await adminClient().from("triggered_alerts").select("acknowledged_by").in("id", alertIds);
  if (error) throw new Error(`Reading the alerts failed (code ${error.code}).`);
  return data.map((row) => row.acknowledged_by);
}

function triggeredList(page: Page) {
  return page.getByRole("list", { name: "Triggered alerts" });
}

// Every area of alert settings, and its forms, none of which belong on the inbox (#343).
const SETTINGS_AREAS = ["Alert rules", "Budgets", "Alert emails", "Channels", "Unusual spend and usage"] as const;
const SETTINGS_FORMS = ["Add an alert rule", "Add a budget", "Add a channel"] as const;

// More Tab stops than the inbox has before Alert settings, or alert settings before New budget.
const MAX_TAB_PRESSES = 60;

ownerTest.describe("triggered alerts as the owner", () => {
  ownerTest("sees the alert on the alerts page, dashboard, and timeline, then acknowledges it", async ({ page }) => {
    const workspace = await createTestWorkspace("Triggered alerts");
    try {
      const alertId = await seedTriggeredAlert(workspace);

      await page.goto(`/w/${workspace.slug}/dashboard`);
      const summary = page.getByRole("region", { name: "Alerts", exact: true });
      await expect(summary).toContainText("1 unacknowledged alert");
      await expect(summary.getByText(ALERT_TITLE, { exact: true })).toBeVisible();
      await expect(summary.getByText(ALERT_VALUE, { exact: true })).toBeVisible();
      await expect(summary).toContainText("Critical");
      // The full sentence waits behind its disclosure.
      await expect(summary.getByText(ALERT_MESSAGE)).toBeHidden();
      await summary.getByText("Show the full alert").click();
      await expect(summary.getByText(ALERT_MESSAGE)).toBeVisible();
      await expectNoAxeViolations(page);

      await page.goto(`/w/${workspace.slug}/timeline`);
      await expect(page.getByRole("heading", { name: EVENT_TITLE })).toBeVisible();

      await page.goto(`/w/${workspace.slug}/dashboard`);
      await summary.getByRole("link", { name: "View all alerts" }).click();
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/alerts$`));

      const item = triggeredList(page).getByRole("listitem").filter({ hasText: ALERT_TITLE });
      await expect(item.getByRole("heading", { level: 3, name: ALERT_TITLE })).toBeVisible();
      await expect(item.getByText(ALERT_VALUE, { exact: true })).toBeVisible();
      await expect(item).toContainText("Critical");
      await expect(item.getByText("Estimated", { exact: true })).toBeVisible();
      await expect(item).toContainText("Threshold 100 percent");
      await expect(item.locator("time").first()).toHaveAttribute("datetime", "2026-10-31T09:30:00.000Z");
      await expect(item).toContainText("2026-10-31 09:30 GMT");
      await expect(item).toContainText("Not acknowledged");
      await expectNoAxeViolations(page);

      // Keyboard only: the disclosure opens and closes with Enter, named after its alert.
      const disclosure = item.getByText("Show the full alert");
      await expect(item.getByText(ALERT_MESSAGE)).toBeHidden();
      await item.locator("summary").focus();
      await page.keyboard.press("Enter");
      await expect(item.getByText(ALERT_MESSAGE)).toBeVisible();
      await expect(item.getByText("Hide the full alert")).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(item.getByText(ALERT_MESSAGE)).toBeHidden();
      await expect(disclosure).toBeVisible();

      // One unacknowledged alert: "Acknowledge all" is offered beside the count.
      const triggered = page.getByRole("region", { name: "Triggered alerts" });
      await expect(triggered).toContainText("1 unacknowledged alert");
      await expect(triggered.getByRole("button", { name: "Acknowledge all" })).toBeVisible();

      // Keyboard only: focus the button and press Enter.
      const button = item.getByRole("button", { name: /^Acknowledge/ });
      await expect(button).toHaveAccessibleName(`Acknowledge : ${ALERT_TITLE}, triggered 2026-10-31 09:30 GMT`);
      await button.focus();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status").filter({ hasText: "Alert acknowledged." })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Triggered alerts" })).toBeFocused();
      await expect(page.getByText("No unacknowledged alerts")).toBeVisible();
      await expect(triggered.getByRole("button", { name: "Acknowledge all" })).toHaveCount(0);

      // Still in the history, marked acknowledged.
      await page.getByRole("link", { name: "Show acknowledged alerts" }).click();
      await expect(page).toHaveURL(/acknowledged=show/);
      const acknowledged = triggeredList(page).getByRole("listitem").filter({ hasText: ALERT_TITLE });
      await expect(acknowledged).toContainText("Acknowledged by you");
      await expect(acknowledged.getByRole("button", { name: /^Acknowledge/ })).toHaveCount(0);
      await expectNoAxeViolations(page);

      expect(await acknowledgedBy([alertId])).toEqual([workspace.ownerId]);

      await page.goto(`/w/${workspace.slug}/dashboard`);
      await expect(page.getByRole("region", { name: "Alerts", exact: true })).toContainText("No unacknowledged alerts");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("acknowledges every alert at once and announces how many", async ({ page }) => {
    const workspace = await createTestWorkspace("Acknowledge all");
    const other = await createTestWorkspace("Acknowledge all elsewhere");
    try {
      const alertIds = [
        await seedTriggeredAlert(workspace),
        await seedTriggeredAlert(workspace),
        await seedTriggeredAlert(workspace),
      ];
      const otherAlertId = await seedTriggeredAlert(other);

      await page.goto(`/w/${workspace.slug}/alerts`);
      const triggered = page.getByRole("region", { name: "Triggered alerts" });
      await expect(triggered).toContainText("3 unacknowledged alerts");
      await expect(triggeredList(page).getByRole("listitem")).toHaveCount(3);
      await expectNoAxeViolations(page);

      // Keyboard only: focus "Acknowledge all" and press Enter.
      await triggered.getByRole("button", { name: "Acknowledge all" }).focus();
      await page.keyboard.press("Enter");
      await expect(
        page.getByRole("status").filter({
          hasText: "3 alerts acknowledged. They stay in the alert history. Choose Show acknowledged alerts to see them.",
        }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Triggered alerts" })).toBeFocused();
      await expect(page.getByText("No unacknowledged alerts")).toBeVisible();
      await expect(triggered.getByRole("button", { name: /^Acknowledge/ })).toHaveCount(0);

      expect(await acknowledgedBy(alertIds)).toEqual([workspace.ownerId, workspace.ownerId, workspace.ownerId]);
      // Another workspace's alert is untouched, even though the same owner holds it.
      expect(await acknowledgedBy([otherAlertId])).toEqual([null]);

      await page.goto(`/w/${workspace.slug}/alerts?acknowledged=show`);
      await expect(triggeredList(page).getByRole("listitem").filter({ hasText: "Acknowledged by you" })).toHaveCount(3);
      await expectNoAxeViolations(page);
    } finally {
      await Promise.all([deleteTestWorkspace(workspace), deleteTestWorkspace(other)]);
    }
  });

  ownerTest("shows an empty state that links to adding an alert rule, which opens ready to fill in", async ({ page }) => {
    const workspace = await createTestWorkspace("No triggered alerts");
    try {
      await page.goto(`/w/${workspace.slug}/alerts`);
      await expect(page.getByText("No alerts have fired")).toBeVisible();
      const triggered = page.getByRole("region", { name: "Triggered alerts" });
      const add = triggered.getByRole("link", { name: "Add an alert rule" });
      await expect(add).toHaveAttribute("href", `/w/${workspace.slug}/alerts/settings#add-alert-rule`);
      await expect(triggered.getByRole("button", { name: "Acknowledge all" })).toHaveCount(0);

      // The rule form is closed on alert settings (#343), but this link opens it at its first field.
      await add.click();
      await expect(page).toHaveURL(`/w/${workspace.slug}/alerts/settings#add-alert-rule`);
      const form = page.getByRole("form", { name: "Add an alert rule" });
      await expect(form.getByRole("radio", { name: "Usage reaches a percentage of a provider allowance" })).toBeFocused();

      await page.goto(`/w/${workspace.slug}/dashboard`);
      await expect(page.getByRole("region", { name: "Alerts", exact: true })).toContainText("No unacknowledged alerts");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("keeps settings off the inbox, one keyboard step away, with every create form closed (#343)", async ({ page }) => {
    const workspace = await createTestWorkspace("Alerts inbox");
    try {
      await seedTriggeredAlert(workspace);
      await page.goto(`/w/${workspace.slug}/alerts`);
      await expect(triggeredList(page).getByRole("listitem")).toHaveCount(1);
      for (const name of SETTINGS_AREAS) await expect(page.getByRole("region", { name, exact: true })).toHaveCount(0);
      for (const name of SETTINGS_FORMS) await expect(page.getByRole("form", { name })).toHaveCount(0);
      await expectNoAxeViolations(page);

      // Keyboard only from here: Tab to Alert settings and press Enter.
      await expectHydrated(page);
      const settingsLink = page.getByRole("link", { name: "Alert settings" });
      await tabTo(page, settingsLink, MAX_TAB_PRESSES);
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`/w/${workspace.slug}/alerts/settings`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Alert settings");
      for (const name of SETTINGS_AREAS) await expect(page.getByRole("region", { name, exact: true })).toBeVisible();
      for (const name of SETTINGS_FORMS) await expect(page.getByRole("form", { name })).toHaveCount(0);
      await expectNoAxeViolations(page);

      // New budget opens its form at the name field; Enter in a field adds it.
      const newBudget = page.getByRole("button", { name: "New budget" });
      await tabTo(page, newBudget, MAX_TAB_PRESSES);
      await page.keyboard.press("Enter");
      const form = page.getByRole("form", { name: "Add a budget" });
      await expect(form.getByLabel("Budget name")).toBeFocused();
      // Scanned open and at rest: right after a submit, the button is still fading back in from
      // its pending opacity, which axe would measure mid-transition.
      await expectNoAxeViolations(page);
      await page.keyboard.type("Keyboard budget");
      await page.keyboard.press("Tab");
      await expect(form.getByLabel("Monthly amount")).toBeFocused();
      await page.keyboard.type("40");
      await page.keyboard.press("Enter");
      await expect(form.getByRole("status")).toHaveText("Budget added.");
      const budgets = page.getByRole("list", { name: "Budgets" });
      await expect(budgets.getByRole("listitem").filter({ hasText: "Keyboard budget" })).toContainText("$40.00 a month");

      // Cancel closes it and hands focus back to New budget.
      await tabTo(page, form.getByRole("button", { name: "Cancel" }), MAX_TAB_PRESSES);
      await page.keyboard.press("Enter");
      await expect(form).toHaveCount(0);
      await expect(newBudget).toBeFocused();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("sends a link to a settings section of the old alerts page on to alert settings (#343)", async ({ page }) => {
    const workspace = await createTestWorkspace("Moved alert settings");
    try {
      // The address every alert email sent before #343 links to for the email setting.
      await page.goto(`/w/${workspace.slug}/alerts#alert-emails`);
      await expect(page).toHaveURL(`/w/${workspace.slug}/alerts/settings#alert-emails`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Alert settings");
      // In view below the sticky header, and focused, so a screen reader says where the user landed.
      const emails = page.getByRole("heading", { name: "Alert emails" });
      await expect(emails).toBeInViewport();
      await expect(emails).toBeFocused();
      const headerBottom = await page.getByRole("banner").evaluate((element) => element.getBoundingClientRect().bottom);
      await expect.poll(async () => (await emails.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(headerBottom);
      // A link straight to a section of alert settings, as new emails carry, lands on it the same way.
      await page.goto(`/w/${workspace.slug}/alerts/settings#alert-channels`);
      const channels = page.getByRole("heading", { name: "Channels", exact: true });
      await expect(channels).toBeInViewport();
      await expect(channels).toBeFocused();
      // Replaced, not pushed: Back leaves the alerts pages rather than bouncing off the inbox.
      await page.goto(`/w/${workspace.slug}/timeline`);
      await page.goto(`/w/${workspace.slug}/alerts#budgets-title`);
      await expect(page).toHaveURL(`/w/${workspace.slug}/alerts/settings#budgets-title`);
      await page.goBack();
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline`);

      // The inbox's own fragment stays on the inbox.
      await page.goto(`/w/${workspace.slug}/alerts#triggered-alerts-title`);
      await expectHydrated(page);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Alerts");
      await expect(page).toHaveURL(`/w/${workspace.slug}/alerts#triggered-alerts-title`);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

viewerTest.describe("triggered alerts as a viewer", () => {
  viewerTest("shows the status without acknowledge buttons and says why", async ({ page }) => {
    const workspace = await createTestWorkspace("Viewer triggered alerts");
    try {
      await seedTriggeredAlert(workspace);
      await page.goto(`/w/${workspace.slug}/alerts`);
      const item = triggeredList(page).getByRole("listitem").filter({ hasText: ALERT_TITLE });
      await expect(item).toContainText("Not acknowledged");
      await expect(page.getByRole("button", { name: /^Acknowledge/ })).toHaveCount(0);
      await expect(page.getByText("Only owners and admins can acknowledge alerts.")).toBeVisible();
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
