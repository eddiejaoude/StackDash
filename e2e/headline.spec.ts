import AxeBuilder from "@axe-core/playwright";

import type { Database } from "../src/lib/supabase/database.types";

import { expect, ownerTest } from "./fixtures/auth";
import { waitForTrends } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";

// Seeds its own workspace with synthetic data: an Example provider (fake) connection with spend,
// signups, and deploys, a Stripe connection with revenue, a Supabase connection with signups but
// no spend, and a PostHog connection that reports signups only as a total per UTC day. Amounts
// grow faster this week than before, so every comparison has a direction.

const DAY_MS = 86_400_000;

type Provider = "fake" | "stripe" | "supabase" | "posthog";

type SnapshotInsert = Database["public"]["Tables"]["usage_snapshots"]["Insert"];
type EventInsert = Database["public"]["Tables"]["activity_events"]["Insert"];

const usd = (amountMinor: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(amountMinor / 100);
const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);

type Seeded = Readonly<{ days: number }>;

async function seedHeadline(workspace: TestWorkspace): Promise<Seeded> {
  const admin = adminClient();
  const now = Date.now();
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const weekStart = today - ((new Date(now).getUTCDay() + 6) % 7) * DAY_MS;
  const previousStart = weekStart - 7 * DAY_MS;
  // The day before the previous month began, so both windows of either kind start after the first
  // reading on any date: the month view compares with the previous month's first days.
  const firstDay = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() - 1, 1) - DAY_MS;
  const syncedAt = new Date(Math.max(today + 1000, now - 60_000)).toISOString();

  const { data: connections, error: connectionsError } = await admin
    .from("connections")
    .insert(
      (["fake", "stripe", "supabase", "posthog"] as const).map((provider) => ({
        workspace_id: workspace.id,
        provider,
        status: "active" as const,
        granted_at: new Date().toISOString(),
        display_name: `${provider} headline connection`,
        poll_interval_seconds: 3_600,
        last_synced_at: syncedAt,
      })),
    )
    .select("id, provider");
  if (connectionsError) throw new Error(`Seeding connections failed (code ${connectionsError.code}).`);
  const { data: accounts, error: accountsError } = await admin
    .from("external_accounts")
    .insert(
      connections.map((connection) => ({
        workspace_id: workspace.id,
        connection_id: connection.id,
        external_id: `acct_${connection.provider}`,
        display_name: `${connection.provider} account`,
        kind: "account",
      })),
    )
    .select("id, connection_id");
  if (accountsError) throw new Error(`Seeding accounts failed (code ${accountsError.code}).`);
  const ids = (provider: Provider) => {
    const connection = connections.find((row) => row.provider === provider);
    const account = accounts.find((row) => row.connection_id === connection?.id);
    if (connection === undefined || account === undefined) throw new Error(`No seeded ${provider} account.`);
    return { connection_id: connection.id, external_account_id: account.id };
  };

  // Month to date running totals, one reading a day, as an hourly sync leaves them.
  const runningTotal = (
    provider: "fake" | "stripe",
    metric: Pick<SnapshotInsert, "metric_key" | "kind" | "label">,
    rate: (day: number) => number,
  ): SnapshotInsert[] => {
    const rows: SnapshotInsert[] = [];
    for (let day = firstDay; day <= today; day += DAY_MS) {
      const monthStart = Date.UTC(new Date(day).getUTCFullYear(), new Date(day).getUTCMonth(), 1);
      let amount = 0;
      for (let earlier = monthStart; earlier <= day; earlier += DAY_MS) amount += rate(earlier);
      const retrievedAt = day === today ? syncedAt : new Date(day + 12 * 3_600_000).toISOString();
      rows.push({
        workspace_id: workspace.id,
        ...ids(provider),
        ...metric,
        snapshot_date: isoDate(day),
        amount_minor: amount,
        currency: "USD",
        period_start: new Date(monthStart).toISOString(),
        period_end: retrievedAt,
        retrieved_at: retrievedAt,
        provenance_source: "provider_api",
      });
    }
    return rows;
  };
  const thisWeek = (high: number, low: number) => (day: number) => (day >= weekStart ? high : low);
  // PostHog's signups for each whole UTC day, read the next morning: 2 a day this week, 1 a day
  // last week, none before, so the same days last month had no signups from anyone.
  const postHogTotals: SnapshotInsert[] = [];
  for (let day = firstDay; day < today; day += DAY_MS) {
    const retrievedAt = new Date(Math.min(day + DAY_MS + 3_600_000, now)).toISOString();
    postHogTotals.push({
      workspace_id: workspace.id,
      ...ids("posthog"),
      metric_key: "posthog.signups.daily",
      kind: "usage",
      label: "Daily signups",
      snapshot_date: isoDate(day + DAY_MS),
      value: day >= weekStart ? 2 : day >= previousStart ? 1 : 0,
      unit: "signups",
      period_start: new Date(day).toISOString(),
      period_end: new Date(day + DAY_MS).toISOString(),
      retrieved_at: retrievedAt,
      provenance_source: "provider_api",
    });
  }
  const { error: snapshotsError } = await admin.from("usage_snapshots").insert([
    ...runningTotal("fake", { metric_key: "fake.spend.month", kind: "verified_spend", label: "Spend this month" }, thisWeek(1_000, 500)),
    ...runningTotal("stripe", { metric_key: "stripe.revenue.month.usd", kind: "revenue", label: "Revenue this month" }, thisWeek(5_000, 4_000)),
    ...postHogTotals,
    // Supabase reports no spend; this reading says it was connected before both windows.
    {
      workspace_id: workspace.id,
      ...ids("supabase"),
      metric_key: "supabase.plan.monthly_active_users",
      kind: "included_allowance",
      label: "Monthly active users",
      snapshot_date: isoDate(firstDay),
      value: 50_000,
      unit: "users",
      point_at: new Date(firstDay + 12 * 3_600_000).toISOString(),
      retrieved_at: new Date(firstDay + 12 * 3_600_000).toISOString(),
      provenance_source: "provider_api",
    },
  ]);
  if (snapshotsError) throw new Error(`Seeding snapshots failed (code ${snapshotsError.code}).`);

  const currentAt = new Date(Math.max(weekStart, now - 60_000)).toISOString();
  const previousAt = new Date(previousStart + 60_000).toISOString();
  const events = (
    provider: "fake" | "supabase",
    typeId: string,
    title: string,
    counts: Readonly<{ current: number; previous: number }>,
  ): EventInsert[] =>
    (["current", "previous"] as const).flatMap((window) =>
      Array.from({ length: counts[window] }, (_, index) => ({
        workspace_id: workspace.id,
        ...ids(provider),
        provider,
        type_id: typeId,
        severity: "success" as const,
        title,
        occurred_at: window === "current" ? currentAt : previousAt,
        dedupe_key: `${typeId}:${window}:${index}`,
      })),
    );
  const { error: eventsError } = await admin.from("activity_events").insert([
    ...events("fake", "fake.signup", "New signup", { current: 4, previous: 2 }),
    ...events("supabase", "supabase.auth.signup", "New signup", { current: 2, previous: 1 }),
    ...events("fake", "fake.deploy.succeeded", "Deployment succeeded", { current: 5, previous: 5 }),
  ]);
  if (eventsError) throw new Error(`Seeding events failed (code ${eventsError.code}).`);
  return { days: (today - weekStart) / DAY_MS + 1 };
}

ownerTest.describe("dashboard headline strip", () => {
  ownerTest("puts revenue against spend, signups, cost per signup, and deploys over one window", async ({ page }) => {
    const workspace = await createTestWorkspace("Dashboard headline");
    try {
      const { days } = await seedHeadline(workspace);
      await page.goto(`/w/${workspace.slug}/dashboard`);
      const strip = page.getByRole("region", { name: "This week so far" });
      await expect(strip).toContainText(/\d{4}-\d{2}-\d{2}.* in UTC, compared with \d{4}-\d{2}-\d{2}/);
      await expect(strip.getByRole("link", { name: "This week" })).toHaveAttribute("aria-current", "page");

      // Labels in reading order, each followed by its value. Inner text, so the closed tooltip is not read.
      const labels = ["Revenue", "Spend", "Revenue minus spend", "Signups", "Cost per signup", "Deploys"];
      await expect(strip.getByRole("term")).toHaveText(labels, { useInnerText: true });
      const figure = (label: string) => strip.getByRole("definition").nth(labels.indexOf(label));
      // PostHog counts whole UTC days up to yesterday: 2 signups a day now, 1 a day on as many days
      // last week. On a Monday there is no whole day yet, so it is named unavailable instead.
      const wholeDays = days - 1;

      await expect(figure("Revenue")).toContainText(usd(5_000 * days));
      await expect(figure("Revenue")).toContainText(`Up 25 percent from ${usd(4_000 * days)} on the same days last week`);
      await expect(figure("Spend")).toContainText(usd(1_000 * days));
      await expect(figure("Spend")).toContainText(`Up 100 percent from ${usd(500 * days)} on the same days last week`);
      // PostHog and Stripe report spend but have none here: named, never counted as zero. Supabase
      // never reports spend, so it is not named as failing to (#286).
      await expect(figure("Spend")).toContainText("Unavailable from PostHog and Stripe, not counted.");
      await expect(figure("Revenue minus spend")).toContainText(usd(4_000 * days));
      await expect(figure("Revenue minus spend")).toContainText(`Up 14 percent from ${usd(3_500 * days)}`);
      // Stripe's revenue counts; only its spend, and the others', are left out.
      await expect(figure("Revenue minus spend")).toContainText("Leaves out spend from PostHog and Stripe, unavailable for this window.");
      await expect(figure("Revenue minus spend")).not.toContainText("Leaves out revenue");
      // Twice the spend over twice the signups.
      await expect(figure("Cost per signup")).toContainText("No change from");
      await expect(figure("Signups")).toContainText(`${6 + 2 * wholeDays} signups`);
      await expect(figure("Signups")).toContainText(`Up 100 percent from ${3 + wholeDays} signups on the same days last week`);
      await expect(figure("Signups")).toContainText("PostHog counts signups by whole UTC day, so today is not in its count yet.");
      await expect(figure("Signups")).toContainText(
        wholeDays > 0 ? "From Example provider, PostHog, and Supabase." : "From Example provider and Supabase. Unavailable from PostHog, not counted.",
      );
      await expect(figure("Deploys")).toContainText("5 deploys");
      await expect(figure("Deploys")).toContainText("No change from 5 deploys on the same days last week");
      // Direction is always a word; verified and estimated are labeled in words too.
      await expect(figure("Revenue").getByText("Verified", { exact: true })).toBeVisible();

      // Keyboard: from the window choice, Tab reaches the cost per signup explanation.
      await strip.getByRole("link", { name: "This month" }).focus();
      await page.keyboard.press("Tab");
      const explain = strip.getByRole("button", { name: "How cost per signup is worked out" });
      await expect(explain).toBeFocused();
      const tooltip = strip.getByRole("tooltip");
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText(
        wholeDays > 0
          ? "Spend from Example provider, divided by signups from Example provider, PostHog, and Supabase. PostHog counts signups by whole UTC day, so today is not in its count yet. Leaves out spend from PostHog and Stripe, unavailable for this window."
          : "Spend from Example provider, divided by signups from Example provider and Supabase. Leaves out spend from PostHog and Stripe, unavailable for this window. Leaves out signups from PostHog, unavailable for this window.",
      );
      await expect(explain).toHaveAccessibleDescription(/^Spend from Example provider, divided by signups/);
      await page.keyboard.press("Escape");
      await expect(tooltip).toBeHidden();
      // Opened by hover with focus elsewhere, Escape still dismisses it (WCAG 1.4.13).
      await strip.getByRole("link", { name: "This month" }).focus();
      await explain.hover();
      await expect(tooltip).toBeVisible();
      await expect(explain).not.toBeFocused();
      await page.keyboard.press("Escape");
      await expect(tooltip).toBeHidden();

      await waitForTrends(page);
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      await strip.getByRole("link", { name: "This month" }).click();
      await expect(page).toHaveURL(/[?&]window=month(&|$)/);
      const month = page.getByRole("region", { name: "This month so far" });
      await expect(month.getByRole("link", { name: "This month" })).toHaveAttribute("aria-current", "page");
      await expect(month.getByRole("definition").first()).toContainText("on the same days last month");
      // The seeded signups fall after the same days last month, so there is nothing to divide by then,
      // on any date: the history reaches back to before the previous month began.
      await expect(month.getByRole("definition").nth(labels.indexOf("Cost per signup"))).toContainText(
        "No comparison: there were no signups on the same days last month",
      );

      // The scope filter narrows the strip: without Stripe there is no revenue to show.
      await page.goto(`/w/${workspace.slug}/dashboard?provider=fake`);
      const scoped = page.getByRole("region", { name: "This week so far" });
      await expect(scoped.getByRole("definition").first()).toContainText("Unavailable");
      await expect(scoped.getByRole("definition").first()).toContainText("No provider in this view reports revenue.");
      await expect(scoped.getByRole("definition").nth(1)).toContainText("From Example provider.");
      await expect(scoped.getByRole("definition").nth(1)).not.toContainText("Unavailable from");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
