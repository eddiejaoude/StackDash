/**
 * What a message says, independent of where it goes (#152, #153). Email, Discord, Slack, and the
 * generic webhook all render the same `Notice`, so every channel carries the same fields: what
 * crossed, by how much, the provider, the project, the reset date, and a link.
 *
 * Copy follows the house voice: sentence case, no exclamation marks, no dashes, and every message
 * says what happened and what to do. Ids are never shown.
 *
 * The projected end of period that #152 asks for waits for the projection engine in #167, so this
 * file does not estimate one (decision on #152, option 3).
 */
import { formatDateTime, formatMoney, formatPeriod, formatQuantity, formatPercent } from "@/lib/format";

import type { DeliveryAlert, DigestPeriod } from "./model";

export type NoticeSeverity = "critical" | "warning" | "info";

export type NoticeField = Readonly<{ name: string; value: string }>;

export type NoticeItem = Readonly<{
  title: string;
  body: string;
  severity: NoticeSeverity;
  fields: readonly NoticeField[];
}>;

export type NoticeSection = Readonly<{ heading: string; items: readonly NoticeItem[] }>;

export type NoticeLink = Readonly<{ label: string; url: string }>;

export type NoticeType = "alerts" | "digest" | "test";

export type Notice = Readonly<{
  type: NoticeType;
  workspaceName: string;
  /** Email subject and channel headline. */
  subject: string;
  intro: string;
  sections: readonly NoticeSection[];
  links: readonly NoticeLink[];
  /** The alerts behind an alert notice, for the generic webhook's structured payload. */
  alerts: readonly DeliveryAlert[];
}>;

/** Absolute links into the workspace, built by the caller from the instance's public origin. */
export type WorkspaceLinks = Readonly<{ alerts: string; connections: string; timeline: string }>;

const SEVERITY_LABEL: Record<NoticeSeverity, string> = { critical: "Critical", warning: "Warning", info: "Info" };

export function severityLabel(severity: NoticeSeverity): string {
  return SEVERITY_LABEL[severity];
}

function alertItem(alert: DeliveryAlert): NoticeItem {
  return {
    title: alert.title,
    body: alert.message,
    severity: alert.severity,
    fields: [
      { name: "Severity", value: SEVERITY_LABEL[alert.severity] },
      { name: "Threshold", value: alert.thresholdLabel },
      { name: "Provider", value: alert.providerName ?? "More than one provider" },
      { name: "Project", value: alert.projectName ?? "No single project" },
      { name: "Resets", value: alert.resetsAt === null ? "Not reported by the provider" : formatDateTime(alert.resetsAt) },
      { name: "Triggered", value: formatDateTime(alert.triggeredAt) },
    ],
  };
}

const WHAT_TO_DO: NoticeSection = {
  heading: "What to do",
  items: [
    {
      title: "Raise the threshold",
      body: "If this level is expected, edit the rule in alert settings so it fires at a higher level.",
      severity: "info",
      fields: [],
    },
    {
      title: "Acknowledge the alert",
      body: "Mark it as seen on the alerts page so the rest of the workspace knows someone has it.",
      severity: "info",
      fields: [],
    },
    {
      title: "Open the provider",
      body: "Check what is using the allowance or the money in the provider's own dashboard, then reduce it or change the plan.",
      severity: "info",
      fields: [],
    },
  ],
};

/** One message for every alert waiting for a target: several alerts in a tick arrive together. */
export function alertNotice(input: {
  workspaceName: string;
  alerts: readonly DeliveryAlert[];
  links: WorkspaceLinks;
}): Notice {
  const { alerts, workspaceName } = input;
  const first = alerts[0];
  const single = alerts.length === 1 && first !== undefined;
  return {
    type: "alerts",
    workspaceName,
    subject: single ? `Alert in ${workspaceName}: ${first.title}` : `${alerts.length} alerts in ${workspaceName}`,
    intro: single
      ? `A threshold you set in StackDash for ${workspaceName} was crossed.`
      : `${alerts.length} thresholds you set in StackDash for ${workspaceName} were crossed.`,
    sections: [{ heading: single ? "What crossed" : "What crossed, most urgent first", items: alerts.map(alertItem) }, WHAT_TO_DO],
    links: [
      { label: "Open the alerts page", url: input.links.alerts },
      { label: "Open connections", url: input.links.connections },
    ],
    alerts,
  };
}

// ── Digest ──────────────────────────────────────────────────────────────────────

/** Usage against an allowance on one connection, as the dashboard reduces it. */
export type DigestAllowance = Readonly<{
  connectionName: string;
  label: string;
  unit: string;
  used: number | null;
  included: number | null;
  percentUsed: number | null;
  resetsAt: string | null;
}>;

/** Verified and estimated spend of one connection in one currency, never added together. */
export type DigestSpend = Readonly<{
  connectionName: string;
  currency: string;
  verifiedMinor: number | null;
  estimatedMinor: number | null;
  period: Readonly<{ start: string; end: string }> | null;
}>;

export type DigestHighlights = Readonly<{ deploys: number; signups: number; stars: number; payments: number }>;

export type DigestContent = Readonly<{
  workspaceName: string;
  period: DigestPeriod;
  alerts: readonly DeliveryAlert[];
  allowances: readonly DigestAllowance[];
  spend: readonly DigestSpend[];
  highlights: DigestHighlights;
}>;

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

function allowanceItem(allowance: DigestAllowance): NoticeItem {
  const { used, included, unit, percentUsed } = allowance;
  const amounts =
    used !== null && included !== null ? `${formatQuantity(used, unit)} of ${formatQuantity(included, unit)}` : "Usage unavailable";
  const percent = percentUsed === null ? "" : `${formatPercent(percentUsed)} used, `;
  return {
    title: `${allowance.connectionName}: ${allowance.label}`,
    body: `${percent}${amounts}.`,
    severity: percentUsed !== null && percentUsed >= 100 ? "critical" : percentUsed !== null && percentUsed >= 75 ? "warning" : "info",
    fields: [{ name: "Resets", value: allowance.resetsAt === null ? "Not reported by the provider" : formatDateTime(allowance.resetsAt) }],
  };
}

function spendItem(spend: DigestSpend): NoticeItem {
  const parts: string[] = [];
  if (spend.verifiedMinor !== null) parts.push(`${formatMoney(spend.verifiedMinor, spend.currency)} reported by the provider`);
  if (spend.estimatedMinor !== null) parts.push(`${formatMoney(spend.estimatedMinor, spend.currency)} estimated by StackDash`);
  return {
    title: `${spend.connectionName}: spend in ${spend.currency}`,
    body: parts.length === 0 ? "Spend unavailable." : `${parts.join(", and ")}.`,
    severity: "info",
    fields: spend.period === null ? [] : [{ name: "Billing period", value: formatPeriod(spend.period) }],
  };
}

export function digestNotice(content: DigestContent, links: WorkspaceLinks): Notice {
  const { period, workspaceName, highlights } = content;
  const span = period.frequency === "daily" ? period.date : formatPeriod(period);
  const kind = period.frequency === "daily" ? "Daily" : "Weekly";
  const alertCount = content.alerts.length;
  const sections: NoticeSection[] = [
    {
      heading: "New alerts",
      items:
        alertCount === 0
          ? [{ title: "No new alerts", body: "No threshold was crossed in this period.", severity: "info", fields: [] }]
          : content.alerts.map(alertItem),
    },
    {
      heading: "Usage against allowances",
      items:
        content.allowances.length === 0
          ? [{ title: "No allowances reported", body: "No connection reports an allowance yet.", severity: "info", fields: [] }]
          : content.allowances.map(allowanceItem),
    },
    {
      heading: "Spend this billing period",
      items:
        content.spend.length === 0
          ? [{ title: "No spend reported", body: "No connection reports spend yet.", severity: "info", fields: [] }]
          : content.spend.map(spendItem),
    },
    {
      heading: "Highlights",
      items: [
        {
          title: "Activity in this period",
          body: [
            plural(highlights.deploys, "deployment", "deployments"),
            plural(highlights.signups, "signup", "signups"),
            plural(highlights.stars, "star event", "star events"),
            plural(highlights.payments, "payment", "payments"),
          ].join(", "),
          severity: "info",
          fields: [],
        },
      ],
    },
  ];
  return {
    type: "digest",
    workspaceName,
    subject: `${kind} digest for ${workspaceName}: ${span}`,
    intro:
      alertCount === 0
        ? `${kind} digest for ${workspaceName}, ${span}. No new alerts.`
        : `${kind} digest for ${workspaceName}, ${span}. ${plural(alertCount, "new alert", "new alerts")}.`,
    sections,
    links: [
      { label: "Open the alerts page", url: links.alerts },
      { label: "Open the timeline", url: links.timeline },
    ],
    alerts: content.alerts,
  };
}

/** The "Send test message" body: proves the channel works without claiming anything crossed. */
export function testNotice(workspaceName: string, destinationName: string, links: WorkspaceLinks): Notice {
  return {
    type: "test",
    workspaceName,
    subject: `Test message from StackDash for ${workspaceName}`,
    intro: `This is a test message for the channel ${destinationName}. Alerts and digests for ${workspaceName} will arrive here. Nothing needs doing.`,
    sections: [],
    links: [{ label: "Open the alerts page", url: links.alerts }],
    alerts: [],
  };
}
