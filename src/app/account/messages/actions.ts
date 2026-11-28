"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { requireUser } from "@/lib/auth/session";
import { discardAttachment as discardStagedAttachment } from "@/lib/support/attachment-store";
import { supportFromPage } from "@/lib/support/from-page";
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
  unexpectedFailure,
} from "@/lib/support/outcomes";
import { SUPPORT_MESSAGES_PATH } from "@/lib/support/paths";
import { normalizeBody } from "@/lib/support/text";
import { markMemberThreadRead, sendMemberMessage, startMemberThread } from "@/lib/support/threads";
import type { ClaimAttachmentResult, DiscardAttachmentResult, MarkThreadReadResult, SendMessageResult } from "@/lib/support/views";

/*
 * Support chat, the user's side (#680). Every action authorizes through requireUser: signed out,
 * it redirects to sign-in like every app page, and nothing is written. The user is the verified
 * session's, never a form field; a thread id from the form is only ever matched against that user's
 * own threads, and a thread that is missing and one that is someone else's get the same answer.
 * Each form is parsed field by field with a strict schema, so an unknown field cannot reach a write.
 * The draft stays in the composer on every failure. Nothing here revalidates: a screen reads the
 * conversation again itself (router.refresh() or the route handlers), as it does on a Realtime hint.
 */

const startSchema = z
  .object({ body: rawBodySchema, fromPage: z.string().max(2048).nullable(), attachmentIds: attachmentIdsSchema })
  .strict();

/** Starts a conversation: `body`, `fromPage` (the path the user is on), and `attachmentId` repeated. */
export async function startThread(_previous: SendMessageResult | null, formData: FormData): Promise<SendMessageResult> {
  const parsed = startSchema.safeParse({
    body: formData.get("body"),
    fromPage: formData.get("fromPage"),
    attachmentIds: formData.getAll("attachmentId"),
  });
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };
  const body = normalizeBody(parsed.data.body);
  if (!body.ok) return bodyFailure(body.reason);

  try {
    const user = await requireUser(SUPPORT_MESSAGES_PATH);
    const outcome = await startMemberThread({
      userId: user.id,
      headers: await headers(),
      body: body.body,
      fromPage: supportFromPage(parsed.data.fromPage),
      attachmentIds: parsed.data.attachmentIds,
    });
    return outcome.ok ? outcome : sendFailure(outcome);
  } catch (error) {
    return unexpectedFailure(error, "support.start_failed", "Your message was not sent. Try again in a moment.");
  }
}

const sendSchema = z.object({ threadId: supportIdSchema, body: rawBodySchema, attachmentIds: attachmentIdsSchema }).strict();

/** Sends a message in one of the user's own conversations: `threadId`, `body`, and `attachmentId` repeated. */
export async function sendMessage(_previous: SendMessageResult | null, formData: FormData): Promise<SendMessageResult> {
  const parsed = sendSchema.safeParse({
    threadId: formData.get("threadId"),
    body: formData.get("body"),
    attachmentIds: formData.getAll("attachmentId"),
  });
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };
  const body = normalizeBody(parsed.data.body);
  if (!body.ok) return bodyFailure(body.reason);

  try {
    const user = await requireUser(SUPPORT_MESSAGES_PATH);
    const outcome = await sendMemberMessage({
      userId: user.id,
      headers: await headers(),
      threadId: parsed.data.threadId,
      body: body.body,
      attachmentIds: parsed.data.attachmentIds,
    });
    return outcome.ok ? outcome : sendFailure(outcome);
  } catch (error) {
    return unexpectedFailure(error, "support.send_failed", "Your message was not sent. Try again in a moment.");
  }
}

const markReadSchema = z.object({ threadId: supportIdSchema, seenThrough: seenThroughSchema }).strict();

/**
 * Marks one of the user's conversations read through `seenThrough` (the conversation's
 * `seenThrough`), and answers their fresh unread count for the badges.
 */
export async function markThreadRead(_previous: MarkThreadReadResult | null, formData: FormData): Promise<MarkThreadReadResult> {
  const parsed = markReadSchema.safeParse({ threadId: formData.get("threadId"), seenThrough: formData.get("seenThrough") });
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };
  try {
    const user = await requireUser(SUPPORT_MESSAGES_PATH);
    const unreadCount = await markMemberThreadRead(user.id, parsed.data.threadId, parsed.data.seenThrough);
    return { ok: true, unreadCount };
  } catch (error) {
    return unexpectedFailure(error, "support.mark_read_failed", "This conversation could not be marked as read. It stays marked as new.");
  }
}

/**
 * Claims an image before the browser uploads it, into one of the user's own conversations or, with
 * `threadId` empty, for the conversation they are starting. Answers where to upload it.
 */
export async function claimAttachment(_previous: ClaimAttachmentResult | null, formData: FormData): Promise<ClaimAttachmentResult> {
  const fields = parseClaimForm(formData);
  if (fields === null) return { ok: false, message: OUT_OF_DATE };
  try {
    const user = await requireUser(SUPPORT_MESSAGES_PATH);
    return await claimUpload({ ...fields, uploaderId: user.id, headers: await headers() });
  } catch (error) {
    return unexpectedFailure(error, "support.claim_failed", "The image was not attached. Try attaching it again.");
  }
}

const discardSchema = z.object({ attachmentId: supportIdSchema }).strict();

/** Removes one of the user's own unsent images (`attachmentId`) and its bytes. Removing one already gone succeeds. */
export async function discardAttachment(_previous: DiscardAttachmentResult | null, formData: FormData): Promise<DiscardAttachmentResult> {
  const parsed = discardSchema.safeParse({ attachmentId: formData.get("attachmentId") });
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };
  try {
    const user = await requireUser(SUPPORT_MESSAGES_PATH);
    await discardStagedAttachment(user.id, parsed.data.attachmentId);
    return { ok: true };
  } catch (error) {
    return unexpectedFailure(error, "support.discard_failed", "The image was not removed. Try removing it again.");
  }
}
