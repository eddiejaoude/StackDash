import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { SignOutButton } from "@/components/app/sign-out-button";
import { Wordmark } from "@/components/wordmark";
import { requireUser } from "@/lib/auth/session";
import { getLastWorkspaceSlug, listMyWorkspaces } from "@/lib/data/workspaces";
import { isWorkspaceSlug, workspaceHome } from "@/lib/workspaces/access";

export const metadata: Metadata = { title: "Your workspace" };

/**
 * The signed-in entry point. It holds no content of its own: it opens the last-used workspace,
 * then the personal one, then the first membership. Session reads sit behind Suspense, as Cache
 * Components requires.
 */
export default function AppEntryPage() {
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

  const lastSlug = await getLastWorkspaceSlug();
  if (lastSlug !== null && isWorkspaceSlug(lastSlug)) redirect(workspaceHome(lastSlug));

  const workspaces = await listMyWorkspaces();
  const target = workspaces.find((workspace) => workspace.is_personal) ?? workspaces[0];
  if (target !== undefined && isWorkspaceSlug(target.slug)) redirect(workspaceHome(target.slug));

  return <NoWorkspace />;
}

function OpeningWorkspace() {
  return (
    <p role="status" aria-live="polite" className="text-center text-sm text-muted">
      Opening your workspace
    </p>
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
        the DevMacro test, or sign out and sign in with a different GitHub account.
      </p>
      <div className="mt-6">
        <SignOutButton />
      </div>
    </div>
  );
}
