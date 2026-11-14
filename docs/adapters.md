# Write a provider adapter

A provider adapter connects DevMacro to one provider's API: it runs the OAuth connection, reads usage, spend, revenue, and activity on a schedule, and maps them onto DevMacro's metric and event model. This guide takes you from a copy of the example adapter to a pull request: the interface, capabilities, metric kinds, provenance rules, security requirements, tests, every file a new provider touches, and how adapters are reviewed.

## Before you start

- **Ask first.** Open an issue with the **Adapter request** template. It asks for the provider's OAuth support, the scopes, the data DevMacro would read, what those scopes also allow, and the known limits. A maintainer answers with go or no-go before any code is written, because some providers cannot be connected the way DevMacro requires.
- **OAuth only.** A user connects a provider through the provider's OAuth authorization code flow. DevMacro never asks anyone to paste an API key, so a provider without OAuth cannot have an adapter.
- **Polling only.** An adapter is called on a schedule and reads what changed. Webhooks are not supported yet.
- **Read only.** Ask for the narrowest read scopes that cover what the adapter reads. A scope that can also write needs a reason the user sees before connecting.
- **No new dependencies.** Adapters call the provider's HTTP API with the shared `fetchJson` helper and parse responses with `zod`. Adding a provider SDK or any other package is a maintainer decision: raise it on the adapter request issue first.

## Review and trust

**Every adapter is reviewed by a maintainer before it is released, and an adapter is never run untrusted with production secrets.**

Until a maintainer has reviewed and merged it, your adapter runs only on your own machine: in unit tests against recorded fixtures and, if you choose, against your own sandbox account with your own OAuth app. The local simulator never calls your adapter: with `DEVMACRO_SIMULATE_PROVIDERS=1` the app swaps every live adapter for its simulated profile, which makes up its data, so data on screen there does not mean your code ran. Your adapter never receives a production OAuth client secret or a user's token: those exist only in the environment of a deployed instance, which runs merged code only. Never ask for production credentials to test an adapter, and never paste a real token, client secret, or private response into an issue, a pull request, a fixture, or a log. When you test against your sandbox account, keep its secret in your git-ignored `.env.local`, and scrub every response before it becomes a fixture.

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
| `index.ts` | The adapter: OAuth with PKCE and rotating refresh tokens, revocation, account listing, and a sync that reads one primary endpoint and three optional ones |
| `schemas.ts` | One `zod` schema per response, parsed at the boundary so nothing unvalidated reaches the mapping code |
| `fixtures/*.json` | One recorded response per endpoint, with synthetic ids, tokens, and amounts |
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
| `beta` | A one sentence reason shown beside a "Beta" badge on the provider's card. Omit when not in beta |
| `oauth` | Authorize, token, and revoke URLs, the requested scopes, whether PKCE is used, and the names (never the values) of the environment variables holding the client id and secret, plus `extraEnv` for any other app setting the provider needs (an integration slug, an app's private key) and `optionalExtraKeys` for the ones an instance may leave unset |
| `pollIntervalSeconds` | How often to sync. Hourly (3600) unless the provider's limits or retention need otherwise. At least 60 |
| `buildAuthorizeUrl` | The URL the user is sent to. Always sends the scopes explicitly, the `state`, and the PKCE challenge |
| `exchangeCode` | Swaps the callback's code for a credential. Callback parameters are untrusted: verify them |
| `refreshTokens` | Returns a new credential. Omit when the provider's tokens never expire. The sync runner saves the result before anything else runs |
| `revoke` | Ends the grant at the provider. Omit when the provider has no revocation endpoint |
| `listAccounts` | The accounts, organizations, teams, or projects the grant can read. Each becomes an external account the user can include |
| `detectMissingPermissions` | The requested scopes absent from a grant. Empty means nothing is missing |
| `sync` | Reads one external account and returns metrics, events, an optional cursor, and partial errors |

Every method receives a context instead of reaching for globals: `ctx.fetch` for every request, `ctx.now()` for the time, `ctx.timeoutMs`, `ctx.logger`, and for OAuth calls the client id, the secret, and those extra settings, each a `Secret` in `ctx.client.extra`. An adapter sees exactly one credential, the one it is handed.

## Capabilities

Capabilities say what an adapter reports, and the dashboard leaves out what a provider never declares. `oauth: true`, `polling: true`, and `webhooks: false` are fixed by the type.

| Capability | Declare it when the adapter emits | Example Cloud |
|---|---|---|
| `usage` | `usage` metrics: a quantity used in a period | Requests this billing period |
| `allowance` | `included_allowance` and `remaining_allowance` metrics | Requests the plan includes and requests left |
| `spending` | `verified_spend` or `estimated_spend` metrics | Spend this period, and the overage it is on course for |
| `credits` | `credit_balance` metrics | Account credit |
| `revenue` | `revenue` or `recurring_revenue` metrics | Revenue this period and monthly recurring revenue |
| `events` | Timeline events, with at least one declared event type | Signups and deployments |

The harness fails a sync result that emits a metric kind whose capability is false, and a declaration whose `events` capability disagrees with its event types.

## Metric kinds

Metrics are validated by `AdapterMetricSchema` (`src/lib/adapters/metrics.ts`) before anything is stored, and one invalid metric rejects the whole batch.

| Kind | Value | Use it for |
|---|---|---|
| `usage` | `value` and `unit` | A quantity consumed: emails sent, build minutes, requests |
| `included_allowance` | `value` and `unit` | What the plan includes for that quantity |
| `remaining_allowance` | `value` and `unit` | What is left of the allowance, never below zero |
| `verified_spend` | `amountMinor` and `currency` | Money the provider itself reports as charged |
| `estimated_spend` | `amountMinor` and `currency` | Money DevMacro calculates from usage and a price list |
| `credit_balance` | `amountMinor` and `currency`, may be negative | Prepaid credit or a balance owed |
| `revenue` | `amountMinor` and `currency`, may be negative | Money earned in a period, net of refunds |
| `recurring_revenue` | `amountMinor` and `currency` | A run rate at one moment, such as monthly recurring revenue. Never summed into revenue |

`budget` is also a kind, but budgets are set by users in DevMacro and an adapter can never emit one.

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
- `source: "derived"`: DevMacro calculated it. An `estimated_spend` metric must be derived and must name its price list in `pricingSource`, with the date it was checked, because the user deserves to know what an estimate rests on.

The dashboard labels figures verified or estimated from the kind, so never report an estimate as `verified_spend`. A figure that predicts the whole billing period, rather than what has been spent so far, is a projection: declare its key in `projectedSpend` so no total counts it as money already spent.

## Events

An event type is declared once, in `eventTypes`, with a stable id (`acme.deploy.failed`), a label, a description, whether it is shown by default, and optionally a category (`signup`, `deploy_succeeded`, or `deploy_failed`) so the dashboard headline counts it. An event emitted with an undeclared type id rejects the whole batch. The label is the type's name everywhere the app names it: the timeline's event type filter and its chips, a collapsed run of events, **Event details**, and the command palette. Write it the way a person would say it (`Payment succeeded`, not `Charge succeeded`), since the id's own words are shown only for a type no adapter declares any more.

Each event carries a type id, when it happened, a severity (`info`, `success`, `warning`, `critical`), a title of at most 200 characters, an optional body, the external account, and a dedupe key that is the same every time the same event is read, so reading it twice never stores it twice. An optional link must be `https`: an event with any other link fails validation, and that rejects the whole batch. Drop a link that is not `https` before the event reaches the batch, as the example's `httpsUrl` does.

The event model has no field for a person, on purpose: no names, emails, usernames, or avatars. Count a signup; never record who signed up.

Read events with a cursor: an opaque string the adapter returns from one sync and receives in the next. Bound every read: a page size and a maximum number of pages per sync, with the cursor set to where the read stopped, so a busy account catches up over several syncs instead of one sync running without end. On the first sync, read a short backfill window (the example reads 7 days), not the whole history. If the cursor comes back unreadable, log it and start again from the backfill window rather than failing every future sync.

## Achievements

An achievement is a permanent outcome a project earns from its providers' data, such as "10 Vercel deployments recorded" or "Kilostar: 1,024 GitHub stars". Each adapter declares its own in `achievements`, beside `eventTypes`. After each successful sync, DevMacro evaluates them for every project the connection's accounts are assigned to, from the events and metric snapshots it has stored. A project earns each achievement once, and members publish the ones they want to show.

Before you add or change achievements, read the achievements of adapters of the same kind and keep ids, thresholds, and wording parallel.

The kinds today are deployment hosts (Vercel, Railway, DigitalOcean, GitLab, and Render to come), payments (Stripe and Polar), and signups (Supabase and PostHog). A member who switches provider then sees the same ladder. `src/lib/adapters/achievements.test.ts` compares the ladders each kind shares and lists every adapter's ids, so a change to one is a change to the test. Achievements count per provider: a project that deploys through two hosts earns each host's ladder separately.

| Field | Rule |
|---|---|
| `id` | The adapter id, then a stable name: `vercel.deployments.10`. It is stored on every earned row, so it never changes. Use the same name as adapters of the same kind |
| `title` | What members see in the project's Achievements section and on the timeline. At most 80 characters (`ACHIEVEMENT_TITLE_MAX`), so it fits a card and a badge |
| `publicTitle` | What a public page, card, badge, and share text show once it is published. Never an account name, a repository name, or an amount. The same as `title` unless the title says something private |
| `description` | One sentence on how it is earned, such as "Earned when DevMacro records the 10th successful Vercel deployment." |
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
| `daily_total_threshold` | A daily total declared in `signupDailyTotals` reaching `value`, summed day by day (`cumulative`) or in one day (`single_day`), dated to the day |
| `metric_daily_gain` | `metricKey` rising by at least `gain` within one London calendar day, from stored snapshots |

The evidence decides the wording and the date:

- An event achievement says "recorded", because an adapter may backfill limited history or set a baseline on its first sync. DevMacro never claims it saw a project's first-ever deployment, signup, payment, or fork.
- An event threshold is dated to the event that reached it.
- A snapshot threshold is dated to the first stored reading that proves it. When no earlier reading below the threshold is stored, its evidence is "at least" and it is shown as "Recorded at least 100" (for a threshold of 100), rather than claiming the crossing happened then.
- A daily total threshold is dated to the day, never to a time.
- Once earned, an achievement stays earned when a rolling window moves on, and keeps its stored title if its definition is later removed from the adapter.

"In one day" and "in one hour" mean a Europe/London calendar day and clock hour (`TIMELINE_TIME_ZONE` in `src/lib/timeline/query.ts`, the activity heatmap's zone), never rolling windows: ten deployments from 23:30 to 00:30 do not earn a "one hour" achievement. This was decided on 2026-11-14, so they match the activity heatmap. Weekdays and local hours are read in the same zone. Check when your adapter dates an event: GitHub dates `github.stars.daily` to the end of its UTC day, which is always the next London date, so its weekend achievement starts its run on a Sunday.

`checkAdapterDeclaration` rejects an achievement whose id is not unique or not prefixed with the adapter id, whose rule names an event type the adapter does not declare (a type with no category is fine) or a metric key without the adapter's prefix, whose `daily_total_threshold` sums a key missing from `signupDailyTotals`, or whose threshold is not positive or title is too long.

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
- `checkAdapterDeclaration` checks what the app reads before any sync: the id, permissions for every requested scope, event types, achievements, capabilities, projections, the poll interval, and environment variable names.
- `checkSyncResult` applies the sync runner's own gates (every metric and event valid, every key owned by the adapter, nothing for another account) plus the capability, projection, and partial error rules.
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
| `src/lib/connections/revoke.ts` | The steps to remove DevMacro at the provider in `MANUAL_REVOKE_STEPS`, when the provider has them |
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
| `README.md` | The provider lists, the environment variable table, and the adapters folder list |
| `src/components/sections/integrations.tsx` | The landing page's integration list and spend line |
| `src/components/sections/faq.tsx` | The provider in the answer that lists integrations |

When the provider reports deployments, also:

| File | Change |
|---|---|
| `src/lib/dashboard/markers.ts` | Its finished deployment event types in the deployments marker category, with `markers.test.ts` |
| `src/lib/public-metrics/definitions.ts` | Its success and failure types in `DEPLOYMENT_OUTCOMES`, with `definitions.test.ts`. The provider then joins the provider list in the year in review's deployment sentence ("Connect ... to count your deployments."), so update that sentence where `src/lib/public-metrics/yearly.test.ts` and `e2e/year-in-review.spec.ts` assert it |
| `docs/architecture/public-metrics.md` | The provider in the deployment metrics' event lists |

Event categories, capabilities, projections, and daily signup totals need no list of their own: the dashboard reads them from the registered adapter.

## Provider page template

Every provider has a page in `docs/providers/<id>.md`, published at `/docs/providers/<id>`. It is the record of what the adapter reads and why, and a reviewer checks the adapter against it. Copy this into the new page and fill in every section. The lead line is required: the docs build fails without a `Verification:` sentence, and a new adapter starts at `documentation only`.

````markdown
# <Provider name>

Provider id: `<id>`. Verification: documentation only. Docs checked <YYYY-MM-DD>.

DevMacro reads <what, in one sentence>. It asks for <the scopes, and whether they are read only>.

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

<From DevMacro, and by hand at the provider.>

## Permissions

| Scope | Access | Why | Also allows |
|---|---|---|---|
| | Read | | |

<Scopes deliberately not requested, and why.>

## Data

<One section per endpoint read: what it returns, what DevMacro keeps, and how it maps to metrics.>

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

## Webhooks (Post-MVP)

## Permission risks

<What each scope also allows beyond what DevMacro reads, shown on the connect screen before the user grants access.>

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
