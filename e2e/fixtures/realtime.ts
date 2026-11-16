import { randomUUID } from "node:crypto";

import { expect, type Page, type Request } from "@playwright/test";
import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { z } from "zod";

import { adminClient } from "./db";

// A change reaches an open page within a few seconds: Realtime delivery, the refresh debounce, and
// one server render.
export const LIVE_TIMEOUT_MS = 15_000;

// Realtime text frames are [join_ref, ref, topic, event, payload] (realtime-js serializer 2.0.0).
export const FrameSchema = z.tuple([z.unknown(), z.unknown(), z.string(), z.string(), z.unknown()]);
// Sent by Realtime once the channel's postgres_changes subscription is streaming.
export const SubscribedSchema = z.object({ extension: z.literal("postgres_changes"), status: z.literal("ok") });

export type LiveChannel = Readonly<{
  subscribed: () => boolean;
  left: () => boolean;
  /** Every postgres_changes payload the channel received, in order, unparsed. */
  changes: () => readonly unknown[];
}>;

/**
 * Watches the page's Realtime socket for the workspace channel that LiveRefresh opens. Call it
 * before navigating, so no frame is missed. Waiting for the subscription before writing a row is
 * what makes that row's delivery certain. A row written earlier can still arrive after the
 * subscription (#226): Realtime reads changes from the replication slot behind the writes and
 * matches them against the subscriptions that exist when it reads them. So a test asserts on the
 * changes it wrote after subscribing, never on an exact total of what the channel received.
 *
 * A new join (LiveRefresh remounting, or the client rejoining) clears `subscribed` until that
 * join streams, so a wait after it is not satisfied by the channel that went before.
 */
export function watchLiveChannel(page: Page, workspaceId: string): LiveChannel {
  const topicPrefix = `realtime:workspace-live:${workspaceId}:`;
  let subscribed = false;
  let left = false;
  const changes: unknown[] = [];

  function frameOf(data: string | Buffer): z.infer<typeof FrameSchema> | null {
    if (typeof data !== "string") return null;
    const frame = FrameSchema.safeParse(JSON.parse(data));
    return frame.success && frame.data[2].startsWith(topicPrefix) ? frame.data : null;
  }

  page.on("websocket", (socket) => {
    if (!socket.url().includes("/realtime/v1/websocket")) return;
    socket.on("framereceived", ({ payload }) => {
      const frame = frameOf(payload);
      if (frame === null) return;
      const [, , , event, body] = frame;
      if (event === "system" && SubscribedSchema.safeParse(body).success) subscribed = true;
      if (event === "postgres_changes") changes.push(body);
    });
    socket.on("framesent", ({ payload }) => {
      const event = frameOf(payload)?.[3];
      if (event === "phx_join") subscribed = false;
      if (event === "phx_leave") left = true;
    });
  });

  return { subscribed: () => subscribed, left: () => left, changes: () => changes };
}

export async function expectSubscribed(channel: LiveChannel): Promise<void> {
  await expect
    .poll(channel.subscribed, {
      timeout: LIVE_TIMEOUT_MS,
      message: "The workspace channel's postgres_changes subscription never streamed",
    })
    .toBe(true);
}

// The one column `insertUnheard` reads from a delivered row.
const InsertedRowSchema = z.object({ id: z.string() });

// The tables in the `supabase_realtime` publication
// (supabase/migrations/20261104090000_realtime_publication.sql): the only ones Realtime delivers
// changes from. The same list as `LIVE_TABLES` in src/components/app/live-refresh.tsx, which a spec
// cannot import (a client component).
type PublishedTable = "activity_events" | "usage_snapshots" | "connections" | "triggered_alerts";

/**
 * Runs `insert`, which writes one row to `table` in the workspace and returns its id, and resolves
 * with that id once Realtime has read the insert, so a page that subscribes afterwards never hears
 * it (#448). Realtime matches each change against the subscriptions that exist when it reads the
 * replication slot, not when the row was written (#226, see `watchLiveChannel`). So a row seeded
 * just before a page opens can still reach that page once it subscribes, and LiveRefresh renders
 * the route again `REFRESH_DEBOUNCE_MS` later (src/lib/realtime/refresh-scheduler.ts). That is
 * harmless until the test deletes the row: the refresh then renders the page after the delete, as
 * not found. Seed a row in a published table that the test deletes behind an open page through
 * this. A row in any other table never reaches a page, needs nothing, and could never be awaited
 * here, so `table` admits only the published ones.
 *
 * A service role channel subscribes before the insert, which makes its delivery certain; once it
 * has arrived there, Realtime has read it, and a later subscription is never matched against it.
 */
export async function insertUnheard(
  table: PublishedTable,
  workspaceId: string,
  insert: () => Promise<string>,
): Promise<string> {
  const admin = adminClient();
  // Join with the service role key, not whatever token the client happens to hold yet (see
  // live-refresh.tsx).
  await admin.realtime.setAuth();
  let state = "joining";
  const delivered = new Set<string>();
  const filter = { event: "INSERT", schema: "public", table, filter: `workspace_id=eq.${workspaceId}` } as const;
  const channel = admin
    .channel(`e2e-unheard:${randomUUID()}`)
    .on("postgres_changes", filter, ({ new: row }) => delivered.add(InsertedRowSchema.parse(row).id))
    .on("system", {}, (payload: unknown) => {
      if (SubscribedSchema.safeParse(payload).success) state = "subscribed";
    })
    .subscribe((status) => {
      if (status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR || status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT) {
        state = status;
      }
    });
  try {
    await expect
      .poll(() => state, { timeout: LIVE_TIMEOUT_MS, message: "The seed channel's subscription never streamed" })
      .toBe("subscribed");
    const id = await insert();
    await expect
      .poll(() => delivered.has(id), { timeout: LIVE_TIMEOUT_MS, message: `Realtime never delivered the ${table} insert` })
      .toBe(true);
    return id;
  } finally {
    await admin.removeChannel(channel);
  }
}

/**
 * Whether a request is the RSC GET that renders `path` again for a refresh or a navigation to it,
 * prefetches excluded.
 */
export function isRenderRequest(request: Request, path: string): boolean {
  const headers = request.headers();
  return (
    request.method() === "GET" &&
    headers["rsc"] === "1" &&
    headers["next-router-prefetch"] === undefined &&
    headers["next-router-segment-prefetch"] === undefined &&
    new URL(request.url()).pathname === path
  );
}

export type LiveRefreshWatch = Readonly<{
  /**
   * Call before the action. Resolves once the action's change is sure to be delivered, and returns
   * a function that waits for the refresh it sets off.
   */
  next: () => Promise<() => Promise<void>>;
}>;

/**
 * For an action that writes a live table (`LIVE_TABLES` in src/components/app/live-refresh.tsx).
 * The action's own `refresh()` rides in its POST response. The change then reaches the browser
 * over Realtime, and `LiveRefresh` renders the route again `REFRESH_DEBOUNCE_MS` later
 * (src/lib/realtime/refresh-scheduler.ts). That swaps the metadata a second time, typically while
 * axe runs (#179, see `expectNoAxeViolations` in ./axe.ts).
 *
 * Whether that second render happens depends on timing. Realtime delivers only changes made after
 * the channel's postgres_changes subscription streams, and that is later than the header's "Live"
 * state. An action taken in between is never heard, and no refresh follows. So `next()` first waits
 * for the subscription, which makes the refresh certain. Then it listens for the next RSC GET of
 * this path, prefetches excluded. The function it returns resolves once that response's body is
 * fully in. After that no render is pending, and `expectNoAxeViolations` waits out the swap.
 *
 * Call `watchLiveRefresh` before the page opens, so the subscription frame is not missed.
 */
export function watchLiveRefresh(page: Page, workspaceId: string): LiveRefreshWatch {
  const live = watchLiveChannel(page, workspaceId);
  return {
    async next() {
      await expectSubscribed(live);
      // Room in the resource timing buffer (250 entries by default) for the entry awaited below.
      await page.evaluate(() => performance.clearResourceTimings());
      const path = new URL(page.url()).pathname;
      const refreshed = page.waitForResponse((response) => isRenderRequest(response.request(), path), {
        timeout: LIVE_TIMEOUT_MS,
      });
      // The browser writes a fetch's resource timing entry once its body has arrived. Playwright
      // 1.64's `response.finished()` never settled for this streamed response, although the page
      // read the body to the end within 60 ms.
      return async () => {
        const url = (await refreshed).url();
        await page.waitForFunction((name) => performance.getEntriesByName(name).length > 0, url, {
          timeout: LIVE_TIMEOUT_MS,
        });
      };
    },
  };
}
