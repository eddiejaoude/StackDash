import { createHmac, randomUUID } from "node:crypto";

import type { APIRequestContext, APIResponse } from "@playwright/test";

import { expect, ownerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import { adminClient, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { anonymous } from "./fixtures/share";
import { SIMULATED_WEBHOOK_E2E_SECRET } from "./fixtures/simulated-webhook";
import { tickUntilConnectionStatus, tickUntilFirstSync, tickUntilStored } from "./fixtures/webhook-ticks";

/*
 * Vercel webhooks (#422), end to end against the simulated Vercel provider, which runs the real
 * adapter's `verify` and `parse` (#479): a delivery signed the way Vercel signs (hex HMAC SHA-1 of
 * the raw body, `x-vercel-signature`) is accepted, a repeat is a duplicate, an unsigned or tampered
 * one is refused, and the next job tick puts the deployment on the timeline. Then an
 * `integration-configuration.removed` delivery asks for a reconnect at once.
 *
 * The deployment id and project name are new to this run, so only the delivery can have put the
 * event there: the simulated sync makes up its own deployments. Deliveries are posted from a
 * context with no session, as Vercel sends them. The tick is instance-wide, so this spec lives in
 * the `instance-wide` Playwright project (playwright.config.ts).
 */

/** POSTs `body` to Vercel's app-level URL, signed as Vercel signs it unless `signature` overrides it. */
function postVercelWebhook(request: APIRequestContext, body: string, signature: string | null = sign(body)): Promise<APIResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (signature !== null) headers["x-vercel-signature"] = signature;
  return request.post("/api/webhooks/vercel", { data: body, headers });
}

function sign(body: string): string {
  return createHmac("sha1", SIMULATED_WEBHOOK_E2E_SECRET).update(body, "utf8").digest("hex");
}

/** The simulated team the connection includes: the account every delivery names. */
async function teamId(workspace: TestWorkspace): Promise<string> {
  const { data, error } = await adminClient().from("external_accounts").select("external_id").eq("workspace_id", workspace.id);
  if (error) throw new Error(`Reading the accounts failed (code ${error.code}).`);
  expect(data).toHaveLength(1);
  const [account] = data;
  if (account === undefined) throw new Error("The simulated Vercel connection has no account.");
  return account.external_id;
}

ownerTest.describe("Vercel webhooks", () => {
  ownerTest("a signed deployment reaches the timeline once, and an uninstall asks for a reconnect", async ({ page, baseURL }) => {
    ownerTest.slow();
    const vercel = await anonymous(baseURL);
    const workspace = await createTestWorkspace("Vercel webhooks");
    try {
      await connectSimulated(page, workspace.slug, "Vercel");
      const connectionPage = page.url();
      const team = await teamId(workspace);

      // The first sync runs before any delivery is posted, so the uninstall below is the last write
      // the spec observes: before #487 was fixed, a sync finishing after it set the connection back
      // to active.
      await tickUntilFirstSync(page, workspace, "vercel");

      const suffix = randomUUID().slice(0, 8);
      const deploymentId = `dpl_e2e${suffix}`;
      const projectName = `webhook-${suffix}`;
      const body = JSON.stringify({
        id: `evt_e2e${suffix}`,
        type: "deployment.succeeded",
        createdAt: Date.now(),
        region: "iad1",
        payload: {
          team: { id: team },
          user: { id: "e2e-user" },
          deployment: { id: deploymentId, name: projectName, url: `${projectName}.vercel.app`, meta: {} },
          links: { deployment: `https://vercel.com/example/${projectName}/${suffix}` },
          target: "production",
          project: { id: `prj_e2e${suffix}` },
        },
      });

      const accepted = await postVercelWebhook(vercel, body);
      expect(accepted.status()).toBe(202);
      expect(await accepted.json()).toEqual({ status: "accepted" });

      // Vercel retried: the envelope id is the same, so it is acknowledged and dropped.
      const repeated = await postVercelWebhook(vercel, body);
      expect(repeated.status()).toBe(200);
      expect(await repeated.json()).toEqual({ status: "duplicate" });

      const unsigned = await postVercelWebhook(vercel, body, null);
      expect(unsigned.status()).toBe(401);
      expect(await unsigned.json()).toEqual({ error: "unauthorized" });

      // The original signature over a body re-sent under a new delivery id.
      const tampered = await postVercelWebhook(vercel, body.replace(`evt_e2e${suffix}`, `evt_e2x${suffix}`), sign(body));
      expect(tampered.status()).toBe(401);

      // Stored under the provider's prefix, the key a poll of the same deployment would use.
      await tickUntilStored(page, workspace, `vercel:${deploymentId}:READY`);
      // Searched by its project name: the simulated sync's own deployments are in the same window,
      // and the timeline collapses a run of one type into a group, which would hide the title.
      await page.goto(`/w/${workspace.slug}/timeline?provider=vercel&q=${projectName}`);
      const events = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      await expect(events.getByRole("heading", { name: `Production deployment of ${projectName} succeeded`, exact: true })).toHaveCount(1);

      const removed = JSON.stringify({
        id: `evt_e2e${suffix}-removed`,
        type: "integration-configuration.removed",
        createdAt: Date.now(),
        region: "iad1",
        payload: { team: { id: team }, user: { id: "e2e-user" }, configuration: { id: `icfg_e2e${suffix}`, projects: [] } },
      });
      // The first sync finished before this uninstall is posted (checked above), and the next
      // simulated sync is not due for SIMULATED_POLL_INTERVAL_SECONDS (60), so no sync runs after
      // the uninstall's job. Before #487 was fixed, one that did set the connection back to active.
      // Keep this order.
      const uninstalled = await postVercelWebhook(vercel, removed);
      expect(uninstalled.status()).toBe(202);
      await tickUntilConnectionStatus(page, workspace, "vercel", "needs_attention");

      await page.goto(connectionPage);
      await expect(page.getByRole("region", { name: "Status" }).getByText("Status: Needs attention")).toBeVisible();
    } finally {
      await vercel.dispose();
      await deleteTestWorkspace(workspace);
    }
  });
});
