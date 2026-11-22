import { expect, ownerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { connectSimulated, makeConnectionsNotDue } from "./fixtures/connections";
import { createTestWorkspace, deleteTestWorkspace } from "./fixtures/db";

/*
 * GitLab (#112) in the connection catalog and through the connect flow. The web server simulates
 * the live providers (playwright.config.ts), so GitLab connects through the dev consent route with
 * no OAuth application registered. It never runs the job tick, so it stays in the `chromium`
 * project; syncing simulated GitLab data is covered by the simulator's unit tests.
 */

ownerTest.describe("GitLab connection", () => {
  ownerTest("is offered in the catalog, says what it collects before connecting, and connects by keyboard", async ({ page }) => {
    const workspace = await createTestWorkspace("GitLab connection");
    try {
      await connectSimulated(page, workspace.slug, "GitLab", {
        catalog: () => expectNoAxeViolations(page),
        connectScreen: async () => {
          const permissions = page.getByRole("region", { name: "Permissions GitLab will ask you to grant" });
          await expect(permissions.getByText(/^Simulated\. StackDash makes up example GitLab data/)).toBeVisible();
          const data = page.getByRole("region", { name: "Data collected" });
          for (const item of [
            "Compute minutes used this month, per namespace and per project",
            "Monthly compute minutes included in your plan (estimated from the plan)",
            "Pipelines that succeeded or failed",
            "Deployments per environment",
            "Merged merge requests (numbers only, never titles or authors)",
          ]) {
            await expect(data.getByText(item, { exact: true })).toBeVisible();
          }
          await expectNoAxeViolations(page);
        },
      });
      await makeConnectionsNotDue(page, workspace.id);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("GitLab (example-group)");
      await expectNoAxeViolations(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
