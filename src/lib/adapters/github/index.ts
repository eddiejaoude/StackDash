import { PROVIDER_NAMES } from "@/lib/providers";
import type { Achievement } from "../achievements";
import { AuthRevokedError, fetchJson, InvalidResponseError, PermissionMissingError } from "../errors";
import type { ActivityEvent } from "../events";
import type { AdapterMetric } from "../metrics";
import {
  Secret,
  type AuthorizeUrlParams,
  type ExchangeCodeInput,
  type OAuthContext,
  type OAuthCredential,
  type OAuthGrant,
  type ProviderAdapter,
  type SyncInput,
  type SyncResult,
} from "../types";
import {
  API_ORIGIN,
  assertNotSuspended,
  getInstallation,
  getJson,
  installationIdOf,
  metadataKeys,
  mintInstallationToken,
  requireExtra,
} from "./api";
import { collectBilling } from "./billing";
import { collectRepositories, CursorSchema, eventTypes, POLL_INTERVAL_SECONDS, starMetricNames, type Cursor } from "./repositories";
import {
  TokenResponseSchema,
  UserInstallationsPageSchema,
  type Installation,
  type TokenSuccess,
} from "./schemas";

/**
 * GitHub adapter (adapter pattern over a GitHub App), per docs/providers/github.md.
 *
 * Connecting takes two browser legs on the same callback route:
 * 1. `buildAuthorizeUrl` returns the app install URL. GitHub redirects back with `installation_id`
 *    (see `readCallback`), which is untrusted.
 * 2. `buildUserAuthorizeUrl` starts the user authorization (PKCE). Its callback carries `code`;
 *    the route passes the pending `installation_id` from leg 1 in `callbackParams`, and
 *    `exchangeCode` verifies the authorizing user can access that installation before trusting it.
 *
 * Sync mints a short-lived installation token from the app JWT every run. Personal accounts keep
 * the user token as well, because personal billing endpoints only accept user tokens.
 */

const OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const INSTALLATIONS_PAGE_SIZE = 100;
// Bounded verification: at most 1,000 installations are searched for the callback's id.
const MAX_INSTALLATION_PAGES = 10;

// GitHub App permissions configured on the app registration, as `<permission>:<level>`. GitHub
// Apps have no OAuth scopes, so nothing is sent on the authorize URL; the grant's `scopes` hold the
// installation's permissions instead.
const appPermissions = {
  metadata: "metadata:read",
  organizationAdministration: "organization_administration:read",
  plan: "plan:read",
} as const;

/** What a request to the shared callback route carries, for the route to pick the next step. */
export type GitHubCallback =
  | { step: "installed"; installationId: string }
  | { step: "authorized"; code: string }
  // The user declined the authorization (`error=access_denied`).
  | { step: "denied" }
  // A non-owner asked an organization owner to approve the install; nothing is connected yet.
  | { step: "requested" };

export function readCallback(params: Readonly<Record<string, string>>): GitHubCallback {
  if (params.error !== undefined) return { step: "denied" };
  const code = params.code;
  if (code !== undefined && code.length > 0) return { step: "authorized", code };
  const installationId = params.installation_id;
  if (installationId !== undefined && /^\d+$/.test(installationId)) return { step: "installed", installationId };
  // `setup_action=request` and the redirect without `installation_id` are in the page's Unverified list.
  return { step: "requested" };
}

/** Leg 2: user authorization with PKCE, bound to a new `state` that the route ties to the pending installation. */
export function buildUserAuthorizeUrl({ client, state, redirectUri, codeChallenge }: AuthorizeUrlParams): URL {
  if (codeChallenge === undefined) throw new TypeError("GitHub user authorization requires a PKCE code challenge");
  const url = new URL(OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url;
}

async function requestToken(ctx: OAuthContext, params: Record<string, string>): Promise<TokenSuccess> {
  const body = new URLSearchParams({
    client_id: ctx.client.clientId,
    client_secret: ctx.client.clientSecret.reveal(),
    ...params,
  });
  // `Accept: application/json` is documented for OAuth apps; whether a GitHub App needs it is in
  // the page's Unverified list, so it is always sent.
  const response = await fetchJson(
    ctx,
    OAUTH_TOKEN_URL,
    { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" }, body },
    TokenResponseSchema,
  );
  if ("error" in response) {
    // The OAuth error code is a fixed GitHub string, never a token.
    if (response.error === "bad_refresh_token" || response.error === "bad_verification_code") {
      throw new AuthRevokedError(`GitHub rejected the grant (${response.error}); authorize GitHub again`);
    }
    throw new InvalidResponseError(`GitHub token endpoint returned ${response.error}`, { endpoint: OAUTH_TOKEN_URL });
  }
  return response;
}

/** `GET /user/installations`, paginated and bounded, looking for one installation id. */
async function findUserInstallation(
  ctx: OAuthContext,
  userToken: Secret,
  installationId: string,
): Promise<Installation | undefined> {
  let seen = 0;
  for (let page = 1; page <= MAX_INSTALLATION_PAGES; page += 1) {
    const response = await getJson(ctx, "/user/installations", userToken, UserInstallationsPageSchema, {
      per_page: String(INSTALLATIONS_PAGE_SIZE),
      page: String(page),
    });
    const match = response.installations.find((installation) => String(installation.id) === installationId);
    if (match !== undefined) return match;
    seen += response.installations.length;
    if (response.installations.length < INSTALLATIONS_PAGE_SIZE || seen >= response.total_count) return undefined;
  }
  return undefined;
}

/**
 * Organizations do not need the user token after verification, so it is revoked
 * (`DELETE /applications/{client_id}/token`, 204 No Content). A failed revocation is logged and
 * not fatal: the token expires within 8 hours either way and DevMacro never sends it again.
 */
async function revokeUserToken(ctx: OAuthContext, userToken: Secret): Promise<void> {
  const endpoint = `${API_ORIGIN}/applications/${encodeURIComponent(ctx.client.clientId)}/token`;
  const basic = Buffer.from(`${ctx.client.clientId}:${ctx.client.clientSecret.reveal()}`).toString("base64");
  try {
    const response = await ctx.fetch(endpoint, {
      method: "DELETE",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/json",
        "User-Agent": "DevMacro",
      },
      body: JSON.stringify({ access_token: userToken.reveal() }),
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
    if (!response.ok) ctx.logger.warn("github.user_token_revoke_failed", { status: response.status });
  } catch (error) {
    ctx.logger.warn("github.user_token_revoke_failed", { reason: error instanceof Error ? error.name : "unknown" });
  }
}

function parseCursor(cursor: string | undefined, ctx: OAuthContext): Cursor | undefined {
  if (cursor === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(cursor);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    raw = undefined;
  }
  const parsed = CursorSchema.safeParse(raw);
  if (!parsed.success) {
    // Our own format changed or was corrupted: start over as a first sync, which fires no backfill events.
    ctx.logger.warn("github.sync.cursor_reset", {});
    return undefined;
  }
  return parsed.data;
}

// Achievements (#413). Star thresholds come from the stored `github.stars.total` snapshots,
// Trending from the `github.stars.gained.daily` daily totals, forks from `github.forks.new` events
// (docs/adapters.md, "Achievements").
const achievements: readonly Achievement[] = [
  {
    id: "github.stars.10",
    title: "10 GitHub stars",
    publicTitle: "10 GitHub stars",
    description: "Earned when DevMacro records 10 or more stars across the connected GitHub repositories.",
    rule: { kind: "metric_threshold", metricKey: "github.stars.total", value: 10 },
  },
  {
    id: "github.stars.100",
    title: "100 GitHub stars",
    publicTitle: "100 GitHub stars",
    description: "Earned when DevMacro records 100 or more stars across the connected GitHub repositories.",
    rule: { kind: "metric_threshold", metricKey: "github.stars.total", value: 100 },
  },
  {
    id: "github.stars.1000",
    title: "1,000 GitHub stars",
    publicTitle: "1,000 GitHub stars",
    description: "Earned when DevMacro records 1,000 or more stars across the connected GitHub repositories.",
    rule: { kind: "metric_threshold", metricKey: "github.stars.total", value: 1000 },
  },
  {
    id: "github.stars.10000",
    title: "10,000 GitHub stars",
    publicTitle: "10,000 GitHub stars",
    description: "Earned when DevMacro records 10,000 or more stars across the connected GitHub repositories.",
    rule: { kind: "metric_threshold", metricKey: "github.stars.total", value: 10000 },
  },
  {
    id: "github.stars.777",
    title: "Lucky sevens: 777 GitHub stars",
    publicTitle: "Lucky sevens: 777 GitHub stars",
    description: "Earned when DevMacro records 777 or more stars across the connected GitHub repositories.",
    rule: { kind: "metric_threshold", metricKey: "github.stars.total", value: 777 },
  },
  {
    id: "github.stars.1024",
    title: "Kilostar: 1,024 GitHub stars",
    publicTitle: "Kilostar: 1,024 GitHub stars",
    description: "Earned when DevMacro records 1,024 or more stars across the connected GitHub repositories.",
    rule: { kind: "metric_threshold", metricKey: "github.stars.total", value: 1024 },
  },
  {
    id: "github.stars.hot_day",
    title: "Trending: 10 new stars in one day",
    publicTitle: "Trending: 10 new stars in one day",
    description: "Earned when GitHub repositories DevMacro already followed gain 10 or more new stars between them over one UTC day.",
    // A daily total rather than the rise in `github.stars.total`: adding a repository to the
    // installation raises the total without a single new star.
    rule: { kind: "daily_total_threshold", metricKey: starMetricNames.gainedDaily.metricKey, value: 10, sum: "single_day" },
  },
  {
    id: "github.stars.steady_glow",
    title: "Steady glow: new stars on 7 days in a row",
    publicTitle: "Steady glow: new stars on 7 days in a row",
    description: "Earned when DevMacro records new stars on a connected GitHub repository on each of 7 consecutive days.",
    rule: { kind: "consecutive_days", typeIds: ["github.stars.daily"], days: 7 },
  },
  {
    id: "github.stars.weekend",
    title: "Weekend stargazers: new stars on a Saturday and the Sunday after it",
    publicTitle: "Weekend stargazers: new stars on a Saturday and the Sunday after it",
    description: "Earned when DevMacro records new stars on a connected GitHub repository on a Saturday and on the Sunday after it.",
    // `github.stars.daily` is dated to the end of its UTC day (00:00 UTC the next day, always the
    // next London date), so Saturday's and Sunday's stars arrive as Sunday and Monday events and
    // the run starts on a Sunday.
    rule: { kind: "consecutive_days", typeIds: ["github.stars.daily"], days: 2, startWeekday: "sunday" },
  },
  {
    id: "github.forks.first",
    title: "First fork recorded",
    publicTitle: "First fork recorded",
    description: "Earned when DevMacro records the first new fork of a connected GitHub repository.",
    rule: { kind: "event_count", typeIds: ["github.forks.new"], count: 1 },
  },
  {
    id: "github.forks.10",
    title: "10 forks recorded",
    publicTitle: "10 forks recorded",
    description: "Earned when DevMacro records the 10th new fork of a connected GitHub repository.",
    rule: { kind: "event_count", typeIds: ["github.forks.new"], count: 10 },
  },
  {
    id: "github.forks.100",
    title: "100 forks recorded",
    publicTitle: "100 forks recorded",
    description: "Earned when DevMacro records the 100th new fork of a connected GitHub repository.",
    rule: { kind: "event_count", typeIds: ["github.forks.new"], count: 100 },
  },
  {
    id: "github.forks.party",
    title: "Fork party: 5 forks in one day",
    publicTitle: "Fork party: 5 forks in one day",
    description: "Earned when DevMacro records 5 new forks of the connected GitHub repositories on one London calendar day.",
    rule: { kind: "events_in_window", typeIds: ["github.forks.new"], count: 5, window: "day" },
  },
];

export const githubAdapter: ProviderAdapter = {
  id: "github",
  displayName: PROVIDER_NAMES.github,
  capabilities: {
    oauth: true,
    polling: true,
    webhooks: false,
    usage: true,
    spending: true,
    allowance: false,
    credits: false,
    revenue: false,
    events: true,
  },
  permissions: [
    {
      scope: appPermissions.metadata,
      access: "read",
      description:
        "Repository metadata: the repositories you choose, their star counts, and new forks. On private repositories it can also read collaborators and contributors; DevMacro does not.",
    },
    {
      scope: appPermissions.organizationAdministration,
      access: "read",
      description:
        "Organization administration: billing usage for Actions, Copilot, and other metered products. It can also read organization settings, runners, and Copilot seat assignments; DevMacro reads only billing. Needs an organization owner to install.",
    },
    {
      scope: appPermissions.plan,
      access: "read",
      description: "Account plan (personal accounts): your own billing usage. Held through a refresh token that lasts 6 months.",
    },
  ],
  dataCollected: [
    "Spend per product and SKU this month (Actions, larger runners, storage, Copilot)",
    "Usage per product this month, such as Actions minutes and Copilot credits",
    "Daily spend per product",
    "Star counts per repository, net new stars per day, and star milestones",
    "New forks per repository (counts only, never who forked)",
  ],
  eventTypes,
  achievements,
  dailyTotals: [starMetricNames.gainedDaily.metricKey],
  oauth: {
    authorizeUrl: OAUTH_AUTHORIZE_URL,
    tokenUrl: OAUTH_TOKEN_URL,
    scopes: [],
    pkce: true,
    clientIdEnv: "GITHUB_APP_CLIENT_ID",
    clientSecretEnv: "GITHUB_APP_CLIENT_SECRET",
    extraEnv: {
      appSlug: "GITHUB_APP_SLUG",
      appId: "GITHUB_APP_ID",
      privateKey: "GITHUB_APP_PRIVATE_KEY",
    },
  },
  pollIntervalSeconds: POLL_INTERVAL_SECONDS,

  /** Leg 1: the app install URL. The setup URL is fixed in the app registration, not sent here. */
  buildAuthorizeUrl({ client, state }) {
    const slug = requireExtra(client, "appSlug").reveal();
    const url = new URL(`https://github.com/apps/${encodeURIComponent(slug)}/installations/new`);
    url.searchParams.set("state", state);
    return url;
  },

  async exchangeCode(input: ExchangeCodeInput, ctx: OAuthContext): Promise<OAuthCredential> {
    if (input.codeVerifier === undefined) throw new TypeError("GitHub code exchange requires the PKCE code verifier");
    const installationId = input.callbackParams.installation_id;
    if (installationId === undefined || !/^\d+$/.test(installationId)) {
      throw new InvalidResponseError("GitHub callback did not carry a valid installation id");
    }

    const token = await requestToken(ctx, {
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    });
    const userToken = new Secret(token.access_token);

    // `installation_id` arrived on the query string and can be spoofed: it is trusted only if the
    // authorizing user can access that installation.
    const installation = await findUserInstallation(ctx, userToken, installationId);
    if (installation === undefined) {
      throw new PermissionMissingError("The GitHub installation does not belong to the authorizing user", []);
    }
    assertNotSuspended(installation);

    const scopes = Object.entries(installation.permissions)
      .map(([permission, level]) => `${permission}:${level}`)
      .sort();
    const metadata = {
      [metadataKeys.installationId]: String(installation.id),
      [metadataKeys.accountId]: String(installation.account.id),
      [metadataKeys.accountLogin]: installation.account.login,
      [metadataKeys.accountType]: installation.account.type,
    };

    if (installation.account.type === "Organization") {
      await revokeUserToken(ctx, userToken);
      // The contract requires an access token, but organizations sync with installation tokens
      // minted per run. The revoked verification token is kept only to satisfy the shape: it has
      // no refresh token and no expiry, so it is never refreshed or sent again.
      return { accessToken: userToken, scopes, tokenType: token.token_type, metadata };
    }

    return {
      accessToken: userToken,
      ...(token.refresh_token === undefined ? {} : { refreshToken: new Secret(token.refresh_token) }),
      ...(token.expires_in === undefined
        ? {}
        : { expiresAt: new Date(ctx.now().getTime() + token.expires_in * 1000) }),
      scopes,
      tokenType: token.token_type,
      metadata,
    };
  },

  /** Personal accounts only: refresh tokens rotate on every use, so the returned pair replaces the stored one. */
  async refreshTokens(credential: OAuthCredential, ctx: OAuthContext): Promise<OAuthCredential> {
    if (credential.refreshToken === undefined) {
      throw new AuthRevokedError("This GitHub connection has no refresh token; authorize GitHub again");
    }
    const token = await requestToken(ctx, {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken.reveal(),
    });
    return {
      accessToken: new Secret(token.access_token),
      ...(token.refresh_token === undefined ? {} : { refreshToken: new Secret(token.refresh_token) }),
      ...(token.expires_in === undefined
        ? {}
        : { expiresAt: new Date(ctx.now().getTime() + token.expires_in * 1000) }),
      scopes: credential.scopes,
      tokenType: token.token_type,
      ...(credential.metadata === undefined ? {} : { metadata: credential.metadata }),
    };
  },

  async listAccounts(credential, ctx) {
    const installation = await getInstallation(ctx, installationIdOf(credential));
    return [
      {
        externalId: String(installation.account.id),
        displayName: installation.account.login,
        kind: installation.account.type === "Organization" ? "organization" : "user",
      },
    ];
  },

  /**
   * Metadata read is always needed; billing needs Organization Administration read on an
   * organization or Account Plan read on a personal account, so either one satisfies it.
   */
  detectMissingPermissions(grant: OAuthGrant): string[] {
    const granted = new Set(grant.scopes.map((scope) => scope.replace(/:write$/, ":read")));
    const missing: string[] = [];
    if (!granted.has(appPermissions.metadata)) missing.push(appPermissions.metadata);
    if (!granted.has(appPermissions.organizationAdministration) && !granted.has(appPermissions.plan)) {
      missing.push(appPermissions.organizationAdministration, appPermissions.plan);
    }
    return missing;
  },

  async sync(input: SyncInput, ctx: OAuthContext): Promise<SyncResult> {
    const installationId = installationIdOf(input.credential);
    // Read every run: the login can be renamed, and a suspended install fails here as revoked.
    const installation = await getInstallation(ctx, installationId);
    const installationToken = await mintInstallationToken(ctx, installationId, installation.account.type);

    const repositories = await collectRepositories(
      ctx,
      installationToken,
      input.externalAccountId,
      parseCursor(input.cursor, ctx),
    );
    const billing = await collectBilling(ctx, {
      accountType: installation.account.type,
      login: installation.account.login,
      // Personal billing endpoints accept only user tokens; installation tokens do not work there.
      token: installation.account.type === "Organization" ? installationToken : input.credential.accessToken,
      externalAccountId: input.externalAccountId,
    });

    const metrics: AdapterMetric[] = [...billing.metrics, ...repositories.metrics];
    const events: ActivityEvent[] = repositories.events;
    const cursor: Cursor = { v: 1, repos: repositories.repos };
    return {
      metrics,
      events,
      cursor: JSON.stringify(cursor),
      ...(billing.partialErrors.length === 0 ? {} : { partialErrors: billing.partialErrors }),
    };
  },
};
