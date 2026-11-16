import { randomUUID } from "node:crypto";

import { expect, ownerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import { createTestWorkspace, deleteTestWorkspace } from "./fixtures/db";
import { connectedOrganizationId, newPolarSigningSecret, orderPaid, postPolarDelivery, setUpPolarByHand } from "./fixtures/polar-webhook";
import { anonymous } from "./fixtures/share";
import { tickUntilStored } from "./fixtures/webhook-ticks";

/*
 * Polar webhooks (#429), end to end against simulated Polar, which runs the live adapter's
 * Standard Webhooks `verify` and `parse`: an `order.paid` signed with the secret pasted from Polar
 * reaches the timeline once, with the sync's own title and dedupe key, and none of the customer's
 * details. The order is dated three weeks back, outside the half hour the simulated sync fills, so
 * only the delivery can have put it there.
 *
 * Deliveries are posted from a context with no session, as Polar sends them. The tick is
 * instance-wide, so this spec lives in the `instance-wide` Playwright project (playwright.config.ts).
 */

const DAY_MS = 86_400_000;
const DAYS_BACK = 21;

ownerTest.describe("Polar webhooks", () => {
  ownerTest("a signed paid order reaches the timeline once, and its repeat does not", async ({ page, baseURL }) => {
    ownerTest.slow();
    const polar = await anonymous(baseURL);
    const workspace = await createTestWorkspace("Polar webhooks");
    try {
      await connectSimulated(page, workspace.slug, "Polar");
      const organizationId = await connectedOrganizationId(workspace);
      const secret = newPolarSigningSecret();
      const url = await setUpPolarByHand(page, secret);

      // Noon UTC is the same day in London whether it is GMT or BST, so `from` and `to` (London days)
      // always hold the event.
      const day = new Date(Date.now() - DAYS_BACK * DAY_MS).toISOString().slice(0, 10);
      const orderId = randomUUID();
      const body = orderPaid(orderId, organizationId, new Date(`${day}T12:00:00.000Z`));
      const deliveryId = `msg_${randomUUID().replaceAll("-", "")}`;
      expect((await postPolarDelivery(polar, url, body, { secret, deliveryId })).status()).toBe(202);
      expect((await postPolarDelivery(polar, url, body, { secret, deliveryId, timestampSeconds: Math.floor(Date.now() / 1000) + 1 })).status()).toBe(200);

      // Applied on the next tick. The store prefixes the adapter's dedupe key with the provider.
      await tickUntilStored(page, workspace, `polar:order:${orderId}`);

      await page.goto(`/w/${workspace.slug}/timeline?from=${day}&to=${day}&provider=polar`);
      const events = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      await expect(events.getByRole("heading", { name: "Order paid: $49.00", exact: true })).toHaveCount(1);
      await expect(page.getByText("Jane Doe")).toHaveCount(0);
      if (process.env.PW_PR_EVIDENCE === "1") {
        await page.screenshot({ path: "pr-evidence/after/polar-webhook-timeline.png", animations: "disabled", fullPage: true });
      }
    } finally {
      await polar.dispose();
      await deleteTestWorkspace(workspace);
    }
  });
});
