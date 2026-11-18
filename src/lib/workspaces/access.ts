import "server-only";

import { notFound } from "next/navigation";
import { connection } from "next/server";
import { cache } from "react";

import { getCurrentUser, requireUser, type SessionUser } from "@/lib/auth/session";
import { getWorkspaceMembership, type WorkspaceRef } from "@/lib/data/workspaces";
import { isWorkspaceSlug, workspaceHome } from "@/lib/workspaces/paths";
import {
  actionDeniedReason,
  ForbiddenError,
  hasRoleAtLeast,
  requiredRoleFor,
  type WorkspaceAction,
  type WorkspaceRole,
} from "@/lib/workspaces/permissions";

export type WorkspaceAccess = {
  user: SessionUser;
  workspace: WorkspaceRef;
  role: WorkspaceRole;
};

/**
 * Signs the user in if needed, then confirms they belong to the workspace with `slug` and hold at
 * least `minRole`. A missing workspace and a workspace the user is not a member of both end in
 * `notFound()`, so the response never reveals which slugs exist. A member below `minRole` gets a
 * `ForbiddenError`; pages that want to explain instead should ask for "viewer" and use
 * `canPerform` on the returned role.
 */
export const requireWorkspace = cache(
  async (slug: string, minRole: WorkspaceRole): Promise<WorkspaceAccess> => {
    // Verifying the session reads the clock (token expiry). Cookies alone do not stop a runtime
    // prerender, so wait for the real request first or Next reports a current-time prerender error.
    await connection();
    const validSlug = isWorkspaceSlug(slug);
    // Send the user back to this workspace after sign-in, but only through a known-safe path.
    const user = await requireUser(validSlug ? workspaceHome(slug) : "/app");
    if (!validSlug) notFound();

    const membership = await getWorkspaceMembership(user.id, slug);
    if (!membership) notFound();
    if (!hasRoleAtLeast(membership.role, minRole)) throw new ForbiddenError(minRole);

    return { user, workspace: membership.workspace, role: membership.role };
  },
);

/**
 * Whether the signed-in user belongs to the workspace with `slug`, for wording a not-found page
 * only: it never redirects or throws `notFound()`, so a signed-out user, an invalid slug, and a
 * non-member are all `false`. It reads through the same request caches as `requireWorkspace`, so
 * beside a page that calls that it queries nothing again.
 */
export async function isWorkspaceMember(slug: string): Promise<boolean> {
  if (!isWorkspaceSlug(slug)) return false;
  const user = await getCurrentUser();
  if (user === null) return false;
  return (await getWorkspaceMembership(user.id, slug)) !== null;
}

/** `requireWorkspace` for a specific matrix action, for Server Actions and Route Handlers. */
export async function requireWorkspaceAction(
  slug: string,
  action: WorkspaceAction,
): Promise<WorkspaceAccess> {
  try {
    return await requireWorkspace(slug, requiredRoleFor(action));
  } catch (error) {
    // Swap the generic role message for the one that names the action.
    if (error instanceof ForbiddenError) {
      throw new ForbiddenError(error.requiredRole, actionDeniedReason(action));
    }
    throw error;
  }
}
