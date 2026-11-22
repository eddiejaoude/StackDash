import { randomUUID } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { z } from "zod";

import { createSyntheticUser, expect, removeSyntheticUser, type SyntheticUser } from "./fixtures/auth";
import { adminClient, notDueForAMonth, personalWorkspace, type Admin } from "./fixtures/db";
import { expectTopRowFits } from "./fixtures/header";

/*
 * Account deletion (#42) and the account's place in the headers (#175). Every test signs in as
 * fresh synthetic users created here and removed afterwards; the shared e2e owner and viewer are
 * never deleted. The web server runs with STACKDASH_ENABLE_FAKE_PROVIDER=1, so the seeded fake
 * connection never reaches a live provider.
 */

async function signedInContext(browser: Browser, user: SyntheticUser): Promise<BrowserContext> {
  return browser.newContext({ storageState: { cookies: user.cookies, origins: [] } });
}

/** One of everything a workspace holds: a project, a fake connection and its data, rules, a job. */
async function seedWorkspace(admin: Admin, workspaceId: string): Promise<void> {
  const { data: project, error: projectError } = await admin
    .from("projects")
    .insert({ workspace_id: workspaceId, name: "Checkout" })
    .select("id")
    .single();
  if (projectError) throw new Error(`Seeding a project failed (code ${projectError.code}).`);

  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspaceId,
      provider: "fake",
      status: "active",
      granted_at: new Date().toISOString(),
      display_name: "Example provider (Example team)",
      poll_interval_seconds: 3600,
      next_sync_at: notDueForAMonth(),
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);

  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({
      workspace_id: workspaceId,
      connection_id: connection.id,
      external_id: "fake-acct-1",
      display_name: "Example team",
      kind: "team",
      project_id: project.id,
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);

  const { error: snapshotError } = await admin.from("usage_snapshots").insert({
    workspace_id: workspaceId,
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

  const { data: budget, error: budgetError } = await admin
    .from("budgets")
    .insert({ workspace_id: workspaceId, name: "Monthly", scope: "workspace", amount_minor: 10_000, currency: "USD" })
    .select("id")
    .single();
  if (budgetError) throw new Error(`Seeding a budget failed (code ${budgetError.code}).`);

  const { data: rule, error: ruleError } = await admin
    .from("alert_rules")
    .insert({ workspace_id: workspaceId, kind: "budget_percent", scope: "workspace", budget_id: budget.id, threshold_percent: 80 })
    .select("id")
    .single();
  if (ruleError) throw new Error(`Seeding an alert rule failed (code ${ruleError.code}).`);

  const { error: alertError } = await admin.from("triggered_alerts").insert({
    workspace_id: workspaceId,
    rule_id: rule.id,
    cycle_key: "2026-10-01",
    triggered_at: "2026-10-31T09:30:00Z",
    observed_value: 85,
    threshold_label: "80 percent",
    is_estimated: true,
    message: "Spend is at 85 percent of the Monthly budget.",
  });
  if (alertError) throw new Error(`Seeding a triggered alert failed (code ${alertError.code}).`);

  const { error: eventError } = await admin.from("activity_events").insert({
    workspace_id: workspaceId,
    connection_id: connection.id,
    provider: "fake",
    type_id: "fake.deployment_failed",
    severity: "warning",
    title: "Deployment failed",
    occurred_at: "2026-10-31T08:00:00Z",
    dedupe_key: `account-e2e:${randomUUID()}`,
  });
  if (eventError) throw new Error(`Seeding an event failed (code ${eventError.code}).`);

  // Far in the future so no tick picks it up while the test runs.
  const { error: jobError } = await admin.from("sync_jobs").insert({
    workspace_id: workspaceId,
    connection_id: connection.id,
    kind: "sync",
    run_after: "2099-01-01T00:00:00Z",
  });
  if (jobError) throw new Error(`Seeding a sync job failed (code ${jobError.code}).`);
}

/** Rows left in every tenant table for `workspaceId`, by table. */
async function rowsReferencingWorkspace(admin: Admin, workspaceId: string): Promise<Record<string, number | null>> {
  const head = { count: "exact", head: true } as const;
  const results = await Promise.all([
    admin.from("workspaces").select("id", head).eq("id", workspaceId),
    admin.from("workspace_members").select("user_id", head).eq("workspace_id", workspaceId),
    admin.from("profiles").select("user_id", head).eq("last_workspace_id", workspaceId),
    admin.from("projects").select("id", head).eq("workspace_id", workspaceId),
    admin.from("connections").select("id", head).eq("workspace_id", workspaceId),
    admin.from("connection_credentials").select("connection_id", head).eq("workspace_id", workspaceId),
    admin.from("oauth_states").select("state", head).eq("workspace_id", workspaceId),
    admin.from("external_accounts").select("id", head).eq("workspace_id", workspaceId),
    admin.from("usage_snapshots").select("id", head).eq("workspace_id", workspaceId),
    admin.from("activity_events").select("id", head).eq("workspace_id", workspaceId),
    admin.from("budgets").select("id", head).eq("workspace_id", workspaceId),
    admin.from("alert_rules").select("id", head).eq("workspace_id", workspaceId),
    admin.from("triggered_alerts").select("id", head).eq("workspace_id", workspaceId),
    admin.from("sync_jobs").select("id", head).eq("workspace_id", workspaceId),
  ]);
  const tables = [
    "workspaces",
    "workspace_members",
    "profiles",
    "projects",
    "connections",
    "connection_credentials",
    "oauth_states",
    "external_accounts",
    "usage_snapshots",
    "activity_events",
    "budgets",
    "alert_rules",
    "triggered_alerts",
    "sync_jobs",
  ];
  return Object.fromEntries(
    results.map(({ count, error }, index) => {
      if (error) throw new Error(`Counting ${tables[index]} failed (code ${error.code}).`);
      return [tables[index], count];
    }),
  );
}

async function userExists(admin: Admin, userId: string): Promise<boolean> {
  const { data, error } = await admin.auth.admin.getUserById(userId);
  return error === null && data.user !== null;
}

test.describe("the account header", () => {
  test("fits a phone without horizontal overflow, and offers the workspace link from sm up", async ({ browser }) => {
    const user = await createSyntheticUser("header");
    const context = await signedInContext(browser, user);
    try {
      const page = await context.newPage();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/account");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Account");
      // The streamed account content has landed, so the width below is measured on the full page.
      const details = page.getByRole("region", { name: "Sign-in details" });
      await expect(details.getByText(user.email, { exact: true })).toBeVisible();

      const header = page.getByRole("banner");
      const brand = header.getByRole("link", { name: "StackDash", exact: true });
      const workspace = header.getByRole("link", { name: "Open your workspace", exact: true });
      await expect(brand).toBeVisible();
      await expect(brand).toHaveAttribute("href", "/app");
      await expect(header.getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
      // The brand already opens the workspace, so the duplicate link gives way on a phone.
      await expect(workspace).toBeHidden();
      expect(await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth)).toBe(true);

      // At the sm breakpoint the link returns, still leading to the workspace.
      await page.setViewportSize({ width: 640, height: 844 });
      await expect(workspace).toBeVisible();
      await expect(workspace).toHaveAttribute("href", "/app");
    } finally {
      await context.close();
      await removeSyntheticUser(user);
    }
  });
});

/*
 * Who is signed in, in the workspace header (#175). Avatars are answered here, never fetched from
 * GitHub: the browser loads them directly (the app CSP allows avatars.githubusercontent.com).
 */
const AVATAR_URL = "https://avatars.githubusercontent.com/u/1?v=4";
const AVATAR_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" fill="#3b82f6"/></svg>';

async function openWorkspace(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto("/app");
  await expect(page).toHaveURL(/\/w\/[a-z2-7]{10}\//);
  await expect(page.getByRole("banner").getByRole("button", { name: "Sign out", exact: true })).toBeVisible();
  return page;
}

test.describe("the workspace header identity", () => {
  test("shows the GitHub display name and avatar, fits a phone, and opens the Account page by keyboard", async ({ browser }) => {
    const user = await createSyntheticUser("identity", { full_name: "Ada Example", name: "Ada Example", avatar_url: AVATAR_URL });
    const context = await signedInContext(browser, user);
    await context.route("https://avatars.githubusercontent.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "image/svg+xml", body: AVATAR_SVG }),
    );
    try {
      const page = await openWorkspace(context);
      const account = page.getByRole("banner").getByRole("link", { name: "Account: Ada Example", exact: true });
      await expect(account).toHaveAttribute("href", "/account");
      await expect(account).toHaveText("Account: Ada Example");
      await expect(account.getByText("Ada Example", { exact: true })).toBeVisible();

      // The name beside it already says who this is, so the avatar is decorative, and it loaded.
      const avatar = account.getByTestId("account-avatar");
      await expect(avatar).toHaveAttribute("alt", "");
      await expect(avatar).toHaveAttribute("src", `${AVATAR_URL}&s=64`);
      await expect.poll(() => avatar.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBe(64);

      const scan = await new AxeBuilder({ page }).include("header").analyze();
      expect(scan.violations).toEqual([]);
      await expectTopRowFits(page, "Account: Ada Example");

      // Keyboard: tab forward from the workspace switcher until the identity link has focus.
      await page.getByRole("banner").getByRole("button", { name: /^Workspace: / }).focus();
      for (let presses = 0; presses < 10 && !(await account.evaluate((link) => link === document.activeElement)); presses++) {
        await page.keyboard.press("Tab");
      }
      await expect(account).toBeFocused();
      expect(await account.evaluate((link) => getComputedStyle(link).outlineStyle)).toBe("solid");

      // On a phone the avatar stands for the link; the name is visually hidden (sr-only, so 1 px,
      // which Playwright still counts as visible) and stays in the link's accessible name.
      for (const width of [375, 320]) {
        await page.setViewportSize({ width, height: 700 });
        await expect
          .poll(async () => (await account.getByText("Ada Example", { exact: true }).boundingBox())?.width)
          .toBeLessThanOrEqual(1);
        await expect(avatar).toBeVisible();
        await expectTopRowFits(page, "Account: Ada Example");
      }

      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/account$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Account");
    } finally {
      await context.close();
      await removeSyntheticUser(user);
    }
  });

  test("falls back to the GitHub username and a person icon when there is no display name and the avatar fails", async ({
    browser,
  }) => {
    const user = await createSyntheticUser("identity-fallback", { avatar_url: AVATAR_URL });
    const context = await signedInContext(browser, user);
    await context.route("https://avatars.githubusercontent.com/**", (route) => route.fulfill({ status: 404, body: "" }));
    try {
      const page = await openWorkspace(context);
      const accountName = `Account: ${user.userName}`;
      const account = page.getByRole("banner").getByRole("link", { name: accountName, exact: true });
      await expect(account.getByText(user.userName, { exact: true })).toBeVisible();

      // The failed avatar is removed rather than drawn broken, and the person icon shows instead.
      await expect(account.getByTestId("account-avatar")).toHaveCount(0);
      await expect(account.getByTestId("account-avatar-fallback")).toBeVisible();
      await expectTopRowFits(page, accountName);

      await account.click();
      await expect(page).toHaveURL(/\/account$/);
    } finally {
      await context.close();
      await removeSyntheticUser(user);
    }
  });
});

test.describe("an account with no workspace", () => {
  test("explains why and who can help, in product words, and passes axe", async ({ browser }) => {
    const admin = adminClient();
    const user = await createSyntheticUser("no-workspace");
    const context = await signedInContext(browser, user);
    try {
      // The only way to reach this page: the user's one workspace is gone.
      const workspaceId = (await personalWorkspace(user.id)).id;
      const { error } = await admin.from("workspaces").delete().eq("id", workspaceId);
      if (error) throw new Error(`Deleting the personal workspace failed (code ${error.code}).`);

      const page = await context.newPage();
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto("/app");
      const main = page.getByRole("main");
      await expect(main.getByRole("heading", { level: 1 })).toHaveText("You are not a member of any workspace");
      // #345: the product says "StackDash", never "the StackDash test".
      await expect(main).toContainText("Contact the person who invited you to StackDash, or sign out");
      await expect(main).not.toContainText(/StackDash test/);
      await expect(main.getByRole("button", { name: "Sign out" })).toBeVisible();
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await context.close();
      await removeSyntheticUser(user);
    }
  });
});

test.describe("deleting an account", () => {
  test("lists what goes, needs the email, then deletes the user and every row of their workspace", async ({ browser }) => {
    const admin = adminClient();
    const user = await createSyntheticUser("delete");
    const context = await signedInContext(browser, user);
    try {
      const workspaceId = (await personalWorkspace(user.id)).id;
      await seedWorkspace(admin, workspaceId);

      const page = await context.newPage();
      await page.goto("/account");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Account");

      // The confirmation lists exactly what is deleted.
      const deleted = page.getByRole("list", { name: "What is deleted" });
      await expect(deleted).toContainText("The Personal workspace (personal), with:");
      for (const line of [
        "1 Example provider connection and their stored credentials",
        "1 connected account",
        "1 project",
        "1 budget",
        "1 alert rule",
      ]) {
        await expect(deleted.getByText(line, { exact: true })).toBeVisible();
      }
      await expect(deleted).toContainText(/About \d+ history records/);

      // And what StackDash cannot revoke itself, with the steps to do it by hand.
      const manual = page.getByRole("list", { name: "Providers to revoke by hand" });
      await expect(manual.getByRole("listitem")).toHaveCount(1);
      await expect(manual).toContainText("Example provider does not let apps revoke their own access.");
      await expect(manual).toContainText("Remove StackDash's access in your Example provider account settings.");

      // The button stays disabled until the account email is typed.
      const confirmation = page.getByRole("textbox", { name: "Type your email address or GitHub username to confirm" });
      const button = page.getByRole("button", { name: "Delete my account" });
      await expect(button).toBeDisabled();
      await confirmation.fill("someone-else@example.com");
      await expect(button).toBeDisabled();
      await confirmation.fill(user.email.toUpperCase());
      await expect(button).toBeEnabled();
      // axe's color-contrast rule skips disabled controls, so the scan waits for the enabled
      // button to finish its fade in and checks the state a person is about to press.
      await expect(button).toHaveCSS("opacity", "1");
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
      await button.click();

      await expect(page).toHaveURL(/\/account\/deleted\?manual=fake$/);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your account is deleted");
      await expect(page.getByRole("list", { name: "Providers to revoke by hand" })).toContainText("Example provider");

      // Signed out: the account page now asks to sign in.
      await page.goto("/account");
      await expect(page).toHaveURL(/\/sign-in\?next=%2Faccount$/);

      expect(await userExists(admin, user.id)).toBe(false);
      expect(await rowsReferencingWorkspace(admin, workspaceId)).toEqual({
        workspaces: 0,
        workspace_members: 0,
        profiles: 0,
        projects: 0,
        connections: 0,
        connection_credentials: 0,
        oauth_states: 0,
        external_accounts: 0,
        usage_snapshots: 0,
        activity_events: 0,
        budgets: 0,
        alert_rules: 0,
        triggered_alerts: 0,
        sync_jobs: 0,
      });
      const { count: profiles } = await admin
        .from("profiles")
        .select("user_id", { count: "exact", head: true })
        .eq("user_id", user.id);
      expect(profiles).toBe(0);
    } finally {
      await context.close();
      await removeSyntheticUser(user);
    }
  });

  test("stops the sole owner of a workspace with another member, and deletes nothing", async ({ browser }) => {
    const admin = adminClient();
    const owner = await createSyntheticUser("sole-owner");
    const member = await createSyntheticUser("member");
    const context = await signedInContext(browser, owner);
    let sharedId: string | null = null;
    try {
      const name = `Shared ${randomUUID().slice(0, 8)}`;
      const { data, error } = await admin.rpc("create_workspace", { p_user_id: owner.id, p_name: name, p_is_personal: false });
      if (error) throw new Error(`Creating the shared workspace failed (code ${error.code}).`);
      sharedId = z.object({ id: z.string() }).parse(data).id;
      const personalId = (await personalWorkspace(owner.id)).id;
      await seedWorkspace(admin, personalId);

      // The page is loaded while the owner is still the only member, so the form is offered.
      const page = await context.newPage();
      await page.goto("/account");
      await expect(page.getByRole("list", { name: "What is deleted" })).toContainText(`The ${name} workspace`);
      await page.getByRole("textbox", { name: "Type your email address or GitHub username to confirm" }).fill(owner.email);

      // Someone joins before the button is pressed: the server plans again and refuses.
      const { error: memberError } = await admin
        .from("workspace_members")
        .insert({ workspace_id: sharedId, user_id: member.id, role: "viewer" });
      if (memberError) throw new Error(`Adding the member failed (code ${memberError.code}).`);
      await page.getByRole("button", { name: "Delete my account" }).click();
      await expect(page.getByRole("alert").filter({ hasText: "Your account was not deleted." })).toContainText(
        `You are the only owner of ${name}, and other people belong to it. Transfer ownership to another member or delete that workspace first, then try again.`,
      );
      await expect(page).toHaveURL(/\/account$/);

      // Reloaded, the page explains the block and offers no way to delete.
      await page.reload();
      await expect(page.getByRole("heading", { name: "You cannot delete your account yet" })).toBeVisible();
      await expect(page.getByRole("list", { name: "Workspaces that need another owner" })).toContainText(name);
      await expect(page.getByRole("button", { name: "Delete my account" })).toHaveCount(0);
      await expect(page.getByText("Nothing has been deleted.")).toBeVisible();

      // Nothing was deleted: the user, both workspaces, and the personal workspace's data remain.
      expect(await userExists(admin, owner.id)).toBe(true);
      const shared = await rowsReferencingWorkspace(admin, sharedId);
      expect(shared.workspaces).toBe(1);
      expect(shared.workspace_members).toBe(2);
      const personal = await rowsReferencingWorkspace(admin, personalId);
      expect(personal).toMatchObject({ workspaces: 1, workspace_members: 1, projects: 1, connections: 1, budgets: 1 });
      const { data: connection } = await admin.from("connections").select("status").eq("workspace_id", personalId).single();
      expect(connection?.status).toBe("active");
    } finally {
      await context.close();
      // The shared workspace goes first: while it has another member, the owner cannot be deleted.
      if (sharedId !== null) await admin.from("workspaces").delete().eq("id", sharedId);
      await removeSyntheticUser(owner);
      await removeSyntheticUser(member);
    }
  });
});
