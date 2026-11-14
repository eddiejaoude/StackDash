import type { Page } from "@playwright/test";

import { expect, ownerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import { adminClient, createTestWorkspace, cronSecret, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";

/*
 * Earning an achievement (#413), end to end: a sync earns it and writes exactly one "Achievement
 * earned" timeline entry, and a repeated sync neither duplicates nor moves it.
 *
 * A real sync is the trigger, the way production earns achievements: Sentry connects simulated
 * through the dev consent screen (the web server runs with DEVMACRO_SIMULATE_PROVIDERS=1), its
 * three example projects become accounts, and those are assigned to a DevMacro project before the
 * first sync. POST /api/jobs/tick then syncs the connection, and the runner evaluates the project's
 * achievements right after (src/lib/jobs/sync-connection.ts). Every simulated Sentry project
 * releases every 20 minutes, so the 30 minute backfill always holds a release, which earns "First
 * Sentry release recorded" (sentry.releases.first). The tick is instance-wide, so this spec lives in
 * the `instance-wide` Playwright project (playwright.config.ts), like simulated-sentry.spec.ts.
 */

const ACHIEVEMENT_ID = "sentry.releases.first";
const ACHIEVEMENT_TITLE = "First Sentry release recorded";
const EARNED_TYPE_ID = "devmacro.achievement_earned";

/** Ticks until the workspace's Sentry connection has synced after `after` (or at all). */
async function tickUntilSynced(page: Page, workspace: TestWorkspace, after: string | null): Promise<string> {
  const authorization = `Bearer ${cronSecret()}`;
  let syncedAt = "";
  await expect(async () => {
    const response = await page.request.post("/api/jobs/tick", { headers: { Authorization: authorization }, timeout: 120_000 });
    expect(response.status()).toBe(200);
    const { data, error } = await adminClient()
      .from("connections")
      .select("last_synced_at")
      .eq("workspace_id", workspace.id)
      .eq("provider", "sentry")
      .limit(1);
    if (error) throw new Error(`Reading connections failed (code ${error.code}).`);
    const last = data[0]?.last_synced_at ?? null;
    expect(last).not.toBeNull();
    if (after !== null) expect(Date.parse(last ?? "")).toBeGreaterThan(Date.parse(after));
    syncedAt = last ?? "";
  }).toPass({ timeout: 90_000 });
  return syncedAt;
}

/** A project holding every account in the workspace (the Sentry connection's three). */
async function assignAccountsToProject(workspace: TestWorkspace): Promise<string> {
  const admin = adminClient();
  const { data: project, error } = await admin
    .from("projects")
    .insert({ workspace_id: workspace.id, name: "Achievements", created_by: workspace.ownerId })
    .select("id")
    .single();
  if (error) throw new Error(`Seeding a project failed (code ${error.code}).`);
  const { data: accounts, error: accountError } = await admin
    .from("external_accounts")
    .update({ project_id: project.id })
    .eq("workspace_id", workspace.id)
    .select("id");
  if (accountError) throw new Error(`Assigning accounts failed (code ${accountError.code}).`);
  expect(accounts).toHaveLength(3);
  return project.id;
}

type Earned = Readonly<{ achievements: { achievement_id: string; earned_at: string; simulated: boolean }[]; events: { dedupe_key: string; occurred_at: string; title: string }[] }>;

async function earned(workspace: TestWorkspace, projectId: string): Promise<Earned> {
  const admin = adminClient();
  const [achievements, events] = await Promise.all([
    admin
      .from("project_achievements")
      .select("achievement_id, earned_at, simulated")
      .eq("workspace_id", workspace.id)
      .eq("project_id", projectId)
      .order("achievement_id")
      .limit(100),
    admin
      .from("activity_events")
      .select("dedupe_key, occurred_at, title")
      .eq("workspace_id", workspace.id)
      .eq("type_id", EARNED_TYPE_ID)
      .order("dedupe_key")
      .limit(100),
  ]);
  if (achievements.error) throw new Error(`Reading achievements failed (code ${achievements.error.code}).`);
  if (events.error) throw new Error(`Reading achievement events failed (code ${events.error.code}).`);
  return { achievements: achievements.data, events: events.data };
}

/** Each earned achievement has exactly one timeline entry, at its earned date, and nothing else does. */
function expectOneEntryEach(state: Earned, projectId: string): void {
  expect(state.events.map((event) => event.dedupe_key)).toEqual(
    state.achievements.map((achievement) => `achievement:${projectId}:${achievement.achievement_id}`),
  );
  for (const [index, achievement] of state.achievements.entries()) {
    expect(Date.parse(state.events[index]?.occurred_at ?? "")).toBe(Date.parse(achievement.earned_at));
  }
}

ownerTest.describe("earning achievements", () => {
  ownerTest("a sync earns an achievement with one timeline entry, and a repeated sync changes neither", async ({ page }) => {
    ownerTest.slow();
    const workspace = await createTestWorkspace("Achievements earning");
    try {
      await connectSimulated(page, workspace.slug, "Sentry");
      const projectId = await assignAccountsToProject(workspace);

      const firstSync = await tickUntilSynced(page, workspace, null);
      const first = await earned(workspace, projectId);
      const release = first.achievements.find((achievement) => achievement.achievement_id === ACHIEVEMENT_ID);
      expect(release).toBeDefined();
      // The simulated Sentry connection's data is made up, so the achievement says so. (Its
      // timeline row carries no per-row label here: when every connection in view is simulated, the
      // timeline marks the whole page instead, as for any event.)
      expect(release?.simulated).toBe(true);
      expectOneEntryEach(first, projectId);
      expect(first.events.find((event) => event.dedupe_key.endsWith(`:${ACHIEVEMENT_ID}`))?.title).toBe(ACHIEVEMENT_TITLE);

      // Dated to the first stored release of the project's accounts, not to the sync.
      const { data: releases, error } = await adminClient()
        .from("activity_events")
        .select("occurred_at")
        .eq("workspace_id", workspace.id)
        .eq("type_id", "sentry.release.created")
        .order("occurred_at")
        .order("id")
        .limit(1);
      if (error) throw new Error(`Reading releases failed (code ${error.code}).`);
      expect(Date.parse(release?.earned_at ?? "")).toBe(Date.parse(releases[0]?.occurred_at ?? ""));

      // The member sees it once on the timeline.
      await page.goto(`/w/${workspace.slug}/timeline?type=${EARNED_TYPE_ID}`);
      const entries = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      await expect(entries.filter({ hasText: ACHIEVEMENT_TITLE })).toHaveCount(1);

      // Sync again: make the connection due and tick until it has synced once more.
      const { error: dueError } = await adminClient()
        .from("connections")
        .update({ next_sync_at: new Date(Date.now() - 60_000).toISOString() })
        .eq("workspace_id", workspace.id)
        .eq("provider", "sentry");
      if (dueError) throw new Error(`Making the connection due failed (code ${dueError.code}).`);
      await tickUntilSynced(page, workspace, firstSync);

      const second = await earned(workspace, projectId);
      expectOneEntryEach(second, projectId);
      expect(second.achievements.find((achievement) => achievement.achievement_id === ACHIEVEMENT_ID)).toEqual(release);

      await page.reload();
      await expect(entries.filter({ hasText: ACHIEVEMENT_TITLE })).toHaveCount(1);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
