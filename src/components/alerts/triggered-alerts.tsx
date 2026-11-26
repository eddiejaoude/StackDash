import Link from "next/link";

import { ChevronDownIcon } from "@/components/icons";
import { SeverityBadge } from "@/components/severity-badge";
import type { AlertSeverity } from "@/lib/alerts/evaluate";
import type { AlertHeadline } from "@/lib/alerts/headline";
import {
  countUnacknowledgedAlerts,
  hasTriggeredAlerts,
  listTriggeredAlerts,
  type TriggeredAlert,
} from "@/lib/data/triggered-alerts";
import type { WorkspaceRef } from "@/lib/data/workspaces";
import { formatDateTime } from "@/lib/format";
import { barPercent, usageBarClass } from "@/lib/realtime/arrivals";
import { ALERT_SETTINGS_IDS, alertSettingsPath, type AlertsInboxQuery, pathWithQuery, workspacePath } from "@/lib/workspaces/paths";
import { actionDeniedReason, canPerform, type WorkspaceRole } from "@/lib/workspaces/permissions";

import { AcknowledgeAllButton, AcknowledgeAnnouncer, AcknowledgeButton } from "./acknowledge-button";
import { DeniedReason } from "./form-controls";
import { FragmentHeading } from "./fragment-heading";

/**
 * Triggered alerts, newest first: what fired, how bad, and whether someone has acknowledged it.
 * Acknowledged alerts stay in the history and show with `?acknowledged=show`. Each alert leads with
 * its short title and value (#268); the full sentence is one disclosure away.
 */

const HEADING_ID = "triggered-alerts-title";

const linkClass = "text-accent underline underline-offset-2";

function WarningIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-warning">
      <path d="M8 1.75 15 14.25H1L8 1.75Z" strokeLinejoin="round" />
      <path d="M8 6v4M8 12v.01" strokeLinecap="round" />
    </svg>
  );
}

function CriticalIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 text-danger">
      <path d="M5.1 1.5h5.8l4.1 4.1v5.8l-4.1 4.1H5.1L1 11.4V5.6l4.1-4.1Z" strokeLinejoin="round" />
      <path d="M8 4.5v4.5M8 11.5v.01" strokeLinecap="round" />
    </svg>
  );
}

/** Severity as an icon and a word, so color never carries it alone. */
export function AlertSeverityLabel({ severity }: { severity: AlertSeverity }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {severity === "critical" ? <CriticalIcon /> : <WarningIcon />}
      <SeverityBadge severity={severity === "critical" ? "Critical" : "Warning"} />
    </span>
  );
}

export function EstimatedBadge() {
  return (
    <span className="inline-flex min-h-6 items-center rounded-full border border-line-strong px-2.5 text-xs font-medium text-muted">
      Estimated
    </span>
  );
}

/** "2026-10-31 14:05 GMT" in Europe/London, as a machine-readable `<time>`. */
export function AlertTime({ iso }: { iso: string }) {
  return <time dateTime={new Date(iso).toISOString()}>{formatDateTime(iso)}</time>;
}

/**
 * The observed value in words, with a bar before it when there is a percent. The words are the
 * accessible value; the bar only repeats them, colored by `usageBarClass` like the dashboard's.
 */
export function AlertValue({ headline }: { headline: AlertHeadline }) {
  const { percent, value } = headline;
  if (value === null) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      {percent === null ? null : (
        <span aria-hidden="true" className="block h-1.5 w-32 overflow-hidden rounded-full bg-line">
          <span
            className={`block h-full rounded-full ${usageBarClass(percent)}`}
            style={{ width: `${barPercent(percent)}%` }}
          />
        </span>
      )}
      <span>{value}</span>
    </span>
  );
}

/** The alert's full sentence behind a native disclosure, named after the alert it belongs to. */
export function AlertFullMessage({ title, message }: { title: string; message: string }) {
  return (
    <details className="group mt-2">
      <summary className="inline-flex min-h-6 cursor-pointer list-none items-center gap-1 text-sm text-accent underline-offset-4 hover:underline [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">Show the full alert</span>
        <span className="hidden group-open:inline">Hide the full alert</span>
        <span className="sr-only">: {title}</span>
        <ChevronDownIcon className="size-4 shrink-0 transition-transform motion-reduce:transition-none group-open:rotate-180" />
      </summary>
      <p className="mt-1 break-words text-sm leading-6">{message}</p>
    </details>
  );
}

function acknowledgedByLabel(acknowledgedBy: string | null, userId: string): string {
  if (acknowledgedBy === null) return "a former member";
  return acknowledgedBy === userId ? "you" : "another member";
}

export async function TriggeredAlerts({
  workspace,
  role,
  userId,
  showAcknowledged,
  after,
}: {
  workspace: WorkspaceRef;
  role: WorkspaceRole;
  userId: string;
  showAcknowledged: boolean;
  after: string | null;
}) {
  const canAcknowledge = canPerform(role, "acknowledge_alert");
  const canManageRules = canPerform(role, "manage_budgets");
  const [page, anyFired, unacknowledged] = await Promise.all([
    listTriggeredAlerts(workspace.id, showAcknowledged, after),
    // Only needed to tell "nothing ever fired" from "everything is acknowledged".
    showAcknowledged ? null : hasTriggeredAlerts(workspace.id),
    // Only needed for "Acknowledge all", which only members who can acknowledge see.
    canAcknowledge ? countUnacknowledgedAlerts(workspace.id) : 0,
  ]);

  const alertsPath = workspacePath(workspace.slug, "alerts");
  // Each link changes only its own part of the inbox's query (#316).
  const query: AlertsInboxQuery = { acknowledged: showAcknowledged ? "show" : null, alertsAfter: after };
  // Showing or hiding acknowledged alerts is a different list, so it starts from the newest.
  const toggleHref = pathWithQuery(alertsPath, { ...query, acknowledged: showAcknowledged ? null : "show", alertsAfter: null });
  const successMessage = showAcknowledged
    ? "Alert acknowledged. It stays in the alert history."
    : "Alert acknowledged. It stays in the alert history. Choose Show acknowledged alerts to see it.";
  const nothingFired = page.items.length === 0 && after === null && (showAcknowledged || anyFired === false);

  return (
    <section aria-labelledby={HEADING_ID} className="mt-8 rounded-xl border border-line bg-panel">
      <div className="flex flex-col gap-3 border-b border-line px-6 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <FragmentHeading id={HEADING_ID} cursor={after}>
            Triggered alerts
          </FragmentHeading>
          <p className="mt-1 text-sm text-muted">
            {showAcknowledged
              ? "Every alert that has fired, newest first, including acknowledged ones."
              : "Alerts nobody has acknowledged yet, newest first. Acknowledged alerts stay in the history."}
          </p>
          {canAcknowledge ? null : <DeniedReason>{actionDeniedReason("acknowledge_alert")}</DeniedReason>}
        </div>
        <Link
          href={toggleHref}
          scroll={false}
          className={`inline-flex min-h-6 shrink-0 items-center text-sm ${linkClass}`}
        >
          {showAcknowledged ? "Hide acknowledged alerts" : "Show acknowledged alerts"}
        </Link>
      </div>

      <AcknowledgeAnnouncer>
        {unacknowledged === 0 ? null : (
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-3 text-sm">
            <p className="font-medium">
              {unacknowledged === 1 ? "1 unacknowledged alert" : `${unacknowledged} unacknowledged alerts`}
            </p>
            <AcknowledgeAllButton
              workspaceSlug={workspace.slug}
              showAcknowledged={showAcknowledged}
              afterAcknowledgeFocusId={HEADING_ID}
            />
          </div>
        )}
        {nothingFired ? (
          <div className="px-6 py-5 text-sm">
            <p className="font-medium">No alerts have fired</p>
            <p className="mt-1 text-muted">
              {canManageRules ? (
                <>
                  <Link href={alertSettingsPath(workspace.slug, ALERT_SETTINGS_IDS.newRule)} className={linkClass}>
                    Add an alert rule
                  </Link>{" "}
                  to hear about usage or spend before it becomes a problem.
                </>
              ) : (
                <>
                  Alerts appear here when an{" "}
                  <Link href={alertSettingsPath(workspace.slug, ALERT_SETTINGS_IDS.rules)} className={linkClass}>
                    alert rule
                  </Link>{" "}
                  crosses its threshold.
                </>
              )}
            </p>
          </div>
        ) : page.items.length === 0 ? (
          <div className="px-6 py-5 text-sm">
            <p className="font-medium">No unacknowledged alerts</p>
            <p className="mt-1 text-muted">Every alert that has fired is acknowledged.</p>
          </div>
        ) : (
          <ul aria-label="Triggered alerts" className="divide-y divide-line">
            {page.items.map((alert) => (
              <TriggeredAlertItem
                key={alert.id}
                alert={alert}
                userId={userId}
                acknowledge={
                  canAcknowledge
                    ? { workspaceSlug: workspace.slug, successMessage, afterAcknowledgeFocusId: HEADING_ID }
                    : null
                }
              />
            ))}
          </ul>
        )}
      </AcknowledgeAnnouncer>

      {/* A pager replaces the list, so it lands on the list's heading rather than the top of the page. */}
      {page.nextCursor === null && after === null ? null : (
        <nav aria-label="Triggered alert pages" className="flex flex-wrap gap-4 border-t border-line px-6 py-3 text-sm">
          {after === null ? null : (
            <Link href={pathWithQuery(alertsPath, { ...query, alertsAfter: null }, HEADING_ID)} className={linkClass}>
              Show the newest alerts
            </Link>
          )}
          {page.nextCursor === null ? null : (
            <Link href={pathWithQuery(alertsPath, { ...query, alertsAfter: page.nextCursor }, HEADING_ID)} className={linkClass}>
              Show older alerts
            </Link>
          )}
        </nav>
      )}
    </section>
  );
}

function TriggeredAlertItem({
  alert,
  userId,
  acknowledge,
}: {
  alert: TriggeredAlert;
  userId: string;
  acknowledge: { workspaceSlug: string; successMessage: string; afterAcknowledgeFocusId: string } | null;
}) {
  const { headline } = alert;
  return (
    <li className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-start sm:justify-between">
      <article className="min-w-0">
        <h3 className="break-words text-sm font-semibold leading-6">{headline.title}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
          <AlertSeverityLabel severity={alert.severity} />
          {alert.is_estimated ? <EstimatedBadge /> : null}
          <AlertValue headline={headline} />
        </div>
        <p className="mt-2 text-sm text-muted">
          Threshold {alert.threshold_label}
          <span aria-hidden="true"> · </span>
          <span className="sr-only">. </span>
          Triggered <AlertTime iso={alert.triggered_at} />
        </p>
        <p className="mt-1 text-sm">
          {alert.acknowledged_at === null ? (
            <span className="text-muted">Not acknowledged</span>
          ) : (
            <span className="text-success">
              Acknowledged by {acknowledgedByLabel(alert.acknowledged_by, userId)} on{" "}
              <AlertTime iso={alert.acknowledged_at} />
            </span>
          )}
        </p>
        <AlertFullMessage title={headline.title} message={alert.message} />
      </article>
      {acknowledge === null || alert.acknowledged_at !== null ? null : (
        <AcknowledgeButton
          workspaceSlug={acknowledge.workspaceSlug}
          alertId={alert.id}
          accessibleSuffix={`${headline.title}, triggered ${formatDateTime(alert.triggered_at)}`}
          successMessage={acknowledge.successMessage}
          afterAcknowledgeFocusId={acknowledge.afterAcknowledgeFocusId}
        />
      )}
    </li>
  );
}
