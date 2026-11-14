import { z } from "zod";

import {
  AuthRevokedError,
  InvalidResponseError,
  PermissionMissingError,
  ProviderUnavailableError,
  RateLimitedError,
} from "@/lib/adapters/errors";
import type { ActivityEvent, EventType } from "@/lib/adapters/events";
import type { AdapterMetric } from "@/lib/adapters/metrics";
import {
  Secret,
  type ExternalAccount,
  type OAuthCredential,
  type OAuthGrant,
  type Permission,
  type ProviderAdapter,
  type SyncInput,
  type SyncResult,
} from "@/lib/adapters/types";
import { addDecimals, parseDecimal, toMinorUnits } from "@/lib/money";
import { PROVIDER_NAMES } from "@/lib/providers";

/**
 * In-memory provider for unit tests, sync engine tests, and Playwright e2e (#40). It never touches
 * the network: the "consent screen" is the dev-only route at FAKE_AUTHORIZE_PATH, codes and tokens
 * are minted locally, and `sync` derives every number from `ctx.now()` so the same clock always
 * yields the same metric keys, values, and event dedupe keys.
 */

export const FAKE_AUTHORIZE_PATH = "/api/dev/fake-provider/authorize";
export const FAKE_CALLBACK_PATH = "/api/connections/fake/callback";
export const FAKE_CODE_PREFIX = "fake-";
// The route is served only when this variable is exactly "1" (never in production).
export const FAKE_PROVIDER_ENABLE_ENV = "DEVMACRO_ENABLE_FAKE_PROVIDER";

export const FAKE_SCOPE_USAGE_READ = "usage:read";
export const FAKE_SCOPE_ADMIN = "admin";
export const fakeScopes = [FAKE_SCOPE_USAGE_READ, FAKE_SCOPE_ADMIN] as const;
// `admin` is requested so the permission disclosure can show a full-access scope, but declining
// it is fine: only `usage:read` is needed to sync.
const requiredScopes: readonly string[] = [FAKE_SCOPE_USAGE_READ];

/**
 * Failure switch for tests, carried from the callback's `mode` parameter into the credential
 * metadata. `refreshTokens` and `sync` honour it; `listAccounts` does not, so a connection can be
 * created and the failure then surfaces where it would for a real provider: on the next sync.
 */
export const FakeModeSchema = z.enum(["ok", "rate_limited", "revoked", "unavailable"]);
export type FakeMode = z.infer<typeof FakeModeSchema>;

const FAKE_RATE_LIMIT_RETRY_AFTER_MS = 1000;
const ACCESS_TOKEN_TTL_SECONDS = 3600;
// Stand-in for the endpoint a real adapter reads, so provenance and errors name a source.
const FAKE_ENDPOINT = "in-memory:fake-provider";
const PRICING_SOURCE = "Example provider price list (fake, fixed in code)";
const CURRENCY = "USD";
// The whole month at today's daily charge, declared as projected spend.
const PROJECTED_SPEND_METRIC_KEY = "fake.cost.estimate";
const INCLUDED_REQUESTS = 50_000;
// The event "page" cap: a sync never looks further back than this many UTC days.
export const FAKE_EVENT_WINDOW_DAYS = 7;
const DAY_MS = 86_400_000;
const SIGNUP_OFFSET_MS = (9 * 60 + 30) * 60_000; // 09:30 UTC
const DEPLOY_OFFSET_MS = 12 * 60 * 60_000; // 12:00 UTC

type FakeAccount = ExternalAccount & Readonly<{ dailyRequests: number; dailyCharge: string }>;

// Daily charges have sub-cent precision on purpose: the month total is summed exactly and rounded
// once, so a per-day rounding bug shows up as a one-cent difference in the tests.
const fakeAccounts: readonly FakeAccount[] = [
  { externalId: "fake-acct-1", displayName: "Example team", kind: "team", dailyRequests: 1200, dailyCharge: "1.2345" },
  { externalId: "fake-acct-2", displayName: "Example sandbox", kind: "team", dailyRequests: 150, dailyCharge: "0.0105" },
];

const eventTypes = [
  {
    id: "fake.deploy.succeeded",
    label: "Deployment succeeded",
    description: "A deployment on the example provider finished successfully.",
    shownByDefault: true,
    category: "deploy_succeeded",
    emoji: "🚀",
  },
  {
    id: "fake.signup",
    label: "New signup",
    description: "Someone signed up to the example app. No details about the person are collected.",
    shownByDefault: true,
    category: "signup",
    emoji: "👋",
  },
] as const satisfies readonly EventType[];

const permissions: readonly Permission[] = [
  {
    scope: FAKE_SCOPE_USAGE_READ,
    access: "read",
    description: "Read request counts and spend. Without it, deployments and signups still sync.",
  },
  {
    scope: FAKE_SCOPE_ADMIN,
    access: "full",
    description: "Change settings on the example provider.",
    fullAccessReason:
      "Requested only to exercise the full-access disclosure in tests. DevMacro never uses it, and you can decline it.",
  },
];

const CursorSchema = z.iso.datetime();

function readMode(credential: OAuthCredential): FakeMode {
  const parsed = FakeModeSchema.optional().safeParse(credential.metadata?.mode);
  if (!parsed.success) {
    throw new InvalidResponseError("Fake credential carries an unknown mode", { cause: parsed.error });
  }
  return parsed.data ?? "ok";
}

function failForMode(mode: FakeMode): void {
  switch (mode) {
    case "ok":
      return;
    case "rate_limited":
      throw new RateLimitedError("Fake provider rate limited the request (mode rate_limited)", FAKE_RATE_LIMIT_RETRY_AFTER_MS, {
        status: 429,
        endpoint: FAKE_ENDPOINT,
      });
    case "revoked":
      throw new AuthRevokedError("Fake provider rejected the credential (mode revoked)", {
        status: 401,
        endpoint: FAKE_ENDPOINT,
      });
    case "unavailable":
      throw new ProviderUnavailableError("Fake provider is unavailable (mode unavailable)", {
        status: 503,
        endpoint: FAKE_ENDPOINT,
      });
  }
}

/** Keeps only scopes this adapter knows, in its own order, so untrusted input cannot add scopes. */
export function parseFakeScopes(value: string): string[] {
  const listed = new Set(value.split(/\s+/).filter((scope) => scope.length > 0));
  return fakeScopes.filter((scope) => listed.has(scope));
}

function mintCredential(mode: FakeMode, scopes: readonly string[], now: Date): OAuthCredential {
  return {
    accessToken: new Secret(`fake-at-${crypto.randomUUID()}`),
    refreshToken: new Secret(`fake-rt-${crypto.randomUUID()}`),
    expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000),
    scopes,
    tokenType: "bearer",
    metadata: { mode },
  };
}

function buildMetrics(account: FakeAccount, now: Date): AdapterMetric[] {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const dayOfMonth = now.getUTCDate();
  const monthStart = new Date(Date.UTC(year, month, 1));
  const nextMonthStart = new Date(Date.UTC(year, month + 1, 1));
  // Today counts as a full day, so the period always has a positive length, even at midnight.
  const tomorrowStart = new Date(Date.UTC(year, month, dayOfMonth + 1));
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  // Summed exactly at full precision, rounded once (src/lib/money.ts).
  const dailyCharge = parseDecimal(account.dailyCharge);
  const spentSoFar = addDecimals(Array.from({ length: dayOfMonth }, () => dailyCharge));
  const projected = addDecimals(Array.from({ length: daysInMonth }, () => dailyCharge));
  const used = account.dailyRequests * dayOfMonth;
  const monthToDate = { type: "period", start: monthStart, end: tomorrowStart } as const;
  const wholeMonth = { type: "period", start: monthStart, end: nextMonthStart } as const;
  const common = { externalAccountId: account.externalId, retrievedAt: now };
  const fromApi = { source: "provider_api", endpoint: `${FAKE_ENDPOINT}/usage` } as const;

  return [
    {
      ...common,
      kind: "verified_spend",
      metricKey: "fake.spend.month",
      label: "Spend this month",
      timeframe: monthToDate,
      amountMinor: toMinorUnits(spentSoFar, CURRENCY),
      currency: CURRENCY,
      provenance: { source: "provider_api", endpoint: `${FAKE_ENDPOINT}/billing` },
    },
    {
      ...common,
      kind: "usage",
      metricKey: "fake.requests.month",
      label: "Requests this month",
      timeframe: monthToDate,
      value: used,
      unit: "requests",
      provenance: fromApi,
      resetsAt: nextMonthStart,
    },
    {
      ...common,
      kind: "included_allowance",
      metricKey: "fake.requests.included",
      label: "Requests included in the plan",
      timeframe: wholeMonth,
      value: INCLUDED_REQUESTS,
      unit: "requests",
      provenance: fromApi,
      resetsAt: nextMonthStart,
    },
    {
      ...common,
      kind: "remaining_allowance",
      metricKey: "fake.requests.remaining",
      label: "Requests left in the plan",
      timeframe: wholeMonth,
      value: Math.max(0, INCLUDED_REQUESTS - used),
      unit: "requests",
      provenance: fromApi,
      resetsAt: nextMonthStart,
    },
    {
      ...common,
      kind: "estimated_spend",
      metricKey: PROJECTED_SPEND_METRIC_KEY,
      label: "Estimated spend for the month",
      timeframe: wholeMonth,
      amountMinor: toMinorUnits(projected, CURRENCY),
      currency: CURRENCY,
      provenance: { source: "derived", endpoint: `${FAKE_ENDPOINT}/billing`, pricingSource: PRICING_SOURCE },
    },
  ];
}

/**
 * One signup (09:30 UTC) and one deployment (12:00 UTC) per UTC day, newer than the cursor and no
 * older than FAKE_EVENT_WINDOW_DAYS. Dedupe keys are the type, account, and UTC date, so polling
 * the same day twice yields the same keys.
 */
function buildEvents(account: FakeAccount, now: Date, after: Date | undefined): ActivityEvent[] {
  const todayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const events: ActivityEvent[] = [];
  for (let offset = FAKE_EVENT_WINDOW_DAYS - 1; offset >= 0; offset -= 1) {
    const dayStart = todayStart - offset * DAY_MS;
    const date = new Date(dayStart).toISOString().slice(0, 10);
    const candidates: ActivityEvent[] = [
      {
        typeId: "fake.signup",
        occurredAt: new Date(dayStart + SIGNUP_OFFSET_MS),
        severity: "info",
        title: "New signup",
        externalAccountId: account.externalId,
        dedupeKey: `fake.signup:${account.externalId}:${date}`,
      },
      {
        typeId: "fake.deploy.succeeded",
        occurredAt: new Date(dayStart + DEPLOY_OFFSET_MS),
        severity: "success",
        title: "Deployment succeeded",
        body: `Daily deployment for ${date}.`,
        externalAccountId: account.externalId,
        dedupeKey: `fake.deploy.succeeded:${account.externalId}:${date}`,
      },
    ];
    for (const event of candidates) {
      const at = event.occurredAt.getTime();
      if (at <= now.getTime() && (after === undefined || at > after.getTime())) events.push(event);
    }
  }
  return events;
}

function parseCursor(cursor: string | undefined): Date | undefined {
  if (cursor === undefined) return undefined;
  const parsed = CursorSchema.safeParse(cursor);
  if (!parsed.success) {
    throw new InvalidResponseError("Fake sync cursor is not an ISO timestamp", { cause: parsed.error });
  }
  return new Date(parsed.data);
}

export const fakeAdapter: ProviderAdapter = {
  id: "fake",
  displayName: PROVIDER_NAMES.fake,
  capabilities: {
    oauth: true,
    polling: true,
    webhooks: false,
    usage: true,
    spending: true,
    allowance: true,
    credits: false,
    revenue: false,
    events: true,
  },
  permissions,
  dataCollected: [
    "Requests per month and the requests included in the plan",
    "Spend this month and an estimate for the whole month",
    "Deployments and signups, as counts only, with no details about people",
  ],
  eventTypes,
  projectedSpend: [PROJECTED_SPEND_METRIC_KEY],
  oauth: {
    // Relative to DevMacro's own origin; `buildAuthorizeUrl` resolves it against the redirect URI.
    authorizeUrl: FAKE_AUTHORIZE_PATH,
    // Never requested: `exchangeCode` and `refreshTokens` mint tokens in memory.
    tokenUrl: `${FAKE_ENDPOINT}/token`,
    scopes: fakeScopes,
    pkce: false,
    clientIdEnv: "FAKE_PROVIDER_CLIENT_ID",
    clientSecretEnv: "FAKE_PROVIDER_CLIENT_SECRET",
  },
  pollIntervalSeconds: 3600,

  buildAuthorizeUrl({ state, redirectUri }) {
    const url = new URL(FAKE_AUTHORIZE_PATH, new URL(redirectUri).origin);
    url.searchParams.set("state", state);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", fakeScopes.join(" "));
    return url;
  },

  async exchangeCode({ code, callbackParams }, ctx) {
    if (!code.startsWith(FAKE_CODE_PREFIX) || code.length === FAKE_CODE_PREFIX.length) {
      throw new InvalidResponseError("Fake provider did not issue this authorization code", {
        status: 400,
        endpoint: `${FAKE_ENDPOINT}/token`,
      });
    }
    const mode = FakeModeSchema.optional().safeParse(callbackParams.mode);
    if (!mode.success) {
      throw new InvalidResponseError("Fake callback carries an unknown mode", { cause: mode.error });
    }
    const granted = callbackParams.granted_scope;
    const scopes = granted === undefined ? [...fakeScopes] : parseFakeScopes(granted);
    return mintCredential(mode.data ?? "ok", scopes, ctx.now());
  },

  async refreshTokens(credential, ctx) {
    const mode = readMode(credential);
    failForMode(mode);
    if (credential.refreshToken === undefined) {
      throw new AuthRevokedError("Fake credential has no refresh token", { endpoint: `${FAKE_ENDPOINT}/token` });
    }
    return mintCredential(mode, credential.scopes, ctx.now());
  },

  async listAccounts() {
    return fakeAccounts.map(({ externalId, displayName, kind }) => ({ externalId, displayName, kind }));
  },

  detectMissingPermissions(grant: OAuthGrant) {
    return requiredScopes.filter((scope) => !grant.scopes.includes(scope));
  },

  async sync({ credential, externalAccountId, cursor }: SyncInput, ctx): Promise<SyncResult> {
    failForMode(readMode(credential));
    const account = fakeAccounts.find((candidate) => candidate.externalId === externalAccountId);
    if (account === undefined) {
      // A real provider answers 404 for an account the grant cannot see; fetchJson maps that here.
      throw new InvalidResponseError("Fake provider has no such account", { status: 404, endpoint: FAKE_ENDPOINT });
    }
    const now = ctx.now();
    const events = buildEvents(account, now, parseCursor(cursor));
    const last = events.at(-1);
    const nextCursor = last === undefined ? cursor : last.occurredAt.toISOString();
    // Without `usage:read` the numbers are unreachable but events are not: return what is
    // reachable and name the missing scope, like a real adapter hitting a 403 on billing.
    const canReadUsage = credential.scopes.includes(FAKE_SCOPE_USAGE_READ);
    const result: SyncResult = { metrics: canReadUsage ? buildMetrics(account, now) : [], events };
    if (!canReadUsage) {
      result.partialErrors = [
        new PermissionMissingError("Fake provider needs usage:read for usage and spend", [FAKE_SCOPE_USAGE_READ], {
          status: 403,
          endpoint: `${FAKE_ENDPOINT}/usage`,
        }),
      ];
    }
    if (nextCursor !== undefined) result.cursor = nextCursor;
    return result;
  },
};
