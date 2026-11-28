"use client";

import { useActionState } from "react";

import { dismissChecklist, type DismissChecklistResult } from "@/app/w/[workspace]/timeline/actions";
import { GuardedButton } from "@/components/guarded-button";
import { buttonClass } from "@/components/ui/button";
import { FailureAnnouncement } from "@/components/ui/live-region";

/**
 * Hides the setup checklist for the signed-in member (#674). The panel goes away with the button,
 * so focus moves to the page heading rather than being dropped to the document.
 */
export function DismissChecklistButton({
  workspaceSlug,
  afterDismissFocusId,
}: {
  workspaceSlug: string;
  afterDismissFocusId: string;
}) {
  const [state, formAction, pending] = useActionState<DismissChecklistResult | null, FormData>(
    async (previous, formData) => {
      const result = await dismissChecklist(previous, formData);
      if (result.ok) document.getElementById(afterDismissFocusId)?.focus();
      return result;
    },
    null,
  );
  return (
    <form action={formAction} className="shrink-0">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <GuardedButton type="submit" unavailable={pending} className={buttonClass("secondary", "sm")}>
        {pending ? "Hiding checklist" : "Hide checklist"}
      </GuardedButton>
      <FailureAnnouncement
        failure={state !== null && !state.ok ? state : null}
        className="max-w-xs text-sm"
        messageClassName="mt-2"
      />
    </form>
  );
}
