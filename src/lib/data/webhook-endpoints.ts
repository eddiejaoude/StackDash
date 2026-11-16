import "server-only";

import { z } from "zod";

import { Secret, type ProviderId } from "@/lib/adapters/types";
import { decryptSecret, DecryptionFailedError, encryptSecret, UnknownEncryptionKeyError } from "@/lib/crypto/credentials";
import { encryptedFromRow, encryptedToColumns } from "@/lib/data/credentials";
import { log } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

/*
 * Repository for `webhook_endpoints` (#28, #426): the per-connection URL of a provider whose
 * webhook is set up per account (`/api/webhooks/<provider>/<endpoint id>`), the secret that
 * verifies its deliveries, sealed like connection credentials (#35), and how it was set up. The
 * table has RLS enabled, no policies, and no grants for anon or authenticated, so only the service
 * role reaches it. Callers must have authorized the user for the workspace: as an admin to create,
 * change, or delete an endpoint, as a member to read its setup.
 *
 * The secret never leaves this module except wrapped in `Secret`, and is never logged. Errors
 * carry the Postgres error code only, never row data.
 */

export type WebhookEndpoint = Readonly<{
  id: string;
  provider: ProviderId;
  workspaceId: string;
  connectionId: string;
  secret: Secret;
}>;

export type WebhookSetupMode = Database["public"]["Enums"]["webhook_setup_mode"];

export type NewWebhookEndpoint = Readonly<{
  // Chosen by the caller, so automatic setup can give the provider the URL before the row exists.
  id: string;
  workspaceId: string;
  connectionId: string;
  provider: ProviderId;
  secret: Secret;
  setup:
    | Readonly<{ mode: "manual"; awaitingProviderSecret: boolean }>
    | Readonly<{ mode: "automatic"; providerWebhookId: string }>;
}>;

/** How a connection's webhook is set up, for its page; never the secret. */
export type ConnectionWebhook = Readonly<{
  id: string;
  setupMode: WebhookSetupMode;
  // Manual setup of a provider that generates the signing secret, until the user pastes it.
  awaitingProviderSecret: boolean;
  // Received deliveries are kept 30 days (purge_webhook_deliveries), so older ones are not seen.
  lastDeliveryAt: Date | null;
}>;

/** The workspace holds WEBHOOK_ENDPOINTS_PER_WORKSPACE endpoints already (webhook_endpoints_enforce_limit). */
export class WebhookEndpointLimitError extends Error {
  override readonly name = "WebhookEndpointLimitError";
}

/** The connection has an endpoint already: a second setup raced the first. */
export class WebhookEndpointExistsError extends Error {
  override readonly name = "WebhookEndpointExistsError";
}

// Raised by webhook_endpoints_enforce_limit, and by the unique key on connection_id.
const PROGRAM_LIMIT_EXCEEDED = "54000";
const UNIQUE_VIOLATION = "23505";

function failure(operation: string, error: { code: string }): Error {
  return new Error(`webhook_endpoints ${operation} failed (code ${error.code}).`);
}

function sealSecret(secret: Secret, workspaceId: string, connectionId: string) {
  const plaintext = JSON.stringify({ v: 1, secret: secret.reveal() });
  return encryptedToColumns(encryptSecret(plaintext, webhookEndpointSecretAad(workspaceId, connectionId)));
}

/**
 * Associated data that binds a sealed secret to its row. A connection has at most one endpoint,
 * so the connection names the row; the prefix keeps a connection credential, sealed under
 * `workspaceId:connectionId`, from decrypting here if it were copied in.
 */
export function webhookEndpointSecretAad(workspaceId: string, connectionId: string): string {
  return `webhook_endpoint:${workspaceId}:${connectionId}`;
}

// Versioned like the credential shape, so a later change is migrated rather than misread.
const sealedSecretSchema = z.strictObject({ v: z.literal(1), secret: z.string().min(1) });

// The route hands over the URL's path segment as it came. Postgres refuses text that is not a
// uuid with an error (22P02), so anything else is an unknown endpoint before it reaches the query.
const EndpointIdSchema = z.guid();

/**
 * Creates the connection's endpoint. Throws WebhookEndpointLimitError when the workspace is at its
 * limit and WebhookEndpointExistsError when the connection has an endpoint already.
 */
export async function insertWebhookEndpoint({ id, workspaceId, connectionId, provider, secret, setup }: NewWebhookEndpoint): Promise<void> {
  const supabase = createAdminClient();

  // The service role bypasses RLS, so confirm the connection is this workspace's and this
  // provider's before attaching a secret to it. The composite foreign key repeats the workspace
  // check in the database.
  const { data: connection, error: lookupError } = await supabase
    .from("connections")
    .select("id")
    .eq("id", connectionId)
    .eq("workspace_id", workspaceId)
    .eq("provider", provider)
    .maybeSingle();
  if (lookupError) throw failure("connection lookup", lookupError);
  if (connection === null) {
    throw new Error("Cannot create a webhook endpoint: the connection does not belong to this workspace and provider.");
  }

  const { error } = await supabase.from("webhook_endpoints").insert({
    id,
    workspace_id: workspaceId,
    connection_id: connectionId,
    provider,
    setup_mode: setup.mode,
    provider_webhook_id: setup.mode === "automatic" ? setup.providerWebhookId : null,
    awaiting_provider_secret: setup.mode === "manual" && setup.awaitingProviderSecret,
    ...sealSecret(secret, workspaceId, connectionId),
  });
  if (error?.code === PROGRAM_LIMIT_EXCEEDED) throw new WebhookEndpointLimitError("The workspace has as many webhook endpoints as it may.");
  if (error?.code === UNIQUE_VIOLATION) throw new WebhookEndpointExistsError("The connection has a webhook endpoint already.");
  if (error) throw failure("insert", error);
}

/**
 * Seals a new secret into the connection's endpoint, keeping its id, so the URL the provider holds
 * keeps working, and marks a pasted provider secret as received. False when the connection has no
 * endpoint.
 */
export async function replaceWebhookEndpointSecret({
  workspaceId,
  connectionId,
  secret,
}: Readonly<{ workspaceId: string; connectionId: string; secret: Secret }>): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .from("webhook_endpoints")
    .update({ awaiting_provider_secret: false, ...sealSecret(secret, workspaceId, connectionId) })
    .eq("workspace_id", workspaceId)
    .eq("connection_id", connectionId)
    .select("id");
  if (error) throw failure("update", error);
  return data.length > 0;
}

/**
 * The endpoint a delivery was sent to, with its secret decrypted, or null when there is no such
 * endpoint (including an id that is not a uuid) or its secret cannot be read: the key is not
 * configured or the record fails authentication. Either way the delivery cannot be verified, so
 * the route refuses it like an unknown endpoint. Only the webhook route may call this, and never
 * log the result.
 */
export async function loadWebhookEndpoint(endpointId: string): Promise<WebhookEndpoint | null> {
  if (!EndpointIdSchema.safeParse(endpointId).success) return null;

  const { data, error } = await createAdminClient()
    .from("webhook_endpoints")
    .select("id, workspace_id, connection_id, provider, key_id, iv, ciphertext, auth_tag")
    .eq("id", endpointId)
    .maybeSingle();
  if (error) throw failure("select", error);
  if (data === null) return null;

  let plaintext: string;
  try {
    plaintext = decryptSecret(encryptedFromRow(data), webhookEndpointSecretAad(data.workspace_id, data.connection_id));
  } catch (decryptError) {
    if (decryptError instanceof UnknownEncryptionKeyError || decryptError instanceof DecryptionFailedError) {
      // Every delivery to it is refused until the secret is set again, so an operator must know.
      log.warn("webhook_endpoint.secret_unreadable", { endpointId: data.id, keyId: decryptError.keyId });
      return null;
    }
    throw decryptError;
  }
  const parsed = sealedSecretSchema.safeParse(JSON.parse(plaintext));
  // Only that the shape is wrong: zod issues would echo the secret.
  if (!parsed.success) throw new Error("Decrypted webhook endpoint secret has an unexpected shape.");

  return {
    id: data.id,
    provider: data.provider,
    workspaceId: data.workspace_id,
    connectionId: data.connection_id,
    secret: new Secret(parsed.data.secret),
  };
}

/** The connection's webhook setup and when its last delivery arrived, or null when it has none. */
export async function getConnectionWebhook(workspaceId: string, connectionId: string): Promise<ConnectionWebhook | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("webhook_endpoints")
    .select("id, setup_mode, awaiting_provider_secret")
    .eq("workspace_id", workspaceId)
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (error) throw failure("select", error);
  if (data === null) return null;

  // webhook_deliveries_endpoint_received_at_idx answers this from the index's first entry.
  const { data: last, error: lastError } = await supabase
    .from("webhook_deliveries")
    .select("received_at")
    .eq("endpoint_id", data.id)
    .order("received_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw new Error(`webhook_deliveries select failed (code ${lastError.code}).`);

  return {
    id: data.id,
    setupMode: data.setup_mode,
    awaitingProviderSecret: data.awaiting_provider_secret,
    lastDeliveryAt: last === null ? null : new Date(last.received_at),
  };
}

/** How many endpoints the workspace holds, for the setup panel to say when it is at its limit. */
export async function countWorkspaceWebhookEndpoints(workspaceId: string): Promise<number> {
  const { count, error } = await createAdminClient()
    .from("webhook_endpoints")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  if (error) throw failure("count", error);
  return count ?? 0;
}

export type RemovedWebhookEndpoint = Readonly<{ setupMode: WebhookSetupMode; providerWebhookId: string | null }>;

/**
 * Deletes the connection's endpoint, so its URL answers like an unknown one and any delivery still
 * sent to it is dropped. Returns what was deleted, or null when there was none.
 */
export async function deleteWebhookEndpoint(workspaceId: string, connectionId: string): Promise<RemovedWebhookEndpoint | null> {
  const { data, error } = await createAdminClient()
    .from("webhook_endpoints")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("connection_id", connectionId)
    .select("setup_mode, provider_webhook_id")
    .maybeSingle();
  if (error) throw failure("delete", error);
  return data === null ? null : { setupMode: data.setup_mode, providerWebhookId: data.provider_webhook_id };
}
