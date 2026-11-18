# Local development

Run StackDash on your own computer from a fresh clone, run the checks a pull request needs, and find your way around the code. To try StackDash with simulated data only, the [README](../README.md#try-it-with-simulated-data) has the short version of steps 1 to 6.

## Stack

- Next.js 16 (App Router, Cache Components, Server Actions) and React 19
- TypeScript (strict), Zod for validation
- Tailwind CSS 4
- Supabase: Postgres with row level security, Auth (GitHub), `pg_cron` and `pg_net` for scheduled
  syncs, run locally with the Supabase CLI
- Vitest for unit tests, pgTAP (`supabase test db`) for database tests, Playwright with axe for
  end-to-end tests
- Hosted on Vercel with a Supabase project, see [Deploy](operations/deploy.md). Vercel Web
  Analytics counts page views on Vercel deployments only, so a self-hosted install loads no
  analytics script

## Run it locally

Follow these steps in order from a fresh clone. Every command runs from the repository root. Steps
1 to 6 end in a demo workspace with 90 days of simulated history, signed in, without registering any
OAuth app. Steps 7 to 12 add real GitHub sign-in, the fake provider, syncs, and email.

### 1. Prerequisites

- Node.js 22.13 or later in the 22 line, and npm. CI and the hosted app on Vercel both use Node.js
  22, and `.nvmrc` says the same, so `nvm install` installs the latest 22 and selects it. The floor
  comes from `package-lock.json`: `@supabase/supabase-js` and its packages need Node.js 22, Vite and
  Rolldown (used by Vitest) and `@axe-core/playwright` need 22.12, and `eslint-visitor-keys` 5 (used
  by typescript-eslint) needs 22.13. The `engines` field in `package.json` holds the same range,
  `^22.13.0`: Vercel reads it to choose the Node.js version it deploys, so it stays on the version CI
  tests. On Node.js 24 or later, `npm ci` warns `EBADENGINE` and carries on.
- Docker running (Docker Desktop, OrbStack, or another Docker-compatible runtime).
- The [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started),
  version 2.120 or later, for example `brew install supabase/tap/supabase`. CI pins 2.120.0, the
  version that generated the committed database types.
- `openssl`, to generate secrets.

### 2. Clone and install

```bash
git clone https://github.com/eddiejaoude/StackDash.git
cd StackDash
npm ci
```

### 3. Start the local Supabase stack

`supabase/config.toml` enables GitHub sign-in and reads its OAuth credentials with
`env(SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID)` and `env(SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET)`. The
CLI refuses to start when they are unset, so export placeholders first:

```bash
export SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID=local-placeholder
export SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET=local-placeholder
supabase start
```

Placeholders are enough for everything except signing in with your own GitHub account: the demo in
step 6 signs you in as the demo account without GitHub, and the checks and the end-to-end suite
never sign in through GitHub. Step 7 sets up real GitHub sign-in.

The first start downloads the images, applies every migration in `supabase/migrations/`, and loads
`supabase/seed.sql`. If the stack is already running, for example from another clone of this
repository (they share the project id `stackdash`), `supabase start` says so and changes nothing:
carry on with step 4. The stack uses ports 55420 to 55429, so it runs beside other local Supabase
projects:

| Service | Address |
| --- | --- |
| API | `http://127.0.0.1:55421` |
| Database | `postgresql://postgres:postgres@127.0.0.1:55422/postgres` |
| Studio | <http://localhost:55423> |
| Email inbox (sign-in emails from the local stack) | <http://localhost:55424> |

Stop the stack with `supabase stop`; your data is kept for the next `supabase start`.

Sessions are verified inside the app, without a call to Auth per request: the CLI signs access
tokens with its built-in ES256 key and publishes the public half at
`http://127.0.0.1:55421/auth/v1/.well-known/jwks.json`, which `supabase.auth.getClaims()` checks
them against. There is no key file to create and nothing to add to `.env.local`. A hosted project
needs one dashboard step instead: [Deploy, JWT signing keys](operations/deploy.md#jwt-signing-keys).

### 4. Create `.env.local`

```bash
cp .env.example .env.local
```

Print the Supabase keys with the names the app expects and paste them into `.env.local`:

```bash
supabase status -o env \
  --override-name api.url=NEXT_PUBLIC_SUPABASE_URL \
  --override-name auth.publishable_key=NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
  --override-name auth.service_role_key=SUPABASE_SERVICE_ROLE_KEY
```

Generate the two secrets and paste them into `STACKDASH_ENCRYPTION_KEY` and `CRON_SECRET`:

```bash
openssl rand -base64 32   # STACKDASH_ENCRYPTION_KEY: exactly 32 random bytes, base64
openssl rand -hex 32      # CRON_SECRET: 64 hex characters
```

Turn on the simulated providers, which the demo in step 6 connects instead of real ones (step 10
says what they are). Set this line in `.env.local`:

```bash
STACKDASH_SIMULATE_PROVIDERS=1
```

Leave the provider variables empty. Every variable is described in [`.env.example`](../.env.example),
and the production values in [Deploy, environment variables](operations/deploy.md#environment-variables).

### 5. Apply migrations and seed data

```bash
supabase migration up
```

After a fresh `supabase start` this has nothing to do; run it after every pull to apply new
migrations without touching your data. Migrations are forward only: add one with
`supabase migration new <name>`, never edit a merged one, and regenerate the types after any schema
change with `npm run db:types` (writes `src/lib/supabase/database.types.ts`, commit it).

`supabase/seed.sql` holds synthetic data (the users `owner@example.com` and `viewer@example.com`,
the workspace Acme, one project, one fake connection, three days of snapshots, a few events). The
CLI loads it only when it creates the database: on the first `supabase start` and on
`supabase db reset`. Never run `supabase db reset` to get it back: it deletes all local data,
including connections and anything other tools share in this stack, and it is never used against a
remote. To load the seed into an empty database by hand, see
[Database schema](architecture/schema.md) for what it contains, then run it with `psql`:

```bash
psql "postgresql://postgres:postgres@127.0.0.1:55422/postgres" -f supabase/seed.sql
```

The seed uses fixed ids, so it fails on a database that already holds them. Seed users have no
password; they exist for tests and for browsing data in Studio.

### 6. Open the demo workspace

Start the app in one terminal and leave it running:

```bash
npm run dev
```

Build the demo workspace in a second terminal:

```bash
npm run demo
```

It creates the account `demo@example.com` and a workspace called **Demo workspace** with every
simulated provider connected and 90 days of history, then prints the dashboard, timeline, and
public page links and a one-time sign-in link. Open the sign-in link in the browser: you land on
the demo workspace's dashboard, signed in as the demo account. The landing page at
<http://localhost:3000> works without signing in. Leave `npm run demo` running to keep data
arriving live, and press Ctrl+C to stop it. The link works once and expires after an hour; run the
command again for a new one, which deletes the demo workspace and builds it again from scratch, so
anything you added to it is gone. Step 11 describes what the command builds and its options.

The links assume the app is on port 3000. If 3000 is taken, do not use the port `npm run dev`
moves to: local Auth returns a GitHub sign-in (step 7) only to port 3000 or a port from 3100 to 3199
(`additional_redirect_urls` in `supabase/config.toml`). Pick a port from 3102 to 3199 (Playwright
uses 3100 and 3101 by default), set `NEXT_PUBLIC_SITE_URL=http://localhost:<port>` in `.env.local`,
start the app with `npm run dev -- --port <port>`, and run `npm run demo` again so the printed links
point at it.

### 7. Sign in with your own GitHub account

Sign-in for real accounts is GitHub only. Register a separate GitHub OAuth app for your local stack
with the callback URL `http://127.0.0.1:55421/auth/v1/callback`, as described in
[OAuth apps, GitHub OAuth app for sign-in](operations/oauth-apps.md#github-oauth-app-for-sign-in).
Export its real client ID and secret instead of the placeholders from step 3 (or put both lines in
`supabase/.env.local`, which is git ignored), and restart the stack so Auth reads them:

```bash
export SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID=<client-id>
export SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET=<client-secret>
supabase stop
supabase start
```

Sign-up is invite only: the `before_user_created` auth hook lets Supabase create a user only when
the email is in `public.access_invites`. Invite the primary verified email of your GitHub account:

```bash
npm run invite -- you@example.com
```

Step 6 left the browser signed in as the demo account, and the sign-in page sends a signed-in
visitor straight back to the app. Choose **Sign out** in the header first. Then, with `npm run dev`
running, open <http://localhost:3000/sign-in> (or `http://localhost:<port>/sign-in` if step 6 moved
the app to another port) and continue with GitHub. After sign-in you land on your personal
workspace timeline.

### 8. Connect the fake provider

The fake provider ("Example provider") is an in-memory provider with a dev-only consent screen. It
lets you walk through connecting and syncing without any real provider app. Set these in
`.env.local` (never in production) and restart `npm run dev`:

```bash
STACKDASH_ENABLE_FAKE_PROVIDER=1
FAKE_PROVIDER_CLIENT_ID=fake-client
FAKE_PROVIDER_CLIENT_SECRET=fake-secret
```

In the app, open your workspace, go to **Connections**, add **Example provider**, and approve the
consent screen. Connecting queues the first sync.

### 9. Run a sync

```bash
npm run jobs:tick
```

This runs one scheduler tick directly with the settings in `.env.local`: it schedules due syncs,
runs up to 10 queued jobs of every kind but `webhook` and up to 50 `webhook` jobs on top, and
prints the counts as JSON. It needs no dev server and no `CRON_SECRET`. An open dashboard,
timeline, alerts, or connections page updates by itself within a few seconds of the tick, with no
reload. In production `pg_cron` calls `POST /api/jobs/tick` every minute instead, see
[Jobs](operations/jobs.md).

Most connections are due once an hour (Supabase every 15 minutes), and the Example provider adds a
signup and a deployment each day, so running the tick again soon after usually brings nothing new.
For data that keeps arriving, use step 10.

### 10. Simulate every provider and watch it update live (optional)

Simulated providers let you try StackDash with Vercel, GitHub, Resend, Stripe, Supabase, DigitalOcean, PostHog, Polar, Sentry, Railway, and GitLab
without registering a single OAuth app. Each one has the real adapter's metric keys and event
types, makes up plausible data on your machine, and runs through the real sync, validation,
alerts, and live updates. Nothing is sent to or read from any provider. Each simulated connection
is marked as simulated when it is made and keeps that mark whether the flag is later on or off, and
a real connection never has it. The connection pages label it **Simulated**. The dashboard and the
timeline say **Simulated** once per page while every connection in view is simulated, and on each
simulated item in a workspace that mixes real and simulated connections. While the flag is on the
catalog labels every provider **Simulated** too.
It is for local use only: the app refuses it on a Vercel production deployment.

1. Check that `.env.local` has the flag from step 4, and restart `npm run dev` if you just added
   it:

   ```bash
   STACKDASH_SIMULATE_PROVIDERS=1
   ```

2. In your workspace, open **Connections** and connect several providers from the catalog, for
   example Vercel, Stripe, and Resend. Each one approves at once and fills the last 30 minutes.
   Or, in a workspace with nothing connected, select **Explore with sample data** on the empty
   timeline: it connects every simulated provider to that workspace and replays the current week
   and the day before it in one step, so the timeline and dashboard have data at once.
   Only owners and admins see it, and only while the flag is on.
3. Keep the data coming:

   ```bash
   npm run jobs:tick -- --watch
   ```

   It runs a tick every 10 seconds (`--interval 30` for every 30 seconds, at least 5), syncs every
   simulated connection on each tick (up to 100 jobs of every kind but `webhook` per tick, and up
   to 50 `webhook` jobs on top), and prints one line per tick with the time and the number of jobs
   synced, events written, and failures. Press Ctrl+C to stop it after the current tick.

   It reads `.env.local` once, when it starts: if you add the flag while a watcher is already
   running, stop it and start it again.

   To fill the screens faster, add `--volume` with a whole number from 1 to 20:

   ```bash
   npm run jobs:tick -- --watch --volume 10
   ```

   Each simulated connection then makes about ten times as many deployments, payments, signups,
   and other random timeline events. The default, 1, is the realistic small product. It needs
   `--watch` and `STACKDASH_SIMULATE_PROVIDERS=1`, and is refused before any tick runs otherwise.
   It scales simulated timeline events only. Provider metrics (spend, usage, quotas), daily
   summaries and other scheduled events, real providers, the sync cadence, the 100 job claim
   limit, and `npm run demo:event` incidents stay as they are. Counts the app derives from
   timeline events (dashboard markers and headline counts, and public metrics such as signups or
   deployments in 30 days) rise with the volume and stay raised until those events age out, so
   use a workspace whose numbers do not need to stay realistic. Like the simulator, it is for
   local use only.
4. Open the dashboard and the timeline: deployments, payments, signups, forks, and Sentry issues
   and releases trickle in, spend and usage grow through the billing period, and the Resend daily
   quota crosses 75 and 90 percent each evening, which triggers allowance alerts if you add them.

If nothing new appears:

- The first line of `jobs:tick -- --watch` says "Provider simulation is off": the flag is missing
  from `.env.local`, or the watcher was started before you added it. Add it and restart the watcher
  and `npm run dev`.
- It says "No active simulated connection": connect providers from step 2, or open the ones that
  need attention and reconnect them; a simulated connection that needs attention is not synced.
  The Example provider from step 8 is not simulated.
- A simulated GitHub connection made before GitHub received webhooks fails every sync with an
  invalid response: its account id changed to a number, like a real GitHub account id. Disconnect
  it and connect GitHub again.

A simulated provider whose real adapter receives webhooks receives them too, through the real
adapter's signature check and mapping. Where the provider has one URL for every account
(`POST /api/webhooks/<provider>`), its deliveries are signed with
`STACKDASH_SIMULATED_WEBHOOK_SECRET` from `.env.local` instead of the provider's own webhook
secret, so simulation never needs one; unset, the URL answers `503`. A provider with one URL per
connection keeps that connection's stored secret. The webhook job applies a delivery to simulated
connections only while the flag is on, and to real connections only while it is off, so a
delivery signed with the simulated secret never reaches a real connection that includes the same
account; it logs any connection it left out as `webhook.targets_dropped`. A delivery to the
shared URL reaches every simulated connection that includes its account. Events that also name
an installation (Sentry's issue deliveries) reach only the connections whose recorded
installation is that one, and a simulated grant's installation is its seed, so post
`installation.uuid` as the connection's `external_installation_id`: any other gets `202` and
nothing on the timeline. A delivery to a per-connection URL reaches that connection only.
Nothing sends deliveries on its own: post one signed the way the provider signs, as the
`e2e/webhooks-<provider>.spec.ts` specs do.

Remove the flag and restart to go back to the real providers. Simulated connections then refuse to
sync rather than mix made-up data with real data: their next sync sends nothing to the provider
and marks them as needing attention. Delete them from their connection page. A simulated
connection cannot be reconnected with a real provider, nor a real one with the simulator.

Note for local use: a real connection you made before turning the flag on is never synced early
by `--watch`, but while the flag is on its scheduled syncs are refused by the simulator. It is
marked failed with one timeline event, and syncs again on its hourly retry once the flag is
removed. That event's advice to reconnect applies only once `STACKDASH_SIMULATE_PROVIDERS` is
removed: while the flag is on, a reconnect is refused, so leave the connection alone and it
recovers on its own after the flag is gone.

### 11. What the demo command builds (optional)

`npm run demo` from step 6 builds a whole workspace on your local stack with every simulated
provider connected and 90 days behind it, signs you in to it, and keeps it updating live, so a demo
is not mostly empty charts. No GitHub OAuth app is needed. It needs the stack from step 3,
`.env.local` from step 4 with `STACKDASH_SIMULATE_PROVIDERS=1`, and `npm run dev` running.

- It creates the account `demo@example.com` (once) and a workspace called **Demo workspace** owned
  by it, connects every simulated provider through the same code as the connect flow, spreads their
  accounts over three projects, and adds a Vercel budget alert and a Resend monthly quota alert.
- It then replays the 90 days before today one at a time, counting days in London (the timeline's
  time zone), then today up to now: each day runs the real sync (with its validation and alert
  checks) and the daily summary job with the clock set to that day, so the history is exactly what
  a live tick would have stored. Each day keeps the last 30 minutes of events before midnight in
  London, as a sync after a pause does. Weekdays are busier than weekends, one Vercel launch day in
  every 30 has a spend spike and a burst of deploys, the Resend monthly quota gets close to its
  limit, and the budget alert triggers in the third week of each full month. The alerts the replay
  triggers count as already sent, so the first tick afterwards emails and posts none of them;
  alerts that trigger once the history runs live are delivered as usual.
- It prints the dashboard, timeline, and public page links, and a one-time sign-in link for
  `demo@example.com`. Open that link in the browser to sign in as the demo account and land on the
  dashboard. The link works once and expires after an hour (`otp_expiry` in
  `supabase/config.toml`); run the command again for a new one. The link only works while
  `STACKDASH_SIMULATE_PROVIDERS=1` is set and `NEXT_PUBLIC_SUPABASE_URL` points at this computer,
  and only for the demo account: anywhere else, `/auth/confirm` answers every link as expired.
- It then runs `npm run jobs:tick -- --watch` itself, carrying on from the replay's last sync
  without a gap or a repeat. Press Ctrl+C to stop it after the tick in progress.
- `--member you@example.com` also adds an account that has already signed in with GitHub (step 7)
  as an admin of the demo workspace; repeat it for more people (an email given twice counts once,
  and `demo@example.com` is refused because it already owns the workspace). `--seed <text>` picks
  different simulated accounts; the same seed rehearses the same demo (default `stackdash-demo`).
- Running it again deletes the demo workspace and builds a new one, so there is only ever one. It
  changes nothing outside the demo account's workspaces.
- It refuses to run, and writes nothing, unless `STACKDASH_SIMULATE_PROVIDERS=1` is set and
  `NEXT_PUBLIC_SUPABASE_URL` points at this computer (`localhost`, `127.x.x.x`, or `[::1]`), so it
  can never write to a hosted project.

Building the workspace takes seconds (22 on a local stack, measured on 2026-11-15). Stop any other
`npm run jobs:tick -- --watch` before you run it. To build the workspace without starting a
watcher, run `npm run demo:seed` with the same options. It prints the same links, sign-in link
included; start `npm run jobs:tick -- --watch` yourself straight after it finishes.

To show an alert firing on cue during the demo, instead of waiting for the simulation to produce
one, make one incident happen now:

```bash
npm run demo:event -- --type failed-deployment
npm run demo:event -- --type budget-crossing
```

- `failed-deployment` adds a failed production deployment of `web` to the simulated Vercel team.
- `budget-crossing` raises this month's simulated Vercel spend to the highest threshold of every
  budget alert that covers Vercel (the seed's **Vercel monthly** budget alert at 90 percent of
  $600, so $540), which triggers those alerts. A budget alert triggers once per billing period:
  if every one of them already did this month (the replay crosses the seed's in the third week),
  the command says so and writes nothing. The next sync reads the usual spend again; the alert
  stays.
- Either way the demo workspace's simulated Vercel connection syncs once through the real sync,
  validation, and alert checks, so a timeline open in the browser shows the event without a
  reload. A triggered alert is emailed and posted like any other by the next tick: keep
  `npm run jobs:tick -- --watch` running, or run `npm run jobs:tick`. With the fake Resend API
  from step 12 running, the email prints there, and a channel added in alert settings gets the
  post.
- `--workspace <slug>` targets another workspace on your stack that has a simulated Vercel
  connection, instead of the demo workspace. It writes nothing outside that one workspace, and it
  refuses to run under the same conditions as the seed.

### 12. Send alert and digest emails locally (optional)

Alert and digest emails go through Resend. Locally they go to a fake Resend API instead, which
prints each email it receives, so nothing leaves your machine and no Resend account is needed. Add
these to `.env.local` and restart `npm run dev` (the key can be any value: the fake accepts the one
set here):

```bash
STACKDASH_EMAIL_FROM=StackDash alerts <alerts@example.com>
STACKDASH_RESEND_API_KEY=local-fake-key
STACKDASH_RESEND_API_URL=http://127.0.0.1:55430
```

Start the fake in its own terminal and leave it running:

```bash
npm run email:fake
```

Then `npm run jobs:tick` sends what is due. A triggered alert goes to the owners and admins whose
alert emails are set to **As each alert happens**, and the first tick of each day sends the
**Daily digest** for the day before to members who chose it in alert settings, in every workspace
with a connection. Each email prints in the fake's terminal, and
<http://127.0.0.1:55430/fake/emails> lists them all. To see how a failed email shows on the
timeline, make the fake refuse the next one:

```bash
curl -X POST -d '{"status":500}' http://127.0.0.1:55430/fake/failures
```

## Checks

The Supabase stack from step 3 must be running for `test:db`, `db:types:check`, and `test:e2e`.

```bash
npm run typecheck        # generate route types, then tsc
npm run lint             # eslint, zero warnings allowed
npm test                 # unit tests (Vitest)
npm run test:db          # database tests in supabase/tests/database (pgTAP, supabase test db)
npm run db:types:check   # fails if src/lib/supabase/database.types.ts is stale
npm run build            # production build
```

CI also runs `supabase db lint --level error --fail-on error`,
`npm audit --audit-level=high --omit=dev`, and a gitleaks scan of the full git history. GitHub
secret scanning and push protection are on for this repository too: push protection blocks a push
that contains a recognized credential, and gitleaks catches what reaches CI. Run the scan locally
from a normal clone (not a git worktree) with:

```bash
docker run --rm -v "$PWD:/repo:ro" -w /repo ghcr.io/gitleaks/gitleaks:v8.30.1 detect --source . --redact --verbose
```

Never commit a credential-shaped value, even a sample: use a placeholder such as `<access-token>`
in docs and build fake keys at runtime in tests. `.gitleaks.toml` allowlists only exact
already-pushed commits that added such a value, once the current tree no longer has it.

Two more workflows run on every pull request. Dependency review
(`.github/workflows/dependency-review.yml`) fails a pull request that adds or changes a dependency
with a known vulnerability of any severity. It judges only what the pull
request changes, so an advisory already on `main` does not fail it; `npm audit` covers the whole
tree. To accept one advisory after reading it, add its GHSA id to the action's `allow-ghsas` input,
with the reason beside it. CodeQL (`.github/workflows/codeql.yml`) analyzes the JavaScript and
TypeScript and the GitHub Actions workflows on pull requests, on pushes to `main`, and weekly. Its
alerts appear on the pull request and in the repository's **Security and quality** tab.

Dependabot (`.github/dependabot.yml`) opens version update pull requests for npm and GitHub Actions
every Monday: one grouped pull request for the minor and patch updates of each ecosystem, and one
per major update, with at most three npm and two GitHub Actions pull requests open at a time.
Packages that `package.json` pins together get one pull request per major: `next` with
`eslint-config-next`, and `react` with `react-dom`, `@types/react`, and `@types/react-dom`.
`@types/node` stays on the Node major in `.nvmrc` (22): raise the `ignore` bound in
`.github/dependabot.yml` when the Node version goes up. Security updates open as soon as an
advisory lands, outside that schedule.

### End-to-end tests

Install the browser once, then run the suite:

```bash
npx playwright install chromium
npm run test:e2e
```

Playwright starts its own dev server on port 3100 (override with `E2E_PORT=3200 npm run test:e2e`),
which loads `.env.local`. The suite needs no GitHub app: `e2e/global-setup.ts` reads the Supabase
keys from `.env.local`, invites and creates the synthetic users `e2e-owner@example.com` and
`e2e-viewer@example.com` through the Auth admin API with a password generated for that run, signs
them in, and saves the sessions in `e2e/.auth/` (git ignored). The connection and sync specs use
the fake provider, so `.env.local` must contain `STACKDASH_ENCRYPTION_KEY`, `CRON_SECRET`, and the
three fake provider values from step 8, as CI writes them. The Playwright config also turns on
the simulated providers from step 10 for its dev server, which `e2e/simulated-providers.spec.ts`
connects and syncs through `POST /api/jobs/tick`. `e2e/real-connection-while-simulating.spec.ts`
checks, without a tick, that a real connection stays unlabeled and cannot be reconnected through
the simulator.

`e2e/alert-email.spec.ts` sends an alert email through the `resend` package and reads it back from
the fake Resend API. Playwright starts the fake itself (`npm run email:fake`, on the app's port
plus one, 3101 by default, or `E2E_RESEND_PORT`) and gives its dev server the fake's URL, a dummy
key, and a sender, which take precedence over `.env.local`, so the spec needs no email settings
and never reaches Resend. Playwright also sets `NEXT_PUBLIC_SITE_URL` to the app server's own
origin, locally and in CI, and that too takes precedence over `.env.local`:
`e2e/social-metadata.spec.ts` reads absolute canonical and preview image addresses from it, and
CI's production build sends no alert message without it. CI also writes
`STACKDASH_ALLOW_PRIVATE_WEBHOOKS=1` into `.env.local`, because its production build refuses to
post to `e2e/alert-channels.spec.ts`'s receiver on 127.0.0.1 without it. A local run on the dev
server needs neither in `.env.local`.

The tick is instance-wide: it syncs the due connections of every workspace, including the ones
other specs seed, so a spec that runs it would break them if it ran beside them. Such specs
(`INSTANCE_WIDE_SPECS` in `playwright.config.ts`: `e2e/simulated-providers.spec.ts`,
`e2e/alert-email.spec.ts`, and every `e2e/webhooks*.spec.ts`, among others) live in a second Playwright
project, `instance-wide`, which depends on the `chromium` project and so starts only after every
other spec has finished. `npm run test:e2e` (and CI) runs both projects in that order; if a
`chromium` test fails, the `instance-wide` specs are skipped. To run the tick specs locally:

```bash
npx playwright test --project=instance-wide        # runs every chromium spec first, then the tick specs
npx playwright test --project=instance-wide --no-deps  # only the tick specs, with nothing else running
npx playwright test --project=chromium              # every spec except the tick specs
```

A file filter does not narrow the `chromium` dependency: it still runs in full. A wrapper that
always passes `--project chromium` skips the tick specs; it needs `--project instance-wide` to
include them.

## Project layout

```text
src/
  proxy.ts                     content security policy, Supabase session refresh, project page addresses, and
                               /app/admin sent to the super admin route for super admins only, so anyone else gets 404
  instrumentation-client.ts    browser setup before hydration: Zod without eval, for the policy
  app/
    page.tsx, layout.tsx       landing page and root layout
    sitemap.ts                 /sitemap.xml: the landing page, /docs and every docs page, the legal pages, and indexable
                               public project pages
    robots.ts                  /robots.txt: public pages allowed, signed-in and API paths disallowed, the sitemap named
    opengraph-image.tsx        /opengraph-image: the site's 1200 by 630 link preview image
    not-found.tsx              not-found page copy, for notFound() calls and unmatched URLs
    global-not-found.tsx       document for URLs that match no route, rendered per request so its
                               scripts carry the policy nonce
    fonts.ts                   fonts shared by the root layout and global-not-found.tsx
    sign-in/                   GitHub sign-in page
    docs/                      the Markdown in docs/ published at /docs, one page per file, except docs/internal/
    privacy/, terms/           privacy policy and terms of use, published only when the operator variables are set
    auth/                      OAuth callback, error page, sign-out
    app/                       entry after sign-in, sends you to a workspace
    super-admin/               the super admin instance overview, answered at /app/admin through the proxy only
    account/                   account page, delete account action, signed-out "account deleted" page
    w/[workspace]/             dashboard, connections, projects, timeline, alerts and alert settings, settings, year in review
    unsubscribe/               signed-out page behind the unsubscribe link in alert emails
    api/connections/[provider]/  provider OAuth start and callback routes
    api/jobs/tick/             scheduler entry point, protected by CRON_SECRET
    api/v1/                    the read-only REST API, one GET route per resource, API key auth
    api/mcp/                   the read-only MCP server (Streamable HTTP), on the same API keys
    api/notifications/unsubscribe/  RFC 8058 one-click unsubscribe for mail clients
    api/dev/fake-provider/     dev-only consent screen of the fake and simulated providers
    api/public/projects/[projectId]/metrics/  published metrics as JSON, for anyone
    badge/, card/              a published metric's live SVG badge and PNG card, for anyone
    p/[workspace]/[slug]/      public project page, answered at /@<workspace>/<slug>
  components/
    sections/                  landing page sections
    app/                       app shell: navigation, workspace switcher, command palette, page states
    account/                   account deletion form and manual revoke steps
    dashboard/                 dashboard view and provider cards
    connections/               connection status and controls
    projects/                  project forms and rules
    public-metrics/            publish, unpublish, self-reported value, and project page controls; the share dialog; history charts
    timeline/                  event list and filters, the event inspector, and the activity overview
    admin/                     instance overview tables and status pills
    alerts/                    alert rules, budgets, triggered alerts
    docs/                      Markdown rendering and the docs list for /docs
    legal/                     the privacy policy and terms of use layout, and the line beside the sign-in button
    ui/                        shared primitives, used instead of writing your own: ProviderMark,
                               ModalDialog (the only <dialog>), buttonClass, LiveRegion and the
                               status and error announcements, DialogError
    *.tsx                      shared UI (site nav, footer, badges, icons)
  lib/
    adapters/                  provider adapters (github, vercel, stripe, supabase, resend, digitalocean, posthog, polar, sentry, railway, gitlab, fake, simulated), registry, the unregistered example adapter, and the contract test harness
    api/                       REST API: key hashing and checks, endpoint list, Zod schemas, OpenAPI document
    mcp/                       MCP server: the read-only tools and provider page resources, client setup snippets
    connections/               connect, OAuth state, revoke
    jobs/                      sync queue, runner, schedule, retries, retention, daily summary
    alerts/                    alert rule schema and evaluation
    notifications/             alert email and channel messages: dispatch, digests, Discord, Slack, webhooks
    email/                     email transport through the `resend` package, and the fake Resend API for local runs and tests
    dashboard/, timeline/      dashboard aggregation and timeline queries
    public-metrics/            public metric definitions, engine, history, published read API, badges, cards, yearly card
    palette/                   command palette: the commands for a workspace, search, and shortcut keys
    data/                      data access per table
    crypto/                    credential encryption and key ids
    auth/, workspaces/, account/  session, redirects, super admins, roles and permissions, account deletion
    admin/                     instance overview: configuration checks, deployment and migration state
    demo/                      the demo workspace, its replayed history, its one-time sign-in link, incidents on cue (npm run demo, demo:seed, demo:event), and in-app sample data
    log/                       structured logger with redaction
    supabase/                  Supabase clients (server, browser, admin) and generated types
    env.ts, site.ts, money.ts, providers.ts  env validation, site constants, money, provider list
    legal.ts                   whether this instance names an operator, and the links to the legal pages
    docs.ts                    reads docs/ for /docs: the page list, titles, and link rewriting
  types/                       ambient type declarations
supabase/
  config.toml                  local stack configuration (ports, GitHub auth, invite hook, seed)
  migrations/                  forward-only SQL migrations
  seed.sql                     synthetic local data
  tests/database/              pgTAP tests (row level security, roles, sync engine)
scripts/                       invite.ts, rotate-encryption-key.ts, tick.ts, demo.ts, demo-seed.ts, demo-event.ts, fake-resend-api.ts
e2e/                           Playwright specs, global-setup.ts, fixtures/
docs/
  adapters.md                  writing a provider adapter: contract, harness, registration, review
  api.md                       the REST API: keys, scopes, endpoints, errors, rate limit
  development.md               this page: local setup, checks, end-to-end tests, project layout
  getting-started.md           first steps for people using StackDash, from sign-in to a published metric
  mcp.md                       the MCP server: connecting an assistant, tools, resources, prompts
  architecture/concepts.md     workspaces, connections, accounts, projects: what each is for
  architecture/schema.md       tables, relationships, functions
  architecture/public-metrics.md  publishable metrics: rules, formulas, and the read API
  operations/                  deploy, OAuth apps, jobs
  internal/                    hosted instance runbook, kept in the repository, not published at /docs
  providers/                   one page per provider: app setup, permissions, data read
```
