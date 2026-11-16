import { randomUUID } from "node:crypto";

import { SIMULATED_SCOPE } from "../src/lib/adapters/simulated/marker";
import { SIMULATED_WEBHOOK_WRITE_SCOPE } from "../src/lib/adapters/simulated/webhooks";
import { STANDARD_WEBHOOK_TOLERANCE_SECONDS } from "../src/lib/webhooks/standard-webhooks";
import { expect, ownerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import { adminClient, CONNECTION_URL, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import {
  connectedOrganizationId,
  newPolarSigningSecret,
  orderPaid,
  polarWebhookAddress,
  postPolarDelivery,
} from "./fixtures/polar-webhook";
import { anonymous } from "./fixtures/share";
import {
  chooseWithKeyboard,
  connectionId,
  disconnect,
  endpointCount,
  EVIDENCE,
  evidence,
  expectAccessiblePanel,
  grantedScopes,
  panel,
  tabTo,
} from "./fixtures/webhook-panel";

/*
 * Polar's webhook (#429), both setup paths, end to end through simulated Polar: its twin carries the
 * live declaration, so the panel shows Polar's own steps and a delivery runs the live Standard
 * Webhooks `verify` and `parse`; automatic setup creates and deletes the webhook in the app's
 * process, and its `webhooks:write` is the simulated write scope.
 *
 * - By hand: no write access asked for, the steps, the address, a delivery refused until Polar's
 *   secret is pasted, then a signed `order.paid` for the connection's organization accepted and
 *   stored once, its retry acknowledged as a duplicate, unsigned, wrongly signed, stale, and
 *   replayed deliveries refused, the last delivery's time, and disconnect with the removal steps.
 * - Automatic: the write access warning before the consent screen, the write access held after it,
 *   the webhook created, and disconnect deleting it.
 *
 * Deliveries are posted from a context with no session, as Polar sends them. No job tick runs, so
 * this spec stays in the `chromium` project; webhooks-polar.spec.ts puts a delivered order on the
 * timeline, and polar/index.test.ts tests the mapping.
 */

const POLAR_AUTOMATIC =
  "StackDash asks Polar for write access, because Polar has no read-only access that can create a webhook. With write access, StackDash's connection can change your Polar account, not only read it. If you want StackDash to stay read-only, set up the webhook by hand instead.";
const POLAR_MANUAL = "StackDash stays read-only. You add the webhook in Polar yourself, using the address below.";
const REMOVAL_STEP =
  "In Polar, open the organization's Settings, then Webhooks, open the endpoint whose URL is StackDash's address, and delete it.";

async function storedDeliveryIds(endpointId: string): Promise<string[]> {
  const { data, error } = await adminClient().from("webhook_deliveries").select("delivery_id").eq("endpoint_id", endpointId);
  if (error) throw new Error(`Reading the deliveries failed (code ${error.code}).`);
  return data.map((row) => row.delivery_id);
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

ownerTest.describe("Polar webhook setup", () => {
  let workspace: TestWorkspace;

  ownerTest.beforeEach(async () => {
    workspace = await createTestWorkspace("Polar webhooks");
  });

  ownerTest.afterEach(async () => {
    await deleteTestWorkspace(workspace);
  });

  ownerTest("by hand: read-only, Polar's steps, its pasted secret, and signed deliveries", async ({ page, baseURL }) => {
    ownerTest.slow();
    if (EVIDENCE) await page.emulateMedia({ reducedMotion: "reduce" });
    const polar = await anonymous(baseURL);
    try {
      await connectSimulated(page, workspace.slug, "Polar");
      const connection = await connectionId(page);
      const organizationId = await connectedOrganizationId(workspace);
      await expect(panel(page).getByRole("radio", { name: "Set up by hand" })).toHaveAccessibleDescription(POLAR_MANUAL);

      await chooseWithKeyboard(page, "Set up by hand");
      await expect(panel(page).getByText(/^Webhook address created\. Add it in Polar with the steps below/)).toBeVisible();
      // Setup by hand never asks Polar for anything: the grant stays read-only.
      await expect(page).toHaveURL(CONNECTION_URL);
      expect(await grantedScopes(connection)).toEqual([SIMULATED_SCOPE]);
      for (const step of [
        "In Polar, pick one organization this connection tracks. A connection takes one webhook, so add it to that organization only: an endpoint in a second organization has its own secret, and StackDash refuses its deliveries.",
        "Open that organization's Settings, then Webhooks, and choose Add Endpoint.",
        "Paste the address below as the URL and leave the format on Raw.",
        "For the secret, choose Generate rather than typing your own.",
        "Select the order.paid, subscription.created, subscription.active, subscription.canceled, subscription.revoked, refund.created, refund.updated events, and create the endpoint.",
        "Copy the endpoint's secret and paste it into the field below.",
      ]) {
        await expect(panel(page).getByRole("listitem").filter({ hasText: step })).toBeVisible();
      }
      await expect(panel(page).getByText(REMOVAL_STEP, { exact: false })).toBeVisible();
      const url = await polarWebhookAddress(page);
      const secret = newPolarSigningSecret();
      const body = orderPaid(randomUUID(), organizationId, new Date());

      // Until Polar's secret is pasted, the endpoint holds one nobody knows.
      expect((await postPolarDelivery(polar, url, body, { secret })).status()).toBe(401);
      expect((await endpointOf(connection)).awaiting_provider_secret).toBe(true);

      const field = panel(page).getByLabel("Signing secret from Polar");
      await tabTo(page, field);
      await page.keyboard.type(secret);
      await page.keyboard.press("Enter");
      await expect(panel(page).getByText("Signing secret saved. Deliveries Polar signs with it are accepted from now on.")).toBeVisible();
      await expect(field).toHaveAccessibleDescription(/^Saved\./);

      const deliveryId = `msg_${randomUUID().replaceAll("-", "")}`;
      const accepted = await postPolarDelivery(polar, url, body, { secret, deliveryId });
      expect(accepted.status()).toBe(202);
      expect(await accepted.json()).toEqual({ status: "accepted" });

      // Polar's retry keeps the webhook-id and is signed again with its own timestamp.
      const retried = await postPolarDelivery(polar, url, body, { secret, deliveryId, timestampSeconds: Math.floor(Date.now() / 1000) + 5 });
      expect(retried.status()).toBe(200);
      expect(await retried.json()).toEqual({ status: "duplicate" });

      const now = Math.floor(Date.now() / 1000);
      for (const [refusal, options] of [
        ["unsigned", { secret: null }],
        ["signed with another secret", { secret: newPolarSigningSecret() }],
        ["stale", { secret, timestampSeconds: now - STANDARD_WEBHOOK_TOLERANCE_SECONDS - 60 }],
        ["replayed under a new webhook-id", { secret, signedId: deliveryId }],
      ] as const) {
        const response = await postPolarDelivery(polar, url, body, options);
        expect(response.status(), refusal).toBe(401);
        expect(await response.json(), refusal).toEqual({ error: "unauthorized" });
      }

      // Stored once: a 202 also means the live parse returned an event for this organization.
      const endpointId = new URL(url).pathname.split("/").at(-1) ?? "";
      expect(await storedDeliveryIds(endpointId)).toEqual([deliveryId]);

      await tabTo(page, panel(page).getByRole("button", { name: "Check for deliveries" }));
      await page.keyboard.press("Enter");
      const lastDelivery = panel(page).getByRole("status").filter({ hasText: "Last delivery:" });
      await expect(lastDelivery.locator("time")).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);
      await expectAccessiblePanel(page);
      await evidence(panel(page), "polar-panel-by-hand");

      await disconnect(
        page,
        /^Stops accepting the webhook you added in Polar\. Remove it there afterwards: In Polar, open the organization's Settings/,
        new RegExp(`Remove the webhook you added in Polar: ${REMOVAL_STEP.replaceAll(".", "\\.")}`),
        "polar-disconnect-by-hand",
      );
      expect(await endpointCount(connection)).toBe(0);
      expect((await postPolarDelivery(polar, url, body, { secret })).status()).toBe(404);
    } finally {
      await polar.dispose();
    }
  });

  ownerTest("automatic: the write access warning before consent, the access held, and the webhook deleted on disconnect", async ({ page, baseURL }) => {
    ownerTest.slow();
    if (EVIDENCE) await page.emulateMedia({ reducedMotion: "reduce" });
    const polar = await anonymous(baseURL);
    try {
      await connectSimulated(page, workspace.slug, "Polar");
      const connection = await connectionId(page);
      await expect(panel(page).getByRole("radio", { name: /Set up automatically/ })).toHaveAccessibleDescription(POLAR_AUTOMATIC);
      await expect(panel(page).getByText("Write access", { exact: true })).toBeVisible();
      expect(await endpointCount(connection)).toBe(0);
      await expectAccessiblePanel(page);
      await evidence(panel(page), "polar-panel-choices");

      await chooseWithKeyboard(page, "Set up automatically");

      // The warning again, with the scope and its reason, before Polar's own consent screen.
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Set up Polar webhooks automatically");
      // Visible only: the connection page the user came from can stay mounted, hidden, behind this one.
      await expect(page.getByText(POLAR_AUTOMATIC).filter({ visible: true })).toBeVisible();
      const writeScope = page.getByRole("listitem").filter({ hasText: SIMULATED_WEBHOOK_WRITE_SCOPE });
      await expect(writeScope.getByText("Full access", { exact: true })).toBeVisible();
      await expect(writeScope.getByText("Why full access: Simulated. Polar has no read-only access that can create a webhook.")).toBeVisible();
      expect(await grantedScopes(connection)).toEqual([SIMULATED_SCOPE]);
      if (EVIDENCE) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({ path: "pr-evidence/after/polar-consent-write-access-warning.png", animations: "disabled", fullPage: true });
      }
      const consent = page.getByRole("checkbox", { name: "I understand StackDash gets full access to my Polar account" });
      await tabTo(page, consent);
      await page.keyboard.press("Space");
      await tabTo(page, page.getByRole("button", { name: "Continue to Polar" }));
      await page.keyboard.press("Enter");

      await expect(page).toHaveURL(CONNECTION_URL);
      await expect(page.getByText("Webhook set up", { exact: true })).toBeVisible();
      await expect(panel(page).getByText(/^Set up automatically\. StackDash added this webhook in Polar/)).toBeVisible();
      await expect(panel(page).getByRole("heading", { name: "Write access StackDash holds in Polar" })).toBeVisible();
      await expect(panel(page).getByLabel("Signing secret from Polar")).toHaveCount(0);
      expect(await grantedScopes(connection)).toEqual([SIMULATED_SCOPE, SIMULATED_WEBHOOK_WRITE_SCOPE]);
      const endpoint = await endpointOf(connection);
      expect(endpoint.setup_mode).toBe("automatic");
      expect(endpoint.provider_webhook_id).toMatch(/^simulated-webhook-/);
      expect(endpoint.awaiting_provider_secret).toBe(false);

      // The secret came from (simulated) Polar and was never shown: a guessed one is refused.
      const url = await polarWebhookAddress(page);
      // Refused before it is parsed, so the organization it names does not matter.
      const body = orderPaid(randomUUID(), randomUUID(), new Date());
      expect((await postPolarDelivery(polar, url, body, { secret: newPolarSigningSecret() })).status()).toBe(401);
      await expectAccessiblePanel(page);
      await evidence(panel(page), "polar-panel-automatic");

      await disconnect(
        page,
        "Deletes the webhook StackDash added in Polar. If that fails, you are told how to do it there.",
        /StackDash deleted its webhook in Polar\./,
        "polar-disconnect-automatic",
      );
      expect(await endpointCount(connection)).toBe(0);
      expect((await postPolarDelivery(polar, url, body, { secret: newPolarSigningSecret() })).status()).toBe(404);
    } finally {
      await polar.dispose();
    }
  });

  ownerTest("the one account needed result says why and what to do", async ({ page }) => {
    if (EVIDENCE) await page.emulateMedia({ reducedMotion: "reduce" });
    await connectSimulated(page, workspace.slug, "Polar");
    await connectionId(page);
    // The page's wording and focus for the `one_account_needed` result, the code the start route
    // sends a refused automatic setup back with. Nothing is refused here: the refusal before the
    // consent (panel action and start route) has no end to end test until #529, because each
    // simulated grant names a new organization, so Polar's twin cannot carry the limit. Until then
    // `setupRefusal` is unit tested (src/lib/connections/webhook-setup.test.ts) and its `automatic`
    // parameter is required, so a caller cannot drop it.
    const url = new URL(page.url());
    url.search = "";
    url.searchParams.set("webhook", "one_account_needed");
    await page.goto(url.toString());
    const banner = page.getByRole("alert").filter({ hasText: "Webhook not set up" });
    await expect(banner).toContainText(
      "Polar adds a webhook to one account at a time, so automatic setup needs this connection to include exactly one account. Under Accounts on this page, include only the account you want events from, then choose automatic setup again. Or set up the webhook by hand in that account.",
    );
    await expect(banner).toBeFocused();
    await expect(panel(page).getByRole("radio", { name: "Set up by hand" })).toBeVisible();
    await expectAccessiblePanel(page);
    await evidence(banner, "polar-automatic-refused-one-organization");
  });
});
