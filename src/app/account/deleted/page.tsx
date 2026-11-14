import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { ManualRevokeList, type ManualRevokeItem } from "@/components/account/manual-revoke-list";
import { Wordmark } from "@/components/wordmark";
import { parseDeletionOutcome } from "@/lib/account/delete-account";
import { manualRevokeStep, supportsRevoke } from "@/lib/connections/revoke";
import { PROVIDER_NAMES } from "@/lib/providers";

export const metadata: Metadata = { title: "Account deleted", robots: { index: false } };

/**
 * Shown after account deletion, when the session is already gone. The confirmation is static; the
 * list of providers still to revoke by hand comes from the redirect's query string (provider ids
 * and reference ids only, see `accountDeletedPath`) and streams in behind Suspense.
 */
export default function AccountDeletedPage({ searchParams }: PageProps<"/account/deleted">) {
  return (
    <main id="main" className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-16">
      <div className="rounded-xl border border-line bg-panel px-6 py-10 sm:px-10">
        <p className="flex">
          <Wordmark />
        </p>
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Your account is deleted</h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Your profile, your sign-in, and every workspace only you belonged to are deleted, with their
          connections, credentials, and history. You are signed out.
        </p>
        <Suspense fallback={null}>
          <StillToRevoke searchParams={searchParams} />
        </Suspense>
        <p className="mt-8 text-sm">
          <Link href="/" className="underline underline-offset-4">
            Go to the StackDash home page
          </Link>
        </p>
      </div>
    </main>
  );
}

async function StillToRevoke({ searchParams }: { searchParams: PageProps<"/account/deleted">["searchParams"] }) {
  const { manual, failed } = parseDeletionOutcome(await searchParams);
  const items: ManualRevokeItem[] = [
    ...failed.map(({ provider, referenceId }) => ({
      key: `${provider}:${referenceId}`,
      providerName: PROVIDER_NAMES[provider],
      reason: `StackDash could not revoke its access at ${PROVIDER_NAMES[provider]}.`,
      steps: manualRevokeStep(provider),
      referenceId,
    })),
    ...manual.map((provider) => ({
      key: provider,
      providerName: PROVIDER_NAMES[provider],
      // A provider that supports revoking lands here only when it is no longer set up on this instance.
      reason: supportsRevoke(provider)
        ? `StackDash could not revoke its access at ${PROVIDER_NAMES[provider]}.`
        : `${PROVIDER_NAMES[provider]} does not let apps revoke their own access.`,
      steps: manualRevokeStep(provider),
    })),
  ];
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="still-to-revoke-title" className="mt-6">
      <h2 id="still-to-revoke-title" className="text-sm font-semibold">
        Remove StackDash&apos;s access at these providers
      </h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        The stored credentials are deleted, so StackDash can no longer use them, but the access you granted still
        exists at the provider until you remove it.
      </p>
      <div className="mt-3">
        <ManualRevokeList label="Providers to revoke by hand" items={items} />
      </div>
    </section>
  );
}
