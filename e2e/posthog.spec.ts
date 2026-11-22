import { expect, ownerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { connectSimulated, makeConnectionsNotDue } from "./fixtures/connections";
import { createTestWorkspace, deleteTestWorkspace } from "./fixtures/db";

/*
 * PostHog (#115) end to end. The web server simulates the live providers (playwright.config.ts), so
 * PostHog connects from the catalog through the dev consent screen without a metadata document or a
 * signing key. It never runs the job tick, so it stays in the `chromium` project. The two public
 * routes PostHog itself calls answer 404 here, because CI sets no PostHog variables.
 */

ownerTest.describe("PostHog", () => {
  ownerTest("connects from the catalog with the keyboard and lists the organization", async ({ page }) => {
    const workspace = await createTestWorkspace("PostHog connection");
    try {
      await connectSimulated(page, workspace.slug, "PostHog", {
        catalog: () => expectNoAxeViolations(page),
        connectScreen: async () => {
          // The simulated adapter reuses the real adapter's list of what is collected. Role queries
          // skip the hidden catalog the client router keeps, so each item matches once.
          for (const item of ["Signups per project per day", "When a product nears or reaches its billing limit"]) {
            await expect(page.getByRole("listitem").filter({ hasText: new RegExp(`^${item}$`) })).toBeVisible();
          }
          await expectNoAxeViolations(page);
        },
      });
      await makeConnectionsNotDue(page, workspace.id);
      await expect(page.getByRole("list", { name: "Accounts" }).getByText("Example organization", { exact: true })).toBeVisible();
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  // The 404 body is proven by the route unit tests; here only the status matters.
  ownerTest("answers 404 for the metadata document and JWKS when PostHog is not set up", async ({ request }) => {
    for (const path of ["/oauth/posthog/client-metadata", "/oauth/posthog/jwks"]) {
      expect((await request.get(path)).status()).toBe(404);
    }
  });
});
