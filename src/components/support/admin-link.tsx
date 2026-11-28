"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef } from "react";

import { SUPPORT_OPERATORS_TOPIC } from "@/lib/support/live";

import { UnreadBadge, unreadCountFrom, useSetUnreadCount, useSupportShell, useUnreadCount } from "./support-unread";
import { useSupportChannel } from "./use-support-channel";

/*
 * The header's Admin link for a super admin (#364), with the support inbox's unread count (#680).
 * The server renders it for a super admin only and passes the path, so nobody else's page or this
 * shared module carries it. The count comes from the shell's SupportShellProvider; the operators'
 * Realtime channel, joined here with the operator's presence, reads it again after each hint
 * (GET /api/support/inbox/unread). A read by another operator changes only their own count, so its
 * hint is ignored.
 */

export function AdminLink({ href, className }: Readonly<{ href: string; className: string }>) {
  return (
    <Link href={href} className={className}>
      Admin
      <Suspense fallback={null}>
        <OperatorBadge />
      </Suspense>
    </Link>
  );
}

function OperatorBadge() {
  const shell = useSupportShell();
  return shell === null ? null : <LiveOperatorBadge operatorId={shell.userId} />;
}

function LiveOperatorBadge({ operatorId }: Readonly<{ operatorId: string }>) {
  const count = useUnreadCount("operator");
  const setUnread = useSetUnreadCount();
  const countRead = useRef<AbortController | null>(null);

  async function readCount(): Promise<void> {
    countRead.current?.abort();
    const controller = new AbortController();
    countRead.current = controller;
    let fresh: number | null = null;
    try {
      const response = await fetch("/api/support/inbox/unread", { signal: controller.signal, cache: "no-store" });
      if (response.ok) fresh = unreadCountFrom(await response.json());
    } catch {
      // A failed or cancelled read leaves the badge as it is (null below), as an unknown count does.
    }
    if (!controller.signal.aborted) setUnread("operator", fresh);
  }

  useEffect(() => () => countRead.current?.abort(), []);

  useSupportChannel({
    topic: SUPPORT_OPERATORS_TOPIC,
    presenceKey: operatorId,
    onActivity: (activity) => {
      if (activity.kind === "read" && activity.operatorId !== operatorId) return;
      void readCount();
    },
    onReconnect: () => void readCount(),
  });

  return (
    <>
      {" "}
      <UnreadBadge count={count} reads="unread in the support inbox" />
    </>
  );
}
