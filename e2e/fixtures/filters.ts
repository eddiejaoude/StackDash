import { expect, type Page } from "@playwright/test";

/**
 * Opens the shared filter bar (dashboard and timeline) so its checkboxes can be used. The form
 * sits in a `details` element that is hidden from the accessibility tree until opened, and a page
 * load or a client navigation renders it closed, so it is only toggled when closed. `keyboard`
 * opens it the way a keyboard user would: focus the summary and press Enter.
 */
export async function openFilters(page: Page, input: "pointer" | "keyboard" = "pointer"): Promise<void> {
  const filters = page.getByRole("region", { name: "Filters", exact: true });
  const summary = filters.locator("summary");
  if ((await filters.locator("details").getAttribute("open")) === null) {
    if (input === "keyboard") {
      await summary.focus();
      await page.keyboard.press("Enter");
    } else {
      await summary.click();
    }
  }
  await expect(filters.getByRole("button", { name: "Apply filters" })).toBeVisible();
}
