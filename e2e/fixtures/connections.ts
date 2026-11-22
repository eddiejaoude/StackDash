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
 * once each has loaded, before the flow moves on. The new connection is due at once; a spec that
 * does not sync it on purpose follows this with `makeConnectionsNotDue`.
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

// What `makeConnectionsNotDue` reads from a delivered connection row.
const ScheduledRowSchema = z.object({ next_sync_at: z.string() });

/**
 * Makes every connection the scheduler would sync in the workspace (active, or failed and waiting
 * out its backoff) not due for a month (`notDueForAMonth`, #621), then reloads the page. Call it
 * where the app has just made or remade a connection: a connect or reconnect landing on the
 * connection, or sample data. The app makes each one due at once (src/lib/connections/connect.ts
 * sets `next_sync_at` to now, so the first sync runs right away), and any job tick against the same
 * database (`npm run jobs:tick`, its watcher, or an `instance-wide` spec) would sync it mid-test,
 * as it would a due seed (#408). Only a spec that syncs it on purpose leaves it due. A tick watcher
 * with simulation on (`npm run jobs:tick -- --watch`) makes every active simulated connection due
 * on each iteration, but leaves one parked more than a day out alone (`PARKED_SYNC_AFTER_MS` in
 * src/lib/jobs/store.ts, #626), so these stay out of its reach once this has run; before it, any
 * tick may sync them.
 *
 * The update goes through `updateUnheard`, so a page that subscribes afterwards never hears it or
 * the connect flow's own writes before it. The page already open may have heard them and would
 * render again at a moment the test does not choose (#179, #448), so it is reloaded, at the same
 * address, and comes back without that refresh pending.
 */
export async function makeConnectionsNotDue(page: Page, workspaceId: string): Promise<void> {
  const nextSyncAt = notDueForAMonth();
  await updateUnheard(
    "connections",
    workspaceId,
    async () => {
      const { data, error } = await adminClient()
        .from("connections")
        .update({ next_sync_at: nextSyncAt })
        .eq("workspace_id", workspaceId)
        .in("status", ["active", "failed"])
        .select("id");
      if (error) throw new Error(`Making the connections not due failed (code ${error.code}).`);
      if (data.length === 0) throw new Error("The workspace has no active or failed connection to make not due.");
      return data.map((connection) => connection.id);
    },
    (row) => {
      const scheduled = ScheduledRowSchema.safeParse(row);
      return scheduled.success && Date.parse(scheduled.data.next_sync_at) === Date.parse(nextSyncAt);
    },
  );
  await page.reload();
}
