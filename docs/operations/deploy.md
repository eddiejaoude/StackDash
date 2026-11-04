# Deploy the hosted app

Issues: #78 (deploy), #89 (hosted scheduling), #88 (provider apps). This page takes a cold reader from an empty Vercel and Supabase account to a production deployment that invited testers can sign in to. Production promotion is Eddie's: agents prepare configuration and preview deployments, they never trigger or promote a production deployment.

Placeholders in angle brackets (`<project-ref>`, `<production-host>`) stand for your own values. No real value belongs in this file or in the repository.

Related pages:

- [OAuth apps](oauth-apps.md): register the sign-in OAuth app and the five provider apps.
- [Jobs](jobs.md): the sync scheduler, the tick route, and the `pg_cron` registration.
- `.env.example`: one line per variable, what it is for and where to get it.

## Overview

| Piece | Where it runs |
|---|---|
| Next.js app (pages, Server Actions, `/api/connections/*`, `/api/jobs/tick`) | One Vercel project, built from this repository |
| Postgres, Auth, the invite hook, `pg_cron`, `pg_net` | One production Supabase project |
| Scheduler | `pg_cron` in the Supabase project calls `POST /api/jobs/tick` every minute through `pg_net`. No Vercel Cron, no separate worker |
| Auth email | A custom SMTP sender configured in Supabase Auth |

Order matters: the Supabase project must exist before the Vercel environment variables can be filled in, and the production URL must exist before the OAuth apps and the cron job can point at it.

## 1. Create the production Supabase project

1. In the [Supabase dashboard](https://supabase.com/dashboard), create a project in the organization that will own DevMacro. Pick the region closest to the Vercel functions region (Vercel defaults to Washington, D.C., `iad1`, unless you change it in the project's Functions settings).
2. Save the database password in your password manager. It is needed to link the CLI and is never stored in the repository or in Vercel.
3. Note the project ref (the subdomain of `https://<project-ref>.supabase.co`, also under Project Settings, General).

## 2. Apply the migrations, forward only

House rules (project rules, Supabase section): schema changes are migrations in the repository, migrations are forward only and applied with `supabase migration up`, and there is **no `supabase db push` to a remote** and no schema change made by hand in the dashboard. A bad migration is fixed with a new migration. Never run `supabase db reset` against a remote, and never load `supabase/seed.sql` into production (it creates local test users).

From a clean checkout of the commit you are deploying:

```bash
supabase login
supabase link --project-ref <project-ref>        # asks for the database password
supabase migration list --linked                 # shows which migrations the remote has
supabase migration up --linked                   # applies only the missing ones, in order
supabase migration list --linked                 # local and remote columns now match
```

If you cannot link (for example from a CI runner), the same command takes a connection string: `supabase migration up --db-url "<connection string>"`. Use the **direct connection** or the **session pooler** string from the project's Connect panel (session mode, port 5432). The transaction pooler (port 6543) does not support everything a migration session needs. Keep the string out of shell history and out of the repository.

The app itself never connects to Postgres with a connection string: it talks to Supabase over HTTPS with the keys in step 5, so Vercel needs no `DATABASE_URL` and no pooler setting.

The migrations create everything the deployment relies on, including:

- `public.hook_before_user_created(jsonb)`, the invite gate, with execute granted only to `supabase_auth_admin` (`20261031090300_jobs_and_invites.sql`).
- The `pg_cron` extension (schema `pg_catalog`) and the `pg_net` extension (schema `extensions`). The cron job itself is not a migration because it carries the deployment URL and `CRON_SECRET`; see step 7.

Every later release repeats `supabase migration list --linked` and `supabase migration up --linked` **before** promoting the matching deployment. Migrations follow expand then contract, so the previous deployment keeps working against the new schema.

## 3. Configure Supabase Auth

All in the Supabase dashboard, under **Authentication**. Do not use `supabase config push`: `supabase/config.toml` holds local settings (localhost URLs, the local SMTP catcher) and would overwrite production.

### URL configuration

**Authentication, URL Configuration**:

- **Site URL**: `https://<production-host>` (the Vercel production URL until a domain is registered; change it when the domain arrives).
- **Redirect URLs**: add
  - `https://<production-host>/**`
  - the preview wildcard, only on the Supabase project that previews use (see step 5): `https://*-<vercel-team-slug>.vercel.app/**`

The sign-in page sends Supabase a `redirectTo` of `<origin>/auth/callback`; Supabase refuses any origin that does not match this list.

### GitHub sign-in provider

1. Register a **GitHub OAuth app** for sign-in (not the GitHub App that reads billing). Settings are in [OAuth apps, GitHub OAuth app for sign-in](oauth-apps.md#github-oauth-app-for-sign-in). Its callback URL is `https://<project-ref>.supabase.co/auth/v1/callback`.
2. **Authentication, Sign In / Providers, GitHub**: enable it and paste the client ID and client secret. These live only in Supabase. `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` are read by the local Supabase CLI only and are never set in Vercel.

### Disable the email provider

**Authentication, Sign In / Providers, Email**: turn it off. Email and password users exist only in the local seed and the end-to-end fixtures; production sign-in is GitHub only. Leave **Allow new users to sign up** on: the invite hook below decides who may sign up.

### Before user created hook

**Authentication, Auth Hooks, Add hook, Before User Created**:

- Hook type: **Postgres function**.
- Schema `public`, function `hook_before_user_created`.

This mirrors `[auth.hook.before_user_created]` in `supabase/config.toml` (`pg-functions://postgres/public/hook_before_user_created`). With it enabled, Supabase creates a user only when their GitHub email is in `public.access_invites`; everyone else sees "This email has not been invited to the DevMacro test."

### Custom SMTP sender

**Authentication, Emails, SMTP Settings**: enable custom SMTP and enter the sender address, sender name, host, port, username, and password from your email provider (for example a Resend domain you have verified). Supabase's built-in sender is rate limited and only meant for testing. The SMTP password stays in Supabase.

## 4. Invite testers

The invite list lives in `public.access_invites`, which only the service role can write. Run the invite script with the **production** variables in the environment. It reads `.env.local` when that file exists, so run it from a directory where `.env.local` does not point at production by accident, or export the variables in a shell that has no `.env.local` to pick up:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<production service role key> \
npm run invite -- tester@example.com

npm run invite -- tester@example.com --remove     # same variables; stops new sign-ups only
```

Start the line with a space if your shell is set to skip such lines in history, or export the key from your password manager instead of typing it. Invite the email that the tester's GitHub account exposes as its primary verified email, because that is what Supabase passes to the hook.

## 5. Create the Vercel project

1. In Vercel, **Add New, Project**, import `eddiejaoude/DevMacro`.
2. **Framework Preset**: Next.js. Root directory: the repository root. Keep the default install command, build command (`npm run build`), and output directory.
3. **Settings, General, Node.js Version**: 22.x, the version CI uses.
4. **Settings, Git**: production branch `main`. Every other branch and every pull request gets a preview deployment automatically. Keep **Git Fork Protection** on, so a pull request from a fork never builds with the project's secrets until someone approves it.
5. Do not add `crons` to a `vercel.json`: scheduling is `pg_cron` (step 7).

### Preview deployments and their Supabase project

Preview deployments run unreviewed branch code. Point the **Preview** environment at a separate staging Supabase project (repeat steps 1 to 4 for it, with its own keys) rather than at production, so preview code never holds the production service role key. Add the preview wildcard redirect URL to that project. Provider connections do not complete on previews: each provider app has a fixed callback URL on the production origin (see [OAuth apps](oauth-apps.md#hosted-and-self-hosted)).

### Environment variables

Set them in **Settings, Environment Variables**, per environment. `NEXT_PUBLIC_` variables are inlined into the browser bundle at build time, so changing one needs a new deployment; every other variable is read on the server at runtime. A secret must never get a `NEXT_PUBLIC_` name.

| Variable | Kind | Production | Preview | Where it comes from |
|---|---|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | Public | `https://<production-host>` | Leave unset (the app falls back to the request origin) | The production URL. Also the origin of every provider callback URL |
| `NEXT_PUBLIC_SUPABASE_URL` | Public | `https://<project-ref>.supabase.co` | Staging project URL | Supabase, Project Settings, API |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public | Publishable key (`sb_publishable_...`) | Staging publishable key | Supabase, Project Settings, API Keys |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Service role (secret) key | Staging key | Supabase, Project Settings, API Keys. Bypasses row level security |
| `DEVMACRO_ENCRYPTION_KEY` | Secret | Own key | Different key | `openssl rand -base64 32` (step 6) |
| `DEVMACRO_ENCRYPTION_KEYS_PREVIOUS` | Secret | Unset except during rotation | Unset | See [key rotation](#key-rotation) |
| `CRON_SECRET` | Secret | Own value | Different value, or unset if staging runs no cron job | Step 6. The same value goes into the `pg_cron` job |
| `GITHUB_APP_ID` | Server only | Yes | Optional | [OAuth apps, GitHub App](oauth-apps.md#github-app) |
| `GITHUB_APP_SLUG` | Server only | Yes | Optional | Same |
| `GITHUB_APP_CLIENT_ID` | Server only | Yes | Optional | Same |
| `GITHUB_APP_CLIENT_SECRET` | Secret | Yes | Optional | Same |
| `GITHUB_APP_PRIVATE_KEY` | Secret | Yes | Optional | Same. Paste the PEM; `\n` escapes are accepted |
| `VERCEL_CLIENT_ID` | Server only | Yes | Optional | [OAuth apps, Vercel Integration](oauth-apps.md#vercel-integration) |
| `VERCEL_CLIENT_SECRET` | Secret | Yes | Optional | Same |
| `VERCEL_INTEGRATION_SLUG` | Server only | Yes | Optional | Same |
| `STRIPE_APP_CLIENT_ID` | Server only | Yes | Optional | [OAuth apps, Stripe App](oauth-apps.md#stripe-app) |
| `STRIPE_APP_SECRET_KEY` | Secret | Yes | Optional | Same (`sk_live_...` of the app's account) |
| `STRIPE_APP_TEST_SECRET_KEY` | Secret | Only to accept test mode installs | Optional | Same (`sk_test_...`) |
| `SUPABASE_OAUTH_CLIENT_ID` | Server only | Yes | Optional | [OAuth apps, Supabase OAuth app](oauth-apps.md#supabase-oauth-app) |
| `SUPABASE_OAUTH_CLIENT_SECRET` | Secret | Yes | Optional | Same |
| `RESEND_CLIENT_ID` | Server only | Yes | Optional | [OAuth apps, Resend OAuth client](oauth-apps.md#resend-oauth-client) |
| `RESEND_CLIENT_SECRET` | Secret | Yes | Optional | Same |
| `DEVMACRO_ENABLE_FAKE_PROVIDER` | Test only | **Must be unset** | **Unset** | Only local development and end-to-end runs set it to `1` |
| `FAKE_PROVIDER_CLIENT_ID`, `FAKE_PROVIDER_CLIENT_SECRET` | Test only | Unset | Unset | Fake provider used by tests |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID`, `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` | Local CLI only | Not in Vercel | Not in Vercel | Hosted: entered in the Supabase dashboard (step 3) |

"Server only" values are not secret on their own (a client ID appears in authorize URLs anyway), but they are still set without a `NEXT_PUBLIC_` prefix because only the server uses them. Mark every "Secret" row as **Sensitive** in Vercel so its value cannot be read back from the dashboard. A provider whose variables are missing is shown as not configured; the rest of the app still works.

## 6. Generate the deployment secrets

Generate each value on your own machine, paste it straight into Vercel, and keep a copy in your password manager. Generate separate values per environment.

```bash
openssl rand -base64 32    # DEVMACRO_ENCRYPTION_KEY: exactly 32 random bytes, base64
openssl rand -hex 32       # CRON_SECRET: 64 hex characters (at least 32 are required)
```

Losing `DEVMACRO_ENCRYPTION_KEY` makes every stored provider credential unreadable, and every connection must reconnect. `CRON_SECRET` uses hex so it can sit in an HTTP header and in SQL without quoting trouble.

### Key rotation

Rotate `DEVMACRO_ENCRYPTION_KEY` without downtime by moving the old key into `DEVMACRO_ENCRYPTION_KEYS_PREVIOUS`, deploying, then running `npm run keys:rotate` with the production variables in the environment (the same way as `npm run invite`). The full procedure is in the header comment of `scripts/rotate-encryption-key.ts`.

To rotate `CRON_SECRET`, set the new value in Vercel, deploy, then update the cron job as described in [Jobs](jobs.md#register-the-pg_cron-job). Ticks fail with `401` between the two steps, and the next tick after the update catches up.

## 7. Schedule syncs (#89)

After the production deployment exists and `CRON_SECRET` is set, register the `pg_cron` job in the production Supabase project (SQL editor). The SQL, the payload, how to change or remove the job, and how to read failed runs are in [Jobs, register the pg_cron job](jobs.md#register-the-pg_cron-job). Do not copy it here; keep one source.

The cron job is environment configuration, not a migration, because it carries the production URL and the secret. Register it only on the production project (and on staging only if staging should sync).

## 8. Promote production (Eddie)

1. Merge to `main` after CI passes and the preview has been checked. Vercel builds a production deployment.
2. Before the deployment receives traffic, apply any new migrations (step 2).
3. Promote or confirm the production deployment in Vercel.

## 9. Verify the production deployment

Run every check against the production URL and write down the deployment URL you checked.

- [ ] **Invited tester signs in.** Invite a tester (step 4), open `https://<production-host>/sign-in` in a private window, choose GitHub, and land on the timeline of their personal workspace. Then try a GitHub account that is not invited: sign-in must be refused with the "not been invited" message.
- [ ] **No secret in the client bundle.** Download every script the sign-in page loads and search it:

  ```bash
  SITE=https://<production-host>
  curl -s "$SITE/sign-in" | grep -oE '/_next/static/[^"]+\.js' | sort -u \
    | while read -r path; do curl -s "$SITE$path"; done \
    | grep -cE 'sb_secret_|sk_live_|sk_test_|PRIVATE KEY|SERVICE_ROLE|ENCRYPTION_KEY|CLIENT_SECRET|CRON_SECRET'
  ```

  The count must be `0`. Repeat with a signed-in page path if you want the app chunks too (copy the page's HTML from the browser, since `curl` is signed out). Also confirm in Vercel that no variable whose name starts with `NEXT_PUBLIC_` holds a secret.
- [ ] **Tick refuses unauthenticated calls.**

  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<production-host>/api/jobs/tick
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'Authorization: Bearer wrong' https://<production-host>/api/jobs/tick
  ```

  Both must print `401`.
- [ ] **The scheduler runs.** In the Supabase SQL editor, recent `pg_cron` runs succeed and ticks get `200` responses; [Jobs](jobs.md) lists the queries.
- [ ] **A sync runs.** Connect one provider in a test workspace (needs that provider's app from [OAuth apps](oauth-apps.md)), then select **Sync now** or wait for the schedule. The connection shows a recent "last synced" time and `public.sync_jobs` has a `succeeded` row for it.
- [ ] **Fake provider is off.** The provider catalog shows no fake provider, and `https://<production-host>/api/dev/fake-provider/authorize` answers `404`.
- [ ] **Preview deployments.** A pull request gets a preview URL from Vercel.

## What stays Eddie's

- Creating the Vercel project, the production (and staging) Supabase projects, and the SMTP sender.
- Registering the sign-in OAuth app and the five provider apps ([OAuth apps](oauth-apps.md)), and entering their secrets.
- Generating and storing the production secrets.
- Running migrations against production, registering the cron job, and inviting testers.
- Promoting production deployments. Agents never trigger or promote one.
- Turning on GitHub secret scanning and push protection for the repository. In **Settings, Code security** (called **Advanced Security** in newer GitHub layouts), enable **Secret scanning** and **Push protection**. For a private repository this needs GitHub Secret Protection, a paid part of GitHub Advanced Security; both are free once the repository is public. Until they are on, the gitleaks scan in CI is the only automated secret check, and it only runs after a push. Confirm with `gh api repos/eddiejaoude/DevMacro --jq '.security_and_analysis'`: `secret_scanning` and `secret_scanning_push_protection` must both show `"status": "enabled"`.
