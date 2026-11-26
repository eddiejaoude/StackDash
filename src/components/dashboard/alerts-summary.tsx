import Link from "next/link";

import {
  AlertFullMessage,
  AlertSeverityLabel,
  AlertTime,
  AlertValue,
  EstimatedBadge,
} from "@/components/alerts/triggered-alerts";
import { ANOMALY_TYPE_ID } from "@/lib/alerts/anomaly";
import type { RecentAnomalies } from "@/lib/data/anomalies";
import type { UnacknowledgedSummary } from "@/lib/data/triggered-alerts";
import type { WorkspaceRef } from "@/lib/data/workspaces";
import { EMPTY_SCOPE } from "@/lib/filters/scope";
import { londonDayLabel } from "@/lib/timeline/days";
import { londonDayStart, timelineHref } from "@/lib/timeline/query";
import { workspacePath } from "@/lib/workspaces/paths";

const TITLE_ID = "alerts-summary-title";

/**
 * Unacknowledged alerts on the dashboard: how many, the newest three by their short titles (#268),
 * and the way to the full list, followed by how many unusual spend and usage events anomaly
 * detection recorded on the last 7 London calendar days, today included (#169), and the way to
 * exactly those events on the timeline (#664). The days themselves are listed once, by "What
 * changed" at the top (#291). One plain line with no panel when there is nothing to act on, so it
 * never pushes the numbers down. Zero is said in words, so "no alerts" never looks like "not loaded".
 */
export function AlertsSummary({
  workspace,
  summary,
  anomalies,
}: {
  workspace: WorkspaceRef;
  summary: UnacknowledgedSummary;
  anomalies: RecentAnomalies;
}) {
  const { count, newest } = summary;
  const allAlertsLink = (
    <Link
      href={workspacePath(workspace.slug, "alerts")}
      className="ml-auto inline-flex min-h-6 items-center text-accent underline underline-offset-2"
    >
      View all alerts
    </Link>
  );
  if (count === 0 && anomalies.count === 0) {
    return (
      <section aria-labelledby={TITLE_ID} className="mt-4 flex flex-wrap items-center gap-x-3 text-sm">
        <h2 id={TITLE_ID} className="text-sm font-semibold">
          Alerts
        </h2>
        <p className="text-muted">No unacknowledged alerts</p>
        {allAlertsLink}
      </section>
    );
  }
  return (
    <section aria-labelledby={TITLE_ID} className="mt-6 rounded-xl border border-line bg-panel">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm">
        <h2 id={TITLE_ID} className="font-semibold">
          Alerts
        </h2>
        <p className={count === 0 ? "text-muted" : "font-medium"}>
          {count === 0
            ? "No unacknowledged alerts"
            : count === 1
              ? "1 unacknowledged alert"
              : `${count} unacknowledged alerts`}
        </p>
        {allAlertsLink}
      </div>
      {newest.length === 0 ? null : (
        <ul aria-label="Newest unacknowledged alerts" className="divide-y divide-line border-t border-line">
          {newest.map((alert) => (
            <li key={alert.id} className="px-4 py-3">
              <p className="break-words text-sm font-medium leading-6">{alert.headline.title}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
                <AlertSeverityLabel severity={alert.severity} />
                {alert.is_estimated ? <EstimatedBadge /> : null}
                <AlertValue headline={alert.headline} />
                <span className="text-xs text-muted">
                  Triggered <AlertTime iso={alert.triggered_at} />
                </span>
              </div>
              <AlertFullMessage title={alert.headline.title} message={alert.message} />
            </li>
          ))}
        </ul>
      )}
      {anomalies.count === 0 ? null : <UnusualDays workspace={workspace} anomalies={anomalies} />}
    </section>
  );
}

function UnusualDays({ workspace, anomalies }: { workspace: WorkspaceRef; anomalies: RecentAnomalies }) {
  // One event per metric per day, so two metrics on one day are two events, not two days. The count
  // is of the events as recorded on the day for the whole workspace, so it ignores the dashboard's
  // filters and later mutes, which "What changed" follows (#291); the words say so. The sentence
  // names the first day counted and the link filters from that day, the bound the count used, so
  // the timeline lists the events counted and no older ones (#664).
  const events = anomalies.count === 1 ? "1 unusual spend or usage event" : `${anomalies.count} unusual spend or usage events`;
  const href = timelineHref(
    workspacePath(workspace.slug, "timeline"),
    { types: [ANOMALY_TYPE_ID], severities: [], from: anomalies.from, to: null, timeRange: null, search: null, cursor: null, scope: EMPTY_SCOPE },
    null,
  );
  return (
    <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 text-sm">
      <h3 className="font-semibold">Unusual spend and usage</h3>
      <p className="font-medium">
        {`${events} recorded for the whole workspace from ${londonDayLabel(londonDayStart(anomalies.from))} through today`}
      </p>
      <Link href={href} className="ml-auto inline-flex min-h-6 items-center text-accent underline underline-offset-2">
        Show unusual days on the timeline
      </Link>
    </div>
  );
}
