# Roadmap

What is being built now, what comes next, and what is planned after that. This page is the public summary of the project board the maintainers plan StackDash on, and it changes when the board does. It names no dates: work moves up or down as priorities change.

Last checked against the board: 2026-11-16.

## How this page maps to the board

Every item on the board is an issue in the [StackDash repository](https://github.com/eddiejaoude/StackDash/issues), with a status and a priority from P0, the most urgent, to P3.

| Section on this page | Status on the board |
|---|---|
| [Now](#now) | In progress or In review |
| [Next](#next) | Ready: specified and waiting for someone to pick it up |
| [Later](#later) | Backlog, priority P0 or P1 |
| [Further out](#further-out) | Backlog, priority P2 or P3 |

- Work that is done leaves this page. What StackDash does today is in the README's feature list and in these docs.
- Each line sums up a theme, in what a person using or hosting StackDash would notice, rather than tracking one issue. Bug fixes, test reliability, and internal refactors are on the board too, summed up in one line per section.
- An issue that is blocked, waiting on a decision or on someone outside the project, stays in its section and says so.
- An issue with no priority yet appears here once it has one.
- This page is updated when work ships or priorities change. The date above says when it was last checked against the board.
- The roadmap on the home page sums up the same sections in fewer words: its **Coming next** card covers Now, Next, and Later, and its **Further out** card covers Further out.

Want something that is not here? Search the issues first, then open a new one: a request for a new provider starts with an adapter request.

## Now

- **Events pushed by webhook from GitLab, Resend, and Polar**, so pipelines, deployments, releases, merge requests, email and domain events, orders, subscriptions, and refunds reach the timeline within a minute instead of at the next hourly sync.
- **Security scanning in CI**: dependency review, code scanning, and secret scanning on every pull request.
- **Fixes** to how connections set up and remove their webhooks.

## Next

- **Hosted version.** Run the sync scheduler and background jobs for the hosted version, and decide its billing provider, tax approach, and plan limits.
- **Dashboard and achievements.** Clearer dashboard figures and chart series names, one consistent list of unusual days, and a deployment streak counted across every provider that deploys.
- **Privacy.** Remove an account's invite and sign-in records when the account is deleted.
- **Fixes.** The timeline, alerts, connections, webhooks, sign-in, the content security policy, and the docs, plus the reliability of the end-to-end tests.

## Later

- **Hosted version launch.** Deploy the hosted app with its production Supabase project, register its provider apps and webhook endpoints, and move it to its own domain.
- **A first useful result sooner.** Take a new user from signing in to a connected provider and a timeline worth reading in as few steps as possible, before sign-up opens wider.
- **Open sign-up.** Replace the invite list with abuse protection, so anyone can sign up.
- **A public demo.** A demo instance anyone can open, with a seeded sandbox workspace.
- **New integrations.** Better Stack for spend, usage, and incidents, blocked until a check confirms its API accepts the sign-in StackDash would use. Render for deploys, service events, and bandwidth, blocked until Render issues an app registration. Simulated OpenAI and Anthropic usage and cost for local demos, blocked for now.
- **Legal pages for the hosted version.** Terms, a privacy policy, a data processing agreement, and a list of subprocessors.
- **Open source launch.** Announce StackDash where self-hosters and side project builders look for tools.

## Further out

- **More integrations.** OpenAI and Anthropic usage and cost through an admin API key, and ElevenLabs credits and reset dates.
- **Teams.** Invite members to a workspace by email, change their roles or remove them, transfer ownership, leave a workspace, and create more workspaces and switch between them. Workspaces already have owner, admin, and viewer roles.
- **Public pages.** A leaderboard of verified stats that are not revenue, and public profile and project directory pages.
- **Hosted version: paid plans.** Plans and their limits, checkout, a pricing page, billing settings, the payment provider's customer portal, a grace period for failed payments, and API and MCP rate limits per plan. Plans apply to the hosted version; a self-hosted install gets its own default. Per-seat and annual pricing, coupons, trials, usage-based overage, and a second billing provider come after that.
- **Hosted version: operations.** Error tracking, uptime checks, sign-up abuse protection, backups with a restore drill, a status page, and support tiers.
- **Timeline.** Hide the event types you do not care about, save named views, give deploys, payments, and alerts their own detail fields, and serve the per-provider counts from a rollup for very large workspaces.
- **Dashboard and events.** How the monthly comparison treats accounts that start or stop reporting, blocked on a decision. Record the deployment environment on events, and add a daily logins metric.
- **Email.** A weekly email with what changed across your stack and how your leaderboard rank moved.
- **Stripe test mode webhooks.** Route Stripe deliveries by live or test mode, and push test mode events.
- **Versioned releases.** Tagged releases with release notes, to upgrade to instead of `main`.
- **A light theme**, blocked on a decision: whether to offer a manual switch as well as following the system setting.
- **An admin console** for the hosted version, with audited impersonation for support.
- **Fixes and upkeep.** A tab title that goes blank after a save. A check that a live Resend callback carries its issuer, and two dependency upgrades, are blocked until something outside the project changes.
