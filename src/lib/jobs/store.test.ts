import { afterEach, describe, expect, it, vi } from "vitest";

import { declaredDailyTotals, declaredProjectedSpend } from "@/lib/adapters/registry";
import type { WebhookOutcome } from "@/lib/adapters/types";
import { addUtcDays, anomalySnapshotRange, findAnomalies, type AnomalyConnection, type AnomalyRow } from "@/lib/alerts/anomaly";
import { log } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { fakeSupabase, MAX_ROWS, type Row } from "@/lib/supabase/fake-postgrest";

import {
  ANOMALY_ROW_LIMIT,
  createSupabaseJobStore,
  SUMMARY_ROW_LIMIT,
  WEBHOOK_TARGET_LIMIT,
  webhookOutcomeFromJson,
  webhookOutcomeToJson,
} from "./store";

/*
 * The Supabase job store's paged reads against the fake PostgREST
 * (src/lib/supabase/fake-postgrest.ts), which answers at most `max_rows` rows per request like the
 * real Data API and says nothing about the rest. The anomaly read (#219) then goes through
 * findAnomalies, the way the daily summary job uses it; the daily summary's own snapshot and
 * connection reads (#218) are checked for every row once, and for the warning at their bound.
 */

vi.mock("@/lib/supabase/admin");

const WORKSPACE_ID = "21900000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE_ID = "21900000-0000-4000-8000-000000000002";
const VERCEL: AnomalyConnection = { id: "21900000-0000-4000-8000-000000000003", provider: "vercel" };
// The summarized day. Its month to date total is checked on it, against 2026-10-02 to 2026-10-13.
const DATE = "2026-10-14";
const USUAL_DAILY_MINOR = 10_000;
const SPIKE_DAILY_MINOR = 40_000;
// The daily summary's 14 day history window.
const SUMMARY_FROM_DATE = "2026-10-23";
const SUMMARY_TO_DATE = "2026-11-05";
const SUMMARY_CONNECTION_ID = "21800000-0000-4000-8000-000000000003";
const SUMMARY_ACCOUNT_ID = "21800000-0000-4000-8000-000000000004";

type StoredRow = AnomalyRow & Readonly<{ id: string; workspace_id: string }>;

function uuid(prefix: number, index: number): string {
  return `${String(prefix).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/**
 * `accountCount` Vercel accounts, each with a month to date spend total from 2026-10-01 to DATE
 * that grows $100.00 a day and $400.00 on DATE: one series, summed over the accounts, that spikes
 * on DATE. Row ids follow the account, so within one day the store's id order is account order.
 */
function vercelSpend(accountCount: number): StoredRow[] {
  return Array.from({ length: accountCount }, (_, account) => {
    const rows: StoredRow[] = [];
    let total = 0;
    for (let day = 0, date = "2026-10-01"; date <= DATE; day += 1, date = addUtcDays(date, 1)) {
      total += date === DATE ? SPIKE_DAILY_MINOR : USUAL_DAILY_MINOR;
      rows.push({
        id: uuid(account + 1, day),
        workspace_id: WORKSPACE_ID,
        connection_id: VERCEL.id,
        external_account_id: uuid(0, account),
        metric_key: "vercel.spend.total",
        kind: "verified_spend",
        label: "Vercel billed spend, month to date",
        snapshot_date: date,
        value: null,
        unit: null,
        amount_minor: total,
        currency: "USD",
        period_start: "2026-10-01T00:00:00.000Z",
        period_end: "2026-11-01T00:00:00.000Z",
        point_at: null,
        resets_at: null,
        retrieved_at: `${date}T23:59:50.000Z`,
        provenance_source: "provider_api",
        pricing_source: null,
      });
    }
    return rows;
  }).flat();
}

/** The columns the store selects, so a stored row compares with what the read returns. */
function asRead({ id: _id, workspace_id: _workspace, ...row }: StoredRow): AnomalyRow {
  return row;
}

/** Oldest day first, then by id: the order a complete read hands to findAnomalies. */
function oldestFirst(rows: readonly StoredRow[]): StoredRow[] {
  return rows.toSorted((a, b) => a.snapshot_date.localeCompare(b.snapshot_date) || a.id.localeCompare(b.id));
}

function storeOver(rows: readonly Row[], table = "usage_snapshots") {
  const { db, requests } = fakeSupabase({ [table]: rows });
  vi.mocked(createAdminClient).mockReturnValue(db);
  return { store: createSupabaseJobStore(), requests };
}

/** `perDay` usage rows a day for `dayCount` days ending SUMMARY_TO_DATE, newest day first, then by id. */
function summarySnapshots(perDay: number, dayCount: number): StoredRow[] {
  return Array.from({ length: dayCount }, (_, daysBack) =>
    Array.from({ length: perDay }, (_, metric): StoredRow => {
      const date = addUtcDays(SUMMARY_TO_DATE, -daysBack);
      return {
        id: uuid(daysBack + 1, metric),
        workspace_id: WORKSPACE_ID,
        connection_id: SUMMARY_CONNECTION_ID,
        external_account_id: SUMMARY_ACCOUNT_ID,
        metric_key: `simulated.metric.${metric}`,
        kind: "usage",
        label: `Metric ${metric}`,
        snapshot_date: date,
        value: metric,
        unit: "requests",
        amount_minor: null,
        currency: null,
        period_start: `${date}T00:00:00.000Z`,
        period_end: `${date}T23:59:59.000Z`,
        point_at: null,
        resets_at: null,
        retrieved_at: `${date}T23:59:59.000Z`,
        provenance_source: "provider_api",
        pricing_source: null,
      };
    }),
  ).flat();
}

function summaryConnections(count: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: uuid(21801, index),
    workspace_id: WORKSPACE_ID,
    provider: "vercel",
    status: "active",
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createSupabaseJobStore listAnomalySnapshots", () => {
  it("returns every spend and usage row of the range once, oldest day first, and the spike on the checked day fires", async () => {
    const spend = vercelSpend(3);
    const [first] = spend;
    if (first === undefined) throw new Error("expected spend rows");
    const kept: StoredRow[] = [
      ...spend,
      // One reading of each other kind detection reads; a single day has no history, so neither fires.
      { ...first, id: uuid(8, 1), metric_key: "vercel.spend.estimate", kind: "estimated_spend", label: "Vercel estimated spend", snapshot_date: "2026-10-05" },
      {
        ...first,
        id: uuid(8, 2),
        metric_key: "vercel.usage.bandwidth",
        kind: "usage",
        label: "Vercel bandwidth",
        value: 12,
        unit: "GB",
        amount_minor: null,
        currency: null,
      },
    ];
    const skipped: StoredRow[] = [
      // Another workspace, a point in time reading, a level, and a day before the range.
      { ...first, id: uuid(9, 1), workspace_id: OTHER_WORKSPACE_ID },
      { ...first, id: uuid(9, 2), point_at: `${DATE}T12:00:00.000Z` },
      { ...first, id: uuid(9, 3), kind: "credit_balance" },
      { ...first, id: uuid(9, 4), snapshot_date: addUtcDays(anomalySnapshotRange(DATE).from, -1) },
    ];
    const { store } = storeOver([...skipped, ...kept].toReversed());
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const range = anomalySnapshotRange(DATE);

    const rows = await store.listAnomalySnapshots(WORKSPACE_ID, range.from, range.to);

    expect(rows).toEqual(oldestFirst(kept).map(asRead));
    expect(warn).not.toHaveBeenCalled();
    expect(findAnomalies({ date: DATE, rows, connections: [VERCEL], mutes: [], projectedSpend: declaredProjectedSpend, dailyTotals: declaredDailyTotals })).toEqual([
      expect.objectContaining({ date: DATE, metricKey: "vercel.spend.total", value: 3 * SPIKE_DAILY_MINOR, usual: 3 * USUAL_DAILY_MINOR }),
    ]);
  });

  it("keeps the newest day when the range holds more rows than the bound, logs the cut, and the spike on that day still fires (boundary: ANOMALY_ROW_LIMIT)", async () => {
    // 1500 accounts over 14 days: 21,000 rows, so the read stops 1000 rows short. Read oldest first,
    // those 1000 were DATE's rows of 1000 accounts, so the checked day had no total to compare.
    const spend = vercelSpend(1500);
    expect(spend.length).toBe(ANOMALY_ROW_LIMIT + 1000);
    const { store, requests } = storeOver(spend);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const range = anomalySnapshotRange(DATE);

    const rows = await store.listAnomalySnapshots(WORKSPACE_ID, range.from, range.to);

    // Newest first, then by id, the read leaves out 2026-10-01's rows of the last 1000 accounts.
    const left = new Set(spend.filter((row) => row.snapshot_date === "2026-10-01").slice(-1000));
    expect(rows).toEqual(oldestFirst(spend.filter((row) => !left.has(row))).map(asRead));
    expect(rows.filter((row) => row.snapshot_date === DATE)).toHaveLength(1500);
    expect(requests).toHaveLength(ANOMALY_ROW_LIMIT / MAX_ROWS);
    expect(warn).toHaveBeenCalledExactlyOnceWith("anomaly.snapshots_truncated", { workspaceId: WORKSPACE_ID, rows: ANOMALY_ROW_LIMIT });
    // 2026-10-02 loses its day before for those accounts and is unavailable, leaving 11 history days.
    expect(findAnomalies({ date: DATE, rows, connections: [VERCEL], mutes: [], projectedSpend: declaredProjectedSpend, dailyTotals: declaredDailyTotals })).toEqual([
      expect.objectContaining({
        date: DATE,
        metricKey: "vercel.spend.total",
        value: 1500 * SPIKE_DAILY_MINOR,
        usual: 1500 * USUAL_DAILY_MINOR,
        historyDays: 11,
      }),
    ]);
  });
});

describe("createSupabaseJobStore listSnapshotsBetween", () => {
  it.each([
    { name: "empty", perDay: 0, requests: 1 },
    { name: "one short page", perDay: 71, requests: 1 },
    { name: "exactly max_rows", perDay: 125, days: 8, requests: 2 },
    { name: "one row past max_rows", perDay: 77, days: 13, requests: 2 },
    { name: "several pages", perDay: 250, requests: 4 },
  ])("returns every snapshot of the window once, newest first, in requests of at most max_rows (boundary: $name)", async ({ perDay, days = 14, requests: expected }) => {
    const rows = summarySnapshots(perDay, days);
    const [first] = summarySnapshots(1, 1);
    if (first === undefined) throw new Error("expected a snapshot row");
    const outside: StoredRow[] = [
      { ...first, id: uuid(9, 1), workspace_id: OTHER_WORKSPACE_ID },
      { ...first, id: uuid(9, 2), snapshot_date: addUtcDays(SUMMARY_FROM_DATE, -1) },
    ];
    const { store, requests } = storeOver([...outside, ...rows].toReversed());
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const read = await store.listSnapshotsBetween(WORKSPACE_ID, SUMMARY_FROM_DATE, SUMMARY_TO_DATE);

    expect(read).toEqual(rows.map(asRead));
    expect(requests).toHaveLength(expected);
    expect(requests.every((request) => request.limit !== null && request.limit <= MAX_ROWS)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stops at SUMMARY_ROW_LIMIT, keeps the newest days, and logs the cut (boundary: more rows than the bound)", async () => {
    // 400 metrics a day over 14 days: 5600 rows.
    const rows = summarySnapshots(400, 14);
    const { store, requests } = storeOver(rows);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const read = await store.listSnapshotsBetween(WORKSPACE_ID, SUMMARY_FROM_DATE, SUMMARY_TO_DATE);

    expect(read).toEqual(rows.slice(0, SUMMARY_ROW_LIMIT).map(asRead));
    expect(read.at(0)?.snapshot_date).toBe(SUMMARY_TO_DATE);
    expect(requests).toHaveLength(SUMMARY_ROW_LIMIT / MAX_ROWS);
    expect(warn).toHaveBeenCalledExactlyOnceWith("daily_summary.snapshots_truncated", { workspaceId: WORKSPACE_ID, rows: SUMMARY_ROW_LIMIT });
  });
});

describe("createSupabaseJobStore listSummaryConnections", () => {
  it("returns every connection but the revoked ones across pages, in id order (boundary: more rows than max_rows)", async () => {
    const rows = summaryConnections(1500);
    const revoked = { ...summaryConnections(1)[0], id: uuid(21802, 1), status: "revoked" };
    const elsewhere = { ...summaryConnections(1)[0], id: uuid(21802, 2), workspace_id: OTHER_WORKSPACE_ID };
    const { store, requests } = storeOver([revoked, elsewhere, ...rows].toReversed(), "connections");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const read = await store.listSummaryConnections(WORKSPACE_ID);

    expect(read).toEqual(rows.map((row) => ({ id: row.id, provider: row.provider })));
    expect(requests).toHaveLength(2);
    expect(requests.every((request) => request.limit !== null && request.limit <= MAX_ROWS)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("stops at SUMMARY_ROW_LIMIT and logs the cut (boundary: one row past the bound)", async () => {
    const rows = summaryConnections(SUMMARY_ROW_LIMIT + 1);
    const { store } = storeOver(rows, "connections");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const read = await store.listSummaryConnections(WORKSPACE_ID);

    expect(read).toHaveLength(SUMMARY_ROW_LIMIT);
    expect(read.at(-1)?.id).toBe(rows[SUMMARY_ROW_LIMIT - 1]?.id);
    expect(warn).toHaveBeenCalledExactlyOnceWith("daily_summary.connections_truncated", { workspaceId: WORKSPACE_ID, rows: SUMMARY_ROW_LIMIT });
  });
});

describe("createSupabaseJobStore updateConnectionInStatus (#487)", () => {
  const CONNECTION_ID = uuid(48701, 1);
  // The fake answers the update with the rows its filters match, as PostgREST does when asked to
  // return them; it does not apply the patch, which these tests do not read back.
  const connection = (status: string): Row => ({ id: CONNECTION_ID, workspace_id: WORKSPACE_ID, status });

  it.each([
    { name: "active (happy path)", status: "active", applied: true },
    { name: "failed", status: "failed", applied: true },
    { name: "needs_attention, an uninstall applied meanwhile", status: "needs_attention", applied: false },
    { name: "revoked, disconnected meanwhile", status: "revoked", applied: false },
  ])("filters the update on the status in the same request (boundary: $name)", async ({ status, applied }) => {
    const { store, requests } = storeOver([connection(status)], "connections");

    const result = await store.updateConnectionInStatus({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID }, ["active", "failed"], {
      status: "active",
    });

    expect(result).toBe(applied);
    expect(requests.map((request) => request.filters)).toEqual([
      [
        ["id", `eq.${CONNECTION_ID}`],
        ["workspace_id", `eq.${WORKSPACE_ID}`],
        ["status", "in.(active,failed)"],
      ],
    ]);
  });

  it("does not apply to the same connection id in another workspace (boundary: wrong owner)", async () => {
    const { store } = storeOver([connection("active")], "connections");

    const result = await store.updateConnectionInStatus({ workspaceId: OTHER_WORKSPACE_ID, connectionId: CONNECTION_ID }, ["active"], {
      status: "active",
    });

    expect(result).toBe(false);
  });
});

describe("webhook delivery outcome stored as JSON (#28)", () => {
  const event = {
    typeId: "fake.deploy.succeeded",
    occurredAt: new Date("2026-11-14T09:30:00.000Z"),
    severity: "success",
    title: "Deploy succeeded",
    externalAccountId: "fake-acct-1",
    dedupeKey: "fake.deploy.succeeded:fake-acct-1:2026-11-14",
  } as const;
  const storedEvent = { ...event, occurredAt: event.occurredAt.toISOString() };

  it.each<WebhookOutcome>([
    {
      kind: "events",
      externalAccountId: "fake-acct-1",
      events: [event, { ...event, body: "Production", url: "https://example.com/deployments/1", dedupeKey: "fake.deploy.succeeded:fake-acct-1:2026-11-15" }],
    },
    { kind: "events", externalAccountId: "fake-acct-1", events: [] },
    { kind: "events", externalAccountId: "fake-acct-1", installationId: "fake-installation-1", events: [event] },
    { kind: "uninstalled", externalAccountId: "fake-acct-1", occurredAt: new Date("2026-11-14T08:00:00.000Z") },
    { kind: "uninstalled", by: "account", externalAccountId: "fake-acct-1", occurredAt: new Date("2026-11-14T08:00:00.000Z") },
    { kind: "uninstalled", by: "installation", installationId: "fake-installation-1", occurredAt: new Date("2026-11-14T08:00:00.000Z") },
    { kind: "ignored", reason: "unmapped event" },
  ])("reads back the $kind outcome it stored, event and uninstall dates included", (outcome) => {
    // jsonb keeps exactly what JSON keeps.
    const stored: unknown = JSON.parse(JSON.stringify(webhookOutcomeToJson(outcome)));

    expect(webhookOutcomeFromJson(stored)).toEqual(outcome);
  });

  it.each<[WebhookOutcome, WebhookOutcome]>([
    [
      { kind: "events", externalAccountId: "fake-acct-1", events: [event], source: { id: "9", name: "group1/app" } },
      { kind: "events", externalAccountId: "fake-acct-1", events: [event] },
    ],
    [
      { kind: "ignored", reason: "pipeline has not finished", source: { id: "9", name: "group1/app" } },
      { kind: "ignored", reason: "pipeline has not finished" },
    ],
  ])("stores an outcome without the source it names (#428), which the job reads back", (outcome, expected) => {
    const stored: unknown = JSON.parse(JSON.stringify(webhookOutcomeToJson(outcome)));
    expect(webhookOutcomeFromJson(stored)).toEqual(expected);
  });

  it.each([
    { name: "null, a processed delivery", value: null },
    { name: "an unknown kind", value: { kind: "deleted", externalAccountId: "fake-acct-1" } },
    { name: "a field the outcome does not name", value: { kind: "ignored", reason: "test", payload: "raw body" } },
    { name: "an event field the model does not name", value: { kind: "events", externalAccountId: "fake-acct-1", events: [{ ...storedEvent, author: "someone" }] } },
    { name: "an occurredAt that is not an ISO instant", value: { kind: "events", externalAccountId: "fake-acct-1", events: [{ ...storedEvent, occurredAt: "yesterday" }] } },
    { name: "an uninstall without occurredAt", value: { kind: "uninstalled", externalAccountId: "fake-acct-1" } },
    { name: "an uninstall occurredAt that is not an ISO instant", value: { kind: "uninstalled", externalAccountId: "fake-acct-1", occurredAt: "yesterday" } },
    { name: "an installation uninstall with an empty id", value: { kind: "uninstalled", by: "installation", installationId: "", occurredAt: "2026-11-14T08:00:00.000Z" } },
    { name: "an installation id without by", value: { kind: "uninstalled", installationId: "fake-installation-1", occurredAt: "2026-11-14T08:00:00.000Z" } },
    { name: "by installation naming an account", value: { kind: "uninstalled", by: "installation", externalAccountId: "fake-acct-1", occurredAt: "2026-11-14T08:00:00.000Z" } },
    { name: "an uninstall naming both", value: { kind: "uninstalled", by: "installation", installationId: "fake-installation-1", externalAccountId: "fake-acct-1", occurredAt: "2026-11-14T08:00:00.000Z" } },
    { name: "events with an empty installation id", value: { kind: "events", externalAccountId: "fake-acct-1", installationId: "", events: [] } },
    { name: "events with a null installation id", value: { kind: "events", externalAccountId: "fake-acct-1", installationId: null, events: [] } },
    { name: "an unknown by", value: { kind: "uninstalled", by: "organization", externalAccountId: "fake-acct-1", occurredAt: "2026-11-14T08:00:00.000Z" } },
  ])("refuses a stored outcome of another shape (boundary: $name)", ({ value }) => {
    expect(webhookOutcomeFromJson(value)).toBeNull();
  });
});

describe("createSupabaseJobStore webhook deliveries (#28)", () => {
  const DELIVERY_ID = "28000000-0000-4000-8000-000000000001";
  const ENDPOINT_ID = "28000000-0000-4000-8000-000000000002";

  function targets(count: number): Row[] {
    return Array.from({ length: count }, (_, index) => ({
      workspace_id: uuid(28001, index),
      connection_id: uuid(28002, index),
      account_id: uuid(28003, index),
      granted_at: "2026-11-15T09:00:00.123456+00:00",
      simulated: false,
    }));
  }

  function storeWith(functions: Parameters<typeof fakeSupabase>[1], tables: Readonly<Record<string, readonly Row[]>> = {}) {
    const { db, requests } = fakeSupabase(tables, functions);
    vi.mocked(createAdminClient).mockReturnValue(db);
    return { store: createSupabaseJobStore(), requests };
  }

  it("claims webhook jobs through claim_webhook_jobs, each with the delivery it processes", async () => {
    const job = {
      id: uuid(28004, 1),
      workspace_id: null,
      connection_id: null,
      kind: "webhook",
      attempts: 1,
      max_attempts: 5,
      created_at: "2026-11-15T09:00:00+00:00",
      dedupe_key: null,
      webhook_delivery_id: DELIVERY_ID,
      status: "running",
    };
    const { store, requests } = storeWith({ claim_webhook_jobs: () => [job] });

    const [claimed] = await store.claimWebhookJobs(50, 120);

    expect(claimed).toEqual(expect.objectContaining({ kind: "webhook", webhook_delivery_id: DELIVERY_ID }));
    expect(requests.map((request) => request.args)).toEqual([{ p_limit: 50, p_lease_seconds: 120 }]);
  });

  it("maps every target of an app-level delivery, with when its connection was granted, without restricting it to a connection", async () => {
    // A live connection with no recorded grant has no grant time (#502).
    const rows = [...targets(1), { ...targets(2)[1], granted_at: null }];
    const { store, requests } = storeWith({ list_webhook_targets: () => rows });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const read = await store.listWebhookTargets({ provider: "fake", externalAccountId: "fake-acct-1", installationId: null, endpointId: null });

    expect(read).toEqual([
      { workspaceId: uuid(28001, 0), connectionId: uuid(28002, 0), accountId: uuid(28003, 0), grantedAt: "2026-11-15T09:00:00.123456+00:00", simulated: false },
      { workspaceId: uuid(28001, 1), connectionId: uuid(28002, 1), accountId: uuid(28003, 1), grantedAt: null, simulated: false },
    ]);
    expect(requests.map((request) => request.args)).toEqual([{ p_provider: "fake", p_external_id: "fake-acct-1" }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("restricts a per-connection delivery to the endpoint's connection", async () => {
    const { store, requests } = storeWith({ list_webhook_targets: () => targets(1) });

    await store.listWebhookTargets({ provider: "fake", externalAccountId: "fake-acct-1", installationId: null, endpointId: ENDPOINT_ID });

    expect(requests.map((request) => request.args)).toEqual([{ p_provider: "fake", p_external_id: "fake-acct-1", p_endpoint_id: ENDPOINT_ID }]);
  });

  it("keeps a delivery's account to the installation that sent it, when it names one (#497)", async () => {
    const { store, requests } = storeWith({ list_webhook_targets: () => targets(1) });

    const read = await store.listWebhookTargets({ provider: "fake", externalAccountId: "fake-acct-1", installationId: "fake-installation-1", endpointId: null });

    expect(read).toEqual([
      { workspaceId: uuid(28001, 0), connectionId: uuid(28002, 0), accountId: uuid(28003, 0), grantedAt: "2026-11-15T09:00:00.123456+00:00", simulated: false },
    ]);
    expect(requests.map((request) => request.args)).toEqual([{ p_provider: "fake", p_external_id: "fake-acct-1", p_installation_id: "fake-installation-1" }]);
  });

  it("asks for an installation's connections by installation id alone, one target per connection (#480)", async () => {
    // The function answers an installation with no account.
    const rows = targets(2).map((row) => ({ ...row, account_id: null }));
    const { store, requests } = storeWith({ list_webhook_targets: () => rows });

    const read = await store.listInstallationTargets({ provider: "fake", installationId: "fake-installation-1", endpointId: ENDPOINT_ID });

    expect(read).toEqual([
      { workspaceId: uuid(28001, 0), connectionId: uuid(28002, 0), grantedAt: "2026-11-15T09:00:00.123456+00:00", simulated: false },
      { workspaceId: uuid(28001, 1), connectionId: uuid(28002, 1), grantedAt: "2026-11-15T09:00:00.123456+00:00", simulated: false },
    ]);
    expect(requests.map((request) => request.args)).toEqual([{ p_provider: "fake", p_installation_id: "fake-installation-1", p_endpoint_id: ENDPOINT_ID }]);
  });

  it("says which targets are simulated, on the account and the installation match (#495)", async () => {
    const rows = [...targets(1), { ...targets(2)[1], simulated: true }];
    const { store } = storeWith({ list_webhook_targets: () => rows });

    const byAccount = await store.listWebhookTargets({ provider: "github", externalAccountId: "github-acct-1", installationId: null, endpointId: null });
    const byInstallation = await store.listInstallationTargets({ provider: "github", installationId: "github-installation-1", endpointId: null });

    for (const read of [byAccount, byInstallation]) expect(read.map((target) => target.simulated)).toEqual([false, true]);
  });

  it("reads a target without `simulated` as real, as a database before the migration returns it (boundary: mixed deploy, #495)", async () => {
    const rows = targets(1).map(({ simulated: _simulated, ...row }) => row);
    const { store } = storeWith({ list_webhook_targets: () => rows });

    const byAccount = await store.listWebhookTargets({ provider: "github", externalAccountId: "github-acct-1", installationId: null, endpointId: null });
    const byInstallation = await store.listInstallationTargets({ provider: "github", installationId: "github-installation-1", endpointId: null });

    for (const read of [byAccount, byInstallation]) expect(read.map((target) => target.simulated)).toEqual([false]);
  });

  it.each([
    { name: "one below the bound", count: WEBHOOK_TARGET_LIMIT - 1, warned: false },
    { name: "at the bound", count: WEBHOOK_TARGET_LIMIT, warned: true },
  ])("logs a target list cut at WEBHOOK_TARGET_LIMIT (boundary: $name)", async ({ count, warned }) => {
    const { store } = storeWith({ list_webhook_targets: () => targets(count) });
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);

    const read = await store.listWebhookTargets({ provider: "fake", externalAccountId: "fake-acct-1", installationId: null, endpointId: null });

    expect(read).toHaveLength(count);
    expect(warn.mock.calls).toEqual(warned ? [["webhook.targets_truncated", { provider: "fake", targets: count }]] : []);
  });

  it("stores the outcome as JSON with ISO event dates and no endpoint for an app-level delivery", async () => {
    const { store, requests } = storeWith({ record_webhook_delivery: () => [true] });
    const signup = {
      typeId: "fake.signup",
      occurredAt: new Date("2026-11-14T09:30:00.000Z"),
      severity: "info",
      title: "New signup",
      externalAccountId: "fake-acct-1",
      dedupeKey: "fake.signup:fake-acct-1:2026-11-14",
    } as const;

    await store.recordWebhookDelivery({
      provider: "fake",
      deliveryId: "delivery-1",
      endpointId: null,
      outcome: { kind: "events", externalAccountId: "fake-acct-1", events: [signup] },
    });

    expect(requests.map((request) => request.args)).toEqual([
      {
        p_provider: "fake",
        p_delivery_id: "delivery-1",
        p_outcome: { kind: "events", externalAccountId: "fake-acct-1", events: [{ ...signup, occurredAt: "2026-11-14T09:30:00.000Z" }] },
      },
    ]);
  });

  it.each([
    { name: "already processed", rows: [{ id: DELIVERY_ID, provider: "fake", endpoint_id: null, status: "processed", outcome: null }] },
    { name: "purged", rows: [] },
  ])("loads nothing for a delivery that is $name (boundary: nothing left to do)", async ({ rows }) => {
    const { store } = storeWith({}, { webhook_deliveries: rows });

    expect(await store.loadWebhookDelivery(DELIVERY_ID)).toBeNull();
  });
});
