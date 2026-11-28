"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";

import { claimAttachment, discardAttachment, markThreadRead, replyToThread, setThreadStatus } from "@/app/super-admin/inbox/actions";
import { GuardedButton } from "@/components/guarded-button";
import { AttachmentPicker, useAttachmentUploads } from "@/components/support/attachment-picker";
import { Composer } from "@/components/support/composer";
import { MessageList } from "@/components/support/message-list";
import { buttonClass } from "@/components/ui/button";
import { FailureAnnouncement, LiveRegion, OutcomeAnnouncement, outcomeOf, ReferenceNote, type Outcome } from "@/components/ui/live-region";
import type { MarkThreadReadResult, OperatorThreadView, SetThreadStatusResult, SupportConversation, SupportMessageView } from "@/lib/support/views";
import { roleLabel } from "@/lib/workspaces/permissions";

import { parseFailureReference, parseOperatorConversation } from "./conversation-response";
import { memberDisplayName, OPERATOR_STATUS_LABELS } from "./inbox";
import { MemberOnline, useInboxLive } from "./inbox-live";
import { MemberAvatar } from "./member-avatar";

/*
 * The open conversation in the support inbox (#680). It loads through
 * GET /api/support/inbox/threads/<id>, not a Server Action: Next.js runs a client's actions one at a
 * time, so opening a conversation would wait behind a reply still sending. It reads again on every
 * hint for this conversation and after every reconnect (InboxLive's `conversationSignal`), after a
 * reply, and after a status change. Older pages the operator loaded stay above the newest page as
 * long as the two still meet.
 *
 * A conversation is marked read once it is on screen in a visible tab, through the `seenThrough` of
 * the newest page, so a message that arrives while it is open stays unread until it is shown. A
 * close carries the same `seenThrough`, and the server refuses it when the user wrote after it.
 */

type Conversation = SupportConversation<OperatorThreadView>;

type Loaded = Readonly<{
  /** The newest page, read again on every hint. */
  conversation: Conversation;
  /** Messages from older pages the operator loaded, oldest first. */
  older: readonly SupportMessageView[];
  /** The cursor of the page before everything shown, null when the first message is shown. */
  olderCursor: string | null;
}>;

type LoadFailure = Readonly<{ kind: "gone" | "signed_out" | "failed"; referenceId?: string | undefined }>;

type LoadResult = Readonly<{ ok: true; conversation: Conversation }> | Readonly<{ ok: false; failure: LoadFailure }>;

async function fetchConversation(threadId: string, before: string | null, signal: AbortSignal): Promise<LoadResult> {
  const query = before === null ? "" : `?${new URLSearchParams({ before }).toString()}`;
  try {
    const response = await fetch(`/api/support/inbox/threads/${encodeURIComponent(threadId)}${query}`, { cache: "no-store", signal });
    if (response.status === 404) return { ok: false, failure: { kind: "gone" } };
    if (response.status === 401) return { ok: false, failure: { kind: "signed_out" } };
    const body: unknown = await response.json();
    if (!response.ok) return { ok: false, failure: { kind: "failed", referenceId: parseFailureReference(body) } };
    const conversation = parseOperatorConversation(body);
    return conversation === null ? { ok: false, failure: { kind: "failed" } } : { ok: true, conversation };
  } catch (cause) {
    // A dropped connection, an aborted request, or a body that is not JSON: each is a failed load
    // the pane offers to retry, never an error that takes the inbox down. An aborted one is ignored
    // by the caller.
    if (!signal.aborted) {
      console.error(
        JSON.stringify({ level: "error", event: "support.inbox_load_failed", reason: cause instanceof Error ? cause.message : "unknown" }),
      );
    }
    return { ok: false, failure: { kind: "failed" } };
  }
}

/** The newest page in place of the last, keeping loaded older pages when the two still meet. */
function withNewest(previous: Loaded | null, conversation: Conversation): Loaded {
  const fresh = { conversation, older: [], olderCursor: conversation.olderCursor };
  if (previous === null || previous.older.length === 0) return fresh;
  const newestShown = previous.conversation.messages.at(-1);
  const ids = new Set(conversation.messages.map((message) => message.id));
  // More messages arrived than a page holds, so the loaded pages no longer meet the newest one.
  if (newestShown === undefined || !ids.has(newestShown.id)) return fresh;
  const older = [...previous.older, ...previous.conversation.messages].filter((message) => !ids.has(message.id));
  return { conversation, older, olderCursor: previous.olderCursor };
}

/** An older page above everything shown. */
function withOlder(previous: Loaded, page: Conversation): Loaded {
  const shown = new Set([...previous.older, ...previous.conversation.messages].map((message) => message.id));
  return {
    ...previous,
    older: [...page.messages.filter((message) => !shown.has(message.id)), ...previous.older],
    olderCursor: page.olderCursor,
  };
}

const NETWORK_STATUS_FAILURE = "The conversation was not changed because the connection failed. Check your connection, then try again.";
const NETWORK_READ_FAILURE = "This conversation could not be marked as read because the connection failed. It stays marked as unread.";

/**
 * The conversation pane: the open conversation, or what to do when none is open. Remounted per
 * conversation, so a draft, staged images, and messages never carry over to another one.
 */
export function OperatorConversation({ threadId, backHref, signInHref }: Readonly<{ threadId: string | null; backHref: string; signInHref: string }>) {
  const headingId = useId();
  if (threadId === null) {
    return (
      <section aria-labelledby={headingId} className="rounded-lg border border-dashed border-line-strong bg-panel px-6 py-12 text-center">
        <h2 id={headingId} className="text-lg font-semibold tracking-tight">
          No conversation open
        </h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">Choose a conversation from the list to read it and reply.</p>
      </section>
    );
  }
  return <ConversationPane key={threadId} threadId={threadId} backHref={backHref} signInHref={signInHref} />;
}

function ConversationPane({ threadId, backHref, signInHref }: Readonly<{ threadId: string; backHref: string; signInHref: string }>) {
  const { conversationSignal, refreshList, watchMember, focusOnOpen } = useInboxLive();
  const headingId = useId();
  const contextHeadingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadFailure, setLoadFailure] = useState<LoadFailure | null>(null);
  const [reloads, setReloads] = useState(0);
  const attachments = useAttachmentUploads({ claim: claimAttachment, discard: discardAttachment, threadId });

  // The newest page: on open, on every hint and reconnect, and after this operator's own changes.
  useEffect(() => {
    const controller = new AbortController();
    void fetchConversation(threadId, null, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      if (result.ok) {
        setLoaded((previous) => withNewest(previous, result.conversation));
        setLoadFailure(null);
      } else {
        setLoadFailure(result.failure);
      }
    });
    return () => controller.abort();
  }, [threadId, conversationSignal, reloads]);

  function reloadAll() {
    setReloads((count) => count + 1);
    refreshList();
  }

  const conversation = loaded?.conversation ?? null;
  const memberId = conversation?.thread.member.userId ?? null;
  useEffect(() => {
    watchMember(memberId);
    return () => watchMember(null);
  }, [memberId, watchMember]);

  // A conversation opened from the list takes focus once it is on screen; one the page opened on
  // leaves focus where the page starts.
  const focusPending = useRef(focusOnOpen);
  const shown = conversation !== null;
  useEffect(() => {
    if (!shown || !focusPending.current) return;
    focusPending.current = false;
    heading.current?.focus();
  }, [shown]);

  // Marked read once on screen in a visible tab, through what this page showed.
  const unreadThrough = conversation !== null && conversation.thread.unread ? conversation.seenThrough : null;
  const markedThrough = useRef<string | null>(null);
  const [readFailure, setReadFailure] = useState<string | null>(null);
  useEffect(() => {
    if (unreadThrough === null || markedThrough.current === unreadThrough) return;
    const seenThrough = unreadThrough;
    function mark(): boolean {
      if (document.visibilityState !== "visible") return false;
      markedThrough.current = seenThrough;
      const form = new FormData();
      form.set("threadId", threadId);
      form.set("seenThrough", seenThrough);
      void markThreadRead(null, form).then(
        (result: MarkThreadReadResult) => {
          if (result.ok) {
            setReadFailure(null);
            refreshList();
          } else {
            setReadFailure(result.message);
          }
        },
        () => setReadFailure(NETWORK_READ_FAILURE),
      );
      return true;
    }
    if (mark()) return;
    const onVisible = () => {
      if (mark()) document.removeEventListener("visibilitychange", onVisible);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [unreadThrough, threadId, refreshList]);

  // Older pages, on request. Aborted when the pane unmounts.
  const [olderPending, setOlderPending] = useState(false);
  const [olderFailure, setOlderFailure] = useState<LoadFailure | null>(null);
  const olderRequest = useRef<AbortController | null>(null);
  useEffect(() => () => olderRequest.current?.abort(), []);

  async function loadOlder() {
    const before = loaded?.olderCursor ?? null;
    if (before === null || olderPending) return;
    setOlderPending(true);
    setOlderFailure(null);
    const controller = new AbortController();
    olderRequest.current = controller;
    const result = await fetchConversation(threadId, before, controller.signal);
    if (controller.signal.aborted) return;
    setOlderPending(false);
    if (!result.ok) {
      setOlderFailure(result.failure);
      return;
    }
    setLoaded((previous) => (previous === null ? previous : withOlder(previous, result.conversation)));
    // The button goes away with the first message shown; focus moves to the top of the pane.
    if (result.conversation.olderCursor === null) heading.current?.focus();
  }

  // Close and reopen.
  const [statusPending, startStatusChange] = useTransition();
  const [requestedStatus, setRequestedStatus] = useState<"open" | "closed">("closed");
  const [statusOutcome, setStatusOutcome] = useState<Outcome | null>(null);

  function changeStatus(status: "open" | "closed") {
    const seenThrough = conversation?.seenThrough ?? null;
    if (seenThrough === null || statusPending) return;
    setRequestedStatus(status);
    setStatusOutcome(null);
    const form = new FormData();
    form.set("threadId", threadId);
    form.set("status", status);
    form.set("seenThrough", seenThrough);
    startStatusChange(async () => {
      let result: SetThreadStatusResult;
      try {
        result = await setThreadStatus(null, form);
      } catch {
        result = { ok: false, message: NETWORK_STATUS_FAILURE };
      }
      setStatusOutcome(
        outcomeOf(
          result,
          status === "closed" ? "Conversation closed. It now shows under Closed." : "Conversation reopened. It now shows under Active.",
        ),
      );
      // A refused close means the user wrote again: the reload shows what they wrote.
      reloadAll();
    });
  }

  const thread = conversation?.thread ?? null;
  const name = thread === null ? null : memberDisplayName(thread.member);
  const closed = thread?.status === "closed";

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <Link href={backHref} scroll={false} className="inline-flex min-h-9 items-center self-start text-sm underline underline-offset-4 md:hidden">
        Back to conversations
      </Link>

      <LiveRegion tone="status" className="text-sm text-muted">
        {loaded === null && loadFailure === null ? <p>Loading the conversation</p> : null}
      </LiveRegion>
      <LiveRegion tone="error" className="text-sm">
        {loadFailure === null ? null : (
          <div className="flex flex-col items-start gap-3 rounded-lg border border-danger/40 px-4 py-3">
            <p className="text-danger">
              {loadFailure.kind === "gone"
                ? "This conversation is no longer available. Choose another conversation from the list."
                : loadFailure.kind === "signed_out"
                  ? "Your session has ended, so this conversation could not be loaded. Sign in again to keep reading."
                  : loaded === null
                    ? "This conversation could not be loaded. Check your connection, then try again."
                    : "The newest messages could not be loaded. Check your connection, then try again."}
              <ReferenceNote referenceId={loadFailure.referenceId} />
            </p>
            {loadFailure.kind === "signed_out" ? (
              <a href={signInHref} className={buttonClass("secondary", "sm")}>
                Sign in again
              </a>
            ) : loadFailure.kind === "failed" ? (
              <button type="button" onClick={() => setReloads((count) => count + 1)} className={buttonClass("secondary", "sm")}>
                Try again
              </button>
            ) : null}
          </div>
        )}
      </LiveRegion>

      <div className="flex flex-wrap items-start gap-3 border-b border-line pb-4">
        {thread === null ? null : <MemberAvatar url={thread.member.avatarUrl} size={40} />}
        <div className="min-w-0 flex-1">
          <h2 id={headingId} ref={heading} tabIndex={-1} className={thread === null ? "sr-only" : "truncate text-lg font-semibold tracking-tight"}>
            {name ?? "Conversation"}
          </h2>
          {thread === null ? null : (
            <>
              {thread.member.name !== null && thread.member.email !== null ? (
                <p className="break-all text-sm text-muted">{thread.member.email}</p>
              ) : null}
              <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted">
                <span>{OPERATOR_STATUS_LABELS[thread.status]}</span>
                <MemberOnline userId={thread.member.userId} />
              </p>
            </>
          )}
        </div>
        {thread === null ? null : (
          <GuardedButton
            type="button"
            unavailable={statusPending || conversation?.seenThrough === null}
            onClick={() => changeStatus(closed ? "open" : "closed")}
            className={buttonClass("secondary", "sm")}
          >
            {statusPending ? (requestedStatus === "closed" ? "Closing" : "Reopening") : closed ? "Reopen conversation" : "Close conversation"}
          </GuardedButton>
        )}
      </div>
      <OutcomeAnnouncement outcome={statusOutcome} className="text-sm" />
      <FailureAnnouncement failure={readFailure === null ? null : { message: readFailure }} className="text-sm" />

      {thread === null || loaded === null || name === null ? null : (
        <>
          <section aria-labelledby={contextHeadingId} className="rounded-lg border border-line bg-panel px-4 py-3">
            <h3 id={contextHeadingId} className="text-sm font-semibold">
              Where they wrote from
            </h3>
            <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="text-muted">Page</dt>
              <dd className="break-all">
                {thread.context.fromPage === null ? (
                  "Not recorded"
                ) : (
                  <Link href={thread.context.fromPage} className="inline-flex min-h-6 items-center underline underline-offset-4">
                    {thread.context.fromPage}
                  </Link>
                )}
              </dd>
              <dt className="text-muted">Workspace</dt>
              <dd className="break-words">{thread.context.workspaceName ?? "Not recorded"}</dd>
              <dt className="text-muted">Role</dt>
              <dd>{thread.context.memberRole === null ? "Not recorded" : roleLabel(thread.context.memberRole)}</dd>
            </dl>
          </section>

          <MessageList
            messages={[...loaded.older, ...loaded.conversation.messages]}
            viewer="operator"
            label={`Conversation with ${name}`}
            memberName={name}
            empty="No messages in this conversation yet. Write a reply below."
            before={
              loaded.olderCursor === null ? null : (
                <div className="flex flex-col items-start gap-2">
                  <GuardedButton type="button" unavailable={olderPending} onClick={() => void loadOlder()} className={buttonClass("secondary", "sm")}>
                    {olderPending ? "Loading older messages" : "Load older messages"}
                  </GuardedButton>
                  <FailureAnnouncement
                    failure={
                      olderFailure === null
                        ? null
                        : {
                            message:
                              olderFailure.kind === "gone"
                                ? "This conversation is no longer available. Choose another conversation from the list."
                                : "Older messages could not be loaded. Check your connection, then try again.",
                            referenceId: olderFailure.referenceId,
                          }
                    }
                    className="text-sm"
                  />
                </div>
              )
            }
          />

          <Composer
            action={replyToThread}
            fields={{ threadId }}
            label={`Reply to ${name}`}
            submitLabel="Send reply"
            attachments={attachments}
            onSent={reloadAll}
          >
            <AttachmentPicker controller={attachments} />
          </Composer>
        </>
      )}
    </section>
  );
}
