/*
 * The one definition of "unread" for a support thread (#680), shared by the server, which derives
 * each row's flag, and the browser, which compares markers to decide whether a hint needs a reload.
 * The list and count functions in 20261128120300_support_chat_functions.sql make the same
 * comparison in SQL: a side has unread activity when the thread's last_message_at is after that
 * side's read marker, and a side that never opened the thread has everything unread.
 *
 * Timestamps are compared in microseconds, the precision Postgres stores. Date.parse stops at
 * milliseconds, so two instants within one millisecond would compare equal and a message written
 * just after a read marker would count as read (BackTalk src/lib/feedback/unread.ts).
 */

const FRACTION = /\.(\d+)/;

/**
 * An ISO 8601 timestamp as microseconds since the epoch, or NaN when it cannot be read. The
 * fraction is normalized to six digits, so "…:00.5Z" and "…:00.500000+00:00" are the same instant.
 */
export function instantMicros(iso: string): number {
  const fraction = FRACTION.exec(iso);
  const digits = (fraction?.[1] ?? "").padEnd(6, "0").slice(0, 6);
  const withMillis = fraction === null ? iso : iso.replace(fraction[0], `.${digits.slice(0, 3)}`);
  const millis = Date.parse(withMillis);
  if (Number.isNaN(millis)) return Number.NaN;
  return millis * 1000 + Number(digits.slice(3));
}

/** Whether `a` is strictly after `b`; false when either cannot be read. */
export function isAfter(a: string, b: string): boolean {
  return instantMicros(a) > instantMicros(b);
}

/**
 * Whether a side has unread activity in a thread: its last activity is after the side's read
 * marker. A side with no marker has never opened the thread, so the thread is unread for it. An
 * unreadable timestamp counts as read, so a bad value can never raise a badge that cannot be
 * cleared.
 */
export function isUnread(lastMessageAt: string, readAt: string | null): boolean {
  if (readAt === null) return !Number.isNaN(instantMicros(lastMessageAt));
  return isAfter(lastMessageAt, readAt);
}

/** "99+" at or past the count cap, the number below it, and nothing at zero. */
export function unreadBadgeLabel(count: number, cap: number): string | null {
  if (!Number.isFinite(count) || count <= 0) return null;
  return count >= cap ? `${cap - 1}+` : String(Math.floor(count));
}
