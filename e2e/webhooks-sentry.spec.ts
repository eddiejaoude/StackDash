import { randomInt, randomUUID } from "node:crypto";

import type { APIRequestContext, APIResponse } from "@playwright/test";

import { SENTRY_WEBHOOK_HEADERS, sentryWebhookSignature } from "../src/lib/adapters/sentry";
import { Secret } from "../src/lib/adapters/types";
import { expect, ownerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import { adminClient, CONNECTION_URL, createTestWorkspace, deleteTestWorkspace, type TestWorkspace } from "./fixtures/db";
import { anonymous } from "./fixtures/share";
import { SIMULATED_WEBHOOK_E2E_SECRET } from "./fixtures/simulated-webhook";
import { tickUntilConnectionStatus, tickUntilFirstSync, tickUntilStored } from "./fixtures/webhook-ticks";

/*
 * Sentry webhooks (#421), end to end against simulated Sentry, which runs the real adapter's
 * `verify` and `parse` with the simulated secret (#479).
 * - A signed `issue.created` delivery for one of the connection's projects is accepted, a repeat
 *   of its Request-ID is acknowledged as a duplicate, an unsigned one is refused, and the next tick
 *   puts "New issue" on the timeline once. The issue is dated three weeks back, outside the half
 *   hour simulated Sentry's sync backfills, so only the delivery can have put it there.
 * - A signed `installation.deleted` naming the connection's installation (a simulated grant's is
 *   its seed, #480) marks the connection as needing attention on the next tick.
 *
 * Deliveries are posted from a context with no session, as Sentry sends them. The tick is
 * instance-wide, so this spec lives in the `instance-wide` Playwright project (playwright.config.ts).
 */

const DAY_MS = 86_400_000;
const DAYS_BACK = 21;

/** The external id of the connection's simulated `web` project. */
async function webProjectId(workspace: TestWorkspace): Promise<string> {
  const { data, error } = await adminClient()
    .from("external_accounts")
    .select("external_id")
    .eq("workspace_id", workspace.id)
    .eq("display_name", "web")
    .single();
  if (error) throw new Error(`Reading the Sentry projects failed (code ${error.code}).`);
  return data.external_id;
}

/**
 * POSTs `body` to Sentry's app-level URL as Sentry would: the resource, the current timestamp, the
 * Request-ID, and the signature over the raw body, unless `signed` is false.
 */
function postSentryWebhook(
  request: APIRequestContext,
  body: string,
  options: Readonly<{ requestId: string; resource: "issue" | "installation"; signed?: boolean }>,
): Promise<APIResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [SENTRY_WEBHOOK_HEADERS.delivery]: options.requestId,
    [SENTRY_WEBHOOK_HEADERS.resource]: options.resource,
    [SENTRY_WEBHOOK_HEADERS.timestamp]: String(Math.floor(Date.now() / 1000)),
  };
  if (options.signed !== false) {
    headers[SENTRY_WEBHOOK_HEADERS.signature] = sentryWebhookSignature(new Secret(SIMULATED_WEBHOOK_E2E_SECRET), body);
  }
  return request.post("/api/webhooks/sentry", { headers, data: body });
}

ownerTest.describe("Sentry webhooks", () => {
  ownerTest("a signed issue.created delivery puts the new issue on the timeline once", async ({ page, baseURL }) => {
    ownerTest.slow();
    const sentry = await anonymous(baseURL);
    const workspace = await createTestWorkspace("Sentry webhooks");
    try {
      await connectSimulated(page, workspace.slug, "Sentry");
      const projectId = await webProjectId(workspace);

      const day = new Date(Date.now() - DAYS_BACK * DAY_MS).toISOString().slice(0, 10);
      // Shorter than the simulated issues' ids, which start with the project id, so never one of them.
      const issueId = String(randomInt(100_000, 999_999));
      const shortId = `WEB-E2E${issueId}`;
      const body = JSON.stringify({
        action: "created",
        installation: { uuid: randomUUID() },
        data: {
          issue: {
            id: issueId,
            shortId,
            title: "Synthetic e2e error",
            culprit: "e2e",
            permalink: null,
            level: "error",
            status: "unresolved",
            substatus: "new",
            project: { id: projectId, name: "web", slug: "web" },
            firstSeen: `${day}T12:00:00.000000+00:00`,
            lastSeen: `${day}T12:00:00.000000+00:00`,
          },
        },
        actor: { type: "application", id: "sentry", name: "Sentry" },
      });
      const requestId = randomUUID().replaceAll("-", "");

      const accepted = await postSentryWebhook(sentry, body, { requestId, resource: "issue" });
      expect(accepted.status()).toBe(202);
      expect(await accepted.json()).toEqual({ status: "accepted" });

      const repeated = await postSentryWebhook(sentry, body, { requestId, resource: "issue" });
      expect(repeated.status()).toBe(200);
      expect(await repeated.json()).toEqual({ status: "duplicate" });

      const unsigned = await postSentryWebhook(sentry, body, { requestId: randomUUID().replaceAll("-", ""), resource: "issue", signed: false });
      expect(unsigned.status()).toBe(401);
      expect(await unsigned.json()).toEqual({ error: "unauthorized" });

      await tickUntilStored(page, workspace, `sentry:sentry.issue.created:${issueId}`);

      await page.goto(`/w/${workspace.slug}/timeline?from=${day}&to=${day}`);
      const events = page.getByRole("region", { name: "Events", exact: true }).getByRole("listitem");
      await expect(events.filter({ hasText: `New issue ${shortId}` })).toHaveCount(1);
      await expect(page.getByText("Synthetic e2e error")).toHaveCount(0);
    } finally {
      await sentry.dispose();
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("a signed installation.deleted delivery marks the connection as needing attention", async ({ page, baseURL }) => {
    ownerTest.slow();
    const sentry = await anonymous(baseURL);
    const workspace = await createTestWorkspace("Sentry uninstall");
    try {
      await connectSimulated(page, workspace.slug, "Sentry");
      const connectionPage = page.url();
      expect(connectionPage).toMatch(CONNECTION_URL);

      const readConnection = async () => {
        const { data, error } = await adminClient()
          .from("connections")
          .select("status, external_installation_id, granted_at")
          .eq("workspace_id", workspace.id)
          .eq("provider", "sentry")
          .single();
        if (error) throw new Error(`Reading the connection failed (code ${error.code}).`);
        return data;
      };

      // The first sync runs before the uninstall is posted, so the delivery finds the connection
      // idle, as a real one is between its hourly syncs, and the uninstall is the last write the
      // spec observes. Before #487 was fixed, a sync already running when the uninstall was applied
      // wrote the connection back to active as it finished.
      await tickUntilFirstSync(page, workspace, "sentry");

      const connected = await readConnection();
      expect(connected.status).toBe("active");
      // Recorded when the grant completed: the simulated grant's seed.
      expect(connected.external_installation_id).toMatch(/^[0-9a-f]{8}$/);
      const installationId = connected.external_installation_id ?? "";
      // Sentry stamps whole seconds, and an uninstall sent no later than the grant is left to the
      // next sync, so the delivery goes out once a whole second has passed since the grant.
      const grantedAtMs = Date.parse(connected.granted_at ?? "");
      expect(Number.isNaN(grantedAtMs)).toBe(false);
      await expect.poll(() => Math.floor(Date.now() / 1000) * 1000 > grantedAtMs).toBe(true);

      const body = JSON.stringify({
        action: "deleted",
        installation: { uuid: installationId },
        data: { installation: { status: "installed", organization: { slug: "e2e-org" }, uuid: installationId } },
        actor: { type: "user", id: 1, name: "Synthetic e2e user" },
      });
      const accepted = await postSentryWebhook(sentry, body, { requestId: randomUUID().replaceAll("-", ""), resource: "installation" });
      expect(accepted.status()).toBe(202);
      expect(await accepted.json()).toEqual({ status: "accepted" });

      await tickUntilConnectionStatus(page, workspace, "sentry", "needs_attention");

      await page.goto(connectionPage);
      await expect(page.getByRole("region", { name: "Status" }).getByText("Status: Needs attention")).toBeVisible();
    } finally {
      await sentry.dispose();
      await deleteTestWorkspace(workspace);
    }
  });
});
