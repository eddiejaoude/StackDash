import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import { z } from "zod";

import { Cell, CheckRow, HeaderCell, Panel, RowHeader, ScrollTable, StatusPill } from "@/components/admin/overview";
import { PageHeader } from "@/components/app/page-header";
import { SignOutButton } from "@/components/app/sign-out-button";
import { Wordmark } from "@/components/wordmark";
import type { ProviderId } from "@/lib/adapters/types";
import {
  instanceConfiguration,
  providerSetup,
  type CheckStatus,
  type ConfigCheck,
  type ProviderSetup,
} from "@/lib/admin/configuration";
import { compareMigrations, deploymentInfo, expectedMigrationVersion, type MigrationState } from "@/lib/admin/deployment";
import { ADMIN_PATH, requireSuperAdmin } from "@/lib/auth/super-admin";
import {
  loadInstanceTotals,
  loadJobFailures,
  loadJobHealth,
  loadLatestMigration,
  loadProviderUsage,
  loadWorkspaceStats,
  type JobHealth,
  type ProviderUsage,
} from "@/lib/data/admin";
import { formatDateTime, formatList, formatRelative } from "@/lib/format";
import { log } from "@/lib/log/logger";
import { PROVIDER_NAMES } from "@/lib/providers";
import type { Database } from "@/lib/supabase/database.types";

// The title would name the page to anyone, so it is gated like the page: a non super admin gets
// the not found page's metadata instead.
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  await requireSuperAdmin(ADMIN_PATH);
  return { title: "Instance overview" };
}

// The enforced CSP nonce (src/proxy.ts) needs this page's HTML rendered per request, so the page
// awaits `connection()` before anything renders and allows an empty static shell (#125).
export const instant = false;

// pg_cron calls the tick every minute (docs/operations/jobs.md), so a runnable job waiting this long
// means ticks are not arriving or not authorized.
const SCHEDULER_LAG_WARNING_MS = 10 * 60_000;

const numberFormat = new Intl.NumberFormat("en-US");

const JOB_KIND_LABELS: Record<Database["public"]["Enums"]["sync_job_kind"], string> = {
  sync: "Sync",
  daily_summary: "Daily summary",
  retention: "Retention",
  alert_dispatch: "Alert dispatch",
  digest: "Digest",
  webhook: "Webhook delivery",
};

const MIGRATION_STATES: Record<MigrationState, Readonly<{ status: CheckStatus; summary: string; detail: string }>> = {
  current: { status: "ok", summary: "Up to date", detail: "The database has every migration this build includes." },
  behind: {
    status: "attention",
    summary: "Behind",
    detail: "This build includes migrations the database does not have yet. Apply them before using the features they add.",
  },
  ahead: {
    status: "attention",
    summary: "Ahead",
    detail: "The database has migrations this build does not include. Deploy the build that matches the database.",
  },
  unknown: {
    status: "info",
    summary: "Cannot tell",
    detail: "The database was not migrated by the Supabase CLI, or the migration files did not ship with this build.",
  },
};

// A malformed or repeated `after` is ignored, which means the first page.
const searchSchema = z.object({
  after: z.string().max(200).optional().catch(undefined),
});

/**
 * The super admin page (#250): how this instance is configured and how it is used. Addressed as
 * ADMIN_PATH; src/proxy.ts rewrites that address to this route for a super admin only, and answers
 * this route's own path as not found, so anyone else gets the not found page with its 404 (#374).
 */
export default async function AdminPage({ searchParams }: PageProps<"/super-admin">) {
  await connection();
  // Checked before anything below renders: this is the authorization, and the proxy's routing is
  // not. It cannot set the status on a production build, where the empty static shell
  // `instant = false` allows has already been sent with a 200 by the time this runs: a request the
  // proxy let through by mistake would still get the not-found page, but with a 200.
  const user = await requireSuperAdmin(ADMIN_PATH);
  return (
    <div className="flex flex-1 flex-col">
      <header className="border-b border-line">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center gap-3 px-4 sm:px-6">
          <Link href="/app" className="inline-flex min-h-6 shrink-0 items-center">
            <Wordmark />
          </Link>
          <div className="ml-auto flex shrink-0 items-center gap-3">
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
      <main id="main" className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-6 sm:py-10">
        <PageHeader
          title="Instance overview"
          description="How this StackDash server is configured and how it is used. Settings show whether they are set, never their values."
        />
        <Suspense fallback={<LoadingOverview />}>
          <AdminContent userId={user.id} searchParams={searchParams} />
        </Suspense>
      </main>
    </div>
  );
}

function LoadingOverview() {
  return (
    <div role="status" aria-live="polite" className="mt-8">
      <span className="sr-only">Loading the instance overview</span>
      <div aria-hidden="true" className="h-96 rounded-xl border border-dashed border-line bg-panel motion-safe:animate-pulse" />
    </div>
  );
}

async function AdminContent({ userId, searchParams }: { userId: string } & Pick<PageProps<"/super-admin">, "searchParams">) {
  const after = searchSchema.parse(await searchParams).after ?? null;
  // Admin views are logged: who looked at instance-wide data, and when (the log line's time).
  log.info("admin.viewed", { userId });

  const [totals, workspaces, providerUsage, jobHealth, jobFailures, appliedMigration] = await Promise.all([
    loadInstanceTotals(),
    loadWorkspaceStats(after),
    loadProviderUsage(),
    loadJobHealth(),
    loadJobFailures(),
    loadLatestMigration(),
  ]);
  // Read after the request data above, so the clock never runs during prerendering.
  const now = new Date();

  const configuration = instanceConfiguration();
  const providers = providerSetup();
  const deployment = deploymentInfo();
  const expectedMigration = expectedMigrationVersion();
  const migration = MIGRATION_STATES[compareMigrations(appliedMigration, expectedMigration)];
  const scheduler = schedulerCheck(jobHealth, now);

  const attention = [
    ...configuration.flatMap((group) => group.checks),
    scheduler,
    { name: "Database migrations", status: migration.status },
  ].filter((check) => check.status === "attention");

  return (
    <>
      <p className="mt-6 text-sm leading-6">
        {attention.length === 0
          ? "Nothing needs attention."
          : `${attention.length} ${attention.length === 1 ? "item needs" : "items need"} attention: ${formatList(attention.map((check) => check.name))}.`}
      </p>

      <Panel id="usage" title="Usage" description="Across every workspace on this instance.">
        <dl className="grid gap-px bg-line sm:grid-cols-3">
          <Stat
            label="Users"
            value={totals.users}
            note={`${numberFormat.format(totals.users_new_7d)} new in 7 days, ${numberFormat.format(totals.users_new_30d)} in 30 days`}
          />
          <Stat label="Users signed in, last 30 days" value={totals.users_signed_in_30d} />
          <Stat
            label="Workspaces"
            value={totals.workspaces}
            note={`${numberFormat.format(totals.workspaces_new_7d)} new in 7 days, ${numberFormat.format(totals.workspaces_new_30d)} in 30 days`}
          />
          <Stat label="Workspace members" value={totals.memberships} note="One per person per workspace" />
          <Stat label="Connections" value={totals.connections} note="Not counting disconnected ones" />
          <Stat label="Timeline events" value={totals.events} note="Kept for 13 months" />
        </dl>
      </Panel>

      <Panel id="configuration" title="Configuration" description="Environment variables this server reads. Set them in the host's settings and restart.">
        <ScrollTable label="Settings">
          <ConfigHeader />
          {configuration.map((group) => (
            <tbody key={group.title}>
              <tr className="border-b border-line bg-panel-raised">
                <th scope="rowgroup" colSpan={4} className="px-6 py-2 text-left font-semibold">
                  {group.title}
                </th>
              </tr>
              {group.checks.map((check) => (
                <CheckRow key={check.name} check={check} />
              ))}
            </tbody>
          ))}
        </ScrollTable>
      </Panel>

      <Panel
        id="providers"
        title="Providers"
        description="Whether each provider's OAuth app is registered here, and how many workspaces connect to it."
      >
        <ProvidersTable providers={providers} usage={providerUsage} />
      </Panel>

      <Panel id="jobs" title="Background jobs" description="The scheduler's queue. Finished jobs are deleted 30 days after they were queued.">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-4 text-sm">
          <StatusPill status={scheduler.status}>{scheduler.summary}</StatusPill>
          <span className="leading-6">{scheduler.detail}</span>
        </div>
        <JobsTable jobs={jobHealth} now={now} />
        <h3 className="border-t border-line px-6 pt-4 text-sm font-semibold">Failures in the last 24 hours</h3>
        {jobFailures.length === 0 ? (
          <p className="px-6 py-4 text-sm text-muted">No job used up its attempts in the last 24 hours.</p>
        ) : (
          <ScrollTable label="Job failures in the last 24 hours">
            <thead>
              <tr>
                <HeaderCell>Job</HeaderCell>
                <HeaderCell>Error code</HeaderCell>
                <HeaderCell numeric>Failures</HeaderCell>
                <HeaderCell>Last failed</HeaderCell>
              </tr>
            </thead>
            <tbody>
              {jobFailures.map((failure) => (
                <tr key={`${failure.kind}:${failure.error_code}`} className="border-b border-line last:border-b-0">
                  <Cell>{JOB_KIND_LABELS[failure.kind]}</Cell>
                  <Cell>
                    <code className="font-mono text-xs">{failure.error_code}</code>
                  </Cell>
                  <Cell numeric>{numberFormat.format(failure.failures)}</Cell>
                  <Cell>
                    <time dateTime={failure.last_failed_at}>{formatRelative(failure.last_failed_at, now)}</time>
                  </Cell>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </Panel>

      <Panel id="workspaces" title="Workspaces" description="Newest first. Events are the timeline events each workspace keeps.">
        {workspaces.items.length === 0 ? (
          <p className="px-6 py-4 text-sm text-muted">
            {after === null ? "No workspaces yet. Each person gets one when they first sign in." : "No more workspaces."}
          </p>
        ) : (
          <ScrollTable label="Workspace figures">
            <thead>
              <tr>
                <HeaderCell>Workspace</HeaderCell>
                <HeaderCell>Created</HeaderCell>
                <HeaderCell numeric>Members</HeaderCell>
                <HeaderCell numeric>Connections</HeaderCell>
                <HeaderCell numeric>Events</HeaderCell>
              </tr>
            </thead>
            <tbody>
              {workspaces.items.map((workspace) => (
                <tr key={workspace.workspace_id} className="border-b border-line last:border-b-0">
                  <RowHeader>
                    {workspace.name}
                    {workspace.is_personal ? <span className="ml-2 text-xs font-normal text-muted">Personal</span> : null}
                    <span className="block font-mono text-xs font-normal text-muted">{workspace.slug}</span>
                  </RowHeader>
                  <Cell>
                    <time dateTime={workspace.created_at}>{formatDateTime(workspace.created_at)}</time>
                  </Cell>
                  <Cell numeric>{numberFormat.format(workspace.members)}</Cell>
                  <Cell numeric>{numberFormat.format(workspace.connections)}</Cell>
                  <Cell numeric>{numberFormat.format(workspace.events)}</Cell>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
        {after === null && workspaces.nextCursor === null ? null : (
          <nav aria-label="Workspace pages" className="flex flex-wrap gap-3 border-t border-line px-6 py-4">
            {after === null ? null : (
              <Link href={ADMIN_PATH} className="inline-flex min-h-10 items-center rounded-md border border-line-strong px-4 py-2 text-sm">
                Show the newest workspaces
              </Link>
            )}
            {workspaces.nextCursor === null ? null : (
              <Link
                href={`${ADMIN_PATH}?${new URLSearchParams({ after: workspaces.nextCursor }).toString()}`}
                className="inline-flex min-h-10 items-center rounded-md border border-line-strong px-4 py-2 text-sm"
              >
                Show older workspaces
              </Link>
            )}
          </nav>
        )}
      </Panel>

      <Panel id="deployment" title="Deployment">
        <dl className="divide-y divide-line text-sm">
          <Fact label="Commit">
            {deployment.commit === null ? "Unknown: only reported on Vercel" : <code className="font-mono text-xs">{deployment.commit}</code>}
          </Fact>
          <Fact label="Environment">{deployment.environment}</Fact>
          <Fact label="Database migrations">
            <span className="flex flex-col items-start gap-2">
              <StatusPill status={migration.status}>{migration.summary}</StatusPill>
              <span className="leading-6">{migration.detail}</span>
              <span className="text-muted">
                Database: <code className="font-mono text-xs text-foreground">{appliedMigration ?? "unknown"}</code>. This build:{" "}
                <code className="font-mono text-xs text-foreground">{expectedMigration ?? "unknown"}</code>.
              </span>
            </span>
          </Fact>
        </dl>
      </Panel>
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="bg-panel px-6 py-5">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{numberFormat.format(value)}</dd>
      {note === undefined ? null : <dd className="mt-1 text-xs text-muted">{note}</dd>}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-6 py-4 sm:grid-cols-3 sm:gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="break-words sm:col-span-2">{children}</dd>
    </div>
  );
}

function ConfigHeader() {
  return (
    <thead>
      <tr>
        <HeaderCell>Setting</HeaderCell>
        <HeaderCell>State</HeaderCell>
        <HeaderCell>What it means</HeaderCell>
        <HeaderCell>Variables</HeaderCell>
      </tr>
    </thead>
  );
}

/** Whether ticks are arriving, judged by the oldest job that could have run and has not. */
function schedulerCheck(jobs: readonly JobHealth[], now: Date): Pick<ConfigCheck, "name" | "status" | "summary" | "detail"> {
  const name = "Scheduler";
  // Compared as instants: the strings come from Postgres and their offsets need not match.
  const oldestDue = jobs.reduce<string | null>(
    (oldest, job) =>
      job.oldest_due_at !== null && (oldest === null || Date.parse(job.oldest_due_at) < Date.parse(oldest)) ? job.oldest_due_at : oldest,
    null,
  );
  const lastFinished = jobs.reduce<string | null>(
    (latest, job) =>
      job.last_finished_at !== null && (latest === null || Date.parse(job.last_finished_at) > Date.parse(latest))
        ? job.last_finished_at
        : latest,
    null,
  );
  const finished = lastFinished === null ? "No job has finished in the last 30 days." : `Last job finished ${formatRelative(lastFinished, now)}.`;
  if (oldestDue !== null && now.getTime() - Date.parse(oldestDue) > SCHEDULER_LAG_WARNING_MS) {
    return {
      name,
      status: "attention",
      summary: "Falling behind",
      detail: `A job has been waiting to run since ${formatRelative(oldestDue, now)}. Check that pg_cron calls the tick and that CRON_SECRET matches. ${finished}`,
    };
  }
  return { name, status: "ok", summary: "Running", detail: `No job is waiting longer than 10 minutes. ${finished}` };
}

function ProvidersTable({
  providers,
  usage,
}: {
  providers: readonly ProviderSetup[];
  usage: readonly ProviderUsage[];
}) {
  const usageByProvider = new Map<ProviderId, ProviderUsage>(usage.map((row) => [row.provider, row]));
  const live = new Set<ProviderId>(providers.map(({ provider }) => provider));
  // Connections to a provider that is not live (the test-only example provider) still count.
  const others = usage.filter((row) => !live.has(row.provider));
  const rows = [
    ...providers.map(({ provider, check }) => ({ provider, check, usage: usageByProvider.get(provider) })),
    ...others.map((row) => ({ provider: row.provider, check: null, usage: row })),
  ];
  return (
    <ScrollTable label="Provider figures">
      <thead>
        <tr>
          <HeaderCell>Provider</HeaderCell>
          <HeaderCell>OAuth app</HeaderCell>
          <HeaderCell numeric>Workspaces using it</HeaderCell>
          <HeaderCell numeric>Active</HeaderCell>
          <HeaderCell numeric>Needs attention</HeaderCell>
          <HeaderCell numeric>Failed</HeaderCell>
          <HeaderCell numeric>Pending</HeaderCell>
          <HeaderCell numeric>Disconnected</HeaderCell>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ provider, check, usage: row }) => (
          <tr key={provider} className="border-b border-line last:border-b-0">
            <RowHeader>{PROVIDER_NAMES[provider]}</RowHeader>
            <Cell>
              {check === null ? (
                <span className="text-muted">Test only</span>
              ) : (
                <span className="flex flex-col items-start gap-1">
                  <StatusPill status={check.status}>{check.summary}</StatusPill>
                  {check.variables.length === 0 ? null : (
                    <span className="max-w-xs text-xs leading-5 text-muted">{check.detail}</span>
                  )}
                </span>
              )}
            </Cell>
            <Cell numeric>{numberFormat.format(row?.workspaces ?? 0)}</Cell>
            <Cell numeric>{numberFormat.format(row?.active ?? 0)}</Cell>
            <Cell numeric>{numberFormat.format(row?.needs_attention ?? 0)}</Cell>
            <Cell numeric>{numberFormat.format(row?.failed ?? 0)}</Cell>
            <Cell numeric>{numberFormat.format(row?.pending ?? 0)}</Cell>
            <Cell numeric>{numberFormat.format(row?.revoked ?? 0)}</Cell>
          </tr>
        ))}
      </tbody>
    </ScrollTable>
  );
}

function JobsTable({ jobs, now }: { jobs: readonly JobHealth[]; now: Date }) {
  if (jobs.length === 0) {
    return <p className="px-6 py-4 text-sm text-muted">No jobs yet. The scheduler queues them on its first tick.</p>;
  }
  return (
    <ScrollTable label="Background jobs by kind">
      <thead>
        <tr>
          <HeaderCell>Job</HeaderCell>
          <HeaderCell numeric>Queued</HeaderCell>
          <HeaderCell numeric>Due now</HeaderCell>
          <HeaderCell numeric>Retrying</HeaderCell>
          <HeaderCell numeric>Running</HeaderCell>
          <HeaderCell numeric>Stuck</HeaderCell>
          <HeaderCell numeric>Succeeded, 24 hours</HeaderCell>
          <HeaderCell numeric>Failed, 24 hours</HeaderCell>
          <HeaderCell>Last finished</HeaderCell>
        </tr>
      </thead>
      <tbody>
        {jobs.map((job) => (
          <tr key={job.kind} className="border-b border-line last:border-b-0">
            <RowHeader>{JOB_KIND_LABELS[job.kind]}</RowHeader>
            <Cell numeric>{numberFormat.format(job.queued)}</Cell>
            <Cell numeric>{numberFormat.format(job.due)}</Cell>
            <Cell numeric>{numberFormat.format(job.retrying)}</Cell>
            <Cell numeric>{numberFormat.format(job.running)}</Cell>
            <Cell numeric>{numberFormat.format(job.stale)}</Cell>
            <Cell numeric>{numberFormat.format(job.succeeded_24h)}</Cell>
            <Cell numeric>{numberFormat.format(job.failed_24h)}</Cell>
            <Cell>
              {job.last_finished_at === null ? (
                <span className="text-muted">Never</span>
              ) : (
                <time dateTime={job.last_finished_at}>{formatRelative(job.last_finished_at, now)}</time>
              )}
            </Cell>
          </tr>
        ))}
      </tbody>
    </ScrollTable>
  );
}
