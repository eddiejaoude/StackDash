import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { z } from "zod";

import { PageHeader } from "@/components/app/page-header";
import { SignOutButton } from "@/components/app/sign-out-button";
import { INBOX_CURSOR_PARAM, INBOX_VIEW_PARAM, inboxHref } from "@/components/support/operator/inbox";
import { InboxLive } from "@/components/support/operator/inbox-live";
import { InboxRoster } from "@/components/support/operator/inbox-roster";
import { OperatorConversation } from "@/components/support/operator/operator-conversation";
import { LiveRegion } from "@/components/ui/live-region";
import { Wordmark } from "@/components/wordmark";
import { ADMIN_PATH, requireSuperAdmin } from "@/lib/auth/super-admin";
import { log } from "@/lib/log/logger";
import { SUPPORT_INBOX_PATH, SUPPORT_THREAD_PARAM } from "@/lib/support/paths";
import { listOperatorThreads } from "@/lib/support/threads";

// The title would name the page to anyone, so it is gated like the page: a non super admin gets
// the not found page's metadata instead.
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  await requireSuperAdmin(SUPPORT_INBOX_PATH);
  return { title: "Support inbox" };
}

// The enforced CSP nonce (src/proxy.ts) needs this page's HTML rendered per request, so the page
// awaits `connection()` before anything renders and allows an empty static shell (#125).
export const instant = false;

// A malformed or repeated parameter is ignored: the active list, its first page, nothing open.
const searchSchema = z.object({
  [INBOX_VIEW_PARAM]: z.enum(["active", "closed"]).catch("active"),
  [INBOX_CURSOR_PARAM]: z.string().max(200).optional().catch(undefined),
  [SUPPORT_THREAD_PARAM]: z.guid().optional().catch(undefined),
});

const ROSTER_HEADING_ID = "support-roster-heading";

/**
 * The support inbox (#680): every user's support conversations, answered by the instance's super
 * admins. Addressed as SUPPORT_INBOX_PATH; src/proxy.ts rewrites that address to this route for a
 * super admin only, and answers this route's own path as not found, so anyone else gets the not
 * found page with its 404 (#374). The list renders here; the open conversation (`?thread=`, which
 * support emails link to) loads in the browser through the inbox route handler, and both read
 * again on every Realtime hint (InboxLive).
 */
export default async function SupportInboxPage({ searchParams }: PageProps<"/super-admin/inbox">) {
  await connection();
  // The authorization, checked before anything below renders; the proxy's routing is not. It also
  // syncs this operator's mirror row, which the Realtime channels need to join.
  const operator = await requireSuperAdmin(SUPPORT_INBOX_PATH);
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex h-14 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
          <Link href="/app" className="inline-flex min-h-6 shrink-0 items-center">
            <Wordmark />
          </Link>
          <div className="ml-auto flex shrink-0 items-center gap-3">
            <Link
              href={ADMIN_PATH}
              className="inline-flex min-h-9 items-center rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground"
            >
              Instance overview
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <PageHeader
          title="Support inbox"
          description="Conversations with the people who use this instance. Replies are emailed to them when they are not online."
        />
        <Suspense fallback={<LoadingInbox />}>
          <InboxContent operatorId={operator.id} searchParams={searchParams} />
        </Suspense>
      </main>
    </div>
  );
}

function LoadingInbox() {
  return (
    <LiveRegion tone="status" className="mt-8">
      <span className="sr-only">Loading the support inbox</span>
      <div aria-hidden="true" className="h-96 rounded-xl border border-dashed border-line bg-panel motion-safe:animate-pulse" />
    </LiveRegion>
  );
}

async function InboxContent({ operatorId, searchParams }: { operatorId: string } & Pick<PageProps<"/super-admin/inbox">, "searchParams">) {
  const query = searchSchema.parse(await searchParams);
  const view = query[INBOX_VIEW_PARAM];
  const cursor = query[INBOX_CURSOR_PARAM] ?? null;
  const threadId = query[SUPPORT_THREAD_PARAM] ?? null;
  // Admin views are logged, as the instance overview's are: who read members' conversations, when.
  log.info("admin.viewed", { userId: operatorId, page: "support_inbox", view });

  const page = await listOperatorThreads(operatorId, view, cursor);
  // Read after the request data above, so the clock never runs during prerendering.
  const now = new Date();
  const here = inboxHref({ view, cursor, threadId });

  return (
    <InboxLive
      operatorId={operatorId}
      memberIds={page.threads.map((thread) => thread.member.userId)}
      selectedThreadId={threadId}
      rosterHeadingId={ROSTER_HEADING_ID}
    >
      {/* Side by side from md; below it, the list or the open conversation with a way back. */}
      <div className="mt-8 md:grid md:grid-cols-[minmax(0,22rem)_minmax(0,1fr)] md:items-start md:gap-6">
        <div className={threadId === null ? "" : "hidden md:block"}>
          <InboxRoster
            view={view}
            cursor={cursor}
            selectedThreadId={threadId}
            threads={page.threads}
            nextCursor={page.nextCursor}
            headingId={ROSTER_HEADING_ID}
            now={now}
          />
        </div>
        <div className={threadId === null ? "hidden md:block" : ""}>
          <OperatorConversation
            threadId={threadId}
            backHref={inboxHref({ view, cursor, threadId: null })}
            signInHref={`/sign-in?${new URLSearchParams({ next: here }).toString()}`}
          />
        </div>
      </div>
    </InboxLive>
  );
}
