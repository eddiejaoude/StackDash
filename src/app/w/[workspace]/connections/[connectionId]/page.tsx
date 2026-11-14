import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/app/page-skeleton";
import { PageHeader } from "@/components/app/page-header";
import {
  AccountIncludedForm,
  AccountProjectForm,
  DeleteConnectionDialog,
  DisconnectDialog,
  SyncNowForm,
} from "@/components/connections/connection-controls";
import { ConnectionStatusBadge } from "@/components/connections/connection-status-badge";
import { cooldownRemainingSeconds, syncCooldownNotice } from "@/components/connections/cooldown";
import { FeedbackBanner } from "@/components/connections/feedback-banner";
import { SimulatedBadge } from "@/components/connections/simulated-badge";
import { LockIcon } from "@/components/icons";
import { buttonClass } from "@/components/ui/button";
import { ProviderMark } from "@/components/ui/provider-mark";
import { availableProviders } from "@/lib/adapters/registry";
import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import { getConnection, listExternalAccounts, listProjectOptions } from "@/lib/data/connections";
import { formatDateTime, formatRelative } from "@/lib/format";
import { MANUAL_SYNC_COOLDOWN_SECONDS } from "@/lib/jobs/queue";
import { PROVIDER_NAMES } from "@/lib/providers";
import { requireWorkspace } from "@/lib/workspaces/access";
import { workspacePath } from "@/lib/workspaces/paths";
import { actionDeniedReason, canPerform } from "@/lib/workspaces/permissions";

export const metadata: Metadata = { title: "Connection" };

// Every section renders inside its own Suspense boundary so navigating between sections
// has an instant shell; access checks and data reads stream in behind it.
export default function ConnectionPage(props: PageProps<"/w/[workspace]/connections/[connectionId]">) {
  return (
    <Suspense fallback={<PageSkeleton label="Loading the connection" />}>
      <ConnectionContent {...props} />
    </Suspense>
  );
}

async function ConnectionContent({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/connections/[connectionId]">) {
  const [{ workspace: slug, connectionId }, query] = await Promise.all([params, searchParams]);
  const { workspace, role } = await requireWorkspace(slug, "viewer");
  const connection = await getConnection(workspace.id, connectionId);
  if (connection === null) notFound();

  const canManage = canPerform(role, "manage_connections");
  const [accounts, projects] = await Promise.all([
    listExternalAccounts(workspace.id, connection.id),
    canManage ? listProjectOptions(workspace.id) : Promise.resolve([]),
  ]);
  // Read after the request data above, so the clock never runs during prerendering.
  const now = new Date();

  // The fake provider is absent from the registry when its flag is off; its rows still render.
  const adapter = availableProviders().find((candidate) => candidate.id === connection.provider);
  const providerName = PROVIDER_NAMES[connection.provider];
  const simulated = isSimulatedConnection(connection);
  const connectionsPath = workspacePath(workspace.slug, "connections");
  const reconnectHref = `${connectionsPath}/new/${connection.provider}?${new URLSearchParams({ connection: connection.id }).toString()}`;
  const lastSynced = connection.last_synced_at === null ? null : new Date(connection.last_synced_at);
  const remaining = cooldownRemainingSeconds(
    connection.last_sync_requested_at === null ? null : new Date(connection.last_sync_requested_at),
    MANUAL_SYNC_COOLDOWN_SECONDS,
    now,
  );
  const cooldownNotice = syncCooldownNotice(remaining);
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const revoked = connection.status === "revoked";

  return (
    <>
      <p className="mb-4 text-sm">
        <Link href={connectionsPath} className="text-muted underline-offset-4 hover:text-foreground hover:underline">
          All connections
        </Link>
      </p>
      <PageHeader
        title={connection.display_name}
        description={
          simulated
            ? `Simulated ${providerName} connection for this workspace. Its data is made up on this computer; no ${providerName} account is connected.`
            : `${providerName} connection for this workspace.`
        }
      />

      {query.connected === "1" ? (
        connection.status === "needs_attention" ? null : (
          <FeedbackBanner tone="success" title={`${providerName} connected`}>
            <p>
              The first sync is queued. Its events appear on the timeline as they arrive, and its numbers on the dashboard
              within a few minutes.
            </p>
            <p className="mt-2">
              <Link
                href={workspacePath(workspace.slug, "timeline")}
                className="font-medium text-foreground underline underline-offset-4"
              >
                Open the timeline
              </Link>
            </p>
          </FeedbackBanner>
        )
      ) : null}

      {connection.status === "needs_attention" && connection.missing_scopes.length > 0 ? (
        <section
          aria-labelledby="attention-title"
          className="mt-6 rounded-xl border border-warning/50 bg-panel px-5 py-4 text-sm"
        >
          <h2 id="attention-title" className="font-semibold text-warning">
            {providerName} did not grant every permission StackDash needs
          </h2>
          <p className="mt-1 leading-6 text-muted">
            Missing: <span className="font-medium text-foreground">{connection.missing_scopes.join(", ")}</span>. The
            data that needs it cannot sync until you reconnect and approve it.
          </p>
          {canManage ? (
            <Link href={reconnectHref} className={`mt-3 ${buttonClass("primary")}`}>
              Reconnect {providerName}
            </Link>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="status-title" className="mt-6 rounded-xl border border-line bg-panel">
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <ProviderMark provider={connection.provider} />
          <h2 id="status-title" className="text-sm font-semibold">
            Status
          </h2>
          <ConnectionStatusBadge status={connection.status} />
          {simulated ? <SimulatedBadge /> : null}
        </div>
        <dl className="grid gap-x-6 gap-y-2 px-6 py-4 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">Authorized by</dt>
          <dd className="break-words">{connection.authorized_account_label ?? "Not reported by the provider"}</dd>
          <dt className="text-muted">Last synced</dt>
          <dd>
            {lastSynced === null ? (
              "Not synced yet"
            ) : (
              <time dateTime={lastSynced.toISOString()}>
                {formatRelative(lastSynced, now)} ({formatDateTime(lastSynced)})
              </time>
            )}
          </dd>
          <dt className="text-muted">Missing permissions</dt>
          <dd>{connection.missing_scopes.length === 0 ? "None" : connection.missing_scopes.join(", ")}</dd>
        </dl>
      </section>

      <section aria-labelledby="accounts-title" className="mt-6 rounded-xl border border-line bg-panel">
        <h2 id="accounts-title" className="border-b border-line px-6 py-4 text-sm font-semibold">
          Accounts
        </h2>
        {accounts.length === 0 ? (
          <p className="px-6 py-4 text-sm text-muted">
            {providerName} reported no accounts for this grant.{" "}
            {canManage ? "Reconnect and choose at least one account on the consent screen." : null}
          </p>
        ) : (
          <ul aria-label="Accounts" className="divide-y divide-line">
            {accounts.map((account) => (
              <li key={account.id} className="flex flex-col gap-4 px-6 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="font-medium break-words">{account.display_name}</p>
                  <p className="mt-1 text-muted">
                    <span className="capitalize">{account.kind}</span>
                    {" · "}
                    {account.included ? "Included in totals" : "Excluded from totals"}
                    {canManage ? null : (
                      <>
                        {" · "}
                        {account.project_id === null ? "No project" : "Assigned to a project"}
                      </>
                    )}
                  </p>
                </div>
                {canManage ? (
                  // Three shared rows (label, controls, status) that both forms join as a subgrid, so
                  // Exclude lines up with the project dropdown whatever the label or messages hold.
                  <div className="flex flex-col items-start gap-4 sm:grid sm:grid-cols-[auto_auto] sm:grid-rows-[auto_auto_auto] sm:gap-x-4 sm:gap-y-2">
                    <AccountProjectForm
                      workspaceSlug={workspace.slug}
                      accountId={account.id}
                      accountName={account.display_name}
                      projectId={account.project_id !== null && projectNames.has(account.project_id) ? account.project_id : null}
                      projects={projects}
                    />
                    <AccountIncludedForm
                      workspaceSlug={workspace.slug}
                      accountId={account.id}
                      accountName={account.display_name}
                      included={account.included}
                    />
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="manage-title" className="mt-6 rounded-xl border border-line bg-panel px-6 py-4">
        <h2 id="manage-title" className="text-sm font-semibold">
          Manage
        </h2>
        {canManage ? (
          <div className="mt-4 flex flex-wrap items-start gap-4">
            {revoked ? null : (
              <SyncNowForm workspaceSlug={workspace.slug} connectionIds={[connection.id]} cooldownNotice={cooldownNotice} />
            )}
            <Link href={reconnectHref} className={buttonClass("outline")}>
              Reconnect
            </Link>
            <DisconnectDialog
              workspaceSlug={workspace.slug}
              connectionId={connection.id}
              providerName={providerName}
              canRevoke={adapter?.revoke !== undefined}
              revoked={revoked}
            />
            <DeleteConnectionDialog workspaceSlug={workspace.slug} connectionId={connection.id} providerName={providerName} />
          </div>
        ) : (
          <p className="mt-3 flex items-center gap-2 text-sm text-muted">
            <LockIcon className="shrink-0" />
            <span>{actionDeniedReason("manage_connections")}</span>
          </p>
        )}
      </section>
    </>
  );
}
