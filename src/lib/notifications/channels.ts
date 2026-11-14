/**
 * Discord, Slack, and generic webhook channels (#153): URL rules, the message each platform gets,
 * and the HTTP post with retries. Pure apart from the injected `fetch` and `sleep`, so formatting,
 * retry, and failure classification are unit tested with a mocked transport. `pinnedFetch` is the
 * production transport: it resolves the host once, applies the private address policy to every
 * address, and connects only to those.
 *
 * Sources (checked 2026-11-05):
 * - Discord execute webhook: https://docs.discord.com/developers/resources/webhook#execute-webhook
 *   (content up to 2000 characters, up to 10 embeds; `allowed_mentions` with an empty `parse` so a
 *   name can never ping @everyone). Embed limits: title 256, description 4096, 25 fields, field
 *   name 256 and value 1024, 6000 characters in total.
 * - Discord rate limits: https://docs.discord.com/developers/topics/rate-limits (429 with a
 *   `Retry-After` header and a JSON `retry_after` in seconds).
 * - Slack incoming webhooks: https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks
 *   (`text` fallback plus Block Kit `blocks`; errors such as `no_service` 404, `channel_is_archived`
 *   410, `action_prohibited` 403 mean the webhook cannot be used again). Slack allows about one
 *   message per second per webhook: https://docs.slack.dev/apis/web-api/rate-limits
 * - Generic webhooks are signed as Standard Webhooks describe:
 *   https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md
 *   (`webhook-id`, `webhook-timestamp`, and `webhook-signature: v1,<base64 HMAC-SHA256 of
 *   "id.timestamp.body">` with the base64 key after the `whsec_` prefix).
 */
import { createHmac, randomBytes } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

import type { DestinationKind } from "./model";
import type { Notice, NoticeSeverity } from "./notice";
import { severityLabel } from "./notice";

// ── URLs ────────────────────────────────────────────────────────────────────────

const DISCORD_HOSTS: Record<string, true> = {
  "discord.com": true,
  "discordapp.com": true,
  "ptb.discord.com": true,
  "canary.discord.com": true,
};
const DISCORD_PATH = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/;
const SLACK_HOST = "hooks.slack.com";
const SLACK_PATH = /^\/services\/[A-Z0-9]+\/[A-Z0-9]+\/[A-Za-z0-9]+\/?$/;
const MAX_URL_LENGTH = 2000;

/*
 * Addresses a webhook may not reach on a production instance unless
 * STACKDASH_ALLOW_PRIVATE_WEBHOOKS=1: loopback, private, shared (carrier-grade NAT), link-local
 * (cloud metadata), unique and site local, multicast, reserved, and documentation ranges, from the
 * IANA special-purpose registries (checked 2026-11-05):
 * https://www.iana.org/assignments/iana-ipv4-special-registry and
 * https://www.iana.org/assignments/iana-ipv6-special-registry. BlockList also matches an
 * IPv4-mapped IPv6 address (::ffff:a.b.c.d) against the IPv4 ranges:
 * https://nodejs.org/api/net.html#class-netblocklist
 */
const PRIVATE_RANGES: ReadonlyArray<readonly [network: string, prefix: number, type: "ipv4" | "ipv6"]> = [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  // Unspecified, loopback, and the deprecated IPv4-compatible block.
  ["::", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  // 6to4 can carry any IPv4 address, private ones included.
  ["2002::", 16, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["fec0::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
];
const PRIVATE_ADDRESSES = new BlockList();
for (const [network, prefix, type] of PRIVATE_RANGES) PRIVATE_ADDRESSES.addSubnet(network, prefix, type);
// NAT64 (RFC 6052) reaches the IPv4 address in the last 32 bits, so that address is what is judged.
const NAT64 = new BlockList();
NAT64.addSubnet("64:ff9b::", 96, "ipv6");

/** The IPv4 address in the last 32 bits of an IPv6 address. */
function embeddedIpv4(ipv6: string): string {
  // The URL parser writes IPv6 in its canonical compressed form, whose last two groups are the
  // last 32 bits (an empty group is a compressed zero).
  const groups = new URL(`http://[${ipv6}]`).hostname.slice(1, -1).split(":");
  const [high = 0, low = 0] = groups.slice(-2).map((group) => (group === "" ? 0 : Number.parseInt(group, 16)));
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

/** True for an IP address a production webhook may not reach; anything that is not an IP address too. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  const type = family === 4 ? "ipv4" : "ipv6";
  if (PRIVATE_ADDRESSES.check(address, type)) return true;
  return type === "ipv6" && NAT64.check(address, "ipv6") && isPrivateAddress(embeddedIpv4(address));
}

/**
 * The save time check on the URL as written: a private address literal, or a name that is local by
 * definition. Names are resolved when a message is posted (`pinnedFetch`), so a public name that
 * resolves to a private address is refused there.
 */
function isPrivateHost(hostname: string): boolean {
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".internal")) return true;
  // URL.hostname keeps the brackets around an IPv6 address.
  const host = hostname.replace(/^\[(.*)\]$/, "$1");
  return isIP(host) !== 0 && isPrivateAddress(host);
}

export type UrlPolicy = Readonly<{ allowPrivate: boolean }>;

/** Plain http, and private hosts, are for local runs and self-hosted networks only. */
export function urlPolicyFromEnv(env: Readonly<Record<string, string | undefined>> = process.env): UrlPolicy {
  return { allowPrivate: env.NODE_ENV !== "production" || env.STACKDASH_ALLOW_PRIVATE_WEBHOOKS === "1" };
}

export type ParsedChannelUrl = { ok: true; url: string; host: string } | { ok: false; message: string };

/** Checks a pasted URL for the chosen kind. Messages never repeat the URL, which is a secret. */
export function parseChannelUrl(kind: DestinationKind, raw: string, policy: UrlPolicy): ParsedChannelUrl {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, message: "Paste the webhook URL." };
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, message: "This URL is too long to be a webhook URL." };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, message: "This is not a valid URL. Copy the whole webhook URL and paste it again." };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, message: "Remove the user name and password from the URL." };
  }
  switch (kind) {
    case "discord":
      if (url.protocol !== "https:" || DISCORD_HOSTS[url.hostname] !== true || !DISCORD_PATH.test(url.pathname)) {
        return {
          ok: false,
          message: "This is not a Discord webhook URL. In Discord, open the channel settings, Integrations, Webhooks, and copy the webhook URL.",
        };
      }
      break;
    case "slack":
      if (url.protocol !== "https:" || url.hostname !== SLACK_HOST || !SLACK_PATH.test(url.pathname)) {
        return {
          ok: false,
          message: "This is not a Slack incoming webhook URL. It starts with https://hooks.slack.com/services/.",
        };
      }
      break;
    case "webhook": {
      const local = policy.allowPrivate && url.protocol === "http:";
      if (url.protocol !== "https:" && !local) return { ok: false, message: "Use an https URL." };
      if (!policy.allowPrivate && isPrivateHost(url.hostname)) {
        return { ok: false, message: "This URL points to a private network address, which this instance does not allow." };
      }
      break;
    }
  }
  url.hash = "";
  return { ok: true, url: url.href, host: url.hostname };
}

// ── Platform payloads ───────────────────────────────────────────────────────────

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}\u2026`;
}

const DISCORD_COLOR: Record<NoticeSeverity, number> = { critical: 0xb42318, warning: 0xdc6803, info: 0x475467 };
const DISCORD_MAX_EMBEDS = 10;
// Below Discord's 6000 total so the clipped titles and fields always fit.
const DISCORD_DESCRIPTION_MAX = 1000;

export function discordPayload(notice: Notice): Record<string, unknown> {
  const items = notice.sections.flatMap((section) => section.items);
  const shown = items.slice(0, DISCORD_MAX_EMBEDS - 1);
  const rest = items.length - shown.length;
  const links = notice.links.map((link) => `[${link.label}](${link.url})`).join(" | ");
  const embeds = shown.map((item) => ({
    title: clip(item.title, 256),
    description: clip(item.body, DISCORD_DESCRIPTION_MAX),
    color: DISCORD_COLOR[item.severity],
    fields: item.fields.slice(0, 8).map((field) => ({ name: clip(field.name, 256), value: clip(field.value, 256), inline: true })),
  }));
  embeds.push({
    title: clip(notice.subject, 256),
    description: clip([notice.intro, rest > 0 ? `${rest} more in StackDash.` : "", links].filter((part) => part !== "").join("\n\n"), DISCORD_DESCRIPTION_MAX),
    color: DISCORD_COLOR.info,
    fields: [],
  });
  return {
    content: clip(notice.subject, 2000),
    embeds,
    allowed_mentions: { parse: [] },
  };
}

/** Slack mrkdwn needs &, <, and > escaped: https://docs.slack.dev/messaging/formatting-message-text */
function slackEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const SLACK_MAX_ITEMS = 20;

export function slackPayload(notice: Notice): Record<string, unknown> {
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: { type: "plain_text", text: clip(notice.subject, 150) } },
    { type: "section", text: { type: "mrkdwn", text: clip(slackEscape(notice.intro), 3000) } },
  ];
  let shown = 0;
  let hidden = 0;
  for (const section of notice.sections) {
    blocks.push({ type: "divider" });
    blocks.push({ type: "section", text: { type: "mrkdwn", text: `*${clip(slackEscape(section.heading), 200)}*` } });
    for (const item of section.items) {
      if (shown >= SLACK_MAX_ITEMS) {
        hidden += 1;
        continue;
      }
      shown += 1;
      const label = item.severity === "info" ? "" : ` (${severityLabel(item.severity)})`;
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: clip(`*${slackEscape(item.title)}*${label}\n${slackEscape(item.body)}`, 3000) },
        ...(item.fields.length === 0
          ? {}
          : {
              fields: item.fields
                .slice(0, 10)
                .map((field) => ({ type: "mrkdwn", text: clip(`*${slackEscape(field.name)}*\n${slackEscape(field.value)}`, 2000) })),
            }),
      });
    }
  }
  const links = notice.links.map((link) => `<${link.url}|${slackEscape(link.label)}>`);
  if (hidden > 0) links.unshift(`${hidden} more in StackDash.`);
  blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: clip(links.join(" | "), 3000) }] });
  // The fallback `text` is mrkdwn too (it is what notifications show), so it is escaped as well.
  return { text: clip(slackEscape(notice.subject), 3000), blocks };
}

const WEBHOOK_TYPES = { alerts: "stackdash.alerts", digest: "stackdash.digest", test: "stackdash.test" } as const;

/** The generic webhook body: the same sections, plus the alerts as data for whoever receives it. */
export function webhookPayload(notice: Notice, sentAt: Date): Record<string, unknown> {
  return {
    type: WEBHOOK_TYPES[notice.type],
    sent_at: sentAt.toISOString(),
    workspace: notice.workspaceName,
    subject: notice.subject,
    intro: notice.intro,
    sections: notice.sections,
    links: notice.links,
    alerts: notice.alerts.map((alert) => ({
      id: alert.id,
      rule_id: alert.ruleId,
      title: alert.title,
      message: alert.message,
      severity: alert.severity,
      threshold: alert.thresholdLabel,
      is_estimated: alert.isEstimated,
      provider: alert.providerName,
      project: alert.projectName,
      resets_at: alert.resetsAt,
      triggered_at: alert.triggeredAt,
    })),
  };
}

// ── Signing ─────────────────────────────────────────────────────────────────────

const SECRET_PREFIX = "whsec_";

/** A new Standard Webhooks signing secret: `whsec_` and 32 random bytes in base64. */
export function newSigningSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString("base64")}`;
}

/** The `webhook-signature` header value for one delivery. */
export function signWebhook(secret: string, messageId: string, timestampSeconds: number, body: string): string {
  const key = Buffer.from(secret.startsWith(SECRET_PREFIX) ? secret.slice(SECRET_PREFIX.length) : secret, "base64");
  const signature = createHmac("sha256", key).update(`${messageId}.${timestampSeconds}.${body}`, "utf8").digest("base64");
  return `v1,${signature}`;
}

// ── Posting ─────────────────────────────────────────────────────────────────────

export type ChannelSecret = Readonly<{ url: string; signingSecret?: string }>;

export type PostOutcome =
  | Readonly<{ ok: true; attempts: number }>
  | Readonly<{ ok: false; attempts: number; retryable: boolean; code: string }>;

/** One post to a channel. `kind` lets the URL rules be applied again when it is sent. */
export type ChannelRequest = Readonly<{ kind: DestinationKind; url: string; body: string; headers: Record<string, string> }>;

/** The HTTP call `postToChannel` makes: `pinnedFetch` in production, a stub in tests. */
export type ChannelFetch = (
  url: string,
  init: Readonly<{ method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }>,
) => Promise<Response>;

export type PostDeps = Readonly<{
  fetch: ChannelFetch;
  sleep: (ms: number) => Promise<void>;
  random: () => number;
  now: () => Date;
  newId: () => string;
  /** Read when the message is sent, so removing STACKDASH_ALLOW_PRIVATE_WEBHOOKS takes effect at once. */
  policy: UrlPolicy;
}>;

export const POST_TIMEOUT_MS = 10_000;
export const POST_MAX_ATTEMPTS = 3;
// A wait longer than this is left to the next job attempt rather than held inside a tick.
export const POST_MAX_WAIT_MS = 10_000;
const POST_BASE_DELAY_MS = 1_000;

/** Seconds from `Retry-After` (or Discord's JSON `retry_after`), in milliseconds; null when absent. */
async function retryAfterMs(response: Response): Promise<number | null> {
  const header = response.headers.get("retry-after");
  if (header !== null && /^\d+(\.\d+)?$/.test(header.trim())) return Math.ceil(Number(header) * 1000);
  if ((response.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const body: unknown = await response.json();
      if (typeof body === "object" && body !== null && "retry_after" in body && typeof body.retry_after === "number") {
        return Math.ceil(body.retry_after * 1000);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return null;
}

/** The request for one channel: Discord and Slack take their JSON, a webhook is signed. */
export function channelRequest(
  kind: DestinationKind,
  secret: ChannelSecret,
  notice: Notice,
  deps: Pick<PostDeps, "now" | "newId">,
): ChannelRequest {
  const now = deps.now();
  const payload = kind === "discord" ? discordPayload(notice) : kind === "slack" ? slackPayload(notice) : webhookPayload(notice, now);
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "StackDash" };
  if (kind === "webhook" && secret.signingSecret !== undefined) {
    const id = `msg_${deps.newId()}`;
    const timestamp = Math.floor(now.getTime() / 1000);
    headers["webhook-id"] = id;
    headers["webhook-timestamp"] = String(timestamp);
    headers["webhook-signature"] = signWebhook(secret.signingSecret, id, timestamp, body);
  }
  return { kind, url: secret.url, body, headers };
}

/**
 * Posts with up to POST_MAX_ATTEMPTS tries (`maxAttempts` lowers it, for a test message that
 * should answer with the first result). The URL rules are applied again first: a URL saved while
 * STACKDASH_ALLOW_PRIVATE_WEBHOOKS=1 is no longer posted once the flag is gone. 429 waits for
 * Retry-After (when short enough) and 5xx, timeouts, and network errors back off with jitter; both
 * are retryable later when the tries run out. Any other 4xx, any redirect (never followed, so a
 * webhook cannot bounce the request to another host), and a host that resolves to a private
 * address are not: the URL itself is wrong now.
 */
export async function postToChannel(
  request: ChannelRequest,
  deps: Pick<PostDeps, "fetch" | "sleep" | "random" | "policy">,
  options: Readonly<{ maxAttempts?: number }> = {},
): Promise<PostOutcome> {
  if (!parseChannelUrl(request.kind, request.url, deps.policy).ok) {
    return { ok: false, attempts: 0, retryable: false, code: "url_not_allowed" };
  }
  const maxAttempts = options.maxAttempts ?? POST_MAX_ATTEMPTS;
  let last: { retryable: boolean; code: string } = { retryable: true, code: "network_error" };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await deps.fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof PrivateAddressError) return { ok: false, attempts: attempt, retryable: false, code: "private_address" };
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      last = { retryable: true, code: timedOut ? "timeout" : "network_error" };
      if (attempt < maxAttempts) await deps.sleep(POST_BASE_DELAY_MS * 2 ** (attempt - 1) * (0.5 + deps.random() / 2));
      continue;
    }
    if (response.status >= 200 && response.status < 300) return { ok: true, attempts: attempt };
    if (response.status === 429) {
      const wait = (await retryAfterMs(response)) ?? POST_BASE_DELAY_MS * 2 ** (attempt - 1);
      last = { retryable: true, code: "rate_limited" };
      if (wait > POST_MAX_WAIT_MS) return { ok: false, attempts: attempt, ...last };
      if (attempt < maxAttempts) await deps.sleep(wait);
      continue;
    }
    if (response.status >= 500) {
      last = { retryable: true, code: `http_${response.status}` };
      if (attempt < maxAttempts) await deps.sleep(POST_BASE_DELAY_MS * 2 ** (attempt - 1) * (0.5 + deps.random() / 2));
      continue;
    }
    return { ok: false, attempts: attempt, retryable: false, code: `http_${response.status}` };
  }
  return { ok: false, attempts: maxAttempts, ...last };
}

// ── Address pinning ─────────────────────────────────────────────────────────────

/** A webhook host that resolves to an address the policy refuses. Never retried. */
export class PrivateAddressError extends Error {
  override readonly name = "PrivateAddressError";
}

export type ResolvedAddress = Readonly<{ address: string; family: number }>;
/** Every address of a host name: `dns.lookup` with `all` in production, a table in tests. */
export type ResolveHost = (hostname: string) => Promise<readonly ResolvedAddress[]>;

// Enough for an error body or Discord's JSON retry_after; nothing more of a response is read.
const RESPONSE_BODY_LIMIT_BYTES = 64 * 1024;
// Statuses whose response has no body (Fetch standard, "null body status"): a Response with one throws.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Rejects with the signal's reason (a TimeoutError) when it fires first: dns.lookup cannot be aborted. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return Promise.race([promise, aborted.promise]).finally(() => signal.removeEventListener("abort", onAbort));
}

function responseHeaders(message: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  return headers;
}

/**
 * The production ChannelFetch. It resolves the host once, refuses the post when any of its
 * addresses is private under `policy`, and then connects only to those addresses (the `lookup`
 * option answers with them), so a name that resolves to a public address for the check and to a
 * private one for the connection (DNS rebinding) never reaches the private one. TLS still verifies
 * the certificate against the host name. Redirects are never followed, and connections are not
 * pooled. Sources (checked 2026-11-05): https://nodejs.org/api/http.html#httprequesturl-options-callback
 * (`lookup`, `signal`, `agent: false`) and https://nodejs.org/api/dns.html#dnspromiseslookuphostname-options.
 */
export function pinnedFetch(policy: UrlPolicy, resolveHost: ResolveHost = (hostname) => dnsLookup(hostname, { all: true })): ChannelFetch {
  return async (url, init) => {
    const target = new URL(url);
    // URL.hostname keeps the brackets around an IPv6 address.
    const host = target.hostname.replace(/^\[(.*)\]$/, "$1");
    const family = isIP(host);
    const addresses = family === 0 ? await abortable(resolveHost(host), init.signal) : [{ address: host, family }];
    const [first] = addresses;
    if (first === undefined) throw new Error("The webhook host has no address.");
    if (!policy.allowPrivate && addresses.some((entry) => isPrivateAddress(entry.address))) {
      throw new PrivateAddressError("The webhook host resolves to a private network address.");
    }
    const lookup: LookupFunction = (_hostname, options, callback) => {
      if (options.all === true) callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })));
      else callback(null, first.address, first.family);
    };
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;

    const { promise, resolve, reject } = Promise.withResolvers<Response>();
    // An aborted request fails with Node's AbortError; the caller tells a timeout by the reason.
    const fail = (error: unknown) => reject(init.signal.aborted ? init.signal.reason : error);
    const request = send(target, { method: init.method, headers: init.headers, signal: init.signal, agent: false, lookup }, (message) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const finish = () => {
        try {
          const status = message.statusCode ?? 0;
          const body = NULL_BODY_STATUSES.has(status) ? null : Buffer.concat(chunks).toString("utf8");
          resolve(new Response(body, { status, headers: responseHeaders(message) }));
        } catch (error) {
          // A status the Fetch standard does not allow (outside 200 to 599).
          fail(error);
        }
      };
      message.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        size += chunk.length;
        if (size >= RESPONSE_BODY_LIMIT_BYTES) {
          message.destroy();
          finish();
        }
      });
      message.on("end", finish);
      message.on("error", fail);
    });
    request.on("error", fail);
    request.end(init.body);
    return promise;
  };
}

/** The failure code of a channel whose sealed URL is gone or cannot be decrypted (dispatch.ts). */
export const SECRET_MISSING_CODE = "secret_missing";

/** Plain words for a failure code, for the timeline and the channel's status line. */
export function describeFailure(code: string): string {
  if (code === SECRET_MISSING_CODE) return "The webhook URL can no longer be read";
  if (code === "rate_limited") return "The service kept asking StackDash to slow down";
  if (code === "timeout") return "The service did not answer in time";
  if (code === "network_error") return "StackDash could not reach the service";
  if (code === "private_address") return "The webhook URL leads to a private network address, which this instance does not allow";
  if (code === "url_not_allowed") return "This instance no longer allows the webhook URL";
  if (code === "http_404" || code === "http_410") return "The webhook no longer exists, or its channel was archived";
  if (code === "http_401" || code === "http_403") return "The service refused the webhook";
  if (/^http_3\d\d$/.test(code)) return "The webhook URL redirects somewhere else, which StackDash does not follow";
  if (/^http_5\d\d$/.test(code)) return "The service had an error";
  return "The service rejected the message";
}

/**
 * What an admin does about a channel that needs attention after this failure. A test message
 * cannot repair an unreadable URL, so that one asks for the URL again. `onSettingsPage` drops the
 * pointer to alert settings, where the channels are (#343), when the reader is already there.
 */
export function repairStep(code: string, onSettingsPage: boolean): string {
  if (code === SECRET_MISSING_CODE) return `Remove the channel${onSettingsPage ? "" : " in alert settings"} and add it again with its URL`;
  return `Fix the webhook, then send a test message${onSettingsPage ? "" : " from alert settings"} to turn it back on, or remove it`;
}
