import { expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";

import { Constants, type Database } from "../../src/lib/supabase/database.types";

import { adminClient, type TestWorkspace } from "./db";

/*
 * Synthetic data for the badge, card, and year in review specs (#149, #151, #262): one project with
 * a real (not simulated) GitHub, Vercel, Supabase, Resend, and Stripe connection, 36 days of
 * history, and a fresh sync, so every metric in the public metric engine has a value. Seeds only
 * inside the given workspace, which deleting the workspace removes. Also the helpers those specs
 * share for reading the images.
 */

/** A context with no session, as a README, a social network, or a stranger reads the routes. */
export async function anonymous(baseURL: string | undefined): Promise<APIRequestContext> {
  if (baseURL === undefined) throw new Error("baseURL is not configured");
  return playwrightRequest.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
}

/** Width and height from a PNG's IHDR chunk (PNG specification, section 11.2.2). */
export function pngSize(body: Buffer): { width: number; height: number } {
  expect(body.subarray(1, 4).toString("latin1")).toBe("PNG");
  return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
}

type ProviderId = Database["public"]["Enums"]["provider_id"];
export type PublicMetricId = Database["public"]["Enums"]["public_metric_id"];

/** Every metric the engine defines, as the database enum lists them. */
export const ALL_METRIC_IDS: readonly PublicMetricId[] = Constants.public.Enums.public_metric_id;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
export const HISTORY_DAYS = 36;
/** GitHub stars today: 1,000 on the first stored day, 6 more each day after. */
export const STARS_TODAY = 1000 + 6 * (HISTORY_DAYS - 1);

const PROVIDERS = ["github", "vercel", "supabase", "resend", "stripe"] as const satisfies readonly ProviderId[];

type Seeded = Readonly<{ projectId: string; accounts: Readonly<Record<(typeof PROVIDERS)[number], { connectionId: string; accountId: string }>> }>;

function check(error: { code: string } | null, what: string): void {
  if (error) throw new Error(`Seeding ${what} failed (code ${error.code}).`);
}

const LONDON_CLOCK = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  hourCycle: "h23",
});

/** The Europe/London calendar date and hour at `instant`. */
function londonClock(instant: number): Readonly<{ year: number; month: number; day: number; hour: number }> {
  const parts = LONDON_CLOCK.formatToParts(instant);
  const part = (type: "year" | "month" | "day" | "hour"): number => {
    const value = Number(parts.find((candidate) => candidate.type === type)?.value);
    if (!Number.isInteger(value)) throw new Error(`No London ${type} for ${new Date(instant).toISOString()}.`);
    return value;
  };
  return { year: part("year"), month: part("month"), day: part("day"), hour: part("hour") };
}

/**
 * The start of the Europe/London day `daysAgo` London days before the one `now` falls on. The year
 * in review counts events per London day (`year_review_event_counts`), so each seeded day has to be
 * exactly one London day whatever the time of day the run starts: a fixed UTC offset from `now`
 * puts two seeded days on one London day around a clock change (#581). Midnight is never ambiguous,
 * because the clocks change at 01:00 UTC, and today's is never after `now`, so the newest seeded
 * day is always today: on 1 January it is 00:00 UTC, inside the new year's window from the start.
 */
function londonDayStart(now: number, daysAgo: number): Date {
  const today = londonClock(now);
  const utcMidnight = Date.UTC(today.year, today.month - 1, today.day - daysAgo);
  // 00:00 UTC reads 01:00 in London under British Summer Time, so step back the difference.
  return new Date(utcMidnight - londonClock(utcMidnight).hour * HOUR_MS);
}

export async function seedShareProject(workspace: TestWorkspace, name = "Acme web"): Promise<Seeded> {
  const admin = adminClient();
  const now = Date.now();
  const synced = new Date(now - 5 * 60_000).toISOString();

  const { data: project, error: projectError } = await admin
    .from("projects")
    .insert({ workspace_id: workspace.id, name })
    .select("id")
    .single();
  check(projectError, "a project");
  if (project === null) throw new Error("Seeding a project returned no row.");

  const entries = await Promise.all(
    PROVIDERS.map(async (provider) => {
      const { data: connection, error: connectionError } = await admin
        .from("connections")
        .insert({
          workspace_id: workspace.id,
          provider,
          status: "active",
          granted_at: new Date().toISOString(),
          ...(provider === "stripe" ? { mode: "live" as const } : {}),
          display_name: provider,
          poll_interval_seconds: 3600,
          // Far in the future, so no tick another spec runs ever syncs this credential-less row.
          next_sync_at: new Date(now + 30 * DAY_MS).toISOString(),
          last_synced_at: synced,
        })
        .select("id")
        .single();
      check(connectionError, `a ${provider} connection`);
      if (connection === null) throw new Error("Seeding a connection returned no row.");
      const { data: account, error: accountError } = await admin
        .from("external_accounts")
        .insert({
          workspace_id: workspace.id,
          connection_id: connection.id,
          external_id: `share-e2e-${provider}`,
          display_name: `example-${provider}`,
          kind: "organization",
          project_id: project.id,
        })
        .select("id")
        .single();
      check(accountError, `a ${provider} account`);
      if (account === null) throw new Error("Seeding an account returned no row.");
      return [provider, { connectionId: connection.id, accountId: account.id }] as const;
    }),
  );
  const accounts = Object.fromEntries(entries) as Seeded["accounts"];

  const snapshot = (
    provider: (typeof PROVIDERS)[number],
    metricKey: string,
    kind: Database["public"]["Enums"]["metric_kind"],
    value: number,
    unit: string,
    at: Date,
  ): Database["public"]["Tables"]["usage_snapshots"]["Insert"] => ({
    workspace_id: workspace.id,
    connection_id: accounts[provider].connectionId,
    external_account_id: accounts[provider].accountId,
    metric_key: metricKey,
    kind,
    label: metricKey,
    snapshot_date: at.toISOString().slice(0, 10),
    value,
    unit,
    point_at: at.toISOString(),
    retrieved_at: at.toISOString(),
    provenance_source: "provider_api",
  });
  const today = new Date(now - 5 * 60_000);
  const snapshots = [
    ...Array.from({ length: HISTORY_DAYS }, (_, index) =>
      snapshot("github", "github.stars.total", "usage", 1000 + 6 * index, "stars", new Date(today.getTime() - (HISTORY_DAYS - 1 - index) * DAY_MS)),
    ),
    snapshot("github", "github.usage.actions.minutes", "usage", 420, "minutes", today),
    snapshot("resend", "resend.emails.monthly.used", "usage", 1250, "emails", today),
    snapshot("resend", "resend.emails.monthly.limit", "included_allowance", 3000, "emails", today),
  ];
  const { error: snapshotError } = await admin.from("usage_snapshots").insert(snapshots);
  check(snapshotError, "snapshots");

  const event = (provider: (typeof PROVIDERS)[number], typeId: string, daysAgo: number, index: number) => ({
    workspace_id: workspace.id,
    connection_id: accounts[provider].connectionId,
    external_account_id: accounts[provider].accountId,
    provider,
    type_id: typeId,
    severity: typeId.endsWith("failed") ? ("critical" as const) : ("success" as const),
    title: typeId,
    occurred_at: londonDayStart(now, daysAgo).toISOString(),
    dedupe_key: `share-e2e-${typeId}-${daysAgo}-${index}`,
  });
  const days = Array.from({ length: HISTORY_DAYS }, (_, daysAgo) => daysAgo);
  const events = [
    event("vercel", "vercel.deployment.failed", HISTORY_DAYS, 0),
    ...days.flatMap((daysAgo) => [event("vercel", "vercel.deployment.succeeded", daysAgo, 0), event("vercel", "vercel.deployment.succeeded", daysAgo, 1)]),
    ...days.map((daysAgo) => event("supabase", "supabase.auth.signup", daysAgo, 0)),
    ...days.filter((daysAgo) => daysAgo % 3 === 0).map((daysAgo) => event("stripe", "stripe.customer.created", daysAgo, 0)),
    ...days.filter((daysAgo) => daysAgo % 2 === 0).map((daysAgo) => event("stripe", "stripe.charge.succeeded", daysAgo, 0)),
  ];
  const { error: eventError } = await admin.from("activity_events").insert(events);
  check(eventError, "events");

  return { projectId: project.id, accounts };
}

/** Publishes the given metrics of a project exactly, as the owner, the way the publish action stores them. */
export async function publishMetrics(workspace: TestWorkspace, projectId: string, metricIds: readonly PublicMetricId[]): Promise<void> {
  const { error } = await adminClient()
    .from("published_metrics")
    .insert(metricIds.map((metricId) => ({ workspace_id: workspace.id, project_id: projectId, metric_id: metricId, published_by: workspace.ownerId })));
  check(error, "publications");
}
