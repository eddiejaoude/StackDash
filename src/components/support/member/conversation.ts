import { instantMicros } from "@/lib/support/unread";
import type { SupportConversation, SupportThreadStatus, SupportThreadView } from "@/lib/support/views";

/*
 * Conversation state shared by the member's launcher and messages page (#680): how a fresh read of
 * the newest page joins what is already on screen, how an older page joins it, and the words for a
 * thread's status. Pure, so both screens agree.
 */

export type MemberConversation = SupportConversation<SupportThreadView>;

/**
 * A fresh newest page, keeping the older messages already loaded above it. The older cursor stays
 * the one that reaches past them, so "Load older messages" goes on from where the reader got to.
 */
export function withNewest(current: MemberConversation | null, fresh: MemberConversation): MemberConversation {
  if (current === null || current.thread.id !== fresh.thread.id) return fresh;
  const oldestFresh = fresh.messages[0];
  if (oldestFresh === undefined) return fresh;
  const freshIds = new Set(fresh.messages.map((message) => message.id));
  const before = instantMicros(oldestFresh.createdAt);
  const kept = current.messages.filter((message) => !freshIds.has(message.id) && instantMicros(message.createdAt) < before);
  if (kept.length === 0) return fresh;
  return { ...fresh, messages: [...kept, ...fresh.messages], olderCursor: current.olderCursor };
}

/** An older page above the messages on screen. The thread and `seenThrough` stay those of the newest read. */
export function withOlder(current: MemberConversation, older: MemberConversation): MemberConversation {
  const shown = new Set(current.messages.map((message) => message.id));
  return {
    ...current,
    messages: [...older.messages.filter((message) => !shown.has(message.id)), ...current.messages],
    olderCursor: older.olderCursor,
  };
}

/** The conversation once the reader has seen it: no longer unread. */
export function asRead(conversation: MemberConversation): MemberConversation {
  return conversation.thread.unread ? { ...conversation, thread: { ...conversation.thread, unread: false } } : conversation;
}

const STATUS_TEXT: Record<SupportThreadStatus, string> = {
  open: "Waiting for support",
  replied: "Support replied",
  closed: "Closed",
};

/** A thread's status in the member's words. */
export function statusText(status: SupportThreadStatus): string {
  return STATUS_TEXT[status];
}

/** Said under a closed conversation's messages, so writing in it is no surprise. */
export const CLOSED_NOTE = "This conversation is closed. Send a message to open it again.";

/** The static reply-time note: users never see which operators are online. */
export const REPLY_TIME_NOTE = "Replies show up here, and by email when you are away.";

/** The form the mark-read action reads, for the conversation as it is on screen. */
export function markReadForm(conversation: MemberConversation): FormData | null {
  if (!conversation.thread.unread || conversation.seenThrough === null) return null;
  const form = new FormData();
  form.set("threadId", conversation.thread.id);
  form.set("seenThrough", conversation.seenThrough);
  return form;
}
