import { useId } from "react";

import { AlertIcon } from "@/components/icons";
import { capNotice, capNoticeText, type CappedRead } from "@/lib/dashboard/aggregate";

/**
 * The dashboard's one notice when a snapshot read stopped at its row cap (#336), in place of a line
 * on every card: which parts leave out older readings, and from which day each is whole. Nothing
 * when every part is whole. Laid out like the stale notice (#267); the warning is in words and an
 * icon, never in color alone. It has nothing to operate, so it adds no stop to the keyboard order.
 */
export function CapNotice({ reads }: { reads: readonly CappedRead[] }) {
  const titleId = useId();
  const notice = capNotice(reads);
  if (notice === null) return null;
  const { title, body } = capNoticeText(notice);
  return (
    <section aria-labelledby={titleId} className="mt-6 rounded-xl border border-warning/50 bg-panel px-5 py-4 text-sm">
      <h2 id={titleId} className="flex items-center gap-2 font-semibold text-warning">
        <AlertIcon className="shrink-0" width={14} height={14} />
        {title}
      </h2>
      <p className="mt-1 max-w-3xl leading-6 text-muted">{body}</p>
    </section>
  );
}
