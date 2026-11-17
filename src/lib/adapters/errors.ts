import { z } from "zod";
import type { AdapterContext } from "./types";

export const adapterErrorCodes = [
  "auth_revoked",
  "permission_missing",
  "rate_limited",
  "provider_unavailable",
  "invalid_response",
  "timeout",
] as const;

export type AdapterErrorCode = (typeof adapterErrorCodes)[number];

type AdapterErrorOptions = {
  cause?: unknown;
  status?: number;
  // Origin and path only. Query strings can carry tokens, so they never reach an error.
  endpoint?: string;
};

/**
 * Base for every failure an adapter reports. The sync runner branches on `code`
 * (strategy per failure: mark the connection revoked, ask for more scopes,
 * back off, retry later), so callers never parse messages.
 * Messages never contain tokens, response bodies, or query strings.
 */
export abstract class AdapterError extends Error {
  abstract readonly code: AdapterErrorCode;
  readonly status: number | undefined;
  readonly endpoint: string | undefined;

  constructor(message: string, options: AdapterErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.endpoint = options.endpoint;
  }
}

export class AuthRevokedError extends AdapterError {
  override readonly code = "auth_revoked";
}

export class PermissionMissingError extends AdapterError {
  override readonly code = "permission_missing";
  // Empty when the provider refused without saying which scope was missing.
  readonly missingScopes: readonly string[];

  constructor(message: string, missingScopes: readonly string[], options: AdapterErrorOptions = {}) {
    super(message, options);
    this.missingScopes = missingScopes;
  }
}

export class RateLimitedError extends AdapterError {
  override readonly code = "rate_limited";
  readonly retryAfterMs: number | undefined;

  constructor(message: string, retryAfterMs: number | undefined, options: AdapterErrorOptions = {}) {
    super(message, options);
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProviderUnavailableError extends AdapterError {
  override readonly code = "provider_unavailable";
}

export class InvalidResponseError extends AdapterError {
  override readonly code = "invalid_response";
}

export class AdapterTimeoutError extends AdapterError {
  override readonly code = "timeout";
}

/**
 * Retry-After is either delay-seconds or an HTTP-date (RFC 9110 section 10.2.3).
 * Returns undefined when absent or unparseable so the caller falls back to its own backoff.
 */
export function parseRetryAfterMs(header: string | null, now: Date): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return Number.isSafeInteger(seconds * 1000) ? seconds * 1000 : undefined;
  }
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}

function describeEndpoint(url: string | URL): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch (error) {
    // An unparseable URL is reported without its text: it may hold a token.
    if (error instanceof TypeError) return "unparseable url";
    throw error;
  }
}

/**
 * GitHub signals primary and secondary rate limits with 403, not 429, and marks
 * them with Retry-After or x-ratelimit-remaining: 0. Without this a rate limit
 * would be reported as a missing permission and ask the user to reconnect.
 */
function isRateLimited403(response: Response): boolean {
  return (
    response.headers.has("retry-after") || response.headers.get("x-ratelimit-remaining") === "0"
  );
}

type RequestContext = Pick<AdapterContext, "fetch" | "now" | "timeoutMs">;

/**
 * Sends one request under `signal` and maps every HTTP failure to its typed error, so `fetchJson`
 * and `fetchNoContent` treat statuses alike. Returns the response of a 2xx answer.
 */
async function sendChecked(ctx: RequestContext, url: string | URL, init: Omit<RequestInit, "signal">, signal: AbortSignal): Promise<Response> {
  const endpoint = describeEndpoint(url);
  let response: Response;
  try {
    response = await ctx.fetch(url, { ...init, signal });
  } catch (error) {
    if (signal.aborted) {
      throw new AdapterTimeoutError(`Request to ${endpoint} timed out after ${ctx.timeoutMs} ms`, {
        cause: error,
        endpoint,
      });
    }
    throw new ProviderUnavailableError(`Request to ${endpoint} failed before a response`, {
      cause: error,
      endpoint,
    });
  }

  const { status } = response;
  if (status === 401) {
    throw new AuthRevokedError(`${endpoint} rejected the credential (401)`, { status, endpoint });
  }
  if (status === 429 || (status === 403 && isRateLimited403(response))) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"), ctx.now());
    throw new RateLimitedError(`${endpoint} rate limited the request (${status})`, retryAfterMs, {
      status,
      endpoint,
    });
  }
  if (status === 403) {
    throw new PermissionMissingError(`${endpoint} refused the request (403)`, [], {
      status,
      endpoint,
    });
  }
  if (status >= 500) {
    throw new ProviderUnavailableError(`${endpoint} is unavailable (${status})`, {
      status,
      endpoint,
    });
  }
  if (!response.ok) {
    throw new InvalidResponseError(`${endpoint} answered with unexpected status ${status}`, {
      status,
      endpoint,
    });
  }
  return response;
}

/**
 * One outbound request whose answer StackDash does not read (a DELETE that may answer 204 or an
 * empty body), with the same timeout and error mapping as `fetchJson`. The body is discarded.
 */
export async function fetchNoContent(ctx: RequestContext, url: string | URL, init: Omit<RequestInit, "signal">): Promise<void> {
  const response = await sendChecked(ctx, url, init, AbortSignal.timeout(ctx.timeoutMs));
  await response.body?.cancel();
}

/**
 * One outbound JSON request with the adapter contract applied: a timeout on
 * every call, HTTP failures mapped to typed errors, and the body parsed at the
 * boundary so nothing unvalidated reaches the adapter.
 * The signal is owned here so the timeout cannot be bypassed.
 */
export async function fetchJson<T>(
  ctx: RequestContext,
  url: string | URL,
  init: Omit<RequestInit, "signal">,
  schema: z.ZodType<T>,
): Promise<T> {
  const endpoint = describeEndpoint(url);
  const signal = AbortSignal.timeout(ctx.timeoutMs);
  const response = await sendChecked(ctx, url, init, signal);
  const { status } = response;
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (signal.aborted) {
      throw new AdapterTimeoutError(`Reading ${endpoint} timed out after ${ctx.timeoutMs} ms`, {
        cause: error,
        endpoint,
      });
    }
    throw new InvalidResponseError(`${endpoint} returned a body that is not JSON`, {
      cause: error,
      status,
      endpoint,
    });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new InvalidResponseError(`${endpoint} returned an unexpected shape`, {
      cause: parsed.error,
      status,
      endpoint,
    });
  }
  return parsed.data;
}

/**
 * RFC 6749 section 5.2 error body from an OAuth token endpoint (`invalid_grant`,
 * `invalid_client`, `invalid_request`, ...). Only the code is read.
 */
export const OAuthErrorSchema = z.object({ error: z.string().min(1) });

/**
 * The RFC 6749 `error` code of a token endpoint error response, or undefined when the body is not
 * JSON or carries no code. Pass a clone when `fetchJson` still has to read the body. Which statuses
 * and codes mean a revoked grant stays with each adapter, since providers differ there.
 */
export async function readOAuthErrorCode(response: Response): Promise<string | undefined> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  const parsed = OAuthErrorSchema.safeParse(body);
  return parsed.success ? parsed.data.error : undefined;
}
