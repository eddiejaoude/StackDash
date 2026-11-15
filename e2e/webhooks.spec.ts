import { randomUUID } from "node:crypto";

import type { Page } from "@playwright/test";

import { expect, ownerTest } from "./fixtures/auth";
import { adminClient, CONNECTION_URL, createTestWorkspace, cronSecret, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { postFakeWebhook } from "./fixtures/fake-webhook";
import { anonymous } from "./fixtures/share";

/*
 * Provider webhooks (#28), end to end against the fake provider: a signed delivery is accepted, a
 * repeat of it is acknowledged as a duplicate, an unsigned one is refused, and the next job tick
 * puts the event on the timeline once. The event is dated three weeks back, outside the week the
 * fake provider's sync reports, so only the delivery can have put it there.
 *
 * Deliveries are posted from a context with no session, as a provider sends them, so a change that
 * gated API routes on a session would fail here. The tick and the timeline use the owner's page.
 *
 * A delivery to the app-level URL reaches every workspace that includes the account, and the tick
 * is instance-wide, so this spec lives in the `instance-wide` Playwright project
 * (playwright.config.ts).
 */

const PROVIDER_NAME = "Example provider";
const DAY_MS = 86_400_000;
// Older than FAKE_EVENT_WINDOW_DAYS (7), the furthest back the fake provider's sync reads.
const DAYS_BACK = 21;

/** Connects the fake provider through the catalog and the disclosure page, as a person does. */
async function connectFakeProvider(page: Page, workspace: TestWorkspace): Promise<void> {
  await page.goto(`/w/${workspace.slug}/connections`);
  await page.getByRole("link", { name: `Connect ${PROVIDER_NAME}` }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Connect ${PROVIDER_NAME}`);
  await page.getByRole("checkbox", { name: `I understand StackDash gets full access to my ${PROVIDER_NAME} account` }).check();
  await page.getByRole("button", { name: `Continue to ${PROVIDER_NAME}` }).click();
  await expect(page).toHaveURL(CONNECTION_URL);
}

async function storedCopies(workspace: TestWorkspace, dedupeKey: string): Promise<number | null> {
  const { count, error } = await adminClient()
    .from("activity_events")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspace.id)
    .eq("dedupe_key", dedupeKey);
  if (error) throw new Error(`Reading the events failed (code ${error.code}).`);
  return count;
}

/** Ticks until the delivery's event is stored; other workspaces' jobs may share a tick. */
async function tickUntilStored(page: Page, workspace: TestWorkspace, dedupeKey: string): Promise<void> {
  const authorization = `Bearer ${cronSecret()}`;
  await expect(async () => {
    const response = await page.request.post("/api/jobs/tick", { headers: { Authorization: authorization }, timeout: 120_000 });
    expect(response.status()).toBe(200);
    expect(await storedCopies(workspace, dedupeKey)).toBe(1);
  }).toPass({ timeout: 90_000 });
}

ownerTest.describe("provider webhooks", () => {
  ownerTest("a signed delivery reaches the timeline once, and repeated or unsigned ones do not", async ({ page, baseURL }) => {
    ownerTest.slow();
    // The provider's side: no cookies and no session.
    const provider = await anonymous(baseURL);
    const workspace = await createTestWorkspace("Webhooks");
    try {
      await connectFakeProvider(page, workspace);

      const day = new Date(Date.now() - DAYS_BACK * DAY_MS).toISOString().slice(0, 10);
      const body = JSON.stringify({
        type: "event",
        account: "fake-acct-1",
        event: { typeId: "fake.deploy.succeeded", occurredAt: `${day}T12:00:00.000Z` },
      });
      const deliveryId = `e2e-${randomUUID()}`;

      const accepted = await postFakeWebhook(provider, body, { deliveryId });
      expect(accepted.status()).toBe(202);
      expect(accepted.headers()["cache-control"]).toBe("no-store");
      expect(await accepted.json()).toEqual({ status: "accepted" });

      // The provider retried: acknowledged, and dropped.
      const repeated = await postFakeWebhook(provider, body, { deliveryId });
      expect(repeated.status()).toBe(200);
      expect(await repeated.json()).toEqual({ status: "duplicate" });

      // Anyone can reach the URL; without the signature nothing is stored.
      const unsigned = await postFakeWebhook(provider, body, { deliveryId: `e2e-${randomUUID()}`, signed: false });
      expect(unsigned.status()).toBe(401);
      expect(await unsigned.json()).toEqual({ error: "unauthorized" });

      // Applied on the next tick, which also runs the connection's first sync.
      const dedupeKey = `fake:fake.deploy.succeeded:fake-acct-1:${day}`;
      await tickUntilStored(page, workspace, dedupeKey);

      await page.goto(`/w/${workspace.slug}/timeline?from=${day}&to=${day}`);
      const events = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      await expect(events.getByRole("heading", { name: "Deployment succeeded", exact: true })).toHaveCount(1);
    } finally {
      await provider.dispose();
      await deleteTestWorkspace(workspace);
    }
  });
});
