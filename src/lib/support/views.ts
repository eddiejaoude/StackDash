import type { Database } from "@/lib/supabase/database.types";

import type { AttachmentMime } from "./attachments";

/*
 * The shapes support chat (#680) hands to screens: the data layer (threads.ts) returns them to
 * Server Components and the route handlers, and the server actions return the result types below.
 * Types only, so client components can import them without pulling in server code.
 */

type Enums = Database["public"]["Enums"];

export type SupportThreadStatus = Enums["support_thread_status"];
export type SupportSender = Enums["support_sender"];
export type SupportMemberRole = Enums["workspace_role"];

export type SupportAttachmentView = Readonly<{
  id: string;
  /** Display text only: the uploader's filename without any directory part. */
  filename: string;
  mime: AttachmentMime;
  bytes: number;
  /**
   * A signed URL to the image, valid for ATTACHMENT_URL_TTL_SECONDS from the read that made it, or
   * null when Storage could not sign it; the screen then lists the file without a preview.
   */
  url: string | null;
}>;

export type SupportMessageView = Readonly<{
  id: string;
  /** `user` for the member who owns the conversation, `operator` for the support team. */
  sender: SupportSender;
  /** Plain text. Render it as text, keeping its line breaks; never as HTML. */
  body: string;
  createdAt: string;
  attachments: readonly SupportAttachmentView[];
}>;

/** A thread as the viewer sees it. `unread` is against the viewer's own read marker. */
export type SupportThreadView = Readonly<{
  id: string;
  subject: string;
  status: SupportThreadStatus;
  createdAt: string;
  lastMessageAt: string;
  unread: boolean;
}>;

/** The newest message of a list row: who wrote it and its first 200 characters. */
export type SupportLastMessage = Readonly<{ sender: SupportSender; preview: string }>;

/** One row of the member's own list. */
export type MemberThreadSummary = SupportThreadView & Readonly<{ lastMessage: SupportLastMessage | null }>;

/** Who the member is, for operators. Read fresh from the account on every load. */
export type SupportMember = Readonly<{
  userId: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
}>;

/** Where the member wrote from, as the server recorded it when the conversation started. */
export type SupportContext = Readonly<{
  fromPage: string | null;
  workspaceName: string | null;
  memberRole: SupportMemberRole | null;
}>;

/** A thread as an operator sees it. */
export type OperatorThreadView = SupportThreadView & Readonly<{ member: SupportMember; context: SupportContext }>;

/** One row of the operators' list. */
export type OperatorThreadSummary = OperatorThreadView & Readonly<{ lastMessage: SupportLastMessage | null }>;

/** One page of a list, and the cursor of the next page, or null on the last one. */
export type ThreadPage<Row> = Readonly<{ threads: readonly Row[]; nextCursor: string | null }>;

/** Which operator list: open and replied threads, or closed ones. */
export type OperatorListView = "active" | "closed";

/**
 * A conversation, or one older page of it. `messages` are oldest first. `olderCursor` loads the page
 * before the oldest message shown, null when there is none. `seenThrough` is what the reader saw:
 * pass it back to markThreadRead and setThreadStatus, so a message that arrives while the thread is
 * open stays unread until it is on screen. Null on an older page, which shows nothing new.
 */
export type SupportConversation<Thread extends SupportThreadView> = Readonly<{
  thread: Thread;
  messages: readonly SupportMessageView[];
  olderCursor: string | null;
  seenThrough: string | null;
}>;

// ── Server action results ──────────────────────────────────────────────────────

/**
 * A refused or failed action. `message` is one sentence that says what happened and what to do;
 * `referenceId` names a logged failure; `retryAt` (an ISO timestamp) says when sending works again
 * after the rate limit; `fieldErrors.body` is the composer's field error.
 */
export type SupportFailure = Readonly<{
  ok: false;
  message: string;
  referenceId?: string;
  retryAt?: string;
  fieldErrors?: Readonly<{ body?: string }>;
}>;

export type SendMessageResult = Readonly<{ ok: true; threadId: string; messageId: string }> | SupportFailure;

/** `unreadCount` is the reader's fresh badge count, or null when it could not be read (keep the badge). */
export type MarkThreadReadResult = Readonly<{ ok: true; unreadCount: number | null }> | SupportFailure;

export type SetThreadStatusResult = Readonly<{ ok: true; status: SupportThreadStatus }> | SupportFailure;

/** Where the browser uploads the claimed image: `bucket` and `objectName`, with the session's client. */
export type ClaimAttachmentResult =
  | Readonly<{ ok: true; attachmentId: string; bucket: string; objectName: string }>
  | SupportFailure;

export type DiscardAttachmentResult = Readonly<{ ok: true }> | SupportFailure;
