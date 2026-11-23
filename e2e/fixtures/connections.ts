import { expect, type Page } from "@playwright/test";
import { z } from "zod";

import { adminClient, CONNECTION_URL, notDueForAMonth } from "./db";
import { updateUnheard } from "./realtime";

/** Checks a spec runs on a screen of the connect flow before moving on, such as an axe scan. */
export type ConnectChecks = Readonly<{
  catalog?: () => Promise<void>;
  connectScreen?: () => Promise<void>;
}>;

/**
 * Connects a simulated provider from the catalog with the keyboard and lands on the connection.
 * The web server must run with STACKDASH_SIMULATE_PROVIDERS=1 (playwright.config.ts), so the dev
 * consent screen stands in for the provider. `checks` run on the catalog and on the connect screen
 * once each has loaded, before the flow moves on. The new connection is due at once and has its
 * initial sync queued; a spec that does not sync it on purpose follows this with
 * `makeConnectionsNotDue`.
 */
export async function connectSimulated(
  page: Page,
  slug: string,
  provider: string,
  checks: ConnectChecks = {},
): Promise<void> {
  await page.goto(`/w/${slug}/connections`);
  const card = page
    .getByRole("list", { name: "Providers" })
    .getByRole("listitem")
    .filter({ has: page.getByRole("heading", { name: provider, exact: true }) });
  await expect(card.getByText("Simulated", { exact: true })).toBeVisible();
  await checks.catalog?.();
  await card.getByRole("link", { name: `Connect ${provider}` }).focus();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Connect ${provider}`);
  const permissions = page.getByRole("region", { name: `Permissions ${provider} will ask you to grant` });
  await expect(permissions.getByText("Simulated", { exact: true })).toBeVisible();
  await expect(permissions.getByText(/^Simulated\. StackDash makes up example/)).toBeVisible();
  await checks.connectScreen?.();
  await page.getByRole("button", { name: `Continue to ${provider}` }).focus();
  await page.keyboard.press("Enter");

  await expect(page).toHaveURL(CONNECTION_URL);
  await expect(page.getByRole("region", { name: "Status" }).getByText("Simulated", { exact: true })).toBeVisible();
}

// What `makeConnectionsNotDue` reads from a re-read connection row.
const ScheduledRowSchema = z.object({ next_sync_at: z.string() });

// How long `makeConnectionsNotDue` waits for a sync a tick is running to finish. A simulated sync
// takes about a second; a tick's lease on a job is two minutes (TICK_LEASE_SECONDS in
// src/lib/jobs/runner.ts), so a run that outlasts this is a stuck tick, not a slow one.
const SYNC_SETTLE_TIMEOUT_MS = 30_000;

/**
 * Makes every connection the scheduler would sync in the workspace (active, or failed and waiting
 * out its backoff) not due for a month (`notDueForAMonth`, #621), and leaves no sync job of theirs
 * that a tick could still run, then reloads the page. Call it where the app has just made or remade
 * a connection: a connect or reconnect landing on the connection, or sample data. Each of those
 * goes through `completeConnection` (src/lib/connections/connect.ts), which sets `next_sync_at` to
 * now and queues an `initial` sync job, so any job tick against the same database
 * (`npm run jobs:tick`, its watcher, or an `instance-wide` spec) would sync it mid-test, as it
 * would a due seed (#408). Only a spec that syncs it on purpose leaves it due.
 *
 * Parking `next_sync_at` a month out keeps `enqueue_due_syncs` from queueing a sync, and keeps a
 * tick watcher with simulation on (`npm run jobs:tick -- --watch`) from making the connection due
 * again: it leaves one parked more than a day out alone (`PARKED_SYNC_AFTER_MS` in
 * src/lib/jobs/store.ts, #626). Parking alone does not stop a job already in the queue, though:
 * `claim_sync_jobs` claims a queued job whatever `next_sync_at` says, and a sync that succeeds
 * moves `next_sync_at` one poll interval out (a minute for a simulated connection), back in the
 * watcher's reach. So this parks, deletes the connections' sync jobs a tick could still claim
 * (queued, or running on a lease that has expired), waits for a sync a tick is running to finish,
 * and parks again, since that sync may have rewritten `next_sync_at`. It repeats the last three
 * steps until a park holds: no sync job of theirs is open after it, and every connection still has
 * the parked `next_sync_at`. Deleting a running job on an expired lease can let this return while a
 * slow tick's sync of it has yet to write `next_sync_at`, and that lease is compared against this
 * test process's clock, not the database's. Before this runs, any tick may sync them.
 *
 * The writes go through `updateUnheard`, which waits for the message of the last write to each
 * parked connection, the final park's or a sync's after it, so a page that subscribes afterwards
 * never hears it or anything written before it: the connect flow's writes, and those of a sync that
 * ran in the meantime. The page already open may have heard them and would render again at a
 * moment the test does not choose (#179, #448), so it is reloaded, at the same address, and comes
 * back without that refresh pending.
 */
export async function makeConnectionsNotDue(page: Page, workspaceId: string): Promise<void> {
  const admin = adminClient();
  const parkedUntilMs = Date.parse(notDueForAMonth());

  async function park(): Promise<readonly string[]> {
    const { data, error } = await admin
      .from("connections")
      .update({ next_sync_at: new Date(parkedUntilMs).toISOString() })
      .eq("workspace_id", workspaceId)
      .in("status", ["active", "failed"])
      .select("id");
    if (error) throw new Error(`Making the connections not due failed (code ${error.code}).`);
    if (data.length === 0) throw new Error("The workspace has no active or failed connection to make not due.");
    return data.map((connection) => connection.id);
  }

  async function deleteClaimableSyncJobs(connectionIds: readonly string[]): Promise<void> {
    const { error } = await admin
      .from("sync_jobs")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("kind", "sync")
      .in("connection_id", connectionIds)
      .or(`status.eq.queued,and(status.eq.running,locked_until.lt."${new Date().toISOString()}")`);
    if (error) throw new Error(`Deleting the connections' queued sync jobs failed (code ${error.code}).`);
  }

  async function openSyncJobCount(connectionIds: readonly string[]): Promise<number> {
    const { count, error } = await admin
      .from("sync_jobs")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("kind", "sync")
      .in("connection_id", connectionIds)
      .in("status", ["queued", "running"]);
    if (error) throw new Error(`Counting the connections' open sync jobs failed (code ${error.code}).`);
    return count ?? 0;
  }

  async function parkedCount(connectionIds: readonly string[]): Promise<number> {
    const { data, error } = await admin.from("connections").select("next_sync_at").in("id", connectionIds);
    if (error) throw new Error(`Reading the parked connections failed (code ${error.code}).`);
    return data.filter((row) => {
      const scheduled = ScheduledRowSchema.safeParse(row);
      return scheduled.success && Date.parse(scheduled.data.next_sync_at) === parkedUntilMs;
    }).length;
  }

  await updateUnheard("connections", workspaceId, async () => {
    let parked = await park();
    await expect(async () => {
      await deleteClaimableSyncJobs(parked);
      expect(await openSyncJobCount(parked), "A tick is still running a sync of these connections").toBe(0);
      parked = await park();
      expect(await openSyncJobCount(parked), "A sync job of these connections opened during the park").toBe(0);
      expect(await parkedCount(parked), "A sync rewrote next_sync_at during the park").toBe(parked.length);
    }).toPass({ timeout: SYNC_SETTLE_TIMEOUT_MS });
    return parked;
  });
  await page.reload();
}
