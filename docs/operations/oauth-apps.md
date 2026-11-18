# Register the OAuth apps

Connections are OAuth only: StackDash never asks users for API keys. Each deployment therefore needs twelve registrations: one GitHub OAuth app for signing in to StackDash, and one app per provider for connecting accounts. PostHog's is a document the deployment serves itself, with nothing to create in PostHog.

This page lists the settings that must match the code. The provider pages under `docs/providers/` hold the full click paths, the reasons for each permission, and what each permission also allows; follow the linked section for each app.

`<SITE_URL>` below is the deployment's public origin with no trailing slash, the same value as `NEXT_PUBLIC_SITE_URL` (for example `https://stackdash.example.com`). Every provider callback is `<SITE_URL>/api/connections/<provider>/callback`. The app builds the redirect URI from `NEXT_PUBLIC_SITE_URL` when it is set and from the request origin otherwise, and providers compare it byte for byte with the registered value, so set `NEXT_PUBLIC_SITE_URL` before testing a connection.

All variables below are server only: never give them a `NEXT_PUBLIC_` prefix. Set them per environment in the host (Vercel: see [Deploy, environment variables](deploy.md#environment-variables)), or in `.env.local` for local development. Never commit them.

## Hosted and self-hosted

- **Hosted StackDash**: the hosted instance has one registration per app, owned by the StackDash account or organization, with callbacks on its production origin. Hosted users connect through these apps and never create their own.
- **Self-hosted StackDash**: every install registers its own apps with the same permissions, because the callback URLs, client secrets, and private keys belong to one deployment. Never reuse the hosted apps' credentials.
- **Local development and previews**: provider callbacks are fixed per app (Vercel allows a single Redirect URL), so a preview deployment cannot complete a provider connection with the production apps. Register separate development apps with `http://localhost:3000/...` callbacks where the provider allows them. End-to-end tests use the fake provider instead (`STACKDASH_ENABLE_FAKE_PROVIDER=1`, never in production). To try every provider locally without registering any app, simulate them (`STACKDASH_SIMULATE_PROVIDERS=1`, local only and refused on a Vercel production deployment): each connection is labeled "Simulated" and its data is made up on your machine.
- **Webhooks**: StackDash can receive signed deliveries (see [Webhooks](../adapters.md#webhooks)). Leave every webhook setting empty or inactive unless that provider's section below says to fill it in. Each provider page says whether StackDash receives that provider's webhooks.

## Summary

| App | Register at | Callback | Permissions (all read-only except where noted) | Variables |
|---|---|---|---|---|
| GitHub OAuth app (sign-in) | GitHub, Settings, Developer settings, OAuth Apps | `https://<project-ref>.supabase.co/auth/v1/callback` | `read:user user:email` (requested by the sign-in page) | Entered in Supabase Auth, not in the app |
| GitHub App | GitHub, Settings, Developer settings, GitHub Apps | `<SITE_URL>/api/connections/github/callback` (callback and setup URL); webhook `<SITE_URL>/api/webhooks/github` | Metadata read, Issues read, Pull requests read, Organization Administration read, Account Plan read | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET` |
| Vercel Integration | Vercel, Integrations Console | `<SITE_URL>/api/connections/vercel/callback` | `billing`, `deployment`, `project`, `team` at Read | `VERCEL_CLIENT_ID`, `VERCEL_CLIENT_SECRET`, `VERCEL_INTEGRATION_SLUG` |
| Stripe App | Stripe CLI (`stripe apps`) and Dashboard | `<SITE_URL>/api/connections/stripe/callback` | `event_read`, `charge_read`, `customer_read`, `subscription_read`, `invoice_read`, `balance_read`, `payout_read` | `STRIPE_APP_CLIENT_ID`, `STRIPE_APP_SECRET_KEY`, `STRIPE_APP_TEST_SECRET_KEY` (optional), `STRIPE_WEBHOOK_SECRET` (optional), `STRIPE_WEBHOOK_TEST_SECRET` (optional) |
| Supabase OAuth app | Supabase, organization settings, OAuth Apps | `<SITE_URL>/api/connections/supabase/callback` | `organizations:read`, `projects:read`, `analytics:read` | `SUPABASE_OAUTH_CLIENT_ID`, `SUPABASE_OAUTH_CLIENT_SECRET` |
| Resend OAuth client | `POST https://api.resend.com/oauth/register` | `<SITE_URL>/api/connections/resend/callback` | `full_access` (Resend has no read-only scope; **not read-only**) | `RESEND_CLIENT_ID`, `RESEND_CLIENT_SECRET` |
| DigitalOcean OAuth app | DigitalOcean control panel, API, OAuth Applications | `<SITE_URL>/api/connections/digitalocean/callback` | `billing:read`, `actions:read`, `app:read`, `droplet:read`, `account:read` (sent with each authorize request) | `DIGITALOCEAN_CLIENT_ID`, `DIGITALOCEAN_CLIENT_SECRET` |
| PostHog client ID metadata document | Nothing to create: StackDash serves the document at `<SITE_URL>/oauth/posthog/client-metadata` | `<SITE_URL>/api/connections/posthog/callback` (listed in the document) | `billing:read`, `organization:read`, `project:read`, `query:read` | `POSTHOG_OAUTH_CLIENT_ID`, `POSTHOG_OAUTH_PRIVATE_KEY` |
| Polar OAuth client | Polar, Account Settings, Developer | `<SITE_URL>/api/connections/polar/callback` | `organizations:read`, `metrics:read`, `orders:read`, `subscriptions:read`, `customers:read`, `refunds:read`, and `webhooks:write` (requested only for automatic webhook setup) | `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET` |
| Sentry integration | Sentry, Settings, Developer Settings, Public Integration | `<SITE_URL>/api/connections/sentry/callback` (Redirect URL) | `org:read`, `event:read`, `project:read` | `SENTRY_CLIENT_ID`, `SENTRY_CLIENT_SECRET`, `SENTRY_INTEGRATION_SLUG` |
| Railway OAuth app | Railway, workspace settings, Developer, New OAuth App | `<SITE_URL>/api/connections/railway/callback` | `openid`, `email`, `profile`, `offline_access`, `workspace:viewer` (requested by the app, not set on the registration) | `RAILWAY_CLIENT_ID`, `RAILWAY_CLIENT_SECRET` |
| GitLab OAuth application | GitLab.com, avatar, Edit profile, Access, Applications | `<SITE_URL>/api/connections/gitlab/callback` | `read_api`, `read_user`, `api` (asked for only with automatic webhook setup) | `GITLAB_CLIENT_ID`, `GITLAB_CLIENT_SECRET` |

A provider whose variables are missing shows as not configured in the connection catalog; the other providers keep working.

## GitHub OAuth app for sign-in

Signing in to StackDash goes through Supabase Auth with GitHub. This is a classic **OAuth app**, separate from the GitHub App below.

1. GitHub, **Settings, Developer settings, OAuth Apps, New OAuth App** ([direct link](https://github.com/settings/developers)). Use the organization's developer settings to own it as an organization.
2. **Application name**: for example `StackDash`. **Homepage URL**: `<SITE_URL>`.
3. **Authorization callback URL**: `https://<project-ref>.supabase.co/auth/v1/callback`, the Supabase project's Auth callback, not a StackDash URL. Locally it is `http://127.0.0.1:55421/auth/v1/callback` (from `supabase/config.toml`), in a separate OAuth app.
4. Leave **Enable Device Flow** unchecked. Register, then **Generate a new client secret**.
5. Hosted: paste the client ID and secret in the Supabase dashboard, **Authentication, Sign In / Providers, GitHub** ([Deploy, step 3](deploy.md#github-sign-in-provider)). Locally: `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` in `supabase/.env.local`, read by the Supabase CLI only.

The sign-in page requests `read:user user:email`, so Supabase receives the account's email, which the invite hook checks against `public.access_invites`.

## GitHub App

Reads organization and personal billing usage, stars, forks, and published releases (from each repository's events feed), and receives pull requests merged, issues opened, and new stars by webhook, with the hourly sync as the backfill. Full steps: [GitHub, Self-hosted registration](../providers/github.md#self-hosted-registration). Permissions and why: [GitHub, Permissions](../providers/github.md#permissions). Webhooks: [GitHub, Webhooks](../providers/github.md#webhooks).

Settings that must match the code:

- **Callback URL**: `<SITE_URL>/api/connections/github/callback`.
- **Setup URL**: the same `<SITE_URL>/api/connections/github/callback`, with **Redirect on update** checked.
- **Request user authorization (OAuth) during installation**: unchecked (it disables the setup URL; StackDash runs the user authorization itself, with PKCE).
- **Expire user authorization tokens**: checked. **Enable Device Flow**: unchecked.
- **Webhook**: **Active** checked. **Webhook URL**: `<SITE_URL>/api/webhooks/github`. **Webhook secret**: a long random value, also set as `GITHUB_APP_WEBHOOK_SECRET`. An instance GitHub cannot reach (local development) leaves it unchecked: the hourly sync still brings pull requests, issues, and releases, but single star events never arrive, and an uninstall or suspension is noticed on the next failed sync.
- **Permissions**: Repository, Metadata: Read-only. Repository, Issues: Read-only. Repository, Pull requests: Read-only. Organization, Administration: Read-only. Account, Plan: Read-only. Everything else: No access, Contents included (it also reads code; releases come from the events feed instead).
- **Subscribe to events**: Issues, Pull request, Star. Leave Release unchecked: it needs Contents read. Installation and authorization events reach every GitHub App without a box.
- **Where can this GitHub App be installed?**: **Any account** for hosted StackDash or a shared install; **Only on this account** for a single-user self-host.

Variables: `GITHUB_APP_ID` (App ID), `GITHUB_APP_SLUG` (from `https://github.com/apps/<slug>`), `GITHUB_APP_CLIENT_ID` (Client ID, not the App ID), `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` (the downloaded PEM; `\n` escapes are accepted when the host stores single-line values), and `GITHUB_APP_WEBHOOK_SECRET` (the webhook secret above). Delete the downloaded PEM file once it is stored.

An app registered before webhooks: add the webhook, the two repository permissions, and the three events, then save. Each installation's owner is asked to accept the new permissions; until then its connection lists them as missing and keeps syncing billing, stars, forks, and releases.

## Vercel Integration

Reads team plan, billing charges, deployments, and projects. Full steps, including the required profile fields: [Vercel, Self-hosted registration steps](../providers/vercel.md#self-hosted-registration-steps). Scopes and what they also allow: [Vercel, Scopes requested](../providers/vercel.md#scopes-requested) and [Permission risks](../providers/vercel.md#permission-risks).

Settings that must match the code:

- Create it in the Vercel team that should own it: **Integrations, Integrations Console, Create**.
- **Redirect URL**: `<SITE_URL>/api/connections/vercel/callback`. It is a single field, so one integration serves one origin.
- **API Scopes**: `billing` Read, `deployment` Read, `project` Read, `team` Read. Everything else None.
- **Webhook URL**: `<SITE_URL>/api/webhooks/vercel`, with only `deployment.succeeded`, `deployment.error`, and `integration-configuration.removed` ticked. Leave it empty on a local development integration, which no delivery can reach. See [Vercel, Webhooks](../providers/vercel.md#webhooks).
- **Configuration URL**: empty.

Variables: `VERCEL_CLIENT_ID` (`oac_...`), `VERCEL_CLIENT_SECRET` (from **Credentials**; **Rotate Secret** is there too; it also verifies webhook deliveries, so rotating it changes the webhook key at once), `VERCEL_INTEGRATION_SLUG` (the URL Slug, used to build `https://vercel.com/integrations/<slug>/new`).

Adding or upgrading a scope later emails every installer for confirmation, so register with exactly these four.

## Stripe App

Reads revenue, fees, payouts, subscriptions, and payment and customer events. A Stripe App is built and uploaded with the Stripe CLI; it exists only to request permissions and issue OAuth tokens. Full steps: [Stripe, Self-hosted setup](../providers/stripe.md#self-hosted-setup) and the manifest in [Packaging the Stripe App](../providers/stripe.md#packaging-the-stripe-app). Permissions and what they also allow: [Stripe, Permissions](../providers/stripe.md#permissions).

Settings that must match the code:

- Owner account: a Stripe account used only for the app, without Connect enabled. One account owns at most one public app.
- `stripe-app.json`: `distribution_type` `public`, `stripe_api_access_type` `oauth` (fixed after the first upload), `allowed_redirect_uris` `["<SITE_URL>/api/connections/stripe/callback"]` (HTTPS for live mode).
- Permissions, added with `stripe apps grant permission`: `event_read`, `charge_read`, `customer_read`, `subscription_read`, `invoice_read`, `balance_read`, `payout_read`. Nothing else.
- After `stripe apps upload`: in the Dashboard, **Created apps**, select the app, **Set external test version**, **Access**: **Anyone with the link**. Up to 25 external testers can install an unpublished app; MVP testers are added this way ([External testers and review](../providers/stripe.md#external-testers-and-review)). Testers need the Apps administrator role on their Stripe account.
- Webhooks, optional: one endpoint in the owner account's live mode, **Developers**, **Webhooks**, at `<SITE_URL>/api/webhooks/stripe`, with **Listen to events on Connected accounts** and the eight events listed in [Stripe, Webhooks](../providers/stripe.md#webhooks), and, to push test mode installs' events too, a second endpoint with the same settings at the same URL in the owner account's test mode. Each delivery reaches only connections of its own mode.

Variables: `STRIPE_APP_CLIENT_ID` (the `client_id` in the OAuth install link), `STRIPE_APP_SECRET_KEY` (live secret key `sk_live_...` of the owner account; Stripe Apps have no client secret, and a restricted key does not work), `STRIPE_APP_TEST_SECRET_KEY` (`sk_test_...`, only to accept installs from the test mode link), `STRIPE_WEBHOOK_SECRET` (the live mode webhook endpoint's signing secret `whsec_...`, only to receive live mode webhooks), and `STRIPE_WEBHOOK_TEST_SECRET` (the test mode webhook endpoint's signing secret `whsec_...`, only to receive test mode webhooks). With both webhook secrets empty, Stripe is on polling alone.

## Supabase OAuth app

Reads organization plan and limits, project health, and auth activity counts. Full steps: [Supabase, Self-hosted registration](../providers/supabase.md#self-hosted-registration). Scopes and why `database:read` is never requested: [Supabase, Scopes and why](../providers/supabase.md#scopes-and-why).

Settings that must match the code:

- Supabase dashboard, organization settings, **OAuth Apps**, **Add application** ([link](https://supabase.com/dashboard/org/_/apps)).
- **Redirect URL**: `<SITE_URL>/api/connections/supabase/callback`.
- **Scopes**: Organizations read, Projects read, Analytics read (`organizations:read`, `projects:read`, `analytics:read`). Nothing else. Scopes cannot be narrowed per request, and changing them later sends every user through consent again.

Variables: `SUPABASE_OAUTH_CLIENT_ID`, `SUPABASE_OAUTH_CLIENT_SECRET`.

This is unrelated to the Supabase project that hosts StackDash itself; register it in whichever organization should own the app.

## Resend OAuth client

Reads email usage, quotas, and domains. Resend has no dashboard page for OAuth clients: registration is one API call, as a pre-registered confidential client. Full steps and the request body: [Resend, Self-hosted registration](../providers/resend.md#self-hosted-registration). Why the scope is broad: [Resend, Permission risks](../providers/resend.md#permission-risks).

Settings that must match the code:

- `redirect_uris`: `["<SITE_URL>/api/connections/resend/callback"]` (HTTPS; loopback `http` only for local development).
- `token_endpoint_auth_method`: `client_secret_basic`. `grant_types`: `authorization_code`, `refresh_token`. `scope`: `full_access`, the only scope that can read usage. It is **not** read-only; the connect flow tells users so before redirecting.

Variables: `RESEND_CLIENT_ID`, `RESEND_CLIENT_SECRET`. The secret is shown once in the registration response. Clients cannot be updated, so a new callback URL or a lost secret means registering a new client.

## DigitalOcean OAuth app

Reads the balance, month-to-date usage, invoices, daily spend by SKU, Droplet actions, and App Platform deployments. Full steps: [DigitalOcean, Self-hosted registration](../providers/digitalocean.md#self-hosted-registration). Scopes and what they also allow: [DigitalOcean, Permissions](../providers/digitalocean.md#permissions) and [Permission risks](../providers/digitalocean.md#permission-risks). Not yet tried with a real account.

Settings that must match the code:

- DigitalOcean control panel, **API**, **OAuth Applications**, **Register OAuth application** ([link](https://cloud.digitalocean.com/account/api/applications/new)), signed in with the team that should own the app.
- **Callback URL**: `<SITE_URL>/api/connections/digitalocean/callback`.
- Scopes are not set on the app: StackDash sends `billing:read actions:read app:read droplet:read account:read` with every authorize request, so the consent screen never offers more.

Variables: `DIGITALOCEAN_CLIENT_ID`, `DIGITALOCEAN_CLIENT_SECRET` (from the app's **View** dialog).

## PostHog client ID metadata document

Reads organization spend, projected spend, usage against each product's free allocation and billing limit, and signups per project per day. PostHog registers third-party apps by client ID metadata document: the client id is the URL of a JSON document this deployment serves, so there is no form to fill in and no client secret. StackDash signs its token requests with its own key instead (`private_key_jwt`). Full steps: [PostHog, Self-hosted registration](../providers/posthog.md#self-hosted-registration). Scopes and what they also allow: [PostHog, Permissions](../providers/posthog.md#permissions) and [Permission risks](../providers/posthog.md#permission-risks).

Settings that must match the code:

- `NEXT_PUBLIC_SITE_URL` is the public HTTPS origin. PostHog fetches the document from the internet and requires HTTPS, so local development uses the simulated provider instead.
- `POSTHOG_OAUTH_CLIENT_ID` is exactly `<SITE_URL>/oauth/posthog/client-metadata`. The route refuses to serve the document under any other client id.
- The document lists `<SITE_URL>/api/connections/posthog/callback` as its only redirect URI, `<SITE_URL>/oauth/posthog/jwks` as its `jwks_uri`, and the four read scopes as its scope ceiling. All three come from the code; there is nothing to configure.

Variables: `POSTHOG_OAUTH_CLIENT_ID`, `POSTHOG_OAUTH_PRIVATE_KEY` (a P-256 or RSA private key in PEM, generated with `openssl`; `\n` escapes are accepted). Check both routes answer JSON after deploying. Whether PostHog grants `billing:read` to a document-registered app is unconfirmed; see [PostHog, Unverified](../providers/posthog.md#unverified).

## Polar OAuth client

Reads revenue, Polar fees, recurring revenue, order and subscription counts, new customers, and order, subscription, and refund events, which a webhook can also push. Not yet registered for hosted StackDash; the adapter is built from Polar's documentation and every unconfirmed claim is listed in [Polar, Unverified](../providers/polar.md#unverified). Full steps: [Polar, Self-hosted registration](../providers/polar.md#self-hosted-registration). Scopes and what they also allow: [Polar, Permissions](../providers/polar.md#permissions) and [Permission risks](../providers/polar.md#permission-risks).

Settings that must match the code:

- Polar, **Account Settings**, **Developer** ([link](https://polar.sh/dashboard/account/developer)), create an OAuth 2.0 client of the confidential type, not a public client.
- **Redirect URIs**: `<SITE_URL>/api/connections/polar/callback`. Polar requires HTTPS except on `localhost`.
- **Scopes**: `organizations:read`, `metrics:read`, `orders:read`, `subscriptions:read`, `customers:read`, `refunds:read`, and `webhooks:write`. Nothing else. A connection asks for the six read scopes; `webhooks:write` is asked for in a second consent only when a user chooses automatic webhook setup ([Polar, Webhooks](../providers/polar.md#webhooks)). Without it on the client, automatic setup cannot get the scope, and setup by hand still works.
- Register in production (`polar.sh`), not the sandbox: the adapter calls `https://api.polar.sh` only.

Variables: `POLAR_CLIENT_ID`, `POLAR_CLIENT_SECRET`.

## Sentry integration

Reads error counts by outcome, new, regressed, and resolved issues, and releases, per project. A Sentry public integration on the integration platform; StackDash uses its OAuth install flow and never asks for an auth token. Full steps: [Sentry, Self-hosted registration](../providers/sentry.md#self-hosted-registration). Permissions and what they also allow: [Sentry, Permissions](../providers/sentry.md#permissions) and [Permission risks](../providers/sentry.md#permission-risks).

Settings that must match the code:

- Sentry, **Settings, Developer Settings, Create New Integration, Public Integration**, in the organization that should own it.
- **Redirect URL**: `<SITE_URL>/api/connections/sentry/callback`. Sentry sends `code`, `installationId`, `orgSlug`, and the `state` from the install URL here.
- **Verify Installation**: unchecked. Checking it would need a write request to Sentry after every install.
- **Permissions**: Organization Read, Issue & Event Read, Project Read (`org:read`, `event:read`, `project:read`). Everything else No Access. Team, Member, and Release permissions are not needed: releases are read with Project Read.
- **Webhook URL**: `<SITE_URL>/api/webhooks/sentry`. Under **Webhooks**, subscribe to **Issue** (new issues, resolutions, and regressions reach the timeline; assignments and archiving are acknowledged and ignored). Installation webhooks need no subscription: Sentry sends them to every public integration, and `installation.deleted` marks the connection as needing a reconnect. Leave **Alert Rule Action** off and every other subscription (Error, Comment) unchecked. See [Sentry, Webhooks](../providers/sentry.md#webhooks).

Variables: `SENTRY_CLIENT_ID` and `SENTRY_CLIENT_SECRET` (the integration's **Credentials**; the secret also signs the token refresh JWT and verifies webhook deliveries), `SENTRY_INTEGRATION_SLUG` (the slug in `https://sentry.io/sentry-apps/<slug>/external-install/`).

Until Sentry publishes it, a public integration can only be installed by the organization that created it. Hosted StackDash needs Sentry's publication review before other organizations can connect; a self-hosted install registers its own integration in its own organization and needs no review.

## Railway OAuth app

Reads deployments, resource usage, usage cost, credits, and plan. Full steps: [Railway, Self-hosted registration](../providers/railway.md#self-hosted-registration). Scopes and what they also allow: [Railway, Scopes](../providers/railway.md#scopes) and [Permission risks](../providers/railway.md#permission-risks).

Settings that must match the code:

- Created by a workspace admin: workspace **Settings**, **Developer**, **New OAuth App**.
- **App type**: **Web (Confidential)**. StackDash authenticates with `client_secret_basic` and always sends PKCE.
- **Redirect URI**: `<SITE_URL>/api/connections/railway/callback`, matched exactly. Add a separate `http://localhost:3000/...` URI for local development.
- Scopes are not set on the app: the authorize request asks for `openid email profile offline_access workspace:viewer` with `prompt=consent`, which Railway needs before it issues a refresh token.

Variables: `RAILWAY_CLIENT_ID`, `RAILWAY_CLIENT_SECRET`. The secret is shown once, right after the app is created. Railway has no token revocation endpoint, so disconnecting in StackDash deletes the tokens and asks the user to remove the app in Railway.

## GitLab OAuth application

Reads compute minutes, storage, plan, pipelines, deployments, releases, and merged merge requests on GitLab.com, and receives project webhooks for the same activity. Full steps: [GitLab, Self-hosted registration](../providers/gitlab.md#self-hosted-registration). Scopes and what they also allow: [GitLab, Permissions](../providers/gitlab.md#permissions) and [Permission risks](../providers/gitlab.md#permission-risks). Webhooks: [GitLab, Webhooks](../providers/gitlab.md#webhooks). Registering the hosted application is deferred, so the adapter is not yet confirmed with a real account ([GitLab, Unverified](../providers/gitlab.md#unverified)).

Settings that must match the code:

- GitLab.com, avatar, **Edit profile**, **Access**, **Applications**, **Add new application**. To own it as a group, use the group's **Settings**, **Applications**.
- **Redirect URI**: `<SITE_URL>/api/connections/gitlab/callback`.
- **Confidential**: checked.
- **Scopes**: `read_api`, `read_user`, and `api`. Every connection asks for `read_api read_user` only; `api` (read and write) is asked for only from a user who chooses automatic webhook setup, after a warning. GitLab refuses a scope the application does not allow, so an application without `api` offers webhook setup by hand only: choosing automatic setup then fails at GitLab's consent screen. No webhook setting is needed on the application: each webhook is added per project, by StackDash or by hand.

Variables: `GITLAB_CLIENT_ID` (the Application ID), `GITLAB_CLIENT_SECRET` (the Secret; **Renew secret** rotates it and stops the old one at once). GitLab.com only: a self-managed GitLab instance would need its own application and is not supported.

## After registering

1. Set the variables for the environment and redeploy (Vercel reads server variables at runtime, but a new deployment picks them up reliably).
2. In a test workspace, connect each provider once and check that the connection becomes active with no missing permissions.
3. Record which apps are registered, under which account, and which origin they point at. Never record the secrets.
