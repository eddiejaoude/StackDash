import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { digitaloceanAdapter } from "@/lib/adapters/digitalocean";
import { ProviderUnavailableError } from "@/lib/adapters/errors";
import { validateAdapterEvents, type ActivityEvent } from "@/lib/adapters/events";
import { exampleAdapter } from "@/lib/adapters/example";
import { gitlabAdapter, metricKeys as gitlabMetricKeys } from "@/lib/adapters/gitlab";
import { githubAdapter } from "@/lib/adapters/github";
import { validateAdapterMetrics, type AdapterMetric } from "@/lib/adapters/metrics";
import { polarAdapter } from "@/lib/adapters/polar";
import { postHogAdapter } from "@/lib/adapters/posthog";
import { railwayAdapter } from "@/lib/adapters/railway";
import { resendAdapter } from "@/lib/adapters/resend";
import { sentryAdapter } from "@/lib/adapters/sentry";
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
  type WebhookDescriptor,
} from "@/lib/adapters/types";
import { spendCategories, TOTAL_METRIC_KEY, vercelAdapter } from "@/lib/adapters/vercel";
import { aggregateDashboard, type AccountInput, type ConnectionInput, type CurrencyAmounts, type SnapshotInput } from "@/lib/dashboard/aggregate";
import { DEMO_SEED_TEXT, demoAccountSeed, historySteps } from "@/lib/demo/history";
import { DEMO_VERCEL_BUDGET } from "@/lib/demo/workspace";
import { toSnapshotRow, utcDate } from "@/lib/jobs/ingest";
import { londonDayStart } from "@/lib/timeline/query";

import {
  createSimulatedAdapter,
  isProviderSimulationEnabled,
  isSimulatedAdapter,
  SIMULATED_BACKFILL_MS,
  SIMULATED_CODE_PREFIX,
  SIMULATED_POLL_INTERVAL_SECONDS,
  simulatedAdapters,
  simulatedAdaptersAtVolume,
  SIMULATED_WEBHOOK_SECRET_ENV,
} from "./index";
import { everySimulated, isSimulatedConnection, isSimulatedCredential, SIMULATED_SCOPE } from "./marker";
import { DAY_MS, DEFAULT_EVENT_VOLUME, isLaunchDay, isWeekend, MAX_EVENT_VOLUME, type SimulatedIncident } from "./simulation";
import { NEW_CUSTOMERS_PER_DAY } from "./stripe";
import { vercelFailedDeployment, vercelProfile, vercelSpendSurge } from "./vercel";

const REAL: Readonly<Record<LiveProviderId, ProviderAdapter>> = {
  vercel: vercelAdapter,
  github: githubAdapter,
  resend: resendAdapter,
  stripe: stripeAdapter,
  supabase: supabaseAdapter,
  digitalocean: digitaloceanAdapter,
  posthog: postHogAdapter,
  polar: polarAdapter,
  sentry: sentryAdapter,
  railway: railwayAdapter,
  gitlab: gitlabAdapter,
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

/** A credential minted by the simulator, with a fixed seed (the test's, by default) instead of a random one. */
async function connect(adapter: ProviderAdapter, seed: string = SEED): Promise<OAuthCredential> {
  const credential = await adapter.exchangeCode(
    { code: `${SIMULATED_CODE_PREFIX}code`, redirectUri: "http://localhost:3000/cb", callbackParams: {} },
    makeCtx(SPAN_START),
  );
  return { ...credential, metadata: { ...credential.metadata, seed } };
}

type SpanSync = { accountId: string; backfill: boolean; result: SyncResult };
type Chain = { start: Date; stepMs: number; steps: number };

// Watch mode: one sync per 10 second slot for two hours.
const WATCH_SPAN: Chain = { start: SPAN_START, stepMs: SLOT_MS, steps: SPAN_SLOTS };
// One UTC day in steps of the backfill window, the longest step a chained sync covers without a gap.
// Every simulator is a pure function of account and slot, so the 48 syncs after the backfill (step 0
// backfills the half hour before midnight and is filtered out as `backfill`) write exactly the events
// 8,640 ticks of 10 seconds would, including the daily ones that land at UTC midnight.
const DAY_CHAIN: Chain = {
  start: new Date("2026-11-05T00:00:00.000Z"),
  stepMs: SIMULATED_BACKFILL_MS,
  steps: DAY_MS / SIMULATED_BACKFILL_MS,
};
// Stripe's sync re-adds 31 days of hourly transactions for its metrics, so its 721 chained syncs are
// the slowest work in this file, and two places run them: Stripe's `beforeAll` in "simulated %s over
// a two hour span" (with DAY_CHAIN's 49 syncs, 0.1 s more) and the group test at the end. Each takes
// about 1.5 s on a laptop on the merged base. On CI the group test took 2.5 s (run 41960569995) and
// 3.3 s (run 41964081379); CI does not report hook times. Vitest's defaults are 5 s for a test and
// 10 s for a hook, and the all-provider shape this replaced ran past 5 s on CI (run 41959212551).
// 20 s is six times the slower CI measurement, for both.
const WATCH_TIMEOUT_MS = 20_000;

/** Syncs every account once per step across the chain, chaining cursors like the runner. */
async function syncChain(adapter: ProviderAdapter, credential: OAuthCredential, chain: Chain): Promise<SpanSync[]> {
  const accounts = await adapter.listAccounts(credential, makeCtx(chain.start));
  const results: SpanSync[] = [];
  for (const account of accounts) {
    let cursor: string | undefined;
    for (let step = 0; step <= chain.steps; step += 1) {
      const now = new Date(chain.start.getTime() + step * chain.stepMs + 3000);
      const input = cursor === undefined
        ? { credential, externalAccountId: account.externalId }
        : { credential, externalAccountId: account.externalId, cursor };
      const result = await adapter.sync(input, makeCtx(now));
      results.push({ accountId: account.externalId, backfill: cursor === undefined, result });
      cursor = result.cursor;
    }
  }
  return results;
}

function eventCount(syncs: readonly SpanSync[]): number {
  return syncs.reduce((sum, { result }) => sum + result.events.length, 0);
}

/** Groups syncs by account: the runner syncs one account per tick, so each bound holds per account. */
function byAccount(syncs: readonly SpanSync[]): Map<string, SpanSync[]> {
  const groups = new Map<string, SpanSync[]>();
  for (const sync of syncs) {
    const group = groups.get(sync.accountId);
    if (group === undefined) groups.set(sync.accountId, [sync]);
    else group.push(sync);
  }
  return groups;
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
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", value);
    expect(isProviderSimulationEnabled()).toBe(expected);
  });

  it("refuses 1 on a Vercel production deployment", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(isProviderSimulationEnabled()).toBe(false);
  });

  it("allows 1 on a Vercel preview deployment", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(isProviderSimulationEnabled()).toBe(true);
  });
});

describe("simulated adapter declarations", () => {
  it.each(liveProviderIds)("%s mirrors the real adapter's id, event types, achievements, daily signup totals, projections, beta, and capabilities", (id) => {
    const simulated = simulatedAdapters[id];
    expect(simulated.id).toBe(REAL[id].id);
    expect(simulated.displayName).toBe(REAL[id].displayName);
    expect(simulated.eventTypes).toBe(REAL[id].eventTypes);
    expect(simulated.achievements).toBeDefined();
    expect(simulated.achievements).toBe(REAL[id].achievements);
    expect(simulated.signupDailyTotals).toBe(REAL[id].signupDailyTotals);
    expect(simulated.projectedSpend).toBe(REAL[id].projectedSpend);
    expect(simulated.beta).toBe(REAL[id].beta);
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

  it.each(liveProviderIds)("%s receives webhooks exactly when its live adapter does, through the live verify and parse", (id) => {
    const real = REAL[id].webhooks;
    const simulated = simulatedAdapters[id].webhooks;
    if (real === undefined) {
      expect(simulated).toBeUndefined();
      return;
    }
    expect(simulated?.subscriptions).toBe(real.subscriptions);
    expect(simulated?.verify).toBe(real.verify);
    expect(simulated?.parse).toBe(real.parse);
  });

  describe("webhook secrets (#479)", () => {
    const descriptor = exampleAdapter.webhooks;
    if (descriptor === undefined) throw new Error("the example adapter declares webhooks");
    const withWebhooks = (webhooks: WebhookDescriptor) =>
      createSimulatedAdapter({ ...vercelProfile, real: { ...vercelAdapter, webhooks } }, "vercel").webhooks;

    it("reads an app-level secret from the one simulated variable, never the provider's own", () => {
      const simulated = withWebhooks(descriptor);
      expect(descriptor.registration).toEqual({ kind: "app", secretEnv: "EXAMPLE_WEBHOOK_SECRET" });
      expect(simulated?.registration).toEqual({ kind: "app", secretEnv: SIMULATED_WEBHOOK_SECRET_ENV });
      expect(simulated?.verify).toBe(descriptor.verify);
      expect(simulated?.parse).toBe(descriptor.parse);
    });

    it("keeps a per-connection registration, whose secret is stored for its connection", () => {
      const perConnection: WebhookDescriptor = { ...descriptor, registration: { kind: "connection" } };
      expect(withWebhooks(perConnection)?.registration).toEqual({ kind: "connection" });
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
    expect(isSimulatedCredential(first)).toBe(true);
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

  it("names a simulated grant's seed as its installation when the live adapter matches uninstalls by installation (#480)", async () => {
    const credential = await simulatedAdapters.sentry.exchangeCode(
      { code: `${SIMULATED_CODE_PREFIX}code`, redirectUri: "http://localhost:3000/cb", callbackParams: {} },
      makeCtx(SPAN_START),
    );
    expect(credential.metadata?.seed).toMatch(/^[0-9a-f]{8}$/);
    expect(simulatedAdapters.sentry.installationIdOf?.(credential)).toBe(credential.metadata?.seed);
    // A credential the simulator did not mint names no installation (boundary).
    const { metadata: _simulated, ...unmarked } = credential;
    expect(simulatedAdapters.sentry.installationIdOf?.({ ...unmarked, metadata: { seed: "0a1b2c3d" } })).toBeNull();
  });

  it("declares no installation when the live adapter's uninstalls name an account (boundary)", () => {
    expect(vercelAdapter.installationIdOf).toBeUndefined();
    expect(simulatedAdapters.vercel.installationIdOf).toBeUndefined();
  });
});

describe("simulated markers", () => {
  it("marks a connection by its granted scopes, whatever the flag says", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", undefined);
    expect(isSimulatedConnection({ granted_scopes: [SIMULATED_SCOPE] })).toBe(true);
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    expect(isSimulatedConnection({ granted_scopes: ["read:project"] })).toBe(false);
    expect(isSimulatedConnection({ granted_scopes: [] })).toBe(false);
  });

  it("never marks a real credential", () => {
    expect(isSimulatedCredential({})).toBe(false);
    expect(isSimulatedCredential({ metadata: { teamId: "team_1" } })).toBe(false);
    expect(isSimulatedCredential({ metadata: { simulated: "0" } })).toBe(false);
  });

  it("knows the registry's simulated adapters by identity, not id", () => {
    for (const id of liveProviderIds) {
      expect(isSimulatedAdapter(simulatedAdapters[id])).toBe(true);
      expect(isSimulatedAdapter(REAL[id])).toBe(false);
      expect(isSimulatedAdapter({ ...simulatedAdapters[id] })).toBe(false);
    }
  });

  it.each([
    ["one simulated item", [true], true],
    ["many simulated items", [true, true, true], true],
    ["nothing in view", [], false],
    ["one real item", [false], false],
    ["a mix, real last", [true, true, false], false],
    ["a mix, real first", [false, true], false],
  ])("says the whole page is simulated (#269) only when all of it is: %s", (_title, flags, expected) => {
    expect(everySimulated(flags.map((simulated) => ({ simulated })))).toBe(expected);
  });
});

describe("a simulated adapter with an incident (#256)", () => {
  // Mid slot, with the cursor at the slot before: a usual sync here covers no new slot.
  const now = new Date("2026-11-10T14:00:03.000Z");
  const cursor = new Date(Math.floor(now.getTime() / SLOT_MS) * SLOT_MS - SLOT_MS).toISOString();

  async function syncBoth(incident: SimulatedIncident): Promise<{ usual: SyncResult; withIncident: SyncResult; accountId: string }> {
    const adapter = createSimulatedAdapter(vercelProfile, "vercel", { incident });
    const credential = await connect(adapter);
    const [account] = await adapter.listAccounts(credential, makeCtx(now));
    if (account === undefined) throw new Error("simulated Vercel has an account");
    const input = { credential, externalAccountId: account.externalId, cursor };
    return {
      usual: await simulatedAdapters.vercel.sync(input, makeCtx(now)),
      withIncident: await adapter.sync(input, makeCtx(now)),
      accountId: account.externalId,
    };
  }

  it("is simulated, so it gets the local client and syncs simulated credentials", () => {
    expect(isSimulatedAdapter(createSimulatedAdapter(vercelProfile, "vercel", { incident: { events: () => [] } }))).toBe(true);
  });

  it("adds the incident's events at the sync's clock, even to a sync that covers no new slot", async () => {
    const { usual, withIncident, accountId } = await syncBoth({ events: (id, at) => [vercelFailedDeployment(id, at)] });
    expect(usual.events).toEqual([]);
    expect(withIncident.events).toEqual([vercelFailedDeployment(accountId, now)]);
    expect(withIncident.metrics).toEqual(usual.metrics);
    expect(withIncident.cursor).toBe(usual.cursor);
  });

  it("reads the incident's metrics instead of the profile's, at the slot's start", async () => {
    const { usual, withIncident, accountId } = await syncBoth({ events: () => [], metrics: (id, at) => vercelSpendSurge(id, at, 100_000) });
    const slotStart = new Date(Math.floor(now.getTime() / SLOT_MS) * SLOT_MS);
    expect(withIncident.metrics).toEqual(vercelSpendSurge(accountId, slotStart, 100_000));
    expect(withIncident.metrics).not.toEqual(usual.metrics);
    expect(withIncident.events).toEqual(usual.events);
  });
});

describe("vercelFailedDeployment", () => {
  const at = new Date("2026-11-10T14:00:03.000Z");

  it("is a failed production deployment of web at the instant, as the real adapter reports one", () => {
    const event = vercelFailedDeployment("team_sim5eed0a11", at);
    expect(event).toMatchObject({
      typeId: "vercel.deployment.failed",
      severity: "critical",
      title: "Production deployment of web failed",
      body: "Error code: BUILD_FAILED",
      occurredAt: at,
      externalAccountId: "team_sim5eed0a11",
    });
    expect(event.url).toBeUndefined();
    expect(validateAdapterEvents(vercelAdapter.eventTypes, [event]).ok).toBe(true);
  });

  it("is the same deployment at the same instant and a new one a millisecond later", () => {
    const first = vercelFailedDeployment("team_sim5eed0a11", at).dedupeKey;
    expect(vercelFailedDeployment("team_sim5eed0a11", new Date(at.getTime())).dedupeKey).toBe(first);
    expect(vercelFailedDeployment("team_sim5eed0a11", new Date(at.getTime() + 1)).dedupeKey).not.toBe(first);
  });
});

describe("vercelSpendSurge", () => {
  // Early in the month, when the usual total is a few hundred dollars.
  const at = new Date("2026-11-10T14:00:00.000Z");
  const accountId = "team_sim5eed0a11";
  const amount = (metrics: readonly AdapterMetric[], key: string) => {
    const metric = metrics.find((candidate) => candidate.metricKey === key);
    return metric !== undefined && "amountMinor" in metric ? metric.amountMinor : undefined;
  };
  const usualTotal = amount(vercelProfile.metrics(accountId, at, makeCtx(at)), TOTAL_METRIC_KEY) ?? 0;

  // Usage plus the $20 purchase, then 20 percent tax rounded down: the least usage that reaches the target.
  it.each([
    [60_000, 48_000, 60_000],
    [60_001, 48_001, 60_001],
    [60_005, 48_005, 60_006],
    [60_006, 48_005, 60_006],
  ])("reaches a total of %i with usage of %i (total %i), one cent less would fall short", (target, usage, total) => {
    const metrics = vercelSpendSurge(accountId, at, target);
    expect(amount(metrics, "vercel.spend.usage")).toBe(usage);
    expect(amount(metrics, TOTAL_METRIC_KEY)).toBe(total);
    const categories = spendCategories.map(({ metricKey }) => amount(metrics, metricKey) ?? 0);
    expect(categories.reduce((sum, value) => sum + value, 0)).toBe(total);
    expect(validateAdapterMetrics("vercel", metrics).ok).toBe(true);
  });

  it.each([
    ["zero", 0],
    ["below the purchase and its tax", 100],
    ["one cent below the usual total", usualTotal - 1],
    ["the usual total", usualTotal],
  ])("reads as usual for a target of %s", (_title, target) => {
    expect(vercelSpendSurge(accountId, at, target)).toEqual(vercelProfile.metrics(accountId, at, makeCtx(at)));
  });
});

describe.each(liveProviderIds)("simulated %s over a two hour span", (id) => {
  const adapter = simulatedAdapters[id];
  let results: SpanSync[];
  let ticks: SpanSync[];
  let allEvents: ActivityEvent[];
  let dayTicks: SpanSync[];

  // Carries the Stripe cost described at WATCH_TIMEOUT_MS, so it states the same timeout.
  beforeAll(async () => {
    const credential = await connect(adapter);
    results = await syncChain(adapter, credential, WATCH_SPAN);
    // Every sync after an account's backfill is one `jobs:tick -- --watch` tick.
    ticks = results.filter(({ backfill }) => !backfill);
    allEvents = results.flatMap(({ result }) => result.events);
    dayTicks = (await syncChain(adapter, credential, DAY_CHAIN)).filter(({ backfill }) => !backfill);
  }, WATCH_TIMEOUT_MS);

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

  // Every reading of spend (the headline #173, and since #223 the dashboard, summary, and alerts
  // too) counts an estimate as spend so far unless its adapter declares it a projection, so an
  // estimate for a period running past the day it was read must be declared.
  it("declares as projected spend every estimate for a period that runs past the day it was read", () => {
    const declared = REAL[id].projectedSpend ?? [];
    const estimates = results.flatMap(({ result }) => result.metrics).filter((item) => item.kind === "estimated_spend");
    const projections = estimates.filter(
      ({ timeframe, retrievedAt }) =>
        timeframe.type === "period" && timeframe.end.getTime() > Math.floor(retrievedAt.getTime() / DAY_MS) * DAY_MS + DAY_MS,
    );
    expect([...new Set(projections.map((item) => item.metricKey))].filter((key) => !declared.includes(key))).toEqual([]);
    for (const key of declared) expect(estimates.some((item) => item.metricKey === key)).toBe(true);
  });

  it("trickles events in, at most 10 a tick like the group test, with no dedupe key repeated across chained syncs", () => {
    expect(allEvents.length).toBeGreaterThan(0);
    const keys = allEvents.map((event) => event.dedupeKey);
    expect(new Set(keys).size).toBe(keys.length);
    // The group test's per-tick cap, so no single provider is allowed a burst the group would reject.
    // The most any provider writes in one tick on the seed is 3 (GitHub's daily stars at midnight).
    for (const { result } of ticks) expect(result.events.length).toBeLessThanOrEqual(10);
  });

  it("keeps events coming after the backfill on every account across a UTC day of chained syncs", () => {
    // The silence check, bounded per account, so adding a provider never moves another's bound and a
    // busy account cannot hide a silent sibling (Supabase's two projects write 52 and 6). A day and
    // not the two hour span: the sparsest profiles write a few events a day, so two hours leaves them
    // one or two (Resend 1, Polar 1, PostHog 2 on the seed). Over the day the seed gives Polar 3,
    // PostHog 5, Supabase staging 6, Resend 13, Stripe 63 (60 of them new customers), and every
    // other account 50 or more. A 0 here means that account's syncs after the backfill stopped
    // writing, or a simulator's random keying changed: check its `eventsInSlot` before watch mode.
    const accounts = byAccount(dayTicks);
    expect(accounts.size).toBeGreaterThan(0);
    for (const [accountId, syncs] of accounts) expect(eventCount(syncs), accountId).toBeGreaterThan(0);
  });

  it("writes under one event in ten ticks on average on every account as watch mode ticks every 10 seconds", () => {
    // The flood check, bounded per account like the silence check, because one account's
    // `eventsInSlot` is what floods and a provider-wide mean would dilute it with quiet siblings.
    // The busiest accounts on the seed are Sentry's ios project, Railway, and GitLab, at about 0.02
    // a tick (12 to 14 over 720 ticks), so this ceiling is five times them: a small product's pace
    // (#264), where Stripe alone wrote 0.7 a tick before. Tuning any profile past it fails here.
    for (const [accountId, syncs] of byAccount(ticks)) {
      expect(eventCount(syncs) / syncs.length, accountId).toBeLessThan(0.1);
    }
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

// The five providers simulated since #131, the group the watch bounds below were set for. Fixed, so
// these aggregate bounds and this test's cost stay the same as providers are added; every provider's
// own silence, flood, and burst bounds are in "simulated %s over a two hour span" above. Its timeout
// is explained at WATCH_TIMEOUT_MS.
const WATCH_GROUP = ["vercel", "github", "resend", "stripe", "supabase"] as const satisfies readonly LiveProviderId[];

describe("simulated providers ticking every 10 seconds, as `jobs:tick -- --watch` does", () => {
  it("bring events at a small product's pace (#264) across the #131 providers, never in a burst, and keep Vercel spend moving", async () => {
    const connections = await Promise.all(
      WATCH_GROUP.map(async (id) => {
        const adapter = simulatedAdapters[id];
        const credential = await connect(adapter);
        const [account] = await adapter.listAccounts(credential, makeCtx(SPAN_START));
        if (account === undefined) throw new Error(`expected a ${id} account`);
        return { adapter, credential, accountId: account.externalId, cursor: undefined as string | undefined };
      }),
    );
    const perTick: number[] = [];
    const spend: number[] = [];
    for (let tick = 0; tick <= SPAN_SLOTS; tick += 1) {
      const now = new Date(SPAN_START.getTime() + tick * SLOT_MS + 3000);
      let written = 0;
      for (const connection of connections) {
        const { adapter, credential, accountId, cursor } = connection;
        const input = cursor === undefined ? { credential, externalAccountId: accountId } : { credential, externalAccountId: accountId, cursor };
        const result = await adapter.sync(input, makeCtx(now));
        connection.cursor = result.cursor;
        written += result.events.length;
        if (adapter.id === "vercel") spend.push(amount(metric(result.metrics, TOTAL_METRIC_KEY)));
      }
      // The first tick is the 30 minute backfill.
      if (tick > 0) perTick.push(written);
    }
    // A small product's timeline: 23 events over these 720 ticks on the seed, 3 of them Stripe's
    // new customers, where Stripe alone wrote 497 before #264. Never a burst, and never silent for
    // a whole backfill window (the longest quiet run on the seed is 118 ticks).
    const total = perTick.reduce((sum, count) => sum + count, 0);
    let quiet = 0;
    let longestQuiet = 0;
    for (const count of perTick) {
      quiet = count > 0 ? 0 : quiet + 1;
      longestQuiet = Math.max(longestQuiet, quiet);
    }
    expect(total).toBeGreaterThan(0);
    expect(total / perTick.length).toBeLessThan(0.1);
    expect(Math.max(...perTick)).toBeLessThanOrEqual(10);
    expect(longestQuiet).toBeLessThan(SIMULATED_BACKFILL_MS / SLOT_MS);
    // Stripe's few payments a day leave its revenue still for hours at a time (and a refund lowers
    // it), so what keeps an open dashboard moving is spend accruing by the millisecond: Vercel's
    // total changes on 142 of the 720 ticks on the seed, overnight in UTC.
    const moved = spend.slice(1).filter((value, index) => value !== spend[index]).length;
    expect(moved / (spend.length - 1)).toBeGreaterThan(0.1);
  }, WATCH_TIMEOUT_MS);
});

// `npm run jobs:tick -- --watch --volume <n>` (#383). Every realistic-volume bound above stays on
// `simulatedAdapters`, the default volume; these hold what a higher volume may and may not change.
describe.each(liveProviderIds)("simulated %s at a higher event volume", (id) => {
  const VOLUME = MAX_EVENT_VOLUME;
  type CoveredSync = { result: SyncResult; fromMs: number; toMs: number };

  /** DAY_CHAIN's syncs for every account, each with the slots it covered: [fromMs, toMs). */
  async function chainAt(adapter: ProviderAdapter): Promise<CoveredSync[]> {
    const credential = await connect(adapter);
    const syncs: CoveredSync[] = [];
    for (const sync of await syncChain(adapter, credential, DAY_CHAIN)) {
      const toMs = Date.parse(sync.result.cursor ?? "") + SLOT_MS;
      const previous = syncs.at(-1);
      const fromMs = sync.backfill || previous === undefined ? toMs - SIMULATED_BACKFILL_MS : previous.toMs;
      syncs.push({ result: sync.result, fromMs, toMs });
    }
    return syncs;
  }

  let base: CoveredSync[];
  let scaled: CoveredSync[];
  beforeAll(async () => {
    base = await chainAt(simulatedAdapters[id]);
    scaled = await chainAt(simulatedAdaptersAtVolume(VOLUME)[id]);
  }, WATCH_TIMEOUT_MS);

  const events = (syncs: readonly CoveredSync[]) => syncs.flatMap(({ result }) => result.events);

  it("writes more events over a UTC day than the default volume, keeping every default event as it was", () => {
    const defaults = events(base);
    const more = events(scaled);
    expect(more.length).toBeGreaterThan(defaults.length);
    const byKey = new Map(more.map((event) => [event.dedupeKey, event]));
    for (const event of defaults) expect(byKey.get(event.dedupeKey)).toEqual(event);
  });

  it("repeats no dedupe key and writes only valid, declared events", () => {
    const more = events(scaled);
    expect(new Set(more.map((event) => event.dedupeKey)).size).toBe(more.length);
    expect(validateAdapterEvents(REAL[id].eventTypes, more).ok).toBe(true);
  });

  it("dates every added event inside the slots its sync covered", () => {
    const defaultKeys = new Set(events(base).map((event) => event.dedupeKey));
    for (const { result, fromMs, toMs } of scaled) {
      for (const event of result.events.filter((candidate) => !defaultKeys.has(candidate.dedupeKey))) {
        expect(Number.isNaN(event.occurredAt.getTime()), event.dedupeKey).toBe(false);
        expect(event.occurredAt.getTime(), event.dedupeKey).toBeGreaterThanOrEqual(fromMs);
        expect(event.occurredAt.getTime(), event.dedupeKey).toBeLessThan(toMs);
      }
    }
  });

  it("leaves metrics and cursors exactly as the default volume reads them", () => {
    expect(scaled.map(({ result }) => [result.metrics, result.cursor])).toEqual(base.map(({ result }) => [result.metrics, result.cursor]));
  });

  it("is deterministic for the same account, slot, seed, and volume", async () => {
    const again = await chainAt(simulatedAdaptersAtVolume(VOLUME)[id]);
    expect(events(again)).toEqual(events(scaled));
  });
});

describe("simulated event volume bounds", () => {
  it.each([DEFAULT_EVENT_VOLUME, MAX_EVENT_VOLUME])("builds an adapter at volume %d", (volume) => {
    expect(isSimulatedAdapter(createSimulatedAdapter(vercelProfile, "vercel", { volume }))).toBe(true);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["one past the maximum", MAX_EVENT_VOLUME + 1],
    ["not a number", Number.NaN],
  ])("refuses a %s volume", (_title, volume) => {
    expect(() => createSimulatedAdapter(vercelProfile, "vercel", { volume })).toThrow(RangeError);
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

  it("keeps Polar revenue as revenue, fees as spend, and MRR and ARR as recurring revenue, in USD cents", async () => {
    const [metrics] = await metricsAt(simulatedAdapters.polar, [new Date("2026-11-20T15:00:00Z")]);
    if (metrics === undefined) throw new Error("expected metrics");
    expect(Object.fromEntries(metrics.map((item) => [item.metricKey, item.kind]))).toEqual({
      "polar.revenue.month.usd": "revenue",
      "polar.fees.month.usd": "verified_spend",
      "polar.orders.month": "usage",
      "polar.subscriptions.new.month": "usage",
      "polar.subscriptions.canceled.month": "usage",
      "polar.mrr.usd": "recurring_revenue",
      "polar.arr.usd": "recurring_revenue",
      "polar.subscriptions.active": "usage",
      "polar.customers.new.month": "usage",
    });
    for (const item of metrics) {
      if ("amountMinor" in item) {
        expect(Number.isInteger(item.amountMinor), item.metricKey).toBe(true);
        expect(item.currency).toBe("USD");
      }
    }
    const revenue = amount(metric(metrics, "polar.revenue.month.usd"));
    const fees = amount(metric(metrics, "polar.fees.month.usd"));
    expect(revenue).toBeGreaterThan(0);
    expect(fees).toBeGreaterThan(0);
    expect(fees).toBeLessThan(revenue);
    // ARR is twelve months of MRR, each rounded once from Polar's fractional cents.
    expect(Math.abs(amount(metric(metrics, "polar.arr.usd")) - 12 * amount(metric(metrics, "polar.mrr.usd")))).toBeLessThanOrEqual(12);
  });

  it("grows Polar month-to-date revenue within a month and starts again in the next", async () => {
    const samples = await metricsAt(simulatedAdapters.polar, [
      new Date("2026-11-20T15:00:00Z"),
      new Date("2026-11-20T15:10:00Z"),
      new Date("2026-11-30T23:00:00Z"),
      new Date("2026-12-01T00:10:00Z"),
    ]);
    const revenue = samples.map((metrics) => amount(metric(metrics, "polar.revenue.month.usd")));
    expect(revenue[0]).toBeLessThanOrEqual(revenue[1] ?? 0);
    expect(revenue[1]).toBeLessThan(revenue[2] ?? 0);
    expect(revenue[3]).toBeLessThan(revenue[2] ?? 0);
  });

  // The dashboard counts the organization total and drops each product's spend as its breakdown
  // (`dropSupersededBreakdowns`, #204), so the products must sit one segment below the total.
  it("reports the PostHog organization's spend so far with each product's spend one segment below it", async () => {
    const [early, late] = await metricsAt(simulatedAdapters.posthog, [new Date("2026-11-03T09:00:00Z"), new Date("2026-11-27T09:00:00Z")]);
    if (early === undefined || late === undefined) throw new Error("expected metrics");
    const verified = late.filter((item) => item.kind === "verified_spend");
    expect(verified.map((item) => item.metricKey).sort()).toEqual([
      "posthog.spend.current",
      "posthog.spend.current.feature_flags",
      "posthog.spend.current.product_analytics",
      "posthog.spend.current.session_replay",
    ]);
    const total = amount(metric(late, "posthog.spend.current"));
    expect(total).toBeGreaterThan(amount(metric(early, "posthog.spend.current")));
    // The products add up to the total, give or take a cent each: each is rounded on its own.
    const products = verified.filter((item) => item.metricKey !== "posthog.spend.current").map(amount);
    expect(Math.abs(products.reduce((sum, value) => sum + value, 0) - total)).toBeLessThanOrEqual(products.length);
  });

  it("reports GitHub stars per repository and in total, plus Actions minutes and spend", async () => {
    const [metrics] = await metricsAt(simulatedAdapters.github, [new Date("2026-11-20T15:00:00Z")]);
    if (metrics === undefined) throw new Error("expected metrics");
    const repos = metrics.filter((item) => /^github\.stars\.repo_\d+$/.test(item.metricKey));
    expect(repos).toHaveLength(3);
    expect(quantity(metric(metrics, "github.stars.total"))).toBe(repos.reduce((sum, item) => sum + quantity(item), 0));
    // Yesterday's new stars across the three repositories (240, 24, and 6 a day), dated to yesterday.
    expect(metric(metrics, "github.stars.gained.daily")).toMatchObject({
      value: 270,
      timeframe: { type: "period", start: new Date("2026-11-19T00:00:00Z"), end: new Date("2026-11-20T00:00:00Z") },
    });
    expect(quantity(metric(metrics, "github.usage.actions.minutes"))).toBeGreaterThan(0);
    expect(amount(metric(metrics, "github.spend.actions"))).toBeGreaterThan(0);
    expect(amount(metric(metrics, "github.spend.actions.actions_linux"))).toBe(amount(metric(metrics, "github.spend.actions")));
  });

  it("grows DigitalOcean usage through the month, splits yesterday by SKU, and resets on the 1st", async () => {
    const samples = await metricsAt(simulatedAdapters.digitalocean, [
      new Date("2026-11-20T09:00:00Z"),
      new Date("2026-11-20T15:00:00Z"),
      new Date("2026-12-01T00:10:00Z"),
    ]);
    const usage = samples.map((metrics) => amount(metric(metrics, "digitalocean.spend.month_to_date")));
    expect(usage[0]).toBeLessThan(usage[1] ?? 0);
    expect(usage[2]).toBeLessThan(usage[1] ?? 0);
    const [morning] = samples;
    if (morning === undefined) throw new Error("expected metrics");
    const daily = morning.filter((item) => item.metricKey.startsWith("digitalocean.daily_spend.sku_"));
    expect(daily).toHaveLength(5);
    for (const item of daily) {
      expect(item.kind).toBe("estimated_spend");
      expect(item.timeframe).toEqual({ type: "period", start: new Date("2026-11-19T00:00:00Z"), end: new Date("2026-11-20T00:00:00Z") });
      expect(item.provenance.endpoint).toMatch(/^simulated:digitalocean\//);
    }
    expect(metric(morning, "digitalocean.invoice.latest").timeframe).toEqual({
      type: "period",
      start: new Date("2026-10-01T00:00:00Z"),
      end: new Date("2026-11-01T00:00:00Z"),
    });
    expect(amount(metric(morning, "digitalocean.credit.balance"))).toBeGreaterThanOrEqual(0);
  });

  it("issues the DigitalOcean invoice for the month before at 00:00 UTC on the 1st, and only then", async () => {
    const credential = await connect(simulatedAdapters.digitalocean);
    const [account] = await simulatedAdapters.digitalocean.listAccounts(credential, makeCtx(SPAN_START));
    if (account === undefined) throw new Error("expected an account");
    const sync = (now: string) =>
      simulatedAdapters.digitalocean.sync({ credential, externalAccountId: account.externalId }, makeCtx(new Date(now)));
    const invoices = (await sync("2026-12-01T00:00:15Z")).events.filter((event) => event.typeId === "digitalocean.invoice.issued");
    expect(invoices).toHaveLength(1);
    expect(invoices[0]?.title).toMatch(/^Invoice for 2026-11 issued: \$\d+\.\d{2}$/);
    expect(invoices[0]?.occurredAt).toEqual(new Date("2026-12-01T00:00:00Z"));
    const before = (await sync("2026-11-30T23:59:50Z")).events.filter((event) => event.typeId === "digitalocean.invoice.issued");
    expect(before).toEqual([]);
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

  it("reports Sentry errors by outcome over the last 24 hours for each of three projects", async () => {
    const credential = await connect(simulatedAdapters.sentry);
    const accounts = await simulatedAdapters.sentry.listAccounts(credential, makeCtx(SPAN_START));
    expect(accounts.map((account) => account.displayName)).toEqual(["web", "api", "ios"]);
    const now = new Date("2026-11-20T15:00:00Z");
    for (const account of accounts) {
      const { metrics } = await simulatedAdapters.sentry.sync({ credential, externalAccountId: account.externalId }, makeCtx(now));
      expect(metrics.map((item) => item.metricKey)).toEqual([
        "sentry.errors.accepted",
        "sentry.errors.filtered",
        "sentry.errors.rate_limited",
      ]);
      for (const item of metrics) {
        expect(item.timeframe).toEqual({ type: "period", start: new Date("2026-11-19T15:00:00Z"), end: now });
      }
      expect(quantity(metric(metrics, "sentry.errors.accepted"))).toBeGreaterThan(quantity(metric(metrics, "sentry.errors.filtered")));
    }
  });

  it("puts at least one Sentry release in every project's 30 minute backfill, each on its own project", async () => {
    const credential = await connect(simulatedAdapters.sentry);
    const accounts = await simulatedAdapters.sentry.listAccounts(credential, makeCtx(SPAN_START));
    for (const account of accounts) {
      for (const minutes of [0, 7, 45, 90]) {
        const { events } = await simulatedAdapters.sentry.sync({ credential, externalAccountId: account.externalId }, makeCtx(at(minutes)));
        const releases = events.filter((event) => event.typeId === "sentry.release.created");
        expect(releases.length, `${account.displayName} at minute ${minutes}`).toBeGreaterThan(0);
        for (const event of releases) expect(event.externalAccountId).toBe(account.externalId);
      }
    }
  });

  it("grows Railway usage cost through the billing period, the bill estimate never below the fee or the cost so far", async () => {
    const samples = await metricsAt(simulatedAdapters.railway, [
      new Date("2026-11-03T09:00:00Z"),
      new Date("2026-11-20T09:00:00Z"),
    ]);
    const [early, late] = samples;
    if (early === undefined || late === undefined) throw new Error("expected metrics");
    expect(amount(metric(early, "railway.spend.usage"))).toBeLessThan(amount(metric(late, "railway.spend.usage")));
    for (const metrics of samples) {
      // Hobby: the $5 fee covers the first $5 of usage, and the estimate covers the whole period.
      const bill = amount(metric(metrics, "railway.estimate.bill"));
      expect(bill).toBeGreaterThanOrEqual(500);
      expect(bill).toBeGreaterThanOrEqual(amount(metric(metrics, "railway.spend.usage")));
      expect(metric(metrics, "railway.spend.usage").timeframe).toEqual({
        type: "period",
        start: new Date("2026-11-01T00:00:00Z"),
        end: new Date("2026-12-01T00:00:00Z"),
      });
    }
    expect(metric(late, "railway.plan.memory_per_service").kind).toBe("included_allowance");
  });

  it("lands each Railway deployment's building event before its final event, one final event each", async () => {
    const credential = await connect(simulatedAdapters.railway);
    const [account] = await simulatedAdapters.railway.listAccounts(credential, makeCtx(SPAN_START));
    if (account === undefined) throw new Error("expected an account");
    // A day of first syncs, each backfilling its own 30 minutes, so every deployment is seen.
    const events: ActivityEvent[] = [];
    for (let minute = 30; minute <= 24 * 60; minute += 30) {
      const result = await simulatedAdapters.railway.sync({ credential, externalAccountId: account.externalId }, makeCtx(at(minute)));
      events.push(...result.events);
    }
    const byDeployment = new Map<string, ActivityEvent[]>();
    for (const event of events) {
      const id = event.dedupeKey.split(":")[1] ?? "";
      byDeployment.set(id, [...(byDeployment.get(id) ?? []), event]);
    }
    const finals = ["railway.deployment.deployed", "railway.deployment.failed", "railway.deployment.crashed"];
    const typeIds = new Set(events.map((event) => event.typeId));
    expect([...typeIds].sort()).toEqual([
      "railway.deployment.building",
      "railway.deployment.crashed",
      "railway.deployment.deployed",
      "railway.deployment.failed",
      "railway.deployment.removed",
    ]);
    for (const [id, list] of byDeployment) {
      const building = list.find((event) => event.typeId === "railway.deployment.building");
      const final = list.filter((event) => finals.includes(event.typeId));
      if (building === undefined) continue;
      expect(final.length, id).toBeLessThanOrEqual(1);
      for (const event of final) expect(event.occurredAt.getTime()).toBeGreaterThan(building.occurredAt.getTime());
    }
  });

  it.each([
    ["Railway", "railway", "railway.deployment.building", ["railway.deployment.deployed", "railway.deployment.failed", "railway.deployment.crashed"]],
    ["DigitalOcean", "digitalocean", "digitalocean.deployment.started", ["digitalocean.deployment.succeeded", "digitalocean.deployment.failed"]],
  ] as const)("pairs every %s deployment outcome with its own start at the maximum event volume (#383)", async (_name, id, startType, outcomeTypes) => {
    const day = async (adapter: ProviderAdapter) =>
      (await syncChain(adapter, await connect(adapter), DAY_CHAIN)).flatMap(({ result }) => result.events);
    const starts = (events: readonly ActivityEvent[]) => events.filter((event) => event.typeId === startType);
    const events = await day(simulatedAdaptersAtVolume(MAX_EVENT_VOLUME)[id]);
    // More starts than the default volume's, so the pairing below is not held by lane 0 alone.
    expect(starts(events).length).toBeGreaterThan(starts(await day(simulatedAdapters[id])).length);

    const byDeployment = new Map<string, ActivityEvent[]>();
    for (const event of events.filter((candidate) => candidate.typeId === startType || outcomeTypes.some((type) => type === candidate.typeId))) {
      const deployment = event.dedupeKey.split(":")[1] ?? "";
      byDeployment.set(deployment, [...(byDeployment.get(deployment) ?? []), event]);
    }
    // Only the window's edges leave one side alone: an outcome whose start came before the first
    // backfill, or a start still building at the last sync. Both profiles build for at most 6 minutes.
    const windowStart = DAY_CHAIN.start.getTime() - SIMULATED_BACKFILL_MS;
    const windowEnd = DAY_CHAIN.start.getTime() + DAY_CHAIN.steps * DAY_CHAIN.stepMs;
    const longestBuildMs = 6 * MINUTE_MS;
    for (const [deployment, list] of byDeployment) {
      const started = list.filter((event) => event.typeId === startType);
      const outcomes = list.filter((event) => event.typeId !== startType);
      expect(started.length, deployment).toBeLessThanOrEqual(1);
      expect(outcomes.length, deployment).toBeLessThanOrEqual(1);
      const [start] = started;
      const [outcome] = outcomes;
      if (start !== undefined && outcome !== undefined) {
        expect(outcome.occurredAt.getTime(), deployment).toBeGreaterThan(start.occurredAt.getTime());
      } else if (outcome !== undefined) {
        expect(outcome.occurredAt.getTime(), deployment).toBeLessThan(windowStart + longestBuildMs);
      } else if (start !== undefined) {
        expect(start.occurredAt.getTime(), deployment).toBeGreaterThanOrEqual(windowEnd - longestBuildMs);
      }
    }
  }, WATCH_TIMEOUT_MS);

  it("takes GitLab compute minutes past 75 and then 90 percent of the Free quota late in the month, resetting with a new one", async () => {
    const samples = await metricsAt(simulatedAdapters.gitlab, [
      new Date("2026-11-10T12:00:00Z"),
      new Date("2026-11-25T12:00:00Z"),
      new Date("2026-11-29T12:00:00Z"),
      new Date("2026-12-01T01:00:00Z"),
    ]);
    const percents = samples.map(
      (metrics) => (100 * quantity(metric(metrics, gitlabMetricKeys.minutesUsed))) / quantity(metric(metrics, gitlabMetricKeys.minutesIncluded)),
    );
    expect(percents[0]).toBeLessThan(75);
    expect(percents[1]).toBeGreaterThanOrEqual(75);
    expect(percents[2]).toBeGreaterThanOrEqual(90);
    expect(percents[3]).toBeLessThan(5);
    const [early] = samples;
    if (early === undefined) throw new Error("expected metrics");
    expect(metric(early, gitlabMetricKeys.minutesIncluded).provenance).toMatchObject({ source: "derived" });
    // The namespace total is the sum of its projects, each under its own key.
    const projects = early.filter((item) => /^gitlab\.compute_minutes\.project\.p\d+\.month$/.test(item.metricKey));
    expect(projects).toHaveLength(3);
    expect(projects.reduce((sum, item) => sum + quantity(item), 0)).toBe(quantity(metric(early, gitlabMetricKeys.minutesUsed)));
    expect(quantity(metric(early, gitlabMetricKeys.storageUsed))).toBeLessThan(quantity(metric(early, gitlabMetricKeys.storageLimit)));
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

describe("the simulated week (#166)", () => {
  it.each([
    ["Friday's last millisecond", "2026-11-06T23:59:59.999Z", false],
    ["Saturday's first instant", "2026-11-07T00:00:00.000Z", true],
    ["Sunday's last millisecond", "2026-11-08T23:59:59.999Z", true],
    ["Monday's first instant", "2026-11-09T00:00:00.000Z", false],
  ])("counts %s as weekend: %s", (_title, at, expected) => {
    expect(isWeekend(Date.parse(at))).toBe(expected);
  });

  it.each(["team_sim5eed0a11", "sim5eed0a11", "acct_simffffffff"])("puts exactly one launch day in any 30 UTC days for %s", (accountId) => {
    const first = Date.UTC(2026, 6, 1);
    const launches = Array.from({ length: 120 }, (_, index) => first + index * DAY_MS).filter((day) => isLaunchDay(accountId, day));
    expect(launches.length).toBe(4);
    for (const [index, day] of launches.slice(1).entries()) expect(day - (launches[index] ?? 0)).toBe(30 * DAY_MS);
    // The whole day is a launch day, up to its last millisecond.
    const [launch] = launches;
    if (launch === undefined) throw new Error("expected a launch day");
    expect(isLaunchDay(accountId, launch + DAY_MS - 1)).toBe(true);
    expect(isLaunchDay(accountId, launch - 1)).toBe(false);
  });

  it("lines a Vercel spend spike up with a burst of deploys on the launch day, and slows both at weekends", async () => {
    const adapter = simulatedAdapters.vercel;
    const credential = await connect(adapter);
    const [account] = await adapter.listAccounts(credential, makeCtx(SPAN_START));
    if (account === undefined) throw new Error("expected an account");
    const accountId = account.externalId;
    // Days after the 1st, so a day's spend is the difference of two readings in one month.
    const days = Array.from({ length: 60 }, (_, index) => Date.UTC(2026, 8, 2) + index * DAY_MS).filter(
      (day) => new Date(day).getUTCDate() > 1,
    );
    const pick = (predicate: (day: number) => boolean) => {
      const day = days.find(predicate);
      if (day === undefined) throw new Error("expected a matching day");
      return day;
    };
    const launch = pick((day) => isLaunchDay(accountId, day));
    const weekday = pick((day) => !isLaunchDay(accountId, day) && !isWeekend(day));
    const weekend = pick((day) => !isLaunchDay(accountId, day) && isWeekend(day));

    const usageAt = async (ms: number) =>
      amount(metric((await adapter.sync({ credential, externalAccountId: accountId }, makeCtx(new Date(ms)))).metrics, "vercel.spend.usage"));
    const dailyUsage = async (day: number) => (await usageAt(day + DAY_MS - SLOT_MS)) - (await usageAt(day - SLOT_MS));
    // Chained syncs every 30 minutes across the day, as a live tick would read it.
    const dailyDeploys = async (day: number) => {
      let cursor = new Date(day - SLOT_MS).toISOString();
      const deploys: ActivityEvent[] = [];
      for (let step = 1; step <= 48; step += 1) {
        const result = await adapter.sync({ credential, externalAccountId: accountId, cursor }, makeCtx(new Date(day + step * 30 * MINUTE_MS)));
        deploys.push(...result.events);
        cursor = result.cursor ?? cursor;
      }
      return deploys;
    };
    // The half hour before London midnight, which is all the demo seed's daily step reads: 22:30 to
    // 23:00 UTC in summer, 23:30 to 00:00 UTC in winter.
    const lastHalfHour = (deploys: ActivityEvent[], day: number) => {
      const londonMidnight = londonDayStart(utcDate(new Date(day + DAY_MS))).getTime();
      return deploys.filter((event) => {
        const at = event.occurredAt.getTime();
        return at >= londonMidnight - 30 * MINUTE_MS && at < londonMidnight;
      }).length;
    };

    const [launchUsage, weekdayUsage, weekendUsage] = await Promise.all([launch, weekday, weekend].map(dailyUsage));
    const [launchDeploys = [], weekdayDeploys = [], weekendDeploys = []] = await Promise.all([launch, weekday, weekend].map(dailyDeploys));
    expect(launchUsage).toBeGreaterThan(3 * (weekdayUsage ?? 0));
    expect(weekendUsage).toBeLessThan((weekdayUsage ?? 0) / 2);
    expect(launchDeploys.length).toBeGreaterThan(3 * weekdayDeploys.length);
    expect(weekendDeploys.length).toBeLessThan(weekdayDeploys.length / 2);
    expect(lastHalfHour(launchDeploys, launch)).toBeGreaterThan(5 * Math.max(1, lastHalfHour(weekdayDeploys, weekday)));
  });
});

describe("a small product's demo (#264)", () => {
  const budgetMinor = Number(DEMO_VERCEL_BUDGET.amount) * 100;
  const total = (amounts: CurrencyAmounts) => (amounts.verified?.amountMinor ?? 0) + (amounts.estimated?.amountMinor ?? 0);

  it.each([
    ["the test seed", (): string => SEED],
    ["the demo seed's accounts", (id: LiveProviderId): string => demoAccountSeed(DEMO_SEED_TEXT, id)],
  ])("keeps a whole month of revenue and spend within ten times the demo's Vercel budget, on %s", async (_title, seedFor) => {
    // October's last slot, when every month to date reading covers the whole month. Every account of
    // every provider, reduced by the dashboard's own rules, so each amount is counted as it is shown.
    const monthEnd = new Date(Date.parse("2026-11-01T00:00:00.000Z") - SLOT_MS);
    const snapshots: SnapshotInput[] = [];
    const connections: ConnectionInput[] = [];
    const accounts: AccountInput[] = [];
    for (const id of liveProviderIds) {
      const adapter = simulatedAdapters[id];
      const credential = await connect(adapter, seedFor(id));
      connections.push({
        id,
        provider: id,
        display_name: adapter.displayName,
        status: "active",
        last_synced_at: monthEnd.toISOString(),
        last_sync_requested_at: null,
        poll_interval_seconds: SIMULATED_POLL_INTERVAL_SECONDS,
        granted_scopes: [SIMULATED_SCOPE],
      });
      for (const account of await adapter.listAccounts(credential, makeCtx(monthEnd))) {
        const accountId = `${id}:${account.externalId}`;
        accounts.push({ id: accountId, connection_id: id, display_name: account.displayName, project_id: null });
        const { metrics } = await adapter.sync({ credential, externalAccountId: account.externalId }, makeCtx(monthEnd));
        snapshots.push(...metrics.map((item) => toSnapshotRow(item, { id, workspace_id: "workspace" }, { id: accountId })));
      }
    }
    const projectedSpend = liveProviderIds.flatMap((id) => simulatedAdapters[id].projectedSpend ?? []);
    const view = aggregateDashboard({ snapshots, connections, accounts, projects: [], projectedSpend, now: monthEnd });

    // Before #264 a month came to about $4.5 million and €2.1 million of revenue and $166,000 of spend.
    expect(view.revenue.map(({ currency }) => currency)).toEqual(["EUR", "USD"]);
    for (const amounts of view.revenue) {
      expect(total(amounts), `revenue in ${amounts.currency}`).toBeGreaterThanOrEqual(budgetMinor / 10);
      expect(total(amounts), `revenue in ${amounts.currency}`).toBeLessThanOrEqual(budgetMinor * 10);
    }
    // Spend in euros is only Stripe's fees on euro payments, so only the budget's currency has a floor.
    for (const amounts of view.totals) expect(total(amounts), `spend in ${amounts.currency}`).toBeLessThanOrEqual(budgetMinor * 10);
    const budgetCurrency = view.totals.find(({ currency }) => currency === DEMO_VERCEL_BUDGET.currency);
    if (budgetCurrency === undefined) throw new Error(`expected spend in ${DEMO_VERCEL_BUDGET.currency}`);
    expect(total(budgetCurrency)).toBeGreaterThanOrEqual(budgetMinor / 10);
  });

  it("keeps payments within ten times Vercel's deployments over the demo seed's 90 days", async () => {
    // The seed's own replay: one sync per account at each of its steps, cursors chained the way
    // `replayHistory` runs them, so each day keeps the half hour before London midnight.
    const steps = historySteps(new Date("2026-11-10T12:00:00.000Z"));
    const replayed = async (id: LiveProviderId): Promise<ActivityEvent[]> => {
      const adapter = simulatedAdapters[id];
      const credential = await connect(adapter, demoAccountSeed(DEMO_SEED_TEXT, id));
      const events = new Map<string, ActivityEvent>();
      for (const account of await adapter.listAccounts(credential, makeCtx(SPAN_START))) {
        let cursor: string | undefined;
        for (const step of steps) {
          const input = cursor === undefined ? { credential, externalAccountId: account.externalId } : { credential, externalAccountId: account.externalId, cursor };
          const result = await adapter.sync(input, makeCtx(step.at));
          for (const event of result.events) events.set(event.dedupeKey, event);
          cursor = result.cursor;
        }
      }
      return [...events.values()];
    };
    const [stripe = [], polar = [], vercel = []] = await Promise.all((["stripe", "polar", "vercel"] as const).map(replayed));
    const deployments = vercel.filter((event) => event.typeId.startsWith("vercel.deployment.")).length;
    const payments = [...stripe, ...polar].filter((event) => event.typeId === "stripe.charge.succeeded" || event.typeId === "polar.order.paid").length;
    // 168 deployments against 11 Stripe payments and 3 Polar orders. Payments only (#264, decided on
    // pull request #290): Stripe's other 99 events are almost all new customers, which carry no
    // money. Before #264 Stripe wrote 8,163 payments, 49 a deployment.
    expect(deployments).toBeGreaterThan(0);
    expect(payments).toBeGreaterThan(0);
    expect(payments).toBeLessThanOrEqual(10 * deployments);
  });

  it("adds Stripe's new customers at their stated daily rate, and they carry no money", async () => {
    // The bounds follow NEW_CUSTOMERS_PER_DAY, not a fitted count: a UTC day of chained half hour
    // syncs holds between half and twice the target (60 on the seed, beside 2 payments), so a
    // retune of the target moves the test with it and a chance that misses it fails here.
    const syncs = await syncChain(simulatedAdapters.stripe, await connect(simulatedAdapters.stripe), DAY_CHAIN);
    const events = syncs.filter(({ backfill }) => !backfill).flatMap(({ result }) => result.events);
    const customers = events.filter((event) => event.typeId === "stripe.customer.created");
    expect(customers.length).toBeGreaterThanOrEqual(NEW_CUSTOMERS_PER_DAY / 2);
    expect(customers.length).toBeLessThanOrEqual(NEW_CUSTOMERS_PER_DAY * 2);
    expect(events.filter((event) => event.typeId === "stripe.charge.succeeded").length).toBeLessThanOrEqual(5);
    // "New customer" and nothing else: no amount, no currency, nothing that reads as money.
    for (const event of customers) {
      expect(event.title).toBe("New customer");
      expect(event.body).toBeUndefined();
      expect(event.severity).toBe("info");
    }
  });

  it.each([
    { id: "stripe", paid: "stripe.charge.succeeded", money: ["stripe.charge.succeeded", "stripe.charge.failed", "stripe.charge.refunded"] },
    { id: "polar", paid: "polar.order.paid", money: ["polar.order.paid", "polar.refund.succeeded"] },
  ] as const)("prints the amount and currency on every simulated $id payment and refund (#261)", async ({ id, paid, money }) => {
    const adapter = simulatedAdapters[id];
    // The chain's first sync backfills, so this covers weeks of payments, failures, and refunds.
    const syncs = await syncChain(adapter, await connect(adapter), DAY_CHAIN);
    const events = syncs.flatMap(({ result }) => result.events).filter((event) => money.some((typeId) => typeId === event.typeId));
    expect(events.filter((event) => event.typeId === paid).length).toBeGreaterThan(0);
    for (const event of events) {
      // One amount in one currency, "$49.00" or "€19.00", and for a partial refund "of" the price "so far".
      expect(event.title, event.typeId).toMatch(/: [$€]\d+\.\d{2}( of [$€]\d+\.\d{2} so far)?$/);
      // A failed payment's reason is a sentence, never Stripe's code.
      if (event.body !== undefined) expect(event.body, event.typeId).not.toMatch(/_/);
    }
  });

  it("names the branch each simulated GitLab environment deploys, never main for a review app", async () => {
    const adapter = simulatedAdapters.gitlab;
    const credential = await connect(adapter);
    const [account] = await adapter.listAccounts(credential, makeCtx(SPAN_START));
    if (account === undefined) throw new Error("expected a GitLab account");
    // A week of chained half hour syncs: long enough for every environment to deploy.
    const start = Date.parse("2026-11-02T00:00:00.000Z");
    const events: ActivityEvent[] = [];
    let cursor: string | undefined;
    for (let step = 0; step <= 7 * 48; step += 1) {
      const input = cursor === undefined ? { credential, externalAccountId: account.externalId } : { credential, externalAccountId: account.externalId, cursor };
      const result = await adapter.sync(input, makeCtx(new Date(start + step * SIMULATED_BACKFILL_MS)));
      events.push(...result.events);
      cursor = result.cursor;
    }
    const refOf: Readonly<Record<string, string>> = { production: "main", staging: "main", "review/feature-checkout": "feature/checkout" };
    const environments = new Set<string>();
    for (const event of events.filter((item) => item.typeId.startsWith("gitlab.deployment."))) {
      // As a reader sees it: "Deployment to <environment> succeeded in ...", "Deployment #<iid> of <ref>."
      const environment = /^Deployment to (\S+) (?:succeeded|failed) in /.exec(event.title)?.[1] ?? "";
      const ref = /^Deployment #\d+ of (\S+)\.$/.exec(event.body ?? "")?.[1];
      expect(ref, event.title).toBe(refOf[environment]);
      environments.add(environment);
    }
    expect([...environments].sort()).toEqual(Object.keys(refOf).sort());
  });
});
