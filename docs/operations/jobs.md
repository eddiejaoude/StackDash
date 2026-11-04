# Jobs: scheduled syncs, retries, and retention

DevMacro runs all background work from one route, `POST /api/jobs/tick`, called once a minute. Hosted (Vercel plus Supabase) and self-hosted (Docker Compose) run the same code; only the caller differs. Decisions: #10 (Postgres job table plus a `pg_cron` tick), #37 (per-adapter poll intervals, 13 months of history).

## How a tick works

Each tick does three things, then answers with counts only (no data, no errors in the body):

1. **Schedule.** Queues a sync for every connection that is due:
   - `active` connections whose `next_sync_at` has passed, or was never set.
   - `failed` connections whose backoff has elapsed (`next_sync_at`, one hour after the last failure).
   - `needs_attention`, `pending`, and `revoked` connections are never scheduled. They wait for the user to reconnect.

   It also queues the retention job once per UTC day (dedupe key `retention:YYYY-MM-DD`), and one daily summary job per workspace with a connection that is not revoked (dedupe key `daily_summary:<workspace id>:YYYY-MM-DD`, for the previous UTC day). The summary writes one `devmacro.daily_summary` timeline event with each provider's usage and spending for that day, labeled verified, estimated, or unavailable, and never adds currencies together.
2. **Claim.** Takes up to 10 runnable jobs from `sync_jobs` with `for update skip locked` and a 120 second lease, so overlapping ticks never run the same job.
3. **Run.** Runs the claimed jobs, three at a time, within a 50 second budget. Jobs not started when the budget runs out go back to the queue without using an attempt. The route's `maxDuration` is 120 seconds, which leaves room for jobs already running.

There is at most one queued or running sync per connection (unique index `sync_jobs_one_open_sync_per_connection`). The scheduler, "Sync now", and the first sync after connecting can all ask at once without stacking jobs. It also serializes token refreshes: providers that rotate refresh tokens invalidate the old one on use, so two parallel refreshes would lose the connection.

### A sync job

For each included external account of the connection:

1. Load and decrypt the credential. If the access token expires within 5 minutes, refresh it and save the new credential before anything else.
2. Call the adapter's `sync` with the account's stored cursor. The result is validated (`validateAdapterMetrics`, `validateAdapterEvents`); an invalid batch fails the job as `invalid_response`.
3. Store the result: one `usage_snapshots` row per account, metric, and UTC day (upserted, so the latest row is the current value), events inserted once per `dedupe_key`, then the new cursor. A billing period rollover writes one `devmacro.allowance_reset` event.
4. On success: `consecutive_failures = 0`, `last_synced_at = now`, `next_sync_at = now + poll_interval_seconds`. Parts the grant could not reach are recorded in `missing_scopes`; the connection stays `active`.

### Failures and retries

| Adapter error | Connection | Job |
|---|---|---|
| `auth_revoked`, `permission_missing`, no stored credential | `needs_attention` at once | Failed, no retry |
| `rate_limited` | Stays `active` while retrying | Retried after `Retry-After` (at most a day), or the backoff below when absent |
| `provider_unavailable`, `timeout`, `invalid_response`, anything unexpected | Stays `active` while retrying | Retried with exponential backoff and full jitter: a random delay in [0, min(1 h, 60 s x 2^(attempt-1))] |

After 5 attempts the job fails and the connection becomes `failed`; the scheduler tries it again once an hour, one attempt per run, until a sync succeeds. Every failure records `last_error_code` and `last_error_reference` (the reference id in the server logs).

The timeline gets exactly one `devmacro.sync_failed` event per failure episode. An episode starts when a connection leaves `active` for `needs_attention` or `failed`; retries and later failed runs in the same episode add nothing. The event names the provider and account and says to reconnect. A successful sync ends the episode, so the next failure writes a new event.

### Sync now

`enqueueSync({ reason: "manual" })` in `src/lib/jobs/queue.ts` accepts one request per connection every 5 minutes (`MANUAL_SYNC_COOLDOWN_SECONDS`). The check and the `last_sync_requested_at` stamp happen in one statement (`request_manual_sync`), so two quick clicks cannot both pass.

## Retention

The daily retention job deletes, in batches of 1000 rows:

- `oauth_states` whose `expires_at` has passed. A finished connect flow deletes its own state, so these belong to abandoned flows (a closed tab on the provider's consent screen, or GitHub's approval pending path) and still hold a sealed PKCE verifier. They go first, ahead of the larger tables.
- `usage_snapshots` with `snapshot_date` more than 13 months before today (UTC).
- `activity_events` with `occurred_at` more than 13 months ago.
- Finished `sync_jobs` (succeeded or failed) created more than 30 days ago. Queued and running jobs are never deleted.

Data exactly 13 months old is kept. Triggered alerts are kept while their rule exists. A run cut short by the tick budget is finished by the next run; running it twice is harmless.

## Run a tick locally

```bash
npm run jobs:tick
```

This calls the same runner as the route, with the settings in `.env.local`, and prints the counts as JSON. It needs no dev server and no `CRON_SECRET`. Run it again to process retries whose time has come.

`npm run jobs:tick -- --watch` keeps running the same tick in a loop, every 10 seconds by default (`--interval <seconds>`, at least 5), and prints one line per tick with the time and the number of jobs synced, timeline events written, failures, and retries, never any data. Each watch tick claims up to 100 jobs instead of 10, so every simulated connection of a local instance syncs on every tick. Ctrl+C or SIGTERM stops it after the tick in progress and exits 0. With `DEVMACRO_SIMULATE_PROVIDERS=1` (local only, refused on a Vercel production deployment) every live provider is simulated in that process, and each iteration first makes the active connections the simulator made due (their granted scope is `simulated:read`), so they sync on every tick and open screens update continuously (#131). A real connection is never made due early, whatever its provider. On its normal schedule the simulator refuses its real credential rather than fill it with made-up data: the sync is retried, the connection is marked failed with one timeline event, and it syncs again on its hourly retry once the flag is removed. Without the flag it says so once and runs the normal tick, which syncs connections only when they are due. Without `--watch` the script runs one tick, as above.

To call the route itself (dev server running):

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/jobs/tick
```

Without the header, with a wrong secret, or when `CRON_SECRET` is unset or shorter than 32 characters, the route answers `401`.

## Register the pg_cron job

The `pg_cron` and `pg_net` extensions are installed by migration. The cron job is environment configuration (#89): it carries the deployment URL and `CRON_SECRET`, so it is registered once per environment in the Supabase SQL editor, never in a migration. Both values are kept in [Supabase Vault](https://supabase.com/docs/guides/database/vault), following the Supabase guide [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions) (pg_cron plus pg_net with secrets in Vault).

1. Store the app URL and the secret in Vault. Use the same `CRON_SECRET` value as the deployment.

   ```sql
   select vault.create_secret('https://devmacro.example.com', 'devmacro_app_url');
   select vault.create_secret('<CRON_SECRET value>', 'devmacro_cron_secret');
   ```

2. Schedule the tick every minute:

   ```sql
   select cron.schedule(
     'devmacro-jobs-tick',
     '* * * * *',
     $$
     select net.http_post(
       url := (select decrypted_secret from vault.decrypted_secrets where name = 'devmacro_app_url') || '/api/jobs/tick',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'devmacro_cron_secret')
       ),
       body := '{}'::jsonb,
       timeout_milliseconds := 120000
     ) as request_id;
     $$
   );
   ```

   The body is ignored; the route reads nothing from it. `timeout_milliseconds` matches the route's `maxDuration`, so pg_net does not give up on a long tick.

3. Check it runs (a minute later):

   ```sql
   select jobid, status, return_message, start_time
   from cron.job_run_details
   where jobid = (select jobid from cron.job where jobname = 'devmacro-jobs-tick')
   order by start_time desc
   limit 5;

   select id, status_code, error_msg, created
   from net._http_response
   order by created desc
   limit 5;
   ```

   `status_code` 200 means the tick ran; 401 means the Vault secret does not match the deployment's `CRON_SECRET`. `net._http_response` keeps responses for about 6 hours.

### Change or remove the job

- New secret (rotation): set it in the deployment first, then update Vault. Ticks answer `401` in between, and the next tick after the update catches up.

  ```sql
  select vault.update_secret(
    (select id from vault.secrets where name = 'devmacro_cron_secret'),
    '<new CRON_SECRET value>'
  );
  ```

- New URL: the same with `devmacro_app_url`.
- Pause or remove: `select cron.unschedule('devmacro-jobs-tick');` Run step 2 again to restore it.

### Self-hosted (Docker Compose) and local Supabase

The same SQL works with the Supabase stack in Compose. Use a URL the database container can reach: the app's service name on the Compose network (for example `http://app:3000`), or `http://host.docker.internal:3000` for a dev server on the host. Any other scheduler that can send the same `POST` with the bearer header every minute works too.

## Where to look when syncs stop

- `connections.status`, `last_error_code`, `last_error_reference` for one connection; search the server logs for the reference id.
- `sync_jobs` for the queue: `status`, `attempts`, `run_after`, `error_code`. A `running` job whose `locked_until` passed belongs to a tick that died; the next tick reclaims it.
- `cron.job_run_details` and `net._http_response` for whether ticks reach the app at all.
