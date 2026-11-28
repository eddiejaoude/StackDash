"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { sendMessage, startThread } from "@/app/account/messages/actions";
import { buttonClass } from "@/components/ui/button";
import { FailureAnnouncement, LiveRegion } from "@/components/ui/live-region";
import { SUPPORT_MESSAGES_PATH, supportThreadPath } from "@/lib/support/paths";

import { Composer } from "../composer";
import { MessageList } from "../message-list";
import { useSetUnreadCount } from "../support-unread";
import { asRead, CLOSED_NOTE, REPLY_TIME_NOTE, statusText, withNewest, type MemberConversation } from "./conversation";
import { fetchConversation, fetchThreadPage } from "./responses";
import { useMarkRead } from "./use-mark-read";

/*
 * The launcher's panel (#680), loaded with next/dynamic the first time the launcher opens, so the
 * shell every app page loads carries only the button and the channel. It shows the user's first
 * conversation (unread first, then the newest activity) with a composer, or invites the first
 * message when there is none. No attachments here: the picker stays on the full messages page,
 * which the panel links to. The shell's Realtime channel bumps `revision` on each hint; the panel
 * then reads the conversation on screen again, with the list for the badge.
 */

type PanelState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "thread"; conversation: MemberConversation }>;

const LOAD_FAILED = "Your conversation could not be loaded. Check your connection, then try again.";

export function LauncherPanel({ open, revision }: Readonly<{ open: boolean; revision: number }>) {
  const pathname = usePathname();
  const setUnread = useSetUnreadCount();
  const [state, setState] = useState<PanelState>({ kind: "loading" });
  const [composingNew, setComposingNew] = useState(false);
  // Set by a step the reader took (starting, sending, going back), so the composer that appears
  // takes focus. Cleared on close: on the next open, focus starts on the panel itself.
  const [focusComposer, setFocusComposer] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setFocusComposer(false);
  }
  const request = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const shownId = state.kind === "thread" ? state.conversation.thread.id : null;

  /** Reads the list (for the badge, and the first conversation when `threadId` is null) and the conversation. */
  async function load(threadId: string | null): Promise<void> {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    const pageRead = fetchThreadPage(null, signal);
    let id = threadId;
    if (id === null) {
      const page = await pageRead;
      if (signal.aborted) return;
      if (!page.ok) {
        setState({ kind: "failed" });
        return;
      }
      setUnread("member", page.value.unreadCount);
      const first = page.value.threads[0];
      if (first === undefined) {
        setState({ kind: "empty" });
        return;
      }
      id = first.id;
    }
    const [page, read] = await Promise.all([pageRead, fetchConversation(id, null, signal)]);
    if (signal.aborted) return;
    if (page.ok) setUnread("member", page.value.unreadCount);
    if (!read.ok) {
      // Gone since the list was read: show what the list holds now.
      if (read.failure === "not_found" && threadId !== null) {
        void load(null);
        return;
      }
      setState({ kind: "failed" });
      return;
    }
    setState((current) => ({
      kind: "thread",
      conversation: withNewest(current.kind === "thread" ? current.conversation : null, read.value),
    }));
  }

  const loadFromEffect = useEffectEvent((threadId: string | null) => void load(threadId));
  const reloadShown = useEffectEvent(() => void load(shownId));

  // Each open shows the conversation as it is now; one that started elsewhere may have become first.
  useEffect(() => {
    if (open) loadFromEffect(null);
  }, [open]);

  // A Realtime hint or a reconnect: read the conversation on screen again.
  useEffect(() => {
    if (revision > 0) reloadShown();
  }, [revision]);

  useEffect(() => () => request.current?.abort(), []);

  const conversation = state.kind === "thread" ? state.conversation : null;
  const markFailure = useMarkRead({
    conversation,
    visible: open,
    onRead: (threadId, unreadCount) => {
      setUnread("member", unreadCount);
      setState((current) =>
        current.kind === "thread" && current.conversation.thread.id === threadId
          ? { kind: "thread", conversation: asRead(current.conversation) }
          : current,
      );
    },
  });

  // Keep the newest message in view as messages arrive.
  const messageCount = conversation?.messages.length ?? 0;
  useEffect(() => {
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, [messageCount, shownId]);

  const allMessagesHref = shownId === null ? SUPPORT_MESSAGES_PATH : supportThreadPath(SUPPORT_MESSAGES_PATH, shownId);
  const writingNew = state.kind === "empty" || (state.kind === "thread" && composingNew);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <LiveRegion tone="status" className="sr-only">
        {state.kind === "loading" ? "Loading your conversation" : null}
      </LiveRegion>
      {state.kind === "loading" ? (
        <p aria-hidden="true" className="text-sm text-muted">
          Loading your conversation
        </p>
      ) : null}

      {state.kind === "failed" ? (
        <div className="flex flex-col items-start gap-2 text-sm">
          <p className="text-danger">{LOAD_FAILED}</p>
          <button type="button" onClick={() => void load(null)} className={buttonClass("secondary", "sm")}>
            Try again
          </button>
        </div>
      ) : null}

      {writingNew ? (
        <>
          <p className="text-sm text-muted">
            {state.kind === "empty"
              ? "Ask a question, report a problem, or share an idea. Your first line becomes the subject."
              : "Start a new conversation. Your first line becomes the subject."}
          </p>
          <Composer
            key="new"
            action={startThread}
            fields={{ fromPage: pathname }}
            label="Message to support"
            autoFocus={focusComposer}
            onSent={(result) => {
              setComposingNew(false);
              setFocusComposer(true);
              void load(result.threadId);
            }}
          />
          {state.kind === "thread" ? (
            <button
              type="button"
              onClick={() => {
                setComposingNew(false);
                setFocusComposer(true);
              }}
              className={`self-start ${buttonClass("secondary", "xs")}`}
            >
              Back to your conversation
            </button>
          ) : null}
        </>
      ) : null}

      {state.kind === "thread" && !composingNew ? (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h3 className="min-w-0 break-words text-sm font-semibold">{state.conversation.thread.subject}</h3>
            <p className="text-xs text-muted">{statusText(state.conversation.thread.status)}</p>
          </div>
          <div ref={scroller} className="min-h-24 overflow-y-auto overscroll-contain pr-1">
            <MessageList
              messages={state.conversation.messages}
              viewer="member"
              label="Conversation with support"
              empty="No messages yet. Write the first one below."
              before={
                state.conversation.olderCursor === null ? null : (
                  <Link href={allMessagesHref} className="self-center text-xs text-muted underline underline-offset-4 hover:text-foreground">
                    See earlier messages on the messages page
                  </Link>
                )
              }
            />
          </div>
          {state.conversation.thread.status === "closed" ? <p className="text-xs text-muted">{CLOSED_NOTE}</p> : null}
          <FailureAnnouncement failure={markFailure} className="text-xs" />
          <Composer
            key={state.conversation.thread.id}
            action={sendMessage}
            fields={{ threadId: state.conversation.thread.id }}
            label="Message to support"
            autoFocus={focusComposer}
            onSent={() => void load(state.conversation.thread.id)}
          />
          <button
            type="button"
            onClick={() => {
              setComposingNew(true);
              setFocusComposer(true);
            }}
            className={`self-start ${buttonClass("secondary", "xs")}`}
          >
            New conversation
          </button>
        </>
      ) : null}

      <p className="text-xs text-muted">{REPLY_TIME_NOTE}</p>
      <Link href={allMessagesHref} className="self-start text-sm underline underline-offset-4">
        Open all messages
      </Link>
    </div>
  );
}
