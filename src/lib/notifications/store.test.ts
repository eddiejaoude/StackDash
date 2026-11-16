import { afterEach, describe, expect, it, vi } from "vitest";

import { log } from "@/lib/log/logger";
import { fakeSupabase, MAX_ROWS, type Row } from "@/lib/supabase/fake-postgrest";

import { DISPATCH_ALERT_LIMIT } from "./dispatch";
import { alertSubjectKey, deliveryKey } from "./model";
import { createSupabaseNotificationStore, DELIVERIES_LIMIT } from "./store";

/*
 * The deliveries a dispatch reads to skip what was already sent, against a fake PostgREST that,
 * like the real one, answers at most max_rows (1000) rows a request and says nothing about the
 * rest (#218). A key left out is a message sent twice on a retry.
 */

const { client } = vi.hoisted(() => ({ client: { db: null as unknown } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => client.db }));

const WORKSPACE_ID = "21800000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "21800000-0000-4000-8000-000000000002";

function uuid(prefix: number, index: number): string {
  return `${String(prefix).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** One dispatch's worth of alerts, each delivered to `targets` recipients and channels. */
function deliveries(targets: number) {
  const subjects = Array.from({ length: DISPATCH_ALERT_LIMIT }, (_, index) => alertSubjectKey(uuid(21810, index)));
  const rows: Row[] = subjects.flatMap((subject, alert) =>
    Array.from({ length: targets }, (_, target) => ({
      id: uuid(21811, alert * targets + target),
      workspace_id: WORKSPACE_ID,
      subject_key: subject,
      target_key: target % 2 === 0 ? `email:${uuid(21812, target)}` : `destination:${uuid(21813, target)}`,
    })),
  );
  return { subjects, rows };
}

function store(rows: readonly Row[]) {
  const fake = fakeSupabase({ notification_deliveries: rows });
  client.db = fake.db;
  return { store: createSupabaseNotificationStore(), requests: fake.requests };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSupabaseNotificationStore listDeliveries", () => {
  it.each([
    { name: "one short page", targets: 9, requests: 1 },
    { name: "exactly max_rows", targets: 10, requests: 2 },
    { name: "several pages", targets: 25, requests: 3 },
  ])("returns every delivered key of the subjects in requests of at most max_rows (boundary: $name)", async ({ targets, requests: expected }) => {
    const { subjects, rows } = deliveries(targets);
    const unrelated = [
      { id: uuid(21814, 1), workspace_id: WORKSPACE_ID, subject_key: "digest:daily:2026-11-05", target_key: `email:${uuid(21812, 0)}` },
      { id: uuid(21814, 2), workspace_id: OTHER_WORKSPACE_ID, subject_key: subjects[0] ?? "", target_key: `email:${uuid(21812, 999)}` },
    ];
    const { store: notifications, requests } = store([...unrelated, ...rows].toReversed());
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const delivered = await notifications.listDeliveries(WORKSPACE_ID, subjects);

    expect(delivered).toEqual(new Set(rows.map((row) => deliveryKey(String(row.subject_key), String(row.target_key)))));
    expect(requests).toHaveLength(expected);
    expect(requests.every((request) => request.limit !== null && request.limit <= MAX_ROWS)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("asks nothing when there are no subjects (boundary: empty)", async () => {
    const { store: notifications, requests } = store(deliveries(1).rows);
    expect(await notifications.listDeliveries(WORKSPACE_ID, [])).toEqual(new Set());
    expect(requests).toHaveLength(0);
  });

  it("stops at DELIVERIES_LIMIT and logs the cut (boundary: more rows than the bound)", async () => {
    // 100 alerts to 51 targets each: 5100 rows.
    const { subjects, rows } = deliveries(51);
    const { store: notifications, requests } = store(rows);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const delivered = await notifications.listDeliveries(WORKSPACE_ID, subjects);

    expect(delivered.size).toBe(DELIVERIES_LIMIT);
    expect(requests).toHaveLength(DELIVERIES_LIMIT / MAX_ROWS);
    expect(warn).toHaveBeenCalledExactlyOnceWith("notifications.deliveries_truncated", {
      workspaceId: WORKSPACE_ID,
      subjects: subjects.length,
      rows: DELIVERIES_LIMIT,
    });
  });
});

describe("createSupabaseNotificationStore countHighlights", () => {
  const START = "2026-11-09T00:00:00.000Z";
  const END = "2026-11-16T00:00:00.000Z";

  function event(index: number, typeId: string, occurredAt = "2026-11-10T12:00:00.000Z", workspaceId = WORKSPACE_ID): Row {
    return { id: uuid(21820, index), workspace_id: workspaceId, type_id: typeId, occurred_at: occurredAt };
  }

  it("counts the star events the dashboard marks, the daily net and the milestone, and never a single star (boundary: github.stars.new)", async () => {
    const fake = fakeSupabase({
      activity_events: [
        event(1, "github.stars.daily"),
        event(2, "github.stars.milestone"),
        // 200 single stars over the same week: the daily event already counts them.
        ...Array.from({ length: 200 }, (_, index) => event(100 + index, "github.stars.new")),
        event(3, "github.forks.new"),
        event(4, "github.stars.daily", "2026-11-16T00:00:00.000Z"),
        event(5, "github.stars.daily", "2026-11-10T12:00:00.000Z", OTHER_WORKSPACE_ID),
      ],
      usage_snapshots: [],
    });
    client.db = fake.db;

    const highlights = await createSupabaseNotificationStore().countHighlights(WORKSPACE_ID, START, END);

    // The week's end is exclusive, and another workspace's event is not counted.
    expect(highlights.stars).toBe(2);
  });
});
