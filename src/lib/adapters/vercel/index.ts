import { z } from "zod";
import { addDecimals, InvalidDecimalError, toMinorUnits, type Decimal } from "@/lib/money";
import { PROVIDER_NAMES } from "@/lib/providers";
import type { Achievement } from "../achievements";
import {
  AuthRevokedError,
  fetchJson,
  InvalidResponseError,
  PermissionMissingError,
} from "../errors";
import type { ActivityEvent, EventType } from "../events";
import type { AdapterMetric } from "../metrics";
import {
  Secret,
  type ExternalAccount,
  type FetchLike,
  type OAuthContext,
  type OAuthCredential,
  type ProviderAdapter,
  type SyncInput,
  type SyncResult,
} from "../types";
import {
  BillingChargesSchema,
  chargeCategories,
  DeploymentsPageSchema,
  TeamSchema,
  TokenResponseSchema,
  type BillingCharge,
  type Deployment,
} from "./schemas";

/**
 * Vercel adapter (adapter pattern over the Vercel REST API), per docs/providers/vercel.md.
 * Connects through a Vercel Integration: install URL with `state` only (no PKCE), a long-lived
 * token with no refresh and no revocation endpoint. Disconnect is handled by the app.
 *
 * Calls only list endpoints. Never call `GET /v9/projects/{idOrName}` or any environment
 * variable endpoint: the project detail response carries environment variable records.
 */

const API_ORIGIN = "https://api.vercel.com";
const TOKEN_URL = `${API_ORIGIN}/v2/oauth/access_token`;
const CHARGES_PATH = "/v1/billing/charges";
const DEPLOYMENTS_PATH = "/v7/deployments";

const SLUG_EXTRA_KEY = "integrationSlug";
const MAX_SLUG_LENGTH = 32;

// Bounded sync: at most this many deployment pages per run, reported through the cursor.
export const MAX_DEPLOYMENT_PAGES = 10;
// The maximum `limit` for GET /v7/deployments is undocumented (docs/providers/vercel.md, Unverified).
const DEPLOYMENT_PAGE_LIMIT = 100;
// Re-read deployments created up to an hour before the cursor so one still building at the last
// poll is seen again once it finishes (Vercel builds are capped below an hour). Dedupe keys make
// the re-read idempotent.
const DEPLOYMENT_OVERLAP_MS = 60 * 60 * 1000;
const FIRST_SYNC_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

const scopes = ["billing:read", "deployment:read", "project:read", "team:read"] as const;

// Exported, like the spend vocabulary and `deploymentEvent` below, for the local simulator (#131).
export const eventTypes = [
  {
    id: "vercel.deployment.succeeded",
    label: "Deployment succeeded",
    description: "A Vercel deployment finished building and is ready.",
    shownByDefault: true,
    category: "deploy_succeeded",
    emoji: "🚀",
  },
  {
    id: "vercel.deployment.failed",
    label: "Deployment failed",
    description: "A Vercel deployment failed to build or deploy.",
    shownByDefault: true,
    category: "deploy_failed",
    emoji: "💥",
  },
] as const satisfies readonly EventType[];

// Achievements (#413). The deployment ladder is shared with Railway, DigitalOcean, and GitLab: keep the ids,
// thresholds, and wording in step with theirs (docs/adapters.md, "Achievements").
const achievements: readonly Achievement[] = [
  {
    id: "vercel.deployments.first",
    title: "First Vercel deployment recorded",
    publicTitle: "First Vercel deployment recorded",
    description: "Earned when StackDash records the first successful Vercel deployment.",
    rule: { kind: "event_count", typeIds: ["vercel.deployment.succeeded"], count: 1 },
  },
  {
    id: "vercel.deployments.10",
    title: "10 Vercel deployments recorded",
    publicTitle: "10 Vercel deployments recorded",
    description: "Earned when StackDash records the 10th successful Vercel deployment.",
    rule: { kind: "event_count", typeIds: ["vercel.deployment.succeeded"], count: 10 },
  },
  {
    id: "vercel.deployments.100",
    title: "100 Vercel deployments recorded",
    publicTitle: "100 Vercel deployments recorded",
    description: "Earned when StackDash records the 100th successful Vercel deployment.",
    rule: { kind: "event_count", typeIds: ["vercel.deployment.succeeded"], count: 100 },
  },
  {
    id: "vercel.deployments.streak_10",
    title: "10 Vercel deployments in a row",
    publicTitle: "10 Vercel deployments in a row",
    description: "Earned when StackDash records 10 successful Vercel deployments in a row, with no failed deployment between them.",
    rule: { kind: "event_streak", successTypeIds: ["vercel.deployment.succeeded"], failureTypeIds: ["vercel.deployment.failed"], count: 10 },
  },
  {
    id: "vercel.deployments.night_owl",
    title: "Night owl: a Vercel deployment between midnight and 5 am",
    publicTitle: "Night owl: a Vercel deployment between midnight and 5 am",
    description: "Earned when StackDash records a successful Vercel deployment between midnight and 5 am London time.",
    rule: { kind: "event_at_local_time", typeIds: ["vercel.deployment.succeeded"], fromHour: 0, toHour: 5 },
  },
  {
    id: "vercel.deployments.friday_ship",
    title: "Shipped on a Friday afternoon",
    publicTitle: "Shipped on a Friday afternoon",
    description: "Earned when StackDash records a successful Vercel deployment on a Friday between 4 pm and midnight London time.",
    rule: { kind: "event_at_local_time", typeIds: ["vercel.deployment.succeeded"], fromHour: 16, toHour: 24, weekdays: ["friday"] },
  },
  {
    id: "vercel.deployments.busy_day",
    title: "Busy day: 10 Vercel deployments in one day",
    publicTitle: "Busy day: 10 Vercel deployments in one day",
    description: "Earned when StackDash records 10 successful Vercel deployments on one London calendar day.",
    rule: { kind: "events_in_window", typeIds: ["vercel.deployment.succeeded"], count: 10, window: "day" },
  },
  {
    id: "vercel.deployments.weekly_rhythm",
    title: "Weekly rhythm: a Vercel deployment on 7 days in a row",
    publicTitle: "Weekly rhythm: a Vercel deployment on 7 days in a row",
    description: "Earned when StackDash records a successful Vercel deployment on each of 7 consecutive London calendar days.",
    rule: { kind: "consecutive_days", typeIds: ["vercel.deployment.succeeded"], days: 7 },
  },
];

/**
 * Charge categories that are charges and so are never negative. FOCUS `Credit` and `Adjustment`
 * rows can be negative, which a `verified_spend` metric cannot hold, so they only count toward
 * the net total.
 */
export const spendCategories = [
  { category: "Usage", metricKey: "vercel.spend.usage", label: "Vercel usage charges, month to date" },
  { category: "Purchase", metricKey: "vercel.spend.purchase", label: "Vercel purchases, month to date" },
  { category: "Tax", metricKey: "vercel.spend.tax", label: "Vercel tax, month to date" },
] as const satisfies readonly { category: BillingCharge["ChargeCategory"]; metricKey: string; label: string }[];

export const TOTAL_METRIC_KEY = "vercel.spend.total";
const BILLING_CURRENCY = "USD";

const HttpsUrlSchema = z.url({ protocol: /^https$/ });

type VercelScope = Readonly<{ configurationId: string; userId: string; teamId?: string }>;

/** The Vercel scope (team or Hobby account) stored with the grant by `exchangeCode`. */
function readScope(credential: OAuthCredential): VercelScope {
  const configurationId = credential.metadata?.["configurationId"];
  const userId = credential.metadata?.["userId"];
  const teamId = credential.metadata?.["teamId"];
  if (configurationId === undefined || userId === undefined) {
    // Only a reconnection rebuilds the metadata, so the runner should ask for one.
    throw new AuthRevokedError("Vercel credential is missing its installation metadata; reconnect Vercel");
  }
  return teamId === undefined ? { configurationId, userId } : { configurationId, userId, teamId };
}

function authorization(credential: OAuthCredential): Record<string, string> {
  return { Authorization: `Bearer ${credential.accessToken.reveal()}` };
}

/** Team installs must send `teamId` on every call; a missing one is the usual cause of 403. */
function apiUrl(path: string, scope: VercelScope, params: Record<string, string> = {}): URL {
  const url = new URL(path, API_ORIGIN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (scope.teamId !== undefined) url.searchParams.set("teamId", scope.teamId);
  return url;
}

/**
 * Billing charges arrive as JSONL (one JSON object per line). This wraps fetch so a successful
 * body is re-served as a JSON array of its lines, which lets `fetchJson` keep owning the timeout,
 * the status mapping, and the zod parse of every line. A malformed line makes the array invalid
 * JSON, so it surfaces as `invalid_response`. Error responses pass through untouched.
 */
function jsonLinesAsArray(fetch: FetchLike): FetchLike {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (!response.ok) return response;
    const lines = (await response.text())
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    return new Response(`[${lines.join(",")}]`, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

const BILLING_ROLE_MESSAGE =
  "Vercel billing data needs a Pro or Enterprise team and an installer with an Owner, Member, Developer, Security, Billing, or Enterprise Viewer role";

function minorUnits(value: Decimal, endpoint: string): number {
  try {
    return toMinorUnits(value, BILLING_CURRENCY);
  } catch (error) {
    if (error instanceof InvalidDecimalError) {
      throw new InvalidResponseError(`${endpoint} returned an amount outside the storable range`, {
        cause: error,
        endpoint,
      });
    }
    throw error;
  }
}

/**
 * Month-to-date billed spend per charge category plus a net total. The window is the current UTC
 * calendar month up to the end of today: the integration scopes expose no billing cycle anchor,
 * and one month stays well inside the endpoint's one year maximum range.
 * Amounts are summed exactly and rounded once per metric, half to even (src/lib/money.ts).
 * Returns a `PermissionMissingError` instead of metrics when the plan or role has no billing
 * access, so deployments still sync and the gap reaches `SyncResult.partialErrors`.
 */
async function syncBilling(
  scope: VercelScope,
  input: SyncInput,
  ctx: OAuthContext,
): Promise<AdapterMetric[] | PermissionMissingError> {
  const endpoint = `${API_ORIGIN}${CHARGES_PATH}`;
  if (scope.teamId === undefined) {
    // The billing scope is Pro and Enterprise only, and those are teams. Whether a Hobby install
    // always has a null team id is unverified (docs/providers/vercel.md, Unverified).
    return new PermissionMissingError(`${BILLING_ROLE_MESSAGE}; this is a Hobby account`, ["billing:read"], {
      endpoint,
    });
  }

  const now = ctx.now();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const url = apiUrl(CHARGES_PATH, scope, { from: from.toISOString(), to: to.toISOString() });

  let charges: BillingCharge[];
  try {
    charges = await fetchJson(
      { ...ctx, fetch: jsonLinesAsArray(ctx.fetch) },
      url,
      { headers: authorization(input.credential) },
      BillingChargesSchema,
    );
  } catch (error) {
    // Hobby plans and installers outside the billing roles get 403 here.
    if (error instanceof PermissionMissingError) {
      return new PermissionMissingError(BILLING_ROLE_MESSAGE, ["billing:read"], {
        cause: error,
        ...(error.status === undefined ? {} : { status: error.status }),
        endpoint,
      });
    }
    throw error;
  }

  const byCategory = new Map<BillingCharge["ChargeCategory"], Decimal[]>(
    chargeCategories.map((category) => [category, []]),
  );
  let skippedRows = 0;
  for (const charge of charges) {
    // The schema enum is USD only; anything else is never summed as dollars.
    if (charge.BillingCurrency !== BILLING_CURRENCY) {
      skippedRows += 1;
      continue;
    }
    byCategory.get(charge.ChargeCategory)?.push(charge.BilledCost);
  }
  if (skippedRows > 0) {
    ctx.logger.warn("vercel.billing.non_usd_rows_skipped", { count: skippedRows });
  }

  const sumOf = (category: BillingCharge["ChargeCategory"]): Decimal =>
    addDecimals(byCategory.get(category) ?? []);

  const base = {
    timeframe: { type: "period", start: from, end: to },
    externalAccountId: input.externalAccountId,
    retrievedAt: now,
    provenance: { source: "provider_api", endpoint },
    currency: BILLING_CURRENCY,
    kind: "verified_spend",
  } as const;

  const metrics: AdapterMetric[] = spendCategories.map(({ category, metricKey, label }) => {
    const amountMinor = minorUnits(sumOf(category), endpoint);
    if (amountMinor < 0) {
      throw new InvalidResponseError(`${endpoint} returned a negative ${category} total`, { endpoint });
    }
    return { ...base, metricKey, label, amountMinor };
  });

  const totalMinor = minorUnits(addDecimals(chargeCategories.map(sumOf)), endpoint);
  if (totalMinor < 0) {
    // Credits exceeded charges; spend metrics cannot be negative, so the total is left out.
    ctx.logger.warn("vercel.billing.negative_total", { amountMinor: totalMinor });
  } else {
    metrics.push({
      ...base,
      metricKey: TOTAL_METRIC_KEY,
      label: "Vercel billed spend, month to date",
      amountMinor: totalMinor,
    });
  }
  return metrics;
}

function environmentLabel(target: string | null | undefined): string {
  if (target === "production") return "Production";
  if (target === "staging") return "Staging";
  return "Preview";
}

/** Only finished deployments become events; personal creator fields never reach here. */
export function deploymentEvent(deployment: Deployment, externalAccountId: string): ActivityEvent | undefined {
  const { readyState } = deployment;
  if (readyState !== "READY" && readyState !== "ERROR") return undefined;
  const succeeded = readyState === "READY";
  const environment = environmentLabel(deployment.target);
  const event: ActivityEvent = {
    typeId: succeeded ? "vercel.deployment.succeeded" : "vercel.deployment.failed",
    occurredAt: new Date(deployment.ready ?? deployment.created),
    severity: succeeded ? "success" : deployment.target === "production" ? "critical" : "warning",
    title: `${environment} deployment of ${deployment.name} ${succeeded ? "succeeded" : "failed"}`,
    externalAccountId,
    // Stable across re-polls: one event per deployment and final state.
    dedupeKey: `${deployment.uid}:${readyState}`,
  };
  const errorCode = deployment.errorCode?.trim();
  if (!succeeded && errorCode !== undefined && errorCode.length > 0) {
    event.body = `Error code: ${errorCode}`;
  }
  const link = HttpsUrlSchema.safeParse(deployment.inspectorUrl);
  if (link.success) event.url = link.data;
  return event;
}

/** The cursor is the latest deployment `created` time seen, in Unix milliseconds. */
function parseCursor(cursor: string | undefined, ctx: OAuthContext): number | undefined {
  if (cursor === undefined) return undefined;
  if (/^\d+$/.test(cursor) && Number.isSafeInteger(Number(cursor))) return Number(cursor);
  ctx.logger.warn("vercel.deployments.cursor_ignored", { reason: "not a millisecond timestamp" });
  return undefined;
}

async function syncDeployments(
  scope: VercelScope,
  input: SyncInput,
  ctx: OAuthContext,
): Promise<{ events: ActivityEvent[]; latestCreated: number | undefined }> {
  const previous = parseCursor(input.cursor, ctx);
  const since =
    previous === undefined
      ? ctx.now().getTime() - FIRST_SYNC_LOOKBACK_MS
      : Math.max(0, previous - DEPLOYMENT_OVERLAP_MS);

  const events = new Map<string, ActivityEvent>();
  let latestCreated = previous;
  let until: number | undefined;

  for (let page = 1; page <= MAX_DEPLOYMENT_PAGES; page += 1) {
    const params: Record<string, string> = { since: String(since), limit: String(DEPLOYMENT_PAGE_LIMIT) };
    // Passing `pagination.next` as `until` is inferred from the field descriptions
    // (docs/providers/vercel.md, Unverified).
    if (until !== undefined) params["until"] = String(until);
    const body = await fetchJson(
      ctx,
      apiUrl(DEPLOYMENTS_PATH, scope, params),
      { headers: authorization(input.credential) },
      DeploymentsPageSchema,
    );

    for (const deployment of body.deployments) {
      latestCreated = Math.max(latestCreated ?? deployment.created, deployment.created);
      const event = deploymentEvent(deployment, input.externalAccountId);
      if (event !== undefined) events.set(event.dedupeKey, event);
    }

    const next = body.pagination.next;
    if (next === null || next === undefined || body.deployments.length === 0) break;
    if (page === MAX_DEPLOYMENT_PAGES) {
      ctx.logger.warn("vercel.deployments.page_cap_reached", { pages: MAX_DEPLOYMENT_PAGES });
      break;
    }
    until = next;
  }

  return { events: [...events.values()], latestCreated };
}

export const vercelAdapter: ProviderAdapter = {
  id: "vercel",
  displayName: PROVIDER_NAMES.vercel,
  capabilities: {
    oauth: true,
    polling: true,
    usage: false,
    spending: true,
    allowance: false,
    credits: false,
    revenue: false,
    events: true,
  },
  permissions: [
    {
      scope: "billing:read",
      access: "read",
      description:
        "Usage and cost charges for the whole team, every project included. Pro and Enterprise teams only.",
    },
    {
      scope: "deployment:read",
      access: "read",
      description:
        "Deployments, which on Vercel also includes build logs, file lists, and the file structure of each deployment. Build logs can contain secrets. StackDash only lists deployments.",
    },
    {
      scope: "project:read",
      access: "read",
      description:
        "Projects, which on Vercel also includes project details with environment variable records. StackDash never reads project details or environment variables.",
    },
    {
      scope: "team:read",
      access: "read",
      description:
        "Team name and plan. Also allows listing team members; StackDash never reads the member list.",
    },
  ],
  dataCollected: [
    "Month-to-date billed spend by charge category (Pro and Enterprise teams)",
    "Deployment outcomes (succeeded or failed) with project name and environment",
  ],
  eventTypes,
  achievements,
  oauth: {
    authorizeUrl: "https://vercel.com/integrations/{slug}/new",
    tokenUrl: TOKEN_URL,
    // Integration scopes are set in the Integrations Console, not sent with the install URL.
    scopes,
    pkce: false,
    clientIdEnv: "VERCEL_CLIENT_ID",
    clientSecretEnv: "VERCEL_CLIENT_SECRET",
    extraEnv: { [SLUG_EXTRA_KEY]: "VERCEL_INTEGRATION_SLUG" },
  },
  pollIntervalSeconds: 3600,

  buildAuthorizeUrl({ client, state }) {
    const slug = client.extra[SLUG_EXTRA_KEY]?.reveal().trim();
    if (slug === undefined || slug.length === 0 || slug.length > MAX_SLUG_LENGTH) {
      throw new TypeError("VERCEL_INTEGRATION_SLUG must be set to the integration's URL slug");
    }
    // The Redirect URL is fixed in the Integrations Console, so it is not a parameter here.
    const url = new URL(`https://vercel.com/integrations/${encodeURIComponent(slug)}/new`);
    url.searchParams.set("state", state);
    return url;
  },

  async exchangeCode(input, ctx) {
    const token = await fetchJson(
      ctx,
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: ctx.client.clientId,
          client_secret: ctx.client.clientSecret.reveal(),
          code: input.code,
          redirect_uri: input.redirectUri,
        }),
      },
      TokenResponseSchema,
    );

    if (token.token_type.toLowerCase() !== "bearer") {
      throw new InvalidResponseError("Vercel returned a token type other than Bearer", { endpoint: TOKEN_URL });
    }
    // Callback parameters are untrusted: they must agree with the token response, which wins.
    const callbackConfigurationId = input.callbackParams["configurationId"];
    if (callbackConfigurationId !== undefined && callbackConfigurationId !== token.installation_id) {
      throw new InvalidResponseError("Vercel callback configurationId does not match the installation", {
        endpoint: TOKEN_URL,
      });
    }
    if ((input.callbackParams["teamId"] ?? null) !== token.team_id) {
      throw new InvalidResponseError("Vercel callback teamId does not match the installation", {
        endpoint: TOKEN_URL,
      });
    }

    const metadata: Record<string, string> = {
      configurationId: token.installation_id,
      userId: token.user_id,
    };
    if (token.team_id !== null) metadata["teamId"] = token.team_id;

    // The token response lists no scopes; the grant is the console configuration, which is what
    // the adapter requests. No `expiresAt` and no refresh token: the token is long-lived.
    return {
      accessToken: new Secret(token.access_token),
      scopes: [...scopes],
      tokenType: "Bearer",
      metadata,
    };
  },

  async listAccounts(credential, ctx): Promise<ExternalAccount[]> {
    const scope = readScope(credential);
    if (scope.teamId === undefined) {
      // Hobby install: StackDash does not request the `user` scope, so there is no name to read.
      return [{ externalId: scope.userId, displayName: "Vercel personal account", kind: "user" }];
    }
    const team = await fetchJson(
      ctx,
      apiUrl(`/v2/teams/${encodeURIComponent(scope.teamId)}`, scope),
      { headers: authorization(credential) },
      TeamSchema,
    );
    const name = team.name?.trim();
    return [
      {
        externalId: team.id,
        displayName: name !== undefined && name.length > 0 ? name : team.slug,
        kind: "team",
      },
    ];
  },

  detectMissingPermissions(grant) {
    return scopes.filter((scope) => !grant.scopes.includes(scope));
  },

  async sync(input, ctx) {
    const scope = readScope(input.credential);
    const accountId = scope.teamId ?? scope.userId;
    if (input.externalAccountId !== accountId) {
      throw new Error("Vercel sync was handed an external account the credential does not cover");
    }
    // Deployments first: a disabled installation fails here with 403 instead of being read as a
    // billing permission gap.
    const { events, latestCreated } = await syncDeployments(scope, input, ctx);
    const billing = await syncBilling(scope, input, ctx);
    const result: SyncResult =
      billing instanceof PermissionMissingError
        ? { metrics: [], events, partialErrors: [billing] }
        : { metrics: billing, events };
    if (latestCreated !== undefined) result.cursor = String(latestCreated);
    return result;
  },
};
