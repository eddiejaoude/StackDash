import Link from "next/link";

import { AlertSeverityLabel, AlertTime, EstimatedBadge } from "@/components/alerts/triggered-alerts";
import type { UnacknowledgedSummary } from "@/lib/data/triggered-alerts";
import type { WorkspaceRef } from "@/lib/data/workspaces";
import { workspacePath } from "@/lib/workspaces/access";

const TITLE_ID = "alerts-summary-title";

/**
 * Unacknowledged alerts on the dashboard: how many, the newest three, and the way to the full
 * list. One slim row when there is nothing to act on, so it never pushes the numbers down. Zero
 * is said in words, so "no alerts" never looks like "not loaded".
 */
export function AlertsSummary({ workspace, summary }: { workspace: WorkspaceRef; summary: UnacknowledgedSummary }) {
  const { count, newest } = summary;
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
        <Link
          href={workspacePath(workspace.slug, "alerts")}
          className="ml-auto inline-flex min-h-6 items-center text-accent underline underline-offset-2"
        >
          View all alerts
        </Link>
      </div>
      {count === 0 ? null : (
        <ul aria-label="Newest unacknowledged alerts" className="divide-y divide-line border-t border-line">
          {newest.map((alert) => (
            <li key={alert.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <AlertSeverityLabel severity={alert.severity} />
                {alert.is_estimated ? <EstimatedBadge /> : null}
                <span className="text-xs text-muted">
                  Triggered <AlertTime iso={alert.triggered_at} />
                </span>
              </div>
              <p className="mt-1 break-words text-sm leading-6">{alert.message}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
