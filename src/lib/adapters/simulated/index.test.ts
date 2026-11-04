import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderUnavailableError } from "@/lib/adapters/errors";
import { validateAdapterEvents, type ActivityEvent } from "@/lib/adapters/events";
import { githubAdapter } from "@/lib/adapters/github";
import { validateAdapterMetrics, type AdapterMetric } from "@/lib/adapters/metrics";
import { resendAdapter } from "@/lib/adapters/resend";
import { stripeAdapter } from "@/lib/adapters/stripe";
import { supabaseAdapter } from "@/lib/adapters/supabase";
import {
  liveProviderIds,
  Secret,
  type LiveProviderId,
  type OAuthContext,
  type OAuthCredential,
  type ProviderAdapter,
  type SyncResult,
} from "@/lib/adapters/types";
import { spendCategories, TOTAL_METRIC_KEY, vercelAdapter } from "@/lib/adapters/vercel";

import {
  isProviderSimulationEnabled,
  SIMULATED_BACKFILL_MS,
  SIMULATED_CODE_PREFIX,
  SIMULATED_SCOPE,
  simulatedAdapters,
} from "./index";

const REAL: Readonly<Record<LiveProviderId, ProviderAdapter>> = {
  vercel: vercelAdapter,
  github: githubAdapter,
  resend: resendAdapter,
  stripe: stripeAdapter,
  supabase: supabaseAdapter,
};

const MINUTE_MS = 60_000;
const SLOT_MS = 10_000;
// Crosses UTC midnight, so the daily events (GitHub stars, Supabase summary) fall inside it.
const SPAN_START = new Date("2026-11-04T23:00:00.000Z");
const SPAN_SLOTS = 720;
// A fixed seed makes every account id, and so every simulated value, the same on every run.
const SEED = "5eed0a11";

function makeCtx(now: Date): OAuthContext {
  return {
    fetch: vi.fn(() => Promise.reject(new Error("network is not allowed in simulated adapter tests"))),
    now: () => now,
    timeoutMs: 5000,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    client: { clientId: "simulated", clientSecret: new Secret("simulated"), extra: {} },
  };
}

function at(minutesAfterStart: number, seconds = 0): Date {
  return new Date(SPAN_START.getTime() + minutesAfterStart * MINUTE_MS + seconds * 1000);
}

/** A credential minted by the simulator, with the fixed test seed instead of a random one. */
async function connect(adapter: ProviderAdapter): Promise<OAuthCredential> {
  const credential = await adapter.exchangeCode(
    { code: `${SIMULATED_CODE_PREFIX}code`, redirectUri: "http://localhost:3000/cb", callbackParams: {} },
    makeCtx(SPAN_START),
  );
  return { ...credential, metadata: { ...credential.metadata, seed: SEED } };
}

type SpanSync = { accountId: string; at: Date; result: SyncResult };

/** Syncs every account once per 10 second slot across the span, chaining cursors like the runner. */
async function syncSpan(adapter: ProviderAdapter, credential: OAuthCredential): Promise<SpanSync[]> {
  const accounts = await adapter.listAccounts(credential, makeCtx(SPAN_START));
  const results: SpanSync[] = [];
  for (const account of accounts) {
    let cursor: string | undefined;
    for (let slot = 0; slot <= SPAN_SLOTS; slot += 1) {
      const now = new Date(SPAN_START.getTime() + slot * SLOT_MS + 3000);
      const input = cursor === undefined
        ? { credential, externalAccountId: account.externalId }
        : { credential, externalAccountId: account.externalId, cursor };
      const result = await adapter.sync(input, makeCtx(now));
      results.push({ accountId: account.externalId, at: now, result });
      cursor = result.cursor;
    }
  }
  return results;
}

function metric(metrics: readonly AdapterMetric[], key: string): AdapterMetric {
  const found = metrics.find((candidate) => candidate.metricKey === key);
  if (found === undefined) throw new Error(`metric ${key} missing`);
  return found;
}

function amount(value: AdapterMetric): number {
  if (!("amountMinor" in value)) throw new Error(`${value.metricKey} is not money`);
  return value.amountMinor;
}

function quantity(value: AdapterMetric): number {
  if (!("value" in value)) throw new Error(`${value.metricKey} is not a quantity`);
  return value.value;
}

const globalFetch = vi.fn(() => Promise.reject(new Error("network is not allowed in simulated adapter tests")));

beforeEach(() => {
  vi.stubGlobal("fetch", globalFetch);
});

afterEach(() => {
  // Neither the injected fetch nor the global one is ever called: the simulator has no network.
  expect(globalFetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  globalFetch.mockClear();
  vi.unstubAllEnvs();
});

describe("isProviderSimulationEnabled", () => {
  it.each([
    ["unset", undefined, false],
    ["empty", "", false],
    ["0", "0", false],
    ["true", "true", false],
    ["padded 1", " 1", false],
    ["exactly 1", "1", true],
  ])("is %s -> %s", (_title, value, expected) => {
    vi.stubEnv("VERCEL_ENV", undefined);
    vi.stubEnv("DEVMACRO_SIMULATE_PROVIDERS", value);
    expect(isProviderSimulationEnabled()).toBe(expected);
  });

  it("refuses 1 on a Vercel production deployment", () => {
    vi.stubEnv("DEVMACRO_SIMULATE_PROVIDERS", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(isProviderSimulationEnabled()).toBe(false);
  });

  it("allows 1 on a Vercel preview deployment", () => {
    vi.stubEnv("DEVMACRO_SIMULATE_PROVIDERS", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(isProviderSimulationEnabled()).toBe(true);
  });
});

describe("simulated adapter declarations", () => {
  it.each(liveProviderIds)("%s mirrors the real adapter's id, event types, and capabilities", (id) => {
    const simulated = simulatedAdapters[id];
    expect(simulated.id).toBe(REAL[id].id);
    expect(simulated.displayName).toBe(REAL[id].displayName);
    expect(simulated.eventTypes).toBe(REAL[id].eventTypes);
    expect(simulated.capabilities).toBe(REAL[id].capabilities);
    expect(simulated.pollIntervalSeconds).toBe(60);
    expect(simulated.oauth.pkce).toBe(false);
    expect(simulated.permissions).toHaveLength(1);
    const [permission] = simulated.permissions;
    expect(permission?.access).toBe("read");
    expect(permission?.description).toMatch(/^Simulated\. /);
    expect(simulated.revoke).toBeDefined();
    expect(simulated.refreshTokens).toBeUndefined();
  });

  it("sends the browser to the dev consent route on the app's own origin, with the provider", () => {
    const url = simulatedAdapters.stripe.buildAuthorizeUrl({
      client: { clientId: "simulated", clientSecret: new Secret("simulated"), extra: {} },
      state: "state-1",
      redirectUri: "http://localhost:3000/api/connections/stripe/callback",
    });
    expect(`${url.origin}${url.pathname}`).toBe("http://localhost:3000/api/dev/fake-provider/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      provider: "stripe",
      state: "state-1",
      redirect_uri: "http://localhost:3000/api/connections/stripe/callback",
      scope: SIMULATED_SCOPE,
    });
  });
});

describe("simulated connect", () => {
  it("mints a marked credential with its own seed per grant, and one or more accounts", async () => {
    const mint = () =>
      simulatedAdapters.supabase.exchangeCode(
        { code: `${SIMULATED_CODE_PREFIX}code`, redirectUri: "http://localhost:3000/cb", callbackParams: {} },
        makeCtx(SPAN_START),
      );
    const first = await mint();
    const second = await mint();
    expect(first.metadata?.simulated).toBe("1");
    expect(first.metadata?.seed).toMatch(/^[0-9a-f]{8}$/);
    expect(first.metadata?.seed).not.toBe(second.metadata?.seed);
    expect(JSON.stringify(first)).not.toContain("simulated-at-");
    expect(simulatedAdapters.supabase.detectMissingPermissions(first)).toEqual([]);
    const accounts = await simulatedAdapters.supabase.listAccounts(first, makeCtx(SPAN_START));
    expect(accounts.map((account) => account.displayName)).toEqual(["Example app", "Example app staging"]);
  });

  it.each([
    ["without the prefix", "fake-123"],
    ["the prefix alone", SIMULATED_CODE_PREFIX],
  ])("refuses a code %s", async (_title, code) => {
    await expect(
      simulatedAdapters.vercel.exchangeCode({ code, redirectUri: "http://localhost:3000/cb", callbackParams: {} }, makeCtx(SPAN_START)),
    ).rejects.toThrow(/did not issue/);
  });

  it("names the simulated scope as missing when the grant lacks it", () => {
    expect(simulatedAdapters.github.detectMissingPermissions({ scopes: [] })).toEqual([SIMULATED_SCOPE]);
  });
});

describe.each(liveProviderIds)("simulated %s over a two hour span", (id) => {
  const adapter = simulatedAdapters[id];
  let results: SpanSync[];
  let allEvents: ActivityEvent[];

  beforeAll(async () => {
    results = await syncSpan(adapter, await connect(adapter));
    allEvents = results.flatMap(({ result }) => result.events);
  });

  it("passes validateAdapterMetrics and validateAdapterEvents on every sync", () => {
    for (const { result } of results) {
      const metrics = validateAdapterMetrics(id, result.metrics);
      const events = validateAdapterEvents(adapter.eventTypes, result.events);
      expect(metrics.ok ? [] : metrics.issues).toEqual([]);
      expect(events.ok ? [] : events.issues).toEqual([]);
      expect(result.metrics.length).toBeGreaterThan(0);
      expect(result.partialErrors).toBeUndefined();
    }
  });

  it("reports only the synced account", () => {
    for (const { accountId, result } of results) {
      for (const item of [...result.metrics, ...result.events]) expect(item.externalAccountId).toBe(accountId);
    }
  });

  it("trickles events in, a few per sync at most, with no dedupe key repeated across chained syncs", () => {
    expect(allEvents.length).toBeGreaterThan(0);
    const keys = allEvents.map((event) => event.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const { result } of results.slice(1)) expect(result.events.length).toBeLessThanOrEqual(12);
  });

  it("backfills the last 30 minutes on the first sync, never newer than the last whole slot", () => {
    const first = results[0];
    if (first === undefined) throw new Error("expected a first sync");
    const oldest = SPAN_START.getTime() - SIMULATED_BACKFILL_MS - SLOT_MS;
    for (const event of first.result.events) {
      expect(event.occurredAt.getTime()).toBeGreaterThanOrEqual(oldest);
      expect(event.occurredAt.getTime()).toBeLessThan(SPAN_START.getTime());
    }
    expect(first.result.cursor).toBe(new Date(SPAN_START.getTime() - SLOT_MS).toISOString());
  });

  it("is deterministic for a given slot and account", async () => {
    const credential = await connect(adapter);
    const [account] = await adapter.listAccounts(credential, makeCtx(SPAN_START));
    if (account === undefined) throw new Error("expected an account");
    const input = { credential, externalAccountId: account.externalId };
    const early = await adapter.sync(input, makeCtx(at(30, 0)));
    const late = await adapter.sync(input, makeCtx(at(30, 9.999)));
    expect(late).toEqual(early);
    // One slot later the clock has moved on: the cursor and the metrics' read time follow it.
    const next = await adapter.sync(input, makeCtx(at(30, 10)));
    expect(next.cursor).not.toBe(early.cursor);
    expect(next.metrics[0]?.retrievedAt).toEqual(at(30, 10));
  });

  it("repeats the same dedupe keys for the same minutes when syncs overlap", async () => {
    const credential = await connect(adapter);
    const [account] = await adapter.listAccounts(credential, makeCtx(SPAN_START));
    if (account === undefined) throw new Error("expected an account");
    // First syncs at minute 60 and 65 backfill minutes 30 to 60 and 35 to 65: 35 to 60 overlap.
    const keysOf = async (now: Date) =>
      (await adapter.sync({ credential, externalAccountId: account.externalId }, makeCtx(now))).events
        .filter((event) => event.occurredAt.getTime() >= at(35).getTime() && event.occurredAt.getTime() < at(60).getTime())
        .map((event) => event.dedupeKey);
    expect(await keysOf(at(60))).toEqual(await keysOf(at(65)));
  });
});

describe("simulated sync boundaries", () => {
  async function firstAccount(adapter: ProviderAdapter) {
    const credential = await connect(adapter);
    const [account] = await adapter.listAccounts(credential, makeCtx(SPAN_START));
    if (account === undefined) throw new Error("expected an account");
    return { credential, accountId: account.externalId };
  }

  it("refuses a credential it did not mint, so a real connection never gets made-up data", async () => {
    const real: OAuthCredential = { accessToken: new Secret("real-token"), scopes: ["deployment:read"], tokenType: "Bearer" };
    await expect(
      simulatedAdapters.vercel.sync({ credential: real, externalAccountId: "team_1" }, makeCtx(SPAN_START)),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("refuses an account the grant does not cover", async () => {
    const { credential } = await firstAccount(simulatedAdapters.stripe);
    await expect(
      simulatedAdapters.stripe.sync({ credential, externalAccountId: "acct_someone_else" }, makeCtx(SPAN_START)),
    ).rejects.toThrow(/no such account/);
  });

  it("catches up at most 30 minutes after a long pause", async () => {
    const { credential, accountId } = await firstAccount(simulatedAdapters.stripe);
    const cursor = new Date(SPAN_START.getTime() - 24 * 60 * MINUTE_MS).toISOString();
    const result = await simulatedAdapters.stripe.sync({ credential, externalAccountId: accountId, cursor }, makeCtx(SPAN_START));
    const oldest = Math.min(...result.events.map((event) => event.occurredAt.getTime()));
    expect(oldest).toBeGreaterThanOrEqual(SPAN_START.getTime() - SIMULATED_BACKFILL_MS - SLOT_MS);
  });

  it("writes nothing and keeps the cursor when the clock moved back", async () => {
    const { credential, accountId } = await firstAccount(simulatedAdapters.github);
    const cursor = at(90).toISOString();
    const result = await simulatedAdapters.github.sync({ credential, externalAccountId: accountId, cursor }, makeCtx(at(10)));
    expect(result.events).toEqual([]);
    expect(result.cursor).toBe(cursor);
  });

  it("restarts with a backfill and a warning when the cursor is unreadable", async () => {
    const { credential, accountId } = await firstAccount(simulatedAdapters.resend);
    const ctx = makeCtx(SPAN_START);
    const result = await simulatedAdapters.resend.sync({ credential, externalAccountId: accountId, cursor: "not a date" }, ctx);
    expect(ctx.logger.warn).toHaveBeenCalledWith("simulated.sync.cursor_reset", { provider: "resend" });
    expect(result.cursor).toBe(new Date(SPAN_START.getTime() - SLOT_MS).toISOString());
  });
});

describe("simulated providers ticking every 10 seconds, as `jobs:tick -- --watch` does", () => {
  it("bring new events on most ticks across the five providers, and keep Stripe revenue moving", async () => {
    const connections = await Promise.all(
      liveProviderIds.map(async (id) => {
        const adapter = simulatedAdapters[id];
        const credential = await connect(adapter);
        const [account] = await adapter.listAccounts(credential, makeCtx(SPAN_START));
        if (account === undefined) throw new Error(`expected a ${id} account`);
        return { adapter, credential, accountId: account.externalId, cursor: undefined as string | undefined };
      }),
    );
    const perTick: number[] = [];
    const revenue: number[] = [];
    for (let tick = 0; tick <= SPAN_SLOTS; tick += 1) {
      const now = new Date(SPAN_START.getTime() + tick * SLOT_MS + 3000);
      let written = 0;
      for (const connection of connections) {
        const { adapter, credential, accountId, cursor } = connection;
        const input = cursor === undefined ? { credential, externalAccountId: accountId } : { credential, externalAccountId: accountId, cursor };
        const result = await adapter.sync(input, makeCtx(now));
        connection.cursor = result.cursor;
        written += result.events.length;
        if (adapter.id === "stripe") revenue.push(amount(metric(result.metrics, "stripe.revenue.month.usd")));
      }
      // The first tick is the 30 minute backfill.
      if (tick > 0) perTick.push(written);
    }
    const ticksWithEvents = perTick.filter((count) => count > 0).length;
    const mean = perTick.reduce((sum, count) => sum + count, 0) / perTick.length;
    expect(ticksWithEvents / perTick.length).toBeGreaterThan(0.6);
    expect(mean).toBeGreaterThan(0.8);
    expect(mean).toBeLessThan(3);
    expect(Math.max(...perTick)).toBeLessThanOrEqual(10);
    const moved = revenue.slice(1).filter((value, index) => value !== revenue[index]).length;
    expect(moved / (revenue.length - 1)).toBeGreaterThan(0.8);
  });
});

describe("simulated numbers", () => {
  async function metricsAt(adapter: ProviderAdapter, times: readonly Date[], accountIndex = 0) {
    const credential = await connect(adapter);
    const account = (await adapter.listAccounts(credential, makeCtx(SPAN_START)))[accountIndex];
    if (account === undefined) throw new Error("expected an account");
    return Promise.all(
      times.map(async (now) => (await adapter.sync({ credential, externalAccountId: account.externalId }, makeCtx(now))).metrics),
    );
  }

  it("grows Vercel month-to-date spend in USD, the total adding up its categories", async () => {
    const samples = await metricsAt(simulatedAdapters.vercel, [
      new Date("2026-11-03T09:00:00Z"),
      new Date("2026-11-03T09:10:00Z"),
      new Date("2026-11-20T09:00:00Z"),
    ]);
    const totals = samples.map((metrics) => amount(metric(metrics, TOTAL_METRIC_KEY)));
    expect(totals[0]).toBeLessThanOrEqual(totals[1] ?? 0);
    expect(totals[1]).toBeLessThan(totals[2] ?? 0);
    const [first] = samples;
    if (first === undefined) throw new Error("expected metrics");
    const categories = spendCategories.map(({ metricKey }) => amount(metric(first, metricKey)));
    expect(categories.reduce((sum, value) => sum + value, 0)).toBe(totals[0]);
  });

  it("resets Vercel spend with a new month", async () => {
    const [endOfMonth, startOfMonth] = await metricsAt(simulatedAdapters.vercel, [
      new Date("2026-11-30T23:00:00Z"),
      new Date("2026-12-01T00:10:00Z"),
    ]);
    if (endOfMonth === undefined || startOfMonth === undefined) throw new Error("expected metrics");
    expect(amount(metric(startOfMonth, "vercel.spend.usage"))).toBeLessThan(amount(metric(endOfMonth, "vercel.spend.usage")));
  });

  it("takes the Resend daily quota past 75 and then 90 percent during one UTC day, resetting at midnight", async () => {
    const samples = await metricsAt(simulatedAdapters.resend, [
      new Date("2026-11-04T12:00:00Z"),
      new Date("2026-11-04T20:00:00Z"),
      new Date("2026-11-04T23:40:00Z"),
      new Date("2026-11-05T00:05:00Z"),
    ]);
    const percents = samples.map(
      (metrics) => (100 * quantity(metric(metrics, "resend.emails.daily.used"))) / quantity(metric(metrics, "resend.emails.daily.limit")),
    );
    expect(percents[0]).toBeLessThan(75);
    expect(percents[1]).toBeGreaterThanOrEqual(75);
    expect(percents[2]).toBeGreaterThanOrEqual(90);
    expect(percents[3]).toBeLessThan(5);
    const [noon] = samples;
    if (noon === undefined) throw new Error("expected metrics");
    expect(metric(noon, "resend.emails.daily.used").resetsAt).toEqual(new Date("2026-11-05T00:00:00Z"));
    expect(metric(noon, "resend.emails.monthly.used").resetsAt).toEqual(new Date("2026-12-01T00:00:00Z"));
  });

  it("keeps Stripe fees and revenue apart per currency, in integer minor units", async () => {
    const [metrics] = await metricsAt(simulatedAdapters.stripe, [new Date("2026-11-20T15:00:00Z")]);
    if (metrics === undefined) throw new Error("expected metrics");
    const keys = metrics.map((item) => item.metricKey).sort();
    expect(keys).toEqual([
      "stripe.fees.last_30_days.eur",
      "stripe.fees.last_30_days.usd",
      "stripe.fees.month.eur",
      "stripe.fees.month.usd",
      "stripe.revenue.last_30_days.eur",
      "stripe.revenue.last_30_days.usd",
      "stripe.revenue.month.eur",
      "stripe.revenue.month.usd",
    ]);
    for (const item of metrics) {
      expect(Number.isInteger(amount(item))).toBe(true);
      if (!("currency" in item)) throw new Error("expected money");
      expect(item.metricKey.endsWith(`.${item.currency.toLowerCase()}`)).toBe(true);
    }
    expect(amount(metric(metrics, "stripe.revenue.month.usd"))).toBeGreaterThan(0);
  });

  it("reports GitHub stars per repository and in total, plus Actions minutes and spend", async () => {
    const [metrics] = await metricsAt(simulatedAdapters.github, [new Date("2026-11-20T15:00:00Z")]);
    if (metrics === undefined) throw new Error("expected metrics");
    const repos = metrics.filter((item) => /^github\.stars\.repo_\d+$/.test(item.metricKey));
    expect(repos).toHaveLength(3);
    expect(quantity(metric(metrics, "github.stars.total"))).toBe(repos.reduce((sum, item) => sum + quantity(item), 0));
    expect(quantity(metric(metrics, "github.usage.actions.minutes"))).toBeGreaterThan(0);
    expect(amount(metric(metrics, "github.spend.actions"))).toBeGreaterThan(0);
    expect(amount(metric(metrics, "github.spend.actions.actions_linux"))).toBe(amount(metric(metrics, "github.spend.actions")));
  });

  it("reports Supabase plan limits and yesterday's daily active users", async () => {
    const [metrics] = await metricsAt(simulatedAdapters.supabase, [new Date("2026-11-20T15:00:00Z")]);
    if (metrics === undefined) throw new Error("expected metrics");
    expect(metric(metrics, "supabase.plan.monthly_active_users").kind).toBe("included_allowance");
    expect(metric(metrics, "supabase.plan.audit_log_retention").kind).toBe("included_allowance");
    expect(metric(metrics, "supabase.auth.daily_active_users").timeframe).toEqual({
      type: "period",
      start: new Date("2026-11-19T00:00:00Z"),
      end: new Date("2026-11-20T00:00:00Z"),
    });
  });

  it("lands the daily GitHub stars and Supabase summary events in the first minute of a UTC day", async () => {
    // Dated like the real adapters: GitHub at the end of the day it counts, Supabase at its start.
    const expected = [
      { adapter: simulatedAdapters.github, typeId: "github.stars.daily", occurredAt: new Date("2026-11-05T00:00:00Z") },
      { adapter: simulatedAdapters.supabase, typeId: "supabase.auth.daily_summary", occurredAt: new Date("2026-11-04T00:00:00Z") },
    ];
    for (const { adapter, typeId, occurredAt } of expected) {
      const credential = await connect(adapter);
      const [account] = await adapter.listAccounts(credential, makeCtx(SPAN_START));
      if (account === undefined) throw new Error("expected an account");
      const sync = (now: string) => adapter.sync({ credential, externalAccountId: account.externalId }, makeCtx(new Date(now)));
      const daily = (await sync("2026-11-05T00:01:30Z")).events.filter((event) => event.typeId === typeId);
      expect(daily.length, adapter.id).toBeGreaterThan(0);
      for (const event of daily) expect(event.occurredAt).toEqual(occurredAt);
      // Only the midnight minute carries it, so a sync that ends before midnight has none.
      const before = (await sync("2026-11-04T23:59:30Z")).events.filter((event) => event.typeId === typeId);
      expect(before).toEqual([]);
    }
  });
});
