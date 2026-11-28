"use client";

import Image from "next/image";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { LiveRegion } from "@/components/ui/live-region";
import { formatDateTime } from "@/lib/format";
import { formatMegabytes } from "@/lib/support/attachments";
import type { SupportMessageView } from "@/lib/support/views";

/*
 * A support conversation (#680), for the user's screens and the operators' alike. Messages render as
 * text with their line breaks kept (`whitespace-pre-wrap`), never as HTML. A message that arrives
 * after the list first renders is announced politely, once, by who wrote it and how it starts; the
 * list itself is not a live region, so a reload never reads the whole conversation aloud.
 */

/** Who the viewer is: the user who owns the conversation, or an operator answering it. */
export type ConversationViewer = "member" | "operator";

export type MessageListProps = Readonly<{
  messages: readonly SupportMessageView[];
  viewer: ConversationViewer;
  /** The accessible name of the list, such as "Conversation with support". */
  label: string;
  /** What operators see as the user's name; the user sees "You". */
  memberName?: string;
  /** Shown when there are no messages: say what to do first. */
  empty?: ReactNode;
  /** A control above the oldest message, such as a button that loads older messages. */
  before?: ReactNode;
}>;

const ANNOUNCE_CHARS = 120;

function senderName(message: SupportMessageView, viewer: ConversationViewer, memberName: string): string {
  if (message.sender === "user") return viewer === "member" ? "You" : memberName;
  return viewer === "operator" ? "Support team" : "Support";
}

export function MessageList({ messages, viewer, label, memberName = "The user", empty, before }: MessageListProps) {
  // Ids rendered before, to announce only what arrives later. Null until the first render is in.
  const shown = useRef<ReadonlySet<string> | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => {
    const previous = shown.current;
    shown.current = new Set(messages.map((message) => message.id));
    if (previous === null) return;
    // Only what follows the newest message already shown arrived: an older page loaded above the
    // list is not new, and announcing it would read out history as if it had just been written.
    const lastShown = messages.findLastIndex((message) => previous.has(message.id));
    const arrived = messages.slice(lastShown + 1).filter((message) => !previous.has(message.id));
    const newest = arrived.at(-1);
    if (newest === undefined) return;
    const start = [...newest.body].slice(0, ANNOUNCE_CHARS).join("");
    const more = arrived.length > 1 ? `${arrived.length} new messages. The newest, from` : "New message from";
    setAnnouncement(`${more} ${senderName(newest, viewer, memberName)}: ${start}${start.length < newest.body.length ? "…" : ""}`);
  }, [messages, viewer, memberName]);

  return (
    <section aria-label={label} className="flex flex-col gap-3">
      {before}
      {messages.length === 0 ? (
        <div className="text-sm text-muted">{empty}</div>
      ) : (
        <ol className="flex flex-col gap-3">
          {messages.map((message) => {
            const own = (message.sender === "user") === (viewer === "member");
            const name = senderName(message, viewer, memberName);
            return (
              <li
                key={message.id}
                className={`flex max-w-[85%] flex-col gap-1 rounded-lg border px-3 py-2 ${
                  own ? "self-end border-line-strong bg-panel-raised" : "self-start border-line bg-panel"
                }`}
              >
                <p className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
                  <span className="font-medium text-foreground">{name}</span>
                  <time dateTime={message.createdAt}>{formatDateTime(message.createdAt)}</time>
                </p>
                <p className="whitespace-pre-wrap break-words text-sm">{message.body}</p>
                {message.attachments.length === 0 ? null : (
                  <ul className="flex flex-wrap gap-2" aria-label={`${message.attachments.length === 1 ? "1 image" : `${message.attachments.length} images`} from ${name}`}>
                    {message.attachments.map((attachment, index) => (
                      <li key={attachment.id}>
                        {attachment.url === null ? (
                          <span className="text-xs text-muted">
                            {attachment.filename} ({formatMegabytes(attachment.bytes)}) cannot be shown right now. Reload to try again.
                          </span>
                        ) : (
                          <a
                            href={attachment.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block rounded-md border border-line focus-visible:outline-2 focus-visible:outline-accent"
                          >
                            {/* Signed URLs expire and change per read, so the image optimizer has nothing to cache. */}
                            <Image
                              src={attachment.url}
                              unoptimized
                              width={96}
                              height={96}
                              alt={`Image ${index + 1} of ${message.attachments.length} from ${name}. Opens full size in a new tab.`}
                              className="size-24 rounded-md object-cover"
                            />
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
      <LiveRegion tone="status" className="sr-only">
        {announcement}
      </LiveRegion>
    </section>
  );
}
