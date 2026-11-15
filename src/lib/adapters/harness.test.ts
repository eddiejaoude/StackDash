import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Achievement, AchievementRule } from "./achievements";
import { PermissionMissingError } from "./errors";
import { eventTypes, exampleAdapter, metricKeys } from "./example";
import { fakeAdapter } from "./fake";
import {
  checkAdapterDeclaration,
  checkSyncResult,
  checkTraffic,
  checkWebhookOutcome,
  createAdapterHarness,
  routeKey,
} from "./harness";
import type { AdapterMetric } from "./metrics";
import { getAdapter } from "./registry";
import { simulatedAdapters } from "./simulated";
import { liveProviderIds, type ProviderAdapter, type SyncResult, type WebhookDescriptor, type WebhookOutcome } from "./types";

const NOW = new Date("2026-11-16T00:00:00.000Z");
const ACCOUNT = "acct_1001";
const API = "https://api.example.com";
// Made up, and built from parts so CI's secret scan (gitleaks) does not read it as a credential.
const PRIVATE_KEY = ["synthetic", "private", "key", "1"].join("-");

const usage: AdapterMetric = {
  kind: "usage",
  metricKey: metricKeys.requestsUsed,
  label: "Requests this billing period",
  value: 10,
  unit: "requests",
  timeframe: { type: "point", at: NOW },
  externalAccountId: ACCOUNT,
  retrievedAt: NOW,
  provenance: { source: "provider_api" },
};

const signup = {
  typeId: "example.signup",
  occurredAt: NOW,
  severity: "info",
  title: "New signup",
  externalAccountId: ACCOUNT,
  dedupeKey: "example.signup:evt_1",
} as const;

function adapterWith(change: Partial<ProviderAdapter<string>>): ProviderAdapter<string> {
  return { ...exampleAdapter, ...change };
}

function webhooksWith(change: Partial<WebhookDescriptor>): WebhookDescriptor {
  const { webhooks } = exampleAdapter;
  if (webhooks === undefined) throw new Error("the example adapter declares no webhook");
  return { ...webhooks, ...change };
}

describe("checkAdapterDeclaration", () => {
  // The live adapters whatever the developer's shell exports: with simulation on, `getAdapter`
  // hands out the simulated twins, which are checked on their own below.
  beforeEach(() => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(liveProviderIds)("passes the live %s adapter", (id) => {
    expect(checkAdapterDeclaration(getAdapter(id))).toEqual([]);
  });

  // What `getAdapter` hands out besides the live adapters (the simulated twins and the fake
  // provider), and the unregistered example. A twin carries its live adapter's id, so its title
  // says it is the twin.
  const otherAdapters = [
    ...Object.entries(simulatedAdapters).map(([id, adapter]) => [`simulated ${id}`, adapter] as const),
    ["fake", fakeAdapter] as const,
    ["example", exampleAdapter] as const,
  ];

  it.each(otherAdapters)("passes the %s adapter", (_name, adapter) => {
    expect(checkAdapterDeclaration(adapter)).toEqual([]);
  });

  it.each<[string, Partial<ProviderAdapter<string>>, string]>([
    ["an id with a dot", { id: "example.cloud" }, 'id "example.cloud" must be lowercase letters and digits'],
    ["a blank display name", { displayName: "  " }, "displayName is empty"],
    ["no permissions", { permissions: [] }, "permissions is empty: the connect screen has nothing to show"],
    [
      "a permission without a description",
      { permissions: [{ scope: "accounts:read", access: "read", description: " " }] },
      "permission accounts:read has no description",
    ],
    [
      "a full access scope without a reason",
      { permissions: [...exampleAdapter.permissions, { scope: "admin", access: "full", description: "Admin", fullAccessReason: "" }] },
      "permission admin is full access without a fullAccessReason",
    ],
    [
      "a requested scope the connect screen does not explain",
      { oauth: { ...exampleAdapter.oauth, scopes: [...exampleAdapter.oauth.scopes, "admin"] } },
      "requested scope admin has no permission entry for the connect screen",
    ],
    ["no data collected", { dataCollected: [] }, "dataCollected must list what the adapter reads, one non-empty line each"],
    [
      "an event type owned by another provider",
      { eventTypes: [{ ...eventTypes[0], id: "vercel.signup" }] },
      "event type vercel.signup must start with example.",
    ],
    [
      "an event type declared twice",
      { eventTypes: [eventTypes[0], eventTypes[0]] },
      "event type example.signup is declared twice",
    ],
    ["events without event types", { eventTypes: [] }, "capabilities.events is true but no event types are declared"],
    [
      "event types without the events capability",
      { capabilities: { ...exampleAdapter.capabilities, events: false } },
      "event types are declared but capabilities.events is false",
    ],
    ["a projection owned by another provider", { projectedSpend: ["railway.cost"] }, "projectedSpend key railway.cost must start with example."],
    [
      "a projection without the spending capability",
      { capabilities: { ...exampleAdapter.capabilities, spending: false } },
      "projectedSpend is declared but capabilities.spending is false",
    ],
    [
      "a daily signup total without the usage capability",
      { signupDailyTotals: ["example.signups.daily"], capabilities: { ...exampleAdapter.capabilities, usage: false } },
      "signupDailyTotals is declared but capabilities.usage is false",
    ],
    ["a daily total owned by another provider", { dailyTotals: ["github.stars.gained.daily"] }, "dailyTotals key github.stars.gained.daily must start with example."],
    [
      "a daily total without the usage capability",
      { dailyTotals: ["example.requests.daily"], capabilities: { ...exampleAdapter.capabilities, usage: false } },
      "dailyTotals is declared but capabilities.usage is false",
    ],
    [
      "a daily total also declared as signups",
      { signupDailyTotals: ["example.signups.daily"], dailyTotals: ["example.signups.daily"] },
      "dailyTotals key example.signups.daily is also declared in signupDailyTotals",
    ],
    ["a beta without a reason", { beta: { reason: " " } }, "beta is set without a reason"],
    ["a poll interval of 59 seconds", { pollIntervalSeconds: 59 }, "pollIntervalSeconds must be a whole number of at least 60"],
    ["a fractional poll interval", { pollIntervalSeconds: 60.5 }, "pollIntervalSeconds must be a whole number of at least 60"],
    [
      "a client id the browser would see",
      { oauth: { ...exampleAdapter.oauth, clientIdEnv: "NEXT_PUBLIC_EXAMPLE_CLIENT_ID" } },
      "NEXT_PUBLIC_EXAMPLE_CLIENT_ID would be sent to the browser; drop NEXT_PUBLIC_",
    ],
    [
      "a lowercase variable name",
      { oauth: { ...exampleAdapter.oauth, clientSecretEnv: "example_secret" } },
      "environment variable name example_secret must be UPPER_SNAKE_CASE",
    ],
    [
      "an optional extra that is not an extra",
      { oauth: { ...exampleAdapter.oauth, optionalExtraKeys: ["slug"] } },
      "optional extra slug is not a key of extraEnv",
    ],
  ])("reports %s (boundary)", (_case, change, problem) => {
    expect(checkAdapterDeclaration(adapterWith(change))).toContain(problem);
  });

  it("reports an event type the schema rejects (boundary)", () => {
    const problems = checkAdapterDeclaration(adapterWith({ eventTypes: [{ ...eventTypes[0], label: "" }] }));
    // The message ends with zod's wording, so only its start is pinned.
    expect(problems).toContainEqual(expect.stringMatching(/^event type example\.signup is invalid: \S/));
  });

  describe("webhooks", () => {
    it("passes a connection-level webhook, which names no instance secret", () => {
      expect(checkAdapterDeclaration(adapterWith({ webhooks: webhooksWith({ registration: { kind: "connection" } }) }))).toEqual([]);
    });

    it("passes a single subscription (boundary: one)", () => {
      expect(checkAdapterDeclaration(adapterWith({ webhooks: webhooksWith({ subscriptions: ["event.created"] }) }))).toEqual([]);
    });

    it.each<[string, Partial<ProviderAdapter<string>>, string]>([
      [
        "no subscriptions",
        { webhooks: webhooksWith({ subscriptions: [] }) },
        "webhooks.subscriptions must list the provider's event names, one non-empty name each",
      ],
      [
        "a blank subscription",
        { webhooks: webhooksWith({ subscriptions: ["event.created", " "] }) },
        "webhooks.subscriptions must list the provider's event names, one non-empty name each",
      ],
      [
        "a subscription listed twice",
        { webhooks: webhooksWith({ subscriptions: ["event.created", "event.created"] }) },
        "webhook subscription event.created is listed twice",
      ],
      [
        "a webhook secret the browser would see",
        { webhooks: webhooksWith({ registration: { kind: "app", secretEnv: "NEXT_PUBLIC_EXAMPLE_WEBHOOK_SECRET" } }) },
        "NEXT_PUBLIC_EXAMPLE_WEBHOOK_SECRET would be sent to the browser; drop NEXT_PUBLIC_",
      ],
      [
        "a lowercase webhook secret name",
        { webhooks: webhooksWith({ registration: { kind: "app", secretEnv: "example_webhook_secret" } }) },
        "environment variable name example_webhook_secret must be UPPER_SNAKE_CASE",
      ],
      [
        "webhooks without the events capability",
        { eventTypes: [], achievements: [], capabilities: { ...exampleAdapter.capabilities, events: false } },
        "webhooks are declared but capabilities.events is false",
      ],
    ])("reports %s (boundary)", (_case, change, problem) => {
      expect(checkAdapterDeclaration(adapterWith(change))).toContain(problem);
    });
  });

  describe("achievements", () => {
    const deployments: Achievement = {
      id: "example.deployments.first",
      title: "First Example Cloud deployment recorded",
      publicTitle: "First Example Cloud deployment recorded",
      description: "Earned when StackDash records the first successful Example Cloud deployment.",
      rule: { kind: "event_count", typeIds: ["example.deploy.succeeded"], count: 1 },
    };
    const withRule = (rule: AchievementRule): Achievement => ({ ...deployments, rule });
    const uncategorized = {
      id: "example.domain.verified",
      label: "Domain verified",
      description: "A custom domain passed verification.",
      shownByDefault: true,
      emoji: "✅",
    } as const;

    it.each<[string, Partial<ProviderAdapter<string>>]>([
      ["a rule on an event type with no category", { eventTypes: [...eventTypes, uncategorized], achievements: [withRule({ kind: "event_count", typeIds: [uncategorized.id], count: 3 })] }],
      [
        "a daily total declared in signupDailyTotals",
        {
          signupDailyTotals: ["example.signups.daily"],
          achievements: [withRule({ kind: "daily_total_threshold", metricKey: "example.signups.daily", value: 10, sum: "cumulative" })],
        },
      ],
      [
        "a daily total declared in dailyTotals",
        {
          dailyTotals: ["example.requests.daily"],
          achievements: [withRule({ kind: "daily_total_threshold", metricKey: "example.requests.daily", value: 10, sum: "single_day" })],
        },
      ],
      ["a metric threshold on the adapter's own key", { achievements: [withRule({ kind: "metric_threshold", metricKey: metricKeys.requestsUsed, value: 1000 })] }],
    ])("passes %s (boundary)", (_case, change) => {
      expect(checkAdapterDeclaration(adapterWith(change))).toEqual([]);
    });

    it.each<[string, readonly Achievement[], string]>([
      ["a duplicate id", [deployments, { ...deployments, title: "Another title" }], "achievement example.deployments.first is declared twice"],
      [
        "an id scoped to another provider",
        [{ ...deployments, id: "vercel.deployments.first" }],
        "achievement vercel.deployments.first must start with example.",
      ],
      [
        "an undeclared event type",
        [withRule({ kind: "events_in_window", typeIds: ["example.deploy.canceled"], count: 10, window: "day" })],
        "achievement example.deployments.first reads event type example.deploy.canceled, which the adapter does not declare",
      ],
      [
        "an undeclared failure type in a streak",
        [
          withRule({
            kind: "event_streak",
            successTypeIds: ["example.deploy.succeeded"],
            failureTypeIds: ["vercel.deployment.failed"],
            count: 10,
          }),
        ],
        "achievement example.deployments.first reads event type vercel.deployment.failed, which the adapter does not declare",
      ],
      [
        "a metric key owned by another provider",
        [withRule({ kind: "metric_threshold", metricKey: "github.stars.total", value: 10 })],
        "achievement example.deployments.first reads metric github.stars.total, which must start with example.",
      ],
      [
        "a daily total declared in neither signupDailyTotals nor dailyTotals",
        [withRule({ kind: "daily_total_threshold", metricKey: "example.signups.daily", value: 10, sum: "cumulative" })],
        "achievement example.deployments.first sums example.signups.daily, which is not declared in signupDailyTotals or dailyTotals",
      ],
    ])("reports %s (boundary)", (_case, achievements, problem) => {
      expect(checkAdapterDeclaration(adapterWith({ achievements }))).toContain(problem);
    });

    // The messages end with zod's wording, so only the achievement and the field are pinned.
    it.each<[string, Achievement, string]>([
      ["an event count of 0", withRule({ kind: "event_count", typeIds: ["example.deploy.succeeded"], count: 0 }), "rule.count"],
      ["a metric threshold of 0", withRule({ kind: "metric_threshold", metricKey: metricKeys.requestsUsed, value: 0 }), "rule.value"],
      ["a negative daily total", withRule({ kind: "daily_total_threshold", metricKey: metricKeys.requestsUsed, value: -5, sum: "single_day" }), "rule.value"],
      ["a run of 0 days", withRule({ kind: "consecutive_days", typeIds: ["example.deploy.succeeded"], days: 0 }), "rule.days"],
      ["a title too long for the card", { ...deployments, title: "x".repeat(81) }, "title"],
    ])("reports %s as invalid (boundary)", (_case, achievement, field) => {
      const problems = checkAdapterDeclaration(adapterWith({ achievements: [achievement] }));
      const prefix = `achievement example.deployments.first is invalid: ${field}: `;
      expect(problems).toContainEqual(expect.stringMatching(new RegExp(`^${prefix.replaceAll(".", "\\.")}\\S`)));
    });
  });
});

describe("checkSyncResult", () => {
  it("passes a result the sync runner would store", () => {
    expect(checkSyncResult(exampleAdapter, ACCOUNT, { metrics: [usage], events: [signup] })).toEqual([]);
  });

  it("passes an empty result (boundary)", () => {
    expect(checkSyncResult(exampleAdapter, ACCOUNT, { metrics: [], events: [] })).toEqual([]);
  });

  // A daily total of usage over the whole UTC day before NOW, as PostHog and GitHub report theirs.
  const yesterday = { type: "period", start: new Date("2026-11-15T00:00:00.000Z"), end: NOW } as const;

  it.each([
    ["signupDailyTotals", adapterWith({ signupDailyTotals: [metricKeys.requestsUsed] })],
    ["dailyTotals", adapterWith({ dailyTotals: [metricKeys.requestsUsed] })],
  ])("passes a total declared in %s over one whole UTC day", (_field, adapter) => {
    expect(checkSyncResult(adapter, ACCOUNT, { metrics: [{ ...usage, timeframe: yesterday }], events: [] })).toEqual([]);
  });

  it.each<[string, AdapterMetric["timeframe"]]>([
    ["a point reading", { type: "point", at: NOW }],
    ["24 hours from 01:00 UTC", { type: "period", start: new Date("2026-11-15T01:00:00.000Z"), end: new Date("2026-11-16T01:00:00.000Z") }],
    ["two whole UTC days", { type: "period", start: new Date("2026-11-14T00:00:00.000Z"), end: NOW }],
    ["a day 1 ms short", { type: "period", start: new Date("2026-11-15T00:00:00.000Z"), end: new Date(NOW.getTime() - 1) }],
  ])("reports a declared daily total whose timeframe is %s (boundary)", (_case, timeframe) => {
    const metrics = [{ ...usage, timeframe }];
    expect(checkSyncResult(adapterWith({ dailyTotals: [metricKeys.requestsUsed] }), ACCOUNT, { metrics, events: [] })).toEqual([
      "metrics[0] example.requests.used is declared in dailyTotals but its timeframe is not one whole UTC day",
    ]);
    expect(checkSyncResult(adapterWith({ signupDailyTotals: [metricKeys.requestsUsed] }), ACCOUNT, { metrics, events: [] })).toEqual([
      "metrics[0] example.requests.used is declared in signupDailyTotals but its timeframe is not one whole UTC day",
    ]);
  });

  it.each<[string, ProviderAdapter<string>, SyncResult, string[]]>([
    [
      "a metric key owned by another provider",
      exampleAdapter,
      { metrics: [{ ...usage, metricKey: "vercel.requests" }], events: [] },
      ["metrics[0].metricKey: must start with example."],
    ],
    [
      "an undeclared event type",
      exampleAdapter,
      { metrics: [], events: [{ ...signup, typeId: "example.unknown" }] },
      ["events[0].typeId: is not one of the adapter's declared event types"],
    ],
    [
      "data for another account",
      exampleAdapter,
      { metrics: [{ ...usage, externalAccountId: "acct_9" }], events: [{ ...signup, externalAccountId: "acct_9" }] },
      ["metrics[0] belongs to account acct_9, not acct_1001", "events[0] belongs to account acct_9, not acct_1001"],
    ],
    [
      "a metric kind the adapter does not declare",
      adapterWith({ capabilities: { ...exampleAdapter.capabilities, usage: false } }),
      { metrics: [usage], events: [] },
      ["metrics[0] is usage but capabilities.usage is false"],
    ],
    [
      "a declared projection that is not estimated spend",
      adapterWith({ projectedSpend: [metricKeys.requestsUsed] }),
      { metrics: [usage], events: [] },
      ["metrics[0] example.requests.used is declared in projectedSpend but is usage"],
    ],
    [
      "a declared daily signup total that is not usage",
      adapterWith({ signupDailyTotals: [metricKeys.creditBalance] }),
      {
        metrics: [
          {
            kind: "credit_balance",
            metricKey: metricKeys.creditBalance,
            label: "Account credit",
            amountMinor: 5,
            currency: "USD",
            timeframe: yesterday,
            externalAccountId: ACCOUNT,
            retrievedAt: NOW,
            provenance: { source: "provider_api" },
          },
        ],
        events: [],
      },
      ["metrics[0] example.credits.balance is declared in signupDailyTotals but is credit_balance"],
    ],
    [
      "a declared daily total that is not usage",
      adapterWith({ dailyTotals: [metricKeys.creditBalance] }),
      {
        metrics: [
          {
            kind: "credit_balance",
            metricKey: metricKeys.creditBalance,
            label: "Account credit",
            amountMinor: 5,
            currency: "USD",
            timeframe: yesterday,
            externalAccountId: ACCOUNT,
            retrievedAt: NOW,
            provenance: { source: "provider_api" },
          },
        ],
        events: [],
      },
      ["metrics[0] example.credits.balance is declared in dailyTotals but is credit_balance"],
    ],
    [
      "a partial error naming a scope the adapter never requests",
      exampleAdapter,
      { metrics: [], events: [], partialErrors: [new PermissionMissingError("refused", ["admin"])] },
      ["partialErrors[0] names admin, which the adapter never requests, so reconnecting cannot fix it"],
    ],
  ])("reports %s (boundary)", (_case, adapter, result, problems) => {
    expect(checkSyncResult(adapter, ACCOUNT, result)).toEqual(problems);
  });
});

describe("checkWebhookOutcome", () => {
  it.each<[string, WebhookOutcome]>([
    ["events for the delivery's account", { kind: "events", externalAccountId: ACCOUNT, events: [signup] }],
    ["no events (boundary: empty)", { kind: "events", externalAccountId: ACCOUNT, events: [] }],
    ["an uninstall", { kind: "uninstalled", externalAccountId: ACCOUNT, occurredAt: NOW }],
    ["an ignored delivery with a reason", { kind: "ignored", reason: "not a delivery Example Cloud maps" }],
  ])("passes %s", (_case, outcome) => {
    expect(checkWebhookOutcome(exampleAdapter, outcome)).toEqual([]);
  });

  it.each<[string, WebhookOutcome, string[]]>([
    ["an ignored delivery without a reason", { kind: "ignored", reason: " " }, ["an ignored delivery has no reason"]],
    ["an uninstall without an account", { kind: "uninstalled", externalAccountId: "", occurredAt: NOW }, ["the uninstalled outcome has no externalAccountId"]],
    [
      "an uninstall with an invalid time",
      { kind: "uninstalled", externalAccountId: ACCOUNT, occurredAt: new Date(Number.NaN) },
      ["the uninstalled outcome has an invalid occurredAt"],
    ],
    [
      "events without an account",
      { kind: "events", externalAccountId: "", events: [] },
      ["the events outcome has no externalAccountId"],
    ],
    [
      "an undeclared event type",
      { kind: "events", externalAccountId: ACCOUNT, events: [{ ...signup, typeId: "example.unknown" }] },
      ["events[0].typeId: is not one of the adapter's declared event types"],
    ],
    [
      "an event for another account",
      { kind: "events", externalAccountId: ACCOUNT, events: [signup, { ...signup, externalAccountId: "acct_9" }] },
      ["events[1] belongs to account acct_9, not acct_1001"],
    ],
  ])("reports %s (boundary)", (_case, outcome, problems) => {
    expect(checkWebhookOutcome(exampleAdapter, outcome)).toEqual(problems);
  });
});

describe("createAdapterHarness and checkTraffic", () => {
  it("answers from the recordings, keyed without the query, and records every request", async () => {
    const harness = createAdapterHarness({
      now: NOW,
      routes: {
        [`GET ${API}/v1/items`]: (request) => ({ body: { page: request.url.searchParams.get("page") } }),
        [`DELETE ${API}/v1/items`]: { status: 204, body: { ignored: true } },
      },
    });
    const response = await harness.ctx.fetch(`${API}/v1/items?page=2`, { signal: AbortSignal.timeout(1000) });
    const empty = await harness.ctx.fetch(`${API}/v1/items`, { method: "delete", signal: AbortSignal.timeout(1000) });

    expect(await response.json()).toEqual({ page: "2" });
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
    expect(harness.requests.map((request) => routeKey(request.method, request.url))).toEqual([
      `GET ${API}/v1/items`,
      `DELETE ${API}/v1/items`,
    ]);
    expect(harness.ctx.now()).toEqual(NOW);
    expect(checkTraffic(harness)).toEqual([]);
  });

  it("answers an unrecorded request with a 404 and reports it (boundary)", async () => {
    const harness = createAdapterHarness({ now: NOW, routes: {} });
    const response = await harness.ctx.fetch(`${API}/v1/unknown`, { signal: AbortSignal.timeout(1000) });
    expect(response.status).toBe(404);
    expect(checkTraffic(harness)).toEqual([`GET ${API}/v1/unknown has no recorded response`]);
  });

  it("hands the adapter the client id, timeout, and extra settings a test passes", () => {
    const harness = createAdapterHarness({
      now: NOW,
      routes: {},
      clientId: "acme-client-id",
      timeoutMs: 250,
      extra: { privateKey: PRIVATE_KEY },
    });
    expect(harness.ctx.client.clientId).toBe("acme-client-id");
    expect(harness.ctx.timeoutMs).toBe(250);
    expect(harness.ctx.client.extra.privateKey?.reveal()).toBe(PRIVATE_KEY);
  });

  it("reports a request over http or without a timeout (boundary)", async () => {
    const harness = createAdapterHarness({
      now: NOW,
      routes: { "GET http://api.example.com/v1/items": { body: [] }, [`GET ${API}/v1/items`]: { body: [] } },
    });
    await harness.ctx.fetch("http://api.example.com/v1/items", { signal: AbortSignal.timeout(1000) });
    await harness.ctx.fetch(`${API}/v1/items`);
    expect(checkTraffic(harness)).toEqual([
      "GET http://api.example.com/v1/items is not https",
      `GET ${API}/v1/items was sent without a timeout; send it through fetchJson`,
    ]);
  });

  it("reports a log line that carries a secret, and passes one with a Secret (boundary)", () => {
    const harness = createAdapterHarness({
      now: NOW,
      routes: {},
      // Made-up keys in both forms an app's private key arrives in: one line with `\n` escapes,
      // and two lines.
      extra: { privateKey: "synthetic-key-a-1\\nsynthetic-key-a-2", multiLine: "synthetic-key-b-1\nsynthetic-key-b-2" },
    });
    harness.ctx.logger.info("example.safe", {
      secret: harness.ctx.client.clientSecret,
      key: harness.ctx.client.extra.multiLine,
      error: new Error("token refused"),
    });
    harness.ctx.logger.warn("example.leak", { token: "synthetic-access-token-1" });
    harness.ctx.logger.error("example.client", { value: harness.clientSecret });
    harness.ctx.logger.error("example.extra", { key: harness.ctx.client.extra.privateKey?.reveal() });
    harness.ctx.logger.error("example.multiline", { key: harness.ctx.client.extra.multiLine?.reveal() });
    harness.ctx.logger.error("example.error", { error: new Error("refused synthetic-access-token-1") });
    harness.ctx.logger.error("example.cause", {
      error: new Error("refused", { cause: new Error("synthetic-access-token-1 expired") }),
    });
    expect(checkTraffic(harness, ["synthetic-access-token-1"])).toEqual([
      "log 1 (example.leak) contains a secret",
      "log 2 (example.client) contains a secret",
      "log 3 (example.extra) contains a secret",
      "log 4 (example.multiline) contains a secret",
      "log 5 (example.error) contains a secret",
      "log 6 (example.cause) contains a secret",
    ]);
  });
});
