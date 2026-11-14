import { describe, expect, it } from "vitest";

import type { AdapterMetric } from "@/lib/adapters/metrics";

import { adapterEventDedupeKey, allowanceResetEvents, toSnapshotRow, utcDate } from "./ingest";

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
