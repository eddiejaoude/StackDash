import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/app/page-skeleton";
import { PageHeader } from "@/components/app/page-header";
import { FeedbackBanner } from "@/components/connections/feedback-banner";
import { SimulatedBadge } from "@/components/connections/simulated-badge";
import { LockIcon } from "@/components/icons";
import { buttonClass } from "@/components/ui/button";
import { ProviderMark } from "@/components/ui/provider-mark";
import { getAdapter, isFakeProviderEnabled, loadOAuthClient } from "@/lib/adapters/registry";
import { isSimulatedAdapter } from "@/lib/adapters/simulated";
import { ProviderIdSchema } from "@/lib/adapters/types";
import { connectErrorMessage, reconnectMismatch } from "@/lib/connections/oauth-state";
import { automaticChoiceCopy, needsWriteAccess } from "@/lib/connections/webhook-copy";
import { connectionWebhookSetup, webhookWritePermissions } from "@/lib/connections/webhook-setup";
import { getConnection, isConnectionId } from "@/lib/data/connections";
import { requireWorkspace } from "@/lib/workspaces/access";
import { workspacePath } from "@/lib/workspaces/paths";
import { actionDeniedReason, canPerform } from "@/lib/workspaces/permissions";

export const metadata: Metadata = { title: "Connect a provider" };

// Every section renders inside its own Suspense boundary so navigating between sections
// has an instant shell; access checks and data reads stream in behind it.
export default function ConnectProviderPage(props: PageProps<"/w/[workspace]/connections/new/[provider]">) {
  return (
    <Suspense fallback={<PageSkeleton label="Loading the connection form" />}>
      <ConnectProviderContent {...props} />
    </Suspense>
  );
}

/**
 * Permission disclosure (#40): every permission the provider will ask for, labelled Read or Full
 * access, with the reason for each full one, before the browser leaves for the provider. Full
 * access needs an explicit tick; the start route refuses the request without it.
 */
async function ConnectProviderContent({
  params,
  searchParams,
}: PageProps<"/w/[workspace]/connections/new/[provider]">) {
  const [{ workspace: slug, provider: providerParam }, query] = await Promise.all([params, searchParams]);
  const { workspace, role } = await requireWorkspace(slug, "viewer");
  const parsedProvider = ProviderIdSchema.safeParse(providerParam);
  if (!parsedProvider.success) notFound();
  const provider = parsedProvider.data;
  if (provider === "fake" && !isFakeProviderEnabled()) notFound();
  const adapter = getAdapter(provider);
  const connectionsPath = workspacePath(workspace.slug, "connections");

  const connectionParam = typeof query.connection === "string" ? query.connection : undefined;
  const reconnect =
    connectionParam !== undefined && isConnectionId(connectionParam)
      ? await getConnection(workspace.id, connectionParam)
      : null;
  if (connectionParam !== undefined && (reconnect === null || reconnect.provider !== provider)) notFound();
  // The user chose automatic webhook setup on the connection page (#426): this reconnect also asks
  // for the write access that creates the webhook, and says so before the provider's screen.
  const webhookChosen = query.webhook === "automatic";
  const webhookSetup = connectionWebhookSetup(adapter);
  if (webhookChosen && (reconnect === null || webhookSetup === null || !needsWriteAccess(webhookSetup))) notFound();
  const extraPermissions = await webhookWritePermissions({
    adapter,
    workspaceId: workspace.id,
    connectionId: reconnect?.id,
    chosen: webhookChosen,
  });
  const permissions = [...adapter.permissions, ...extraPermissions];
  // The grant holds the write access already (an automatic setup that failed after its consent),
  // so the advice to stay read-only by setting up by hand would be false.
  const writeAccessHeld =
    reconnect !== null && extraPermissions.length > 0 && extraPermissions.every((permission) => reconnect.granted_scopes.includes(permission.scope));

  const canConnect = canPerform(role, "manage_connections");
  const configured = loadOAuthClient(adapter) !== null;
  const simulated = isSimulatedAdapter(adapter);
  // A real connection is never reconnected through the simulator, nor the reverse (#131).
  const mismatch = reconnect === null ? null : reconnectMismatch(reconnect, simulated);
  const fullAccess = permissions.filter((permission) => permission.access === "full");
  const consentMissing = query.error === "consent_required";
  const title = webhookChosen
    ? `Set up ${adapter.displayName} webhooks automatically`
    : reconnect === null
      ? `Connect ${adapter.displayName}`
      : `Reconnect ${adapter.displayName}`;

  return (
    <>
      <PageHeader
        title={title}
        description={
          webhookChosen && webhookSetup !== null
            ? automaticChoiceCopy(adapter.displayName, webhookSetup, writeAccessHeld)
            : reconnect !== null
              ? mismatch !== null
                ? `${reconnect.display_name} cannot be reconnected on this instance.`
                : `Approve access again for ${reconnect.display_name}. The connection keeps its history and project assignments.`
              : simulated
                ? `${adapter.displayName} is simulated on this instance. StackDash approves at once and makes up example ${adapter.displayName} data on this computer; no ${adapter.displayName} account is connected.`
                : `Review what StackDash asks ${adapter.displayName} for. You approve it on ${adapter.displayName}'s own consent screen next.`
        }
      />

      {consentMissing ? (
        <FeedbackBanner tone="error" title="Confirm full access to continue">
          <p>
            {connectErrorMessage("consent_required", adapter.displayName)}{" "}
            <a href="#consent" className="font-medium text-foreground underline underline-offset-4">
              Go to the confirmation
            </a>
          </p>
        </FeedbackBanner>
      ) : null}

      <section aria-labelledby="permissions-title" className="mt-8 rounded-xl border border-line bg-panel">
        <div className="flex items-center gap-3 border-b border-line px-6 py-4">
          <ProviderMark provider={provider} />
          <h2 id="permissions-title" className="text-sm font-semibold">
            Permissions {adapter.displayName} will ask you to grant
          </h2>
          {simulated ? <SimulatedBadge /> : null}
        </div>
        <ul className="divide-y divide-line">
          {permissions.map((permission) => (
            <li key={permission.scope} className="px-6 py-4 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono text-xs">{permission.scope}</code>
                <span
                  className={`rounded-full border px-2 py-0.5 text-xs font-medium ${
                    permission.access === "full" ? "border-warning/50 text-warning" : "border-line-strong text-muted"
                  }`}
                >
                  {permission.access === "full" ? "Full access" : "Read"}
                </span>
              </div>
              <p className="mt-2 leading-6">{permission.description}</p>
              {permission.access === "full" ? (
                <p className="mt-2 leading-6 text-muted">
                  <span className="font-medium text-foreground">Why full access: </span>
                  {permission.fullAccessReason}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="data-title" className="mt-6 rounded-xl border border-line bg-panel px-6 py-4">
        <h2 id="data-title" className="text-sm font-semibold">
          Data collected
        </h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-6 text-muted">
          {adapter.dataCollected.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="mt-3 text-sm leading-6 text-muted">
          Tokens are encrypted and stay on the server. You can disconnect at any time, and the provider&apos;s own
          settings let you revoke access too.
        </p>
      </section>

      {!canConnect ? (
        <p className="mt-6 flex items-center gap-2 text-sm text-muted">
          <LockIcon className="shrink-0" />
          <span>{actionDeniedReason("manage_connections")}</span>
        </p>
      ) : mismatch !== null ? (
        <p className="mt-6 flex items-start gap-2 text-sm text-muted">
          <LockIcon className="mt-0.5 shrink-0" />
          <span>{connectErrorMessage(mismatch, adapter.displayName)}</span>
        </p>
      ) : !configured ? (
        <p className="mt-6 flex items-start gap-2 text-sm text-muted">
          <LockIcon className="mt-0.5 shrink-0" />
          <span>{connectErrorMessage("not_configured", adapter.displayName)}</span>
        </p>
      ) : (
        <form method="post" action={`/api/connections/${provider}/start`} className="mt-6" noValidate>
          <input type="hidden" name="workspace" value={workspace.slug} />
          {reconnect === null ? null : <input type="hidden" name="connection" value={reconnect.id} />}
          {webhookChosen ? <input type="hidden" name="webhook" value="automatic" /> : null}
          {fullAccess.length === 0 ? null : (
            <div className="rounded-xl border border-warning/40 bg-panel px-6 py-4">
              <div className="flex items-start gap-3">
                <input
                  id="consent"
                  type="checkbox"
                  name="consent"
                  value="1"
                  aria-required="true"
                  aria-invalid={consentMissing ? true : undefined}
                  aria-describedby={consentMissing ? "consent-hint consent-error" : "consent-hint"}
                  className="mt-0.5 size-5 shrink-0 accent-accent"
                />
                <div className="text-sm">
                  <label htmlFor="consent" className="font-medium">
                    I understand StackDash gets full access to my {adapter.displayName} account
                  </label>
                  <p id="consent-hint" className="mt-1 leading-6 text-muted">
                    Required. {adapter.displayName} has no narrower permission for this data:{" "}
                    {fullAccess.map((permission) => permission.scope).join(", ")}.
                  </p>
                  {consentMissing ? (
                    <p id="consent-error" className="mt-1 text-danger">
                      <span className="font-medium">Error: </span>
                      Tick this box to continue.
                    </p>
                  ) : null}
                </div>
              </div>
            </div>
          )}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="submit"
              className={buttonClass("primary")}
            >
              Continue to {adapter.displayName}
            </button>
            <Link
              href={reconnect === null ? connectionsPath : `${connectionsPath}/${reconnect.id}`}
              className={buttonClass("outline")}
            >
              Cancel
            </Link>
          </div>
        </form>
      )}
    </>
  );
}
