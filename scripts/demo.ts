/*
 * One command from a fresh clone to a signed-in demo workspace (#260): builds the demo workspace
 * exactly as `npm run demo:seed` does, prints a one-time sign-in link for the demo account that
 * opens its dashboard, then keeps the history going live as `npm run jobs:tick -- --watch` does,
 * until Ctrl+C.
 *
 *   npm run demo
 *   npm run demo -- --member you@example.com [--member someone@example.com] [--seed <text>]
 *
 * `--member` and `--seed` are the demo seed's (see scripts/demo-seed.ts). No GitHub OAuth app is
 * needed: the link signs in through `/auth/confirm`, which accepts it only on a local stack with
 * provider simulation on.
 *
 * Refuses to run, and writes nothing, unless STACKDASH_SIMULATE_PROVIDERS=1 and
 * NEXT_PUBLIC_SUPABASE_URL points at this computer. Rerunning replaces the demo workspace and
 * prints a new link. Stop any `npm run jobs:tick -- --watch` first, as for the demo seed: this
 * command runs its own once the history is built. Reads `.env.local` when present.
 */
import { existsSync } from "node:fs";

import { isProviderSimulationEnabled } from "@/lib/adapters/simulated";
import { DEFAULT_EVENT_VOLUME } from "@/lib/adapters/simulated/simulation";
import { connectOrigin } from "@/lib/connections/oauth-state";
import { demoCommandRefusal } from "@/lib/demo/history";
import { runDemoCommand, seedDemoWorkspace } from "@/lib/demo/seed";
import { demoSignInLink } from "@/lib/demo/sign-in";
import { DEMO_USER_EMAIL } from "@/lib/demo/workspace";
import { createJobDeps } from "@/lib/jobs/queue";
import { liveWatchDeps, WATCH_DEFAULT_INTERVAL_SECONDS, watchUntilStopped } from "@/lib/jobs/watch";
import { createAdminClient } from "@/lib/supabase/admin";

const USAGE = "Usage: npm run demo -- [--member you@example.com] [--seed <text>]";
const DEFAULT_ORIGIN = "http://localhost:3000";

function print(line: string): void {
  console.log(line);
}

function main(): Promise<number> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const origin = connectOrigin(DEFAULT_ORIGIN, process.env.NEXT_PUBLIC_SITE_URL);
  return runDemoCommand(process.argv.slice(2), {
    label: "Demo",
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
      print("Start the app with npm run dev if it is not running, then open the link. The history now continues live:");
      print("");
      // The replay's last step is now, so the watch carries on from its cursors without a gap.
      await watchUntilStopped(liveWatchDeps(createJobDeps(), print), {
        intervalSeconds: WATCH_DEFAULT_INTERVAL_SECONDS,
        volume: DEFAULT_EVENT_VOLUME,
      });
    },
  });
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Errors raised on this path carry Postgres codes and messages, never secrets or the link.
    console.error(error instanceof Error && error.message.length > 0 ? `Demo failed: ${error.message}` : "Demo failed.");
    process.exitCode = 1;
  },
);
