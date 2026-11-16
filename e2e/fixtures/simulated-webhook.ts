/*
 * The secret every simulated provider's webhook deliveries are signed with in end-to-end runs
 * (#479). playwright.config.ts gives the app this value as STACKDASH_SIMULATED_WEBHOOK_SECRET,
 * which takes precedence over .env.local, so a run never depends on a local value. A spec signs a
 * delivery with it the way the live provider signs with its own secret. Synthetic and used only by
 * end-to-end runs: not a secret.
 */
export const SIMULATED_WEBHOOK_E2E_SECRET = "e2e-only-simulated-webhook-secret";
