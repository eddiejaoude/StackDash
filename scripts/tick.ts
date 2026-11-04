/*
 * Runs one job tick locally: schedules due syncs and the daily retention job, then runs up to 10
 * claimed jobs, exactly as POST /api/jobs/tick does.
 *
 *   npm run jobs:tick
 *   npm run jobs:tick -- --watch [--interval <seconds>]
 *
 * `--watch` repeats the tick every 10 seconds (at least 5) until Ctrl+C or SIGTERM, which stop it
 * after the tick in progress. With DEVMACRO_SIMULATE_PROVIDERS=1 each iteration first makes the
 * simulated connections due, so they sync on every tick (#131). It prints one line of counts per
 * tick.
 *
 * Calls the runner directly, so no dev server or CRON_SECRET is needed. Reads `.env.local` when
 * present (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, DEVMACRO_ENCRYPTION_KEY, provider
 * OAuth settings). Prints the counts only. See docs/operations/jobs.md.
 */
import { existsSync } from "node:fs";

import { simulatedProviderIds } from "@/lib/adapters/registry";
import { isProviderSimulationEnabled } from "@/lib/adapters/simulated";
import { createJobDeps } from "@/lib/jobs/queue";
import { runTick } from "@/lib/jobs/runner";
import { abortableSleep, countingEventWrites, parseTickArgs, runWatch } from "@/lib/jobs/watch";

async function main(): Promise<void> {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const args = parseTickArgs(process.argv.slice(2));
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

  const deps = createJobDeps();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await runWatch(
    {
      tick: async () => {
        const counter = { written: 0 };
        const result = await runTick({ ...deps, store: countingEventWrites(deps.store, counter) });
        return { result, eventsWritten: counter.written };
      },
      simulationEnabled: isProviderSimulationEnabled,
      // Only providers simulated in this process, so a real connection is never pulled forward.
      markSimulatedDue: () => deps.store.markSyncsDue(simulatedProviderIds(), new Date()),
      now: () => new Date(),
      sleep: abortableSleep,
      print: (line) => console.log(line),
      signal: controller.signal,
    },
    args.intervalSeconds,
  );
}

main().catch((error: unknown) => {
  // Store errors carry Postgres codes only, never row data or secrets.
  console.error(error instanceof Error && error.message.length > 0 ? `Tick failed: ${error.message}` : "Tick failed.");
  process.exitCode = 1;
});
