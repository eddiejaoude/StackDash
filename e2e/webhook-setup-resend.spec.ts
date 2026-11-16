import { randomBytes, randomUUID } from "node:crypto";

import type { APIRequestContext, APIResponse, Page } from "@playwright/test";

import { RESEND_WEBHOOK_HEADERS, resendWebhookSignature } from "../src/lib/adapters/resend";
import { SIMULATED_SCOPE } from "../src/lib/adapters/simulated/marker";
import { Secret } from "../src/lib/adapters/types";
import { expect, ownerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import { adminClient, CONNECTION_URL, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { anonymous } from "./fixtures/share";
import {
  chooseWithKeyboard,
  connectionId,
  disconnect,
  endpointCount,
  evidence,
  expectAccessiblePanel,
  grantedScopes,
  panel,
  tabTo,
} from "./fixtures/webhook-panel";

/*
 * Resend's webhook (#427), both setup paths, end to end through simulated Resend: its twin carries
 * the live declaration, so the panel shows Resend's own steps and a delivery runs the live Svix
 * `verify` and `parse`; automatic setup creates and deletes the webhook in the app's process.
 *
 * - By hand: the steps, the address, a delivery refused until Resend's signing secret is pasted,
 *   then a signed `domain.updated` accepted and stored once with the domain event the live `parse`
 *   mapped, its retry acknowledged as a duplicate, unsigned, wrongly signed, stale, and replayed
 *   deliveries refused, the last delivery's time, and disconnect with the removal steps.
 * - Automatic: no new access asked for, the webhook created at once, and disconnect deleting it.
 *
 * Deliveries are posted from a context with no session, as Resend sends them. No job tick runs, so
 * this spec stays in the `chromium` project; a simulated delivery's events name Resend's one team
 * account, which a simulated connection does not have (docs/providers/resend.md, "Webhooks").
 */

const RESEND_AUTOMATIC =
  "StackDash adds a webhook to your Resend team, using the access you already granted. You can see it in Resend, and StackDash removes it when you disconnect.";
const RESEND_MANUAL = "You add the webhook in Resend yourself, using the address below.";
const REMOVAL_STEP = "In Resend, open Webhooks, open the webhook whose endpoint is StackDash's address, and delete it.";
const TOLERANCE_SECONDS = 5 * 60;

/** A Svix signing secret as Resend makes one: `whsec_` and 24 random bytes in base64. */
function newSigningSecret(): string {
  return `whsec_${randomBytes(24).toString("base64")}`;
}

type DeliveryOptions = Partial<{
  // Null sends the delivery unsigned.
  secret: string | null;
  deliveryId: string;
  // The id the signature was made for, when it differs from the one sent (a replay).
  signedId: string;
  timestampSeconds: number;
}>;

/** POSTs `body` to the connection's URL as Resend sends it through Svix. */
function postResendDelivery(request: APIRequestContext, url: string, body: string, options: DeliveryOptions = {}): Promise<APIResponse> {
  const deliveryId = options.deliveryId ?? `msg_${randomUUID().replaceAll("-", "")}`;
  const timestamp = String(options.timestampSeconds ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [RESEND_WEBHOOK_HEADERS.delivery]: deliveryId,
    [RESEND_WEBHOOK_HEADERS.timestamp]: timestamp,
  };
  if (options.secret !== null && options.secret !== undefined) {
    headers[RESEND_WEBHOOK_HEADERS.signature] = resendWebhookSignature(
      new Secret(options.secret),
      options.signedId ?? deliveryId,
      timestamp,
      new TextEncoder().encode(body),
    );
  }
  return request.post(new URL(url).pathname, { headers, data: body });
}

/** A `domain.updated` delivery for a synthetic domain, shaped like the sample on Resend's event page. */
function domainVerified(domainId: string): string {
  return JSON.stringify({
    type: "domain.updated",
    created_at: new Date().toISOString(),
    data: {
      id: domainId,
      name: "e2e.example.com",
      status: "verified",
      created_at: "2026-04-26T20:21:26.347Z",
      region: "us-east-1",
      capabilities: { sending: "enabled", receiving: "disabled" },
      records: [{ record: "DKIM", name: "resend._domainkey", type: "TXT", status: "verified", value: "p=EXAMPLE", ttl: "Auto" }],
    },
  });
}

/** The deliveries stored for an endpoint, as the route recorded them (no tick runs in this project). */
async function storedDeliveries(endpointId: string) {
  const { data, error } = await adminClient().from("webhook_deliveries").select("delivery_id, status, outcome").eq("endpoint_id", endpointId);
  if (error) throw new Error(`Reading the deliveries failed (code ${error.code}).`);
  return data;
}

async function endpointOf(connection: string) {
  const { data, error } = await adminClient()
    .from("webhook_endpoints")
    .select("setup_mode, provider_webhook_id, awaiting_provider_secret")
    .eq("connection_id", connection)
    .single();
  if (error) throw new Error(`Reading the endpoint failed (code ${error.code}).`);
  return data;
}

async function webhookAddress(page: Page): Promise<string> {
  const url = await panel(page).getByRole("textbox", { name: "Webhook address" }).inputValue();
  expect(url).toMatch(/\/api\/webhooks\/resend\/[0-9a-f-]{36}$/);
  return url;
}

ownerTest.describe("Resend webhook setup", () => {
  let workspace: TestWorkspace;

  ownerTest.beforeEach(async () => {
    workspace = await createTestWorkspace("Resend webhooks");
  });

  ownerTest.afterEach(async () => {
    await deleteTestWorkspace(workspace);
  });

  ownerTest("by hand: Resend's steps, its pasted signing secret, and Svix-signed deliveries", async ({ page, baseURL }) => {
    ownerTest.slow();
    const resend = await anonymous(baseURL);
    try {
      await connectSimulated(page, workspace.slug, "Resend");
      const connection = await connectionId(page);
      await expect(panel(page).getByRole("radio", { name: "Set up by hand" })).toHaveAccessibleDescription(RESEND_MANUAL);

      await chooseWithKeyboard(page, "Set up by hand");
      await expect(panel(page).getByText(/^Webhook address created\. Add it in Resend with the steps below/)).toBeVisible();
      expect(await grantedScopes(connection)).toEqual([SIMULATED_SCOPE]);
      for (const step of [
        "In Resend, open Webhooks and choose Add Webhook.",
        "Paste the address below as the endpoint URL, select only the domain.updated event, and add the webhook.",
        "Open the new webhook, copy its signing secret, and paste it into the field below.",
      ]) {
        await expect(panel(page).getByRole("listitem").filter({ hasText: step })).toBeVisible();
      }
      await expect(panel(page).getByText(REMOVAL_STEP, { exact: false })).toBeVisible();
      const url = await webhookAddress(page);
      const secret = newSigningSecret();
      const domainId = randomUUID();
      const body = domainVerified(domainId);

      // Until Resend's secret is pasted, the endpoint holds one nobody knows.
      expect((await postResendDelivery(resend, url, body, { secret })).status()).toBe(401);
      expect((await endpointOf(connection)).awaiting_provider_secret).toBe(true);

      const field = panel(page).getByLabel("Signing secret from Resend");
      await tabTo(page, field);
      await page.keyboard.type(secret);
      await page.keyboard.press("Enter");
      await expect(panel(page).getByText("Signing secret saved. Deliveries Resend signs with it are accepted from now on.")).toBeVisible();
      await expect(field).toHaveAccessibleDescription(/^Saved\./);

      const deliveryId = `msg_${randomUUID().replaceAll("-", "")}`;
      const accepted = await postResendDelivery(resend, url, body, { secret, deliveryId });
      expect(accepted.status()).toBe(202);
      expect(await accepted.json()).toEqual({ status: "accepted" });

      // Resend's retry keeps the svix-id and is signed again with its own timestamp.
      const retried = await postResendDelivery(resend, url, body, { secret, deliveryId, timestampSeconds: Math.floor(Date.now() / 1000) + 5 });
      expect(retried.status()).toBe(200);
      expect(await retried.json()).toEqual({ status: "duplicate" });

      const now = Math.floor(Date.now() / 1000);
      for (const [refusal, options] of [
        ["unsigned", { secret: null }],
        ["signed with another secret", { secret: newSigningSecret() }],
        ["stale", { secret, timestampSeconds: now - TOLERANCE_SECONDS - 60 }],
        ["replayed under a new svix-id", { secret, signedId: deliveryId }],
      ] as const) {
        const response = await postResendDelivery(resend, url, body, options);
        expect(response.status(), refusal).toBe(401);
        expect(await response.json(), refusal).toEqual({ error: "unauthorized" });
      }

      // Stored once, still `received` with the live parse's events: an ignored delivery would be
      // stored `processed` with no outcome, and no tick runs in this project to process it.
      const endpointId = new URL(url).pathname.split("/").at(-1) ?? "";
      const stored = await storedDeliveries(endpointId);
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({
        delivery_id: deliveryId,
        status: "received",
        outcome: {
          kind: "events",
          externalAccountId: "team",
          events: [{ typeId: "resend.domain.verified", dedupeKey: `resend.domain:${domainId}:verified` }],
        },
      });

      await tabTo(page, panel(page).getByRole("button", { name: "Check for deliveries" }));
      await page.keyboard.press("Enter");
      const lastDelivery = panel(page).getByRole("status").filter({ hasText: "Last delivery:" });
      await expect(lastDelivery.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
      await expectAccessiblePanel(page);
      await evidence(panel(page), "resend-panel-by-hand");

      await disconnect(
        page,
        /^Stops accepting the webhook you added in Resend\. Remove it there afterwards: In Resend, open Webhooks/,
        new RegExp(`Remove the webhook you added in Resend: ${REMOVAL_STEP.replaceAll(".", "\\.")}`),
        "resend-disconnect-by-hand",
      );
      expect(await endpointCount(connection)).toBe(0);
      expect((await postResendDelivery(resend, url, body, { secret })).status()).toBe(404);
    } finally {
      await resend.dispose();
    }
  });

  ownerTest("automatic: no new access, the webhook created at once, and deleted on disconnect", async ({ page, baseURL }) => {
    ownerTest.slow();
    const resend = await anonymous(baseURL);
    try {
      await connectSimulated(page, workspace.slug, "Resend");
      const connection = await connectionId(page);
      await expect(panel(page).getByRole("radio", { name: "Set up automatically" })).toHaveAccessibleDescription(RESEND_AUTOMATIC);
      await expect(panel(page).getByText("Write access", { exact: true })).toHaveCount(0);
      await expectAccessiblePanel(page);
      await evidence(panel(page), "resend-panel-choices");

      await chooseWithKeyboard(page, "Set up automatically");
      // No consent screen: the access already granted creates the webhook.
      await expect(page).toHaveURL(CONNECTION_URL);
      await expect(panel(page).getByText(/^StackDash added a webhook in Resend\./)).toBeVisible();
      await expect(panel(page).getByText(/^Set up automatically\. StackDash added this webhook in Resend/)).toBeVisible();
      await expect(panel(page).getByLabel("Signing secret from Resend")).toHaveCount(0);
      expect(await grantedScopes(connection)).toEqual([SIMULATED_SCOPE]);
      const endpoint = await endpointOf(connection);
      expect(endpoint.setup_mode).toBe("automatic");
      expect(endpoint.provider_webhook_id).toMatch(/^simulated-webhook-/);
      expect(endpoint.awaiting_provider_secret).toBe(false);

      // The signing secret came from (simulated) Resend and was never shown: a guessed one is refused.
      const url = await webhookAddress(page);
      const body = domainVerified(randomUUID());
      expect((await postResendDelivery(resend, url, body, { secret: newSigningSecret() })).status()).toBe(401);
      await expectAccessiblePanel(page);
      await evidence(panel(page), "resend-panel-automatic");

      await disconnect(
        page,
        "Deletes the webhook StackDash added in Resend. If that fails, you are told how to do it there.",
        /StackDash deleted its webhook in Resend\./,
        "resend-disconnect-automatic",
      );
      expect(await endpointCount(connection)).toBe(0);
      expect((await postResendDelivery(resend, url, body, { secret: newSigningSecret() })).status()).toBe(404);
    } finally {
      await resend.dispose();
    }
  });
});
