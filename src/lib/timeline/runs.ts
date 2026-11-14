import { londonDate } from "./days";

/**
 * Bursts of identical events collapse into one timeline row (#253). Two neighboring events join
 * the same run when they share provider, type, severity, and account (the connection when the
 * event has no account), fall on the same London day, and happen at most this far apart.
 */
export const EVENT_RUN_GAP_MS = 5 * 60 * 1000;

type RunnableEvent = {
  id: string;
  /** Null for StackDash's own events, such as a sync failure. */
  provider: string | null;
  type_id: string;
  severity: string;
  occurred_at: string;
  external_account_id: string | null;
  connection_id: string | null;
};

/** One or more consecutive identical events, newest first. */
export type EventRun<T> = readonly [T, ...T[]];

function sameSource(a: RunnableEvent, b: RunnableEvent): boolean {
  return (
    a.provider === b.provider &&
    a.type_id === b.type_id &&
    a.severity === b.severity &&
    a.external_account_id === b.external_account_id &&
    (a.external_account_id !== null || a.connection_id === b.connection_id)
  );
}

/**
 * Consecutive identical events grouped into runs, keeping the order given (newest first). Only
 * neighbors are compared, so any other event in between breaks a run, and a gap is measured
 * between neighbors rather than from the run's first event: a run gains or loses an event only at
 * its ends. A live refresh adds events at the top of the page and drops them at the bottom, so it
 * only ever changes the first and last runs.
 */
export function groupEventRuns<T extends RunnableEvent>(events: readonly T[]): EventRun<T>[] {
  const runs: [T, ...T[]][] = [];
  for (const event of events) {
    const run = runs.at(-1);
    const previous = run?.at(-1);
    if (
      run !== undefined &&
      previous !== undefined &&
      sameSource(previous, event) &&
      Math.abs(Date.parse(previous.occurred_at) - Date.parse(event.occurred_at)) <= EVENT_RUN_GAP_MS &&
      londonDate(new Date(previous.occurred_at)) === londonDate(new Date(event.occurred_at))
    ) {
      run.push(event);
      continue;
    }
    runs.push([event]);
  }
  return runs;
}
