import { describe, expect, it } from "vitest";

import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";

import {
  adapterEventDedupeKey,
  allowanceResetEvents,
  ingestSyncResult,
  toEventRow,
  toSnapshotRow,
  utcDate,
} from "./ingest";
import { MemoryJobStore } from "./memory-store";

const connection = { id: "conn-1", workspace_id: "ws-1" };
const account = { id: "acct-row-1", display_name: "Example team" };
const retrievedAt = new Date("2026-11-01T00:30:00.000Z");

function allowance(kind: "included_allowance" | "remaining_allowance", resetsAt: Date | undefined): AdapterMetric {
  return {
    kind,
    metricKey: kind === "included_allowance" ? "fake.requests.included" : "fake.requests.remaining",
    label: "Requests included in the plan",
    timeframe: { type: "period", start: new Date("2026-11-01T00:00:00.000Z"), end: new Date("2026-12-01T00:00:00.000Z") },
    value: 50_000,
    unit: "requests",
    externalAccountId: "fake-acct-1",
    retrievedAt,
    provenance: { source: "provider_api" },
    ...(resetsAt === undefined ? {} : { resetsAt }),
  };
}

describe("utcDate", () => {
  it("puts 23:59:59.999 UTC and 00:00:00.000 UTC on different days", () => {
    expect(utcDate(new Date("2026-10-31T23:59:59.999Z"))).toBe("2026-10-31");
    expect(utcDate(new Date("2026-11-01T00:00:00.000Z"))).toBe("2026-11-01");
  });

  it("ignores the London offset (01:00 BST is still the previous UTC day)", () => {
    expect(utcDate(new Date("2026-07-01T00:30:00+01:00"))).toBe("2026-06-30");
  });
});

describe("toSnapshotRow", () => {
  it("maps money metrics to amount and currency with a point timeframe", () => {
    const row = toSnapshotRow(
      {
        kind: "credit_balance",
        metricKey: "fake.credits.balance",
        label: "Credit balance",
        timeframe: { type: "point", at: retrievedAt },
        amountMinor: -250,
        currency: "USD",
        externalAccountId: "fake-acct-1",
        retrievedAt,
        provenance: { source: "provider_api", endpoint: "https://api.example.com/credits" },
      },
      connection,
      account,
    );
    expect(row).toMatchObject({
      amount_minor: -250,
      currency: "USD",
      value: null,
      unit: null,
      point_at: retrievedAt.toISOString(),
      period_start: null,
      period_end: null,
      resets_at: null,
      snapshot_date: "2026-11-01",
      retrieved_at: "2026-11-01T00:30:00.000Z",
      provenance_endpoint: "https://api.example.com/credits",
      pricing_source: null,
      external_account_id: "acct-row-1",
    });
  });

  it("maps recurring revenue to amount and currency, as money, never as a quantity", () => {
    const row = toSnapshotRow(
      {
        kind: "recurring_revenue",
        metricKey: "fake.mrr.usd",
        label: "Monthly recurring revenue (USD)",
        timeframe: { type: "point", at: retrievedAt },
        amountMinor: 0,
        currency: "USD",
        externalAccountId: "fake-acct-1",
        retrievedAt,
        provenance: { source: "provider_api" },
      },
      connection,
      account,
    );
    expect(row).toMatchObject({ kind: "recurring_revenue", amount_minor: 0, currency: "USD", value: null, unit: null });
  });

  it("maps quantity metrics to value and unit with a period timeframe", () => {
    const row = toSnapshotRow(allowance("included_allowance", new Date("2026-12-01T00:00:00.000Z")), connection, account);
    expect(row).toMatchObject({
      value: 50_000,
      unit: "requests",
      amount_minor: null,
      currency: null,
      period_start: "2026-11-01T00:00:00.000Z",
      period_end: "2026-12-01T00:00:00.000Z",
      point_at: null,
      resets_at: "2026-12-01T00:00:00.000Z",
    });
  });
});

describe("allowanceResetEvents", () => {
  const next = new Date("2026-12-01T00:00:00.000Z");

  it("raises one event when the stored reset passed and the new one is later", () => {
    const rows = allowanceResetEvents({
      metrics: [allowance("included_allowance", next), allowance("remaining_allowance", next)],
      previousResets: new Map([
        ["fake.requests.included", "2026-11-01T00:00:00.000Z"],
        ["fake.requests.remaining", "2026-11-01T00:00:00.000Z"],
      ]),
      connection,
      account,
      providerName: "Example provider",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type_id: "stackdash.allowance_reset",
      provider: null,
      occurred_at: "2026-11-01T00:00:00.000Z",
      dedupe_key: "allowance_reset:acct-row-1:fake.requests.included:2026-11-01T00:00:00.000Z",
      title: "Example provider allowance reset for Example team",
    });
  });

  it("raises nothing when the stored reset is still in the future (exactly at retrievedAt counts as passed)", () => {
    const base = { connection, account, providerName: "Example provider" };
    expect(
      allowanceResetEvents({
        ...base,
        metrics: [allowance("included_allowance", next)],
        previousResets: new Map([["fake.requests.included", "2026-11-01T00:30:00.001Z"]]),
      }),
    ).toHaveLength(0);
    expect(
      allowanceResetEvents({
        ...base,
        metrics: [allowance("included_allowance", next)],
        previousResets: new Map([["fake.requests.included", "2026-11-01T00:30:00.000Z"]]),
      }),
    ).toHaveLength(1);
  });

  it("raises nothing without a previous snapshot, a previous reset, or a later new reset", () => {
    const base = { connection, account, providerName: "Example provider" };
    expect(allowanceResetEvents({ ...base, metrics: [allowance("included_allowance", next)], previousResets: new Map() })).toHaveLength(0);
    expect(
      allowanceResetEvents({ ...base, metrics: [allowance("included_allowance", next)], previousResets: new Map([["fake.requests.included", null]]) }),
    ).toHaveLength(0);
    expect(
      allowanceResetEvents({
        ...base,
        metrics: [allowance("included_allowance", new Date("2026-11-01T00:00:00.000Z"))],
        previousResets: new Map([["fake.requests.included", "2026-11-01T00:00:00.000Z"]]),
      }),
    ).toHaveLength(0);
  });

  it("falls back to remaining_allowance when the provider reports no included allowance", () => {
    const rows = allowanceResetEvents({
      metrics: [allowance("remaining_allowance", next)],
      previousResets: new Map([["fake.requests.remaining", "2026-11-01T00:00:00.000Z"]]),
      connection,
      account,
      providerName: "Example provider",
    });
    expect(rows.map((row) => row.dedupe_key)).toEqual([
      "allowance_reset:acct-row-1:fake.requests.remaining:2026-11-01T00:00:00.000Z",
    ]);
  });
});

describe("adapterEventDedupeKey", () => {
  it("prefixes the provider so adapters cannot collide", () => {
    expect(adapterEventDedupeKey("fake", "fake.signup:a:2026-11-01")).toBe("fake:fake.signup:a:2026-11-01");
  });
});

describe("ingestSyncResult events", () => {
  const syncAccount = { id: account.id, external_id: "fake-acct-1", display_name: account.display_name, sync_cursor: null };

  function failure(body: string | undefined, overrides: Partial<ActivityEvent> = {}): ActivityEvent {
    return {
      typeId: "fake.deployment.failed",
      occurredAt: new Date("2026-11-01T10:00:00.000Z"),
      severity: "critical",
      title: "Production deployment of web failed",
      externalAccountId: "fake-acct-1",
      dedupeKey: "deployment:1:failed",
      url: "https://example.com/deployments/1",
      ...(body === undefined ? {} : { body }),
      ...overrides,
    };
  }

  // What the later write disagrees on besides its body: none of it may reach the stored event.
  const later: Partial<ActivityEvent> = {
    occurredAt: new Date("2026-11-01T10:05:00.000Z"),
    severity: "warning",
    title: "Preview deployment of web failed",
    url: "https://example.com/deployments/1/inspect",
  };

  function ingest(store: MemoryJobStore, events: readonly ActivityEvent[], target = connection): Promise<void> {
    return ingestSyncResult({ store, provider: "fake", connection: target, account: syncAccount, metrics: [], events, cursor: undefined });
  }

  it.each([
    ["null to value: a stored event without a body takes the later one", undefined, "Error code: BUILD_FAILED", "Error code: BUILD_FAILED"],
    ["value to other value: a stored body is never replaced", "Error code: BUILD_FAILED", "Error code: OTHER", "Error code: BUILD_FAILED"],
    ["value to null: a stored body is never cleared", "Error code: BUILD_FAILED", undefined, "Error code: BUILD_FAILED"],
    ["null to null: a stored event without a body keeps none", undefined, undefined, null],
  ])("%s, and no other column changes (boundary)", async (_case, first, second, stored) => {
    const store = new MemoryJobStore(() => retrievedAt);
    await ingest(store, [failure(first)]);
    const [written] = store.events;
    await ingest(store, [failure(second, later)]);

    expect(store.events).toEqual([{ ...written, body: stored }]);
  });

  it("counts a filled in event as nothing new", async () => {
    const store = new MemoryJobStore(() => retrievedAt);
    expect(await store.insertEvents([toEventRow(failure(undefined), "fake", connection, account)])).toBe(1);
    expect(await store.insertEvents([toEventRow(failure("Error code: BUILD_FAILED"), "fake", connection, account)])).toBe(0);
    expect(store.events.map((event) => event.body)).toEqual(["Error code: BUILD_FAILED"]);
  });

  it("writes the first row of a key named twice in one batch, body included (boundary)", async () => {
    const store = new MemoryJobStore(() => retrievedAt);
    await ingest(store, [failure(undefined), failure("Error code: BUILD_FAILED", later)]);

    expect(store.events).toHaveLength(1);
    expect(store.events[0]).toMatchObject({ title: "Production deployment of web failed", body: null });
  });

  it("fills in only the workspace whose event is written (boundary)", async () => {
    const store = new MemoryJobStore(() => retrievedAt);
    const other = { id: "conn-2", workspace_id: "ws-2" };
    await ingest(store, [failure(undefined)]);
    await ingest(store, [failure(undefined)], other);
    await ingest(store, [failure("Error code: BUILD_FAILED")]);

    expect(store.events.map((event) => [event.workspace_id, event.body])).toEqual([
      ["ws-1", "Error code: BUILD_FAILED"],
      ["ws-2", null],
    ]);
  });
});
