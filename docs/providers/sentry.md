# Sentry

Provider id: `sentry`. Verification: documentation only. Docs checked 2026-11-05.

StackDash reads error counts per Sentry project, new and regressed issues, resolutions, and releases. It installs as a Sentry integration with three read-only scopes. Sentry does not report cost, so StackDash shows none.

**Built without a real Sentry account.** No integration has been registered yet, so every request and response on this page comes from Sentry's documentation, and the tests run on samples from it. Everything not yet confirmed against a real organization is listed under [Unverified](#unverified); treat the adapter as unverified until that list is worked through.

## Go or no-go

**Go, as error volume and activity, not cost.** A Sentry public integration with three read-only scopes gives error counts per project by outcome (accepted, filtered, rate limited), new issues, regressions, resolutions, and releases. No endpoint an integration can call reports spend, plan, or quota, so the adapter reports usage and events only and never a dollar figure.

The hosted integration needs Sentry's publication review before organizations other than the one that registered it can install it. Self-hosters register their own integration and can use it unpublished.

## Connection

A Sentry public integration on the integration platform, installed on one Sentry organization.

| Item | Value |
|---|---|
| Install URL | `https://sentry.io/sentry-apps/<SENTRY_INTEGRATION_SLUG>/external-install/?state=<state>` (browser navigation) |
| Redirect URL | `<SITE_URL>/api/connections/sentry/callback`. Sentry adds `code`, `installationId`, `orgSlug`, and `state` |
| Token URL | `POST https://sentry.io/api/0/sentry-app-installations/{installationId}/authorizations/` (code exchange and refresh) |
| API base URL | `https://sentry.io/api/0` |
| Access token | Expires after 8 hours (`expiresAt` in the token response) |
| Refresh | JWT bearer grant (`urn:sentry:params:oauth:grant-type:jwt-bearer`), HS256 signed with the client secret. No refresh token is stored |
| Scopes | Fixed on the integration's registration, approved by the installer, not sent on the install URL |
| PKCE | Not offered by the integration flow |
| Revocation | No endpoint for integrators. The user uninstalls in Sentry |

### Install

1. A workspace owner or admin clicks Connect Sentry. StackDash creates a random `state` bound to the session and workspace (short TTL, single use) and redirects to the install URL. Sentry documents that it passes `state` back unchanged on the redirect.
2. In Sentry the user picks the organization (if they belong to more than one) and approves the permissions. Sentry only issues a grant code once every permission is approved.
3. Sentry redirects to the Redirect URL with `code`, `installationId`, `orgSlug`, and `state`.
4. `installationId` and `orgSlug` are untrusted until Sentry accepts them. The code is bound to the installation, so a spoofed `installationId` fails the exchange. The `orgSlug` is proved by reading one page of that organization's projects with the new token: an integration token only reads the organization it is installed on.

### Code exchange

`POST /api/0/sentry-app-installations/{installationId}/authorizations/` with a JSON body: `grant_type: "authorization_code"`, `code`, `client_id`, `client_secret`. The response holds `id`, `token`, `refreshToken`, `dateCreated`, `expiresAt`, `state`, `application`. StackDash keeps `token` and `expiresAt` only, plus the installation id and organization slug as connection metadata. The response lists no scopes: the grant is the integration's registered set, which is what the code asks for.

### Token refresh

Sentry recommends the manual refresh over the refresh token grant, because a refresh committed on Sentry's side can be lost on the way back, which would strand a rotated refresh token. The manual refresh needs only the client secret:

1. Build a JWT with `iss` and `sub` set to the client id, `iat` now, `exp` one minute later, and a random `jti`, signed HS256 with the client secret.
2. `POST` the token URL with `Authorization: Bearer <jwt>` and the JSON body `{"grant_type": "urn:sentry:params:oauth:grant-type:jwt-bearer"}`.
3. The response has the same shape as the code exchange. The new token replaces the old one.

The sync runner refreshes when the token is within its refresh window, so with hourly syncs most syncs refresh first. The refresh token grant (`grant_type: "refresh_token"`) also exists; StackDash does not use it and never stores the refresh token.

### Disconnect and revoke

- Sentry documents no endpoint an integration can call to revoke its own token or uninstall itself. Disconnecting in StackDash deletes the stored token and shows the manual step: in Sentry, open **Settings**, then **Integrations**, choose StackDash, and choose **Uninstall**.
- After an uninstall the token stops working. Without webhooks (Post-MVP), StackDash finds out on the next sync: a `401` on any call, or a `401`, `403`, or `404` on the refresh, marks the connection as needing a reconnect. The exact codes are unverified.

## Permissions

All read-only.

| Scope | Sentry UI name | Why | Endpoints |
|---|---|---|---|
| `org:read` | Organization: Read | Project list, error counts by outcome | `GET /organizations/{org}/projects/`, `GET /organizations/{org}/stats_v2/` |
| `event:read` | Issue & Event: Read | New, regressed, and resolved issues | `GET /organizations/{org}/issues/` |
| `project:read` | Project: Read | Releases | `GET /organizations/{org}/releases/` |

Not requested: `project:releases` (one scope for read and write of releases; the release list also accepts `project:read`), `team:read`, `member:read`, and every write or admin scope. Every timeline event in this adapter needs only these three read scopes, so no event type was left out for needing a write scope.

## Data

One external account is one Sentry project. All three reads are filtered to that project with `project=<id>`.

### Which projects: `GET /api/0/organizations/{org}/projects/`

`per_page=100`, paginated by the `Link` header (`rel="next"; results="true"; cursor="..."`), at most 5 pages (500 projects, the most accounts one connection stores). Reads `id`, `slug`, and `name`. Read when connecting and reconnecting; a project created later appears after a reconnect.

### Error volume: `GET /api/0/organizations/{org}/stats_v2/`

| Query | Value |
|---|---|
| `field` | `sum(quantity)` (event count for errors) |
| `groupBy` | `outcome` |
| `category` | `error` (includes `default` and `security` events) |
| `project` | The project id |
| `statsPeriod` | `24h` |
| `interval` | `1h` (the minimum) |

Response: `start`, `end`, `intervals`, and `groups[]`, each with `by.outcome`, `totals["sum(quantity)"]`, and `series`. A group appears only for outcomes that had events, so a missing outcome is zero. StackDash stores three usage metrics per project, in `errors`, over the period Sentry returned:

| Metric key | Outcome | Meaning (Sentry Stats page) |
|---|---|---|
| `sentry.errors.accepted` | `accepted` | Processed and stored |
| `sentry.errors.filtered` | `filtered` | Dropped by inbound filters (browser extensions, legacy browsers, localhost, error messages, releases) |
| `sentry.errors.rate_limited` | `rate_limited` | Dropped for rate limits or quota: DSN limit, spike protection, an exhausted monthly quota, internal limits |

Not shown: `invalid`, `abuse`, `client_discard`, and `cardinality_limited`. Rate limited is the one that means lost data and, for quota, a plan limit reached.

### Issues: `GET /api/0/organizations/{org}/issues/`

Common query: `project=<id>`, `statsPeriod=14d`, `limit=100`, and `collapse` of `stats`, `lifetime`, `filtered`, and `unhandled` (fields the adapter never reads). An explicit `query` replaces the default `is:unresolved`. Each sync runs up to three searches, one page each:

| Search | `query` | `sort` | Gives |
|---|---|---|---|
| New issues | `firstSeen:>=<since>` | `new` | Issues first seen since the last sync |
| Active issues | `is:unresolved lastSeen:>=<since>` | `date` | Regressed issues (`substatus: "regressed"`) and the issues to remember |
| Resolved | `is:resolved issue:[<short ids>]` | default | Which remembered issues are now resolved |

`<since>` is the previous sync time minus 10 minutes, as `YYYY-MM-DDTHH:MM:SSZ`. The first sync looks back one day, and a sync after a pause looks back at most 7 days.

Fields read: `id`, `shortId`, `status`, `substatus`, `level`, `firstSeen`, `lastSeen`, `permalink`. Never read: `title`, `metadata`, `culprit`, `assignedTo`, `owners`, and anything from events. Titles and culprits come from exception messages and code paths, and messages can contain whatever the user's app put in them, including personal data.

The cursor remembers up to 100 unresolved issues per project (short id, whether they were regressed, and last seen), the most recently seen first, for 13 days. That is what lets a later sync notice that an issue regressed or was resolved without being asked about every issue in the project.

### Releases: `GET /api/0/organizations/{org}/releases/`

`project=<id>`, `per_page=100`. Sorted by most recent. Fields read: `id`, `version`, `shortVersion`, `dateCreated`. Never read: `authors`, `owner`, `lastCommit`, `lastDeploy`, which name people.

### Units, freshness, retention

- Counts are whole numbers of error events. `sum(quantity)` is bytes only for attachments, which this adapter does not query.
- Stats intervals are aligned by Sentry; the metric's period is the `start` and `end` Sentry returned, not one computed by StackDash. The Stats page shows days in UTC.
- Issue `firstSeen` and `lastSeen` and release `dateCreated` are UTC timestamps.
- Freshness of stats and of the issue search is not documented. The 10 minute overlap covers a short indexing delay.
- Retention follows the organization's Sentry plan and is not read.

### Timeline events (by polling)

| Event type | Source | Dated | Severity | Rule |
|---|---|---|---|---|
| `sentry.issue.created` (New issue) | New issues search | `firstSeen` | `critical` for fatal, `warning` for error, `info` otherwise | One per issue id |
| `sentry.issue.regressed` (Issue regressed) | Active issues search | When the sync saw it | `critical` for fatal and error, `warning` otherwise | When `substatus` is `regressed` and the issue was not remembered as regressed. Not on the first sync, which records a baseline |
| `sentry.issue.resolved` (Issue resolved) | Resolved search over remembered issues | When the sync saw it | `success` | Once, then the issue is forgotten |
| `sentry.release.created` (New release) | Release list | `dateCreated` | `info` | One per release and project |

Titles carry the short id or the release version, never the issue title: "New issue WEB-1A", "Issue WEB-1A regressed", "Issue WEB-1A resolved", "Release web@1.2.0 created". Issue events link to the issue's `permalink` when it is an `https` address on `sentry.io`. The issue list does not say when a status changed, so regressed and resolved events carry the sync time; their dedupe key includes the sync window, so an issue that regresses again later gets a new event.

None of these events counts in the dashboard headline's signups or deploys: a release is a version Sentry was told about, not a deployment of it.

## Achievements

StackDash evaluates these for each project the Sentry accounts are assigned to, from the Sentry data it has stored, after each sync (see [Achievements](../adapters.md#achievements)). A project earns each one once, and it stays private until an owner or admin publishes it.

The issue achievements count `sentry.issue.resolved` events and the release ones `sentry.release.created`. Days are London calendar days.

| Id | Title | How it is earned |
|---|---|---|
| `sentry.issues.resolved_first` | First Sentry issue resolved | Earned when StackDash records the first resolved Sentry issue. |
| `sentry.issues.resolved_100` | 100 Sentry issues resolved | Earned when StackDash records the 100th resolved Sentry issue. |
| `sentry.issues.bug_squasher` | Bug squasher: 10 issues resolved in one day | Earned when StackDash records 10 resolved Sentry issues on one London calendar day. |
| `sentry.releases.first` | First Sentry release recorded | Earned when StackDash records the first new Sentry release. |
| `sentry.releases.10` | 10 Sentry releases recorded | Earned when StackDash records the 10th new Sentry release. |

## Verified, estimated, unavailable

| Value | Status |
|---|---|
| Errors accepted, filtered, and rate limited per project, last 24 hours | Verified (Sentry's own counts) |
| New issues and their first seen time | Verified |
| Releases and their creation time | Verified |
| Regressions and resolutions | Verified status, estimated time: dated when the sync saw the change, up to one poll interval late |
| Spend, plan, reserved volume, on-demand budget, quota remaining | Unavailable: no endpoint for integrations |
| Transactions, replays, attachments, profiles, and other categories | Unavailable in this adapter (the same endpoint can count them; StackDash does not read them) |
| Who is assigned, who released, issue titles and messages | Not collected on purpose |

## Rate limits

- Sentry limits each caller per endpoint with fixed windows, plus a limit on concurrent requests. Limits differ per endpoint and are not published; each response carries `X-Sentry-Rate-Limit-Limit`, `-Remaining`, `-Reset` (UTC epoch seconds), `-ConcurrentLimit`, and `-ConcurrentRemaining`.
- The limit follows the caller's identity, not the token, so more tokens do not raise it.
- Sentry warns that polling the API "is likely to quickly trigger rate limiting" and recommends webhooks. StackDash polls hourly, runs its requests one after another, and backs off on `429` with `Retry-After` through the shared adapter error handling.
- Budget per project per sync: one stats call, two or three issue searches, one release list, so at most 5 requests per project per hour, plus one token refresh per connection about every 8 hours. 20 projects is about 100 requests an hour.

## Webhooks (Post-MVP)

Polling only for the MVP. The integration platform can push `installation` (created, deleted), `issue` (created, resolved, assigned, archived, unresolved), `error`, and alert resources to one webhook URL, each signed with `Sentry-Hook-Signature`: an HMAC SHA-256 hex digest of the raw body keyed with the client secret, compared in constant time. `installation.deleted` would also tell StackDash at once when a user uninstalls. There is no webhook for usage stats, so error volume stays polled.

## Permission risks

Disclose these on the connect screen before redirecting:

- **`event:read`** reads every issue and event in every project of the organization. Events carry whatever the user's app sends: exception messages, stack traces with local variables, request data, breadcrumbs, and user context such as IP address, email, or user id if the SDK sends them. StackDash reads only issue status fields and never fetches events.
- **`org:read`** reads organization details and settings, the project list, integrations, and usage stats for the whole organization, not just the projects StackDash shows.
- **`project:read`** reads project settings and the project's client keys (DSNs). DSNs are designed to sit in client code, but they still let anyone send events to the project. StackDash reads only releases.
- The scopes cover the whole organization: an integration cannot be limited to some projects. Excluding an account in StackDash stops syncing it but does not narrow the token.
- The client secret signs token refreshes and webhook payloads. Store it only in the server environment.

## Limitations

- No cost data. Sentry exposes no billing or quota endpoint to integrations.
- sentry.io only. Self-hosted Sentry servers use their own base URL and are out of scope. Organizations in the EU (`de.sentry.io`) are called through `sentry.io`, which Sentry documents as the general API host; whether every endpoint here answers for them there is unverified.
- Projects created after connecting appear after a reconnect, like every provider's accounts.
- More than 100 new issues, or more than 100 recently active unresolved issues, in one project between two syncs: only the first page is read and a warning is logged. Releases are read one page at a time for the same reason.
- Regressions and resolutions are dated when the sync saw them, not when they happened.
- A resolution is seen only for issues StackDash remembers: up to 100 per project that were unresolved and active within the last 13 days. An issue resolved weeks after its last event is not reported.
- Renaming the organization changes its slug, which StackDash stores; calls then fail until the user reconnects (unverified whether Sentry redirects old slugs).
- The hosted integration is unavailable to other organizations until Sentry approves its publication.

## Self-hosted registration

Each deployment registers its own public integration, because the redirect URL and client secret belong to one deployment. The click path below follows Sentry's documentation and is unverified.

1. In sentry.io, open **Settings**, **Developer Settings**, then **Create New Integration** and choose **Public Integration**. Use the organization that should own it.
2. **Name**: for example `StackDash (your name)`. The slug Sentry derives from it is `SENTRY_INTEGRATION_SLUG`; it appears in `https://sentry.io/sentry-apps/<slug>/external-install/`.
3. **Redirect URL**: `<SITE_URL>/api/connections/sentry/callback`.
4. Leave **Verify Installation** unchecked, and leave **Webhook URL**, **Alert Rule Action**, and every webhook subscription empty or off.
5. **Permissions**: Project Read, Issue & Event Read, Organization Read. Everything else No Access.
6. Save. On the integration's page, under **Credentials**, copy the **Client ID** and **Client Secret**.
7. Upload the logo Sentry requires for public integrations (PNG, 256 to 1024 pixels square, transparent background).
8. Set the environment variables:

| Variable | Value |
|---|---|
| `SENTRY_CLIENT_ID` | Client ID |
| `SENTRY_CLIENT_SECRET` | Client Secret. Also signs the refresh JWT |
| `SENTRY_INTEGRATION_SLUG` | The integration's slug, lowercase letters, digits, hyphens, and underscores |

A self-hosted StackDash can keep the integration unpublished: only its own organization can then install it. To let other organizations connect, choose **Publish** on the integration, which sends it to Sentry for review.

## Sample responses

All samples are from documentation, not recorded, trimmed, with synthetic ids and placeholder tokens. The test fixtures in `src/lib/adapters/sentry/fixtures/` are built from them.

Redirect after install (from documentation, not recorded):

```
<SITE_URL>/api/connections/sentry/callback?code=<grant-code>&installationId=7a485448-a9e2-4c85-8a3c-4f44175783c9&orgSlug=the-interstellar-jurisdiction&state=AB12t
```

`POST /api/0/sentry-app-installations/{installationId}/authorizations/`, code exchange and refresh (from documentation, not recorded; tokens shown as placeholders):

```json
{
  "id": "38",
  "token": "<access-token>",
  "refreshToken": "<refresh-token>",
  "dateCreated": "2019-08-07T20:25:09.870Z",
  "expiresAt": "2019-08-08T04:25:09.870Z",
  "state": null,
  "application": null
}
```

`GET /api/0/organizations/{org}/projects/` (from documentation, not recorded; trimmed):

```json
[
  {
    "slug": "prime-mover",
    "name": "Prime Mover",
    "dateCreated": "2018-11-06T21:19:58.536Z",
    "id": "3",
    "platform": "",
    "team": { "id": "2", "name": "Powerful Abolitionist", "slug": "powerful-abolitionist" }
  }
]
```

`GET /api/0/organizations/{org}/stats_v2/` (from documentation, not recorded):

```json
{
  "start": "2022-02-14T19:00:00Z",
  "end": "2022-02-28T18:03:00Z",
  "intervals": ["2022-02-28T00:00:00Z"],
  "groups": [
    {
      "by": { "outcome": "invalid" },
      "totals": { "sum(quantity)": 165665 },
      "series": { "sum(quantity)": [165665] }
    }
  ]
}
```

`GET /api/0/organizations/{org}/issues/` (from documentation, not recorded; trimmed, and the fields StackDash drops are kept to show what it drops):

```json
[
  {
    "assignedTo": { "type": "user", "id": "1", "name": "John Doe", "email": "john.doe@example.com" },
    "culprit": "raven.scripts.runner in main",
    "firstSeen": "2018-11-06T21:19:55Z",
    "id": "1",
    "lastSeen": "2018-12-06T21:19:55Z",
    "level": "error",
    "metadata": { "title": "This is an example Python exception" },
    "permalink": "https://sentry.io/the-interstellar-jurisdiction/pump-station/issues/1/",
    "project": { "id": "2", "name": "Pump Station", "slug": "pump-station", "platform": "python" },
    "shortId": "PUMP-STATION-1",
    "status": "ignored",
    "substatus": "archived_until_condition_met",
    "title": "This is an example Python exception"
  }
]
```

`GET /api/0/organizations/{org}/releases/` (from documentation, not recorded; trimmed):

```json
[
  {
    "id": 1,
    "version": "frontend@1.0.0",
    "shortVersion": "frontend@1.0.0",
    "status": "open",
    "dateReleased": null,
    "dateCreated": "2024-01-01T00:00:00Z",
    "authors": [],
    "projects": [{ "id": 1, "slug": "sentry", "name": "sentry" }]
  }
]
```

## Unverified

Nothing on this page has been tried against a real Sentry organization. Confirm with a test organization and an unpublished integration before relying on the adapter:

- The install, redirect, code exchange, and JWT bearer refresh end to end, including that `state` comes back unchanged from the external install URL and that the refresh response has the documented shape.
- That `installationId` is always a UUID and `orgSlug` the organization's current slug, and that a spoofed `orgSlug` is refused (`403` or `404`) when the token lists that organization's projects.
- That an installation grants exactly the registered scopes (the token response lists none), and what happens to existing installs when the integration's scopes change.
- The status codes after an uninstall: on API calls (expected `401`) and on the refresh (`401`, `403`, or `404` are all treated as uninstalled).
- That integration tokens can call `stats_v2` with `project=<id>`, and that `statsPeriod=24h` with `interval=1h` returns hourly aligned `start` and `end`.
- The issue search syntax in the API: the `firstSeen:>=` and `lastSeen:>=` datetime form with a trailing `Z`, that an explicit `query` replaces the default `is:unresolved`, that `issue:[A-1,B-2]` matches a list of short ids, and that `statsPeriod=14d` limits results to issues seen in that window.
- That `substatus` reads `regressed` for a regressed issue in the list response, and for how long it stays so.
- That `limit` is the page size for the organization issue list (the reference describes it as "the maximum number of issues to affect").
- That the release list is sorted by `dateCreated`, newest first, and accepts a numeric project id in `project`.
- Whether EU organizations answer on `sentry.io` for every endpoint here, or need `de.sentry.io`.
- The Sentry UI names in the registration steps and the manual uninstall path (**Settings**, **Integrations**, StackDash, **Uninstall**).
- Whether the public integration form requires a webhook URL.
- Real rate limits for these endpoints, and how long the issue search lags behind ingestion.

## Sources

All checked 2026-11-05.

- [Integration platform](https://docs.sentry.io/organization/integrations/integration-platform/) (now at [integrations/integration-platform](https://docs.sentry.io/integrations/integration-platform/))
- [Public integrations: installation, OAuth process, external install URL and `state`, token refresh, verifying installations](https://docs.sentry.io/integrations/integration-platform/public-integration/)
- [Integration platform webhooks](https://docs.sentry.io/integrations/integration-platform/webhooks/)
- [API authentication (OAuth applications, the alternative considered)](https://docs.sentry.io/api/auth/)
- [Permissions and scopes](https://docs.sentry.io/api/permissions/)
- [API overview: region domains](https://docs.sentry.io/api/)
- [Paginating results](https://docs.sentry.io/api/pagination/)
- [Rate limits](https://docs.sentry.io/api/ratelimits/)
- [List an organization's projects](https://docs.sentry.io/api/organizations/list-an-organizations-projects/)
- [Retrieve event counts for an organization (v2)](https://docs.sentry.io/api/organizations/retrieve-event-counts-for-an-organization-v2/)
- [Stats page: outcome definitions](https://docs.sentry.io/product/stats/)
- [List an organization's issues](https://docs.sentry.io/api/events/list-an-organizations-issues/)
- [Search syntax](https://docs.sentry.io/concepts/search/)
- [Issue properties for search](https://docs.sentry.io/concepts/search/searchable-properties/issues/)
- [List an organization's releases](https://docs.sentry.io/api/releases/list-an-organizations-releases/)
- [List a project's client keys (scope `project:read`)](https://docs.sentry.io/api/projects/list-a-projects-client-keys/)
- [Sentry branding (glyph in dark and light)](https://sentry.io/branding/)
