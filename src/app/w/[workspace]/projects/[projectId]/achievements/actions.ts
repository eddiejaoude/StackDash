"use server";

import { refresh } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import type { PublicMetricActionResult } from "@/app/w/[workspace]/projects/[projectId]/public-metrics/actions";
import { logError } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAction } from "@/lib/workspaces/access";
import { ForbiddenError } from "@/lib/workspaces/permissions";

/*
 * Publishing and unpublishing an earned achievement (#413), one at a time. Owner or admin only:
 * `requireWorkspaceAction` checks the signed-in member, then a service role function writes the
 * publication and checks the member's role again (20261114120000_project_achievements.sql), the
 * same split as publishing a metric (../public-metrics/actions.ts).
 */

type Failure = Extract<PublicMetricActionResult, { ok: false }>;

// `guid`, not `uuid`: fixtures use hand-written ids that skip the RFC version bits.
const achievementSchema = z
  .object({
    workspace: z.string().min(1),
    projectId: z.guid(),
    // The shape project_achievements.achievement_id allows.
    achievementId: z
      .string()
      .max(100)
      .regex(/^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/),
  })
  .strict();

const OUT_OF_DATE = "This form is out of date. Reload the page and try again.";
// Same answer for an achievement that is gone and one in another workspace.
const ACHIEVEMENT_GONE = "This project no longer has this achievement. Reload the page to see its achievements.";
const DENIED = "Only owners and admins can publish or unpublish achievements.";
const INSUFFICIENT_PRIVILEGE = "42501";

function unexpected(error: unknown, event: string, message: string): Failure {
  // notFound() and redirect() signal through throws; let Next.js handle them.
  unstable_rethrow(error);
  if (error instanceof ForbiddenError) return { ok: false, message: DENIED };
  const referenceId = logError(event, error);
  return { ok: false, message, referenceId };
}

/** A role change between the page check and the database check. */
function rpcFailure(error: { code: string }, what: string): never {
  if (error.code === INSUFFICIENT_PRIVILEGE) throw new ForbiddenError("admin", DENIED);
  throw new Error(`${what} failed`, { cause: error });
}

function parse(formData: FormData) {
  return achievementSchema.safeParse({
    workspace: formData.get("workspace"),
    projectId: formData.get("projectId"),
    achievementId: formData.get("achievementId"),
  });
}

/** The achievement's private title, read as the member, or null when the project has not earned it. */
async function achievementTitle(workspaceId: string, projectId: string, achievementId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("project_achievements")
    .select("title")
    .eq("workspace_id", workspaceId)
    .eq("project_id", projectId)
    .eq("achievement_id", achievementId)
    .maybeSingle();
  if (error) throw new Error("Achievement lookup failed", { cause: error });
  return data?.title ?? null;
}

export async function publishAchievement(
  _previous: PublicMetricActionResult | null,
  formData: FormData,
): Promise<PublicMetricActionResult> {
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };
  const { projectId, achievementId } = parsed.data;

  try {
    const { workspace: ws, user } = await requireWorkspaceAction(parsed.data.workspace, "publish_metrics");
    const title = await achievementTitle(ws.id, projectId, achievementId);
    if (title === null) return { ok: false, message: ACHIEVEMENT_GONE };
    const { data, error } = await createAdminClient().rpc("publish_achievement", {
      p_workspace_id: ws.id,
      p_project_id: projectId,
      p_actor_id: user.id,
      p_achievement_id: achievementId,
    });
    if (error) rpcFailure(error, "Publish achievement");
    if (data === "not_found") return { ok: false, message: ACHIEVEMENT_GONE };
    refresh();
    return { ok: true, message: data === "unchanged" ? `${title} was already published.` : `Published ${title}.` };
  } catch (error) {
    return unexpected(error, "achievements.publish_failed", "The achievement was not published. Try again in a moment.");
  }
}

export async function unpublishAchievement(
  _previous: PublicMetricActionResult | null,
  formData: FormData,
): Promise<PublicMetricActionResult> {
  const parsed = parse(formData);
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };
  const { projectId, achievementId } = parsed.data;

  try {
    const { workspace: ws, user } = await requireWorkspaceAction(parsed.data.workspace, "publish_metrics");
    const title = await achievementTitle(ws.id, projectId, achievementId);
    if (title === null) return { ok: false, message: ACHIEVEMENT_GONE };
    const { data, error } = await createAdminClient().rpc("unpublish_achievement", {
      p_workspace_id: ws.id,
      p_project_id: projectId,
      p_actor_id: user.id,
      p_achievement_id: achievementId,
    });
    if (error) rpcFailure(error, "Unpublish achievement");
    if (data === "not_found") return { ok: false, message: ACHIEVEMENT_GONE };
    refresh();
    return {
      ok: true,
      message: data === "unchanged" ? `${title} was not published.` : `Unpublished ${title}. It is no longer public.`,
    };
  } catch (error) {
    return unexpected(error, "achievements.unpublish_failed", "The achievement was not unpublished. Try again in a moment.");
  }
}
