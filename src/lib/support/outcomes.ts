import "server-only";

import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { formatLondonHourMinute } from "@/lib/format";
import { logError } from "@/lib/log/logger";

import { claimAttachment } from "./attachment-store";
import { ATTACHMENT_MIME_TYPES, attachmentRefusalMessage } from "./attachments";
import { ATTACHMENT_BUCKET, ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_BYTES, MESSAGE_MAX_CHARS } from "./limits";
import { checkSupportRateLimit } from "./rate-limit";
import type { BodyCheck } from "./text";
import type { SendOutcome } from "./threads";
import type { ClaimAttachmentResult, SupportFailure } from "./views";

/*
 * What support chat's server actions (#680) parse and answer, shared by the user's actions
 * (src/app/account/messages/actions.ts) and the operators' (src/app/super-admin/inbox/actions.ts),
 * so both sides accept the same fields and read the same words. A refusal is one sentence that says
 * what happened and what to do next. The draft is never cleared on a failure, so the copy can say
 * it is kept.
 */

export const OUT_OF_DATE = "This form is out of date. Reload the page and try again.";
export const THREAD_GONE = "This conversation is no longer available. Reload the page to see your conversations.";

// Ids arrive from forms and fixtures, which skip the RFC version bits, so `guid` (as src/lib/data/cursor.ts).
export const supportIdSchema = z.guid();

/** Up to ATTACHMENTS_PER_MESSAGE distinct attachment ids, as a form posts them (`attachmentId`, repeated). */
export const attachmentIdsSchema = z
  .array(supportIdSchema)
  .max(ATTACHMENTS_PER_MESSAGE)
  .refine((ids) => new Set(ids).size === ids.length);

/** A raw message as posted: bounded before it is normalized, so no request can carry megabytes. */
export const rawBodySchema = z.string().max(MESSAGE_MAX_CHARS * 4);

/** What the reader saw, as the conversation reported it (`seenThrough`), with microseconds kept. */
export const seenThroughSchema = z.iso.datetime({ offset: true });

const claimSchema = z
  .object({
    threadId: supportIdSchema.nullable(),
    filename: z.string().min(1).max(1024),
    mime: z.enum(ATTACHMENT_MIME_TYPES),
    bytes: z.coerce.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  })
  .strict();

export type ClaimFields = z.infer<typeof claimSchema>;

/**
 * A claim form, field by field: `threadId` (empty for a new conversation), `filename`, `mime` (the
 * type its first bytes declare, from checkAttachment), and `bytes`. Null when it does not parse.
 */
export function parseClaimForm(formData: FormData): ClaimFields | null {
  const threadId = formData.get("threadId");
  const parsed = claimSchema.safeParse({
    threadId: threadId === "" ? null : threadId,
    filename: formData.get("filename"),
    mime: formData.get("mime"),
    bytes: formData.get("bytes"),
  });
  return parsed.success ? parsed.data : null;
}

/** The composer's field error for a body that cannot be sent. */
export function bodyFailure(reason: Extract<BodyCheck, { ok: false }>["reason"]): SupportFailure {
  const message =
    reason === "empty"
      ? "Write a message before sending."
      : `Messages can be up to ${MESSAGE_MAX_CHARS.toLocaleString("en-US")} characters. Shorten this one, then send it.`;
  return { ok: false, message, fieldErrors: { body: message } };
}

/** The rate limit's refusal: when sending (or attaching) works again, in minutes and London time. */
function rateLimited(what: "send" | "claim", retryAt: Date, now: Date): SupportFailure {
  const minutes = Math.max(1, Math.ceil((retryAt.getTime() - now.getTime()) / 60_000));
  const wait = `${minutes === 1 ? "about a minute" : `about ${minutes} minutes`}, at ${formatLondonHourMinute(retryAt)} London time`;
  const message =
    what === "send"
      ? `You have sent many messages in a short time, so this one was not sent. You can send again in ${wait}. Your message is still here.`
      : `You have attached many images in a short time, so this one was not attached. You can attach images again in ${wait}.`;
  return { ok: false, message, retryAt: retryAt.toISOString() };
}

/** A send the data layer refused: the rate limit, a thread that is gone, or an attachment. */
export function sendFailure(outcome: Exclude<SendOutcome, { ok: true }>, now: Date = new Date()): SupportFailure {
  switch (outcome.reason) {
    case "rate_limited":
      return rateLimited("send", outcome.retryAt, now);
    case "not_found":
      return { ok: false, message: THREAD_GONE };
    case "attachments":
      return { ok: false, message: attachmentRefusalMessage(outcome.refusal) };
  }
}

/**
 * Claims an image for `uploaderId`, who the caller has authorized for `threadId` (a user's own
 * thread or null, or any thread for an operator): the claim rate limit, the claim, and the answer
 * that tells the browser where to upload it.
 */
export async function claimUpload(input: ClaimFields & Readonly<{ uploaderId: string; headers: Headers }>): Promise<ClaimAttachmentResult> {
  const limit = await checkSupportRateLimit("claim", input.uploaderId, input.headers);
  if (!limit.allowed) return rateLimited("claim", limit.retryAt, new Date());
  const claim = await claimAttachment({
    uploaderId: input.uploaderId,
    threadId: input.threadId,
    filename: input.filename,
    mime: input.mime,
    bytes: input.bytes,
  });
  if (!claim.ok) {
    const message = claim.refusal === "thread" ? THREAD_GONE : attachmentRefusalMessage(claim.refusal, { name: input.filename, size: input.bytes });
    return { ok: false, message };
  }
  return { ok: true, attachmentId: claim.attachmentId, bucket: ATTACHMENT_BUCKET, objectName: claim.objectName };
}

/**
 * Anything thrown after validation: notFound() and redirect() go on to Next.js, everything else is
 * logged under a reference the user can quote.
 */
export function unexpectedFailure(error: unknown, event: string, message: string): SupportFailure {
  unstable_rethrow(error);
  return { ok: false, message, referenceId: logError(event, error) };
}
