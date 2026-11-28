import { SUPPORT_INBOX_PATH, SUPPORT_THREAD_PARAM } from "@/lib/support/paths";
import type { OperatorListView, SupportThreadStatus } from "@/lib/support/views";

/*
 * What the support inbox's (#680) Server Components and client components share: the addresses
 * within it, so both write the query the page reads, and the words for a member and a status.
 * Plain module: no client or server directive, so either side can call it.
 */

/** The query parameter that picks the list: `active` (the default, left out) or `closed`. */
export const INBOX_VIEW_PARAM = "view";

/** The query parameter carrying a list page's cursor. */
export const INBOX_CURSOR_PARAM = "cursor";

export type InboxLocation = Readonly<{
  view: OperatorListView;
  cursor: string | null;
  threadId: string | null;
}>;

/** The inbox at `location`: a list, one page of it, and the open conversation. */
export function inboxHref({ view, cursor, threadId }: InboxLocation): string {
  const query = new URLSearchParams();
  if (view !== "active") query.set(INBOX_VIEW_PARAM, view);
  if (cursor !== null) query.set(INBOX_CURSOR_PARAM, cursor);
  if (threadId !== null) query.set(SUPPORT_THREAD_PARAM, threadId);
  const search = query.toString();
  return search === "" ? SUPPORT_INBOX_PATH : `${SUPPORT_INBOX_PATH}?${search}`;
}

/** The element id of a conversation's row in the list, where focus returns after Back. */
export function threadRowId(threadId: string): string {
  return `support-thread-${threadId}`;
}

/** What operators see as a member's name: their name, else their email, else a placeholder. */
export function memberDisplayName(member: Readonly<{ name: string | null; email: string | null }>): string {
  return member.name ?? member.email ?? "Unnamed user";
}

/** A conversation's status in an operator's words: who it waits on. */
export const OPERATOR_STATUS_LABELS: Readonly<Record<SupportThreadStatus, string>> = {
  open: "Needs a reply",
  replied: "Replied",
  closed: "Closed",
};
