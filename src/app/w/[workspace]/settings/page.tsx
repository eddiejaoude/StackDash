import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/app/page-skeleton";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { LockIcon, MailIcon } from "@/components/icons";
import { requestPublicOrigin } from "@/lib/connections/oauth-state";
import { API_KEYS_LIST_LIMIT, listApiKeys, MAX_ACTIVE_API_KEYS } from "@/lib/data/api-keys";
import { formatDateTime } from "@/lib/format";
import { mcpEndpointUrl } from "@/lib/mcp/setup";
import { workspaceAddress } from "@/lib/public-metrics/project-page";
import { requireWorkspace } from "@/lib/workspaces/access";
import { actionDeniedReason, canPerform, roleLabel } from "@/lib/workspaces/permissions";

import { ApiKeysManager, type ApiKeyItem } from "./api-keys";
import { AssistantSetup } from "./assistant-setup";
import { RenameWorkspaceForm } from "./rename-workspace-form";
import { WorkspaceHandleForm } from "./workspace-handle-form";

export const metadata: Metadata = { title: "Settings" };

// Every section renders inside its own Suspense boundary so navigating between sections
// has an instant shell; access checks and data reads stream in behind it.
export default function SettingsPage(props: PageProps<"/w/[workspace]/settings">) {
  return (
    <Suspense fallback={<PageSkeleton label="Loading settings" />}>
      <SettingsContent {...props} />
    </Suspense>
  );
}

async function SettingsContent({ params }: PageProps<"/w/[workspace]/settings">) {
  const { workspace: slug } = await params;
  const { user, workspace, role } = await requireWorkspace(slug, "viewer");
  const canRename = canPerform(role, "rename_workspace");
  const canSetHandle = canPerform(role, "set_workspace_handle");
  const canManageKeys = canPerform(role, "manage_api_keys");
  // Row level security shows keys to owners and admins only, so viewers are not asked to load them.
  const apiKeys = canManageKeys ? await listApiKeys(workspace.id) : null;
  const apiKeyItems: ApiKeyItem[] =
    apiKeys?.keys.map((key) => ({
      id: key.id,
      name: key.name,
      tokenPrefix: key.token_prefix,
      scopes: key.scopes,
      created: formatDateTime(key.created_at),
      lastUsed: key.last_used_at === null ? null : formatDateTime(key.last_used_at),
      revoked: key.revoked_at === null ? null : formatDateTime(key.revoked_at),
      creatorLeft: key.creator_left,
    })) ?? [];
  // The MCP URL users paste into an assistant: NEXT_PUBLIC_SITE_URL when set, otherwise this
  // request's own origin, as the sitemap does.
  const endpointUrl = mcpEndpointUrl(await requestPublicOrigin());

  return (
    <>
      <PageHeader title="Settings" description="This workspace and your access to it." />

      <section aria-labelledby="workspace-name-title" className="mt-8 rounded-xl border border-line bg-panel">
        <h2 id="workspace-name-title" className="border-b border-line px-6 py-4 text-sm font-semibold">
          Name
        </h2>
        {canRename ? (
          <RenameWorkspaceForm workspaceSlug={workspace.slug} currentName={workspace.name} />
        ) : (
          <div className="px-6 py-5 text-sm">
            <p className="break-words">{workspace.name}</p>
            <p className="mt-3 flex items-center gap-2 text-muted">
              <LockIcon className="shrink-0" />
              <span>{actionDeniedReason("rename_workspace")}</span>
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="workspace-handle-title" className="mt-6 rounded-xl border border-line bg-panel">
        <h2 id="workspace-handle-title" className="border-b border-line px-6 py-4 text-sm font-semibold">
          Public handle
        </h2>
        {canSetHandle ? (
          <WorkspaceHandleForm workspaceSlug={workspace.slug} currentHandle={workspace.handle} />
        ) : (
          <div className="px-6 py-5 text-sm">
            <p>
              {workspace.handle === null ? "No handle yet. " : null}
              Public project pages open at{" "}
              <span className="font-mono break-words">/@{workspaceAddress(workspace)}/</span> followed by the page address.
            </p>
            <p className="mt-3 flex items-center gap-2 text-muted">
              <LockIcon className="shrink-0" />
              <span>{actionDeniedReason("set_workspace_handle")}</span>
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="workspace-details-title" className="mt-6 rounded-xl border border-line bg-panel">
        <h2 id="workspace-details-title" className="border-b border-line px-6 py-4 text-sm font-semibold">
          Workspace details
        </h2>
        <dl className="divide-y divide-line text-sm">
          <div className="grid gap-1 px-6 py-4 sm:grid-cols-3 sm:gap-4">
            <dt className="text-muted">Workspace ID</dt>
            <dd className="font-mono sm:col-span-2">{workspace.slug}</dd>
          </div>
          <div className="grid gap-1 px-6 py-4 sm:grid-cols-3 sm:gap-4">
            <dt className="text-muted">Your role</dt>
            <dd className="sm:col-span-2">{roleLabel(role)}</dd>
          </div>
          <div className="grid gap-1 px-6 py-4 sm:grid-cols-3 sm:gap-4">
            <dt className="text-muted">Signed in as</dt>
            <dd className="break-words sm:col-span-2">{user.email ?? "No email address on record"}</dd>
          </div>
        </dl>
      </section>

      <section aria-labelledby="api-keys-title" className="mt-6 rounded-xl border border-line bg-panel">
        <div className="border-b border-line px-6 py-4">
          <h2 id="api-keys-title" className="text-sm font-semibold">
            API keys
          </h2>
          <p className="mt-1 text-sm text-muted">
            Let your own scripts, tools, and dashboards read this workspace through the REST API. Keys can only read,
            and each one reads only what you choose.{" "}
            <Link href="/docs/api" className="text-foreground underline underline-offset-2">
              Read the API guide
            </Link>
          </p>
        </div>
        {apiKeys === null ? (
          <p className="flex items-center gap-2 px-6 py-5 text-sm text-muted">
            <LockIcon className="shrink-0" />
            <span>{actionDeniedReason("manage_api_keys")}</span>
          </p>
        ) : (
          <ApiKeysManager
            workspaceSlug={workspace.slug}
            keys={apiKeyItems}
            hasMore={apiKeys.hasMore}
            listLimit={API_KEYS_LIST_LIMIT}
          />
        )}
      </section>

      <AssistantSetup
        workspaceSlug={workspace.slug}
        endpointUrl={endpointUrl}
        canManageKeys={canManageKeys}
        maxKeys={MAX_ACTIVE_API_KEYS}
      />

      {/* No action: inviting teammates is not built yet, and there is nothing to link to. */}
      <EmptyState
        icon={<MailIcon width={20} height={20} />}
        title="No teammates invited"
        description="StackDash does not invite teammates by email yet. Each workspace is used by the people already in it."
      />
    </>
  );
}
