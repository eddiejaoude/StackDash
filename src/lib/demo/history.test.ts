import { beforeAll, describe, expect, it, vi } from "vitest";

import { simulatedAdapters } from "@/lib/adapters/simulated";
import { SIMULATED_SCOPE, simulatedCredentialMetadata } from "@/lib/adapters/simulated/marker";
import { DAY_MS, isLaunchDay, SLOT_MS, slotOf } from "@/lib/adapters/simulated/simulation";
import { Secret, type OAuthClient, type OAuthCredential, type ProviderAdapter } from "@/lib/adapters/types";
import { TOTAL_METRIC_KEY } from "@/lib/adapters/vercel";
import { ANOMALY_TYPE_ID } from "@/lib/alerts/anomaly";
import { headlineWindows } from "@/lib/dashboard/headline";
import { buildTrends, TREND_DAYS, type TrendConnection, type TrendRow } from "@/lib/dashboard/trends";
import { DAILY_SUMMARY_TYPE_ID } from "@/lib/jobs/daily-summary";
import { utcDate } from "@/lib/jobs/ingest";
import { MemoryJobStore, type MemorySnapshot } from "@/lib/jobs/memory-store";
import { runSyncJob, type SyncDeps } from "@/lib/jobs/sync-connection";
import type { Logger } from "@/lib/log/logger";
import { memoryNotificationDeps } from "@/lib/notifications/memory-store";
import { groupEventsByDay, londonDate } from "@/lib/timeline/days";

import {
  DEMO_HISTORY_DAYS,
  demoAccountSeed,
  demoCommandRefusal,
  headlineWeekDays,
  historySteps,
  replayClock,
  replayHistory,
} from "./history";

const WORKSPACE_ID = "16616616-6166-4166-8166-166166166166";
// Mid afternoon, so subtracting whole days never crosses a London midnight on a clock change.
const NOW = new Date("2026-11-05T14:23:17.000Z");
const silent: Logger = { info: () => {}, warn: () => {}, error: () => {} };
const client: OAuthClient = { clientId: "simulated", clientSecret: new Secret("simulated"), extra: {} };
const LONDON_TIME = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

describe("demoCommandRefusal", () => {
  const local = "http://127.0.0.1:56421";

  it("allows the local stack with simulation on", () => {
    expect(demoCommandRefusal({ simulationEnabled: true, supabaseUrl: local })).toBeNull();
  });

  it("refuses with simulation off, even against the local stack", () => {
    expect(demoCommandRefusal({ simulationEnabled: false, supabaseUrl: local })).toMatch(/simulation is off/);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["whitespace", "  "],
  ])("refuses when the Supabase URL is %s", (_title, supabaseUrl) => {
    expect(demoCommandRefusal({ simulationEnabled: true, supabaseUrl })).toMatch(/not set/);
  });

  it.each([
    ["a hosted project", "https://abcdefghijklmnop.supabase.co"],
    ["a private network address", "http://10.0.0.5:54321"],
    ["every interface", "http://0.0.0.0:54321"],
  ])("refuses %s", (_title, supabaseUrl) => {
    expect(demoCommandRefusal({ simulationEnabled: true, supabaseUrl })).toMatch(/not a Supabase stack on this computer/);
  });
});

describe("demoAccountSeed", () => {
  it("is eight hex characters, the same for the same seed and provider", () => {
    expect(demoAccountSeed("devmacro-demo", "vercel")).toMatch(/^[0-9a-f]{8}$/);
    expect(demoAccountSeed("devmacro-demo", "vercel")).toBe(demoAccountSeed("devmacro-demo", "vercel"));
  });

  it("differs between providers and between seeds, including seeds that only differ by joining", () => {
    const seeds = new Set([
      demoAccountSeed("devmacro-demo", "vercel"),
      demoAccountSeed("devmacro-demo", "github"),
      demoAccountSeed("rehearsal", "vercel"),
      demoAccountSeed("a", "bvercel"),
      demoAccountSeed("ab", "vercel"),
    ]);
    expect(seeds.size).toBe(5);
  });
});

describe("historySteps", () => {
  it("closes each of the 90 London days before today in the last slot before London midnight, then ends at now", () => {
    const steps = historySteps(NOW);
    expect(steps).toHaveLength(DEMO_HISTORY_DAYS + 1);
    // British Summer Time: London midnight is 23:00 UTC.
    expect(steps[0]).toEqual({ at: new Date("2026-08-07T22:59:50.000Z"), summaryDate: "2026-08-07" });
    expect(steps.at(-2)).toEqual({ at: new Date("2026-11-04T23:59:50.000Z"), summaryDate: "2026-11-04" });
    expect(steps.at(-1)).toEqual({ at: NOW, summaryDate: null });
    for (const step of steps.slice(0, -1)) {
      // The snapshot keeps the day's UTC date, and the next slot is the next London day.
      expect(step.at.toISOString().slice(0, 10)).toBe(step.summaryDate);
      const next = new Date(step.at.getTime() + SLOT_MS);
      expect(LONDON_TIME.format(next)).toBe("00:00:00");
      expect(londonDate(step.at)).toBe(step.summaryDate);
    }
  });

  it("steps 25 hours across the October clock change and 24 on either side", () => {
    const steps = historySteps(new Date("2026-10-27T12:00:00.000Z"), 3);
    expect(steps.map((step) => step.at.toISOString())).toEqual([
      "2026-10-24T22:59:50.000Z",
      "2026-10-25T23:59:50.000Z",
      "2026-10-26T23:59:50.000Z",
      "2026-10-27T12:00:00.000Z",
    ]);
  });

  it("keeps the last past step before now when now is exactly UTC midnight", () => {
    const midnight = new Date("2026-11-05T00:00:00.000Z");
    const steps = historySteps(midnight, 1);
    expect(steps).toEqual([
      { at: new Date("2026-11-04T23:59:50.000Z"), summaryDate: "2026-11-04" },
      { at: midnight, summaryDate: null },
    ]);
  });

  it("closes the London day that just ended when London is already in the next day but UTC is not", () => {
    // 00:30 in London on 2026-08-09, so 2026-08-08 is yesterday on the timeline.
    const lateEvening = new Date("2026-08-08T23:30:00.000Z");
    expect(historySteps(lateEvening, 1)).toEqual([
      { at: new Date("2026-08-08T22:59:50.000Z"), summaryDate: "2026-08-08" },
      { at: lateEvening, summaryDate: null },
    ]);
  });

  it("is only now for zero days", () => {
    expect(historySteps(NOW, 0)).toEqual([{ at: NOW, summaryDate: null }]);
  });
});

describe("headlineWeekDays", () => {
  it.each([
    ["a Monday (only the Sunday before)", "2026-11-09T12:00:00.000Z", 1],
    ["a Tuesday", "2026-11-10T12:00:00.000Z", 2],
    ["a Sunday (the most in winter)", "2026-11-15T12:00:00.000Z", 7],
    ["a summer Sunday 23:30 UTC, already Monday in London (boundary)", "2026-07-05T23:30:00.000Z", 8],
    ["a summer Monday 23:30 UTC, already Tuesday in London", "2026-07-06T23:30:00.000Z", 2],
  ])("counts the days back for %s", (_title, at, expected) => {
    expect(headlineWeekDays(new Date(at))).toBe(expected);
  });

  it.each(["2026-11-09T00:00:00.000Z", "2026-11-12T08:00:00.000Z", "2026-11-15T23:59:59.000Z", "2026-07-05T23:30:00.000Z"])(
    "replays a reading for the day before the headline week and every day of it to date at %s",
    (at) => {
      const now = new Date(at);
      const { current } = headlineWindows("week", now);
      const dates = historySteps(now, headlineWeekDays(now)).map((step) => utcDate(step.at));
      const needed: string[] = [];
      for (let day = Date.parse(`${current.start}T00:00:00Z`) - DAY_MS; utcDate(new Date(day)) <= current.end; day += DAY_MS) {
        needed.push(utcDate(new Date(day)));
      }
      expect(dates).toEqual(expect.arrayContaining(needed));
    },
  );
});

describe("replayClock", () => {
  it("moves the jobs' clock and every adapter context's clock together, from the start", () => {
    const live: SyncDeps = {
      store: new MemoryJobStore(() => NOW),
      getAdapter: () => simulatedAdapters.vercel,
      loadOAuthClient: () => client,
      createOAuthContext: (oauthClient) => ({ client: oauthClient, fetch: vi.fn(), now: () => NOW, timeoutMs: 1000, logger: silent }),
      now: () => NOW,
      random: () => 0.5,
      logError: () => "REF-TEST0000",
      log: silent,
      evaluateAlerts: async () => {},
      evaluateAchievements: async () => 0,
      notifications: () => memoryNotificationDeps(),
    };
    const start = new Date("2026-11-02T23:59:50.000Z");
    const { deps, setNow } = replayClock(live, start);
    expect(deps.store).toBe(live.store);
    expect(deps.now()).toEqual(start);
    expect(deps.createOAuthContext(client).now()).toEqual(start);

    setNow(NOW);
    expect(deps.now()).toEqual(NOW);
    expect(deps.createOAuthContext(client).now()).toEqual(NOW);
  });
});

function trendRow(row: MemorySnapshot): TrendRow {
  return {
    connection_id: row.connection_id,
    external_account_id: row.external_account_id,
    metric_key: row.metric_key,
    kind: row.kind,
    label: row.label,
    snapshot_date: row.snapshot_date,
    value: row.value ?? null,
    unit: row.unit ?? null,
    amount_minor: row.amount_minor ?? null,
    currency: row.currency ?? null,
    retrieved_at: row.retrieved_at,
    provenance_source: row.provenance_source,
  };
}

describe("replayHistory with every simulated provider in the registry", () => {
  let clock = NOW;
  const now = () => clock;
  const store = new MemoryJobStore(now);
  const adapters: ProviderAdapter[] = Object.values(simulatedAdapters);
  const connectionIds: string[] = [];
  const alertClocks: string[] = [];
  let deps: SyncDeps;

  beforeAll(async () => {
    for (const adapter of adapters) {
      const connection = store.addConnection({
        workspace_id: WORKSPACE_ID,
        provider: adapter.id,
        granted_scopes: [SIMULATED_SCOPE],
        poll_interval_seconds: adapter.pollIntervalSeconds,
      });
      const credential: OAuthCredential = {
        accessToken: new Secret("simulated-at-test"),
        scopes: [SIMULATED_SCOPE],
        tokenType: "bearer",
        metadata: simulatedCredentialMetadata(demoAccountSeed("test", adapter.id)),
      };
      store.credentials.set(connection.id, credential);
      const ctx = { client, fetch: vi.fn(), now, timeoutMs: 1000, logger: silent };
      for (const account of await adapter.listAccounts(credential, ctx)) {
        store.addAccount({ workspace_id: WORKSPACE_ID, connection_id: connection.id, external_id: account.externalId, display_name: account.displayName });
      }
      connectionIds.push(connection.id);
    }
    deps = {
      store,
      getAdapter: (id) => {
        if (id === "fake") throw new Error("the demo never uses the fake provider");
        return simulatedAdapters[id];
      },
      loadOAuthClient: () => client,
      createOAuthContext: (oauthClient) => ({
        client: oauthClient,
        fetch: () => Promise.reject(new Error("no network in tests")),
        now,
        timeoutMs: 1000,
        logger: silent,
      }),
      now,
      random: () => 0.5,
      logError: () => "REF-TEST0000",
      log: silent,
      evaluateAlerts: async (_workspaceId, at) => {
        alertClocks.push(at.toISOString());
      },
      evaluateAchievements: async () => 0,
      notifications: () => memoryNotificationDeps(),
    };
    await replayHistory({
      deps,
      setNow: (at) => {
        clock = at;
      },
      workspaceId: WORKSPACE_ID,
      connectionIds,
      steps: historySteps(NOW),
    });
  }, 120_000);

  it("fills 30 daily trend points and at least 3 monthly ones for every provider", () => {
    const rows = store.snapshots.map(trendRow);
    const connections: TrendConnection[] = store.connections;
    const daily = buildTrends(rows, connections, "daily", NOW);
    const monthly = buildTrends(rows, connections, "monthly", NOW);
    for (const adapter of adapters) {
      const full = daily.filter((series) => series.provider === adapter.id && series.points.every((point) => point.value !== null));
      expect(full.length, adapter.id).toBeGreaterThan(0);
      for (const series of full) expect(series.points).toHaveLength(TREND_DAYS);
      const months = monthly.filter((series) => series.provider === adapter.id).map((series) => series.points.filter((point) => point.value !== null).length);
      expect(Math.max(...months), adapter.id).toBeGreaterThanOrEqual(3);
    }
  });

  it("puts events on every one of the last 90 London days", () => {
    const newestFirst = store.events.toSorted((a, b) => Date.parse(b.occurred_at) - Date.parse(a.occurred_at));
    const days = new Set(groupEventsByDay(newestFirst, NOW).map((day) => day.date));
    for (let back = 0; back < DEMO_HISTORY_DAYS; back += 1) {
      expect(days.has(londonDate(new Date(NOW.getTime() - back * DAY_MS))), `${back} days back`).toBe(true);
    }
  });

  it("puts each Vercel deploy burst on the same day as its spend spike, once in the 30 day trend", () => {
    const vercel = store.connections.find((connection) => connection.provider === "vercel");
    const account = store.accounts.find((row) => row.connection_id === vercel?.id);
    if (account === undefined) throw new Error("expected a Vercel account");
    const pastDays = historySteps(NOW).flatMap((step) => (step.summaryDate === null ? [] : [step.summaryDate]));
    const isLaunch = (date: string) => isLaunchDay(account.external_id, Date.parse(`${date}T12:00:00Z`));
    expect(pastDays.slice(-TREND_DAYS).filter(isLaunch)).toHaveLength(1);
    // Days after the first: its own day keeps only the 30 minute first sync.
    const launches = pastDays.slice(1).filter(isLaunch);
    const ordinary = pastDays.slice(1).filter((date) => !isLaunch(date));
    expect(launches.length).toBeGreaterThanOrEqual(2);

    // The timeline groups by London day; the replay reads the half hour before London midnight.
    const deploys = new Map<string, number>();
    for (const event of store.events) {
      if (event.provider !== "vercel") continue;
      const date = londonDate(new Date(event.occurred_at));
      deploys.set(date, (deploys.get(date) ?? 0) + 1);
    }
    const busiestOrdinary = Math.max(...ordinary.map((date) => deploys.get(date) ?? 0));

    // Month to date, so a day's spend is its rise from the day before; a month's first day restarts.
    const totals = new Map(
      store.snapshots
        .filter((row) => row.connection_id === vercel?.id && row.metric_key === TOTAL_METRIC_KEY)
        .map((row) => [row.snapshot_date, row.amount_minor ?? 0]),
    );
    const rise = (date: string) => (totals.get(date) ?? 0) - (totals.get(utcDate(new Date(Date.parse(date) - DAY_MS))) ?? 0);
    const highestOrdinaryRise = Math.max(...ordinary.filter((date) => !date.endsWith("-01")).map(rise));

    for (const launch of launches) {
      expect(deploys.get(launch) ?? 0, launch).toBeGreaterThan(2 * busiestOrdinary);
      if (!launch.endsWith("-01")) expect(rise(launch), launch).toBeGreaterThan(2 * highestOrdinaryRise);
    }
  });

  it("flags each Vercel launch day as exactly one unusual spend event, and nothing else (#169)", () => {
    const vercel = store.connections.find((connection) => connection.provider === "vercel");
    const account = store.accounts.find((row) => row.connection_id === vercel?.id);
    if (account === undefined) throw new Error("expected a Vercel account");
    const pastDays = historySteps(NOW).flatMap((step) => (step.summaryDate === null ? [] : [step.summaryDate]));
    // Detection needs 7 days of history and never checks the first day of a billing month.
    const launches = pastDays
      .slice(8)
      .filter((date) => isLaunchDay(account.external_id, Date.parse(`${date}T12:00:00Z`)) && !date.endsWith("-01"));
    expect(launches.length).toBeGreaterThanOrEqual(2);
    const anomalies = store.events.filter((event) => event.type_id === ANOMALY_TYPE_ID);
    expect(anomalies.map((event) => event.dedupe_key)).toEqual(
      launches.map((date) => `anomaly:${date}:vercel:${TOTAL_METRIC_KEY}:money:USD:verified`),
    );
  });

  it("writes one daily summary for each of the 90 days before today", () => {
    const titles = store.events.filter((event) => event.type_id === DAILY_SUMMARY_TYPE_ID).map((event) => event.title);
    expect(titles).toHaveLength(DEMO_HISTORY_DAYS);
    expect(titles).toContain("Daily summary for 2026-08-07");
    expect(titles).toContain("Daily summary for 2026-11-04");
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("evaluates alerts on the replay clock, never on the wall clock", () => {
    const steps = historySteps(NOW).map((step) => step.at.toISOString());
    expect(new Set(alertClocks)).toEqual(new Set(steps));
  });

  it("leaves every connection healthy and every cursor at now, so a live sync continues without a gap or a repeat", async () => {
    const atNow = new Date((slotOf(NOW) - 1) * SLOT_MS).toISOString();
    for (const connection of store.connections) {
      expect(connection.status, connection.provider).toBe("active");
      expect(connection.last_synced_at).toBe(NOW.toISOString());
    }
    for (const account of store.accounts) expect(account.sync_cursor).toBe(atNow);

    const before = store.events.length;
    clock = new Date(NOW.getTime() + 5 * 60_000);
    let produced = 0;
    for (const connection of store.connections) {
      const credential = store.credentials.get(connection.id);
      if (credential === undefined) throw new Error("expected a credential");
      const adapter = deps.getAdapter(connection.provider);
      for (const account of store.accounts.filter((row) => row.connection_id === connection.id)) {
        const result = await adapter.sync({ credential, externalAccountId: account.external_id, cursor: atNow }, deps.createOAuthContext(client));
        produced += result.events.length;
        for (const event of result.events) expect(event.occurredAt.getTime()).toBeGreaterThan(Date.parse(atNow));
      }
      const outcome = await runSyncJob(
        { id: "live", kind: "sync", workspace_id: WORKSPACE_ID, connection_id: connection.id, attempts: 1, max_attempts: 3, created_at: clock.toISOString(), dedupe_key: null },
        deps,
      );
      expect(outcome).toEqual({ status: "succeeded" });
    }
    // Every event the live sync read was new: nothing between the replay and now was skipped or repeated.
    expect(store.events.length - before).toBe(produced);
    for (const account of store.accounts) expect(account.sync_cursor).toBe(new Date((slotOf(clock) - 1) * SLOT_MS).toISOString());
  });
});
