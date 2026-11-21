import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import { LegalConsent } from "@/components/legal/legal-consent";
import { LiveRegion } from "@/components/ui/live-region";
import { Wordmark } from "@/components/wordmark";
import { safeNextPath, SIGN_IN_ERROR_CODES, type SignInErrorCode } from "@/lib/auth/redirect";
import { getCurrentUser } from "@/lib/auth/session";
import { logError } from "@/lib/log/logger";
import { REFERENCE_ID_PATTERN } from "@/lib/log/reference";
import { createClient } from "@/lib/supabase/server";

import { SignInForm } from "./sign-in-form";

export const metadata: Metadata = {
  title: "Sign in",
  robots: { index: false },
};

// The enforced CSP nonce (src/proxy.ts) needs this page's HTML rendered per request, so the page
// awaits `connection()` before anything renders and allows an empty static shell (#125).
export const instant = false;

// Codes the auth routes put in `?error=`. Anything else in the URL is ignored.
const signInErrorSchema = z.enum(SIGN_IN_ERROR_CODES);

const SIGN_IN_ERRORS: Record<SignInErrorCode, string> = {
  not_invited: "This GitHub account's email has not been invited to StackDash. Ask for an invite, then try again.",
  cancelled: "GitHub sign-in was cancelled. Continue with GitHub to try again.",
  start_failed: "We could not start GitHub sign-in. Try again in a moment.",
  callback_failed: "GitHub sign-in did not finish. Try again in a moment.",
  // The demo sign-in link from `npm run demo` (#260). Anywhere that command cannot run, every link
  // gets this message too, so the page never tells a valid link from a refused one.
  link_invalid: "This sign-in link has expired or was already used. Run npm run demo again to print a new one.",
  link_failed: "We could not sign you in with this link. Open it again in a moment, or run npm run demo for a new one.",
};

// Query values can repeat (`?next=a&next=b`); take the first and drop anything malformed.
const firstString = z.preprocess(
  (value) => (Array.isArray(value) ? value[0] : value),
  z.string().optional().catch(undefined),
);

const searchParamsSchema = z.object({
  next: firstString,
  error: firstString.pipe(signInErrorSchema.optional().catch(undefined)),
  ref: firstString.pipe(z.string().regex(REFERENCE_ID_PATTERN).optional().catch(undefined)),
});

/**
 * Starts the GitHub OAuth flow (PKCE: the verifier lands in a cookie) and sends the browser to
 * Supabase Auth. Invite gating happens in the database hook when the user is first created.
 */
async function signInWithGitHub(nextInput: string): Promise<void> {
  "use server";

  const next = safeNextPath(nextInput);
  // Next.js has already checked that a Server Function's Origin header matches the host, so it is
  // this deployment's public origin. Supabase Auth also refuses redirect URLs outside its allow list.
  const origin = (await headers()).get("origin");

  let url: string | null = null;
  let failure: unknown = new Error("The sign-in request had no Origin header");
  if (origin !== null) {
    const callback = new URL("/auth/callback", origin);
    callback.searchParams.set("next", next);
    const supabase = await createClient();
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: "github",
      options: { redirectTo: callback.toString(), scopes: "read:user user:email" },
    });
    if (error === null) url = data.url;
    else failure = error;
  }

  if (url === null) {
    const referenceId = logError("auth.oauth_start_failed", failure);
    redirect(
      `/sign-in?${new URLSearchParams({ error: "start_failed", ref: referenceId, next }).toString()}`,
    );
  }
  redirect(url);
}

async function SignInPanel({ searchParams }: { searchParams: PageProps<"/sign-in">["searchParams"] }) {
  const { next: nextInput, error, ref } = searchParamsSchema.parse(await searchParams);
  const next = safeNextPath(nextInput);

  // Already signed in: there is nothing to do here.
  if ((await getCurrentUser()) !== null) redirect(next);

  return (
    <>
      {error === undefined ? null : (
        <LiveRegion tone="error" className="mb-6 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm leading-6">
          <p>{SIGN_IN_ERRORS[error]}</p>
          {ref === undefined ? null : (
            <p className="mt-1 text-muted">
              If it keeps happening, share reference <span className="font-mono text-foreground">{ref}</span>.
            </p>
          )}
        </LiveRegion>
      )}
      <SignInForm action={signInWithGitHub.bind(null, next)} />
    </>
  );
}

export default async function SignInPage({ searchParams }: PageProps<"/sign-in">) {
  await connection();
  return (
    <main id="main" className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-8">
        <Link href="/" className="inline-flex min-h-6 items-center">
          <Wordmark />
        </Link>
        <h1 className="mt-6 text-2xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-2 mb-6 text-sm leading-6 text-muted">
          Sign-up to StackDash is invite only for now. Sign in with the GitHub account whose email was invited.
        </p>
        <Suspense fallback={<div className="min-h-11 rounded-lg bg-panel-raised" aria-hidden="true" />}>
          <SignInPanel searchParams={searchParams} />
        </Suspense>
        <LegalConsent />
      </div>
    </main>
  );
}
