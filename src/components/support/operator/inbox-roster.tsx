import Link from "next/link";

import { formatRelative } from "@/lib/format";
import type { OperatorListView, OperatorThreadSummary } from "@/lib/support/views";

import { inboxHref, memberDisplayName, OPERATOR_STATUS_LABELS, threadRowId } from "./inbox";
import { InboxConnection, MemberOnline } from "./inbox-live";
import { MemberAvatar } from "./member-avatar";

/*
 * The support inbox's list (#680), rendered on the server: one page of conversations, unread
 * first, with the switch between active and closed ones and the links between pages. Each row is a
 * link that opens the conversation (`?thread=`), so a row can open in a new tab and the address
 * names what is open. Unread and online are said in words, never by color alone.
 */

const VIEWS: readonly Readonly<{ view: OperatorListView; label: string; heading: string }>[] = [
  { view: "active", label: "Active", heading: "Active conversations" },
  { view: "closed", label: "Closed", heading: "Closed conversations" },
];

export function InboxRoster({
  view,
  cursor,
  selectedThreadId,
  threads,
  nextCursor,
  headingId,
  now,
}: Readonly<{
  view: OperatorListView;
  cursor: string | null;
  selectedThreadId: string | null;
  threads: readonly OperatorThreadSummary[];
  nextCursor: string | null;
  headingId: string;
  now: Date;
}>) {
  const heading = VIEWS.find((entry) => entry.view === view)?.heading ?? "Conversations";
  const otherView = view === "active" ? "closed" : "active";

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <nav aria-label="Conversation views">
        <ul className="flex gap-2">
          {VIEWS.map((entry) => (
            <li key={entry.view}>
              <Link
                href={inboxHref({ view: entry.view, cursor: null, threadId: selectedThreadId })}
                scroll={false}
                aria-current={entry.view === view ? "page" : undefined}
                className={`inline-flex min-h-9 items-center rounded-md border px-3 py-1.5 text-sm transition-colors ${
                  entry.view === view
                    ? "border-accent bg-accent-soft font-medium text-foreground"
                    : "border-line-strong text-muted hover:text-foreground"
                }`}
              >
                {entry.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <div>
        <h2 id={headingId} tabIndex={-1} className="text-lg font-semibold tracking-tight">
          {heading}
        </h2>
        <InboxConnection />
      </div>

      {threads.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line-strong bg-panel px-4 py-6 text-sm">
          {cursor !== null ? (
            <>
              <p className="text-muted">No more conversations on this page.</p>
              <Link href={inboxHref({ view, cursor: null, threadId: null })} className="mt-3 inline-flex min-h-6 items-center underline underline-offset-4">
                Show the first page
              </Link>
            </>
          ) : (
            <>
              <p className="text-muted">
                {view === "active"
                  ? "No conversations need you right now. When someone writes to support, their conversation shows here."
                  : "No closed conversations yet. A conversation moves here when you close it."}
              </p>
              <Link
                href={inboxHref({ view: otherView, cursor: null, threadId: null })}
                className="mt-3 inline-flex min-h-6 items-center underline underline-offset-4"
              >
                {otherView === "closed" ? "Show closed conversations" : "Show active conversations"}
              </Link>
            </>
          )}
        </div>
      ) : (
        <ul aria-labelledby={headingId} className="flex flex-col divide-y divide-line overflow-hidden rounded-lg border border-line bg-panel">
          {threads.map((thread) => (
            <RosterRow
              key={thread.id}
              thread={thread}
              href={inboxHref({ view, cursor, threadId: thread.id })}
              selected={thread.id === selectedThreadId}
              now={now}
            />
          ))}
        </ul>
      )}

      {cursor === null && nextCursor === null ? null : (
        <nav aria-label="Conversation pages" className="flex flex-wrap gap-3">
          {cursor === null ? null : (
            <Link
              href={inboxHref({ view, cursor: null, threadId: selectedThreadId })}
              className="inline-flex min-h-9 items-center rounded-md border border-line-strong px-3 py-1.5 text-sm"
            >
              Show the first page
            </Link>
          )}
          {nextCursor === null ? null : (
            <Link
              href={inboxHref({ view, cursor: nextCursor, threadId: selectedThreadId })}
              className="inline-flex min-h-9 items-center rounded-md border border-line-strong px-3 py-1.5 text-sm"
            >
              Show the next page
            </Link>
          )}
        </nav>
      )}
    </section>
  );
}

function RosterRow({ thread, href, selected, now }: { thread: OperatorThreadSummary; href: string; selected: boolean; now: Date }) {
  const name = memberDisplayName(thread.member);
  const preview = thread.lastMessage === null ? null : thread.lastMessage.sender === "operator" ? `Support team: ${thread.lastMessage.preview}` : thread.lastMessage.preview;
  return (
    <li>
      <Link
        id={threadRowId(thread.id)}
        href={href}
        prefetch={false}
        scroll={false}
        aria-current={selected ? "true" : undefined}
        className={`flex gap-3 px-4 py-3 text-sm transition-colors hover:bg-panel-raised ${selected ? "bg-panel-raised" : ""}`}
      >
        <MemberAvatar url={thread.member.avatarUrl} size={32} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className={`truncate ${thread.unread ? "font-semibold" : "font-medium"}`}>{name}</span>
            {thread.unread ? (
              <span className="rounded-full bg-accent px-2 py-0.5 text-xs font-medium text-background">
                <Pause />
                Unread
              </span>
            ) : null}
            <MemberOnline userId={thread.member.userId} />
          </span>
          <span className="truncate text-foreground">
            <Pause />
            {thread.subject}
          </span>
          {preview === null ? null : (
            <span className="truncate text-muted">
              <Pause />
              {preview}
            </span>
          )}
          <span className="flex flex-wrap gap-x-2 text-xs text-muted">
            <span>
              <Pause />
              {OPERATOR_STATUS_LABELS[thread.status]}
            </span>
            <time dateTime={thread.lastMessageAt}>
              <Pause />
              {formatRelative(thread.lastMessageAt, now)}
            </time>
          </span>
        </span>
      </Link>
    </li>
  );
}

/** A comma only a screen reader hears, so a row's link name reads as a list rather than one run of words. */
function Pause() {
  return <span className="sr-only">, </span>;
}
