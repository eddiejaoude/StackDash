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
      // support: an image on a phone, where the picture is static, and a group around the source
      // buttons from sm up.
      const picture = page
        .getByRole("region", { name: "One timeline and one alert for your whole developer stack." })
        .getByRole(viewport.width < 640 ? "img" : "group", { name: PICTURE_NAME });
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

  async function countOf(core: Locator): Promise<number> {
    const match = /([\d,]+) events/.exec((await core.textContent()) ?? "");
    if (!match?.[1]) throw new Error("The center shows no event count");
    return Number(match[1].replaceAll(",", ""));
  }

  test("events arriving by themselves raise the count and pulse the center in their color", async ({ page }) => {
    const picture = page.getByRole("group", { name: PICTURE_NAME });
    const core = picture.getByTestId("flow-core-text").filter({ visible: true });
    await expect(core).toContainText("1,287 events");

    // GitHub's first looping packet ("New fork of acme/api", a success) reaches the center 4 s in.
    await expect.poll(() => countOf(core), { timeout: 10_000 }).toBeGreaterThan(1287);
    await expect(picture.locator('[data-pulse="success"]').first()).toHaveCSS("border-top-color", "rgb(62, 207, 142)");
  });

  test("a source sends its next example event by mouse or keyboard, and the center counts it", async ({ page }) => {
    const picture = page.getByRole("group", { name: PICTURE_NAME });
    const core = picture.getByTestId("flow-core-text").filter({ visible: true });
    // Paused, nothing arrives by itself, so every change to the count is a sent event. Sent packets
    // still travel, and the cards stop drifting.
    await picture.getByRole("button", { name: "Pause animation" }).click();
    const before = await countOf(core);

    const github = picture.getByRole("button", { name: /^GitHub\b/ });
    await github.click();
    await expect(picture.getByText("Sent an example GitHub event: New fork of acme/api.")).toBeAttached();
    await expect(picture.locator("[data-sent]")).toHaveCount(1);
    // The packet runs once to the center, then the count goes up and the packet is gone.
    await expect.poll(() => countOf(core)).toBe(before + 1);
    await expect(picture.locator("[data-sent]")).toHaveCount(0);

    // Each source moves on to its next event.
    await github.click();
    await expect(picture.getByText("Sent an example GitHub event: acme/cli hit 1,000 ★.")).toBeAttached();

    // The center pulses in the arriving event's color: Resend's first event is a warning.
    await picture.getByRole("button", { name: /^Resend\b/ }).focus();
    await page.keyboard.press("Enter");
    await expect(picture.getByText("Sent an example Resend event: Emails at 75% of quota.")).toBeAttached();
    await expect(picture.locator('[data-pulse="warning"]')).toHaveCSS("border-top-color", "rgb(245, 166, 35)");
    await expect.poll(() => countOf(core)).toBe(before + 3);
  });

  test("a pulled source stretches on an elastic, springs back, and sends one event", async ({ page }) => {
    const picture = page.getByRole("group", { name: PICTURE_NAME });
    const core = picture.getByTestId("flow-core-text").filter({ visible: true });
    await picture.getByRole("button", { name: "Pause animation" }).click();
    const before = await countOf(core);

    const github = picture.getByRole("button", { name: /^GitHub\b/ });
    const home = await github.boundingBox();
    if (!home) throw new Error("GitHub's card has no box");
    await page.mouse.move(home.x + home.width / 2, home.y + home.height / 2);
    await page.mouse.down();
    await page.mouse.move(home.x + home.width / 2 + 200, home.y + home.height / 2, { steps: 12 });

    // 200 px of pull moves the card a little, and never further than the elastic allows.
    const pulled = await github.boundingBox();
    if (!pulled) throw new Error("GitHub's card has no box while pulled");
    expect(pulled.x - home.x).toBeGreaterThan(10);
    expect(pulled.x - home.x).toBeLessThan(40);

    await page.mouse.up();
    await expect(picture.getByText("Sent an example GitHub event: New fork of acme/api.")).toBeAttached();
    await expect.poll(async () => Math.abs(((await github.boundingBox())?.x ?? Infinity) - home.x)).toBeLessThan(0.5);
    // One event, not two: the click a browser fires after the drag is not sent again.
    await expect.poll(() => countOf(core)).toBe(before + 1);
    await expect(picture.locator("[data-sent]")).toHaveCount(0);
    expect(await countOf(core)).toBe(before + 1);
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

  test("a hovered or keyboard-focused source stays bright with its packets while the others dim", async ({
    page,
  }) => {
    const picture = page.getByRole("group", { name: PICTURE_NAME });
    const stripe = picture.getByRole("button", { name: /^Stripe\b/ });
    const polar = picture.getByRole("button", { name: /^Polar\b/ });

    await stripe.hover({ force: true });
    await expect(polar).toHaveCSS("filter", "opacity(0.35)");
    await expect(stripe).toHaveCSS("filter", "none");
    for (const packet of await picture.locator('[data-testid="flow-packet"][data-source="stripe"]').all()) {
      await expect(packet).toHaveCSS("filter", "none");
    }
    // The packet a click sends travels bright, not dimmed with the rest.
    await stripe.click();
    await expect(picture.locator("[data-sent]")).toHaveCSS("filter", "none");

    // From the keyboard, the focused source is the bright one.
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    const focused = picture.locator("button[data-on]");
    await expect(focused).toBeFocused();
    await expect(stripe).toHaveCSS("filter", "opacity(0.35)");
  });

  test("the stage tilts toward a mouse pointer, never past 5 degrees, and not while paused", async ({ page }) => {
    const picture = page.getByRole("group", { name: PICTURE_NAME });
    const tilt = picture.getByTestId("flow-tilt");
    const angles = () =>
      tilt.evaluate((element) =>
        ["--tilt-x", "--tilt-y"].map((name) => Number.parseFloat(element.style.getPropertyValue(name) || "0")),
      );
    const frame = await tilt.boundingBox();
    if (!frame) throw new Error("The stage has no box");

    await page.mouse.move(frame.x + frame.width * 0.95, frame.y + frame.height * 0.5);
    await expect.poll(async () => (await angles())[0]).toBeGreaterThan(3);

    // A pull keeps the pointer captured, so moves arrive from far outside the frame.
    const stripe = picture.getByRole("button", { name: /^Stripe\b/ });
    await stripe.hover({ force: true });
    await page.mouse.down();
    await page.mouse.move(1, 799, { steps: 10 });
    await expect.poll(async () => (await angles())[0]).toBeLessThan(-3);
    for (const angle of await angles()) expect(Math.abs(angle)).toBeLessThanOrEqual(5);
    await page.mouse.up();

    await picture.getByRole("button", { name: "Pause animation" }).click();
    await page.mouse.move(frame.x + frame.width * 0.95, frame.y + frame.height * 0.1);
    await expect.poll(angles).toEqual([0, 0]);
  });
});

test.describe("hero data-flow constellation on a touch screen", () => {
  // A phone in landscape is wide enough for the interactive stage.
  test.use({ hasTouch: true, viewport: { width: 844, height: 390 } });

  test("a tap sends an event and leaves no spotlight behind", async ({ page }) => {
    await page.goto("/");
    const picture = page.getByRole("group", { name: PICTURE_NAME });
    // Nothing stops a card drifting under a finger, so the tap does not wait for it to settle.
    await picture.getByRole("button", { name: /^GitHub\b/ }).tap({ force: true });
    await expect(picture.getByText("Sent an example GitHub event: New fork of acme/api.")).toBeAttached();
    await expect(picture.locator("[data-on]")).toHaveCount(0);
    await expect(picture.getByRole("button", { name: /^Polar\b/ })).toHaveCSS("filter", "none");
  });
});
