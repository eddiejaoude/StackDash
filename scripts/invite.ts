/*
 * Adds or removes an email on the StackDash test invite list (issue #23).
 *
 *   npm run invite -- someone@example.com            invite
 *   npm run invite -- someone@example.com --remove   remove the invite
 *
 * Sign-in is GitHub only. When an invited person first signs in, the before-user-created auth hook
 * finds their GitHub email in `public.access_invites` and lets Supabase create the user; anyone
 * else is refused. Removing an invite stops new sign-ups with that email; it does not delete an
 * account that already exists.
 *
 * Reads `.env.local` when present; otherwise NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY must already be in the environment (hosted: run it where the
 * production variables are set). Prints only the outcome and the email.
 */
import { existsSync } from "node:fs";
import { userInfo } from "node:os";
import { parseArgs } from "node:util";

import { z } from "zod";

import { createAdminClient } from "@/lib/supabase/admin";

const USAGE = "Usage: npm run invite -- someone@example.com [--remove]";

// Lowercased before validation: the table's check constraint requires lowercase, and the hook
// compares lowercased emails, so "Someone@Example.com" and "someone@example.com" are one invite.
const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: { remove: { type: "boolean", default: false } },
    allowPositionals: true,
  });
  const parsed = emailSchema.safeParse(positionals[0]);
  if (positionals.length !== 1 || !parsed.success) {
    console.error(`Give exactly one valid email address. ${USAGE}`);
    return 2;
  }
  const email = parsed.data;

  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const supabase = createAdminClient();

  if (values.remove) {
    const { error } = await supabase.from("access_invites").delete().eq("email", email);
    if (error) throw new Error(`Removing the invite failed (code ${error.code}).`);
    console.log(`Removed ${email}`);
    return 0;
  }

  // Upsert so re-inviting is harmless; the original invite time is refreshed, which is fine for a
  // test allow list.
  const { error } = await supabase
    .from("access_invites")
    .upsert({ email, invited_at: new Date().toISOString(), invited_by: `cli:${userInfo().username}` });
  if (error) throw new Error(`Saving the invite failed (code ${error.code}).`);
  console.log(`Invited ${email}`);
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Errors raised on this path carry Postgres codes and variable names, never secrets.
    console.error(
      error instanceof Error && error.message.length > 0 ? `Invite failed: ${error.message}` : "Invite failed.",
    );
    process.exitCode = 1;
  },
);
