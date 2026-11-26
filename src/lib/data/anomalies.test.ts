import { beforeEach, describe, expect, it, vi } from "vitest";

import { getRecentAnomalies, RECENT_ANOMALY_DAYS, recentAnomaliesFrom } from "./anomalies";

/*
 * The dashboard's count of recorded unusual days (#291) against an in-memory `activity_events`
 * table that applies the filters the data layer asks for, so the tests check which events are
 * counted rather than which builder methods were called.
 */

type EventRow = { id: string; workspace_id: string; type_id: string; occurred_at: string };
type Column = keyof EventRow;
type Result = { data: null; count: number | null; error: { code: string } | null };

const db = vi.hoisted(() => ({
  rows: [] as EventRow[],
  /** Set to make every read fail the way PostgREST reports an error. */
  failWith: null as { code: string } | null,
  /** Set to make a read succeed with no count, which supabase-js types as possible. */
  omitCount: false,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      if (table !== "activity_events") throw new Error(`Unexpected table ${table}`);
      const filters: Array<(row: EventRow) => boolean> = [];
      const builder = {
        select() {
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
        then(resolve: (value: Result) => unknown) {
          if (db.failWith !== null) return Promise.resolve({ data: null, count: null, error: db.failWith }).then(resolve);
          const count = db.omitCount ? null : db.rows.filter((row) => filters.every((keep) => keep(row))).length;
          return Promise.resolve({ data: null, count, error: null }).then(resolve);
        },
      };
      return builder;
    },
  }),
}));

const WORKSPACE = "29100000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE = "29100000-0000-4000-8000-000000000002";
const ANOMALY = "stackdash.anomaly_detected";
// A winter London day: it starts at midnight UTC.
const FROM = "2026-11-19";

let nextId = 0;
function event(overrides: Partial<EventRow>): EventRow {
  nextId += 1;
  return {
    id: `event-${nextId}`,
    workspace_id: WORKSPACE,
    type_id: ANOMALY,
    occurred_at: "2026-11-24T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  db.rows = [];
  db.omitCount = false;
  db.failWith = null;
});

describe("recentAnomaliesFrom", () => {
  it("starts the window 6 London days before today, so it holds 7 days with today", () => {
    expect(RECENT_ANOMALY_DAYS).toBe(7);
    expect(recentAnomaliesFrom(new Date("2026-11-26T12:00:00.000Z"))).toBe("2026-11-20");
  });

  it("takes today from the London calendar, not the UTC one", () => {
    // 00:30 BST on 2026-07-16 is still 2026-07-15 in UTC.
    expect(recentAnomaliesFrom(new Date("2026-07-15T23:30:00.000Z"))).toBe("2026-07-10");
    expect(recentAnomaliesFrom(new Date("2026-07-15T22:59:59.999Z"))).toBe("2026-07-09");
  });

  it("counts calendar days across a clock change, not 24 hour steps", () => {
    // London went to summer time on 2026-03-29, a 23 hour day inside the window.
    expect(recentAnomaliesFrom(new Date("2026-04-01T23:00:00.000Z"))).toBe("2026-03-27");
  });
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
    expect(await getRecentAnomalies(WORKSPACE, FROM)).toEqual({ count: 3, from: FROM });
  });

  it("counts an event recorded exactly at the start of the window and not one a millisecond before", async () => {
    db.rows = [event({ occurred_at: "2026-11-19T00:00:00.000Z" }), event({ occurred_at: "2026-11-18T23:59:59.999Z" })];
    expect(await getRecentAnomalies(WORKSPACE, FROM)).toEqual({ count: 1, from: FROM });
  });

  it("starts a summer window at London midnight, an hour before the UTC day, as the timeline's date filter does", async () => {
    db.rows = [event({ occurred_at: "2026-07-09T23:00:00.000Z" }), event({ occurred_at: "2026-07-09T22:59:59.999Z" })];
    expect(await getRecentAnomalies(WORKSPACE, "2026-07-10")).toEqual({ count: 1, from: "2026-07-10" });
  });

  it("counts 0 when nothing unusual was recorded", async () => {
    db.rows = [event({ workspace_id: OTHER_WORKSPACE }), event({ type_id: "fake.deploy.succeeded" })];
    expect(await getRecentAnomalies(WORKSPACE, FROM)).toEqual({ count: 0, from: FROM });
  });

  it("counts 0 when the read succeeds without a count, as the unacknowledged alerts count does", async () => {
    db.rows = [event({}), event({})];
    db.omitCount = true;
    expect(await getRecentAnomalies(WORKSPACE, FROM)).toEqual({ count: 0, from: FROM });
  });

  it("throws when the read fails, rather than reporting nothing unusual", async () => {
    db.failWith = { code: "42501" };
    await expect(getRecentAnomalies(WORKSPACE, FROM)).rejects.toThrow("Failed to count recent anomalies");
  });
});
