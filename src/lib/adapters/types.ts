import { z } from "zod";
import type { Logger } from "@/lib/log/logger";
import type { Achievement } from "./achievements";
import type { PermissionMissingError } from "./errors";
import type { ActivityEvent, EventType } from "./events";
import type { AdapterMetric } from "./metrics";

/**
 * Provider adapter contract (adapter pattern per provider API, strategy
 * pattern for the sync runner: it holds a `ProviderAdapter` and never branches
 * on provider id).
 */

export const liveProviderIds = ["vercel", "github", "resend", "stripe", "supabase", "digitalocean", "posthog", "polar", "sentry", "railway", "gitlab"] as const;

/**
 * `fake` is an in-memory adapter for unit tests and Playwright e2e: it lets the
 * connect and sync pipeline run end to end without a real OAuth app, network
 * access, or provider secrets in CI. It is never registered in production, so
 * anything user-facing iterates `liveProviderIds`.
 */
export const providerIds = [...liveProviderIds, "fake"] as const;

export const ProviderIdSchema = z.enum(providerIds);
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export type LiveProviderId = (typeof liveProviderIds)[number];

/**
 * Stable, dotted, lowercase key owned by one adapter, for metric keys and
 * event type ids (`resend.emails.monthly`, `vercel.deployment.failed`).
 * Stored in the database, so renaming one is a migration.
 */
export const AdapterScopedKeySchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/, "must be a lowercase dotted key like provider.thing");

const REDACTED = "[redacted]";
const inspectCustom: unique symbol = Symbol.for("nodejs.util.inspect.custom");

/**
 * Wrapper for a token or client secret.
 *
 * Chosen over a credential object with a redacting `toJSON`: that guards only
 * JSON.stringify, while spreads, `Object.entries`, `util.inspect`, string
 * interpolation, and `structuredClone` would still copy the raw string. The
 * value lives in an ES private field, so all of those see `[redacted]` or
 * nothing, and the private field makes the class nominal (a plain string or
 * look-alike object cannot be passed where a `Secret` is expected).
 * Every real use goes through `reveal()`, which keeps each one greppable.
 */
export class Secret {
  readonly #value: string;

  constructor(value: string) {
    if (value.length === 0) throw new TypeError("Secret value must not be empty");
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [inspectCustom](): string {
    return REDACTED;
  }
}

export type OAuthCredential = Readonly<{
  accessToken: Secret;
  // Absent when the provider issues tokens that do not expire.
  refreshToken?: Secret;
  expiresAt?: Date;
  scopes: readonly string[];
  tokenType: string;
  // Non-secret identifiers the provider returns with the grant and the adapter needs later
  // (Vercel team and configuration ids, GitHub installation id, Stripe account id).
  metadata?: Readonly<Record<string, string>>;
}>;

/** What the provider granted, for comparing against what the adapter requests. */
export type OAuthGrant = Pick<OAuthCredential, "scopes">;

export type OAuthClient = Readonly<{
  clientId: string;
  clientSecret: Secret;
  // Provider-specific app settings beyond the id and secret (GitHub App id and private key,
  // Vercel integration slug), keyed by the names in `OAuthDescriptor.extraEnv`.
  extra: Readonly<Record<string, Secret>>;
}>;

export type OAuthDescriptor = Readonly<{
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  scopes: readonly string[];
  pkce: boolean;
  // Names of the environment variables, never their values.
  clientIdEnv: string;
  clientSecretEnv: string;
  // Extra settings: key used in `OAuthClient.extra` mapped to its environment variable name.
  extraEnv?: Readonly<Record<string, string>>;
  // Keys of `extraEnv` an instance may leave unset (Stripe's test mode key). Every other extra is
  // required for the provider to count as set up on this instance.
  optionalExtraKeys?: readonly string[];
}>;

/**
 * MVP rules are encoded as literal types so an adapter cannot claim otherwise
 * by accident: OAuth is the only connection path, polling is the only sync
 * path, and webhooks are Post-MVP.
 */
export type AdapterCapabilities = Readonly<{
  oauth: true;
  polling: true;
  webhooks: false;
  usage: boolean;
  spending: boolean;
  allowance: boolean;
  credits: boolean;
  revenue: boolean;
  events: boolean;
}>;

/**
 * Shown on the connect screen before the user grants access. A `full` scope
 * must say why it is needed, because the screen labels it "Full access" and
 * the user deserves the reason next to that label.
 */
export type Permission = Readonly<
  { scope: string; description: string } & (
    | { access: "read" }
    | { access: "full"; fullAccessReason: string }
  )
>;

/** An account, organization, team, or project the grant can read. */
export type ExternalAccount = Readonly<{
  externalId: string;
  displayName: string;
  // Provider vocabulary for the account: `team`, `organization`, `user`, `account`, `project`.
  kind: string;
}>;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Everything an adapter may touch besides its inputs, injected so tests run on
 * fixtures with a fake fetch and a fixed clock. It deliberately holds no
 * credential store: an adapter only ever sees the one credential it is handed.
 */
export type AdapterContext = Readonly<{
  fetch: FetchLike;
  now: () => Date;
  timeoutMs: number;
  // Structured fields only; credentials are `Secret`s, so a stray field logs as [redacted].
  logger: Logger;
}>;

export type OAuthContext = AdapterContext & Readonly<{ client: OAuthClient }>;

export type AuthorizeUrlParams = Readonly<{
  client: OAuthClient;
  state: string;
  redirectUri: string;
  // S256 challenge. Required when `oauth.pkce` is true.
  codeChallenge?: string;
}>;

export type ExchangeCodeInput = Readonly<{
  code: string;
  redirectUri: string;
  // Required when `oauth.pkce` is true.
  codeVerifier?: string;
  // Every query parameter the provider sent to the callback, for provider-specific values such
  // as GitHub's `installation_id` or Vercel's `configurationId`. Untrusted: adapters verify them.
  callbackParams: Readonly<Record<string, string>>;
}>;

/** One decrypted credential for one connection and one external account. */
export type SyncInput = Readonly<{
  credential: OAuthCredential;
  externalAccountId: string;
  // Opaque value from the previous sync's result. Absent on the first sync.
  cursor?: string;
}>;

export type SyncResult = {
  metrics: AdapterMetric[];
  events: ActivityEvent[];
  cursor?: string;
  // Parts of the sync the grant could not reach while the rest succeeded (for example Vercel
  // billing on a Hobby team). The sync runner records them on the connection as missing
  // scopes so the user sees what is unavailable and why, instead of failing the whole sync.
  partialErrors?: PermissionMissingError[];
};

/**
 * `Id` is a registered `ProviderId` everywhere the app reads an adapter. It is wider only for an
 * adapter `liveProviderIds` does not name yet: the example adapter (`example/index.ts`) and a copy
 * of it run the contract harness (`harness.ts`) under their own id before any shared file changes
 * (docs/adapters.md). Registering the id makes `ProviderAdapter<"acme">` a `ProviderAdapter`.
 */
export interface ProviderAdapter<Id extends string = ProviderId> {
  readonly id: Id;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;
  readonly permissions: readonly Permission[];
  // Plain-language list for the connect screen, e.g. "Emails sent per day".
  readonly dataCollected: readonly string[];
  readonly eventTypes: readonly EventType[];
  // Achievements this provider's data can prove, evaluated per project (#413). Before adding or
  // changing one, read the achievements of adapters of the same kind (deployment hosts: Vercel,
  // Railway, DigitalOcean, GitLab, Render; payments: Stripe, Polar; signups: Supabase, PostHog)
  // and keep the ids, thresholds, and wording parallel, so a member sees the same ladder
  // whichever provider they use. docs/adapters.md, "Achievements", has the rules.
  readonly achievements?: readonly Achievement[];
  // Usage metric keys whose reading is the signups of one whole UTC day (its timeframe is that
  // day), for a provider that reports a daily total rather than one event per signup. The
  // dashboard headline (#173) sums these readings as the provider's signups. Omitted when none.
  readonly signupDailyTotals?: readonly string[];
  // Usage metric keys whose reading is the total of one whole UTC day (its timeframe is that day)
  // and which are not signups, such as GitHub's new stars per day. `daily_total_threshold`
  // achievement rules read a key from `dailyTotals` or `signupDailyTotals`. Omitted when none.
  readonly dailyTotals?: readonly string[];
  // Estimated spend metric keys whose reading is a projection for the whole billing period (what
  // the period is expected to cost), not money spent so far. Every reading of spend (dashboard,
  // headline, digests, alerts, anomaly detection, projections, daily summary) leaves them out,
  // whatever their period looks like on the day they are read (`isDeclaredProjection`, #223).
  // Omitted when none.
  readonly projectedSpend?: readonly string[];
  // Set while the adapter is in beta: the connections catalog shows a "Beta" badge on its card with
  // this reason beside it (#242), so a member knows before connecting. The reason is one sentence in
  // plain language, read by members: no internal ids or standards numbers. Omitted when not in beta.
  readonly beta?: Readonly<{ reason: string }>;
  readonly oauth: OAuthDescriptor;
  // Decided on #37: each adapter declares how often it polls, hourly unless its provider's
  // limits or retention need otherwise. Must be at least 60.
  readonly pollIntervalSeconds: number;

  buildAuthorizeUrl(params: AuthorizeUrlParams): URL;
  exchangeCode(input: ExchangeCodeInput, ctx: OAuthContext): Promise<OAuthCredential>;
  // Omitted when the provider's tokens do not expire.
  refreshTokens?(credential: OAuthCredential, ctx: OAuthContext): Promise<OAuthCredential>;
  // Omitted when the provider has no revocation endpoint.
  revoke?(credential: OAuthCredential, ctx: OAuthContext): Promise<void>;
  listAccounts(credential: OAuthCredential, ctx: OAuthContext): Promise<ExternalAccount[]>;
  /** Requested scopes absent from the grant. Empty means nothing is missing. */
  detectMissingPermissions(grant: OAuthGrant): string[];
  sync(input: SyncInput, ctx: OAuthContext): Promise<SyncResult>;
}

export type ValidationIssue = Readonly<{
  index: number;
  path: string;
  message: string;
}>;

export type BatchValidation<T> = { ok: true; items: T[] } | { ok: false; issues: ValidationIssue[] };

export function issuesFromZod(index: number, error: z.ZodError): ValidationIssue[] {
  return error.issues.map((issue) => ({
    index,
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
}
