import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { headers } from "next/headers";
import { z } from "zod";

import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import { ProviderIdSchema, type ProviderId } from "@/lib/adapters/types";
import { decryptSecret, encryptSecret } from "@/lib/crypto/credentials";
import { fromBytea, toBytea } from "@/lib/data/credentials";
import { REFERENCE_ID_PATTERN } from "@/lib/log/reference";
import { createAdminClient } from "@/lib/supabase/admin";

/*
 * OAuth `state` for provider connections (#40). One `oauth_states` row per in-flight flow, created
 * by the start route and deleted by the callback in the same statement that reads it, so a state
 * works once. The token itself is 32 random bytes and carries nothing: the flow context (the
 * connection being reconnected, GitHub's pending installation id, the PKCE verifier sealed with
 * the app key and bound to its state) lives in the row.
 */

export const OAUTH_STATE_TTL_SECONDS = 600;

const RANDOM_BYTES = 32;
// base64url of 32 bytes, no padding.
const STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** A fresh state token: 32 random bytes, base64url. */
export function newStateToken(): string {
  return randomBytes(RANDOM_BYTES).toString("base64url");
}

/** True for a value shaped like a token this server makes; anything else skips the database. */
export function isStateToken(value: string): boolean {
  return STATE_PATTERN.test(value);
}

export type PkcePair = Readonly<{ verifier: string; challenge: string }>;

/** RFC 7636 S256: a 43 character verifier from 32 random bytes and its SHA-256 challenge. */
export function createPkcePair(): PkcePair {
  const verifier = randomBytes(RANDOM_BYTES).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Origin the provider sends the browser back to: NEXT_PUBLIC_SITE_URL when it is a valid http(s)
 * URL (behind a proxy the request origin can be internal), otherwise the request's own origin.
 * The start route and the callback both call this, so the two redirect URIs always match.
 */
export function connectOrigin(requestUrl: string, siteUrl: string | undefined): string {
  if (siteUrl !== undefined && siteUrl.trim() !== "") {
    try {
      const site = new URL(siteUrl);
      if (site.protocol === "https:" || site.protocol === "http:") return site.origin;
    } catch {
      // Fall through to the request origin.
    }
  }
  return new URL(requestUrl).origin;
}

/**
 * This deployment's public origin while rendering a page or metadata route, which has no request
 * URL: NEXT_PUBLIC_SITE_URL when set, otherwise the origin the request reached, from the proxy's
 * forwarded host when there is one.
 */
export async function requestPublicOrigin(): Promise<string> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "http";
  return connectOrigin(`${protocol}://${host}`, process.env.NEXT_PUBLIC_SITE_URL);
}

export function callbackRedirectUri(origin: string, provider: ProviderId): string {
  return new URL(`/api/connections/${provider}/callback`, origin).href;
}

export function stateExpiresAt(now: Date): Date {
  return new Date(now.getTime() + OAUTH_STATE_TTL_SECONDS * 1000);
}

export function isStateExpired(expiresAt: Date, now: Date): boolean {
  return expiresAt.getTime() <= now.getTime();
}

function verifierAad(state: string): string {
  return `oauth_state:${state}`;
}

export type CreateStateInput = Readonly<{
  state: string;
  workspaceId: string;
  provider: ProviderId;
  userId: string;
  // Present only for providers that use PKCE.
  codeVerifier?: string;
  reconnectId?: string;
  // GitHub second step only: the installation from the first step, still untrusted.
  pendingInstallationId?: string;
  // The user chose automatic webhook setup (#426): the callback creates the webhook once the
  // grant with its extra scopes is stored.
  webhookSetup?: boolean;
  now: Date;
}>;

/** Stores a state row. The caller must have authorized the user for the workspace first. */
export async function createOAuthState(input: CreateStateInput): Promise<void> {
  const sealed = input.codeVerifier === undefined ? null : encryptSecret(input.codeVerifier, verifierAad(input.state));
  const { error } = await createAdminClient()
    .from("oauth_states")
    .insert({
      state: input.state,
      workspace_id: input.workspaceId,
      provider: input.provider,
      user_id: input.userId,
      code_verifier_iv: sealed === null ? null : toBytea(sealed.iv),
      code_verifier_ciphertext: sealed === null ? null : toBytea(sealed.ciphertext),
      code_verifier_tag: sealed === null ? null : toBytea(sealed.authTag),
      key_id: sealed?.keyId ?? null,
      reconnect_connection_id: input.reconnectId ?? null,
      pending_installation_id: input.pendingInstallationId ?? null,
      webhook_setup: input.webhookSetup ?? false,
      expires_at: stateExpiresAt(input.now).toISOString(),
    });
  if (error) throw new Error(`oauth_states insert failed (code ${error.code}).`);
}

export type ConsumedState = Readonly<{
  workspaceId: string;
  provider: ProviderId;
  userId: string;
  codeVerifier: string | undefined;
  reconnectId: string | undefined;
  pendingInstallationId: string | undefined;
  webhookSetup: boolean;
  expiresAt: Date;
}>;

/**
 * Deletes the state row and returns what it held, in one statement, so two requests with the same
 * state can never both succeed. Null when no such row exists (unknown, forged, or already used).
 * Expiry is the caller's check, because an expired row is still deleted here.
 */
export async function consumeOAuthState(state: string): Promise<ConsumedState | null> {
  if (!isStateToken(state)) return null;
  const { data, error } = await createAdminClient()
    .from("oauth_states")
    .delete()
    .eq("state", state)
    .select(
      "workspace_id, provider, user_id, code_verifier_iv, code_verifier_ciphertext, code_verifier_tag, key_id, reconnect_connection_id, pending_installation_id, webhook_setup, expires_at",
    )
    .maybeSingle();
  if (error) throw new Error(`oauth_states consume failed (code ${error.code}).`);
  if (data === null) return null;

  let codeVerifier: string | undefined;
  if (
    data.key_id !== null &&
    data.code_verifier_iv !== null &&
    data.code_verifier_ciphertext !== null &&
    data.code_verifier_tag !== null
  ) {
    codeVerifier = decryptSecret(
      {
        keyId: data.key_id,
        iv: fromBytea(data.code_verifier_iv),
        ciphertext: fromBytea(data.code_verifier_ciphertext),
        authTag: fromBytea(data.code_verifier_tag),
      },
      verifierAad(state),
    );
  }
  return {
    workspaceId: data.workspace_id,
    provider: data.provider,
    userId: data.user_id,
    codeVerifier,
    reconnectId: data.reconnect_connection_id ?? undefined,
    pendingInstallationId: data.pending_installation_id ?? undefined,
    webhookSetup: data.webhook_setup,
    expiresAt: new Date(data.expires_at),
  };
}

/*
 * Outcomes the routes report back to the connections pages through the query string. Only these
 * fixed codes travel, never provider error text, and the page turns them into copy.
 */
export const connectErrorCodes = [
  "cancelled",
  "expired",
  "invalid",
  "not_configured",
  "consent_required",
  "forbidden",
  "approval_pending",
  "provider_error",
  "failed",
  "reconnect_real_connection",
  "reconnect_simulated_connection",
] as const;

export const ConnectErrorCodeSchema = z.enum(connectErrorCodes);
export type ConnectErrorCode = z.infer<typeof ConnectErrorCodeSchema>;

export const ConnectFeedbackSchema = z.object({
  error: ConnectErrorCodeSchema,
  provider: ProviderIdSchema.optional(),
  ref: z.string().regex(REFERENCE_ID_PATTERN).optional(),
});

export type ConnectFeedback = z.infer<typeof ConnectFeedbackSchema>;

export type ReconnectMismatchCode = Extract<ConnectErrorCode, "reconnect_real_connection" | "reconnect_simulated_connection">;

/**
 * Why reconnecting `connection` through the provider simulator (`throughSimulator`), or through a
 * real provider app, is refused, or null when the two match (#131). A reconnect overwrites the
 * credential, scopes, and accounts of the connection, so a real connection would end up holding
 * made-up data next to its real history, or the reverse, with no way to tell them apart afterwards.
 */
export function reconnectMismatch(
  connection: Readonly<{ granted_scopes: readonly string[] }>,
  throughSimulator: boolean,
): ReconnectMismatchCode | null {
  const simulatedConnection = isSimulatedConnection(connection);
  if (simulatedConnection === throughSimulator) return null;
  return simulatedConnection ? "reconnect_simulated_connection" : "reconnect_real_connection";
}

/** Query string for a connect outcome, for the routes to append to a page URL. */
export function connectFeedbackQuery(feedback: ConnectFeedback): string {
  const params = new URLSearchParams({ error: feedback.error });
  if (feedback.provider !== undefined) params.set("provider", feedback.provider);
  if (feedback.ref !== undefined) params.set("ref", feedback.ref);
  return params.toString();
}

/** User-facing copy for a connect outcome: what happened and what to do next. */
export function connectErrorMessage(code: ConnectErrorCode, providerName: string): string {
  switch (code) {
    case "cancelled":
      return `You cancelled connecting ${providerName}. Nothing was saved. Connect again whenever you are ready.`;
    case "expired":
      return `The request to connect ${providerName} expired or was already used. Start connecting again.`;
    case "invalid":
      return `That request to connect ${providerName} could not be checked, so nothing was saved. Start connecting again from this page.`;
    case "not_configured":
      return `${providerName} is not set up on this instance. Ask the person who runs this StackDash instance to register the ${providerName} app.`;
    case "consent_required":
      return `Confirm that you understand the full access ${providerName} grants before continuing.`;
    case "forbidden":
      return "Only owners and admins can connect providers. Ask one of them to connect it.";
    case "approval_pending":
      return `Waiting for an organization owner to approve the StackDash ${providerName} App. Connect again once they approve it.`;
    case "provider_error":
      return `${providerName} did not finish connecting, so nothing was saved. Try again, and if it keeps failing, check the app registration.`;
    case "failed":
      return `Connecting ${providerName} failed on our side, so nothing was saved. Try again in a moment.`;
    case "reconnect_real_connection":
      return `This connection was made with the real ${providerName} app. Connect a new simulated one instead.`;
    case "reconnect_simulated_connection":
      return `This connection was made with the simulated ${providerName}. Connect a new real one instead.`;
  }
}
