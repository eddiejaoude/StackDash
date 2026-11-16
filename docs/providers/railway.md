# Railway

Provider id: `railway`. Verification: documentation only. Docs checked 2026-11-05.

StackDash reads the Railway workspaces you pick, their projects and deployments, and their billing when Railway allows it. It asks for viewer access to those workspaces and your Railway sign-in.

## Go or no-go

**Go, built against the documentation only.** "Login with Railway" is a standard OAuth 2.0 authorization code flow with PKCE and OpenID Connect, and the Public API is the same GraphQL API the Railway dashboard uses. A `workspace:viewer` grant lists the workspaces the user picks, their projects, and every deployment with its status, which covers the deployment events on the timeline. Billing is the open question: Railway's dashboard limits billing settings to workspace admins, and whether a viewer token can read the billing fields is not documented. The adapter therefore treats billing as optional: when Railway refuses it with `Not Authorized`, deployments still sync and billing shows as unavailable. Any other billing failure, such as an unexpected shape, fails the sync, so it is retried and recorded instead of being mistaken for a permission gap.

No Railway account has been used yet. Every claim below comes from Railway's documentation or its public GraphQL schema, and everything a real account still has to confirm is listed under [Unverified](#unverified).

## Connection

OAuth 2.0 authorization code flow with PKCE (`S256`), as a **Web (confidential)** app with `client_secret_basic`. Railway recommends PKCE for web apps too, so StackDash always sends it.

| Item | Value |
|---|---|
| Discovery document | `https://backboard.railway.com/.well-known/openid-configuration` |
| Issuer | `https://backboard.railway.com` |
| Authorize URL | `GET https://backboard.railway.com/oauth/auth` (browser navigation, never fetched server side) |
| Token URL | `POST https://backboard.railway.com/oauth/token` |
| Revoke URL | None. The discovery document lists no revocation endpoint |
| API URL | `POST https://backboard.railway.com/graphql/v2` (GraphQL) |
| Scopes StackDash requests | `openid email profile offline_access workspace:viewer` |
| Access token | Opaque, `expires_in: 3600` (one hour) |
| Refresh token | Only with `offline_access` and `prompt=consent`. Rotates; a new one lives one year from issue |
| ID token | JWT (`ES256`). Returned and ignored: StackDash never reads identity claims |
| Client secret | Shown once when the app is created |

### Authorize request

Query parameters: `response_type=code`, `client_id`, `redirect_uri` (exact match with a registered URI, including scheme, host, port, and path), `scope` (space separated, `openid` required), `state` (StackDash caps it at 1024 characters), `code_challenge`, `code_challenge_method=S256`, and `prompt=consent`.

`prompt=consent` is required, not cosmetic: without it a returning user can skip the consent screen through automatic approval, and then Railway issues no refresh token. It also lets the user change which workspaces they share every time they connect.

On the consent screen the user picks **which workspaces** the app can see. One StackDash connection covers the workspaces picked; each one becomes an account on the connection.

The discovery document advertises `authorization_response_iss_parameter_supported: true`, and the documented callback carries `iss=https://backboard.railway.com`. Following [RFC 9207, section 2.4](https://www.rfc-editor.org/rfc/rfc9207#section-2.4), StackDash rejects a callback whose `iss` is missing or anything else, before calling the token endpoint. A denied request comes back with an `error` parameter instead of a code.

### Token exchange

Form encoded, client authenticated with HTTP Basic (`client_id:client_secret`). Body: `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`. The code is short lived and single use. The response holds `access_token`, `expires_in`, `id_token`, `refresh_token`, `scope`, and `token_type: "Bearer"`. StackDash refuses a response without a refresh token, because the connection would stop working after an hour.

### Refresh and rotation

Body: `grant_type=refresh_token`, `refresh_token`, with the same Basic client authentication. The response carries a `refresh_token` that "may initially contain the same value, but will eventually return a new token". Always store the one from the latest response: **using an old, rotated refresh token fails and the user has to authorize again**. Each user authorization keeps at most 100 refresh tokens; the oldest are revoked automatically past that.

StackDash refreshes through `refreshIfExpiring` in `src/lib/connections/credential-refresh.ts`: a token within 5 minutes of expiry is refreshed, the rotated credential is saved before anything uses it, and every refresh of one connection (a sync, automatic webhook setup, removal on disconnect) runs under the connection's refresh lock, so two refreshes never spend the same refresh token. `invalid_grant` on refresh is reported as auth revoked, so the connection asks for a reconnect instead of retrying.

### Disconnect

- From StackDash: there is no revocation endpoint, so StackDash deletes the stored tokens and tells the user to remove its access in Railway.
- From Railway: where a user reviews and removes an authorized app is not documented (see Unverified). The disconnect screen gives the generic step: remove StackDash's access in your Railway account settings.
- An app deleted or a grant removed in Railway makes the next token refresh or API call fail, and the connection asks for a reconnect.

### API calls

Every request is a `POST` to `/graphql/v2` with `Authorization: Bearer <access token>` and a JSON body `{ query, variables }`. GraphQL can carry mutations over the same endpoint, so the adapter sends only four fixed read queries and changes nothing but their variables.

Railway follows the GraphQL error convention: **a denied query answers HTTP 200** with an `errors` entry whose message is `Not Authorized` (code `INTERNAL_SERVER_ERROR`). HTTP 400 is a malformed or invalid query, HTTP 429 a rate limit. The adapter maps `Not Authorized` to a missing permission, any other GraphQL error to an invalid response, and never copies Railway's error messages into its own, because they can echo arguments.

## Scopes

All requested scopes are read only. Railway scopes cap the access level: a `workspace:viewer` grant never acts with more than viewer access, even for a workspace admin.

| Scope | Why |
|---|---|
| `openid` | Required by Railway for every request |
| `email` | Required by Railway, with `profile`, before `me { workspaces }` lists the shared workspaces. StackDash never calls `/oauth/me` and never selects `email` |
| `profile` | Same requirement as `email`. StackDash never selects `name` or `avatar` |
| `offline_access` | Refresh tokens, so hourly syncs keep working after the one hour access token expires |
| `workspace:viewer` | Viewer access to the workspaces the user picks: projects, deployments, usage, and billing where viewer access allows it |

Railway documents `email profile` as required for listing workspaces, so the request adds them to `openid offline_access workspace:viewer`.

Not requested: `workspace:member` and `workspace:admin` (they can deploy, change variables, and delete services), `project:viewer` and `project:member` (they cover single projects, not workspace billing), `notifications`, and `ssh_keys`. Every event type below is readable with `workspace:viewer`, so none was left out for needing a write scope.

## Data

### Workspaces: `me { workspaces { id name } }`

Only the workspaces picked on the consent screen. Each becomes an external account with kind `workspace`, keyed by its id; a blank name shows as "Railway workspace".

### Projects: `workspace(workspaceId) { projects(first: 50) { ... } }`

`id` and `name` per project. At most 50 projects per workspace per sync; a larger workspace logs `railway.projects.cap_reached` and the rest are skipped until a later version pages through them.

### Deployments: `deployments(first: 50, after, input: { projectId, includeDeleted: true })`

The documented list query, one aliased field per project (`d0`, `d1`, ...), ten projects per request. Fields read: `id`, `status`, `createdAt`, `updatedAt`, `statusUpdatedAt`, `canRollback`, `service { name }`, `environment { name }`, and `pageInfo { hasNextPage endCursor }`. Never selected: `creator` (name, email, avatar), `meta` (commit details), logs, variables, and URLs.

Each project's deployment history is read newest first, 50 at a time, following `endCursor` until a page reaches a deployment created before the sync window, so every deployment created in the window is read however many there are, up to five pages (250) per project per sync. The order is newest first, inferred from the documented "Get latest active deployment" example, which reads `first: 1`. `includeDeleted: true` asks for removed deployments too, so a deployment replaced between two polls is still listed (whether the default leaves them out is unverified). Project-level and service-level `deployments` fields are deprecated in the schema "for properly scoped access control", so the adapter uses the root query.

Railway keeps no status history per deployment that the adapter can use. `Deployment` carries only its current `status`, `statusUpdatedAt` (when it entered that status), `createdAt`, and `updatedAt` (schema introspected 2026-11-05). The two other places that look like history do not fit: `deploymentEvents(id)` returns build and deploy steps (`DeploymentEventStep`: `SNAPSHOT_CODE`, `BUILD_IMAGE`, `HEALTHCHECK`, `DRAIN_INSTANCES`, and others) rather than statuses, needs one field per deployment, and is not in Railway's documentation; `events(projectId)` is the project activity feed with an untyped `JSON` payload, also undocumented. So a success is dated only while the deployment is still `SUCCESS`. A removed deployment that Railway can still roll back to (`canRollback: true`) had deployed successfully: rollback restores "the previously successful deployment" and is offered on removed deployments within the plan's image retention, at least 24 hours ([Deployment actions](https://docs.railway.com/deployments/deployment-actions#rollback), [image retention](https://docs.railway.com/pricing/plans#image-retention-policy)). The adapter uses that to keep replaced deployments on the timeline, see Timeline events.

Statuses in the schema (checked 2026-11-05): `BUILDING`, `CRASHED`, `DEPLOYING`, `FAILED`, `INITIALIZING`, `NEEDS_APPROVAL`, `QUEUED`, `REMOVED`, `REMOVING`, `SKIPPED`, `SLEEPING`, `SUCCESS`, `WAITING`. A status outside this list fails the parse instead of being guessed at.

### Billing: one query per workspace

```graphql
query StackDashBilling($workspaceId: String!, $measurements: [MetricMeasurement!]!) {
  workspace(workspaceId: $workspaceId) {
    plan
    customer { billingPeriod { start end } currentUsage creditBalance }
  }
  usage(workspaceId: $workspaceId, measurements: $measurements, includeDeleted: true) { measurement value }
  estimatedUsage(workspaceId: $workspaceId, measurements: $measurements, includeDeleted: true) {
    measurement estimatedValue projectId
  }
}
```

Measurements: `CPU_USAGE`, `MEMORY_USAGE_GB`, `NETWORK_TX_GB`, `DISK_USAGE_GB`. `includeDeleted: true` keeps projects deleted during the period that still bill.

| Metric key | Kind | Source |
|---|---|---|
| `railway.usage.cpu` | usage, vCPU-minutes, billing period | `usage`, `CPU_USAGE` |
| `railway.usage.memory` | usage, GB-minutes, billing period | `usage`, `MEMORY_USAGE_GB` |
| `railway.usage.network_egress` | usage, GB, billing period | `usage`, `NETWORK_TX_GB` |
| `railway.usage.volume` | usage, GB-minutes, billing period | `usage`, `DISK_USAGE_GB` |
| `railway.spend.usage` | verified spend, USD, billing period | `customer.currentUsage` ("cached and may not be up to date") |
| `railway.estimate.bill` | estimated spend, USD, billing period | Subscription fee plus estimated usage beyond the included usage; `estimatedUsage` quantities times the pricing page's unit prices. Declared as projected spend (`projectedSpend`), so no reading of spend counts it as money spent: not the dashboard's totals, cards, or headline, the daily summary, digests, alerts, unusual spend and usage checks, or the dashboard's own projections |
| `railway.credits.balance` | credit balance, USD, at sync time | `customer.creditBalance` |
| `railway.plan.memory_per_service`, `vcpu_per_service`, `replicas_per_service`, `volume_per_service` | included allowance, at sync time | `workspace.plan` and the pricing page's default plan resources |

Every billing period metric uses `customer.billingPeriod` (`start` to `end`), so a sync later in the same period replaces the same figures.

### Units, money, and rounding

- Money: `currentUsage` and `creditBalance` are JSON numbers, read as US dollars (see Unverified). Each is read at 12 decimal places, converted exactly, and rounded once to cents, half to even (`src/lib/money.ts`).
- Estimate: Railway's `estimatedUsage` is described as "the estimated total cost of the project at the end of the current billing cycle" but returns one quantity per measurement and project. StackDash multiplies each by the unit price and rounds the sum once. Unit prices from the [pricing page](https://docs.railway.com/pricing/plans) (checked 2026-11-05): CPU $0.000463 per vCPU per minute, memory $0.000231 per GB per minute, egress $0.05 per GB, volume storage $0.000003472222222 per GB per minute. Builds are free and not measured.
- Bill: Hobby is $5 a month and includes $5 of usage; Pro is $20 and includes $20. The estimated bill is the fee plus estimated usage beyond the included amount, before credits. Free is always $0: it stops workloads when its $1 credit runs out instead of billing more. Enterprise is custom, but `Workspace.plan` is `Plan!` and the enum holds only `FREE`, `HOBBY`, and `PRO`, so an Enterprise workspace reports one of those (most likely `PRO`) and its estimated bill and plan limits then use that plan's figures, a Pro bill for a custom contract. Both are unverified for Enterprise. It is the only estimated spend metric, and it is declared a projection for the whole period, so no reading of spend counts it as money spent so far.
- Reset: every billing period metric carries the period end as its reset time.
- Quantities: CPU and memory are priced per minute, so their measurements are read as vCPU-minutes and GB-minutes; egress is in GB.
- Plan limits per service, replicas included (pricing page, "Default plan resources"): Free 0.5 GB memory, 1 vCPU, 1 replica, 0.5 GB volume; Hobby 48 GB, 48 vCPU, 6 replicas, 5 GB volume; Pro 1 TB (stored as 1,000 GB), 1,000 vCPU, 42 replicas, 1 TB volume.

### Timeline events (by polling)

| Event type | When | Dated |
|---|---|---|
| `railway.deployment.building` | The deployment's build started: status `BUILDING`, `DEPLOYING`, `SUCCESS`, `SLEEPING`, `FAILED`, or `CRASHED`, or `REMOVING` or `REMOVED` with `canRollback: true` | `createdAt` |
| `railway.deployment.deployed` | Status `SUCCESS`, or `SLEEPING` (only a deployed service sleeps) | `statusUpdatedAt`, else `updatedAt` |
| `railway.deployment.failed` | Status `FAILED` | Same |
| `railway.deployment.crashed` | Status `CRASHED` | Same |
| `railway.deployment.removed` | Status `REMOVING` or `REMOVED`; usually a newer deployment replaced it. With `canRollback: true` the title says it succeeded first | Same |

`QUEUED`, `WAITING`, `INITIALIZING`, `NEEDS_APPROVAL`, and `SKIPPED` produce no event. All five event types are shown by default, like every other adapter's.

The dashboard headline's deploys count `railway.deployment.deployed` as a success and `railway.deployment.failed` as a failure. Building, crashed, and removed events have no category: a build starting says nothing about how the deployment ended, and a crash or removal usually follows a deployment a poll already saw deployed, so counting either would count it twice. A deployment that succeeded and was replaced before any poll saw it reaches the timeline only as removed (see [Limitations](#limitations)), so the headline does not count it.

Titles name the service and environment (`Deployment of api to production failed`, `Deployment of web to production succeeded, then was removed`), the body names the project. A failure or crash in an environment named `production` (Railway's name for a new project's first environment, any letter case) is critical; elsewhere it is a warning. Dedupe keys are `railway.deployment:<id>:<kind>`, so a re-read or a later status never duplicates an event. Events carry no link: Railway documents no dashboard URL for a deployment.

The first sync looks back 7 days. The cursor is the latest status time seen; each later sync re-reads from an hour before it, so a status that changed just before the last poll is seen again. A deployment is kept or dropped as a whole, by when it entered its current status: one that sat queued for longer than the overlap still gets its building event alongside its final one.

## Achievements

StackDash evaluates these for each project the Railway accounts are assigned to, from the Railway data it has stored, after each sync (see [Achievements](../adapters.md#achievements)). A project earns each one once, and it stays private until an owner or admin publishes it.

The deployment ladder is the same on Vercel, DigitalOcean, and GitLab. It counts `railway.deployment.deployed` events, and a `railway.deployment.failed` event breaks a run of deployments in a row; a crash after a deployment does not. Days, hours, and weekdays are London time.

| Id | Title | How it is earned |
|---|---|---|
| `railway.deployments.first` | First Railway deployment recorded | Earned when StackDash records the first successful Railway deployment. |
| `railway.deployments.10` | 10 Railway deployments recorded | Earned when StackDash records the 10th successful Railway deployment. |
| `railway.deployments.100` | 100 Railway deployments recorded | Earned when StackDash records the 100th successful Railway deployment. |
| `railway.deployments.streak_10` | 10 Railway deployments in a row | Earned when StackDash records 10 successful Railway deployments in a row, with no failed deployment between them. |
| `railway.deployments.night_owl` | Night owl: a Railway deployment between midnight and 5 am | Earned when StackDash records a successful Railway deployment between midnight and 5 am London time. |
| `railway.deployments.friday_ship` | Shipped on a Friday afternoon | Earned when StackDash records a successful Railway deployment on a Friday between 4 pm and midnight London time. |
| `railway.deployments.busy_day` | Busy day: 10 Railway deployments in one day | Earned when StackDash records 10 successful Railway deployments on one London calendar day. |
| `railway.deployments.weekly_rhythm` | Weekly rhythm: a Railway deployment on 7 days in a row | Earned when StackDash records a successful Railway deployment on each of 7 consecutive London calendar days. |

## Verified, estimated, unavailable

| Value | Status |
|---|---|
| Deployment status, times, service, and environment | Verified (Railway's records) |
| That a removed deployment had succeeded | Inferred from `canRollback` (Unverified 14); only the title of its removal says so, no success time is invented |
| CPU, memory, egress, and volume used this billing period | Verified quantities; units unverified |
| Usage cost so far (`currentUsage`) | Verified, but cached by Railway and possibly behind |
| Credit balance and billing period | Verified |
| Bill for the whole period | Estimated (StackDash: Railway's quantity estimate times published prices, plus the plan fee). Stored, but never shown or counted as spend this billing period |
| Plan limits per service | Estimated (from the plan and the pricing page) |
| Any billing value when Railway refuses viewer access to billing | Unavailable; deployments still sync |
| Invoices, payment methods, usage limits | Not collected |
| Who triggered a deployment, commit messages, logs | Not collected (never selected) |

## Rate limits

From the [Public API page](https://docs.railway.com/integrations/api): 100 requests per hour on Free, 1,000 on Hobby, 10,000 on Pro, custom on Enterprise; 10 requests per second on Hobby and 50 on Pro. Headers: `RateLimit-Policy`, `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, and `Retry-After` once the window is used up. An exceeded limit is HTTP 429; StackDash honors `Retry-After`.

Budget per workspace per sync: one projects request, one deployments request per ten projects, and one billing request, so four requests for a workspace of up to ten projects. A project that created more than 50 deployments since the last sync costs one more deployments request per further page of 50, up to five pages. The adapter polls hourly and runs requests one after another, because the limit is shared with the user's own tokens and scripts. Whether the limit counts per token, per user, or per workspace is unverified.

## Webhooks

Not used. Railway's notification webhooks are not signed, so StackDash cannot tell a real delivery from a forged one. Deployments are polled.

## Permission risks

Disclosed on the connect screen before redirecting:

- **`workspace:viewer`** reads everything a viewer can see in the chosen workspaces, not only what StackDash reads. That may include logs and service settings (unverified for viewer access). StackDash only lists projects, deployments, and billing.
- **`email` and `profile`** let the token read the user's email address, name, and avatar. StackDash never reads them: no query selects those fields and `/oauth/me` is never called.
- **`offline_access`** issues a refresh token valid for a year from its last rotation, the longest-lived secret in this adapter. It is encrypted at rest with the other credentials.
- Railway has no revocation endpoint, so disconnecting in StackDash deletes the tokens but the user must remove the app in Railway to end the grant.

## Limitations

- Billing may be unreadable with viewer access. When Railway answers `Not Authorized`, the connection syncs deployments, shows billing as unavailable, and lists `workspace:viewer` under missing permissions although the user granted it: it is the permission billing is read through, and reconnecting does not help, because only a workspace admin can read billing in Railway's dashboard.
- At most 50 projects per workspace, and per project the deployments created in the sync window up to five pages of 50; past that the sync logs `railway.deployments.page_cap_reached` and older deployments in the window are skipped.
- Enterprise workspaces report `FREE`, `HOBBY`, or `PRO` (the schema has no other plan value), so their estimated bill and plan limits use that plan's published figures, not the custom contract. Unverified.
- StackDash polls hourly, and Railway reports only each deployment's latest status with the time it entered it. A status that changed and changed again between two polls shows only the latest one, apart from the building event. In particular, a deployment that succeeded and was replaced before a poll saw it is first seen as removed: it reaches the timeline as "started building" and "succeeded, then was removed", never as a separate "succeeded" event, because nothing dates the success. On a service that deploys several times an hour, most successful deployments arrive this way. Telling that a removed deployment succeeded relies on `canRollback`, which turns false once the plan's image retention ends (24 hours on Free), so after a longer sync outage replaced deployments show as removed only.
- A deployment created before the sync window is re-read only while it is on the page where paging stops: the first page of 50 that reaches a deployment older than the window. With removed deployments included, that page holds roughly the newest 50 deployments of the project's history, or fewer older ones when deployments in the window fill part of it. Once about 50 newer deployments, removed ones included, exist in its project, a later crash or removal of an older long-running deployment is missed, however many pages the sync reads. A production deployment that runs for weeks and then crashes is exactly this case. When the five page cap is reached first, no older deployment is re-read at all.
- No link from an event to Railway's dashboard.

## Self-hosted registration

Only a workspace admin can create an OAuth app. Each deployment registers its own app, because the redirect URI and the client secret belong to one deployment.

1. Pick the deployment's public URL, `<SITE_URL>`. The redirect URI is `<SITE_URL>/api/connections/railway/callback`.
2. In Railway, open the workspace's **Settings**, then **Developer**, and choose **New OAuth App**.
3. **Name**: something users recognize on the consent screen, for example `StackDash`.
4. **Redirect URI**: `<SITE_URL>/api/connections/railway/callback`. For local development add `http://localhost:3000/api/connections/railway/callback` too; Railway lets one app register several URIs and matches them exactly.
5. **App type**: **Web (Confidential)**.
6. Create the app and copy the client secret at once: it is shown only once.
7. Set `RAILWAY_CLIENT_ID` and `RAILWAY_CLIENT_SECRET` in the server environment (see [Register the OAuth apps](../operations/oauth-apps.md#railway-oauth-app)).

Scopes are not configured on the app: StackDash sends them with each authorize request. Dynamic client registration (`POST /oauth/register`) exists, but those clients are managed only through a registration access token and never appear in the dashboard, so StackDash uses the dashboard app.

## Sample responses

All samples are from documentation, not recorded. Values are synthetic. The unit tests use the same shapes under `src/lib/adapters/railway/fixtures/`.

`POST /oauth/token` with `offline_access` (from "Login & Tokens"):

```json
{
  "access_token": "synthetic-access-token-1",
  "expires_in": 3600,
  "id_token": "synthetic-id-token-1",
  "refresh_token": "synthetic-refresh-token-1",
  "scope": "openid email profile offline_access workspace:viewer",
  "token_type": "Bearer"
}
```

`me { workspaces { id name } }` (from "Fetching Workspaces or Projects"):

```json
{ "data": { "me": { "workspaces": [{ "id": "ws-synthetic-1", "name": "My Workspace" }] } } }
```

`deployments(first: 50, after, input: { projectId, includeDeleted: true })` (shaped from the schema and the "Manage Deployments" fields):

```json
{
  "data": {
    "d0": {
      "edges": [
        {
          "node": {
            "id": "dep-web-success",
            "status": "SUCCESS",
            "createdAt": "2026-11-05T11:00:00.000Z",
            "updatedAt": "2026-11-05T11:03:00.000Z",
            "statusUpdatedAt": "2026-11-05T11:03:00.000Z",
            "canRollback": false,
            "service": { "name": "web" },
            "environment": { "name": "production" }
          }
        }
      ],
      "pageInfo": { "hasNextPage": true, "endCursor": "cursor-shop-1" }
    }
  }
}
```

Billing (shaped from the schema; amounts in dollars is the reading StackDash assumes):

```json
{
  "data": {
    "workspace": {
      "plan": "HOBBY",
      "customer": {
        "billingPeriod": { "start": "2026-10-20T00:00:00.000Z", "end": "2026-11-20T00:00:00.000Z" },
        "currentUsage": 3.456,
        "creditBalance": 1.25
      }
    },
    "usage": [{ "measurement": "CPU_USAGE", "value": 4200.5 }],
    "estimatedUsage": [{ "measurement": "CPU_USAGE", "estimatedValue": 5000, "projectId": "prj-shop" }]
  }
}
```

A denied query (from "Public API, Errors", with Railway's documented denial message):

```json
{
  "errors": [
    {
      "message": "Not Authorized",
      "path": ["workspace", "customer"],
      "extensions": { "code": "INTERNAL_SERVER_ERROR", "traceId": "1234567890123456789" }
    }
  ],
  "data": null
}
```

## Unverified

Confirm with a test account before relying on these:

1. Whether a `workspace:viewer` token can read `workspace.customer`, `usage`, and `estimatedUsage`. The dashboard limits billing settings to admins; a `Not Authorized` answer leaves billing unavailable.
2. Whether `me { workspaces }` really needs `email` and `profile`, as documented, or also answers without them.
3. Whether the token response's `scope` lists `workspace:viewer`. If it does not, the connection would show it as a missing permission although it was granted.
4. The units of `currentUsage` and `creditBalance` (assumed US dollars) and of the `usage` and `estimatedUsage` measurements (assumed vCPU-minutes, GB-minutes, GB, and GB-minutes).
5. Whether `estimatedUsage` already returns dollars rather than quantities, as its description ("estimated total cost") could suggest.
6. That `deployments` returns newest first.
7. That `statusUpdatedAt` is the time of the current status, and how often it is null.
8. How an expired or revoked access token answers: HTTP 401, or HTTP 200 with `Not Authorized`.
9. Whether one query with ten aliased `deployments` fields stays within any query complexity limit.
10. Whether the rate limit counts per token, per user, or per workspace.
11. Where a user removes an authorized app in Railway's dashboard.
12. The exact `Plan` value an Enterprise workspace returns, and so which plan's fee and limits its billing uses.
13. Whether `deployments(input: { projectId })` lists `REMOVED` deployments without `includeDeleted: true`, and what else `includeDeleted` adds (deployments of deleted services or environments, or ones removed from the history). The adapter passes it either way. If it adds deployments of a deleted service or environment, whether their `service` and `environment` still resolve: the schema's `Service.deletedAt` and `Environment.deletedAt` suggest soft deletion, but a non-null field that fails to resolve would fail the whole deployments query.
14. That `canRollback` is true for a removed deployment only when it deployed successfully, and stays true for the plan's image retention.
15. That `endCursor` pages `deployments` in the same newest first order.

## Sources

All checked 2026-11-05.

- [OAuth: Creating an App](https://docs.railway.com/integrations/oauth/creating-an-app)
- [OAuth: Scopes & User Consent](https://docs.railway.com/integrations/oauth/scopes-and-user-consent)
- [OAuth: Login & Tokens](https://docs.railway.com/integrations/oauth/login-and-tokens)
- [OAuth: Fetching Workspaces or Projects](https://docs.railway.com/integrations/oauth/fetching-workspaces-or-projects)
- [OpenID configuration](https://backboard.railway.com/.well-known/openid-configuration)
- [Public API: endpoint, rate limits, errors, versioning](https://docs.railway.com/integrations/api)
- [Public API: Manage Deployments (queries and statuses)](https://docs.railway.com/integrations/api/manage-deployments)
- [Public API: API Cookbook](https://docs.railway.com/integrations/api/api-cookbook)
- Public API schema, by introspection of `https://backboard.railway.com/graphql/v2` (`Customer`, `BillingPeriod`, `Deployment`, `DeploymentStatus`, `DeploymentListInput`, `PageInfo`, `Workspace`, `Plan`, `MetricMeasurement`, `Query.usage`, `Query.estimatedUsage`, `Query.deploymentEvents`, `DeploymentEventStep`, `Query.events`, `Service`, `Environment`)
- [Pricing Plans (prices, included usage, default plan resources, image retention)](https://docs.railway.com/pricing/plans)
- [Deployment actions (rollback)](https://docs.railway.com/deployments/deployment-actions)
- [Workspaces (roles and billing access)](https://docs.railway.com/projects/workspaces)
