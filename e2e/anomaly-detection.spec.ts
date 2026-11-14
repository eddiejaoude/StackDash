import type { Page } from "@playwright/test";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations, waitForTrends } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { openFilters } from "./fixtures/filters";

// Every test seeds its own workspace with synthetic data from the fake provider only. The
// detection itself is unit tested (src/lib/alerts/anomaly.test.ts, src/lib/jobs/daily-summary.test.ts);
// these tests cover what a person sees and changes.

const ANOMALY_TITLE = "Unusual spend on Example provider: 4 times the usual daily spend";
const ANOMALY_BODY =
  "Spend this month (verified) went up by $412.00 on 2026-11-03. The usual amount is $103.00 a day, the median of the 14 days before.";
const METRIC_NAME = "Example provider: Spend this month";

/** One fake account reporting month to date spend, and one anomaly event found an hour ago. */
async function seedAnomaly(workspace: TestWorkspace): Promise<void> {
  const admin = adminClient();
  const now = new Date();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "fake",
      status: "active",
      display_name: "Fake billing account",
      poll_interval_seconds: 3_600,
      last_synced_at: now.toISOString(),
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({ workspace_id: workspace.id, connection_id: connection.id, external_id: "acct_anomaly", display_name: "Production", kind: "account" })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const { error: snapshotError } = await admin.from("usage_snapshots").insert({
    workspace_id: workspace.id,
    connection_id: connection.id,
    external_account_id: account.id,
    metric_key: "fake.spend.month",
    kind: "verified_spend",
    label: "Spend this month",
    snapshot_date: now.toISOString().slice(0, 10),
    amount_minor: 41_200,
    currency: "USD",
    period_start: monthStart.toISOString(),
    period_end: nextMonth.toISOString(),
    retrieved_at: now.toISOString(),
    provenance_source: "provider_api",
  });
  if (snapshotError) throw new Error(`Seeding a snapshot failed (code ${snapshotError.code}).`);
  const { error: eventError } = await admin.from("activity_events").insert({
    workspace_id: workspace.id,
    connection_id: connection.id,
    external_account_id: account.id,
    provider: "fake",
    type_id: "stackdash.anomaly_detected",
    severity: "warning",
    title: ANOMALY_TITLE,
    body: `${ANOMALY_BODY}\nWhat to do next: open Example provider to see what drove it, check the timeline for deploys on 2026-11-03, or mute this metric in alert settings if it was expected.`,
    occurred_at: new Date(now.getTime() - 3_600_000).toISOString(),
    dedupe_key: "anomaly:2026-11-03:fake:fake.spend.month:money:USD:verified",
  });
  if (eventError) throw new Error(`Seeding the anomaly event failed (code ${eventError.code}).`);
}

function anomalySection(page: Page) {
  return page.getByRole("region", { name: "Unusual spend and usage" });
}

ownerTest.describe("anomaly detection as the owner", () => {
  ownerTest("shows an unusual day on the dashboard, then turns detection off and on and mutes a metric", async ({ page }) => {
    const workspace = await createTestWorkspace("Anomaly detection");
    try {
      await seedAnomaly(workspace);

      await page.goto(`/w/${workspace.slug}/dashboard`);
      const summary = page.getByRole("region", { name: "Alerts", exact: true });
      await expect(summary).toContainText("No unacknowledged alerts");
      await expect(summary).toContainText("1 unusual spend or usage event in the last 7 days");
      await expect(summary).toContainText(ANOMALY_TITLE);
      await expect(summary).toContainText(ANOMALY_BODY);
      await waitForTrends(page);
      await expectNoAxeViolations(page);

      await summary.getByRole("link", { name: "Show unusual days on the timeline" }).click();
      await expect(page).toHaveURL(/\/timeline\?type=stackdash\.anomaly_detected$/);
      await expect(page.getByRole("heading", { name: ANOMALY_TITLE })).toBeVisible();
      // The page the link lands on names the type the way alert settings names the feature (#345).
      await openFilters(page, "keyboard");
      const types = page.getByRole("group", { name: "Event type" });
      await expect(types.getByRole("checkbox", { name: "StackDash: Unusual spend or usage" })).toBeChecked();
      await expect(types).not.toContainText(/anomal/i);
      await expectNoAxeViolations(page);

      await page.goto(`/w/${workspace.slug}/alerts/settings`);
      const section = anomalySection(page);
      await expect(section).toContainText("Unusual spend and usage checks are on");
      // One name for the feature in the product (#345): the section never says "anomaly".
      await expect(section).not.toContainText(/anomal/i);
      await expect(section).toContainText("No muted metrics. Every spend and usage metric is checked.");

      // Keyboard only: focus the switch and press Enter.
      const turnOff = section.getByRole("button", { name: "Turn off unusual spend and usage checks" });
      await turnOff.focus();
      await page.keyboard.press("Enter");
      await expect(section.getByRole("status").filter({ hasText: "Unusual spend and usage checks are off." })).toBeVisible();
      await expect(section).toContainText("No unusual days are flagged.");
      await expect(section).not.toContainText(/anomal/i);
      await section.getByRole("button", { name: "Turn on unusual spend and usage checks" }).click();
      await expect(section.getByRole("status").filter({ hasText: "Unusual spend and usage checks are on." })).toBeVisible();

      // Submitting without a choice explains what to do.
      await section.getByRole("button", { name: "Mute metric" }).click();
      await expect(section.getByText("Choose a metric to mute.")).toBeVisible();

      await section.getByLabel("Metric to mute").selectOption({ label: METRIC_NAME });
      await section.getByRole("button", { name: "Mute metric" }).click();
      const muted = section.getByRole("list", { name: "Muted metrics" });
      await expect(muted.getByRole("listitem")).toHaveText([new RegExp(METRIC_NAME)]);
      await expect(section).toContainText("Every spend and usage metric is muted.");
      await expectNoAxeViolations(page);

      // The visually hidden suffix names the metric, so each Unmute button is unique in the list.
      await muted.getByRole("button", { name: new RegExp(`^Unmute\\s?: ${METRIC_NAME}$`) }).click();
      await expect(page.getByRole("heading", { name: "Unusual spend and usage" })).toBeFocused();
      await expect(section).toContainText("No muted metrics. Every spend and usage metric is checked.");
      await expect(section.getByLabel("Metric to mute")).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

viewerTest.describe("anomaly detection as a viewer", () => {
  viewerTest("sees the setting and the reason it cannot change it", async ({ page }) => {
    const workspace = await createTestWorkspace("Anomaly viewer");
    try {
      await seedAnomaly(workspace);
      await page.goto(`/w/${workspace.slug}/alerts/settings`);
      const section = anomalySection(page);
      await expect(section).toContainText("Unusual spend and usage checks are on");
      await expect(section).toContainText("Only owners and admins can manage budgets and alert rules.");
      await expect(section.getByRole("button")).toHaveCount(0);
      await expect(section.getByLabel("Metric to mute")).toHaveCount(0);
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
