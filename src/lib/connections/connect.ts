import "server-only";

import { isSimulatedCredential } from "@/lib/adapters/simulated/marker";
import {
  credentialInstallationId,
  type ExternalAccount,
  type OAuthContext,
  type OAuthCredential,
  type ProviderAdapter,
} from "@/lib/adapters/types";
import { CONNECTION_ACCOUNTS_MAX } from "@/lib/data/connections";
import { deleteCredential, saveCredential } from "@/lib/data/credentials";
import { enqueueSync } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

import { reconnectMismatch, type ReconnectMismatchCode } from "./oauth-state";

/*
 * Turns a fresh grant into a connection (#40). Runs from the OAuth callback after the state was
 * consumed and the user re-authorized for the workspace, so it uses the service role: status,
 * scopes, and schedule are server-written columns that `authenticated` cannot update.
 *
 * A new grant always makes a new connection, so two accounts of the same provider never share a
 * row. Reconnect replaces the credential on the existing connection, keeping its id, its accounts'
 * project assignments, and its history.
 */

type ConnectionStatus = Database["public"]["Enums"]["connection_status"];

// A grant reaching more than CONNECTION_ACCOUNTS_MAX is unusual; the rest are picked up by a later
// reconnect.
const MAX_LABEL_NAMES = 2;

export class ReconnectTargetMissingError extends Error {
  override readonly name = "ReconnectTargetMissingError";
}

/** A real connection reconnected with a simulated grant, or the reverse (#131); nothing was changed. */
export class ReconnectMismatchError extends Error {
  override readonly name = "ReconnectMismatchError";

  constructor(readonly code: ReconnectMismatchCode) {
    super("The connection to reconnect was made with the other kind of provider.");
  }
}

export type CompleteConnectionInput = Readonly<{
  adapter: ProviderAdapter;
  ctx: OAuthContext;
  workspaceId: string;
  userId: string;
  credential: OAuthCredential;
  // Connection to replace, already parsed from the consumed state.
  reconnectId?: string;
}>;

export type CompleteConnectionResult = Readonly<{
  connectionId: string;
  status: Extract<ConnectionStatus, "active" | "needs_attention">;
  missingScopes: readonly string[];
}>;

/** Who granted access, as the provider names them: one account, or the first two and a count. */
export function authorizedAccountLabel(accounts: readonly ExternalAccount[]): string | null {
  const names = accounts.map((account) => account.displayName.trim()).filter((name) => name.length > 0);
  if (names.length === 0) return null;
  const shown = names.slice(0, MAX_LABEL_NAMES).join(", ");
  const more = names.length - MAX_LABEL_NAMES;
  return more > 0 ? `${shown} and ${more} more` : shown;
}

export function connectionDisplayName(adapter: ProviderAdapter, label: string | null): string {
  return label === null ? adapter.displayName : `${adapter.displayName} (${label})`;
}

export async function completeConnection(input: CompleteConnectionInput): Promise<CompleteConnectionResult> {
  const { adapter, ctx, workspaceId, userId, credential, reconnectId } = input;
  const admin = createAdminClient();

  const missingScopes = adapter.detectMissingPermissions({ scopes: credential.scopes });
  const status = missingScopes.length > 0 ? "needs_attention" : "active";
  const accounts = (await adapter.listAccounts(credential, ctx)).slice(0, CONNECTION_ACCOUNTS_MAX);
  const label = authorizedAccountLabel(accounts);
  const now = ctx.now().toISOString();

  const finalColumns = {
    status,
    display_name: connectionDisplayName(adapter, label),
    authorized_account_label: label,
    granted_scopes: [...credential.scopes],
    missing_scopes: missingScopes,
    // Only a completed grant moves this, on connect and on reconnect; a token refresh saves the
    // credential without it. A webhook uninstall older than it is stale (#476).
    granted_at: now,
    // The installation this grant belongs to, for an uninstall that names only the installation
    // (#480). A reconnect may land on another installation, so it is written every time.
    external_installation_id: credentialInstallationId(adapter, credential),
    poll_interval_seconds: adapter.pollIntervalSeconds,
    next_sync_at: now,
    consecutive_failures: 0,
    last_error_code: null,
    last_error_reference: null,
    updated_by: userId,
  } satisfies Database["public"]["Tables"]["connections"]["Update"];

  let connectionId: string;
  let created = false;
  if (reconnectId !== undefined) {
    // Re-read inside this workspace and provider: an id from another tenant finds nothing.
    const { data, error } = await admin
      .from("connections")
      .select("id, granted_scopes")
      .eq("id", reconnectId)
      .eq("workspace_id", workspaceId)
      .eq("provider", adapter.id)
      .maybeSingle();
    if (error) throw new Error(`Reconnect lookup failed (code ${error.code}).`);
    if (data === null) throw new ReconnectTargetMissingError("The connection to reconnect no longer exists.");
    // The start route already refused a mismatch; this covers the flag changing mid-flow.
    const mismatch = reconnectMismatch(data, isSimulatedCredential(credential));
    if (mismatch !== null) throw new ReconnectMismatchError(mismatch);
    connectionId = data.id;
  } else {
    // Pending until the credential and accounts are stored, so the scheduler never picks up a
    // connection it cannot sync.
    const { data, error } = await admin
      .from("connections")
      .insert({
        workspace_id: workspaceId,
        provider: adapter.id,
        status: "pending",
        display_name: finalColumns.display_name,
        poll_interval_seconds: adapter.pollIntervalSeconds,
        created_by: userId,
        updated_by: userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(`Connection insert failed (code ${error.code}).`);
    connectionId = data.id;
    created = true;
  }

  try {
    await saveCredential({ workspaceId, connectionId, credential });

    if (accounts.length > 0) {
      // Only discovery columns are written, so on reconnect each account keeps its project and
      // its included choice; new accounts are included by default.
      const { error } = await admin.from("external_accounts").upsert(
        accounts.map((account) => ({
          workspace_id: workspaceId,
          connection_id: connectionId,
          external_id: account.externalId,
          display_name: account.displayName,
          kind: account.kind,
        })),
        { onConflict: "connection_id,external_id" },
      );
      if (error) throw new Error(`External accounts upsert failed (code ${error.code}).`);
    }

    const { error: updateError } = await admin
      .from("connections")
      .update(finalColumns)
      .eq("id", connectionId)
      .eq("workspace_id", workspaceId);
    if (updateError) throw new Error(`Connection update failed (code ${updateError.code}).`);
  } catch (error) {
    if (created) {
      // Never leave a half-made connection behind; the cascade removes its credential and accounts.
      const { error: cleanupError } = await admin
        .from("connections")
        .delete()
        .eq("id", connectionId)
        .eq("workspace_id", workspaceId);
      if (cleanupError) {
        await deleteCredential({ workspaceId, connectionId }).catch(() => undefined);
      }
    }
    throw error;
  }

  await enqueueSync({ workspaceId, connectionId, reason: "initial" });
  return { connectionId, status, missingScopes };
}
