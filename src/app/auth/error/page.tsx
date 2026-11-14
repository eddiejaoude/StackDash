import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import { buttonClass } from "@/components/ui/button";
import { LiveRegion } from "@/components/ui/live-region";
import { Wordmark } from "@/components/wordmark";
import { REFERENCE_ID_PATTERN } from "@/lib/log/reference";

export const metadata: Metadata = {
  title: "Sign-in problem",
  robots: { index: false },
};

// The enforced CSP nonce (src/proxy.ts) needs this page's HTML rendered per request, so the page
// awaits `connection()` before anything renders and allows an empty static shell (#125).
export const instant = false;

const reasonSchema = z.enum(["sign_out_failed"]);

const REASONS: Record<z.infer<typeof reasonSchema>, string> = {
  sign_out_failed:
    "We could not sign you out, so this browser may still be signed in. Try signing out again in a moment.",
};

const FALLBACK_MESSAGE = "Something went wrong with signing in or out. Go back and try again.";

// Query values can repeat; take the first and drop anything malformed.
const firstString = z.preprocess(
  (value) => (Array.isArray(value) ? value[0] : value),
  z.string().optional().catch(undefined),
);

const searchParamsSchema = z.object({
  reason: firstString.pipe(reasonSchema.optional().catch(undefined)),
  ref: firstString.pipe(z.string().regex(REFERENCE_ID_PATTERN).optional().catch(undefined)),
});

async function ErrorDetails({ searchParams }: { searchParams: PageProps<"/auth/error">["searchParams"] }) {
  const { reason, ref } = searchParamsSchema.parse(await searchParams);
  return (
    <LiveRegion tone="error" className="text-sm leading-6">
      <p>{reason === undefined ? FALLBACK_MESSAGE : REASONS[reason]}</p>
      {ref === undefined ? null : (
        <p className="mt-2 text-muted">
          If it keeps happening, share reference <span className="font-mono text-foreground">{ref}</span>.
        </p>
      )}
    </LiveRegion>
  );
}

/** Where auth routes land when something unexpected fails outside the sign-in page itself. */
export default async function AuthErrorPage({ searchParams }: PageProps<"/auth/error">) {
  await connection();
  return (
    <main id="main" className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-panel p-8">
        <Link href="/" className="inline-flex min-h-6 items-center">
          <Wordmark />
        </Link>
        <h1 className="mt-6 mb-4 text-2xl font-semibold tracking-tight">Sign-in problem</h1>
        <Suspense fallback={<p className="text-sm text-muted">Loading details</p>}>
          <ErrorDetails searchParams={searchParams} />
        </Suspense>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link
            href="/app"
            className={buttonClass("primary", "lg")}
          >
            Go to StackDash
          </Link>
          <Link
            href="/"
            className={buttonClass("outline", "lg")}
          >
            Go to the home page
          </Link>
        </div>
      </div>
    </main>
  );
}
