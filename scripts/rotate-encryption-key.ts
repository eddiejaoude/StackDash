/*
 * Re-encrypts stored secrets under the current encryption key (issue #35): connection credentials
 * and, since #153, the sealed webhook URLs of alert channels.
 *
 * Run with `npm run keys:rotate`. Reads `.env.local` when present; otherwise the variables must
 * already be in the environment (hosted: run it where the production variables are set).
 *
 * Rotating the encryption key
 *
 * 1. Generate a new key: `openssl rand -base64 32`.
 * 2. Work out the id of the key in use now (the first 8 hex chars of its SHA-256):
 *    `printf '%s' "$OLD_KEY" | openssl base64 -d -A | shasum -a 256 | cut -c1-8`
 *    (this script also prints the current key id each time it runs).
 * 3. Set `STACKDASH_ENCRYPTION_KEY` to the new key and add the old one to
 *    `STACKDASH_ENCRYPTION_KEYS_PREVIOUS` as `oldKeyId:oldBase64Key` (comma separate several).
 *    Deploy. From now on new secrets are sealed with the new key and old rows still decrypt,
 *    so nothing goes down.
 * 4. Once every running instance has the new configuration, run `npm run keys:rotate`. It prints
 *    counts only and is safe to re-run; repeat until "remaining" is 0 for every table.
 * 5. Wait until pending OAuth states sealed with the old key have expired (they are short lived),
 *    then remove the old entry from `STACKDASH_ENCRYPTION_KEYS_PREVIOUS` and deploy again. The
 *    unsubscribe links in alert emails are signed with a key derived from the encryption key, so
 *    links in emails sent before the rotation stop working at this step; every newer email works.
 *
 * Rows that cannot be decrypted (key not configured, or failed authentication) are counted as
 * unreadable and left untouched; those connections need reconnecting and those channels need
 * their URL again. The exit code is 1 when any row was unreadable.
 *
 * Each row is updated with a compare-and-set on its old key id and IV, so a secret written
 * concurrently by the app (for example a token refresh) is never overwritten with stale content.
 */
import { existsSync } from "node:fs";

import {
  currentKeyId,
  decryptSecret,
  credentialAad,
  DecryptionFailedError,
  encryptSecret,
  UnknownEncryptionKeyError,
} from "@/lib/crypto/credentials";
import { encryptedFromRow, encryptedToColumns } from "@/lib/data/credentials";
import { destinationSecretAad } from "@/lib/data/notification-destinations";
import { createAdminClient } from "@/lib/supabase/admin";

const BATCH_SIZE = 100;

type Counts = { scanned: number; rotated: number; skipped: number; unreadable: number };

type SealedRow = { id: string; workspace_id: string; key_id: string; iv: string; ciphertext: string; auth_tag: string };

/** One table of sealed rows: how to page through it, bind a row's ciphertext, and replace it. */
type SealedTable = {
  label: string;
  aad: (row: SealedRow) => string;
  /** Rows not on the current key, after `cursor` by primary key, at most BATCH_SIZE. */
  page: (cursor: string | null) => Promise<SealedRow[]>;
  /** Compare-and-set on the old key id and IV. False when the row changed since it was read. */
  replace: (row: SealedRow, sealed: Pick<SealedRow, "key_id" | "iv" | "ciphertext" | "auth_tag">) => Promise<boolean>;
  remaining: () => Promise<number | null>;
};

async function rotate(table: SealedTable): Promise<Counts> {
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

async function main(): Promise<number> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");

  const supabase = createAdminClient();
  const keyId = currentKeyId();
  console.log(`Current key id: ${keyId}`);

  const tables: SealedTable[] = [
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

  let unreadable = 0;
  for (const table of tables) {
    const counts = await rotate(table);
    const remaining = await table.remaining();
    unreadable += counts.unreadable;
    console.log(
      `${table.label}: scanned ${counts.scanned}, rotated ${counts.rotated}, skipped ${counts.skipped} (changed concurrently), unreadable ${counts.unreadable}, remaining on old keys ${remaining ?? "unknown"}.`,
    );
  }
  return unreadable > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Errors raised on this path name variables, key ids, and Postgres codes, never values.
    console.error(
      error instanceof Error && error.message.length > 0
        ? `Rotation failed: ${error.message}`
        : "Rotation failed.",
    );
    process.exitCode = 1;
  },
);
