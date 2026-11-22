# Connect providers

This guide covers what each provider needs before it can connect to StackDash, who has to approve it on the provider's side, and what to expect once it is connected. Each provider has its own page with the full detail: what StackDash reads, what each permission allows, and what is still unverified.

## Before you connect

- **In StackDash**, only owners and admins of a workspace connect, reconnect, and disconnect providers. Every member sees what is connected.
- **On your StackDash site**, each provider needs an app registered by the person who runs the site. A card that says **Not set up on this instance** under **Add a provider** has no app yet. If you run the site yourself, [Register the OAuth apps](operations/oauth-apps.md) lists the settings for each one; set the variables it names and deploy again, and the card offers **Connect**.
- **On the provider's side**, you approve StackDash on the provider's own consent screen, with an account that is allowed to grant what StackDash asks for. The table below says where that takes a particular role.
- **StackDash never asks for a provider API key.** Every connection goes through the provider's own sign-in and consent screen, and the credential it returns is stored encrypted for your workspace only.

To try every provider without registering anything, a local install can simulate them: see [Local development, step 10](development.md#10-simulate-every-provider-and-watch-it-update-live-optional). Simulated connections make up their data on your computer and are labeled **Simulated** everywhere they appear.

## Connect a provider

The steps, with the buttons as StackDash names them, are in [Getting started, connect your first provider](getting-started.md#3-connect-your-first-provider): open **Connections**, select **Connect** for the provider, check the **Permissions** and **Data collected**, and select **Continue to** the provider to approve StackDash there. You land back on the new connection's page, and its first sync is queued at once.

## Providers

| Provider | What you grant | Before you connect | Provider page |
|---|---|---|---|
| DigitalOcean | Five read-only scopes | One connection covers one DigitalOcean team; connect once per team. Billing figures need a team role that can read billing | [DigitalOcean](providers/digitalocean.md) |
| GitHub | A GitHub App with five read-only permissions | For an organization, an organization owner installs the app. A member without owner rights sends the owner a request instead | [GitHub](providers/github.md) |
| GitLab | The read-only `read_api` and `read_user` scopes | GitLab.com only, not a self-managed GitLab. StackDash lists only the namespaces you own | [GitLab](providers/gitlab.md) |
| Polar | Six read-only scopes | StackDash never writes to Polar | [Polar](providers/polar.md) |
| PostHog | Four read-only scopes | Spend and billing limits need `billing:read`. If PostHog does not grant it, signups still sync and the connection page lists the missing permission | [PostHog](providers/posthog.md) |
| Railway | Viewer access to the workspaces you pick, and your Railway sign-in | Billing shows only when Railway lets your role read it; deployments sync either way | [Railway](providers/railway.md) |
| Resend | Full access, because Resend has no read-only scope that covers usage | Full access also allows sending email and changing your Resend team, so StackDash asks you to tick the agreement before it sends you to Resend | [Resend](providers/resend.md) |
| Sentry | A Sentry integration with three read-only scopes | Until Sentry publishes an integration, only the organization that registered it can install it. On your own site, that is the organization you registered it under | [Sentry](providers/sentry.md) |
| Stripe | A Stripe App with five read-only permissions | One connection is one Stripe account in one mode, live or test. Test mode installs work only when the site has a test mode key set | [Stripe](providers/stripe.md) |
| Supabase | Three read-only scopes | StackDash never reads your database rows, only counts and timestamps | [Supabase](providers/supabase.md) |
| Vercel | A Vercel Integration with three scopes at Read level | One connection covers one team or Hobby account. Billing is available on Pro and Enterprise teams only | [Vercel](providers/vercel.md) |

Every provider page starts with how far its claims have been checked: against the provider's documentation only, or with a real account. The docs index shows the same status on each provider's card.

## After you connect

- **The first sync** starts within a minute and fills in the history the provider makes available. Until it finishes, the timeline says **Events are on their way**.
- **Later syncs** run on a schedule: hourly for most providers and every 15 minutes for Supabase. Owners and admins can select **Sync now** on a connection's page, once every 5 minutes.
- **Some providers also push events** to StackDash as they happen, so they reach the timeline within a minute instead of at the next sync. Each provider page's Webhooks section says whether that provider does, and what still arrives by sync.
- **Accounts**: one connection can cover several accounts, such as teams, organizations, or projects. On the connection's page, under **Accounts**, choose which project each account belongs to.

## When a connection needs attention

A connection's status shows on its page and on **Connections**:

- **Active**: syncing on schedule.
- **Needs attention**: the provider refused the credential, or a permission StackDash needs was not granted. The connection stops syncing until an owner or admin selects **Reconnect** and approves StackDash again. When a permission is missing, the page names it.
- **Failed**: syncs kept failing for a reason on the provider's side, such as an outage. StackDash keeps retrying once an hour on its own, and the first successful sync makes it active again.
- **Disconnected**: someone selected **Disconnect**. The credential is deleted and the history already collected is kept. **Reconnect** at any time.

Each problem writes one sync failed event to the timeline, not one per retry. To remove a connection together with everything it collected, select **Delete connection and history**.

How syncs, retries, and retention work on the server is in [Jobs](operations/jobs.md).
