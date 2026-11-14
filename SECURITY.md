# Security policy

StackDash stores OAuth tokens for the providers people connect, so a vulnerability can expose other
people's accounts. Report it privately, and give us the chance to fix it before anyone else
learns of it.

## Report a vulnerability

**Never report a vulnerability in a public issue, pull request, discussion, or comment.**

1. Report it through GitHub's private vulnerability reporting: open the repository's
   [Security tab](https://github.com/eddiejaoude/StackDash/security) and choose
   **Report a vulnerability**. Only you and the maintainers can read the report.
2. If that button is not shown, email [eddie@jaoudestudios.com](mailto:eddie@jaoudestudios.com)
   with "StackDash security" in the subject.

Include what you can of:

- What the vulnerability is and what an attacker gains from it.
- The steps to reproduce it, starting from a fresh local setup if you can.
- The commit you tested and the affected files, routes, or functions.
- A proof of concept that uses your own accounts and synthetic data only.

Never include a real token, secret, API key, or another person's data, even one you found through
the vulnerability. Describe it instead.

## Scope

In scope: the code in this repository and the configuration it documents, including:

- Sign-in, sessions, invites, and workspace roles.
- Tenant isolation: row level security, Server Actions, and route handlers that let one workspace
  read or change another's data.
- Provider OAuth connections, token encryption and storage, and the provider adapters.
- The REST API, the MCP server, and their API keys.
- Public project pages, badges, cards, and the published metrics API.
- Alert email, Slack, Discord, and webhook delivery, including outbound requests the app makes.
- The database migrations, scheduled jobs, and the scripts in `scripts/`.

Out of scope:

- A vulnerability in a provider's own service (GitHub, Stripe, Vercel, and the others). Report it
  to that provider. A flaw in how StackDash uses a provider is in scope.
- A vulnerability in a dependency with no path to exploit it through StackDash. Report it to the
  dependency's maintainers. If StackDash is exposed through it, it is in scope.
- Findings that need physical access to a device, an already compromised machine, or a deployment
  that ignores the setup in the README and `docs/operations/`.
- Automated scanner output with no demonstrated impact, and denial of service by volume.

## How to test

- Test only against an instance you run yourself, from a fresh clone following the README, with
  accounts and data you created.
- Never test against the hosted StackDash instance or another person's deployment, never access or
  keep data that is not yours, and never run social engineering or phishing against anyone.
- Provider connections stay in each provider's sandbox or test mode, using your own OAuth apps.

## Supported versions

StackDash has no releases yet. Fixes land on the `main` branch, so a self-hosted instance is
supported when it runs the latest `main`.

## What to expect

- We acknowledge your report within 5 business days.
- Within 10 business days of that, we tell you whether we confirmed the vulnerability and how
  severe we judge it, or why we did not confirm it.
- Until it is fixed, we update you at least every 14 days.
- Once a fix is on `main`, we publish a GitHub security advisory describing the vulnerability and
  credit you by name, unless you ask us not to.
- Please keep the vulnerability private until the advisory is published, or for 90 days after your
  report, whichever comes first, unless we agree a different date with you.
