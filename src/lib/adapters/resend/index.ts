import { createHmac } from "node:crypto";

import { z } from "zod";
import { PROVIDER_NAMES } from "@/lib/providers";
import { isFresh, readDeliveryId, safeEqual } from "@/lib/webhooks/signature";
import type { Achievement } from "../achievements";
import {
  AuthRevokedError,
  fetchJson,
  InvalidResponseError,
  PermissionMissingError,
  readOAuthErrorCode,
} from "../errors";
import type { ActivityEvent, EventType } from "../events";
import type { AdapterMetric } from "../metrics";
import {
  Secret,
  type AdapterContext,
  type CreateWebhookInput,
  type ExternalAccount,
  type FetchLike,
  type OAuthContext,
  type OAuthCredential,
  type ProviderAdapter,
  type RemoveWebhookInput,
  type SyncInput,
  type SyncResult,
  type WebhookOutcome,
  type WebhookRequest,
  type WebhookVerification,
} from "../types";
import {
  CreateWebhookResponseSchema,
  DeleteWebhookResponseSchema,
  DomainListResponseSchema,
  domainStatuses,
  DomainStatusSchema,
  DomainUpdatedDeliverySchema,
  EmailMetricsResponseSchema,
  RESEND_ISSUER,
  TokenResponseSchema,
  UsageResponseSchema,
  WebhookTypeSchema,
  type Domain,
  type DomainStatus,
  type TokenResponse,
} from "./schemas";

/**
 * Resend adapter (docs/providers/resend.md, issue #46).
 *
 * OAuth 2.1 authorization code flow with PKCE (S256) as a pre-registered confidential client
 * (client_secret_basic). Sync reads three GET routes only: `/usage` for quota usage and limits,
 * `/emails/metrics` for delivery counts, and `/domains` for verification status changes.
 *
 * Webhooks (#427): one per connection, on the connection's own URL, set up by hand or, when the
 * user chooses, created with `POST /webhooks` and deleted with `DELETE /webhooks/:id` using the
 * `full_access` grant the connection already holds. Resend generates the signing secret either
 * way. Deliveries are signed with Svix over the delivery id, the timestamp, and the raw body, so a
 * captured delivery replayed under a new id fails the signature, and one replayed under its own id
 * is a duplicate. `domain.updated` maps to the same events and dedupe keys the sync's domain
 * polling produces, so a change seen both ways is stored once.
 */

const API_BASE = "https://api.resend.com";
const AUTHORIZE_URL = `${API_BASE}/oauth/authorize`;
const TOKEN_URL = `${API_BASE}/oauth/token`;
const REVOKE_URL = `${API_BASE}/oauth/revoke`;

// Resend blocks requests without a User-Agent with 403 (error 1010) before they reach the API.
export const RESEND_USER_AGENT = "StackDash";

const FULL_ACCESS = "full_access";
const REQUESTED_SCOPES = [FULL_ACCESS] as const;

const STATE_MAX_LENGTH = 1024;
const CODE_VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

// 100 domains per page, 10 pages per sync: 1,000 domains, the Scale plan's domain allowance.
const DOMAIN_PAGE_SIZE = 100;
export const MAX_DOMAIN_PAGES = 10;
const DELIVERY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DOMAIN_TITLE_NAME_MAX = 150;

// No endpoint names or identifies the team a grant covers (docs/providers/resend.md, Limitations),
// and one grant is exactly one team. External accounts are unique per connection, so a fixed id
// is stable across token refreshes and re-polls without inventing an identifier.
// The access token JWT may carry a team id, but its claims are undocumented and not relied on
// (docs/providers/resend.md, Unverified 10).
export const RESEND_TEAM_EXTERNAL_ID = "team";

// The adapter's HTTP surface is restricted to these reads (docs/providers/resend.md, Permission risks):
// `full_access` could do far more, and these types keep the code promise checkable. The only writes
// are automatic webhook setup's create and delete, made only when the user chooses it.
type ReadPath = "/usage" | "/emails/metrics" | "/domains";
type WebhookPath = "/webhooks" | `/webhooks/${string}`;
type ApiPath = ReadPath | WebhookPath;

// Exported, like `usageMetrics` and `deliveryMetrics` below, for the local simulator (#131).
export const eventTypes = [
  {
    id: "resend.domain.verified",
    label: "Domain verified",
    description: "A sending domain passed Resend's DNS verification.",
    shownByDefault: true,
    emoji: "✅",
  },
  {
    id: "resend.domain.failed",
    label: "Domain verification failed",
    description: "Resend could not find a domain's DNS records within 72 hours, so it cannot send.",
    shownByDefault: true,
    emoji: "❌",
  },
] as const satisfies readonly EventType[];

// Achievements (#413), evaluated per project from stored events (docs/adapters.md, "Achievements").
const achievements: readonly Achievement[] = [
  {
    id: "resend.domains.first",
    title: "First Resend domain verified",
    publicTitle: "First Resend domain verified",
    description: "Earned when StackDash records the first verified Resend domain.",
    rule: { kind: "event_count", typeIds: ["resend.domain.verified"], count: 1 },
  },
  {
    id: "resend.domains.collector",
    title: "Domain collector: 3 domains verified",
    publicTitle: "Domain collector: 3 domains verified",
    description: "Earned when StackDash records the 3rd verified Resend domain.",
    rule: { kind: "event_count", typeIds: ["resend.domain.verified"], count: 3 },
  },
];

// Domain statuses that produce an event when a domain moves into them. Threshold alerts such as
// quota near its limit are StackDash's job, not adapter events.
const statusEvents: Partial<Record<DomainStatus, (typeof eventTypes)[number]["id"]>> = {
  verified: "resend.domain.verified",
  failed: "resend.domain.failed",
};

// Cursor: last seen status per domain id, as compact JSON with one or two letter status codes.
const statusCodeValues = ["n", "p", "v", "pv", "pf", "f", "t"] as const;
type StatusCode = (typeof statusCodeValues)[number];

const statusCodes = {
  not_started: "n",
  pending: "p",
  verified: "v",
  partially_verified: "pv",
  partially_failed: "pf",
  failed: "f",
  temporary_failure: "t",
} as const satisfies Record<DomainStatus, StatusCode>;

const statusByCode = new Map<StatusCode, DomainStatus>(
  domainStatuses.map((status) => [statusCodes[status], status] as const),
);

const CursorSchema = z.object({
  v: z.literal(1),
  s: z.record(z.string().min(1), z.enum(statusCodeValues)),
});

type DomainStatuses = Map<string, DomainStatus>;

function encodeCursor(statuses: DomainStatuses): string {
  const sorted = [...statuses.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const s: Record<string, StatusCode> = {};
  for (const [id, status] of sorted) s[id] = statusCodes[status];
  return JSON.stringify({ v: 1, s });
}

function decodeCursor(cursor: string | undefined, ctx: OAuthContext): DomainStatuses | undefined {
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
    // Our own value came back unreadable: re-baseline (no events this sync) rather than fail every
    // future sync on it.
    ctx.logger.warn("resend.sync.cursor_unreadable", { provider: "resend" });
    return undefined;
  }
  const statuses: DomainStatuses = new Map();
  for (const [id, code] of Object.entries(parsed.data.s)) {
    const status = statusByCode.get(code);
    if (status !== undefined) statuses.set(id, status);
  }
  return statuses;
}

function formEncode(value: string): string {
  return new URLSearchParams({ v: value }).toString().slice(2);
}

// RFC 6749 section 2.3.1: id and secret are form-encoded before Basic encoding. Never logged.
function basicAuthorization(ctx: OAuthContext): string {
  const { clientId, clientSecret } = ctx.client;
  return `Basic ${btoa(`${formEncode(clientId)}:${formEncode(clientSecret.reveal())}`)}`;
}

function oauthHeaders(ctx: OAuthContext): Record<string, string> {
  return {
    Authorization: basicAuthorization(ctx),
    "Content-Type": "application/x-www-form-urlencoded",
    Accept: "application/json",
    "User-Agent": RESEND_USER_AGENT,
  };
}

/**
 * Token endpoint call. `invalid_grant` (400) means the code or grant is gone: revoked by the user,
 * refresh token reuse detected, or expired. That is reported as auth revoked so the connection asks
 * to reconnect and is never retried; `fetchJson` alone would call it an invalid response.
 */
async function requestTokens(ctx: OAuthContext, form: Record<string, string>): Promise<TokenResponse> {
  let oauthError: string | undefined;
  const capturingFetch: FetchLike = async (input, init) => {
    const response = await ctx.fetch(input, init);
    if (response.status === 400) oauthError = await readOAuthErrorCode(response.clone());
    return response;
  };
  try {
    return await fetchJson(
      { ...ctx, fetch: capturingFetch },
      TOKEN_URL,
      { method: "POST", headers: oauthHeaders(ctx), body: new URLSearchParams(form).toString() },
      TokenResponseSchema,
    );
  } catch (error) {
    if (error instanceof InvalidResponseError && error.status === 400 && oauthError === "invalid_grant") {
      throw new AuthRevokedError("Resend rejected the authorization grant (invalid_grant)", {
        cause: error,
        status: 400,
        ...(error.endpoint === undefined ? {} : { endpoint: error.endpoint }),
      });
    }
    throw error;
  }
}

function parseScopes(scope: string | undefined, fallback: readonly string[]): readonly string[] {
  // RFC 6749 section 5.1: an omitted scope means the requested (or previously granted) scope.
  if (scope === undefined) return fallback;
  return scope.split(" ").filter((value) => value.length > 0);
}

function toCredential(tokens: TokenResponse, ctx: OAuthContext, fallbackScopes: readonly string[]): OAuthCredential {
  return {
    accessToken: new Secret(tokens.access_token),
    refreshToken: new Secret(tokens.refresh_token),
    // 900 seconds (15 minutes) per the docs; taken from the response, never assumed.
    expiresAt: new Date(ctx.now().getTime() + tokens.expires_in * 1000),
    scopes: parseScopes(tokens.scope, fallbackScopes),
    tokenType: tokens.token_type,
  };
}

function bearerHeaders(credential: OAuthCredential): Record<string, string> {
  return {
    Authorization: `Bearer ${credential.accessToken.reveal()}`,
    Accept: "application/json",
    "User-Agent": RESEND_USER_AGENT,
  };
}

function apiGet<T>(
  ctx: OAuthContext,
  credential: OAuthCredential,
  path: ReadPath,
  query: Readonly<Record<string, string>>,
  schema: z.ZodType<T>,
): Promise<T> {
  const url = new URL(path, API_BASE);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return fetchJson(ctx, url, { method: "GET", headers: bearerHeaders(credential) }, schema);
}

function endpointOf(path: ApiPath): string {
  return `${API_BASE}${path}`;
}

type DomainListing = { domains: Domain[]; complete: boolean };

async function listDomains(
  ctx: OAuthContext,
  credential: OAuthCredential,
  maxPages: number,
): Promise<DomainListing> {
  const domains: Domain[] = [];
  let after: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const query: Record<string, string> = { limit: String(DOMAIN_PAGE_SIZE) };
    if (after !== undefined) query.after = after;
    const response = await apiGet(ctx, credential, "/domains", query, DomainListResponseSchema);
    domains.push(...response.data);
    const last = response.data.at(-1);
    if (!response.has_more) return { domains, complete: true };
    // has_more with an empty page cannot advance; stop instead of looping.
    if (last === undefined) return { domains, complete: false };
    after = last.id;
  }
  return { domains, complete: false };
}

export function usageMetrics(
  usage: z.infer<typeof UsageResponseSchema>,
  externalAccountId: string,
  retrievedAt: Date,
): AdapterMetric[] {
  const provenance = { source: "provider_api", endpoint: endpointOf("/usage") } as const;
  const windows = [
    { key: "daily", window: usage.emails.daily, noun: "daily" },
    { key: "monthly", window: usage.emails.monthly, noun: "monthly" },
  ] as const;
  const metrics: AdapterMetric[] = [];
  for (const { key, window, noun } of windows) {
    // The daily window may be rolling or a UTC day (docs/providers/resend.md, Unverified 2 and 3):
    // its start is not computed, so these are point readings with the reset time as returned.
    const base = {
      externalAccountId,
      retrievedAt,
      timeframe: { type: "point", at: retrievedAt },
      provenance,
      resetsAt: window.resets_at,
      unit: "emails",
    } as const;
    metrics.push({
      ...base,
      kind: "usage",
      metricKey: `resend.emails.${key}.used`,
      label: `Emails used against the ${noun} quota`,
      value: window.used,
    });
    // A null limit means no cap: no allowance metrics rather than a fake 0 or infinity.
    if (window.limit !== null) {
      metrics.push(
        {
          ...base,
          kind: "included_allowance",
          metricKey: `resend.emails.${key}.limit`,
          label: `${noun === "daily" ? "Daily" : "Monthly"} email quota`,
          value: window.limit,
        },
        {
          ...base,
          kind: "remaining_allowance",
          metricKey: `resend.emails.${key}.remaining`,
          label: `Emails remaining in the ${noun} quota`,
          // Paid plans can run past the quota (overage); remaining never goes below zero.
          value: Math.max(0, window.limit - window.used),
        },
      );
    }
  }
  return metrics;
}

export function deliveryMetrics(
  response: z.infer<typeof EmailMetricsResponseSchema>,
  externalAccountId: string,
  retrievedAt: Date,
): AdapterMetric[] {
  const base = {
    kind: "usage",
    externalAccountId,
    retrievedAt,
    // Resend clamps the window to its 30 day retention, so the returned range is the truth.
    timeframe: { type: "period", start: response.start_date, end: response.end_date },
    provenance: { source: "provider_api", endpoint: endpointOf("/emails/metrics") },
    unit: "emails",
  } as const;
  return [
    { ...base, metricKey: "resend.delivery.delivered", label: "Emails delivered", value: response.totals.delivered },
    { ...base, metricKey: "resend.delivery.bounced", label: "Emails bounced", value: response.totals.bounced },
    { ...base, metricKey: "resend.delivery.complained", label: "Spam complaints", value: response.totals.complained },
  ];
}

/**
 * The timeline event for a domain now in `domain.status`, or undefined when that status is not on
 * the timeline. Shared by the sync's polling and the `domain.updated` webhook, so one change seen
 * both ways has one type, title, and dedupe key and is stored once.
 */
function domainStatusEvent(
  domain: Pick<Domain, "id" | "name" | "status">,
  externalAccountId: string,
  occurredAt: Date,
): ActivityEvent | undefined {
  const typeId = statusEvents[domain.status];
  if (typeId === undefined) return undefined;
  const name =
    domain.name.length > DOMAIN_TITLE_NAME_MAX ? `${domain.name.slice(0, DOMAIN_TITLE_NAME_MAX)}…` : domain.name;
  const verified = typeId === "resend.domain.verified";
  return {
    typeId,
    occurredAt,
    severity: verified ? "success" : "critical",
    title: verified ? `Domain ${name} verified` : `Domain ${name} failed verification`,
    ...(verified
      ? {}
      : { body: "Resend could not find the domain's DNS records within 72 hours. Check its DNS settings in Resend." }),
    externalAccountId,
    dedupeKey: `resend.domain:${domain.id}:${domain.status}`,
  };
}

function domainEvents(
  domains: readonly Domain[],
  previous: DomainStatuses | undefined,
  externalAccountId: string,
  detectedAt: Date,
): ActivityEvent[] {
  // First sync has no earlier snapshot: it records a baseline instead of replaying every domain's
  // current status as if it had just changed.
  if (previous === undefined) return [];
  const events: ActivityEvent[] = [];
  for (const domain of domains) {
    if (previous.get(domain.id) === domain.status) continue;
    // Resend does not say when the status changed, so the event is dated when the sync saw it.
    const event = domainStatusEvent(domain, externalAccountId, detectedAt);
    if (event !== undefined) events.push(event);
  }
  return events;
}

function permissionGap(error: unknown, what: string): PermissionMissingError | undefined {
  if (!(error instanceof PermissionMissingError)) return undefined;
  return new PermissionMissingError(`Resend refused ${what}; the grant needs ${FULL_ACCESS}`, [FULL_ACCESS], {
    cause: error,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.endpoint === undefined ? {} : { endpoint: error.endpoint }),
  });
}

/* Webhook -------------------------------------------------------------------------------------- */

// Svix's headers, as Resend's "Verify webhook requests" guide passes them to its SDK.
export const RESEND_WEBHOOK_HEADERS = {
  delivery: "svix-id",
  timestamp: "svix-timestamp",
  signature: "svix-signature",
} as const;
// Five minutes either side of now: the tolerance of the `standardwebhooks` library Resend's SDK
// verifies with, and of Svix's own libraries. Svix signs every retry attempt with its own
// timestamp, so a retry later in Resend's 28 hour schedule is never stale.
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;
const SIGNING_SECRET_PREFIX = "whsec_";
const SIGNATURE_VERSION = "v1,";
// Svix generates 24 random bytes. A pasted secret that decodes to fewer than 16 is not one Resend
// made, and a key that short could be guessed, so it verifies nothing.
const MIN_SIGNING_KEY_BYTES = 16;
// Whole seconds since the epoch; twelve digits reach far past any real clock.
const TIMESTAMP_SECONDS = /^\d{1,12}$/;

// `domain.updated` only: it carries the domain verification changes the timeline already shows.
// Email events (`email.bounced`, `email.complained`, `email.failed`) carry recipients and subjects
// and have no event type here; bounce and complaint counts come from `/emails/metrics` instead.
const WEBHOOK_SUBSCRIPTIONS = ["domain.updated"] as const;

/** The HMAC key a Svix signing secret encodes (base64 after `whsec_`), or null when it is too short. */
function signingKey(secret: Secret): Buffer | null {
  const value = secret.reveal().trim();
  const key = Buffer.from(value.startsWith(SIGNING_SECRET_PREFIX) ? value.slice(SIGNING_SECRET_PREFIX.length) : value, "base64");
  return key.length >= MIN_SIGNING_KEY_BYTES ? key : null;
}

function svixSignature(key: Buffer, deliveryId: string, timestamp: string, rawBody: Uint8Array): string {
  // Signed as bytes, never decoded first: decoding would map invalid UTF-8 onto U+FFFD and let two
  // different bodies share one signature.
  const signed = Buffer.concat([Buffer.from(`${deliveryId}.${timestamp}.`, "utf8"), rawBody]);
  return `${SIGNATURE_VERSION}${createHmac("sha256", key).update(signed).digest("base64")}`;
}

/**
 * The `svix-signature` value Resend sends for a delivery: `v1,` and the base64 HMAC-SHA256 of
 * `<svix-id>.<svix-timestamp>.<raw body>` under the secret's decoded key. For tests and e2e runs.
 */
export function resendWebhookSignature(secret: Secret, deliveryId: string, timestamp: string, rawBody: Uint8Array): string {
  const key = signingKey(secret);
  if (key === null) throw new RangeError("A Resend signing secret decodes to at least 16 bytes");
  return svixSignature(key, deliveryId, timestamp, rawBody);
}

/**
 * Svix verification: headers, then freshness, then the delivery id (the signature covers it, so a
 * missing one is malformed), then the signature in constant time against each `v1` entry. Svix
 * sends several space-separated entries while a secret rotates; one match is enough.
 */
function verifyWebhook({ headers, rawBody }: WebhookRequest, secret: Secret, now: Date): WebhookVerification {
  const timestamp = headers.get(RESEND_WEBHOOK_HEADERS.timestamp)?.trim();
  const signatures = headers.get(RESEND_WEBHOOK_HEADERS.signature)?.trim();
  if (!timestamp || !signatures) return { ok: false, reason: "missing_signature" };
  if (!TIMESTAMP_SECONDS.test(timestamp)) return { ok: false, reason: "malformed" };
  if (!isFresh(Number(timestamp), now, RESEND_WEBHOOK_TOLERANCE_SECONDS)) return { ok: false, reason: "stale" };
  const deliveryId = readDeliveryId(headers, RESEND_WEBHOOK_HEADERS.delivery);
  if (deliveryId === undefined) return { ok: false, reason: "malformed" };
  const key = signingKey(secret);
  if (key === null) return { ok: false, reason: "bad_signature" };
  const expected = svixSignature(key, deliveryId, timestamp, rawBody);
  const matched = signatures.split(/\s+/).some((candidate) => safeEqual(candidate, expected));
  return matched ? { ok: true, deliveryId } : { ok: false, reason: "bad_signature" };
}

/**
 * Maps a verified `domain.updated` through the sync's own builder, dated to when Resend created the
 * event. A status the timeline does not show (pending, partially verified) is ignored, as the sync
 * ignores it. Reads the domain's id, name, and status only.
 */
function parseWebhook({ rawBody }: WebhookRequest, ctx: AdapterContext): WebhookOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(rawBody));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { kind: "ignored", reason: "body is not JSON" };
  }
  const typed = WebhookTypeSchema.safeParse(raw);
  if (!typed.success) return { kind: "ignored", reason: "not a Resend webhook delivery" };
  if (typed.data.type !== "domain.updated") return { kind: "ignored", reason: "event type is not on the timeline" };
  const parsed = DomainUpdatedDeliverySchema.safeParse(raw);
  if (!parsed.success) {
    // The one subscribed event, in a shape StackDash cannot read: Resend changed the payload, and
    // every such delivery is acknowledged and dropped, so say so. Names the type only.
    ctx.logger.warn("resend.webhook.unreadable", { type: typed.data.type });
    return { kind: "ignored", reason: "not a delivery Resend maps" };
  }
  const { data, created_at: createdAt } = parsed.data;
  const status = DomainStatusSchema.safeParse(data.status);
  const event = status.success
    ? domainStatusEvent({ id: data.id, name: data.name, status: status.data }, RESEND_TEAM_EXTERNAL_ID, createdAt)
    : undefined;
  if (event === undefined) return { kind: "ignored", reason: "domain status is not on the timeline" };
  return { kind: "events", externalAccountId: RESEND_TEAM_EXTERNAL_ID, events: [event] };
}

/** `POST /webhooks`: the response carries the new webhook's signing secret (API reference, Create Webhook). */
async function createWebhook({ credential, url }: CreateWebhookInput, ctx: OAuthContext): Promise<Readonly<{ webhookId: string; secret: Secret }>> {
  const path: WebhookPath = "/webhooks";
  const created = await fetchJson(
    ctx,
    new URL(path, API_BASE),
    {
      method: "POST",
      headers: { ...bearerHeaders(credential), "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: url, events: WEBHOOK_SUBSCRIPTIONS }),
    },
    CreateWebhookResponseSchema,
  );
  return { webhookId: created.id, secret: new Secret(created.signing_secret) };
}

/** `DELETE /webhooks/:id`. A webhook already gone (the user deleted it in Resend) is removed. */
async function removeWebhook({ credential, webhookId }: RemoveWebhookInput, ctx: OAuthContext): Promise<void> {
  const path: WebhookPath = `/webhooks/${encodeURIComponent(webhookId)}`;
  try {
    await fetchJson(ctx, new URL(path, API_BASE), { method: "DELETE", headers: bearerHeaders(credential) }, DeleteWebhookResponseSchema);
  } catch (error) {
    if (error instanceof InvalidResponseError && error.status === 404) {
      ctx.logger.info("resend.webhook.already_removed", { provider: "resend" });
      return;
    }
    throw error;
  }
}

export const resendAdapter: ProviderAdapter = {
  id: "resend",
  displayName: PROVIDER_NAMES.resend,
  capabilities: {
    oauth: true,
    polling: true,
    usage: true,
    // Resend has no billing API: no spend, invoices, or overage cost (docs/providers/resend.md).
    spending: false,
    allowance: true,
    credits: false,
    revenue: false,
    events: true,
  },
  permissions: [
    {
      scope: FULL_ACCESS,
      access: "full",
      description: "Read your Resend team's email usage, delivery metrics, and domain status.",
      fullAccessReason:
        "Resend has no read-only access. This permission lets StackDash send and delete email, change or delete domains, and create and delete API keys in this Resend team. StackDash only reads usage, delivery metrics, and domain status, and adds or deletes its own webhook only if you choose automatic webhook setup. You can revoke access at any time in your Resend team settings.",
    },
  ],
  dataCollected: [
    "Emails used against the daily and monthly quota",
    "Daily and monthly email quotas and when they reset",
    "Emails delivered, bounced, and marked as spam over the last 7 days",
    "Domain names and their verification status",
  ],
  eventTypes,
  achievements,
  // In beta until #241 settles whether a live Resend callback carries `iss`: once #228 lands,
  // `exchangeCode` refuses a callback without it, which would fail every Resend connection. Remove
  // this declaration to drop the catalog's "Beta" badge.
  beta: { reason: "StackDash is still checking how Resend returns you here after you approve access, so connecting may fail." },
  oauth: {
    authorizeUrl: AUTHORIZE_URL,
    tokenUrl: TOKEN_URL,
    revokeUrl: REVOKE_URL,
    scopes: REQUESTED_SCOPES,
    pkce: true,
    clientIdEnv: "RESEND_CLIENT_ID",
    clientSecretEnv: "RESEND_CLIENT_SECRET",
  },
  // Hourly: /emails/metrics is cached up to 15 minutes and the team's 10 req/s budget is shared.
  pollIntervalSeconds: 3600,
  // Per connection (#424, #427): a Resend webhook belongs to one team, and Resend generates its
  // signing secret. Automatic setup needs no access beyond the `full_access` already granted.
  webhooks: {
    registration: {
      kind: "connection",
      setup: {
        secretSource: "provider",
        manualSteps: [
          "In Resend, open Webhooks and choose Add Webhook.",
          "Paste the address below as the endpoint URL, select only the domain.updated event, and add the webhook.",
          "Open the new webhook, copy its signing secret, and paste it into the field below.",
        ],
        removalSteps: ["In Resend, open Webhooks, open the webhook whose endpoint is StackDash's address, and delete it."],
        automatic: { extraPermissions: [], create: createWebhook, remove: removeWebhook },
      },
    },
    subscriptions: WEBHOOK_SUBSCRIPTIONS,
    verify: verifyWebhook,
    parse: parseWebhook,
  },

  buildAuthorizeUrl({ client, state, redirectUri, codeChallenge }) {
    if (codeChallenge === undefined) throw new TypeError("Resend requires a PKCE S256 code challenge");
    if (state.length === 0 || state.length > STATE_MAX_LENGTH) {
      throw new RangeError(`state must be 1 to ${STATE_MAX_LENGTH} characters`);
    }
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", redirectUri);
    // Always explicit: never let the scope default by omission.
    url.searchParams.set("scope", REQUESTED_SCOPES.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  },

  async exchangeCode({ code, redirectUri, codeVerifier, callbackParams }, ctx) {
    // RFC 9207 section 2.4: Resend's discovery document sets
    // `authorization_response_iss_parameter_supported`, so a callback without `iss`, or with
    // another issuer, is refused as a possible mix-up attack.
    if (callbackParams["iss"] !== RESEND_ISSUER) {
      throw new InvalidResponseError("Resend callback did not carry Resend as its issuer");
    }
    if (codeVerifier === undefined || !CODE_VERIFIER.test(codeVerifier)) {
      throw new TypeError("Resend requires a PKCE code verifier of 43 to 128 unreserved characters");
    }
    const tokens = await requestTokens(ctx, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    return toCredential(tokens, ctx, REQUESTED_SCOPES);
  },

  /**
   * Returns the NEW refresh token: Resend rotates it on every use and the old one stops working.
   * Callers MUST serialize refreshes per connection (row lock or single flight) and persist the
   * returned credential atomically before using it: replaying an old refresh token fails with
   * invalid_grant and revokes the whole grant.
   */
  async refreshTokens(credential, ctx) {
    if (credential.refreshToken === undefined) {
      throw new AuthRevokedError("Resend connection has no refresh token; reconnect required");
    }
    const tokens = await requestTokens(ctx, {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken.reveal(),
    });
    const refreshed = toCredential(tokens, ctx, credential.scopes);
    return credential.metadata === undefined ? refreshed : { ...refreshed, metadata: credential.metadata };
  },

  /** Revokes the whole grant (and its issued access tokens) through the refresh token (RFC 7009). */
  async revoke(credential, ctx) {
    if (credential.refreshToken === undefined) {
      // Access tokens cannot be revoked individually; without a refresh token there is no grant handle.
      ctx.logger.warn("resend.revoke.no_refresh_token", { provider: "resend" });
      return;
    }
    // Resend answers 200 with an empty body; fetchJson expects JSON, so an empty success body is
    // read as JSON null. Error statuses pass through untouched and keep fetchJson's mapping.
    const emptyBodyFetch: FetchLike = async (input, init) => {
      const response = await ctx.fetch(input, init);
      if (!response.ok) return response;
      const text = await response.clone().text();
      return text.trim().length === 0
        ? new Response("null", { status: response.status, headers: response.headers })
        : response;
    };
    await fetchJson(
      { ...ctx, fetch: emptyBodyFetch },
      REVOKE_URL,
      {
        method: "POST",
        headers: oauthHeaders(ctx),
        body: new URLSearchParams({
          token: credential.refreshToken.reveal(),
          token_type_hint: "refresh_token",
        }).toString(),
      },
      z.unknown(),
    );
  },

  async listAccounts(credential, ctx): Promise<ExternalAccount[]> {
    // No endpoint names the team, so the label comes from the oldest domain (first page only).
    const { domains } = await listDomains(ctx, credential, 1);
    const oldest = [...domains].sort((a, b) => a.created_at.getTime() - b.created_at.getTime())[0];
    return [
      {
        externalId: RESEND_TEAM_EXTERNAL_ID,
        displayName: oldest === undefined ? "Resend team" : `Resend team (${oldest.name})`,
        kind: "team",
      },
    ];
  },

  detectMissingPermissions(grant) {
    return REQUESTED_SCOPES.filter((scope) => !grant.scopes.includes(scope));
  },

  // Requests run one after another on purpose: the team's 10 requests per second budget is shared
  // with the user's own API keys (docs/providers/resend.md, Rate limits).
  async sync({ credential, externalAccountId, cursor }: SyncInput, ctx): Promise<SyncResult> {
    const retrievedAt = ctx.now();
    const partialErrors: PermissionMissingError[] = [];

    // Usage is the primary data: any failure here, a 403 included, fails the sync. That an OAuth
    // full_access token (not only a full access API key) can read /usage is documented but not yet
    // confirmed (docs/providers/resend.md, Unverified 1).
    const usage = await apiGet(ctx, credential, "/usage", {}, UsageResponseSchema);
    const metrics = usageMetrics(usage, externalAccountId, retrievedAt);

    try {
      const delivery = await apiGet(
        ctx,
        credential,
        "/emails/metrics",
        {
          start_date: new Date(retrievedAt.getTime() - DELIVERY_WINDOW_MS).toISOString(),
          end_date: retrievedAt.toISOString(),
          metrics: "delivered,bounced,complained",
        },
        EmailMetricsResponseSchema,
      );
      metrics.push(...deliveryMetrics(delivery, externalAccountId, retrievedAt));
    } catch (error) {
      const gap = permissionGap(error, "email metrics");
      if (gap === undefined) throw error;
      partialErrors.push(gap);
    }

    const previous = decodeCursor(cursor, ctx);
    let events: ActivityEvent[] = [];
    let nextCursor = cursor;
    try {
      const listing = await listDomains(ctx, credential, MAX_DOMAIN_PAGES);
      if (!listing.complete) {
        ctx.logger.warn("resend.sync.domain_page_cap", { provider: "resend", maxPages: MAX_DOMAIN_PAGES });
      }
      events = domainEvents(listing.domains, previous, externalAccountId, retrievedAt);
      // A capped listing keeps the statuses of domains it did not reach; only a complete listing
      // drops domains that no longer exist.
      const statuses: DomainStatuses = listing.complete ? new Map() : new Map(previous ?? []);
      for (const domain of listing.domains) statuses.set(domain.id, domain.status);
      nextCursor = encodeCursor(statuses);
    } catch (error) {
      const gap = permissionGap(error, "the domain list");
      if (gap === undefined) throw error;
      partialErrors.push(gap);
    }

    return {
      metrics,
      events,
      ...(nextCursor === undefined ? {} : { cursor: nextCursor }),
      ...(partialErrors.length === 0 ? {} : { partialErrors }),
    };
  },
};
