import "server-only";

import { after } from "next/server";
import { cache } from "react";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { log, logError } from "@/lib/log/logger";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";
import type { WorkspaceRole } from "@/lib/workspaces/permissions";

type WorkspaceRow = Database["public"]["Tables"]["workspaces"]["Row"];

export type WorkspaceRef = Pick<WorkspaceRow, "id" | "slug" | "name" | "handle">;

export type WorkspaceSummary = Pick<WorkspaceRow, "id" | "slug" | "name" | "is_personal"> & {
  role: WorkspaceRole;
};

export type WorkspaceMembership = {
  workspace: WorkspaceRef;
  role: WorkspaceRole;
};

// The switcher is a plain list; nobody belongs to more than a handful of workspaces in the MVP.
const MY_WORKSPACES_LIMIT = 50;

/**
 * The signed-in user's membership of the workspace with `slug`, or null when the workspace does
 * not exist or the user is not a member. The two cases are deliberately indistinguishable so a
 * slug cannot be probed. Row level security already hides other workspaces; the explicit
 * `user_id` filter keeps the query correct even for a user who could see more.
 */
export const getWorkspaceMembership = cache(
  async (userId: string, slug: string): Promise<WorkspaceMembership | null> => {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("workspaces")
      .select("id, slug, name, handle, workspace_members!inner(role)")
      .eq("slug", slug)
      .eq("workspace_members.user_id", userId)
      .maybeSingle();
    if (error) throw new Error("Failed to load workspace membership", { cause: error });
    const role = data?.workspace_members[0]?.role;
    if (!data || role === undefined) return null;
    return { workspace: { id: data.id, slug: data.slug, name: data.name, handle: data.handle }, role };
  },
);

/** Every workspace the signed-in user belongs to, ordered by name, at most 50. */
export const listMyWorkspaces = cache(async (): Promise<WorkspaceSummary[]> => {
  const user = await getCurrentUser();
  if (!user) return [];
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, slug, name, is_personal, workspace_members!inner(role)")
    .eq("workspace_members.user_id", user.id)
    .order("name", { ascending: true })
    .order("id", { ascending: true })
    .limit(MY_WORKSPACES_LIMIT);
  if (error) throw new Error("Failed to list workspaces", { cause: error });
  return data.flatMap((row) => {
    const role = row.workspace_members[0]?.role;
    if (role === undefined) return [];
    return [{ id: row.id, slug: row.slug, name: row.name, is_personal: row.is_personal, role }];
  });
});

/**
 * Slug of the workspace the user last opened, or null when none is recorded or they have since
 * lost access to it. One read: the profile with its last workspace embedded only while the user
 * is still a member, so it never waits on a second request (#346).
 */
export const getLastWorkspaceSlug = cache(async (): Promise<string | null> => {
  const user = await getCurrentUser();
  if (!user) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("profiles")
    .select("last_workspace:workspaces!profiles_last_workspace_id_fkey(slug, workspace_members!inner(user_id))")
    .eq("user_id", user.id)
    .eq("last_workspace.workspace_members.user_id", user.id)
    .maybeSingle();
  if (error) throw new Error("Failed to load last workspace", { cause: error });
  return data?.last_workspace?.slug ?? null;
});

/**
 * Records `workspaceId` as the user's last-used workspace so `/app` reopens it. The write runs
 * after the response is sent so it never delays rendering, and it is filtered to skip the write
 * when the value is already current. Only call it after membership has been confirmed.
 */
export async function rememberWorkspace(workspaceId: string): Promise<void> {
  // The id is interpolated into a PostgREST filter below, so it must be plain uuid text. `guid`,
  // not `uuid`: fixtures use hand-written ids that skip the RFC version bits.
  const id = z.guid().parse(workspaceId);
  const user = await getCurrentUser();
  if (!user) return;
  // Request APIs (cookies) cannot be read inside `after` from a Server Component, so the
  // user-scoped client is created now and only used later.
  const supabase = await createClient();
  after(async () => {
    const { error } = await supabase
      .from("profiles")
      .update({ last_workspace_id: id })
      .eq("user_id", user.id)
      .or(`last_workspace_id.is.null,last_workspace_id.neq.${id}`);
    if (error === null) return;
    // The profiles_update_own with check refused the row because the user is no longer a member
    // of the workspace (it was deleted, or they left it, after this request). Expected: /app simply
    // opens another workspace next time, so this is degraded but handled. Only the row level
    // security refusal qualifies: a lost grant or an anonymous request is also 42501 ("permission
    // denied") and is a real fault.
    if (error.code === "42501" && error.message.includes("row-level security policy")) {
      log.warn("workspaces.remember_skipped_not_member", { workspaceId: id });
      return;
    }
    // Losing this only means /app opens a different workspace next time, so log and move on.
    logError("workspaces.remember_failed", error, { workspaceId: id });
  });
}
