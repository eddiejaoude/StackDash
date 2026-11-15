import { createHash, randomUUID } from "node:crypto";

import { SIMULATE_PROVIDERS_ENV } from "@/lib/adapters/simulated";
import { DAY_MS, SLOT_MS } from "@/lib/adapters/simulated/simulation";
import { headlineWindows } from "@/lib/dashboard/headline";
import { isLoopbackUrl } from "@/lib/env";
import { dailySummaryJobKey, runDailySummaryJob } from "@/lib/jobs/daily-summary";
import { utcDate } from "@/lib/jobs/ingest";
import type { ClaimedJob } from "@/lib/jobs/store";
import { runSyncJob, type JobOutcome, type SyncDeps } from "@/lib/jobs/sync-connection";
import { londonDate } from "@/lib/timeline/days";
import { londonDayStart } from "@/lib/timeline/query";

/*
 * The 90 day history behind the demo workspace (#166). The simulated providers (#131) make up every
 * value from the clock, so the history is built by moving the clock, not by writing rows: one
 * step per London day, each running the same job code as a live tick (`runSyncJob` with its
 * validation, ingest, and alert evaluation, then `runDailySummaryJob`) with `now` set to that day.
 * The demo therefore cannot show anything the real pipeline would reject.
 */

export const DEMO_HISTORY_DAYS = 90;

/**
 * Why a demo command (`npm run demo`, `npm run demo:seed`, `npm run demo:event`) must not run
 * here, or null when it may. They write only with simulation on (the same check the app uses,
 * which already refuses a Vercel production deployment) and only to a Supabase stack on this
 * computer, so they can never touch a remote project. The `/auth/confirm` route applies the same
 * check before it accepts the demo account's one-time sign-in link, so the link works only where
 * the commands that print it can run.
 */
export function demoCommandRefusal(input: Readonly<{ simulationEnabled: boolean; supabaseUrl: string | undefined }>): string | null {
  if (!input.simulationEnabled) {
    return `Provider simulation is off. Set ${SIMULATE_PROVIDERS_ENV}=1 in .env.local and run the command again.`;
  }
  if (input.supabaseUrl === undefined || input.supabaseUrl.trim() === "") {
    return "NEXT_PUBLIC_SUPABASE_URL is not set. Start the local Supabase stack and copy its URL into .env.local.";
  }
  if (!isLoopbackUrl(input.supabaseUrl)) {
    return "NEXT_PUBLIC_SUPABASE_URL is not a Supabase stack on this computer. The demo commands only write to a local stack (localhost or 127.0.0.1).";
  }
  return null;
}

/** The seed text `npm run demo` and `npm run demo:seed` use when `--seed` is not given. */
export const DEMO_SEED_TEXT = "stackdash-demo";

/**
 * The seed a simulated provider derives its accounts from, fixed by the demo seed text so a
 * rehearsed demo shows the same accounts, projects, and launch days every time.
 */
export function demoAccountSeed(seed: string, provider: string): string {
  return createHash("sha256").update(`${seed}\u0000${provider}`).digest("hex").slice(0, 8);
}

export type HistoryStep = Readonly<{
  at: Date;
  /** The day this step closes, the same date in London and in UTC at `at`, whose daily summary runs after its syncs; null for today. */
  summaryDate: string | null;
}>;

/**
 * The replay clock: for each of the `days` London days before the one `now` falls on, oldest
 * first, the last 10 second slot before that day ends, then `now`. London runs on UTC or one hour
 * ahead, so that instant is always late in the same UTC day: its snapshot carries the day's totals
 * under the day's date, and the half hour of events a step reads lands on the same day on the
 * timeline, which groups by London days. Counting back from the London date, not the UTC one,
 * keeps the day that just ended when the seed runs after London midnight but before UTC midnight.
 * The step at `now` leaves every cursor where `npm run jobs:tick -- --watch` continues from.
 */
export function historySteps(now: Date, days: number = DEMO_HISTORY_DAYS): HistoryStep[] {
  // The London date of `now` as a UTC midnight, so whole days can be counted back in milliseconds.
  const today = Date.parse(`${londonDate(now)}T00:00:00Z`);
  const steps: HistoryStep[] = [];
  for (let back = days; back >= 1; back -= 1) {
    const nextDay = utcDate(new Date(today - (back - 1) * DAY_MS));
    const at = new Date(londonDayStart(nextDay).getTime() - SLOT_MS);
    steps.push({ at, summaryDate: utcDate(at) });
  }
  steps.push({ at: now, summaryDate: null });
  return steps;
}

/**
 * How many London days `historySteps` must replay so the dashboard headline's week to date (#173,
 * UTC, Monday first) has figures: every day since the week started, plus the day before it, whose
 * reading of each running billing period total is what the window's first day is measured from
 * (without it, that day's change would span the window edge and leave every provider
 * unavailable). 1 on a Monday, 7 on a Sunday. When London is already on the next day (the first
 * hour of a summer day), one more day is counted, so no UTC day is missed.
 */
export function headlineWeekDays(now: Date): number {
  const weekStart = Date.parse(`${headlineWindows("week", now).current.start}T00:00:00Z`);
  return Math.round((Date.parse(`${londonDate(now)}T00:00:00Z`) - weekStart) / DAY_MS) + 1;
}

/**
 * The live job dependencies with every clock (the jobs' and the adapters') reading one movable
 * clock that starts at `start`, and the `setNow` that moves it, for `replayHistory`.
 */
export function replayClock(live: SyncDeps, start: Date): Pick<ReplayInput, "deps" | "setNow"> {
  let clock = start;
  return {
    deps: {
      ...live,
      now: () => clock,
      createOAuthContext: (client) => ({ ...live.createOAuthContext(client), now: () => clock }),
    },
    setNow: (at) => {
      clock = at;
    },
  };
}

export type ReplayInput = Readonly<{
  /** Live job dependencies whose `now`, and whose adapter context's `now`, read the replay clock. */
  deps: SyncDeps;
  setNow: (at: Date) => void;
  workspaceId: string;
  connectionIds: readonly string[];
  steps: readonly HistoryStep[];
  onStep?: (step: HistoryStep, index: number) => void;
}>;

/**
 * A job as `claim_sync_jobs` would hand it over, on its one and only attempt. The demo commands
 * run their jobs directly and never retry: a failure stops the seed instead of leaving a gap in
 * the history, and `npm run demo:event` reports it.
 */
export function oneShotJob(fields: Pick<ClaimedJob, "kind" | "workspace_id" | "connection_id" | "dedupe_key">, at: Date): ClaimedJob {
  return { id: randomUUID(), attempts: 1, max_attempts: 1, created_at: at.toISOString(), webhook_delivery_id: null, ...fields };
}

function check(outcome: JobOutcome, what: string, at: Date): void {
  if (outcome.status === "succeeded") return;
  const reference = outcome.errorReference === null ? "" : `, reference ${outcome.errorReference}`;
  throw new Error(`The demo history stopped at ${at.toISOString()}: ${what} failed (${outcome.errorCode}${reference}).`);
}

/** Runs every step: each connection syncs at the step's instant, then the day it closes is summarized. */
export async function replayHistory(input: ReplayInput): Promise<void> {
  const { deps, workspaceId } = input;
  for (const [index, step] of input.steps.entries()) {
    input.setNow(step.at);
    // Different connections never share a cursor, so they sync side by side as on a live tick.
    const outcomes = await Promise.all(
      input.connectionIds.map((connectionId) =>
        runSyncJob(oneShotJob({ kind: "sync", workspace_id: workspaceId, connection_id: connectionId, dedupe_key: null }, step.at), deps),
      ),
    );
    for (const outcome of outcomes) check(outcome, "a sync", step.at);

    if (step.summaryDate !== null) {
      const job = oneShotJob(
        {
          kind: "daily_summary",
          workspace_id: workspaceId,
          connection_id: null,
          dedupe_key: dailySummaryJobKey(workspaceId, step.summaryDate),
        },
        step.at,
      );
      check(await runDailySummaryJob(job, deps), "the daily summary", step.at);
    }
    input.onStep?.(step, index);
  }
}
