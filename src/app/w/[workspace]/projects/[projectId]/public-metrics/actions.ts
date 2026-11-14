"use server";

import { refresh } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { SELF_REPORTED_LIVE_MAX, selfReportedFields } from "@/components/public-metrics/self-reported-rules";
import { formatQuantity } from "@/lib/format";
import { logError } from "@/lib/log/logger";
import {
  allowedRoundings,
  PUBLIC_METRIC_IDS,
  PUBLISHED_METRIC_ROUNDINGS,
  publicMetricDefinition,
} from "@/lib/public-metrics/definitions";
import { livePublicationsText, publicationSummary } from "@/lib/public-metrics/display";
import { pageSlugSchema, projectPagePath } from "@/lib/public-metrics/project-page";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAction } from "@/lib/workspaces/access";
import { actionDeniedReason, ForbiddenError } from "@/lib/workspaces/permissions";

/*
 * Publishing and unpublishing (#148), and turning the project page on and off (#150). Owner or
 * admin only: `requireWorkspaceAction` checks the signed-in member, then a service role function
 * writes the row and its timeline audit event in one transaction and checks the member's role
 * again (20261105023129_published_metrics.sql, 20261105120500_project_pages.sql).
 */

export type PublicMetricActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string; fieldErrors?: Record<string, string>; referenceId?: string };

type Failure = Extract<PublicMetricActionResult, { ok: false }>;

// `guid`, not `uuid`: fixtures use hand-written ids that skip the RFC version bits.
const id = z.guid();
const workspace = z.string().min(1);

const publishSchema = z
  .object({
    workspace,
    projectId: id,
    metricId: z.enum(PUBLIC_METRIC_IDS),
    rounding: z.enum(PUBLISHED_METRIC_ROUNDINGS),
    delayDays: z.enum(["0", "7"]),
  })
  .strict();
const unpublishSchema = z.object({ workspace, publicationId: id }).strict();
const unpublishAllSchema = z.object({ workspace }).strict();
const selfReportedSchema = z.object({ workspace, projectId: id, ...selfReportedFields }).strict();
const projectPageSchema = z.object({ workspace, projectId: id, slug: pageSlugSchema, indexable: z.boolean() }).strict();
const disableProjectPageSchema = z.object({ workspace, projectId: id }).strict();

const OUT_OF_DATE = "This form is out of date. Reload the page and try again.";
// Same answer for a project or publication that is gone and one in another workspace.
const PROJECT_GONE = "This project no longer exists. Reload the page to see your projects.";
const PUBLICATION_GONE = "This metric is no longer published. Reload the page to see what is public now.";
const INSUFFICIENT_PRIVILEGE = "42501";

function unexpected(error: unknown, event: string, message: string): Failure {
  // notFound() and redirect() signal through throws; let Next.js handle them.
  unstable_rethrow(error);
  if (error instanceof ForbiddenError) return { ok: false, message: error.message };
  const referenceId = logError(event, error);
  return { ok: false, message, referenceId };
}

/** A role change between the page check and the database check. */
function rpcFailure(error: { code: string }, what: string): never {
  if (error.code === INSUFFICIENT_PRIVILEGE) throw new ForbiddenError("admin", actionDeniedReason("publish_metrics"));
  throw new Error(`${what} failed`, { cause: error });
}

async function projectName(workspaceId: string, projectId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("name")
    .eq("workspace_id", workspaceId)
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw new Error("Project lookup failed", { cause: error });
  return data?.name ?? null;
}

export async function publishMetric(
  _previous: PublicMetricActionResult | null,
  formData: FormData,
): Promise<PublicMetricActionResult> {
  const parsed = publishSchema.safeParse({
    workspace: formData.get("workspace"),
    projectId: formData.get("projectId"),
    metricId: formData.get("metricId"),
    rounding: formData.get("rounding"),
    delayDays: formData.get("delayDays"),
  });
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };
  const { metricId, rounding, projectId } = parsed.data;
  const delayDays = parsed.data.delayDays === "7" ? 7 : 0;
  const definition = publicMetricDefinition(metricId);
  if (!allowedRoundings(definition.unit).includes(rounding)) return { ok: false, message: OUT_OF_DATE };

  try {
    const { workspace: ws, user } = await requireWorkspaceAction(parsed.data.workspace, "publish_metrics");
    const name = await projectName(ws.id, projectId);
    if (name === null) return { ok: false, message: PROJECT_GONE };
    const { data, error } = await createAdminClient().rpc("publish_metric", {
      p_workspace_id: ws.id,
      p_project_id: projectId,
      p_actor_id: user.id,
      p_metric_id: metricId,
      p_rounding: rounding,
      p_delay_days: delayDays,
      p_title: `Published ${definition.label}`,
      p_body: `Project ${name}. ${publicationSummary(rounding, delayDays)}.`,
    });
    if (error) rpcFailure(error, "Publish metric");
    if (data === "not_found") return { ok: false, message: PROJECT_GONE };
    refresh();
    return {
      ok: true,
      message: data === "unchanged" ? `${definition.label} was already published that way.` : `Published ${definition.label}.`,
    };
  } catch (error) {
    return unexpected(error, "public_metrics.publish_failed", "The metric was not published. Try again in a moment.");
  }
}

export async function unpublishMetric(
  _previous: PublicMetricActionResult | null,
  formData: FormData,
): Promise<PublicMetricActionResult> {
  const parsed = unpublishSchema.safeParse({
    workspace: formData.get("workspace"),
    publicationId: formData.get("publicationId"),
  });
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };

  try {
    const { workspace: ws, user } = await requireWorkspaceAction(parsed.data.workspace, "publish_metrics");
    const supabase = await createClient();
    const { data: row, error: rowError } = await supabase
      .from("published_metrics")
      .select("metric_id, self_reported_label")
      .eq("workspace_id", ws.id)
      .eq("id", parsed.data.publicationId)
      .is("revoked_at", null)
      .maybeSingle();
    if (rowError) throw new Error("Publication lookup failed", { cause: rowError });
    if (row === null) return { ok: false, message: PUBLICATION_GONE };
    const label = row.metric_id === null ? (row.self_reported_label ?? "a self-reported value") : publicMetricDefinition(row.metric_id).label;

    const { data, error } = await createAdminClient().rpc("unpublish_metric", {
      p_workspace_id: ws.id,
      p_published_metric_id: parsed.data.publicationId,
      p_actor_id: user.id,
      p_title: `Unpublished ${label}`,
    });
    if (error) rpcFailure(error, "Unpublish metric");
    if (data === "not_found") return { ok: false, message: PUBLICATION_GONE };
    refresh();
    return { ok: true, message: `Unpublished ${label}. It is no longer public.` };
  } catch (error) {
    return unexpected(error, "public_metrics.unpublish_failed", "The metric was not unpublished. Try again in a moment.");
  }
}

export async function unpublishEverything(
  _previous: PublicMetricActionResult | null,
  formData: FormData,
): Promise<PublicMetricActionResult> {
  const parsed = unpublishAllSchema.safeParse({ workspace: formData.get("workspace") });
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };

  try {
    const { workspace: ws, user } = await requireWorkspaceAction(parsed.data.workspace, "publish_metrics");
    // Takes down every live metric publication and every published achievement in one transaction.
    const { data, error } = await createAdminClient().rpc("unpublish_all_metrics", {
      p_workspace_id: ws.id,
      p_actor_id: user.id,
    });
    if (error) rpcFailure(error, "Unpublish everything");
    const [counts] = data;
    if (counts === undefined) throw new Error("Unpublish everything returned no counts");
    refresh();
    const taken = livePublicationsText(counts);
    return {
      ok: true,
      message: taken === "" ? "Nothing was published in this workspace." : `Unpublished everything in this workspace: ${taken}.`,
    };
  } catch (error) {
    return unexpected(error, "public_metrics.unpublish_all_failed", "Nothing was unpublished. Try again in a moment.");
  }
}

export async function publishSelfReported(
  _previous: PublicMetricActionResult | null,
  formData: FormData,
): Promise<PublicMetricActionResult> {
  const parsed = selfReportedSchema.safeParse({
    workspace: formData.get("workspace"),
    projectId: formData.get("projectId"),
    label: formData.get("label"),
    value: formData.get("value"),
    unit: formData.get("unit"),
  });
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if ((field === "label" || field === "value" || field === "unit") && fieldErrors[field] === undefined) {
        fieldErrors[field] = issue.message;
      }
    }
    if (Object.keys(fieldErrors).length === 0) return { ok: false, message: OUT_OF_DATE };
    return { ok: false, fieldErrors, message: "The value was not published. Fix the fields marked below." };
  }
  const { projectId, label, value, unit } = parsed.data;

  try {
    const { workspace: ws, user } = await requireWorkspaceAction(parsed.data.workspace, "publish_metrics");
    const name = await projectName(ws.id, projectId);
    if (name === null) return { ok: false, message: PROJECT_GONE };
    const { data, error } = await createAdminClient().rpc("publish_self_reported_metric", {
      p_workspace_id: ws.id,
      p_project_id: projectId,
      p_actor_id: user.id,
      p_label: label,
      p_value: value,
      p_unit: unit,
      p_title: `Published ${label} (self-reported)`,
      p_body: `Project ${name}. ${formatQuantity(value, unit)}.`,
    });
    if (error) rpcFailure(error, "Publish self-reported value");
    if (data === "not_found") return { ok: false, message: PROJECT_GONE };
    if (data === "duplicate") {
      const message = "A self-reported value with this name is already published. Unpublish it first, or use another name.";
      return { ok: false, fieldErrors: { label: message }, message: `The value was not published. ${message}` };
    }
    if (data === "limit_reached") {
      return {
        ok: false,
        message: `The value was not published. This project already publishes ${SELF_REPORTED_LIVE_MAX} self-reported values. Unpublish one you no longer need, then publish this one.`,
      };
    }
    refresh();
    return { ok: true, message: `Published ${label} as a self-reported value.` };
  } catch (error) {
    return unexpected(error, "public_metrics.self_reported_failed", "The value was not published. Try again in a moment.");
  }
}

export async function saveProjectPage(
  _previous: PublicMetricActionResult | null,
  formData: FormData,
): Promise<PublicMetricActionResult> {
  const slug = formData.get("slug");
  if (typeof slug !== "string") return { ok: false, message: OUT_OF_DATE };
  const parsed = projectPageSchema.safeParse({
    workspace: formData.get("workspace"),
    projectId: formData.get("projectId"),
    slug,
    // A checkbox sends "on" when ticked and nothing otherwise.
    indexable: formData.get("indexable") === "on",
  });
  if (!parsed.success) {
    const slugIssue = parsed.error.issues.find((issue) => issue.path[0] === "slug");
    if (slugIssue === undefined) return { ok: false, message: OUT_OF_DATE };
    return { ok: false, fieldErrors: { slug: slugIssue.message }, message: "The page settings were not saved. Fix the address below." };
  }

  try {
    const { workspace: ws, user } = await requireWorkspaceAction(parsed.data.workspace, "publish_metrics");
    const { data, error } = await createAdminClient().rpc("save_project_page", {
      p_workspace_id: ws.id,
      p_project_id: parsed.data.projectId,
      p_actor_id: user.id,
      p_slug: parsed.data.slug,
      p_indexable: parsed.data.indexable,
    });
    if (error) rpcFailure(error, "Save project page");
    if (data === "not_found") return { ok: false, message: PROJECT_GONE };
    if (data === "slug_taken") {
      const message = "Another project in this workspace uses this address. Choose another one.";
      return { ok: false, fieldErrors: { slug: message }, message: `The page settings were not saved. ${message}` };
    }
    if (data === "unchanged") return { ok: true, message: "The project page already has these settings." };
    refresh();
    const path = projectPagePath(ws, parsed.data.slug);
    return {
      ok: true,
      message: data === "enabled" ? `The project page is on at ${path}.` : `Saved the project page settings. Its address is ${path}.`,
    };
  } catch (error) {
    return unexpected(error, "project_page.save_failed", "The page settings were not saved. Try again in a moment.");
  }
}

export async function disableProjectPage(
  _previous: PublicMetricActionResult | null,
  formData: FormData,
): Promise<PublicMetricActionResult> {
  const parsed = disableProjectPageSchema.safeParse({ workspace: formData.get("workspace"), projectId: formData.get("projectId") });
  if (!parsed.success) return { ok: false, message: OUT_OF_DATE };

  try {
    const { workspace: ws, user } = await requireWorkspaceAction(parsed.data.workspace, "publish_metrics");
    const { data, error } = await createAdminClient().rpc("disable_project_page", {
      p_workspace_id: ws.id,
      p_project_id: parsed.data.projectId,
      p_actor_id: user.id,
    });
    if (error) rpcFailure(error, "Disable project page");
    if (data === "not_found") return { ok: false, message: "The project page is already off. Reload the page to see its settings." };
    refresh();
    return { ok: true, message: "The project page is off. Its address now answers page not found." };
  } catch (error) {
    return unexpected(error, "project_page.disable_failed", "The project page was not turned off. Try again in a moment.");
  }
}
