import { expect, type Page } from "@playwright/test";

import { CONNECTION_URL } from "./db";

/** Checks a spec runs on a screen of the connect flow before moving on, such as an axe scan. */
export type ConnectChecks = Readonly<{
  catalog?: () => Promise<void>;
  connectScreen?: () => Promise<void>;
}>;

/**
 * Connects a simulated provider from the catalog with the keyboard and lands on the connection.
 * The web server must run with STACKDASH_SIMULATE_PROVIDERS=1 (playwright.config.ts), so the dev
 * consent screen stands in for the provider. `checks` run on the catalog and on the connect screen
 * once each has loaded, before the flow moves on.
 */
export async function connectSimulated(
  page: Page,
  slug: string,
  provider: string,
  checks: ConnectChecks = {},
): Promise<void> {
  await page.goto(`/w/${slug}/connections`);
  const card = page
    .getByRole("list", { name: "Providers" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: provider, exact: true }) });
  await expect(card.getByText("Simulated", { exact: true })).toBeVisible();
  await checks.catalog?.();
  await card.getByRole("link", { name: `Connect ${provider}` }).focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Connect ${provider}`);
  const permissions = page.getByRole("region", { name: `Permissions ${provider} will ask you to grant` });
  await expect(permissions.getByText("Simulated", { exact: true })).toBeVisible();
  await expect(permissions.getByText(/^Simulated\. StackDash makes up example/)).toBeVisible();
  await checks.connectScreen?.();
  await page.getByRole("button", { name: `Continue to ${provider}` }).focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(CONNECTION_URL);
  await expect(page.getByRole("region", { name: "Status" }).getByText("Simulated", { exact: true })).toBeVisible();
}
