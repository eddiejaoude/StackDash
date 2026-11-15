# Vercel

Provider id: `vercel`. Verification: documentation only. Docs checked 2026-10-31.

StackDash reads your Vercel billing charges and deployments for one team or Hobby account. It installs as a Vercel Integration with four scopes, all at Read level, and billing is available on Pro and Enterprise teams only.

StackDash connects to Vercel through a **Vercel Integration** (a "connectable account" integration, external installation flow). The integration gets a long-lived access token for one Vercel scope (a team or a Hobby account), limited to the API scopes chosen in the Integrations Console. StackDash uses it to poll billing charges (FOCUS format) and deployments.

## Connection

### Flow summary

1. StackDash sends the browser to the install URL with a `state` value it stored server side.
2. The user signs in to Vercel, picks the scope (Hobby account or a team), picks **all projects** or **selected projects**, and reviews the requested permissions.
3. Vercel redirects to the integration's Redirect URL with `code`, `configurationId`, `teamId` (teams only), `next`, `state`, and `source`.
4. StackDash's callback checks `state`, then exchanges `code` server side for an access token.
5. StackDash stores the token, `installation_id` (same value as `configurationId`), `team_id`, and `user_id` against the workspace connection.

| Item | Value |
|---|---|
| Install (authorize) URL | `https://vercel.com/integrations/<slug>/new?state=<state>` (browser navigation). `<slug>` is the integration's URL Slug |
| Legacy OAuth entry point | `https://vercel.com/oauth/authorize?client_id=…&state=…`. Vercel tells integrations to replace it with the URL above, because only the external flow lets the user choose the scope. Do not use it |
| Token URL | `POST https://api.vercel.com/v2/oauth/access_token` |
| Token request body | `application/x-www-form-urlencoded`: `client_id`, `client_secret`, `code`, `redirect_uri` (the Redirect URL configured in the Integrations Console). All four required |
| Token response | `token_type` (`"Bearer"`), `access_token`, `installation_id` (`icfg_…`), `user_id`, `team_id` (null when installed on a Hobby account) |
| Authorization code | Valid 30 minutes, exchangeable once |
| Access token lifetime | Long-lived. The token exchange returns no `expires_in` and no `refresh_token` |
| Refresh | None. A Vercel staff answer on the community forum (2026-01-05) says the token "is long lived and doesn't need to be exchanged like a typical OAuth flow", modeled on GitHub Apps, and that reinstallation is needed only when permissions change |
| PKCE | Not supported for integrations. The token endpoint documents no `code_verifier` parameter. CSRF protection relies on `state` |
| API base URL | `https://api.vercel.com`, `Authorization: Bearer <access_token>` |
| Client id format | `oac_…` (documented examples) |

### Callback query parameters (external flow)

| Name | Meaning | Example (from documentation) |
|---|---|---|
| `code` | Authorization code to exchange | `jMIukZ1DBCKXHje3X14BCkU0` |
| `teamId` | Team id, only when a team was selected | `team_LLHUOMOoDlqOp8wPE4kFo9pE` |
| `configurationId` | Id of this installation ("configuration") | `icfg_6uKSUQ359QCbPfECTAY9murE` |
| `next` | Encoded URL to send the user to once setup on StackDash's side is done | `https%3A%2F%2Fvercel.com%2F…` |
| `state` | The value StackDash passed to `/new` | `xyzABC123` |
| `source` | Where the install started: `external`, `marketplace`, or `deploy-button` | `external` |

Rules for the callback:

- Reject a callback whose `state` is missing or does not match the stored value. Installs started from the Vercel side (`source=marketplace` or `deploy-button`) carry no StackDash state and cannot be tied to a workspace. The integration is unlisted (Community badge), so these should be rare.
- The installing user's scope is in `teamId` and again in the token response `team_id`. Prefer the token response and check the two match.
- `configurationId` and `installation_id` are the same `icfg_…` id. Vercel never reuses configuration ids, and a reinstall creates a new one.
- Vercel allows one installation per scope. If the integration is already installed in the chosen scope, Vercel reuses the existing configuration. Key the stored connection on `(configurationId)` and update it in place.
- The Redirect URL is opened in a popup during installation. If StackDash sets `Cross-Origin-Opener-Policy`, the callback route must send `unsafe-none` so the Vercel dashboard can watch the popup. Vercel's guidance is to finish by redirecting to `next`.

### Team context on every request

When `team_id` is not null, append `teamId=<team_id>` to every API call. A missing `teamId` is the most common cause of `403` for team installs.

### Disconnect, uninstall, and revocation

- **No token revocation endpoint is documented for integration tokens.** Uninstalling the integration is the only documented way to invalidate the token.
- `DELETE /v1/integrations/configuration/{id}` removes an installation and all its resources, but it needs the `integration-configuration` scope at **Read/Write**. StackDash does not request that scope, so it cannot uninstall itself.
- StackDash "disconnect" therefore means: delete the stored token, then tell the user to uninstall in Vercel (Dashboard, **Integrations**, **Manage** next to the integration, **Settings**, **Uninstall Integration**).
- A user can uninstall from Vercel at any time. Until StackDash receives Vercel webhooks (see [Webhooks](#webhooks)), it learns about it on the next poll when calls start failing. The exact status code after uninstall is not documented (see Unverified).
- **Disabled installations.** The token belongs to the developer who installed the integration. If that person leaves the team, the installation is disabled: API calls fail with `403` and `code: "integration_configuration_disabled"`. Team owners get 30 days to transfer ownership, then the installation is deleted. Treat this code as "needs reconnection" and show it to the user, never retry.

## Scopes requested

Vercel integration scopes are set once in the Integrations Console (not per authorize request). Each scope has a level of `None`, `Read`, or `Read/Write`. StackDash sets everything to `None` except:

| Scope | Level | Read-only | Why StackDash needs it | Read endpoints it unlocks |
|---|---|---|---|---|
| `billing` | Read | Yes | Usage and cost charges. **Only available to Pro and Enterprise teams** | `GET /v1/billing/charges`, `GET /v1/billing/contract-commitments` |
| `deployment` | Read | Yes | Deployment events for the timeline | `GET /v6/deployments` (listed by the scopes page; the reference documents `GET /v7/deployments`), `GET /v13/deployments/{idOrUrl}`, `GET /v2/deployments/{idOrUrl}/events`, `GET /v6/deployments/{id}/files`, `GET /v2/deployments/{id}/aliases` |
| `project` | Read | Yes | Project names and new project events | `GET /v9/projects` (scopes page; the reference documents `GET /v10/projects`), `GET /v9/projects/{idOrName}`, project domain reads |
| `team` | Read | Yes | Team name, slug, and plan (`billing.plan`) to know whether billing data exists | `GET /v2/teams/{teamId}`, `GET /v2/teams/{teamId}/members` |

`team` only offers Read. `billing` lists only Read endpoints in the scopes table. None of the four at Read level can create, change, or delete anything.

Scope changes after launch: adding or upgrading a scope sends every affected user and team owner an email and needs their confirmation. Removing or downgrading a scope applies immediately with no confirmation.

## Data collected

All calls are `GET` on `https://api.vercel.com` with `Authorization: Bearer <token>` and, for team installs, `teamId`. Every call needs a timeout.

### 1. Team and plan

`GET /v2/teams/{teamId}` (scope `team`)

| Field | Use |
|---|---|
| `id`, `slug`, `name` | Connection label |
| `billing.plan` | `hobby`, `pro`, or `enterprise` (nullable object). Skip billing calls when not `pro` or `enterprise` |
| `membership.role` | Role of the token's user on the team (`OWNER`, `MEMBER`, `DEVELOPER`, `SECURITY`, `BILLING`, `VIEWER`, `VIEWER_FOR_PLUS`, `CONTRIBUTOR`). See the role restriction on billing below |

For a Hobby install (`team_id` null) there is no team to read, and StackDash does not request the `user` scope. Label the connection from the token response.

### 2. Billing charges (FOCUS v1.3)

`GET /v1/billing/charges` (scope `billing`)

| Query param | Required | Meaning |
|---|---|---|
| `from` | Yes | Inclusive start, ISO 8601 date-time in UTC |
| `to` | Yes | Exclusive end, ISO 8601 date-time in UTC |
| `teamId` or `slug` | No | Team to read |

- Response: **`application/jsonl`**, one JSON object per line, streamed. Send `Accept-Encoding: gzip` for a compressed stream. Parse line by line; do not call `response.json()`.
- Granularity: **1 day**. Maximum range per request: **1 year**.
- Role restriction: "only available for Owner, Member, Developer, Security, Billing, and Enterprise Viewer roles". The token acts as the installing user, so an install by a Pro `VIEWER` or a `CONTRIBUTOR` gets `403` here even with the `billing` scope.
- Errors: `400` (bad query), `401`, `403`, `404`, `410`, `500`, `503`.

Row fields (required unless noted):

| Field | Type | Unit and meaning |
|---|---|---|
| `BilledCost` | number | Amount invoiced, in `BillingCurrency` major units (dollars, decimal) |
| `EffectiveCost` | number | Amortized cost after discounts and commitment credits, in `BillingCurrency` |
| `BillingCurrency` | string | ISO 4217. The schema enum is `USD` only |
| `PricingCurrency` | string | Enum `USD` |
| `ChargeCategory` | string | `Usage`, `Purchase`, `Tax`, `Credit`, `Adjustment` |
| `ChargePeriodStart` | string | Inclusive start of the charge period, ISO 8601 UTC |
| `ChargePeriodEnd` | string | Exclusive end of the charge period, ISO 8601 UTC |
| `ConsumedQuantity` | number, nullable | Amount of the resource consumed |
| `ConsumedUnit` | string, nullable | Unit of `ConsumedQuantity` (free text; not enumerated) |
| `PricingQuantity` | number | Quantity priced |
| `PricingUnit` | string | Unit of `PricingQuantity` |
| `PricingCategory` | string | `Standard`, `Committed`, `Dynamic`, `Other` |
| `ServiceName` | string | Product display name |
| `ServiceCategory` | string, optional | FOCUS category, for example `Compute`, `Networking`, `Storage`, `AI and Machine Learning` |
| `ServiceProviderName` | string | Seller of the service |
| `SkuId` | string | Stable product id. For unmapped items it is derived from the item identifier |
| `RegionId`, `RegionName` | string, optional | Region |
| `Tags` | object of strings | Charge metadata "including the Vercel ProjectId and ProjectName". Exact key names are not documented |

Mapping to StackDash's money rules:

- Convert `BilledCost` and `EffectiveCost` to integer minor units (cents) for `USD` only after aggregating; never store the float. The values can carry more than two decimal places for small usage lines (not confirmed, see Unverified). Recommended: parse each amount from the raw JSON text as a decimal string, sum per `(day, SkuId, currency)` in an integer at a fixed finer precision, and round to cents once at the end.
- Reject (and log) any row whose `BillingCurrency` is not `USD` rather than assuming dollars. Never sum across currencies.
- Group by `ChargePeriodStart` (UTC day) and `ServiceName` or `SkuId` for the dashboard. `Credit` and `Adjustment` rows can be negative [inference from FOCUS semantics, not stated by Vercel].

Freshness: not documented. Poll a trailing window (for example the last 3 UTC days) on each sync and replace those days, so late rows and corrections are picked up. Today's day is partial.

### 3. Contract commitments

`GET /v1/billing/contract-commitments` (scope `billing`). Query: `teamId` or `slug` only. JSONL, FOCUS v1.3.

- Vercel says the endpoint "is only applicable to Enterprise Vercel customers. An empty response is returned for non-Enterprise (Pro/Flex) customers." The schema description also mentions "Pro: $20 monthly spend commitment". The two statements conflict; treat Pro as empty until tested.
- Fields: `BillingCurrency`, `ContractCommitmentCategory` (`Spend` or `Usage`), `ContractCommitmentCost` (number, in `BillingCurrency`, required when category is `Spend`), `ContractCommitmentQuantity`, `ContractCommitmentUnit`, `ContractCommitmentId`, `ContractCommitmentType`, `ContractCommitmentDescription`, `ContractCommitmentPeriodStart`/`End`, `ContractId`, `ContractPeriodStart`/`End`.
- Optional for the MVP. Useful later for "commitment used so far" on Enterprise.

### 4. Deployments

`GET /v7/deployments` (scope `deployment`)

| Query param | Meaning |
|---|---|
| `since` | Deployments created after this Unix time in **milliseconds** |
| `until` | Deployments created before this Unix time in milliseconds |
| `limit` | Page size (maximum not documented) |
| `projectId` / `projectIds` | Filter by project (mutually exclusive) |
| `target` | Environment filter, for example `production` |
| `state` | `BUILDING`, `ERROR`, `INITIALIZING`, `QUEUED`, `READY`, `CANCELED`, `BLOCKED` |
| `branch`, `sha`, `users`, `app`, `rollbackCandidate` | Other filters |
| `from`, `to` | Deprecated in the OpenAPI spec. Use `since` and `until` |
| `teamId` or `slug` | Team to read |

Response: `{ deployments: [...], pagination: { count, next, prev } }`. `pagination.next` is a millisecond timestamp ("must be used to request the next page"), null on the last page. Pass it as `until` for the next page [inference from the field descriptions].

Fields StackDash keeps (required in schema unless noted):

| Field | Meaning |
|---|---|
| `uid` | Deployment id, `dpl_…` |
| `name` | Project name used in the deployment URL |
| `projectId` | Project id |
| `readyState` | `BLOCKED`, `BUILDING`, `CANCELED`, `DELETED`, `ERROR`, `INITIALIZING`, `QUEUED`, `READY` |
| `readySubstate` (optional) | `STAGED`, `ROLLING`, `PROMOTED` when `READY` (`PROMOTED` means it has served production traffic) |
| `target` (optional, nullable) | `production`, `staging`, or null (preview) |
| `created`, `createdAt` | Creation time, Unix milliseconds |
| `buildingAt`, `ready` (optional) | Build start and ready times, Unix milliseconds. Build duration is `ready - buildingAt` |
| `errorCode`, `errorMessage` (optional) | Failure details |
| `source` (optional) | `git`, `cli`, `redeploy`, `import`, `v0-web`, and others |
| `url` | Deployment hostname. Null while the upload is incomplete, even though the schema marks it required |
| `inspectorUrl` | Link to the deployment in the Vercel dashboard (nullable) |

Fields to drop at the boundary: `creator.email`, `creator.username`, `creator.githubLogin`, `creator.gitlabLogin`, `meta` (Git metadata such as commit messages), `projectSettings`. They are personal or potentially sensitive and the timeline does not need them.

Freshness: live API data. Poll with `since` set to the last seen `created` minus a small overlap, and upsert on `uid`, because a deployment changes state after creation.

### 5. Projects

`GET /v10/projects` (scope `project`). Query: `since`, `until` (updated time, ms), `from` (continuation), `limit`, `search`, `teamId`. The body is either an array or `{ projects, pagination }`, so parse both shapes.

Use only the list endpoint. `GET /v9/projects/{idOrName}` returns an `env` array of environment variable records (`key`, `value`, `decrypted`, `target`, and more). StackDash must never call it (see Permission risks).

## Achievements

StackDash evaluates these for each project the Vercel accounts are assigned to, from the Vercel data it has stored, after each sync (see [Achievements](../adapters.md#achievements)). A project earns each one once, and it stays private until an owner or admin publishes it.

The deployment ladder is the same on Railway, DigitalOcean, and GitLab. It counts `vercel.deployment.succeeded` events, and a `vercel.deployment.failed` event breaks a run of deployments in a row. Days, hours, and weekdays are London time.

| Id | Title | How it is earned |
|---|---|---|
| `vercel.deployments.first` | First Vercel deployment recorded | Earned when StackDash records the first successful Vercel deployment. |
| `vercel.deployments.10` | 10 Vercel deployments recorded | Earned when StackDash records the 10th successful Vercel deployment. |
| `vercel.deployments.100` | 100 Vercel deployments recorded | Earned when StackDash records the 100th successful Vercel deployment. |
| `vercel.deployments.streak_10` | 10 Vercel deployments in a row | Earned when StackDash records 10 successful Vercel deployments in a row, with no failed deployment between them. |
| `vercel.deployments.night_owl` | Night owl: a Vercel deployment between midnight and 5 am | Earned when StackDash records a successful Vercel deployment between midnight and 5 am London time. |
| `vercel.deployments.friday_ship` | Shipped on a Friday afternoon | Earned when StackDash records a successful Vercel deployment on a Friday between 4 pm and midnight London time. |
| `vercel.deployments.busy_day` | Busy day: 10 Vercel deployments in one day | Earned when StackDash records 10 successful Vercel deployments on one London calendar day. |
| `vercel.deployments.weekly_rhythm` | Weekly rhythm: a Vercel deployment on 7 days in a row | Earned when StackDash records a successful Vercel deployment on each of 7 consecutive London calendar days. |

## Verified vs estimated vs unavailable

| Metric | Status | Notes |
|---|---|---|
| Daily charges per service and SKU (`BilledCost`) | Verified | Provider-reported, USD, 1 day granularity. Days in an open billing period can still change |
| Daily effective cost (`EffectiveCost`) | Verified | Provider-reported amortized cost |
| Usage quantities (`ConsumedQuantity` + `ConsumedUnit`) | Verified | Units are free text per row; show as given |
| Month-to-date spend | Verified | Sum of daily `BilledCost` rows in the period, computed by StackDash from provider values |
| Projected month-end spend | Estimated | Linear projection by StackDash. Label it estimated |
| Spend per project | Verified when `Tags` carries the project | Rows without project tags stay team-level |
| Deployment counts, failures, build duration | Verified | From deployment timestamps and states |
| Enterprise commitment allocation | Verified (Enterprise only) | `GET /v1/billing/contract-commitments` |
| Hobby plan usage against free limits | Unavailable | Billing scope is Pro and Enterprise only |
| Included allowance remaining, spend limits and budgets, invoices | Unavailable | No endpoint in the integration scopes table |
| Real-time spend | Unavailable | Daily granularity only |

## Rate limits

From the Limits page (per minute unless noted; scope `user` means per Vercel user, so all of one installer's connections share it):

| Limit name | Limit | Window | Scope | Applies to |
|---|---|---|---|---|
| `api-deployments-get` | 500 | 60 s | user | Listing and reading deployments |
| `api-deployments-get-enterprise` | 2000 | 60 s | user | Same, Enterprise |
| `api-teams-get` | 600 | 60 s | user | `GET /v2/teams/{teamId}` |
| `api-integrations-configuration-get` | 120 | 60 s | user | Reading one integration configuration |

- No limit is listed for `GET /v1/billing/charges` or `GET /v10/projects`. Assume one is enforced.
- Limits are per endpoint: hitting one does not block others.
- On a limit, the API returns `429` with `{ "error": { "code": "rate_limited", "message", "limit": { "remaining", "reset", "resetMs", "total" } } }`. `reset` is Unix seconds, `resetMs` Unix milliseconds. Back off until `resetMs`.
- `X-RateLimit-*` response headers are documented only for the analytics API, not for the general REST API.

A sync of one connection every few minutes is far below these limits.

## Plan restrictions

| Vercel plan | Billing charges | Contract commitments | Deployments and projects |
|---|---|---|---|
| Hobby | Not available (`billing` scope is Pro and Enterprise only) | Not available | Available |
| Pro | Available, subject to the installer's role | Empty (per endpoint description) | Available |
| Enterprise | Available, subject to the installer's role | Available | Available |

The connection flow should read `billing.plan` after install and tell Hobby users plainly that cost data is not available from Vercel for their plan, while deployments still work.

## Webhooks

Not received yet; planned, through the shared webhook route (see [Webhooks](../adapters.md#webhooks)), with polling kept as the backfill. They need no extra access. Notes:

- One Webhook URL per integration, set in the Integrations Console, with event checkboxes. Integration events include `deployment.created`, `deployment.error`, `deployment.canceled`, `deployment.succeeded`, `deployment.ready`, `project.created`, `project.removed`, `integration-configuration.removed`, `integration-configuration.permission-upgraded`, `integration-configuration.scope-change-confirmed`, `integration-configuration.transferred`, `domain.created`.
- Envelope: `{ type, id, createdAt, region, payload }`. Deployment payloads carry `payload.team.id`, `payload.user.id`, `payload.deployment.{id,url,name,meta}`, `payload.links.{deployment,project}`, `payload.target`, `payload.project.id`, `payload.plan`, `payload.regions`.
- Signature: header `x-vercel-signature` is the **hex HMAC-SHA1** of the raw request body, keyed with the integration's Client Secret. Compare in constant time. Rotating the client secret in the console changes the webhook key too.
- Delivery: 30 second timeout; non-2xx responses are retried with exponential backoff for up to 24 hours, then dropped.
- `integration-configuration.removed` would replace failure-based uninstall detection. Disabled installations still receive `project.created`, `project.removed`, and `integration-configuration.removed`.

## Interesting timeline events

From polling:

- Production deployment went live (`target = production`, `readyState = READY`, ideally `readySubstate = PROMOTED`).
- Deployment failed (`readyState = ERROR`, with `errorCode`), or was canceled (`CANCELED`).
- First deployment of the day, or a streak of deployments [derived].
- Slow build: `ready - buildingAt` well above the project's usual time [derived].
- New project created (project list `createdAt`, via scope `project`).
- Daily spend jumped compared with the trailing average, or a new SKU appeared in charges [derived].

Webhook-only (see [Webhooks](#webhooks)): instant rollback (`deployment.rollback`), promotion (`deployment.promoted`), domain events.

## Permission risks

Disclose these in the connection flow before redirecting:

- **Deployment read is broad.** Vercel describes it as retrieving deployments "including build logs, a list of files and builds, and the file structure for a specific deployment". The token can list deployed files and read build logs, which can include secrets that leak into logs. StackDash calls only the list endpoint.
- **Project read exposes environment variable records.** `GET /v9/projects/{idOrName}` is in the `project` Read scope and its response includes an `env` array with `key`, `value`, and a `decrypted` flag. Whether values come back decrypted for an integration token is not documented. StackDash must never call that endpoint, and a code review rule should enforce it.
- **Team read includes member listing** (`GET /v2/teams/{teamId}/members`), so names and emails of teammates are reachable. StackDash does not call it.
- **Billing read** covers all charges for the team, every project included, regardless of which projects the user selected at install [inference: the endpoint is team-scoped and takes no project filter].
- The token is long-lived with no expiry and no refresh. A leaked token works until the user uninstalls. Encrypt it at rest and never send it to the browser (Vercel also warns to call the API server side only).
- The token acts as the installing developer. If that person's role changes, data access changes with it, and if they leave the team, the installation is disabled.
- `project` and `team` could be dropped to narrow access: deployment rows already carry `name` and `projectId`, and charge `Tags` carry project names. Keep them only if the plan check and new project events are wanted. Removing a scope later applies without user confirmation; adding one later needs every user to confirm.

## API limitations

- No refresh, no expiry, no revoke endpoint for integration tokens. Uninstall is the only revocation.
- No PKCE.
- Billing is daily only, USD only (per schema), up to 1 year per request, and JSONL rather than JSON.
- No billing data for Hobby, and none for roles outside Owner, Member, Developer, Security, Billing, and Enterprise Viewer.
- Billing data freshness is undocumented.
- Endpoint version drift: the scopes page lists `/v6/deployments` and `/v9/projects`; the current reference documents `/v7/deployments` and `/v10/projects`. Use the reference versions and confirm the scope covers them in testing.
- `GET /v7/deployments` `url` can be null for incomplete uploads even though the schema marks it required. Model it as nullable.
- The integration's Redirect URL is a single field, so one integration serves one StackDash origin. Local development needs its own integration (localhost redirect URLs are allowed) [inference].
- Unlisted integrations carry a **Community** badge. Listing on the public marketplace needs at least 500 active installations and a review. StackDash does not need listing: installs work through the `/new` link.

## Self-hosted registration steps

Every StackDash deployment registers its own Vercel integration, because the client secret and Redirect URL belong to one deployment.

1. In the Vercel dashboard, pick the team that will own the integration, open **Integrations**, then **Integrations Console**, then **Create**.
2. Fill in the required profile fields: **Name** (max 64 characters), **URL Slug** (max 32), **Developer**, **Contact email**, **Support contact email** (public), **Short Description** (max 40), **Logo** (square PNG, at least 256 px, not transparent), **Category** (for example Dev Tools), **Website**, **Documentation URL**, **EULA URL**, **Privacy Policy URL**, **Support URL**, **Overview** (max 768), and at least one **Feature media** image (16:9, 1920x1080 PNG).
3. **Redirect URL**: `<SITE_URL>/api/connections/vercel/callback`, where `<SITE_URL>` is the public origin of the StackDash deployment (for local development use `http://localhost:3000/api/connections/vercel/callback` in a separate integration).
4. **API Scopes**: set `billing` to Read, `deployment` to Read, `project` to Read, `team` to Read, everything else to None.
5. Leave **Webhook URL** and **Configuration URL** empty. The webhook URL is set once StackDash receives Vercel webhooks (see [Webhooks](#webhooks)).
6. Accept the Vercel Integrations Marketplace Agreement and submit.
7. Copy the client (integration) id and the client secret from the **Credentials** section at the bottom of the integration settings. **Rotate Secret** is available there.
8. Set the environment variables:

| Variable | Value | Notes |
|---|---|---|
| `VERCEL_CLIENT_ID` | Integration client id (`oac_…`) | Server only |
| `VERCEL_CLIENT_SECRET` | Integration client secret | Server only. Also the webhook signing key later |
| `VERCEL_INTEGRATION_SLUG` | The URL Slug from step 2 | Needed to build `https://vercel.com/integrations/<slug>/new` |

The Redirect URL used in the token exchange must equal the one in the console, so derive it from `SITE_URL` the same way in both places.

## Sample responses

All samples below are **from documentation, not recorded**. Ids are the documentation's synthetic values; tokens are shown as placeholders. Arrays are trimmed.

Token exchange, `POST /v2/oauth/access_token`:

```json
{
  "token_type": "Bearer",
  "access_token": "<access-token>",
  "installation_id": "icfg_ijgU3GzRxyz7nGpwwsSmbNkI",
  "user_id": "2tUzTmv4ljvFVHifEf9TGdpH",
  "team_id": null
}
```

One JSONL line from `GET /v1/billing/charges`. The documentation example renders numbers as strings and uses placeholders; the schema types `BilledCost`, `EffectiveCost`, and the quantities as numbers, and `Tags` as an object of strings:

```json
{
  "BilledCost": "123",
  "BillingCurrency": "USD",
  "ChargeCategory": "Adjustment",
  "ChargePeriodEnd": "string",
  "ChargePeriodStart": "string",
  "ConsumedQuantity": "1",
  "ConsumedUnit": "units",
  "EffectiveCost": "123",
  "PricingCategory": "Committed",
  "PricingCurrency": "USD",
  "PricingQuantity": "1",
  "PricingUnit": "units",
  "RegionId": "example_id",
  "RegionName": "Example Name",
  "ServiceCategory": "AI and Machine Learning",
  "ServiceName": "Example Name",
  "ServiceProviderName": "Example Name",
  "SkuId": "example_id",
  "Tags": "value"
}
```

`GET /v7/deployments`, trimmed to the fields StackDash keeps (documentation example, numeric fields shown as strings there):

```json
{
  "deployments": [
    {
      "uid": "dpl_2euZBFqxYdDMDG1jTrHFnNZ2eUVa",
      "name": "docs",
      "projectId": "example_id",
      "url": "docs-9jaeg38me.vercel.app",
      "inspectorUrl": "https://vercel.com/acme/nextjs/J1hXN00qjUeoYfpEEf7dnDtpSiVq",
      "created": "1609492210000",
      "createdAt": "123",
      "buildingAt": "1609492210000",
      "ready": "1609492210000",
      "readyState": "BLOCKED",
      "readySubstate": "PROMOTED",
      "state": "READY",
      "target": "production",
      "source": "cli",
      "type": "LAMBDAS",
      "errorCode": "BUILD_FAILED",
      "errorMessage": "The Deployment has been canceled because this project was not affected"
    }
  ],
  "pagination": {
    "count": "20",
    "next": "1540095775951",
    "prev": "1540095775951"
  }
}
```

`GET /v2/teams/{teamId}`, trimmed:

```json
{
  "id": "team_nllPyCtREAqxxdyFKbbMDlxd",
  "slug": "my-team",
  "name": "My Team",
  "billing": { "plan": "enterprise" },
  "membership": { "role": "BILLING" }
}
```

Rate limit error body (from the REST API errors page):

```json
{
  "error": {
    "code": "rate_limited",
    "message": "The rate limit of 6 exceeded for 'api-www-user-update-username'. Try again in 7 days",
    "limit": {
      "remaining": 0,
      "reset": 1571432075,
      "resetMs": 1571432075563,
      "total": 6
    }
  }
}
```

Fixtures for tests must be recorded from a real Pro test team and sanitized; these documentation samples are not realistic enough to stand in for them.

## Unverified

Could not be confirmed from documentation on 2026-10-31. Check each with a test install before building on it:

- Whether the external installation flow also runs in a popup, and whether redirecting to `next` or straight to StackDash gives the better result.
- The status code and error body returned for a token whose installation was uninstalled (as opposed to disabled).
- Whether any endpoint can revoke an integration token. `DELETE /v3/user/tokens/{tokenId}` exists for user tokens; its use with integration tokens is not documented.
- Whether installing with the `billing` scope on a Hobby account succeeds (with billing calls failing), or is blocked.
- Whether `team_id` is always null for Hobby installs now that Vercel calls them "Hobby teams" in places.
- Billing data freshness, and how long a past day can still change.
- Decimal precision of `BilledCost` and `EffectiveCost` (sub-cent values or not), and whether they arrive as JSON numbers or strings in practice.
- Exact key names inside `Tags` for the project id and name.
- Whether `GET /v1/billing/contract-commitments` returns the $20 Pro commitment or an empty body for Pro.
- Rate limits for `GET /v1/billing/charges` and `GET /v10/projects`.
- Maximum `limit` for `GET /v7/deployments`, and that `pagination.next` is meant to be passed as `until`.
- Whether the `deployment` and `project` Read scopes, documented against `/v6/deployments` and `/v9/projects`, also authorize `/v7/deployments` and `/v10/projects`.
- Whether deployment and project listing is restricted to the projects selected at install, and whether billing charges are (presumed not).
- Whether `GET /v9/projects/{idOrName}` returns decrypted environment variable values to an integration token.
- Whether a newly created Community integration needs a Vercel review before users outside the owning team can install it.
- Whether the installation deep link `https://vercel.com/d/dashboard/integrations/{slug}/{installationId}` (documented for native integrations) also works for connectable account integrations, which would make a better "uninstall in Vercel" link.

## Alternative considered: Sign in with Vercel

Sign in with Vercel apps use a standard OAuth flow (`https://vercel.com/oauth/authorize`, token at `https://api.vercel.com/login/oauth/token`, revoke at `https://api.vercel.com/login/oauth/token/revoke`), with required PKCE (`S256`), 1 hour access tokens, refresh tokens via `offline_access`, and finer permissions such as Billing (Read Only), Deployments (Read Only), and Activity Events (Read Only). It would be the narrower and safer option, but Vercel states that "permissions for issuing API requests and interacting with team resources are currently in private beta". Not usable for the MVP; revisit when it is generally available.

## Sources

All checked 2026-10-31.

- [Building Integrations with Vercel REST API](https://vercel.com/docs/integrations/create-integration/vercel-api-integrations): token exchange, response, scopes table, disabled configurations, scope changes. Checked 2026-10-31.
- [Requirements for listing an Integration](https://vercel.com/docs/integrations/create-integration/submit-integration): Redirect URL, API scopes, webhook events, external installation flow and callback parameters, single installation per scope. Checked 2026-10-31.
- [Create an Integration](https://vercel.com/docs/integrations/create-integration): console steps, credentials and secret rotation, Community badge, listing requirements. Checked 2026-10-31.
- [Upgrade an Integration](https://vercel.com/docs/integrations/create-integration/upgrade-integration): `/integrations/:slug/new` replaces `/oauth/authorize`. Checked 2026-10-31.
- [Permissions and Access](https://vercel.com/docs/integrations/install-an-integration/manage-integrations-reference): permission descriptions, disabled integrations. Checked 2026-10-31.
- [Add a Connectable Account](https://vercel.com/docs/integrations/install-an-integration/add-a-connectable-account): install and uninstall steps. Checked 2026-10-31.
- [Using the Integrations REST API](https://vercel.com/docs/integrations/create-integration/marketplace-api): installation deep links. Checked 2026-10-31.
- [List FOCUS billing charges](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges). Checked 2026-10-31.
- [List FOCUS contract commitments](https://vercel.com/docs/rest-api/billing/list-focus-contract-commitments). Checked 2026-10-31.
- [Changelog: Access billing usage and cost data via API (2026-02-19)](https://vercel.com/changelog/access-billing-usage-cost-data-api). Checked 2026-10-31.
- [vercel usage CLI](https://vercel.com/docs/cli/usage): role restriction, units. Checked 2026-10-31.
- [List deployments](https://vercel.com/docs/rest-api/deployments/list-deployments). Checked 2026-10-31.
- [Retrieve a list of projects](https://vercel.com/docs/rest-api/projects/retrieve-a-list-of-projects). Checked 2026-10-31.
- [Get a Team](https://vercel.com/docs/rest-api/teams/get-a-team). Checked 2026-10-31.
- [Retrieve an integration configuration](https://vercel.com/docs/rest-api/integrations/retrieve-an-integration-configuration) and [Delete an integration configuration](https://vercel.com/docs/rest-api/integrations/delete-an-integration-configuration). Checked 2026-10-31.
- [OpenAPI spec](https://vercel.com/openapi.json): deprecated `from`/`to` on deployments, `env` on project detail. Checked 2026-10-31.
- [Limits: rate limits](https://vercel.com/docs/limits#rate-limits). Checked 2026-10-31.
- [REST API errors](https://vercel.com/docs/rest-api/errors). Checked 2026-10-31.
- [Make your first Vercel API request](https://vercel.com/docs/rest-api/getting-started): `teamId`, `401`/`403`/`429` handling. Checked 2026-10-31.
- [Webhooks API reference](https://vercel.com/docs/webhooks/webhooks-api): payloads, `x-vercel-signature`, retries. Checked 2026-10-31.
- [Sign in with Vercel: Authorization Server API](https://vercel.com/docs/sign-in-with-vercel/authorization-server-api) and [Scopes and Permissions](https://vercel.com/docs/sign-in-with-vercel/scopes-and-permissions). Checked 2026-10-31.
- [Vercel Community: Integration installation access token (2026-01-05)](https://community.vercel.com/t/integration-installation-access-token/30847): token lifetime answer from Vercel staff. Checked 2026-10-31.

## Go or no-go for the MVP

**Go.** Every piece StackDash needs is documented and reachable with read-only scopes from a self-serve integration: daily charges in FOCUS format with explicit currency and periods, deployments with clear states for the timeline, and the plan from the team record. The token never expires, so there is no refresh logic to get wrong. The costs are known and manageable: billing works only for Pro and Enterprise teams and for installers with an eligible role (the flow must say so), the `deployment` and `project` read scopes reach more than StackDash uses (disclose it, and never call the build log, file, or project detail endpoints), and freshness, precision, and uninstall behavior must be confirmed with a Pro test team before fixtures are recorded.
