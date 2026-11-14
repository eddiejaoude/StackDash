"use client";

import {
  publishAchievement,
  unpublishAchievement,
} from "@/app/w/[workspace]/projects/[projectId]/achievements/actions";
import { Failure, useAnnouncedAction } from "@/components/public-metrics/publication-controls";
import { buttonClass } from "@/components/ui/button";

/*
 * Publish and Unpublish for one earned achievement (#413), on the project's Achievements section
 * and in a timeline entry's details. Rendered inside `PublicationAnnouncer`, like the metric
 * controls: a publish swaps this button for Unpublish and Share, so success is announced above the
 * list and focus moves to `focusId` rather than being dropped. Failures stay beside the button.
 */

type AchievementControlProps = Readonly<{
  workspaceSlug: string;
  projectId: string;
  achievementId: string;
  /** The private title, so a list of buttons can be told apart by name. */
  title: string;
  /** Takes focus after the action succeeds and this button is replaced. */
  focusId: string;
}>;

function AchievementForm({
  action,
  label,
  pendingLabel,
  workspaceSlug,
  projectId,
  achievementId,
  title,
  focusId,
}: AchievementControlProps & {
  action: typeof publishAchievement;
  label: string;
  pendingLabel: string;
}) {
  const [state, formAction, pending] = useAnnouncedAction(action, focusId);
  return (
    <form action={formAction}>
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="achievementId" value={achievementId} />
      <button type="submit" disabled={pending} className={buttonClass("raised", "xs")}>
        {pending ? pendingLabel : label}
        <span className="sr-only"> {title}</span>
      </button>
      <Failure state={state} />
    </form>
  );
}

export function PublishAchievementButton(props: AchievementControlProps) {
  return <AchievementForm {...props} action={publishAchievement} label="Publish achievement" pendingLabel="Publishing achievement" />;
}

export function UnpublishAchievementButton(props: AchievementControlProps) {
  return (
    <AchievementForm {...props} action={unpublishAchievement} label="Unpublish achievement" pendingLabel="Unpublishing achievement" />
  );
}
