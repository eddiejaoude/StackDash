import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { PageSkeleton } from "@/components/app/page-skeleton";
import { EmptyState } from "@/components/app/empty-state";
import { PageHeader } from "@/components/app/page-header";
import { BetaBadge } from "@/components/connections/beta-badge";
import { ConnectionStatusBadge } from "@/components/connections/connection-status-badge";
import { FeedbackBanner } from "@/components/connections/feedback-banner";
import { SimulatedBadge } from "@/components/connections/simulated-badge";
import { ArrowRightIcon, LockIcon, PlugIcon } from "@/components/icons";
import { buttonClass } from "@/components/ui/button";
import { ProviderMark } from "@/components/ui/provider-mark";
import { availableProviders, isProviderConfigured, isProviderSimulated } from "@/lib/adapters/registry";
import { isSimulatedConnection } from "@/lib/adapters/simulated/marker";
import { ProviderIdSchema, type ProviderAdapter } from "@/lib/adapters/types";
import { connectErrorMessage, ConnectFeedbackSchema } from "@/lib/connections/oauth-state";
import { webhookRemovalSteps } from "@/lib/connections/webhook-setup";
import { listConnections, type ConnectionSummary } from "@/lib/data/connections";
import { decodeCursor } from "@/lib/data/cursor";
import { formatDateTime, formatRelative } from "@/lib/format";
import { PROVIDER_NAMES } from "@/lib/providers";
import { requireWorkspace } from "@/lib/workspaces/access";
import { workspacePath } from "@/lib/workspaces/paths";
import { actionDeniedReason, canPerform } from "@/lib/workspaces/permissions";

export const metadata: Metadata = { title: "Connections" };

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Every section renders inside its own Suspense boundary so navigating between sections
// has an instant shell; access checks and data reads stream in behind it.
export default function ConnectionsPage(props: PageProps<"/w/[workspace]/connections">) {
  return (
    <Suspense fallback={<PageSkeleton label="Loading connections" />}>
      <ConnectionsContent {...props} />
    </Suspense>
  );
}

async function ConnectionsContent({ params, searchParams }: PageProps<"/w/[workspace]/connections">) {
  const [{ workspace: slug }, query] = await Promise.all([params, searchParams]);
  const { workspace, role } = await requireWorkspace(slug, "viewer");
  const canConnect = canPerform(role, "manage_connections");
  const connectionsPath = workspacePath(workspace.slug, "connections");

  const catalog = availableProviders();

  const after = decodeCursor(first(query.after));
  const page = await listConnections(workspace.id, after);
  // Read after the request data above, so the clock never runs during prerendering.
  const now = new Date();

  const feedback = ConnectFeedbackSchema.safeParse({
    error: first(query.error),
    provider: first(query.provider),
    ref: first(query.ref),
  });
  const deleted = ProviderIdSchema.safeParse(first(query.deleted));

  return (
    <>
      <PageHeader
        title="Connections"
        description="The providers this workspace reads usage, spend, and activity from. Every member can see them; owners and admins connect and manage them."
      />

      {feedback.success ? (
        <FeedbackBanner tone="error" title="Nothing was connected">
          <p>
            {connectErrorMessage(
              feedback.data.error,
              feedback.data.provider === undefined ? "the provider" : PROVIDER_NAMES[feedback.data.provider],
            )}
          </p>
          {feedback.data.ref === undefined ? null : (
            <p className="mt-1">
              If this keeps happening, quote reference{" "}
              <code className="font-mono text-xs text-foreground">{feedback.data.ref}</code>.
            </p>
          )}
        </FeedbackBanner>
      ) : null}
      {deleted.success ? (
        <FeedbackBanner tone="success" title="Connection deleted">
          <p>The connection, its credential, and its history are deleted.</p>
          {first(query.revoke) === "manual" ? (
            <p className="mt-1">
              StackDash could not revoke access at {PROVIDER_NAMES[deleted.data]}. Remove StackDash&apos;s access in your{" "}
              {PROVIDER_NAMES[deleted.data]} account settings.
            </p>
          ) : null}
          {first(query.webhook) === "remove" ? (
            <p className="mt-1">
              Remove the webhook in {PROVIDER_NAMES[deleted.data]} too: {webhookRemovalSteps(deleted.data)}
            </p>
          ) : null}
        </FeedbackBanner>
      ) : null}

      <section aria-labelledby="connections-list-title" className="mt-8">
        <h2 id="connections-list-title" className="text-lg font-semibold tracking-tight">
          Connected providers
        </h2>
        {page.items.length === 0 && after === null ? (
          <EmptyState
            icon={<PlugIcon width={20} height={20} />}
            title="No connections yet"
            description={
              canConnect
                ? "Pick a provider below and connect it. You can add the others at any time."
                : "Once an owner or admin connects a provider, it is listed here."
            }
            deniedReason={canConnect ? undefined : actionDeniedReason("manage_connections")}
          />
        ) : (
          <>
            <ul aria-label="Connections" className="mt-4 divide-y divide-line rounded-xl border border-line bg-panel">
              {page.items.map((connection) => (
                <ConnectionRow
                  key={connection.id}
                  connection={connection}
                  providerName={PROVIDER_NAMES[connection.provider]}
                  href={`${connectionsPath}/${connection.id}`}
                  now={now}
                  simulated={isSimulatedConnection(connection)}
                />
              ))}
            </ul>
            {page.nextCursor === null ? null : (
              <Link
                href={`${connectionsPath}?${new URLSearchParams({ after: page.nextCursor }).toString()}`}
                className={`mt-4 gap-2 ${buttonClass("outline")}`}
              >
                Show more connections
                <ArrowRightIcon />
              </Link>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="catalog-title" className="mt-10">
        <h2 id="catalog-title" className="text-lg font-semibold tracking-tight">
          Add a provider
        </h2>
        <p className="mt-1 text-sm text-muted">
          Each provider shows exactly what StackDash asks for before you leave for its consent screen. Connect
          the same provider again to add another account; each one stays separate.
        </p>
        <ul aria-label="Providers" className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {catalog.map((adapter) => (
            <CatalogCard
              key={adapter.id}
              adapter={adapter}
              href={`${connectionsPath}/new/${adapter.id}`}
              canConnect={canConnect}
              configured={isProviderConfigured(adapter)}
              simulated={isProviderSimulated(adapter.id)}
            />
          ))}
        </ul>
      </section>
    </>
  );
}

function ConnectionRow({
  connection,
  providerName,
  href,
  now,
  simulated,
}: {
  connection: ConnectionSummary;
  providerName: string;
  href: string;
  now: Date;
  simulated: boolean;
}) {
  const lastSynced = connection.last_synced_at === null ? null : new Date(connection.last_synced_at);
  return (
    <li className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-start sm:gap-4">
      <ProviderMark provider={connection.provider} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={href} className="font-medium underline-offset-4 hover:underline">
            {connection.display_name}
          </Link>
          <ConnectionStatusBadge status={connection.status} />
          {simulated ? <SimulatedBadge /> : null}
        </div>
        <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted">Provider</dt>
          <dd>{providerName}</dd>
          <dt className="text-muted">Authorized by</dt>
          <dd className="break-words">{connection.authorized_account_label ?? "Not reported by the provider"}</dd>
          <dt className="text-muted">Last synced</dt>
          <dd>
            {lastSynced === null ? (
              "Not synced yet"
            ) : (
              <time dateTime={lastSynced.toISOString()} title={formatDateTime(lastSynced)}>
                {formatRelative(lastSynced, now)} ({formatDateTime(lastSynced)})
              </time>
            )}
          </dd>
          {connection.missing_scopes.length === 0 ? null : (
            <>
              <dt className="text-muted">Missing permissions</dt>
              <dd className="text-warning">{connection.missing_scopes.join(", ")}</dd>
            </>
          )}
        </dl>
      </div>
    </li>
  );
}

function CatalogCard({
  adapter,
  href,
  canConnect,
  configured,
  simulated,
}: {
  adapter: ProviderAdapter;
  href: string;
  canConnect: boolean;
  configured: boolean;
  simulated: boolean;
}) {
  const hasFullAccess = adapter.permissions.some((permission) => permission.access === "full");
  const reason = !canConnect
    ? actionDeniedReason("manage_connections")
    : !configured
      ? `Not set up on this instance. Ask the person who runs this StackDash instance to register the ${adapter.displayName} app.`
      : null;
  // Visible text and the connect link's description, so the reason never lives in a tooltip only.
  const betaReasonId = adapter.beta === undefined ? undefined : `catalog-${adapter.id}-beta-reason`;
  return (
    <li className="flex flex-col rounded-xl border border-line bg-panel p-5">
      <div className="flex items-center gap-3">
        <ProviderMark provider={adapter.id} />
        <h3 className="font-semibold">{adapter.displayName}</h3>
        {adapter.beta === undefined ? null : <BetaBadge />}
        {simulated ? <SimulatedBadge /> : null}
      </div>
      {adapter.beta === undefined ? null : (
        <p id={betaReasonId} className="mt-3 text-sm text-muted">
          {adapter.beta.reason}
        </p>
      )}
      <p className="mt-3 text-xs font-medium text-muted">Data collected</p>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
        {adapter.dataCollected.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <p className="mt-3 text-sm">
        {hasFullAccess ? "Asks for full access to at least one area." : "Read access only."}
      </p>
      <div className="mt-auto pt-4">
        {reason === null ? (
          <Link
            href={href}
            aria-describedby={betaReasonId}
            className={`gap-2 ${buttonClass("primary")}`}
          >
            Connect {adapter.displayName}
            <ArrowRightIcon />
          </Link>
        ) : (
          <p className="flex items-start gap-2 text-sm text-muted">
            <LockIcon className="mt-0.5 shrink-0" />
            <span>{reason}</span>
          </p>
        )}
      </div>
    </li>
  );
}
