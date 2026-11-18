import { randomUUID } from "node:crypto";

import type { APIRequestContext, APIResponse } from "@playwright/test";

import { signStripeWebhook, STRIPE_SIGNATURE_HEADER, STRIPE_WEBHOOK_TOLERANCE_SECONDS } from "../src/lib/adapters/stripe";
import { expect, ownerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { anonymous } from "./fixtures/share";
import { SIMULATED_WEBHOOK_E2E_SECRET } from "./fixtures/simulated-webhook";
import { storedCopies, tick, tickUntilConnectionStatus, tickUntilFirstSync, tickUntilStored } from "./fixtures/webhook-ticks";

/*
 * Stripe webhooks (#423, #481), end to end against the simulated Stripe provider, which runs the
 * real adapter's `verify` and `parse` with the synthetic secret playwright.config.ts gives the app
 * (#479). Every simulated Stripe grant is a test mode one (its account is "Example Stripe account
 * (test mode)"), so this is the test mode path: a signed test mode `charge.succeeded` for the
 * connected account reaches the timeline once, a repeat of it is acknowledged as a duplicate, an
 * unsigned or stale one is refused, and a live mode event for the same account is acknowledged but
 * never stored, because a live delivery must never reach a test mode connection. Then a live mode
 * uninstall leaves the connection alone and a test mode one asks it to reconnect. The payment is
 * dated three weeks back, outside the half hour the simulated sync fills, so only the delivery can
 * have put it there.
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

/** An `apps.install.deleted` for the account at `createdSeconds`, as Stripe sends one when an account uninstalls the app. */
function installDeleted(eventId: string, accountId: string, createdSeconds: number, livemode: boolean): string {
  return JSON.stringify({
    id: eventId,
    object: "event",
    account: accountId,
    api_version: "2026-10-28.endive",
    created: createdSeconds,
    data: { object: { id: `appinst_e2e_${randomUUID().replaceAll("-", "")}`, object: "apps.install", deleted: true } },
    livemode,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "apps.install.deleted",
  });
}

const newEventId = () => `evt_e2e_${randomUUID().replaceAll("-", "")}`;

ownerTest.describe("Stripe webhooks", () => {
  ownerTest("a signed test mode payment reaches the test mode timeline once, and repeated, unsigned, stale, or live ones do not", async ({ page, baseURL }) => {
    ownerTest.slow();
    const stripe = await anonymous(baseURL);
    const workspace = await createTestWorkspace("Stripe webhooks");
    try {
      await connectSimulated(page, workspace.slug, "Stripe");
      const accountId = await connectedAccountId(workspace);

      // Noon UTC is the same day in London whether it is GMT or BST, so `from` and `to` (London days)
      // always hold the event.
      const day = new Date(Date.now() - DAYS_BACK * DAY_MS).toISOString().slice(0, 10);
      const createdSeconds = Date.parse(`${day}T12:00:00.000Z`) / 1000;
      const eventId = newEventId();
      const body = chargeSucceeded(eventId, accountId, createdSeconds, false);

      const accepted = await postStripeWebhook(stripe, body);
      expect(accepted.status()).toBe(202);
      expect(await accepted.json()).toEqual({ status: "accepted" });

      // Stripe retried the event: a new signature and timestamp, the same event id.
      const repeated = await postStripeWebhook(stripe, body, { timestampSeconds: Math.floor(Date.now() / 1000) + 1 });
      expect(repeated.status()).toBe(200);
      expect(await repeated.json()).toEqual({ status: "duplicate" });

      const unsigned = await postStripeWebhook(stripe, chargeSucceeded(newEventId(), accountId, createdSeconds, false), { signed: false });
      expect(unsigned.status()).toBe(401);
      expect(await unsigned.json()).toEqual({ error: "unauthorized" });

      // Signed one second past the 5 minute tolerance: a captured delivery replayed later.
      const staleSeconds = Math.floor(Date.now() / 1000) - STRIPE_WEBHOOK_TOLERANCE_SECONDS - 1;
      const stale = await postStripeWebhook(stripe, chargeSucceeded(newEventId(), accountId, createdSeconds, false), { timestampSeconds: staleSeconds });
      expect(stale.status()).toBe(401);

      // A live mode event for the same account id: acknowledged, so Stripe stops retrying, and
      // never written to this test mode connection (#481).
      const liveId = newEventId();
      const live = await postStripeWebhook(stripe, chargeSucceeded(liveId, accountId, createdSeconds, true));
      expect(live.status()).toBe(202);

      // Applied on the next tick, which also runs the connection's first sync. The store prefixes an
      // adapter's dedupe key (the Stripe event id) with the provider.
      await tickUntilStored(page, workspace, `stripe:${eventId}`);
      expect(await storedCopies(workspace, `stripe:${liveId}`)).toBe(0);

      await page.goto(`/w/${workspace.slug}/timeline?from=${day}&to=${day}&provider=stripe`);
      const events = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      await expect(events.getByRole("heading", { name: "Payment succeeded: $49.00", exact: true })).toHaveCount(1);
      await expect(page.getByText("Jane Doe")).toHaveCount(0);
      if (process.env.PW_PR_EVIDENCE === "1") {
        // The whole page: the delivered row sits below the activity overview.
        await page.screenshot({ path: "pr-evidence/after/stripe-webhook-timeline.png", animations: "disabled", fullPage: true });
      }
    } finally {
      await stripe.dispose();
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("a live mode uninstall leaves the test mode connection alone, and a test mode uninstall asks it to reconnect", async ({ page, baseURL }) => {
    ownerTest.slow();
    const stripe = await anonymous(baseURL);
    const workspace = await createTestWorkspace("Stripe uninstall");
    try {
      await connectSimulated(page, workspace.slug, "Stripe");
      const accountId = await connectedAccountId(workspace);
      // The first sync runs before the uninstall is posted, so the delivery finds the connection
      // idle, as a real one is between its hourly syncs.
      await tickUntilFirstSync(page, workspace, "stripe");

      const readConnection = async () => {
        const { data, error } = await adminClient().from("connections").select("status, mode, granted_at").eq("workspace_id", workspace.id).eq("provider", "stripe").single();
        if (error) throw new Error(`Reading the connection failed (code ${error.code}).`);
        return data;
      };
      const connected = await readConnection();
      expect(connected).toMatchObject({ status: "active", mode: "test" });
      // Stripe stamps whole seconds, and an uninstall no later than the grant is left to the next
      // sync, so the uninstall goes out once a whole second has passed since the grant.
      const grantedAtMs = Date.parse(connected.granted_at ?? "");
      expect(Number.isNaN(grantedAtMs)).toBe(false);
      await expect.poll(() => Math.floor(Date.now() / 1000) * 1000 > grantedAtMs).toBe(true);
      const removedSeconds = () => Math.floor(Date.now() / 1000);

      // Live mode: accepted, applied by the next tick, and never reaching this test mode connection.
      const liveId = newEventId();
      expect((await postStripeWebhook(stripe, installDeleted(liveId, accountId, removedSeconds(), true))).status()).toBe(202);
      await expect(async () => {
        await tick(page);
        const { data, error } = await adminClient().from("webhook_deliveries").select("status").eq("provider", "stripe").eq("delivery_id", liveId).single();
        if (error) throw new Error(`Reading the delivery failed (code ${error.code}).`);
        expect(data.status).toBe("processed");
      }).toPass({ timeout: 90_000 });
      expect((await readConnection()).status).toBe("active");

      // Test mode: the same account's test mode install removed, which is this connection.
      expect((await postStripeWebhook(stripe, installDeleted(newEventId(), accountId, removedSeconds(), false))).status()).toBe(202);
      await tickUntilConnectionStatus(page, workspace, "stripe", "needs_attention");
    } finally {
      await stripe.dispose();
      await deleteTestWorkspace(workspace);
    }
  });
});
