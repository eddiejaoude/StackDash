import { adminClient, notDueForAMonth, type TestWorkspace } from "./db";

// Public project pages (#150): a project with stored history, seeded with the service role inside
// one test workspace, so specs never depend on each other's data.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days of star history seeded; the count climbs past 100 and 1,000 inside it. */
export const STAR_HISTORY_DAYS = 35;
/** Today's star count; each earlier day has 35 fewer. */
export const STARS_TODAY = 1204;

/** One real (not simulated) connection and its account, synced a few minutes ago, in the project. */
async function seedAccount(workspace: TestWorkspace, projectId: string, provider: "github" | "vercel", now: Date): Promise<{ connectionId: string; accountId: string }> {
  const admin = adminClient();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider,
      status: "active",
      granted_at: new Date().toISOString(),
      display_name: provider === "github" ? "GitHub" : "Vercel",
      poll_interval_seconds: 3600,
      next_sync_at: notDueForAMonth(),
      last_synced_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_id: `project-pages-e2e-${provider}`,
      // An account name that must never reach a public page.
      display_name: "example-org",
      kind: "organization",
      project_id: projectId,
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  return { connectionId: connection.id, accountId: account.id };
}

/**
 * "Acme web" with a GitHub account whose star count climbs to 1,204 over 35 days, and a Vercel
 * account with a deployment a day for 20 days. Nothing is published. Returns the project id.
 */
export async function seedProjectWithHistory(workspace: TestWorkspace): Promise<string> {
  const admin = adminClient();
  const now = new Date();
  const { data: project, error: projectError } = await admin
    .from("projects")
    .insert({ workspace_id: workspace.id, name: "Acme web" })
    .select("id")
    .single();
  if (projectError) throw new Error(`Seeding a project failed (code ${projectError.code}).`);

  const github = await seedAccount(workspace, project.id, "github", now);
  const vercel = await seedAccount(workspace, project.id, "vercel", now);

  const today = now.toISOString().slice(0, 10);
  const snapshots = Array.from({ length: STAR_HISTORY_DAYS }, (_, daysAgo) => {
    // Today's reading from a few minutes ago; earlier days' last reading late that day.
    const retrievedAt = daysAgo === 0 ? new Date(now.getTime() - 5 * 60_000) : new Date(Date.parse(`${today}T23:00:00Z`) - daysAgo * DAY_MS);
    return {
      workspace_id: workspace.id,
      connection_id: github.connectionId,
      external_account_id: github.accountId,
      metric_key: "github.stars.total",
      kind: "usage" as const,
      label: "Stars across connected repositories",
      snapshot_date: retrievedAt.toISOString().slice(0, 10),
      value: STARS_TODAY - daysAgo * 35,
      unit: "stars",
      point_at: retrievedAt.toISOString(),
      retrieved_at: retrievedAt.toISOString(),
      provenance_source: "provider_api",
    };
  });
  const { error: snapshotError } = await admin.from("usage_snapshots").insert(snapshots);
  if (snapshotError) throw new Error(`Seeding snapshots failed (code ${snapshotError.code}).`);

  const deployments = Array.from({ length: 20 }, (_, daysAgo) => ({
    workspace_id: workspace.id,
    connection_id: vercel.connectionId,
    external_account_id: vercel.accountId,
    provider: "vercel" as const,
    type_id: "vercel.deployment.succeeded",
    severity: "info" as const,
    title: "Deployment succeeded",
    occurred_at: new Date(now.getTime() - (daysAgo * 24 + 2) * 60 * 60 * 1000).toISOString(),
    dedupe_key: `project-pages-e2e-deployment-${daysAgo}`,
  }));
  const { error: eventError } = await admin.from("activity_events").insert(deployments);
  if (eventError) throw new Error(`Seeding events failed (code ${eventError.code}).`);
  return project.id;
}

/**
 * Public metrics read at most 200 included accounts of a project (ACCOUNTS_LIMIT in
 * src/lib/public-metrics/supabase-store.ts, which this Node process cannot import: it is
 * server-only). Adds `count` more included GitHub accounts to the project, on one new connection.
 */
export async function seedIncludedAccounts(workspace: TestWorkspace, projectId: string, count: number): Promise<void> {
  const admin = adminClient();
  const now = new Date();
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "github",
      status: "active",
      granted_at: new Date().toISOString(),
      display_name: "GitHub organizations",
      poll_interval_seconds: 3600,
      next_sync_at: notDueForAMonth(),
      last_synced_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { error } = await admin.from("external_accounts").insert(
    Array.from({ length: count }, (_, index) => ({
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_id: `project-pages-e2e-many-${index}`,
      display_name: `example-org-${index}`,
      kind: "organization",
      project_id: projectId,
    })),
  );
  if (error) throw new Error(`Seeding accounts failed (code ${error.code}).`);
}

/** Publishes GitHub stars, exact and current, as the workspace owner. */
export async function publishStars(workspace: TestWorkspace, projectId: string): Promise<void> {
  const { error } = await adminClient().rpc("publish_metric", {
    p_workspace_id: workspace.id,
    p_project_id: projectId,
    p_actor_id: workspace.ownerId,
    p_metric_id: "github-stars",
    p_rounding: "exact",
    p_delay_days: 0,
    p_title: "Published GitHub stars",
    p_body: "Project Acme web. Exact, current.",
  });
  if (error) throw new Error(`Publishing failed (code ${error.code}).`);
}

/** Turns the project's page on at `slug` as the workspace owner. */
export async function turnOnPage(workspace: TestWorkspace, projectId: string, slug: string, indexable: boolean): Promise<void> {
  const { data, error } = await adminClient().rpc("save_project_page", {
    p_workspace_id: workspace.id,
    p_project_id: projectId,
    p_actor_id: workspace.ownerId,
    p_slug: slug,
    p_indexable: indexable,
  });
  if (error) throw new Error(`Turning the page on failed (code ${error.code}).`);
  if (data !== "enabled" && data !== "updated") throw new Error(`Turning the page on answered ${data}.`);
}

/** Turns the project's page off as the workspace owner. */
export async function turnOffPage(workspace: TestWorkspace, projectId: string): Promise<void> {
  const { data, error } = await adminClient().rpc("disable_project_page", {
    p_workspace_id: workspace.id,
    p_project_id: projectId,
    p_actor_id: workspace.ownerId,
  });
  if (error) throw new Error(`Turning the page off failed (code ${error.code}).`);
  if (data !== "disabled") throw new Error(`Turning the page off answered ${data}.`);
}

/** Claims `handle` for the workspace as its owner. */
export async function claimHandle(workspace: TestWorkspace, handle: string): Promise<void> {
  const { data, error } = await adminClient().rpc("set_workspace_handle", {
    p_workspace_id: workspace.id,
    p_actor_id: workspace.ownerId,
    p_handle: handle,
  });
  if (error) throw new Error(`Claiming the handle failed (code ${error.code}).`);
  if (data !== "saved") throw new Error(`Claiming the handle answered ${data}.`);
}
