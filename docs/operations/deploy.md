# Deploy to Vercel and Supabase

This page takes you from empty Vercel and Supabase accounts to a production deployment of your own StackDash that the people you invite can sign in to.

Placeholders in angle brackets (`<project-ref>`, `<production-host>`) stand for your own values. No real value belongs in this file or in the repository.

Related pages:

- [OAuth apps](oauth-apps.md): register the sign-in OAuth app and one app per provider.
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

1. In the [Supabase dashboard](https://supabase.com/dashboard), create a project in the organization that will own StackDash. Pick the region closest to the Vercel functions region (Vercel defaults to Washington, D.C., `iad1`, unless you change it in the project's Functions settings).
2. Save the database password in your password manager. It is needed to link the CLI and is never stored in the repository or in Vercel.
3. Note the project ref (the subdomain of `https://<project-ref>.supabase.co`, also under Project Settings, General).

## 2. Apply the migrations, forward only

Schema changes are migrations in the repository, migrations are forward only and applied with `supabase migration up`, and there is **no `supabase db push` to a remote** and no schema change made by hand in the dashboard. A bad migration is fixed with a new migration. Never run `supabase db reset` against a remote, and never load `supabase/seed.sql` into production (it creates local test users).

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

This mirrors `[auth.hook.before_user_created]` in `supabase/config.toml` (`pg-functions://postgres/public/hook_before_user_created`). With it enabled, Supabase creates a user only when their GitHub email is in `public.access_invites`; everyone else is sent back to the sign-in page with "This GitHub account's email has not been invited to StackDash. Ask for an invite, then try again."

### Custom SMTP sender

**Authentication, Emails, SMTP Settings**: enable custom SMTP and enter the sender address, sender name, host, port, username, and password from your email provider (for example a Resend domain you have verified). Supabase's built-in sender is rate limited and only meant for testing. The SMTP password stays in Supabase.

### JWT signing keys

The app verifies every session with `supabase.auth.getClaims()`, in `src/proxy.ts` and in `src/lib/auth/session.ts`. When Auth signs access tokens with an asymmetric key, `getClaims()` checks them against the project's public keys, which supabase-js fetches from `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json` and keeps in memory for 10 minutes, so a page request makes no Auth call. With the legacy JWT secret (HS256) it cannot check the signature itself and calls the Auth server instead: twice per signed-in app page, once in the proxy and once on render (measured on the local stack). The local stack already signs with an ES256 key; a hosted project that still shows **Migrate JWT secret** does not.

On the **JWT signing keys** page (`https://supabase.com/dashboard/project/<project-ref>/settings/jwt`), following Supabase's [JWT signing keys guide](https://supabase.com/docs/guides/auth/signing-keys#getting-started):

1. Select **Migrate JWT secret**. The legacy secret becomes the current key and Supabase creates an ECC (P-256) key on standby. Nothing changes for signed-in users yet.
2. Select **Rotate keys**. Auth signs new access tokens with the ECC key. Tokens signed with the legacy secret stay valid until they expire, so nobody is signed out.
3. Leave the legacy secret under **Previously used**. Revoking it is not needed for this. The dashboard only lets you revoke it once the legacy `anon` and `service_role` keys are disabled, so first make sure `SUPABASE_SERVICE_ROLE_KEY` holds a secret key (`sb_secret_...`), disable the legacy keys, and revoke no sooner than 1 hour 15 minutes after rotating, so every token the legacy secret signed has expired.

Supabase throttles key changes to about one every 5 minutes. No variable in the app or in Vercel holds a signing key or the JWT secret, and the private key never leaves Supabase.

What the rotation trades away: on the legacy secret, Auth checks the session on every app page, so a session ended on the server (a sign-out of all devices, an account deleted from another device, a ban) is refused on the next request. With the asymmetric key the app checks only the signature and the expiry, so the proxy and the pages keep accepting such a session until its access token expires: up to the project's JWT expiry, 3600 seconds by default. Supabase names the same trade-off in its guide ("To ensure secure revocation, Auth server is in the hot path of your application").

## 4. Invite testers

The invite list lives in `public.access_invites`, which only the service role can write. Run the invite script with the **production** variables in the environment. It reads `.env.local` when that file exists, so run it from a directory where `.env.local` does not point at production by accident, or export the variables in a shell that has no `.env.local` to pick up:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co \
SUPABASE_SERVICE_ROLE_KEY=<production service role key> \
npm run invite -- tester@example.com

npm run invite -- tester@example.com --remove     # same variables; stops new sign-ups only
```

Start the line with a space if your shell is set to skip such lines in history, or export the key from your password manager instead of typing it. Invite the email that the tester's GitHub account exposes as its primary verified email, because that is what Supabase passes to the hook. Removing an invite does not delete an account that already signed up.

## 5. Create the Vercel project

1. In Vercel, **Add New, Project**, and import your fork of the StackDash repository.
2. **Framework Preset**: Next.js. Root directory: the repository root. Keep the default install command, build command (`npm run build`), and output directory.
3. **Settings, General, Node.js Version**: 22.x, the version CI uses.
4. **Settings, Git**: production branch `main`. Every other branch and every pull request gets a preview deployment automatically. Keep **Git Fork Protection** on, so a pull request from a fork never builds with the project's secrets until someone approves it.
5. Do not add `crons` to a `vercel.json`: scheduling is `pg_cron` (step 7).
6. **Analytics** in the project sidebar, then **Enable**, and deploy again. That turns on Vercel Web Analytics, which counts page views and sets no cookies. The app loads its script only when it sees `VERCEL=1` (see the environment variables below), so a self-hosted install loads no analytics script and sends nothing. Each page address goes to Vercel without its query string or fragment, which can carry an unsubscribe token or an OAuth `code` and `state`, and the **Routes** panel groups addresses by route, such as `/w/[workspace]/timeline`. Until analytics is enabled, the script fails to load and nothing is counted.

### Preview deployments and their Supabase project

Preview deployments run unreviewed branch code. Point the **Preview** environment at a separate staging Supabase project (repeat steps 1 to 4 for it, with its own keys) rather than at production, so preview code never holds the production service role key. Add the preview wildcard redirect URL to that project. Provider connections do not complete on previews: each provider app has a fixed callback URL on the production origin (see [OAuth apps](oauth-apps.md#hosted-and-self-hosted)).

### Environment variables

Set them in **Settings, Environment Variables**, per environment. `NEXT_PUBLIC_` variables are inlined into the browser bundle at build time, so changing one needs a new deployment. Every other variable is read on the server at runtime, except the inputs of the prerendered home page and legal pages, which are read at build time: the three operator variables, `VERCEL` (for the privacy policy's list of processors and for Vercel Web Analytics), and for the list of processors also the email variables (`STACKDASH_RESEND_API_KEY`, `STACKDASH_EMAIL_FROM`, `STACKDASH_RESEND_API_URL`). So the policy names Resend only after a deployment that was built with the email variables set, and with the operator variables set, a half-set email configuration (a key without `STACKDASH_EMAIL_FROM`) fails `next build` instead of only showing a notice on the alerts page. A secret must never get a `NEXT_PUBLIC_` name. Vercel applies a changed variable only to the next deployment anyway.

| Variable | Kind | Production | Preview | Where it comes from |
|---|---|---|---|---|
| `NEXT_PUBLIC_SITE_URL` | Public | `https://<production-host>` | Leave unset (the app falls back to the request origin), unless the preview sends alert emails or channel messages: then the preview URL | The production URL. Also the origin of every provider callback URL, of the `formulaUrl` links in the public metrics route, of the addresses in the sitemap and robots.txt, of the canonical address, `og:url`, and preview image of the landing page, the docs, the privacy policy and terms of use, and public project pages (left out while it is unset), and of the links in alert messages, which a production build will not send without it |
| `NEXT_PUBLIC_SUPABASE_URL` | Public | `https://<project-ref>.supabase.co` | Staging project URL | Supabase, Project Settings, API |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public | Publishable key (`sb_publishable_...`) | Staging publishable key | Supabase, Project Settings, API Keys |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret | Service role (secret) key | Staging key | Supabase, Project Settings, API Keys. Bypasses row level security |
| `STACKDASH_ENCRYPTION_KEY` | Secret | Own key | Different key | `openssl rand -base64 32` (step 6) |
| `STACKDASH_ENCRYPTION_KEYS_PREVIOUS` | Secret | Unset except during rotation | Unset | See [key rotation](#key-rotation) |
| `CRON_SECRET` | Secret | Own value | Different value, or unset if staging runs no cron job | Step 6. The same value goes into the `pg_cron` job |
| `STACKDASH_SUPER_ADMIN_EMAILS` | Server only | The operators' sign-in emails | Optional | Who can open the instance overview at `/app/admin`, comma separated, matched without regard to case. Empty means nobody |
| `STACKDASH_EMAIL_FROM` | Server only | `StackDash alerts <alerts@<verified-domain>>` | Optional | Sender of alert emails, an address on a domain verified in the Resend account |
| `STACKDASH_RESEND_API_KEY` | Secret | Yes, for alert email | Optional, a separate key | Resend, API Keys, with sending access. Alert email goes only through Resend, so a self-hosted install needs a Resend account and a verified sending domain; without this key email is off |
| `STACKDASH_RESEND_API_URL` | Server only | Unset (sends to `https://api.resend.com`) | Unset | Another server that answers like Resend's API: https, or plain http only to the same computer. Locally `http://127.0.0.1:55430`, the fake that `npm run email:fake` starts |
| `STACKDASH_ALLOW_PRIVATE_WEBHOOKS` | Server only | **Must be unset** | **Unset** | `1` lets webhook channels reach plain http and private addresses, whether written in the URL or resolved from its host name. Checked each time a message is posted, so unsetting it stops posts to such channels at once. Only for a self-hosted instance on its own network, and the e2e run |
| `STACKDASH_TRUSTED_PROXY_COUNT` | Server only | Unset | Unset | Self-hosted only: how many proxies in front of the app append to `x-forwarded-for` (1 when unset), for the per IP rate limit of the public routes. Ignored on Vercel: with `VERCEL=1` (a system environment variable) the app reads the client from `x-vercel-forwarded-for`. Without system variables it reads `x-forwarded-for`, which Vercel overwrites with the client alone, so unset is right there too |
| `STACKDASH_OPERATOR_NAME` | Server only | `<your name or organization>` | Optional: unset keeps `/privacy` and `/terms` off previews | Who runs the instance, named on the privacy policy and terms of use. Set all three operator variables or none: with none, both pages answer 404 and nothing links to them; with only some, the build fails and names the missing one. The policy names Vercel and Vercel Web Analytics only when the build sees `VERCEL=1`, which Vercel sets only while **Settings, Environment Variables, Enable access to System Environment Variables** is checked ([system environment variables](https://vercel.com/docs/environment-variables/system-environment-variables)), so keep it checked: without it the policy says "Hosting", no page counts views, and nothing fails. After the first production deployment built with these and the email variables, check that `/privacy` lists Vercel, Vercel Web Analytics, and Resend |
| `STACKDASH_OPERATOR_EMAIL` | Server only | `<privacy contact address>` | Optional, with the name | The address for privacy and data requests, shown on both pages |
| `STACKDASH_GOVERNING_LAW` | Server only | `<jurisdiction>`, for example `England and Wales` | Optional, with the name | The law the terms of use are governed by, as it reads after "the law of" |
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
| `DIGITALOCEAN_CLIENT_ID` | Server only | Yes | Optional | [OAuth apps, DigitalOcean OAuth app](oauth-apps.md#digitalocean-oauth-app) |
| `DIGITALOCEAN_CLIENT_SECRET` | Secret | Yes | Optional | Same |
| `POSTHOG_OAUTH_CLIENT_ID` | Server only | Yes, exactly `<SITE_URL>/oauth/posthog/client-metadata` | Optional | [OAuth apps, PostHog client ID metadata document](oauth-apps.md#posthog-client-id-metadata-document) |
| `POSTHOG_OAUTH_PRIVATE_KEY` | Secret | Yes | Optional | Same. Paste the PEM; `\n` escapes are accepted |
| `POLAR_CLIENT_ID` | Server only | Yes | Optional | [OAuth apps, Polar OAuth client](oauth-apps.md#polar-oauth-client) |
| `POLAR_CLIENT_SECRET` | Secret | Yes | Optional | Same |
| `SENTRY_CLIENT_ID` | Server only | Yes | Optional | [OAuth apps, Sentry integration](oauth-apps.md#sentry-integration) |
| `SENTRY_CLIENT_SECRET` | Secret | Yes | Optional | Same. Also signs the token refresh |
| `SENTRY_INTEGRATION_SLUG` | Server only | Yes | Optional | Same |
| `RAILWAY_CLIENT_ID` | Server only | Yes | Optional | [OAuth apps, Railway OAuth app](oauth-apps.md#railway-oauth-app) |
| `RAILWAY_CLIENT_SECRET` | Secret | Yes | Optional | Same |
| `GITLAB_CLIENT_ID` | Server only | Yes | Optional | [OAuth apps, GitLab OAuth application](oauth-apps.md#gitlab-oauth-application) |
| `GITLAB_CLIENT_SECRET` | Secret | Yes | Optional | Same |
| `STACKDASH_ENABLE_FAKE_PROVIDER` | Test only | **Must be unset** | **Unset** | Only local development and end-to-end runs set it to `1` |
| `FAKE_PROVIDER_CLIENT_ID`, `FAKE_PROVIDER_CLIENT_SECRET` | Test only | Unset | Unset | Fake provider used by tests |
| `STACKDASH_FAKE_WEBHOOK_SECRET` | Test only | **Must be unset** | **Unset** | Signs the fake provider's webhook deliveries in local development and end-to-end runs; `playwright.config.ts` sets a synthetic value. Unused while `STACKDASH_ENABLE_FAKE_PROVIDER` is unset |
| `STACKDASH_SIMULATE_PROVIDERS` | Local only | **Must be unset** (refused there even if set) | **Unset** | Only local development and end-to-end runs set it to `1` to simulate the live providers |
| `STACKDASH_SIMULATED_WEBHOOK_SECRET` | Local only | **Must be unset** | **Unset** | Signs every simulated provider's webhook deliveries in local development and end-to-end runs, in place of each provider's own webhook secret; `playwright.config.ts` sets a synthetic value. Unused while `STACKDASH_SIMULATE_PROVIDERS` is unset |
| `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID`, `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` | Local CLI only | Not in Vercel | Not in Vercel | Hosted: entered in the Supabase dashboard (step 3) |

"Server only" values are not secret on their own (a client ID appears in authorize URLs anyway), but they are still set without a `NEXT_PUBLIC_` prefix because only the server uses them. Mark every "Secret" row as **Sensitive** in Vercel so its value cannot be read back from the dashboard. A provider whose variables are missing is shown as not configured; the rest of the app still works.

## 6. Generate the deployment secrets

Generate each value on your own machine, paste it straight into Vercel, and keep a copy in your password manager. Generate separate values per environment.

```bash
openssl rand -base64 32    # STACKDASH_ENCRYPTION_KEY: exactly 32 random bytes, base64
openssl rand -hex 32       # CRON_SECRET: 64 hex characters (at least 32 are required)
```

Losing `STACKDASH_ENCRYPTION_KEY` makes every stored provider credential unreadable, and every connection must reconnect. `CRON_SECRET` uses hex so it can sit in an HTTP header and in SQL without quoting trouble.

### Key rotation

Rotate `STACKDASH_ENCRYPTION_KEY` without downtime with `npm run keys:rotate`, which re-encrypts stored credentials under the current key. Run it with the production variables in the environment, the same way as `npm run invite`. The full procedure is also in the header comment of `scripts/rotate-encryption-key.ts`:

1. Generate a new key with `openssl rand -base64 32`.
2. Work out the id of the key in use now, the first 8 hex characters of its SHA-256: `printf '%s' "$OLD_KEY" | openssl base64 -d -A | shasum -a 256 | cut -c1-8` (the script also prints the current key id on every run).
3. Set `STACKDASH_ENCRYPTION_KEY` to the new key, add the old one to `STACKDASH_ENCRYPTION_KEYS_PREVIOUS` as `oldKeyId:oldBase64Key`, and deploy. New credentials use the new key and old rows still decrypt.
4. Once every running instance has the new configuration, run `npm run keys:rotate` with that environment's variables. It prints counts only and is safe to re-run; repeat until "remaining" is 0.
5. After pending OAuth states sealed with the old key have expired, remove the old entry from `STACKDASH_ENCRYPTION_KEYS_PREVIOUS` and deploy again. The unsubscribe links in alert emails are signed with a key derived from the encryption key, so links in emails sent before the rotation stop working at this step; every newer email works.

Rows that cannot be decrypted are counted as unreadable and left untouched (exit code 1). Those connections need reconnecting, and those alert channels need removing and adding again with their URL (alert settings marks them as needing attention after their next message).

To rotate `CRON_SECRET`, set the new value in Vercel, deploy, then update the cron job as described in [Jobs](jobs.md#register-the-pg_cron-job). Ticks fail with `401` between the two steps, and the next tick after the update catches up.

To rotate `POSTHOG_OAUTH_PRIVATE_KEY`, generate a new key, set it, and deploy. It is a cutover: PostHog token calls can fail for up to a minute until PostHog fetches the new JWKS, and the affected syncs are retried. Details in [PostHog, Permission risks](../providers/posthog.md#permission-risks).

## 7. Schedule syncs

After the production deployment exists and `CRON_SECRET` is set, register the `pg_cron` job in the production Supabase project (SQL editor). The SQL, the payload, how to change or remove the job, and how to read failed runs are in [Jobs, register the pg_cron job](jobs.md#register-the-pg_cron-job). Do not copy it here; keep one source.

The cron job is environment configuration, not a migration, because it carries the production URL and the secret. Register it only on the production project (and on staging only if staging should sync).

### Provider webhooks

Providers that push signed events deliver them to the production URL, and the tick applies them, so they reach the timeline within a minute. A provider registered once for the whole instance posts to `https://<production-host>/api/webhooks/<provider>`, verified with the secret in the environment variable its adapter names. A provider set up per connection posts to `https://<production-host>/api/webhooks/<provider>/<endpoint id>`, verified with a secret stored encrypted for that connection. [Webhooks](../adapters.md#webhooks) in the adapter guide describes both.

Without a public URL, on a local machine or a self-hosted install on a private network, no delivery arrives and every provider works on polling alone, at its poll interval. The route's answers and log lines are in [Jobs, a webhook job](jobs.md#a-webhook-job).

## 8. Verify the production deployment

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
- [ ] **Fake and simulated providers are off.** The provider catalog shows no fake provider and no "Simulated" label, and `https://<production-host>/api/dev/fake-provider/authorize` and `https://<production-host>/api/dev/fake-provider/authorize?provider=vercel` both answer `404`.
- [ ] **Instance overview.** Sign in as an address in `STACKDASH_SUPER_ADMIN_EMAILS` and open `https://<production-host>/app/admin`: it says nothing needs attention, the scheduler is running, and the database migrations are up to date. Signed in as anyone else, the same address answers page not found.
- [ ] **Preview deployments.** A pull request gets a preview URL from Vercel.
- [ ] **Page views are counted.** In a normal browser window, open the home page and a workspace timeline, then **Analytics** in the Vercel project: both views arrive, the timeline is listed under **Routes** as `/w/[workspace]/timeline`, and no address under **Pages** has a query string. An automated or headless browser shows nothing there: the script sends no views when the browser reports itself as automated. On both pages the browser console shows no Content Security Policy error, and the site's cookies in the developer tools are only the `sb-` ones, as the privacy policy says.
- [ ] **Sessions are verified without Auth.** The **JWT signing keys** page lists the ECC (P-256) key as the current key. Checking the JWKS endpoint is not enough: it also lists a key that is only on standby.
- [ ] **Link previews and crawl rules.** `curl -s https://<production-host>/docs | grep -oE '<(meta property="og:(title|url|image)"|link rel="canonical")[^>]*>'` prints the page's own title and production addresses, the `og:image` address answers `200` with a PNG, and `curl -s https://<production-host>/robots.txt` names `https://<production-host>/sitemap.xml` and disallows `/w/`, `/app`, `/api/`, `/auth/`, `/account`, and `/oauth`.

## Instance overview

`/app/admin` shows a super admin how this server is configured and used: whether each variable in [Environment variables](#environment-variables) is set (never its value) and what that means, which provider OAuth apps are registered and how many workspaces use each provider, the background job queue and its failures in the last 24 hours, users, workspaces with their members and timeline events, and whether the database has this build's migrations. Super admins are the addresses in `STACKDASH_SUPER_ADMIN_EMAILS`; anyone else gets page not found.

A super admin reaches it from the Admin link in the workspace header on wider screens (the `lg` breakpoint, 1024 pixels, and up), or from the Admin command in the command palette at every width, which is the way in on a phone. Neither is sent to anyone else. Each view is logged with the viewer's user id (`admin.viewed`). Locally, add your GitHub email to `STACKDASH_SUPER_ADMIN_EMAILS` in `.env.local` and restart `npm run dev`.
