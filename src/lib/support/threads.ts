import "server-only";

import { after } from "next/server";
import { cache } from "react";
import { z } from "zod";

import { decodeCursor, encodeCursor } from "@/lib/data/cursor";
import { getWorkspaceMembership } from "@/lib/data/workspaces";
import { log, logError } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { Constants } from "@/lib/supabase/database.types";
import { isWorkspaceSlug } from "@/lib/workspaces/paths";

import { attachmentRow, checkStagedAttachments, signAttachments } from "./attachment-store";
import { MESSAGE_PAGE_SIZE, THREAD_PAGE_SIZE } from "./limits";
import { notifyMember, notifyOperators } from "./notify";
import { checkSupportRateLimit } from "./rate-limit";
import { supportSubject } from "./text";
import { instantMicros, isUnread } from "./unread";
import type {
  MemberThreadSummary,
  OperatorListView,
  OperatorThreadSummary,
  OperatorThreadView,
  SupportConversation,
  SupportMessageView,
  SupportThreadStatus,
  SupportThreadView,
  ThreadPage,
} from "./views";

/*
 * Support chat's data-access layer (#680): every read and write of a conversation, for the user who
 * owns it and for operators. Callers authorize first (requireUser, or requireSuperAdmin for the
 * operator functions) and pass the verified user's id; nothing here takes an id from a browser
 * without that. Everything goes through the service role and the functions of
 * 20261128120300_support_chat_functions.sql, which take the actor as an argument and re-check it:
 * a user only ever writes into their own thread, and an operator id must be a super admin's.
 *
 * A missing thread and someone else's thread give the same answer (null, or `not_found`), so ids
 * cannot be probed. Writes count against the rate limit first, so probing ids costs attempts.
 */

const statusSchema = z.enum(Constants.public.Enums.support_thread_status);
const senderSchema = z.enum(Constants.public.Enums.support_sender);
const roleSchema = z.enum(Constants.public.Enums.workspace_role);
// Fixture ids skip the RFC version bits, so `guid` rather than `uuid` (as src/lib/data/cursor.ts).
const idSchema = z.guid();

// ── List cursors ────────────────────────────────────────────────────────────────
// A list is ordered unread first, then by last activity and id, so its cursor is the last row's
// unread flag, last_message_at exactly as the database returned it (microseconds survive), and id.

const listCursorSchema = z.tuple([
  z.boolean(),
  z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/),
  idSchema,
]);
type ListCursor = z.infer<typeof listCursorSchema>;
const MAX_CURSOR_LENGTH = 200;

function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

/**
 * The list function's arguments for the page after `raw`: none for a missing or malformed cursor,
 * which then means the first page.
 */
function listCursorArgs(raw: string | null) {
  if (raw === null || raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return {};
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return {};
    throw error;
  }
  const parsed = listCursorSchema.safeParse(decoded);
  if (!parsed.success) return {};
  const [unread, lastMessageAt, id] = parsed.data;
  return { p_after_unread: unread, p_after_last_message_at: lastMessageAt, p_after_id: id };
}

type ListRow = Readonly<{
  id: string;
  subject: string;
  status: SupportThreadStatus;
  created_at: string;
  last_message_at: string;
  read_at: string | null;
  last_sender: z.infer<typeof senderSchema> | null;
  last_preview: string | null;
}>;

/** A page of list rows as summaries, each extended by `extra`, and the cursor of the next page. */
function pageOf<Row extends ListRow, Extra extends object>(rows: readonly Row[], extra: (row: Row) => Extra): ThreadPage<MemberThreadSummary & Extra> {
  const page = rows.slice(0, THREAD_PAGE_SIZE);
  const last = page.at(-1);
  return {
    threads: page.map((row) => ({
      id: row.id,
      subject: row.subject,
      status: row.status,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
      unread: isUnread(row.last_message_at, row.read_at),
      lastMessage: row.last_sender === null || row.last_preview === null ? null : { sender: row.last_sender, preview: row.last_preview },
      ...extra(row),
    })),
    nextCursor:
      rows.length > THREAD_PAGE_SIZE && last !== undefined
        ? encodeListCursor([isUnread(last.last_message_at, last.read_at), last.last_message_at, last.id])
        : null,
  };
}

// ── The user's side ─────────────────────────────────────────────────────────────

const memberThreadRow = z.object({
  id: idSchema,
  subject: z.string(),
  status: statusSchema,
  created_at: z.string(),
  last_message_at: z.string(),
  read_at: z.string().nullable(),
  last_sender: senderSchema.nullable(),
  last_preview: z.string().nullable(),
});

/** One page of the user's own threads, unread first, then newest activity. */
export async function listMemberThreads(userId: string, rawCursor: string | null): Promise<ThreadPage<MemberThreadSummary>> {
  const { data, error } = await createAdminClient().rpc("support_member_threads", {
    p_user_id: userId,
    p_limit: THREAD_PAGE_SIZE + 1,
    ...listCursorArgs(rawCursor),
  });
  if (error) throw new Error("Loading support threads failed", { cause: error });
  return pageOf(z.array(memberThreadRow).parse(data), () => ({}));
}

/**
 * Threads with unread replies for the user's badge, up to UNREAD_COUNT_CAP. Null when the count
 * cannot be read, so a badge keeps what it showed rather than claiming zero. Cached per request.
 */
export const memberUnreadCount = cache(async (userId: string): Promise<number | null> => {
  const { data, error } = await createAdminClient().rpc("support_member_unread_count", { p_user_id: userId });
  if (error) {
    logError("support.unread_count_failed", error, { side: "member" });
    return null;
  }
  return data;
});

// ── The operators' side ─────────────────────────────────────────────────────────

const operatorThreadRow = z.object({
  id: idSchema,
  user_id: idSchema,
  member_email: z.string().nullable(),
  member_name: z.string().nullable(),
  member_avatar_url: z.string().nullable(),
  subject: z.string(),
  status: statusSchema,
  from_page: z.string().nullable(),
  workspace_name: z.string().nullable(),
  member_role: roleSchema.nullable(),
  created_at: z.string(),
  last_message_at: z.string(),
  read_at: z.string().nullable(),
  last_sender: senderSchema.nullable(),
  last_preview: z.string().nullable(),
});

/**
 * One page of the operators' list, against the calling operator's own read markers: `active` (open
 * and replied threads) or `closed`, unread first, then newest activity.
 */
export async function listOperatorThreads(
  operatorId: string,
  view: OperatorListView,
  rawCursor: string | null,
): Promise<ThreadPage<OperatorThreadSummary>> {
  const { data, error } = await createAdminClient().rpc("support_operator_threads", {
    p_operator_id: operatorId,
    p_closed: view === "closed",
    p_limit: THREAD_PAGE_SIZE + 1,
    ...listCursorArgs(rawCursor),
  });
  if (error) throw new Error("Loading the support inbox failed", { cause: error });
  return pageOf(z.array(operatorThreadRow).parse(data), (row) => ({
    member: { userId: row.user_id, email: row.member_email, name: row.member_name, avatarUrl: row.member_avatar_url },
    context: { fromPage: row.from_page, workspaceName: row.workspace_name, memberRole: row.member_role },
  }));
}

/** Active threads with unread activity for this operator's badge, up to UNREAD_COUNT_CAP; null when unknown. */
export const operatorUnreadCount = cache(async (operatorId: string): Promise<number | null> => {
  const { data, error } = await createAdminClient().rpc("support_operator_unread_count", { p_operator_id: operatorId });
  if (error) {
    logError("support.unread_count_failed", error, { side: "operator" });
    return null;
  }
  return data;
});

// ── Conversations ───────────────────────────────────────────────────────────────

const detailRow = z.object({
  id: idSchema,
  user_id: idSchema,
  member_email: z.string().nullable(),
  member_name: z.string().nullable(),
  member_avatar_url: z.string().nullable(),
  subject: z.string(),
  status: statusSchema,
  from_page: z.string().nullable(),
  workspace_name: z.string().nullable(),
  member_role: roleSchema.nullable(),
  created_at: z.string(),
  last_message_at: z.string(),
  user_last_read_at: z.string().nullable(),
  operator_read_at: z.string().nullable(),
});

type ThreadDetail = z.infer<typeof detailRow>;

const messageRow = z.object({
  id: idSchema,
  sender: senderSchema,
  body: z.string(),
  created_at: z.string(),
  attachments: z.array(attachmentRow),
});

type MessageRow = z.infer<typeof messageRow>;

async function loadDetail(threadId: string, readerId: string): Promise<ThreadDetail | null> {
  const { data, error } = await createAdminClient().rpc("support_thread_detail", { p_thread_id: threadId, p_reader_id: readerId });
  if (error) throw new Error("Loading a support thread failed", { cause: error });
  return z.array(detailRow).parse(data)[0] ?? null;
}

/** A page of messages, newest first as the database returns it, one more than a page to tell if older ones exist. */
async function loadMessageRows(threadId: string, rawBefore: string | null): Promise<MessageRow[]> {
  const before = decodeCursor(rawBefore);
  const { data, error } = await createAdminClient().rpc("support_thread_messages", {
    p_thread_id: threadId,
    p_limit: MESSAGE_PAGE_SIZE + 1,
    ...(before === null ? {} : { p_before_created_at: before[0], p_before_id: before[1] }),
  });
  if (error) throw new Error("Loading support messages failed", { cause: error });
  return z.array(messageRow).parse(data);
}

/** Oldest first, with signed image URLs, and the cursor of the page before. */
async function messagePage(rows: readonly MessageRow[]): Promise<Readonly<{ messages: SupportMessageView[]; olderCursor: string | null }>> {
  const page = rows.slice(0, MESSAGE_PAGE_SIZE);
  const signed = await signAttachments(page.flatMap((row) => row.attachments));
  const messages = page
    .map((row) => ({
      id: row.id,
      sender: row.sender,
      body: row.body,
      createdAt: row.created_at,
      attachments: row.attachments.flatMap((attachment) => signed.get(attachment.id) ?? []),
    }))
    .reverse();
  const oldest = page.at(-1);
  return { messages, olderCursor: rows.length > MESSAGE_PAGE_SIZE && oldest !== undefined ? encodeCursor([oldest.created_at, oldest.id]) : null };
}

/**
 * What a reader of the newest page saw: the thread's last activity, or the newest message on the
 * page when one landed after the thread row was read. Null for an older page, which shows nothing new.
 */
function seenThrough(detail: ThreadDetail, rows: readonly MessageRow[], rawBefore: string | null): string | null {
  if (decodeCursor(rawBefore) !== null) return null;
  const newest = rows[0]?.created_at;
  return newest !== undefined && instantMicros(newest) > instantMicros(detail.last_message_at) ? newest : detail.last_message_at;
}

function threadView(detail: ThreadDetail, readAt: string | null): SupportThreadView {
  return {
    id: detail.id,
    subject: detail.subject,
    status: detail.status,
    createdAt: detail.created_at,
    lastMessageAt: detail.last_message_at,
    unread: isUnread(detail.last_message_at, readAt),
  };
}

/**
 * One of the user's own conversations: its newest page of messages, or the page before `rawBefore`
 * (a message cursor from `olderCursor`). Null when the thread does not exist or is not theirs.
 */
export async function loadMemberConversation(
  userId: string,
  threadId: string,
  rawBefore: string | null,
): Promise<SupportConversation<SupportThreadView> | null> {
  const [detail, rows] = await Promise.all([loadDetail(threadId, userId), loadMessageRows(threadId, rawBefore)]);
  if (detail === null || detail.user_id !== userId) return null;
  const { messages, olderCursor } = await messagePage(rows);
  return { thread: threadView(detail, detail.user_last_read_at), messages, olderCursor, seenThrough: seenThrough(detail, rows, rawBefore) };
}

/** Any conversation, for an operator, with who wrote it and from where. Null when it does not exist. */
export async function loadOperatorConversation(
  operatorId: string,
  threadId: string,
  rawBefore: string | null,
): Promise<SupportConversation<OperatorThreadView> | null> {
  const [detail, rows] = await Promise.all([loadDetail(threadId, operatorId), loadMessageRows(threadId, rawBefore)]);
  if (detail === null) return null;
  const { messages, olderCursor } = await messagePage(rows);
  return {
    thread: {
      ...threadView(detail, detail.operator_read_at),
      member: { userId: detail.user_id, email: detail.member_email, name: detail.member_name, avatarUrl: detail.member_avatar_url },
      context: { fromPage: detail.from_page, workspaceName: detail.workspace_name, memberRole: detail.member_role },
    },
    messages,
    olderCursor,
    seenThrough: seenThrough(detail, rows, rawBefore),
  };
}

// ── Writes ──────────────────────────────────────────────────────────────────────

export type SendOutcome =
  | Readonly<{ ok: true; threadId: string; messageId: string }>
  | Readonly<{ ok: false; reason: "rate_limited"; retryAt: Date }>
  | Readonly<{ ok: false; reason: "not_found" }>
  | Readonly<{ ok: false; reason: "attachments"; refusal: "upload" | "unreadable" }>;

// bind_support_attachments raises no_data_found when an attachment changed between the check and
// the send (sent from another tab, discarded, swept): the send is refused, nothing is written.
const ATTACHMENTS_UNBINDABLE = "P0002";

type Context = Readonly<{ workspaceId: string; workspaceName: string; role: z.infer<typeof roleSchema> }>;

/**
 * The workspace the user wrote from and their role in it, when `fromPage` is a page of a workspace
 * they belong to, read with their own session. Fail soft: context helps whoever answers, and a
 * lookup that fails must never be why a message cannot be sent.
 */
async function captureContext(userId: string, fromPage: string | null): Promise<Context | null> {
  const slug = /^\/w\/([^/]+)/.exec(fromPage ?? "")?.[1];
  if (slug === undefined || !isWorkspaceSlug(slug)) return null;
  try {
    const membership = await getWorkspaceMembership(userId, slug);
    return membership === null ? null : { workspaceId: membership.workspace.id, workspaceName: membership.workspace.name, role: membership.role };
  } catch (error) {
    log.warn("support.context_unavailable", { reason: error instanceof Error ? error.message : "unknown" });
    return null;
  }
}

type Sender = Readonly<{ userId: string; headers: Headers }>;

/**
 * Starts a conversation with its first message. `body` is already normalized (normalizeBody) and
 * `fromPage` validated (supportFromPage). Operators are told after the response.
 */
export async function startMemberThread(
  input: Sender & Readonly<{ body: string; fromPage: string | null; attachmentIds: readonly string[] }>,
): Promise<SendOutcome> {
  const [limit, context] = await Promise.all([
    checkSupportRateLimit("send", input.userId, input.headers),
    captureContext(input.userId, input.fromPage),
  ]);
  if (!limit.allowed) return { ok: false, reason: "rate_limited", retryAt: limit.retryAt };
  const check = await checkStagedAttachments(input.userId, null, input.attachmentIds);
  if (!check.ok) return { ok: false, reason: "attachments", refusal: check.refusal };

  const { data, error } = await createAdminClient()
    .rpc("support_start_thread", {
      p_user_id: input.userId,
      p_subject: supportSubject(input.body),
      p_body: input.body,
      p_attachment_ids: [...input.attachmentIds],
      ...(input.fromPage === null ? {} : { p_from_page: input.fromPage }),
      ...(context === null
        ? {}
        : { p_workspace_id: context.workspaceId, p_workspace_name: context.workspaceName, p_member_role: context.role }),
    })
    .single();
  if (error?.code === ATTACHMENTS_UNBINDABLE) return { ok: false, reason: "attachments", refusal: "upload" };
  if (error) throw new Error("Starting a support thread failed", { cause: error });
  const threadId = idSchema.parse(data.thread_id);
  const messageId = idSchema.parse(data.message_id);
  after(() => notifyOperators({ threadId, messageId, body: input.body, attachmentCount: input.attachmentIds.length }));
  return { ok: true, threadId, messageId };
}

/** The user's message in one of their own threads; `not_found` for a thread that is not theirs. */
export async function sendMemberMessage(
  input: Sender & Readonly<{ threadId: string; body: string; attachmentIds: readonly string[] }>,
): Promise<SendOutcome> {
  const limit = await checkSupportRateLimit("send", input.userId, input.headers);
  if (!limit.allowed) return { ok: false, reason: "rate_limited", retryAt: limit.retryAt };
  const check = await checkStagedAttachments(input.userId, input.threadId, input.attachmentIds);
  if (!check.ok) return { ok: false, reason: "attachments", refusal: check.refusal };

  const { data, error } = await createAdminClient().rpc("support_send_member_message", {
    p_thread_id: input.threadId,
    p_user_id: input.userId,
    p_body: input.body,
    p_attachment_ids: [...input.attachmentIds],
  });
  if (error?.code === ATTACHMENTS_UNBINDABLE) return { ok: false, reason: "attachments", refusal: "upload" };
  if (error) throw new Error("Sending a support message failed", { cause: error });
  const row = data[0];
  if (row === undefined) return { ok: false, reason: "not_found" };
  const messageId = idSchema.parse(row.message_id);
  after(() => notifyOperators({ threadId: input.threadId, messageId, body: input.body, attachmentCount: input.attachmentIds.length }));
  return { ok: true, threadId: input.threadId, messageId };
}

/** An operator's reply; `not_found` for a thread that does not exist. The user is told after the response. */
export async function replyAsOperator(
  input: Sender & Readonly<{ threadId: string; body: string; attachmentIds: readonly string[] }>,
): Promise<SendOutcome> {
  const limit = await checkSupportRateLimit("send", input.userId, input.headers);
  if (!limit.allowed) return { ok: false, reason: "rate_limited", retryAt: limit.retryAt };
  const check = await checkStagedAttachments(input.userId, input.threadId, input.attachmentIds);
  if (!check.ok) return { ok: false, reason: "attachments", refusal: check.refusal };

  const { data, error } = await createAdminClient().rpc("support_operator_reply", {
    p_thread_id: input.threadId,
    p_operator_id: input.userId,
    p_body: input.body,
    p_attachment_ids: [...input.attachmentIds],
  });
  if (error?.code === ATTACHMENTS_UNBINDABLE) return { ok: false, reason: "attachments", refusal: "upload" };
  if (error) throw new Error("Sending a support reply failed", { cause: error });
  const row = data[0];
  if (row === undefined) return { ok: false, reason: "not_found" };
  const messageId = idSchema.parse(row.message_id);
  const memberId = idSchema.parse(row.member_id);
  after(() => notifyMember({ threadId: input.threadId, messageId, memberId, body: input.body, attachmentCount: input.attachmentIds.length }));
  return { ok: true, threadId: input.threadId, messageId };
}

/**
 * Moves the user's read marker to what they saw. Returns their fresh unread count (null when it
 * cannot be read); a thread that is not theirs changes nothing and answers the same way.
 */
export async function markMemberThreadRead(userId: string, threadId: string, seenThroughAt: string): Promise<number | null> {
  const { error } = await createAdminClient().rpc("support_mark_read_by_member", {
    p_thread_id: threadId,
    p_user_id: userId,
    p_seen_through: seenThroughAt,
  });
  if (error) throw new Error("Marking a support thread read failed", { cause: error });
  return memberUnreadCount(userId);
}

/** Moves this operator's own read marker; other operators' markers are untouched. */
export async function markOperatorThreadRead(operatorId: string, threadId: string, seenThroughAt: string): Promise<number | null> {
  const { error } = await createAdminClient().rpc("support_mark_read_by_operator", {
    p_thread_id: threadId,
    p_operator_id: operatorId,
    p_seen_through: seenThroughAt,
  });
  if (error) throw new Error("Marking a support thread read failed", { cause: error });
  return operatorUnreadCount(operatorId);
}

export type StatusOutcome = Readonly<{ ok: true; status: SupportThreadStatus }> | Readonly<{ ok: false; reason: "not_found" | "newer_message" }>;

const statusOutcomeSchema = z.enum(["updated", "unchanged", "newer_message"]).nullable();

/**
 * Opens or closes a thread. A close is refused (`newer_message`) when the user wrote after what the
 * operator saw (`seenThroughAt`), so a question nobody read is never closed away.
 */
export async function setThreadStatusAsOperator(
  operatorId: string,
  threadId: string,
  status: Extract<SupportThreadStatus, "open" | "closed">,
  seenThroughAt: string,
): Promise<StatusOutcome> {
  const { data, error } = await createAdminClient().rpc("support_set_thread_status", {
    p_thread_id: threadId,
    p_operator_id: operatorId,
    p_status: status,
    p_seen_through: seenThroughAt,
  });
  if (error) throw new Error("Changing a support thread's status failed", { cause: error });
  const outcome = statusOutcomeSchema.parse(data);
  if (outcome === null) return { ok: false, reason: "not_found" };
  if (outcome === "newer_message") return { ok: false, reason: "newer_message" };
  return { ok: true, status };
}
