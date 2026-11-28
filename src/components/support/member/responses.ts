import { z } from "zod";

import { Constants } from "@/lib/supabase/database.types";
import { ATTACHMENT_MIME_TYPES } from "@/lib/support/attachments";
import type { MemberThreadSummary, SupportConversation, SupportThreadView, ThreadPage } from "@/lib/support/views";

/*
 * The member's side of support chat (#680) reading its own route handlers from the browser:
 * GET /api/support/threads (the list and the badge count) and GET /api/support/threads/<id> (one
 * conversation, or the page before `before`). Each body is parsed before a screen renders it, so a
 * body of another shape shows the screen's load failure instead of breaking it. The schemas are
 * annotated with the view types the routes return, so they cannot drift apart.
 */

const enums = Constants.public.Enums;

const threadFields = {
  id: z.string(),
  subject: z.string(),
  status: z.enum(enums.support_thread_status),
  createdAt: z.string(),
  lastMessageAt: z.string(),
  unread: z.boolean(),
};

const summarySchema: z.ZodType<MemberThreadSummary> = z.object({
  ...threadFields,
  lastMessage: z.object({ sender: z.enum(enums.support_sender), preview: z.string() }).nullable(),
});

const pageSchema = z.object({
  threads: z.array(summarySchema),
  nextCursor: z.string().nullable(),
  unreadCount: z.number().nullable(),
});

export type MemberThreadPage = ThreadPage<MemberThreadSummary> & Readonly<{ unreadCount: number | null }>;

const conversationSchema: z.ZodType<SupportConversation<SupportThreadView>> = z.object({
  thread: z.object(threadFields),
  messages: z.array(
    z.object({
      id: z.string(),
      sender: z.enum(enums.support_sender),
      body: z.string(),
      createdAt: z.string(),
      attachments: z.array(
        z.object({
          id: z.string(),
          filename: z.string(),
          mime: z.enum(ATTACHMENT_MIME_TYPES),
          bytes: z.number(),
          url: z.string().nullable(),
        }),
      ),
    }),
  ),
  olderCursor: z.string().nullable(),
  seenThrough: z.string().nullable(),
});

const conversationResponseSchema = z.object({ conversation: conversationSchema });

/** Why a read failed: the conversation is gone or not the user's, or anything else (the connection, the server). */
export type ReadFailure = "not_found" | "failed";

export type Read<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; failure: ReadFailure }>;

/** Never rejects: a failed or cancelled read is a failure. Check `signal.aborted` before using the result. */
async function readJson<T>(url: string, signal: AbortSignal, parse: (body: unknown) => T | null): Promise<Read<T>> {
  let response: Response;
  try {
    response = await fetch(url, { signal, cache: "no-store", headers: { Accept: "application/json" } });
  } catch {
    // A cancelled read lands here too; its caller checks `signal.aborted` and drops the result.
    return { ok: false, failure: "failed" };
  }
  if (response.status === 404) return { ok: false, failure: "not_found" };
  if (!response.ok) return { ok: false, failure: "failed" };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, failure: "failed" };
  }
  const value = parse(body);
  return value === null ? { ok: false, failure: "failed" } : { ok: true, value };
}

/** One page of the user's conversations, `cursor` from the previous page's `nextCursor`, with their unread count. */
export function fetchThreadPage(cursor: string | null, signal: AbortSignal): Promise<Read<MemberThreadPage>> {
  const query = cursor === null ? "" : `?${new URLSearchParams({ cursor }).toString()}`;
  return readJson(`/api/support/threads${query}`, signal, (body) => {
    const parsed = pageSchema.safeParse(body);
    return parsed.success ? parsed.data : null;
  });
}

/** One of the user's conversations: its newest page, or the page before `before` (an `olderCursor`). */
export function fetchConversation(
  threadId: string,
  before: string | null,
  signal: AbortSignal,
): Promise<Read<SupportConversation<SupportThreadView>>> {
  const query = before === null ? "" : `?${new URLSearchParams({ before }).toString()}`;
  return readJson(`/api/support/threads/${encodeURIComponent(threadId)}${query}`, signal, (body) => {
    const parsed = conversationResponseSchema.safeParse(body);
    return parsed.success ? parsed.data.conversation : null;
  });
}
