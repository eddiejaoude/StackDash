"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { requireSuperAdmin } from "@/lib/auth/super-admin";
import { discardAttachment as discardStagedAttachment } from "@/lib/support/attachment-store";
import {
  attachmentIdsSchema,
  bodyFailure,
  claimUpload,
  OUT_OF_DATE,
  parseClaimForm,
  rawBodySchema,
  seenThroughSchema,
  sendFailure,
  supportIdSchema,
  THREAD_GONE,
  unexpectedFailure,
} from "@/lib/support/outcomes";
import { SUPPORT_INBOX_PATH } from "@/lib/support/paths";
import { normalizeBody } from "@/lib/support/text";
import { markOperatorThreadRead, replyAsOperator, setThreadStatusAsOperator } from "@/lib/support/threads";
import type {
  ClaimAttachmentResult,
  DiscardAttachmentResult,
  MarkThreadReadResult,
  SendMessageResult,
  SetThreadStatusResult,
} from "@/lib/support/views";

/*
 * Support chat, the operators' side (#680). Every action authorizes through requireSuperAdmin
 * (STACKDASH_SUPER_ADMIN_EMAILS, which also syncs the caller's mirror row): signed out it redirects
 * to sign-in, and anyone else gets the same not found as any missing page. The write functions
 * check the operator id against the mirror again. Fields are parsed one by one with strict schemas;
 * the draft stays in the composer on every failure. Nothing here revalidates.
 */

const replySchema = z.object({ threadId: supportIdSchema, body: rawBodySchema, attachmentIds: attachmentIdsSchema }).strict();

/** Replies in any conversation: `threadId`, `body`, and `attachmentId` repeated. The user is emailed when not online. */
export async function replyToThread(_previous: SendMessageResult | null, formData: FormData): Promise<SendMessageResult> {
  const parsed = replySchema.safeParse({
    threadId: formData.get("threadId"),
    body: formData.get("body"),
    attachmentIds: formData.getAll("attachmentId"),
  });
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };
  const body = normalizeBody(parsed.data.body);
  if (!body.ok) return bodyFailure(body.reason);

  try {
    const operator = await requireSuperAdmin(SUPPORT_INBOX_PATH);
    const outcome = await replyAsOperator({
      userId: operator.id,
      headers: await headers(),
      threadId: parsed.data.threadId,
      body: body.body,
      attachmentIds: parsed.data.attachmentIds,
    });
    return outcome.ok ? outcome : sendFailure(outcome);
  } catch (error) {
    return unexpectedFailure(error, "support.reply_failed", "Your reply was not sent. Try again in a moment.");
  }
}

const markReadSchema = z.object({ threadId: supportIdSchema, seenThrough: seenThroughSchema }).strict();

/** Marks a conversation read for the calling operator only, through `seenThrough`; answers their unread count. */
export async function markThreadRead(_previous: MarkThreadReadResult | null, formData: FormData): Promise<MarkThreadReadResult> {
  const parsed = markReadSchema.safeParse({ threadId: formData.get("threadId"), seenThrough: formData.get("seenThrough") });
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };
  try {
    const operator = await requireSuperAdmin(SUPPORT_INBOX_PATH);
    const unreadCount = await markOperatorThreadRead(operator.id, parsed.data.threadId, parsed.data.seenThrough);
    return { ok: true, unreadCount };
  } catch (error) {
    return unexpectedFailure(error, "support.mark_read_failed", "This conversation could not be marked as read. It stays marked as new.");
  }
}

const statusSchema = z.object({ threadId: supportIdSchema, status: z.enum(["open", "closed"]), seenThrough: seenThroughSchema }).strict();

/**
 * Opens or closes a conversation: `threadId`, `status` (`open` or `closed`), and `seenThrough`. A
 * close is refused when the user wrote after what the operator saw.
 */
export async function setThreadStatus(_previous: SetThreadStatusResult | null, formData: FormData): Promise<SetThreadStatusResult> {
  const parsed = statusSchema.safeParse({
    threadId: formData.get("threadId"),
    status: formData.get("status"),
    seenThrough: formData.get("seenThrough"),
  });
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };
  try {
    const operator = await requireSuperAdmin(SUPPORT_INBOX_PATH);
    const outcome = await setThreadStatusAsOperator(operator.id, parsed.data.threadId, parsed.data.status, parsed.data.seenThrough);
    if (outcome.ok) return outcome;
    return {
      ok: false,
      message:
        outcome.reason === "not_found"
          ? THREAD_GONE
          : "The user wrote again after you opened this conversation, so it was not closed. Read the new message, then close it.",
    };
  } catch (error) {
    return unexpectedFailure(error, "support.status_failed", "The conversation was not changed. Try again in a moment.");
  }
}

/** Claims an image for a reply in `threadId` (required here: operators never start conversations). */
export async function claimAttachment(_previous: ClaimAttachmentResult | null, formData: FormData): Promise<ClaimAttachmentResult> {
  const fields = parseClaimForm(formData);
  if (fields === null || fields.threadId === null) return { ok: false, message: OUT_OF_DATE };
  try {
    const operator = await requireSuperAdmin(SUPPORT_INBOX_PATH);
    return await claimUpload({ ...fields, uploaderId: operator.id, headers: await headers() });
  } catch (error) {
    return unexpectedFailure(error, "support.claim_failed", "The image was not attached. Try attaching it again.");
  }
}

const discardSchema = z.object({ attachmentId: supportIdSchema }).strict();

/** Removes one of the operator's own unsent images and its bytes. */
export async function discardAttachment(_previous: DiscardAttachmentResult | null, formData: FormData): Promise<DiscardAttachmentResult> {
  const parsed = discardSchema.safeParse({ attachmentId: formData.get("attachmentId") });
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };
  try {
    const operator = await requireSuperAdmin(SUPPORT_INBOX_PATH);
    await discardStagedAttachment(operator.id, parsed.data.attachmentId);
    return { ok: true };
  } catch (error) {
    return unexpectedFailure(error, "support.discard_failed", "The image was not removed. Try removing it again.");
  }
}
