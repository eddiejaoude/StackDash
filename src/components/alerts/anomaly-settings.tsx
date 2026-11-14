import Link from "next/link";

import { ANOMALY_MIN_HISTORY_DAYS, ANOMALY_MIN_RATIO, ANOMALY_TYPE_ID, ANOMALY_WINDOW_DAYS } from "@/lib/alerts/anomaly";
import { getAnomalyControls, listAnomalyMetrics, type AnomalyMetric } from "@/lib/data/anomalies";
import type { WorkspaceRef } from "@/lib/data/workspaces";
import { providerName } from "@/lib/providers";
import { ALERT_SETTINGS_IDS, workspacePath } from "@/lib/workspaces/paths";
import { actionDeniedReason, canPerform, type WorkspaceRole } from "@/lib/workspaces/permissions";

import { AnomalyToggle, MuteMetricForm, UnmuteButton } from "./anomaly-controls";
import { DeniedReason } from "./form-controls";
import { FragmentHeading } from "./fragment-heading";

/**
 * Anomaly detection in alert settings (#169): whether it runs, and which metrics are muted.
 * Detection needs no setup, so the section explains what it does and offers only the two
 * controls the issue asks for: a workspace switch and a per-metric mute.
 */

export const ANOMALY_HEADING_ID = ALERT_SETTINGS_IDS.unusual;
const linkClass = "text-accent underline underline-offset-2";

function metricName(metric: Pick<AnomalyMetric, "provider" | "label">): string {
  return `${providerName(metric.provider)}: ${metric.label}`;
}

export async function AnomalySettings({ workspace, role }: { workspace: WorkspaceRef; role: WorkspaceRole }) {
  const canManage = canPerform(role, "manage_budgets");
  const [controls, metrics] = await Promise.all([getAnomalyControls(workspace.id), listAnomalyMetrics(workspace.id)]);
  const labels = new Map(metrics.map((metric) => [`${metric.provider} ${metric.metricKey}`, metric.label]));
  const muted = new Set(controls.mutes.map((mute) => `${mute.provider} ${mute.metric_key}`));
  const options = metrics
    .filter((metric) => !muted.has(`${metric.provider} ${metric.metricKey}`))
    .map((metric) => ({ value: `${metric.provider} ${metric.metricKey}`, label: metricName(metric) }));
  const timelineHref = `${workspacePath(workspace.slug, "timeline")}?type=${ANOMALY_TYPE_ID}`;

  return (
    <section aria-labelledby={ANOMALY_HEADING_ID} className="mt-8 rounded-xl border border-line bg-panel">
      <div className="border-b border-line px-6 py-4">
        <FragmentHeading id={ANOMALY_HEADING_ID}>
          Unusual spend and usage
        </FragmentHeading>
        <p className="mt-1 text-sm text-muted">
          Every day, StackDash compares each spend and usage metric with the {ANOMALY_WINDOW_DAYS} days before it. A day at
          least {ANOMALY_MIN_RATIO} times the usual amount adds an event to the timeline. A metric needs{" "}
          {ANOMALY_MIN_HISTORY_DAYS} days of history first, and small changes never count.
        </p>
        <p className="mt-2 text-sm">
          <Link href={timelineHref} className={`inline-flex min-h-6 items-center ${linkClass}`}>
            Show unusual days on the timeline
          </Link>
        </p>
      </div>

      <div className="flex flex-col gap-3 border-b border-line px-6 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="text-sm">
          <p className="font-medium">
            {controls.enabled ? "Unusual spend and usage checks are on" : "Unusual spend and usage checks are off"}
          </p>
          <p className="mt-1 text-muted">
            {controls.enabled
              ? "No setup needed. They apply to every provider this workspace connects."
              : "No unusual days are flagged. Turn them on to check every provider again from the next daily summary."}
          </p>
          {canManage ? null : <DeniedReason>{actionDeniedReason("manage_budgets")}</DeniedReason>}
        </div>
        {canManage ? <AnomalyToggle workspaceSlug={workspace.slug} enabled={controls.enabled} /> : null}
      </div>

      <h3 className="px-6 pt-4 text-sm font-semibold">Muted metrics</h3>
      {controls.mutes.length === 0 ? (
        <p className="px-6 pt-1 pb-4 text-sm text-muted">No muted metrics. Every spend and usage metric is checked.</p>
      ) : (
        <ul aria-label="Muted metrics" className="mt-2 divide-y divide-line border-y border-line">
          {controls.mutes.map((mute) => {
            const label = metricName({
              provider: mute.provider,
              // A metric no longer reported keeps its key as its name.
              label: labels.get(`${mute.provider} ${mute.metric_key}`) ?? mute.metric_key,
            });
            return (
              <li key={mute.id} className="flex flex-col gap-2 px-6 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <p className="break-words">{label}</p>
                {canManage ? (
                  <UnmuteButton
                    workspaceSlug={workspace.slug}
                    muteId={mute.id}
                    label={label}
                    afterUnmuteFocusId={ANOMALY_HEADING_ID}
                  />
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      {!canManage ? null : options.length === 0 ? (
        <p className="px-6 py-4 text-sm text-muted">
          {metrics.length === 0
            ? "Spend and usage metrics appear here after a sync reports them."
            : "Every spend and usage metric is muted."}
        </p>
      ) : (
        <MuteMetricForm workspaceSlug={workspace.slug} options={options} />
      )}
    </section>
  );
}
