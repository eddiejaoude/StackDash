import { NextResponse } from "next/server";
import { z } from "zod";

import {
  FAKE_CALLBACK_PATH,
  FAKE_CODE_PREFIX,
  FAKE_PROVIDER_ENABLE_ENV,
  FakeModeSchema,
  fakeScopes,
  parseFakeScopes,
} from "@/lib/adapters/fake";
import { isProviderSimulationEnabled, SIMULATED_CODE_PREFIX, simulatedAdapters } from "@/lib/adapters/simulated";
import { SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";
import { liveProviderIds, type LiveProviderId } from "@/lib/adapters/types";

const LiveProviderIdSchema = z.enum(liveProviderIds);

function plainText(message: string, status: number): NextResponse {
  return new NextResponse(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/**
 * The redirect target must be StackDash's own callback for this provider: anything else is an
 * open redirect. Returns the callback carrying the state, or an error response.
 */
function callbackFor(requestUrl: URL, path: string): URL | NextResponse {
  const query = requestUrl.searchParams;
  const state = query.get("state");
  if (state === null || state.length === 0) return plainText("Missing state.", 400);
  const callback = new URL(path, requestUrl.origin);
  if (query.get("redirect_uri") !== callback.href) {
    return plainText(`redirect_uri must be ${callback.href}.`, 400);
  }
  callback.searchParams.set("state", state);
  return callback;
}

/** `error=access_denied` (the user pressed Cancel), an unsupported error, or null to approve. */
function cancelled(query: URLSearchParams, callback: URL): NextResponse | null {
  const error = query.get("error");
  if (error === null) return null;
  if (error !== "access_denied") return plainText("Only error=access_denied is supported.", 400);
  callback.searchParams.set("error", "access_denied");
  return NextResponse.redirect(callback, 302);
}

function fakeConsent(requestUrl: URL): NextResponse {
  if (process.env[FAKE_PROVIDER_ENABLE_ENV] !== "1") return plainText("Not found", 404);
  const query = requestUrl.searchParams;
  const callback = callbackFor(requestUrl, FAKE_CALLBACK_PATH);
  if (callback instanceof NextResponse) return callback;
  const denied = cancelled(query, callback);
  if (denied !== null) return denied;

  const requestedText = query.get("scope") ?? "";
  const requested = parseFakeScopes(requestedText);
  const declinedText = query.get("decline") ?? "";
  const declined = parseFakeScopes(declinedText);
  // Unknown scope names are rejected rather than dropped, so a typo in a test fails loudly.
  const known: ReadonlySet<string> = new Set(fakeScopes);
  const unknown = [...requestedText.split(/\s+/), ...declinedText.split(/\s+/)].filter(
    (scope) => scope.length > 0 && !known.has(scope),
  );
  if (requested.length === 0 || unknown.length > 0) {
    return plainText(`scope and decline may only list: ${fakeScopes.join(", ")}.`, 400);
  }

  const mode = query.get("mode");
  if (mode !== null) {
    if (!FakeModeSchema.safeParse(mode).success) return plainText("Unknown mode.", 400);
    callback.searchParams.set("mode", mode);
  }

  callback.searchParams.set("code", `${FAKE_CODE_PREFIX}${crypto.randomUUID()}`);
  callback.searchParams.set("granted_scope", requested.filter((scope) => !declined.includes(scope)).join(" "));
  return NextResponse.redirect(callback, 302);
}

/** A simulated live provider (#131): one read scope, approved at once, no test switches. */
function simulatedConsent(requestUrl: URL, providerParam: string): NextResponse {
  if (!isProviderSimulationEnabled()) return plainText("Not found", 404);
  const parsed = LiveProviderIdSchema.safeParse(providerParam);
  if (!parsed.success) return plainText(`provider must be one of: ${liveProviderIds.join(", ")}.`, 400);
  const provider: LiveProviderId = parsed.data;
  const query = requestUrl.searchParams;
  const callback = callbackFor(requestUrl, `/api/connections/${provider}/callback`);
  if (callback instanceof NextResponse) return callback;
  if (query.has("decline") || query.has("mode")) {
    return plainText("decline and mode are only for the example provider.", 400);
  }
  const denied = cancelled(query, callback);
  if (denied !== null) return denied;
  // The simulated read scope, followed by automatic webhook setup's write scope only for a provider
  // whose simulated adapter declares it (#426); any other scope is refused.
  const registration = simulatedAdapters[provider].webhooks?.registration;
  const writeScopes =
    registration?.kind === "connection" ? (registration.setup.automatic?.extraPermissions ?? []).map((permission) => permission.scope) : [];
  const allowed = [SIMULATED_SCOPE, ...writeScopes.map((scope) => `${SIMULATED_SCOPE} ${scope}`)];
  const requested = query.get("scope");
  if (requested === null || !allowed.includes(requested)) return plainText(`scope must be one of: ${allowed.join(", ")}.`, 400);

  callback.searchParams.set("code", `${SIMULATED_CODE_PREFIX}${crypto.randomUUID()}`);
  callback.searchParams.set("granted_scope", requested);
  return NextResponse.redirect(callback, 302);
}

/**
 * Dev-only consent screen (#40, #131), for tests, e2e, and local demos. It approves at once and
 * redirects to StackDash's own callback, so the connect flow runs end to end without a real OAuth
 * app. Without `provider` it is the fake provider's screen, served only when
 * STACKDASH_ENABLE_FAKE_PROVIDER is "1", with these test switches in the query:
 * - `decline=usage:read` (space-separated scopes): the user unticked those scopes.
 * - `error=access_denied`: the user pressed Cancel.
 * - `mode=rate_limited|revoked|unavailable`: forwarded so later calls on the connection fail.
 *
 * With `provider=<live provider id>` it is that provider's simulated screen, served only while
 * provider simulation is enabled; `error=access_denied` is its only switch.
 *
 * Flags are read on every request, not at module load, so they cannot be baked into a build.
 */
export function GET(request: Request): NextResponse {
  const requestUrl = new URL(request.url);
  const provider = requestUrl.searchParams.get("provider");
  return provider === null ? fakeConsent(requestUrl) : simulatedConsent(requestUrl, provider);
}
