import Link from "next/link";

import { ArrowRightIcon, CheckIcon, LockIcon } from "@/components/icons";
import { buttonClass } from "@/components/ui/button";
import {
  ONBOARDING_STEP_IDS,
  type OnboardingStepId,
  type OnboardingStepStatus,
  type OnboardingSteps,
} from "@/lib/data/onboarding-checklist";
import { ALERT_SETTINGS_IDS, alertSettingsPath, assistantSetupPath, workspacePath } from "@/lib/workspaces/paths";
import { actionDeniedReason, canPerform, type WorkspaceAction, type WorkspaceRole } from "@/lib/workspaces/permissions";

import { DismissChecklistButton } from "./dismiss-checklist-button";

/*
 * The Timeline's first-run setup panel (#674, plan step 3 of #411). Each step links to the control
 * that completes it, done or not, so the control stays one click away. Every control needs the
 * admin role, so a viewer sees the role matrix's reason in place of each link. Hiding the panel
 * needs no role.
 *
 * Two targets are today's and will move: "Choose where alerts go" will become the alerts offer at
 * connect (#411 step 5), and "Share a badge" the one-step badge publish (#411 step 11). Until then
 * they open the alert settings page and the Projects list, the first step to a project's public
 * metrics page and its share dialog.
 */

type StepCopy = Readonly<{
  title: string;
  description: string;
  linkLabel: string;
  /** The role matrix action the linked control needs. */
  action: WorkspaceAction;
  href: (slug: string) => string;
}>;

const STEPS: Readonly<Record<OnboardingStepId, StepCopy>> = {
  connect_provider: {
    title: "Connect a provider",
    description: "Link Vercel, GitHub, Stripe, or another provider so its events and usage show up here.",
    linkLabel: "Go to Connections",
    action: "manage_connections",
    href: (slug) => workspacePath(slug, "connections"),
  },
  alert_destination: {
    title: "Choose where alerts go",
    description: "Pick how often alert emails arrive, or post alerts to Discord, Slack, or a webhook.",
    linkLabel: "Go to alert settings",
    action: "manage_alert_channels",
    href: (slug) => alertSettingsPath(slug, ALERT_SETTINGS_IDS.emails),
  },
  assistant: {
    title: "Connect your assistant",
    description: "Create a key for Claude, Cursor, or another assistant so it can answer questions about this workspace.",
    linkLabel: "Go to AI assistants",
    action: "manage_api_keys",
    href: assistantSetupPath,
  },
  badge: {
    title: "Share a badge",
    description: "Publish a metric from a project, then share it as a badge or a link.",
    linkLabel: "Go to Projects",
    action: "publish_metrics",
    href: (slug) => workspacePath(slug, "projects"),
  },
};

const TITLE_ID = "setup-checklist-title";

export function OnboardingChecklist({
  workspaceSlug,
  role,
  steps,
  afterDismissFocusId,
}: {
  workspaceSlug: string;
  role: WorkspaceRole;
  steps: OnboardingSteps;
  /** The page heading, which takes focus once the panel is gone. */
  afterDismissFocusId: string;
}) {
  return (
    <section aria-labelledby={TITLE_ID} className="mt-6 rounded-xl border border-line bg-panel">
      <div className="flex flex-col gap-3 border-b border-line px-6 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 id={TITLE_ID} className="text-sm font-semibold">
            Set up this workspace
          </h2>
          <p className="mt-1 text-sm text-muted">
            Four steps that get this workspace ready. Hide this list when you are done with it.
          </p>
        </div>
        <DismissChecklistButton workspaceSlug={workspaceSlug} afterDismissFocusId={afterDismissFocusId} />
      </div>
      <ol className="divide-y divide-line">
        {ONBOARDING_STEP_IDS.map((id) => (
          <ChecklistStep key={id} copy={STEPS[id]} status={steps[id]} workspaceSlug={workspaceSlug} role={role} />
        ))}
      </ol>
    </section>
  );
}

const STATUS_BADGES: Record<Exclude<OnboardingStepStatus, "unknown">, { label: string; className: string }> = {
  done: { label: "Done", className: "border-success/50 text-success" },
  todo: { label: "To do", className: "border-dashed border-line-strong text-muted" },
};

function ChecklistStep({
  copy,
  status,
  workspaceSlug,
  role,
}: {
  copy: StepCopy;
  status: OnboardingStepStatus;
  workspaceSlug: string;
  role: WorkspaceRole;
}) {
  // A step whose state the role cannot read shows no badge: the denied reason below says why.
  const badge = status === "unknown" ? null : STATUS_BADGES[status];
  return (
    <li className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 gap-3">
        <span
          aria-hidden="true"
          className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border ${
            status === "done" ? "border-success/50 text-success" : "border-line-strong text-muted"
          }`}
        >
          {status === "done" ? <CheckIcon width={14} height={14} /> : null}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-medium">{copy.title}</h3>
            {badge === null ? null : (
              <span className={`rounded-full border px-2 py-0.5 text-xs font-medium ${badge.className}`}>{badge.label}</span>
            )}
          </div>
          <p className="mt-1 text-sm text-muted">{copy.description}</p>
        </div>
      </div>
      {canPerform(role, copy.action) ? (
        <Link
          href={copy.href(workspaceSlug)}
          className={`shrink-0 gap-2 self-start sm:self-center ${buttonClass(status === "done" ? "secondary" : "raised", "sm")}`}
        >
          {copy.linkLabel}
          <ArrowRightIcon />
        </Link>
      ) : (
        <p className="flex max-w-xs shrink-0 items-start gap-2 text-sm text-muted">
          <LockIcon className="mt-0.5 shrink-0" />
          <span>{actionDeniedReason(copy.action)}</span>
        </p>
      )}
    </li>
  );
}
