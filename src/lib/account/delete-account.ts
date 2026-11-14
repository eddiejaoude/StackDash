import { ProviderIdSchema, type ProviderId } from "@/lib/adapters/types";
import { REFERENCE_ID_PATTERN } from "@/lib/log/reference";
import type { WorkspaceRole } from "@/lib/workspaces/permissions";

/*
 * Account deletion rules (#42), kept pure so they are unit tested. Loading the facts and carrying
 * out the plan live in src/lib/data/account.ts.
 */

/** One membership of the user, with the counts the rules need. */
export type MembershipFacts = Readonly<{
  workspaceId: string;
  slug: string;
  name: string;
  isPersonal: boolean;
  role: WorkspaceRole;
  // Every member, the user included.
  memberCount: number;
  // Every owner, the user included when they are one.
  ownerCount: number;
}>;

export type DeletionPlan = Readonly<{
  // Only the user belongs here: the workspace and everything in it is deleted with the account.
  deletable: readonly MembershipFacts[];
  // The user is the only owner and others belong here: deletion stops until ownership moves.
  blocked: readonly MembershipFacts[];
  // Other members keep it, with an owner among them: the user only leaves.
  leaving: readonly MembershipFacts[];
}>;

/** Sorts each membership by what deleting the account does to its workspace. */
export function planAccountDeletion(memberships: readonly MembershipFacts[]): DeletionPlan {
  const deletable: MembershipFacts[] = [];
  const blocked: MembershipFacts[] = [];
  const leaving: MembershipFacts[] = [];
  for (const membership of memberships) {
    if (membership.memberCount <= 1) deletable.push(membership);
    else if (membership.role === "owner" && membership.ownerCount <= 1) blocked.push(membership);
    else leaving.push(membership);
  }
  return { deletable, blocked, leaving };
}

export function canDeleteAccount(plan: DeletionPlan): boolean {
  return plan.blocked.length === 0;
}

/** Why deletion stops, naming the workspaces. The page and the action use the same words. */
export function blockedMessage(workspaceNames: readonly string[]): string {
  const one = workspaceNames.length === 1;
  return `You are the only owner of ${workspaceNames.join(", ")}, and other people belong to ${
    one ? "it" : "them"
  }. Transfer ownership to another member or delete ${one ? "that workspace" : "those workspaces"} first, then try again.`;
}

export type AccountIdentity = Readonly<{ email: string | null; userName: string | null }>;

/** The confirmation is the account email or the GitHub username, ignoring case and outer spaces. */
export function confirmationMatches(input: string, identity: AccountIdentity): boolean {
  const typed = input.trim().toLowerCase();
  if (typed === "") return false;
  return [identity.email, identity.userName].some(
    (expected) => expected !== null && expected.trim() !== "" && expected.trim().toLowerCase() === typed,
  );
}

/*
 * What the signed-out "account deleted" page shows. It travels in the redirect URL because the
 * session is gone by then. Only provider ids and reference ids are carried, and the page rebuilds
 * every sentence itself, so an edited URL can only change which known steps are listed.
 */

export type RevocationFailure = Readonly<{ provider: ProviderId; referenceId: string }>;

export type DeletionOutcome = Readonly<{
  // Providers that cannot revoke StackDash's access from StackDash's side.
  manual: readonly ProviderId[];
  // Revocations StackDash attempted that failed.
  failed: readonly RevocationFailure[];
}>;

export const ACCOUNT_DELETED_PATH = "/account/deleted";

// Bounds the URL: a handful of connections at most in the MVP.
const MAX_OUTCOME_ITEMS = 20;

export function accountDeletedPath(outcome: DeletionOutcome): string {
  const query = new URLSearchParams();
  const manual = [...new Set(outcome.manual)].slice(0, MAX_OUTCOME_ITEMS);
  const failed = outcome.failed.slice(0, MAX_OUTCOME_ITEMS);
  if (manual.length > 0) query.set("manual", manual.join(","));
  if (failed.length > 0) query.set("failed", failed.map(({ provider, referenceId }) => `${provider}:${referenceId}`).join(","));
  const search = query.toString();
  return search === "" ? ACCOUNT_DELETED_PATH : `${ACCOUNT_DELETED_PATH}?${search}`;
}

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

/** Reads the outcome back, dropping anything that is not a known provider or a reference id. */
export function parseDeletionOutcome(params: Readonly<Record<string, string | string[] | undefined>>): DeletionOutcome {
  const manual = new Set<ProviderId>();
  for (const part of firstValue(params.manual).split(",").slice(0, MAX_OUTCOME_ITEMS)) {
    const provider = ProviderIdSchema.safeParse(part);
    if (provider.success) manual.add(provider.data);
  }
  const failed: RevocationFailure[] = [];
  for (const part of firstValue(params.failed).split(",").slice(0, MAX_OUTCOME_ITEMS)) {
    const [rawProvider = "", referenceId = ""] = part.split(":");
    const provider = ProviderIdSchema.safeParse(rawProvider);
    if (provider.success && REFERENCE_ID_PATTERN.test(referenceId)) {
      failed.push({ provider: provider.data, referenceId });
    }
  }
  return { manual: [...manual], failed };
}
