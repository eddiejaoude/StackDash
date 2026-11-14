# Supabase

Provider id: `supabase`. Verification: documentation only.

StackDash reads your Supabase organization's plan and limits, each project's health, and auth activity: signups, logins, logouts, deleted users, and daily active users. It asks for three read-only scopes, never reads database rows, and stores counts and timestamps only.

All facts below were checked against Supabase's documentation and the Management API OpenAPI spec on 2026-10-31. Anything not confirmed by those sources is marked unverified and listed in [Unverified](#unverified).

## Summary

| Topic | Answer |
|---|---|
| Authentication | OAuth 2.0 authorization code flow with PKCE, through a Supabase OAuth app. No API key or personal access token path (MVP is OAuth only) |
| Scopes | `organizations:read`, `projects:read`, `analytics:read`. Never `database:read` |
| Read-only | Yes. All three scopes are read scopes |
| Spend or invoices | Unavailable. No billing endpoint carries an OAuth scope |
| Auth activity | Yes, through the logs endpoint, source `auth_audit_logs` |
| Webhooks | None. Polling only |
| Rate limit | 120 requests per minute per endpoint per project or organization, shared by every user of the OAuth app |
| Biggest constraint | Auth audit logs are kept for 1 hour on the Free plan, so the adapter must poll well inside that hour |

### Correction to the original plan

The original plan named `GET /v1/projects/{ref}/analytics/endpoints/logs.all`. That endpoint was removed on 2026-09-23 and now always returns `410 Gone` ([changelog](https://supabase.com/changelog/48235-migration-of-supabase-management-api-logs-all-analytics-endpoint-to-logs-endpoint), OpenAPI operation `v1-get-project-logs-all`). Use `GET /v1/projects/{ref}/analytics/endpoints/logs` instead. It takes ClickHouse SQL against one unified `logs` table, with the same `analytics:read` scope and the same 24 hour window rule.

## Connection

### Endpoints

| Step | Request | Notes |
|---|---|---|
| Authorize | `GET https://api.supabase.com/v1/oauth/authorize` | Browser redirect |
| Token | `POST https://api.supabase.com/v1/oauth/token` | `application/x-www-form-urlencoded` |
| Revoke | `POST https://api.supabase.com/v1/oauth/revoke` | `application/json`, returns `204` |

The OpenAPI spec marks all three as Beta and "experimental", so they may change. Treat any unexpected status as an error with the response kept as `cause`.

### Authorize

Query parameters ([OAuth guide](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration), OpenAPI `v1-authorize-user`):

| Parameter | Value |
|---|---|
| `client_id` | `SUPABASE_OAUTH_CLIENT_ID` (a UUID) |
| `redirect_uri` | `<SITE_URL>/api/connections/supabase/callback` |
| `response_type` | `code` |
| `state` | Opaque, unguessable value bound to the StackDash session. `redirect_uri` and `state` together must stay under 4 kB |
| `code_challenge` | Base64url SHA-256 of the code verifier |
| `code_challenge_method` | `S256` |
| `organization_slug` | Optional. Pre-selects an organization on the consent screen |

Do not send `scope`. The guide marks it deprecated: scopes are set on the OAuth app itself. Supabase strongly recommends PKCE, and StackDash always uses it.

On consent, Supabase redirects to `redirect_uri` with `code` and `state`. Compare `state` with the stored value before anything else.

### Token exchange

Form body: `grant_type=authorization_code`, `code`, `redirect_uri` (byte-for-byte the same as in the authorize step), `code_verifier`. Client credentials go in an HTTP Basic `Authorization` header (`client_id:client_secret`), as the guide shows. The spec also accepts `client_id` and `client_secret` as form fields.

Response (OpenAPI `v1-exchange-oauth-token`): `access_token` (string), `refresh_token` (string), `expires_in` (integer, seconds), `token_type` (`"Bearer"`). `access_token`, `expires_in`, and `token_type` are required in the schema; `refresh_token` is optional in the schema but is returned for the authorization code grant per the guide.

### Token lifetimes and refresh

- The Management API reference says OAuth tokens are "short-lived". No exact access token or refresh token lifetime is documented. Compute expiry from `expires_in` at exchange time, never from a hard-coded value.
- Refresh with `POST /v1/oauth/token`, `grant_type=refresh_token`, `refresh_token`, and the same Basic client credentials.
- Whether refresh tokens rotate is not documented. Always store the `refresh_token` from a refresh response when one is present, and keep the old one only if none is returned.
- If the user revokes the app, refresh fails and access tokens stop working. The guide says to handle `401 Unauthorized` on every call. A `401` on refresh marks the connection as needing reconnection; do not retry it.

### Revoke

On disconnect, call `POST /v1/oauth/revoke` with JSON `{ "client_id", "client_secret", "refresh_token" }`. A `204` means the app authorization and its tokens are revoked. Then delete the stored tokens.

### Scopes and why

Scopes are configured on the OAuth app, not per request. Changing them later forces every connected user through the OAuth flow again ([OAuth scopes](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes)). Choose them once.

| Scope | Endpoints StackDash uses (scope from the OpenAPI `x-oauth-scope` of each operation) |
|---|---|
| `organizations:read` | `GET /v1/organizations`, `GET /v1/organizations/{slug}`, `GET /v1/organizations/{slug}/entitlements` |
| `projects:read` | `GET /v1/organizations/{slug}/projects`, `GET /v1/projects`, `GET /v1/projects/{ref}`, `GET /v1/projects/{ref}/health` |
| `analytics:read` | `GET /v1/projects/{ref}/analytics/endpoints/logs`, `GET /v1/projects/{ref}/analytics/endpoints/metrics` |

`organizations:read` also unlocks `GET /v1/organizations/{slug}/members`, which returns member `email`, `user_id`, and `user_name`. StackDash never calls it.

#### Why never `database:read`

`database:read` unlocks `POST /v1/projects/{ref}/database/query/read-only`, which runs arbitrary SQL "as supabase_read_only_user". In Supabase's Postgres init script that role is created `with login bypassrls` and granted `pg_read_all_data` ([initial schema](https://raw.githubusercontent.com/supabase/postgres/develop/migrations/db/init-scripts/00000000000000-initial-schema.sql), lines 19 and 20). It reads every row of every table, row level security ignored, including `auth.users` emails and phone numbers. The optional `auth.audit_log_entries` table is only reachable this way too. StackDash needs counts, not rows, so it must not hold this scope.

#### Disclosure before connecting

Shown to the user before the redirect, in plain words:

- Read your organization name, plan, and plan limits.
- Read your projects' names, regions, status, and service health.
- Read your projects' logs, including auth logs, to count signups, logins, and active users. StackDash keeps only counts and timestamps, never emails, IP addresses, or user ids.
- StackDash cannot read your database tables or change anything.

The third line matters: `analytics:read` returns raw log rows on request, and those rows can contain emails and IP addresses. The privacy guarantee comes from the queries StackDash sends, not from the scope.

## Data

### Organizations and projects

- `GET /v1/organizations` lists the organizations the token can see: `slug`, `name`, and deprecated `id`.
- `GET /v1/organizations/{slug}/projects` returns `{ projects, pagination }`. Query `offset`, `limit` (1 to 100, default 100), `sort` (`name_asc`, `name_desc`, `created_asc`, `created_desc`), `statuses`. Each project has `ref`, `name`, `region`, `cloud_provider`, `is_branch`, `status`, `inserted_at`, and `databases[]` with `infra_compute_size`, `status`, `type` (`PRIMARY` or `READ_REPLICA`), and optional `disk_volume_size_gb`.
- `GET /v1/projects` lists all projects with `ref`, `organization_slug`, `name`, `region`, `created_at`, `status`, and `database` (`host`, `version`, `postgres_engine`, `release_channel`). No pagination parameters are documented.

Prefer the organization-scoped list: it is paginated and its rate limit is tracked per organization, while `GET /v1/projects` and `GET /v1/organizations` are tracked per caller (see [Rate limits](#rate-limits)). Skip projects whose `status` is `INACTIVE` (paused) when polling logs and health. Free projects pause after 1 week of inactivity ([pricing](https://supabase.com/pricing)).

### Plan and entitlements

- `GET /v1/organizations/{slug}` returns `id`, `name`, `plan` (`free`, `pro`, `team`, `enterprise`, `platform`), `opt_in_tags`, `allowed_release_channels`.
- `GET /v1/organizations/{slug}/entitlements` returns `entitlements[]`, each with `feature.key`, `feature.type` (`boolean`, `numeric`, `set`), `hasAccess`, `type`, and `config`. A numeric `config` has `enabled`, `value`, `unlimited`, `unit`.

Keys StackDash reads (from the documented enum):

| Key | Use |
|---|---|
| `security.audit_logs_days` | Auth audit log retention. Drives the polling interval |
| `log.retention_days` | API and database log retention |
| `function.max_count` | Edge Function count limit |
| `realtime.max_concurrent_users` | Realtime limit |
| `storage.max_file_size` | Storage limit |

No entitlement key covers database size, egress, or monthly active users. Those plan limits appear only on the [pricing page](https://supabase.com/pricing): Free has 500 MB database size per project and 50,000 MAU; Pro and Team include 8 GB disk per project and 100,000 MAU. A limit taken from the pricing page is a constant in code, labeled estimated, with the date checked.

### Project health

`GET /v1/projects/{ref}/health?services=auth,db,rest,storage,realtime&timeout_ms=2000`

- `services` is required: a comma-separated list from `auth`, `db`, `db_postgres_user`, `pooler`, `realtime`, `rest`, `storage`, `pg_bouncer`.
- `timeout_ms` is optional.
- Response: an array of `{ name, status, info?, error? }`, `status` one of `COMING_UP`, `ACTIVE_HEALTHY`, `UNHEALTHY`. `healthy` (boolean) is deprecated; use `status`.

### Auth activity from logs

`GET /v1/projects/{ref}/analytics/endpoints/logs` ([query logs with SQL](https://supabase.com/docs/guides/observability/advanced-log-filtering), OpenAPI `v1-get-project-logs`).

| Query parameter | Rule |
|---|---|
| `sql` | ClickHouse SQL. Without it the endpoint queries API Gateway events only |
| `iso_timestamp_start`, `iso_timestamp_end` | UTC, for example `2026-10-31T09:00:00Z`. Range at most 24 hours, rounded to the nearest minute. Over 24 hours is a validation error. Omitting both queries only the last minute |

Response: `{ result: unknown[], error?: string | { code, errors[], message, status } }`. Check the HTTP status and `error` before reading `result`. Statuses: `401`, `402` ("Usage exceeded. Enable additional usage to continue querying"), `403`, `429`.

Query rules from the docs: every event is a row in `logs`; filter by source; list columns explicitly, since `select *` and `count(*)` are rejected (use `count()`); always set `limit`; `timestamp` is a UTC `DateTime64`; values in `log_attributes` are strings.

#### Where the actions live

The [log field reference](https://supabase.com/docs/guides/observability/log-field-reference) lists source `auth_audit_logs` ("Auth audit events") with these fields:

| ClickHouse field | StackDash |
|---|---|
| `timestamp` | Read |
| `log_attributes['auth_audit_event.action']` | Read (filter and group only) |
| `log_attributes['auth_audit_event.actor_id']` | Used only inside `uniqExact()` for daily active users. Never selected |
| `log_attributes['auth_audit_event.actor_username']`, `actor_name` | Never touched. Likely holds the email [inference] |
| `log_attributes['auth_audit_event.user_agent']`, `request_id`, `audit_log_id`, `log_type`, `created_at`, `actor_via_sso` | Never selected |
| `id`, `event_message`, `identifier`, `host`, `level`, `msg` | Never selected. `event_message` may embed the whole event |

`auth_logs` (the Auth server's own log) also carries `auth_event.action` alongside `auth_event.traits.user_email` and `remote_addr`. StackDash uses `auth_audit_logs` only.

Actions StackDash counts ([auth audit logs](https://supabase.com/docs/guides/auth/audit-logs)):

| Action | Documented meaning | StackDash use |
|---|---|---|
| `user_signedup` | New user registration | "New signup" timeline event, one per row |
| `login` | User sign-in attempt | Daily login count; daily active users |
| `logout` | User sign-out | Daily count |
| `user_deleted` | User account deleted | Daily count |
| `token_refreshed` | Refresh token used to obtain new tokens | Daily active users only |

The docs warn "there may be a short delay before logs appear". Poll windows that end a few minutes in the past so late events are not missed.

#### Queries

Counts for one window:

```sql
select log_attributes['auth_audit_event.action'] as action, count() as events
from logs
where source = 'auth_audit_logs'
  and log_attributes['auth_audit_event.action'] in
    ('user_signedup', 'login', 'logout', 'user_deleted', 'token_refreshed')
group by action
limit 10
```

Signup timestamps for the timeline (no identifiers):

```sql
select timestamp
from logs
where source = 'auth_audit_logs'
  and log_attributes['auth_audit_event.action'] = 'user_signedup'
order by timestamp asc
limit 1000
```

If a window returns the full `limit`, split it in half and query again.

Daily active users, aggregated by ClickHouse so no user id leaves Supabase:

```sql
select uniqExact(log_attributes['auth_audit_event.actor_id']) as active_users
from logs
where source = 'auth_audit_logs'
  and log_attributes['auth_audit_event.action'] in ('login', 'token_refreshed')
limit 1
```

The changelog's examples filter on `source_name`, while the current query guide and field reference use `source`. Confirm which column the endpoint accepts with a test project.

#### Windows and daily active users

- Event counts add up across windows, so the daily "N logins" figure is the sum of every poll window in the UTC day.
- Distinct users do not add up. An exact daily active user count needs one query over the whole UTC day (`00:00:00Z` to the next `00:00:00Z`, exactly 24 hours), run after the day ends and while that day is still retained.
- That works when `security.audit_logs_days` is at least 1 (Pro: 7 days, Team: 28 days).
- On the Free plan, auth audit logs are kept for 1 hour, so no full-day query is possible. Summing hourly distinct counts overstates the figure, and keeping ids to deduplicate breaks the privacy rule. Recommendation: on Free, show daily active users as unavailable with a short reason ("Supabase keeps auth logs for 1 hour on the Free plan"), and show logins and signups as normal.

### Usage and database size

| Metric | Reachable with these scopes | Label |
|---|---|---|
| Spend, invoices, credits | No. No billing endpoint has an OAuth scope (`GET /v1/projects/{ref}/billing/addons` lists none) | Unavailable |
| Monthly active users (billed MAU) | No endpoint | Unavailable |
| Database size in use | Possibly, through `GET /v1/projects/{ref}/analytics/endpoints/metrics` (`analytics:read`). It returns Prometheus text with about 200 series. Supabase's own Grafana dashboard charts `pg_database_size_mb` from this feed ([supabase-grafana](https://github.com/supabase/supabase-grafana)). The pricing page lists the metrics endpoint as not included on Free. Returns `400` when the project is not active and healthy | Estimated, Pro and above, unverified |
| Provisioned disk | `databases[].disk_volume_size_gb` from the organization projects list (`projects:read`). This is the disk size, not data in use | Verified as provisioned size |
| API request counts | `GET /v1/projects/{ref}/analytics/endpoints/usage.api-counts` (`interval` from `15min` to `7day`, returns `total_auth_requests`, `total_rest_requests`, `total_storage_requests`, `total_realtime_requests` per timestamp). The spec lists no OAuth scope for it | Unverified, not in MVP |
| Disk utilization | `GET /v1/projects/{ref}/config/disk/util` exists but lists no OAuth scope | Unavailable for OAuth [inference], not in MVP |

The metrics endpoint is the only documented path to database size with these scopes. The Prometheus text can be large; parse only the `pg_database_size_mb` line and do not store the rest.

### Verified, estimated, unavailable

| Metric | Unit, period | Label |
|---|---|---|
| Signups, logins, logouts, deleted users | count per UTC day, plus one timestamp per signup | Verified (provider-reported log events) |
| Daily active users | count per UTC day | Verified on Pro and above; unavailable on Free |
| Plan | `free`, `pro`, `team`, `enterprise`, `platform` | Verified |
| Entitlements (log retention, function count, realtime limits) | as given by `unit` | Verified |
| Plan limits not in entitlements (database size, MAU) | MB, users per month | Estimated (pricing page constant) |
| Project health per service | status | Verified |
| Database size | MB, at scrape time | Estimated, unverified |
| Spend | | Unavailable |

## Achievements

StackDash evaluates these for each project the Supabase accounts are assigned to, from the Supabase data it has stored, after each sync (see [Achievements](../adapters.md#achievements)). A project earns each one once, and it stays private until an owner or admin publishes it.

The signup ladder is the same on PostHog. It counts `supabase.auth.signup` events. Rush hour and Night owls are Supabase's own, because PostHog reports only a total per day. Days and hours are London time.

| Id | Title | How it is earned |
|---|---|---|
| `supabase.signups.first` | First Supabase signup recorded | Earned when StackDash records the first Supabase signup. |
| `supabase.signups.10` | 10 Supabase signups recorded | Earned when StackDash records the 10th Supabase signup. |
| `supabase.signups.100` | 100 Supabase signups recorded | Earned when StackDash records the 100th Supabase signup. |
| `supabase.signups.1000` | 1,000 Supabase signups recorded | Earned when StackDash records the 1,000th Supabase signup. |
| `supabase.signups.big_day` | Big day: 100 signups in one day | Earned when StackDash records 100 Supabase signups on one London calendar day. |
| `supabase.signups.rush_hour` | Rush hour: 10 signups in one hour | Earned when StackDash records 10 Supabase signups in one London clock hour. |
| `supabase.signups.night_owls` | Night owls: a signup between midnight and 5 am | Earned when StackDash records a Supabase signup between midnight and 5 am London time. |

## Polling

- Webhooks: none. Supabase has no webhook for auth events or project changes reachable by an OAuth app. Log drains exist but are paid, per project, and push to a destination the customer configures, so they are out of scope.
- Suggested cycle per connection, every 15 minutes:
  1. Organization projects list (one call per organization).
  2. For each active project: health (one call), auth counts and signup timestamps for the window since the last successful poll (two log queries).
- Once per day: organization, entitlements, and the full-day daily active users query (Pro and above).
- Windows are non-overlapping, from the previous window's end to now minus a settle lag of 5 minutes. A 15 minute interval with a 5 minute lag keeps every window well inside the 1 hour Free retention, and leaves room for one missed cycle. If a project falls more than about 45 minutes behind on Free, record a gap rather than claiming zero events.
- Read `security.audit_logs_days` per organization. On Pro and above the interval could be longer, but 15 minutes keeps the timeline fresh.

### Rate limits

From the [Management API reference](https://supabase.com/docs/reference/api/introduction#rate-limits):

- 120 requests per minute, per project or organization, per endpoint.
- For OAuth apps the identifier is the OAuth app id, so the limit is shared by everyone calling through the app. For a hosted StackDash, every user who connects the same Supabase project shares that project's budget.
- Calls without a project or organization in the path (`GET /v1/projects`, `GET /v1/organizations`) are tracked on the identifier alone. Reading the docs, for an OAuth app this is one budget for the whole app across all users [inference]. Call them only at connect time.
- Analytics endpoints are stricter. The exceptions table lists 30 requests per minute for `logs.all`, `usage.api-counts`, and `usage.api-requests-count`. It does not list the new `logs` endpoint. Budget 30 per minute per project for it until confirmed.
- Over the limit, every call returns `429` for the rest of the minute. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (seconds). Back off using `X-RateLimit-Reset`, and stagger projects across the interval.

### Log query allowance

Logs Query is not billed, but each organization gets an allowance of 100 times its log ingest (Free: 100 GB) ([logs query usage](https://supabase.com/docs/guides/platform/manage-your-usage/logs-query)). The docs warn that scheduled polling rescans data on every run. Once enforcement starts (not yet, per the docs), going over means the next month is degraded: 10 queries per minute and log retention cut to 1 hour on Free or 24 hours on paid plans, and a second month over cuts off log access. Keep windows small and always filter on the source, which is what the queries above do. The `402` status on the logs endpoint is the likely signal; surface it as a connection warning, not a retry.

### Retention per plan

From the [pricing comparison](https://supabase.com/pricing):

| Plan | Auth audit logs | API and database logs | Fits a 15 minute poll |
|---|---|---|---|
| Free | 1 hour | 1 day | Yes, with little slack |
| Pro | 7 days | 7 days | Yes |
| Team | 28 days | 28 days | Yes |
| Enterprise | Included (custom) | 90 days | Yes |

## Privacy

- Store counts and timestamps only. Never emails, phone numbers, IP addresses, user agents, Supabase user ids, actor names, or log row ids.
- Never select an identifying column. Daily active users are counted with `uniqExact()` inside the query, so ids never reach StackDash.
- Parse `result` with zod schemas that accept only the expected aggregate columns (`action`, `events`, `timestamp`, `active_users`). Reject anything else instead of storing it.
- Do not log raw responses from the logs endpoint.
- Fixtures are synthetic.

## Self-hosted registration

Every install registers its own OAuth app, because the client secret and callback URL belong to one deployment.

1. In the Supabase dashboard, open the organization's settings and select the **OAuth Apps** tab ([link](https://supabase.com/dashboard/org/_/apps)).
2. Select **Add application**.
3. Fill in the details:
   - Name and website: your StackDash install.
   - Redirect URL: `<SITE_URL>/api/connections/supabase/callback`, for example `https://stackdash.example.com/api/connections/supabase/callback`. For local development, `http://localhost:3000/api/connections/supabase/callback`.
   - Scopes: Organizations read, Projects read, Analytics read. Nothing else.
4. Select **Confirm**, then copy the client id and client secret.
5. Set the environment variables (never commit them):

```bash
SUPABASE_OAUTH_CLIENT_ID=
SUPABASE_OAUTH_CLIENT_SECRET=
```

The guide says "once you've published your OAuth App". Whether an app must be published before users outside the creating organization can authorize it is not documented.

## Sample responses

From documentation, not recorded. Shapes follow the OpenAPI schemas; values are synthetic. Replace them with recorded, sanitized fixtures after the test project checks.

`POST /v1/oauth/token`:

```json
{
  "access_token": "<access token>",
  "refresh_token": "<refresh token>",
  "expires_in": 3600,
  "token_type": "Bearer"
}
```

`expires_in` here is illustrative; the real lifetime is not documented.

`GET /v1/organizations`:

```json
[{ "id": "examplecorp", "slug": "examplecorp", "name": "Example Corp" }]
```

`GET /v1/organizations/examplecorp`:

```json
{
  "id": "examplecorp",
  "name": "Example Corp",
  "plan": "free",
  "opt_in_tags": [],
  "allowed_release_channels": ["ga"]
}
```

`GET /v1/organizations/examplecorp/entitlements` (trimmed):

```json
{
  "entitlements": [
    {
      "feature": { "key": "security.audit_logs_days", "type": "numeric" },
      "hasAccess": true,
      "type": "numeric",
      "config": { "enabled": true, "value": 0, "unlimited": false, "unit": "days" }
    },
    {
      "feature": { "key": "log.retention_days", "type": "numeric" },
      "hasAccess": true,
      "type": "numeric",
      "config": { "enabled": true, "value": 1, "unlimited": false, "unit": "days" }
    }
  ]
}
```

How Free's 1 hour audit retention appears in `security.audit_logs_days` is unknown; the `0` above is a guess.

`GET /v1/organizations/examplecorp/projects` (trimmed):

```json
{
  "projects": [
    {
      "ref": "abcdefghijklmnopqrst",
      "name": "example-app",
      "cloud_provider": "AWS",
      "region": "us-east-1",
      "is_branch": false,
      "status": "ACTIVE_HEALTHY",
      "inserted_at": "2026-01-15T12:00:00Z",
      "databases": [
        {
          "infra_compute_size": "nano",
          "region": "us-east-1",
          "status": "ACTIVE_HEALTHY",
          "cloud_provider": "AWS",
          "identifier": "abcdefghijklmnopqrst",
          "type": "PRIMARY"
        }
      ]
    }
  ],
  "pagination": { "count": 1, "limit": 100, "offset": 0 }
}
```

`GET /v1/projects/abcdefghijklmnopqrst/health?services=auth,db`:

```json
[
  {
    "name": "auth",
    "healthy": true,
    "status": "ACTIVE_HEALTHY",
    "info": { "name": "GoTrue", "version": "2.0.0", "description": "GoTrue is a user registration and authentication API" }
  },
  { "name": "db", "healthy": true, "status": "ACTIVE_HEALTHY" }
]
```

`GET /v1/projects/abcdefghijklmnopqrst/analytics/endpoints/logs` with the counts query:

```json
{
  "result": [
    { "action": "login", "events": 42 },
    { "action": "user_signedup", "events": 3 },
    { "action": "token_refreshed", "events": 310 }
  ]
}
```

Whether `events` arrives as a number or a string, and whether `timestamp` arrives as an ISO string or epoch microseconds, is unverified.

The documented audit log event format, shown only so implementers know what not to store ([auth audit logs](https://supabase.com/docs/guides/auth/audit-logs)):

```json
{
  "timestamp": "2025-08-01T10:30:00Z",
  "user_id": "uuid",
  "action": "user_signedup",
  "ip_address": "192.168.1.1",
  "user_agent": "Mozilla/5.0...",
  "metadata": { "provider": "email" }
}
```

## Confirm first, with a test project

The original checklist, restated with what the docs say. Run each on a Free organization and a Pro organization before building the adapter.

- [ ] **Auth audit events appear in the logs endpoint, and which source and fields hold the action.** Docs: source `auth_audit_logs`, action in `log_attributes['auth_audit_event.action']`, user in `auth_audit_event.actor_id`. Confirm with one signup, one login, one logout, one deletion, and one token refresh. Also confirm whether the filter column is `source` (query guide) or `source_name` (changelog), and that these events are recorded without turning on "Write audit logs to the database".
- [ ] **Log retention on the Free plan is longer than the polling interval.** Docs: auth audit logs are kept 1 hour on Free (7 days Pro, 28 days Team); API and database logs 1 day on Free. A 15 minute poll fits. Confirm the 1 hour figure by querying a window 50 to 70 minutes old, and record what `security.audit_logs_days` returns on Free.
- [ ] **Whether the metrics endpoint includes database size.** Docs: `GET /v1/projects/{ref}/analytics/endpoints/metrics` takes `analytics:read` and returns Prometheus text; Supabase's Grafana dashboard charts `pg_database_size_mb` from this feed; pricing lists the metrics endpoint as not included on Free. Confirm the series is present on Pro and what Free returns.
- [ ] **Whether `usage.api-counts` accepts OAuth tokens.** Docs: the spec lists no OAuth scope for it, and the rate limit table puts it at 30 per minute. Call it with an OAuth token holding only the three scopes and record the status.

Added by this research:

- [ ] `logs.all` returns `410` and `logs` works with an OAuth token holding `analytics:read`.
- [ ] The rate limit on `/analytics/endpoints/logs` (read `X-RateLimit-Limit`).
- [ ] Access token lifetime (`expires_in`) and whether refresh rotates the refresh token.
- [ ] Whether a token is limited to the organization chosen on the consent screen or covers every organization the user belongs to.
- [ ] Whether a user without the owner or admin role can authorize the app and read the organization and entitlements (the spec lists the internal permission `organization_admin_read` for both).
- [ ] The response types of `count()`, `uniqExact()`, and `timestamp` in `result`.
- [ ] Whether `login` includes failed sign-in attempts (the docs say "sign-in attempt").

## Unverified

- Access and refresh token lifetimes, and refresh token rotation. Not documented.
- The rate limit for `GET /v1/projects/{ref}/analytics/endpoints/logs`. Only `logs.all` (30 per minute) is listed.
- `source` versus `source_name` as the filter column.
- Whether `login` counts failed attempts, which would inflate login counts.
- Whether the metrics feed reached through the Management API includes `pg_database_size_mb`, and what it returns on Free.
- Whether `usage.api-counts`, `usage.api-requests-count`, and `config/disk/util` accept OAuth tokens.
- How the Free plan's 1 hour audit retention is expressed in `security.audit_logs_days`.
- Whether a token spans one organization or all of the user's organizations, and whether non-admin members can authorize.
- Whether an OAuth app must be published before users outside its organization can authorize it.
- Whether the user-scoped rate limit on `GET /v1/projects` and `GET /v1/organizations` is one budget for the whole OAuth app.
- Field value types in the logs `result` array.
- `actor_username` holding the user's email (likely, not stated).

## Sources

All checked 2026-10-31.

- [Build a Supabase Integration (OAuth apps)](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration)
- [Scopes for your OAuth App](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes)
- [Management API introduction: authentication and rate limits](https://supabase.com/docs/reference/api/introduction)
- [Management API OpenAPI spec](https://api.supabase.com/api/v1-json) (operations `v1-authorize-user`, `v1-exchange-oauth-token`, `v1-revoke-token`, `v1-list-all-organizations`, `v1-get-an-organization`, `v1-get-organization-entitlements`, `v1-get-all-projects-for-organization`, `v1-list-all-projects`, `v1-get-services-health`, `v1-get-project-logs`, `v1-get-project-logs-all`, `v1-scrape-project-metrics`, `v1-get-project-usage-api-count`, `v1-read-only-query`, `v1-list-organization-members`)
- [Migration of `logs.all` to `logs` (changelog, 2026-07-23)](https://supabase.com/changelog/48235-migration-of-supabase-management-api-logs-all-analytics-endpoint-to-logs-endpoint)
- [Query logs with SQL](https://supabase.com/docs/guides/observability/advanced-log-filtering)
- [Log sources and fields](https://supabase.com/docs/guides/observability/log-field-reference)
- [Auth audit logs](https://supabase.com/docs/guides/auth/audit-logs)
- [Logs in Studio](https://supabase.com/docs/guides/observability/logs)
- [Manage Logs usage](https://supabase.com/docs/guides/platform/manage-your-usage/logs)
- [Manage Logs Query usage](https://supabase.com/docs/guides/platform/manage-your-usage/logs-query)
- [Metrics API](https://supabase.com/docs/guides/observability/metrics)
- [supabase-grafana dashboard](https://github.com/supabase/supabase-grafana)
- [Pricing and full feature comparison](https://supabase.com/pricing)
- [Supabase Postgres initial schema](https://raw.githubusercontent.com/supabase/postgres/develop/migrations/db/init-scripts/00000000000000-initial-schema.sql)
- [connect-supabase example](https://github.com/supabase/supabase/tree/master/examples/edge-functions/supabase/functions/connect-supabase)

## Go or no-go

**Go for the MVP**, on three conditions: the adapter uses `/analytics/endpoints/logs` (not the removed `logs.all`), polls every 15 minutes so Free plan auth logs (1 hour retention) are not missed, and shows daily active users only where audit retention covers a full day (Pro and above). Run the test project checklist before building.
