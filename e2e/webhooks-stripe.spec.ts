import { randomUUID } from "node:crypto";

import type { APIRequestContext, APIResponse } from "@playwright/test";

import { signStripeWebhook, STRIPE_SIGNATURE_HEADER, STRIPE_WEBHOOK_TOLERANCE_SECONDS } from "../src/lib/adapters/stripe";
import { expect, ownerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { anonymous } from "./fixtures/share";
import { SIMULATED_WEBHOOK_E2E_SECRET } from "./fixtures/simulated-webhook";
import { storedCopies, tickUntilStored } from "./fixtures/webhook-ticks";

/*
 * Stripe webhooks (#423), end to end against the simulated Stripe provider, which runs the real
 * adapter's `verify` and `parse` with the synthetic secret playwright.config.ts gives the app
 * (#479). A signed `charge.succeeded` for the connected account reaches the timeline once, a repeat
 * of it is acknowledged as a duplicate, an unsigned or stale one is refused, and a test mode event
 * is acknowledged but never stored (decided on #423: test mode connections stay polled). The
 * payment is dated three weeks back, outside the half hour the simulated sync fills, so only the
 * delivery can have put it there.
 *
 * Deliveries are posted from a context with no session, as Stripe sends them. The delivery reaches
 * every workspace that includes the account and the tick is instance-wide, so this spec lives in
 * the `instance-wide` Playwright project (playwright.config.ts).
 */

const DAY_MS = 86_400_000;
const DAYS_BACK = 21;

/** The simulated Stripe account the connection includes: its id is seeded per grant. */
async function connectedAccountId(workspace: TestWorkspace): Promise<string> {
  const { data, error } = await adminClient().from("external_accounts").select("external_id").eq("workspace_id", workspace.id);
  if (error) throw new Error(`Reading the accounts failed (code ${error.code}).`);
  expect(data).toHaveLength(1);
  const [account] = data;
  if (account === undefined) throw new Error("The simulated Stripe connection has no account.");
  return account.external_id;
}

/** A Stripe event as a Connect webhook endpoint receives it, with synthetic personal data Stripe would include. */
function chargeSucceeded(eventId: string, accountId: string, createdSeconds: number, livemode: boolean): string {
  return JSON.stringify({
    id: eventId,
    object: "event",
    account: accountId,
    api_version: "2026-10-28.endive",
    created: createdSeconds,
    data: {
      object: {
        id: `ch_e2e_${randomUUID().replaceAll("-", "")}`,
        object: "charge",
        amount: 4900,
        amount_refunded: 0,
        billing_details: { email: "jane.doe@example.com", name: "Jane Doe" },
        currency: "usd",
        refunded: false,
        status: "succeeded",
      },
    },
    livemode,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "charge.succeeded",
  });
}

/** POSTs `body` to Stripe's app-level URL as Stripe would, signed at `timestampSeconds` unless `signed` is false. */
function postStripeWebhook(
  request: APIRequestContext,
  body: string,
  options: Readonly<{ signed?: boolean; timestampSeconds?: number }> = {},
): Promise<APIResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json; charset=utf-8" };
  if (options.signed !== false) {
    const timestampSeconds = options.timestampSeconds ?? Math.floor(Date.now() / 1000);
    headers[STRIPE_SIGNATURE_HEADER] = signStripeWebhook({ secret: SIMULATED_WEBHOOK_E2E_SECRET, rawBody: body, timestampSeconds });
  }
  return request.post("/api/webhooks/stripe", { data: body, headers });
}

ownerTest.describe("Stripe webhooks", () => {
  ownerTest("a signed payment reaches the timeline once, and repeated, unsigned, stale, or test mode ones do not", async ({ page, baseURL }) => {
    ownerTest.slow();
    const stripe = await anonymous(baseURL);
    const workspace = await createTestWorkspace("Stripe webhooks");
    try {
      await connectSimulated(page, workspace.slug, "Stripe");
      const accountId = await connectedAccountId(workspace);

      const occurredAt = new Date(Date.now() - DAYS_BACK * DAY_MS);
      const day = occurredAt.toISOString().slice(0, 10);
      const createdSeconds = Math.floor(occurredAt.getTime() / 1000);
      const eventId = `evt_e2e_${randomUUID().replaceAll("-", "")}`;
      const body = chargeSucceeded(eventId, accountId, createdSeconds, true);

      const accepted = await postStripeWebhook(stripe, body);
      expect(accepted.status()).toBe(202);
      expect(await accepted.json()).toEqual({ status: "accepted" });

      // Stripe retried the event: a new signature and timestamp, the same event id.
      const repeated = await postStripeWebhook(stripe, body, { timestampSeconds: Math.floor(Date.now() / 1000) + 1 });
      expect(repeated.status()).toBe(200);
      expect(await repeated.json()).toEqual({ status: "duplicate" });

      const unsigned = await postStripeWebhook(stripe, chargeSucceeded(`evt_e2e_${randomUUID().replaceAll("-", "")}`, accountId, createdSeconds, true), {
        signed: false,
      });
      expect(unsigned.status()).toBe(401);
      expect(await unsigned.json()).toEqual({ error: "unauthorized" });

      // Signed one second past the 5 minute tolerance: a captured delivery replayed later.
      const staleSeconds = Math.floor(Date.now() / 1000) - STRIPE_WEBHOOK_TOLERANCE_SECONDS - 1;
      const stale = await postStripeWebhook(stripe, chargeSucceeded(`evt_e2e_${randomUUID().replaceAll("-", "")}`, accountId, createdSeconds, true), {
        timestampSeconds: staleSeconds,
      });
      expect(stale.status()).toBe(401);

      // A test mode event for the same account: acknowledged, so Stripe stops retrying, and dropped.
      const testModeId = `evt_e2e_${randomUUID().replaceAll("-", "")}`;
      const testMode = await postStripeWebhook(stripe, chargeSucceeded(testModeId, accountId, createdSeconds, false));
      expect(testMode.status()).toBe(202);

      // Applied on the next tick, which also runs the connection's first sync. The store prefixes an
      // adapter's dedupe key (the Stripe event id) with the provider.
      await tickUntilStored(page, workspace, `stripe:${eventId}`);
      expect(await storedCopies(workspace, `stripe:${testModeId}`)).toBe(0);

      await page.goto(`/w/${workspace.slug}/timeline?from=${day}&to=${day}&provider=stripe`);
      const events = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      await expect(events.getByRole("heading", { name: "Payment succeeded: $49.00", exact: true })).toHaveCount(1);
      await expect(page.getByText("Jane Doe")).toHaveCount(0);
      if (process.env.PW_PR_EVIDENCE === "1") {
        await page.screenshot({ path: "pr-evidence/after/stripe-webhook-timeline.png", animations: "disabled" });
      }
    } finally {
      await stripe.dispose();
      await deleteTestWorkspace(workspace);
    }
  });
});
