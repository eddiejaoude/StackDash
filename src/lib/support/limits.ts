/*
 * The numbers support chat (#680) is bounded by. No imports, so the browser bundle (the composer,
 * the attachment picker) and the server read the same values. Several mirror a database constraint
 * or the bucket's settings, named on each, and move together with it.
 */

/** Characters in one message. Mirrors support_messages_body_format (20261128120100_support_chat.sql). */
export const MESSAGE_MAX_CHARS = 4000;

/** Characters of a thread's subject, the first line of its first message, before the ellipsis. */
export const SUBJECT_MAX_CHARS = 80;

/** Threads per page of either list. The list functions cap a page at 100. */
export const THREAD_PAGE_SIZE = 25;

/** Messages per page of a conversation, newest first. support_thread_messages caps a page at 200. */
export const MESSAGE_PAGE_SIZE = 50;

/** Unread counts stop at this many threads; a badge shows "99+" at or past it. */
export const UNREAD_COUNT_CAP = 100;

/**
 * Sending: one window is SEND_WINDOW_SECONDS long, and an attempt is refused once it and the
 * attempts of the window before it pass a limit (src/lib/support/rate-limit.ts). A conversation
 * at a typing pace never meets it; a script does, and so does a flood of operator email.
 */
export const SEND_WINDOW_SECONDS = 300;
export const SEND_LIMIT_PER_USER = 20;
/** Several people can share one address (an office, a VPN), so the address gets more room. */
export const SEND_LIMIT_PER_IP = 60;

/** Attachment claims, counted apart from sends so a failed upload never costs a message. */
export const CLAIM_LIMIT_PER_USER = 30;
export const CLAIM_LIMIT_PER_IP = 90;

/** Images per message: a rendering limit, enforced by the picker and the send actions. */
export const ATTACHMENTS_PER_MESSAGE = 5;

/** Bytes per image, 10 MiB. Mirrors the bucket's file_size_limit and support_attachments_bytes_check. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Unsent attachments one uploader may hold at once: the bound on what uploads can park in the
 * bucket, since every object needs a claim. Above ATTACHMENTS_PER_MESSAGE so a retry or two never
 * locks anyone out; the retention job clears what is never sent.
 */
export const STAGED_ATTACHMENTS_PER_UPLOADER = 20;

/** How long an unsent attachment, or an object no row names, waits before the retention job deletes it. */
export const ATTACHMENT_SWEEP_AGE_HOURS = 24;

/** The private Storage bucket (20261128120200_support_attachments.sql). The browser uploads into it. */
export const ATTACHMENT_BUCKET = "support-attachments";

/** Lifetime of a signed image URL. Minted per read, never stored. */
export const ATTACHMENT_URL_TTL_SECONDS = 600;
