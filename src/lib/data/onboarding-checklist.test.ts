import { describe, expect, it } from "vitest";

import { onboardingSteps, type OnboardingReads, type OnboardingSteps } from "./onboarding-checklist";

/*
 * The setup checklist's step rules (#674): what makes each step done, which reads count, and the
 * step a viewer's role cannot read.
 */

const NOTHING: OnboardingReads = {
  connections: [],
  hasDestination: false,
  hasEmailPreference: false,
  hasAssistantKey: false,
  hasPublishedMetric: false,
};

const ALL_TODO: OnboardingSteps = { connect_provider: "todo", alert_destination: "todo", assistant: "todo", badge: "todo" };

describe("onboardingSteps", () => {
  it("marks every step to do in a workspace with nothing set up", () => {
    expect(onboardingSteps(NOTHING)).toEqual(ALL_TODO);
  });

  it("marks every step done once each is set up", () => {
    expect(
      onboardingSteps({
        connections: [{ status: "active" }],
        hasDestination: true,
        hasEmailPreference: true,
        hasAssistantKey: true,
        hasPublishedMetric: true,
      }),
    ).toEqual({ connect_provider: "done", alert_destination: "done", assistant: "done", badge: "done" });
  });

  it.each([
    { case: "only disconnected connections", statuses: ["revoked", "revoked"], expected: "todo" },
    { case: "one disconnected and one pending", statuses: ["revoked", "pending"], expected: "done" },
    { case: "one that needs attention", statuses: ["needs_attention"], expected: "done" },
    { case: "one whose sync failed", statuses: ["failed"], expected: "done" },
  ] as const)("connect a provider with $case is $expected", ({ statuses, expected }) => {
    const steps = onboardingSteps({ ...NOTHING, connections: statuses.map((status) => ({ status })) });
    expect(steps.connect_provider).toBe(expected);
  });

  it.each([
    { case: "an alert channel and no email setting", hasDestination: true, hasEmailPreference: false },
    { case: "the member's email setting and no channel", hasDestination: false, hasEmailPreference: true },
  ])("choose where alerts go is done with $case", ({ hasDestination, hasEmailPreference }) => {
    expect(onboardingSteps({ ...NOTHING, hasDestination, hasEmailPreference }).alert_destination).toBe("done");
  });

  it("leaves the assistant step unknown, not to do, when the role cannot read API keys", () => {
    expect(onboardingSteps({ ...NOTHING, hasAssistantKey: null })).toEqual({ ...ALL_TODO, assistant: "unknown" });
  });
});
