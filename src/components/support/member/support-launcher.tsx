"use client";

import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { Suspense, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { CloseIcon } from "@/components/icons";
import { supportUserTopic } from "@/lib/support/live";

import { UnreadBadge, unreadCountFrom, useSetUnreadCount, useSupportShell, useUnreadCount } from "../support-unread";
import { useSupportChannel } from "../use-support-channel";

/*
 * The support launcher (#680): a button fixed in the corner of every signed-in app page (the
 * workspace shell and /account; the messages page has its own screen), with the member's unread
 * count. It opens a non-modal panel whose content (launcher-panel.tsx) loads with next/dynamic on
 * the first open, so the bundle every app page shares holds only this file and the channel.
 * Escape closes the panel and puts focus back on the button; a press outside closes it and leaves
 * focus alone; a navigation closes it.
 *
 * It also holds the member's own Realtime channel for as long as the shell shows it, tracking
 * presence there, which is how operators see the member online and how reply email knows to wait.
 * A hint reads the badge count again (GET /api/support/threads); once the panel has loaded, the
 * panel reads it with the conversation it shows, so one hint costs one round of reads.
 */

const LauncherPanel = dynamic(() => import("./launcher-panel").then((module) => module.LauncherPanel), {
  ssr: false,
  loading: () => <p className="text-sm text-muted">Loading your conversation</p>,
});

/** The launcher, once the shell's support read has arrived; nothing for a signed-out visitor. */
export function SupportLauncher() {
  return (
    <Suspense fallback={null}>
      <ShellLauncher />
    </Suspense>
  );
}

function ShellLauncher() {
  const shell = useSupportShell();
  return shell === null ? null : <Launcher userId={shell.userId} />;
}

function Launcher({ userId }: Readonly<{ userId: string }>) {
  const pathname = usePathname();
  const unread = useUnreadCount("member");
  const setUnread = useSetUnreadCount();
  const [open, setOpen] = useState(false);
  // The panel stays mounted once loaded, hidden while closed, so a draft survives closing it.
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const panelId = useId();
  const headingId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const countRead = useRef<AbortController | null>(null);

  // The shell outlives navigations between its pages; the panel belongs to the page it opened on.
  const [openedOn, setOpenedOn] = useState(pathname);
  if (pathname !== openedOn) {
    setOpenedOn(pathname);
    setOpen(false);
  }

  async function readCount(): Promise<void> {
    countRead.current?.abort();
    const controller = new AbortController();
    countRead.current = controller;
    let count: number | null = null;
    try {
      const response = await fetch("/api/support/threads", { signal: controller.signal, cache: "no-store" });
      if (response.ok) count = unreadCountFrom(await response.json());
    } catch {
      // A failed or cancelled read leaves the badge as it is (null below), as an unknown count does.
    }
    if (!controller.signal.aborted) setUnread("member", count);
  }

  useEffect(() => () => countRead.current?.abort(), []);

  function readAgain(): void {
    if (loaded) setRevision((value) => value + 1);
    else void readCount();
  }

  useSupportChannel({
    topic: supportUserTopic(userId),
    presenceKey: userId,
    // A read (in another tab) changes only the count; a message or a status change the conversation too.
    onActivity: (activity) => (activity.kind === "read" ? void readCount() : readAgain()),
    onReconnect: readAgain,
  });

  // Opening moves focus into the panel, so a screen reader hears its name and Tab goes on from there.
  useEffect(() => {
    if (open) panelRef.current?.focus();
  }, [open]);

  // A press outside closes the panel and leaves focus where the press put it.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent): void {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function close(): void {
    setOpen(false);
    buttonRef.current?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "Escape" || !open) return;
    event.preventDefault();
    close();
  }

  return (
    // Under the sticky header (z-40) and dialogs; the phone's safe area keeps it off the home bar.
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      className="fixed bottom-4 right-4 z-30 flex flex-col-reverse items-end gap-3 pb-[env(safe-area-inset-bottom)] sm:bottom-6 sm:right-6"
    >
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={loaded ? panelId : undefined}
        onClick={() => {
          setOpen((value) => !value);
          setLoaded(true);
        }}
        className="inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full border border-line-strong bg-panel-raised px-3 text-sm font-medium shadow-lg shadow-black/30 transition-colors hover:border-accent sm:px-4"
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
        <span className="sr-only sm:not-sr-only">Message support</span> <UnreadBadge count={unread} />
      </button>

      {loaded ? (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-labelledby={headingId}
          tabIndex={-1}
          hidden={!open}
          className="flex max-h-[min(36rem,calc(100dvh-7rem))] w-[min(24rem,calc(100vw-2rem))] flex-col gap-3 rounded-xl border border-line bg-panel p-4 shadow-2xl shadow-black/40 focus-visible:outline-none"
        >
          <div className="flex items-center justify-between gap-3">
            <h2 id={headingId} className="text-base font-semibold">
              Chat with support
            </h2>
            <button
              type="button"
              onClick={close}
              aria-label="Close support chat"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:text-foreground"
            >
              <CloseIcon />
            </button>
          </div>
          <LauncherPanel open={open} revision={revision} />
        </div>
      ) : null}
    </div>
  );
}
