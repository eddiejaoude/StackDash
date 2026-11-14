import type { EmailOtpType, SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

/*
 * The demo account's one-time sign-in link (#260). `npm run demo` mints it with the service role
 * (`auth.admin.generateLink`) and `/auth/confirm` consumes it with `verifyOtp({ token_hash, type })`,
 * the token hash flow in @supabase/auth-js (GoTrueClient.d.ts, "Verify Email Auth (Token Hash)").
 * Kept free of `server-only` so the end-to-end tests build the same link.
 */

// Set in app_metadata, which only the service role can write, when the demo seed creates the account.
export const DEMO_USER_MARKER = "stackdash_demo";

/** True when `appMetadata` carries the marker the demo seed sets on the account it creates. */
export function isDemoAccount(appMetadata: unknown): boolean {
  if (typeof appMetadata !== "object" || appMetadata === null || !(DEMO_USER_MARKER in appMetadata)) return false;
  return appMetadata[DEMO_USER_MARKER] === true;
}

/** The only `type` `/auth/confirm` accepts: the email token hash type, which covers a magic link. */
export const DEMO_SIGN_IN_OTP_TYPE = "email" satisfies EmailOtpType;

export const DEMO_SIGN_IN_ROUTE = "/auth/confirm";

/** `/auth/confirm` with the link's token hash and where to land once signed in. */
export function demoSignInPath(tokenHash: string, next: string): string {
  const params = new URLSearchParams({ token_hash: tokenHash, type: DEMO_SIGN_IN_OTP_TYPE, next });
  return `${DEMO_SIGN_IN_ROUTE}?${params.toString()}`;
}

/**
 * A one-time sign-in link for `email` that lands on `next`: a magic link token minted with the
 * service role (`auth.admin.generateLink`, which sends no email), consumed once by `/auth/confirm`.
 * It expires after the stack's `otp_expiry` (supabase/config.toml, one hour). The demo commands
 * mint it for the demo account; the end-to-end tests for a throwaway account.
 */
export async function demoSignInLink(admin: SupabaseClient<Database>, input: Readonly<{ email: string; origin: string; next: string }>): Promise<string> {
  const { data, error } = await admin.auth.admin.generateLink({ type: "magiclink", email: input.email });
  if (error) throw new Error(`Making the sign-in link for ${input.email} failed: ${error.message}`, { cause: error });
  return `${input.origin}${demoSignInPath(data.properties.hashed_token, input.next)}`;
}
