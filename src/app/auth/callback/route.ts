import { NextResponse, type NextRequest } from "next/server";

import { safeNextPath, signInErrorUrl, type SignInErrorCode } from "@/lib/auth/redirect";
import { log, logError } from "@/lib/log/logger";
import { createClient } from "@/lib/supabase/server";

// Matches the message `public.hook_before_user_created` returns when an email is not on the
// invite list. Supabase Auth passes the hook's message through as `error_description`.
const NOT_INVITED_PATTERN = /not been invited/i;

function signInWithError(request: NextRequest, error: SignInErrorCode, next: string, referenceId?: string) {
  return NextResponse.redirect(signInErrorUrl(request.url, error, next, referenceId), 303);
}

/**
 * Where Supabase Auth sends the browser after GitHub. Exchanges the one-time code for a session
 * (the PKCE verifier cookie proves this browser started the flow), then continues to `next`.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const next = safeNextPath(params.get("next"));
  const code = params.get("code");

  if (code === null) {
    const providerError = params.get("error");
    const description = params.get("error_description") ?? "";
    if (NOT_INVITED_PATTERN.test(description)) {
      // Expected while sign-up is invite only: no reference id, the message says what to do.
      log.info("auth.sign_in_not_invited");
      return signInWithError(request, "not_invited", next);
    }
    if (providerError === "access_denied") {
      return signInWithError(request, "cancelled", next);
    }
    const referenceId = logError("auth.callback_provider_error", new Error("OAuth callback without a code"), {
      providerError,
      errorCode: params.get("error_code"),
      description,
    });
    return signInWithError(request, "callback_failed", next, referenceId);
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error !== null) {
    const referenceId = logError("auth.callback_exchange_failed", error);
    return signInWithError(request, "callback_failed", next, referenceId);
  }

  // `next` is allow-listed to app paths, so this never leaves the site.
  return NextResponse.redirect(new URL(next, request.url), 303);
}
