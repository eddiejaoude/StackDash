import { expect, ownerTest } from "./fixtures/auth";
import { adminClient, createTestWorkspace, deleteTestWorkspace } from "./fixtures/db";

/*
 * A real connection while the live providers are simulated (#131): the web server runs with
 * STACKDASH_SIMULATE_PROVIDERS=1 (playwright.config.ts), but whether a connection is simulated is
 * recorded on the connection, so one made with a real app is never labeled "Simulated" and cannot
 * be reconnected through the simulator. It never runs the job tick, so it stays in the `chromium`
 * project beside the other specs; specs that tick live in `instance-wide`.
 */

ownerTest.describe("real connection while simulating", () => {
  ownerTest("never labels a real connection as simulated, and refuses to reconnect it through the simulator", async ({ page }) => {
    const workspace = await createTestWorkspace("Real connection while simulating");
    try {
      // Made before the flag went on: its granted scopes are a real app's, not simulated:read.
      const { data: connection, error } = await adminClient()
        .from("connections")
        .insert({
          workspace_id: workspace.id,
          provider: "vercel",
          status: "active",
          display_name: "Vercel (Real team)",
          poll_interval_seconds: 3600,
        })
        .select("id")
        .single();
      if (error) throw new Error(`Seeding a connection failed (code ${error.code}).`);

      await page.goto(`/w/${workspace.slug}/connections`);
      const row = page
        .getByRole("list", { name: "Connections" })
        .getByRole("listitem")
        .filter({ has: page.getByRole("link", { name: "Vercel (Real team)", exact: true }) });
      await expect(row).toBeVisible();
      await expect(row.getByText("Simulated", { exact: true })).toHaveCount(0);

      await page.goto(`/w/${workspace.slug}/connections/${connection.id}`);
      await expect(page.getByRole("region", { name: "Status" }).getByText("Simulated", { exact: true })).toHaveCount(0);

      await page.goto(`/w/${workspace.slug}/connections/new/vercel?connection=${connection.id}`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reconnect Vercel");
      await expect(
        page.getByText("This connection was made with the real Vercel app. Connect a new simulated one instead."),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue to Vercel" })).toHaveCount(0);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
