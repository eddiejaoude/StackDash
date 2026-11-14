import { describe, expect, it } from "vitest";

import { renderNoticeEmail, type EmailFooter } from "./email";
import { digestPeriods, type DeliveryAlert } from "./model";
import { alertNotice, digestNotice, testNotice, type DigestContent, type Notice, type WorkspaceLinks } from "./notice";

const links: WorkspaceLinks = {
  alerts: "https://stackdash.test/w/abc/alerts",
  connections: "https://stackdash.test/w/abc/connections",
  timeline: "https://stackdash.test/w/abc/timeline",
};

const footer: EmailFooter = {
  reason: "You get this because you are an owner or admin of Acme and your alert emails are set to each alert as it happens.",
  preferencesUrl: "https://stackdash.test/w/abc/alerts/settings#alert-emails",
  unsubscribePageUrl: "https://stackdash.test/unsubscribe?token=t",
  oneClickUrl: "https://stackdash.test/api/notifications/unsubscribe?token=t",
};

function alert(fields: Partial<DeliveryAlert> = {}): DeliveryAlert {
  return {
    id: "a",
    ruleId: "r",
    title: "Example provider requests passed 90 percent of the allowance",
    message:
      "Example provider requests this month is at 104 percent of the allowance (104,000 requests of 100,000 requests) for the billing period starting 2026-11-01. The alert threshold is 90 percent.",
    severity: "critical",
    thresholdLabel: "90 percent",
    isEstimated: false,
    providerName: "Example provider",
    projectName: "Storefront",
    resetsAt: "2026-12-01T00:00:00.000Z",
    triggeredAt: "2026-11-05T09:00:00.000Z",
    ...fields,
  };
}

const [dailyPeriod] = digestPeriods("2026-11-04");
if (dailyPeriod === undefined) throw new Error("fixture: a daily period");

const digest: DigestContent = {
  workspaceName: "Acme",
  period: dailyPeriod,
  alerts: [alert()],
  allowances: [
    {
      connectionName: "Example (Acme)",
      label: "Requests this month",
      unit: "requests",
      used: 104_000,
      included: 100_000,
      percentUsed: 104,
      resetsAt: "2026-12-01T00:00:00.000Z",
    },
  ],
  spend: [
    {
      connectionName: "Example (Acme)",
      currency: "USD",
      verifiedMinor: 12_345,
      estimatedMinor: 30_000,
      period: { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" },
    },
  ],
  highlights: { deploys: 4, signups: 1, stars: 2, payments: 0 },
};

// House voice: no em or en dashes, no exclamation marks, in anything a person reads.
function expectHouseVoice(notice: Notice): void {
  const rendered = renderNoticeEmail(notice, footer);
  for (const text of [rendered.subject, rendered.text]) {
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(text).not.toContain("!");
  }
}

describe("alert email", () => {
  it("says what crossed, by how much, the provider, the project, the reset date, a link, and what to do", () => {
    const email = renderNoticeEmail(alertNotice({ workspaceName: "Acme", alerts: [alert()], links }), footer);
    expect(email.subject).toBe("Alert in Acme: Example provider requests passed 90 percent of the allowance");
    for (const line of [
      "A threshold you set in StackDash for Acme was crossed.",
      "at 104 percent of the allowance (104,000 requests of 100,000 requests)",
      "Severity: Critical",
      "Provider: Example provider",
      "Project: Storefront",
      "Resets: 2026-12-01 00:00 GMT",
      "Raise the threshold",
      "Acknowledge the alert",
      "Open the provider",
      `Open the alerts page: ${links.alerts}`,
      `Unsubscribe: ${footer.unsubscribePageUrl}`,
    ]) {
      expect(email.text).toContain(line);
    }
    expect(email.html).toContain(`href="${links.alerts}"`);
    expect(email.headers).toEqual({
      "List-Unsubscribe": `<${footer.oneClickUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("names the unknowns in words, never as a blank", () => {
    const email = renderNoticeEmail(alertNotice({ workspaceName: "Acme", alerts: [alert({ providerName: null, projectName: null, resetsAt: null })], links }), footer);
    expect(email.text).toContain("Provider: More than one provider");
    expect(email.text).toContain("Project: No single project");
    expect(email.text).toContain("Resets: Not reported by the provider");
  });

  it("escapes names in the HTML part", () => {
    const email = renderNoticeEmail(alertNotice({ workspaceName: `<script>alert("x")</script>`, alerts: [alert({ projectName: "A & B" })], links }), footer);
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(email.html).toContain("A &amp; B");
  });

  it("keeps a line break in a name out of the subject header", () => {
    const email = renderNoticeEmail(alertNotice({ workspaceName: "Acme\r\nBcc: someone@example.com", alerts: [alert()], links }), footer);
    expect(email.subject).not.toMatch(/[\r\n]/);
  });

  it("follows the house voice for one alert, many alerts, a digest, and a test", () => {
    expectHouseVoice(alertNotice({ workspaceName: "Acme", alerts: [alert()], links }));
    expectHouseVoice(alertNotice({ workspaceName: "Acme", alerts: [alert(), alert({ id: "b", severity: "warning" })], links }));
    expectHouseVoice(digestNotice(digest, links));
    expectHouseVoice(testNotice("Acme", "#alerts", links));
  });
});

describe("digest email", () => {
  it("has new alerts, usage against allowances, spend kept apart by source, and the highlights", () => {
    const email = renderNoticeEmail(digestNotice(digest, links), footer);
    expect(email.subject).toBe("Daily digest for Acme: 2026-11-04");
    for (const line of [
      "Daily digest for Acme, 2026-11-04. 1 new alert.",
      "New alerts",
      "Usage against allowances",
      "Example (Acme): Requests this month (Critical)",
      "104% used, 104,000 requests of 100,000 requests.",
      "Spend this billing period",
      "$123.45 reported by the provider, and $300.00 estimated by StackDash.",
      "Billing period: 2026-11-01 to 2026-11-30",
      "4 deployments, 1 signup, 2 star events, 0 payments",
    ]) {
      expect(email.text).toContain(line);
    }
  });

  it("says plainly when there is nothing to report", () => {
    const email = renderNoticeEmail(digestNotice({ ...digest, alerts: [], allowances: [], spend: [] }, links), footer);
    expect(email.text).toContain("No new alerts.");
    expect(email.text).toContain("No connection reports an allowance yet.");
    expect(email.text).toContain("No connection reports spend yet.");
  });
});
