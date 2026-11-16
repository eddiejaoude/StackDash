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
- Each section groups related issues under one line and names what a person using or hosting StackDash would notice. Bug fixes, test reliability, and internal refactors are on the board too; they are summed up in one line rather than listed.
- An issue that is blocked, waiting on a decision or on someone outside the project, stays in its section and says so.
- When an issue changes status or priority on the board, the pull request that changes it, or the next one to touch this page, moves it here as well and updates the date above.
- The roadmap on the home page sums up the same sections: its **Coming next** card covers Now, Next, and Later, and its **Further out** card covers Further out. A change here that alters those cards changes them too.

Want something that is not here? Search the issues first, then open a new one: a request for a new provider starts with an adapter request.

## Now

- **Pushed events from GitLab**: pipelines, deployments, releases, and merged merge requests reach the timeline by webhook within a minute instead of at the next hourly sync.
- **Pushed events from Resend**: domain and email events by webhook.
- **Security scanning in CI**: dependency review, code scanning, and secret scanning on every pull request.

## Next

- **Hosted version: scheduling and workers.** Run the sync scheduler and background jobs for the hosted version.
- **Hosted version: plans and billing, being decided.** Which billing provider and tax approach to use, and which limits and prices the plans have.
- **Dashboard.** A notice when a dashboard figure was cut off at the row limit, readable names for DigitalOcean spend series with the SKU as secondary text, and one list of unusual days where the dashboard now shows two that can disagree.
- **Achievements.** Count the deployment streak across every provider that deploys, not one at a time.
- **Account deletion.** Remove an account's invite and its sign-in log entries when the account is deleted.
- **Docs.** Link the repository files these docs mention, now that the repository is public.
- **Fixes.** The timeline, alerts, connections, webhooks, sign-in, and the content security policy, plus the reliability of the end-to-end tests.

## Later

- **Hosted version launch.** Deploy the hosted app with its production Supabase project, register its provider apps and webhook endpoints, and move it to its own domain.
- **A first useful result sooner.** Take a new user from signing in to a connected provider and a timeline worth reading in as few steps as possible, before sign-up opens wider.
- **Open sign-up.** Replace the invite list with abuse protection, so anyone can sign up.
- **A public demo.** A demo instance anyone can open, with a seeded sandbox workspace.
- **New integrations.** Better Stack for spend, usage, and incidents, blocked until a check confirms its API accepts the sign-in StackDash would use. Render for deploys, service events, and bandwidth, blocked until Render issues an app registration.
- **Pushed events from Polar**: orders, subscriptions, and refunds by webhook, blocked until the shared webhook setup it builds on is finished.
- **Legal pages for the hosted version.** Terms, a privacy policy, a data processing agreement, and a list of subprocessors.
- **Open source launch.** Announce StackDash where self-hosters and side project builders look for tools.

## Further out

- **More integrations.** OpenAI and Anthropic usage and cost through an admin API key, and ElevenLabs credits and reset dates. Simulated OpenAI and Anthropic usage for local demos is blocked for now.
- **Teams.** Invite members to a workspace by email, change their roles or remove them, transfer ownership, leave a workspace, and create more workspaces and switch between them. Workspaces already have owner, admin, and viewer roles.
- **Public pages.** A leaderboard of verified stats that are not revenue, and public profile and project directory pages.
- **Hosted version: paid plans.** Plans and their limits, checkout, a pricing page, billing settings, the payment provider's customer portal, a grace period for failed payments, and API and MCP rate limits per plan. Plans apply to the hosted version; a self-hosted install gets its own default. Per-seat and annual pricing, coupons, trials, usage-based overage, and a second billing provider come after that.
- **Hosted version: operations.** Error tracking, uptime checks, sign-up abuse protection, backups with a restore drill, a status page, and support tiers.
- **Timeline.** Hide the event types you do not care about, save named views, give deploys, payments, and alerts their own detail fields, and serve the per-provider counts from a rollup for very large workspaces.
- **Dashboard and events.** Decide how the monthly comparison treats accounts that start or stop reporting, record the deployment environment on events, and add a daily logins metric.
- **Email.** A weekly email with what changed across your stack and how your leaderboard rank moved.
- **Stripe test mode webhooks.** Route Stripe deliveries by live or test mode, and push test mode events.
- **Versioned releases.** Tagged releases with release notes, to upgrade to instead of `main`.
- **A light theme**, blocked on a decision: whether to offer a manual switch as well as following the system setting.
- **An admin console** for the hosted version, with audited impersonation for support.
- **Fixes and upkeep.** A tab title that goes blank after a save, and dependency upgrades waiting on their upstream releases.
