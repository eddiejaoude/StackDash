import "server-only";

import { z } from "zod";

import { emailTransportFromEnv, type EmailTransport } from "@/lib/email/send";
import { superAdminEmails } from "@/lib/env";
import { log, logError } from "@/lib/log/logger";
import { escapeHtml } from "@/lib/notifications/email";
import { messageOrigin } from "@/lib/notifications/links";
import { site } from "@/lib/site";
import { Constants } from "@/lib/supabase/database.types";
import { createAdminClient } from "@/lib/supabase/admin";
import { roleLabel } from "@/lib/workspaces/permissions";

import { SUPPORT_OPERATORS_TOPIC, supportUserTopic } from "./live";
import { SUPPORT_INBOX_PATH, SUPPORT_MESSAGES_PATH, supportThreadPath } from "./paths";
import { presenceKeys } from "./presence";
import { REFERENCE_LIMIT, buildThreadHeaders, normalizeMessageId, threadSubject } from "./thread-headers";

/*
 * Support chat email (#680), through the existing Resend path (src/lib/email/send.ts): a user's
 * message to every operator who is not online, an operator's reply to the user when they are not.
 * Nothing is sent when email is not set up (no STACKDASH_RESEND_API_KEY); locally the fake Resend
 * API (`npm run email:fake`, STACKDASH_RESEND_API_URL) receives it instead of a real inbox.
 *
 * Online is presence on the Realtime topics (presence.ts): the user's own topic, and the operators'
 * topic keyed by operator id. A probe that fails counts as offline, so the email goes out.
 *
 * Threading is per recipient (thread-headers.ts): each email answers the last one the same address
 * received about the conversation, read from support_message_deliveries, and its own Message-ID is
 * recorded there once Resend reports it. The text is the message itself, escaped into the HTML;
 * images are counted, never attached.
 *
 * Runs after the response (`after` in the server actions), so it never delays or fails a send:
 * every failure is logged and swallowed here, per recipient, so one bad address silences no one else.
 */

const MESSAGE_ID_ATTEMPTS = 3;
const MESSAGE_ID_RETRY_MS = 2000;

const threadRow = z.object({
  user_id: z.guid(),
  member_email: z.string().nullable(),
  member_name: z.string().nullable(),
  subject: z.string(),
  from_page: z.string().nullable(),
  workspace_name: z.string().nullable(),
  member_role: z.enum(Constants.public.Enums.workspace_role).nullable(),
});

type NotifyThread = z.infer<typeof threadRow>;

async function loadThread(threadId: string): Promise<NotifyThread | null> {
  const { data, error } = await createAdminClient().rpc("support_thread_detail", { p_thread_id: threadId, p_reader_id: threadId });
  if (error) throw new Error("Loading a support thread for email failed", { cause: error });
  const [row] = z.array(threadRow).parse(data);
  return row ?? null;
}

export type EmailBody = Readonly<{ subject: string; text: string; html: string }>;

const PARAGRAPH = 'style="margin:0 0 12px"';
const MUTED = 'style="margin:16px 0 0;color:#475467;font-size:12px"';

function messageHtml(body: string): string {
  return body
    .split(/\n{2,}/)
    .map((paragraph) => `<p ${PARAGRAPH}>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("");
}

/** "1 image is attached" or "3 images are attached", or null for none. */
function imagesNote(count: number): string | null {
  if (count < 1) return null;
  return count === 1 ? "1 image is attached. Open the conversation to see it." : `${count} images are attached. Open the conversation to see them.`;
}

function htmlDocument(title: string, inner: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>` +
    `<body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#101828;margin:0;padding:24px">` +
    `<div style="max-width:600px">${inner}</div></body></html>`
  );
}

/** The email an operator gets about a user's message: who wrote, from where, and the message. */
export function operatorEmail(
  input: Readonly<{ thread: NotifyThread; body: string; attachmentCount: number; link: string }>,
): EmailBody {
  const { thread } = input;
  const who = thread.member_name ?? thread.member_email ?? "A user";
  const intro = `${who} wrote in support chat:`;
  const where = [
    thread.member_email === null ? null : `From ${thread.member_email}.`,
    thread.from_page === null ? null : `Sent from ${thread.from_page}.`,
    thread.workspace_name === null
      ? null
      : `Workspace ${thread.workspace_name}${thread.member_role === null ? "" : `, where they are ${roleLabel(thread.member_role).toLowerCase()}`}.`,
  ].filter((line): line is string => line !== null);
  const note = imagesNote(input.attachmentCount);
  const footer = `You get this email as a super admin of this ${site.name} instance who was not online in the inbox. This address does not receive replies, so answer in the inbox.`;
  const subject = `Support chat: ${thread.subject}`;
  const text = [intro, "", input.body, ...(note === null ? [] : ["", note]), "", ...where, "", `Open the conversation: ${input.link}`, "", footer].join("\n");
  const html = htmlDocument(
    subject,
    `<p ${PARAGRAPH}>${escapeHtml(intro)}</p>` +
      messageHtml(input.body) +
      (note === null ? "" : `<p ${MUTED}>${escapeHtml(note)}</p>`) +
      (where.length === 0 ? "" : `<p ${MUTED}>${where.map(escapeHtml).join("<br>")}</p>`) +
      `<p style="margin:16px 0 0"><a href="${escapeHtml(input.link)}" style="color:#1d4ed8">Open the conversation</a></p>` +
      `<p ${MUTED}>${escapeHtml(footer)}</p>`,
  );
  return { subject, text, html };
}

/** The email a user gets about an operator's reply. */
export function memberEmail(
  input: Readonly<{ thread: Pick<NotifyThread, "subject">; body: string; attachmentCount: number; link: string }>,
): EmailBody {
  const intro = `Support replied to your message "${input.thread.subject}":`;
  const note = imagesNote(input.attachmentCount);
  const footer = `You get this email because you wrote to ${site.name} support and were not online when the reply arrived. This address does not receive replies, so reply in ${site.name}.`;
  const subject = `${site.name} support: ${input.thread.subject}`;
  const text = [intro, "", input.body, ...(note === null ? [] : ["", note]), "", `Read and reply: ${input.link}`, "", footer].join("\n");
  const html = htmlDocument(
    subject,
    `<p ${PARAGRAPH}>${escapeHtml(intro)}</p>` +
      messageHtml(input.body) +
      (note === null ? "" : `<p ${MUTED}>${escapeHtml(note)}</p>`) +
      `<p style="margin:16px 0 0"><a href="${escapeHtml(input.link)}" style="color:#1d4ed8">Read and reply</a></p>` +
      `<p ${MUTED}>${escapeHtml(footer)}</p>`,
  );
  return { subject, text, html };
}

const chainRow = z.object({ email_message_id: z.string().nullable() });

/** The Message-IDs of the email `recipient` already received about the thread, oldest first, and their first one. */
async function recipientChain(threadId: string, recipient: string): Promise<Readonly<{ ids: string[]; root: string | null }>> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("support_message_deliveries")
    .select("email_message_id")
    .eq("thread_id", threadId)
    .eq("recipient", recipient)
    .not("email_message_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(REFERENCE_LIMIT);
  if (error) throw new Error("Reading a support email chain failed", { cause: error });
  const ids = z
    .array(chainRow)
    .parse(data)
    .flatMap((row) => (row.email_message_id === null ? [] : [row.email_message_id]))
    .reverse();
  if (ids.length < REFERENCE_LIMIT) return { ids, root: null };
  const first = await supabase
    .from("support_message_deliveries")
    .select("email_message_id")
    .eq("thread_id", threadId)
    .eq("recipient", recipient)
    .not("email_message_id", "is", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (first.error) throw new Error("Reading the first support email of a chain failed", { cause: first.error });
  return { ids, root: first.data?.email_message_id ?? null };
}

/**
 * The Message-ID Resend gave a send, asked up to three times two seconds apart: its retrieve
 * endpoint can lag the send. Null when it never says; the next email then threads on the ids
 * before it and on the subject.
 */
export async function resolveMessageId(transport: EmailTransport, emailId: string, retryMs: number = MESSAGE_ID_RETRY_MS): Promise<string | null> {
  for (let attempt = 1; ; attempt += 1) {
    const lookup = await transport.rfcMessageId(emailId);
    if (lookup.messageId !== null) return normalizeMessageId(lookup.messageId);
    if (!lookup.retryable || attempt >= MESSAGE_ID_ATTEMPTS) {
      log.warn("support.email_message_id_unavailable", { emailId, attempts: attempt, reason: lookup.reason });
      return null;
    }
    const wait = Promise.withResolvers<void>();
    setTimeout(wait.resolve, retryMs);
    await wait.promise;
  }
}

/** Sends one recipient their email, threaded on what they received before, and records it. */
async function deliver(
  transport: EmailTransport,
  input: Readonly<{ threadId: string; messageId: string; to: string; email: EmailBody }>,
): Promise<void> {
  try {
    const chain = await recipientChain(input.threadId, input.to);
    const { headers, isReply } = buildThreadHeaders(chain.ids, chain.root);
    const sent = await transport.send({
      to: input.to,
      subject: threadSubject(input.email.subject, isReply),
      text: input.email.text,
      html: input.email.html,
      headers,
      // A retried delivery of the same message to the same address is dropped by Resend.
      idempotencyKey: `support:${input.messageId}:${input.to}`,
    });
    const supabase = createAdminClient();
    const recorded = await supabase
      .from("support_message_deliveries")
      .insert({ message_id: input.messageId, thread_id: input.threadId, recipient: input.to, email_provider_id: sent.messageId })
      .select("id")
      .single();
    if (recorded.error) throw new Error("Recording a support email failed", { cause: recorded.error });
    const rfcMessageId = await resolveMessageId(transport, sent.messageId);
    if (rfcMessageId === null) return;
    const { error } = await supabase.from("support_message_deliveries").update({ email_message_id: rfcMessageId }).eq("id", recorded.data.id);
    if (error) throw new Error("Recording a support email's Message-ID failed", { cause: error });
  } catch (error) {
    logError("support.email_failed", error, { threadId: input.threadId, messageId: input.messageId });
  }
}

const operatorRow = z.object({ user_id: z.guid(), email: z.string() });

/** The listed addresses of operators online in the inbox now; none when the probe fails. */
async function onlineOperatorEmails(): Promise<ReadonlySet<string>> {
  const online = await presenceKeys(SUPPORT_OPERATORS_TOPIC);
  if (online === null || online.size === 0) return new Set();
  const { data, error } = await createAdminClient().from("super_admins").select("user_id, email").in("user_id", [...online]);
  if (error) throw new Error("Reading the online operators failed", { cause: error });
  return new Set(z.array(operatorRow).parse(data).map((row) => row.email));
}

/** A user wrote: email every listed operator who is not online. */
export async function notifyOperators(input: Readonly<{ threadId: string; messageId: string; body: string; attachmentCount: number }>): Promise<void> {
  try {
    const transport = emailTransportFromEnv();
    if (transport === null) return;
    const listed = superAdminEmails();
    if (listed.size === 0) return;
    const [thread, online] = await Promise.all([loadThread(input.threadId), onlineOperatorEmails()]);
    if (thread === null) return;
    const recipients = [...listed].filter((address) => !online.has(address));
    if (recipients.length === 0) return;
    const email = operatorEmail({
      thread,
      body: input.body,
      attachmentCount: input.attachmentCount,
      link: new URL(supportThreadPath(SUPPORT_INBOX_PATH, input.threadId), messageOrigin()).href,
    });
    await Promise.all(recipients.map((to) => deliver(transport, { threadId: input.threadId, messageId: input.messageId, to, email })));
  } catch (error) {
    logError("support.notify_operators_failed", error, { threadId: input.threadId });
  }
}

/** An operator replied: email the user when they are not online. */
export async function notifyMember(
  input: Readonly<{ threadId: string; messageId: string; memberId: string; body: string; attachmentCount: number }>,
): Promise<void> {
  try {
    const transport = emailTransportFromEnv();
    if (transport === null) return;
    const [thread, online] = await Promise.all([loadThread(input.threadId), presenceKeys(supportUserTopic(input.memberId))]);
    if (thread === null || thread.member_email === null) return;
    if (online !== null && online.size > 0) return;
    const email = memberEmail({
      thread,
      body: input.body,
      attachmentCount: input.attachmentCount,
      link: new URL(supportThreadPath(SUPPORT_MESSAGES_PATH, input.threadId), messageOrigin()).href,
    });
    await deliver(transport, { threadId: input.threadId, messageId: input.messageId, to: thread.member_email.toLowerCase(), email });
  } catch (error) {
    logError("support.notify_member_failed", error, { threadId: input.threadId });
  }
}
