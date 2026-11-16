import type { Page } from "@playwright/test";

import { expect } from "./auth";
import { adminClient, cronSecret, type TestWorkspace } from "./db";

/*
 * Applying a webhook delivery in end-to-end runs (#28, #479): the route only records a delivery,
 * and the next job tick writes its events. Shared by every `webhooks*.spec.ts`, which run the
 * instance-wide tick and so live in the `instance-wide` Playwright project (playwright.config.ts).
 */

/** How many copies of the event with `dedupeKey` the workspace holds. */
export async function storedCopies(workspace: TestWorkspace, dedupeKey: string): Promise<number | null> {
  const { count, error } = await adminClient()
    .from("activity_events")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspace.id)
    .eq("dedupe_key", dedupeKey);
  if (error) throw new Error(`Reading the events failed (code ${error.code}).`);
  return count;
}

/** Ticks until the delivery's event is stored once; other workspaces' jobs may share a tick. */
export async function tickUntilStored(page: Page, workspace: TestWorkspace, dedupeKey: string): Promise<void> {
  const authorization = `Bearer ${cronSecret()}`;
  await expect(async () => {
    const response = await page.request.post("/api/jobs/tick", { headers: { Authorization: authorization }, timeout: 120_000 });
    expect(response.status()).toBe(200);
    expect(await storedCopies(workspace, dedupeKey)).toBe(1);
  }).toPass({ timeout: 90_000 });
}
