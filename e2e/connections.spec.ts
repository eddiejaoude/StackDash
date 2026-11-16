import { test, type APIResponse, type Page } from "@playwright/test";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, CONNECTION_URL, createTestWorkspace, deleteTestWorkspace } from "./fixtures/db";
import { expectFailureInDialog } from "./fixtures/dialogs";
import { expectHydrated } from "./fixtures/hydration";
import { insertUnheard } from "./fixtures/realtime";

/*
 * Connecting a provider (#40), end to end against the fake provider: the web server runs with
 * STACKDASH_ENABLE_FAKE_PROVIDER=1 and FAKE_PROVIDER_CLIENT_ID/SECRET set, so no live provider is
 * ever called. Each test seeds only inside its own workspace.
 */

const PROVIDER_NAME = "Example provider";

function connectionIdFrom(page: Page): string {
  const id = CONNECTION_URL.exec(page.url())?.[1];
  if (id === undefined) throw new Error(`Not on a connection page: ${page.url()}`);
  return id;
}

/**
 * Posts the disclosure form to the start route, as the browser does: same-origin, with the
 * site's Origin header.
 */
function postStart(page: Page, provider: string, form: Record<string, string>) {
  return page.request.post(`/api/connections/${provider}/start`, {
    form,
    headers: { Origin: new URL(test.info().project.use.baseURL ?? "").origin },
    maxRedirects: 0,
  });
}

// Seeded rather than connected through the UI: the failure tests force a failure by deleting the
// row behind the open dialog, and Realtime refreshes the page on inserts and updates only. The
// seed's own insert must not reach the page either, or its refresh can land after the delete and
// render the page as not found (#448), so Realtime has read it before the page opens.
function seedConnection(workspaceId: string): Promise<string> {
  return insertUnheard("connections", workspaceId, () => insertConnection(workspaceId));
}

async function insertConnection(workspaceId: string): Promise<string> {
  const { data, error } = await adminClient()
    .from("connections")
    .insert({
      workspace_id: workspaceId,
      provider: "fake",
      status: "active",
      display_name: `${PROVIDER_NAME} (Seeded team)`,
      authorized_account_label: "Seeded team",
      poll_interval_seconds: 3600,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Seeding a connection failed (code ${error.code}).`);
  return data.id;
}

async function deleteConnectionRow(id: string): Promise<void> {
  const { error } = await adminClient().from("connections").delete().eq("id", id);
  if (error) throw new Error(`Deleting the connection failed (code ${error.code}).`);
}

const GONE_MESSAGE = "That item no longer exists in this workspace. Reload the page to see what is current.";

/**
 * Reads the authorize URL from the start route's handoff page: the target of its "Continue to"
 * link, parsed with DOMParser, whose documents are inert, so the meta refresh never runs. Checks
 * the refresh points at the same URL and that the page carries no script.
 */
async function handoffUrl(page: Page, response: APIResponse): Promise<URL> {
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expect(headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(headers["cache-control"]).toContain("no-store");
  const html = await response.text();
  expect(html).not.toMatch(/<script/i);
  const { href, refresh } = await page.evaluate(
    ({ source, name }) => {
      const doc = new DOMParser().parseFromString(source, "text/html");
      const link = [...doc.querySelectorAll("a")].find((anchor) => anchor.textContent === name);
      return {
        href: link?.getAttribute("href") ?? null,
        refresh: doc.querySelector('meta[http-equiv="refresh"]')?.getAttribute("content") ?? null,
      };
    },
    { source: html, name: `Continue to ${PROVIDER_NAME}` },
  );
  if (href === null) throw new Error("The start route did not answer with the handoff page.");
  expect(refresh).toBe(`0;url=${href}`);
  return new URL(href);
}

/**
 * Calls the start route as the signed-in user, lets `edit` change the fake authorize URL (to
 * decline a scope or cancel, as a person would on a real consent screen), then follows it.
 */
async function startFakeConnect(page: Page, slug: string, edit: (url: URL) => void): Promise<void> {
  const response = await postStart(page, "fake", { workspace: slug, consent: "1" });
  const authorize = await handoffUrl(page, response);
  expect(authorize.pathname).toBe("/api/dev/fake-provider/authorize");
  edit(authorize);
  await page.goto(authorize.href);
}

/**
 * Connects the fake provider through the catalog and disclosure page, with the keyboard. The
 * start route answers with the handoff page, whose meta refresh moves on to the fake authorize
 * route, so the browser ends on the new connection.
 */
async function connectThroughUi(page: Page, slug: string): Promise<string> {
  await page.goto(`/w/${slug}/connections`);
  await page.getByRole("link", { name: `Connect ${PROVIDER_NAME}` }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Connect ${PROVIDER_NAME}`);
  const consent = page.getByRole("checkbox", {
    name: `I understand StackDash gets full access to my ${PROVIDER_NAME} account`,
  });
  await consent.focus();
  await page.keyboard.press("Space");
  await expect(consent).toBeChecked();
  await page.getByRole("button", { name: `Continue to ${PROVIDER_NAME}` }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(CONNECTION_URL);
  return connectionIdFrom(page);
}

ownerTest.describe("connecting a provider as the owner", () => {
  ownerTest("discloses full access, requires consent, and lands on the connection with its accounts", async ({ page }) => {
    const workspace = await createTestWorkspace("Connect");
    try {
      await page.goto(`/w/${workspace.slug}/connections`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connections");
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      // Page-wide text also finds the header's live indicator, whose hidden tooltip lists the
      // workspace's connections with their status, or says "No connections yet". Assert on the
      // page's own content.
      await expect(page.getByRole("main").getByText("No connections yet")).toBeVisible();

      const card = page.getByRole("list", { name: "Providers" }).getByRole("listitem").filter({ hasText: PROVIDER_NAME }).first();
      await expect(card.getByText("Requests per month and the requests included in the plan")).toBeVisible();
      await card.getByRole("link", { name: `Connect ${PROVIDER_NAME}` }).click();

      // Disclosure: every permission with its access label, and the reason for full access.
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Connect ${PROVIDER_NAME}`);
      const permissions = page.getByRole("region", { name: `Permissions ${PROVIDER_NAME} will ask you to grant` });
      const usage = permissions.getByRole("listitem").filter({ hasText: "usage:read" });
      const admin = permissions.getByRole("listitem").filter({ hasText: "admin" }).filter({ hasText: "Full access" });
      await expect(usage.getByText("Read", { exact: true })).toBeVisible();
      await expect(admin.getByText("Full access", { exact: true })).toBeVisible();
      await expect(admin.getByText(/Why full access:/)).toBeVisible();

      // Continuing without consent is refused, and focus moves to the error summary.
      await page.getByRole("button", { name: `Continue to ${PROVIDER_NAME}` }).click();
      const summary = page.getByRole("alert").filter({ hasText: "Confirm full access to continue" });
      await expect(summary).toBeVisible();
      await expect(summary).toBeFocused();
      const consent = page.getByRole("checkbox", {
        name: `I understand StackDash gets full access to my ${PROVIDER_NAME} account`,
      });
      await expect(consent).toHaveAttribute("aria-invalid", "true");
      await expect(consent).toHaveAccessibleDescription(/Tick this box to continue\./);

      const connectionId = await connectThroughUi(page, workspace.slug);
      await expect(page.getByRole("heading", { level: 1 })).toContainText(PROVIDER_NAME);
      const connected = page.getByRole("status").filter({ hasText: `${PROVIDER_NAME} connected` });
      await expect(connected).toBeVisible();
      // The banner names the next step (#322): the timeline, where the first sync's events arrive.
      const openTimeline = connected.getByRole("link", { name: "Open the timeline" });
      await expect(openTimeline).toHaveAttribute("href", `/w/${workspace.slug}/timeline`);
      await expectNoAxeViolations(page);
      await expect(page.getByRole("region", { name: "Status" }).getByText("Status: Active")).toBeVisible();
      const accounts = page.getByRole("list", { name: "Accounts" });
      await expect(accounts.getByRole("listitem")).toHaveCount(2);
      await expect(accounts.getByText("Example team", { exact: true })).toBeVisible();
      await expect(accounts.getByText("Example sandbox", { exact: true })).toBeVisible();
      await expect(page.getByLabel("Project for Example team")).toBeVisible();

      // Stored server side only: the page never carries the credential.
      const { data: credential } = await adminClient()
        .from("connection_credentials")
        .select("connection_id")
        .eq("connection_id", connectionId)
        .maybeSingle();
      expect(credential?.connection_id).toBe(connectionId);
      expect(await page.content()).not.toContain("fake-at-");

      // Keyboard only: the banner's link opens the timeline, which says the first sync is coming.
      await openTimeline.focus();
      await expect(openTimeline).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline`);
      await expect(page.getByRole("region", { name: "Events are on their way" })).toBeVisible();

      // The list shows it with its status in words.
      await page.goto(`/w/${workspace.slug}/connections`);
      const row = page.getByRole("list", { name: "Connections" }).getByRole("listitem").first();
      await expect(row.getByText("Status: Active")).toBeVisible();
      // Exact: the display name link contains the same words in parentheses.
      await expect(row.getByText("Example team, Example sandbox", { exact: true })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("marks Resend as beta in the catalog with a reason a keyboard or screen reader user reaches", async ({ page }) => {
    const workspace = await createTestWorkspace("Beta badge");
    try {
      await page.goto(`/w/${workspace.slug}/connections`);
      const providers = page.getByRole("list", { name: "Providers" });
      const cards = providers.getByRole("listitem");
      const reason = "StackDash is still checking how Resend returns you here after you approve access, so connecting may fail.";

      // The word and the reason as visible text, and the reason as the connect link's description.
      const resend = cards.filter({ has: page.getByRole("heading", { level: 3, name: "Resend", exact: true }) });
      await expect(resend.getByText("Beta", { exact: true })).toBeVisible();
      await expect(resend.getByText(reason)).toBeVisible();
      await expect(resend.getByRole("link", { name: "Connect Resend" })).toHaveAccessibleDescription(reason);

      // Declared by the Resend adapter only: another card has neither.
      const vercel = cards.filter({ has: page.getByRole("heading", { level: 3, name: "Vercel", exact: true }) });
      await expect(vercel.getByRole("link", { name: "Connect Vercel" })).toBeVisible();
      await expect(vercel.getByText("Beta", { exact: true })).toHaveCount(0);
      await expect(vercel.getByRole("link", { name: "Connect Vercel" })).toHaveAccessibleDescription("");
      await expect(providers.getByText("Beta", { exact: true })).toHaveCount(1);

      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("keeps two connections of the same provider separate", async ({ page }) => {
    const workspace = await createTestWorkspace("Connect twice");
    try {
      const first = await connectThroughUi(page, workspace.slug);
      const second = await connectThroughUi(page, workspace.slug);
      expect(second).not.toBe(first);

      const { data: rows, error } = await adminClient()
        .from("external_accounts")
        .select("id, connection_id, external_id")
        .eq("workspace_id", workspace.id);
      expect(error).toBeNull();
      expect(rows).toHaveLength(4);
      const byConnection = new Map<string, string[]>();
      for (const row of rows ?? []) {
        byConnection.set(row.connection_id, [...(byConnection.get(row.connection_id) ?? []), row.id]);
      }
      expect([...byConnection.keys()].sort()).toEqual([first, second].sort());
      expect(byConnection.get(first)).toHaveLength(2);
      expect(byConnection.get(second)).toHaveLength(2);
      // Same provider accounts, never the same rows.
      expect(new Set((rows ?? []).map((row) => row.id)).size).toBe(4);

      await page.goto(`/w/${workspace.slug}/connections`);
      await expect(page.getByRole("list", { name: "Connections" }).getByRole("listitem")).toHaveCount(2);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("names a declined permission and offers to reconnect", async ({ page }) => {
    const workspace = await createTestWorkspace("Connect declined");
    try {
      await page.goto(`/w/${workspace.slug}/connections`);
      await startFakeConnect(page, workspace.slug, (url) => url.searchParams.set("decline", "usage:read"));
      await expect(page).toHaveURL(CONNECTION_URL);
      await expect(page.getByRole("region", { name: "Status" }).getByText("Status: Needs attention")).toBeVisible();
      const attention = page.getByRole("region", {
        name: `${PROVIDER_NAME} did not grant every permission StackDash needs`,
      });
      await expect(attention).toContainText("Missing: usage:read");
      await attention.getByRole("link", { name: `Reconnect ${PROVIDER_NAME}` }).click();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Reconnect ${PROVIDER_NAME}`);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("saves an account's project and keeps it selected, in line with the account's other controls", async ({ page }) => {
    const workspace = await createTestWorkspace("Account project");
    try {
      const { data: project, error } = await adminClient()
        .from("projects")
        .insert({ workspace_id: workspace.id, name: "Checkout" })
        .select("id")
        .single();
      if (error) throw new Error(`Seeding the project failed (code ${error.code}).`);
      await connectThroughUi(page, workspace.slug);

      const row = page.getByRole("list", { name: "Accounts" }).getByRole("listitem").filter({ hasText: "Example team" });
      const select = row.getByLabel("Project for Example team");
      const save = row.getByRole("button", { name: "Save project" });
      const exclude = row.getByRole("button", { name: "Exclude Example team" });

      // One row of controls: the dropdown, its save button, and Exclude share a top and a height.
      const selectBox = await select.boundingBox();
      if (selectBox === null) throw new Error("The project dropdown is not rendered.");
      for (const button of [save, exclude]) {
        const box = await button.boundingBox();
        if (box === null) throw new Error("An account button is not rendered.");
        expect(Math.abs(box.y - selectBox.y)).toBeLessThanOrEqual(1);
        expect(Math.abs(box.height - selectBox.height)).toBeLessThanOrEqual(1);
      }

      // The form resets after a save: the dropdown must show what was saved, not what it mounted with.
      await select.selectOption({ label: "Checkout" });
      await save.click();
      await expect(row.getByRole("status").filter({ hasText: "Project saved." })).toBeVisible();
      await expect(select).toHaveValue(project.id);
      const { data: account } = await adminClient()
        .from("external_accounts")
        .select("project_id")
        .eq("workspace_id", workspace.id)
        .eq("display_name", "Example team")
        .single();
      expect(account?.project_id).toBe(project.id);
      await expectNoAxeViolations(page);

      // Back to no project, from the keyboard: the empty value survives the reset too, and focus
      // stays on the button through the save instead of dropping to the page (#161).
      await select.selectOption({ label: "No project" });
      await select.focus();
      await page.keyboard.press("Tab");
      await expect(save).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(exclude).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(save).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(row.getByRole("status").filter({ hasText: "Project removed." })).toBeVisible();
      await expect(select).toHaveValue("");
      await expect(save).toBeFocused();

      // Exclude's message sits below it, in the status row, not above it beside the label.
      await exclude.click();
      const excluded = row.getByRole("status").filter({ hasText: "Account excluded." });
      await expect(excluded).toBeVisible();
      const [statusBox, includeBox] = await Promise.all([
        excluded.boundingBox(),
        row.getByRole("button", { name: "Include Example team" }).boundingBox(),
      ]);
      if (statusBox === null || includeBox === null) throw new Error("The include control or its message is not rendered.");
      expect(statusBox.y).toBeGreaterThanOrEqual(includeBox.y + includeBox.height);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("says so when the person cancels at the provider", async ({ page }) => {
    const workspace = await createTestWorkspace("Connect cancelled");
    try {
      await page.goto(`/w/${workspace.slug}/connections`);
      await startFakeConnect(page, workspace.slug, (url) => url.searchParams.set("error", "access_denied"));
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/connections\\?error=cancelled`));
      const alert = page.getByRole("alert").filter({ hasText: `You cancelled connecting ${PROVIDER_NAME}.` });
      await expect(alert).toBeVisible();
      await expect(alert).toBeFocused();
      const { count } = await adminClient()
        .from("connections")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace.id);
      expect(count).toBe(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("refuses a state that was already used", async ({ page }) => {
    const workspace = await createTestWorkspace("Connect replay");
    try {
      await page.goto(`/w/${workspace.slug}/connections`);
      let callback = "";
      page.on("request", (request) => {
        if (request.url().includes("/api/connections/fake/callback")) callback = request.url();
      });
      await startFakeConnect(page, workspace.slug, () => undefined);
      await expect(page).toHaveURL(CONNECTION_URL);
      expect(callback).not.toBe("");

      // Replay the exact callback. A consumed state names no workspace, so the route falls back to
      // the user's last-opened workspace, which parallel specs change; assert on the redirect
      // itself (never a connection page, always the invalid outcome) rather than where it lands.
      const replay = await page.request.get(callback, { maxRedirects: 0 });
      expect(replay.status()).toBe(303);
      const location = new URL(replay.headers().location ?? "", callback);
      expect(location.pathname).not.toMatch(CONNECTION_URL);
      if (location.pathname !== "/app") {
        expect(location.pathname).toMatch(/^\/w\/[a-z0-9]+\/connections$/);
        expect(location.searchParams.get("error")).toBe("invalid");
        expect(location.searchParams.get("provider")).toBe("fake");
      }
      const { count } = await adminClient()
        .from("connections")
        .select("id", { count: "exact", head: true })
        .eq("workspace_id", workspace.id);
      expect(count).toBe(1);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("disconnects after confirming, keeping the history and deleting the credential", async ({ page }) => {
    const workspace = await createTestWorkspace("Disconnect");
    try {
      const connectionId = await connectThroughUi(page, workspace.slug);
      // Scoped to main and exact: the workspace switcher's name contains "Disconnect" too.
      const main = page.getByRole("main");
      await main.getByRole("button", { name: "Disconnect", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `Disconnect ${PROVIDER_NAME}?` });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Deletes the stored credential");
      await expect(dialog).toContainText("Keeps the history already collected");

      // Cancel leaves everything as it was.
      await dialog.getByRole("button", { name: "Cancel" }).click();
      await expect(dialog).toBeHidden();

      await main.getByRole("button", { name: "Disconnect", exact: true }).click();
      await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
      await expect(page.getByRole("status").filter({ hasText: "Disconnected. The credential is deleted" })).toBeVisible();
      await expect(page.getByRole("region", { name: "Status" }).getByText("Status: Disconnected")).toBeVisible();

      const admin = adminClient();
      const [{ data: credential }, { data: connection }, { count: accounts }] = await Promise.all([
        admin.from("connection_credentials").select("connection_id").eq("connection_id", connectionId).maybeSingle(),
        admin.from("connections").select("status").eq("id", connectionId).single(),
        admin
          .from("external_accounts")
          .select("id", { count: "exact", head: true })
          .eq("connection_id", connectionId),
      ]);
      expect(credential).toBeNull();
      expect(connection?.status).toBe("revoked");
      expect(accounts).toBe(2);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("deletes a connection and its history after a separate confirmation", async ({ page }) => {
    const workspace = await createTestWorkspace("Delete connection");
    try {
      const connectionId = await connectThroughUi(page, workspace.slug);
      await page.getByRole("main").getByRole("button", { name: "Delete connection and history", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Delete this connection and its history?" });
      await dialog.getByRole("button", { name: "Delete connection and history", exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/connections\\?deleted=fake`));
      await expect(page.getByRole("status").filter({ hasText: "Connection deleted" })).toBeVisible();
      const { count } = await adminClient()
        .from("connections")
        .select("id", { count: "exact", head: true })
        .eq("id", connectionId);
      expect(count).toBe(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("shows a failed disconnect and a failed delete inside the open dialog", async ({ page }) => {
    const workspace = await createTestWorkspace("Connection failures");
    try {
      const main = page.getByRole("main");
      const disconnectId = await seedConnection(workspace.id);
      await page.goto(`/w/${workspace.slug}/connections/${disconnectId}`);
      await expectFailureInDialog(page, {
        trigger: main.getByRole("button", { name: "Disconnect", exact: true }),
        dialog: page.getByRole("dialog", { name: `Disconnect ${PROVIDER_NAME}?` }),
        confirmName: "Disconnect",
        breakIt: () => deleteConnectionRow(disconnectId),
        message: GONE_MESSAGE,
      });

      const deleteId = await seedConnection(workspace.id);
      await page.goto(`/w/${workspace.slug}/connections/${deleteId}`);
      await expectFailureInDialog(page, {
        trigger: main.getByRole("button", { name: "Delete connection and history", exact: true }),
        dialog: page.getByRole("dialog", { name: "Delete this connection and its history?" }),
        confirmName: "Delete connection and history",
        breakIt: () => deleteConnectionRow(deleteId),
        message: GONE_MESSAGE,
      });
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  for (const reopened of [false, true]) {
    const when = reopened ? "dismissed and reopened" : "dismissed";
    ownerTest(`shows a failure beside the opener when its dialog was ${when} while working (#367)`, async ({ page }) => {
      const workspace = await createTestWorkspace("Dismissed failure");
      try {
        const connectionId = await seedConnection(workspace.id);
        const connectionPath = `/w/${workspace.slug}/connections/${connectionId}`;
        // Holds the server action (a POST to the page) until the dialog is dismissed, so "Working"
        // stays on screen for as long as the test needs it, with no sleep.
        const held = Promise.withResolvers<void>();
        await page.route(`**${connectionPath}`, async (route) => {
          if (route.request().method() !== "POST") return route.fallback();
          await held.promise;
          return route.continue();
        });
        await page.goto(connectionPath);
        await expectHydrated(page);
        const main = page.getByRole("main");
        const opener = main.getByRole("button", { name: "Disconnect", exact: true });
        const dialog = page.getByRole("dialog", { name: `Disconnect ${PROVIDER_NAME}?` });

        await opener.click();
        await deleteConnectionRow(connectionId);
        await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
        await expect(dialog.getByRole("button", { name: "Working" })).toBeVisible();
        await page.keyboard.press("Escape");
        await expect(dialog).toBeHidden();
        await expect(opener).toBeFocused();
        if (reopened) {
          // The confirmation that ran the action is gone, and the page behind the open dialog is
          // inert, so the new confirmation reports the failure, focused and announced.
          await opener.click();
          await expect(dialog.getByRole("button", { name: "Disconnect", exact: true })).toBeVisible();
          held.resolve();
          await expect(dialog.getByRole("alert")).toHaveText(GONE_MESSAGE);
          await expect(dialog.getByText(GONE_MESSAGE)).toBeFocused();
          await expectNoAxeViolations(page);
          await page.keyboard.press("Escape");
          await expect(dialog).toBeHidden();
        } else {
          held.resolve();
        }

        // The closed dialog's own alert is hidden, so a visible one is the alert beside the opener.
        await expect(main.getByRole("alert").filter({ hasText: GONE_MESSAGE })).toBeVisible();
        await expectNoAxeViolations(page);

        // Opening the dialog again starts fresh, beside the opener too.
        await opener.click();
        await expect(dialog).toBeVisible();
        await expect(page.getByText(GONE_MESSAGE)).toHaveCount(0);
      } finally {
        await deleteTestWorkspace(workspace);
      }
    });
  }
});

viewerTest.describe("connections as a viewer", () => {
  viewerTest("shows status only, with no Connect or management controls", async ({ page }) => {
    const workspace = await createTestWorkspace("Viewer connections");
    try {
      const { data: seeded, error } = await adminClient()
        .from("connections")
        .insert({
          workspace_id: workspace.id,
          provider: "fake",
          status: "active",
          display_name: `${PROVIDER_NAME} (Seeded team)`,
          authorized_account_label: "Seeded team",
          poll_interval_seconds: 3600,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Seeding a connection failed (code ${error.code}).`);

      await page.goto(`/w/${workspace.slug}/connections`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Connections");
      await expect(page.getByRole("link", { name: /^Connect / })).toHaveCount(0);
      await expect(page.getByText("Only owners and admins can connect providers.").first()).toBeVisible();
      const row = page.getByRole("list", { name: "Connections" }).getByRole("listitem").first();
      await expect(row.getByText("Status: Active")).toBeVisible();

      await page.goto(`/w/${workspace.slug}/connections/${seeded.id}`);
      await expect(page.getByRole("region", { name: "Status" }).getByText("Status: Active")).toBeVisible();
      for (const name of ["Sync now", "Disconnect", "Delete connection and history"]) {
        await expect(page.getByRole("button", { name })).toHaveCount(0);
      }
      await expect(page.getByRole("link", { name: "Reconnect" })).toHaveCount(0);

      // The start route refuses a viewer even when called directly.
      const response = await postStart(page, "fake", { workspace: workspace.slug, consent: "1" });
      expect(response.status()).toBe(303);
      expect(response.headers().location).toContain("error=forbidden");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

test.describe("connections when signed out", () => {
  test("sends the start route to sign-in, keeping a reconnect", async ({ page }) => {
    const response = await postStart(page, "fake", { workspace: "abcdefghij", consent: "1" });
    expect(response.status()).toBe(303);
    const signIn = new URL(response.headers().location ?? "");
    expect(signIn.pathname).toBe("/sign-in");
    expect(signIn.searchParams.get("next")).toBe("/w/abcdefghij/connections/new/fake");

    // A session that expired on the reconnect page returns to the same reconnect after sign-in.
    const connectionId = "00000000-0000-4000-8000-000000000000";
    const reconnect = await postStart(page, "fake", { workspace: "abcdefghij", consent: "1", connection: connectionId });
    expect(reconnect.status()).toBe(303);
    expect(new URL(reconnect.headers().location ?? "").searchParams.get("next")).toBe(
      `/w/abcdefghij/connections/new/fake?connection=${connectionId}`,
    );
  });

  test("the start route refuses a cross-site post and a GET", async ({ request }) => {
    const crossSite = await request.post("/api/connections/fake/start", {
      form: { workspace: "abcdefghij", consent: "1" },
      headers: { Origin: "https://evil.example" },
      maxRedirects: 0,
    });
    expect(crossSite.status()).toBe(403);

    const link = await request.get("/api/connections/fake/start?workspace=abcdefghij&consent=1", { maxRedirects: 0 });
    expect(link.status()).toBe(405);
  });
});
