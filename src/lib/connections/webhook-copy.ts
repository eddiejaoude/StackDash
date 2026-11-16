import type { ConnectionWebhookSetup } from "@/lib/adapters/types";

/*
 * The webhook setup panel's words (#426), as decided on #424, with the product's current name in
 * place of "DevMacro". Pure, so the panel, the connect screen, and the tests read one copy.
 */

export const WEBHOOK_PANEL_HEADING = "Get events as they happen";

/**
 * Webhook endpoints one workspace may hold (#426). Kept in step with webhook_endpoints_enforce_limit
 * (supabase/migrations/20261116120000_webhook_setup.sql), which refuses the next one, so concurrent
 * setups cannot pass it. The number is why: every endpoint may queue
 * WEBHOOK_ENDPOINT_DELIVERIES_PER_MINUTE (50) deliveries a minute, the instance applies
 * WEBHOOK_TICK_CLAIM_LIMIT (50) a minute, oldest first across every workspace, so a workspace with
 * N busy endpoints can put up to N minutes of backlog ahead of everyone else's deliveries each
 * minute. Five is one endpoint for each provider that needs a user-created webhook (#424: Resend,
 * GitLab, Polar, Better Stack, Render).
 */
export const WEBHOOK_ENDPOINTS_PER_WORKSPACE = 5;

/** True when automatic setup needs a scope that can change the account. */
export function needsWriteAccess(setup: ConnectionWebhookSetup): boolean {
  return (setup.automatic?.extraPermissions.length ?? 0) > 0;
}

/** The explanation under "Set up automatically". */
export function automaticChoiceCopy(provider: string, setup: ConnectionWebhookSetup): string {
  return needsWriteAccess(setup)
    ? `StackDash asks ${provider} for write access, because ${provider} has no read-only access that can create a webhook. With write access, StackDash's connection can change your ${provider} account, not only read it. If you want StackDash to stay read-only, set up the webhook by hand instead.`
    : `StackDash adds a webhook to your ${provider} team, using the access you already granted. You can see it in ${provider}, and StackDash removes it when you disconnect.`;
}

/**
 * The explanation under "Set up by hand". `writeAccessHeld`: the grant still holds automatic
 * setup's write access without an automatic webhook (setup failed after the consent), so the
 * read-only claim would be false until a reconnect gives the access up.
 */
export function manualChoiceCopy(provider: string, setup: ConnectionWebhookSetup, writeAccessHeld = false): string {
  const using = setup.secretSource === "stackdash" ? "using the address and secret below" : "using the address below";
  const addIt = `You add the webhook in ${provider} yourself, ${using}.`;
  return needsWriteAccess(setup) && !writeAccessHeld ? `StackDash stays read-only. ${addIt}` : addIt;
}

export function pollingCopy(provider: string): string {
  return `Until a webhook is set up, StackDash checks ${provider} for changes on a schedule.`;
}

export function endpointLimitCopy(provider: string): string {
  return `This workspace already has ${WEBHOOK_ENDPOINTS_PER_WORKSPACE} webhooks, the most one workspace can have. To set one up here, first disconnect a connection whose webhook you no longer need. ${pollingCopy(provider)}`;
}

/** Write access left from an automatic setup that did not finish, and how to give it up. */
export function leftoverWriteAccessCopy(provider: string): string {
  return `StackDash still holds write access from automatic setup, but no webhook uses it. Reconnect ${provider} to return to read-only access.`;
}

/** How to move from automatic setup to setup by hand, shown on every automatic webhook. */
export function switchToManualCopy(provider: string, setup: ConnectionWebhookSetup): string {
  const start = `To set up the webhook by hand instead, disconnect ${provider}, reconnect it, and choose setup by hand.`;
  return needsWriteAccess(setup)
    ? `${start} Disconnecting deletes the webhook and ends StackDash's write access; it cannot be given up while the webhook stays.`
    : `${start} Disconnecting deletes the webhook.`;
}

/**
 * What became of automatic setup after the write-access consent, carried to the connection page
 * as `?webhook=<result>` (and `ref` for `failed`). Only these fixed codes travel.
 */
export const WEBHOOK_SETUP_RESULTS = ["automatic", "limit_reached", "already_set_up", "write_access_missing", "not_configured", "failed"] as const;
export type WebhookSetupResult = (typeof WEBHOOK_SETUP_RESULTS)[number];

export function isWebhookSetupResult(value: unknown): value is WebhookSetupResult {
  return WEBHOOK_SETUP_RESULTS.some((result) => result === value);
}

/** The banner for a setup result: a title and one or two sentences, and whether it is an error. */
export function webhookSetupResultCopy(result: WebhookSetupResult, provider: string): Readonly<{ tone: "success" | "error"; title: string; body: string }> {
  switch (result) {
    case "automatic":
      return {
        tone: "success",
        title: "Webhook set up",
        body: `StackDash added a webhook in ${provider}. New events reach the timeline within a minute of ${provider} sending them.`,
      };
    case "limit_reached":
      return { tone: "error", title: "Webhook not set up", body: endpointLimitCopy(provider) };
    case "already_set_up":
      return { tone: "success", title: "Webhook already set up", body: "This connection already has a webhook. Its details are below." };
    case "write_access_missing":
      return {
        tone: "error",
        title: "Webhook not set up",
        body: `${provider} did not grant the write access a webhook needs. Choose automatic setup again and approve it, or set up the webhook by hand.`,
      };
    case "not_configured":
      return {
        tone: "error",
        title: "Webhook not set up",
        body: `${provider} is no longer set up on this instance, so StackDash could not add the webhook. Set it up by hand, or ask the instance's operator.`,
      };
    case "failed":
      return {
        tone: "error",
        title: "Webhook not set up",
        body: `StackDash could not add the webhook in ${provider}. Try again in a moment, or set up the webhook by hand.`,
      };
  }
}
