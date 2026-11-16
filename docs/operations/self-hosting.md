# Self-host StackDash

This guide is the starting point for running your own StackDash: what you need before you start, the order to set it up in, how alert email works, how to run it day to day, and how to upgrade it. The detailed steps live in [Deploy to Vercel and Supabase](deploy.md), [Register the OAuth apps](oauth-apps.md), and [Jobs](jobs.md); this page links to the right section of each rather than repeating it.

## What a self-hosted StackDash is

A self-hosted StackDash is your own fork of the repository, deployed to your own Vercel project, with its data in your own Supabase project. Nothing is shared with the hosted version or with anyone else's install: you register your own sign-in app and your own provider apps, generate your own secrets, and decide who is invited.

- The guides cover Vercel and Supabase, the stack StackDash is built and checked on. There is no Docker image and no Docker Compose file.
- Sign-in is GitHub only, and only for the email addresses you invite.
- StackDash is licensed under the GNU Affero General Public License v3.0 only. If you run a modified version for other people over a network, the license requires you to offer them its source code. A modified version you host for people outside your organization also needs its own name and logo: the trademark terms in `TRADEMARKS.md` say what you can do without asking.

## What you need

| You need | Required | What for |
|---|---|---|
| A Supabase project | Yes | The database, sign-in through Supabase Auth, the invite check, and the scheduler (`pg_cron` and `pg_net`) |
| A Vercel project | Yes | The app itself, built from your fork |
| A GitHub account that can register an OAuth app | Yes | Signing in to StackDash |
| An SMTP sender for Supabase Auth | Yes | The emails Supabase Auth sends; its built-in sender is only meant for testing ([Deploy, custom SMTP sender](deploy.md#custom-smtp-sender)) |
| A Resend account with a verified sending domain | Only for alert email | Alert and digest emails. Without it, alerts still show in the app and reach Slack, Discord, and webhook channels ([Alert email](#alert-email)) |
| A developer account with each provider you want to connect | One per provider | Registering that provider's app ([Register the OAuth apps](oauth-apps.md)) |

On your own computer: Git, Node.js 22.13 or later in the 22 line, the [Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) 2.120 or later, and `openssl`. Docker is only needed if you also run the local Supabase stack for development.

## Set it up

Do these in order. Each step needs something the one before it creates: the Supabase project must exist before the Vercel variables can be filled in, and the production URL must exist before the OAuth apps and the scheduler can point at it.

1. **Fork the repository** on GitHub and clone your fork. You deploy from your fork, and you upgrade by bringing new commits into it ([Upgrade](#upgrade)).
2. **Create the Supabase project and apply the migrations**: [Deploy, steps 1 and 2](deploy.md#1-create-the-production-supabase-project).
3. **Configure Supabase Auth**: the site URL, GitHub sign-in, the invite hook, and the SMTP sender, in [Deploy, step 3](deploy.md#3-configure-supabase-auth).
4. **Invite yourself** with `npm run invite`: [Deploy, step 4](deploy.md#4-invite-testers).
5. **Create the Vercel project and set the environment variables**: [Deploy, step 5](deploy.md#5-create-the-vercel-project), with the secrets from [step 6](deploy.md#6-generate-the-deployment-secrets).
6. **Schedule syncs** by registering the `pg_cron` job: [Jobs, register the pg_cron job](jobs.md#register-the-pg_cron-job).
7. **Register an app for each provider you want**, set its variables, and deploy again: [Register the OAuth apps](oauth-apps.md). Then connect them from the app: [Connect providers](../connect-providers.md).
8. **Check the deployment** with the list in [Deploy, step 8](deploy.md#8-verify-the-production-deployment).

## Environment variables

Every variable in `.env.example` is documented twice: in `.env.example` itself, one comment per variable saying what it is for and where to get it, and in the table under [Deploy, environment variables](deploy.md#environment-variables), which adds whether it is secret and what to set for production and for previews. Start from that table. The variables that matter most when you host it yourself:

- `NEXT_PUBLIC_SITE_URL`, your public origin. Every provider callback URL starts with it, and a production build sends no alert email or channel message without it.
- `STACKDASH_ENCRYPTION_KEY`, which encrypts every stored provider credential. Keep a copy in your password manager: losing it means every connection must reconnect. [Key rotation](deploy.md#key-rotation) changes it without downtime.
- `STACKDASH_SUPER_ADMIN_EMAILS`, the sign-in emails that can open the instance overview at `/app/admin` ([Instance overview](deploy.md#instance-overview)).
- `STACKDASH_OPERATOR_NAME`, `STACKDASH_OPERATOR_EMAIL`, and `STACKDASH_GOVERNING_LAW`, which publish the privacy policy and terms of use with your details. Set all three or none.
- `STACKDASH_ALLOW_PRIVATE_WEBHOOKS` and `STACKDASH_TRUSTED_PROXY_COUNT` only apply to an install on your own network or behind your own proxies. Leave both unset on Vercel.

Never set the test and local only variables in production: `STACKDASH_ENABLE_FAKE_PROVIDER`, `STACKDASH_SIMULATE_PROVIDERS`, and the rest marked "Test only" or "Local only" in the table.

## Alert email

Alert email goes through Resend only. To send it, create a Resend account, verify a sending domain there, and set two variables:

- `STACKDASH_RESEND_API_KEY`: a Resend API key with sending access.
- `STACKDASH_EMAIL_FROM`: the sender, an address on the verified domain, optionally with a name, such as `StackDash alerts <alerts@your-domain>`.

Without the key, email stays off: alerts still show in the app and still reach Slack, Discord, and webhook channels, and alert settings says email is not set up. The privacy policy lists Resend as a processor only on a build made with the key set, so deploy again after setting it.

This is separate from the SMTP sender in Supabase Auth, which sends Supabase's own emails. You can use a Resend domain for both, but each is configured on its own.

## Webhooks and private networks

Providers that push events deliver them to `https://<your-host>/api/webhooks/<provider>`, so they reach the timeline within a minute. An install without a public URL, such as one on a private network, receives no deliveries and works on polling alone, at each provider's poll interval. [Deploy, provider webhooks](deploy.md#provider-webhooks) and [Jobs, a webhook job](jobs.md#a-webhook-job) have the details.

## Run it day to day

- **Invite people** with `npm run invite -- <email>`, and stop new sign-ups for an address with `--remove`: [Deploy, step 4](deploy.md#4-invite-testers).
- **Check its health** at `/app/admin` as a super admin: unset variables, provider apps, the job queue and its failures in the last 24 hours, and whether the database has this build's migrations.
- **When syncs stop**, start with [Jobs, where to look when syncs stop](jobs.md#where-to-look-when-syncs-stop).
- **Rotate secrets** as [Deploy, key rotation](deploy.md#key-rotation) describes, for the encryption key, `CRON_SECRET`, and the PostHog private key.
- **Backups** are your Supabase project's. Check what your Supabase plan keeps and how to restore it before you rely on it, and before every upgrade.

## Upgrade

### Releases

StackDash has no tagged releases yet. Upgrading means moving your fork to a newer commit of the main repository's `main` branch. Versioned releases, with tags and release notes, will come later; until they do, `main` is what you upgrade to, and the commit history is the change log.

Upgrade often. Migrations follow expand then contract: a change adds the new structure first and removes the old one in a later migration, so the build you are running keeps working while its newer migrations are applied. A jump across many commits can apply both halves at once, which shortens that safe window to the minutes between applying the migrations and the new deployment going live.

### Before you upgrade

1. Find the commit you run now. On Vercel it is on the production deployment, and the instance overview at `/app/admin` shows it under **Deployment**.
2. Read what changed between that commit and the newest `main`:

   ```bash
   git remote add upstream https://github.com/eddiejaoude/StackDash.git   # once
   git fetch upstream
   git log --oneline <your commit>..upstream/main
   git diff <your commit> upstream/main -- .env.example supabase/migrations docs/operations
   ```

   New lines in `.env.example` are new variables, new files under `supabase/migrations` are schema changes, and changes under `docs/operations` can change a setup step, such as the scheduler or an OAuth app setting.
3. Check that you can restore your Supabase project from a backup.

### Upgrade steps

1. **Bring the new commits into your fork** without deploying them yet. Vercel deploys every push to the production branch, so merge into a local branch first:

   ```bash
   git switch main
   git merge --ff-only upstream/main
   npm ci
   ```

   A merge that cannot fast-forward means your fork has commits of its own. Merge `upstream/main` into it, resolve the conflicts, and run `npm run typecheck`, `npm test`, and `npm run build` before you go on.
2. **Set any new variables** in Vercel, for production and for previews, as [Deploy, environment variables](deploy.md#environment-variables) describes.
3. **Apply the new migrations** to your own Supabase project, from the checkout you are about to deploy. Forward only, as in [Deploy, step 2](deploy.md#2-apply-the-migrations-forward-only): never `supabase db push` and never `supabase db reset` against your project.

   ```bash
   supabase migration list --linked     # the remote column is missing the new migrations
   supabase migration up --linked       # applies only those, in order
   supabase migration list --linked     # both columns now match
   ```

   These are the Supabase CLI 2 flags that Deploy uses. The current [Supabase CLI reference](https://supabase.com/docs/reference/cli/supabase-migration-up) names the target `--remote` instead (`supabase migration up --remote`), so run `supabase migration up --help` to see which your version takes.
4. **Deploy**: push `main` to your fork. Vercel builds and promotes the new production deployment.
5. **Follow any step the changes ask for** that a deployment does not do on its own, such as a new OAuth app setting or a changed `pg_cron` job. The scheduler itself carries over unchanged.

### Check the upgrade

- `/app/admin` shows the new commit, **Database migrations: Up to date**, and nothing that needs attention.
- Ticks still succeed: [Jobs, register the pg_cron job](jobs.md#register-the-pg_cron-job), step 3, has the queries.
- One connection syncs: select **Sync now** on it and see its last synced time change.

### Roll back

Migrations are never rolled back: a bad migration is fixed with a newer one. Roll back the app instead, to the deployment you ran before, with Vercel's [Instant Rollback](https://vercel.com/docs/instant-rollback). Expand then contract keeps the previous deployment working against the newer schema when the upgrade was a short step. After a long jump, a migration may have removed something the older build still reads, so check the app after rolling back. Until you deploy a build that matches the database, `/app/admin` shows the database migrations as **Ahead**. After an Instant Rollback, Vercel stops putting new pushes to the production branch live until you promote a deployment again, as its documentation describes.
