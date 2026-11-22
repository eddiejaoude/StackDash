import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  credentialAad,
  decryptSecret,
  DecryptionFailedError,
  encryptSecret,
  UnknownEncryptionKeyError,
} from "@/lib/crypto/credentials";
import { encryptedFromRow, encryptedToColumns } from "@/lib/data/credentials";
import { destinationSecretAad } from "@/lib/data/notification-destinations";
import type { Database } from "@/lib/supabase/database.types";

/*
 * Re-encryption of stored secrets under the current key (#35, #153), driven by
 * `scripts/rotate-encryption-key.ts` (`npm run keys:rotate`), whose header holds the operator
 * procedure. The service role client and the current key id are passed in, so the rotation runs
 * against a fake PostgREST in tests and never against a client built at import.
 */

type Admin = SupabaseClient<Database>;

export const BATCH_SIZE = 100;

export type Counts = { scanned: number; rotated: number; skipped: number; unreadable: number };

export type SealedRow = { id: string; workspace_id: string; key_id: string; iv: string; ciphertext: string; auth_tag: string };

/** One table of sealed rows: how to page through it, bind a row's ciphertext, and replace it. */
export type SealedTable = {
  label: string;
  aad: (row: SealedRow) => string;
  /** Rows not on the current key, after `cursor` by primary key, at most BATCH_SIZE. */
  page: (cursor: string | null) => Promise<SealedRow[]>;
  /** Compare-and-set on the old key id and IV. False when the row changed since it was read. */
  replace: (row: SealedRow, sealed: Pick<SealedRow, "key_id" | "iv" | "ciphertext" | "auth_tag">) => Promise<boolean>;
  remaining: () => Promise<number | null>;
};

/** The tables holding sealed secrets: connection credentials, then alert channel URLs. */
export function sealedTables(supabase: Admin, keyId: string): SealedTable[] {
  return [
    {
      label: "connection_credentials",
      aad: (row) => credentialAad(row.workspace_id, row.id),
      async page(cursor) {
        let query = supabase
          .from("connection_credentials")
          .select("connection_id, workspace_id, key_id, iv, ciphertext, auth_tag")
          .neq("key_id", keyId)
          .order("connection_id", { ascending: true })
          .limit(BATCH_SIZE);
        if (cursor !== null) query = query.gt("connection_id", cursor);
        const { data, error } = await query;
        if (error) throw new Error(`Reading connection_credentials failed (code ${error.code}).`);
        return data.map(({ connection_id, ...rest }) => ({ id: connection_id, ...rest }));
      },
      async replace(row, sealed) {
        const { data, error } = await supabase
          .from("connection_credentials")
          .update({ ...sealed, updated_at: new Date().toISOString() })
          .eq("connection_id", row.id)
          .eq("key_id", row.key_id)
          .eq("iv", row.iv)
          .select("connection_id");
        if (error) throw new Error(`Updating connection_credentials failed (code ${error.code}).`);
        return data.length > 0;
      },
      async remaining() {
        const { count, error } = await supabase
          .from("connection_credentials")
          .select("connection_id", { count: "exact", head: true })
          .neq("key_id", keyId);
        if (error) throw new Error(`Counting connection_credentials failed (code ${error.code}).`);
        return count;
      },
    },
    {
      label: "notification_destination_secrets",
      aad: (row) => destinationSecretAad(row.workspace_id, row.id),
      async page(cursor) {
        let query = supabase
          .from("notification_destination_secrets")
          .select("destination_id, workspace_id, key_id, iv, ciphertext, auth_tag")
          .neq("key_id", keyId)
          .order("destination_id", { ascending: true })
          .limit(BATCH_SIZE);
        if (cursor !== null) query = query.gt("destination_id", cursor);
        const { data, error } = await query;
        if (error) throw new Error(`Reading notification_destination_secrets failed (code ${error.code}).`);
        return data.map(({ destination_id, ...rest }) => ({ id: destination_id, ...rest }));
      },
      async replace(row, sealed) {
        const { data, error } = await supabase
          .from("notification_destination_secrets")
          .update({ ...sealed, updated_at: new Date().toISOString() })
          .eq("destination_id", row.id)
          .eq("key_id", row.key_id)
          .eq("iv", row.iv)
          .select("destination_id");
        if (error) throw new Error(`Updating notification_destination_secrets failed (code ${error.code}).`);
        return data.length > 0;
      },
      async remaining() {
        const { count, error } = await supabase
          .from("notification_destination_secrets")
          .select("destination_id", { count: "exact", head: true })
          .neq("key_id", keyId);
        if (error) throw new Error(`Counting notification_destination_secrets failed (code ${error.code}).`);
        return count;
      },
    },
  ];
}

export async function rotate(table: SealedTable): Promise<Counts> {
  const counts: Counts = { scanned: 0, rotated: 0, skipped: 0, unreadable: 0 };
  // Keyset pagination by primary key: rotated rows drop out of the filter, so offsets would skip
  // rows, while a cursor visits each remaining row exactly once per run.
  let cursor: string | null = null;
  for (;;) {
    const rows = await table.page(cursor);
    for (const row of rows) {
      counts.scanned += 1;
      const aad = table.aad(row);
      let plaintext: string;
      try {
        plaintext = decryptSecret(encryptedFromRow(row), aad);
      } catch (decryptError) {
        if (decryptError instanceof UnknownEncryptionKeyError || decryptError instanceof DecryptionFailedError) {
          counts.unreadable += 1;
          continue;
        }
        throw decryptError;
      }
      // No row matched: the app replaced this secret since it was read, so the newer value
      // (already under the current key, or picked up on the next run) wins.
      if (await table.replace(row, encryptedToColumns(encryptSecret(plaintext, aad)))) counts.rotated += 1;
      else counts.skipped += 1;
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < BATCH_SIZE) break;
    cursor = last.id;
  }
  return counts;
}

/** The line printed for one table: counts only, never a key, a row id, or a value. */
export function summaryLine(label: string, counts: Counts, remaining: number | null): string {
  return `${label}: scanned ${counts.scanned}, rotated ${counts.rotated}, skipped ${counts.skipped} (changed concurrently), unreadable ${counts.unreadable}, remaining on old keys ${remaining ?? "unknown"}.`;
}

/**
 * Rotates every table in turn and prints one summary line each. Answers the process exit code: 1
 * when any row in any table was unreadable, since those secrets need reconnecting, else 0.
 */
export async function rotateAll(tables: readonly SealedTable[], print: (line: string) => void): Promise<number> {
  let unreadable = 0;
  for (const table of tables) {
    const counts = await rotate(table);
    unreadable += counts.unreadable;
    print(summaryLine(table.label, counts, await table.remaining()));
  }
  return unreadable > 0 ? 1 : 0;
}
