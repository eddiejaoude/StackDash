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

/**
 * The explanation under "Set up automatically". `writeAccessHeld`: as for `manualChoiceCopy`; the
 * advice to set up by hand to stay read-only is dropped, because setting up by hand would leave the
 * write access held.
 */
export function automaticChoiceCopy(provider: string, setup: ConnectionWebhookSetup, writeAccessHeld = false): string {
  if (!needsWriteAccess(setup)) {
    return `StackDash adds a webhook to your ${provider} team, using the access you already granted. You can see it in ${provider}, and StackDash removes it when you disconnect.`;
  }
  const asks = `StackDash asks ${provider} for write access, because ${provider} has no read-only access that can create a webhook. With write access, StackDash's connection can change your ${provider} account, not only read it.`;
  return writeAccessHeld ? asks : `${asks} If you want StackDash to stay read-only, set up the webhook by hand instead.`;
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
  const plural = perSourceNoun(setup) !== null;
  const webhooks = plural ? "the webhooks" : "the webhook";
  return needsWriteAccess(setup)
    ? `${start} Disconnecting deletes ${webhooks} and ends StackDash's write access; it cannot be given up while ${webhooks} ${plural ? "stay" : "stays"}.`
    : `${start} Disconnecting deletes ${webhooks}.`;
}

/** The source nouns when automatic setup adds one webhook per source (#428), or null. */
function perSourceNoun(setup: ConnectionWebhookSetup | null): Readonly<{ one: string; many: string }> | null {
  return setup?.automatic?.per === "source" ? (setup.sourceNoun ?? null) : null;
}

/** The first line of an automatic webhook's details. */
export function automaticSetUpCopy(provider: string, setup: ConnectionWebhookSetup): string {
  const noun = perSourceNoun(setup);
  if (noun === null) return `Set up automatically. StackDash added this webhook in ${provider} and deletes it when you disconnect.`;
  return `Set up automatically. StackDash added a webhook to each ${provider} ${noun.one} it reads, adds one to each ${noun.one} it starts reading on a later sync, and deletes them when you disconnect.`;
}

/**
 * The heading and empty state of the list of sources (#428): the ones StackDash added a webhook to,
 * and every one a delivery has come from, with its last delivery.
 */
export function sourceListCopy(
  provider: string,
  noun: Readonly<{ one: string; many: string }>,
  mode: "manual" | "automatic",
): Readonly<{ heading: string; empty: string }> {
  const heading = `${noun.many.charAt(0).toUpperCase()}${noun.many.slice(1)}`;
  return mode === "automatic"
    ? {
        heading,
        empty: `StackDash reads no ${provider} ${noun.one} yet, so it has added no webhook. The next sync that finds a ${noun.one} adds one.`,
      }
    : {
        heading,
        empty: `No ${noun.one} has sent a delivery yet. Each ${noun.one} the webhook is added to shows here once it sends one.`,
      };
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

/**
 * The banner for a setup result: a title and one or two sentences, and whether it is an error.
 * `setup` words an automatic webhook per source (#428) in the plural; null where it is unknown.
 */
export function webhookSetupResultCopy(
  result: WebhookSetupResult,
  provider: string,
  setup: ConnectionWebhookSetup | null,
): Readonly<{ tone: "success" | "error"; title: string; body: string }> {
  switch (result) {
    case "automatic": {
      const noun = perSourceNoun(setup);
      // Per source, some may fail: the panel lists them as having no webhook yet, so this says so.
      const added =
        noun === null
          ? `StackDash added a webhook in ${provider}.`
          : `StackDash added a webhook to the ${provider} ${noun.many} it reads. Any it could not reach are listed below and tried again after the next sync.`;
      return {
        tone: "success",
        title: "Webhook set up",
        body: `${added} New events reach the timeline within a minute of ${provider} sending them.`,
      };
    }
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
