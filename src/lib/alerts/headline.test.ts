import { describe, expect, it } from "vitest";

import { alertHeadline, type AlertHeadlineInput } from "./headline";

const VERCEL_BUDGET: AlertHeadlineInput = {
  kind: "budget_percent",
  provider: "vercel",
  subject: null,
  observed_value: 94.2867,
  observed_amount_minor: 56572,
  currency: "USD",
};

const VERCEL_BANDWIDTH: AlertHeadlineInput = {
  kind: "allowance_percent",
  provider: "vercel",
  subject: "Vercel bandwidth",
  observed_value: 82.5,
  observed_amount_minor: null,
  currency: null,
};

describe("alertHeadline", () => {
  it("leads a budget alert with the provider, the kind, and the percent reached", () => {
    expect(alertHeadline(VERCEL_BUDGET)).toEqual({
      title: "Vercel budget at 94.3 percent",
      percent: 94.2867,
      value: "94.3 percent of the budget, $565.72 spent",
    });
  });

  it.each<[string, AlertHeadlineInput, { title: string; percent: number | null; value: string | null }]>([
    [
      "an allowance over 100 percent keeps the real percent for the bar and the words",
      { kind: "allowance_percent", provider: "github", subject: null, observed_value: 104, observed_amount_minor: null, currency: null },
      { title: "GitHub allowance at 104 percent", percent: 104, value: "104 percent of the allowance" },
    ],
    [
      "a missing provider leads with the kind alone",
      { ...VERCEL_BUDGET, provider: null },
      { title: "Budget at 94.3 percent", percent: 94.2867, value: "94.3 percent of the budget, $565.72 spent" },
    ],
    [
      "a missing amount leaves the money out",
      { ...VERCEL_BUDGET, observed_amount_minor: null, currency: null },
      { title: "Vercel budget at 94.3 percent", percent: 94.2867, value: "94.3 percent of the budget" },
    ],
    [
      "a spend amount rule in a non-USD currency titles with the amount in that currency and has no bar",
      { kind: "spend_amount", provider: null, subject: null, observed_value: null, observed_amount_minor: 12550, currency: "EUR" },
      { title: "Spend at €125.50", percent: null, value: "€125.50 spent" },
    ],
    [
      "a zero-decimal currency is formatted without minor digits",
      { kind: "spend_amount", provider: "vercel", subject: null, observed_value: null, observed_amount_minor: 1200, currency: "JPY" },
      { title: "Vercel spend at ¥1,200", percent: null, value: "¥1,200 spent" },
    ],
    [
      "nothing observed says the threshold passed without inventing a value",
      { kind: "spend_amount", provider: "vercel", subject: null, observed_value: null, observed_amount_minor: null, currency: null },
      { title: "Vercel spend passed its threshold", percent: null, value: null },
    ],
    [
      "a rule that could not be read still gets a title",
      { kind: null, provider: null, subject: null, observed_value: 92, observed_amount_minor: null, currency: null },
      { title: "Alert at 92 percent", percent: 92, value: "92 percent" },
    ],
    [
      "a non-finite stored value is treated as not observed",
      { ...VERCEL_BUDGET, observed_value: Number.POSITIVE_INFINITY },
      { title: "Vercel budget at $565.72", percent: null, value: "$565.72 spent" },
    ],
    [
      "a percent just under a whole number rounds the way the sentence does",
      { ...VERCEL_BUDGET, observed_value: 99.96, observed_amount_minor: null, currency: null },
      { title: "Vercel budget at 100 percent", percent: 99.96, value: "100 percent of the budget" },
    ],
  ])("%s", (_case, input, expected) => {
    expect(alertHeadline(input)).toEqual(expected);
  });
});

describe("alertHeadline with the evaluator's subject (#297)", () => {
  it("names the metric of an allowance alert, so two on one provider read differently", () => {
    const buildMinutes = { ...VERCEL_BANDWIDTH, subject: "Vercel build minutes", observed_value: 91.2 };
    expect([alertHeadline(VERCEL_BANDWIDTH).title, alertHeadline(buildMinutes).title]).toEqual([
      "Vercel bandwidth at 82.5 percent",
      "Vercel build minutes at 91.2 percent",
    ]);
    expect(alertHeadline(VERCEL_BANDWIDTH)).toEqual({
      title: "Vercel bandwidth at 82.5 percent",
      percent: 82.5,
      value: "82.5 percent of the allowance",
    });
  });

  it.each<[string, AlertHeadlineInput, string]>([
    ["a budget alert leads with the budget", { ...VERCEL_BUDGET, subject: "Vercel monthly budget" }, "Vercel monthly budget at 94.3 percent"],
    [
      "a spend amount alert leads with its scope",
      { kind: "spend_amount", provider: null, subject: "Project Acme spend", observed_value: null, observed_amount_minor: 12550, currency: "EUR" },
      "Project Acme spend at €125.50",
    ],
    ["a subject with nothing observed still says the threshold passed", { ...VERCEL_BANDWIDTH, observed_value: null }, "Vercel bandwidth passed its threshold"],
    ["a subject outlives a rule that could not be read", { ...VERCEL_BANDWIDTH, kind: null }, "Vercel bandwidth at 82.5 percent"],
    ["surrounding whitespace in a subject is not shown", { ...VERCEL_BANDWIDTH, subject: "  Vercel bandwidth \n" }, "Vercel bandwidth at 82.5 percent"],
  ])("%s", (_case, input, title) => {
    expect(alertHeadline(input).title).toBe(title);
  });

  it.each<[string, string | null]>([
    ["a null subject (an alert recorded before #297)", null],
    ["an empty subject", ""],
    ["a whitespace only subject", " \t "],
  ])("%s keeps the provider and kind title", (_case, subject) => {
    expect(alertHeadline({ ...VERCEL_BANDWIDTH, subject })).toEqual({
      title: "Vercel allowance at 82.5 percent",
      percent: 82.5,
      value: "82.5 percent of the allowance",
    });
  });
});
