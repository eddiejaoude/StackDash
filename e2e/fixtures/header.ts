import { expect, type Page } from "@playwright/test";

/**
 * Asserts that the workspace header's top-row controls sit in order without overlapping, each holds
 * its own content and is at least 24 by 24 pixels, and the page does not scroll sideways (#198).
 * `adminLink` adds the super admin's Admin link (#364), which sits before the account link.
 */
export async function expectTopRowFits(
  page: Page,
  accountName: string,
  { adminLink = false }: Readonly<{ adminLink?: boolean }> = {},
): Promise<void> {
  const header = page.getByRole("banner");
  const controls = [
    header.getByRole("link", { name: "StackDash", exact: true }),
    header.getByRole("button", { name: /^Workspace: / }),
    header.getByRole("button").filter({ has: page.getByTestId("live-dot") }),
    ...(adminLink ? [header.getByRole("link", { name: "Admin", exact: true })] : []),
    header.getByRole("link", { name: accountName, exact: true }),
    header.getByRole("button", { name: "Sign out", exact: true }),
  ];
  const boxes = await Promise.all(controls.map((control) => control.boundingBox()));
  for (const [index, box] of boxes.entries()) {
    if (box === null) throw new Error(`Top-row control ${index} is not rendered.`);
    expect(box.width, `control ${index} width`).toBeGreaterThanOrEqual(24);
    expect(box.height, `control ${index} height`).toBeGreaterThanOrEqual(24);
    const next = boxes[index + 1];
    if (next) expect(box.x + box.width, `control ${index} ends before control ${index + 1}`).toBeLessThanOrEqual(next.x);
  }
  for (const [index, control] of controls.entries()) {
    expect(await control.evaluate((element) => element.scrollWidth <= element.clientWidth), `control ${index} overflows`).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth === window.innerWidth)).toBe(true);
}
