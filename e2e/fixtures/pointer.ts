import type { Locator } from "@playwright/test";

/** A point on the screen, in the page's CSS pixels, as `page.mouse` takes one. */
export type Point = { x: number; y: number };

/** The middle of an element on the screen. */
export async function boxCenter(locator: Locator): Promise<Point> {
  const box = await locator.boundingBox();
  if (box === null) throw new Error("The element is not rendered.");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
