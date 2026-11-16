import { createHmac, randomUUID } from "node:crypto";

import type { APIRequestContext, APIResponse } from "@playwright/test";

import { expect, ownerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import { adminClient, createTestWorkspace, cronSecret, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { anonymous } from "./fixtures/share";
import { SIMULATED_WEBHOOK_E2E_SECRET } from "./fixtures/simulated-webhook";
import { tickUntilStored } from "./fixtures/webhook-ticks";

/*
 * GitHub webhooks (#62), end to end against the simulated GitHub provider, which carries the real
 * adapter's `verify` and `parse` (#479): a delivery signed the way GitHub signs one
 * (`X-Hub-Signature-256`, an HMAC SHA-256 of the raw body) is accepted, its repeat is a duplicate,
 * an unsigned or wrongly signed one is refused, and the next tick puts the merged pull request on
 * the timeline once. The merge is dated three weeks back, outside the 30 minutes a simulated sync
 * reads, so only the delivery can have put it there. Then an `installation` `deleted` delivery
 * marks the connection as needing a reconnect at once.
 *
 * The signature is computed here with node:crypto, not with the adapter's own helper, so the spec
 * checks the adapter against GitHub's scheme rather than against itself. Deliveries are posted
 * from a context with no session, as GitHub sends them. The tick is instance-wide, so this spec
 * lives in the `instance-wide` Playwright project (playwright.config.ts).
 */

const DAY_MS = 86_400_000;
const DAYS_BACK = 21;

/** Plays GitHub's side: the delivery id, the event name, and the signature over the raw body. */
function postGitHubWebhook(
  request: APIRequestContext,
  event: string,
  body: string,
  options: Readonly<{ deliveryId?: string; signature?: string | null }> = {},
): Promise<APIResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "GitHub-Hookshot/e2e",
    "X-GitHub-Event": event,
    "X-GitHub-Delivery": options.deliveryId ?? randomUUID(),
  };
  const signature =
    options.signature === undefined
      ? `sha256=${createHmac("sha256", SIMULATED_WEBHOOK_E2E_SECRET).update(body, "utf8").digest("hex")}`
      : options.signature;
  if (signature !== null) headers["X-Hub-Signature-256"] = signature;
  return request.post("/api/webhooks/github", { data: body, headers });
}

/** The simulated GitHub account the workspace included: a numeric id, like a real account's. */
async function connectedAccountId(workspace: TestWorkspace): Promise<number> {
  const { data, error } = await adminClient()
    .from("external_accounts")
    .select("external_id")
    .eq("workspace_id", workspace.id)
    .limit(2);
  if (error) throw new Error(`Reading the accounts failed (code ${error.code}).`);
  expect(data).toHaveLength(1);
  const externalId = data[0]?.external_id ?? "";
  expect(externalId).toMatch(/^\d+$/);
  return Number(externalId);
}

async function connectionStatus(workspace: TestWorkspace): Promise<string | null> {
  const { data, error } = await adminClient().from("connections").select("status").eq("workspace_id", workspace.id).limit(1);
  if (error) throw new Error(`Reading the connection failed (code ${error.code}).`);
  return data[0]?.status ?? null;
}

ownerTest.describe("GitHub webhooks", () => {
  ownerTest("a signed delivery puts a merged pull request on the timeline once, and an uninstall asks for a reconnect", async ({ page, baseURL }) => {
    ownerTest.slow();
    const github = await anonymous(baseURL);
    const workspace = await createTestWorkspace("GitHub webhooks");
    try {
      await connectSimulated(page, workspace.slug, "GitHub", {
        connectScreen: async () => {
          // What the webhooks bring is disclosed before connecting.
          const data = page.getByRole("region", { name: "Data collected" });
          await expect(data.getByText(/^Pull requests merged, issues opened, releases published, and new stars/)).toBeVisible();
        },
      });
      const connectionUrl = page.url();
      const accountId = await connectedAccountId(workspace);

      const day = new Date(Date.now() - DAYS_BACK * DAY_MS).toISOString().slice(0, 10);
      const repository = {
        id: 7_100_001,
        name: "e2e-repo",
        full_name: "example-org/e2e-repo",
        private: true,
        html_url: "https://github.com/example-org/e2e-repo",
        owner: { login: "example-org", id: accountId, type: "Organization" },
      };
      const body = JSON.stringify({
        action: "closed",
        number: 4242,
        pull_request: {
          number: 4242,
          state: "closed",
          title: "Synthetic title StackDash never stores",
          merged: true,
          merged_at: `${day}T12:00:00Z`,
          updated_at: `${day}T12:00:05Z`,
          html_url: "https://github.com/example-org/e2e-repo/pull/4242",
        },
        repository,
        installation: { id: 1 },
        sender: { login: "e2e-contributor", id: 8_100_001 },
      });
      const deliveryId = randomUUID();

      const accepted = await postGitHubWebhook(github, "pull_request", body, { deliveryId });
      expect(accepted.status()).toBe(202);
      expect(accepted.headers()["cache-control"]).toBe("no-store");
      expect(await accepted.json()).toEqual({ status: "accepted" });

      // GitHub redelivered it: the same delivery id is acknowledged and dropped.
      const repeated = await postGitHubWebhook(github, "pull_request", body, { deliveryId });
      expect(repeated.status()).toBe(200);
      expect(await repeated.json()).toEqual({ status: "duplicate" });

      // Anyone can reach the URL: without GitHub's signature, or with a wrong one, nothing is stored.
      const unsigned = await postGitHubWebhook(github, "pull_request", body, { signature: null });
      expect(unsigned.status()).toBe(401);
      expect(await unsigned.json()).toEqual({ error: "unauthorized" });
      const forged = await postGitHubWebhook(github, "pull_request", body, { signature: `sha256=${"0".repeat(64)}` });
      expect(forged.status()).toBe(401);

      // Stored under the provider's prefix (`adapterEventDedupeKey`), as a sync of the same merge would be.
      const dedupeKey = `github:github.pull_request.merged:${repository.id}:4242`;
      await tickUntilStored(page, workspace, dedupeKey);

      await page.goto(`/w/${workspace.slug}/timeline?from=${day}&to=${day}`);
      const events = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      await expect(events.getByRole("heading", { name: "Pull request #4242 merged in example-org/e2e-repo", exact: true })).toHaveCount(1);
      await expect(page.getByText("Synthetic title StackDash never stores")).toHaveCount(0);

      // The app was uninstalled from the account: the connection asks for a reconnect at once.
      const uninstalled = await postGitHubWebhook(
        github,
        "installation",
        JSON.stringify({
          action: "deleted",
          installation: { id: 1, account: { login: "example-org", id: accountId, type: "Organization" }, suspended_at: null },
          sender: { login: "e2e-owner", id: 8_500_001 },
        }),
      );
      expect(uninstalled.status()).toBe(202);
      const authorization = `Bearer ${cronSecret()}`;
      await expect(async () => {
        const response = await page.request.post("/api/jobs/tick", { headers: { Authorization: authorization }, timeout: 120_000 });
        expect(response.status()).toBe(200);
        expect(await connectionStatus(workspace)).toBe("needs_attention");
      }).toPass({ timeout: 90_000 });
      await page.goto(connectionUrl);
      await expect(page.getByRole("region", { name: "Status" }).getByText("Status: Needs attention")).toBeVisible();
    } finally {
      await github.dispose();
      await deleteTestWorkspace(workspace);
    }
  });
});
