import { expect, type Page, type Request } from "@playwright/test";
import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { z } from "zod";

import { LIVE_CHANGE_EVENT, LIVE_TABLES, liveTopic } from "../../src/lib/realtime/arrivals";

import { adminClient, newAdminClient } from "./db";

// A change reaches an open page within a few seconds: Realtime delivery, the refresh debounce, and
// one server render.
export const LIVE_TIMEOUT_MS = 15_000;

// Realtime text frames are [join_ref, ref, topic, event, payload] (realtime-js serializer 2.0.0).
export const FrameSchema = z.tuple([z.unknown(), z.unknown(), z.string(), z.string(), z.unknown()]);

// Sent by Realtime to a channel that joined with `broadcast.replication_ready`, as LiveRefresh does,
// once the replication connection that carries the database's messages is up: every write
// committed after it reaches the channel.
export const StreamReadySchema = z.object({ extension: z.literal("system"), status: z.literal("ok") });

// What the database sends on a workspace's live topic for each statement that inserts or updates
// one of the live tables (supabase/migrations/20261122210934_live_refresh_broadcast.sql), less the
// id realtime.send adds.
export const LiveMessageSchema = z.object({
  table: z.enum(LIVE_TABLES),
  operation: z.enum(["INSERT", "UPDATE"]),
  connection_ids: z.array(z.string()),
  changed_at: z.string(),
});

export type LiveMessage = z.infer<typeof LiveMessageSchema>;

// Realtime sends a broadcast to a client on protocol 2.0.0 as a binary frame: the kind (4, a user
// broadcast), the byte lengths of the topic, the event, and the metadata, the payload's encoding
// (1, JSON), then those fields and the payload. Realtime writes it in
// RealtimeWeb.Socket.V2Serializer.fastlane!, and realtime-js reads it in
// Serializer._decodeUserBroadcast (node_modules/@supabase/realtime-js/src/lib/serializer.ts).
const USER_BROADCAST_KIND = 4;
const JSON_ENCODING = 1;
const BROADCAST_HEADER_BYTES = 5;

type BroadcastFrame = Readonly<{ topic: string; event: string; payload: unknown }>;

function broadcastFrame(data: Buffer): BroadcastFrame | null {
  if (data.length < BROADCAST_HEADER_BYTES || data.readUInt8(0) !== USER_BROADCAST_KIND) return null;
  if (data.readUInt8(4) !== JSON_ENCODING) return null;
  const topicEnd = BROADCAST_HEADER_BYTES + data.readUInt8(1);
  const eventEnd = topicEnd + data.readUInt8(2);
  const payloadStart = eventEnd + data.readUInt8(3);
  const payload: unknown = JSON.parse(data.toString("utf8", payloadStart));
  return { topic: data.toString("utf8", BROADCAST_HEADER_BYTES, topicEnd), event: data.toString("utf8", topicEnd, eventEnd), payload };
}

/**
 * A timestamp as microseconds since the epoch, exact whatever its offset: the database writes a
 * live message's `changed_at` and a row's timestamps with up to six fractional digits, more than a
 * `Date` keeps.
 */
function epochMicros(timestamp: string): number {
  const groups = /^(?<seconds>.+T\d{2}:\d{2}:\d{2})(?:\.(?<fraction>\d{1,6}))?(?<zone>Z|[+-]\d{2}:\d{2})$/.exec(timestamp)?.groups;
  const seconds = groups?.["seconds"];
  const zone = groups?.["zone"];
  if (seconds === undefined || zone === undefined) throw new Error(`Not a timestamp: ${timestamp}`);
  return Date.parse(`${seconds}${zone}`) * 1000 + Number((groups?.["fraction"] ?? "").padEnd(6, "0"));
}

/**
 * Whether one of the messages is the one for a write to `table` made in the transaction that started
 * at `writtenAt`. A row's created_at (on insert) and updated_at (on every update, by its
 * set_updated_at trigger) are that transaction's start, and so is the `changed_at` the database
 * sends for it, so the match is exact: an earlier or later write to the same table never matches.
 */
function carries(
  messages: readonly LiveMessage[],
  table: LiveMessage["table"],
  operation: LiveMessage["operation"],
  writtenAt: string,
): boolean {
  const at = epochMicros(writtenAt);
  return messages.some(
    (message) => message.table === table && message.operation === operation && epochMicros(message.changed_at) === at,
  );
}

export type LiveChannel = Readonly<{
  workspaceId: string;
  /** Whether the database stream of the channel's latest join is ready. */
  subscribed: () => boolean;
  left: () => boolean;
  /** Every live change the channel received, in order. */
  changes: () => readonly LiveMessage[];
}>;

/**
 * Watches the page's Realtime socket for the workspace channel that LiveRefresh opens. Call it
 * before navigating, so no frame is missed. Waiting for the channel's database stream before
 * writing a row is what makes that row's delivery certain. A row written earlier can still arrive
 * after it (#226): Realtime reads the database's messages from the replication slot behind the
 * writes and sends each one to the channels joined to its topic when it reads it. So a test asserts
 * on the changes it wrote after subscribing, never on an exact total of what the channel received.
 *
 * A new join (LiveRefresh remounting, or the client rejoining) clears `subscribed` until that
 * join's stream is ready, so a wait after it is not satisfied by the channel that went before.
 */
export function watchLiveChannel(page: Page, workspaceId: string): LiveChannel {
  const topic = `realtime:${liveTopic(workspaceId)}`;
  let subscribed = false;
  let left = false;
  // Parsed when read, so a payload of another shape fails the test that reads it.
  const changes: unknown[] = [];

  function textFrame(data: string | Buffer): z.infer<typeof FrameSchema> | null {
    if (typeof data !== "string") return null;
    const frame = FrameSchema.safeParse(JSON.parse(data));
    return frame.success && frame.data[2] === topic ? frame.data : null;
  }

  page.on("websocket", (socket) => {
    if (!socket.url().includes("/realtime/v1/websocket")) return;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") {
        const broadcast = broadcastFrame(payload);
        if (broadcast?.topic === topic && broadcast.event === LIVE_CHANGE_EVENT) changes.push(broadcast.payload);
        return;
      }
      const frame = textFrame(payload);
      if (frame?.[3] === "system" && StreamReadySchema.safeParse(frame[4]).success) subscribed = true;
    });
    socket.on("framesent", ({ payload }) => {
      const event = textFrame(payload)?.[3];
      if (event === "phx_join") subscribed = false;
      if (event === "phx_leave") left = true;
    });
  });

  return {
    workspaceId,
    subscribed: () => subscribed,
    left: () => left,
    changes: () => z.array(LiveMessageSchema).parse(changes),
  };
}

export async function expectSubscribed(channel: LiveChannel): Promise<void> {
  await expect
    .poll(channel.subscribed, {
      timeout: LIVE_TIMEOUT_MS,
      message: "The workspace channel's database stream never became ready",
    })
    .toBe(true);
}

// Live tables with a created_at that only its default sets, so it tells an insert's message apart.
export type InsertedTable = "activity_events" | "usage_snapshots" | "connections";

// Live tables whose set_updated_at trigger sets updated_at on every update.
type UpdatedTable = "usage_snapshots" | "connections";

const CreatedAtSchema = z.object({ created_at: z.string() });
const UpdatedAtSchema = z.array(z.object({ updated_at: z.string() }));

/** When the row with this id was inserted into `table`: its created_at, for `deliveredInsert`. */
export async function insertedAt(table: InsertedTable, id: string): Promise<string> {
  const { data, error } = await adminClient().from(table).select("created_at").eq("id", id).single();
  if (error) throw new Error(`Reading the inserted ${table} row failed (code ${error.code}).`);
  return CreatedAtSchema.parse(data).created_at;
}

/**
 * Whether the messages include the one for the insert into `table` made at `at` (`insertedAt`).
 * The row must keep the created_at its default gives it (`carries`).
 */
export function deliveredInsert(messages: readonly LiveMessage[], table: InsertedTable, at: string): boolean {
  return carries(messages, table, "INSERT", at);
}

/**
 * Runs `insert`, which writes one row to `table` in the workspace and returns its id, and resolves
 * with that id once Realtime has sent the database's message for the insert, so a page that
 * subscribes afterwards never hears it (#448). Realtime sends each message to the channels joined
 * to its topic when it reads it from the replication slot, not when the row was written (#226, see
 * `watchLiveChannel`). So a row seeded just before a page opens can still reach that page once it
 * subscribes, and LiveRefresh renders the route again `REFRESH_DEBOUNCE_MS` later
 * (src/lib/realtime/refresh-scheduler.ts). That is harmless until the test deletes the row: the
 * refresh then renders the page after the delete, as not found. Or until the test counts arrivals:
 * that refresh is a batch of its own, which can land among the test's changes and split them into
 * two batches (#508). Seed a row in a live table that the test deletes behind an open page, or the
 * last seed before a test that counts arrivals, through this. A row in any other table never
 * reaches a page, needs nothing, and could never be awaited here, so `table` admits only live
 * tables, and only those whose created_at tells the insert's message apart (`carries`): the row
 * must keep the created_at its default gives it.
 *
 * A service role channel joins the workspace's topic before the insert and waits for its database
 * stream, which makes the message's delivery certain; once it has arrived there, Realtime has read
 * it, and a later subscription never receives it. Realtime reads the slot in commit order, so every
 * write committed before the insert has been read by then too.
 */
export function insertUnheard(table: InsertedTable, workspaceId: string, insert: () => Promise<string>): Promise<string> {
  return writeUnheard(table, "INSERT", workspaceId, insert, async (id) => [await insertedAt(table, id)]);
}

/**
 * `insertUnheard` for an update: runs `update`, which updates rows of `table` in the workspace and
 * returns their ids, and resolves with those ids once Realtime has sent the message for the last
 * write to every one of them, so a page that subscribes afterwards never hears them. A row's
 * updated_at names the transaction that wrote it last: the update, or a write after it, such as a
 * sync, whose message Realtime reads later still.
 */
export function updateUnheard(
  table: UpdatedTable,
  workspaceId: string,
  update: () => Promise<readonly string[]>,
): Promise<readonly string[]> {
  return writeUnheard(table, "UPDATE", workspaceId, update, async (ids) => {
    const { data, error } = await adminClient().from(table).select("updated_at").in("id", [...ids]);
    if (error) throw new Error(`Reading the updated ${table} rows failed (code ${error.code}).`);
    return [...new Set(UpdatedAtSchema.parse(data).map((row) => row.updated_at))];
  });
}

/**
 * Joins a service role channel to the workspace's live topic, waits for its database stream, runs
 * `write`, and resolves with what it returned once the channel has received the message for every
 * write time `writtenAt` reads from the result.
 *
 * The channel is on a client of its own. A client hands back the channel it already holds for a
 * topic, and every call for one workspace joins the same topic, so two overlapping calls on the
 * worker's shared client would share one channel: the second's subscribe would do nothing, and the
 * first's removal would end both.
 */
async function writeUnheard<Written>(
  table: LiveMessage["table"],
  operation: LiveMessage["operation"],
  workspaceId: string,
  write: () => Promise<Written>,
  writtenAt: (result: Written) => Promise<readonly string[]>,
): Promise<Written> {
  const admin = newAdminClient();
  // Join with the service role key, not whatever token the client happens to hold yet (see
  // live-refresh.tsx). The service role bypasses row level security, so the topic's policy admits it.
  await admin.realtime.setAuth();
  let state = "joining";
  const delivered: LiveMessage[] = [];
  const channel = admin
    .channel(liveTopic(workspaceId), { config: { private: true, broadcast: { replication_ready: true } } })
    .on("broadcast", { event: LIVE_CHANGE_EVENT }, ({ payload }: { payload: unknown }) => {
      const message = LiveMessageSchema.safeParse(payload);
      if (message.success) delivered.push(message.data);
    })
    .on("system", {}, (payload: unknown) => {
      if (StreamReadySchema.safeParse(payload).success) state = "subscribed";
    })
    .subscribe((status) => {
      if (
        status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR ||
        status === REALTIME_SUBSCRIBE_STATES.TIMED_OUT ||
        status === REALTIME_SUBSCRIBE_STATES.CLOSED
      ) {
        state = status;
      }
    });
  try {
    await expect
      .poll(() => state, { timeout: LIVE_TIMEOUT_MS, message: "The service role channel's database stream never became ready" })
      .toBe("subscribed");
    const result = await write();
    const writes = await writtenAt(result);
    await expect
      .poll(() => writes.every((at) => carries(delivered, table, operation, at)), {
        timeout: LIVE_TIMEOUT_MS,
        message: `Realtime never delivered the ${table} ${operation.toLowerCase()}`,
      })
      .toBe(true);
    return result;
  } finally {
    await admin.removeChannel(channel);
    await admin.realtime.disconnect();
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
 * For an action that writes a live table (one with the live triggers of
 * supabase/migrations/20261122210934_live_refresh_broadcast.sql). The action's own `refresh()`
 * rides in its POST response. The change then reaches the browser over Realtime, and `LiveRefresh`
 * renders the route again `REFRESH_DEBOUNCE_MS` later (src/lib/realtime/refresh-scheduler.ts). That
 * swaps the metadata a second time, typically while axe runs (#179, see `expectNoAxeViolations` in
 * ./axe.ts).
 *
 * Whether that second render happens depends on timing. Realtime delivers only the messages of
 * writes made after the channel's database stream is ready, and that can be later than the
 * header's "Live" state. An action taken in between is never heard, and no refresh follows. So
 * `next()` first waits for the stream, which makes the refresh certain. Then it listens for the
 * next RSC GET of this path, prefetches excluded. The function it returns resolves once that
 * response's body is fully in. After that no render is pending, and `expectNoAxeViolations` waits
 * out the swap.
 *
 * Call `watchLiveRefresh` before the page opens, so the stream's frame is not missed.
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

/**
 * Whether the channel has delivered the insert of the activity event with this title, in its
 * workspace. The event must keep the created_at its default gives it (`carries`).
 */
export async function deliveredEvent(live: LiveChannel, title: string): Promise<boolean> {
  const { data, error } = await adminClient()
    .from("activity_events")
    .select("created_at")
    .eq("workspace_id", live.workspaceId)
    .eq("title", title);
  if (error) throw new Error(`Reading the event failed (code ${error.code}).`);
  return data.some((event) => deliveredInsert(live.changes(), "activity_events", event.created_at));
}
