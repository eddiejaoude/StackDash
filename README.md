# StackDash

**One timeline and one alert for your whole developer stack**

Stop switching between dashboards. StackDash puts the deploys, payments, signups, stars, and errors
from the tools you build with into one feed, and alerts you by email, Slack, Discord, or webhook
before a limit or a budget is reached. It is open source, and you can host it yourself.

[Try the demo](#try-it-with-simulated-data) · [Documentation](#documentation) ·
[Request an integration](https://github.com/eddiejaoude/StackDash/issues/new?template=adapter-request.yml) ·
[Join the launch list](https://stackda.sh)

![Animation: GitHub, GitLab, DigitalOcean, Vercel, PostHog, Stripe, Polar, Sentry, Supabase, Railway, and Resend send events along lines into one StackDash hub that counts them. Illustrative, not the product.](https://github.com/user-attachments/assets/46ca4865-66e4-4ee8-98a7-0a9797ae1ec2)

> [!NOTE]
> StackDash is an early MVP. All 11 integrations are built from each provider's documentation and
> none has been tried with a real account yet. The demo below runs on simulated data.

## See it

![Animation: the StackDash timeline of a demo workspace with 11 simulated providers. New events, among them a failed Vercel production deployment, appear at the top of Today as they arrive, and the event counts per provider go up. Simulated data.](https://github.com/user-attachments/assets/a8eb5c61-ed8d-4d23-a202-0963d9981bde)

The timeline of the demo workspace, with simulated events arriving live from 11 providers.

## Why StackDash

GitHub, Vercel, Supabase, Resend, and Stripe each answer a slice of the question, in their own units
and on their own billing cycle. None of them answers it for your whole stack, so simple questions
turn into a tour of browser tabs:

- What shipped across my projects today?
- Did that launch bring in signups, or errors?
- How many emails can I still send before the quota resets?
- Will I hear about it before a limit is reached?

StackDash answers them in one place, for solo developers running side projects and small products.

## Features

- **One activity timeline.** Deploys, stars, signups, logins, payments, and errors from every
  connected account in one feed, across several organizations, teams, and projects. Filter by
  provider, project, account, or severity.
- **Alerts where you read them.** Email, Slack, Discord, or a signed webhook. A threshold fires once
  per billing period, and unusual daily spend or usage is flagged with no setup.
- **Daily and weekly digests.** What changed across your stack, on the same channels as your
  alerts, with each number marked as verified or estimated.
- **Stats you can share.** Publish one metric at a time as a README badge, a card image, or a public
  project page. Every value is labeled verified or self-reported.
- **A read-only API and MCP server.** Read events, usage, alerts, and connections from your own
  scripts with scoped keys, or ask an AI assistant such as Claude Code or Cursor through the MCP
  server on the same keys.
- **Allowances and spend.** What is left of each included allowance, when it resets, and where it is
  heading by the end of the period. Spend per provider and project where the provider's plan
  reports it.

The dashboard opens with up to three sentences on what was unusual in the last week, with the
deploys, payments, signups, and stars of the same day, then compares revenue, spend, signups, cost
per signup, and deploys for the week or month so far. Its trend charts mark deploys, payments,
signups, stars, and alerts, and its provider cards project spend and quotas to the end of the
period, labeled as estimates. The timeline groups events by London day, opens any event's details
with a link you can share, and charts matching events over time so you can narrow the feed to one
period ([Getting started](docs/getting-started.md#4-read-the-timeline-and-the-dashboard)).

![Screenshot: the StackDash dashboard of a demo workspace with this week's revenue, spend, revenue minus spend, signups, cost per signup, and deploys, each compared with the same days last week. Simulated data.](https://github.com/user-attachments/assets/02bbc051-e035-4a0b-beac-eab1e455cda9)

## Integrations

StackDash connects 11 providers over OAuth, never with pasted provider keys. All 11 are built from
the provider's documentation and tested against sample responses taken from it; none has been
tried with a real account yet, and each provider's page lists what is still unverified. Activity
and quotas work on every plan, and spend shows only where the provider reports it.

| Provider | What StackDash reads on every plan | Spend |
| --- | --- | --- |
| [Vercel](docs/providers/vercel.md) | Deployments and projects | Pro and Enterprise plans only. Vercel shares no billing data for Hobby accounts |
| [GitHub](docs/providers/github.md) | Stars, forks, releases, merged pull requests, and opened issues | Billed usage, Actions minutes, and Copilot AI Credits on GitHub's enhanced billing platform. For an organization, an owner installs the app |
| [Resend](docs/providers/resend.md) | Emails sent against the daily and monthly quota, with reset dates | None. Resend has no billing API |
| [Stripe](docs/providers/stripe.md) | Payments, customers, subscriptions, and payouts | Stripe fees, on any account |
| [Supabase](docs/providers/supabase.md) | Plan limits, project health, signups, and logins. Daily active users on Pro and above | None. No Supabase billing endpoint accepts OAuth |
| [DigitalOcean](docs/providers/digitalocean.md) | Droplet actions and App Platform deployments | Month to date usage, balance, and invoices, if your team role can read billing |
| [PostHog](docs/providers/posthog.md) | Signups per project | Spend and projected spend per product on PostHog Cloud, for a member with billing access |
| [Railway](docs/providers/railway.md) | Deployments | Usage cost and an estimated bill on Free, Hobby, and Pro, if your role can read billing |
| [Polar](docs/providers/polar.md) | Revenue, orders, subscriptions, new customers, and refunds | Polar fees, on any organization |
| [Sentry](docs/providers/sentry.md) | Errors per project, new issues, regressions, and releases | None. Sentry has no billing endpoint for integrations |
| [GitLab](docs/providers/gitlab.md) | Compute minutes and storage for the GitLab.com namespaces you own, pipelines, deployments, releases, and merged merge requests | None. GitLab shares no cost through read-only access |

Missing a provider? Open an
[adapter request](https://github.com/eddiejaoude/StackDash/issues/new?template=adapter-request.yml),
or read [Write a provider adapter](docs/adapters.md) to build one.

## Try it with simulated data

There is no hosted demo yet. `npm run demo` builds one on your own computer: a workspace with all 11
providers simulated and 90 days of history, without registering any OAuth app. You need Node.js
22.13 or later in the 22 line, Docker, the
[Supabase CLI](https://supabase.com/docs/guides/local-development/cli/getting-started) 2.120 or
later, and `openssl`.

```bash
git clone https://github.com/eddiejaoude/StackDash.git
cd StackDash
npm ci

# The CLI needs the GitHub sign-in variables set; placeholders are enough for the demo
export SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID=local-placeholder
export SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET=local-placeholder
supabase start

cp .env.example .env.local
supabase status -o env \
  --override-name api.url=NEXT_PUBLIC_SUPABASE_URL \
  --override-name auth.publishable_key=NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY \
  --override-name auth.service_role_key=SUPABASE_SERVICE_ROLE_KEY
openssl rand -base64 32   # STACKDASH_ENCRYPTION_KEY
openssl rand -hex 32      # CRON_SECRET
```

Paste the three Supabase values and the two secrets into `.env.local`, and set
`STACKDASH_SIMULATE_PROVIDERS=1` there. After a later `git pull`, run `supabase migration up` to
apply new migrations without touching your data. Then start the app and leave it running:

```bash
npm run dev
```

Build the demo workspace in a second terminal:

```bash
npm run demo
```

Open the one-time sign-in link it prints. You land on the dashboard of **Demo workspace**, signed in
as `demo@example.com`, with every simulated provider connected. Leave `npm run demo` running and new
events keep arriving on the timeline; press Ctrl+C to stop it. The data is made up on your computer
and nothing is sent to or read from any provider. Running the command again deletes the demo
workspace and builds a new one. If port 3000 is taken, follow
[Local development, step 6](docs/development.md#6-open-the-demo-workspace) to use another port.

[Local development](docs/development.md) covers real GitHub sign-in, alert and digest email through
a local fake of Resend's API (step 12), the checks, and the end-to-end tests.

If StackDash looks useful, a star helps other developers find it.

## Self-hosting

StackDash runs on your own Vercel and Supabase projects. Start with
[Self-host StackDash](docs/operations/self-hosting.md): what you need, the order to set it up in,
and how to upgrade. [Deploy to Vercel and Supabase](docs/operations/deploy.md) goes from empty
accounts to a production deployment, [Register the OAuth apps](docs/operations/oauth-apps.md) sets up
sign-in and one app per provider, and [Jobs](docs/operations/jobs.md) schedules the syncs with
`pg_cron`. There is no Docker image. Alert email goes through Resend, so it needs a Resend account
and a verified sending domain; without one, alerts still show in the app and reach Slack, Discord,
and webhooks.

## Project status

- **Works in the demo today:** everything under [Features](#features), on simulated data. Alert
  and digest email needs the local fake from
  [Local development, step 12](docs/development.md#12-send-alert-and-digest-emails-locally-optional).
- **Not verified:** real provider accounts. No integration has been tried with one yet; each
  [provider page](docs/providers) lists what is still unverified.
- **Limits:** sign-in is GitHub only and limited to emails on the invite list. Data arrives by
  scheduled sync. Signed provider webhooks are part of the adapter contract
  ([Webhooks](docs/adapters.md#webhooks)), and each [provider page](docs/providers) says whether
  StackDash receives that provider's webhooks. There is no hosted version yet.
  Until Sentry approves the hosted integration for publication, only the organization that
  registered it can install it; self-hosters register their own
  ([Sentry provider page](docs/providers/sentry.md)).
- **Planned:** the [roadmap](docs/roadmap.md) is the public summary of the project board: what is
  being built now, what comes next, and what is planned after that.

## Documentation

- [Getting started](docs/getting-started.md): from sign-in to a published metric.
- [Connect providers](docs/connect-providers.md): what each provider needs before it connects, and
  what to do when a connection needs attention.
- [REST API](docs/api.md): read-only API keys with scopes, the `/api/v1` endpoints with `curl`
  examples, and the OpenAPI document.
- [MCP server](docs/mcp.md): connect Claude Code, Claude Desktop, Cursor, or another MCP client to a
  workspace, and the read-only tools it can call.
- [Providers](docs/providers): one page per provider, with what StackDash reads and what each
  permission allows.
- Self-hosting and operations: [self-hosting and upgrades](docs/operations/self-hosting.md),
  [deploy](docs/operations/deploy.md), [OAuth apps](docs/operations/oauth-apps.md), and
  [jobs](docs/operations/jobs.md).
- Architecture: [concepts](docs/architecture/concepts.md), [database schema](docs/architecture/schema.md),
  and [public metrics](docs/architecture/public-metrics.md).
- [Write a provider adapter](docs/adapters.md): the adapter contract, the test harness, and review.
- [Local development](docs/development.md): setup, checks, end-to-end tests, and the project layout.
- [Roadmap](docs/roadmap.md): what is being built now, next, and later, kept in step with the
  project board.

## Built with

Next.js 16 and React 19, TypeScript, Tailwind CSS 4, and Supabase (Postgres with row level security,
Auth, and `pg_cron`), tested with Vitest, pgTAP, and Playwright, and hosted on Vercel.

## Contributing

Issues, bug reports, adapter requests, and pull requests are welcome, and so are questions in
[Discussions](https://github.com/eddiejaoude/StackDash/discussions). Start with
[CONTRIBUTING.md](CONTRIBUTING.md): every change beyond a typo starts with an issue, and your first
pull request asks you to sign the contributor license agreement once. Everyone taking part follows
the [code of conduct](CODE_OF_CONDUCT.md). Report security vulnerabilities privately, as
[SECURITY.md](SECURITY.md) describes, never in a public issue.

A star on the repository helps more developers find StackDash and its integrations.

## License

Copyright (C) 2026 Eddie Jaoude.

StackDash is licensed under the [GNU Affero General Public License v3.0 only](LICENSE)
(`AGPL-3.0-only`). If you run a modified version for other people over a network, the license
requires you to offer them its source code. The license grants no trademark rights in the name or
the logo: see [Trademarks](#trademarks).

## Trademarks

StackDash and its logo are trademarks of Eddie Jaoude. The code license grants no trademark rights
in them: a modified version you distribute, or a service you host for people outside your
organization, needs its own name and logo. See [TRADEMARKS.md](TRADEMARKS.md) for what you can do
without asking.

## Third-party marks

The platform logos on the landing page use path data from [Simple Icons](https://simpleicons.org)
(CC0-1.0). The logos remain trademarks of their owners and identify the integrations StackDash
connects to. Their use implies no endorsement.
