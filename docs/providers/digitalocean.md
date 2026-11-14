# DigitalOcean

Provider id: `digitalocean`. Verification: documentation only. Docs checked 2026-11-05.

StackDash reads your DigitalOcean balance, month-to-date usage, invoices, daily spend, Droplet actions, and App Platform deployments. It asks for five read-only scopes, one connection per team, and nothing that can write.

**Nothing on this page has been tried against a real DigitalOcean account yet.** Registering apps on real platforms is deferred, so the adapter is built from the official API reference and the OpenAPI specification, and its tests run on samples taken from them. Every claim that only a real account can confirm is listed under [Unverified](#unverified).

## Go or no-go

**Go, after the checks under Unverified.** A DigitalOcean OAuth app with five read-only scopes covers everything StackDash reads: the account balance and month-to-date usage, invoices with line items, daily spend by SKU from Billing Insights, Droplet actions, and App Platform deployments. Nothing needs a write scope. One grant covers one DigitalOcean team, so a person with several teams makes several connections.

## Connection

OAuth 2.0 authorization code flow. StackDash registers a **confidential client** (it has a backend that keeps the client secret) and also sends PKCE (`S256`), which the OAuth page allows for confidential clients "for additional protection".

| Item | Value |
|---|---|
| Authorization server metadata | `https://cloud.digitalocean.com/.well-known/oauth-authorization-server` |
| Authorize URL | `GET https://cloud.digitalocean.com/v1/oauth/authorize` (browser navigation, never fetched server side) |
| Token URL | `POST https://cloud.digitalocean.com/v1/oauth/token` |
| Revoke URL | `POST https://cloud.digitalocean.com/v1/oauth/revoke` |
| API base URL | `https://api.digitalocean.com` |
| Scopes requested | `billing:read`, `actions:read`, `app:read`, `droplet:read`, `account:read` |
| Access token | `expires_in: 2592000` (30 days) for confidential clients. Prefix `doo_v1_` |
| Refresh token | Prefix `dor_v1_`. **Single use**: refreshing returns a new pair and invalidates the access token the refresh token came with |
| Callback URL | `<SITE_URL>/api/connections/digitalocean/callback` |
| Variables | `DIGITALOCEAN_CLIENT_ID`, `DIGITALOCEAN_CLIENT_SECRET` |

### Authorize

Query parameters: `client_id`, `redirect_uri` (must match a registered callback URL), `response_type=code`, `scope` (the five scopes, space separated), `state`, `code_challenge`, `code_challenge_method=S256`. StackDash always sends `scope`: without it, the consent screen offers **Manage permissions**, where the user can pick any scope, including write scopes.

The user signs in, chooses the team, and approves. DigitalOcean redirects back with `code` and `state` only. A mismatched `state` aborts the connection.

### Token exchange

`POST /v1/oauth/token` with `grant_type=authorization_code`, `code`, `client_id`, `client_secret`, `redirect_uri`, `code_verifier`. StackDash sends them as an `application/x-www-form-urlencoded` body. The documentation's example puts them in the query string instead; the body keeps the client secret out of URLs and logs, and the refresh example on the same page uses a form body, but the body form for this grant is unverified.

The response carries `access_token`, `token_type` (`bearer`), `expires_in`, `refresh_token`, `scope`, and `info` with `name`, `email`, `uuid`, `team_uuid`, and `team_name`. StackDash keeps only `info.team_uuid`, as the connection's team. It never stores the name or email. When `info.team_uuid` is missing, it reads the team from `GET /v2/account` instead.

### Refresh and rotation

`POST /v1/oauth/token` with `grant_type=refresh_token` and `refresh_token`. StackDash also sends `client_id` and `client_secret`, because RFC 6749 section 6 asks a confidential client to authenticate; the documented example sends only the first two (unverified). The response has the same shape as the exchange: a new access token **and a new refresh token**.

A refresh token works exactly once, and refreshing invalidates the old access token. So:

- The adapter returns the new pair as one credential, and the sync runner saves it before anything else uses it (`refreshIfExpiring` in `src/lib/jobs/sync-connection.ts`).
- Refreshes are serialized per connection by the job queue: at most one sync per connection is queued or running (`sync_jobs_one_open_sync_per_connection`, see [Jobs, How a tick works](../operations/jobs.md#how-a-tick-works)). Two parallel refreshes would spend the same token twice and lose the connection.
- The runner refreshes within 5 minutes of expiry. An hourly sync refreshes once every 30 days.
- DigitalOcean documents three token errors ([OAuth troubleshooting](https://docs.digitalocean.com/support/im-getting-an-error-when-using-the-digitalocean-oauth-api./)). Only `invalid_grant`, a refresh token or code that is used, expired, or revoked, is reported as `auth_revoked`, so the connection asks to be reconnected instead of retrying a token that can never work again. A `401` is also `auth_revoked` unless its body says `invalid_client`. On the code exchange, `invalid_grant` also means the OAuth app's callback URL does not match `redirect_uri`, so when every first connect fails with it, check the app registration ([OAuth apps](../operations/oauth-apps.md)), not the user's grant.
- `invalid_client` (wrong client id or secret, as a `400` or a `401`) and `invalid_request` (a malformed request) are this instance's OAuth app configuration, not the user's grant. They are reported as `invalid_response`: retried, and logged with the error reference, never a reconnect prompt. If every DigitalOcean connection fails this way, check `DIGITALOCEAN_CLIENT_ID` and `DIGITALOCEAN_CLIENT_SECRET`.

### Disconnect and revoke

- From StackDash: `POST /v1/oauth/revoke` with `Authorization: Bearer <access token>` and body `token=<access token>`. The response is an empty JSON object. Whether revoking the access token also invalidates its refresh token is unverified; StackDash deletes both either way.
- From DigitalOcean: team members can remove an authorized application in the control panel (the "Authorized Applications" role permission covers it; the exact click path is unverified). Without webhooks, StackDash finds out on the next sync, when the API answers `401`.

## Permissions

All read-only. Nothing in this list can create, change, or delete anything.

| Scope | Why StackDash asks | Endpoints StackDash calls |
|---|---|---|
| `billing:read` | Balance, month-to-date usage, invoices, line items, daily spend by SKU | `GET /v2/customers/my/balance`, `GET /v2/customers/my/invoices`, `GET /v2/customers/my/invoices/{invoice_uuid}`, `GET /v2/billing/{account_urn}/insights/{start_date}/{end_date}` |
| `actions:read` | Droplet creates, resizes, power cycles, and deletes | `GET /v2/actions` |
| `app:read` | App Platform deployments started, succeeded, and failed | `GET /v2/apps`, `GET /v2/apps/{app_id}/deployments` |
| `droplet:read` | Droplet names, so Droplet events say which Droplet | `GET /v2/droplets` |
| `account:read` | The team's id and name, to label the connection | `GET /v2/account` |

Not requested: anything ending in `:create`, `:update`, `:delete`, `:admin`, or `:access_console`, and the `api:read` alias, which grows to cover every new read endpoint DigitalOcean adds.

Every event type StackDash reads is readable with these scopes. No event type was left out for needing a write scope.

## Data

### Balance: `GET /v2/customers/my/balance`

Fields: `month_to_date_usage`, `account_balance`, `month_to_date_balance` (the documented sum of the other two), `generated_at`. Amounts are decimal strings in US dollars.

- `digitalocean.spend.month_to_date`: verified spend, `month_to_date_usage`, for the billing month of `generated_at` (UTC), up to the end of the current UTC day. Right after midnight on the 1st the balance can still be last month's; its period then ends on the 1st, so it never counts as this month's spend.
- `digitalocean.credit.balance`: credit balance, `account_balance` negated, at `generated_at`. Because `month_to_date_balance = account_balance + month_to_date_usage`, a positive `account_balance` is owed and a credit is negative; StackDash shows credit as positive (unverified).

### Invoices: `GET /v2/customers/my/invoices` and `GET /v2/customers/my/invoices/{invoice_uuid}`

Invoices are generated on the 1st of each month. The list has `invoice_uuid`, `amount`, and `invoice_period` (`YYYY-MM`), plus an `invoice_preview` for the current month, which StackDash does not read (the balance has the same figure). Line items have `product`, `amount`, `description`, `resource_id`, `project_name`, and more; StackDash reads only `product` and `amount`.

- `digitalocean.invoice.latest`: verified spend, the latest invoice's total, for its billing month. That month has ended by the time it is read, so the invoice is never counted as current spend: spend totals, alerts, projections, and the daily summary (`isCurrentPeriod` in `src/lib/dashboard/aggregate.ts`) and the headline strip count the month to date usage instead.
- `digitalocean.invoice.issued` event for each new invoice, dated the 1st of the following month, with the five largest products in the body. A first sync announces only the latest invoice. A later sync announces at most the 3 newest unannounced invoices and moves the cursor past the rest, so after a long outage the older ones never appear; it logs `digitalocean.invoices.new_cap_reached` with the number skipped.

### Daily spend by SKU: `GET /v2/billing/{account_urn}/insights/{start_date}/{end_date}`

`account_urn` is `do:team:<team uuid>`. Dates are `YYYY-MM-DD`, at most 31 days apart. Each data point has `usage_team_urn`, `start_date`, `total_amount`, `region`, `sku`, `description`, and `group_description`. DigitalOcean builds them from nightly invoice item estimates and says they may not add up to the month's invoice.

Each sync reads the last three whole UTC days and keeps the latest day present. Points for another team are skipped.

- `digitalocean.daily_spend.sku_<sku>`: **estimated** spend per SKU for that day (the SKU lowercased, other characters as `_`). The provenance names Billing Insights as the source of the estimate. At most 50 SKUs per sync, largest first; a SKU that nets below zero (a credit) has no metric. A SKU's day is read after it ends, so it never counts as current spend: the card, alerts, and the daily summary leave it out (`isCurrentPeriod` in `src/lib/dashboard/aggregate.ts`). It feeds the trend charts and the unusual spend and usage checks, which check a SKU's day on the day before (`docs/operations/jobs.md`).

Billing Insights only hold spend from 2025-12-01 onward. A `404` from this endpoint is recorded as a gap on the connection, not a failed sync.

### Droplet actions: `GET /v2/actions` (and names from `GET /v2/droplets`)

Each action has `id`, `status` (`in-progress`, `completed`, `errored`), `type`, `started_at`, `completed_at`, `resource_id`, `resource_type`, and `region_slug`. StackDash keeps finished Droplet actions of four types:

| Action `type` | Event | Severity |
|---|---|---|
| `create` | `digitalocean.droplet.created` | Success |
| `resize` | `digitalocean.droplet.resized` | Info |
| `power_cycle` | `digitalocean.droplet.power_cycled` | Warning |
| `destroy` | `digitalocean.droplet.destroyed` | Warning |
| Any of these, `errored` | `digitalocean.droplet.action_failed` | Critical |

Events are dated at `completed_at`, titled with the Droplet's name from `GET /v2/droplets` (a deleted Droplet keeps its numeric id), and deduplicated on the action id and status. Without `droplet:read`, titles use the id and the gap is recorded.

### App Platform deployments: `GET /v2/apps` and `GET /v2/apps/{app_id}/deployments`

Deployment phases: `UNKNOWN`, `PENDING_BUILD`, `BUILDING`, `PENDING_DEPLOY`, `DEPLOYING`, `ACTIVE`, `SUPERSEDED`, `ERROR`, `CANCELED`.

| Rule | Event | Severity |
|---|---|---|
| Every deployment, at `created_at` | `digitalocean.deployment.started` | Info |
| `ACTIVE`, or `SUPERSEDED` with every progress step successful | `digitalocean.deployment.succeeded` | Success |
| `ERROR` | `digitalocean.deployment.failed` | Critical |

Finished events are dated at `phase_last_updated_at`, or `updated_at` when that is the zero time (`0001-01-01T00:00:00Z`, as in the documentation's example). Canceled deployments have only the started event. StackDash reads the app's `spec.name` and never the rest of the spec or the deployment's `cause`, which can carry commit messages.

Only apps whose `last_deployment_created_at` falls in the sync window are read, at most 25 per sync, 20 deployments each.

### Polling windows and the cursor

The first sync looks back 7 days for actions and deployments. Later syncs start an hour before the latest `started_at` and `created_at` seen, so an action or deployment still running at the last poll is seen again once it finishes; dedupe keys make the overlap harmless. The cursor also stores the latest invoice month seen. A part of the sync the grant cannot reach keeps its old cursor value.

### Units, freshness, retention

- Money: every amount is a decimal string in US dollars (the API names no currency field; the reference says "Billed in USD"). Parsed exactly and rounded once per metric to cents, half to even (`src/lib/money.ts`).
- Freshness: the balance carries `generated_at`. Billing Insights are nightly. Actions and deployments are near real time.
- Retention: Billing Insights from 2025-12-01. How far back the action history goes is not documented.

## Achievements

StackDash evaluates these for each project the DigitalOcean accounts are assigned to, from the DigitalOcean data it has stored, after each sync (see [Achievements](../adapters.md#achievements)). A project earns each one once, and it stays private until an owner or admin publishes it.

The deployment ladder is the same on Vercel, Railway, and GitLab. It counts `digitalocean.deployment.succeeded` events, and a `digitalocean.deployment.failed` event breaks a run of deployments in a row. The droplet achievements count `digitalocean.droplet.created` events. Days, hours, and weekdays are London time.

| Id | Title | How it is earned |
|---|---|---|
| `digitalocean.deployments.first` | First DigitalOcean deployment recorded | Earned when StackDash records the first successful DigitalOcean deployment. |
| `digitalocean.deployments.10` | 10 DigitalOcean deployments recorded | Earned when StackDash records the 10th successful DigitalOcean deployment. |
| `digitalocean.deployments.100` | 100 DigitalOcean deployments recorded | Earned when StackDash records the 100th successful DigitalOcean deployment. |
| `digitalocean.deployments.streak_10` | 10 DigitalOcean deployments in a row | Earned when StackDash records 10 successful DigitalOcean deployments in a row, with no failed deployment between them. |
| `digitalocean.deployments.night_owl` | Night owl: a DigitalOcean deployment between midnight and 5 am | Earned when StackDash records a successful DigitalOcean deployment between midnight and 5 am London time. |
| `digitalocean.deployments.friday_ship` | Shipped on a Friday afternoon | Earned when StackDash records a successful DigitalOcean deployment on a Friday between 4 pm and midnight London time. |
| `digitalocean.deployments.busy_day` | Busy day: 10 DigitalOcean deployments in one day | Earned when StackDash records 10 successful DigitalOcean deployments on one London calendar day. |
| `digitalocean.deployments.weekly_rhythm` | Weekly rhythm: a DigitalOcean deployment on 7 days in a row | Earned when StackDash records a successful DigitalOcean deployment on each of 7 consecutive London calendar days. |
| `digitalocean.droplets.first` | First droplet created | Earned when StackDash records the first new DigitalOcean droplet. |
| `digitalocean.droplets.fleet` | Fleet commander: 10 droplets created | Earned when StackDash records the 10th new DigitalOcean droplet. |

## Verified, estimated, unavailable

| Value | Status |
|---|---|
| Month-to-date usage, account balance | Verified (DigitalOcean's figures; the month is provisional until invoiced) |
| Invoice totals and line items | Verified |
| Daily spend per SKU | Estimated (DigitalOcean's own nightly estimate) |
| Droplet actions, App Platform deployments | Verified |
| Allowances, quotas, free tier remaining | Unavailable |
| Spend for teams inside an organization billed at the organization | Unverified (see below) |

## Rate limits

Per OAuth token: 5,000 requests an hour and 250 a minute. Each request counts for one hour after it is made. Headers: `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`; a rate limited response adds `retry-after`, which the shared fetch helper honors.

Budget per hourly sync, worst case: 1 balance, 1 invoice list, up to 15 invoice item pages (3 new invoices), up to 5 Billing Insights pages, up to 5 action pages, up to 5 Droplet pages, up to 5 app pages, and up to 25 deployment lists: about 60 requests. A typical sync is 6 or 7. Requests run one after another.

## Webhooks (Post-MVP)

DigitalOcean has no general outbound webhooks for billing, actions, or deployments. Everything is polled.

## Permission risks

Disclosed on the connect screen before redirecting:

- **`app:read`** also reads app settings, including environment variable values that are not marked secret, and build and runtime logs, which can contain secrets. StackDash reads only app names and deployment status.
- **`billing:read`** also downloads invoice PDF and CSV files, which show the billing address. StackDash never downloads them.
- **`droplet:read`** also reads Droplet details: IP addresses, sizes, tags, backups, snapshots, and neighbors. StackDash reads only Droplet names.
- **`actions:read`** covers the action history of every resource type in the team, not only Droplets.
- **`account:read`** also reads the signed-in user's name and email address. StackDash reads only the team.
- The refresh token is long-lived in practice: each refresh mints a new one. It is stored encrypted with the access token and never logged.

## Limitations

- No spend allowance or free tier data.
- Billing Insights are estimates and start on 2025-12-01.
- The action list's order is not documented. StackDash assumes newest first and stops reading once a page reaches back past the sync window, so an oldest-first list would hide recent actions.
- The Droplet list skips GPU Droplets unless asked for them, so a GPU Droplet's events show its id.
- An action or deployment that runs for more than an hour past a newer one may be missed when it finishes.
- One grant is one team. Several teams need several connections.
- Enterprise organizations billed at the organization level are untested.

## Self-hosted registration

Each deployment registers its own OAuth app, because the callback URL and client secret belong to one deployment. Field names below are from the OAuth page and are unverified until a real app is registered.

1. Sign in to the DigitalOcean control panel with the team that should own the app, open **API**, then **OAuth Applications**, and choose **Register OAuth application** ([direct link](https://cloud.digitalocean.com/account/api/applications/new)).
2. **Name**: for example `StackDash (your name)`. **Homepage URL**: `<SITE_URL>`. **Description**: what the app reads.
3. **Callback URL**: `<SITE_URL>/api/connections/digitalocean/callback`. For local development register a separate app with `http://localhost:3000/api/connections/digitalocean/callback`.
4. Register, then open the app's **View** dialog and copy the **Client ID** and **Client Secret**.
5. Set the environment variables, server only, never with a `NEXT_PUBLIC_` prefix:

   ```
   DIGITALOCEAN_CLIENT_ID=<client id>
   DIGITALOCEAN_CLIENT_SECRET=<client secret>
   ```

6. Connect a test team in a test workspace and check that the connection becomes active with no missing permissions.

Scopes are not configured on the app: StackDash sends them with every authorize request.

## Sample responses

From documentation, not recorded: the OAuth page and the OpenAPI examples, trimmed, with synthetic ids, names, and amounts. Tokens are placeholders. The test fixtures in `src/lib/adapters/digitalocean/fixtures/` are the same samples with dates moved to November 2026.

`POST /v1/oauth/token`:

```json
{
  "access_token": "<access token>",
  "token_type": "bearer",
  "expires_in": 2592000,
  "refresh_token": "<refresh token>",
  "scope": "read",
  "info": {
    "name": "Sammy the Shark",
    "email": "sammy@example.com",
    "uuid": "00000000-a636-11ec-9e9d-3381ceabe039",
    "team_uuid": "11111111-a636-11ec-a6ac-1323bf96ef4d",
    "team_name": "My Team"
  }
}
```

`GET /v2/customers/my/balance`:

```json
{
  "month_to_date_balance": "23.44",
  "account_balance": "12.23",
  "month_to_date_usage": "11.21",
  "generated_at": "2019-07-09T15:01:12Z"
}
```

`GET /v2/customers/my/invoices` (trimmed):

```json
{
  "invoices": [
    { "invoice_uuid": "22737513-0ea7-4206-8ceb-98a575af7681", "invoice_id": "12345678", "amount": "12.34", "invoice_period": "2019-12" }
  ],
  "invoice_preview": { "invoice_uuid": "1afe95e6-0958-4eb0-8d9a-9c5060d3ef03", "amount": "34.56", "invoice_period": "2020-02", "updated_at": "2020-02-23T06:31:50Z" },
  "links": { "pages": { "next": "https://api.digitalocean.com/v2/customers/my/invoices?page=2&per_page=2" } },
  "meta": { "total": 70 }
}
```

`GET /v2/billing/do:team:{uuid}/insights/2025-01-01/2025-01-31`:

```json
{
  "data_points": [
    {
      "usage_team_urn": "do:team:12345678-1234-1234-1234-123456789012",
      "start_date": "2025-01-01",
      "total_amount": "0.86",
      "region": "nyc3",
      "sku": "1-DO-DROP-0109",
      "description": "droplet name (c-2-4GiB)",
      "group_description": ""
    }
  ],
  "total_items": 1,
  "total_pages": 1,
  "current_page": 1
}
```

`GET /v2/actions` (one action):

```json
{
  "actions": [
    {
      "id": 36804636,
      "status": "completed",
      "type": "create",
      "started_at": "2020-11-14T16:29:21Z",
      "completed_at": "2020-11-14T16:30:06Z",
      "resource_id": 3164444,
      "resource_type": "droplet",
      "region_slug": "nyc3"
    }
  ],
  "links": {},
  "meta": { "total": 1 }
}
```

`GET /v2/apps/{app_id}/deployments` (trimmed; the zero `phase_last_updated_at` is from the documentation):

```json
{
  "deployments": [
    {
      "id": "b6bdf840-2854-4f87-a36c-5f231c617c84",
      "phase": "PENDING_BUILD",
      "phase_last_updated_at": "0001-01-01T00:00:00Z",
      "created_at": "2020-07-28T18:00:00Z",
      "updated_at": "2020-07-28T18:00:00Z",
      "cause": "commit 9a4df0b pushed to github/digitalocean/sample-golang",
      "progress": { "pending_steps": 6, "total_steps": 6 }
    }
  ],
  "links": { "pages": {} },
  "meta": { "total": 1 }
}
```

## Unverified

Confirm with a test team before the adapter is offered to users:

1. That the code exchange accepts its parameters as a form body, as the refresh example does, not only in the query string.
2. That a refresh with `client_id` and `client_secret` in the body succeeds (the example sends neither), and that a spent refresh token returns the `invalid_grant` body the troubleshooting page shows for a spent code. The page gives no HTTP status, so `400` is assumed from RFC 6749 section 5.2 (`invalid_grant` is treated as revoked with `400` or `401`; `invalid_client` and `invalid_request` are not).
3. The exact form of the granted `scope` in the token response when granular scopes are requested (space separated is assumed; the documented example says `read`).
4. That the space separated `scope` parameter on the authorize URL is how granular scopes are requested.
5. The sign of `account_balance` for a team with credit (negative is inferred from the documented sum).
6. That the billing period is the UTC calendar month, and that invoices are dated the 1st in UTC.
7. That the invoice list is newest first (StackDash sorts the first page itself, but reads only one page of 20).
8. That `GET /v2/actions` is newest first, and that deleting a Droplet records an action of type `destroy`.
9. Whether `actions:read` alone lists Droplet actions, or `droplet:read` is also needed.
10. Whether Billing Insights by `do:team:<uuid>` work for a team inside an organization, and which status a team without insights gets.
11. That `last_deployment_created_at` is present on every app that has deployed.
12. That a `SUPERSEDED` deployment that never went live has unfinished progress steps.
13. Whether revoking the access token also invalidates its refresh token, and the control panel path for removing an authorized app.
14. The control panel field names in Self-hosted registration.
15. Which team roles can read billing (a `403` is recorded as a `billing:read` gap either way).

## Sources

All checked 2026-11-05.

- [DigitalOcean OAuth API](https://docs.digitalocean.com/reference/api/oauth/)
- [I'm getting an error when using the DigitalOcean OAuth API](https://docs.digitalocean.com/support/im-getting-an-error-when-using-the-digitalocean-oauth-api./) (token error bodies)
- [Scopes for API tokens](https://docs.digitalocean.com/reference/api/scopes/)
- [DigitalOcean OpenAPI specification](https://github.com/digitalocean/openapi), commit `ace42c4`: `specification/resources/billing`, `actions`, `apps`, `droplets`, `account`, and `specification/description.yml` (rate limits, pagination)
- [Billing API reference](https://docs.digitalocean.com/reference/api/reference/billing/)
- [Billing Insights](https://docs.digitalocean.com/platform/billing/insights/)
- [Invoices](https://docs.digitalocean.com/platform/billing/invoices/)
- [Team roles and permissions: Authorized Applications](https://docs.digitalocean.com/platform/teams/roles/permissions/authorized_application/)
- [Simple Icons 16.36.0, DigitalOcean mark](https://simpleicons.org/?q=digitalocean) (brand color `#0080FF`, guidelines at https://www.digitalocean.com/press/)
