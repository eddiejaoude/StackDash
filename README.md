# DevMacro

The big picture of your developer stack.

DevMacro is an open-source dashboard with one timeline and one alert for your whole developer stack.
You connect GitHub, Vercel, Stripe, Supabase, Resend, DigitalOcean, PostHog, Polar, Sentry,
Railway, and GitLab over OAuth (never with pasted provider keys), and DevMacro syncs them on a schedule:
deploys, stars, signups, payments, and errors land in one feed per workspace and project. Alerts
reach you by email, Slack, Discord, or webhook before a limit or budget becomes a problem, with
daily or weekly digests on the same channels. Unusual daily spend and usage is flagged on the
timeline with no setup. The dashboard opens with up to three sentences on what was unusual in the
last week and the deploys, payments, signups, and stars of the same day, then revenue against
spend, signups, cost per signup, and deploys for the week or month so far, marks deploys,
payments, signups, stars, and alerts on its trend charts, and projects spend and quotas to the
end of the period, labeled as estimates. Publish the stats you choose as a project page, README
badges, and cards, read a workspace from your own scripts through a read-only REST API or from
an AI assistant through a read-only MCP server, and see spend and allowances where each provider
reports them.

The timeline groups events under sticky London-day labels. A neutral spine connects provider
nodes in newest-first order, not cause and effect. Times sit in a left gutter on desktop and
above each event on smaller screens. Severity remains labeled in words, and repeated events
expand to show their individual timestamps. Select an event to inspect its full text, exact time,
and source link in a right-hand panel, or a full-screen view on mobile. Newer and older controls
follow the current page. Copy an event link to reopen it later, even when it is outside the loaded
page or filters; workspace access still applies. Escape or Close event returns to the timeline
without losing your scroll position or expanded groups.

**Status:** MVP for invited testers. Sign-in is GitHub only and limited to emails on the invite
list. Inbound provider webhooks come after the MVP; data arrives by scheduled sync. Every built
integration comes from the provider's documentation and none has been tried with a real account
yet; each provider page in [docs/providers](docs/providers) lists what is still unverified. Until
Sentry approves the hosted integration's publication, only the organization that registered it can
install it; self-hosters register their own ([Sentry provider page](docs/providers/sentry.md)).

## Stack

- Next.js 16 (App Router, Cache Components, Server Actions) and React 19
- TypeScript (strict), Zod for validation
- Tailwind CSS 4
- Supabase: Postgres with row level security, Auth (GitHub), `pg_cron` and `pg_net` for scheduled
  syncs, run locally with the Supabase CLI
- Vitest for unit tests, pgTAP (`supabase test db`) for database tests, Playwright with axe for
  end-to-end tests
- Hosted on Vercel with a Supabase project, see [Deploy](docs/operations/deploy.md)

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
git clone https://github.com/eddiejaoude/DevMacro.git
cd DevMacro
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
repository (they share the project id `devmacro`), `supabase start` says so and changes nothing:
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
needs one dashboard step instead: [Deploy, JWT signing keys](docs/operations/deploy.md#jwt-signing-keys).

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

Generate the two secrets and paste them into `DEVMACRO_ENCRYPTION_KEY` and `CRON_SECRET`:

```bash
openssl rand -base64 32   # DEVMACRO_ENCRYPTION_KEY: exactly 32 random bytes, base64
openssl rand -hex 32      # CRON_SECRET: 64 hex characters
```

Turn on the simulated providers, which the demo in step 6 connects instead of real ones (step 10
says what they are). Set this line in `.env.local`:

```bash
DEVMACRO_SIMULATE_PROVIDERS=1
```

Leave the provider variables empty. Every variable is described in
[Environment variables](#environment-variables) and in `.env.example`.

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
[Database schema](docs/architecture/schema.md) for what it contains, then run it with `psql`:

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
[OAuth apps, GitHub OAuth app for sign-in](docs/operations/oauth-apps.md#github-oauth-app-for-sign-in).
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
DEVMACRO_ENABLE_FAKE_PROVIDER=1
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
runs up to 10 queued jobs, and prints the counts as JSON. It needs no dev server and no
`CRON_SECRET`. An open dashboard, timeline, alerts, or connections page updates by itself within a
few seconds of the tick, with no reload. In production `pg_cron` calls `POST /api/jobs/tick` every
minute instead, see [Jobs](docs/operations/jobs.md).

Most connections are due once an hour (Supabase every 15 minutes), and the Example provider adds a
signup and a deployment each day, so running the tick again soon after usually brings nothing new.
For data that keeps arriving, use step 10.

### 10. Simulate every provider and watch it update live (optional)

Simulated providers let you try DevMacro with Vercel, GitHub, Resend, Stripe, Supabase, DigitalOcean, PostHog, Polar, Sentry, Railway, and GitLab
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
   DEVMACRO_SIMULATE_PROVIDERS=1
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
   simulated connection on each tick (up to 100 jobs per tick), and prints one line per tick with
   the time and the number of jobs synced, events written, and failures. Press Ctrl+C to stop it
   after the current tick.

   It reads `.env.local` once, when it starts: if you add the flag while a watcher is already
   running, stop it and start it again.
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

Remove the flag and restart to go back to the real providers. Simulated connections then refuse to
sync rather than mix made-up data with real data: their next sync sends nothing to the provider
and marks them as needing attention. Delete them from their connection page. A simulated
connection cannot be reconnected with a real provider, nor a real one with the simulator.

Note for local use: a real connection you made before turning the flag on is never synced early
by `--watch`, but while the flag is on its scheduled syncs are refused by the simulator. It is
marked failed with one timeline event, and syncs again on its hourly retry once the flag is
removed. That event's advice to reconnect applies only once `DEVMACRO_SIMULATE_PROVIDERS` is
removed: while the flag is on, a reconnect is refused, so leave the connection alone and it
recovers on its own after the flag is gone.

### 11. What the demo command builds (optional)

`npm run demo` from step 6 builds a whole workspace on your local stack with every simulated
provider connected and 90 days behind it, signs you in to it, and keeps it updating live, so a demo
is not mostly empty charts. No GitHub OAuth app is needed. It needs the stack from step 3,
`.env.local` from step 4 with `DEVMACRO_SIMULATE_PROVIDERS=1`, and `npm run dev` running.

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
  `DEVMACRO_SIMULATE_PROVIDERS=1` is set and `NEXT_PUBLIC_SUPABASE_URL` points at this computer,
  and only for the demo account: anywhere else, `/auth/confirm` answers every link as expired.
- It then runs `npm run jobs:tick -- --watch` itself, carrying on from the replay's last sync
  without a gap or a repeat. Press Ctrl+C to stop it after the tick in progress.
- `--member you@example.com` also adds an account that has already signed in with GitHub (step 7)
  as an admin of the demo workspace; repeat it for more people (an email given twice counts once,
  and `demo@example.com` is refused because it already owns the workspace). `--seed <text>` picks
  different simulated accounts; the same seed rehearses the same demo (default `devmacro-demo`).
- Running it again deletes the demo workspace and builds a new one, so there is only ever one. It
  changes nothing outside the demo account's workspaces.
- It refuses to run, and writes nothing, unless `DEVMACRO_SIMULATE_PROVIDERS=1` is set and
  `NEXT_PUBLIC_SUPABASE_URL` points at this computer (`localhost`, `127.x.x.x`, or `[::1]`), so it
  can never write to a hosted project.

Building the workspace takes seconds (7 on a local stack). Stop any other
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
DEVMACRO_EMAIL_FROM=DevMacro alerts <alerts@example.com>
DEVMACRO_RESEND_API_KEY=local-fake-key
DEVMACRO_RESEND_API_URL=http://127.0.0.1:55430
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
secret scanning and push protection are not on for this repository yet: turning them on is a
manual step in [Hosted instance runbook, what stays Eddie's](docs/internal/hosted-instance.md#what-stays-eddies), and until
then the CI gitleaks scan is the only automated secret check. Run the scan locally from a normal
clone (not a git worktree) with:

```bash
docker run --rm -v "$PWD:/repo:ro" -w /repo ghcr.io/gitleaks/gitleaks:v8.30.1 detect --source . --redact --verbose
```

Never commit a credential-shaped value, even a sample: use a placeholder such as `<access-token>`
in docs and build fake keys at runtime in tests. `.gitleaks.toml` allowlists only exact
already-pushed commits that added such a value, once the current tree no longer has it.

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
the fake provider, so `.env.local` must contain `DEVMACRO_ENCRYPTION_KEY`, `CRON_SECRET`, and the
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
`DEVMACRO_ALLOW_PRIVATE_WEBHOOKS=1` into `.env.local`, because its production build refuses to
post to `e2e/alert-channels.spec.ts`'s receiver on 127.0.0.1 without it. A local run on the dev
server needs neither in `.env.local`.

The tick is instance-wide: it syncs the due connections of every workspace, including the ones
other specs seed, so a spec that runs it would break them if it ran beside them. Such specs
(`e2e/simulated-providers.spec.ts` and `e2e/alert-email.spec.ts`) live in a second Playwright
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

## Environment variables

See [`.env.example`](.env.example) for where each value comes from. Values are never committed.
Public variables are inlined into the browser bundle at build time; every other variable is server
only and must never get a `NEXT_PUBLIC_` prefix.

| Variable | Purpose | Kind | Required |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Public origin for absolute metadata URLs (the canonical address, `og:url`, and preview image of the landing page, the docs, the privacy policy and terms of use, and public project pages, left out while it is unset), provider callback URLs, the sitemap and robots.txt, the `formulaUrl` links in the public metrics route, and the links in alert emails and channel messages; falls back to the request origin, and to `http://localhost:3000` for alert links in development | Public | Optional, but a production build sends no alert email or channel message without it |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API URL | Public | Required |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key; row level security limits what it can read | Public | Required |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key; bypasses row level security | Secret | Required |
| `DEVMACRO_ENCRYPTION_KEY` | AES-256-GCM key for stored provider credentials | Secret | Required to connect providers and sync |
| `DEVMACRO_ENCRYPTION_KEYS_PREVIOUS` | Old keys kept readable during key rotation, `keyId:base64Key` comma separated | Secret | Optional (only while rotating) |
| `CRON_SECRET` | Bearer secret for `POST /api/jobs/tick`, at least 32 characters | Secret | Required where a scheduler calls the route |
| `DEVMACRO_SUPER_ADMIN_EMAILS` | Comma separated email addresses of the people who can open the [instance overview](#instance-overview) at `/app/admin`, matched without regard to case against the email they sign in with | Server only | Optional (empty means nobody) |
| `DEVMACRO_EMAIL_FROM` | Sender of alert emails, optionally with a name: `DevMacro alerts <alerts@your-domain>`, on a domain verified in the Resend account | Server only | Required with `DEVMACRO_RESEND_API_KEY` |
| `DEVMACRO_RESEND_API_KEY` | Resend API key with sending access. Alert email goes only through Resend, so a self-hosted install needs a Resend account and a verified sending domain. Locally any value, with the fake from step 12 | Secret | Optional (without it email is off) |
| `DEVMACRO_RESEND_API_URL` | Another server that answers like Resend's API, instead of `https://api.resend.com`: https, or plain http only to this computer; scheme, host, and port only. Locally `http://127.0.0.1:55430`, the fake that `npm run email:fake` starts (step 12) | Server only | Optional (needs `DEVMACRO_RESEND_API_KEY`) |
| `DEVMACRO_ALLOW_PRIVATE_WEBHOOKS` | Set to `1` to let generic webhook channels post to plain http and private network addresses in a production build; checked on every post. Development allows them anyway | Server only | Optional (self-hosted instances on their own network and the CI e2e run; never on a hosted instance) |
| `DEVMACRO_TRUSTED_PROXY_COUNT` | Self-hosted installs: how many proxies in front of the app append the client address to `x-forwarded-for`, a whole number from 1 to 9. The per IP rate limit of the public badge, card, and metrics routes and public project pages reads the entry that many places from the right. The app must sit behind a proxy that appends to `x-forwarded-for`: reached directly, a client can claim any address and the limit counts per claimed address. Ignored on Vercel (`VERCEL=1`), which reads `x-vercel-forwarded-for` | Server only | Optional (1 when unset) |
| `DEVMACRO_OPERATOR_NAME` | Who runs this instance, named as responsible for its data on `/privacy` and `/terms`. Set all three operator variables or none: with none, both pages answer 404 and the sign-in page, footer, and sitemap do not link to them. The policy names Vercel as a processor only on Vercel (`VERCEL=1`), Resend only when alert email goes to Resend's own API (`DEVMACRO_RESEND_API_KEY` set, `DEVMACRO_RESEND_API_URL` unset or `https://api.resend.com`), and a generic email service when `DEVMACRO_RESEND_API_URL` names another server. Read at build time by the prerendered pages, together with `VERCEL` and the email variables, so rebuild after changing any of them; a half-set email configuration then fails the build | Server only | Optional (required to publish the privacy policy and terms) |
| `DEVMACRO_OPERATOR_EMAIL` | One email address for privacy and data requests, shown on both pages | Server only | With `DEVMACRO_OPERATOR_NAME` |
| `DEVMACRO_GOVERNING_LAW` | The law the terms of use are governed by, as it reads after "the law of", such as `England and Wales` | Server only | With `DEVMACRO_OPERATOR_NAME` |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` | Sign-in GitHub OAuth app client ID, read by the Supabase CLI only | Secret (local CLI only) | Required by `supabase start` (placeholder allowed) |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` | Sign-in GitHub OAuth app client secret, read by the Supabase CLI only | Secret (local CLI only) | Required by `supabase start` (placeholder allowed) |
| `VERCEL_CLIENT_ID` | Vercel Integration client ID | Server only | Optional (enables Vercel) |
| `VERCEL_CLIENT_SECRET` | Vercel Integration client secret | Secret | Optional (enables Vercel) |
| `VERCEL_INTEGRATION_SLUG` | Vercel Integration URL slug | Server only | Optional (enables Vercel) |
| `GITHUB_APP_CLIENT_ID` | GitHub App client ID (billing data, not sign-in) | Server only | Optional (enables GitHub) |
| `GITHUB_APP_CLIENT_SECRET` | GitHub App client secret | Secret | Optional (enables GitHub) |
| `GITHUB_APP_SLUG` | GitHub App URL slug | Server only | Optional (enables GitHub) |
| `GITHUB_APP_ID` | GitHub App numeric ID | Server only | Optional (enables GitHub) |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key, PEM with `\n` newlines | Secret | Optional (enables GitHub) |
| `RESEND_CLIENT_ID` | Resend OAuth client ID | Server only | Optional (enables Resend) |
| `RESEND_CLIENT_SECRET` | Resend OAuth client secret | Secret | Optional (enables Resend) |
| `POLAR_CLIENT_ID` | Polar OAuth client ID | Server only | Optional (enables Polar) |
| `POLAR_CLIENT_SECRET` | Polar OAuth client secret | Secret | Optional (enables Polar) |
| `SENTRY_CLIENT_ID` | Sentry integration client ID | Server only | Optional (enables Sentry) |
| `SENTRY_CLIENT_SECRET` | Sentry integration client secret, also signs token refreshes | Secret | Optional (enables Sentry) |
| `SENTRY_INTEGRATION_SLUG` | Sentry integration slug | Server only | Optional (enables Sentry) |
| `STRIPE_APP_CLIENT_ID` | Stripe App client ID | Server only | Optional (enables Stripe) |
| `STRIPE_APP_SECRET_KEY` | Live secret key of the Stripe App's account, used for the token exchange | Secret | Optional (enables Stripe) |
| `STRIPE_APP_TEST_SECRET_KEY` | Test mode secret key for test mode installs | Secret | Optional |
| `SUPABASE_OAUTH_CLIENT_ID` | Supabase OAuth app client ID | Server only | Optional (enables Supabase) |
| `SUPABASE_OAUTH_CLIENT_SECRET` | Supabase OAuth app client secret | Secret | Optional (enables Supabase) |
| `DIGITALOCEAN_CLIENT_ID` | DigitalOcean OAuth app client ID | Server only | Optional (enables DigitalOcean) |
| `DIGITALOCEAN_CLIENT_SECRET` | DigitalOcean OAuth app client secret | Secret | Optional (enables DigitalOcean) |
| `POSTHOG_OAUTH_CLIENT_ID` | URL of PostHog's client ID metadata document, exactly `<SITE_URL>/oauth/posthog/client-metadata` | Server only | Optional (enables PostHog) |
| `POSTHOG_OAUTH_PRIVATE_KEY` | Private key that signs PostHog token requests, PEM with `\n` newlines | Secret | Optional (enables PostHog) |
| `RAILWAY_CLIENT_ID` | Railway OAuth app client ID | Server only | Optional (enables Railway) |
| `RAILWAY_CLIENT_SECRET` | Railway OAuth app client secret | Secret | Optional (enables Railway) |
| `GITLAB_CLIENT_ID` | GitLab.com OAuth application ID | Server only | Optional (enables GitLab) |
| `GITLAB_CLIENT_SECRET` | GitLab.com OAuth application secret | Secret | Optional (enables GitLab) |
| `DEVMACRO_ENABLE_FAKE_PROVIDER` | Set to `1` to offer the fake provider and its consent screen | Test only | Optional (never in production) |
| `FAKE_PROVIDER_CLIENT_ID` | Any non-empty value for the fake provider | Test only | Optional (with the fake provider) |
| `FAKE_PROVIDER_CLIENT_SECRET` | Any non-empty value for the fake provider | Test only | Optional (with the fake provider) |
| `DEVMACRO_SIMULATE_PROVIDERS` | Set to `1` to replace the live providers with simulated ones that need no OAuth app | Local only | Optional (refused on Vercel production) |
| `E2E_PORT` | Port of the Playwright dev server, read from the shell (default 3100) | Test only | Optional |
| `E2E_RESEND_PORT` | Port of the fake Resend API that Playwright starts for `e2e/alert-email.spec.ts`, read from the shell (default `E2E_PORT` plus one) | Test only | Optional |

A provider with any required variable empty shows as not set up in the connection catalog; the
rest of the app keeps working. Each provider callback URL is
`<SITE_URL>/api/connections/<provider>/callback`.

## Operations

Every Markdown file under `docs/` except `docs/internal/` is also published on the website at
`/docs`, rendered at build time.

- [Deploy to Vercel and Supabase](docs/operations/deploy.md): Supabase project, forward-only
  migrations, Auth settings, Vercel project, environment variables, secrets, and verification.
- [Register the OAuth apps](docs/operations/oauth-apps.md): the sign-in GitHub OAuth app and the
  11 provider apps, with per-provider details in [`docs/providers/`](docs/providers).
- [Jobs](docs/operations/jobs.md): the sync scheduler, retries, retention, and the `pg_cron` job.
- [REST API](docs/api.md): read-only API keys with scopes, the `/api/v1` endpoints with `curl`
  examples, and the OpenAPI document at `/docs/api/openapi.json`.
- [MCP server](docs/mcp.md): connect Claude Code, Claude Desktop, Cursor, or another MCP client to
  a workspace with an API key, and the read-only tools it can call.
- [Write a provider adapter](docs/adapters.md): the adapter contract, the example adapter to
  copy, the test harness, every file a new provider touches, the provider page template, and how
  adapters are reviewed. Ask for a new provider with the **Adapter request** issue template.

### Invite testers

```bash
npm run invite -- tester@example.com            # add the email to public.access_invites
npm run invite -- tester@example.com --remove   # stop new sign-ups with that email
```

The script reads `.env.local` when present, otherwise `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` from the environment. Removing an invite does not delete an existing
account. For production, follow [Deploy, invite testers](docs/operations/deploy.md#4-invite-testers).

### Instance overview

`/app/admin` shows a super admin how this server is configured and used: whether each environment
variable above is set (never its value) and what that means, which provider OAuth apps are
registered and how many workspaces use each provider, the background job queue and its failures in
the last 24 hours, users, workspaces with their members and timeline events, and whether the
database has this build's migrations. Super admins are the addresses in
`DEVMACRO_SUPER_ADMIN_EMAILS`; anyone else gets page not found. A super admin reaches it from the
Admin link in the workspace header on wider screens (the `lg` breakpoint, 1024 pixels, and up), or
from the Admin command in the command palette at every width, which is the way in on a phone;
neither is sent to anyone else. Each view is logged with the viewer's user id (`admin.viewed`).
Locally, add your GitHub email to `.env.local` and restart `npm run dev`.

### Rotate the encryption key

`npm run keys:rotate` re-encrypts stored credentials under the current key without downtime. The
full procedure is in the header of `scripts/rotate-encryption-key.ts`:

1. Generate a new key with `openssl rand -base64 32`.
2. Work out the id of the key in use now, the first 8 hex characters of its SHA-256:
   `printf '%s' "$OLD_KEY" | openssl base64 -d -A | shasum -a 256 | cut -c1-8` (the script also
   prints the current key id on every run).
3. Set `DEVMACRO_ENCRYPTION_KEY` to the new key, add the old one to
   `DEVMACRO_ENCRYPTION_KEYS_PREVIOUS` as `oldKeyId:oldBase64Key`, and deploy. New credentials use
   the new key and old rows still decrypt.
4. Once every running instance has the new configuration, run `npm run keys:rotate` with that
   environment's variables. It prints counts only and is safe to re-run; repeat until "remaining"
   is 0.
5. After pending OAuth states sealed with the old key have expired, remove the old entry from
   `DEVMACRO_ENCRYPTION_KEYS_PREVIOUS` and deploy again.

Rows that cannot be decrypted are counted as unreadable and left untouched (exit code 1); those
connections need reconnecting, and those alert channels need removing and adding again with their
URL (alert settings marks them as needing attention after their next message).

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
    timeline/                  event list and filters
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
  getting-started.md           first steps for people using DevMacro, from sign-in to a published metric
  mcp.md                       the MCP server: connecting an assistant, tools, resources, prompts
  architecture/concepts.md     workspaces, connections, accounts, projects: what each is for
  architecture/schema.md       tables, relationships, functions
  architecture/public-metrics.md  publishable metrics: rules, formulas, and the read API
  operations/                  deploy, OAuth apps, jobs
  internal/                    hosted instance runbook, kept in the repository, not published at /docs
  providers/                   one page per provider: app setup, permissions, data read
```

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open an issue or a pull request: it covers the
issue templates, setup and checks, branch and commit conventions, the review process, and the
rules changes are reviewed against. The license and the contribution terms are not decided yet;
CONTRIBUTING.md says what that means for you. Everyone taking part follows the
[code of conduct](CODE_OF_CONDUCT.md). Report security vulnerabilities privately, as
[SECURITY.md](SECURITY.md) describes, never in a public issue.

## Third-party marks

The platform logos on the landing page use path data from [Simple Icons](https://simpleicons.org)
(CC0-1.0). The logos remain trademarks of their owners and identify the integrations DevMacro
connects to. Their use implies no endorsement.
