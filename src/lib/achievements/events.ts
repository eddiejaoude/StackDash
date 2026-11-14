/**
 * The timeline entry written when a project earns an achievement (#413). The database writes it,
 * in `record_project_achievements()` (supabase/migrations/20261114120000_project_achievements.sql),
 * with this type id and a dedupe key built the same way as `achievement_event_dedupe_key()`.
 */
export const ACHIEVEMENT_EARNED_TYPE_ID = "stackdash.achievement_earned";

const DEDUPE_KEY_PREFIX = "achievement:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACHIEVEMENT_ID = /^[a-z][a-z0-9_]*(?:\.[a-z0-9_]+)+$/;

export function achievementEventDedupeKey(projectId: string, achievementId: string): string {
  return `${DEDUPE_KEY_PREFIX}${projectId}:${achievementId}`;
}

/** The project and achievement an achievement timeline entry is about, or null for any other key. */
export function parseAchievementEventDedupeKey(
  dedupeKey: string,
): Readonly<{ projectId: string; achievementId: string }> | null {
  if (!dedupeKey.startsWith(DEDUPE_KEY_PREFIX)) return null;
  const rest = dedupeKey.slice(DEDUPE_KEY_PREFIX.length);
  const separator = rest.indexOf(":");
  if (separator < 0) return null;
  const projectId = rest.slice(0, separator);
  const achievementId = rest.slice(separator + 1);
  if (!UUID.test(projectId) || achievementId.length > 100 || !ACHIEVEMENT_ID.test(achievementId)) return null;
  return { projectId, achievementId };
}
