"use client";

import { useRouter } from "next/navigation";
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, useTransition, type ReactNode } from "react";

import { useOnlineMembers, useSupportChannel, type SupportChannelStatus } from "@/components/support/use-support-channel";
import { createRefreshScheduler, type RefreshScheduler } from "@/lib/realtime/refresh-scheduler";
import { SUPPORT_OPERATORS_TOPIC, type SupportActivity } from "@/lib/support/live";

import { threadRowId } from "./inbox";

/*
 * The support inbox's live layer (#680). It joins the operators' topic, tracking this operator's
 * presence there, and reads again through the server on every hint: the list by refreshing the
 * page (its Server Components read it), the open conversation by bumping `conversationSignal`,
 * which the conversation pane reloads on. Another operator's read changes nothing here, so its
 * hint is ignored; this operator's own read moves the list's unread marks. After a reconnect
 * everything is read again, since Broadcast does not replay what was missed.
 *
 * List refreshes go through the workspace pages' refresh scheduler (src/lib/realtime/
 * refresh-scheduler.ts): a burst of hints renders the page once, one refresh runs at a time, and a
 * hidden tab waits until it is shown. Presence for the members on screen comes from
 * useOnlineMembers, so each row and the open conversation can say "Online now" in words.
 */

type InboxLiveValue = Readonly<{
  online: ReadonlySet<string>;
  channelStatus: SupportChannelStatus;
  /** Changes whenever the open conversation must be read again. */
  conversationSignal: number;
  /** Reads the list again: after a reply, a status change, or a read. */
  refreshList: () => void;
  /** The open conversation's member, also watched for presence when the list does not show them. */
  watchMember: (userId: string | null) => void;
  /** True once the operator moved off the conversation the page opened on: a new one takes focus. */
  focusOnOpen: boolean;
}>;

const InboxLiveContext = createContext<InboxLiveValue | null>(null);

export function useInboxLive(): InboxLiveValue {
  const value = use(InboxLiveContext);
  if (value === null) throw new Error("useInboxLive must be used inside InboxLive");
  return value;
}

export function InboxLive({
  operatorId,
  memberIds,
  selectedThreadId,
  rosterHeadingId,
  children,
}: Readonly<{
  operatorId: string;
  /** The members of the list rows on screen. */
  memberIds: readonly string[];
  selectedThreadId: string | null;
  /** Where focus goes after Back when the conversation left has no row on this page. */
  rosterHeadingId: string;
  children: ReactNode;
}>) {
  // The router's own method, stable across renders, unlike the object around it.
  const { refresh } = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const scheduler = useRef<RefreshScheduler | null>(null);
  const [conversationSignal, setConversationSignal] = useState(0);
  const [watched, setWatched] = useState<string | null>(null);

  useEffect(() => {
    if (!refreshing) scheduler.current?.settled();
  }, [refreshing]);

  useEffect(() => {
    const next = createRefreshScheduler({
      refresh: () => {
        startRefresh(() => refresh());
        return true;
      },
      isPaused: () => document.visibilityState === "hidden",
    });
    scheduler.current = next;
    const onVisibility = () => next.pauseChanged();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      next.dispose();
      scheduler.current = null;
    };
  }, [refresh]);

  const refreshList = useCallback(() => scheduler.current?.notify(), []);

  const channelStatus = useSupportChannel({
    topic: SUPPORT_OPERATORS_TOPIC,
    presenceKey: operatorId,
    onActivity: (activity: SupportActivity) => {
      if (activity.kind === "read") {
        if (activity.operatorId === operatorId) refreshList();
        return;
      }
      refreshList();
      if (activity.threadId === selectedThreadId) setConversationSignal((signal) => signal + 1);
    },
    onReconnect: () => {
      refreshList();
      setConversationSignal((signal) => signal + 1);
    },
  });

  const online = useOnlineMembers(watched === null ? memberIds : [...memberIds, watched]);

  // A conversation opened from the list takes focus; the one the page opened on (a link from an
  // email, a reload) leaves focus at the start of the page. Adjusted during render, React's pattern
  // for state that follows a prop.
  const [openedWith] = useState(selectedThreadId);
  const [focusOnOpen, setFocusOnOpen] = useState(false);
  if (!focusOnOpen && selectedThreadId !== openedWith) setFocusOnOpen(true);

  // Back on a phone hides the conversation and shows the list again: focus returns to the row of
  // the conversation just left, or to the list's heading when that row is not on this page.
  const shownThread = useRef(selectedThreadId);
  useEffect(() => {
    const left = shownThread.current;
    shownThread.current = selectedThreadId;
    if (left === null || selectedThreadId !== null) return;
    (document.getElementById(threadRowId(left)) ?? document.getElementById(rosterHeadingId))?.focus();
  }, [selectedThreadId, rosterHeadingId]);

  const value = useMemo<InboxLiveValue>(
    () => ({ online, channelStatus, conversationSignal, refreshList, watchMember: setWatched, focusOnOpen }),
    [online, channelStatus, conversationSignal, refreshList, focusOnOpen],
  );
  return <InboxLiveContext value={value}>{children}</InboxLiveContext>;
}

/** "Online now" in words beside a dot for a member present on their topic; nothing otherwise. */
export function MemberOnline({ userId }: { userId: string }) {
  const { online } = useInboxLive();
  if (!online.has(userId)) return null;
  return (
    <span className="inline-flex items-center gap-1 text-xs text-success">
      <span className="sr-only">, </span>
      <span aria-hidden="true" className="size-2 rounded-full bg-success" />
      Online now
    </span>
  );
}

const CHANNEL_STATUS_TEXT: Record<SupportChannelStatus, string> = {
  connecting: "Connecting to live updates.",
  live: "Live: new messages appear as they arrive.",
  offline: "Live updates paused. Reconnecting, then this inbox reloads.",
};

/** Whether the inbox is receiving live updates, in words. */
export function InboxConnection() {
  const { channelStatus } = useInboxLive();
  return <p className="text-xs text-muted">{CHANNEL_STATUS_TEXT[channelStatus]}</p>;
}
