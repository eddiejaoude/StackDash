# Register the OAuth apps

Issues: #88 (hosted apps), #57 (self-hosting), #23 (sign-in). Connections are OAuth only: DevMacro never asks users for API keys. Each deployment therefore needs six registrations: one GitHub OAuth app for signing in to DevMacro, and one app per provider for connecting accounts.

This page lists the settings that must match the code. The provider pages under `docs/providers/` hold the full click paths, the reasons for each permission, and what each permission also allows; follow the linked section for each app.

`<SITE_URL>` below is the deployment's public origin with no trailing slash, the same value as `NEXT_PUBLIC_SITE_URL` (for example `https://devmacro.example.com`). Every provider callback is `<SITE_URL>/api/connections/<provider>/callback`. The app builds the redirect URI from `NEXT_PUBLIC_SITE_URL` when it is set and from the request origin otherwise, and providers compare it byte for byte with the registered value, so set `NEXT_PUBLIC_SITE_URL` before testing a connection.

All variables below are server only: never give them a `NEXT_PUBLIC_` prefix. Set them per environment in the host (Vercel: see [Deploy, environment variables](deploy.md#environment-variables)), or in `.env.local` for local development. Never commit them.

## Hosted and self-hosted

- **Hosted DevMacro**: Eddie registers each app once, owned by the DevMacro account or organization, with callbacks on the production origin. Hosted users connect through these apps and never create their own.
- **Self-hosted DevMacro**: every install registers its own apps with the same permissions, because the callback URLs, client secrets, and private keys belong to one deployment. Never reuse the hosted apps' credentials.
- **Local development and previews**: provider callbacks are fixed per app (Vercel allows a single Redirect URL), so a preview deployment cannot complete a provider connection with the production apps. Register separate development apps with `http://localhost:3000/...` callbacks where the provider allows them. End-to-end tests use the fake provider instead (`DEVMACRO_ENABLE_FAKE_PROVIDER=1`, never in production). To try every provider locally without registering any app, simulate them (`DEVMACRO_SIMULATE_PROVIDERS=1`, local only and refused on a Vercel production deployment): each connection is labeled "Simulated" and its data is made up on your machine.
- **Webhooks** are Post-MVP (#28). Leave every webhook setting empty or inactive.

## Summary

| App | Register at | Callback | Permissions (all read-only except where noted) | Variables |
|---|---|---|---|---|
| GitHub OAuth app (sign-in) | GitHub, Settings, Developer settings, OAuth Apps | `https://<project-ref>.supabase.co/auth/v1/callback` | `read:user user:email` (requested by the sign-in page) | Entered in Supabase Auth, not in the app |
| GitHub App | GitHub, Settings, Developer settings, GitHub Apps | `<SITE_URL>/api/connections/github/callback` (callback and setup URL) | Metadata read, Organization Administration read, Account Plan read | `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` |
| Vercel Integration | Vercel, Integrations Console | `<SITE_URL>/api/connections/vercel/callback` | `billing`, `deployment`, `project`, `team` at Read | `VERCEL_CLIENT_ID`, `VERCEL_CLIENT_SECRET`, `VERCEL_INTEGRATION_SLUG` |
| Stripe App | Stripe CLI (`stripe apps`) and Dashboard | `<SITE_URL>/api/connections/stripe/callback` | `event_read`, `charge_read`, `customer_read`, `subscription_read`, `invoice_read`, `balance_read`, `payout_read` | `STRIPE_APP_CLIENT_ID`, `STRIPE_APP_SECRET_KEY`, `STRIPE_APP_TEST_SECRET_KEY` (optional) |
| Supabase OAuth app | Supabase, organization settings, OAuth Apps | `<SITE_URL>/api/connections/supabase/callback` | `organizations:read`, `projects:read`, `analytics:read` | `SUPABASE_OAUTH_CLIENT_ID`, `SUPABASE_OAUTH_CLIENT_SECRET` |
| Resend OAuth client | `POST https://api.resend.com/oauth/register` | `<SITE_URL>/api/connections/resend/callback` | `full_access` (Resend has no read-only scope; **not read-only**) | `RESEND_CLIENT_ID`, `RESEND_CLIENT_SECRET` |

A provider whose variables are missing shows as not configured in the connection catalog; the other providers keep working.

## GitHub OAuth app for sign-in

Signing in to DevMacro goes through Supabase Auth with GitHub. This is a classic **OAuth app**, separate from the GitHub App below.

1. GitHub, **Settings, Developer settings, OAuth Apps, New OAuth App** ([direct link](https://github.com/settings/developers)). Use the organization's developer settings to own it as an organization.
2. **Application name**: for example `DevMacro`. **Homepage URL**: `<SITE_URL>`.
3. **Authorization callback URL**: `https://<project-ref>.supabase.co/auth/v1/callback`, the Supabase project's Auth callback, not a DevMacro URL. Locally it is `http://127.0.0.1:55421/auth/v1/callback` (from `supabase/config.toml`), in a separate OAuth app.
4. Leave **Enable Device Flow** unchecked. Register, then **Generate a new client secret**.
5. Hosted: paste the client ID and secret in the Supabase dashboard, **Authentication, Sign In / Providers, GitHub** ([Deploy, step 3](deploy.md#github-sign-in-provider)). Locally: `SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID` and `SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET` in `supabase/.env.local`, read by the Supabase CLI only.

The sign-in page requests `read:user user:email`, so Supabase receives the account's email, which the invite hook checks against `public.access_invites`.

## GitHub App

Reads organization and personal billing usage, stars, and forks. Full steps: [GitHub, Self-hosted registration](../providers/github.md#self-hosted-registration). Permissions and why: [GitHub, Permissions](../providers/github.md#permissions).

Settings that must match the code:

- **Callback URL**: `<SITE_URL>/api/connections/github/callback`.
- **Setup URL**: the same `<SITE_URL>/api/connections/github/callback`, with **Redirect on update** checked.
- **Request user authorization (OAuth) during installation**: unchecked (it disables the setup URL; DevMacro runs the user authorization itself, with PKCE).
- **Expire user authorization tokens**: checked. **Enable Device Flow**: unchecked.
- **Webhook**: **Active** unchecked.
- **Permissions**: Repository, Metadata: Read-only. Organization, Administration: Read-only. Account, Plan: Read-only. Everything else: No access.
- **Where can this GitHub App be installed?**: **Any account** for hosted DevMacro or a shared install; **Only on this account** for a single-user self-host.

Variables: `GITHUB_APP_ID` (App ID), `GITHUB_APP_SLUG` (from `https://github.com/apps/<slug>`), `GITHUB_APP_CLIENT_ID` (Client ID, not the App ID), `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_PRIVATE_KEY` (the downloaded PEM; `\n` escapes are accepted when the host stores single-line values). Delete the downloaded PEM file once it is stored.

## Vercel Integration

Reads team plan, billing charges, deployments, and projects. Full steps, including the required profile fields: [Vercel, Self-hosted registration steps](../providers/vercel.md#self-hosted-registration-steps). Scopes and what they also allow: [Vercel, Scopes requested](../providers/vercel.md#scopes-requested) and [Permission risks](../providers/vercel.md#permission-risks).

Settings that must match the code:

- Create it in the Vercel team that should own it: **Integrations, Integrations Console, Create**.
- **Redirect URL**: `<SITE_URL>/api/connections/vercel/callback`. It is a single field, so one integration serves one origin.
- **API Scopes**: `billing` Read, `deployment` Read, `project` Read, `team` Read. Everything else None.
- **Webhook URL** and **Configuration URL**: empty.

Variables: `VERCEL_CLIENT_ID` (`oac_...`), `VERCEL_CLIENT_SECRET` (from **Credentials**; **Rotate Secret** is there too), `VERCEL_INTEGRATION_SLUG` (the URL Slug, used to build `https://vercel.com/integrations/<slug>/new`).

Adding or upgrading a scope later emails every installer for confirmation, so register with exactly these four.

## Stripe App

Reads revenue, fees, payouts, subscriptions, and payment and customer events. A Stripe App is built and uploaded with the Stripe CLI; it exists only to request permissions and issue OAuth tokens. Full steps: [Stripe, Self-hosted setup](../providers/stripe.md#self-hosted-setup) and the manifest in [Packaging the Stripe App](../providers/stripe.md#packaging-the-stripe-app). Permissions and what they also allow: [Stripe, Permissions](../providers/stripe.md#permissions).

Settings that must match the code:

- Owner account: a Stripe account used only for the app, without Connect enabled. One account owns at most one public app.
- `stripe-app.json`: `distribution_type` `public`, `stripe_api_access_type` `oauth` (fixed after the first upload), `allowed_redirect_uris` `["<SITE_URL>/api/connections/stripe/callback"]` (HTTPS for live mode).
- Permissions, added with `stripe apps grant permission`: `event_read`, `charge_read`, `customer_read`, `subscription_read`, `invoice_read`, `balance_read`, `payout_read`. Nothing else.
- After `stripe apps upload`: in the Dashboard, **Created apps**, select the app, **Set external test version**, **Access**: **Anyone with the link**. Up to 25 external testers can install an unpublished app; MVP testers are added this way ([External testers and review](../providers/stripe.md#external-testers-and-review)). Testers need the Apps administrator role on their Stripe account.

Variables: `STRIPE_APP_CLIENT_ID` (the `client_id` in the OAuth install link), `STRIPE_APP_SECRET_KEY` (live secret key `sk_live_...` of the owner account; Stripe Apps have no client secret, and a restricted key does not work), and `STRIPE_APP_TEST_SECRET_KEY` (`sk_test_...`, only to accept installs from the test mode link).

## Supabase OAuth app

Reads organization plan and limits, project health, and auth activity counts. Full steps: [Supabase, Self-hosted registration](../providers/supabase.md#self-hosted-registration). Scopes and why `database:read` is never requested: [Supabase, Scopes and why](../providers/supabase.md#scopes-and-why).

Settings that must match the code:

- Supabase dashboard, organization settings, **OAuth Apps**, **Add application** ([link](https://supabase.com/dashboard/org/_/apps)).
- **Redirect URL**: `<SITE_URL>/api/connections/supabase/callback`.
- **Scopes**: Organizations read, Projects read, Analytics read (`organizations:read`, `projects:read`, `analytics:read`). Nothing else. Scopes cannot be narrowed per request, and changing them later sends every user through consent again.

Variables: `SUPABASE_OAUTH_CLIENT_ID`, `SUPABASE_OAUTH_CLIENT_SECRET`.

This is unrelated to the Supabase project that hosts DevMacro itself; register it in whichever organization should own the app.

## Resend OAuth client

Reads email usage, quotas, and domains. Resend has no dashboard page for OAuth clients: registration is one API call, as a pre-registered confidential client. Full steps and the request body: [Resend, Self-hosted registration](../providers/resend.md#self-hosted-registration). Why the scope is broad: [Resend, Permission risks](../providers/resend.md#permission-risks).

Settings that must match the code:

- `redirect_uris`: `["<SITE_URL>/api/connections/resend/callback"]` (HTTPS; loopback `http` only for local development).
- `token_endpoint_auth_method`: `client_secret_basic`. `grant_types`: `authorization_code`, `refresh_token`. `scope`: `full_access`, the only scope that can read usage. It is **not** read-only; the connect flow tells users so before redirecting.

Variables: `RESEND_CLIENT_ID`, `RESEND_CLIENT_SECRET`. The secret is shown once in the registration response. Clients cannot be updated, so a new callback URL or a lost secret means registering a new client.

## After registering

1. Set the variables for the environment and redeploy (Vercel reads server variables at runtime, but a new deployment picks them up reliably).
2. In a test workspace, connect each provider once and check that the connection becomes active with no missing permissions.
3. Record on #88 which apps are registered, under which account, and which origin they point at. Never record the secrets.
