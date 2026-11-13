import { formatDateTime, formatLondonHourMinute, formatRelative } from "@/lib/format";

/**
 * When an event happened: the absolute London time people can quote, then how long ago. Rendered
 * only on the server (no hydration), so the server's ICU data decides the wording. The gutter shows
 * hours and minutes (#385); the date, the zone, and the exact instant stay in its accessible text,
 * its tooltip, and its `dateTime`.
 */
export function EventTime({ occurredAt, now, gutter = false }: { occurredAt: string; now: Date; gutter?: boolean }) {
  const at = new Date(occurredAt);
  const absolute = formatDateTime(at);
  if (gutter) {
    return (
      <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-xs tabular-nums text-muted lg:flex-col lg:items-end">
        <time dateTime={at.toISOString()} title={absolute} className="text-foreground">
          <span className="sr-only">{absolute}</span>
          <span aria-hidden="true">{formatLondonHourMinute(at)}</span>
        </time>
        <span>{formatRelative(at, now)}</span>
      </span>
    );
  }
  return (
    <span className="font-mono text-[11px] tabular-nums text-muted">
      <time dateTime={at.toISOString()}>{absolute}</time>
      <span aria-hidden="true"> · </span>
      <span className="sr-only">, </span>
      <span>{formatRelative(at, now)}</span>
    </span>
  );
}
