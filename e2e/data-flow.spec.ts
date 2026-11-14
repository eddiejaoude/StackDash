import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { liveProviderIds } from "../src/lib/adapters/types";
import { PROVIDER_NAMES } from "../src/lib/providers";

const providerNames = liveProviderIds.map((id) => PROVIDER_NAMES[id]);

test.describe("hero data-flow constellation", () => {
  // The hero fades in; a scan mid-fade reports contrast the settled page has not. Reduced motion
  // also parks every packet with its label showing, so the scan covers the labels too.
  test.use({ reducedMotion: "reduce" });

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 1280, height: 800 },
  ]) {
    test(`names every live source and fits a ${viewport.width} px viewport`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto("/");

      // One text alternative for the whole picture, inside the hero, listing every source the adapters
      // support.
      const picture = page
        .getByRole("region", { name: "One timeline and one alert for your whole developer stack." })
        .getByRole("img", { name: /^Events from .* flow into one DevMacro timeline\.$/ });
      await expect(picture).toBeVisible();
      for (const name of providerNames) {
        await expect(picture).toHaveAccessibleName(new RegExp(`\\b${name}\\b`));
      }

      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow).toBe(0);

      // The provider nodes in whichever layout is showing all sit inside the viewport, so the scaled
      // stage (or the phone layout) is not clipped by the hero's overflow-hidden.
      const pictureBox = await picture.boundingBox();
      if (!pictureBox) throw new Error("The data-flow picture has no box");
      expect(pictureBox.x).toBeGreaterThanOrEqual(0);
      expect(pictureBox.x + pictureBox.width).toBeLessThanOrEqual(viewport.width);
      for (const name of providerNames) {
        const node = picture.getByText(name, { exact: true }).filter({ visible: true });
        await expect(node).toHaveCount(1);
        const box = await node.boundingBox();
        if (!box) throw new Error(`${name} has no box`);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      }

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    });
  }
});
