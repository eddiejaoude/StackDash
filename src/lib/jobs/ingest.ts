import type { ActivityEvent } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import type { ProviderId } from "@/lib/adapters/types";
import type { SnapshotInput } from "@/lib/dashboard/aggregate";
import { providerName } from "@/lib/providers";

import type { EventRow, JobStore, SnapshotRow, SyncAccount, SyncConnection } from "./store";

/*
 * Writes one external account's validated sync output (#44, #53).
 *
 * Idempotent by construction, so a retried or repeated sync never duplicates data:
 * - Snapshots upsert on (external_account_id, metric_key, snapshot_date). The latest row per
 *   (external_account_id, metric_key) is the current value; older rows are the daily history.
 * - Events insert on (workspace_id, dedupe_key). An event already stored only gains a body it was
 *   stored without (#499): a webhook delivery that lacks a detail the poll reads, such as Vercel's
 *   error code, gets it from the next poll. Nothing else of a stored event ever changes.
 * - The cursor is stored last, so a crash before it only makes the next sync re-read events that
 *   the dedupe key then skips.
 */

export const ALLOWANCE_RESET_TYPE_ID = "stackdash.allowance_reset";

/** UTC calendar date (YYYY-MM-DD) of an instant: the snapshot day boundary. */
export function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Maps the metric union onto usage_snapshots columns. Every nullable column is set, null when the
 * metric has no value for it, so the row is also what the stores read back (`SnapshotInput`).
 */
export function toSnapshotRow(
  metric: AdapterMetric,
  connection: Pick<SyncConnection, "id" | "workspace_id">,
  account: Pick<SyncAccount, "id">,
): SnapshotRow & SnapshotInput {
  const money =
    metric.kind === "verified_spend" ||
    metric.kind === "estimated_spend" ||
    metric.kind === "credit_balance" ||
    metric.kind === "revenue" ||
    metric.kind === "recurring_revenue";
  const timeframe = metric.timeframe;
  return {
    workspace_id: connection.workspace_id,
    connection_id: connection.id,
    external_account_id: account.id,
    metric_key: metric.metricKey,
    kind: metric.kind,
    label: metric.label,
    snapshot_date: utcDate(metric.retrievedAt),
    retrieved_at: metric.retrievedAt.toISOString(),
    value: money ? null : metric.value,
    unit: money ? null : metric.unit,
    amount_minor: money ? metric.amountMinor : null,
    currency: money ? metric.currency : null,
    period_start: timeframe.type === "period" ? timeframe.start.toISOString() : null,
    period_end: timeframe.type === "period" ? timeframe.end.toISOString() : null,
    point_at: timeframe.type === "point" ? timeframe.at.toISOString() : null,
    resets_at: metric.resetsAt?.toISOString() ?? null,
    provenance_source: metric.provenance.source,
    provenance_endpoint: metric.provenance.endpoint ?? null,
    pricing_source: metric.provenance.pricingSource ?? null,
  };
}

/**
 * Prefixed with the provider so two adapters can never collide in a workspace's dedupe space,
 * while two connections to the same provider account share keys and store each event once.
 */
export function adapterEventDedupeKey(provider: ProviderId, dedupeKey: string): string {
  return `${provider}:${dedupeKey}`;
}

export function toEventRow(
  event: ActivityEvent,
  provider: ProviderId,
  connection: Pick<SyncConnection, "id" | "workspace_id">,
  account: Pick<SyncAccount, "id">,
): EventRow {
  return {
    workspace_id: connection.workspace_id,
    connection_id: connection.id,
    external_account_id: account.id,
    provider,
    type_id: event.typeId,
    severity: event.severity,
    title: event.title,
    body: event.body ?? null,
    url: event.url ?? null,
    occurred_at: event.occurredAt.toISOString(),
    dedupe_key: adapterEventDedupeKey(provider, event.dedupeKey),
  };
}

// Reset events are raised for the allowance itself. A provider that reports only what is left
// (no included_allowance metric) gets them for remaining_allowance instead, so each allowance
// produces one event per rollover rather than one per related metric.
function resetCandidates(metrics: readonly AdapterMetric[]): AdapterMetric[] {
  const included = metrics.filter((metric) => metric.kind === "included_allowance");
  return included.length > 0 ? included : metrics.filter((metric) => metric.kind === "remaining_allowance");
}

/**
 * A billing period rolled over when the stored reset time has passed and the new snapshot resets
 * later. The event is keyed on the account, metric, and old reset time, so it is written exactly
 * once per rollover however many syncs observe it.
 */
export function allowanceResetEvents(input: {
  metrics: readonly AdapterMetric[];
  previousResets: ReadonlyMap<string, string | null>;
  connection: Pick<SyncConnection, "id" | "workspace_id">;
  account: Pick<SyncAccount, "id" | "display_name">;
  providerName: string;
}): EventRow[] {
  const rows: EventRow[] = [];
  for (const metric of resetCandidates(input.metrics)) {
    const previous = input.previousResets.get(metric.metricKey);
    if (previous === undefined || previous === null || metric.resetsAt === undefined) continue;
    const previousAt = new Date(previous);
    if (previousAt.getTime() > metric.retrievedAt.getTime()) continue;
    if (metric.resetsAt.getTime() <= previousAt.getTime()) continue;
    const previousIso = previousAt.toISOString();
    rows.push({
      workspace_id: input.connection.workspace_id,
      connection_id: input.connection.id,
      external_account_id: input.account.id,
      provider: null,
      type_id: ALLOWANCE_RESET_TYPE_ID,
      severity: "info",
      title: `${input.providerName} allowance reset for ${input.account.display_name}`,
      body: `${metric.label} started a new billing period.`,
      url: null,
      occurred_at: previousIso,
      dedupe_key: `allowance_reset:${input.account.id}:${metric.metricKey}:${previousIso}`,
    });
  }
  return rows;
}

// A batch naming the same metric twice would make one upsert touch a row twice, which Postgres
// rejects. The last one wins, as it would across two syncs.
function lastPerConflictKey(rows: readonly SnapshotRow[]): SnapshotRow[] {
  const byKey = new Map<string, SnapshotRow>();
  for (const row of rows) byKey.set(`${row.metric_key}|${row.snapshot_date}`, row);
  return [...byKey.values()];
}

export type IngestInput = Readonly<{
  store: JobStore;
  provider: ProviderId;
  connection: Pick<SyncConnection, "id" | "workspace_id">;
  account: SyncAccount;
  // Already validated with validateAdapterMetrics/validateAdapterEvents and checked to belong to
  // this account.
  metrics: readonly AdapterMetric[];
  events: readonly ActivityEvent[];
  cursor: string | undefined;
}>;

export async function ingestSyncResult(input: IngestInput): Promise<void> {
  const { store, provider, connection, account } = input;

  // Read before the upsert overwrites today's row with the new period's reset time.
  const previousResets = await store.latestResets(connection.workspace_id, account.id);
  const resetRows = allowanceResetEvents({
    metrics: input.metrics,
    previousResets,
    connection,
    account,
    providerName: providerName(provider),
  });

  // Events go first: if the snapshot upsert then fails, the retry still sees the old reset time
  // and the dedupe key stops the reset event from being written twice.
  await store.insertEvents([
    ...input.events.map((event) => toEventRow(event, provider, connection, account)),
    ...resetRows,
  ]);
  await store.upsertSnapshots(lastPerConflictKey(input.metrics.map((metric) => toSnapshotRow(metric, connection, account))));

  const cursor = input.cursor ?? null;
  if (cursor !== account.sync_cursor) await store.setCursor(connection.workspace_id, account.id, cursor);
}
