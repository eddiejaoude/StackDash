"use server";

import { refresh } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { dismissOnboardingChecklist } from "@/lib/data/onboarding-checklist";
import { logError } from "@/lib/log/logger";
import { requireWorkspace } from "@/lib/workspaces/access";

export type DismissChecklistResult = { ok: true } | { ok: false; message: string; referenceId?: string };

const dismissSchema = z.object({ workspace: z.string().min(1) }).strict();

/**
 * Hides the Timeline's setup checklist for the signed-in member only (#674). Any member may, so the
 * check is membership; the user comes from the verified session, never from the form, and row level
 * security keeps the row the caller's own.
 */
export async function dismissChecklist(
  _previous: DismissChecklistResult | null,
  formData: FormData,
): Promise<DismissChecklistResult> {
  // Picked field by field so framework-added form entries never trip the strict schema.
  const parsed = dismissSchema.safeParse({ workspace: formData.get("workspace") });
  if (!parsed.success) return { ok: false, message: "This form is out of date. Reload the page and try again." };

  try {
    const { workspace, user } = await requireWorkspace(parsed.data.workspace, "viewer");
    await dismissOnboardingChecklist(workspace.id, user.id);
  } catch (error) {
    // notFound() and redirect() signal through throws; let Next.js handle them.
    unstable_rethrow(error);
    const referenceId = logError("timeline.checklist_dismiss_failed", error);
    return { ok: false, message: "The checklist could not be hidden. Try again in a moment.", referenceId };
  }

  refresh();
  return { ok: true };
}
