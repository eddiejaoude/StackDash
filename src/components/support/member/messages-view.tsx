"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useEffectEvent, useId, useRef, useState, useSyncExternalStore, type MouseEvent } from "react";

import { claimAttachment, discardAttachment, sendMessage, startThread } from "@/app/account/messages/actions";
import { GuardedButton } from "@/components/guarded-button";
import { buttonClass } from "@/components/ui/button";
import { FailureAnnouncement, LiveRegion } from "@/components/ui/live-region";
import { formatDateTime } from "@/lib/format";
import { supportUserTopic } from "@/lib/support/live";
import { SUPPORT_MESSAGES_PATH, SUPPORT_THREAD_PARAM, supportThreadPath } from "@/lib/support/paths";
import type { MemberThreadSummary, SendMessageResult, SupportFailure, ThreadPage } from "@/lib/support/views";

import { AttachmentPicker, useAttachmentUploads } from "../attachment-picker";
import { Composer } from "../composer";
import { MessageList } from "../message-list";
import { useSetUnreadCount } from "../support-unread";
import { useSupportChannel } from "../use-support-channel";
import { asRead, CLOSED_NOTE, REPLY_TIME_NOTE, statusText, withNewest, withOlder, type MemberConversation } from "./conversation";
import { fetchConversation, fetchThreadPage, type ReadFailure } from "./responses";
import { useMarkRead } from "./use-mark-read";

/*
 * The member's messages page (#680): the list of their conversations beside the open one. The page
 * renders the first list page and the selected conversation on the server; from then on this reads
 * through the route handlers. Choosing a conversation changes `?thread=` with the History API
 * (Next.js keeps useSearchParams in step), so links, Back, and reloads open the same conversation
 * without rendering the page again. Below `md` one pane shows at a time: the list, or the
 * conversation (or the new conversation form) with a link back to the list.
 *
 * The member's Realtime channel runs while the page is open (the launcher is not on this page), with
 * presence, so operators see the member online. A hint reads the list again, and the open
 * conversation when it is the one that changed; a reconnect reads both.
 */

type Detail =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "loaded"; conversation: MemberConversation }>
  | Readonly<{ kind: "failed"; threadId: string; failure: ReadFailure }>;

const WIDE_QUERY = "(min-width: 48rem)";

function subscribeWide(onChange: () => void): () => void {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** True when both panes show (`md` and up). False on the server, where nothing is marked read. */
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

function rowId(threadId: string): string {
  return `support-thread-${threadId}`;
}

/** A plain click: a modified one (new tab, new window) is left to the browser. */
function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Fresh rows first, then the rows loaded by "Show more" that the fresh page does not hold. */
function withFreshPage(current: readonly MemberThreadSummary[], fresh: readonly MemberThreadSummary[]): MemberThreadSummary[] {
  const freshIds = new Set(fresh.map((thread) => thread.id));
  return [...fresh, ...current.filter((thread) => !freshIds.has(thread.id))];
}

const LIST_FAILED = "Your conversations could not be loaded. Check your connection, then try again.";
const MORE_FAILED: SupportFailure = { ok: false, message: "More conversations could not be loaded. Check your connection, then try again." };
const OLDER_FAILED: SupportFailure = { ok: false, message: "Older messages could not be loaded. Check your connection, then try again." };

export type MessagesViewProps = Readonly<{
  userId: string;
  initialPage: ThreadPage<MemberThreadSummary>;
  /** The selected conversation (`?thread=` or the first row), read by the page. */
  initialConversation: MemberConversation | null;
  /** `?thread=` named a conversation that is missing or not the user's. */
  initialMissing: string | null;
}>;

export function MessagesView({ userId, initialPage, initialConversation, initialMissing }: MessagesViewProps) {
  const searchParams = useSearchParams();
  const requestedId = searchParams.get(SUPPORT_THREAD_PARAM);
  const wide = useWide();
  const setUnread = useSetUnreadCount();
  const listHeadingId = useId();
  const detailHeadingId = useId();
  const detailRef = useRef<HTMLElement>(null);
  const newButtonRef = useRef<HTMLButtonElement>(null);
  // Where focus goes after the next render: the conversation pane, a list row, or the new button.
  const focusNext = useRef<string | null>(null);

  const [threads, setThreads] = useState<readonly MemberThreadSummary[]>(initialPage.threads);
  const [nextCursor, setNextCursor] = useState(initialPage.nextCursor);
  const [listFailed, setListFailed] = useState(false);
  const [moreFailure, setMoreFailure] = useState<SupportFailure | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [composing, setComposing] = useState(false);
  // Without `?thread=`, the conversation the page opened on stays open while hints reorder the list,
  // so a reply being written is never swapped out from under the writer.
  const [openedOn] = useState(initialPage.threads[0]?.id ?? null);
  const [detail, setDetail] = useState<Detail>(() => {
    if (initialConversation !== null) return { kind: "loaded", conversation: initialConversation };
    if (initialMissing !== null) return { kind: "failed", threadId: initialMissing, failure: "not_found" };
    return { kind: "none" };
  });
  const [olderFailure, setOlderFailure] = useState<SupportFailure | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const conversationRead = useRef<AbortController | null>(null);
  const listRead = useRef<AbortController | null>(null);

  const writing = composing || (threads.length === 0 && requestedId === null);
  const selectedId = writing ? null : (requestedId ?? openedOn ?? threads[0]?.id ?? null);
  const detailId = detail.kind === "loaded" ? detail.conversation.thread.id : detail.kind === "failed" ? detail.threadId : null;
  const loading = selectedId !== null && detailId !== selectedId;
  const conversation = detail.kind === "loaded" && detail.conversation.thread.id === selectedId ? detail.conversation : null;
  const failure = detail.kind === "failed" && detail.threadId === selectedId ? detail.failure : null;
  // On a phone the conversation pane shows only when the URL names one, or while writing.
  const detailShown = requestedId !== null || writing;

  function loadConversation(threadId: string): void {
    conversationRead.current?.abort();
    const controller = new AbortController();
    conversationRead.current = controller;
    void fetchConversation(threadId, null, controller.signal).then((read) => {
      if (controller.signal.aborted) return;
      setDetail((current) =>
        read.ok
          ? { kind: "loaded", conversation: withNewest(current.kind === "loaded" ? current.conversation : null, read.value) }
          : // A failed read again of the conversation on screen keeps it; only a first read shows the failure.
            current.kind === "loaded" && current.conversation.thread.id === threadId && read.failure === "failed"
            ? current
            : { kind: "failed", threadId, failure: read.failure },
      );
    });
  }

  async function refreshList(): Promise<void> {
    listRead.current?.abort();
    const controller = new AbortController();
    listRead.current = controller;
    const read = await fetchThreadPage(null, controller.signal);
    if (controller.signal.aborted) return;
    if (!read.ok) {
      setListFailed(true);
      return;
    }
    setListFailed(false);
    setUnread("member", read.value.unreadCount);
    setThreads((current) => withFreshPage(current, read.value.threads));
    // Rows past the first page stay; their cursor still reaches past them.
    setNextCursor((current) => (threads.length > read.value.threads.length ? current : read.value.nextCursor));
  }

  useEffect(
    () => () => {
      conversationRead.current?.abort();
      listRead.current?.abort();
    },
    [],
  );

  // A conversation chosen (a row, Back, Forward) that is not the one on screen: read it.
  const loadSelected = useEffectEvent((threadId: string) => loadConversation(threadId));
  useEffect(() => {
    if (loading && selectedId !== null) loadSelected(selectedId);
  }, [loading, selectedId]);

  useEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    if (target === "detail") detailRef.current?.focus();
    else if (target === "new") newButtonRef.current?.focus();
    else document.getElementById(target)?.focus();
  });

  useSupportChannel({
    topic: supportUserTopic(userId),
    presenceKey: userId,
    onActivity: (activity) => {
      void refreshList();
      if (activity.kind !== "read" && activity.threadId === conversation?.thread.id) loadConversation(activity.threadId);
    },
    onReconnect: () => {
      void refreshList();
      if (conversation !== null) loadConversation(conversation.thread.id);
    },
  });

  const markFailure = useMarkRead({
    conversation,
    visible: wide || requestedId !== null,
    onRead: (threadId, unreadCount) => {
      setUnread("member", unreadCount);
      setThreads((current) => current.map((thread) => (thread.id === threadId && thread.unread ? { ...thread, unread: false } : thread)));
      setDetail((current) =>
        current.kind === "loaded" && current.conversation.thread.id === threadId ? { kind: "loaded", conversation: asRead(current.conversation) } : current,
      );
    },
  });

  function go(href: string): void {
    window.history.pushState(null, "", href);
  }

  function openThread(event: MouseEvent<HTMLAnchorElement>, threadId: string): void {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    setComposing(false);
    if (threadId !== requestedId) go(supportThreadPath(SUPPORT_MESSAGES_PATH, threadId));
    // On a phone the list goes away, so focus follows to the conversation.
    if (!wide) focusNext.current = "detail";
  }

  function backToList(event: MouseEvent<HTMLAnchorElement>): void {
    if (!isPlainClick(event)) return;
    event.preventDefault();
    const from = selectedId;
    setComposing(false);
    if (requestedId !== null) go(SUPPORT_MESSAGES_PATH);
    focusNext.current = from === null ? "new" : rowId(from);
  }

  function stopWriting(): void {
    setComposing(false);
    focusNext.current = "new";
  }

  async function showMore(): Promise<void> {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    setMoreFailure(null);
    const read = await fetchThreadPage(nextCursor, new AbortController().signal);
    setLoadingMore(false);
    if (!read.ok) {
      setMoreFailure(MORE_FAILED);
      return;
    }
    const firstNew = read.value.threads.find((thread) => !threads.some((shown) => shown.id === thread.id));
    setThreads((current) => [...current, ...read.value.threads.filter((thread) => !current.some((shown) => shown.id === thread.id))]);
    setNextCursor(read.value.nextCursor);
    // The button may go with the last page; the first new row keeps the reader's place.
    if (firstNew !== undefined) focusNext.current = rowId(firstNew.id);
  }

  async function loadOlder(shown: MemberConversation): Promise<void> {
    if (shown.olderCursor === null || loadingOlder) return;
    setLoadingOlder(true);
    setOlderFailure(null);
    const read = await fetchConversation(shown.thread.id, shown.olderCursor, new AbortController().signal);
    setLoadingOlder(false);
    if (!read.ok) {
      setOlderFailure(OLDER_FAILED);
      return;
    }
    setDetail((current) =>
      current.kind === "loaded" && current.conversation.thread.id === shown.thread.id
        ? { kind: "loaded", conversation: withOlder(current.conversation, read.value) }
        : current,
    );
    // The button goes with the first message; the conversation pane keeps focus in the reader's place.
    if (read.value.olderCursor === null) focusNext.current = "detail";
  }

  function onStarted(result: Extract<SendMessageResult, { ok: true }>): void {
    setComposing(false);
    go(supportThreadPath(SUPPORT_MESSAGES_PATH, result.threadId));
    focusNext.current = "detail";
    void refreshList();
  }

  function onReplied(threadId: string): void {
    loadConversation(threadId);
    void refreshList();
  }

  return (
    <div className="mt-8 grid gap-6 md:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
      <section aria-labelledby={listHeadingId} className={`${detailShown ? "hidden md:flex" : "flex"} min-w-0 flex-col gap-3`}>
        <div className="flex items-center justify-between gap-3">
          <h2 id={listHeadingId} className="text-sm font-semibold">
            Conversations
          </h2>
          {threads.length === 0 ? null : (
            <button ref={newButtonRef} type="button" onClick={() => setComposing(true)} className={buttonClass("raised", "xs")}>
              New conversation
            </button>
          )}
        </div>
        {listFailed ? <p className="text-sm text-danger">{LIST_FAILED}</p> : null}
        {threads.length === 0 ? (
          <p className="text-sm text-muted">No conversations yet. Your first message starts one.</p>
        ) : (
          <ul aria-labelledby={listHeadingId} className="flex flex-col gap-2">
            {threads.map((thread) => {
              const selected = thread.id === selectedId;
              return (
                <li key={thread.id}>
                  <a
                    id={rowId(thread.id)}
                    href={supportThreadPath(SUPPORT_MESSAGES_PATH, thread.id)}
                    onClick={(event) => openThread(event, thread.id)}
                    aria-current={selected ? "page" : undefined}
                    className={`flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm transition-colors hover:border-line-strong ${
                      selected ? "border-accent bg-panel-raised" : "border-line bg-panel"
                    }`}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className={`min-w-0 break-words ${thread.unread ? "font-semibold" : "font-medium"}`}>{thread.subject}</span>
                      {thread.unread ? (
                        <span className="shrink-0 rounded-full bg-accent px-1.5 text-xs font-semibold leading-5 text-background">Unread</span>
                      ) : null}
                    </span>
                    {thread.lastMessage === null ? null : (
                      <span className="line-clamp-2 break-words text-muted">
                        {thread.lastMessage.sender === "user" ? "You" : "Support"}: {thread.lastMessage.preview}
                      </span>
                    )}
                    <span className="flex flex-wrap gap-x-2 text-xs text-muted">
                      <span>{statusText(thread.status)}</span>
                      <time dateTime={thread.lastMessageAt}>{formatDateTime(thread.lastMessageAt)}</time>
                    </span>
                  </a>
                </li>
              );
            })}
          </ul>
        )}
        {nextCursor === null ? null : (
          <GuardedButton
            type="button"
            unavailable={loadingMore}
            onClick={() => void showMore()}
            className={`self-start ${buttonClass("secondary", "sm")}`}
          >
            {loadingMore ? "Loading more conversations" : "Show more conversations"}
          </GuardedButton>
        )}
        <FailureAnnouncement failure={moreFailure} className="text-sm" />
      </section>

      <section
        ref={detailRef}
        tabIndex={-1}
        aria-labelledby={detailHeadingId}
        className={`${detailShown ? "flex" : "hidden md:flex"} min-w-0 flex-col gap-4 rounded-xl border border-line bg-panel p-4 focus-visible:outline-none sm:p-6`}
      >
        {requestedId === null && threads.length === 0 ? null : (
          <a
            href={SUPPORT_MESSAGES_PATH}
            onClick={backToList}
            className="inline-flex min-h-6 items-center self-start text-sm text-muted underline underline-offset-4 hover:text-foreground md:hidden"
          >
            Back to conversations
          </a>
        )}

        {writing ? (
          <>
            <h2 id={detailHeadingId} className="text-base font-semibold">
              {threads.length === 0 ? "Start a conversation" : "New conversation"}
            </h2>
            <p className="text-sm text-muted">
              Ask a question, report a problem, or share an idea. Your first line becomes the subject.
            </p>
            {/* Focus moves into the form when the reader asked for it, not when an empty page opens on it. */}
            <NewThreadComposer onSent={onStarted} autoFocus={composing} />
            {threads.length === 0 ? null : (
              <button type="button" onClick={stopWriting} className={`self-start ${buttonClass("secondary", "sm")}`}>
                Cancel
              </button>
            )}
          </>
        ) : conversation !== null ? (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 id={detailHeadingId} className="min-w-0 break-words text-base font-semibold">
                {conversation.thread.subject}
              </h2>
              <p className="text-xs text-muted">{statusText(conversation.thread.status)}</p>
            </div>
            <MessageList
              messages={conversation.messages}
              viewer="member"
              label="Conversation with support"
              empty="No messages yet. Write the first one below."
              before={
                conversation.olderCursor === null ? null : (
                  <GuardedButton
                    type="button"
                    unavailable={loadingOlder}
                    onClick={() => void loadOlder(conversation)}
                    className={`self-center ${buttonClass("secondary", "xs")}`}
                  >
                    {loadingOlder ? "Loading older messages" : "Load older messages"}
                  </GuardedButton>
                )
              }
            />
            <FailureAnnouncement failure={olderFailure} className="text-sm" />
            {conversation.thread.status === "closed" ? <p className="text-sm text-muted">{CLOSED_NOTE}</p> : null}
            <FailureAnnouncement failure={markFailure} className="text-sm" />
            <ReplyComposer key={conversation.thread.id} threadId={conversation.thread.id} onSent={() => onReplied(conversation.thread.id)} />
          </>
        ) : (
          <>
            <h2 id={detailHeadingId} className="text-base font-semibold">
              {failure === "not_found" ? "Conversation not found" : "Conversation"}
            </h2>
            <LiveRegion tone="status" className="text-sm text-muted">
              {loading ? "Loading the conversation" : null}
            </LiveRegion>
            {failure === "not_found" ? (
              <p className="text-sm">
                This conversation does not exist, or it belongs to another account. Choose one from your conversations, or
                start a new one.
              </p>
            ) : null}
            {failure === "failed" ? (
              <div className="flex flex-col items-start gap-2 text-sm">
                <p className="text-danger">This conversation could not be loaded. Check your connection, then try again.</p>
                {selectedId === null ? null : (
                  <button type="button" onClick={() => loadConversation(selectedId)} className={buttonClass("secondary", "sm")}>
                    Try again
                  </button>
                )}
              </div>
            ) : null}
          </>
        )}
        <p className="text-xs text-muted">{REPLY_TIME_NOTE}</p>
      </section>
    </div>
  );
}

/** The new conversation form, with images. Its uploads start without a conversation. */
function NewThreadComposer({
  onSent,
  autoFocus,
}: Readonly<{ onSent: (result: Extract<SendMessageResult, { ok: true }>) => void; autoFocus: boolean }>) {
  const attachments = useAttachmentUploads({ claim: claimAttachment, discard: discardAttachment, threadId: null });
  return (
    <Composer
      action={startThread}
      fields={{ fromPage: SUPPORT_MESSAGES_PATH }}
      label="Your message to support"
      attachments={attachments}
      onSent={onSent}
      autoFocus={autoFocus}
    >
      <AttachmentPicker controller={attachments} />
    </Composer>
  );
}

/** The reply form of one conversation, with images; keyed by the conversation, so a draft stays with it. */
function ReplyComposer({ threadId, onSent }: Readonly<{ threadId: string; onSent: () => void }>) {
  const attachments = useAttachmentUploads({ claim: claimAttachment, discard: discardAttachment, threadId });
  return (
    <Composer action={sendMessage} fields={{ threadId }} label="Your reply" attachments={attachments} onSent={onSent}>
      <AttachmentPicker controller={attachments} />
    </Composer>
  );
}
