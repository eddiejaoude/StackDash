import { randomInt, randomUUID } from "node:crypto";

import { expect, ownerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import { adminClient, createTestWorkspace, cronSecret, deleteTestWorkspace } from "./fixtures/db";
import { pipelineDeliveryBody, pipelineIid, postGitLabDelivery, SIMULATED_GITLAB_GROUP } from "./fixtures/gitlab-webhook";
import { anonymous } from "./fixtures/share";
import { storedCopies, tickUntilStored } from "./fixtures/webhook-ticks";

/*
 * GitLab project webhooks (#428), end to end against the simulated GitLab provider, which runs the
 * real adapter's `verify` and `parse`: the webhook is set up by hand on the panel, and a pipeline
 * delivery carrying the panel's secret in `X-Gitlab-Token` is accepted, a repeat of its delivery id
 * is a duplicate, a missing or wrong token is refused, and the next job tick puts the pipeline on
 * the timeline. A second delivery of the same pipeline under a new id (as a poll of it would be)
 * is processed and stores nothing new, because it carries the same dedupe key.
 *
 * The project path and pipeline id are new to this run, so only the delivery can have put the
 * event there: the simulated sync makes up its own pipelines. Deliveries are posted from a context
 * with no session, as GitLab sends them. The tick is instance-wide, so this spec lives in the
 * `instance-wide` Playwright project (playwright.config.ts).
 */

ownerTest.describe("GitLab webhooks", () => {
  ownerTest("a pipeline delivery to a webhook set up by hand reaches the timeline once", async ({ page, baseURL }) => {
    ownerTest.slow();
    const gitlab = await anonymous(baseURL);
    const workspace = await createTestWorkspace("GitLab webhooks");
    try {
      await connectSimulated(page, workspace.slug, "GitLab");
      const panel = page.getByRole("region", { name: "Get events as they happen" });
      await panel.getByRole("radio", { name: "Set up by hand" }).check();
      await panel.getByRole("button", { name: "Set up the webhook" }).click();
      const url = await panel.getByRole("textbox", { name: "Webhook address" }).inputValue();
      const secret = await panel.getByRole("textbox", { name: "Webhook secret" }).inputValue();

      const suffix = randomUUID().slice(0, 8);
      const projectPath = `${SIMULATED_GITLAB_GROUP}/hook-${suffix}`;
      const projectId = randomInt(100_000, 1_000_000_000);
      const pipelineId = randomInt(100_000, 1_000_000_000);
      const body = pipelineDeliveryBody({ projectId, projectPath, pipelineId, status: "success" });
      const deliveryId = randomUUID();

      const accepted = await postGitLabDelivery(gitlab, url, secret, body, deliveryId);
      expect(accepted.status()).toBe(202);
      expect(await accepted.json()).toEqual({ status: "accepted" });

      // GitLab retried: the same webhook-id is acknowledged and dropped.
      const repeated = await postGitLabDelivery(gitlab, url, secret, body, deliveryId);
      expect(repeated.status()).toBe(200);
      expect(await repeated.json()).toEqual({ status: "duplicate" });

      for (const token of [null, "not-the-secret", `${secret.slice(0, -1)}x`]) {
        const refused = await postGitLabDelivery(gitlab, url, token, body);
        expect(refused.status()).toBe(401);
        expect(await refused.json()).toEqual({ error: "unauthorized" });
      }

      // Stored under the key a poll of the same pipeline uses, with the provider prefix every stored
      // event carries (adapterEventDedupeKey, src/lib/jobs/ingest.ts).
      const dedupeKey = `gitlab:gitlab.pipeline:${projectId}:${pipelineId}:success`;
      await tickUntilStored(page, workspace, dedupeKey);

      // The same pipeline again under a new delivery id, as a poll would see it. Once its job has run
      // (the delivery is processed), there is still one event.
      const secondId = randomUUID();
      expect((await postGitLabDelivery(gitlab, url, secret, body, secondId)).status()).toBe(202);
      await expect(async () => {
        const response = await page.request.post("/api/jobs/tick", { headers: { Authorization: `Bearer ${cronSecret()}` }, timeout: 120_000 });
        expect(response.status()).toBe(200);
        const { data, error } = await adminClient()
          .from("webhook_deliveries")
          .select("status")
          .eq("provider", "gitlab")
          .eq("delivery_id", secondId);
        if (error) throw new Error(`Reading the delivery failed (code ${error.code}).`);
        expect(data.map((row) => row.status)).toEqual(["processed"]);
      }).toPass({ timeout: 90_000 });
      expect(await storedCopies(workspace, dedupeKey)).toBe(1);

      // Searched by its project path: the simulated sync's own pipelines are in the same window, and
      // the timeline collapses a run of one type into a group, which would hide the title.
      await page.goto(`/w/${workspace.slug}/timeline?provider=gitlab&q=hook-${suffix}`);
      const events = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      await expect(
        events.getByRole("heading", { name: `Pipeline #${pipelineIid(pipelineId)} succeeded on main in ${projectPath}`, exact: true }),
      ).toHaveCount(1);
    } finally {
      await gitlab.dispose();
      await deleteTestWorkspace(workspace);
    }
  });
});
