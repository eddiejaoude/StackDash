import { beforeEach, describe, expect, it, vi } from "vitest";

import { getRecentAnomalies } from "./anomalies";

/*
 * The dashboard's count of recorded unusual days (#291) against an in-memory `activity_events`
 * table that applies the filters the data layer asks for, so the tests check which events are
 * counted and what each read sends back rather than which builder methods were called.
 */

type EventRow = { id: string; workspace_id: string; type_id: string; occurred_at: string; title: string; body: string | null };
type Column = keyof EventRow;
type Read = { columns: string; head: boolean };
type Result = { data: Array<Partial<EventRow>> | null; count: number | null; error: { code: string } | null };

const db = vi.hoisted(() => ({
  rows: [] as EventRow[],
  reads: [] as Read[],
  /** Set to make every read fail the way PostgREST reports an error. */
  failWith: null as { code: string } | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      if (table !== "activity_events") throw new Error(`Unexpected table ${table}`);
      const filters: Array<(row: EventRow) => boolean> = [];
      let read: Read = { columns: "*", head: false };
      let limit = Number.POSITIVE_INFINITY;
      const builder = {
        select(columns: string, options?: { count?: "exact"; head?: boolean }) {
          read = { columns, head: options?.head === true };
          return builder;
        },
        eq(column: Column, value: string) {
          filters.push((row) => row[column] === value);
          return builder;
        },
        gte(column: Column, value: string) {
          filters.push((row) => Date.parse(String(row[column])) >= Date.parse(value));
          return builder;
        },
        order() {
          return builder;
        },
        limit(count: number) {
          limit = count;
          return builder;
        },
        then(resolve: (value: Result) => unknown) {
          db.reads.push(read);
          if (db.failWith !== null) return Promise.resolve({ data: null, count: null, error: db.failWith }).then(resolve);
          const matched = db.rows.filter((row) => filters.every((keep) => keep(row))).slice(0, limit);
          const columns = read.columns.split(",").map((column) => column.trim() as Column);
          const data = read.head ? null : matched.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
          return Promise.resolve({ data, count: matched.length, error: null }).then(resolve);
        },
      };
      return builder;
    },
  }),
}));

const WORKSPACE = "29100000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE = "29100000-0000-4000-8000-000000000002";
const ANOMALY = "stackdash.anomaly_detected";
const SINCE = "2026-11-19T00:00:00.000Z";

let nextId = 0;
function event(overrides: Partial<EventRow>): EventRow {
  nextId += 1;
  return {
    id: `event-${nextId}`,
    workspace_id: WORKSPACE,
    type_id: ANOMALY,
    occurred_at: "2026-11-24T00:00:00.000Z",
    title: "Unusual spend on Example provider: 4 times the usual daily spend",
    body: "Spend per day (verified) was $50.00 on 2026-11-23.",
    ...overrides,
  };
}

beforeEach(() => {
  db.rows = [];
  db.reads = [];
  db.failWith = null;
});

describe("getRecentAnomalies", () => {
  it("counts the workspace's recorded unusual spend and usage events since the start of the window", async () => {
    db.rows = [
      event({ occurred_at: "2026-11-24T00:00:00.000Z" }),
      event({ occurred_at: "2026-11-25T00:00:00.000Z" }),
      event({ occurred_at: "2026-11-26T00:00:00.000Z" }),
      // Not counted: another type, another workspace, and an event from before the window.
      event({ type_id: "fake.deploy.succeeded" }),
      event({ workspace_id: OTHER_WORKSPACE }),
      event({ occurred_at: "2026-11-10T00:00:00.000Z" }),
    ];
    expect(await getRecentAnomalies(WORKSPACE, SINCE)).toEqual({ count: 3 });
  });

  it("counts an event recorded exactly at the start of the window and not one a millisecond before", async () => {
    db.rows = [event({ occurred_at: SINCE }), event({ occurred_at: "2026-11-18T23:59:59.999Z" })];
    expect(await getRecentAnomalies(WORKSPACE, SINCE)).toEqual({ count: 1 });
  });

  it("counts 0 when nothing unusual was recorded", async () => {
    db.rows = [event({ workspace_id: OTHER_WORKSPACE }), event({ type_id: "fake.deploy.succeeded" })];
    expect(await getRecentAnomalies(WORKSPACE, SINCE)).toEqual({ count: 0 });
  });

  it("reads the count alone, so no event's title or body leaves the database for the dashboard", async () => {
    db.rows = [event({}), event({}), event({}), event({})];
    await getRecentAnomalies(WORKSPACE, SINCE);
    expect(db.reads).toEqual([{ columns: "id", head: true }]);
  });

  it("throws when the count cannot be read, rather than reporting nothing unusual", async () => {
    db.failWith = { code: "42501" };
    await expect(getRecentAnomalies(WORKSPACE, SINCE)).rejects.toThrow("Failed to count recent anomalies");
  });
});
