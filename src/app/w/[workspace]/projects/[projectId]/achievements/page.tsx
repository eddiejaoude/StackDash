import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { z } from "zod";

import { PublishAchievementButton, UnpublishAchievementButton } from "@/components/achievements/achievement-controls";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { PageSkeleton } from "@/components/app/page-skeleton";
import { SimulatedBadge } from "@/components/connections/simulated-badge";
import { LockIcon } from "@/components/icons";
import { AchievementShareDialog } from "@/components/public-metrics/achievement-share-dialog";
import { PublicationAnnouncer } from "@/components/public-metrics/publication-controls";
import { groupAchievementsByProvider, loadProjectAchievements, type ProjectAchievement } from "@/lib/achievements/private";
import { requestPublicOrigin } from "@/lib/connections/oauth-state";
import { loadProjectPageSettings } from "@/lib/data/project-pages";
import { formatUtcDate } from "@/lib/format";
import { projectPagePath } from "@/lib/public-metrics/project-page";
import { achievementEarnedText, type ShareProjectPage } from "@/lib/public-metrics/share";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspace } from "@/lib/workspaces/access";
import { workspacePath } from "@/lib/workspaces/paths";
import { actionDeniedReason, canPerform } from "@/lib/workspaces/permissions";

export const metadata: Metadata = { title: "Achievements" };

const ACHIEVEMENTS_HEADING_ID = "achievements-title";

// Every section renders inside its own Suspense boundary so navigating between sections
// has an instant shell; access checks and data reads stream in behind it.
export default function AchievementsPage(props: PageProps<"/w/[workspace]/projects/[projectId]/achievements">) {
  return (
    <Suspense fallback={<PageSkeleton label="Loading achievements" />}>
      <AchievementsContent {...props} />
    </Suspense>
  );
}

async function projectName(workspaceId: string, projectId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("name")
    .eq("workspace_id", workspaceId)
    .eq("id", projectId)
    .maybeSingle();
  if (error) throw new Error("Failed to load the project", { cause: error });
  return data?.name ?? null;
}

async function AchievementsContent({ params }: PageProps<"/w/[workspace]/projects/[projectId]/achievements">) {
  const { workspace: slug, projectId } = await params;
  const { workspace, role } = await requireWorkspace(slug, "viewer");
  // A malformed id would fail the uuid cast in the query; it is the same "no such project" answer.
  if (!z.guid().safeParse(projectId).success) notFound();
  const [name, achievements, pageSettings, origin] = await Promise.all([
    projectName(workspace.id, projectId),
    loadProjectAchievements(workspace.id, projectId),
    loadProjectPageSettings(workspace.id, projectId),
    // Share links use the public origin, as the public metrics page builds them.
    requestPublicOrigin(),
  ]);
  if (name === null) notFound();

  const canPublish = canPerform(role, "publish_metrics");
  const sharePage: ShareProjectPage | null =
    pageSettings?.enabled === true ? { path: projectPagePath(workspace, pageSettings.slug), projectName: name } : null;
  const connectionsPath = workspacePath(workspace.slug, "connections");

  return (
    <>
      <p className="mb-4 text-sm">
        <Link
          href={workspacePath(workspace.slug, "projects")}
          className="text-muted underline-offset-4 hover:text-foreground hover:underline"
        >
          All projects
        </Link>
      </p>
      <PageHeader
        title={`Achievements for ${name}`}
        description="Milestones this project has reached, from what its connected providers report. Earned achievements stay earned. Each one is private until an owner or admin publishes it."
      />

      {achievements.length === 0 ? (
        <EmptyState
          title="No achievements yet"
          description="Achievements come from the connected provider accounts assigned to this project. Connect a provider, then assign its accounts to this project on the connection's page. Achievements appear here after the next sync."
          action={{ href: connectionsPath, label: "Assign provider accounts" }}
          deniedReason={canPerform(role, "manage_connections") ? undefined : actionDeniedReason("manage_connections")}
        />
      ) : (
        <PublicationAnnouncer>
          {canPublish ? null : (
            <p className="mt-6 flex items-center gap-2 text-sm text-muted">
              <LockIcon className="shrink-0" />
              <span>Only owners and admins can publish or unpublish achievements.</span>
            </p>
          )}
          <section aria-labelledby={ACHIEVEMENTS_HEADING_ID} className="mt-6 rounded-xl border border-line bg-panel">
            <div className="border-b border-line px-6 py-4">
              <h2 id={ACHIEVEMENTS_HEADING_ID} tabIndex={-1} className="text-sm font-semibold">
                Achievements
              </h2>
              <p className="mt-1 text-sm leading-6 text-muted">
                Grouped by provider, oldest first. A published achievement shows its public title on the project page,
                its badge, and its card, never the private title below it.
              </p>
            </div>
            {groupAchievementsByProvider(achievements).map((group) => {
              const headingId = `achievements-${group.provider}`;
              return (
                <section key={group.provider} aria-labelledby={headingId} className="border-b border-line last:border-b-0">
                  <h3 id={headingId} className="px-6 pt-4 text-sm font-semibold">
                    {group.providerName}
                  </h3>
                  <ol className="divide-y divide-line">
                    {group.achievements.map((achievement) => (
                      <AchievementItem
                        key={achievement.id}
                        achievement={achievement}
                        workspaceSlug={workspace.slug}
                        projectId={projectId}
                        canPublish={canPublish}
                        origin={origin}
                        projectPage={sharePage}
                      />
                    ))}
                  </ol>
                </section>
              );
            })}
          </section>
        </PublicationAnnouncer>
      )}
    </>
  );
}

function AchievementItem({
  achievement,
  workspaceSlug,
  projectId,
  canPublish,
  origin,
  projectPage,
}: {
  achievement: ProjectAchievement;
  workspaceSlug: string;
  projectId: string;
  canPublish: boolean;
  origin: string;
  projectPage: ShareProjectPage | null;
}) {
  const control = { workspaceSlug, projectId, achievementId: achievement.id, title: achievement.title, focusId: ACHIEVEMENTS_HEADING_ID };
  return (
    // The id is the anchor the timeline's "Achievement earned" entries link to. Scrolled clear of
    // the shell's sticky header, and washed while it is the target.
    <li
      id={achievement.id}
      className="flex scroll-mt-32 flex-col gap-3 px-6 py-4 text-sm target:bg-accent-soft lg:flex-row lg:items-start lg:justify-between"
    >
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2">
          <span className="break-words font-medium">{achievement.title}</span>
          {achievement.simulated ? <SimulatedBadge /> : null}
        </p>
        <p className="mt-1 text-muted">
          {/* The same words as the public page; a daily total's machine-readable date is the day alone. */}
          <time dateTime={achievement.earnedPrecision === "day" ? formatUtcDate(achievement.earnedAt) : achievement.earnedAt}>
            {achievementEarnedText(achievement)}
          </time>
        </p>
        <p className="mt-1 break-words text-muted">{achievement.description}</p>
        <p className="mt-1">
          {achievement.published ? (
            <span className="font-medium text-success">Published</span>
          ) : (
            <span className="text-muted">Not published</span>
          )}
          <span className="break-words text-muted">. Public title: {achievement.publicTitle}</span>
        </p>
      </div>
      {canPublish || achievement.published ? (
        <div className="flex shrink-0 flex-wrap items-start gap-3">
          {canPublish ? (
            achievement.published ? (
              <UnpublishAchievementButton {...control} />
            ) : (
              <PublishAchievementButton {...control} />
            )
          ) : null}
          {achievement.published ? (
            <AchievementShareDialog
              projectId={projectId}
              achievementId={achievement.id}
              publicTitle={achievement.publicTitle}
              providerName={achievement.providerName}
              simulated={achievement.simulated}
              siteOrigin={origin}
              projectPage={projectPage}
            />
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
