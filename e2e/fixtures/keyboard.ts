import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Presses Tab until `target` has focus, the way a keyboard user reaches it, and fails if it still
 * does not after `maxPresses`. It checks before each press, so a target that already has focus
 * stays focused rather than being tabbed past.
 *
 * A focus change that scrolls the page starts a smooth scroll (`scroll-behavior: smooth` in
 * globals.css). On a busy main thread Chromium can drop an in-page jump that starts while that
 * scroll is still running: the URL changes and the page stays where it was (#467, product side in
 * #469). So it then waits for the page to stop scrolling, and the specs cover the settled case.
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

/**
 * Resolves once the window's scroll position has held still for several animation frames. The
 * window alone is enough: only `html` sets `scroll-behavior: smooth`, and the property is not
 * inherited, so scrolled containers (dialogs, the inspector, chart rows) jump instantly. It counts
 * animation frames, so it never resolves while a test has paused the page clock.
 */
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
