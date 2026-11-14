import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { SignOutButton } from "@/components/app/sign-out-button";
import { LiveRegion } from "@/components/ui/live-region";
import { Wordmark } from "@/components/wordmark";
import { requireUser } from "@/lib/auth/session";
import { getLastWorkspaceSlug, listMyWorkspaces } from "@/lib/data/workspaces";
import { isWorkspaceSlug, workspaceHome } from "@/lib/workspaces/paths";

export const metadata: Metadata = { title: "Your workspace" };

// The enforced CSP nonce (src/proxy.ts) needs this page's HTML rendered per request, so the page
// awaits `connection()` before anything renders and allows an empty static shell (#125).
export const instant = false;

/**
 * The signed-in entry point. It holds no content of its own: it opens the last-used workspace,
 * then the personal one, then the first membership. Session reads sit behind Suspense, so the
 * "Opening your workspace" status shows while they run. The last workspace and the memberships
 * are read together, since neither needs the other: a visit with no usable last workspace no
 * longer waits for a second round trip (#346).
 */
export default async function AppEntryPage() {
  await connection();
  return (
    <main id="main" className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-16">
      <Suspense fallback={<OpeningWorkspace />}>
        <OpenWorkspace />
      </Suspense>
    </main>
  );
}

async function OpenWorkspace() {
  // Session verification reads the clock (token expiry), so it must not run in a prerender.
  await connection();
  await requireUser("/app");

  const [lastSlug, workspaces] = await Promise.all([getLastWorkspaceSlug(), listMyWorkspaces()]);
  if (lastSlug !== null && isWorkspaceSlug(lastSlug)) redirect(workspaceHome(lastSlug));

  const target = workspaces.find((workspace) => workspace.is_personal) ?? workspaces[0];
  if (target !== undefined && isWorkspaceSlug(target.slug)) redirect(workspaceHome(target.slug));

  return <NoWorkspace />;
}

function OpeningWorkspace() {
  return (
    <LiveRegion tone="status" as="p" className="text-center text-sm text-muted">
      Opening your workspace
    </LiveRegion>
  );
}

// Every account gets a personal workspace when it is created, so reaching this means the
// workspace was deleted or membership was removed. Nothing here can fix that, so say who can.
function NoWorkspace() {
  return (
    <div className="rounded-xl border border-line bg-panel px-6 py-10 sm:px-10">
      <p className="flex">
        <Wordmark />
      </p>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">You are not a member of any workspace</h1>
      <p className="mt-3 text-sm leading-6 text-muted">
        Your account is signed in, but it does not belong to a workspace. This can happen if a
        workspace was deleted or you were removed from it. Contact the person who invited you to
        StackDash, or sign out and sign in with a different GitHub account.
      </p>
      <div className="mt-6">
        <SignOutButton />
      </div>
    </div>
  );
}
