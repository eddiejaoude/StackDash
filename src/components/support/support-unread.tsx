"use client";

import { createContext, use, useState, type ReactNode } from "react";

import { UNREAD_COUNT_CAP } from "@/lib/support/limits";
import { unreadBadgeLabel } from "@/lib/support/unread";

/*
 * Support chat's unread counts in the app shell (#680): the member's own (the launcher and the
 * Messages link) and, for a super admin, the operator's (the Admin link). The shell starts the read
 * on the server without awaiting it (loadSupportShell) and hands the promise down; each badge
 * unwraps it with `use()` behind its own Suspense boundary, so the header never waits for a count.
 *
 * After that the counts change in the browser: a mark-read result, or a read after a Realtime hint
 * (GET /api/support/threads, GET /api/support/inbox/unread), sets the scope's count here. A set
 * belongs to the promise it was made against, so the next server render of the shell (a refresh, a
 * navigation that renders the layout again) brings a new promise and its numbers win, and a count
 * set earlier can never hide a newer one from the server. A null count is unknown: the badge keeps
 * what it showed.
 */

/** What the shell knows about the signed-in user for support chat, or null when nobody is signed in. */
export type SupportShell = Readonly<{
  userId: string;
  /** The member's threads with unread replies, or null when unknown. */
  memberUnread: number | null;
  /** A super admin's active threads with unread activity; null for anyone else, or when unknown. */
  operatorUnread: number | null;
}>;

export type UnreadScope = "member" | "operator";

type Counts = Readonly<Record<UnreadScope, number | null>>;

const NOTHING_SET: Counts = { member: null, operator: null };

type ShellState = Readonly<{
  shell: Promise<SupportShell | null>;
  /** Counts set in the browser since `setFor` was the shell's promise. */
  set: Counts;
  setFor: Promise<SupportShell | null>;
  setCount: (scope: UnreadScope, count: number | null) => void;
}>;

const ShellContext = createContext<ShellState | null>(null);

export function SupportShellProvider({ shell, children }: { shell: Promise<SupportShell | null>; children: ReactNode }) {
  const [state, setState] = useState<Readonly<{ setFor: Promise<SupportShell | null>; set: Counts }>>({ setFor: shell, set: NOTHING_SET });

  function setCount(scope: UnreadScope, count: number | null): void {
    if (count === null) return;
    setState((current) => {
      const base = current.setFor === shell ? current.set : NOTHING_SET;
      if (current.setFor === shell && base[scope] === count) return current;
      return { setFor: shell, set: { ...base, [scope]: count } };
    });
  }

  return <ShellContext value={{ shell, set: state.set, setFor: state.setFor, setCount }}>{children}</ShellContext>;
}

const NO_SHELL: Promise<SupportShell | null> = Promise.resolve(null);

/** The signed-in user's shell data; suspends until the server read arrives. Null outside the provider. */
export function useSupportShell(): SupportShell | null {
  return use(use(ShellContext)?.shell ?? NO_SHELL);
}

/** The scope's current count, null when unknown; suspends until the server read arrives. */
export function useUnreadCount(scope: UnreadScope): number | null {
  const state = use(ShellContext);
  const shell = use(state?.shell ?? NO_SHELL);
  if (state === null) return null;
  const set = state.setFor === state.shell ? state.set[scope] : null;
  return set ?? (scope === "member" ? shell?.memberUnread : shell?.operatorUnread) ?? null;
}

const ignore = (): void => {};

/** Hands a count the server answered to the badges; null keeps them as they are. A no-op outside the provider. */
export function useSetUnreadCount(): (scope: UnreadScope, count: number | null) => void {
  return use(ShellContext)?.setCount ?? ignore;
}

/**
 * The count read from an unread route's JSON body (`{ unreadCount }`), or null when it is unknown or
 * the body has any other shape. Narrowed by hand, so the shell's bundle carries no schema library.
 */
export function unreadCountFrom(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const count: unknown = Reflect.get(body, "unreadCount");
  return typeof count === "number" && Number.isFinite(count) ? count : null;
}

/**
 * The count as a pill, "2" or "99+", followed by `reads` for screen readers (" unread" unless the
 * place needs more words), so the number never rests on color or position alone. Nothing at zero
 * or when unknown. Put a space before it inside a link or button, so the accessible name reads
 * "Messages 2 unread".
 */
export function UnreadBadge({ count, reads = "unread" }: { count: number | null; reads?: string }) {
  const label = count === null ? null : unreadBadgeLabel(count, UNREAD_COUNT_CAP);
  if (label === null) return null;
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-accent px-1.5 text-xs font-semibold leading-5 text-background">
      {label}
      <span className="sr-only"> {reads}</span>
    </span>
  );
}

/** The scope's badge from the shell, for a parent that wraps it in Suspense. */
export function ShellUnreadBadge({ scope }: { scope: UnreadScope }) {
  return <UnreadBadge count={useUnreadCount(scope)} />;
}
