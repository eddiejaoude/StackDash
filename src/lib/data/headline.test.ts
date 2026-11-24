import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AccountInput, ConnectionInput } from "@/lib/dashboard/aggregate";
import type { HeadlineEventTypes, HeadlineWindows } from "@/lib/dashboard/headline";
import { EMPTY_SCOPE } from "@/lib/filters/scope";

import type { WorkspaceScope } from "./dashboard";
import { getHeadlineEvents } from "./headline";

/*
 * The headline's event reads (#346): every connection's first reading comes from one
 * `headline_first_readings` call, however many connections are in view, beside the two window
 * counts. The client records each RPC; the workspace scope is stubbed.
 */

type Rpc = Readonly<{ name: string; args: Readonly<Record<string, unknown>> }>;
type RpcResult = { data: unknown; error: { message: string } | null };

const { rpcs, results, scope } = vi.hoisted(() => ({
  rpcs: [] as Rpc[],
  results: new Map<string, RpcResult>(),
  scope: { current: { connections: [], accounts: [], projects: [] } as WorkspaceScope },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    async rpc(name: string, args: Readonly<Record<string, unknown>>) {
      rpcs.push({ name, args });
      return results.get(name) ?? { data: [], error: null };
    },
  }),
}));

vi.mock("./dashboard", () => ({
  getWorkspaceScope: async () => scope.current,
  loadSnapshots: async () => ({ rows: [], completeFrom: null }),
}));

const WORKSPACE_ID = "34600000-0000-4000-8000-000000000001";
const WINDOWS: HeadlineWindows = {
  kind: "week",
  complete: false,
  current: { start: "2026-11-09", end: "2026-11-12" },
  previous: { start: "2026-11-02", end: "2026-11-05" },
};
const EVENT_TYPES: HeadlineEventTypes = {
  signups: ["fake.signup"],
  deploys: ["fake.deploy.succeeded"],
  failedDeploys: [],
  signupDailyTotals: [],
};

function connectionId(index: number): string {
  return `34600000-0000-4000-8000-${String(100 + index).padStart(12, "0")}`;
}

function accountId(connection: number, account: number): string {
  return `34600000-0000-4000-8000-${String(1000 + connection * 10 + account).padStart(12, "0")}`;
}

function connection(index: number): ConnectionInput {
  return {
    id: connectionId(index),
    provider: "fake",
    display_name: `Connection ${index}`,
    status: "active",
    last_synced_at: "2026-11-12T08:00:00Z",
    last_sync_requested_at: null,
    poll_interval_seconds: 3600,
    granted_scopes: [],
  };
}

function account(connectionIndex: number, accountIndex: number): AccountInput {
  return {
    id: accountId(connectionIndex, accountIndex),
    connection_id: connectionId(connectionIndex),
    display_name: `Account ${connectionIndex}.${accountIndex}`,
    project_id: null,
  };
}

/** A workspace with `count` connections, each holding `accountsEach` included accounts. */
function seedWorkspace(count: number, accountsEach = 1): void {
  const indexes = Array.from({ length: count }, (_, index) => index);
  scope.current = {
    connections: indexes.map(connection),
    accounts: indexes.flatMap((index) => Array.from({ length: accountsEach }, (_, inner) => account(index, inner))),
    projects: [],
  };
}

function firstReadingCalls(): Rpc[] {
  return rpcs.filter((call) => call.name === "headline_first_readings");
}

beforeEach(() => {
  rpcs.length = 0;
  results.clear();
});

describe("getHeadlineEvents first readings", () => {
  it("reads nothing when no connection is in view", async () => {
    seedWorkspace(0);

    const events = await getHeadlineEvents(WORKSPACE_ID, EMPTY_SCOPE, WINDOWS, EVENT_TYPES);

    expect(rpcs).toEqual([]);
    expect(events).toEqual({ current: [], previous: [], firstReadings: new Map() });
  });

  it("reads one connection's first reading on or before the current window's first day", async () => {
    seedWorkspace(1);
    results.set("headline_first_readings", { data: [{ connection_id: connectionId(0), snapshot_date: "2026-10-01" }], error: null });

    const events = await getHeadlineEvents(WORKSPACE_ID, EMPTY_SCOPE, WINDOWS, EVENT_TYPES);

    expect(firstReadingCalls()).toEqual([
      {
        name: "headline_first_readings",
        args: { p_workspace_id: WORKSPACE_ID, p_account_ids: [accountId(0, 0)], p_on_or_before: "2026-11-09" },
      },
    ]);
    expect(events.firstReadings).toEqual(new Map([[connectionId(0), "2026-10-01"]]));
  });

  it("reads every connection's first reading in one call, however many connections are in view", async () => {
    seedWorkspace(12, 2);
    // Connection 11 has no reading by the window's first day, so it has no row and no entry.
    results.set("headline_first_readings", {
      data: Array.from({ length: 11 }, (_, index) => ({ connection_id: connectionId(index), snapshot_date: `2026-10-${String(10 + index)}` })),
      error: null,
    });

    const events = await getHeadlineEvents(WORKSPACE_ID, EMPTY_SCOPE, WINDOWS, EVENT_TYPES);

    expect(rpcs.map((call) => call.name).sort()).toEqual(["headline_event_counts", "headline_event_counts", "headline_first_readings"]);
    const [call] = firstReadingCalls();
    expect(call?.args.p_account_ids).toEqual(scope.current.accounts.map((row) => row.id));
    expect(events.firstReadings.size).toBe(11);
    expect(events.firstReadings.get(connectionId(10))).toBe("2026-10-20");
    expect(events.firstReadings.has(connectionId(11))).toBe(false);
  });

  it("passes only the accounts the scope leaves in view", async () => {
    seedWorkspace(3, 2);

    await getHeadlineEvents(WORKSPACE_ID, { ...EMPTY_SCOPE, accounts: [accountId(1, 1), accountId(2, 0)] }, WINDOWS, EVENT_TYPES);

    expect(firstReadingCalls().map((call) => call.args.p_account_ids)).toEqual([[accountId(1, 1), accountId(2, 0)]]);
  });

  it("fails the read when the first readings cannot be read", async () => {
    seedWorkspace(2);
    results.set("headline_first_readings", { data: null, error: { message: "permission denied" } });

    await expect(getHeadlineEvents(WORKSPACE_ID, EMPTY_SCOPE, WINDOWS, EVENT_TYPES)).rejects.toThrow(
      "Failed to read the connections' first snapshots",
    );
  });
});
