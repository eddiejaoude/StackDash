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
  creditValues,
  describeArrivals,
  formatCount,
  LIVE_CONNECTIONS_LISTED,
  liveChange,
  liveConnectionsText,
  liveStatusText,
  liveSystemMessage,
  type LiveConnection,
  newEventIds,
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
    expect(liveChange(payload)).toEqual({ changedAt, connectionIds });
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
