import { describe, expect, it } from "vitest";

import type {
  Allowance,
  ConnectionInput,
  ConnectionStatus,
  CurrencyAmounts,
  MoneyValue,
  QuantityValue,
} from "@/lib/dashboard/aggregate";

import {
  allowanceValues,
  amountValues,
  ANNOUNCED_LABELS_MAX,
  barScaleFrom,
  changedValueKeys,
  countRange,
  createPendingChanges,
  creditValues,
  describeArrivals,
  formatCount,
  LIVE_CONNECTIONS_LISTED,
  LIVE_TABLES,
  liveChange,
  liveConnectionsText,
  liveStatusText,
  liveSystemMessage,
  liveTablesRead,
  type LiveChange,
  type LiveConnection,
  type LiveTable,
  newEventIds,
  type PendingChanges,
  recurringValues,
  summarizeLiveConnections,
  usageBarClass,
} from "./arrivals";

const source = { connectionId: "c1", provider: "fake", connectionName: "Fake", simulated: false } as const;

function money(amountMinor: number, currency = "USD", status: "verified" | "estimated" = "verified"): MoneyValue {
  return {
    amountMinor,
    currency,
    provenance: status === "verified" ? { status } : { status, pricingSources: [] },
    sources: [source],
    retrievedAt: "2026-11-05T10:00:00.000Z",
    stale: false,
  };
}

function quantity(value: number): QuantityValue {
  return {
    value,
    unit: "requests",
    provenance: { status: "verified" },
    source,
    retrievedAt: "2026-11-05T10:00:00.000Z",
    stale: false,
  };
}

function allowance(accountId: string, metric: string, used: number, percentUsed: number | null): Allowance {
  return {
    key: `${accountId}:${metric}`,
    accountName: accountId,
    label: "Requests",
    unit: "requests",
    included: quantity(1_000),
    used: quantity(used),
    remaining: null,
    percentUsed,
    period: null,
    resetsAt: null,
  };
}

describe("newEventIds", () => {
  it("finds the events that arrived since the previous render, in render order", () => {
    expect(newEventIds(["e2", "e1"], ["e4", "e3", "e2", "e1"])).toEqual(["e4", "e3"]);
  });

  it("marks nothing on the first render, when there is no previous render", () => {
    expect(newEventIds(null, ["e2", "e1"])).toEqual([]);
  });

  it.each([
    { name: "unchanged", previous: ["e2", "e1"], current: ["e2", "e1"] },
    { name: "reordered", previous: ["e2", "e1"], current: ["e1", "e2"] },
    { name: "an old event dropped off the page", previous: ["e3", "e2", "e1"], current: ["e3", "e2"] },
    { name: "both renders empty", previous: [], current: [] },
  ])("marks nothing when the ids are $name", ({ previous, current }) => {
    expect(newEventIds(previous, current)).toEqual([]);
  });

  it("marks every event when the previous render was empty", () => {
    expect(newEventIds([], ["e1"])).toEqual(["e1"]);
  });
});

describe("changedValueKeys", () => {
  it("lists the keys whose value changed", () => {
    expect(changedValueKeys({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(["b"]);
  });

  it("marks nothing on the first render", () => {
    expect(changedValueKeys(null, { a: 1 })).toEqual([]);
  });

  it.each([
    { name: "a key the previous render lacked", previous: { a: 1 }, current: { a: 1, b: 0 }, changed: ["b"] },
    { name: "unavailable to a value", previous: { a: null }, current: { a: 0 }, changed: ["a"] },
    { name: "a value to unavailable", previous: { a: 0 }, current: { a: null }, changed: ["a"] },
    { name: "a value to its negative", previous: { a: 5 }, current: { a: -5 }, changed: ["a"] },
    { name: "a key that is gone", previous: { a: 1, b: 2 }, current: { a: 1 }, changed: [] },
    { name: "unavailable both times", previous: { a: null }, current: { a: null }, changed: [] },
    { name: "zero both times", previous: { a: 0 }, current: { a: 0 }, changed: [] },
  ])("handles $name", ({ previous, current, changed }) => {
    expect(changedValueKeys(previous, current)).toEqual(changed);
  });
});

describe("value keys", () => {
  it("keys an allowance by account and metric, so the same metric on two accounts stays apart", () => {
    const before = { ...allowanceValues(allowance("a1", "fake.requests", 100, 10)), ...allowanceValues(allowance("a2", "fake.requests", 100, 10)) };
    const after = { ...allowanceValues(allowance("a1", "fake.requests", 100, 10)), ...allowanceValues(allowance("a2", "fake.requests", 250, 25)) };
    expect(changedValueKeys(before, after)).toEqual(["a2:fake.requests:used", "a2:fake.requests:percent"]);
  });

  it("keys money by group, currency, and provenance, so verified and estimated never mix", () => {
    const amounts = (verified: number, estimated: number): CurrencyAmounts[] => [
      { currency: "USD", verified: money(verified), estimated: money(estimated, "USD", "estimated") },
      { currency: "EUR", verified: money(500, "EUR"), estimated: null },
    ];
    expect(amountValues("spend", amounts(1_000, 2_000))).toEqual({
      "spend:USD:verified": 1_000,
      "spend:USD:estimated": 2_000,
      "spend:EUR:verified": 500,
      "spend:EUR:estimated": null,
    });
    expect(changedValueKeys(amountValues("spend", amounts(1_000, 2_000)), amountValues("spend", amounts(1_000, 2_500)))).toEqual([
      "spend:USD:estimated",
    ]);
  });

  it("keys credits apart from spend in the same currency", () => {
    expect(creditValues([money(300)])).toEqual({ "credit:USD:verified": 300 });
    expect(creditValues([])).toEqual({});
  });

  it("keys recurring revenue by metric, so monthly and annual rates in one currency stay apart", () => {
    const rates = (mrr: number, arr: number) => [
      { key: "polar.mrr USD verified", label: "Monthly recurring revenue (USD)", value: money(mrr) },
      { key: "polar.arr USD verified", label: "Annual recurring revenue (USD)", value: money(arr) },
    ];
    expect(recurringValues(rates(1_000, 12_000))).toEqual({
      "recurring:polar.mrr USD verified": 1_000,
      "recurring:polar.arr USD verified": 12_000,
    });
    expect(changedValueKeys(recurringValues(rates(1_000, 12_000)), recurringValues(rates(1_000, 12_500)))).toEqual([
      "recurring:polar.arr USD verified",
    ]);
  });

  it("keys recurring revenue apart from revenue in the same currency, and lists nothing without rates", () => {
    const rate = { key: "polar.mrr USD verified", label: "Monthly recurring revenue (USD)", value: money(1_000) };
    const revenue = amountValues("revenue", [{ currency: "USD", verified: money(1_000), estimated: null }]);
    expect(Object.keys({ ...revenue, ...recurringValues([rate]) })).toHaveLength(3);
    expect(recurringValues([])).toEqual({});
  });
});

describe("describeArrivals", () => {
  it("says what a batch brought in one sentence", () => {
    expect(
      describeArrivals([
        { kind: "events", count: 3 },
        { kind: "updated", label: "Vercel spend" },
      ]),
    ).toBe("3 new events. Vercel spend updated.");
  });

  it("says nothing when nothing changed", () => {
    expect(describeArrivals([])).toBeNull();
    expect(describeArrivals([{ kind: "events", count: 0 }])).toBeNull();
  });

  it("uses the singular for one event and sums event reports", () => {
    expect(describeArrivals([{ kind: "events", count: 1 }])).toBe("1 new event.");
    expect(describeArrivals([{ kind: "events", count: 1 }, { kind: "events", count: 1 }])).toBe("2 new events.");
  });

  it("names a label once however many cards report it", () => {
    expect(describeArrivals([{ kind: "updated", label: "Spend in USD" }, { kind: "updated", label: "Spend in USD" }])).toBe(
      "Spend in USD updated.",
    );
  });

  it(`names at most ${ANNOUNCED_LABELS_MAX} updated values and counts the rest`, () => {
    const labels = ["A", "B", "C", "D", "E"].map((label) => ({ kind: "updated", label }) as const);
    expect(describeArrivals(labels.slice(0, ANNOUNCED_LABELS_MAX))).toBe("A updated. B updated. C updated.");
    expect(describeArrivals(labels.slice(0, ANNOUNCED_LABELS_MAX + 1))).toBe("A updated. B updated. C updated. 1 other value updated.");
    expect(describeArrivals(labels)).toBe("A updated. B updated. C updated. 2 other values updated.");
  });
});

describe("liveStatusText", () => {
  it("says Live, named Live updates, while subscribed", () => {
    expect(liveStatusText("live")).toEqual({ word: "Live", name: "Live updates" });
  });

  it("never says live before the channel subscribes or after it fails", () => {
    expect(liveStatusText("connecting")).toEqual({ word: "Connecting", name: "Live updates, connecting" });
    expect(liveStatusText("offline")).toEqual({ word: "Offline", name: "Live updates, offline" });
  });

  it.each(["connecting", "live", "offline"] as const)("keeps the visible word in the name when %s", (status) => {
    const { word, name } = liveStatusText(status);
    expect(name.startsWith("Live updates")).toBe(true);
    expect(name.toLowerCase()).toContain(word.toLowerCase());
  });
});

function liveConnection(id: string, status: ConnectionStatus): LiveConnection {
  return { id, provider: "vercel", display_name: `Connection ${id}`, status };
}

describe("summarizeLiveConnections", () => {
  it("counts active as connected and needs attention or failed as attention, problems listed first", () => {
    const summary = summarizeLiveConnections([
      liveConnection("a", "active"),
      liveConnection("b", "pending"),
      liveConnection("c", "needs_attention"),
      liveConnection("d", "active"),
      liveConnection("e", "failed"),
    ]);
    expect(summary.connected).toBe(2);
    expect(summary.attention).toBe(2);
    expect(summary.listed.map(({ id }) => id)).toEqual(["e", "c", "b", "a", "d"]);
    expect(summary.unlisted).toBe(0);
  });

  it("neither counts nor lists a disconnected connection", () => {
    const summary = summarizeLiveConnections([liveConnection("a", "revoked"), liveConnection("b", "active")]);
    expect(summary).toEqual({ connected: 1, attention: 0, listed: [liveConnection("b", "active")], unlisted: 0 });
  });

  it("lists only the fields the tooltip shows, whatever row the caller passes", () => {
    const row: ConnectionInput = {
      ...liveConnection("a", "active"),
      last_synced_at: "2026-11-13T08:00:00.000Z",
      last_sync_requested_at: null,
      poll_interval_seconds: 3_600,
      granted_scopes: ["read:usage"],
    };
    expect(summarizeLiveConnections([row]).listed).toEqual([liveConnection("a", "active")]);
  });

  it("is empty with no connections, or only disconnected ones", () => {
    const empty = { connected: 0, attention: 0, listed: [], unlisted: 0 };
    expect(summarizeLiveConnections([])).toEqual(empty);
    expect(summarizeLiveConnections([liveConnection("a", "revoked")])).toEqual(empty);
  });

  it.each([
    [LIVE_CONNECTIONS_LISTED, 0],
    [LIVE_CONNECTIONS_LISTED + 1, 1],
  ])("lists at most the cap: %i connections leave %i unlisted, still all counted", (total, unlisted) => {
    const connections = Array.from({ length: total }, (_, index) => liveConnection(String(index), "active"));
    const summary = summarizeLiveConnections(connections);
    expect(summary.listed).toHaveLength(LIVE_CONNECTIONS_LISTED);
    expect(summary.unlisted).toBe(unlisted);
    expect(summary.connected).toBe(total);
  });

  it("keeps a problem past the cap in the list", () => {
    const connections = [
      ...Array.from({ length: LIVE_CONNECTIONS_LISTED }, (_, index) => liveConnection(String(index), "active")),
      liveConnection("broken", "failed"),
    ];
    expect(summarizeLiveConnections(connections).listed[0]?.id).toBe("broken");
  });
});

describe("liveConnectionsText", () => {
  it.each([
    [0, 0, "0 connected", "0 connected"],
    [3, 0, "3 connected", "3 connected"],
    [3, 1, "3 connected", "3 connected, 1 needs attention"],
    [0, 2, "0 connected", "0 connected, 2 need attention"],
  ])("%i connected and %i needing attention reads %j, named %j", (connected, attention, word, name) => {
    expect(liveConnectionsText({ connected, attention })).toEqual({ word, name });
  });
});

describe("liveChange", () => {
  const changedAt = "2026-11-22T21:09:34.123456+00:00";

  it.each([
    ["provider data from two connections", ["c1", "c2"]],
    ["one connection", ["c3"]],
    // A connections row, StackDash's own event, or a triggered alert: no data received.
    ["no connection", []],
  ])("reads a change that brought %s", (_case, connectionIds) => {
    const payload = { id: "m1", table: "usage_snapshots", operation: "INSERT", connection_ids: connectionIds, changed_at: changedAt };
    expect(liveChange(payload)).toEqual({ changedAt, connectionIds, table: "usage_snapshots" });
  });

  it.each(LIVE_TABLES)("reads a change to %s", (table) => {
    const payload = { id: "m1", table, operation: "UPDATE", connection_ids: [], changed_at: changedAt };
    expect(liveChange(payload)?.table).toBe(table);
  });

  // Still a change the indicator records, of a table every page refreshes for.
  it.each([
    ["a table this build does not know", "project_achievements"],
    ["a table named in another case", "Connections"],
    ["an empty table name", ""],
    ["a table that is not a string", 7],
    ["a null table", null],
  ])("reads %s as an unknown table", (_case, table) => {
    const payload = { table, operation: "INSERT", connection_ids: ["c1"], changed_at: changedAt };
    expect(liveChange(payload)).toEqual({ changedAt, connectionIds: ["c1"], table: null });
  });

  it("reads a change with no table as an unknown table", () => {
    expect(liveChange({ connection_ids: [], changed_at: changedAt })).toEqual({ changedAt, connectionIds: [], table: null });
  });

  it.each([
    ["null", null],
    ["a string", "not a change"],
    ["no changed_at", { connection_ids: ["c1"] }],
    ["a changed_at that is no time", { connection_ids: ["c1"], changed_at: "yesterday" }],
    ["no connection_ids", { changed_at: changedAt }],
    ["connection_ids that are not a list", { connection_ids: "c1", changed_at: changedAt }],
    ["a connection id that is not a string", { connection_ids: ["c1", 2], changed_at: changedAt }],
  ])("reads nothing from a payload with %s", (_case, payload) => {
    expect(liveChange(payload)).toBeNull();
  });
});

const EVERY_TABLE: readonly LiveTable[] = ["activity_events", "usage_snapshots", "connections", "triggered_alerts"];

describe("liveTablesRead", () => {
  // Every page: what it reads itself, and the layout's connections.
  it.each<[string, readonly LiveTable[]]>([
    ["/w/acme/dashboard", EVERY_TABLE],
    ["/w/acme/timeline", ["activity_events", "connections"]],
    ["/w/acme/alerts", ["triggered_alerts", "connections"]],
    ["/w/acme/alerts/settings", ["usage_snapshots", "connections"]],
    ["/w/acme/connections", ["connections"]],
    ["/w/acme/connections/0b8f6c1e-4d2a-4f7b-9a51-3c2e8d7f6a10", ["connections"]],
    ["/w/acme/connections/new/github", ["connections"]],
    ["/w/acme/projects", ["connections"]],
    ["/w/acme/projects/p1/achievements", ["activity_events", "connections"]],
    ["/w/acme/projects/p1/public-metrics", ["activity_events", "usage_snapshots", "connections"]],
    ["/w/acme/settings", ["connections"]],
    ["/w/acme/year/2026", ["activity_events", "usage_snapshots", "connections"]],
  ])("reads the tables of %s", (pathname, tables) => {
    expect([...liveTablesRead(pathname)].sort()).toEqual([...tables].sort());
  });

  // Unmatched: a not-found page in the shell, or any path no entry names, refreshes for every table.
  it.each([
    ["a page no entry names", "/w/acme/billing"],
    ["a path one segment past a page", "/w/acme/connections/c1/accounts"],
    ["a path one segment short of a page", "/w/acme/projects/p1"],
    ["the workspace's own path, which only redirects", "/w/acme"],
    ["a trailing slash", "/w/acme/timeline/"],
    ["an empty workspace segment", "/w//timeline"],
    ["an empty connection segment", "/w/acme/connections/new/"],
    ["another letter case", "/w/acme/Timeline"],
    ["a path outside a workspace", "/account"],
    ["the root", "/"],
    ["an empty path", ""],
  ])("reads every table on %s", (_case, pathname) => {
    expect([...liveTablesRead(pathname)].sort()).toEqual([...EVERY_TABLE].sort());
  });
});

describe("createPendingChanges", () => {
  const DASHBOARD = "/w/acme/dashboard";
  const TIMELINE = "/w/acme/timeline";
  const CONNECTIONS = "/w/acme/connections";
  const ALERTS = "/w/acme/alerts";

  function change(table: LiveTable | null, changedAt = "2026-11-24T10:00:00.000000+00:00", connectionIds: string[] = []): LiveChange {
    return { changedAt, connectionIds, table };
  }

  it("takes nothing from a batch that heard nothing", () => {
    expect(createPendingChanges().take(DASHBOARD)).toEqual({ arrival: null, refresh: false });
  });

  it("refreshes for a change to a table the page reads and records when and from where it arrived", () => {
    const pending = createPendingChanges();
    pending.heard(change("usage_snapshots", "2026-11-24T10:00:00.000000+00:00", ["c1"]));
    expect(pending.take(DASHBOARD)).toEqual({
      arrival: { at: "2026-11-24T10:00:00.000000+00:00", connectionIds: new Set(["c1"]) },
      refresh: true,
    });
  });

  it("records a change to a table the page does not read without refreshing it", () => {
    const pending = createPendingChanges();
    pending.heard(change("triggered_alerts", "2026-11-24T10:00:00.000000+00:00"));
    expect(pending.take(CONNECTIONS)).toEqual({
      arrival: { at: "2026-11-24T10:00:00.000000+00:00", connectionIds: new Set() },
      refresh: false,
    });
  });

  it("refreshes for a batch that mixes a table the page reads with one it does not, and records both", () => {
    const pending = createPendingChanges();
    pending.heard(change("usage_snapshots", "2026-11-24T10:00:02.000000+00:00", ["c1"]));
    pending.heard(change("activity_events", "2026-11-24T10:00:01.000000+00:00", ["c2"]));
    // The timeline reads the events, not the snapshots; the newest write is the snapshots', heard first.
    expect(pending.take(TIMELINE)).toEqual({
      arrival: { at: "2026-11-24T10:00:02.000000+00:00", connectionIds: new Set(["c1", "c2"]) },
      refresh: true,
    });
  });

  it.each([
    ["a payload of another shape", (pending: PendingChanges) => pending.heard(null)],
    ["a table this build does not know", (pending: PendingChanges) => pending.heard(change(null))],
    ["changes missed while the channel was down", (pending: PendingChanges) => pending.missed()],
  ])("refreshes every page for %s, as every page did for every change", (_case, hear) => {
    for (const pathname of [CONNECTIONS, "/w/acme/settings", "/w/acme/projects"]) {
      const pending = createPendingChanges();
      hear(pending);
      const due = pending.take(pathname);
      expect(due.refresh).toBe(true);
      expect(due.arrival).not.toBeNull();
    }
  });

  it("records a payload of another shape as an arrival with no time and no connection", () => {
    const pending = createPendingChanges();
    pending.heard(null);
    expect(pending.take(CONNECTIONS).arrival).toEqual({ at: null, connectionIds: new Set() });
  });

  it.each(EVERY_TABLE)("refreshes a path no page matches for a change to %s", (table) => {
    const pending = createPendingChanges();
    pending.heard(change(table));
    expect(pending.take("/w/acme/billing").refresh).toBe(true);
  });

  it("starts every batch empty", () => {
    const pending = createPendingChanges();
    pending.heard(change("activity_events", "2026-11-24T10:00:00.000000+00:00", ["c1"]));
    pending.take(TIMELINE);
    expect(pending.take(TIMELINE)).toEqual({ arrival: null, refresh: false });
  });

  it("needs nothing for a step in history when no change was skipped", () => {
    const pending = createPendingChanges();
    expect(pending.landed(DASHBOARD)).toBe(false);
    pending.heard(change("connections"));
    pending.take(CONNECTIONS);
    expect(pending.landed(DASHBOARD)).toBe(false);
  });

  it("refreshes a page a step in history returns to, once, when it reads a table a skipped change wrote", () => {
    const pending = createPendingChanges();
    pending.heard(change("triggered_alerts"));
    expect(pending.take(CONNECTIONS).refresh).toBe(false);

    // Back to the dashboard, which was rendered before the alert and reads it. Nothing new arrived.
    expect(pending.landed(DASHBOARD)).toBe(true);
    expect(pending.take(DASHBOARD)).toEqual({ arrival: null, refresh: true });
    // That refresh emptied the history cache, so the next step needs nothing.
    expect(pending.landed(DASHBOARD)).toBe(false);
  });

  // The batch can come due before React renders the step, and is then taken for the page the step
  // left. The router has already moved to the page the step landed on, so that is the page a
  // refresh reaches.
  it("refreshes for a step to a page that reads a skipped change, even when the batch is taken for the page it left", () => {
    const pending = createPendingChanges();
    pending.heard(change("triggered_alerts"));
    pending.take(CONNECTIONS);
    expect(pending.landed(DASHBOARD)).toBe(true);
    expect(pending.take(CONNECTIONS)).toEqual({ arrival: null, refresh: true });
    expect(pending.landed(DASHBOARD)).toBe(false);
  });

  it("refreshes for a step to a page that reads a change still in the batch, even when the batch is taken for the page it left", () => {
    const pending = createPendingChanges();
    pending.heard(change("triggered_alerts", "2026-11-24T10:00:00.000000+00:00", ["c1"]));
    expect(pending.landed(DASHBOARD)).toBe(true);
    expect(pending.take(CONNECTIONS)).toEqual({
      arrival: { at: "2026-11-24T10:00:00.000000+00:00", connectionIds: new Set(["c1"]) },
      refresh: true,
    });
  });

  it("keeps a skipped table through a step to a page that does not read it, for a later step to one that does", () => {
    const pending = createPendingChanges();
    pending.heard(change("triggered_alerts"));
    pending.take(CONNECTIONS);
    expect(pending.landed(TIMELINE)).toBe(false);
    expect(pending.take(TIMELINE).refresh).toBe(false);
    expect(pending.landed(ALERTS)).toBe(true);
    expect(pending.take(ALERTS).refresh).toBe(true);
  });

  it("does not refresh for a skipped table without a step in history, even on a page that reads it", () => {
    const pending = createPendingChanges();
    pending.heard(change("triggered_alerts"));
    pending.take(CONNECTIONS);
    // A link to the alerts page renders it from the server: no step back or forward, nothing to refresh.
    pending.heard(change("activity_events"));
    expect(pending.take(ALERTS).refresh).toBe(false);
    expect(pending.landed(ALERTS)).toBe(true);
  });

  it("forgets the skipped tables once any refresh runs", () => {
    const pending = createPendingChanges();
    pending.heard(change("triggered_alerts"));
    pending.take(CONNECTIONS);
    pending.heard(change("connections"));
    expect(pending.take(CONNECTIONS).refresh).toBe(true);
    expect(pending.landed(DASHBOARD)).toBe(false);
  });

  // LiveRefresh keeps one set per workspace, so a new mount after the workspace shell was left and
  // returned to still knows what the mount before it skipped.
  it("hands the skipped tables to a later instance over the same set, until a refresh clears them", () => {
    const skipped = new Set<LiveTable>();
    const before = createPendingChanges(skipped);
    before.heard(change("triggered_alerts"));
    expect(before.take(CONNECTIONS).refresh).toBe(false);

    // Back from the Account page lands on the connections page, which reads none of them, and
    // Back again on the dashboard, rendered before the alert.
    const after = createPendingChanges(skipped);
    expect(after.landed(CONNECTIONS)).toBe(false);
    expect(after.landed(DASHBOARD)).toBe(true);
    expect(after.take(DASHBOARD)).toEqual({ arrival: null, refresh: true });
    expect(createPendingChanges(skipped).landed(DASHBOARD)).toBe(false);
  });

  // LiveRefresh checks the page it mounts on: the step that mounted it fired its `popstate` first.
  it("refreshes the page a later instance over the same set mounts on, for a jump of several entries back into the shell", () => {
    const skipped = new Set<LiveTable>();
    const before = createPendingChanges(skipped);
    before.heard(change("triggered_alerts"));
    before.take(CONNECTIONS);

    // `history.go(-2)` from the Account page lands on the dashboard, rendered before the alert.
    const mounted = createPendingChanges(skipped);
    expect(mounted.landed(DASHBOARD)).toBe(true);
    expect(mounted.take(DASHBOARD)).toEqual({ arrival: null, refresh: true });
    expect(skipped.size).toBe(0);
  });

  it("keeps a skipped table for a later instance when a step judged a page stale and the batch was never taken", () => {
    const skipped = new Set<LiveTable>();
    const before = createPendingChanges(skipped);
    before.heard(change("triggered_alerts"));
    before.take(CONNECTIONS);
    // Back to the dashboard, then a link out of the shell before the batch comes due: `before` ends
    // with the step it judged stale.
    expect(before.landed(DASHBOARD)).toBe(true);

    // Back again lands on the dashboard, still cached from before the alert.
    const mounted = createPendingChanges(skipped);
    expect(mounted.landed(DASHBOARD)).toBe(true);
    expect(mounted.take(DASHBOARD).refresh).toBe(true);
  });

  it("does not refresh the page a later instance mounts on when it reads none of the skipped tables", () => {
    const skipped = new Set<LiveTable>();
    const before = createPendingChanges(skipped);
    before.heard(change("triggered_alerts"));
    before.take(CONNECTIONS);

    const mounted = createPendingChanges(skipped);
    expect(mounted.landed(TIMELINE)).toBe(false);
    expect(mounted.take(TIMELINE).refresh).toBe(false);
    expect([...skipped]).toEqual(["triggered_alerts"]);
  });

  it("does not hand the skipped tables to an instance with a set of its own", () => {
    const pending = createPendingChanges();
    pending.heard(change("triggered_alerts"));
    pending.take(CONNECTIONS);
    expect(createPendingChanges().landed(DASHBOARD)).toBe(false);
    expect(createPendingChanges(new Set()).landed(DASHBOARD)).toBe(false);
  });
});

describe("liveSystemMessage", () => {
  it.each([
    ["the stream is ready", "ok", "Replication connection established", true],
    ["Realtime closes the channel", "error", "Too many messages per second", false],
  ])("reads the message when %s", (_case, status, message, ok) => {
    const payload = { extension: "system", status, message, channel: "workspace-live:w1" };
    expect(liveSystemMessage(payload)).toEqual({ ok, message });
  });

  it.each([
    ["null", null],
    ["a string", "not a message"],
    ["another extension", { extension: "postgres_changes", status: "error", message: "m" }],
    ["an unknown status", { extension: "system", status: "pending", message: "m" }],
    ["no message", { extension: "system", status: "error" }],
  ])("reads nothing from a payload with %s", (_case, payload) => {
    expect(liveSystemMessage(payload)).toBeNull();
  });
});

describe("countRange", () => {
  it("counts whole numbers as they are", () => {
    expect(countRange(4_321, 5_000)).toEqual({ from: 4_321, to: 5_000, scale: 1 });
  });

  it("counts values with decimals in hundredths", () => {
    expect(countRange(12.5, 13.25)).toEqual({ from: 1_250, to: 1_325, scale: 100 });
  });

  it("counts down as well as up, and through negative values", () => {
    expect(countRange(100, -50)).toEqual({ from: 100, to: -50, scale: 1 });
  });

  it.each([
    { name: "equal values", from: 7, to: 7 },
    { name: "values equal once rounded to hundredths", from: 1.001, to: 1.002 },
    { name: "a value past the CSS integer limit", from: 0, to: 2 ** 31 },
    { name: "a decimal value past the limit once scaled", from: 0.5, to: 2 ** 31 / 100 },
    { name: "a value that is not a number", from: Number.NaN, to: 1 },
    { name: "an infinite value", from: 0, to: Number.POSITIVE_INFINITY },
  ])("does not count $name", ({ from, to }) => {
    expect(countRange(from, to)).toBeNull();
  });

  it("counts right up to the CSS integer limit", () => {
    expect(countRange(0, 2 ** 31 - 1)).toEqual({ from: 0, to: 2 ** 31 - 1, scale: 1 });
  });
});

describe("formatCount", () => {
  it("prints each frame the way the settled value prints", () => {
    expect(formatCount(4_321, 1, { type: "money", currency: "USD" })).toBe("$43.21");
    expect(formatCount(1_250, 100, { type: "quantity", unit: "GB" })).toBe("12.5 GB");
    expect(formatCount(3_330, 100, { type: "percent" })).toBe("33.3%");
  });

  it("prints a currency without minor units in whole units", () => {
    expect(formatCount(1_500, 1, { type: "money", currency: "JPY" })).toBe("¥1,500");
  });
});

describe("barScaleFrom", () => {
  it("starts a growing bar at its old width as a fraction of the new one", () => {
    expect(barScaleFrom(25, 50)).toBe(0.5);
  });

  it("starts a shrinking bar wider than its new width", () => {
    expect(barScaleFrom(90, 45)).toBe(2);
  });

  it("grows a bar from empty", () => {
    expect(barScaleFrom(0, 40)).toBe(0);
  });

  it.each([
    { name: "the width is unchanged", from: 40, to: 40 },
    { name: "the new width is zero", from: 40, to: 0 },
    { name: "both widths are past 100 percent", from: 120, to: 150 },
    { name: "both widths are below zero", from: -5, to: -1 },
  ])("does not animate when $name", ({ from, to }) => {
    expect(barScaleFrom(from, to)).toBeNull();
  });

  it("clamps an overspent allowance to the full bar", () => {
    expect(barScaleFrom(50, 130)).toBe(0.5);
  });
});

describe("usageBarClass", () => {
  it.each([
    [0, "bg-accent"],
    [79.9, "bg-accent"],
    [80, "bg-warning"],
    [99.9, "bg-warning"],
    [100, "bg-danger"],
    [250, "bg-danger"],
  ])("colors %s percent %s", (percent, expected) => {
    expect(usageBarClass(percent)).toBe(expected);
  });
});
