import "server-only";

import { z } from "zod";

import { Secret, type ProviderId, type WebhookSource } from "@/lib/adapters/types";
import { decryptSecret, DecryptionFailedError, encryptSecret, UnknownEncryptionKeyError } from "@/lib/crypto/credentials";
import { encryptedFromRow, encryptedToColumns } from "@/lib/data/credentials";
import { log } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

/*
 * Repository for `webhook_endpoints` (#28, #426): the per-connection URL of a provider whose
 * webhook is set up per account (`/api/webhooks/<provider>/<endpoint id>`), the secret that
 * verifies its deliveries, sealed like connection credentials (#35), and how it was set up; and for
 * `webhook_sources` (#428): the resources (GitLab projects) of an endpoint whose provider keeps one
 * webhook per resource, with the webhook StackDash created there and the last delivery from it.
 * Both tables have RLS enabled, no policies, and no grants for anon or authenticated, so only the
 * service role reaches them. Callers must have authorized the user for the workspace: as an admin
 * to create, change, or delete an endpoint, as a member to read its setup.
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
    | Readonly<{ mode: "automatic"; providerWebhookId: string }>
    // Automatic setup with one webhook per source: their ids go to `webhook_sources`.
    | Readonly<{ mode: "automatic"; perSource: true }>;
}>;

/** How a connection's webhook is set up, for its page; never the secret. */
export type ConnectionWebhook = Readonly<{
  id: string;
  setupMode: WebhookSetupMode;
  // Automatic setup that created one webhook per source (webhook_sources) rather than one in all.
  perSource: boolean;
  // Manual setup of a provider that generates the signing secret, until the user pastes it.
  awaitingProviderSecret: boolean;
  // Received deliveries are kept 30 days (purge_webhook_deliveries), so older ones are not seen.
  lastDeliveryAt: Date | null;
}>;

/** One source of an endpoint (a GitLab project), for its setup panel and for automatic setup. */
export type StoredWebhookSource = Readonly<{
  sourceId: string;
  name: string;
  // The webhook StackDash created there, or null for a source known only from its deliveries.
  providerWebhookId: string | null;
  lastDeliveryAt: Date | null;
}>;

/**
 * Sources one endpoint may hold, the limit webhook_sources_enforce_limit applies
 * (supabase/migrations/20261116150000_webhook_sources.sql), so a stream of deliveries naming new
 * resources cannot grow the table without bound.
 */
export const WEBHOOK_SOURCES_PER_ENDPOINT = 100;

/** The endpoint holds WEBHOOK_SOURCES_PER_ENDPOINT sources already (webhook_sources_enforce_limit). */
export class WebhookSourceLimitError extends Error {
  override readonly name = "WebhookSourceLimitError";
}

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
    provider_webhook_id: "providerWebhookId" in setup ? setup.providerWebhookId : null,
    per_source: "perSource" in setup,
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
    .select("id, setup_mode, per_source, awaiting_provider_secret")
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
    perSource: data.per_source,
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

function sourceFromRow(row: { source_id: string; source_name: string; provider_webhook_id: string | null; last_delivery_at: string | null }): StoredWebhookSource {
  return {
    sourceId: row.source_id,
    name: row.source_name,
    providerWebhookId: row.provider_webhook_id,
    lastDeliveryAt: row.last_delivery_at === null ? null : new Date(row.last_delivery_at),
  };
}

/** The endpoint's sources by name, at most WEBHOOK_SOURCES_PER_ENDPOINT (the table holds no more). */
export async function listWebhookSources(endpointId: string): Promise<StoredWebhookSource[]> {
  const { data, error } = await createAdminClient()
    .from("webhook_sources")
    .select("source_id, source_name, provider_webhook_id, last_delivery_at")
    .eq("endpoint_id", endpointId)
    .order("source_name", { ascending: true })
    .order("source_id", { ascending: true })
    .limit(WEBHOOK_SOURCES_PER_ENDPOINT);
  if (error) throw new Error(`webhook_sources select failed (code ${error.code}).`);
  return data.map(sourceFromRow);
}

/**
 * Records the webhook automatic setup created on a source, keeping any delivery already seen from
 * it. Throws WebhookSourceLimitError for a new source past the endpoint's limit.
 */
export async function saveCreatedWebhookSource({
  endpointId,
  source,
  providerWebhookId,
}: Readonly<{ endpointId: string; source: WebhookSource; providerWebhookId: string }>): Promise<void> {
  const { error } = await createAdminClient()
    .from("webhook_sources")
    .upsert(
      { endpoint_id: endpointId, source_id: source.id, source_name: source.name, provider_webhook_id: providerWebhookId },
      { onConflict: "endpoint_id,source_id" },
    );
  if (error?.code === PROGRAM_LIMIT_EXCEEDED) throw new WebhookSourceLimitError("The webhook endpoint has as many sources as it may.");
  if (error) throw new Error(`webhook_sources upsert failed (code ${error.code}).`);
}

/**
 * Notes that a verified delivery to the endpoint came from `source`, for the setup panel. False
 * when the source is new and the endpoint is at its limit: the delivery itself is unaffected.
 */
export async function recordWebhookSource({
  endpointId,
  source,
  receivedAt,
}: Readonly<{ endpointId: string; source: WebhookSource; receivedAt: Date }>): Promise<boolean> {
  const { error } = await createAdminClient().rpc("record_webhook_source", {
    p_endpoint_id: endpointId,
    p_source_id: source.id,
    p_source_name: source.name,
    p_received_at: receivedAt.toISOString(),
  });
  if (error?.code === PROGRAM_LIMIT_EXCEEDED) return false;
  if (error) throw new Error(`record_webhook_source failed (code ${error.code}).`);
  return true;
}

export type RemovedWebhookEndpoint = Readonly<{
  setupMode: WebhookSetupMode;
  providerWebhookId: string | null;
  // The webhooks StackDash created per source, to delete at the provider.
  sourceWebhooks: readonly Readonly<{ sourceId: string; providerWebhookId: string }>[];
}>;

/**
 * Deletes the connection's endpoint, so its URL answers like an unknown one and any delivery still
 * sent to it is dropped. Returns what was deleted, or null when there was none. The sources go
 * first, returning the webhooks StackDash created on them, because deleting the endpoint would
 * take them by cascade without saying which.
 */
export async function deleteWebhookEndpoint(workspaceId: string, connectionId: string): Promise<RemovedWebhookEndpoint | null> {
  const supabase = createAdminClient();
  const { data: endpoint, error: lookupError } = await supabase
    .from("webhook_endpoints")
    .select("id")
    .eq("workspace_id", workspaceId)
    .eq("connection_id", connectionId)
    .maybeSingle();
  if (lookupError) throw failure("select", lookupError);
  if (endpoint === null) return null;

  const { data: sources, error: sourcesError } = await supabase
    .from("webhook_sources")
    .delete()
    .eq("endpoint_id", endpoint.id)
    .not("provider_webhook_id", "is", null)
    .select("source_id, provider_webhook_id");
  if (sourcesError) throw new Error(`webhook_sources delete failed (code ${sourcesError.code}).`);

  const { data, error } = await supabase
    .from("webhook_endpoints")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("connection_id", connectionId)
    .select("setup_mode, provider_webhook_id")
    .maybeSingle();
  if (error) throw failure("delete", error);
  if (data === null) return null;
  return {
    setupMode: data.setup_mode,
    providerWebhookId: data.provider_webhook_id,
    sourceWebhooks: sources.flatMap((row) =>
      row.provider_webhook_id === null ? [] : [{ sourceId: row.source_id, providerWebhookId: row.provider_webhook_id }],
    ),
  };
}
