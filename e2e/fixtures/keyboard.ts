import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Presses Tab until `target` has focus, the way a keyboard user reaches it, and fails if it still
 * does not after `maxPresses`. It checks before each press, so a target that already has focus
 * stays focused rather than being tabbed past.
 *
 * Each focus change starts a smooth scroll (`scroll-behavior: smooth` in globals.css), so it then
 * waits for the page to stop scrolling: a key pressed mid-scroll, such as Enter on an in-page link,
 * races the animation, and a person presses it after the page has stopped moving (#467).
 */
export async function tabTo(page: Page, target: Locator, maxPresses: number): Promise<void> {
  for (let presses = 0; presses < maxPresses; presses += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) {
      await waitForScrollToSettle(page);
      return;
    }
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
  await waitForScrollToSettle(page);
}

/** Resolves once the window's scroll position has held still for several animation frames. */
async function waitForScrollToSettle(page: Page): Promise<void> {
  await page.evaluate(() => {
    const STILL_FRAMES = 5;
    const { promise, resolve } = Promise.withResolvers<void>();
    let last = window.scrollY;
    let still = 0;
    const check = () => {
      still = window.scrollY === last ? still + 1 : 0;
      last = window.scrollY;
      if (still >= STILL_FRAMES) resolve();
      else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
    return promise;
  });
}
