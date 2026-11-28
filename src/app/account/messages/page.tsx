import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import { PageHeader } from "@/components/app/page-header";
import { SignOutButton } from "@/components/app/sign-out-button";
import { MessagesView } from "@/components/support/member/messages-view";
import { LiveRegion } from "@/components/ui/live-region";
import { Wordmark } from "@/components/wordmark";
import { requireUser } from "@/lib/auth/session";
import { SUPPORT_MESSAGES_PATH, SUPPORT_THREAD_PARAM, supportThreadPath } from "@/lib/support/paths";
import { listMemberThreads, loadMemberConversation } from "@/lib/support/threads";

export const metadata: Metadata = { title: "Messages" };

// The enforced CSP nonce (src/proxy.ts) needs this page's HTML rendered per request, so the page
// awaits `connection()` before anything renders and allows an empty static shell (#125).
export const instant = false;

// `?thread=<id>` opens one conversation; anything else in it opens the first row instead.
const searchSchema = z.object({
  [SUPPORT_THREAD_PARAM]: z.guid().optional().catch(undefined),
});

/**
 * The signed-in user's support conversations (#680), linked from the account menu, the launcher,
 * the command palette, and reply email. The header renders first; everything that needs the
 * session streams in behind Suspense, as on the account page.
 */
export default async function MessagesPage({ searchParams }: PageProps<"/account/messages">) {
  await connection();
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4 sm:px-6">
          <Link href="/app" className="inline-flex min-h-6 shrink-0 items-center">
            <Wordmark />
          </Link>
          <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-3">
            <Link
              href="/account"
              className="inline-flex min-h-9 items-center rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:text-foreground sm:px-3"
            >
              Account
            </Link>
            {/* The wordmark already opens the workspace, so phones drop this duplicate to keep the row fitting. */}
            <Link
              href="/app"
              className="hidden min-h-9 items-center rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground sm:inline-flex"
            >
              Open your workspace
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <PageHeader title="Messages" description="Your conversations with support. Replies arrive here, and by email when you are away." />
        <Suspense fallback={<LoadingMessages />}>
          <MessagesContent searchParams={searchParams} />
        </Suspense>
      </main>
    </div>
  );
}

function LoadingMessages() {
  return (
    <LiveRegion tone="status" className="mt-8">
      <span className="sr-only">Loading your messages</span>
      <div aria-hidden="true" className="h-96 rounded-xl border border-dashed border-line bg-panel motion-safe:animate-pulse" />
    </LiveRegion>
  );
}

async function MessagesContent({ searchParams }: Pick<PageProps<"/account/messages">, "searchParams">) {
  // Session verification reads the clock (token expiry), so it must not run in a prerender.
  await connection();
  const search = searchSchema.parse(await searchParams);
  const requested = search[SUPPORT_THREAD_PARAM] ?? null;
  const user = await requireUser(requested === null ? SUPPORT_MESSAGES_PATH : supportThreadPath(SUPPORT_MESSAGES_PATH, requested));
  // A named conversation reads beside the list; otherwise the list names the first one.
  const [page, requestedConversation] = await Promise.all([
    listMemberThreads(user.id, null),
    requested === null ? null : loadMemberConversation(user.id, requested, null),
  ]);
  const first = page.threads[0];
  const conversation =
    requested !== null ? requestedConversation : first === undefined ? null : await loadMemberConversation(user.id, first.id, null);

  return (
    <MessagesView
      userId={user.id}
      initialPage={page}
      initialConversation={conversation}
      initialMissing={requested !== null && requestedConversation === null ? requested : null}
    />
  );
}
