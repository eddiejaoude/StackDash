import type { LogFields } from "@/lib/log/logger";
import { AchievementSchema, achievementRuleMetricKey, achievementRuleTypeIds } from "./achievements";
import { EventTypeSchema, validateAdapterEvents } from "./events";
import { validateAdapterMetrics, type AdapterMetric } from "./metrics";
import {
  Secret,
  type AdapterCapabilities,
  type BatchValidation,
  type FetchLike,
  type OAuthContext,
  type ProviderAdapter,
  type SyncResult,
} from "./types";

/**
 * Contract harness for provider adapters (docs/adapters.md). It runs an adapter against recorded
 * provider responses with a fixed clock and no network, and checks what the sync runner, the
 * connect screen, and the dashboard rely on, so an adapter's own tests only have to assert its
 * provider-specific mapping. Each check returns a list of problems in plain words, empty when the
 * adapter keeps the contract, so `expect(check(...)).toEqual([])` prints every problem at once.
 * Test support only: nothing in the app imports it.
 */

export type RecordedRequest = Readonly<{
  method: string;
  url: URL;
  headers: Headers;
  body: string | undefined;
  // True when the request carried an abort signal, which is how `fetchJson` applies the timeout.
  hasTimeout: boolean;
}>;

/** One recorded provider answer. `body` is sent as JSON; leave it out for an empty body. */
export type RecordedResponse = Readonly<{
  status?: number;
  body?: unknown;
  headers?: Readonly<Record<string, string>>;
}>;

/**
 * Recorded answers keyed by method, origin, and path (`GET https://api.example.com/v1/accounts`).
 * The query string is not part of the key: a function route reads it from the request.
 */
export type RecordedRoutes = Readonly<
  Record<string, RecordedResponse | ((request: RecordedRequest) => RecordedResponse)>
>;

export type LogEntry = Readonly<{ level: "info" | "warn" | "error"; event: string; fields: LogFields | undefined }>;

export type AdapterHarness = Readonly<{
  ctx: OAuthContext;
  /** Every request the adapter sent, in order. */
  requests: readonly RecordedRequest[];
  /** Requests no recorded route answered. Each got a 404, and each is a contract problem. */
  unmatched: readonly RecordedRequest[];
  /** Everything the adapter logged, in order. */
  logs: readonly LogEntry[];
  /** The OAuth client secret the harness hands the adapter, for request assertions. */
  clientSecret: string;
  /** Every secret the harness hands the adapter: the client secret and each `extra` value. */
  handedSecrets: readonly string[];
}>;

export type HarnessOptions = Readonly<{
  routes: RecordedRoutes;
  now: Date;
  // Replaces HARNESS_CLIENT_ID.
  clientId?: string;
  // Settings beyond the client id and secret, keyed like `OAuthDescriptor.extraEnv` (an app's
  // private key, say). The adapter gets each one as a `Secret`; `checkTraffic` scans for them.
  extra?: Readonly<Record<string, string>>;
  // Replaces HARNESS_TIMEOUT_MS.
  timeoutMs?: number;
}>;

export const HARNESS_CLIENT_ID = "harness-client-id";
const HARNESS_CLIENT_SECRET = "harness-client-value";
const HARNESS_TIMEOUT_MS = 5000;

export function routeKey(method: string, url: URL): string {
  return `${method.toUpperCase()} ${url.origin}${url.pathname}`;
}

function bodyText(body: RequestInit["body"]): string | undefined {
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return undefined;
}

function respond(answer: RecordedResponse): Response {
  const status = answer.status ?? 200;
  // A 204 or 304 may not carry a body at all.
  const text = answer.body === undefined || status === 204 || status === 304 ? null : JSON.stringify(answer.body);
  return new Response(text, { status, headers: { "Content-Type": "application/json", ...answer.headers } });
}

/**
 * A context for one test: `fetch` answers from `routes` only (never the network), the clock is
 * fixed at `now`, and the logger records. The client secret is synthetic and never sent anywhere.
 */
export function createAdapterHarness(options: HarnessOptions): AdapterHarness {
  const requests: RecordedRequest[] = [];
  const unmatched: RecordedRequest[] = [];
  const logs: LogEntry[] = [];

  const fetch: FetchLike = async (input, init) => {
    const request: RecordedRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: new URL(input),
      headers: new Headers(init?.headers),
      body: bodyText(init?.body),
      hasTimeout: init?.signal instanceof AbortSignal,
    };
    requests.push(request);
    const route = options.routes[routeKey(request.method, request.url)];
    if (route === undefined) {
      unmatched.push(request);
      return respond({ status: 404, body: { error: "no recorded response for this request" } });
    }
    return respond(typeof route === "function" ? route(request) : route);
  };

  const record = (level: LogEntry["level"]) => (event: string, fields?: LogFields) => {
    logs.push({ level, event, fields });
  };

  const extraValues = options.extra ?? {};
  const extra = Object.fromEntries(Object.entries(extraValues).map(([key, value]) => [key, new Secret(value)] as const));

  return {
    ctx: {
      fetch,
      now: () => options.now,
      timeoutMs: options.timeoutMs ?? HARNESS_TIMEOUT_MS,
      logger: { info: record("info"), warn: record("warn"), error: record("error") },
      client: { clientId: options.clientId ?? HARNESS_CLIENT_ID, clientSecret: new Secret(HARNESS_CLIENT_SECRET), extra },
    },
    requests,
    unmatched,
    logs,
    clientSecret: HARNESS_CLIENT_SECRET,
    handedSecrets: [HARNESS_CLIENT_SECRET, ...Object.values(extraValues)],
  };
}

// A provider id is the prefix of every key the adapter owns (`AdapterScopedKeySchema`).
const PROVIDER_ID = /^[a-z][a-z0-9]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const MIN_POLL_INTERVAL_SECONDS = 60;

function blank(value: string): boolean {
  return value.trim().length === 0;
}

/**
 * What the registry, the connect screen, and the dashboard read from the adapter before any sync:
 * its id, the permissions it explains, the data it lists, the event types it declares, and the
 * keys it marks as projections or daily signup totals.
 */
export function checkAdapterDeclaration(adapter: ProviderAdapter<string>): string[] {
  const problems: string[] = [];
  const prefix = `${adapter.id}.`;
  const ownKey = (key: string) => key.startsWith(prefix);

  if (!PROVIDER_ID.test(adapter.id)) problems.push(`id "${adapter.id}" must be lowercase letters and digits`);
  if (blank(adapter.displayName)) problems.push("displayName is empty");

  if (adapter.permissions.length === 0) problems.push("permissions is empty: the connect screen has nothing to show");
  const explained = new Set(adapter.permissions.map((permission) => permission.scope));
  for (const permission of adapter.permissions) {
    if (blank(permission.description)) problems.push(`permission ${permission.scope} has no description`);
    if (permission.access === "full" && blank(permission.fullAccessReason)) {
      problems.push(`permission ${permission.scope} is full access without a fullAccessReason`);
    }
  }
  for (const scope of adapter.oauth.scopes) {
    if (!explained.has(scope)) problems.push(`requested scope ${scope} has no permission entry for the connect screen`);
  }

  if (adapter.dataCollected.length === 0 || adapter.dataCollected.some(blank)) {
    problems.push("dataCollected must list what the adapter reads, one non-empty line each");
  }

  const eventTypeIds = new Set<string>();
  for (const eventType of adapter.eventTypes) {
    const parsed = EventTypeSchema.safeParse(eventType);
    if (!parsed.success) problems.push(`event type ${eventType.id} is invalid: ${parsed.error.issues[0]?.message ?? ""}`);
    if (!ownKey(eventType.id)) problems.push(`event type ${eventType.id} must start with ${prefix}`);
    if (eventTypeIds.has(eventType.id)) problems.push(`event type ${eventType.id} is declared twice`);
    eventTypeIds.add(eventType.id);
  }
  if (adapter.capabilities.events !== adapter.eventTypes.length > 0) {
    problems.push(
      adapter.capabilities.events
        ? "capabilities.events is true but no event types are declared"
        : "event types are declared but capabilities.events is false",
    );
  }

  for (const [field, keys] of [
    ["projectedSpend", adapter.projectedSpend ?? []],
    ["signupDailyTotals", adapter.signupDailyTotals ?? []],
  ] as const) {
    for (const key of keys) {
      if (!ownKey(key)) problems.push(`${field} key ${key} must start with ${prefix}`);
    }
  }
  if ((adapter.projectedSpend ?? []).length > 0 && !adapter.capabilities.spending) {
    problems.push("projectedSpend is declared but capabilities.spending is false");
  }
  if ((adapter.signupDailyTotals ?? []).length > 0 && !adapter.capabilities.usage) {
    problems.push("signupDailyTotals is declared but capabilities.usage is false");
  }

  // Achievement ids are stored on every earned row, so each must be the adapter's own and unique,
  // and every rule must read evidence this adapter writes: one of its event types (with or
  // without a category), or one of its metric keys.
  const achievementIds = new Set<string>();
  const dailyTotals = new Set(adapter.signupDailyTotals ?? []);
  for (const achievement of adapter.achievements ?? []) {
    const label = `achievement ${achievement.id}`;
    if (!ownKey(achievement.id)) problems.push(`${label} must start with ${prefix}`);
    if (achievementIds.has(achievement.id)) problems.push(`${label} is declared twice`);
    achievementIds.add(achievement.id);

    const parsed = AchievementSchema.safeParse(achievement);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`${label} is invalid: ${issue.path.join(".")}: ${issue.message}`);
      continue;
    }
    const { rule } = parsed.data;
    for (const typeId of achievementRuleTypeIds(rule)) {
      if (!eventTypeIds.has(typeId)) problems.push(`${label} reads event type ${typeId}, which the adapter does not declare`);
    }
    const metricKey = achievementRuleMetricKey(rule);
    if (metricKey !== undefined && !ownKey(metricKey)) problems.push(`${label} reads metric ${metricKey}, which must start with ${prefix}`);
    if (rule.kind === "daily_total_threshold" && !dailyTotals.has(rule.metricKey)) {
      problems.push(`${label} sums ${rule.metricKey}, which is not declared in signupDailyTotals`);
    }
  }

  if (adapter.beta !== undefined && blank(adapter.beta.reason)) problems.push("beta is set without a reason");

  if (!Number.isInteger(adapter.pollIntervalSeconds) || adapter.pollIntervalSeconds < MIN_POLL_INTERVAL_SECONDS) {
    problems.push(`pollIntervalSeconds must be a whole number of at least ${MIN_POLL_INTERVAL_SECONDS}`);
  }

  const { clientIdEnv, clientSecretEnv, extraEnv = {}, optionalExtraKeys = [] } = adapter.oauth;
  for (const name of [clientIdEnv, clientSecretEnv, ...Object.values(extraEnv)]) {
    if (!ENV_NAME.test(name)) problems.push(`environment variable name ${name} must be UPPER_SNAKE_CASE`);
    if (name.startsWith("NEXT_PUBLIC_")) problems.push(`${name} would be sent to the browser; drop NEXT_PUBLIC_`);
  }
  for (const key of optionalExtraKeys) {
    if (!Object.hasOwn(extraEnv, key)) problems.push(`optional extra ${key} is not a key of extraEnv`);
  }

  return problems;
}

// The capability that must be declared for the dashboard to show each metric kind (#269 leaves
// out what a provider never declares).
export const KIND_CAPABILITY: Readonly<Record<AdapterMetric["kind"], keyof AdapterCapabilities>> = {
  usage: "usage",
  verified_spend: "spending",
  estimated_spend: "spending",
  included_allowance: "allowance",
  remaining_allowance: "allowance",
  credit_balance: "credits",
  revenue: "revenue",
  recurring_revenue: "revenue",
};

function batchProblems(label: string, batch: BatchValidation<unknown>): string[] {
  return batch.ok ? [] : batch.issues.map((issue) => `${label}[${issue.index}].${issue.path}: ${issue.message}`);
}

/**
 * One `sync` result against the gates the sync runner applies before storing anything
 * (`src/lib/jobs/sync-connection.ts`), plus what the dashboard assumes: every metric kind is a
 * declared capability, a declared projection is estimated spend, and a daily signup total is usage.
 */
export function checkSyncResult(adapter: ProviderAdapter<string>, externalAccountId: string, result: SyncResult): string[] {
  const problems = [
    ...batchProblems("metrics", validateAdapterMetrics(adapter.id, result.metrics)),
    ...batchProblems("events", validateAdapterEvents(adapter.eventTypes, result.events)),
  ];

  const items = [
    ...result.metrics.map((item, index) => [`metrics[${index}]`, item.externalAccountId] as const),
    ...result.events.map((item, index) => [`events[${index}]`, item.externalAccountId] as const),
  ];
  for (const [label, account] of items) {
    if (account !== externalAccountId) problems.push(`${label} belongs to account ${account}, not ${externalAccountId}`);
  }

  const projected = new Set(adapter.projectedSpend ?? []);
  const signupTotals = new Set(adapter.signupDailyTotals ?? []);
  result.metrics.forEach((metric, index) => {
    const capability = KIND_CAPABILITY[metric.kind];
    if (!adapter.capabilities[capability]) {
      problems.push(`metrics[${index}] is ${metric.kind} but capabilities.${capability} is false`);
    }
    if (projected.has(metric.metricKey) && metric.kind !== "estimated_spend") {
      problems.push(`metrics[${index}] ${metric.metricKey} is declared in projectedSpend but is ${metric.kind}`);
    }
    if (signupTotals.has(metric.metricKey) && metric.kind !== "usage") {
      problems.push(`metrics[${index}] ${metric.metricKey} is declared in signupDailyTotals but is ${metric.kind}`);
    }
  });

  const requested = new Set([...adapter.oauth.scopes, ...adapter.permissions.map((permission) => permission.scope)]);
  (result.partialErrors ?? []).forEach((partial, index) => {
    for (const scope of partial.missingScopes) {
      if (!requested.has(scope)) {
        problems.push(`partialErrors[${index}] names ${scope}, which the adapter never requests, so reconnecting cannot fix it`);
      }
    }
  });

  return problems;
}

// Writes an `Error` the way the app's logger does (`redactError`, src/lib/log/redact.ts): its name,
// message, cause, and own fields. `JSON.stringify` alone writes an `Error` as `{}`.
function writtenAsLogged(_key: string, value: unknown): unknown {
  return value instanceof Error ? { ...value, name: value.name, message: value.message, cause: value.cause } : value;
}

/**
 * What the adapter sent and logged during the test: every request answered by a recording, sent
 * over https with a timeout, and no secret (every secret the harness handed the adapter, plus
 * `secrets`, normally the test credential's tokens) in any log line, including inside a logged
 * `Error`.
 */
export function checkTraffic(harness: AdapterHarness, secrets: readonly string[] = []): string[] {
  const problems: string[] = [];
  for (const request of harness.unmatched) {
    problems.push(`${routeKey(request.method, request.url)} has no recorded response`);
  }
  for (const request of harness.requests) {
    const key = routeKey(request.method, request.url);
    if (request.url.protocol !== "https:") problems.push(`${key} is not https`);
    if (!request.hasTimeout) problems.push(`${key} was sent without a timeout; send it through fetchJson`);
  }
  // The line is JSON, where a newline, quote, or backslash inside a string is escaped, so each
  // secret is compared in its escaped form: a multi line private key is found too.
  const needles = [...harness.handedSecrets, ...secrets]
    .filter((value) => value.length > 0)
    .map((value) => JSON.stringify(value).slice(1, -1));
  harness.logs.forEach((entry, index) => {
    const line = JSON.stringify([entry.event, entry.fields ?? {}], writtenAsLogged);
    if (needles.some((needle) => line.includes(needle))) problems.push(`log ${index} (${entry.event}) contains a secret`);
  });
  return problems;
}
