import Link from "next/link";
import { connection } from "next/server";
import type { ReactNode } from "react";

import { ProjectionNote } from "@/components/dashboard/value-meta";
import { declaredProjectedSpend } from "@/lib/adapters/registry";
import { liveProviderIds } from "@/lib/adapters/types";
import { inScope, scopedItem } from "@/lib/alerts/evaluate";
import { DEFAULT_CURRENCIES, minorUnitsToDecimalString, type AlertScope, type ProviderId } from "@/lib/alerts/rule-schema";
import { budgetProjectionText, projectSpend } from "@/lib/dashboard/projection";
import {
  listAlertRuleChoices,
  listAlertRules,
  listAllowanceMetrics,
  listAllowanceRuleCoverage,
  listScopeTargets,
  type AlertRule,
  type ConnectionOption,
} from "@/lib/data/alert-rules";
import {
  getBudgetSpendRows,
  listBudgetOptions,
  listBudgets,
  listSnapshotCurrencies,
  type Budget,
} from "@/lib/data/budgets";
import type { WorkspaceRef } from "@/lib/data/workspaces";
import { PROVIDER_NAMES } from "@/lib/providers";
import { Constants } from "@/lib/supabase/database.types";
import { ALERT_SETTINGS_IDS, type AlertSettingsQuery, alertSettingsPath, pathWithQuery } from "@/lib/workspaces/paths";
import { actionDeniedReason, canPerform, type WorkspaceRole } from "@/lib/workspaces/permissions";

import { AddSuggestedAlerts } from "./add-suggested-alerts";
import { AlertDelivery } from "./alert-delivery";
import { DeniedReason } from "./form-controls";
import { FragmentHeading } from "./fragment-heading";
import { defaultBudgetValues, defaultRuleValues, formatMinorAmount, ruleToFormValues, type AlertFormOptions } from "./labels";
import { BudgetListItem, NewBudget, NewRule, RuleListItem } from "./list-items";

/**
 * Alert settings (#343): suggested alerts, alert rules, budgets, and where alerts go (alert emails
 * and channels). Each create form stays closed behind its "New" button until it is wanted.
 */

const RULES_HEADING_ID = ALERT_SETTINGS_IDS.rules;
const BUDGETS_HEADING_ID = ALERT_SETTINGS_IDS.budgets;
const FALLBACK_CURRENCY = "USD";

type Scoped = {
  scope: AlertScope;
  provider: ProviderId | null;
  project_id: string | null;
  connection_id: string | null;
};

export async function AlertSettings({
  workspace,
  role,
  userId,
  rulesAfter,
  budgetsAfter,
}: {
  workspace: WorkspaceRef;
  role: WorkspaceRole;
  userId: string;
  rulesAfter: string | null;
  budgetsAfter: string | null;
}) {
  const canManage = canPerform(role, "manage_budgets");
  // Request data first: reading the clock before it would fail the prerender.
  await connection();
  const now = new Date();
  const [rules, budgets, targets, metrics, coverage, budgetOptions, snapshotCurrencies, ruleChoices, spendRows] = await Promise.all([
    listAlertRules(workspace.id, rulesAfter),
    listBudgets(workspace.id, budgetsAfter),
    listScopeTargets(workspace.id),
    listAllowanceMetrics(workspace.id),
    listAllowanceRuleCoverage(workspace.id),
    listBudgetOptions(workspace.id),
    listSnapshotCurrencies(workspace.id),
    listAlertRuleChoices(workspace.id),
    getBudgetSpendRows(workspace.id, now),
  ]);

  /**
   * Where the budget's spend is heading by the end of the period (#167), with "Projected to
   * cross" when it reaches the amount. Shown only; it never raises an alert. Nothing when the
   * budget's scope has no current spend in its currency.
   */
  function budgetProjection(budget: Budget): ReactNode {
    const scoped = spendRows.filter((row) => row.currency === budget.currency && inScope(budget, scopedItem(row)));
    const spend = projectSpend(scoped, declaredProjectedSpend, now).find((projection) => projection.currency === budget.currency);
    if (spend === undefined) return null;
    const text = budgetProjectionText(spend, budget.amount_minor);
    return (
      <ProjectionNote
        text={text}
        estimate={spend.projection.status === "projected"}
        {...(text.crosses ? { flag: "Projected to cross" } : {})}
      />
    );
  }

  const projectNames = new Map(targets.projects.map((project) => [project.id, project.name]));
  const connectionsById = new Map(targets.connections.map((connection) => [connection.id, connection]));
  const budgetsById = new Map(budgetOptions.map((budget) => [budget.id, budget]));
  const metricLabels = new Map(metrics.map((metric) => [metric.metricKey, metric.label]));
  const connectionLabel = (connection: ConnectionOption) =>
    `${connection.display_name} (${PROVIDER_NAMES[connection.provider]})`;

  function scopeLabel(item: Scoped): string {
    switch (item.scope) {
      case "workspace":
        return "the whole workspace";
      case "provider":
        return item.provider === null ? "one provider" : PROVIDER_NAMES[item.provider];
      case "project": {
        const name = item.project_id === null ? undefined : projectNames.get(item.project_id);
        return name === undefined ? "one project" : `the project ${name}`;
      }
      case "connection": {
        const connection = item.connection_id === null ? undefined : connectionsById.get(item.connection_id);
        return connection === undefined ? "one connection" : `the connection ${connectionLabel(connection)}`;
      }
    }
  }

  function ruleSummary(rule: AlertRule): string {
    const percent = `${rule.threshold_percent ?? 0}%`;
    switch (rule.kind) {
      case "allowance_percent": {
        const metric =
          rule.metric_key === null ? "every allowance" : (metricLabels.get(rule.metric_key) ?? "one allowance");
        return `Alert at ${percent} of ${metric}`;
      }
      case "spend_amount":
        return rule.threshold_amount_minor === null || rule.currency === null
          ? "Alert when spend reaches an amount"
          : `Alert when spend reaches ${formatMinorAmount(rule.threshold_amount_minor, rule.currency)}`;
      case "budget_percent": {
        const budget = rule.budget_id === null ? undefined : budgetsById.get(rule.budget_id);
        return budget === undefined ? `Alert at ${percent} of a budget` : `Alert at ${percent} of the ${budget.name} budget`;
      }
    }
  }

  function ruleDetail(rule: AlertRule): string | null {
    if (rule.kind === "spend_amount" && rule.currency !== null) {
      return `Counts spend in ${rule.currency} only. Other currencies are not converted.`;
    }
    if (rule.kind === "budget_percent") {
      const budget = rule.budget_id === null ? undefined : budgetsById.get(rule.budget_id);
      return budget === undefined ? null : `Budget: ${formatMinorAmount(budget.amount_minor, budget.currency)} a month`;
    }
    return null;
  }

  const currencies = [
    ...new Set([
      ...snapshotCurrencies,
      ...DEFAULT_CURRENCIES,
      ...budgetOptions.map((budget) => budget.currency),
      ...rules.items.flatMap((rule) => (rule.currency === null ? [] : [rule.currency])),
    ]),
  ].sort();
  const defaultCurrency = snapshotCurrencies[0] ?? FALLBACK_CURRENCY;

  const liveProviders = new Set<string>(liveProviderIds);
  const connectedProviders = new Set(targets.connections.map((connection) => connection.provider));
  const options: AlertFormOptions = {
    workspaceSlug: workspace.slug,
    providers: Constants.public.Enums.provider_id
      .filter((provider) => liveProviders.has(provider) || connectedProviders.has(provider))
      .map((provider) => ({ value: provider, label: PROVIDER_NAMES[provider] })),
    projects: targets.projects.map((project) => ({ value: project.id, label: project.name })),
    connections: targets.connections.map((connection) => ({ value: connection.id, label: connectionLabel(connection) })),
    budgets: budgetOptions.map((budget) => ({
      value: budget.id,
      label: `${budget.name} (${formatMinorAmount(budget.amount_minor, budget.currency)} a month)`,
    })),
    currencies,
    defaultCurrency,
    metrics: metrics.map((metric) => {
      const provider = connectionsById.get(metric.connectionIds[0] ?? "")?.provider;
      return {
        value: metric.metricKey,
        label: provider === undefined ? metric.label : `${PROVIDER_NAMES[provider]}: ${metric.label}`,
      };
    }),
  };

  // Suggested alerts: providers with a connection that reports allowances but has no allowance
  // rule covering it (workspace-wide, provider-wide, or for that connection).
  const workspaceCovered = coverage.some((rule) => rule.scope === "workspace");
  const coveredProviders = new Set(coverage.flatMap((rule) => (rule.scope === "provider" && rule.provider !== null ? [rule.provider] : [])));
  const coveredConnections = new Set(
    coverage.flatMap((rule) => (rule.scope === "connection" && rule.connection_id !== null ? [rule.connection_id] : [])),
  );
  const suggestedProviders = workspaceCovered
    ? []
    : [
        ...new Set(
          metrics
            .flatMap((metric) => metric.connectionIds)
            .flatMap((connectionId) => {
              const connection = connectionsById.get(connectionId);
              if (connection === undefined || coveredConnections.has(connectionId)) return [];
              return coveredProviders.has(connection.provider) ? [] : [connection.provider];
            }),
        ),
      ].sort();

  const settingsPath = alertSettingsPath(workspace.slug);
  // A pager replaces its list, so it lands on that list's heading rather than the top of the page.
  // Each pager changes only its own cursor and keeps the other list's place (#316).
  const query: AlertSettingsQuery = { rulesAfter, budgetsAfter };
  const deniedReason = actionDeniedReason("manage_budgets");

  return (
    <>
      {canManage && suggestedProviders.length > 0 ? (
        <section aria-labelledby={ALERT_SETTINGS_IDS.suggested} className="mt-8 rounded-xl border border-accent/40 bg-panel">
          <div className="border-b border-line px-6 py-4">
            <FragmentHeading id={ALERT_SETTINGS_IDS.suggested}>Suggested alerts</FragmentHeading>
            <p className="mt-1 text-sm text-muted">
              These providers report allowances that no rule watches yet. Nothing is turned on until you add it.
            </p>
          </div>
          <ul className="divide-y divide-line">
            {suggestedProviders.map((provider) => (
              <li key={provider} className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-start sm:justify-between">
                <p className="text-sm">
                  <span className="font-medium">{PROVIDER_NAMES[provider]}:</span> alert at 75%, 90%, and 100% of
                  each allowance.
                </p>
                <AddSuggestedAlerts
                  workspaceSlug={workspace.slug}
                  provider={provider}
                  providerLabel={PROVIDER_NAMES[provider]}
                  afterAddFocusId={RULES_HEADING_ID}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby={RULES_HEADING_ID} className="mt-8 rounded-xl border border-line bg-panel">
        <div className="border-b border-line px-6 py-4">
          <FragmentHeading id={RULES_HEADING_ID} cursor={rulesAfter}>
            Alert rules
          </FragmentHeading>
          <p className="mt-1 text-sm text-muted">
            Rules watch synced usage and spend and raise an alert in StackDash when a threshold is crossed, at most once
            per billing period.
          </p>
        </div>

        {rules.items.length === 0 ? null : (
          <ul aria-label="Alert rules" className="divide-y divide-line">
            {rules.items.map((rule) => (
              <RuleListItem
                key={rule.id}
                ruleId={rule.id}
                summary={ruleSummary(rule)}
                scopeLabel={scopeLabel(rule)}
                detail={ruleDetail(rule)}
                paused={rule.paused}
                manage={canManage ? { options, values: ruleToFormValues(rule, defaultCurrency) } : null}
                afterDeleteFocusId={RULES_HEADING_ID}
              />
            ))}
          </ul>
        )}

        {rules.nextCursor === null && rulesAfter === null ? null : (
          <nav aria-label="Alert rule pages" className="flex flex-wrap gap-4 border-t border-line px-6 py-3 text-sm">
            {rulesAfter === null ? null : (
              <Link
                href={pathWithQuery(settingsPath, { ...query, rulesAfter: null } satisfies AlertSettingsQuery, RULES_HEADING_ID)}
                className="text-accent underline underline-offset-2"
              >
                Show the first rules
              </Link>
            )}
            {rules.nextCursor === null ? null : (
              <Link
                href={pathWithQuery(
                  settingsPath,
                  { ...query, rulesAfter: rules.nextCursor } satisfies AlertSettingsQuery,
                  RULES_HEADING_ID,
                )}
                className="text-accent underline underline-offset-2"
              >
                Show more rules
              </Link>
            )}
          </nav>
        )}

        {canManage ? (
          // One place for the empty state and the New button, so adding the first rule keeps the
          // open form and its result mounted while the list appears above it.
          <div className={rules.items.length === 0 ? "px-6 py-5" : "border-t border-line px-6 py-5"}>
            {rules.items.length === 0 ? (
              <div className="mb-4 text-sm">
                <p className="font-medium">No alert rules yet</p>
                <p className="mt-1 text-muted">Add one to hear about usage or spend before it becomes a problem.</p>
              </div>
            ) : null}
            <NewRule options={options} initial={defaultRuleValues(defaultCurrency)} />
          </div>
        ) : rules.items.length === 0 ? (
          <div className="px-6 py-5 text-sm">
            <p className="font-medium">No alert rules yet</p>
            <DeniedReason>{deniedReason}</DeniedReason>
          </div>
        ) : (
          <div className="border-t border-line px-6 py-4">
            <DeniedReason>{deniedReason}</DeniedReason>
          </div>
        )}
      </section>

      <section aria-labelledby={BUDGETS_HEADING_ID} className="mt-8 rounded-xl border border-line bg-panel">
        <div className="border-b border-line px-6 py-4">
          <FragmentHeading id={BUDGETS_HEADING_ID} cursor={budgetsAfter}>
            Budgets
          </FragmentHeading>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Your budget is a monthly spending limit you set yourself. It is separate from provider allowances, which
            are the usage a provider plan includes before it charges more. Budgets reset on the first of each month
            and only count spend in their own currency.
          </p>
        </div>

        {budgets.items.length === 0 ? null : (
          <ul aria-label="Budgets" className="divide-y divide-line">
            {budgets.items.map((budget) => (
              <BudgetListItem
                key={budget.id}
                budgetId={budget.id}
                name={budget.name}
                amountLabel={formatMinorAmount(budget.amount_minor, budget.currency)}
                scopeLabel={scopeLabel(budget)}
                projection={budgetProjection(budget)}
                manage={
                  canManage
                    ? {
                        options,
                        values: {
                          name: budget.name,
                          amount: minorUnitsToDecimalString(budget.amount_minor, budget.currency),
                          currency: budget.currency,
                          scope: budget.scope,
                          provider: budget.provider ?? "",
                          projectId: budget.project_id ?? "",
                          connectionId: budget.connection_id ?? "",
                        },
                      }
                    : null
                }
                afterDeleteFocusId={BUDGETS_HEADING_ID}
              />
            ))}
          </ul>
        )}

        {budgets.nextCursor === null && budgetsAfter === null ? null : (
          <nav aria-label="Budget pages" className="flex flex-wrap gap-4 border-t border-line px-6 py-3 text-sm">
            {budgetsAfter === null ? null : (
              <Link
                href={pathWithQuery(settingsPath, { ...query, budgetsAfter: null } satisfies AlertSettingsQuery, BUDGETS_HEADING_ID)}
                className="text-accent underline underline-offset-2"
              >
                Show the first budgets
              </Link>
            )}
            {budgets.nextCursor === null ? null : (
              <Link
                href={pathWithQuery(
                  settingsPath,
                  { ...query, budgetsAfter: budgets.nextCursor } satisfies AlertSettingsQuery,
                  BUDGETS_HEADING_ID,
                )}
                className="text-accent underline underline-offset-2"
              >
                Show more budgets
              </Link>
            )}
          </nav>
        )}

        {canManage ? (
          // The same single place as the rules section's, for the same reason.
          <div className={budgets.items.length === 0 ? "px-6 py-5" : "border-t border-line px-6 py-5"}>
            {budgets.items.length === 0 ? (
              <div className="mb-4 text-sm">
                <p className="font-medium">No budgets yet</p>
                <p className="mt-1 text-muted">Add one to alert on a percentage of what you plan to spend each month.</p>
              </div>
            ) : null}
            <NewBudget options={options} initial={defaultBudgetValues(defaultCurrency)} />
          </div>
        ) : budgets.items.length === 0 ? (
          <div className="px-6 py-5 text-sm">
            <p className="font-medium">No budgets yet</p>
            <DeniedReason>{deniedReason}</DeniedReason>
          </div>
        ) : (
          <div className="border-t border-line px-6 py-4">
            <DeniedReason>{deniedReason}</DeniedReason>
          </div>
        )}
      </section>

      <AlertDelivery
        workspace={workspace}
        role={role}
        userId={userId}
        ruleOptions={ruleChoices.map((rule) => ({ value: rule.id, label: `${ruleSummary(rule)}, for ${scopeLabel(rule)}` }))}
      />
    </>
  );
}
