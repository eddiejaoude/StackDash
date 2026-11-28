import { expect, type Page } from "@playwright/test";

/** Next.js mounts its route announcer from an effect, so it exists only once the page hydrated. */
export async function expectHydrated(page: Page): Promise<void> {
  await expect(page.locator("next-route-announcer")).toBeAttached();
}

/** React reports a failed hydration as a recoverable error: a page error or a console error. */
export function collectHydrationErrors(page: Page): () => readonly string[] {
  const errors: string[] = [];
  const keep = (text: string) => {
    if (/hydrat|Minified React error #(418|419|422|423|425)\b/i.test(text)) errors.push(text);
  };
  page.on("pageerror", (error) => keep(`${error.name}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") keep(message.text());
  });
  return () => errors;
}
