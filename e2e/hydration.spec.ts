import type { Page } from "@playwright/test";

import { expect, ownerTest } from "./fixtures/auth";
import { createTestWorkspace, deleteTestWorkspace } from "./fixtures/db";
import { collectHydrationErrors } from "./fixtures/hydration";

/*
 * A workspace page streams in twice (#211). Every page under /w/[workspace] renders its content in
 * a Suspense boundary that the server streams after the shell: the content arrives in a hidden
 * `<div id="S:n">` and React's inline `$RC` script queues it, and `$RV` later moves it into the
 * boundary. React reveals in batches (one frame, then at most every 300 ms), and the header's
 * boundaries can hydrate before the page's is revealed. If a client update reaches the page's
 * boundary in that window, React client-renders the page instead of hydrating it, and the server
 * copy stays in a hidden segment until `$RV` runs: Playwright's strict mode then finds every label
 * and text twice, and the page's server HTML is thrown away and rendered again on the client.
 *
 * In CI the window is a few hundred milliseconds wide and the failure was random. These tests make
 * it deterministic: they hold the page's reveal until the live connection in the header is up
 * (the client update that hit the page before), then release it and check the page hydrated.
 */

type HeldReveals = Readonly<{
  /** Streamed boundaries inside #main that were held. */
  held: number;
  /** Streamed boundaries React replaced with a client render before their content was revealed. */
  clientRendered: number;
}>;

/** The test-only functions the init script adds to `window`, typed here and not project-wide. */
type RevealWindow = Window &
  Partial<
    Readonly<{
      /** What the hold has seen so far, without revealing anything. */
      heldReveals: () => HeldReveals;
      /** Reveals the held boundaries and reports what was held. */
      releaseHeldReveals: () => HeldReveals;
    }>
  >;

/**
 * Wraps React's reveal function so the boundaries inside #main wait for `releaseHeldReveals()`.
 * The inline script assigns `$RV` as a global, which the setter captures; `$RC` reads it back
 * through the getter. Boundaries outside #main (the header) reveal as React schedules them.
 * `$RC` only schedules the reveal (next frame, or up to 300 ms after the last one), so a test
 * waits for `heldReveals()` to report the page's boundary before it releases it.
 */
async function holdPageReveals(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Reveal = (batch: Element[]) => void;
    let reveal: Reveal | undefined;
    const held: Element[] = [];
    // React deletes a boundary's server markup, the `<template id="B:n">` included, when it gives
    // up hydrating the boundary and renders it on the client.
    let clientRendered = 0;
    const hold: Reveal = (batch) => {
      // React empties the batch after revealing it and schedules the next one when it refills.
      const pairs = batch.splice(0);
      const now: Element[] = [];
      for (let index = 0; index + 1 < pairs.length; index += 2) {
        const boundary = pairs[index];
        const segment = pairs[index + 1];
        if (boundary === undefined || segment === undefined) continue;
        if (!boundary.isConnected) clientRendered += 1;
        (boundary.closest("#main") === null ? now : held).push(boundary, segment);
      }
      if (now.length > 0) reveal?.(now);
    };
    Object.defineProperty(window, "$RV", {
      configurable: true,
      get: () => hold,
      set: (value: Reveal) => {
        reveal = value;
      },
    });
    // React deletes a boundary's server markup when it client-renders it, so a held boundary that
    // is no longer in the document was replaced by a client render while it waited.
    const report = (pairs: readonly Element[]): HeldReveals => {
      let disconnected = 0;
      for (let index = 0; index < pairs.length; index += 2) {
        if (pairs[index]?.isConnected === false) disconnected += 1;
      }
      return { held: pairs.length / 2, clientRendered: clientRendered + disconnected };
    };
    const target: RevealWindow = window;
    Object.assign(target, {
      heldReveals: () => report(held),
      releaseHeldReveals: () => {
        const pairs = held.splice(0);
        // Counted first: React's reveal empties the array it is given.
        const reveals = report(pairs);
        clientRendered = reveals.clientRendered;
        if (pairs.length > 0) reveal?.(pairs);
        return reveals;
      },
    });
  });
}

// `loading` is the page skeleton's status line, which names what is loading (#345). It shows
// while the page's boundary is held, so the hold below is also where it is checked.
const PAGES = [
  { path: "settings", heading: "Settings", loading: "Loading settings" },
  { path: "alerts", heading: "Alerts", loading: "Loading alerts" },
  { path: "alerts/settings", heading: "Alert settings", loading: "Loading alert settings" },
  { path: "connections", heading: "Connections", loading: "Loading connections" },
  { path: "dashboard", heading: "Dashboard", loading: "Loading the dashboard" },
  { path: "timeline", heading: "Timeline", loading: "Loading the timeline" },
] as const;

ownerTest.describe("streamed workspace pages hydrate once (#211)", () => {
  for (const { path, heading, loading } of PAGES) {
    ownerTest(`${path}: the live connection opening before the page is revealed does not render it twice`, async ({
      page,
    }) => {
      const workspace = await createTestWorkspace(`Hydration ${path}`);
      try {
        const hydrationErrors = collectHydrationErrors(page);
        await holdPageReveals(page);
        await page.goto(`/w/${workspace.slug}/${path}`);

        // The header hydrated and LiveRefresh's channel joined, which updates the arrival state
        // around the page; the page's content is still waiting in its hidden streamed segment. The
        // exact name says live (not connecting) and that the new workspace has no connections (#392).
        await expect(page.getByRole("button", { name: "Live updates, 0 connected", exact: true })).toBeVisible();
        await expect(page.getByRole("heading", { level: 1, includeHidden: true })).toHaveCount(1);

        await expect
          .poll(
            () =>
              page.evaluate(() => {
                const target: RevealWindow = window;
                if (target.heldReveals === undefined) throw new Error("The reveal hold was not installed.");
                return target.heldReveals().held;
              }),
            { message: "the page's content streamed in a boundary that reached the hold" },
          )
          .toBeGreaterThan(0);
        await expect(page.locator("#main").getByRole("status").filter({ hasText: /^Loading/ })).toHaveText(loading);

        const reveals = await page.evaluate(() => {
          const target: RevealWindow = window;
          if (target.releaseHeldReveals === undefined) throw new Error("The reveal hold was not installed.");
          return target.releaseHeldReveals();
        });
        expect(reveals.clientRendered, "boundaries React client-rendered instead of hydrating").toBe(0);

        await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
        await expect(page.getByRole("heading", { level: 1, includeHidden: true })).toHaveCount(1);
        expect(hydrationErrors()).toEqual([]);
      } finally {
        await deleteTestWorkspace(workspace);
      }
    });
  }
});
