import "server-only";

import { providerName } from "@/lib/providers";
import { projectPagePath, type PublicAddressOwner } from "@/lib/public-metrics/project-page";
import type { ShareProjectPage } from "@/lib/public-metrics/share";
import type { Database } from "@/lib/supabase/database.types";
import { createClient } from "@/lib/supabase/server";

import { achievementEventDedupeKey } from "./events";

/*
 * What members see of a project's earned achievements (#413): the project's Achievements section
 * and the timeline's "Achievement earned" entries. Every read runs as the signed-in member, so row
 * level security limits it to their workspaces (20261114120000_project_achievements.sql); public
 * surfaces read through public_published_achievements() instead and never come here.
 */

type ProviderId = Database["public"]["Enums"]["provider_id"];
type DatePrecision = Database["public"]["Enums"]["achievement_date_precision"];
type Evidence = Database["public"]["Enums"]["achievement_evidence"];

/** One earned achievement as a member sees it, with the private title and how it was earned. */
export type ProjectAchievement = Readonly<{
  /** The adapter-scoped id, `vercel.deployments.10`; also the item's anchor on the page. */
  id: string;
  provider: ProviderId;
  providerName: string;
  title: string;
  publicTitle: string;
  description: string;
  earnedAt: string;
  earnedPrecision: DatePrecision;
  evidence: Evidence;
  threshold: number | null;
  /** Earned from data the provider simulator (#131) made up, so the page says Simulated. */
  simulated: boolean;
  published: boolean;
}>;

export type ProjectAchievementGroup = Readonly<{
  provider: ProviderId;
  providerName: string;
  /** Oldest first. */
  achievements: readonly ProjectAchievement[];
}>;

// Every adapter declares a few dozen achievements at most and a project earns each once, so a
// project holds a few hundred; this bounds the read at Supabase's own row cap all the same.
const ACHIEVEMENTS_LIMIT = 1000;

/** `/w/<workspace>/projects/<project id>/achievements`; each item is anchored by its achievement id. */
export function achievementsPath(workspaceSlug: string, projectId: string): string {
  return `/w/${workspaceSlug}/projects/${projectId}/achievements`;
}

/** The achievement's own item in its project's Achievements section. */
export function achievementHref(workspaceSlug: string, projectId: string, achievementId: string): string {
  return `${achievementsPath(workspaceSlug, projectId)}#${achievementId}`;
}

/**
 * The achievements under a heading per provider, providers by name, keeping the order given within
 * each (oldest first, as `loadProjectAchievements` returns them).
 */
export function groupAchievementsByProvider(achievements: readonly ProjectAchievement[]): ProjectAchievementGroup[] {
  const groups = new Map<ProviderId, ProjectAchievement[]>();
  for (const achievement of achievements) {
    const group = groups.get(achievement.provider);
    if (group === undefined) groups.set(achievement.provider, [achievement]);
    else group.push(achievement);
  }
  return [...groups.entries()]
    .map(([provider, items]) => ({ provider, providerName: providerName(provider), achievements: items }))
    .sort((a, b) => a.providerName.localeCompare(b.providerName, "en-US"));
}

/**
 * The project's earned achievements, oldest first (ties by id, as the public read orders them),
 * each saying whether it is published. Empty for a project the member cannot see, or none.
 */
export async function loadProjectAchievements(workspaceId: string, projectId: string): Promise<ProjectAchievement[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("project_achievements")
    .select(
      "achievement_id, provider, title, public_title, description, earned_at, earned_precision, evidence, threshold, simulated, project_achievement_publications(project_achievement_id)",
    )
    .eq("workspace_id", workspaceId)
    .eq("project_id", projectId)
    .order("earned_at", { ascending: true })
    .order("achievement_id", { ascending: true })
    .limit(ACHIEVEMENTS_LIMIT);
  if (error) throw new Error("Failed to load the project's achievements", { cause: error });
  return data.map((row) => ({
    id: row.achievement_id,
    provider: row.provider,
    providerName: providerName(row.provider),
    title: row.title,
    publicTitle: row.public_title,
    description: row.description,
    earnedAt: row.earned_at,
    earnedPrecision: row.earned_precision,
    evidence: row.evidence,
    threshold: row.threshold,
    simulated: row.simulated,
    // Embedded through the composite (workspace_id, project_achievement_id) key, so an array of one or none.
    published: row.project_achievement_publications.length > 0,
  }));
}

/** What a timeline entry needs to link to its achievement and offer Share or Publish. */
export type TimelineAchievement = Readonly<{
  projectId: string;
  projectName: string;
  achievementId: string;
  /** The achievement's item in its project's Achievements section. */
  href: string;
  providerName: string;
  publicTitle: string;
  /** Earned from simulator data (#131): the entry says Simulated, as its event has no connection to say it. */
  simulated: boolean;
  published: boolean;
  /** The project's public page while it is on, for the share dialog's links. */
  projectPage: ShareProjectPage | null;
}>;

/**
 * `event` marked simulated when its achievement was earned from simulator data. An "Achievement
 * earned" event is DevMacro's own and has no connection, so its own `simulated` is always false.
 */
export function withAchievementSimulated<E extends Readonly<{ simulated: boolean; achievement: AchievementRef | null }>>(
  event: E,
  achievements: ReadonlyMap<string, Pick<TimelineAchievement, "simulated">>,
): E {
  if (event.achievement === null || event.simulated) return event;
  const achievement = achievements.get(achievementEventDedupeKey(event.achievement.projectId, event.achievement.achievementId));
  return achievement?.simulated === true ? { ...event, simulated: true } : event;
}

export type AchievementRef = Readonly<{ projectId: string; achievementId: string }>;

/**
 * The achievements behind a page of timeline entries, in one query, keyed by the entry's dedupe key
 * (`achievementEventDedupeKey`). An entry whose achievement is gone (deleted with its project
 * between the two reads) has no key in the map.
 */
export async function loadTimelineAchievements(
  workspace: Readonly<{ id: string; slug: string }> & PublicAddressOwner,
  refs: readonly AchievementRef[],
): Promise<Map<string, TimelineAchievement>> {
  const found = new Map<string, TimelineAchievement>();
  if (refs.length === 0) return found;
  const wanted = new Set(refs.map((ref) => achievementEventDedupeKey(ref.projectId, ref.achievementId)));
  const supabase = await createClient();
  // Filtered by project and by achievement id separately, then matched in pairs below: a page holds
  // at most 50 entries, so the cross product the filter allows stays small.
  const { data, error } = await supabase
    .from("project_achievements")
    .select(
      "project_id, achievement_id, provider, public_title, simulated, project_achievement_publications(project_achievement_id), projects!project_achievements_project_fkey(name, project_pages(slug, enabled))",
    )
    .eq("workspace_id", workspace.id)
    .in("project_id", [...new Set(refs.map((ref) => ref.projectId))])
    .in("achievement_id", [...new Set(refs.map((ref) => ref.achievementId))])
    .limit(ACHIEVEMENTS_LIMIT);
  if (error) throw new Error("Failed to load the achievements on this timeline page", { cause: error });
  for (const row of data) {
    const key = achievementEventDedupeKey(row.project_id, row.achievement_id);
    if (!wanted.has(key) || row.projects === null) continue;
    const page = row.projects.project_pages.find((candidate) => candidate.enabled);
    found.set(key, {
      projectId: row.project_id,
      projectName: row.projects.name,
      achievementId: row.achievement_id,
      href: achievementHref(workspace.slug, row.project_id, row.achievement_id),
      providerName: providerName(row.provider),
      publicTitle: row.public_title,
      simulated: row.simulated,
      published: row.project_achievement_publications.length > 0,
      projectPage: page === undefined ? null : { path: projectPagePath(workspace, page.slug), projectName: row.projects.name },
    });
  }
  return found;
}
