import { expect, type Page } from "@playwright/test";

import type { Database } from "../../src/lib/supabase/database.types";

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

/** Runs one instance-wide job tick, as the scheduler does. */
async function tick(page: Page): Promise<void> {
  const response = await page.request.post("/api/jobs/tick", { headers: { Authorization: `Bearer ${cronSecret()}` }, timeout: 120_000 });
  expect(response.status()).toBe(200);
}

/** Ticks until the delivery's event is stored once; other workspaces' jobs may share a tick. */
export async function tickUntilStored(page: Page, workspace: TestWorkspace, dedupeKey: string): Promise<void> {
  await expect(async () => {
    await tick(page);
    expect(await storedCopies(workspace, dedupeKey)).toBe(1);
  }).toPass({ timeout: 90_000 });
}

/**
 * Ticks until the workspace's one connection of `provider` has `status`, for an uninstall delivery
 * (`needs_attention`). Post the uninstall only after the connection's first sync has finished: a
 * sync that finishes after the uninstall's job sets the connection back to `active` (#487).
 */
export async function tickUntilConnectionStatus(
  page: Page,
  workspace: TestWorkspace,
  provider: Database["public"]["Enums"]["provider_id"],
  status: Database["public"]["Enums"]["connection_status"],
): Promise<void> {
  await expect(async () => {
    await tick(page);
    const { data, error } = await adminClient().from("connections").select("status").eq("workspace_id", workspace.id).eq("provider", provider);
    if (error) throw new Error(`Reading the connection failed (code ${error.code}).`);
    expect(data.map((row) => row.status)).toEqual([status]);
  }).toPass({ timeout: 90_000 });
}
