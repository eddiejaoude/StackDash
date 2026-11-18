import type { Database } from "../../src/lib/supabase/database.types";

import { adminClient, type TestWorkspace } from "./db";

/*
 * Synthetic data for the stale data spec (#267): a workspace whose every connection last synced
 * `staleDays` ago, as a demo workspace left alone over a weekend looks. An Example provider (fake)
 * connection with a month to date running total of spend, read once a day; a Vercel connection
 * with two successful deployments a day; a GitHub connection whose star count grows by 5 a day;
 * and a Supabase connection with one signup a day. History runs HISTORY_DAYS back from the sync,
 * long enough for the last complete week and month and the ones before them. Seeds only inside the
 * given workspace, which deleting the workspace removes.
 */

const DAY_MS = 86_400_000;
const HISTORY_DAYS = 75;

type SnapshotInsert = Database["public"]["Tables"]["usage_snapshots"]["Insert"];
type EventInsert = Database["public"]["Tables"]["activity_events"]["Insert"];

const PROVIDERS = ["fake", "vercel", "github", "supabase"] as const;
type Provider = (typeof PROVIDERS)[number];

export type StaleSeed = Readonly<{
  /** When every connection last synced. */
  syncedAt: Date;
  connectionIds: Readonly<Record<Provider, string>>;
}>;

function check(error: { code: string } | null, what: string): void {
  if (error) throw new Error(`Seeding ${what} failed (code ${error.code}).`);
}

export async function seedStaleWorkspace(workspace: TestWorkspace, staleDays = 3): Promise<StaleSeed> {
  const admin = adminClient();
  const now = Date.now();
  const syncedAt = new Date(now - staleDays * DAY_MS);
  const syncDay = Math.floor(syncedAt.getTime() / DAY_MS) * DAY_MS;
  const firstDay = syncDay - HISTORY_DAYS * DAY_MS;
  const isoDate = (time: number) => new Date(time).toISOString().slice(0, 10);
  // One reading a day at noon, and the last one at the sync itself.
  const readAt = (day: number) => new Date(day === syncDay ? syncedAt.getTime() : day + 12 * 3_600_000).toISOString();
  const days: number[] = [];
  for (let day = firstDay; day <= syncDay; day += DAY_MS) {
    if (day + 12 * 3_600_000 <= syncedAt.getTime() || day === syncDay) days.push(day);
  }

  const { data: connections, error: connectionsError } = await admin
    .from("connections")
    .insert(
      PROVIDERS.map((provider) => ({
        workspace_id: workspace.id,
        provider,
        status: "active" as const,
        granted_at: new Date().toISOString(),
        display_name: `${provider} stale connection`,
        poll_interval_seconds: 3_600,
        // Far in the future, so no tick another spec runs ever syncs this credential-less row.
        next_sync_at: new Date(now + 30 * DAY_MS).toISOString(),
        last_synced_at: syncedAt.toISOString(),
      })),
    )
    .select("id, provider");
  check(connectionsError, "connections");
  if (connections === null) throw new Error("Seeding connections returned no rows.");
  const { data: accounts, error: accountsError } = await admin
    .from("external_accounts")
    .insert(
      connections.map((connection) => ({
        workspace_id: workspace.id,
        connection_id: connection.id,
        external_id: `stale-e2e-${connection.provider}`,
        display_name: `example-${connection.provider}`,
        kind: "organization",
      })),
    )
    .select("id, connection_id");
  check(accountsError, "accounts");
  if (accounts === null) throw new Error("Seeding accounts returned no rows.");
  const ids = (provider: Provider) => {
    const connection = connections.find((row) => row.provider === provider);
    const account = accounts.find((row) => row.connection_id === connection?.id);
    if (connection === undefined || account === undefined) throw new Error(`No seeded ${provider} account.`);
    return { connection_id: connection.id, external_account_id: account.id };
  };

  const snapshots: SnapshotInsert[] = [
    // Month to date spend, 150 a day.
    ...days.map((day): SnapshotInsert => {
      const monthStart = Date.UTC(new Date(day).getUTCFullYear(), new Date(day).getUTCMonth(), 1);
      return {
        workspace_id: workspace.id,
        ...ids("fake"),
        metric_key: "fake.spend.month",
        kind: "verified_spend",
        label: "Spend this month",
        snapshot_date: isoDate(day),
        amount_minor: 150 * ((day - monthStart) / DAY_MS + 1),
        currency: "USD",
        period_start: new Date(monthStart).toISOString(),
        period_end: readAt(day),
        retrieved_at: readAt(day),
        provenance_source: "provider_api",
      };
    }),
    // The star count, 5 more each day.
    ...days.map((day, index): SnapshotInsert => ({
      workspace_id: workspace.id,
      ...ids("github"),
      metric_key: "github.stars.total",
      kind: "usage",
      label: "Stars",
      snapshot_date: isoDate(day),
      value: 500 + 5 * index,
      unit: "stars",
      point_at: readAt(day),
      retrieved_at: readAt(day),
      provenance_source: "provider_api",
    })),
    // Vercel and Supabase report no money; a first reading says they were connected all along.
    ...(["vercel", "supabase"] as const).map((provider): SnapshotInsert => ({
      workspace_id: workspace.id,
      ...ids(provider),
      metric_key: `${provider}.plan.limit`,
      kind: "included_allowance",
      label: "Plan limit",
      snapshot_date: isoDate(firstDay),
      value: 1_000,
      unit: "requests",
      point_at: readAt(firstDay),
      retrieved_at: readAt(firstDay),
      provenance_source: "provider_api",
    })),
  ];
  const { error: snapshotsError } = await admin.from("usage_snapshots").insert(snapshots);
  check(snapshotsError, "snapshots");

  const event = (provider: "vercel" | "supabase", typeId: string, day: number, index: number): EventInsert => ({
    workspace_id: workspace.id,
    ...ids(provider),
    provider,
    type_id: typeId,
    severity: "success",
    title: typeId,
    occurred_at: new Date(day + (index + 1) * 3_600_000).toISOString(),
    dedupe_key: `stale-e2e-${typeId}-${day}-${index}`,
  });
  const { error: eventsError } = await admin.from("activity_events").insert([
    ...days.flatMap((day) => [event("vercel", "vercel.deployment.succeeded", day, 0), event("vercel", "vercel.deployment.succeeded", day, 1)]),
    ...days.map((day) => event("supabase", "supabase.auth.signup", day, 0)),
  ]);
  check(eventsError, "events");

  return {
    syncedAt,
    connectionIds: Object.fromEntries(PROVIDERS.map((provider) => [provider, ids(provider).connection_id])) as Record<Provider, string>,
  };
}
