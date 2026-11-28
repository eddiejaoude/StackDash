import { createHmac, hkdfSync, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";

import { expect, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import { z } from "zod";

import { ATTACHMENT_BUCKET, SEND_LIMIT_PER_USER, SEND_WINDOW_SECONDS } from "../../src/lib/support/limits";
import { SUPPORT_OPERATORS_TOPIC } from "../../src/lib/support/live";

import { createSyntheticUser, removeSyntheticUser, type SyntheticUser } from "./auth";
import { adminClient, newAdminClient, personalWorkspace } from "./db";
import { FrameSchema, LIVE_TIMEOUT_MS, StreamReadySchema } from "./realtime";

/*
 * Support chat (#680) from the outside: a member of its own with a client address of its own, the
 * Realtime joins the screens make, and the rate limit's counter. e2e/support-chat.spec.ts.
 */

export type SupportMember = Readonly<{
  user: SyntheticUser;
  /** The member's personal workspace, which every new account gets. */
  workspace: Readonly<{ id: string; slug: string; name: string }>;
}>;

/** A brand new user who writes to support, so nobody else's conversations or counts are touched. */
export async function createSupportMember(label: string): Promise<SupportMember> {
  const user = await createSyntheticUser(label);
  return { user, workspace: await personalWorkspace(user.id) };
}

/**
 * Deletes the member's images from the support bucket, then the member, whose conversations go
 * with the account (on delete cascade). The app's own account deletion removes the images the same
 * way (deleteOwnerObjects in src/lib/support/attachment-store.ts): no cascade reaches Storage.
 */
export async function removeSupportMember(member: SupportMember): Promise<void> {
  const bucket = adminClient().storage.from(ATTACHMENT_BUCKET);
  const { data, error } = await bucket.list(member.user.id, { limit: 100 });
  if (error) throw new Error(`Listing the member's support images failed: ${error.message}`);
  if (data.length > 0) {
    const removed = await bucket.remove(data.map((object) => `${member.user.id}/${object.name}`));
    if (removed.error) throw new Error(`Removing the member's support images failed: ${removed.error.message}`);
  }
  await removeSyntheticUser(member.user);
}

/**
 * A client address in the IPv6 documentation range, new per call. Support chat's rate limit counts
 * by user and by client address (src/lib/support/rate-limit.ts), and every local request comes
 * from one address, so a context that sends gets its own: no other test, and no earlier run within
 * the limit's window, shares the count. Reached directly, the app reads the client from
 * x-forwarded-for, as e2e/project-pages.spec.ts relies on too.
 */
export function clientAddress(): string {
  return `2001:db8::${randomBytes(4).toString("hex").replace(/(.{4})(.{4})/, "$1:$2")}`;
}

/** A browser context signed in as the member, from a client address of its own. */
export function memberContext(browser: Browser, member: SupportMember): Promise<BrowserContext> {
  return browser.newContext({
    storageState: { cookies: member.user.cookies, origins: [] },
    extraHTTPHeaders: { "x-forwarded-for": clientAddress() },
  });
}

export type TopicJoin = Readonly<{ joined: () => boolean }>;

/**
 * Watches the page's Realtime socket for its join of a private support topic and whether Realtime
 * accepted it: the `phx_reply` with status ok to the latest `phx_join` (realtime-js serializer
 * 2.0.0 frames, [join_ref, ref, topic, event, payload], see ./realtime.ts). Call it before
 * navigating. A new document, a new join, or the socket closing clears it until that join is
 * accepted, as `watchLiveChannel` does.
 */
export function watchSupportJoin(page: Page, topic: string): TopicJoin {
  const wire = `realtime:${topic}`;
  const ReplySchema = z.object({ status: z.string() });
  let joinRef: unknown = null;
  let joined = false;

  page.on("request", (request) => {
    if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
    joinRef = null;
    joined = false;
  });

  page.on("websocket", (socket) => {
    if (!socket.url().includes("/realtime/v1/websocket")) return;
    socket.on("framesent", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = FrameSchema.safeParse(JSON.parse(payload));
      if (!frame.success || frame.data[2] !== wire || frame.data[3] !== "phx_join") return;
      joinRef = frame.data[1];
      joined = false;
    });
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      const frame = FrameSchema.safeParse(JSON.parse(payload));
      if (!frame.success || frame.data[2] !== wire || frame.data[3] !== "phx_reply" || frame.data[1] !== joinRef) return;
      joined = ReplySchema.safeParse(frame.data[4]).data?.status === "ok";
    });
    socket.on("close", () => {
      joined = false;
    });
  });

  return { joined: () => joined };
}

export async function expectJoined(join: TopicJoin, topic: string): Promise<void> {
  await expect
    .poll(join.joined, { timeout: LIVE_TIMEOUT_MS, message: `Realtime never accepted the page's join of ${topic}` })
    .toBe(true);
}

/**
 * Resolves once Realtime's replication connection, which carries the hints the database sends on
 * the support topics (realtime.send inside each write), is up. The support channels join without
 * `broadcast.replication_ready`, so a joined channel says nothing about it, and on an idle local
 * stack the first write after a join could go out before the connection is. A service role channel
 * of its own joins with it, waits for Realtime's ready message, and leaves; the connection belongs
 * to the project, not the channel, so it stays up for the test's writes.
 */
export async function supportStreamReady(): Promise<void> {
  const admin = newAdminClient();
  await admin.realtime.setAuth();
  let state = "joining";
  const channel = admin
    .channel(SUPPORT_OPERATORS_TOPIC, { config: { private: true, broadcast: { replication_ready: true } } })
    .on("system", {}, (payload: unknown) => {
      if (StreamReadySchema.safeParse(payload).success) state = "ready";
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
      .poll(() => state, { timeout: LIVE_TIMEOUT_MS, message: "Realtime's replication connection never became ready" })
      .toBe("ready");
  } finally {
    await admin.removeChannel(channel);
    admin.realtime.disconnect();
  }
}

/**
 * The rate limit key of the user's sends, made the way src/lib/support/rate-limit.ts makes it
 * (`rateLimitKey`, under `derivedKey("support-rate-limit")` from src/lib/crypto/credentials.ts),
 * both server-only modules this spec cannot import. If either changes, the seeded count lands on
 * another key and the rate limit test fails on the missing refusal, never silently.
 */
function sendLimitUserKey(userId: string): string {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const encryptionKey = Buffer.from(z.string().min(1).parse(process.env.STACKDASH_ENCRYPTION_KEY).trim(), "base64");
  const derived = Buffer.from(hkdfSync("sha256", encryptionKey, Buffer.alloc(0), "stackdash key v1:support-rate-limit", 32));
  return createHmac("sha256", derived).update(`send:user:${userId.toLowerCase()}`).digest("hex");
}

/**
 * Spends the user's whole send allowance through the counter the app bumps
 * (bump_support_rate_limit), so the next send is refused, without sending the messages. The
 * client address side gets a key nobody uses, so no other sender is limited. The limit counts the
 * current window and the one before, so a window that starts between this and the send still
 * counts these attempts.
 */
export async function spendSendLimit(userId: string): Promise<void> {
  const userKey = sendLimitUserKey(userId);
  const ipKey = randomBytes(32).toString("hex");
  for (let attempt = 0; attempt < SEND_LIMIT_PER_USER; attempt += 1) {
    const { error } = await adminClient().rpc("bump_support_rate_limit", {
      p_user_key: userKey,
      p_ip_key: ipKey,
      p_window_seconds: SEND_WINDOW_SECONDS,
    });
    if (error) throw new Error(`Counting a support send failed (code ${error.code}).`);
  }
}

/** How many support emails about the thread the database recorded for `recipient`. */
export async function supportDeliveries(threadId: string, recipient: string): Promise<number> {
  const { count, error } = await adminClient()
    .from("support_message_deliveries")
    .select("id", { count: "exact", head: true })
    .eq("thread_id", threadId)
    .eq("recipient", recipient);
  if (error) throw new Error(`Counting support emails failed (code ${error.code}).`);
  return count ?? 0;
}

/** A PNG drawn by the browser, so its bytes are a real image the picker and the bucket accept. */
export async function drawnPng(page: Page): Promise<Buffer> {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 120;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("No 2D canvas context.");
    const gradient = context.createLinearGradient(0, 0, 160, 120);
    gradient.addColorStop(0, "#1d4ed8");
    gradient.addColorStop(1, "#0f766e");
    context.fillStyle = gradient;
    context.fillRect(0, 0, 160, 120);
    context.fillStyle = "#ffffff";
    context.fillRect(20, 70, 24, 30);
    context.fillRect(56, 50, 24, 50);
    context.fillRect(92, 30, 24, 70);
    return canvas.toDataURL("image/png");
  });
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

/** Waits until the image has loaded and has pixels: a signed URL the CSP or Storage refused never does. */
export async function expectImageLoaded(image: Locator): Promise<void> {
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => (element.complete ? element.naturalWidth : 0)), {
      message: "The image never loaded",
    })
    .toBeGreaterThan(0);
}
