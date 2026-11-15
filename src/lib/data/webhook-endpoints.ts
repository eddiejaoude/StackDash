import "server-only";

import { z } from "zod";

import { Secret, type ProviderId } from "@/lib/adapters/types";
import { decryptSecret, DecryptionFailedError, encryptSecret, UnknownEncryptionKeyError } from "@/lib/crypto/credentials";
import { encryptedFromRow, encryptedToColumns } from "@/lib/data/credentials";
import { log } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/*
 * Repository for `webhook_endpoints` (#28): the per-connection URL of a provider whose webhook is
 * set up per account (`/api/webhooks/<provider>/<endpoint id>`), and the secret that verifies its
 * deliveries, sealed like connection credentials (#35). The table has RLS enabled, no policies,
 * and no grants for anon or authenticated, so only the service role reaches it. Callers that
 * create an endpoint must have authorized the user as an admin of the workspace.
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

export type NewWebhookEndpoint = Readonly<{
  workspaceId: string;
  connectionId: string;
  provider: ProviderId;
  secret: Secret;
}>;

function failure(operation: string, error: { code: string }): Error {
  return new Error(`webhook_endpoints ${operation} failed (code ${error.code}).`);
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
 * Creates the connection's endpoint and returns its id, or seals a new secret into the endpoint
 * the connection already has and returns that id: the URL the provider holds keeps working.
 */
export async function createWebhookEndpoint({ workspaceId, connectionId, provider, secret }: NewWebhookEndpoint): Promise<string> {
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

  const plaintext = JSON.stringify({ v: 1, secret: secret.reveal() });
  const sealed = encryptedToColumns(encryptSecret(plaintext, webhookEndpointSecretAad(workspaceId, connectionId)));
  const { data, error } = await supabase
    .from("webhook_endpoints")
    .upsert({ workspace_id: workspaceId, connection_id: connectionId, provider, ...sealed }, { onConflict: "connection_id" })
    .select("id")
    .single();
  if (error) throw failure("upsert", error);
  return data.id;
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
