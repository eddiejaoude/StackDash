import { expect, type Page, type Request } from "@playwright/test";
import { z } from "zod";

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

// What a test reads from a postgres_changes payload: the table, the event type, and the row's
// workspace, plus its title for an activity event.
export const LiveChangeSchema = z
  .object({
    data: z.object({
      table: z.string(),
      type: z.string(),
      record: z.object({ workspace_id: z.string(), title: z.string().optional() }),
    }),
  })
  .transform(({ data }) => data);

/** Whether the channel has delivered the activity event with this title. */
export function deliveredEvent(live: LiveChannel, title: string): boolean {
  return z
    .array(LiveChangeSchema)
    .parse(live.changes())
    .some(({ table, record }) => table === "activity_events" && record.title === title);
}
