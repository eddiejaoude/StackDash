# Write a provider adapter

A provider adapter connects StackDash to one provider's API: it runs the OAuth connection, reads usage, spend, revenue, and activity on a schedule, and maps them onto StackDash's metric and event model. This guide takes you from a copy of the example adapter to a pull request: the interface, capabilities, metric kinds, provenance rules, security requirements, tests, every file a new provider touches, and how adapters are reviewed.

## Before you start

- **Ask first.** Open an issue with the **Adapter request** template. It asks for the provider's OAuth support, the scopes, the data StackDash would read, what those scopes also allow, and the known limits. A maintainer answers with go or no-go before any code is written, because some providers cannot be connected the way StackDash requires.
- **OAuth only.** A user connects a provider through the provider's OAuth authorization code flow. StackDash never asks anyone to paste an API key, so a provider without OAuth cannot have an adapter.
- **Webhooks where the provider pushes, polling as the backfill.** An adapter is called on a schedule and reads what changed. Where the provider pushes signed events, the adapter also declares `webhooks`, so those events reach the timeline within a minute. Polling still runs: it catches a delivery that was missed and stays the only source of spend and usage (see [Webhooks](#webhooks)).
- **Read only.** Ask for the narrowest read scopes that cover what the adapter reads. A scope that can also write needs a reason the user sees before connecting. The one exception is automatic webhook setup, which the user opts into on the connection page: where the provider has no read-only access that can create a webhook, StackDash asks for write access in a second consent, after saying why, and setup by hand stays available for a user who wants StackDash to stay read-only (see [Webhooks set up per connection](#webhooks-set-up-per-connection)).
- **No new dependencies.** Adapters call the provider's HTTP API with the shared `fetchJson` helper and parse responses with `zod`. Adding a provider SDK or any other package is a maintainer decision: raise it on the adapter request issue first.

## Review and trust

**Every adapter is reviewed by a maintainer before it is released, and an adapter is never run untrusted with production secrets.**

Until a maintainer has reviewed and merged it, your adapter runs only on your own machine: in unit tests against recorded fixtures and, if you choose, against your own sandbox account with your own OAuth app. The local simulator never calls your adapter to connect or sync: with `STACKDASH_SIMULATE_PROVIDERS=1` the app swaps every live adapter for its simulated profile, which makes up its data, so data on screen there does not mean your code ran. Only a webhook delivery posted to a simulated provider runs your `verify` and `parse` (see [Webhooks](#webhooks)). Your adapter never receives a production OAuth client secret or a user's token: those exist only in the environment of a deployed instance, which runs merged code only. Never ask for production credentials to test an adapter, and never paste a real token, client secret, or private response into an issue, a pull request, a fixture, or a log. When you test against your sandbox account, keep its secret in your git-ignored `.env.local`, and scrub every response before it becomes a fixture.

## Quick start

The example adapter in `src/lib/adapters/example` talks to Example Cloud, a fictional hosting and payments platform whose whole API is the recorded responses in its `fixtures` folder. It exercises every capability an adapter can declare. Copy it and rename the provider id (here `acme`):

```bash
cp -R src/lib/adapters/example src/lib/adapters/acme
grep -rl -i example src/lib/adapters/acme | xargs perl -pi -e 's/example/acme/g; s/Example/Acme/g; s/EXAMPLE/ACME/g'
npx vitest run src/lib/adapters/acme
npm run typecheck
```

The copy's tests pass and it type checks without a change to any shared file, because an adapter can declare an id that is not registered yet (`ProviderAdapter<"acme">`). Then replace Example Cloud with your provider, one piece at a time, keeping the tests green:

1. Write down the provider's API in the provider page (see [Provider page template](#provider-page-template)) before writing code: endpoints, scopes, units, limits.
2. Replace the fixtures with your provider's responses (see [Fixtures](#fixtures)).
3. Replace the schemas in `schemas.ts` with your provider's response shapes.
4. Replace the OAuth details, the reads, and the mappings in `index.ts`.
5. Rewrite the tests in `index.test.ts` for your provider's rules, keeping the contract checks. Delete the case "declares every data capability": it holds for Example Cloud only.

The adapter is not offered to users until it is registered (see [Register the provider](#register-the-provider)).

## What the example contains

| File | What it shows |
|---|---|
| `index.ts` | The adapter: OAuth with PKCE and rotating refresh tokens, revocation, account listing, a sync that reads one primary endpoint and three optional ones, and a signed webhook that pushes the same events the sync reads |
| `schemas.ts` | One `zod` schema per response and per webhook body, parsed at the boundary so nothing unvalidated reaches the mapping code |
| `fixtures/*.json` | One recorded response per endpoint and one webhook delivery, with synthetic ids, tokens, and amounts |
| `index.test.ts` | The contract checks from the harness, then happy path and boundary tests for every rule |

## The adapter interface

An adapter is one object implementing `ProviderAdapter` (`src/lib/adapters/types.ts`). The sync runner, routes, and pages only ever talk to that interface, so nothing outside the adapter branches on the provider.

| Member | Rule |
|---|---|
| `id` | Lowercase letters and digits. It prefixes every metric key and event type id the adapter owns, and it is stored, so it never changes |
| `displayName` | The provider's own name, as users know it |
| `capabilities` | What the adapter reports (see [Capabilities](#capabilities)) |
| `permissions` | One entry per requested scope for the connect screen: what it is for in plain words, and for a scope that can also write, `access: "full"` with the reason it is needed |
| `dataCollected` | One plain line per kind of data read, shown before the user grants access |
| `eventTypes` | Every event type the adapter can emit (see [Events](#events)) |
| `achievements` | The permanent outcomes the provider's data can prove for a project (see [Achievements](#achievements)). Omit when none |
| `projectedSpend` | Estimated spend metric keys that are a projection for the whole billing period. Every reading of spend leaves them out. Omit when none |
| `signupDailyTotals` | Usage metric keys that hold one UTC day's signups, for a provider that reports a daily total instead of one event per signup. Omit when none |
| `dailyTotals` | Usage metric keys that hold the total of one whole UTC day and are not signups (GitHub's `github.stars.gained.daily`). The reading's timeframe is that day. Such a key feeds achievements, not usage to watch: the unusual spend and usage checks never read it, and alert settings does not offer it to mute. Omit when none |
| `beta` | A one sentence reason shown beside a "Beta" badge on the provider's card. Omit when not in beta |
| `oauth` | Authorize, token, and revoke URLs, the requested scopes, whether PKCE is used, and the names (never the values) of the environment variables holding the client id and secret, plus `extraEnv` for any other app setting the provider needs (an integration slug, an app's private key) and `optionalExtraKeys` for the ones an instance may leave unset |
| `pollIntervalSeconds` | How often to sync. Hourly (3600) unless the provider's limits or retention need otherwise. At least 60 |
| `webhooks` | The provider's push path: where deliveries arrive, the events subscribed to, and how a delivery is verified and mapped (see [Webhooks](#webhooks)). Omit when the provider cannot push signed events |
| `buildAuthorizeUrl` | The URL the user is sent to. Always sends the scopes explicitly, the `state`, and the PKCE challenge |
| `exchangeCode` | Swaps the callback's code for a credential. Callback parameters are untrusted: verify them |
| `refreshTokens` | Returns a new credential. Omit when the provider's tokens never expire. StackDash calls it through `refreshIfExpiring` (`src/lib/connections/credential-refresh.ts`) and saves the result before anything uses it; every refresh of one connection (a sync, automatic webhook setup, removal on disconnect) runs under the connection's refresh lock, so it is never called twice at once for one connection |
| `revoke` | Ends the grant at the provider. Omit when the provider has no revocation endpoint |
| `listAccounts` | The accounts, organizations, teams, or projects the grant can read. Each becomes an external account the user can include |
| `installationIdOf` | The provider installation a credential belongs to, read from the credential alone (no network), or null. StackDash stores it on the connection when a grant completes, and on the next sync of a connection made before it existed, so an uninstall naming only the installation finds the connection, and events naming an installation reach only its connections (see [Webhooks](#webhooks), Uninstalls and Events from an installation). Omit when the provider's uninstalls name an account |
| `detectMissingPermissions` | The requested scopes absent from a grant. Empty means nothing is missing |
| `sync` | Reads one external account and returns metrics, events, an optional cursor, and partial errors |

Every method receives a context instead of reaching for globals: `ctx.fetch` for every request, `ctx.now()` for the time, `ctx.timeoutMs`, `ctx.logger`, and for OAuth calls the client id, the secret, and those extra settings, each a `Secret` in `ctx.client.extra`. An adapter sees exactly one credential, the one it is handed.

## Capabilities

Capabilities say what an adapter reports, and the dashboard leaves out what a provider never declares. `oauth: true` and `polling: true` are fixed by the type. Webhooks are not a capability: an adapter that receives them declares `webhooks` (see [Webhooks](#webhooks)).

| Capability | Declare it when the adapter emits | Example Cloud |
|---|---|---|
| `usage` | `usage` metrics: a quantity used in a period | Requests this billing period |
| `allowance` | `included_allowance` and `remaining_allowance` metrics | Requests the plan includes and requests left |
| `spending` | `verified_spend` or `estimated_spend` metrics | Spend this period, and the overage it is on course for |
| `credits` | `credit_balance` metrics | Account credit |
| `revenue` | `revenue` or `recurring_revenue` metrics | Revenue this period and monthly recurring revenue |
| `events` | Timeline events, with at least one declared event type | Signups and deployments |

The harness fails a sync result that emits a metric kind whose capability is false, a declaration whose `events` capability disagrees with its event types, and a declaration with `webhooks` whose `events` capability is false.

## Metric kinds

Metrics are validated by `AdapterMetricSchema` (`src/lib/adapters/metrics.ts`) before anything is stored, and one invalid metric rejects the whole batch.

| Kind | Value | Use it for |
|---|---|---|
| `usage` | `value` and `unit` | A quantity consumed: emails sent, build minutes, requests |
| `included_allowance` | `value` and `unit` | What the plan includes for that quantity |
| `remaining_allowance` | `value` and `unit` | What is left of the allowance, never below zero |
| `verified_spend` | `amountMinor` and `currency` | Money the provider itself reports as charged |
| `estimated_spend` | `amountMinor` and `currency` | Money StackDash calculates from usage and a price list |
| `credit_balance` | `amountMinor` and `currency`, may be negative | Prepaid credit or a balance owed |
| `revenue` | `amountMinor` and `currency`, may be negative | Money earned in a period, net of refunds |
| `recurring_revenue` | `amountMinor` and `currency` | A run rate at one moment, such as monthly recurring revenue. Never summed into revenue |

`budget` is also a kind, but budgets are set by users in StackDash and an adapter can never emit one.

Every metric also carries:

- `metricKey`: lowercase and dotted, starting with the adapter's id (`acme.requests.used`). It is stored, so renaming one later is a migration.
- `label`: plain words, at most 120 characters.
- `timeframe`: a `period` with a start and an end, or a `point` in time.
- `externalAccountId`: the account the sync was called for, and no other.
- `retrievedAt`: `ctx.now()` at the start of the sync.
- `resetsAt`: when a quota resets, when the provider says so.

Money is an integer in minor units (cents, pence) with its ISO 4217 currency, never a float. Convert the provider's figure once, at the boundary, and round once, at the end of a calculation, with the rule named in a comment. A unit is a short word such as `requests`, `minutes`, or `GB`. When the provider has no figure (a plan without a quota), leave the metric out: never invent a zero or an infinity.

## Provenance

Every metric says where it came from in `provenance`:

- `source: "provider_api"`: the provider reported the figure. `endpoint` names the origin and path it came from, with placeholders for ids and never a query string, because query strings can carry tokens.
- `source: "derived"`: StackDash calculated it. An `estimated_spend` metric must be derived and must name its price list in `pricingSource`, with the date it was checked, because the user deserves to know what an estimate rests on.

The dashboard labels figures verified or estimated from the kind, so never report an estimate as `verified_spend`. A figure that predicts the whole billing period, rather than what has been spent so far, is a projection: declare its key in `projectedSpend` so no total counts it as money already spent.

## Events

An event type is declared once, in `eventTypes`, with a stable id (`acme.deploy.failed`), a label, a description, whether it is shown by default, an emoji, and optionally a category (`signup`, `deploy_succeeded`, or `deploy_failed`) so the dashboard headline counts it. An event emitted with an undeclared type id rejects the whole batch. The label is the type's name everywhere the app names it: the timeline's event type filter and its chips, a collapsed run of events, **Event details**, and the command palette. Write it the way a person would say it (`Payment succeeded`, not `Charge succeeded`), since the id's own words are shown only for a type no adapter declares any more.

The `emoji` is one emoji for what happened (`🚀` a deployment went live, `💳` a payment), shown in the corner of the provider's logo on every timeline row; it is decorative, so the label still says it in words, and a new type reuses the emoji similar adapters use for the same kind of event (`💥` for a failed deployment, `👋` for a signup).

Each event carries a type id, when it happened, a severity (`info`, `success`, `warning`, `critical`), a title of at most 200 characters, an optional body, the external account, and a dedupe key that is the same every time the same event is read, so reading it twice never stores it twice. An optional link must be `https`: an event with any other link fails validation, and that rejects the whole batch. Drop a link that is not `https` before the event reaches the batch, as the example's `httpsUrl` does.

The event model has no field for a person, on purpose: no names, emails, usernames, or avatars. Count a signup; never record who signed up.

Read events with a cursor: an opaque string the adapter returns from one sync and receives in the next. Bound every read: a page size and a maximum number of pages per sync, with the cursor set to where the read stopped, so a busy account catches up over several syncs instead of one sync running without end. On the first sync, read a short backfill window (the example reads 7 days), not the whole history. If the cursor comes back unreadable, log it and start again from the backfill window rather than failing every future sync.

## Webhooks

Where a provider pushes signed events, the adapter declares `webhooks`, so an event reaches the timeline within a minute instead of on the next poll. Polling keeps running: it catches a delivery that was missed or failed, and it stays the only source of spend and usage, which no connected provider pushes. A provider whose deliveries are unsigned (Railway) stays polling only, because StackDash cannot tell a real delivery from a forged one. So does a provider with no webhooks (PostHog, DigitalOcean, Supabase).

| Member | Rule |
|---|---|
| `registration` | `{ kind: "app", secretEnv }` when the provider sends every account's deliveries to one URL on StackDash's own app registration; `secretEnv` names the instance setting holding the signing secret. `{ kind: "connection", setup }` when each connection has its own URL and secret, created through the provider's API or added by the user; that secret is stored encrypted like other credentials, and `setup` says how the user gets the webhook (see [Webhooks set up per connection](#webhooks-set-up-per-connection)) |
| `subscriptions` | The provider's own event names StackDash subscribes to, each once |
| `verify(request, secret, now)` | Checks the delivery against its raw body and headers, and returns the provider's delivery id or the reason it was rejected |
| `parse(request, ctx)` | Maps a verified body onto the adapter's declared event types: events for one external account, an uninstall, or ignored |

Deliveries arrive at `POST /api/webhooks/<provider>` for an app registration and `POST /api/webhooks/<provider>/<endpointId>` for a connection registration. The route verifies the delivery, records it, answers the provider at once, and leaves the rest to the job queue, which stores the events on its next tick, within a minute. `verify` and `parse` are synchronous and never call the network, so the route answers within the provider's deadline. A connection URL answers at most 50 verified deliveries a minute and then `429` until the next minute, because the user who connected holds its secret and could otherwise sign deliveries without limit. The number is the webhook jobs a tick claims (`WEBHOOK_TICK_CLAIM_LIMIT`), and a tick runs every minute, so one connection at its limit queues no more a minute than a tick takes and cannot on its own grow the backlog every workspace's deliveries share. The provider retries what was refused. The app URL is not limited, because only the provider holds its secret.

With `STACKDASH_SIMULATE_PROVIDERS=1`, a simulated provider keeps its live adapter's `webhooks`, so a delivery posted to it runs your `verify` and `parse`. An app registration is then checked with `STACKDASH_SIMULATED_WEBHOOK_SECRET` instead of `secretEnv`, so simulation never needs the provider's real secret; a connection registration keeps the secret stored for its connection. The webhook job keeps simulated connections and real ones apart, by the scope a simulated grant records: the route records with each delivery whether the simulated twin verified it, and the job applies one the twin verified to simulated connections only and any other to real connections only, whatever the flag says when the job runs, so a delivery signed with the simulated secret never lands on a real connection that includes the same account. Within that, a delivery to the app URL reaches every such connection that includes its account (and, for events naming an installation, whose recorded installation is that one: a simulated grant's installation is its seed), while a delivery to a connection URL reaches that connection only. A target of the other kind is left out and counted in `webhook.targets_dropped`. Each provider's `e2e/webhooks-<provider>.spec.ts` posts its deliveries this way.

The example adapter shows each rule:

- **Verify before parsing.** `verify` reads only the raw body bytes and the headers. Never parse or decode the body before the signature matches: a parsed body has lost the bytes the signature covers.
- **Constant time.** Compare signatures with `safeEqual` from `src/lib/webhooks/signature.ts`, never with `===`. `hmacHex` computes a hex HMAC (SHA-256 or SHA-1) of the raw bytes. A provider that signs with [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) (Polar) verifies with `verifyStandardWebhook` from `src/lib/webhooks/standard-webhooks.ts`, passing its header names and the HMAC keys its secret stands for: it applies the freshness, replay, and delivery id rules below.
- **Freshness.** When the provider signs a timestamp, reject one outside the provider's documented tolerance, in either direction, with `isFresh`, so a captured delivery cannot be replayed later. The timestamp only protects against replay when it is part of what is signed.
- **Replay.** When the provider signs its delivery id, check the id as part of the signature, so a captured delivery posted again under a new id is `bad_signature` (the example and the fake provider sign `<delivery id>.<timestamp>.<raw body>`, the Standard Webhooks layout). When it does not (GitHub's `X-GitHub-Delivery`), the id only deduplicates honest retries: a replay under a new id is bounded by the signed timestamp where there is one, and otherwise (GitHub signs no timestamp) only by each event's `dedupeKey` and an uninstall's `occurredAt`. Say which applies in the adapter's header comment.
- **Delivery id.** Return the provider's own id for the delivery (GitHub's `X-GitHub-Delivery`, Svix's `webhook-id`), read with `readDeliveryId`. StackDash stores it with a unique key per provider, endpoint, and delivery id, and acknowledges a repeat without processing it again, because providers deliver at least once. The endpoint is part of the key because a provider such as Svix sends one message id to every endpoint of an account, so the same id at two connections' URLs is two deliveries.
- **Rejections.** A delivery is rejected as `missing_signature`, `bad_signature`, `stale`, or `malformed`. The reason is logged, never the body, the headers, or the secret.
- **Reconciliation.** Each event's `dedupeKey` is the one `sync` produces for the same provider event, so a delivery and a later poll store it once. Build both from one function: the example's `toActivityEvents` and the fake provider's `buildEvent` serve `sync` and `parse` alike. Whichever arrives first decides the stored event; the one thing a later write can add is the `body`, and only when the first write had none (`insert_activity_events`). So a delivery that cannot build the body `sync` builds must leave `body` out, as Vercel's and GitLab's deployment deliveries do, rather than send a shorter one, which would then be final.
- **No personal data.** `parse` reads only the fields the timeline shows, as `sync` does: no names, emails, or free text from the user's app.
- **Ignore what you do not map.** A verified delivery of a type the adapter does not show returns `ignored` with a short reason, never an error, so the provider does not retry it.
- **Uninstalls.** When the provider reports that StackDash was removed, return `uninstalled` with `occurredAt`, the time the provider gives for the removal, so the connections it was removed from ask for a reconnect at once instead of after the next failed sync. Name what was removed. Where the account is what the provider uninstalls (a Vercel team, a Stripe account, a GitHub installation's owner), return `externalAccountId` (`by: "account"` is optional), and every connection that includes that account is marked. Where the delivery names only an installation and no account (Sentry's `installation.deleted` names `installation.uuid`, and Sentry's accounts are projects), return `by: "installation"` with `installationId`, and declare `installationIdOf` so each connection records the installation its credential belongs to; every connection of the provider with that installation is marked. The harness and the webhook route refuse an installation from an adapter without `installationIdOf`. A connection granted again after `occurredAt` (a reconnect, which StackDash records as `granted_at`) is left to its next sync, because a late or redelivered uninstall must not revoke a connection the user has since reconnected. A token refresh is not a grant, so it does not protect a connection from an uninstall that happened before it.
- **Events from an installation.** Where an account outlives an uninstall, because the provider uninstalls an installation and the accounts are something inside it (Sentry's projects), also return `installationId` on `events`: the installation that sent the delivery. The events then reach only connections that include the account and whose credential belongs to that installation, so a connection left needing a reconnect after an uninstall receives nothing from a later install of the same organization. A connection with no recorded installation receives nothing from such a delivery either: an `active` or `failed` one until its next sync records its installation, within the hour, with polling bringing its events meanwhile, and a `needs_attention` one, which is not synced, until the user reconnects it. Declare `installationIdOf`, as for an uninstall naming an installation: the harness and the webhook route refuse `installationId` from an adapter without it, and a blank one.

### Webhooks set up per connection

Where an adapter declares `{ kind: "connection", setup }`, because the user has to create the webhook in the provider, the connection page shows a setup panel, "Get events as they happen", once the provider connects. The user chooses between automatic setup and setup by hand before anything is requested or changed. Resend declares one (`src/lib/adapters/resend/index.ts`, a provider-generated secret and automatic setup with no new access), GitLab declares one with one webhook per project (`src/lib/adapters/gitlab/index.ts`, StackDash's secret and automatic setup that needs write access), and Polar declares one (`src/lib/adapters/polar/index.ts`, a provider-generated secret and automatic setup that asks for `webhooks:write`). `registration.setup` declares what the panel offers:

| Member | Rule |
|---|---|
| `secretSource` | `stackdash` when StackDash generates the signing secret and the user pastes it into the provider (GitLab's secret token): automatic setup's `create` receives it as `secret`. `provider` when the provider generates it and the user pastes it back (Resend's signing secret): `create` must return it, which the type requires. Until a provider's secret is pasted, the endpoint holds a random secret nobody knows, so every delivery is refused |
| `manualSteps` | Setup by hand, one plain step each, in order. They refer to "the address" and "the secret" the panel shows beside them |
| `removalSteps` | Removing a webhook added by hand, shown on the panel and when the connection is disconnected |
| `automatic` | Optional. `extraPermissions` lists the scopes beyond `oauth.scopes` that creating a webhook needs, each `access: "full"` with its `fullAccessReason`; empty when the access already granted can create one (Resend). `accounts: "one"` when the provider's webhook belongs to one account and has its own secret (a Polar organization): automatic setup is then refused, with its own message and before any write access is asked for, unless the connection includes exactly one account. `create` makes the webhook for the connection's URL and returns the provider's id for it; `remove` deletes it. Both receive the stored credential, refreshed and saved first when it expires within 5 minutes, as a sync does (`refreshIfExpiring` in `src/lib/connections/credential-refresh.ts`), once for every webhook one setup, removal, or after-sync pass creates or deletes. They never refresh it themselves, because they cannot save a rotated refresh token. With `per: "source"` (only where `secretSource` is `stackdash`), the provider keeps one webhook per resource rather than one per grant (GitLab projects): `listSources` names the resources the connection reads, and `create` and `remove` act on one `sourceId` each. Every source's webhook points at the one URL with the one secret, its id is stored in `webhook_sources` as soon as it exists (at most 100 per endpoint), and sources the connection reads later get theirs after the next successful sync |
| `sourceNoun` | What a source is called (`{ one: "project", many: "projects" }`), for a provider whose `parse` names the resource a delivery came from in the outcome's `source`. Required with `per: "source"` (the harness checks), optional otherwise. The route records the source, and the panel lists every source with its last delivery and whether StackDash added its webhook |

How the panel uses it:

- **Write access is asked for separately.** Choosing automatic setup that needs `extraPermissions` opens the connect screen again for that connection, with the extra scopes listed as full access and the consent box, before the provider's own screen. It is never offered when the connection has a webhook already or the workspace is at its limit. `buildAuthorizeUrl` receives the scopes as `extraScopes` and must request them then, and only then; the harness checks both. The grant replaces the stored credential, the connection page lists the write access for as long as the grant holds it, and a later reconnect asks for it again so the webhook can still be deleted. If setup fails after the consent, the panel says StackDash still holds write access and links the reconnect that gives it up.
- **Setup by hand never asks for a scope.** The panel shows the address, StackDash's secret once (with copy buttons, and a new secret to replace it), or a field for the provider's secret, the steps, and when the last delivery arrived.
- **Disconnect.** An automatic webhook is deleted through `remove` with the stored credential, refreshed first if it is about to expire, before the grant is revoked; if the refresh or the deletion fails, the user gets the steps and a reference. For a webhook added by hand, the user gets the removal steps. Either way the endpoint is deleted, so a delivery still sent to its URL is refused like one to an unknown URL. Moving from automatic setup to setup by hand means disconnecting and reconnecting; there is no in-place downgrade.
- **At most 5 endpoints per workspace.** Each per-connection URL may queue 50 deliveries a minute and the instance applies 50 a minute, oldest first across every workspace, so the number of endpoints a workspace holds bounds how far it can delay everyone else's deliveries. Five is one for each provider that needs a user-created webhook (Resend, GitLab, Polar, Better Stack, Render). The database refuses the sixth (`webhook_endpoints_enforce_limit`), and the panel says the workspace is at its limit instead of offering setup.
- **Simulated providers.** With `STACKDASH_SIMULATE_PROVIDERS=1`, a provider's simulated twin carries its live adapter's `webhooks`: the real steps, `verify`, and `parse`, with automatic setup's `create` and `remove` swapped for ones that never leave the process (`simulatedConnectionSetup` in `src/lib/adapters/simulated/webhooks.ts`; a per-source setup lists the profile's `webhookSources` for the accounts of the grant the credential holds).
- **Accounts by name.** `parse` receives the connection's included accounts (`WebhookConnection`) for a delivery to a per-connection URL, for a provider whose deliveries name their account only by its path (GitLab names a project's namespace by path, never by the id `sync` reads).

## Achievements

An achievement is a permanent outcome a project earns from its providers' data, such as "10 Vercel deployments recorded" or "Kilostar: 1,024 GitHub stars". Each adapter declares its own in `achievements`, beside `eventTypes`. After each successful sync, StackDash evaluates that provider's achievements for every project the connection's accounts are assigned to, from the events and metric snapshots it has stored for all of the project's accounts of that provider. A project earns each achievement once, and members publish the ones they want to show. An achievement earned while any of those accounts is on a simulated connection is stored as simulated.

Before you add or change achievements, read the achievements of adapters of the same kind and keep ids, thresholds, and wording parallel.

The kinds today are deployment hosts (Vercel, Railway, DigitalOcean, GitLab, and Render to come), payments (Stripe and Polar), and signups (Supabase and PostHog). A member who switches provider then sees the same ladder. `src/lib/adapters/achievements.test.ts` compares the ladders each kind shares and lists every adapter's ids, so a change to one is a change to the test. Achievements count per provider: a project that deploys through two hosts earns each host's ladder separately.

| Field | Rule |
|---|---|
| `id` | The adapter id, then a stable name: `vercel.deployments.10`. It is stored on every earned row, so it never changes. Use the same name as adapters of the same kind |
| `title` | What members see in the project's Achievements section and on the timeline. At most 80 characters (`ACHIEVEMENT_TITLE_MAX`), so it fits a card and a badge |
| `publicTitle` | What a public page, card, badge, and share text show once it is published. Never an account name, a repository name, or an amount. The same as `title` unless the title says something private |
| `description` | One sentence on how it is earned, such as "Earned when StackDash records the 10th successful Vercel deployment." |
| `rule` | One rule from the set below |

Rules are a closed set (`src/lib/adapters/achievements.ts`), so an adapter composes them rather than writing code:

| Rule | Earned by |
|---|---|
| `event_count` | The `count`th recorded event of `typeIds`, dated to that event |
| `metric_threshold` | The first stored reading of `metricKey` at or above `value` |
| `event_streak` | `count` events of `successTypeIds` in a row with no event of `failureTypeIds` between them, dated to the event that completes the run |
| `events_in_window` | `count` events of `typeIds` within one London calendar day or clock hour (`window`), dated to the event that reached the count |
| `event_at_local_time` | An event of `typeIds` recorded from `fromHour` to before `toHour` London time (24 is midnight at the end of the day), on one of `weekdays` when given |
| `consecutive_days` | Events of `typeIds` on `days` consecutive London calendar days, starting on `startWeekday` when given |
| `daily_total_threshold` | A daily total declared in `signupDailyTotals` or `dailyTotals` reaching `value`, summed day by day (`cumulative`) or in one day (`single_day`), dated to the day |

The evidence decides the wording and the date:

- An event achievement says "recorded", because an adapter may backfill limited history or set a baseline on its first sync. StackDash never claims it saw a project's first-ever deployment, signup, payment, or fork.
- An event threshold is dated to the event that reached it.
- A snapshot threshold is dated to the first stored reading that proves it. When no earlier reading below the threshold is stored, its evidence is "at least" and it is shown as "Recorded at least 100" (for a threshold of 100), rather than claiming the crossing happened then.
- A daily total threshold is dated to the day, never to a time.
- Once earned, an achievement stays earned when a rolling window moves on, and keeps its stored title if its definition is later removed from the adapter.

"In one day" and "in one hour" mean a Europe/London calendar day and clock hour (`TIMELINE_TIME_ZONE` in `src/lib/timeline/query.ts`, the activity heatmap's zone), never rolling windows: ten deployments from 23:30 to 00:30 do not earn a "one hour" achievement. This was decided on 2026-11-14, so they match the activity heatmap. Weekdays and local hours are read in the same zone. Check when your adapter dates an event: GitHub dates `github.stars.daily` to the end of its UTC day, which is always the next London date, so its weekend achievement starts its run on a Sunday.

Metric rules are the exception. `usage_snapshots` keeps one reading per account, metric, and UTC day (`snapshot_date`), and each sync that day overwrites it, so a metric rule's day is that stored UTC day, not a London calendar day: one reading per day cannot prove anything finer. A UTC day is the London day in winter and 01:00 to 01:00 London time in summer. A `daily_total_threshold` reading names its own UTC day in its timeframe, so it is dated to that day whichever day it was stored on.

A daily total covers one whole UTC day: its timeframe is a period from 00:00 UTC to 00:00 UTC the next day, and the test harness rejects any other reading of a key declared in `dailyTotals` or `signupDailyTotals`. Count only what happened that day. A running total can rise without anything new happening (adding a repository to a GitHub installation raises `github.stars.total` by every star it already has), so GitHub's Trending reads `github.stars.gained.daily`: the new stars of repositories the adapter already followed, written only when a sync closes the day by 02:00 UTC, so a late sync never reports two days as one.

`checkAdapterDeclaration` rejects an achievement whose id is not unique or not prefixed with the adapter id, whose rule names an event type the adapter does not declare (a type with no category is fine) or a metric key without the adapter's prefix, whose `daily_total_threshold` sums a key missing from both `signupDailyTotals` and `dailyTotals`, or whose threshold is not positive or title is too long. It also rejects a `dailyTotals` key without the adapter's prefix, `dailyTotals` without the `usage` capability, and a key declared in both `dailyTotals` and `signupDailyTotals`, which would count it as signups too.

No achievement counts amounts, spend, quota, email volume, failed operations, logins, or connections.

## Errors and partial results

Send every request through `fetchJson` (`src/lib/adapters/errors.ts`). It applies the timeout, parses the body with your schema, and turns HTTP failures into typed errors the sync runner acts on:

| Provider answer | Error | What the sync runner does |
|---|---|---|
| `401` | `AuthRevokedError` | Marks the connection as needing a reconnect |
| `403` | `PermissionMissingError` | Asks the user to grant the missing scope |
| `429`, or `403` with rate limit headers | `RateLimitedError` | Backs off, honoring `Retry-After` |
| `5xx` or no response | `ProviderUnavailableError` | Retries later |
| Timeout | `AdapterTimeoutError` | Retries later |
| Any other status that is not `2xx`, or a body that is not JSON or does not match the schema | `InvalidResponseError` | Retries later, like an outage |

Only the first two stop the retries, because the user has to act before another attempt can work. Every other error is retried with backoff, and after the last attempt the connection is marked failed. Every failure is logged with an error reference.

On the token endpoint, `400` with `invalid_grant` means the grant is gone: report it as `AuthRevokedError`, as the example does.

Decide which reads the sync cannot do without. A failed primary read fails the sync. A refused optional read becomes a `PermissionMissingError` in `partialErrors`, naming the scope that would allow it, and the rest of the sync is stored: the connection then shows what is missing and why. A partial error must name a scope the adapter requests, or reconnecting can never fix it.

## Security requirements

A reviewer checks every item below, and the harness checks the ones it can.

- **Secrets stay wrapped.** Tokens and client secrets are `Secret` values, which print as `[redacted]` everywhere. Call `reveal()` only where the value is sent, and nowhere else.
- **Nothing secret in logs or errors.** Log structured fields only, never a token, a response body, or a full URL. Error messages name the endpoint's origin and path and never include a query string.
- **One credential.** An adapter reads only the credential it is handed and never stores, caches, or forwards it.
- **No network outside `ctx.fetch`.** Every request goes through the injected fetch, by way of `fetchJson`, so tests never touch the network and every request has a timeout.
- **Validate at the boundary.** Every response is parsed with a schema before it is used. Unknown fields are ignored; a field the adapter reads that changes shape fails the sync rather than storing a wrong number.
- **Least privilege.** Request only the scopes the adapter reads with, send them explicitly, use PKCE (S256) when the provider supports it, and pass `state` through untouched.
- **Untrusted callback.** Treat every callback parameter as attacker controlled and verify it before use.
- **No personal data.** Read and store only what the dashboard shows. Drop personal fields at the schema.
- **Environment names only.** The adapter declares the names of its environment variables, never their values, and never with a `NEXT_PUBLIC_` prefix, which would send them to the browser.
- **Clean fixtures.** Fixtures hold synthetic ids, names, amounts, and tokens. A secret scan runs over the whole repository history, so a real token committed once stays found.

## Fixtures

A fixture is one provider response saved as JSON in the adapter's `fixtures` folder and imported by the test. Take it from the provider's documented sample responses, or record it from your own sandbox account. Either way:

- Replace every id, name, email, and token with synthetic values, and keep amounts realistic but made up.
- Trim fields the adapter never reads, unless one shows that unknown fields are ignored.
- Say where it came from in a comment beside its import: documented sample or recorded, and when.
- Add a fixture for each shape the adapter handles differently: an empty list, a second page, a plan without a quota, an error body.

## The test harness

The harness (`src/lib/adapters/harness.ts`) runs an adapter against recorded fixtures with a fixed clock and no network, and checks the contract, so your tests can concentrate on your provider's rules.

```ts
import { checkAdapterDeclaration, checkSyncResult, checkTraffic, createAdapterHarness } from "@/lib/adapters/harness";

const harness = createAdapterHarness({
  now: new Date("2026-11-16T00:00:00.000Z"),
  routes: {
    "GET https://api.acme.com/v1/accounts/acct_1001/usage": { body: usageFixture },
    "GET https://api.acme.com/v1/accounts/acct_1001/billing": { status: 403, body: { error: "insufficient_scope" } },
    "GET https://api.acme.com/v1/accounts/acct_1001/events": (request) => ({
      body: request.url.searchParams.get("page_token") === null ? eventsPage1 : eventsPage2,
    }),
  },
});

const result = await acmeAdapter.sync({ credential, externalAccountId: "acct_1001" }, harness.ctx);

expect(checkAdapterDeclaration(acmeAdapter)).toEqual([]);
expect(checkSyncResult(acmeAdapter, "acct_1001", result)).toEqual([]);
expect(checkTraffic(harness, ["synthetic-access-token-1"])).toEqual([]);
```

- `createAdapterHarness` answers each request from `routes`, keyed by method, origin, and path. A function route reads the query from the request. A request with no recording gets a `404` and is reported. `harness.requests` and `harness.logs` hold everything the adapter sent and logged. Pass `extra` when the adapter reads settings beyond the client id and secret (keyed like `oauth.extraEnv`, for example an app's private key): the adapter receives each one as a `Secret` in `ctx.client.extra`. `clientId` and `timeoutMs` replace the harness defaults when a test needs particular values.
- `checkAdapterDeclaration` checks what the app reads before any sync: the id, permissions for every requested scope, event types, achievements, capabilities, projections, daily totals, the poll interval, environment variable names (the webhook secret's included), the webhook subscriptions, and for a per-connection webhook its setup steps, the reasons for any write access automatic setup asks for, and that `buildAuthorizeUrl` requests that access exactly when it is passed as `extraScopes`.
- `checkSyncResult` applies the sync runner's own gates (every metric and event valid, every key owned by the adapter, nothing for another account) plus the capability, projection, daily total (usage over exactly one whole UTC day), and partial error rules.
- `checkWebhookOutcome` applies the same event gates to what `parse` returns, and checks that every event belongs to the account the delivery names.
- `checkTraffic` reports requests with no recording, requests over plain `http`, requests without a timeout, and any log line containing the harness's client secret, one of its `extra` values, or the secrets you pass, including a multi line value and a secret inside a logged error's message or cause.

Each check returns a list of problems in plain words, so a failing test prints all of them at once.

Test every rule twice: once on the happy path and once at its boundary. The example's tests are the checklist: a revoked token, a refused optional scope, a rate limit, an empty list, a page cap, an unreadable cursor, a plan without a quota, the first day of a period, a token response without a scope, and a missing refresh token. Name the boundary in the test title, so a failure says which rule broke.

## Register the provider

Registering makes the adapter available to users, and it touches files across the app. This list was checked against the most recent adapter added, GitLab. Search the repository for an existing provider's id (`gitlab`) to find each place.

| File | Change |
|---|---|
| `src/lib/adapters/<id>/` | The adapter, its schemas, fixtures, and tests. Change `ProviderAdapter<"<id>">` to `ProviderAdapter` once the id is registered |
| `src/lib/adapters/types.ts` | Add the id to `liveProviderIds` |
| `src/lib/adapters/registry.ts` | Import the adapter and add it to `liveAdapters` |
| `src/lib/adapters/simulated/<id>.ts` | A simulated profile that makes up plausible data with the real metric keys and event types, for local demos and end-to-end tests |
| `src/lib/adapters/simulated/index.ts` | Add the profile to `simulatedAdapters` |
| `src/lib/adapters/simulated/index.test.ts` | Cases for the simulated profile |
| `src/lib/providers.ts` | The name in `PROVIDER_NAMES` and the platform in `PROVIDER_PLATFORMS` |
| `src/lib/site.ts` | The platform in the `Platform` union |
| `src/components/icons.tsx` | The brand mark in `PLATFORM_MARKS`, with its brand rules in the comment |
| `src/lib/connections/revoke.ts` | The steps to remove StackDash at the provider in `MANUAL_REVOKE_STEPS`, when the provider has them |
| `supabase/migrations/<version>_provider_<id>.sql` | `alter type public.provider_id add value if not exists '<id>';` |
| `supabase/tests/database/<NN>_<id>_provider.test.sql` | A pgTAP test that the id is a `provider_id` |
| `src/lib/supabase/database.types.ts` | Regenerated with `npm run db:types` after the migration is applied |
| `src/lib/jobs/sync-connection.test.ts` | A sync runner case for the provider |
| `e2e/<id>.spec.ts` | Connecting the simulated provider end to end |
| `e2e/docs.spec.ts` | The provider page in the docs index, its card count, and its accessibility scan |
| `docs/providers/<id>.md` | The provider page (see [Provider page template](#provider-page-template)) |
| `src/lib/adapters/achievements.test.ts` | The provider's achievement ids in `CATALOG`, and the provider in its kind's shared ladder (deployment hosts, payments, signups) when it has one (see [Achievements](#achievements)) |
| `docs/operations/oauth-apps.md` | The registration row, its section, and the number of registrations |
| `docs/operations/deploy.md` | The environment variable rows |
| `docs/architecture/concepts.md` | What an external account is for this provider |
| `docs/architecture/schema.md` | The migration row |
| `.env.example` | The client id and secret variables, and the provider in the simulated providers note |
| `README.md` | The provider count wherever the README states it (the status note, See it and its image description, Integrations, and the demo section), and the provider's row in the integrations table |
| `docs/development.md` | The provider in the simulated providers list (step 10) and in the adapters folder list (project layout) |
| `src/components/sections/integrations.tsx` | The landing page's integration list and spend line |
| `src/components/sections/faq.tsx` | The provider in the answer that lists integrations |

When the provider reports deployments, also:

| File | Change |
|---|---|
| `src/lib/dashboard/markers.ts` | Its finished deployment event types in the deployments marker category, with `markers.test.ts` |
| `src/lib/public-metrics/definitions.ts` | Its success and failure types in `DEPLOYMENT_OUTCOMES`, with `definitions.test.ts`. The provider then joins the provider list in the year in review's deployment sentence ("Connect ... to count your deployments."), so update that sentence where `src/lib/public-metrics/yearly.test.ts` and `e2e/year-in-review.spec.ts` assert it |
| `docs/architecture/public-metrics.md` | The provider in the deployment metrics' event lists |

Event categories, capabilities, projections, and daily totals need no list of their own: they are read from the registered adapter.

## Provider page template

Every provider has a page in `docs/providers/<id>.md`, published at `/docs/providers/<id>`. It is the record of what the adapter reads and why, and a reviewer checks the adapter against it. Copy this into the new page and fill in every section. The lead line is required: the docs build fails without a `Verification:` sentence, and a new adapter starts at `documentation only`.

````markdown
# <Provider name>

Provider id: `<id>`. Verification: documentation only. Docs checked <YYYY-MM-DD>.

StackDash reads <what, in one sentence>. It asks for <the scopes, and whether they are read only>.

## Go or no-go

<Go or no-go, and the limits that shape it: plans, roles, regions, anything a user would trip on.>

## Connection

<The OAuth flow: authorization code, PKCE or not, how the client authenticates.>

| Item | Value |
|---|---|
| Authorize URL | |
| Token URL | |
| Revoke URL | <or "None"> |
| Callback URL | `<SITE_URL>/api/connections/<id>/callback` |
| API base URL | |
| Scopes | |
| Access token | <lifetime> |
| Refresh token | <lifetime, and whether it rotates> |

### Authorize

### Token exchange

### Refresh and rotation

### Disconnect and revoke

<From StackDash, and by hand at the provider.>

## Permissions

| Scope | Access | Why | Also allows |
|---|---|---|---|
| | Read | | |

<Scopes deliberately not requested, and why.>

## Data

<One section per endpoint read: what it returns, what StackDash keeps, and how it maps to metrics.>

### Units, freshness, retention

### Timeline events (by polling)

| Event | Endpoint | Rule |
|---|---|---|

## Achievements

<Each achievement the adapter declares. Copy the ladder of adapters of the same kind first.>

| Id | Title | How it is earned |
|---|---|---|

## Verified, estimated, unavailable

| Value | Status |
|---|---|

## Rate limits

<The provider's limits, and what one sync costs.>

## Webhooks

<What the provider can push, how a delivery is signed, and whether StackDash uses it. When it does not, say why: unsigned, no webhooks, or setup needs a write scope.>

## Permission risks

<What each scope also allows beyond what StackDash reads, shown on the connect screen before the user grants access.>

## Limitations

## Self-hosted registration

<Click path to register the OAuth app, the callback URL, the scopes, and the environment variables.>

## Sample responses

<Trimmed responses with synthetic values: the source of the test fixtures.>

## Unverified

<Every claim a real account still has to confirm.>

## Sources

<The provider documentation pages read, each with the date checked.>
````

## Review process

1. **Adapter request.** Open an issue with the **Adapter request** template and wait for a go or no-go.
2. **Pull request.** One adapter per pull request, with the adapter, its tests, its provider page, and every file from [Register the provider](#register-the-provider). Run `npm run lint`, `npm run typecheck`, `npm test`, and the end-to-end specs your change touches, and say in the pull request what you ran and what it printed.
3. **Maintainer review.** A maintainer reviews the scopes and what they also allow, the data read and kept, the security requirements above, the fixtures for anything real, and the tests for a happy path and a boundary for each rule. Nothing is released before this review.
4. **Released as documentation only.** A merged adapter is built from the provider's documentation and recorded fixtures, so its page says `Verification: documentation only.` and the docs index marks it "Not yet tested with a real account". It may also carry a `beta` reason on its card.
5. **Tested with a real account.** A maintainer registers the hosted OAuth app, sets its secret in the deployed environment, connects a real account, and then changes the page's lead line to `Verification: tested with a real account.` Production secrets are only ever handled by a maintainer, in the deployed environment.
