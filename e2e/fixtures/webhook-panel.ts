import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";

import { adminClient, CONNECTION_URL } from "./db";

/*
 * The webhook setup panel on a connection page (#426), driven the way a keyboard user drives it.
 * Shared by the specs that set up a provider's webhook: webhook-setup.spec.ts for the panel itself
 * and webhook-setup-<provider>.spec.ts for one provider's declaration.
 */

const WEBHOOK_PANEL = "Get events as they happen";
export const EVIDENCE = process.env.PW_PR_EVIDENCE === "1";

export function panel(page: Page): Locator {
  return page.getByRole("region", { name: WEBHOOK_PANEL });
}

/** A named screenshot for the pull request (PW_PR_EVIDENCE=1), with every secret field masked. */
export async function evidence(locator: Locator, name: string): Promise<void> {
  if (!EVIDENCE) return;
  const page = locator.page();
  const mask = [page.getByRole("textbox", { name: "Webhook secret" }), page.getByLabel(/^Signing secret from /)];
  // The sticky app header would cover the top of a panel taller than the viewport, so it is hidden
  // for the capture; it is not part of the captured element.
  await locator.screenshot({
    path: `pr-evidence/after/${name}.png`,
    animations: "disabled",
    mask,
    style: "header.sticky { visibility: hidden !important; }",
  });
}

/** Axe finds nothing on the panel. */
export async function expectAccessiblePanel(page: Page): Promise<void> {
  const scan = await new AxeBuilder({ page }).include('section[aria-labelledby="webhook-title"]').analyze();
  expect(scan.violations).toEqual([]);
}

/** Presses Tab until `target` has focus, then checks it shows a focus style. */
export async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let presses = 0; presses < 80 && !(await target.evaluate((element) => element === document.activeElement)); presses++) {
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
  expect(await target.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
}

/** Chooses a setup path from the panel with the keyboard only. */
export async function chooseWithKeyboard(page: Page, choice: "Set up automatically" | "Set up by hand"): Promise<void> {
  const radio = panel(page).getByRole("radio", { name: choice });
  await tabTo(page, panel(page).getByRole("radio").first());
  // Arrow keys move through a radio group and select as they go; Space selects the focused one.
  if (!(await radio.evaluate((element) => element === document.activeElement))) await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
  await expect(radio).toBeChecked();
  await tabTo(page, panel(page).getByRole("button", { name: "Set up the webhook" }));
  await page.keyboard.press("Enter");
}

export async function connectionId(page: Page): Promise<string> {
  const id = CONNECTION_URL.exec(page.url())?.[1];
  if (id === undefined) throw new Error("expected to be on a connection page");
  return id;
}

export async function endpointCount(connection: string): Promise<number> {
  const { count, error } = await adminClient()
    .from("webhook_endpoints")
    .select("id", { count: "exact", head: true })
    .eq("connection_id", connection);
  if (error) throw new Error(`Reading the endpoints failed (code ${error.code}).`);
  return count ?? 0;
}

export async function grantedScopes(connection: string): Promise<readonly string[]> {
  const { data, error } = await adminClient().from("connections").select("granted_scopes").eq("id", connection).single();
  if (error) throw new Error(`Reading the connection failed (code ${error.code}).`);
  return data.granted_scopes;
}

/**
 * Disconnects from the Manage section, checking the dialog names `expectedStep` before confirming
 * and the result says `expectedResult` after, with evidence of both under `evidenceName`.
 */
export async function disconnect(page: Page, expectedStep: string | RegExp, expectedResult: RegExp, evidenceName: string): Promise<void> {
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^Disconnect / });
  await expect(dialog.getByText(expectedStep)).toBeVisible();
  await evidence(dialog, `${evidenceName}-dialog`);
  await dialog.getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(dialog).toBeHidden();
  const manage = page.getByRole("region", { name: "Manage" });
  await expect(manage.getByText(expectedResult)).toBeVisible();
  await evidence(manage, `${evidenceName}-result`);
}
