import { londonDayStart, TIMELINE_TIME_ZONE } from "./query";

// en-CA writes a date as YYYY-MM-DD, the house date format.
const LONDON_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMELINE_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const LONDON_WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: TIMELINE_TIME_ZONE, weekday: "long" });

/** The London calendar date (`YYYY-MM-DD`) an instant falls on. */
function londonDate(at: Date): string {
  return LONDON_DATE.format(at);
}

export type EventDay<T> = {
  /** "Today", "Yesterday", or "Monday, 2026-06-15". */
  label: string;
  /** London calendar date, `YYYY-MM-DD`. */
  date: string;
  events: T[];
};

/**
 * Events split into London calendar days, the same days the date filter uses. The events arrive
 * newest first and keep that order; a new group starts whenever the day changes, so the groups
 * read newest first too.
 */
export function groupEventsByDay<T extends { occurred_at: string }>(events: readonly T[], now: Date): EventDay<T>[] {
  const today = londonDate(now);
  // One millisecond before today began, not 24 hours ago: a clock-change day is 23 or 25 hours.
  const yesterday = londonDate(new Date(londonDayStart(today).getTime() - 1));
  const days: EventDay<T>[] = [];
  for (const event of events) {
    const at = new Date(event.occurred_at);
    const date = londonDate(at);
    const current = days.at(-1);
    if (current?.date === date) {
      current.events.push(event);
      continue;
    }
    const label =
      date === today ? "Today" : date === yesterday ? "Yesterday" : `${LONDON_WEEKDAY.format(at)}, ${date}`;
    days.push({ label, date, events: [event] });
  }
  return days;
}
