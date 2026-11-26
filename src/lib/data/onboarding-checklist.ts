import "server-only";

import type { ConnectionInput } from "@/lib/dashboard/aggregate";
import { getWorkspaceScope } from "@/lib/data/dashboard";
import { ASSISTANT_KEY_NAME } from "@/lib/mcp/setup";
import { createClient } from "@/lib/supabase/server";
import { canPerform, type WorkspaceRole } from "@/lib/workspaces/permissions";

/*
 * The Timeline's first-run setup checklist (#674): whether each of its four steps is done, read
 * from the workspace's own state as the signed-in member, and whether that member has hidden it
 * (`onboarding_checklist_dismissals`). Every read is one indexed lookup of at most one row, and
 * they run together.
 */

export const ONBOARDING_STEP_IDS = ["connect_provider", "alert_destination", "assistant", "badge"] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/**
 * `unknown` when the member's role cannot read what decides the step: row level security shows API
 * keys to owners and admins only, so a viewer cannot tell whether an assistant is connected.
 */
export type OnboardingStepStatus = "done" | "todo" | "unknown";

export type OnboardingSteps = Readonly<Record<OnboardingStepId, OnboardingStepStatus>>;

export type OnboardingChecklistState = Readonly<{ dismissed: true }> | Readonly<{ dismissed: false; steps: OnboardingSteps }>;

/** What decides each step, as read for one member. */
export type OnboardingReads = Readonly<{
  connections: readonly Pick<ConnectionInput, "status">[];
  hasDestination: boolean;
  hasEmailPreference: boolean;
  /** Null when the member's role cannot read API keys. */
  hasAssistantKey: boolean | null;
  hasPublishedMetric: boolean;
}>;

function status(done: boolean): OnboardingStepStatus {
  return done ? "done" : "todo";
}

/**
 * Each step's status from what was read:
 * - connect_provider: any connection that is not disconnected, the rule `timelineEmptyKind` uses.
 * - alert_destination: the workspace has an alert channel, or the member chose an email setting.
 * - assistant: a key made by the AI assistants section that is not revoked.
 * - badge: an engine metric published and not unpublished, which is what a badge shows.
 */
export function onboardingSteps(reads: OnboardingReads): OnboardingSteps {
  return {
    connect_provider: status(reads.connections.some((connection) => connection.status !== "revoked")),
    alert_destination: status(reads.hasDestination || reads.hasEmailPreference),
    assistant: reads.hasAssistantKey === null ? "unknown" : status(reads.hasAssistantKey),
    badge: status(reads.hasPublishedMetric),
  };
}

/** The checklist as the signed-in member sees it in this workspace. */
export async function getOnboardingChecklistState(
  workspaceId: string,
  userId: string,
  role: WorkspaceRole,
): Promise<OnboardingChecklistState> {
  const supabase = await createClient();
  const [dismissal, scope, destination, preference, assistantKey, publishedMetric] = await Promise.all([
    supabase
      .from("onboarding_checklist_dismissals")
      .select("dismissed_at")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .maybeSingle(),
    // The same request-cached read the Timeline renders from.
    getWorkspaceScope(workspaceId),
    supabase.from("notification_destinations").select("id").eq("workspace_id", workspaceId).limit(1),
    supabase
      .from("notification_preferences")
      .select("email_frequency")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .maybeSingle(),
    // A viewer's read would come back empty under row level security and say "not done", so it is
    // not made.
    canPerform(role, "manage_api_keys")
      ? supabase
          .from("api_keys")
          .select("id")
          .eq("workspace_id", workspaceId)
          .eq("name", ASSISTANT_KEY_NAME)
          .is("revoked_at", null)
          .limit(1)
      : null,
    // published_metrics_workspace_live_idx: the workspace's rows that are not revoked.
    supabase
      .from("published_metrics")
      .select("id")
      .eq("workspace_id", workspaceId)
      .is("revoked_at", null)
      .not("metric_id", "is", null)
      .limit(1),
  ]);
  if (dismissal.error) throw new Error("Failed to read the checklist dismissal", { cause: dismissal.error });
  if (dismissal.data !== null) return { dismissed: true };
  if (destination.error) throw new Error("Failed to read alert channels for the checklist", { cause: destination.error });
  if (preference.error) throw new Error("Failed to read the alert email setting for the checklist", { cause: preference.error });
  if (assistantKey?.error) throw new Error("Failed to read API keys for the checklist", { cause: assistantKey.error });
  if (publishedMetric.error) {
    throw new Error("Failed to read published metrics for the checklist", { cause: publishedMetric.error });
  }
  return {
    dismissed: false,
    steps: onboardingSteps({
      connections: scope.connections,
      hasDestination: destination.data.length > 0,
      hasEmailPreference: preference.data !== null,
      hasAssistantKey: assistantKey === null ? null : assistantKey.data.length > 0,
      hasPublishedMetric: publishedMetric.data.length > 0,
    }),
  };
}

/**
 * Hides the checklist for the signed-in member. A second hide changes nothing: the insert ignores
 * the row already there, so the first time stays.
 */
export async function dismissOnboardingChecklist(workspaceId: string, userId: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("onboarding_checklist_dismissals")
    .upsert({ workspace_id: workspaceId, user_id: userId }, { onConflict: "workspace_id,user_id", ignoreDuplicates: true });
  if (error) throw new Error("Failed to hide the setup checklist", { cause: error });
}
