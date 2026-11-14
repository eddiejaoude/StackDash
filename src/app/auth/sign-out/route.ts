import { NextResponse, type NextRequest } from "next/server";

import { isSameOrigin } from "@/lib/auth/same-origin";
import { logError } from "@/lib/log/logger";
import { createClient } from "@/lib/supabase/server";

/**
 * Ends this browser's session. `signOut` revokes the session's refresh token on the auth server
 * (not just the cookie), and the server client clears the auth cookies on this response. The
 * `local` scope ends only this session, so signing out on one device leaves the others alone.
 */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return new NextResponse("Sign-out must be submitted from StackDash. Go back and use the Sign out button.", {
      status: 403,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error !== null) {
    const referenceId = logError("auth.sign_out_failed", error);
    const url = new URL("/auth/error", request.url);
    url.searchParams.set("reason", "sign_out_failed");
    url.searchParams.set("ref", referenceId);
    return NextResponse.redirect(url, 303);
  }

  // 303 so the browser follows with a GET instead of re-posting.
  return NextResponse.redirect(new URL("/", request.url), 303);
}
