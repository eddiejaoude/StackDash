import { defineConfig, devices } from "@playwright/test";

import { E2E_USERS } from "./e2e/fixtures/auth";
import { FAKE_RESEND } from "./e2e/fixtures/fake-resend";
import { FAKE_WEBHOOK_E2E_SECRET } from "./e2e/fixtures/fake-webhook";
import { E2E_OPERATOR } from "./e2e/fixtures/operator";
import { SIMULATED_WEBHOOK_E2E_SECRET } from "./e2e/fixtures/simulated-webhook";

// E2E_PORT lets parallel local runs (and agents) avoid each other and the default dev port.
const port = Number(process.env.E2E_PORT ?? 3100);
const baseURL = `http://localhost:${port}`;

// Specs that run the job tick, which touches every workspace; see `projects` below. Each entry is
// a glob matched against the file name: `webhooks*.spec.ts` takes `webhooks.spec.ts` and every
// provider's `webhooks-<provider>.spec.ts` (#479).
const INSTANCE_WIDE_SPECS = [
  "simulated-providers.spec.ts",
  "alert-email.spec.ts",
  "simulated-sentry.spec.ts",
  "demo-event.spec.ts",
  "achievements-earning.spec.ts",
  "webhooks*.spec.ts",
];

// Pass this process's environment through (CI sets the Supabase variables here). Locally the dev
// server loads .env.local itself, and variables already set here take precedence over it.
const inherited = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

// Alert email goes to the fake Resend API (#244) that the first web server runs, never to Resend:
// the app and the fake get the same URL and dummy key, whatever .env.local says.
const fakeResendEnv = {
  STACKDASH_EMAIL_FROM: FAKE_RESEND.from,
  STACKDASH_RESEND_API_KEY: FAKE_RESEND.apiKey,
  STACKDASH_RESEND_API_URL: FAKE_RESEND.url,
};

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
  // POST /api/jobs/tick is instance-wide: it syncs every due connection of every workspace. Seeds
  // are never due (`notDueForAMonth` in e2e/fixtures/db.ts, #408), and a connection a `chromium`
  // spec creates through the app's connect flow or sample data is made not due once it lands
  // (`makeConnectionsNotDue` in e2e/fixtures/connections.ts, #621). A tick still syncs every
  // connection that is due, such as one between its connect and that step, or a simulated one a
  // local tick watcher with simulation on has made due again (#626), and writes connection
  // updates and sync events into its workspace, which would break that spec's realtime, dashboard,
  // timeline, and trends assertions at random. So specs that tick live apart: any spec that runs
  // the tick must live in `instance-wide`, which waits for every `chromium` and touch spec to
  // finish. A dependency always runs in full (a file filter on the command line does not narrow
  // it), and when one of those tests fails, Playwright skips the `instance-wide` specs.
  // The `instance-wide` specs run beside each other (`fullyParallel`, two workers in CI), so each
  // one's ticks sync, summarize, and dispatch in the other's workspaces too (#505). A spec there
  // counts only what no other tick can add to (by dedupe key, type, provider, or a day long past),
  // or settles its workspace first, as e2e/demo-event.spec.ts does (`settleWorkspace`).
  // Tests tagged `@touch` run only in the touch projects, which run nothing else: WebKit and Firefox
  // count each tap of a double-tap 1 where Chromium counts the second 2 (#578), so a touch rule is
  // proved in the engines that need it. Firefox has no `isMobile`.
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: INSTANCE_WIDE_SPECS,
      grepInvert: /@touch/,
    },
    {
      name: "instance-wide",
      use: { ...devices["Desktop Chrome"] },
      testMatch: INSTANCE_WIDE_SPECS,
      dependencies: ["chromium", "webkit-touch", "firefox-touch"],
    },
    {
      name: "webkit-touch",
      use: { ...devices["Desktop Safari"], hasTouch: true, isMobile: true },
      testIgnore: INSTANCE_WIDE_SPECS,
      grep: /@touch/,
    },
    {
      name: "firefox-touch",
      use: { ...devices["Desktop Firefox"], hasTouch: true },
      testIgnore: INSTANCE_WIDE_SPECS,
      grep: /@touch/,
    },
  ],
  webServer: [
    {
      name: "fake-resend",
      command: "npm run email:fake",
      url: `${FAKE_RESEND.url}/fake/emails`,
      reuseExistingServer: false,
      env: { ...inherited, ...fakeResendEnv },
    },
    {
      name: "app",
      // CI tests the production build: it is what users get, it caught the nonce CSP blocking
      // hydration that dev mode hides, and it has no on-demand route compilation to race the first
      // test that reaches a route. Local runs keep the dev server for fast iteration.
      command: process.env.CI ? `npm run build && npm run start -- --port ${port}` : `npm run dev -- --port ${port}`,
      url: baseURL,
      reuseExistingServer: false,
      timeout: process.env.CI ? 300_000 : 120_000,
      // Alert email goes to the fake Resend API, as above (fakeResendEnv).
      // A synthetic operator, and the only switch for it in end-to-end runs (CI does not set it):
      // it publishes /privacy and /terms (#339), e2e/fixtures/operator.ts.
      // Simulated providers, and the only switch for it in end-to-end runs (CI does not set it):
      // the live providers are simulated (#131), so their connect flow runs without OAuth apps.
      // Rows a spec seeds for a live provider stay real connections and are never labeled
      // "Simulated".
      // The public origin is the server's own, whatever .env.local says, so absolute metadata URLs
      // (canonical addresses, og:url, og:image: #338) and alert links point at this server.
      // The e2e owner is the instance's super admin (#250) and the viewer is not, whatever
      // .env.local says, so e2e/admin.spec.ts can check both sides of the gate.
      // The fake provider's webhook secret (#28) is the synthetic one e2e/webhooks.spec.ts signs
      // with, and every simulated provider's (#479) the one the webhooks-<provider> specs sign
      // with, whatever .env.local says.
      env: {
        ...inherited,
        ...fakeResendEnv,
        ...E2E_OPERATOR,
        STACKDASH_SIMULATE_PROVIDERS: "1",
        NEXT_PUBLIC_SITE_URL: baseURL,
        STACKDASH_SUPER_ADMIN_EMAILS: E2E_USERS.owner.email,
        STACKDASH_FAKE_WEBHOOK_SECRET: FAKE_WEBHOOK_E2E_SECRET,
        STACKDASH_SIMULATED_WEBHOOK_SECRET: SIMULATED_WEBHOOK_E2E_SECRET,
      },
    },
  ],
});
