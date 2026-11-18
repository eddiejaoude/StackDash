import type { Locator, Page, Route } from "@playwright/test";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations, waitForTrends } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { combobox, openWith, option, optionsOfKind, palette, resultCount, trigger } from "./fixtures/palette";

/** A fresh workspace with one Vercel connection, account, and project, and two Vercel events. */
async function seedPaletteWorkspace(label: string): Promise<TestWorkspace> {
  const workspace = await createTestWorkspace(label);
  const admin = adminClient();
  const { data: project, error: projectError } = await admin
    .from("projects")
    .insert({ workspace_id: workspace.id, name: "Checkout" })
    .select("id")
    .single();
  if (projectError) throw new Error(`Seeding a project failed (code ${projectError.code}).`);
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "vercel",
      status: "active",
      granted_at: new Date().toISOString(),
      display_name: "Vercel palette team",
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
      external_id: "team_palette",
      display_name: "Palette production",
      kind: "team",
      project_id: project.id,
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  const base = { workspace_id: workspace.id, connection_id: connection.id, external_account_id: account.id, provider: "vercel" as const };
  const { error: eventsError } = await admin.from("activity_events").insert([
    {
      ...base,
      type_id: "vercel.deployment.failed",
      severity: "critical",
      title: "Palette deploy failed",
      body: "Synthetic failed deployment",
      occurred_at: "2026-11-04T10:00:00Z",
      dedupe_key: "e2e-palette-failed",
    },
    {
      ...base,
      type_id: "vercel.deployment.succeeded",
      severity: "success",
      title: "Palette deploy succeeded",
      body: "Synthetic successful deployment",
      occurred_at: "2026-11-04T11:00:00Z",
      dedupe_key: "e2e-palette-succeeded",
    },
  ]);
  if (eventsError) throw new Error(`Seeding events failed (code ${eventsError.code}).`);
  return workspace;
}

/** `count` unacknowledged alerts from one 100 percent allowance rule, one per billing period. */
async function seedTriggeredAlerts(workspace: TestWorkspace, count: number): Promise<void> {
  const admin = adminClient();
  const { data: rule, error: ruleError } = await admin
    .from("alert_rules")
    .insert({ workspace_id: workspace.id, kind: "allowance_percent", scope: "workspace", threshold_percent: 100 })
    .select("id")
    .single();
  if (ruleError) throw new Error(`Seeding a rule failed (code ${ruleError.code}).`);
  const { error } = await admin.from("triggered_alerts").insert(
    Array.from({ length: count }, (_, index) => ({
      workspace_id: workspace.id,
      rule_id: rule.id,
      cycle_key: `2026-${String(index + 1).padStart(2, "0")}-01`,
      triggered_at: `2026-${String(index + 1).padStart(2, "0")}-28T09:30:00Z`,
      observed_value: 104,
      provider: "fake" as const,
      threshold_label: "100 percent",
      is_estimated: true,
      message: "Example provider build minutes is at 104 percent of the allowance.",
    })),
  );
  if (error) throw new Error(`Seeding triggered alerts failed (code ${error.code}).`);
}

/**
 * True when the page's own platform is Apple's, where the palette shortcut uses Cmd. The Desktop
 * Chrome device reports a Windows user agent even on a Mac, so Playwright's `ControlOrMeta`
 * (which follows the host) is not used.
 */
async function applePlatform(page: Page): Promise<boolean> {
  return page.evaluate(() => /Mac|iPhone|iPad|iPod/.test(navigator.userAgent));
}

/** The palette shortcut for the page's own platform. */
async function pressPaletteShortcut(page: Page): Promise<void> {
  await page.keyboard.press((await applePlatform(page)) ? "Meta+K" : "Control+K");
}

type KeyInit = Readonly<Pick<KeyboardEventInit, "key" | "metaKey" | "ctrlKey" | "shiftKey">>;

/**
 * Closes `dialog` and presses `key` in the same task, then waits for the dialog's close event.
 * Chromium hides a closed dialog and returns focus at once but fires `close` on the next animation
 * frame, so the key lands before the event, as a fast press on a busy page does (#225). The dialog
 * closes through `close()`, or through `closeKey` pressed where focus is, when one is given.
 */
async function closeThenPress(dialog: Locator, key: KeyInit, closeKey: KeyInit | null = null): Promise<void> {
  await dialog.evaluate(
    async (element, { init, closeInit }) => {
      if (!(element instanceof HTMLDialogElement)) throw new Error("The locator is not a dialog.");
      const press = (keyInit: KeyInit) =>
        (document.activeElement ?? document).dispatchEvent(
          new KeyboardEvent("keydown", { ...keyInit, bubbles: true, cancelable: true }),
        );
      const late = Promise.withResolvers<void>();
      element.addEventListener("close", () => late.resolve(), { once: true });
      if (closeInit === null) element.close();
      else press(closeInit);
      if (element.open) throw new Error("The dialog did not close.");
      press(init);
      await late.promise;
    },
    { init: key, closeInit: closeKey },
  );
}

/**
 * Presses Escape and waits for `dialog`'s close event, which is when the palette restores focus.
 * The browser moves focus back before that event, so a focus check alone could pass too early.
 */
async function escapeAndWaitForClose(page: Page, dialog: Locator): Promise<void> {
  const closeEvent = await dialog.evaluateHandle((element) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    element.addEventListener("close", () => resolve(), { once: true });
    return { fired: promise };
  });
  await page.keyboard.press("Escape");
  await closeEvent.evaluate(({ fired }) => fired);
}

ownerTest.describe("command palette as the owner", () => {
  ownerTest("opens from the shell button, filters, and opens the chosen result", async ({ page }) => {
    const workspace = await seedPaletteWorkspace("Palette choose");
    try {
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await openWith(palette(page), () => trigger(page).click());
      await expect(combobox(page)).toBeFocused();
      // The search field shows the shell's focus outline (#345): a solid 2px ring in the accent,
      // 6.2:1 against the palette's panel, not a borderless field with no sign of focus.
      await expect(combobox(page)).toHaveCSS("outline-style", "solid");
      await expect(combobox(page)).toHaveCSS("outline-width", "2px");
      await expect(combobox(page)).toHaveCSS("outline-color", "rgb(255, 93, 59)");
      await expect(option(page, "Timeline", "Page")).toBeVisible();
      await waitForTrends(page);
      await expectNoAxeViolations(page);

      await combobox(page).fill("failed vercel");
      const options = palette(page).getByRole("option");
      await expect(options).toHaveCount(1);
      await expect(resultCount(page)).toHaveText("1 result");
      const failed = option(page, "Vercel: Deployment failed", "Event timeline");
      await expect(failed).toHaveAttribute("aria-selected", "true");
      // The kind beside the label is the result's description, so a screen reader reads it too.
      await expect(failed).toHaveAccessibleDescription("Event timeline");
      // The selected result is the combobox's active descendant, which is what a screen reader reads.
      await expect(combobox(page)).toHaveAttribute("aria-activedescendant", (await failed.getAttribute("id")) ?? "missing");
      await expectNoAxeViolations(page);

      await page.keyboard.press("Enter");
      await expect(palette(page)).toBeHidden();
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline?type=vercel.deployment.failed`);
      await expect(page.getByRole("heading", { name: "Palette deploy failed" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Palette deploy succeeded" })).toHaveCount(0);
      await expect(trigger(page)).toBeFocused();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("moves through results with the arrow keys and scopes the dashboard to a project", async ({ page }) => {
    const workspace = await seedPaletteWorkspace("Palette arrows");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openWith(palette(page), () => trigger(page).click());
      // "usage" is a keyword of the dashboard results only. A name would match too, and the e2e
      // owner belongs to every spec's workspace ("Dashboard trends ..."), so the query avoids names.
      await combobox(page).fill("usage");
      const options = palette(page).getByRole("option");
      // The dashboard page, then the dashboard scopes: the provider, the projects (Checkout,
      // Unassigned), then the account, each labeled by its name alone and described by its kind.
      const expected = [
        ["Dashboard", "Page"],
        ["Vercel", "Provider dashboard"],
        ["Checkout", "Project dashboard"],
        ["Unassigned", "Project dashboard"],
        ["Palette production", "Account dashboard"],
      ] as const;
      await expect(options).toHaveCount(expected.length);
      for (const [index, [name, kind]] of expected.entries()) {
        await expect(options.nth(index)).toHaveAccessibleName(name);
        await expect(options.nth(index)).toHaveAccessibleDescription(kind);
      }
      const first = options.nth(0);
      const project = options.nth(2);
      const last = options.nth(4);
      await expect(first).toHaveAttribute("aria-selected", "true");
      // Before the first result the selection wraps to the last, and back.
      await page.keyboard.press("ArrowUp");
      await expect(last).toHaveAttribute("aria-selected", "true");
      await expect(first).toHaveAttribute("aria-selected", "false");
      await page.keyboard.press("ArrowDown");
      await expect(first).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(project).toHaveAttribute("aria-selected", "true");
      await expect(combobox(page)).toHaveAttribute("aria-activedescendant", (await project.getAttribute("id")) ?? "missing");

      await page.keyboard.press("Enter");
      await expect(palette(page)).toBeHidden();
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/dashboard\\?project=[0-9a-f-]{36}$`));
      await expect(page.getByRole("status").filter({ hasText: "project Checkout" })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("leaves Enter and the arrow keys to an IME while it composes", async ({ page }) => {
    const workspace = await createTestWorkspace("Palette IME");
    try {
      await page.goto(`/w/${workspace.slug}/dashboard`);
      await openWith(palette(page), () => trigger(page).click());
      await expect(combobox(page)).toHaveValue("");
      const timeline = option(page, "Timeline", "Page");
      await expect(timeline).toHaveAttribute("aria-selected", "true");

      // While an IME composes, the browser marks its keys with isComposing: Enter commits the
      // composed text and the arrow keys move through the candidates, so the palette ignores them.
      for (const key of ["ArrowDown", "ArrowDown", "ArrowUp", "Enter"]) {
        await combobox(page).dispatchEvent("keydown", { key, isComposing: true });
      }
      await expect(timeline).toHaveAttribute("aria-selected", "true");
      await expect(palette(page)).toBeVisible();
      await expect(page).toHaveURL(`/w/${workspace.slug}/dashboard`);

      // Once the composition ends, the same keys move and choose again.
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      await expect(option(page, "Connections", "Page")).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(palette(page)).toBeHidden();
      await expect(page).toHaveURL(`/w/${workspace.slug}/connections`);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("keeps the keyboard's selection when the list scrolls under a resting pointer", async ({ page }) => {
    const workspace = await seedPaletteWorkspace("Palette pointer");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openWith(palette(page), () => trigger(page).click());
      const options = palette(page).getByRole("option");
      await expect(options.nth(2)).toBeVisible();

      // Moving over a row selects it. Entering only records where the pointer is, so move twice.
      const box = await options.nth(2).boundingBox();
      if (box === null) throw new Error("The third result has no layout box.");
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await page.mouse.move(x - 8, y);
      await page.mouse.move(x, y);
      await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");

      // Down to the last result scrolls the list, which slides other rows under the resting pointer.
      const total = await options.count();
      for (let index = 2; index < total - 1; index += 1) await page.keyboard.press("ArrowDown");
      const last = options.nth(total - 1);
      await expect(last).toHaveAttribute("aria-selected", "true");
      expect(await palette(page).getByRole("listbox").evaluate((list) => list.scrollTop)).toBeGreaterThan(0);

      // What a browser sends after that scroll (Firefox always does): the row now under the
      // pointer gets an enter and a move at the same position. The selection stays.
      const underId = await page.evaluate(
        ({ x, y }) => {
          const row = document.elementFromPoint(x, y)?.closest('[role="option"]');
          if (!(row instanceof HTMLElement)) return null;
          for (const type of ["pointerover", "pointermove"]) {
            row.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: x, clientY: y, pointerType: "mouse" }));
          }
          return row.id;
        },
        { x, y },
      );
      if (underId === null) throw new Error("No result is under the pointer.");
      expect(underId).not.toBe(await last.getAttribute("id"));
      await expect(last).toHaveAttribute("aria-selected", "true");
      await expect(palette(page).getByRole("option", { selected: true })).toHaveCount(1);

      // Real movement selects the row under the pointer again.
      await page.mouse.move(x + 8, y, { steps: 2 });
      await expect(palette(page).locator(`[id="${underId}"]`)).toHaveAttribute("aria-selected", "true");
      await expect(last).toHaveAttribute("aria-selected", "false");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("opens with the shortcut, keeps focus inside, and Escape returns focus", async ({ page }) => {
    const workspace = await seedPaletteWorkspace("Palette shortcut");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      const navLink = page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Dashboard" });
      await navLink.focus();
      await openWith(palette(page), () => pressPaletteShortcut(page));
      await expect(combobox(page)).toBeFocused();

      const close = palette(page).getByRole("button", { name: "Close" });
      await page.keyboard.press("Tab");
      await expect(close).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(combobox(page)).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(close).toBeFocused();

      await combobox(page).fill("nothing matches this");
      await expect(palette(page).getByRole("option")).toHaveCount(0);
      await expect(resultCount(page)).toContainText('No commands match "nothing matches this"');
      await expect(combobox(page)).toHaveAttribute("aria-expanded", "false");

      await page.keyboard.press("Escape");
      await expect(palette(page)).toBeHidden();
      await expect(navLink).toBeFocused();
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline`);

      // Opening again, once, starts fresh: an empty field with focus in it and every result listed.
      await pressPaletteShortcut(page);
      await expect(palette(page)).toBeVisible();
      await expect(combobox(page)).toBeFocused();
      await expect(combobox(page)).toHaveValue("");
      await expect(option(page, "Timeline", "Page")).toHaveAttribute("aria-selected", "true");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  // The late close event must not empty the reopened palette's results or take its return focus.
  ownerTest("reopens with every result when the shortcut beats the last close event", async ({ page }) => {
    const workspace = await seedPaletteWorkspace("Palette fast reopen");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      const navLink = page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Dashboard" });
      await navLink.focus();
      await openWith(palette(page), () => pressPaletteShortcut(page));
      await combobox(page).fill("nothing matches this");
      await expect(palette(page).getByRole("option")).toHaveCount(0);

      const apple = await applePlatform(page);
      await closeThenPress(palette(page), { key: "k", metaKey: apple, ctrlKey: !apple });
      await expect(palette(page)).toBeVisible();
      await expect(combobox(page)).toBeFocused();
      await expect(combobox(page)).toHaveValue("");
      await expect(option(page, "Timeline", "Page")).toHaveAttribute("aria-selected", "true");
      await expect(combobox(page)).toHaveAttribute("aria-expanded", "true");

      await escapeAndWaitForClose(page, palette(page));
      await expect(palette(page)).toBeHidden();
      await expect(navLink).toBeFocused();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  // Same race for the shortcut list: the late event must not take the reopened list's return focus.
  ownerTest("reopens the shortcut list when ? beats the last close event", async ({ page }) => {
    const workspace = await createTestWorkspace("Palette fast help");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      const navLink = page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Dashboard" });
      await navLink.focus();
      const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await openWith(shortcuts, () => page.keyboard.press("Shift+Slash"));

      await closeThenPress(shortcuts, { key: "?", shiftKey: true });
      await expect(shortcuts).toBeVisible();
      await expect(shortcuts.getByRole("button", { name: "Close" })).toBeFocused();

      await escapeAndWaitForClose(page, shortcuts);
      await expect(shortcuts).toBeHidden();
      await expect(navLink).toBeFocused();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  // Same race after choosing "Keyboard shortcuts": that request belonged to the earlier close,
  // so the reopened palette's own close must restore focus rather than open the list.
  ownerTest("drops a shortcut list request when the shortcut beats its close event", async ({ page }) => {
    const workspace = await createTestWorkspace("Palette fast choose");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      const navLink = page.getByRole("navigation", { name: "Workspace" }).getByRole("link", { name: "Dashboard" });
      await navLink.focus();
      await openWith(palette(page), () => pressPaletteShortcut(page));
      await combobox(page).fill("shortcuts");
      await expect(option(page, "Keyboard shortcuts", "Help")).toHaveAttribute("aria-selected", "true");

      const apple = await applePlatform(page);
      await closeThenPress(palette(page), { key: "k", metaKey: apple, ctrlKey: !apple }, { key: "Enter" });
      const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      await expect(palette(page)).toBeVisible();
      await expect(shortcuts).toBeHidden();
      await expect(option(page, "Timeline", "Page")).toHaveAttribute("aria-selected", "true");

      await escapeAndWaitForClose(page, palette(page));
      await expect(palette(page)).toBeHidden();
      await expect(shortcuts).toBeHidden();
      await expect(navLink).toBeFocused();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("never opens a shortcut while typing in a field", async ({ page }) => {
    const workspace = await createTestWorkspace("Palette typing");
    try {
      await page.goto(`/w/${workspace.slug}/settings`);
      // The shortcut works once the shell has hydrated, so a pass below means the guard held.
      await openWith(palette(page), () => pressPaletteShortcut(page));
      await page.keyboard.press("Escape");
      await expect(palette(page)).toBeHidden();
      // The dialog's close event, which returns focus, fires a task after it hides; wait for it so
      // it cannot pull focus out of the field mid-typing.
      await expect(trigger(page)).toBeFocused();

      const name = page.getByRole("textbox", { name: "Workspace name" });
      await name.fill("");
      await name.focus();
      await pressPaletteShortcut(page);
      await page.keyboard.type("Renamed?");
      await expect(name).toHaveValue("Renamed?");
      await expect(palette(page)).toBeHidden();
      await expect(page.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeHidden();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("lists the shortcuts with ? and from the palette", async ({ page }) => {
    const workspace = await createTestWorkspace("Palette help");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      const shortcuts = page.getByRole("dialog", { name: "Keyboard shortcuts" });
      // Focus is on the page itself after load, not in a field.
      await openWith(shortcuts, () => page.keyboard.press("Shift+Slash"));
      await expect(shortcuts).toContainText("Open the command palette");
      await expect(shortcuts.getByRole("button", { name: "Close" })).toBeFocused();
      await expectNoAxeViolations(page);
      await page.keyboard.press("Escape");
      await expect(shortcuts).toBeHidden();

      // `?` already proved the shell hydrated, so this open is plain: a retry would hide a re-open bug.
      await trigger(page).click();
      await expect(palette(page)).toBeVisible();
      await combobox(page).fill("shortcuts");
      await page.keyboard.press("Enter");
      await expect(palette(page)).toBeHidden();
      await expect(shortcuts).toBeVisible();
      await shortcuts.getByRole("button", { name: "Close" }).click();
      await expect(trigger(page)).toBeFocused();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  // #294: the adapter declares "Payment succeeded" for `stripe.charge.succeeded`; its id reads "Charge succeeded".
  ownerTest("names an event type by its adapter's declared label, as the timeline filter does", async ({ page }) => {
    const workspace = await createTestWorkspace("Palette declared labels");
    try {
      const { error } = await adminClient().from("connections").insert({
        workspace_id: workspace.id,
        provider: "stripe",
        status: "active",
        granted_at: new Date().toISOString(),
        display_name: "Stripe palette account",
        poll_interval_seconds: 3600,
      });
      if (error) throw new Error(`Seeding a connection failed (code ${error.code}).`);
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openWith(palette(page), () => trigger(page).click());
      await combobox(page).fill("charge succeeded");
      const payments = option(page, "Stripe: Payment succeeded", "Event timeline");
      await expect(payments).toBeVisible();
      await expect(optionsOfKind(page, "Event timeline")).toHaveCount(1);
      await page.keyboard.press("Enter");
      await expect(palette(page)).toBeHidden();
      await expect(page).toHaveURL(`/w/${workspace.slug}/timeline?type=stripe.charge.succeeded`);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("offers to connect a provider", async ({ page }) => {
    const workspace = await createTestWorkspace("Palette connect");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openWith(palette(page), () => trigger(page).click());
      await combobox(page).fill("connect");
      await option(page, "Connect Vercel", "Action").click();
      await expect(page).toHaveURL(`/w/${workspace.slug}/connections/new/vercel`);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("syncs a connection now and reports the result where focus is", async ({ page }) => {
    const workspace = await seedPaletteWorkspace("Palette sync");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openWith(palette(page), () => trigger(page).click());
      await combobox(page).fill("sync vercel");
      await expect(option(page, "Sync Vercel now", "Action")).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");

      // An action keeps the palette open, with focus in the field, and announces its result politely.
      const queued = palette(page).getByRole("status").filter({ hasText: "Sync queued. New numbers appear within a few minutes." });
      await expect(queued).toBeVisible();
      await expect(palette(page)).toBeVisible();
      await expect(combobox(page)).toBeFocused();
      await expectNoAxeViolations(page);

      // The server refuses a second sync inside the cooldown; the palette says why and what next, at once.
      await page.keyboard.press("Enter");
      await expect(palette(page).getByRole("alert")).toContainText(/^A sync was requested recently\. Try again in \d+ minutes?\.$/);
      await expect(queued).toBeHidden();
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("acknowledges every alert and announces how many", async ({ page }) => {
    const workspace = await createTestWorkspace("Palette acknowledge");
    try {
      await seedTriggeredAlerts(workspace, 2);
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openWith(palette(page), () => trigger(page).click());
      await combobox(page).fill("acknowledge");
      await expect(option(page, "Acknowledge all alerts", "Action")).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");

      // The alerts list's own wording, announced politely, with focus still in the field.
      const done = palette(page).getByRole("status").filter({ hasText: "2 alerts acknowledged. They stay in the alert history." });
      await expect(done).toBeVisible();
      await expect(combobox(page)).toBeFocused();
      await expectNoAxeViolations(page);
      const { data, error } = await adminClient()
        .from("triggered_alerts")
        .select("acknowledged_by")
        .eq("workspace_id", workspace.id);
      if (error) throw new Error(`Reading the alerts failed (code ${error.code}).`);
      expect(data.map((row) => row.acknowledged_by)).toEqual([workspace.ownerId, workspace.ownerId]);

      // Run again, it says nothing was left rather than claiming more.
      await page.keyboard.press("Enter");
      await expect(palette(page).getByRole("status").filter({ hasText: "No alerts were left to acknowledge." })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("gives a sync's result to the palette reopened while it ran", async ({ page }) => {
    const workspace = await seedPaletteWorkspace("Palette sync reopen");
    try {
      const timelinePath = `/w/${workspace.slug}/timeline`;
      // Holds the sync's Server Action request (a POST with a Next-Action header) until released,
      // so the palette can be closed and reopened while the sync is still on its way.
      const held = Promise.withResolvers<Route>();
      await page.route(
        (url) => url.pathname === timelinePath,
        async (route) => {
          const request = route.request();
          if (request.method() === "POST" && request.headers()["next-action"] !== undefined) held.resolve(route);
          else await route.continue();
        },
      );
      await page.goto(timelinePath);
      await openWith(palette(page), () => trigger(page).click());
      await combobox(page).fill("sync vercel");
      await page.keyboard.press("Enter");
      const pending = await held.promise;
      await expect(palette(page).getByRole("status").filter({ hasText: "Queueing a sync for Vercel." })).toBeVisible();

      await escapeAndWaitForClose(page, palette(page));
      await trigger(page).click();
      await expect(palette(page)).toBeVisible();
      await combobox(page).fill("sync vercel");
      await page.keyboard.press("Enter");
      await expect(
        palette(page).getByRole("status").filter({ hasText: "A sync is already being queued. Wait for its result, then try again." }),
      ).toBeVisible();

      // The result it was told to wait for arrives in this palette.
      await pending.continue();
      await expect(
        palette(page).getByRole("status").filter({ hasText: "Sync queued. New numbers appear within a few minutes." }),
      ).toBeVisible();
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("opens the create API key form with its name field focused", async ({ page }) => {
    const workspace = await createTestWorkspace("Palette API key");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openWith(palette(page), () => trigger(page).click());
      await combobox(page).fill("api key");
      await expect(option(page, "Create API key", "Action")).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`/w/${workspace.slug}/settings#create-api-key`);
      const keyName = page.getByRole("textbox", { name: "Key name" });
      await expect(keyName).toBeFocused();

      // Chosen again on settings itself, nothing new mounts, and focus still lands in the field.
      await trigger(page).click();
      await expect(palette(page)).toBeVisible();
      await combobox(page).fill("api key");
      await page.keyboard.press("Enter");
      await expect(palette(page)).toBeHidden();
      await expect(keyName).toBeFocused();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("switches to another workspace, never the current one", async ({ page }) => {
    const [workspace, other] = await Promise.all([
      createTestWorkspace("Palette switch"),
      createTestWorkspace("Palette switch target"),
    ]);
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openWith(palette(page), () => trigger(page).click());
      await combobox(page).fill(workspace.name);
      await expect(resultCount(page)).toContainText("No commands match");
      await combobox(page).fill(other.name);
      await expect(option(page, other.name, "Workspace")).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(`/w/${other.slug}/timeline`);
    } finally {
      await Promise.all([deleteTestWorkspace(workspace), deleteTestWorkspace(other)]);
    }
  });

  ownerTest("opens the year in review", async ({ page }) => {
    const workspace = await createTestWorkspace("Palette year");
    try {
      await page.goto(`/w/${workspace.slug}/timeline`);
      await openWith(palette(page), () => trigger(page).click());
      await combobox(page).fill("yearly card");
      await expect(option(page, "Year in review", "Page")).toHaveAttribute("aria-selected", "true");
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/w/${workspace.slug}/year/\\d{4}$`));
      await expect(page.getByRole("heading", { level: 1, name: /^Your stack in / })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

viewerTest("a viewer is offered no action", async ({ page }) => {
  const workspace = await seedPaletteWorkspace("Palette viewer");
  try {
    await page.goto(`/w/${workspace.slug}/timeline`);
    await openWith(palette(page), () => trigger(page).click());
    await combobox(page).fill("connect");
    await expect(option(page, "Connections", "Page")).toBeVisible();
    // By kind: the viewer also belongs to other specs' workspaces, some named "Connect ...".
    for (const query of ["connect", "sync", "api key", "acknowledge"]) {
      await combobox(page).fill(query);
      await expect(resultCount(page)).toBeVisible();
      await expect(optionsOfKind(page, "Action")).toHaveCount(0);
    }
    // The views are still there for a viewer.
    await combobox(page).fill("vercel");
    await expect(option(page, "Vercel", "Provider dashboard")).toBeVisible();
  } finally {
    await deleteTestWorkspace(workspace);
  }
});
