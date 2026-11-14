import type { AcknowledgeAllResult } from "@/app/w/[workspace]/alerts/actions";
import {
  AMOUNT_PRESETS,
  CUSTOM_CHOICE,
  minorUnitsToDecimalString,
  PERCENT_PRESETS,
  type AlertRuleKind,
  type AlertScope,
  type ProviderId,
} from "@/lib/alerts/rule-schema";
import { currencyMinorDigits, decimalToMinorUnits } from "@/lib/money";
import type { DestinationKind, DigestFrequency, EmailFrequency } from "@/lib/notifications/model";

/**
 * Copy and serializable shapes shared by the server-rendered alerts inbox and alert settings and
 * their client forms. Everything here is plain data or pure functions, safe on either side.
 */

export const KIND_LABELS: Record<AlertRuleKind, string> = {
  allowance_percent: "Usage reaches a percentage of a provider allowance",
  spend_amount: "Spend reaches an amount",
  budget_percent: "Spend reaches a percentage of your budget",
};

export const SCOPE_LABELS: Record<AlertScope, string> = {
  workspace: "The whole workspace",
  provider: "One provider",
  project: "One project",
  connection: "One connection",
};

export type Option = { value: string; label: string };

/** Everything the rule and budget forms need to render their choices. */
export type AlertFormOptions = {
  workspaceSlug: string;
  providers: Option[];
  projects: Option[];
  connections: Option[];
  budgets: Option[];
  currencies: string[];
  defaultCurrency: string;
  metrics: Option[];
};

/** Form state for the rule form: one string per field, empty when not set. */
export type RuleFormValues = {
  kind: AlertRuleKind;
  scope: AlertScope;
  provider: string;
  projectId: string;
  connectionId: string;
  metricKey: string;
  budgetId: string;
  thresholdPreset: string;
  thresholdCustom: string;
  amountPreset: string;
  amountCustom: string;
  currency: string;
};

export type BudgetFormValues = {
  name: string;
  amount: string;
  currency: string;
  scope: AlertScope;
  provider: string;
  projectId: string;
  connectionId: string;
};

export function defaultRuleValues(currency: string): RuleFormValues {
  return {
    kind: "allowance_percent",
    scope: "workspace",
    provider: "",
    projectId: "",
    connectionId: "",
    metricKey: "",
    budgetId: "",
    thresholdPreset: "75",
    thresholdCustom: "",
    amountPreset: "10",
    amountCustom: "",
    currency,
  };
}

export function defaultBudgetValues(currency: string): BudgetFormValues {
  return { name: "", amount: "", currency, scope: "workspace", provider: "", projectId: "", connectionId: "" };
}

type RuleLike = {
  kind: AlertRuleKind;
  scope: AlertScope;
  provider: ProviderId | null;
  project_id: string | null;
  connection_id: string | null;
  metric_key: string | null;
  budget_id: string | null;
  threshold_percent: number | null;
  threshold_amount_minor: number | null;
  currency: string | null;
};

/** A stored rule as the edit form's starting values. */
export function ruleToFormValues(rule: RuleLike, defaultCurrency: string): RuleFormValues {
  const percent = rule.threshold_percent === null ? null : String(rule.threshold_percent);
  const isPercentPreset = percent !== null && (PERCENT_PRESETS as readonly string[]).includes(percent);
  const currency = rule.currency ?? defaultCurrency;
  const amount =
    rule.threshold_amount_minor === null ? null : minorUnitsToDecimalString(rule.threshold_amount_minor, currency);
  // A stored 1000 cents is the 10 preset; any other amount opens as a custom value.
  const amountPreset = AMOUNT_PRESETS.find(
    (preset) => rule.threshold_amount_minor !== null && decimalToMinorUnits(preset, currency) === rule.threshold_amount_minor,
  );
  return {
    kind: rule.kind,
    scope: rule.scope,
    provider: rule.provider ?? "",
    projectId: rule.project_id ?? "",
    connectionId: rule.connection_id ?? "",
    metricKey: rule.metric_key ?? "",
    budgetId: rule.budget_id ?? "",
    thresholdPreset: percent === null ? "75" : isPercentPreset ? percent : CUSTOM_CHOICE,
    thresholdCustom: percent !== null && !isPercentPreset ? percent : "",
    amountPreset: amount === null ? "10" : (amountPreset ?? CUSTOM_CHOICE),
    amountCustom: amount !== null && amountPreset === undefined ? amount : "",
    currency,
  };
}

/** Formats a whole or decimal amount typed in major units: "5" in GBP is "£5.00". */
export function formatMajorAmount(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

/** Formats integer minor units: 25050 GBP is "£250.50". Never sums across currencies. */
export function formatMinorAmount(minor: number, currency: string): string {
  return formatMajorAmount(minor / 10 ** currencyMinorDigits(currency), currency);
}

// ── Alert delivery (#152, #153) ────────────────────────────────────────────────────────────────

export const EMAIL_FREQUENCY_CHOICES: ReadonlyArray<{ value: EmailFrequency; label: string; hint: string }> = [
  { value: "immediate", label: "As each alert happens", hint: "One email per alert, at most once each billing period." },
  { value: "daily", label: "Daily digest", hint: "One email each morning with new alerts, usage, and spend." },
  { value: "weekly", label: "Weekly digest", hint: "One email each Monday covering the week before." },
  { value: "off", label: "Off", hint: "No alert emails. Alerts still show in StackDash." },
];

export const DESTINATION_KIND_LABELS: Record<DestinationKind, string> = {
  discord: "Discord",
  slack: "Slack",
  webhook: "Webhook",
};

export const DIGEST_LABELS: Record<DigestFrequency, string> = {
  off: "No digest",
  daily: "Daily digest",
  weekly: "Weekly digest",
};

/** Form state for the channel form, one string per field. */
export type ChannelFormValues = {
  kind: DestinationKind;
  name: string;
  url: string;
  rules: "all" | "chosen";
  ruleIds: string[];
  digest: DigestFrequency;
};

export function defaultChannelValues(): ChannelFormValues {
  return { kind: "discord", name: "", url: "", rules: "all", ruleIds: [], digest: "off" };
}

/**
 * What the triggered list's live region says after "Acknowledge all": how many, where they went,
 * and what is left. Nothing acknowledged with alerts still waiting happens when another member got
 * there first and more fired meanwhile, so it says this call did nothing rather than "none left".
 */
export function acknowledgedAllMessage(
  { acknowledged, remaining }: Pick<Extract<AcknowledgeAllResult, { ok: true }>, "acknowledged" | "remaining">,
  showAcknowledged: boolean,
): string {
  let message: string;
  if (acknowledged === 0) {
    message = remaining === 0 ? "No alerts were left to acknowledge." : "No alerts were acknowledged this time.";
  } else {
    const [count, pronoun] = acknowledged === 1 ? ["1 alert", "It stays"] : [`${acknowledged} alerts`, "They stay"];
    message = `${count} acknowledged. ${pronoun} in the alert history.`;
    if (!showAcknowledged) message += ` Choose Show acknowledged alerts to see ${acknowledged === 1 ? "it" : "them"}.`;
  }
  if (remaining > 0) {
    const [count, pronoun] = remaining === 1 ? ["1 alert is", "it"] : [`${remaining} alerts are`, "them"];
    message += ` ${count} still unacknowledged. Choose Acknowledge all again to acknowledge ${pronoun}.`;
  }
  return message;
}
