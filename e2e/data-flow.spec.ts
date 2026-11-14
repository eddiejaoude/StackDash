import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator } from "@playwright/test";

import { liveProviderIds } from "../src/lib/adapters/types";
import { PROVIDER_NAMES } from "../src/lib/providers";

const providerNames = liveProviderIds.map((id) => PROVIDER_NAMES[id]);

const PICTURE_NAME = /^Events from .* flow into one DevMacro timeline\.$/;

interface Box {
  /** A card's source name or a packet's label, for the failure message. */
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

async function boxes(locator: Locator): Promise<Box[]> {
  return locator.evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      const name = element.querySelector("p")?.textContent ?? element.textContent ?? "";
      return { name, x, y, width, height };
    }),
  );
}

// Borders that touch are fine; a pixel of real overlap is not.
function overlaps(a: Box, b: Box): boolean {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 1 && height > 1;
}

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
        .getByRole("group", { name: PICTURE_NAME });
      await expect(picture).toBeVisible();
      // Reduced motion stops everything in the picture: the packets, the drift, and the glow.
      expect(await picture.evaluate((element) => element.getAnimations({ subtree: true }).length)).toBe(0);
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

  // The orbit is derived from liveProviderIds, so a new provider moves every slot. With the packets
  // parked, every packet (dot and label) has to stay clear of every source's card, and every label
  // clear of every other label and of the center circle's text, which parked packets paint above.
  test("parked packets cover no source, no other label, and no center text", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");

    const picture = page.getByRole("group", { name: PICTURE_NAME });
    const cards = await boxes(picture.getByTestId("flow-node"));
    const packets = await boxes(picture.getByTestId("flow-packet"));
    const labels = await boxes(picture.getByTestId("flow-label"));
    // The phone layout renders the center text too, hidden at this width.
    const [centerText, ...extraCenterText] = await boxes(picture.getByTestId("flow-core-text").filter({ visible: true }));
    expect(cards).toHaveLength(providerNames.length);
    expect(packets.length).toBeGreaterThan(0);
    if (!centerText || extraCenterText.length > 0) throw new Error("Expected exactly one visible center text");

    const collisions: string[] = [];
    for (const packet of packets) {
      for (const card of cards) {
        if (overlaps(packet, card)) collisions.push(`"${packet.name}" covers the ${card.name} card`);
      }
    }
    labels.forEach((label, index) => {
      if (overlaps(label, centerText)) collisions.push(`"${label.name}" covers the center text`);
      for (const other of labels.slice(index + 1)) {
        if (overlaps(label, other)) collisions.push(`"${label.name}" covers "${other.name}"`);
      }
    });
    expect(collisions).toEqual([]);
  });

  test("under reduced motion a click counts its event at once and there is nothing to pause", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");

    const picture = page.getByRole("group", { name: PICTURE_NAME });
    await expect(picture.getByRole("button", { name: "Pause animation" })).toBeHidden();
    await picture.getByRole("button", { name: /^Stripe\b/ }).click();
    await expect(picture.getByText("Sent an example Stripe event: $49.00 paid · Pro.")).toBeAttached();
    await expect(picture.getByTestId("flow-core-text").filter({ visible: true })).toContainText("1,288 events");
    await expect(picture.locator("[data-sent]")).toHaveCount(0);
  });
});

test.describe("hero data-flow constellation in motion", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
  });

  test("a source sends its next example event by mouse or keyboard, and the center counts it", async ({ page }) => {
    const picture = page.getByRole("group", { name: PICTURE_NAME });
    const count = picture.getByTestId("flow-core-text").filter({ visible: true });
    await expect(count).toContainText("1,287 events");

    const github = picture.getByRole("button", { name: /^GitHub\b/ });
    // A card drifts until the pointer is on it, so Playwright would wait for it to settle forever.
    // Pointing at it first stops the drift, as it does for a visitor.
    await github.hover({ force: true });
    await github.click();
    await expect(picture.getByText("Sent an example GitHub event: PR #128 merged.")).toBeAttached();
    await expect(picture.locator("[data-sent]")).toHaveCount(1);
    // The packet runs once to the center, then the count goes up and the packet is gone.
    await expect(count).toContainText("1,288 events");
    await expect(picture.locator("[data-sent]")).toHaveCount(0);

    // Each source moves on to its next event.
    await github.click();
    await expect(picture.getByText("Sent an example GitHub event: acme/cli hit 1,000 ★.")).toBeAttached();

    await picture.getByRole("button", { name: /^Vercel\b/ }).focus();
    await page.keyboard.press("Enter");
    await expect(picture.getByText("Sent an example Vercel event: Deploy ready · acme-web.")).toBeAttached();
    await expect(count).toContainText("1,290 events");
  });

  test("Pause stops every loop in the picture and Resume starts them again", async ({ page }) => {
    const picture = page.getByRole("group", { name: PICTURE_NAME });
    const loopStates = () =>
      picture.evaluate((element) => [
        ...new Set(element.getAnimations({ subtree: true }).map((animation) => animation.playState)),
      ]);
    await expect.poll(loopStates).toEqual(["running"]);

    await picture.getByRole("button", { name: "Pause animation" }).click();
    await expect(picture.getByRole("button", { name: "Resume animation" })).toBeVisible();
    await expect.poll(loopStates).toEqual(["paused"]);

    await picture.getByRole("button", { name: "Resume animation" }).click();
    await expect.poll(loopStates).toEqual(["running"]);
  });
});
