import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";

import { DeleteAccountForm } from "@/components/account/delete-account-form";
import { ManualRevokeList } from "@/components/account/manual-revoke-list";
import { MessagesLink } from "@/components/app/account-link";
import { PageHeader } from "@/components/app/page-header";
import { SignOutButton } from "@/components/app/sign-out-button";
import { loadSupportShell } from "@/components/support/load-support-shell";
import { SupportLauncher } from "@/components/support/member/support-launcher";
import { SupportShellProvider } from "@/components/support/support-unread";
import { LiveRegion } from "@/components/ui/live-region";
import { Wordmark } from "@/components/wordmark";
import {
  blockedMessage,
  canDeleteAccount,
  planAccountDeletion,
  type AccountIdentity,
  type DeletionPlan,
} from "@/lib/account/delete-account";
import { requireUser } from "@/lib/auth/session";
import { manualRevokeStep } from "@/lib/connections/revoke";
import { loadAccountIdentity, loadDeletionPreview, loadMembershipFacts, type WorkspaceDeletionSummary } from "@/lib/data/account";
import { PROVIDER_NAMES } from "@/lib/providers";
import { SUPPORT_MESSAGES_PATH } from "@/lib/support/paths";
import { isWorkspaceSlug, workspacePath } from "@/lib/workspaces/paths";

export const metadata: Metadata = { title: "Account" };

// The enforced CSP nonce (src/proxy.ts) needs this page's HTML rendered per request, so the page
// awaits `connection()` before anything renders and allows an empty static shell (#125).
export const instant = false;

const numberFormat = new Intl.NumberFormat("en-US");

function count(value: number, one: string, many: string): string {
  return `${numberFormat.format(value)} ${value === 1 ? one : many}`;
}

/**
 * The signed-in account page (#42). The header renders first; everything that needs the session
 * streams in behind Suspense. The support read (#680) starts here without being awaited, beside the
 * account's own reads, for the Messages link's badge and the support launcher.
 */
export default async function AccountPage() {
  await connection();
  const supportShell = loadSupportShell();
  return (
    <SupportShellProvider shell={supportShell}>
      <div className="flex flex-1 flex-col">
        <header className="border-b border-line">
          <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-4 sm:px-6">
            <Link href="/app" className="inline-flex min-h-6 shrink-0 items-center">
              <Wordmark />
            </Link>
            <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-3">
              <MessagesLink href={SUPPORT_MESSAGES_PATH} />
              {/* The wordmark already opens the workspace, so phones drop this duplicate to keep the row fitting. */}
              <Link
                href="/app"
                className="hidden min-h-9 items-center rounded-md px-3 py-1.5 text-sm text-muted transition-colors hover:text-foreground sm:inline-flex"
              >
                Open your workspace
              </Link>
              <SignOutButton />
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
          <PageHeader title="Account" description="Your sign-in details, and deleting your account." />
          <Suspense fallback={<LoadingAccount />}>
            <AccountContent />
          </Suspense>
        </main>
        <SupportLauncher />
      </div>
    </SupportShellProvider>
  );
}

function LoadingAccount() {
  return (
    <LiveRegion tone="status" className="mt-8">
      <span className="sr-only">Loading your account</span>
      <div aria-hidden="true" className="h-64 rounded-xl border border-dashed border-line bg-panel motion-safe:animate-pulse" />
    </LiveRegion>
  );
}

async function AccountContent() {
  // Session verification reads the clock (token expiry), so it must not run in a prerender.
  await connection();
  const user = await requireUser("/account");
  const [identity, memberships] = await Promise.all([loadAccountIdentity(user.id), loadMembershipFacts(user.id)]);
  const plan = planAccountDeletion(memberships);

  return (
    <>
      <section aria-labelledby="account-details-title" className="mt-8 rounded-xl border border-line bg-panel">
        <h2 id="account-details-title" className="border-b border-line px-6 py-4 text-sm font-semibold">
          Sign-in details
        </h2>
        <dl className="divide-y divide-line text-sm">
          <div className="grid gap-1 px-6 py-4 sm:grid-cols-3 sm:gap-4">
            <dt className="text-muted">Email address</dt>
            <dd className="break-words sm:col-span-2">{identity.email ?? "No email address on record"}</dd>
          </div>
          <div className="grid gap-1 px-6 py-4 sm:grid-cols-3 sm:gap-4">
            <dt className="text-muted">GitHub username</dt>
            <dd className="break-words sm:col-span-2">{identity.userName ?? "No username on record"}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="delete-account-title" className="mt-6 rounded-xl border border-danger/40 bg-panel">
        <h2 id="delete-account-title" className="border-b border-line px-6 py-4 text-sm font-semibold">
          Delete your account
        </h2>
        <div className="flex flex-col gap-6 px-6 py-5 text-sm leading-6">
          {canDeleteAccount(plan) ? (
            <DeletionDetails plan={plan} identity={identity} />
          ) : (
            <div className="flex flex-col gap-3">
              <h3 className="font-semibold">You cannot delete your account yet</h3>
              <p>{blockedMessage(plan.blocked.map(({ name }) => name))}</p>
              <ul aria-label="Workspaces that need another owner" className="list-disc space-y-1 pl-5">
                {plan.blocked.map((workspace) => (
                  <li key={workspace.workspaceId}>
                    {isWorkspaceSlug(workspace.slug) ? (
                      <Link href={workspacePath(workspace.slug, "settings")} className="underline underline-offset-4">
                        {workspace.name}
                      </Link>
                    ) : (
                      workspace.name
                    )}{" "}
                    <span className="text-muted">({count(workspace.memberCount - 1, "other member", "other members")})</span>
                  </li>
                ))}
              </ul>
              <p className="text-muted">Nothing has been deleted.</p>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

async function DeletionDetails({
  plan,
  identity,
}: {
  plan: DeletionPlan;
  identity: AccountIdentity;
}) {
  const preview = await loadDeletionPreview(plan.deletable);
  return (
    <>
      <div>
        <h3 className="font-semibold">What is deleted</h3>
        <p className="mt-1 text-muted">This cannot be undone.</p>
        <ul aria-label="What is deleted" className="mt-3 flex flex-col gap-3">
          <li className="rounded-lg border border-line bg-panel-raised px-4 py-3">
            Your profile, your sign-in, your membership of every workspace, and every metric you published.
          </li>
          {preview.workspaces.map((workspace) => (
            <WorkspaceDeletion key={workspace.workspaceId} workspace={workspace} />
          ))}
        </ul>
      </div>

      {plan.leaving.length === 0 ? null : (
        <div>
          <h3 className="font-semibold">Workspaces you leave</h3>
          <p className="mt-1 text-muted">
            Other people keep these. The connections, budgets, and alert rules you created in them stay with the
            workspace. Metrics you published in them are removed and stop being public.
          </p>
          <ul aria-label="Workspaces you leave" className="mt-2 list-disc space-y-1 pl-5">
            {plan.leaving.map((workspace) => (
              <li key={workspace.workspaceId}>{workspace.name}</li>
            ))}
          </ul>
        </div>
      )}

      {preview.revocable.length === 0 && preview.manual.length === 0 ? null : (
        <div>
          <h3 className="font-semibold">Provider access</h3>
          {preview.revocable.length === 0 ? null : (
            <p className="mt-1">
              StackDash asks {preview.revocable.map((provider) => PROVIDER_NAMES[provider]).join(", ")} to revoke its
              access. If a request fails, the next page tells you how to remove access by hand.
            </p>
          )}
          {preview.manual.length === 0 ? null : (
            <>
              <p className="mt-1">These providers cannot be revoked automatically. Remove StackDash&apos;s access there yourself:</p>
              <div className="mt-3">
                <ManualRevokeList
                  label="Providers to revoke by hand"
                  items={preview.manual.map((provider) => ({
                    key: provider,
                    providerName: PROVIDER_NAMES[provider],
                    reason: `${PROVIDER_NAMES[provider]} does not let apps revoke their own access.`,
                    steps: manualRevokeStep(provider),
                  }))}
                />
              </div>
            </>
          )}
        </div>
      )}

      <DeleteAccountForm identity={identity} />
    </>
  );
}

function WorkspaceDeletion({ workspace }: { workspace: WorkspaceDeletionSummary }) {
  return (
    <li className="rounded-lg border border-line bg-panel-raised px-4 py-3">
      <p className="font-medium">
        The {workspace.name} workspace{workspace.isPersonal ? " (personal)" : ""}, with:
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
        {workspace.connections.length === 0 ? (
          <li>No connections</li>
        ) : (
          workspace.connections.map(({ provider, count: connections }) => (
            <li key={provider}>
              {count(connections, `${PROVIDER_NAMES[provider]} connection`, `${PROVIDER_NAMES[provider]} connections`)} and
              their stored credentials
            </li>
          ))
        )}
        <li>{count(workspace.connectedAccounts, "connected account", "connected accounts")}</li>
        <li>{count(workspace.projects, "project", "projects")}</li>
        <li>{count(workspace.budgets, "budget", "budgets")}</li>
        <li>{count(workspace.alertRules, "alert rule", "alert rules")}</li>
        <li>
          About {count(workspace.historyRows, "history record", "history records")} (usage, timeline events, and
          triggered alerts)
        </li>
      </ul>
    </li>
  );
}
