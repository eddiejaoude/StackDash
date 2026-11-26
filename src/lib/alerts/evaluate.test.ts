import { describe, expect, it } from "vitest";

import { declaredProjectedSpend } from "@/lib/adapters/registry";

import {
  alertDedupeKey,
  evaluateAlerts,
  joinAlertSnapshots,
  quantityCycleKey,
  type AlertNames,
  type AlertRuleInput,
  type AlertSnapshotInput,
  type BudgetInput,
} from "./evaluate";

const NOW = new Date("2026-10-20T12:00:00Z");
const OCTOBER = "2026-10-01";

const NAMES: AlertNames = {
  providers: new Map([
    ["resend", "Resend"],
    ["vercel", "Vercel"],
  ]),
  projects: new Map([["project-acme", "Acme"]]),
  connections: new Map([
    ["conn-resend", "Resend"],
    ["conn-vercel", "Vercel team"],
  ]),
};

const RESEND_BASE: AlertSnapshotInput = {
  connection_id: "conn-resend",
  external_account_id: "acct-resend",
  provider: "resend",
  projectId: null,
  metric_key: "resend.emails.monthly.used",
  kind: "usage",
  label: "Emails used against the monthly quota",
  snapshot_date: "2026-10-20",
  value: 0,
  unit: "emails",
  amount_minor: null,
  currency: null,
  period_start: "2026-10-01T00:00:00Z",
  period_end: "2026-11-01T00:00:00Z",
  point_at: null,
  resets_at: null,
  retrieved_at: "2026-10-20T11:00:00Z",
  provenance_source: "provider_api",
  pricing_source: null,
};

function limit(value: number, overrides: Partial<AlertSnapshotInput> = {}): AlertSnapshotInput {
  return {
    ...RESEND_BASE,
    metric_key: "resend.emails.monthly.limit",
    kind: "included_allowance",
    label: "Monthly email quota",
    value,
    ...overrides,
  };
}

function used(value: number, overrides: Partial<AlertSnapshotInput> = {}): AlertSnapshotInput {
  return { ...RESEND_BASE, value, ...overrides };
}

function remaining(value: number, overrides: Partial<AlertSnapshotInput> = {}): AlertSnapshotInput {
  return {
    ...RESEND_BASE,
    metric_key: "resend.emails.monthly.remaining",
    kind: "remaining_allowance",
    label: "Emails remaining in the monthly quota",
    value,
    ...overrides,
  };
}

/** Month to date spend: the window ends at the retrieval time, as Vercel reports it. */
function spend(amountMinor: number, currency: string, overrides: Partial<AlertSnapshotInput> = {}): AlertSnapshotInput {
  return {
    ...RESEND_BASE,
    connection_id: "conn-vercel",
    external_account_id: "acct-vercel",
    provider: "vercel",
    metric_key: `vercel.spend.${currency.toLowerCase()}`,
    kind: "verified_spend",
    label: "Spend this month",
    value: null,
    unit: null,
    amount_minor: amountMinor,
    currency,
    period_end: "2026-10-20T11:00:00Z",
    ...overrides,
  };
}

function rule(overrides: Partial<AlertRuleInput> = {}): AlertRuleInput {
  return {
    id: "rule-1",
    kind: "allowance_percent",
    scope: "workspace",
    provider: null,
    project_id: null,
    connection_id: null,
    metric_key: null,
    budget_id: null,
    threshold_percent: 90,
    threshold_amount_minor: null,
    currency: null,
    paused: false,
    ...overrides,
  };
}

function spendRule(thresholdMinor: number, currency: string, overrides: Partial<AlertRuleInput> = {}): AlertRuleInput {
  return rule({
    kind: "spend_amount",
    threshold_percent: null,
    threshold_amount_minor: thresholdMinor,
    currency,
    ...overrides,
  });
}

const BUDGET: BudgetInput = {
  id: "budget-1",
  name: "Hosting",
  scope: "provider",
  provider: "vercel",
  project_id: null,
  connection_id: null,
  amount_minor: 10_000,
  currency: "USD",
};

function budgetRule(thresholdPercent: number, overrides: Partial<AlertRuleInput> = {}): AlertRuleInput {
  return rule({ kind: "budget_percent", budget_id: BUDGET.id, threshold_percent: thresholdPercent, ...overrides });
}

function evaluate(
  rules: readonly AlertRuleInput[],
  snapshots: readonly AlertSnapshotInput[],
  options: { budgets?: readonly BudgetInput[]; now?: Date } = {},
) {
  return evaluateAlerts({
    rules,
    snapshots,
    budgets: options.budgets ?? [BUDGET],
    names: NAMES,
    projectedSpend: declaredProjectedSpend,
    now: options.now ?? NOW,
  });
}

describe("allowance_percent thresholds", () => {
  it.each([
    ["exactly at the threshold fires", 9000, 90, true],
    ["just below the threshold does not fire", 8999, 90, false],
    ["just above the threshold fires", 9001, 90, true],
    ["over the allowance fires the 100 percent rule", 10_500, 100, true],
    ["exactly at a float-unfriendly threshold fires (29 of 100)", 2900, 29, true],
  ])("%s", (_name, usedValue, threshold, fires) => {
    const triggers = evaluate([rule({ threshold_percent: threshold })], [limit(10_000), used(usedValue)]);
    expect(triggers.length).toBe(fires ? 1 : 0);
  });

  it("fires every threshold crossed in one evaluation, once each", () => {
    const rules = [50, 75, 90, 100].map((threshold) => rule({ id: `rule-${threshold}`, threshold_percent: threshold }));
    const triggers = evaluate(rules, [limit(10_000), used(9500)]);
    expect(triggers.map((trigger) => trigger.ruleId)).toEqual(["rule-50", "rule-75", "rule-90"]);
    expect(new Set(triggers.map((trigger) => trigger.cycleKey))).toEqual(new Set([OCTOBER]));
  });

  it.each([
    ["below 100 percent is a warning", 90, 9500, "warning"],
    ["at 100 percent is critical", 100, 10_000, "critical"],
  ] as const)("severity: %s", (_name, threshold, usedValue, severity) => {
    const [trigger] = evaluate([rule({ threshold_percent: threshold })], [limit(10_000), used(usedValue)]);
    expect(trigger?.severity).toBe(severity);
  });

  it("describes the reading in words, with no dashes", () => {
    const [trigger] = evaluate([rule()], [limit(10_000), used(9200)]);
    expect(trigger).toMatchObject({
      ruleId: "rule-1",
      cycleKey: OCTOBER,
      observed: { value: 92, amountMinor: null, currency: null },
      thresholdLabel: "90 percent",
      isEstimated: false,
      title: "Resend monthly email quota passed 90 percent of the allowance",
      subject: "Resend monthly email quota",
      message:
        "Resend monthly email quota is at 92 percent of the allowance (9,200 emails of 10,000 emails) " +
        "for the billing period starting 2026-10-01. The alert threshold is 90 percent.",
    });
    expect(`${trigger?.title} ${trigger?.subject} ${trigger?.message}`).not.toMatch(/[\u2013\u2014]/);
  });

  it("names the metric in the subject, so two allowances of one provider are told apart (#297)", () => {
    const daily = { metric_key: "resend.emails.daily.limit", label: "Daily email quota" };
    const triggers = evaluate(
      [rule({ id: "rule-monthly", metric_key: "resend.emails.monthly" }), rule({ id: "rule-daily", metric_key: "resend.emails.daily" })],
      [limit(10_000), used(9100), limit(100, daily), used(99, { metric_key: "resend.emails.daily.used" })],
    );
    expect(triggers.map(({ ruleId, subject, provider }) => ({ ruleId, subject, provider }))).toEqual([
      { ruleId: "rule-monthly", subject: "Resend monthly email quota", provider: "resend" },
      { ruleId: "rule-daily", subject: "Resend daily email quota", provider: "resend" },
    ]);
  });

  it("falls back to the provider id in the subject when the provider has no display name", () => {
    const unnamed: AlertNames = { ...NAMES, providers: new Map() };
    const [trigger] = evaluateAlerts({
      rules: [rule()],
      snapshots: [limit(10_000), used(9200)],
      budgets: [],
      names: unnamed,
      projectedSpend: declaredProjectedSpend,
      now: NOW,
    });
    expect(trigger?.subject).toBe("resend monthly email quota");
  });

  it("uses the current value: the latest snapshot per metric wins", () => {
    const yesterday = { snapshot_date: "2026-10-19", retrieved_at: "2026-10-19T11:00:00Z" };
    const triggers = evaluate([rule()], [limit(10_000), used(9900, yesterday), used(100)]);
    expect(triggers).toEqual([]);
  });
});

describe("allowance pairing", () => {
  it("falls back to included minus remaining when there is no usage metric", () => {
    const [trigger] = evaluate([rule()], [limit(10_000), remaining(500)]);
    expect(trigger?.observed.value).toBe(95);
  });

  it.each([
    ["the rule names the shared prefix", "resend.emails.monthly", 1],
    ["the rule names the allowance metric", "resend.emails.monthly.limit", 1],
    ["the rule names the usage metric", "resend.emails.monthly.used", 1],
    ["the rule names another allowance", "resend.emails.daily", 0],
  ])("metric key: %s", (_name, metricKey, expected) => {
    expect(evaluate([rule({ metric_key: metricKey })], [limit(10_000), used(9500)])).toHaveLength(expected);
  });

  it("does not pair a usage metric measured in another unit", () => {
    expect(evaluate([rule()], [limit(10_000), used(9500, { unit: "requests" })])).toEqual([]);
  });

  it("records one alert per rule and cycle when several allowances cross, the furthest one", () => {
    const daily = { metric_key: "resend.emails.daily.limit", label: "Daily email quota" };
    const triggers = evaluate(
      [rule()],
      [
        limit(10_000),
        used(9100),
        limit(100, daily),
        used(99, { metric_key: "resend.emails.daily.used" }),
      ],
    );
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.observed.value).toBe(99);
    expect(triggers[0]?.title).toBe("Resend daily email quota passed 90 percent of the allowance");
    expect(triggers[0]?.subject).toBe("Resend daily email quota");
  });
});

describe("unavailable data never triggers", () => {
  it.each([
    ["zero allowance", [limit(0), used(5)]],
    ["missing usage and remaining", [limit(10_000)]],
    ["missing allowance", [used(9_999)]],
    ["usage with no value", [limit(10_000), used(9500, { value: null })]],
    [
      "no reading in the current cycle (a closed September period)",
      [
        limit(10_000, { period_start: "2026-09-01T00:00:00Z", period_end: "2026-10-01T00:00:00Z", retrieved_at: "2026-10-02T00:00:00Z" }),
        used(9900, { period_start: "2026-09-01T00:00:00Z", period_end: "2026-10-01T00:00:00Z", retrieved_at: "2026-10-02T00:00:00Z" }),
      ],
    ],
    [
      "point reading taken before its reset",
      [
        limit(10_000, { period_start: null, period_end: null, point_at: "2026-10-10T00:00:00Z", resets_at: "2026-10-15T00:00:00Z" }),
        used(9900, { period_start: null, period_end: null, point_at: "2026-10-10T00:00:00Z", resets_at: "2026-10-15T00:00:00Z" }),
      ],
    ],
    [
      "point reading from last month",
      [
        limit(10_000, { period_start: null, period_end: null, point_at: "2026-09-30T23:00:00Z" }),
        used(9900, { period_start: null, period_end: null, point_at: "2026-09-30T23:00:00Z" }),
      ],
    ],
  ])("%s", (_name, snapshots) => {
    expect(evaluate([rule({ threshold_percent: 1 })], snapshots)).toEqual([]);
  });

  it("spend rule with no spend reading in its currency", () => {
    expect(evaluate([spendRule(1, "USD")], [limit(10_000), used(9500)])).toEqual([]);
  });

  it("budget rule whose budget is gone", () => {
    expect(evaluate([budgetRule(1)], [spend(9000, "USD")], { budgets: [] })).toEqual([]);
  });
});

describe("rule selection", () => {
  it("ignores a paused rule", () => {
    expect(evaluate([rule({ paused: true })], [limit(10_000), used(9500)])).toEqual([]);
  });

  it.each([
    ["provider", { scope: "provider", provider: "vercel" }, 0],
    ["provider (matching)", { scope: "provider", provider: "resend" }, 1],
    ["project", { scope: "project", project_id: "project-acme" }, 0],
    ["connection", { scope: "connection", connection_id: "conn-vercel" }, 0],
    ["connection (matching)", { scope: "connection", connection_id: "conn-resend" }, 1],
  ] as const)("scope: %s", (_name, scope, expected) => {
    expect(evaluate([rule(scope)], [limit(10_000), used(9500)])).toHaveLength(expected);
  });

  it("matches a project scope through the external account's project", () => {
    const inProject = { projectId: "project-acme" };
    const triggers = evaluate(
      [rule({ scope: "project", project_id: "project-acme" })],
      [limit(10_000, inProject), used(9500, inProject)],
    );
    expect(triggers).toHaveLength(1);
  });
});

describe("billing cycles", () => {
  const november = { period_start: "2026-11-01T00:00:00Z", period_end: "2026-12-01T00:00:00Z", snapshot_date: "2026-11-03", retrieved_at: "2026-11-03T08:00:00Z" };

  it("fires again after the billing period rolls over, under a new cycle key", () => {
    const october = evaluate([rule()], [limit(10_000), used(9500)]);
    const next = evaluate([rule()], [limit(10_000, november), used(9500, november)], {
      now: new Date("2026-11-03T09:00:00Z"),
    });
    expect(october.map((trigger) => trigger.cycleKey)).toEqual([OCTOBER]);
    expect(next.map((trigger) => trigger.cycleKey)).toEqual(["2026-11-01"]);
  });

  it.each([
    ["no reset time: the UTC month start of now", null, NOW, OCTOBER],
    ["with a reset time: the reset instant, to the minute", "2026-11-01T00:00:00.123Z", NOW, "resets:2026-11-01T00:00Z"],
    ["at the reset instant: unavailable", "2026-11-01T00:00:00Z", new Date("2026-11-01T00:00:00Z"), null],
  ])("point reading cycle key, %s", (_name, resetsAt, now, expected) => {
    const point = { period_start: null, period_end: null, point_at: "2026-10-20T11:00:00Z", resets_at: resetsAt };
    expect(quantityCycleKey(used(1, point), now)).toBe(expected);
  });

  describe("daily quota (point readings with a reset time)", () => {
    const dailyRule = rule({ metric_key: "resend.emails.daily" });
    function day(pointAt: string, resetsAt: string, usedValue: number) {
      const at = { period_start: null, period_end: null, point_at: pointAt, retrieved_at: pointAt, resets_at: resetsAt };
      return [
        limit(100, { ...at, metric_key: "resend.emails.daily.limit", label: "Daily email quota" }),
        used(usedValue, { ...at, metric_key: "resend.emails.daily.used" }),
      ];
    }
    const morning = evaluate([dailyRule], day("2026-10-20T09:00:00Z", "2026-10-21T00:00:00Z", 92), {
      now: new Date("2026-10-20T09:05:00Z"),
    });
    const evening = evaluate([dailyRule], day("2026-10-20T21:00:00Z", "2026-10-21T00:00:00Z", 97), {
      now: new Date("2026-10-20T21:05:00Z"),
    });
    const nextDay = evaluate([dailyRule], day("2026-10-21T09:00:00Z", "2026-10-22T00:00:00Z", 95), {
      now: new Date("2026-10-21T09:05:00Z"),
    });

    it("fires when the daily threshold is crossed, keyed by the reset", () => {
      expect(morning.map((trigger) => trigger.cycleKey)).toEqual(["resets:2026-10-21T00:00Z"]);
      expect(morning[0]?.message).toContain("for the period that resets 2026-10-21 01:00 BST.");
    });

    it("does not fire twice within one day: a later sync keeps the same cycle key", () => {
      expect(evening.map((trigger) => trigger.cycleKey)).toEqual(morning.map((trigger) => trigger.cycleKey));
    });

    it("fires again after the next daily reset, under a new cycle key", () => {
      expect(nextDay.map((trigger) => trigger.cycleKey)).toEqual(["resets:2026-10-22T00:00Z"]);
    });

    it("does not fire on yesterday's reading once the reset has passed", () => {
      expect(
        evaluate([dailyRule], day("2026-10-20T21:00:00Z", "2026-10-21T00:00:00Z", 97), {
          now: new Date("2026-10-21T00:30:00Z"),
        }),
      ).toEqual([]);
    });
  });

  it("keys the alert and its timeline event by rule and cycle", () => {
    expect(alertDedupeKey("rule-1", OCTOBER)).toBe("alert:rule-1:2026-10-01");
  });
});

describe("rule edited mid-cycle", () => {
  const snapshots = [limit(10_000), used(9200)];
  const fired = evaluate([rule({ threshold_percent: 90 })], snapshots);

  it("uses the current threshold: raised above the reading, it does not fire", () => {
    expect(fired).toHaveLength(1);
    expect(evaluate([rule({ threshold_percent: 95 })], snapshots)).toEqual([]);
  });

  it("raised and crossed again, it keeps the same cycle key, so the unique key skips it", () => {
    const again = evaluate([rule({ threshold_percent: 95 })], [limit(10_000), used(9600)]);
    expect(again.map((trigger) => trigger.cycleKey)).toEqual(fired.map((trigger) => trigger.cycleKey));
  });

  it("lowered below the reading before it fired, it fires at the next evaluation", () => {
    expect(evaluate([rule({ threshold_percent: 99 })], snapshots)).toEqual([]);
    expect(evaluate([rule({ threshold_percent: 92 })], snapshots)).toHaveLength(1);
  });
});

describe("spend_amount", () => {
  it.each([
    ["exactly at the amount fires", 2500, true],
    ["one minor unit below does not fire", 2499, false],
  ])("%s", (_name, amount, fires) => {
    expect(evaluate([spendRule(2500, "USD")], [spend(amount, "USD")])).toHaveLength(fires ? 1 : 0);
  });

  it("counts only the rule currency, never converting or adding others", () => {
    expect(evaluate([spendRule(2500, "USD")], [spend(2000, "USD"), spend(500_000, "EUR")])).toEqual([]);
    const [trigger] = evaluate([spendRule(2500, "EUR")], [spend(2000, "USD"), spend(3000, "EUR")]);
    expect(trigger?.observed).toEqual({ value: null, amountMinor: 3000, currency: "EUR" });
    expect(trigger?.message).toContain("Only EUR amounts are counted.");
  });

  const estimatedSpend = (amountMinor: number, overrides: Partial<AlertSnapshotInput> = {}) =>
    spend(amountMinor, "USD", {
      metric_key: "vercel.estimated.usd",
      kind: "estimated_spend",
      provenance_source: "derived",
      pricing_source: "vercel-pricing-2026-10",
      ...overrides,
    });

  it("never adds verified and estimated spend for the same account", () => {
    expect(evaluate([spendRule(2500, "USD")], [spend(2000, "USD"), estimatedSpend(2000)])).toEqual([]);
    const [trigger] = evaluate([spendRule(2000, "USD")], [spend(2000, "USD"), estimatedSpend(3000)]);
    expect(trigger).toMatchObject({ isEstimated: false, observed: { amountMinor: 2000, currency: "USD" } });
    expect(trigger?.message).not.toContain("estimated");
  });

  it("falls back to estimated spend for an account with no verified spend and says it is estimated", () => {
    const [trigger] = evaluate([spendRule(2500, "USD")], [estimatedSpend(3000)]);
    expect(trigger).toMatchObject({
      isEstimated: true,
      observed: { amountMinor: 3000, currency: "USD" },
      thresholdLabel: "$25.00",
      title: "Workspace spend passed $25.00",
      subject: "Workspace spend",
    });
    expect(trigger?.message).toContain("estimated by StackDash");
  });

  it("adds verified spend from one account to estimated spend from an account that has no verified spend", () => {
    const otherAccount = { connection_id: "conn-vercel-2", external_account_id: "acct-vercel-2" };
    const [trigger] = evaluate(
      [spendRule(2500, "USD")],
      [spend(2000, "USD"), estimatedSpend(4000), estimatedSpend(1000, otherAccount)],
    );
    expect(trigger).toMatchObject({ isEstimated: true, observed: { amountMinor: 3000, currency: "USD" } });
  });

  it("ignores estimated spend from a past period when choosing the fallback", () => {
    const september = { period_start: "2026-09-01T00:00:00Z", period_end: "2026-10-01T00:00:00Z" };
    expect(evaluate([spendRule(1, "USD")], [estimatedSpend(3000, september)])).toEqual([]);
  });

  // PostHog's projected spend, Railway's estimated bill, and the Example provider's month estimate.
  it.each(declaredProjectedSpend)("never counts %s, a declared projection, as spend, even with no verified spend", (metricKey) => {
    // The declared key decides, whichever provider reports it: alone, and beside verified spend.
    const projection = estimatedSpend(3000, { metric_key: metricKey, period_end: "2026-11-01T00:00:00Z" });
    expect(evaluate([spendRule(1, "USD")], [projection])).toEqual([]);
    const [trigger] = evaluate([spendRule(1, "USD")], [spend(2000, "USD"), projection]);
    expect(trigger).toMatchObject({ isEstimated: false, observed: { amountMinor: 2000, currency: "USD" } });
  });

  it("does not call verified spend estimated", () => {
    const [trigger] = evaluate([spendRule(2500, "USD")], [spend(3000, "USD")]);
    expect(trigger?.isEstimated).toBe(false);
    expect(trigger?.message).not.toContain("estimated");
  });

  it("keys the cycle by the spend period start", () => {
    const [trigger] = evaluate([spendRule(1, "USD")], [spend(3000, "USD", { period_start: "2026-10-05T00:00:00Z" })]);
    expect(trigger?.cycleKey).toBe("2026-10-05");
  });

  it("ignores spend from a past period", () => {
    const september = { period_start: "2026-09-01T00:00:00Z", period_end: "2026-10-01T00:00:00Z" };
    expect(evaluate([spendRule(1, "USD")], [spend(3000, "USD", september)])).toEqual([]);
  });

  it.each([
    ["project", { scope: "project", project_id: "project-acme" }, "Project Acme spend"],
    ["provider", { scope: "provider", provider: "vercel" }, "Vercel spend"],
    ["connection", { scope: "connection", connection_id: "conn-vercel" }, "Connection Vercel team spend"],
  ] as const)("names a spend amount rule's %s scope in the subject", (_name, scope, subject) => {
    const [trigger] = evaluate([spendRule(2500, "USD", scope)], [spend(3000, "USD", { projectId: "project-acme" })]);
    expect(trigger?.subject).toBe(subject);
  });
});

describe("GitHub spend levels (#137)", () => {
  // The same money per product month to date, per SKU, and per product for today.
  const github = { connection_id: "conn-github", external_account_id: "acct-github", provider: "github" as const };
  const levels = [
    spend(1252, "USD", { ...github, metric_key: "github.daily_spend.actions", period_start: "2026-10-20T00:00:00Z", period_end: "2026-10-21T00:00:00Z" }),
    spend(5175, "USD", { ...github, metric_key: "github.spend.actions", period_end: "2026-11-01T00:00:00Z" }),
    spend(5175, "USD", { ...github, metric_key: "github.spend.actions.actions_linux", period_end: "2026-11-01T00:00:00Z" }),
  ];

  it("counts the month to date product spend once and keys the cycle by the month", () => {
    expect(evaluate([spendRule(5176, "USD")], levels)).toEqual([]);
    const [trigger] = evaluate([spendRule(5175, "USD")], levels);
    expect(trigger).toMatchObject({ cycleKey: OCTOBER, observed: { amountMinor: 5175, currency: "USD" } });
  });

  it("measures a budget against the month to date product spend once", () => {
    const githubBudget: BudgetInput = { ...BUDGET, provider: "github", amount_minor: 10_000 };
    expect(evaluate([budgetRule(52)], levels, { budgets: [githubBudget] })).toEqual([]);
    const [trigger] = evaluate([budgetRule(51)], levels, { budgets: [githubBudget] });
    expect(trigger?.observed).toEqual({ value: 51.75, amountMinor: 5175, currency: "USD" });
  });

  it("counts a GitHub day on its own when the month is unavailable, keyed by that day", () => {
    const [daily] = levels;
    if (daily === undefined) throw new Error("expected the daily row");
    expect(evaluate([spendRule(1253, "USD")], [daily])).toEqual([]);
    const [trigger] = evaluate([spendRule(1252, "USD")], [daily]);
    expect(trigger).toMatchObject({ cycleKey: "2026-10-20", observed: { amountMinor: 1252 } });
  });
});

describe("budget_percent", () => {
  it.each([
    ["exactly at the threshold fires", 7500, 75, true],
    ["just below the threshold does not fire", 7499, 75, false],
    ["past the budget is critical at 100 percent", 10_100, 100, true],
  ])("%s", (_name, amount, threshold, fires) => {
    expect(evaluate([budgetRule(threshold)], [spend(amount, "USD")])).toHaveLength(fires ? 1 : 0);
  });

  it("compares spend in the budget's scope and currency with the budget amount", () => {
    const outOfScope = spend(50_000, "USD", { connection_id: "conn-resend", external_account_id: "acct-resend", provider: "resend", metric_key: "resend.spend.usd" });
    const otherCurrency = spend(50_000, "EUR");
    const [trigger] = evaluate([budgetRule(75)], [spend(8000, "USD"), outOfScope, otherCurrency]);
    expect(trigger).toMatchObject({
      observed: { value: 80, amountMinor: 8000, currency: "USD" },
      thresholdLabel: "75 percent",
      severity: "warning",
      title: "Budget Hosting passed 75 percent",
      subject: "Hosting budget",
    });
  });

  it("is critical at or above 100 percent", () => {
    const [trigger] = evaluate([budgetRule(100)], [spend(10_000, "USD")]);
    expect(trigger?.severity).toBe("critical");
  });

  it("counts verified spend only when the same account also has an estimate", () => {
    const estimate = spend(6000, "USD", { metric_key: "vercel.estimated.usd", kind: "estimated_spend", provenance_source: "derived" });
    expect(evaluate([budgetRule(75)], [spend(5000, "USD"), estimate])).toEqual([]);
  });

  it("never fires on spend in another currency", () => {
    expect(evaluate([budgetRule(1)], [spend(1_000_000, "EUR")])).toEqual([]);
  });
});

describe("joinAlertSnapshots", () => {
  const { provider: _provider, projectId: _projectId, ...stored } = used(10);
  const connections = [{ id: "conn-resend", provider: "resend" as const }];

  it("joins a row to its connection's provider and its account's project", () => {
    const accounts = [{ id: "acct-resend", connection_id: "conn-resend", project_id: "project-acme" }];
    expect(joinAlertSnapshots([stored], connections, accounts)).toEqual([{ ...stored, provider: "resend", projectId: "project-acme" }]);
  });

  it.each([
    ["its account is not included", [], connections],
    ["its account moved to another connection", [{ id: "acct-resend", connection_id: "conn-other", project_id: null }], connections],
    ["its connection is not listed", [{ id: "acct-resend", connection_id: "conn-resend", project_id: null }], []],
  ])("skips a row when %s", (_name, accounts, listed) => {
    expect(joinAlertSnapshots([stored], listed, accounts)).toEqual([]);
  });
});
