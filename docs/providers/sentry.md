# Sentry

Provider id: `sentry`. Verification: documentation only. Docs checked 2026-11-05; webhook pages 2026-11-16.

StackDash reads error counts per Sentry project, new and regressed issues, resolutions, and releases. It installs as a Sentry integration with three read-only scopes. Issue events arrive by webhook within a minute, and polling fills in the rest. Sentry does not report cost, so StackDash shows none.

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
- After an uninstall the token stops working. Sentry sends `installation.deleted` to the integration's Webhook URL, and StackDash marks every connection granted for that installation as needing a reconnect at once (see [Webhooks](#webhooks)). Without the delivery it finds out on the next sync: a `401` on any call, or a `401`, `403`, or `404` on the refresh, marks the connection as needing a reconnect. The exact codes are unverified.

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

### Timeline events

| Event type | Source | Dated | Severity | Rule |
|---|---|---|---|---|
| `sentry.issue.created` (New issue) | New issues search, or an `issue.created` delivery | `firstSeen` | `critical` for fatal, `warning` for error, `info` otherwise | One per issue id |
| `sentry.issue.regressed` (Issue regressed) | Active issues search, or an `issue.unresolved` delivery with `substatus: "regressed"` | When Sentry sent the delivery, or when the sync saw it | `critical` for fatal and error, `warning` otherwise | One per issue per UTC day. By polling: when `substatus` is `regressed` and the issue was not remembered as regressed, and not on the first sync, which records a baseline |
| `sentry.issue.resolved` (Issue resolved) | Resolved search over remembered issues, or an `issue.resolved` delivery | When Sentry sent the delivery, or when the sync saw it | `success` | One per issue per UTC day. By polling: once, then the issue is forgotten |
| `sentry.release.created` (New release) | Release list (polling only) | `dateCreated` | `info` | One per release and project |

Titles carry the short id or the release version, never the issue title: "New issue WEB-1A", "Issue WEB-1A regressed", "Issue WEB-1A resolved", "Release web@1.2.0 created". Issue events link to the issue's `permalink` when it is an `https` address on `sentry.io` or a subdomain of it. The issue list does not say when a status changed, so a sync dates regressed and resolved events by when it saw them; a delivery dates them by when Sentry sent it. Whichever arrives first is stored and the other is dropped, because both build the same dedupe key:

- `sentry.issue.created:<issue id>`.
- `sentry.issue.resolved:<issue id>:<UTC day>` and `sentry.issue.regressed:<issue id>:<UTC day>`. Nothing on the issue stands still across a change: each new event moves `lastSeen`, and an issue resolved in a release or by a commit keeps receiving events from older releases while it stays resolved. The day of the change is the one value the delivery and the next sync both know.

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
| Regressions and resolutions | Verified status. Time verified when a delivery arrives first (when Sentry sent it); otherwise estimated: when the sync saw the change, up to one poll interval late |
| Spend, plan, reserved volume, on-demand budget, quota remaining | Unavailable: no endpoint for integrations |
| Transactions, replays, attachments, profiles, and other categories | Unavailable in this adapter (the same endpoint can count them; StackDash does not read them) |
| Who is assigned, who released, issue titles and messages | Not collected on purpose |

## Rate limits

- Sentry limits each caller per endpoint with fixed windows, plus a limit on concurrent requests. Limits differ per endpoint and are not published; each response carries `X-Sentry-Rate-Limit-Limit`, `-Remaining`, `-Reset` (UTC epoch seconds), `-ConcurrentLimit`, and `-ConcurrentRemaining`.
- The limit follows the caller's identity, not the token, so more tokens do not raise it.
- Sentry warns that polling the API "is likely to quickly trigger rate limiting" and recommends webhooks. StackDash polls hourly, runs its requests one after another, and backs off on `429` with `Retry-After` through the shared adapter error handling.
- Budget per project per sync: one stats call, two or three issue searches, one release list, so at most 5 requests per project per hour, plus one token refresh per connection about every 8 hours. 20 projects is about 100 requests an hour.

## Webhooks

Received at `<SITE_URL>/api/webhooks/sentry`, the one Webhook URL on the integration's registration, through the shared webhook route (see [Webhooks](../adapters.md#webhooks)). Polling still runs hourly as the backfill and stays the only source of error volume and releases, which have no webhook. Webhooks need no access beyond the three read scopes.

| Item | Value |
|---|---|
| Subscriptions | **Issue** on the registration (`issue.created`, `issue.resolved`, `issue.unresolved` are read). Installation webhooks reach every public integration without a subscription |
| Signature | `Sentry-Hook-Signature`: the hex HMAC SHA-256 of the raw body bytes, keyed with `SENTRY_CLIENT_SECRET`, compared in constant time before the body is parsed |
| Delivery id | `Request-ID` (a UUID in hex, one per request). A repeated id is acknowledged and dropped |
| Freshness | `Sentry-Hook-Timestamp`, whole seconds. A delivery more than 5 minutes either side of StackDash's clock is refused. Sentry documents no tolerance |
| Resource | `Sentry-Hook-Resource`: `issue` and `installation` are read; any other resource is acknowledged and ignored |
| Response | Within Sentry's 1 second: the route checks the delivery, stores it with a job, and answers `202`. The next job tick, at most a minute later, applies it |

Sentry signs only the body. Neither `Request-ID` nor `Sentry-Hook-Timestamp` is covered, so a captured delivery replayed under a new id and a fresh timestamp passes the check. What bounds a replay is that every event's dedupe key is the one the sync builds: a replayed new issue stores nothing new, and a replayed resolution or regression adds at most one entry per issue per UTC day. A replayed uninstall names an installation id, and a reconnect is granted a new one. The resource header is not signed either, so an uninstall is read only from a body that carries the installation under `data` with the same `uuid` as the top-level `installation`, as Sentry's installation payload does.

### What a delivery becomes

| Delivery | Becomes | Dated |
|---|---|---|
| `issue.created` | `sentry.issue.created` (New issue) | `firstSeen` |
| `issue.resolved` | `sentry.issue.resolved` (Issue resolved) | When Sentry sent it (`Sentry-Hook-Timestamp`) |
| `issue.unresolved` with `substatus: "regressed"` | `sentry.issue.regressed` (Issue regressed) | When Sentry sent it |
| `issue.unresolved` with any other substatus (`escalating`, `ongoing`), `issue.assigned`, `issue.archived` | Nothing: acknowledged and ignored | Not applicable |
| Any issue delivery whose `issueCategory` is `feedback` | Nothing: user feedback is not an error, and the issue search never returns it, so polling never reports it either | Not applicable |
| `installation.deleted` | Every connection granted for that installation is marked as needing a reconnect | When Sentry sent it |
| `installation.created` | Nothing: a connection is made through the install redirect | Not applicable |

The project (`data.issue.project.id`) is the external account, and the installation that sent the delivery (`installation.uuid`) must be the one stored with the connection (the install redirect's `installationId`). So an issue delivery reaches every workspace that includes that project through a connection of that installation; a project no such connection includes is acknowledged and dropped. A connection marked as needing a reconnect after an uninstall still includes its projects, but if the same Sentry organization later installs StackDash again, for another workspace or the same one, deliveries from the new installation reach only the connections made with it. A connection made before StackDash stored installation ids gets no issue delivery until it has one: an `active` or `failed` connection records it on its next sync, within the hour, and polling brings it the same events meanwhile; a connection waiting for a reconnect is not synced, so it gets no issue delivery and no polling until the user reconnects it, which records the installation. An uninstall is matched on `installation.uuid` against the installation id stored with each connection; an installation StackDash does not know is acknowledged and dropped. A connection reconnected after the uninstall was sent is left alone.

Fields read from an issue delivery: `action`, `installation.uuid`, `id`, `shortId`, `substatus`, `level`, `firstSeen`, `permalink`, `issueCategory`, and `project.id`. From an installation delivery: `action`, `installation.uuid`, and `data.installation.uuid`. Never read: `title`, `culprit`, `metadata`, `assignedTo`, `status` and `lastSeen` (the action says what happened), the `actor` (who triggered the delivery, by name), and the grant `code` in `installation.created`. Logs name the delivery id and why a delivery was refused, never the body.

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
- Without a delivery (webhooks not set up on the integration, or one missed), regressions and resolutions are dated when the sync saw them, up to one poll interval late.
- One regression and one resolution per issue per UTC day: a second change of the same kind that day is not shown. A change delivered in the last poll interval before midnight UTC and seen by the sync after midnight shows twice, and a resolution then counts twice toward the resolved achievements (`sentry.issues.resolved_100` and `sentry.issues.bug_squasher`).
- Without a delivery, a resolution is seen only for issues StackDash remembers: up to 100 per project that were unresolved and active within the last 13 days. An issue resolved weeks after its last event is reported only by its delivery.
- Renaming the organization changes its slug, which StackDash stores; calls then fail until the user reconnects (unverified whether Sentry redirects old slugs).
- The hosted integration is unavailable to other organizations until Sentry approves its publication.

## Self-hosted registration

Each deployment registers its own public integration, because the redirect URL and client secret belong to one deployment. The click path below follows Sentry's documentation and is unverified.

1. In sentry.io, open **Settings**, **Developer Settings**, then **Create New Integration** and choose **Public Integration**. Use the organization that should own it.
2. **Name**: for example `StackDash (your name)`. The slug Sentry derives from it is `SENTRY_INTEGRATION_SLUG`; it appears in `https://sentry.io/sentry-apps/<slug>/external-install/`.
3. **Redirect URL**: `<SITE_URL>/api/connections/sentry/callback`.
4. Leave **Verify Installation** unchecked. Set **Webhook URL** to `<SITE_URL>/api/webhooks/sentry` and, under **Webhooks**, check **Issue**. Leave **Alert Rule Action** off and the other webhook subscriptions unchecked. Installation webhooks need no subscription.
5. **Permissions**: Project Read, Issue & Event Read, Organization Read. Everything else No Access.
6. Save. On the integration's page, under **Credentials**, copy the **Client ID** and **Client Secret**.
7. Upload the logo Sentry requires for public integrations (PNG, 256 to 1024 pixels square, transparent background).
8. Set the environment variables:

| Variable | Value |
|---|---|
| `SENTRY_CLIENT_ID` | Client ID |
| `SENTRY_CLIENT_SECRET` | Client Secret. Also signs the refresh JWT and verifies webhook deliveries |
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

Issue webhook, `Sentry-Hook-Resource: issue` (from documentation, not recorded; trimmed, synthetic ids, and the fields StackDash drops are kept to show what it drops):

```json
{
  "action": "created",
  "installation": { "uuid": "24b397fc-a86e-43ef-9297-949e21b82480" },
  "data": {
    "issue": {
      "id": "1234567890",
      "shortId": "PYTHON-Y",
      "title": "Error generated with event_id: 495d375a-1df6-45c0-9890-34dae8e1b6a4(Priority: HIGH)",
      "culprit": "test-transaction-0-41e49cd3-7252-441f-8d27-63a9ad697b0a",
      "permalink": "https://example-org.sentry.io/issues/1234567890/",
      "level": "fatal",
      "status": "unresolved",
      "statusDetails": {},
      "substatus": "new",
      "project": { "id": "112313123123134", "name": "python", "slug": "python", "platform": "python" },
      "assignedTo": null,
      "firstSeen": "2025-11-10T20:56:00.679000+00:00",
      "lastSeen": "2025-11-10T20:56:00.738000+00:00"
    }
  },
  "actor": { "type": "application", "id": "example-app", "name": "Example App" }
}
```

Installation webhook, `Sentry-Hook-Resource: installation` (from documentation, not recorded; the grant code shown as a placeholder):

```json
{
  "action": "created",
  "actor": { "id": 1, "name": "Meredith Heller", "type": "user" },
  "data": {
    "installation": {
      "status": "pending",
      "organization": { "slug": "test-org" },
      "app": { "uuid": "2ebf071f-28df-4989-aca9-c37c763b278f", "slug": "webhooks-galore" },
      "code": "<grant-code>",
      "uuid": "a8e5d37a-696c-4c54-adb5-b3f28d64c7de"
    }
  },
  "installation": { "uuid": "a8e5d37a-696c-4c54-adb5-b3f28d64c7de" }
}
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
- Whether the public integration form requires a webhook URL (StackDash now sets one).
- Webhooks end to end: that deliveries carry `Request-ID`, `Sentry-Hook-Resource`, and `Sentry-Hook-Timestamp` in whole seconds as Sentry's source sets them, and the signature as documented; whether Sentry retries a failed delivery, and under which `Request-ID`.
- That a regression is delivered as `issue.unresolved` with `substatus: "regressed"`, and that `issueCategory` reads `feedback` for user feedback issues.
- That `installation.deleted` is sent on uninstall with the `installation.uuid` the install redirect gave as `installationId`, at the top level and again under `data.installation` (Sentry documents a payload for `created` only; StackDash ignores a `deleted` body without both).
- That an issue delivery's top-level `installation.uuid` is the `installationId` the install redirect gave for the same installation. Sentry documents it as the object that maps a webhook request "to the appropriate installation"; a mismatch would drop every issue delivery, and polling would still bring the events.
- Real rate limits for these endpoints, and how long the issue search lags behind ingestion.

## Sources

All checked 2026-11-05, except the webhook pages and Sentry's source, checked 2026-11-16.

- [Integration platform](https://docs.sentry.io/organization/integrations/integration-platform/) (now at [integrations/integration-platform](https://docs.sentry.io/integrations/integration-platform/))
- [Public integrations: installation, OAuth process, external install URL and `state`, token refresh, verifying installations](https://docs.sentry.io/integrations/integration-platform/public-integration/)
- [Integration platform webhooks: headers, signature, request structure, 1 second response](https://docs.sentry.io/integrations/integration-platform/webhooks/)
- [Issue webhooks: actions, `status`, `substatus`, payload](https://docs.sentry.io/integrations/integration-platform/webhooks/issues/)
- [Installation webhooks: `created` and `deleted`, payload](https://docs.sentry.io/integrations/integration-platform/webhooks/installation/)
- [Sentry source, `AppPlatformEvent` headers: `Request-ID` as a UUID in hex, `Sentry-Hook-Timestamp` in whole seconds, signature over the body only](https://github.com/getsentry/sentry/blob/72757dae9b6d527e564c81d4921dec0d62d7beca/src/sentry/sentry_apps/api/serializers/app_platform_event.py)
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
