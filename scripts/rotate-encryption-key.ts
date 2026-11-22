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
 *
 * The rotation, its printed counts, and its exit code are `src/lib/crypto/rotation.ts`, unit tested
 * there; this file only loads the environment, builds the service role client, prints the key id,
 * and hands the exit code to the process.
 */
import { existsSync } from "node:fs";

import { currentKeyId } from "@/lib/crypto/credentials";
import { rotateAll, sealedTables } from "@/lib/crypto/rotation";
import { createAdminClient } from "@/lib/supabase/admin";

async function main(): Promise<number> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");

  const supabase = createAdminClient();
  const keyId = currentKeyId();
  console.log(`Current key id: ${keyId}`);

  return rotateAll(sealedTables(supabase, keyId), (line) => console.log(line));
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
