/*
 * Runs one job tick locally: schedules due syncs and the daily retention job, then runs up to 10
 * claimed jobs of every kind but `webhook` and up to 50 `webhook` jobs on top, exactly as
 * POST /api/jobs/tick does.
 *
 *   npm run jobs:tick
 *   npm run jobs:tick -- --watch [--interval <seconds>] [--volume <1-20>]
 *
 * `--watch` repeats the tick every 10 seconds (at least 5) until Ctrl+C or SIGTERM, which stop it
 * after the tick in progress, and claims up to 100 jobs of every kind but `webhook` per tick
 * instead of 10; the `webhook` claim stays at WEBHOOK_TICK_CLAIM_LIMIT (50). With
 * STACKDASH_SIMULATE_PROVIDERS=1 each iteration first makes the connections the simulator made due,
 * so they sync on every tick (#131). It prints one line of counts per tick.
 *
 * `--volume` (#383, default 1) multiplies the simulated timeline events each sync makes, so local
 * screens fill faster. It needs `--watch` and STACKDASH_SIMULATE_PROVIDERS=1 and is refused
 * otherwise, before any tick runs. Metrics, real providers, the cadence, and the claim limit stay
 * as they are.
 *
 * Calls the runner directly, so no dev server or CRON_SECRET is needed. Reads `.env.local` when
 * present (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STACKDASH_ENCRYPTION_KEY, provider
 * OAuth settings). Prints the counts only. See docs/operations/jobs.md.
 */
import { existsSync } from "node:fs";

import { isProviderSimulationEnabled } from "@/lib/adapters/simulated";
import { createJobDeps } from "@/lib/jobs/queue";
import { runTick } from "@/lib/jobs/runner";
import { liveWatchDeps, parseTickArgs, watchUntilStopped, withSimulatedEventVolume } from "@/lib/jobs/watch";

async function main(): Promise<void> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  // Read after .env.local, where the flag usually is.
  const args = parseTickArgs(process.argv.slice(2), { simulationEnabled: isProviderSimulationEnabled() });
  if (args.kind === "invalid") {
    console.error(args.message);
    process.exitCode = 2;
    return;
  }
  if (args.kind === "once") {
    const result = await runTick(createJobDeps());
    console.log(JSON.stringify(result));
    return;
  }

  await watchUntilStopped(
    liveWatchDeps(withSimulatedEventVolume(createJobDeps(), args.volume), (line) => console.log(line)),
    { intervalSeconds: args.intervalSeconds, volume: args.volume },
  );
}

main().catch((error: unknown) => {
  // Store errors carry Postgres codes only, never row data or secrets.
  console.error(error instanceof Error && error.message.length > 0 ? `Tick failed: ${error.message}` : "Tick failed.");
  process.exitCode = 1;
});
