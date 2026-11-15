import "server-only";

import { createHmac } from "node:crypto";

import { validateAdapterEvents, type ActivityEvent } from "@/lib/adapters/events";
import { createAdapterContext, getAdapter, isFakeProviderEnabled } from "@/lib/adapters/registry";
import {
  ProviderIdSchema,
  Secret,
  type AdapterContext,
  type ProviderAdapter,
  type ProviderId,
  type WebhookOutcome,
  type WebhookRegistration,
  type WebhookRequest,
} from "@/lib/adapters/types";
import { derivedKey } from "@/lib/crypto/credentials";
import { loadWebhookEndpoint, type WebhookEndpoint } from "@/lib/data/webhook-endpoints";
import { readBoundedRequestBody } from "@/lib/http/bounded-body";
import { createSupabaseJobStore, type RecordWebhookDeliveryInput } from "@/lib/jobs/store";
import { log, logError, type LogFields, type Logger } from "@/lib/log/logger";
import { rateLimitedHeaders, secondsUntilNextMinute } from "@/lib/public-metrics/requests";
import { createAdminClient } from "@/lib/supabase/admin";

/*
 * Receives one provider delivery (#28): `POST /api/webhooks/<provider>` for an app-level URL and
 * `POST /api/webhooks/<provider>/<endpointId>` for a per-connection one. The route only checks the
 * delivery and stores it with a `webhook` job; the next tick applies it (src/lib/jobs/webhook-delivery.ts),
 * so the answer goes back within any provider's deadline whatever the database is doing.
 *
 * There is no Origin check, unlike the app's other POST routes: a delivery comes from the provider's
 * servers, not from a browser on a StackDash page, so it carries no Origin and no cookies. It is
 * authenticated by its signature over the raw body instead, with the secret only StackDash and the
 * provider hold, and nothing reaches storage before that signature is checked.
 *
 * Logs name the provider, endpoint, delivery id, and rejection reason only: never the body, a
 * header, a signature, or a secret. A `parse` that throws is logged by the error's name only: its
 * message can quote the body (a `SyntaxError` from `JSON.parse`, a `ZodError`'s issues).
 *
 * Rate limit: a per-connection URL answers at most WEBHOOK_ENDPOINT_DELIVERIES_PER_MINUTE verified
 * deliveries a minute. Its secret is one the connecting user holds, so a verified delivery there
 * proves only that the user signed it, and each one stores a row and queues a job on the queue
 * every workspace shares. The app-level URL is not limited: only the provider holds its secret.
 * Counted in Postgres with the public routes' per-minute counter (bump_public_rate_limit, #149),
 * under an HMAC of the endpoint id with a key of its own, so the two never share a bucket.
 */

// Larger than any delivery a provider documents (GitHub caps payloads at 25 MB but sends the
// events StackDash maps far smaller), and small enough that a flood of large bodies stays cheap.
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Verified deliveries one per-connection URL is answered in a minute, sized from the drain: a tick
 * runs every minute and applies up to WEBHOOK_TICK_CLAIM_LIMIT (50) webhook jobs
 * (src/lib/jobs/runner.ts), so one endpoint at this limit queues about one tick of that shared
 * allowance a minute, never many ticks of it. A busy account's real burst (a monorepo deploying
 * every project at once sends a few dozen) fits under it, and anything over is answered 429, which
 * the provider retries.
 */
export const WEBHOOK_ENDPOINT_DELIVERIES_PER_MINUTE = 60;

const NO_STORE = { "Cache-Control": "no-store" };

/** Everything the receiver touches, injected so unit tests run without a database or the network. */
export type ReceiveDeps = Readonly<{
  // Null when the provider is not available on this instance (the fake provider with its flag off).
  getAdapter: (id: ProviderId) => ProviderAdapter | null;
  // Read per request, so a secret is never baked into a build.
  readEnv: (name: string) => string | undefined;
  loadWebhookEndpoint: (endpointId: string) => Promise<WebhookEndpoint | null>;
  // Counts one verified delivery to a per-connection endpoint and returns how many it has had in
  // the current minute, this one included.
  countEndpointDelivery: (endpointId: string) => Promise<number>;
  recordWebhookDelivery: (input: RecordWebhookDeliveryInput) => Promise<boolean>;
  adapterContext: () => AdapterContext;
  now: () => Date;
  log: Logger;
  logError: (event: string, error: unknown, fields?: LogFields) => string;
}>;

export type ReceiveInput = Readonly<{
  provider: string;
  // Null for the app-level URL.
  endpointId: string | null;
  request: Request;
}>;

function json(status: number, body: Readonly<Record<string, string>>): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

// One answer for an unknown provider, a provider without webhooks, the wrong URL shape, and an
// unknown endpoint, so the route says nothing about which providers or endpoints exist.
function notFound(): Response {
  return json(404, { error: "not_found" });
}

/**
 * The body as bytes, or null when it is over the cap. A declared `Content-Length` over the cap is
 * refused before reading; the read is capped too, because the header is optional and can lie.
 */
async function readWebhookBody(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > WEBHOOK_MAX_BODY_BYTES) return null;
  return readBoundedRequestBody(request, WEBHOOK_MAX_BODY_BYTES);
}

type SecretResult = Readonly<{ ok: true; secret: Secret; endpointId: string | null }> | Readonly<{ ok: false; response: Response }>;

async function resolveSecret(
  provider: ProviderId,
  registration: WebhookRegistration,
  endpointId: string | null,
  deps: ReceiveDeps,
): Promise<SecretResult> {
  if (registration.kind === "app") {
    const value = deps.readEnv(registration.secretEnv);
    if (value === undefined || value.trim() === "") {
      // The instance enabled a provider's push path without its secret: a person must set it.
      // Logged by variable name, which is not secret.
      deps.log.error("webhook.secret_missing", { provider, secretEnv: registration.secretEnv });
      return { ok: false, response: json(503, { error: "not_configured" }) };
    }
    return { ok: true, secret: new Secret(value), endpointId: null };
  }
  if (endpointId === null) return { ok: false, response: notFound() };
  const endpoint = await deps.loadWebhookEndpoint(endpointId);
  if (endpoint === null || endpoint.provider !== provider) return { ok: false, response: notFound() };
  return { ok: true, secret: endpoint.secret, endpointId: endpoint.id };
}

type EventCheck = Readonly<{ ok: true; events: ActivityEvent[] }> | Readonly<{ ok: false; issues: string[] }>;

/**
 * A delivery's events, checked like a sync's: declared types, the event schema, and every event
 * belonging to the delivery's own account.
 */
function checkEvents(adapter: ProviderAdapter, externalAccountId: string, candidates: readonly unknown[]): EventCheck {
  const validated = validateAdapterEvents(adapter.eventTypes, candidates);
  // Issue paths only: a message or value could quote the delivery.
  if (!validated.ok) return { ok: false, issues: validated.issues.map((issue) => `${issue.index}.${issue.path}`) };
  const foreign = validated.items.flatMap((event, index) =>
    event.externalAccountId === externalAccountId ? [] : [`${index}.externalAccountId`],
  );
  return foreign.length > 0 ? { ok: false, issues: foreign } : { ok: true, events: validated.items };
}

export async function receiveWebhook(input: ReceiveInput, deps: ReceiveDeps): Promise<Response> {
  const parsedProvider = ProviderIdSchema.safeParse(input.provider);
  if (!parsedProvider.success) return notFound();
  const provider = parsedProvider.data;
  const adapter = deps.getAdapter(provider);
  if (adapter === null || adapter.webhooks === undefined) return notFound();
  const descriptor = adapter.webhooks;
  const appLevelUrl = input.endpointId === null;
  if ((descriptor.registration.kind === "app") !== appLevelUrl) return notFound();

  try {
    const rawBody = await readWebhookBody(input.request);
    if (rawBody === null) return json(413, { error: "payload_too_large" });

    const resolved = await resolveSecret(provider, descriptor.registration, input.endpointId, deps);
    if (!resolved.ok) return resolved.response;

    const request: WebhookRequest = { headers: input.request.headers, rawBody };
    const verification = descriptor.verify(request, resolved.secret, deps.now());
    if (!verification.ok) {
      deps.log.warn("webhook.rejected", { provider, reason: verification.reason, endpointId: input.endpointId });
      return json(401, { error: "unauthorized" });
    }
    const { deliveryId } = verification;
    const fields = { provider, deliveryId, endpointId: resolved.endpointId };
    if (resolved.endpointId !== null) {
      const count = await deps.countEndpointDelivery(resolved.endpointId);
      if (count > WEBHOOK_ENDPOINT_DELIVERIES_PER_MINUTE) {
        deps.log.warn("webhook.rate_limited", { provider, endpointId: resolved.endpointId });
        const retryAfterSeconds = secondsUntilNextMinute(deps.now());
        return Response.json({ error: "rate_limited" }, { status: 429, headers: rateLimitedHeaders({ retryAfterSeconds }) });
      }
    }

    let outcome: WebhookOutcome;
    try {
      outcome = descriptor.parse(request, deps.adapterContext());
    } catch (error) {
      // The error's name only, never its message, stack, or cause: those can quote the body.
      const errorName = error instanceof Error ? error.name : typeof error;
      const referenceId = deps.logError("webhook.parse_failed", new Error(`${provider} webhook parse threw`), { ...fields, errorName });
      return json(400, { error: "bad_request", referenceId });
    }
    if (outcome.kind === "events") {
      const checked = checkEvents(adapter, outcome.externalAccountId, outcome.events);
      if (!checked.ok) {
        const referenceId = deps.logError("webhook.invalid_events", new Error(`${provider} webhook parse returned invalid events`), {
          ...fields,
          issues: checked.issues,
        });
        return json(422, { error: "invalid_events", referenceId });
      }
      outcome = { ...outcome, events: checked.events };
    }

    const recorded = await deps.recordWebhookDelivery({ provider, deliveryId, endpointId: resolved.endpointId, outcome });
    if (!recorded) {
      deps.log.info("webhook.duplicate", { provider, deliveryId });
      return json(200, { status: "duplicate" });
    }
    deps.log.info("webhook.accepted", { ...fields, kind: outcome.kind });
    return json(202, { status: "accepted" });
  } catch (error) {
    // A store failure or a dropped body stream: the provider retries the delivery, and
    // deduplication absorbs any repeat.
    const referenceId = deps.logError("webhook.failed", error, { provider, endpointId: input.endpointId });
    return json(500, { error: "internal_error", referenceId });
  }
}

/**
 * Production `countEndpointDelivery`: the public routes' per-minute counter, keyed by an HMAC of
 * the endpoint id under a key derived for this purpose alone (the counter table accepts only a
 * SHA-256 hex digest).
 */
async function countEndpointDelivery(endpointId: string): Promise<number> {
  const key = createHmac("sha256", derivedKey("webhook-endpoint-rate-limit")).update(endpointId).digest("hex");
  const { data, error } = await createAdminClient().rpc("bump_public_rate_limit", { p_ip_hash: key });
  if (error) throw new Error("Failed to count a webhook delivery", { cause: error });
  return data;
}

/** Production wiring for both webhook routes: the adapter registry, Postgres, and the real clock. */
export function createReceiveDeps(): ReceiveDeps {
  const store = createSupabaseJobStore();
  return {
    // The fake provider exists only when its flag is on; otherwise its URL is as unknown as any.
    getAdapter: (id) => (id === "fake" && !isFakeProviderEnabled() ? null : getAdapter(id)),
    readEnv: (name) => process.env[name],
    loadWebhookEndpoint,
    countEndpointDelivery,
    recordWebhookDelivery: (input) => store.recordWebhookDelivery(input),
    adapterContext: createAdapterContext,
    now: () => new Date(),
    log,
    logError,
  };
}
