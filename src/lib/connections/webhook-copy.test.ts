import { describe, expect, it } from "vitest";

import type { ConnectionWebhookSetup, FullAccessPermission } from "@/lib/adapters/types";

import {
  automaticChoiceCopy,
  endpointLimitCopy,
  isWebhookSetupResult,
  manualChoiceCopy,
  needsWriteAccess,
  WEBHOOK_ENDPOINTS_PER_WORKSPACE,
  WEBHOOK_SETUP_RESULTS,
  webhookSetupResultCopy,
} from "./webhook-copy";

/*
 * The setup panel's words (#426) as decided on #424, for the two cases the issue gives: automatic
 * setup that needs write access (GitLab) and automatic setup with the access already granted
 * (Resend).
 */

const write: FullAccessPermission = {
  scope: "api",
  access: "full",
  description: "Read and write the API.",
  fullAccessReason: "No read-only scope can create a webhook.",
};

function setup(change: Partial<ConnectionWebhookSetup> & { extra?: readonly FullAccessPermission[] }): ConnectionWebhookSetup {
  const { extra = [], ...rest } = change;
  return {
    secretSource: "stackdash",
    manualSteps: ["Add the webhook."],
    removalSteps: ["Delete the webhook."],
    automatic: { extraPermissions: extra, create: () => Promise.resolve({ webhookId: "hook_1" }), remove: () => Promise.resolve() },
    ...rest,
  };
}

describe("webhook setup copy", () => {
  it("warns about write access before it is asked for, and keeps setup by hand read-only (GitLab)", () => {
    const gitlab = setup({ extra: [write] });
    expect(needsWriteAccess(gitlab)).toBe(true);
    expect(automaticChoiceCopy("GitLab", gitlab)).toBe(
      "StackDash asks GitLab for write access, because GitLab has no read-only access that can create a webhook. With write access, StackDash's connection can change your GitLab account, not only read it. If you want StackDash to stay read-only, set up the webhook by hand instead.",
    );
    expect(manualChoiceCopy("GitLab", gitlab)).toBe(
      "StackDash stays read-only. You add the webhook in GitLab yourself, using the address and secret below.",
    );
  });

  it("says automatic setup uses the access already granted when it needs no new scope (Resend)", () => {
    const resend = setup({ secretSource: "provider" });
    expect(needsWriteAccess(resend)).toBe(false);
    expect(automaticChoiceCopy("Resend", resend)).toBe(
      "StackDash adds a webhook to your Resend team, using the access you already granted. You can see it in Resend, and StackDash removes it when you disconnect.",
    );
    expect(manualChoiceCopy("Resend", resend)).toBe("You add the webhook in Resend yourself, using the address below.");
  });

  it("names the secret under setup by hand whenever StackDash generates it (boundary: no write access)", () => {
    expect(manualChoiceCopy("Render", setup({}))).toBe("You add the webhook in Render yourself, using the address and secret below.");
  });

  it("needs no write access for a provider with setup by hand only (boundary: no automatic setup)", () => {
    const manualOnly: ConnectionWebhookSetup = { secretSource: "provider", manualSteps: ["Add it."], removalSteps: ["Delete it."] };
    expect(needsWriteAccess(manualOnly)).toBe(false);
  });

  it("states the endpoint limit with its number and what to do next", () => {
    expect(endpointLimitCopy("GitLab")).toBe(
      `This workspace already has ${WEBHOOK_ENDPOINTS_PER_WORKSPACE} webhooks, the most one workspace can have. To set one up here, first disconnect a connection whose webhook you no longer need. Until a webhook is set up, StackDash checks GitLab for changes on a schedule.`,
    );
  });

  it.each(WEBHOOK_SETUP_RESULTS)("has a banner for the %s result without a dash", (result) => {
    const copy = webhookSetupResultCopy(result, "GitLab");
    expect(copy.title.length).toBeGreaterThan(0);
    expect(`${copy.title} ${copy.body}`).not.toMatch(/[\u2013\u2014]/);
  });

  it.each([undefined, "", "Automatic", "manual", ["automatic"]])("accepts only a known result from the query (boundary: %j)", (value) => {
    expect(isWebhookSetupResult(value)).toBe(false);
  });
});
