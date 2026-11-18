# Jobs: scheduled syncs, retries, and retention

StackDash runs all background work from one route, `POST /api/jobs/tick`, called once a minute. Hosted and self-hosted installs run the same code; only the caller differs: `pg_cron` in the Supabase project, another scheduler, or `npm run jobs:tick` locally. The design is a Postgres job table plus a `pg_cron` tick, with poll intervals per adapter and 13 months of history.

## How a tick works

Each tick does three things, then answers with counts only (no data, no errors in the body):

1. **Schedule.** Queues a sync for every connection that is due:
   - `active` connections whose `next_sync_at` has passed, or was never set.
   - `failed` connections whose backoff has elapsed (`next_sync_at`, one hour after the last failure).
   - `needs_attention`, `pending`, and `revoked` connections are never scheduled. They wait for the user to reconnect.

   It also queues the retention job once per UTC day (dedupe key `retention:YYYY-MM-DD`), and one daily summary job per workspace with a connection that is not revoked (dedupe key `daily_summary:<workspace id>:YYYY-MM-DD`, for the previous UTC day). The summary writes one `stackdash.daily_summary` timeline event with each provider's usage and spending for that day, labeled verified, estimated, or unavailable, and never adds currencies together. Spending counts only what the dashboard counts toward the current billing period as of the end of that day (`isCurrentPeriod` in `src/lib/dashboard/aggregate.ts`), so it agrees with the provider card: a total for a period that had ended when it was read, such as DigitalOcean's last invoice, and a rolling window such as Stripe's last 30 days are left out. It then gives each provider's spend projected to the end of the billing period, labeled as an estimate by StackDash or with the reason there is none, and the date any quota is projected to run out before its reset. Projections are worked out as of the last instant of the summarized day from the 14 days of snapshots up to it (`src/lib/dashboard/projection.ts`): linear on the recent daily rate, from at least 3 days of data in the current period. They never raise an alert.

   The same job then checks for unusual spend and usage, unless an admin turned the unusual spend and usage checks off in alert settings. For each spend and usage metric over a period (verified and estimated apart), it works out the day's amount, the difference between two days for a month to date total, and compares it with the 14 days before. A month to date total is checked on the summarized day, because its last reading that day is already stored. A metric reported one day at a time (Supabase daily active users, a DigitalOcean SKU's day spend) is checked on the day before: the provider reports a finished day the day after, and the job runs in the first minute after the summarized day ends, before that row exists. Its event names the day it checked, and the next day's job checks the summarized day, so no day is skipped or checked twice. A daily total an adapter declares in `dailyTotals` (GitHub's new stars per day) is never checked: it feeds achievements, and a launch day is not usage to warn about. Each snapshot date's rows first go through the dashboard's counting rules (`dropSupersededBreakdowns` and `dropSubWindows` in `src/lib/dashboard/aggregate.ts`), so a GitHub SKU never fires beside its product and a `github.daily_spend.<product>` day never fires beside the product's month; alert settings offers only the metrics left after those rules. It needs at least 7 of those days, and it flags the day only when all three hold: the amount is at least twice the median, at least the minimum change above it (5 whole units of the currency, or 50 units of usage, 1 GB, or 1,000 MB), and above 3.5 on the modified z-score (Iglewicz and Hoaglin, as cited in the [NIST/SEMATECH e-Handbook, section 1.3.5.17](https://www.itl.nist.gov/div898/handbook/eda/section3/eda35h.htm)). The score divides 0.6745 times the distance from the median by the median absolute deviation. When more than half the days share one amount, that deviation is 0 (a quiet weekend, or a workspace active three days a week), so the score divides the distance by 1.253314 times the mean absolute deviation from the median instead ([IBM Cognos Analytics, "Modified z score"](https://www.ibm.com/docs/en/cognos-analytics/12.0.x?topic=terms-modified-z-score)). Only a window where every day had the same amount skips the score, and then the twice the median and minimum change tests decide. The first day of a billing period is never checked, because once a period charges land on it. Each unusual metric writes one `stackdash.anomaly_detected` event, deduplicated per metric per checked day (dedupe key `anomaly:YYYY-MM-DD:<provider>:<metric key>:money:<currency>:<verified or estimated>` for spend, `anomaly:YYYY-MM-DD:<provider>:<metric key>:quantity:<unit>:<verified or estimated>` for usage, for example `anomaly:2026-10-20:vercel:vercel.spend.total:money:USD:verified`). Muted metrics are skipped. Only rises are flagged: a quiet weekend is not an anomaly.

   Alert delivery adds two more:
   - **Alert dispatch**: one `alert_dispatch` job per workspace with a triggered alert not sent yet (at most one open, queued or running, per workspace, unique index `sync_jobs_one_open_alert_dispatch_per_workspace`, so a second dispatch never sends what a running one is sending; an alert that fires meanwhile goes out with the first tick after it finishes). Alerts the syncs of one tick record go out with the next tick, together: one email per owner or admin set to "As each alert happens", and one post per channel that receives those rules, up to 4 targets at a time. A delivery record per alert and target (`notification_deliveries`) means a retried job never sends anything twice, and `triggered_alerts` holds one row per rule per billing cycle, so each rule emails at most once per cycle. Channel posts retry within the job on 429 and 5xx; a target still failing is retried with the job's backoff, and each failure writes one `stackdash.notification_failed` timeline event with the reference id of the logged error. After the last attempt the alerts count as sent, so one broken channel cannot hold back later alerts. A channel that fails 3 times in a row, or answers with any other 4xx or a redirect (never followed), becomes "needs attention" and writes a `stackdash.channel_needs_attention` event. So does a webhook whose host resolves to a private network address, or whose URL this instance no longer allows: the URL rules and the private address check (`STACKDASH_ALLOW_PRIVATE_WEBHOOKS`) are applied each time a message is posted, and the post connects only to the addresses that were checked. So does a channel whose sealed URL cannot be read, for example after a key rotation that lost the old key: alert settings says so, and the channel needs removing and adding again with its URL.

     The Discord embed and Slack Block Kit messages follow the vendors' documentation (the sources are listed at the top of `src/lib/notifications/channels.ts`). They are unconfirmed against a live Discord or Slack webhook until they are checked by hand. A test message to a generic webhook, with its signature, is checked end to end by `e2e/alert-channels.spec.ts`.
   - **Digest**: one `digest` job per workspace with a connection per UTC day (dedupe key `digest:<workspace id>:YYYY-MM-DD`, for the previous day). It sends the daily digest to members and channels set to daily, and on Mondays the weekly digest for the week before to those set to weekly. Its highlights count the period's timeline events (deployments, signups, star events, payments), with PostHog's daily signup counts summed for the days that ended in the period.

   Email goes through Resend's API with `STACKDASH_RESEND_API_KEY` (see `.env.example`). Without it, email targets are skipped and channels still receive alerts. Locally, set `STACKDASH_RESEND_API_URL=http://127.0.0.1:55430` and run `npm run email:fake`: the fake Resend API prints each email the tick sends, and lists them at http://127.0.0.1:55430/fake/emails.
2. **Claim.** Takes up to 50 runnable `webhook` jobs (`claim_webhook_jobs`), then up to 10 runnable jobs of every other kind (`claim_sync_jobs`), from `sync_jobs` with `for update skip locked` and a 120 second lease, so overlapping ticks never run the same job. Each claim takes the oldest `run_after` first. The two claims are separate, so neither kind can take the other's share of a tick.
3. **Run.** Runs the claimed jobs, three at a time, `webhook` jobs first, within a 50 second budget. Webhook jobs, and the achievement checks after them, start only in the first 25 seconds of it (`WEBHOOK_TICK_BUDGET_MS`), so the other kinds always have the rest. Jobs not started when their part of the budget runs out go back to the queue without using an attempt. The route's `maxDuration` is 120 seconds, which leaves room for jobs already running.

There is at most one queued or running sync per connection (unique index `sync_jobs_one_open_sync_per_connection`). The scheduler, "Sync now", and the first sync after connecting can all ask at once without stacking jobs.

Token refreshes are serialized per connection by the credential refresh lock (`credential_refresh_locks`), which a sync, automatic webhook setup and removal, and the pass after a sync that gives new GitLab projects their webhook (`addMissingSourceWebhooks`) all take: providers that rotate refresh tokens invalidate the old one on use, so two parallel refreshes would lose the connection. The lock is a 60 second lease taken through `acquire_credential_refresh_lock`, so a holder that dies frees it on its own. A refresh that finds it held asks again every second for about 20 seconds, then re-reads the credential once it holds the lock and refreshes only if it is still about to expire. The refresh token is spent only while more of the lease is left than the provider's request timeout plus 10 seconds for the save. If the lock stays held, or too little of the lease is left, nothing is spent and:

- A sync fails as `internal_error` (`handleFailure` in `src/lib/jobs/sync-connection.ts`): it is retried with backoff (see [Failures and retries](#failures-and-retries)) and counts toward `consecutive_failures`.
- Automatic webhook setup fails before anything is created, and the panel shows the failure with a reference.
- Removal on disconnect is reported as a failed deletion: the disconnect goes on, and the user gets the steps to remove the webhook by hand with a reference.
- The after-sync pass (`addMissingSourceWebhooks`, called from `runSyncJob` in `src/lib/jobs/sync-connection.ts`) throws before asking the provider anything, as it does when the refresh itself fails. The job logs `sync.source_webhooks_failed`, the sync still counts as succeeded, and the next sync tries the missing webhooks again.

### A sync job

For each included external account of the connection:

1. Load and decrypt the credential. If the access token expires within 5 minutes, refresh it under the connection's refresh lock and save the new credential before anything else.
2. Call the adapter's `sync` with the account's stored cursor. The result is validated (`validateAdapterMetrics`, `validateAdapterEvents`); an invalid batch fails the job as `invalid_response`.
3. Store the result: one `usage_snapshots` row per account, metric, and UTC day (upserted, so the latest row is the current value), events inserted once per `dedupe_key` (`insert_activity_events`: an event already stored only gains a body it was stored without, nothing else of it changes), then the new cursor. A billing period rollover writes one `stackdash.allowance_reset` event.
4. On success: `consecutive_failures = 0`, `last_synced_at = now`, `next_sync_at = now + poll_interval_seconds`. Parts the grant could not reach are recorded in `missing_scopes`; the connection stays `active`.

The sync writes its result to the connection, success or failure, only while the connection is still `active` or `failed`, checked in the same statement as the write. An uninstall delivery (see [A webhook job](#a-webhook-job)) applied while the sync ran has already marked the connection `needs_attention`, and that stays: the sync logs `sync.superseded`, keeps the data it stored, adds no `stackdash.sync_failed` event of its own unless the uninstall lands between the sync's last status read and its event (the event is written before the status, so that gap cannot be closed), creates no webhook for new sources, and ends without a retry.

### A webhook job

Providers that push signed events (see [Webhooks](../adapters.md#webhooks)) deliver them to `POST /api/webhooks/<provider>`, one URL on StackDash's own app registration, or to `POST /api/webhooks/<provider>/<endpoint id>`, one URL per connection. The route never writes events. It verifies the delivery against its raw body, stores it in `webhook_deliveries` with one queued `webhook` job in a single transaction, and answers at once. A delivery StackDash does not map is stored already processed, with no job.

| Status | Body | When |
|---|---|---|
| `202` | `{"status":"accepted"}` | Verified and stored. The next tick applies it |
| `200` | `{"status":"duplicate"}` | The provider's delivery id is already stored for this URL: a retry, acknowledged and dropped (`webhook.duplicate` in the log). Deliveries are unique per provider, endpoint, and delivery id, because a provider sends one message id to every endpoint of an account, so the same id at another connection's URL is a different delivery |
| `400` | `{"error":"bad_request","referenceId":"REF-..."}` | Verified, but the adapter could not read it |
| `401` | `{"error":"unauthorized"}` | Unsigned (reason `missing_signature`), wrongly signed (`bad_signature`), with a timestamp outside the provider's tolerance, a replay (`stale`), or correctly signed with no delivery id, a blank one, or one over 200 characters (`malformed`). Logged as `webhook.rejected` with the provider, reason, and endpoint only, never the body, a header, or the signature |
| `404` | `{"error":"not_found"}` | Unknown provider, a provider without webhooks on this instance, the wrong URL shape for the provider, or an unknown endpoint |
| `413` | `{"error":"payload_too_large"}` | Body over 1 MiB |
| `422` | `{"error":"invalid_events","referenceId":"REF-..."}` | Verified, but the adapter mapped it to events that fail validation |
| `422` | `{"error":"invalid_uninstall","referenceId":"REF-..."}` | Verified, but the adapter mapped it to an uninstall the job could never apply: a blank account or installation id, a time that is not one, or an installation from an adapter that does not record installations (`webhook.invalid_uninstall` in the log, with the issue names only) |
| `429` | `{"error":"rate_limited"}` | A per-connection URL that has already answered 50 verified deliveries this minute (`WEBHOOK_ENDPOINT_DELIVERIES_PER_MINUTE` in `src/lib/webhooks/receive.ts`, set to the 50 webhook jobs a tick claims). One connection at its limit queues no more a minute than a tick takes, so on its own it cannot grow the backlog every workspace's deliveries share. `Retry-After` gives the seconds to the next minute, nothing is stored, and the provider retries. Logged as `webhook.rate_limited` with the provider and endpoint. The app-level URL is never limited |
| `500` | `{"error":"internal_error","referenceId":"REF-..."}` | Storing it failed. The provider retries, and deduplication absorbs the repeat |
| `503` | `{"error":"not_configured"}` | The provider's webhook secret is not set on this instance (`webhook.secret_missing` in the log, with the variable's name) |

The route has no `Origin` check: a delivery comes from the provider's servers, not from a browser, and its signature is what authenticates it.

The next tick runs the job. Each tick claims up to 50 `webhook` jobs (`WEBHOOK_TICK_CLAIM_LIMIT` in `src/lib/jobs/runner.ts`) on their own, plus the regular 10 jobs of every other kind (`TICK_CLAIM_LIMIT`), and starts the webhook jobs first, within their share of the budget: the first 25 seconds (`WEBHOOK_TICK_BUDGET_MS`). Neither can take the other's claim or time: a burst of deliveries never stops syncs, summaries, alerts, digests, or retention, and a backlog of syncs never holds a delivery back. With `pg_cron` calling the tick every minute, a delivered event reaches the timeline on the next tick, within a minute, unless more deliveries are waiting than a tick reaches: then each tick applies the oldest it reaches, up to 50, and the rest wait for the ticks after it. A `webhook` job makes no provider call: it reads its delivery, finds its targets, writes their events in one insert, and marks the delivery processed. Once the tick's webhook jobs are done, each connection they stored a new event for has its achievements checked once, however many deliveries it had, and that check reads every retained event and reading of the pending achievement rules' types, so it costs more the longer the connection's history. What bounds them is the claim, for how many a tick takes, and the share, for how long: no webhook job or achievement check starts after 25 seconds, and webhook jobs not started by then go back to the queue without using an attempt. A webhook job that failed and waits for a retry is not claimed before its backoff ends.

The job reads the delivery back and finds its targets on `active`, `failed`, or `needs_attention` connections of the provider (everything but `pending` and `revoked`), across workspaces for an app-level URL and only on the endpoint's own connection for a per-connection URL. Events and an uninstall naming an account reach every included external account with that external id. An uninstall naming an installation reaches every connection whose `external_installation_id` is that installation, whatever its accounts. A `failed` connection's polling is erroring but still scheduled, so a pushed event can be the one path still reaching it. Then, by what the delivery means:

- **Events** are written to every one of those workspaces in one insert, with the same `dedupe_key` the adapter's sync gives the same provider event. A delivery and a later poll of that event store it once, whichever comes first, and the first write decides everything but a missing body: a delivery that lacks a detail the poll reads (Vercel's error code, GitLab's deployment number and ref) gets that line from the next poll. Connections that received a new event have their achievements checked once the tick's webhook jobs are done, once per connection however many deliveries it had, as after a sync. A check the webhook share does not reach (`webhook.achievements_deferred` in the log) or that fails is left to the connection's next successful sync, and the job still succeeds. For an `active` connection that is usually its next scheduled sync. For a `failed` or `needs_attention` connection it comes later: a `failed` one is tried again once an hour until a sync succeeds, and a `needs_attention` one is not synced until the user reconnects it. Alerts are not checked: every alert rule is a threshold on snapshots, which a delivery never writes.
- **Uninstalled**: each connection is marked the way a sync that got `auth_revoked` marks it, `needs_attention` with one `stackdash.sync_failed` event (none more if its failure episode already has one), at once instead of on its next sync. A connection already waiting for a reconnect is left alone. So is one granted again after the removal happened (a reconnect, `connections.granted_at`), because deliveries arrive late and out of order and a late uninstall must not undo a reconnect; it is logged as `webhook.uninstall_stale`. A token refresh is not a grant and does not move the grant, so a removal followed by a refresh still marks the connection at once. A live connection with no recorded grant has nothing known to be newer than the removal, so the uninstall marks it at once, however late and whenever its credential was last saved. The backfill filled every connection made before the app wrote `granted_at`, so such a connection is one inserted as live (the seed and the e2e fixtures set it), or one a build from before `granted_at` made while it served after `20261118090000_contract_webhook_targets.sql` ran: a self-hosted upgrade that applies both halves of the change in one `supabase migration up` before it promotes, or an Instant Rollback to such a build. Once the current build serves again, run `select public.backfill_connection_granted_at(1000);` as the service role until it returns 0; it fills those connections from their credential's last save, else from when they were created, and never overwrites a recorded grant. `webhook.uninstalled` and `webhook.no_targets` say whether the uninstall named an `account` or an `installation`. A connection's installation is recorded when its grant completes; a connection made before installations were recorded gets it on its next sync, so until then an uninstall naming its installation does not find it and its next sync asks for a reconnect as before.
- **Ignored**: a verified delivery StackDash does not map. It never gets a job: it is stored already processed, with no content, so a repeat is still recognized.

An account no workspace includes, or an installation no live connection records, is logged as `webhook.no_targets` and nothing is written. The delivery is then marked processed and its stored content dropped; only its key stays, for deduplication. A store failure retries the job like a sync (see below). A job whose delivery is gone (purged) finishes without doing anything.

Polling keeps running on its schedule: it catches a delivery that never arrived and stays the only source of spend and usage. An instance without a public URL (local development, a self-hosted install on a private network) receives no deliveries and works on polling alone.

### Failures and retries

| Adapter error | Connection | Job |
|---|---|---|
| `auth_revoked`, `permission_missing`, no stored credential | `needs_attention` at once | Failed, no retry |
| `rate_limited` | Stays `active` while retrying | Retried after `Retry-After` (at most a day), or the backoff below when absent |
| `provider_unavailable`, `timeout`, `invalid_response`, anything unexpected | Stays `active` while retrying | Retried with exponential backoff and full jitter: a random delay in [0, min(1 h, 60 s x 2^(attempt-1))] |

After 5 attempts the job fails and the connection becomes `failed`; the scheduler tries it again once an hour, one attempt per run, until a sync succeeds. Every failure records `last_error_code` and `last_error_reference` (the reference id in the server logs).

The timeline gets exactly one `stackdash.sync_failed` event per failure episode. An episode starts when a connection leaves `active` for `needs_attention` or `failed`; retries and later failed runs in the same episode add nothing. The event names the provider and account and says to reconnect. A successful sync ends the episode, so the next failure writes a new event.

### Sync now

`enqueueSync({ reason: "manual" })` in `src/lib/jobs/queue.ts` accepts one request per connection every 5 minutes (`MANUAL_SYNC_COOLDOWN_SECONDS`). The check and the `last_sync_requested_at` stamp happen in one statement (`request_manual_sync`), so two quick clicks cannot both pass.

The same Server Action (`syncNow` in `src/app/w/[workspace]/connections/actions.ts`) serves a connection's page and the dashboard's stale notice. The notice appears when most or all connections in view have not synced within two poll intervals, and its "Sync now" sends every stale connection at once: one read checks they belong to the workspace, then each goes through `enqueueSync` with its own cooldown, settled one by one, so a failure for one connection is logged with a reference and the answer still says how many were queued. The notice's button is unavailable, with the connection page's hint, only while every stale connection is in its cooldown.

## Retention

The daily retention job deletes, in batches of 1000 rows:

- `oauth_states` whose `expires_at` has passed. A finished connect flow deletes its own state, so these belong to abandoned flows (a closed tab on the provider's consent screen, or GitHub's approval pending path) and still hold a sealed PKCE verifier. They go first, ahead of the larger tables.
- `usage_snapshots` with `snapshot_date` more than 13 months before today (UTC).
- `activity_events` with `occurred_at` more than 13 months ago.
- Finished `sync_jobs` (succeeded or failed) created more than 30 days ago. Queued and running jobs are never deleted.
- `public_rate_limit_counters` older than one day: the per IP rate limit of the public badge, card, and JSON routes and public project pages, and the per-endpoint limit of webhook deliveries, only need the current minute.
- `published_metric_views` with `view_date` more than 13 months before today (UTC), like the history they count.
- Digest delivery records (`notification_deliveries` without a triggered alert) more than 30 days old. Alert delivery records go with their alert.
- `webhook_deliveries` received more than 30 days ago: the deduplication window. Deleting a delivery deletes its job. A provider retrying a delivery later than that would have it processed again, and the `dedupe_key` still stores its events once.

Data exactly 13 months old is kept. Triggered alerts are kept while their rule exists. A run cut short by the tick budget is finished by the next run; running it twice is harmless.

## Run a tick locally

```bash
npm run jobs:tick
```

This calls the same runner as the route, with the settings in `.env.local`, and prints the counts as JSON. It needs no dev server and no `CRON_SECRET`. Run it again to process retries whose time has come.

`npm run jobs:tick -- --watch` keeps running the same tick in a loop, every 10 seconds by default (`--interval <seconds>`, at least 5), and prints one line per tick with the time and the number of jobs synced, timeline events written, failures, and retries, never any data. Each watch tick claims up to 100 jobs of every kind but `webhook` instead of 10, so every simulated connection of a local instance syncs on every tick; `webhook` jobs keep their own claim of up to 50 on top. Ctrl+C or SIGTERM stops it after the tick in progress and exits 0. With `STACKDASH_SIMULATE_PROVIDERS=1` (local only, refused on a Vercel production deployment) every live provider is simulated in that process, and each iteration first makes the active connections the simulator made due (their granted scope is `simulated:read`), so they sync on every tick and open screens update continuously. A real connection is never made due early, whatever its provider. On its normal schedule the simulator refuses its real credential rather than fill it with made-up data: the sync is retried, the connection is marked failed with one timeline event, and it syncs again on its hourly retry once the flag is removed. Without the flag it says so once and runs the normal tick, which syncs connections only when they are due. Without `--watch` the script runs one tick, as above.

`--volume <1-20>` (watch only) multiplies the simulated timeline events each sync makes, so local screens fill faster: `npm run jobs:tick -- --watch --volume 10` makes about ten times as many deployments, payments, signups, and other random events. The default, 1, is the realistic small product and makes exactly what the simulator makes without the option. Events on a calendar (daily summaries, monthly invoices, fixed schedules) do not scale. It needs `--watch` and `STACKDASH_SIMULATE_PROVIDERS=1`: without either, or with anything but a whole number from 1 to 20, the script refuses and exits 2 before any tick runs. The watcher swaps only the simulated adapters for the same providers' adapters at that volume, so provider metrics (spend, usage, quotas), real providers, the sync cadence, the 100 job claim limit, and `npm run demo:event` incidents stay as they are. Counts the app derives from timeline events (dashboard markers and headline counts, and public metrics such as signups or deployments in 30 days) rise with the volume and stay raised until those events age out, so use a workspace whose numbers do not need to stay realistic. Like the simulator it is local only. The startup line names the volume, for example `Watching: a tick every 10 seconds at volume 10, with simulated connections synced on every tick.`

The flag is read once, when the watcher starts, so restart a running watcher after changing `.env.local`. When there is nothing to stream, the watcher says why once instead of printing `synced 0` forever: with simulation off it gives the sync cadence and the setting to add, and with simulation on but no active simulated connection it says to connect one or reconnect the ones that need attention (and again only if none is active). Without simulation, connections sync when due: hourly for most providers, every 15 minutes for Supabase. The Example provider is never simulated and adds a signup and a deployment each day.

`npm run demo:seed` (local stack only) builds a demo workspace by replaying 90 days through the same `runSyncJob` and `runDailySummaryJob` a tick runs, one step per London day (the last slot before London midnight) with the jobs' clock and the adapters' clock set to that day. It calls the jobs directly for its own connections instead of claiming from `sync_jobs`, because a claim would also pick up other workspaces' jobs and run them on the moved clock. Its last step is the present, so a watch started afterwards continues from the replay's cursors. `npm run demo` runs the same seed and then starts that watch itself, in the same process, until Ctrl+C. See [Local development, step 11](../development.md#11-what-the-demo-command-builds-optional).

`npm run demo:event -- --type failed-deployment|budget-crossing` (local stack only, same refusal as the seed) makes one incident happen now in the demo workspace, or in the workspace `--workspace <slug>` names. It builds a simulated Vercel adapter that carries the incident (an extra failed deployment, or spend read past the highest budget alert threshold that covers Vercel) and runs one `runSyncJob` for that workspace's simulated Vercel connection, the same direct call the seed makes, so validation, ingest, Realtime, and alert evaluation are the real ones. It does not deliver: an alert it triggers keeps `dispatched_at` null, and the next tick's `alert_dispatch` sends it like any other. A watcher may sync the same connection at the same moment; the event's dedupe key keeps that harmless, and the watcher's next sync reads the usual spend again.

**Explore with sample data** (only while `STACKDASH_SIMULATE_PROVIDERS=1`) is the in-app version for one workspace: an owner or admin of a workspace with no connections selects it on the empty timeline, and the Server Action connects every simulated provider through `completeConnection` (which queues each one's initial sync as usual), then replays the current UTC week and the day before it through the seed's `replayHistory`, at most nine steps ending at the present, so the timeline, the billing period cards, and the dashboard headline's week to date have figures when the page opens (the day before the week is what the week's first day is measured from). Replayed alerts count as already sent, as the seed's do. The queued initial jobs still run on the next tick and continue from the cursors the replay left. With `npm run jobs:tick -- --watch` running, a watch tick can claim one of those initial syncs while the replay's direct `runSyncJob` calls for the same connection are still running, the case the one-open-sync rule (`sync_jobs_one_open_sync_per_connection`) otherwise prevents. It is harmless here: events insert on `(workspace_id, dedupe_key)` and skip duplicates, snapshots upsert per day, the simulator never moves a cursor back or reads a slot behind it, and a freshly minted simulated credential never needs a refresh. The most it costs is that, if the watcher's sync lands before the replay's earlier days, those days still get their daily readings but not their half hour of events.

To call the route itself (dev server running):

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/jobs/tick
```

Without the header, with a wrong secret, or when `CRON_SECRET` is unset or shorter than 32 characters, the route answers `401`.

## Register the pg_cron job

The `pg_cron` and `pg_net` extensions are installed by migration. The cron job is environment configuration: it carries the deployment URL and `CRON_SECRET`, so it is registered once per environment in the Supabase SQL editor, never in a migration. Both values are kept in [Supabase Vault](https://supabase.com/docs/guides/database/vault), following the Supabase guide [Scheduling Edge Functions](https://supabase.com/docs/guides/functions/schedule-functions) (pg_cron plus pg_net with secrets in Vault).

1. Store the app URL and the secret in Vault. Use the same `CRON_SECRET` value as the deployment.

   ```sql
   select vault.create_secret('https://stackdash.example.com', 'stackdash_app_url');
   select vault.create_secret('<CRON_SECRET value>', 'stackdash_cron_secret');
   ```

2. Schedule the tick every minute:

   ```sql
   select cron.schedule(
     'stackdash-jobs-tick',
     '* * * * *',
     $$
     select net.http_post(
       url := (select decrypted_secret from vault.decrypted_secrets where name = 'stackdash_app_url') || '/api/jobs/tick',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'stackdash_cron_secret')
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
   where jobid = (select jobid from cron.job where jobname = 'stackdash-jobs-tick')
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
    (select id from vault.secrets where name = 'stackdash_cron_secret'),
    '<new CRON_SECRET value>'
  );
  ```

- New URL: the same with `stackdash_app_url`.
- Pause or remove: `select cron.unschedule('stackdash-jobs-tick');` Run step 2 again to restore it.

### Self-hosted and local Supabase

A self-hosted install registers the job with the same SQL, in its own Supabase project, with its own app URL and `CRON_SECRET`. For the local Supabase CLI stack and a dev server on your computer, the URL the database can reach is `http://host.docker.internal:3000`. Any other scheduler that can send the same `POST` with the bearer header every minute works too.

Alert email needs a Resend account with a verified sending domain on a self-hosted install too: set `STACKDASH_RESEND_API_KEY` and `STACKDASH_EMAIL_FROM`. Without the key, alerts still show in the app and reach channels.

## Where to look when syncs stop

- `connections.status`, `last_error_code`, `last_error_reference` for one connection; search the server logs for the reference id.
- `sync_jobs` for the queue: `status`, `attempts`, `run_after`, `error_code`. A `running` job whose `locked_until` passed belongs to a tick that died; the next tick reclaims it.
- `webhook_deliveries` (`status`, `received_at`, `processed_at`) and the `webhook` jobs in `sync_jobs` for pushed events; `webhook.rejected` and `webhook.secret_missing` in the server logs for deliveries the route refused.
- `cron.job_run_details` and `net._http_response` for whether ticks reach the app at all.
