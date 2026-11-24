import "server-only";

import { laterCompleteFrom } from "@/lib/dashboard/aggregate";
import type { DateRange, EventCount, HeadlineEvents, HeadlineEventTypes, HeadlineWindows } from "@/lib/dashboard/headline";
import { applyScope, type ScopeFilters } from "@/lib/filters/scope";
import { createClient } from "@/lib/supabase/server";

import { getWorkspaceScope, loadSnapshots, type SnapshotRead } from "./dashboard";

const DAY_MS = 86_400_000;

/**
 * The snapshot rows the headline's money and daily signup totals read, narrowed to `scope`: the
 * money kinds and the declared daily totals, from the day before the previous window (that day's
 * reading is where the window's first amount starts) to today. Read on their own rather than
 * from the trend history, so the allowance and usage rows that make up most of a busy workspace's
 * history do not count toward the read cap. The cap still applies (`loadSnapshots`, 10,000 rows
 * each, newest first): past it the oldest days are left out, so the previous window is named
 * unavailable and the figures lose their comparison, with a `dashboard.snapshots_truncated`
 * warning. `completeFrom` is then the later of the two reads' first whole days, which the
 * dashboard's notice names (#336). Call only after `requireWorkspace` has confirmed membership.
 */
export async function getHeadlineSnapshots(
  workspaceId: string,
  scope: ScopeFilters,
  windows: HeadlineWindows,
  eventTypes: HeadlineEventTypes,
): Promise<SnapshotRead> {
  const since = new Date(Date.parse(`${windows.previous.start}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10);
  const [workspaceScope, money, dailyTotals] = await Promise.all([
    getWorkspaceScope(workspaceId),
    loadSnapshots(workspaceId, since, "headline money", { kinds: ["revenue", "verified_spend", "estimated_spend"] }),
    eventTypes.signupDailyTotals.length === 0
      ? { rows: [], completeFrom: null }
      : loadSnapshots(workspaceId, since, "headline signups", { kinds: ["usage"], metricKeys: eventTypes.signupDailyTotals }),
  ]);
  return {
    rows: applyScope({ ...workspaceScope, snapshots: [...money.rows, ...dailyTotals.rows] }, scope).snapshots,
    completeFrom: laterCompleteFrom(money.completeFrom, dailyTotals.completeFrom),
  };
}

/**
 * Signup and deploy counts per connection and event type for both headline windows, and each
 * connection's oldest reading, for the included accounts the scope leaves in view. One
 * `headline_event_counts` call per window, each summing the daily event rollup behind one
 * membership check and returning at most one row per connection and type, and one
 * `headline_first_readings` call for every connection's oldest reading on or before the current
 * window's first day, all run together. The rollup's days are UTC days, as the windows' are, so a
 * window's count is the same as counting its events. The oldest reading is read on its own rather
 * than from the trend history, whose newest first page cap would otherwise move it forward in a
 * busy workspace. Call only after `requireWorkspace` has confirmed membership.
 */
export async function getHeadlineEvents(
  workspaceId: string,
  scope: ScopeFilters,
  windows: HeadlineWindows,
  eventTypes: HeadlineEventTypes,
): Promise<HeadlineEvents> {
  const { accounts } = applyScope({ ...(await getWorkspaceScope(workspaceId)), snapshots: [] }, scope);
  if (accounts.length === 0) return { current: [], previous: [], firstReadings: new Map() };
  const accountIds = accounts.map((account) => account.id);
  const supabase = await createClient();
  const count = async (range: DateRange): Promise<EventCount[]> => {
    const { data, error } = await supabase.rpc("headline_event_counts", {
      p_workspace_id: workspaceId,
      p_account_ids: accountIds,
      p_type_ids: [...eventTypes.signups, ...eventTypes.deploys],
      p_start: range.start,
      p_end: range.end,
    });
    if (error) throw new Error("Failed to count activity events", { cause: error });
    return data;
  };
  // Only "on or before the current window's first day" matters, so later readings are not read.
  const firstReadings = async (): Promise<Map<string, string>> => {
    const { data, error } = await supabase.rpc("headline_first_readings", {
      p_workspace_id: workspaceId,
      p_account_ids: accountIds,
      p_on_or_before: windows.current.start,
    });
    if (error) throw new Error("Failed to read the connections' first snapshots", { cause: error });
    return new Map(data.map((row) => [row.connection_id, row.snapshot_date]));
  };
  const [current, previous, readings] = await Promise.all([count(windows.current), count(windows.previous), firstReadings()]);
  return { current, previous, firstReadings: readings };
}
