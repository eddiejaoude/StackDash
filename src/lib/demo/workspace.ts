import "server-only";

import type { SupabaseClient, User } from "@supabase/supabase-js";

import { createOAuthContext, loadOAuthClient } from "@/lib/adapters/registry";
import { SIMULATED_CODE_PREFIX, simulatedAdapters } from "@/lib/adapters/simulated";
import { simulatedCredentialMetadata } from "@/lib/adapters/simulated/marker";
import type { ProviderId } from "@/lib/adapters/types";
import { alertRuleInputSchema, budgetInputSchema } from "@/lib/alerts/rule-schema";
import { completeConnection, WorkspaceNotEmptyError } from "@/lib/connections/connect";
import { createJobDeps } from "@/lib/jobs/queue";
import { countsProvider, PUBLIC_METRICS, publicMetricDefinition, type PublicMetricId } from "@/lib/public-metrics/definitions";
import { publicationSummary } from "@/lib/public-metrics/display";
import { projectPagePath } from "@/lib/public-metrics/project-page";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

import { demoAccountSeed, headlineWeekDays, historySteps, replayClock, replayHistory } from "./history";
import { DEMO_USER_MARKER, isDemoAccount } from "./sign-in";

/*
 * The demo account and workspace (#166), written with the service role on the local stack only
 * (the caller checks `demoCommandRefusal` first). A rerun deletes the workspaces the demo account
 * created, except its personal one, and builds a fresh one, so there is only ever one demo
 * workspace. Connections go through `completeConnection`, exactly as the OAuth callback makes
 * them; budgets and alert rules go through alert settings' input schemas. Sample data (#257) is
 * the one in-app caller: it connects the simulated providers to a member's own empty workspace,
 * behind the role check and `sampleDataRefusal` instead.
 */

type Admin = SupabaseClient<Database>;

/** A reserved example.com address, so the demo account can never be a real person. */
export const DEMO_USER_EMAIL = "demo@example.com";
export const DEMO_WORKSPACE_NAME = "Demo workspace";
export const DEMO_PROJECT_NAMES = ["Storefront", "Marketing site", "Internal tools"] as const;
const USER_PAGE_SIZE = 1000;
// A local stack holds a handful of users; past this the email is treated as not found.
const USER_MAX_PAGES = 20;
const DEMO_WORKSPACE_LIMIT = 100;
const ACCOUNTS_LIMIT = 500;

async function findUserByEmail(admin: Admin, email: string): Promise<User | null> {
  for (let page = 1; page <= USER_MAX_PAGES; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: USER_PAGE_SIZE });
    if (error) throw new Error(`Listing users failed: ${error.message}`, { cause: error });
    const found = data.users.find((user) => user.email?.toLowerCase() === email);
    if (found !== undefined) return found;
    if (data.users.length < USER_PAGE_SIZE) return null;
  }
  return null;
}

/**
 * The demo account's id, creating it on the first run. Refuses an account with the demo email that
 * the seed did not create, so a rerun never deletes anything it does not own.
 */
export async function ensureDemoUser(admin: Admin): Promise<string> {
  const existing = await findUserByEmail(admin, DEMO_USER_EMAIL);
  if (existing !== null) {
    if (!isDemoAccount(existing.app_metadata)) {
      throw new Error(`${DEMO_USER_EMAIL} already exists and was not made by the demo seed, so the seed leaves it alone.`);
    }
    return existing.id;
  }
  // The before-user-created hook lets Supabase create only invited emails.
  const { error: inviteError } = await admin
    .from("access_invites")
    .upsert({ email: DEMO_USER_EMAIL, invited_by: "demo seed" }, { onConflict: "email", ignoreDuplicates: true });
  if (inviteError) throw new Error(`Inviting ${DEMO_USER_EMAIL} failed (code ${inviteError.code}).`);
  // No password: the demo account signs in only with the one-time link `npm run demo` and
  // `npm run demo:seed` print (#260), which `/auth/confirm` accepts on a local stack only.
  const { data, error } = await admin.auth.admin.createUser({
    email: DEMO_USER_EMAIL,
    email_confirm: true,
    app_metadata: { [DEMO_USER_MARKER]: true },
    user_metadata: { user_name: "demo" },
  });
  if (error) throw new Error(`Creating ${DEMO_USER_EMAIL} failed: ${error.message}`, { cause: error });
  return data.user.id;
}

/**
 * The `--member` emails to look up, each once and in the order given. The demo account is refused:
 * it already owns the workspace, and a second membership row for it would fail only after the
 * previous demo workspace was deleted.
 */
export function memberEmails(emails: readonly string[]): string[] {
  const unique = [...new Set(emails)];
  if (unique.includes(DEMO_USER_EMAIL)) {
    throw new Error(`${DEMO_USER_EMAIL} is the demo account, which already owns the demo workspace. Give --member the email you sign in to StackDash with.`);
  }
  return unique;
}

/** Ids of existing accounts to add to the demo workspace, checked before anything is written. */
export async function resolveMembers(admin: Admin, emails: readonly string[]): Promise<Array<{ email: string; userId: string }>> {
  const members: Array<{ email: string; userId: string }> = [];
  for (const email of memberEmails(emails)) {
    const user = await findUserByEmail(admin, email);
    if (user === null) {
      throw new Error(`No account uses ${email}. Sign in to StackDash with GitHub once, then run the demo seed again.`);
    }
    members.push({ email, userId: user.id });
  }
  return members;
}

export type DemoWorkspace = Readonly<{ id: string; slug: string }>;

/**
 * Deletes every workspace the demo account created other than its personal one (everything in
 * them goes by cascade), then creates a fresh demo workspace and adds the members as admins.
 */
export async function resetDemoWorkspace(
  admin: Admin,
  userId: string,
  members: ReadonlyArray<{ userId: string }>,
): Promise<DemoWorkspace & { deleted: number }> {
  const { data: deleted, error: deleteError } = await admin
    .from("workspaces")
    .delete()
    .eq("created_by", userId)
    .eq("is_personal", false)
    .select("id")
    .limit(DEMO_WORKSPACE_LIMIT);
  if (deleteError) throw new Error(`Deleting the old demo workspace failed (code ${deleteError.code}).`);

  const { data, error } = await admin.rpc("create_workspace", {
    p_user_id: userId,
    p_name: DEMO_WORKSPACE_NAME,
    p_is_personal: false,
  });
  if (error) throw new Error(`Creating the demo workspace failed (code ${error.code}).`);

  if (members.length > 0) {
    const { error: memberError } = await admin
      .from("workspace_members")
      .insert(members.map((member) => ({ workspace_id: data.id, user_id: member.userId, role: "admin" as const })));
    if (memberError) throw new Error(`Adding members to the demo workspace failed (code ${memberError.code}).`);
  }
  return { id: data.id, slug: data.slug, deleted: deleted.length };
}

/**
 * The demo workspace the last `npm run demo:seed` built, or null when there is none: no demo
 * account, an account with the demo email that the seed did not create, or no workspace yet.
 */
export async function findDemoWorkspace(admin: Admin): Promise<(DemoWorkspace & { name: string }) | null> {
  const user = await findUserByEmail(admin, DEMO_USER_EMAIL);
  if (user === null || !isDemoAccount(user.app_metadata)) return null;
  const { data, error } = await admin
    .from("workspaces")
    .select("id, slug, name")
    .eq("created_by", user.id)
    .eq("is_personal", false)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Reading the demo workspace failed (code ${error.code}).`);
  return data;
}

export type DemoConnection = Readonly<{ id: string; provider: ProviderId }>;

/**
 * Connects every simulated provider in the registry, as the OAuth callback would, with the
 * credential's account seed fixed by `seed`. Nothing syncs yet: the history replay does that. The
 * first connection goes in only while the workspace has none (#287), so of two sets started
 * together only one lands: the other throws WorkspaceNotEmptyError before writing anything.
 */
export async function connectSimulatedProviders(input: Readonly<{
  workspaceId: string;
  userId: string;
  seed: string;
  now: Date;
}>): Promise<DemoConnection[]> {
  const connections: DemoConnection[] = [];
  for (const adapter of Object.values(simulatedAdapters)) {
    const client = loadOAuthClient(adapter);
    if (client === null) throw new Error(`Simulated ${adapter.displayName} is not available: provider simulation is off.`);
    const ctx = { ...createOAuthContext(client), now: () => input.now };
    const minted = await adapter.exchangeCode(
      { code: `${SIMULATED_CODE_PREFIX}demo-seed`, redirectUri: "http://localhost/demo-seed", callbackParams: {} },
      ctx,
    );
    const credential = { ...minted, metadata: simulatedCredentialMetadata(demoAccountSeed(input.seed, adapter.id)) };
    const { connectionId } = await completeConnection({
      adapter,
      ctx,
      workspaceId: input.workspaceId,
      userId: input.userId,
      credential,
      // Once the first is in, the workspace has a connection, so the rest of the set follows it.
      ...(connections.length === 0 ? { onlyIntoEmptyWorkspace: true as const } : {}),
    });
    connections.push({ id: connectionId, provider: adapter.id });
  }
  return connections;
}

/** The timeline's search param, set to "added" right after sample data was added. */
export const SAMPLE_DATA_ADDED_PARAM = "sample";

// sampleDataRefusal's answer for a workspace with connections, and addSampleData's for one that
// gained a connection after that check, such as another submit's (#287).
const NOT_EMPTY_REFUSAL =
  "This workspace already has connections. Sample data is only added to a workspace with none, so it never mixes with real data.";

/**
 * Why sample data (#257) cannot be added to a workspace, or null when it can. Only with provider
 * simulation on, the same switch that offers simulated providers in the catalog, and only to a
 * workspace with no connections, so made-up data never sits beside real data.
 */
export function sampleDataRefusal(input: Readonly<{ simulationEnabled: boolean; connectionCount: number }>): string | null {
  if (!input.simulationEnabled) return "Sample data is only available while provider simulation is on.";
  if (input.connectionCount > 0) return NOT_EMPTY_REFUSAL;
  return null;
}

/** What adding sample data did: connected the simulated providers, or nothing, and why not. */
export type SampleDataOutcome =
  | Readonly<{ kind: "added"; connections: DemoConnection[] }>
  | Readonly<{ kind: "refused"; refusal: string }>;

/**
 * Sample data for an empty workspace (#257): every simulated provider connected as the demo seed
 * connects them, then the current week and the day before it replayed through the same jobs a
 * tick runs, ending at the present (`headlineWeekDays`), so the timeline, the billing period cards,
 * and the dashboard headline's week to date all have figures in one action. At most nine steps (a
 * summer Sunday night, already Monday in London), against the seed's 90 days, so it fits in a
 * request. Replayed alerts count as already sent, as the seed's do. The caller authorizes the user
 * as an owner or admin of the workspace and checks `sampleDataRefusal` first. A workspace that
 * gained a connection since, such as from another submit that got there first (#287), is refused
 * the same way, with nothing written.
 */
export async function addSampleData(input: Readonly<{ workspaceId: string; userId: string; now: Date }>): Promise<SampleDataOutcome> {
  const steps = historySteps(input.now, headlineWeekDays(input.now));
  const [first] = steps;
  if (first === undefined) throw new Error("The sample data history has no steps.");
  let connections: DemoConnection[];
  try {
    connections = await connectSimulatedProviders({
      workspaceId: input.workspaceId,
      userId: input.userId,
      seed: input.workspaceId,
      now: first.at,
    });
  } catch (error) {
    if (error instanceof WorkspaceNotEmptyError) return { kind: "refused", refusal: NOT_EMPTY_REFUSAL };
    throw error;
  }
  await replayHistory({
    ...replayClock(createJobDeps(), first.at),
    workspaceId: input.workspaceId,
    connectionIds: connections.map((connection) => connection.id),
    steps,
  });
  await markDemoAlertsSent(createAdminClient(), { workspaceId: input.workspaceId, at: input.now });
  return { kind: "added", connections };
}

/**
 * Creates the demo projects and spreads the accounts over them in registry order, so "By project"
 * has spend in more than one project whichever providers the registry holds.
 */
export async function assignDemoProjects(
  admin: Admin,
  input: Readonly<{ workspaceId: string; userId: string; connections: readonly DemoConnection[] }>,
): Promise<void> {
  const { data: projects, error } = await admin
    .from("projects")
    .insert(DEMO_PROJECT_NAMES.map((name) => ({ workspace_id: input.workspaceId, name, created_by: input.userId, updated_by: input.userId })))
    .select("id, name");
  if (error) throw new Error(`Creating the demo projects failed (code ${error.code}).`);
  const projectIds = DEMO_PROJECT_NAMES.map((name) => projects.find((project) => project.name === name)?.id);

  const { data: accounts, error: accountsError } = await admin
    .from("external_accounts")
    .select("id, connection_id, external_id")
    .eq("workspace_id", input.workspaceId)
    .order("external_id")
    .limit(ACCOUNTS_LIMIT);
  if (accountsError) throw new Error(`Reading the demo accounts failed (code ${accountsError.code}).`);
  const order = new Map(input.connections.map((connection, index) => [connection.id, index]));
  const sorted = accounts.toSorted((a, b) => (order.get(a.connection_id) ?? 0) - (order.get(b.connection_id) ?? 0));

  const byProject = new Map<string, string[]>();
  sorted.forEach((account, index) => {
    const projectId = projectIds[index % projectIds.length];
    if (projectId === undefined) return;
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), account.id]);
  });
  await Promise.all(
    [...byProject].map(async ([projectId, accountIds]) => {
      const { error: updateError } = await admin
        .from("external_accounts")
        .update({ project_id: projectId })
        .eq("workspace_id", input.workspaceId)
        .in("id", accountIds);
      if (updateError) throw new Error(`Assigning demo accounts to projects failed (code ${updateError.code}).`);
    }),
  );
}

// A month of simulated Vercel spend runs to about $760 with its launch day
// (src/lib/adapters/simulated/vercel.ts), so this budget's 90 percent threshold ($540) is crossed
// in the third week of each full month of the history. Exported because the simulated providers'
// scale is pinned against it (#264): a month of their revenue and spend stays within ten times it.
export const DEMO_VERCEL_BUDGET = { name: "Vercel monthly", amount: "600", currency: "USD" } as const;
// The simulated Resend team sends about 97 percent of its 3,000 emails a month
// (src/lib/adapters/simulated/resend.ts), so this quota alert fires in the last days of a month.
const RESEND_MONTHLY_QUOTA = "resend.emails.monthly";
const DEMO_THRESHOLD_PERCENT = "90";

/**
 * A Vercel budget with a 90 percent alert, and a 90 percent alert on the Resend monthly quota,
 * validated by the same schemas as alert settings. The replay then triggers them like a live
 * sync would.
 */
export async function createDemoAlerts(admin: Admin, input: Readonly<{ workspaceId: string; userId: string }>): Promise<void> {
  const audit = { workspace_id: input.workspaceId, created_by: input.userId, updated_by: input.userId };
  const budget = budgetInputSchema.parse({ ...DEMO_VERCEL_BUDGET, scope: "provider", provider: "vercel" });
  const { data, error } = await admin.from("budgets").insert({ ...budget, ...audit }).select("id").single();
  if (error) throw new Error(`Creating the demo budget failed (code ${error.code}).`);
  const rules = [
    alertRuleInputSchema.parse({
      kind: "budget_percent",
      scope: "provider",
      provider: "vercel",
      budgetId: data.id,
      thresholdPreset: DEMO_THRESHOLD_PERCENT,
    }),
    alertRuleInputSchema.parse({
      kind: "allowance_percent",
      scope: "provider",
      provider: "resend",
      metricKey: RESEND_MONTHLY_QUOTA,
      thresholdPreset: DEMO_THRESHOLD_PERCENT,
    }),
  ];
  const { error: ruleError } = await admin.from("alert_rules").insert(rules.map((rule) => ({ ...rule, ...audit })));
  if (ruleError) throw new Error(`Creating the demo alert rules failed (code ${ruleError.code}).`);
}

/** The demo project with a public page (#150), the page the public demo (#145) shows. */
export const DEMO_PAGE_PROJECT = DEMO_PROJECT_NAMES[0];
const DEMO_PAGE_SLUG = "storefront";

/** Every metric the providers connected to a project can count, in definition order. */
export function demoPublicMetricIds(providers: readonly ProviderId[]): PublicMetricId[] {
  return PUBLIC_METRICS.filter((definition) => providers.some((provider) => countsProvider(definition, provider))).map((definition) => definition.id);
}

/**
 * Publishes every metric the demo page project's providers can count, exact and current, and turns
 * its project page on (not indexable), through the same functions as the public metrics page, so
 * each change writes its timeline event. Returns the page's address.
 */
export async function publishDemoProjectPage(
  admin: Admin,
  input: Readonly<{ workspaceId: string; workspaceSlug: string; userId: string }>,
): Promise<string> {
  const { data: project, error } = await admin
    .from("projects")
    .select("id, name")
    .eq("workspace_id", input.workspaceId)
    .eq("name", DEMO_PAGE_PROJECT)
    .single();
  if (error) throw new Error(`Reading the demo page project failed (code ${error.code}).`);
  const { data: accounts, error: accountsError } = await admin
    .from("external_accounts")
    .select("connections!inner(provider)")
    .eq("workspace_id", input.workspaceId)
    .eq("project_id", project.id)
    .limit(ACCOUNTS_LIMIT);
  if (accountsError) throw new Error(`Reading the demo page project's accounts failed (code ${accountsError.code}).`);

  const summary = publicationSummary("exact", 0);
  for (const metricId of demoPublicMetricIds(accounts.map((account) => account.connections.provider))) {
    // One at a time: each locks the project row, so parallel calls would only queue there.
    const { error: publishError } = await admin.rpc("publish_metric", {
      p_workspace_id: input.workspaceId,
      p_project_id: project.id,
      p_actor_id: input.userId,
      p_metric_id: metricId,
      p_rounding: "exact",
      p_delay_days: 0,
      p_title: `Published ${publicMetricDefinition(metricId).label}`,
      p_body: `Project ${project.name}. ${summary}.`,
    });
    if (publishError) throw new Error(`Publishing a demo metric failed (code ${publishError.code}).`);
  }

  const { data: saved, error: pageError } = await admin.rpc("save_project_page", {
    p_workspace_id: input.workspaceId,
    p_project_id: project.id,
    p_actor_id: input.userId,
    p_slug: DEMO_PAGE_SLUG,
    p_indexable: false,
  });
  if (pageError) throw new Error(`Turning on the demo project page failed (code ${pageError.code}).`);
  if (saved !== "enabled") throw new Error(`Turning on the demo project page answered ${saved}.`);
  // The seed builds a fresh workspace each run, and a fresh workspace has no handle.
  return projectPagePath({ slug: input.workspaceSlug, handle: null }, DEMO_PAGE_SLUG);
}

/**
 * Marks the alerts the replay triggered as already sent (#152), the way the alert delivery
 * migration treats alerts recorded before delivery existed. They are history: without this the
 * first tick after the seed emails months of them as one "N thresholds were crossed" message.
 * Alerts that trigger once the history continues live are sent as usual.
 */
export async function markDemoAlertsSent(admin: Admin, input: Readonly<{ workspaceId: string; at: Date }>): Promise<void> {
  const { error } = await admin
    .from("triggered_alerts")
    .update({ dispatched_at: input.at.toISOString() })
    .eq("workspace_id", input.workspaceId)
    .is("dispatched_at", null);
  if (error) throw new Error(`Marking the replayed alerts as sent failed (code ${error.code}).`);
}
