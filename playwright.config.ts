import { defineConfig, devices } from "@playwright/test";

// E2E_PORT lets parallel local runs (and agents) avoid each other and the default dev port.
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.results",
  // Mints signed-in storage states for the synthetic e2e users against local Supabase (no GitHub).
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI
    ? [["github"], ["html", { open: "never", outputFolder: "playwright-report" }]]
    : [["list"]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // CI tests the production build: it is what users get, it caught the nonce CSP blocking
    // hydration that dev mode hides, and it has no on-demand route compilation to race the first
    // test that reaches a route. Local runs keep the dev server for fast iteration.
    command: process.env.CI ? `npm run build && npm run start -- --port ${port}` : `npm run dev -- --port ${port}`,
    url: baseURL,
    reuseExistingServer: false,
    timeout: process.env.CI ? 300_000 : 120_000,
    // Pass this process's environment through (CI sets the Supabase variables here). Locally the
    // dev server loads .env.local itself, and variables already set here take precedence over it.
    // The one override: the live providers are simulated (#131), so their connect flow runs
    // without OAuth apps; specs that seed rows for them see them labeled "Simulated".
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
      ),
      DEVMACRO_SIMULATE_PROVIDERS: "1",
    },
  },
});
