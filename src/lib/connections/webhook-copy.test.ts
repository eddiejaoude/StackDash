import { describe, expect, it } from "vitest";

import { Secret, type ConnectionWebhookSetup, type FullAccessPermission } from "@/lib/adapters/types";

import {
  automaticChoiceCopy,
  endpointLimitCopy,
  leftoverWriteAccessCopy,
  isWebhookSetupResult,
  manualChoiceCopy,
  needsWriteAccess,
  switchToManualCopy,
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

const steps = { manualSteps: ["Add the webhook."], removalSteps: ["Delete the webhook."] };
const remove = () => Promise.resolve();

/** Automatic setup with StackDash's secret, needing `extra` scopes. */
function stackdashSetup(extra: readonly FullAccessPermission[]): ConnectionWebhookSetup {
  return { ...steps, secretSource: "stackdash", automatic: { extraPermissions: extra, create: () => Promise.resolve({ webhookId: "hook_1" }), remove } };
}

/** Automatic setup with the access already granted, the provider making the secret (Resend). */
function providerSetup(): ConnectionWebhookSetup {
  return {
    ...steps,
    secretSource: "provider",
    automatic: { extraPermissions: [], create: () => Promise.resolve({ webhookId: "hook_1", secret: new Secret("whsec_test") }), remove },
  };
}

describe("webhook setup copy", () => {
  it("warns about write access before it is asked for, and keeps setup by hand read-only (GitLab)", () => {
    const gitlab = stackdashSetup([write]);
    expect(needsWriteAccess(gitlab)).toBe(true);
    expect(automaticChoiceCopy("GitLab", gitlab)).toBe(
      "StackDash asks GitLab for write access, because GitLab has no read-only access that can create a webhook. With write access, StackDash's connection can change your GitLab account, not only read it. If you want StackDash to stay read-only, set up the webhook by hand instead.",
    );
    expect(manualChoiceCopy("GitLab", gitlab)).toBe(
      "StackDash stays read-only. You add the webhook in GitLab yourself, using the address and secret below.",
    );
  });

  it("says automatic setup uses the access already granted when it needs no new scope (Resend)", () => {
    const resend = providerSetup();
    expect(needsWriteAccess(resend)).toBe(false);
    expect(automaticChoiceCopy("Resend", resend)).toBe(
      "StackDash adds a webhook to your Resend team, using the access you already granted. You can see it in Resend, and StackDash removes it when you disconnect.",
    );
    expect(manualChoiceCopy("Resend", resend)).toBe("You add the webhook in Resend yourself, using the address below.");
  });

  it("names the secret under setup by hand whenever StackDash generates it (boundary: no write access)", () => {
    expect(manualChoiceCopy("Render", stackdashSetup([]))).toBe("You add the webhook in Render yourself, using the address and secret below.");
  });

  it("drops the read-only claim while write access is held without an automatic webhook, and says how to give it up", () => {
    const gitlab = stackdashSetup([write]);
    expect(manualChoiceCopy("GitLab", gitlab, true)).toBe("You add the webhook in GitLab yourself, using the address and secret below.");
    expect(automaticChoiceCopy("GitLab", gitlab, true)).toBe(
      "StackDash asks GitLab for write access, because GitLab has no read-only access that can create a webhook. With write access, StackDash's connection can change your GitLab account, not only read it.",
    );
    expect(leftoverWriteAccessCopy("GitLab")).toBe(
      "StackDash still holds write access from automatic setup, but no webhook uses it. Reconnect GitLab to return to read-only access.",
    );
  });

  it("says how to switch to setup by hand for every automatic webhook, naming write access only where it is held", () => {
    expect(switchToManualCopy("GitLab", stackdashSetup([write]))).toBe(
      "To set up the webhook by hand instead, disconnect GitLab, reconnect it, and choose setup by hand. Disconnecting deletes the webhook and ends StackDash's write access; it cannot be given up while the webhook stays.",
    );
    expect(switchToManualCopy("Resend", providerSetup())).toBe(
      "To set up the webhook by hand instead, disconnect Resend, reconnect it, and choose setup by hand. Disconnecting deletes the webhook.",
    );
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

  it("says why automatic setup needs one account and what to do, before any write access is asked for (Polar)", () => {
    expect(webhookSetupResultCopy("one_account_needed", "Polar")).toEqual({
      tone: "error",
      title: "Webhook not set up",
      body: "Polar adds a webhook to one account at a time, so automatic setup needs this connection to include exactly one account. Under Accounts on this page, include only the account you want events from, then choose automatic setup again. Or set up the webhook by hand in that account.",
    });
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
