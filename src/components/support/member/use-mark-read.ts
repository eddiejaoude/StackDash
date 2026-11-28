"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";

import { markThreadRead } from "@/app/account/messages/actions";
import type { MarkThreadReadResult, SupportFailure } from "@/lib/support/views";

import { markReadForm, type MemberConversation } from "./conversation";

const CONNECTION_FAILED: SupportFailure = {
  ok: false,
  message: "This conversation could not be marked as read because the connection failed. It stays marked as new until you open it again.",
};

/**
 * Marks the member's conversation read through its `seenThrough` once it is on screen (`visible`),
 * once per newest read, and hands the fresh unread count to `onRead`. Answers the latest failure,
 * for an assertive region, or null.
 */
export function useMarkRead({
  conversation,
  visible,
  onRead,
}: Readonly<{
  conversation: MemberConversation | null;
  visible: boolean;
  onRead: (threadId: string, unreadCount: number | null) => void;
}>): SupportFailure | null {
  const [failure, setFailure] = useState<SupportFailure | null>(null);
  const marked = useRef<string | null>(null);

  // The action's answer lands in a callback, like any external system's.
  const settle = useEffectEvent((threadId: string, result: MarkThreadReadResult) => {
    if (!result.ok) {
      // The next read of this conversation tries again.
      marked.current = null;
      setFailure(result);
      return;
    }
    setFailure(null);
    onRead(threadId, result.unreadCount);
  });

  const mark = useEffectEvent((shown: MemberConversation) => {
    const form = markReadForm(shown);
    if (form === null) return;
    const key = `${shown.thread.id}:${shown.seenThrough ?? ""}`;
    if (marked.current === key) return;
    marked.current = key;
    markThreadRead(null, form).then(
      (result) => settle(shown.thread.id, result),
      () => settle(shown.thread.id, CONNECTION_FAILED),
    );
  });

  useEffect(() => {
    if (visible && conversation !== null) mark(conversation);
  }, [visible, conversation]);

  return failure;
}
