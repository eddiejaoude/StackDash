import "server-only";

import type { OAuthCredential } from "@/lib/adapters/types";
import {
  credentialAad,
  decryptCredential,
  encryptCredential,
  type EncryptedSecret,
} from "@/lib/crypto/credentials";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

/*
 * Repository for `connection_credentials` (issue #35). The table has RLS enabled, no policies, and
 * no grants for anon or authenticated, so only the service role can reach it. Callers must have
 * authorized the user (for example `requireWorkspace(slug, "admin")`) before saving or deleting.
 *
 * Credential material never leaves this module except as the decrypted `OAuthCredential`, whose
 * tokens are `Secret`s that serialize as [redacted]. Errors thrown here carry only the Postgres
 * error code, never row data.
 */

type CredentialRow = Database["public"]["Tables"]["connection_credentials"]["Row"];

// PostgREST serializes bytea as Postgres hex text (`\x0a1b...`) in both directions. supabase-js
// types those columns as `string`, so the conversion to and from Buffer is explicit here.
const BYTEA_PREFIX = "\\x";

export function toBytea(buffer: Buffer): string {
  return `${BYTEA_PREFIX}${buffer.toString("hex")}`;
}

export function fromBytea(value: string): Buffer {
  if (!value.startsWith(BYTEA_PREFIX)) {
    throw new Error("Expected a bytea value in Postgres hex format.");
  }
  const hex = value.slice(BYTEA_PREFIX.length);
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("Bytea value is not valid hex.");
  }
  return Buffer.from(hex, "hex");
}

export function encryptedFromRow(
  row: Pick<CredentialRow, "key_id" | "iv" | "ciphertext" | "auth_tag">,
): EncryptedSecret {
  return {
    keyId: row.key_id,
    iv: fromBytea(row.iv),
    ciphertext: fromBytea(row.ciphertext),
    authTag: fromBytea(row.auth_tag),
  };
}

export function encryptedToColumns(
  record: EncryptedSecret,
): Pick<CredentialRow, "key_id" | "iv" | "ciphertext" | "auth_tag"> {
  return {
    key_id: record.keyId,
    iv: toBytea(record.iv),
    ciphertext: toBytea(record.ciphertext),
    auth_tag: toBytea(record.authTag),
  };
}

function failure(operation: string, error: { code: string }): Error {
  return new Error(`connection_credentials ${operation} failed (code ${error.code}).`);
}

export type CredentialKey = Readonly<{ workspaceId: string; connectionId: string }>;

/**
 * Encrypts and stores the credential for a connection, replacing any previous one. The caller must
 * have authorized the user for `workspaceId` with at least the admin role.
 */
export async function saveCredential({
  workspaceId,
  connectionId,
  credential,
}: CredentialKey & Readonly<{ credential: OAuthCredential }>): Promise<void> {
  const supabase = createAdminClient();

  // The service role bypasses RLS, so confirm the connection really belongs to the workspace
  // before writing; otherwise an upsert could attach a credential row to another tenant.
  const { data: connection, error: lookupError } = await supabase
    .from("connections")
    .select("id")
    .eq("id", connectionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (lookupError) throw failure("connection lookup", lookupError);
  if (connection === null) {
    throw new Error("Cannot save a credential: the connection does not belong to this workspace.");
  }

  const encrypted = encryptCredential(credential, credentialAad(workspaceId, connectionId));
  const { error } = await supabase.from("connection_credentials").upsert(
    {
      connection_id: connectionId,
      workspace_id: workspaceId,
      ...encryptedToColumns(encrypted),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "connection_id" },
  );
  if (error) throw failure("upsert", error);
}

/**
 * Loads and decrypts a connection's credential, or returns null when none is stored.
 *
 * Only the sync and connection validation paths may call this. Never call it from a page, a
 * Server Action response, or anything that renders, and never log the result: the tokens stay
 * wrapped in `Secret` until an adapter calls `reveal()` to build a provider request.
 */
export async function loadCredential({
  workspaceId,
  connectionId,
}: CredentialKey): Promise<OAuthCredential | null> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("connection_credentials")
    .select("key_id, iv, ciphertext, auth_tag")
    .eq("connection_id", connectionId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw failure("select", error);
  if (data === null) return null;

  return decryptCredential(encryptedFromRow(data), credentialAad(workspaceId, connectionId));
}

/**
 * Deletes a connection's stored credential (disconnect or revoke). The caller must have authorized
 * the user for `workspaceId`; the workspace filter keeps a connection id from another workspace
 * from matching anything. Deleting a missing row is not an error.
 */
export async function deleteCredential({ workspaceId, connectionId }: CredentialKey): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("connection_credentials")
    .delete()
    .eq("connection_id", connectionId)
    .eq("workspace_id", workspaceId);
  if (error) throw failure("delete", error);
}

/**
 * Takes the connection's credential refresh lock for `leaseSeconds` (#496) and returns its id, or
 * null while another holder's lease is current (acquire_credential_refresh_lock). Throws when the
 * connection is not in the workspace.
 */
export async function acquireCredentialRefreshLock(
  { workspaceId, connectionId }: CredentialKey,
  leaseSeconds: number,
): Promise<string | null> {
  const { data, error } = await createAdminClient().rpc("acquire_credential_refresh_lock", {
    p_workspace_id: workspaceId,
    p_connection_id: connectionId,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw failure("refresh lock acquire", error);
  // The function returns null while the lock is held, which the generated `string` does not say.
  const lockId: unknown = data;
  return typeof lockId === "string" ? lockId : null;
}

/** Frees the lock `lockId` took; a lock taken over since its lease ran out is left to its new holder. */
export async function releaseCredentialRefreshLock({ workspaceId, connectionId }: CredentialKey, lockId: string): Promise<void> {
  const { error } = await createAdminClient()
    .from("credential_refresh_locks")
    .delete()
    .eq("connection_id", connectionId)
    .eq("workspace_id", workspaceId)
    .eq("lock_id", lockId);
  if (error) throw failure("refresh lock release", error);
}
