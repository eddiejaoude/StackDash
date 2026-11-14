/*
 * Builds a ready-to-demo workspace on the local Supabase stack (#166): a demo account owning one
 * workspace with every simulated provider connected, its accounts spread over three projects, a
 * Vercel budget and a Resend quota alert, and 90 days of history replayed through the real sync,
 * alert, and daily summary jobs. The first project then publishes every metric it can and turns
 * on its public project page (#150).
 *
 *   npm run demo:seed
 *   npm run demo:seed -- --member you@example.com [--member someone@example.com] [--seed <text>]
 *
 * It prints a one-time sign-in link for the demo account (#260), which opens the dashboard.
 * `--member` also adds an account that has signed in with GitHub before as an admin of the demo
 * workspace. `--seed` picks the simulated accounts, so the same seed rehearses the same demo
 * (default "stackdash-demo"). `npm run demo` does the same and then keeps the history going live.
 *
 * Refuses to run unless STACKDASH_SIMULATE_PROVIDERS=1 and NEXT_PUBLIC_SUPABASE_URL points at this
 * computer. Rerunning replaces the demo workspace; nothing outside it is touched. Stop
 * `npm run jobs:tick -- --watch` while it runs, then start it again to continue the history live.
 * The replayed alerts count as already sent, so only alerts that trigger live are emailed or
 * posted (#152).
 * Reads `.env.local` when present.
 */
import { existsSync } from "node:fs";

import { isProviderSimulationEnabled } from "@/lib/adapters/simulated";
import { connectOrigin } from "@/lib/connections/oauth-state";
import { demoCommandRefusal } from "@/lib/demo/history";
import { runDemoCommand, seedDemoWorkspace } from "@/lib/demo/seed";
import { demoSignInLink } from "@/lib/demo/sign-in";
import { DEMO_USER_EMAIL } from "@/lib/demo/workspace";
import { createAdminClient } from "@/lib/supabase/admin";

const USAGE = "Usage: npm run demo:seed -- [--member you@example.com] [--seed <text>]";
const DEFAULT_ORIGIN = "http://localhost:3000";

function print(line: string): void {
  console.log(line);
}

function main(): Promise<number> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const origin = connectOrigin(DEFAULT_ORIGIN, process.env.NEXT_PUBLIC_SITE_URL);
  return runDemoCommand(process.argv.slice(2), {
    label: "Demo seed",
    usage: USAGE,
    refusal: () =>
      demoCommandRefusal({
        simulationEnabled: isProviderSimulationEnabled(),
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
      }),
    seed: (args) => seedDemoWorkspace(createAdminClient(), { ...args, now: new Date(), print }),
    signInLink: (next) => demoSignInLink(createAdminClient(), { email: DEMO_USER_EMAIL, origin, next }),
    origin,
    print,
    printError: (line) => console.error(line),
    afterSummary: async () => {
      print("Keep the history going live with: npm run jobs:tick -- --watch");
    },
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Errors raised on this path carry Postgres codes and messages, never secrets.
    console.error(error instanceof Error && error.message.length > 0 ? `Demo seed failed: ${error.message}` : "Demo seed failed.");
    process.exitCode = 1;
  },
);
