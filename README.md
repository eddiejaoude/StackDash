# DevMacro

The big picture of your developer stack.

DevMacro is an open-source dashboard for the usage, spending, quotas, and activity of the developer
services you build on. You connect GitHub, Vercel, Stripe, Supabase, and Resend over OAuth (never
with pasted API keys), and DevMacro syncs their usage on a schedule, shows it per workspace and
project, keeps a timeline of activity, and raises alerts before a limit or budget becomes a problem.

**Status:** MVP for invited testers. Sign-in is GitHub only and limited to emails on the invite
list. Webhooks come after the MVP.

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

Follow these steps in order from a fresh clone. Every command runs from the repository root.

### 1. Prerequisites

- Node.js 20.9 or later and npm (CI uses Node.js 22).
- Docker running (Docker Desktop, OrbStack, or another Docker-compatible runtime).
- The [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started),
  version 2.120 or later, for example `brew install supabase/tap/supabase`. CI pins 2.120.0, the
  version that generated the committed database types.
- `openssl`, to generate secrets.

### 2. Clone and install

```bash
git clone git@github.com:eddiejaoude/DevMacro.git
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

Placeholders are enough for everything except signing in with GitHub in the browser (the checks
and the end-to-end suite never sign in through GitHub). To sign in locally, register a separate
GitHub OAuth app with the callback URL `http://127.0.0.1:55421/auth/v1/callback`, as described in
[OAuth apps, GitHub OAuth app for sign-in](docs/operations/oauth-apps.md#github-oauth-app-for-sign-in),
export its real client ID and secret instead (or put both lines in `supabase/.env.local`, which is
git ignored), and run `supabase stop` then `supabase start` again.

The first start downloads the images, applies every migration in `supabase/migrations/`, and loads
`supabase/seed.sql`. The stack uses ports 55420 to 55429, so it runs beside other local Supabase
projects:

| Service | Address |
| --- | --- |
| API | `http://127.0.0.1:55421` |
| Database | `postgresql://postgres:postgres@127.0.0.1:55422/postgres` |
| Studio | <http://localhost:55423> |
| Email inbox (local SMTP catcher) | <http://localhost:55424> |

Stop the stack with `supabase stop`; your data is kept for the next `supabase start`.

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

Leave the provider variables empty for now; step 8 turns on the fake provider instead. Every
variable is described in [Environment variables](#environment-variables) and in `.env.example`.

### 5. Apply migrations

```bash
supabase migration up
```

After a fresh `supabase start` this has nothing to do; run it after every pull to apply new
migrations without touching your data. Migrations are forward only: add one with
`supabase migration new <name>`, never edit a merged one, and regenerate the types after any schema
change with `npm run db:types` (writes `src/lib/supabase/database.types.ts`, commit it).

### 6. Seed data

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

### 7. Invite yourself and sign in

Sign-up is invite only: the `before_user_created` auth hook lets Supabase create a user only when
the email is in `public.access_invites`. Invite the primary verified email of your GitHub account:

```bash
npm run invite -- you@example.com
npm run dev
```

Open <http://localhost:3000/sign-in> and continue with GitHub. This needs the real GitHub OAuth app
from step 3. After sign-in you land on your personal workspace dashboard. The landing page at
<http://localhost:3000> works without signing in.

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

### 10. Simulate every provider and watch it update live (optional)

Simulated providers let you try DevMacro with Vercel, GitHub, Resend, Stripe, and Supabase
without registering a single OAuth app. Each one has the real adapter's metric keys and event
types, makes up plausible data on your machine, and runs through the real sync, validation,
alerts, and live updates. Nothing is sent to or read from any provider, and every simulated
connection is labeled **Simulated** in the catalog, the connection pages, the dashboard, and the
timeline. It is for local use only: the app refuses it on a Vercel production deployment.

1. Add the flag to `.env.local` and restart `npm run dev`:

   ```bash
   DEVMACRO_SIMULATE_PROVIDERS=1
   ```

2. In your workspace, open **Connections** and connect several providers from the catalog, for
   example Vercel, Stripe, and Resend. Each one approves at once and fills the last 30 minutes.
3. Keep the data coming:

   ```bash
   npm run jobs:tick -- --watch
   ```

   It runs a tick every 10 seconds (`--interval 30` for every 30 seconds, at least 5), syncs every
   simulated connection on each tick, and prints one line per tick with the time and the number
   of jobs synced, events written, and failures. Press Ctrl+C to stop it after the current tick.
4. Open the dashboard and the timeline: deployments, payments, signups, and forks trickle in,
   spend and usage grow through the billing period, and the Resend daily quota crosses 75 and
   90 percent each evening, which triggers allowance alerts if you add them.

Remove the flag and restart to go back to the real providers. Simulated connections then refuse to
sync rather than mix made-up data with real data; delete them from their connection page.

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
manual step in [Deploy, what stays Eddie's](docs/operations/deploy.md#what-stays-eddies), and until
then the CI gitleaks scan is the only automated secret check. Run the scan locally from a normal
clone (not a git worktree) with:

```bash
docker run --rm -v "$PWD:/repo:ro" -w /repo ghcr.io/gitleaks/gitleaks:v8.30.1 detect --source . --redact --verbose
```

Never commit a credential-shaped value, even a sample: use a placeholder such as `<access-token>`
in docs and build fake keys at runtime in tests. `.gitleaks.toml` allowlists only the exact
already-pushed commits that predate this rule.

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
connects and syncs through `POST /api/jobs/tick`.

## Environment variables

See [`.env.example`](.env.example) for where each value comes from. Values are never committed.
Public variables are inlined into the browser bundle at build time; every other variable is server
only and must never get a `NEXT_PUBLIC_` prefix.

| Variable | Purpose | Kind | Required |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SITE_URL` | Public origin for absolute metadata URLs and provider callback URLs; falls back to the request origin | Public | Optional (set in production) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase API URL | Public | Required |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key; row level security limits what it can read | Public | Required |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key; bypasses row level security | Secret | Required |
| `DEVMACRO_ENCRYPTION_KEY` | AES-256-GCM key for stored provider credentials | Secret | Required to connect providers and sync |
| `DEVMACRO_ENCRYPTION_KEYS_PREVIOUS` | Old keys kept readable during key rotation, `keyId:base64Key` comma separated | Secret | Optional (only while rotating) |
| `CRON_SECRET` | Bearer secret for `POST /api/jobs/tick`, at least 32 characters | Secret | Required where a scheduler calls the route |
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
| `STRIPE_APP_CLIENT_ID` | Stripe App client ID | Server only | Optional (enables Stripe) |
| `STRIPE_APP_SECRET_KEY` | Live secret key of the Stripe App's account, used for the token exchange | Secret | Optional (enables Stripe) |
| `STRIPE_APP_TEST_SECRET_KEY` | Test mode secret key for test mode installs | Secret | Optional |
| `SUPABASE_OAUTH_CLIENT_ID` | Supabase OAuth app client ID | Server only | Optional (enables Supabase) |
| `SUPABASE_OAUTH_CLIENT_SECRET` | Supabase OAuth app client secret | Secret | Optional (enables Supabase) |
| `DEVMACRO_ENABLE_FAKE_PROVIDER` | Set to `1` to offer the fake provider and its consent screen | Test only | Optional (never in production) |
| `FAKE_PROVIDER_CLIENT_ID` | Any non-empty value for the fake provider | Test only | Optional (with the fake provider) |
| `FAKE_PROVIDER_CLIENT_SECRET` | Any non-empty value for the fake provider | Test only | Optional (with the fake provider) |
| `DEVMACRO_SIMULATE_PROVIDERS` | Set to `1` to replace the live providers with simulated ones that need no OAuth app | Local only | Optional (refused on Vercel production) |
| `E2E_PORT` | Port of the Playwright dev server, read from the shell (default 3100) | Test only | Optional |

A provider with any required variable empty shows as not set up in the connection catalog; the
rest of the app keeps working. Each provider callback URL is
`<SITE_URL>/api/connections/<provider>/callback`.

## Operations

Every Markdown file under `docs/` is also published on the website at `/docs`, rendered at build time.

- [Deploy the hosted app](docs/operations/deploy.md): Supabase project, forward-only migrations,
  Auth settings, Vercel project, environment variables, secrets, and verification.
- [Register the OAuth apps](docs/operations/oauth-apps.md): the sign-in GitHub OAuth app and the
  five provider apps, with per-provider details in [`docs/providers/`](docs/providers).
- [Jobs](docs/operations/jobs.md): the sync scheduler, retries, retention, and the `pg_cron` job.

### Invite testers

```bash
npm run invite -- tester@example.com            # add the email to public.access_invites
npm run invite -- tester@example.com --remove   # stop new sign-ups with that email
```

The script reads `.env.local` when present, otherwise `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` from the environment. Removing an invite does not delete an existing
account. For production, follow [Deploy, invite testers](docs/operations/deploy.md#4-invite-testers).

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
connections need reconnecting.

## Project layout

```text
src/
  proxy.ts                     content security policy and Supabase session refresh
  app/
    page.tsx, layout.tsx       landing page and root layout
    sign-in/                   GitHub sign-in page
    docs/                      the Markdown in docs/ published at /docs, one page per file
    auth/                      OAuth callback, error page, sign-out
    app/                       entry after sign-in, sends you to a workspace
    account/                   account page, delete account action, signed-out "account deleted" page
    w/[workspace]/             dashboard, connections, projects, timeline, alerts, settings
    api/connections/[provider]/  provider OAuth start and callback routes
    api/jobs/tick/             scheduler entry point, protected by CRON_SECRET
    api/dev/fake-provider/     dev-only consent screen of the fake and simulated providers
  components/
    sections/                  landing page sections
    app/                       app shell: navigation, workspace switcher, page states
    account/                   account deletion form and manual revoke steps
    dashboard/                 dashboard view and provider cards
    connections/               connection status, controls, provider marks
    projects/                  project forms and rules
    timeline/                  event list and filters
    alerts/                    alert rules, budgets, triggered alerts
    docs/                      Markdown rendering and the docs list for /docs
    *.tsx                      shared UI (site nav, footer, badges, icons)
  lib/
    adapters/                  provider adapters (github, vercel, stripe, supabase, resend, fake, simulated) and registry
    connections/               connect, OAuth state, revoke
    jobs/                      sync queue, runner, schedule, retries, retention, daily summary
    alerts/                    alert rule schema and evaluation
    dashboard/, timeline/      dashboard aggregation and timeline queries
    data/                      data access per table
    crypto/                    credential encryption and key ids
    auth/, workspaces/, account/  session, redirects, roles and permissions, account deletion
    log/                       structured logger with redaction
    supabase/                  Supabase clients (server, browser, admin) and generated types
    env.ts, site.ts, money.ts, providers.ts  env validation, site constants, money, provider list
    docs.ts                    reads docs/ for /docs: the page list, titles, and link rewriting
  types/                       ambient type declarations
supabase/
  config.toml                  local stack configuration (ports, GitHub auth, invite hook, seed)
  migrations/                  forward-only SQL migrations
  seed.sql                     synthetic local data
  tests/database/              pgTAP tests (row level security, roles, sync engine)
scripts/                       invite.ts, rotate-encryption-key.ts, tick.ts
e2e/                           Playwright specs, global-setup.ts, fixtures/
docs/
  architecture/schema.md       tables, relationships, functions
  operations/                  deploy, OAuth apps, jobs
  providers/                   one page per provider: app setup, permissions, data read
```

## Third-party marks

The platform logos on the landing page use path data from [Simple Icons](https://simpleicons.org)
(CC0-1.0). The logos remain trademarks of their owners and identify the integrations DevMacro
connects to. Their use implies no endorsement.
