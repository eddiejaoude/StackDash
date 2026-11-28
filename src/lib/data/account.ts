import "server-only";

import {
  canDeleteAccount,
  planAccountDeletion,
  type AccountIdentity,
  type DeletionOutcome,
  type MembershipFacts,
  type RevocationFailure,
} from "@/lib/account/delete-account";
import type { ProviderId } from "@/lib/adapters/types";
import { disconnectConnection, supportsRevoke, type RevokeOutcome } from "@/lib/connections/revoke";
import { deleteCredential } from "@/lib/data/credentials";
import { log, logError } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { deleteOwnerObjects } from "@/lib/support/attachment-store";
import type { Database } from "@/lib/supabase/database.types";

/*
 * Account deletion (#42). Everything here runs with the service role, because deletion touches the
 * auth user and credentials, and because the plan must count every member of a workspace, not only
 * the rows row level security happens to show. Every query is filtered to the signed-in user's id
 * or to workspaces from that user's own plan, so callers must pass the id from `requireUser`, never
 * one from the client.
 */

type ConnectionStatus = Database["public"]["Enums"]["connection_status"];

// Bounds that fail closed: a plan built from a truncated list could delete a shared workspace's
// credentials, so going past one is an error, not a shorter list.
const MAX_MEMBERSHIPS = 200;
const MAX_MEMBER_ROWS = 5000;
const MAX_CONNECTIONS = 500;
// Connections disconnected at once, so one deletion cannot burst hundreds of provider revoke calls.
const REVOKE_CONCURRENCY = 5;

type CountResult = { count: number | null; error: { code: string } | null };

function countOf({ count, error }: CountResult, what: string): number {
  if (error) throw new Error(`Counting ${what} failed (code ${error.code}).`);
  return count ?? 0;
}

/** The email and GitHub username the confirmation accepts, read from the auth record. */
export async function loadAccountIdentity(userId: string): Promise<AccountIdentity> {
  const { data, error } = await createAdminClient().auth.admin.getUserById(userId);
  if (error) throw new Error(`Loading the auth user failed (status ${error.status ?? "unknown"}).`);
  const userName: unknown = data.user.user_metadata.user_name;
  return {
    email: data.user.email ?? null,
    userName: typeof userName === "string" && userName.trim() !== "" ? userName : null,
  };
}

/** Every membership of the user, with member and owner counts for each workspace. */
export async function loadMembershipFacts(userId: string): Promise<MembershipFacts[]> {
  const admin = createAdminClient();
  const { data: memberships, error } = await admin
    .from("workspace_members")
    .select("role, workspaces!inner(id, slug, name, is_personal)")
    .eq("user_id", userId)
    .limit(MAX_MEMBERSHIPS + 1);
  if (error) throw new Error(`Loading memberships failed (code ${error.code}).`);
  if (memberships.length > MAX_MEMBERSHIPS) throw new Error("Too many memberships to plan an account deletion.");
  if (memberships.length === 0) return [];

  const ids = memberships.map((membership) => membership.workspaces.id);
  const { data: members, error: membersError } = await admin
    .from("workspace_members")
    .select("workspace_id, role")
    .in("workspace_id", ids)
    .limit(MAX_MEMBER_ROWS + 1);
  if (membersError) throw new Error(`Loading workspace members failed (code ${membersError.code}).`);
  if (members.length > MAX_MEMBER_ROWS) throw new Error("Too many members to plan an account deletion.");

  return memberships
    .map(({ role, workspaces: workspace }) => {
      const inWorkspace = members.filter((member) => member.workspace_id === workspace.id);
      return {
        workspaceId: workspace.id,
        slug: workspace.slug,
        name: workspace.name,
        isPersonal: workspace.is_personal,
        role,
        memberCount: inWorkspace.length,
        ownerCount: inWorkspace.filter((member) => member.role === "owner").length,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.workspaceId.localeCompare(b.workspaceId));
}

type ConnectionRow = { id: string; workspace_id: string; provider: ProviderId; status: ConnectionStatus };

async function listConnections(workspaceIds: readonly string[]): Promise<ConnectionRow[]> {
  if (workspaceIds.length === 0) return [];
  const { data, error } = await createAdminClient()
    .from("connections")
    .select("id, workspace_id, provider, status")
    .in("workspace_id", workspaceIds)
    .order("created_at", { ascending: true })
    .limit(MAX_CONNECTIONS + 1);
  if (error) throw new Error(`Listing connections failed (code ${error.code}).`);
  if (data.length > MAX_CONNECTIONS) throw new Error("Too many connections to delete in one account deletion.");
  return data;
}

export type WorkspaceDeletionSummary = Readonly<{
  workspaceId: string;
  name: string;
  isPersonal: boolean;
  connections: readonly { provider: ProviderId; count: number }[];
  connectedAccounts: number;
  projects: number;
  budgets: number;
  alertRules: number;
  // Snapshots, timeline events, and triggered alerts. Large tables are estimated, so say "about".
  historyRows: number;
}>;

export type AccountDeletionPreview = Readonly<{
  workspaces: readonly WorkspaceDeletionSummary[];
  // Providers with a connection being deleted that StackDash cannot revoke itself.
  manual: readonly ProviderId[];
  // Providers StackDash asks to revoke its access.
  revocable: readonly ProviderId[];
}>;

/** What deleting the account removes from each workspace in `deletable`. */
export async function loadDeletionPreview(deletable: readonly MembershipFacts[]): Promise<AccountDeletionPreview> {
  const admin = createAdminClient();
  const connections = await listConnections(deletable.map((workspace) => workspace.workspaceId));

  const workspaces = await Promise.all(
    deletable.map(async (workspace): Promise<WorkspaceDeletionSummary> => {
      const id = workspace.workspaceId;
      const [accounts, projects, budgets, alertRules, snapshots, events, triggered] = await Promise.all([
        admin.from("external_accounts").select("id", { count: "exact", head: true }).eq("workspace_id", id),
        admin.from("projects").select("id", { count: "exact", head: true }).eq("workspace_id", id),
        admin.from("budgets").select("id", { count: "exact", head: true }).eq("workspace_id", id),
        admin.from("alert_rules").select("id", { count: "exact", head: true }).eq("workspace_id", id),
        admin.from("usage_snapshots").select("id", { count: "estimated", head: true }).eq("workspace_id", id),
        admin.from("activity_events").select("id", { count: "estimated", head: true }).eq("workspace_id", id),
        admin.from("triggered_alerts").select("id", { count: "estimated", head: true }).eq("workspace_id", id),
      ]);
      const byProvider = new Map<ProviderId, number>();
      for (const connection of connections) {
        if (connection.workspace_id === id) {
          byProvider.set(connection.provider, (byProvider.get(connection.provider) ?? 0) + 1);
        }
      }
      return {
        workspaceId: id,
        name: workspace.name,
        isPersonal: workspace.isPersonal,
        connections: [...byProvider].map(([provider, count]) => ({ provider, count })),
        connectedAccounts: countOf(accounts, "accounts"),
        projects: countOf(projects, "projects"),
        budgets: countOf(budgets, "budgets"),
        alertRules: countOf(alertRules, "alert rules"),
        historyRows:
          countOf(snapshots, "snapshots") + countOf(events, "events") + countOf(triggered, "triggered alerts"),
      };
    }),
  );

  const providers = [...new Set(connections.map((connection) => connection.provider))];
  return {
    workspaces,
    manual: providers.filter((provider) => !supportsRevoke(provider)),
    revocable: providers.filter((provider) => supportsRevoke(provider)),
  };
}

export type AccountDeletionResult =
  | { ok: true; outcome: DeletionOutcome }
  | { ok: false; blocked: readonly MembershipFacts[] };

/**
 * Deletes the account of `userId`, who must be the signed-in user. The plan is rebuilt here, so
 * nothing the browser sent decides what is deleted. Blocked plans change nothing.
 *
 * Every connection in a workspace being deleted is disconnected first, a few at a time: StackDash
 * asks the provider to revoke access where it can (a failure is recorded, not fatal) and deletes the
 * credential. Then the auth user is deleted, and the database cascade removes the profile,
 * memberships, the workspaces only this user belonged to, and every row in them.
 */
export async function deleteUserAccount(userId: string): Promise<AccountDeletionResult> {
  const plan = planAccountDeletion(await loadMembershipFacts(userId));
  if (!canDeleteAccount(plan)) return { ok: false, blocked: plan.blocked };

  const connections = await listConnections(plan.deletable.map((workspace) => workspace.workspaceId));
  const manual = new Set<ProviderId>();
  const failed: RevocationFailure[] = [];
  // Outcomes by connection index, so the failure list keeps the connection order however the pool finishes.
  const outcomes: RevokeOutcome[] = [];
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < connections.length; index = next++) {
      const connection = connections[index];
      if (connection === undefined) continue;
      if (connection.status === "revoked") {
        // Already disconnected; any credential left from a provider-side revoke goes too.
        await deleteCredential({ workspaceId: connection.workspace_id, connectionId: connection.id });
        outcomes[index] = { kind: "revoked" };
        continue;
      }
      // The webhook's endpoint is deleted with the rest; account deletion reports revocation only.
      const { revoke } = await disconnectConnection({
        workspaceId: connection.workspace_id,
        connectionId: connection.id,
        provider: connection.provider,
        userId,
      });
      outcomes[index] = revoke;
    }
  };
  await Promise.all(Array.from({ length: Math.min(REVOKE_CONCURRENCY, connections.length) }, worker));
  connections.forEach(({ provider }, index) => {
    const outcome = outcomes[index];
    if (outcome === undefined) return;
    if (outcome.kind === "failed") failed.push({ provider, referenceId: outcome.referenceId });
    else if (outcome.kind === "not_configured" || !supportsRevoke(provider)) manual.add(provider);
  });

  // Support chat (#680): the user's conversations, messages, and attachment rows go with the auth
  // user (on delete cascade), but no cascade reaches Storage, so the images in their folder are
  // deleted first. A failure does not stop the deletion: the objects are then named by no row, and
  // the retention job deletes such objects within ATTACHMENT_SWEEP_AGE_HOURS.
  try {
    await deleteOwnerObjects(userId);
  } catch (error) {
    logError("account.support_objects_delete_failed", error);
  }

  const { error } = await createAdminClient().auth.admin.deleteUser(userId);
  if (error) throw new Error(`Deleting the auth user failed (status ${error.status ?? "unknown"}).`);

  log.info("account.deleted", {
    deletedWorkspaces: plan.deletable.length,
    leftWorkspaces: plan.leaving.length,
    connections: connections.length,
    revocationFailures: failed.length,
  });
  return { ok: true, outcome: { manual: [...manual], failed } };
}
