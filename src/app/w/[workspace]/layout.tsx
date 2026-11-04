import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { AppNav } from "@/components/app/app-nav";
import { LiveRefresh } from "@/components/app/live-refresh";
import { SignOutButton } from "@/components/app/sign-out-button";
import { WorkspaceSwitcher } from "@/components/app/workspace-switcher";
import { Wordmark } from "@/components/wordmark";
import { requireUser } from "@/lib/auth/session";
import {
  getWorkspaceMembership,
  listMyWorkspaces,
  rememberWorkspace,
  type WorkspaceMembership,
} from "@/lib/data/workspaces";
import { isWorkspaceSlug, workspaceHome } from "@/lib/workspaces/access";
import { roleLabel } from "@/lib/workspaces/permissions";

type WorkspaceParams = LayoutProps<"/w/[workspace]">["params"];

/**
 * Signed-in shell for one workspace. The layout itself never awaits: the wordmark and the
 * fallbacks prerender into the static shell, and everything that needs the session or the slug
 * streams in behind its own Suspense boundary.
 *
 * The layout does not call `notFound()`. A layout's own `not-found.tsx` cannot catch it, so the
 * pages under it call `requireWorkspace`, and the not-found page renders inside this shell.
 */
export default function WorkspaceLayout({ children, params }: LayoutProps<"/w/[workspace]">) {
  return (
    <div className="flex flex-1 flex-col">
      <header className="sticky top-0 z-40 border-b border-line bg-background/90 backdrop-blur-md">
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
          <div className="flex h-14 items-center gap-2 sm:gap-3">
            <Link href="/app" className="inline-flex min-h-6 shrink-0 items-center">
              <Wordmark />
            </Link>
            <span aria-hidden="true" className="hidden text-line-strong sm:inline">
              /
            </span>
            <Suspense fallback={<ControlsSkeleton />}>
              <HeaderControls params={params} />
            </Suspense>
          </div>
          <Suspense fallback={<NavSkeleton />}>
            <HeaderNav params={params} />
          </Suspense>
        </div>
      </header>
      <main id="main" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        {children}
      </main>
    </div>
  );
}

/** Membership for the slug in the URL, or null for an invalid slug or a non-member. */
async function loadMembership(slug: string): Promise<WorkspaceMembership | null> {
  // Session verification reads the clock; see requireWorkspace.
  await connection();
  const user = await requireUser(isWorkspaceSlug(slug) ? workspaceHome(slug) : "/app");
  if (!isWorkspaceSlug(slug)) return null;
  return getWorkspaceMembership(user.id, slug);
}

async function HeaderControls({ params }: { params: WorkspaceParams }) {
  const { workspace: slug } = await params;
  await connection();
  const [membership, workspaces] = await Promise.all([loadMembership(slug), listMyWorkspaces()]);
  if (membership) {
    // Schedules the write for after the response; it never holds up this render.
    await rememberWorkspace(membership.workspace.id);
  }

  return (
    <>
      {/* Only for a member: the channel is scoped to a workspace the user can read. */}
      {membership ? <LiveRefresh workspaceId={membership.workspace.id} /> : null}
      <WorkspaceSwitcher
        workspaces={workspaces.map(({ slug: workspaceSlug, name }) => ({ slug: workspaceSlug, name, href: workspaceHome(workspaceSlug) }))}
        currentSlug={membership ? membership.workspace.slug : null}
      />
      <div className="ml-auto flex shrink-0 items-center gap-3">
        {membership ? (
          <span className="hidden rounded-full border border-line px-2 py-0.5 font-mono text-[11px] font-medium leading-none tracking-wide text-muted sm:inline">
            <span className="sr-only">Your role: </span>
            {roleLabel(membership.role)}
          </span>
        ) : null}
        <Link
          href="/account"
          className="inline-flex min-h-9 items-center rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:text-foreground"
        >
          Account
        </Link>
        <SignOutButton />
      </div>
    </>
  );
}

async function HeaderNav({ params }: { params: WorkspaceParams }) {
  const { workspace: slug } = await params;
  const membership = await loadMembership(slug);
  // Without a membership the page shows "not found"; links into that workspace would only repeat it.
  if (!membership) return null;
  return <AppNav workspaceSlug={membership.workspace.slug} />;
}

function ControlsSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-1 items-center gap-3">
      <div className="h-8 w-32 rounded-md bg-panel-raised motion-safe:animate-pulse" />
      <div className="ml-auto h-8 w-20 rounded-md bg-panel-raised motion-safe:animate-pulse" />
    </div>
  );
}

function NavSkeleton() {
  return (
    <div aria-hidden="true" className="flex h-11 items-center gap-4 border-t border-line md:border-t-0">
      <div className="h-4 w-48 rounded bg-panel-raised motion-safe:animate-pulse md:w-96" />
    </div>
  );
}
