# Supabase

Provider id: `supabase`. Verification: documentation only.

StackDash reads your Supabase organization's plan and limits, each project's health, and auth activity: signups, logins, logouts, deleted users, and daily active users. It asks for three read-only scopes, never reads database rows, and stores counts and timestamps only.

All facts below were checked against Supabase's documentation and the Management API OpenAPI spec on 2026-10-31. Anything not confirmed by those sources is marked unverified and listed in [Unverified](#unverified).

## Summary

| Topic | Answer |
|---|---|
| Authentication | OAuth 2.0 authorization code flow with PKCE, through a Supabase OAuth app. No API key or personal access token path |
| Scopes | `organizations:read`, `projects:read`, `analytics:read`. Never `database:read` |
| Read-only | Yes. All three scopes are read scopes |
| Spend or invoices | Unavailable. No billing endpoint carries an OAuth scope |
| Auth activity | Yes, through the logs endpoint, source `auth_audit_logs` |
| Webhooks | None. Polling only |
| Rate limit | 120 requests per minute per endpoint per project or organization, shared by every user of the OAuth app |
| Biggest constraint | Auth audit logs are kept for 1 hour on the Free plan, so StackDash polls every 15 minutes and cannot count daily active users on Free |

### Correction to the original plan

StackDash queries `GET /v1/projects/{ref}/analytics/endpoints/logs`. The older `GET /v1/projects/{ref}/analytics/endpoints/logs.all` was removed on 2026-09-23 and now always returns `410 Gone` ([changelog](https://supabase.com/changelog/48235-migration-of-supabase-management-api-logs-all-analytics-endpoint-to-logs-endpoint), OpenAPI operation `v1-get-project-logs-all`), so StackDash never calls it. The `logs` endpoint takes ClickHouse SQL against one unified `logs` table, with the same `analytics:read` scope and the same 24 hour window rule.

## Connection

### Endpoints

| Step | Request | Notes |
|---|---|---|
| Authorize | `GET https://api.supabase.com/v1/oauth/authorize` | Browser redirect |
| Token | `POST https://api.supabase.com/v1/oauth/token` | `application/x-www-form-urlencoded` |
| Revoke | `POST https://api.supabase.com/v1/oauth/revoke` | `application/json`, returns `204` |

The OpenAPI spec marks all three as Beta and "experimental", so they may change. StackDash treats any unexpected status as an error.

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

StackDash does not send `scope`. The guide marks it deprecated: scopes are set on the OAuth app itself. Supabase strongly recommends PKCE, and StackDash always uses it.

On consent, Supabase redirects to `redirect_uri` with `code` and `state`. StackDash checks `state` against the stored value before anything else.

### Token exchange

Form body: `grant_type=authorization_code`, `code`, `redirect_uri` (byte-for-byte the same as in the authorize step), `code_verifier`. Client credentials go in an HTTP Basic `Authorization` header (`client_id:client_secret`), as the guide shows. The spec also accepts `client_id` and `client_secret` as form fields.

Response (OpenAPI `v1-exchange-oauth-token`): `access_token` (string), `refresh_token` (string), `expires_in` (integer, seconds), `token_type` (`"Bearer"`). `access_token`, `expires_in`, and `token_type` are required in the schema; `refresh_token` is optional in the schema but is returned for the authorization code grant per the guide.

### Token lifetimes and refresh

- The Management API reference says OAuth tokens are "short-lived". No exact access token or refresh token lifetime is documented. StackDash computes expiry from `expires_in` at exchange time, never from a hard-coded value.
- StackDash refreshes with `POST /v1/oauth/token`, `grant_type=refresh_token`, `refresh_token`, and the same Basic client credentials.
- Whether refresh tokens rotate is not documented. StackDash stores the `refresh_token` from a refresh response when one is present, and keeps the old one only if none is returned.
- If the user revokes the app, refresh fails and access tokens stop working. The guide says to handle `401 Unauthorized` on every call. StackDash treats a `401` on any call, refresh included, as a revoked grant: the connection is marked as needing reconnection and the call is not retried.

### Revoke

On disconnect, StackDash calls `POST /v1/oauth/revoke` with JSON `{ "client_id", "client_secret", "refresh_token" }`. A `204` means the app authorization and its tokens are revoked. StackDash then deletes the stored tokens, even when the revoke call fails.

### Scopes and why

Scopes are configured on the OAuth app, not per request. Changing them later forces every connected user through the OAuth flow again ([OAuth scopes](https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration/oauth-scopes)). Choose them once.

| Scope | Endpoints StackDash uses (scope from the OpenAPI `x-oauth-scope` of each operation) |
|---|---|
| `organizations:read` | `GET /v1/organizations`, `GET /v1/organizations/{slug}`, `GET /v1/organizations/{slug}/entitlements` |
| `projects:read` | `GET /v1/organizations/{slug}/projects`, `GET /v1/projects/{ref}`, `GET /v1/projects/{ref}/health` |
| `analytics:read` | `GET /v1/projects/{ref}/analytics/endpoints/logs` |

`organizations:read` also unlocks `GET /v1/organizations/{slug}/members`, which returns member `email`, `user_id`, and `user_name`. StackDash never calls it. `projects:read` also unlocks `GET /v1/projects`, and `analytics:read` also unlocks `GET /v1/projects/{ref}/analytics/endpoints/metrics`. StackDash calls neither.

#### Why never `database:read`

`database:read` unlocks `POST /v1/projects/{ref}/database/query/read-only`, which runs arbitrary SQL "as supabase_read_only_user". In Supabase's Postgres init script that role is created `with login bypassrls` and granted `pg_read_all_data` ([initial schema](https://raw.githubusercontent.com/supabase/postgres/develop/migrations/db/init-scripts/00000000000000-initial-schema.sql), lines 19 and 20). It reads every row of every table, row level security ignored, including `auth.users` emails and phone numbers. The optional `auth.audit_log_entries` table is only reachable this way too. StackDash needs counts, not rows, so it does not request this scope.

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
- `GET /v1/projects` lists all projects with `ref`, `organization_slug`, `name`, `region`, `created_at`, `status`, and `database` (`host`, `version`, `postgres_engine`, `release_channel`). No pagination parameters are documented. StackDash does not call it.
- `GET /v1/projects/{ref}` returns one project in the same shape. StackDash reads its `name`, `status`, and `organization_slug` on every sync.

At connect time StackDash lists projects with the organization-scoped endpoint (`limit=100`, `sort=name_asc`): it is paginated and its rate limit is tracked per organization, while `GET /v1/projects` and `GET /v1/organizations` are tracked per caller (see [Rate limits](#rate-limits)). It reads up to 25 organizations and 10 pages per organization, skips preview branches (`is_branch`), and offers each remaining project as an account. A sync skips health and logs while the project's `status` is `INACTIVE` (paused). Free projects pause after 1 week of inactivity ([pricing](https://supabase.com/pricing)).

### Plan and entitlements

- `GET /v1/organizations/{slug}` returns `id`, `name`, `plan` (`free`, `pro`, `team`, `enterprise`, `platform`), `opt_in_tags`, `allowed_release_channels`. StackDash reads `plan` only.
- `GET /v1/organizations/{slug}/entitlements` returns `entitlements[]`, each with `feature.key`, `feature.type` (`boolean`, `numeric`, `set`), `hasAccess`, `type`, and `config`. A numeric `config` has `enabled`, `value`, `unlimited`, `unit`.

StackDash reads both on every sync. The spec lists the internal permission `organization_admin_read` for both, so a member without the owner or admin role may get a `403`. That does not stop the sync: StackDash skips the limits it cannot read and reports the missing permission. Without a readable plan and audit retention, StackDash assumes the Free plan's 1 hour retention.

Keys StackDash reads (from the documented enum). Each one the organization has access to, enabled and not unlimited, is stored as an included allowance metric:

| Key | Metric key | Use |
|---|---|---|
| `security.audit_logs_days` | `supabase.plan.audit_log_retention` | Auth audit log retention. Sets how far back a log window may start and whether daily active users are counted. A value below 1 day is not stored |
| `log.retention_days` | `supabase.plan.log_retention` | API and database log retention |
| `function.max_count` | `supabase.plan.edge_functions` | Edge Function count limit |
| `realtime.max_concurrent_users` | `supabase.plan.realtime_concurrent_users` | Realtime limit |
| `storage.max_file_size` | `supabase.plan.storage_max_file_size` | Storage limit. Stored only when Supabase gives a usable unit |

No entitlement key covers database size, egress, or monthly active users. Those plan limits appear only on the [pricing page](https://supabase.com/pricing): Free has 500 MB database size per project and 50,000 MAU; Pro and Team include 8 GB disk per project and 100,000 MAU. StackDash stores these as included allowance metrics labeled estimated, with the pricing page and the date checked as the source: `supabase.plan.database_size` (Free), `supabase.plan.disk_size` (Pro and Team), and `supabase.plan.monthly_active_users`. Enterprise and platform limits are custom, so none are stored.

### Project health

`GET /v1/projects/{ref}/health?services=auth,db,rest,storage,realtime&timeout_ms=2000`

- `services` is required: a comma-separated list from `auth`, `db`, `db_postgres_user`, `pooler`, `realtime`, `rest`, `storage`, `pg_bouncer`.
- `timeout_ms` is optional.
- Response: an array of `{ name, status, info?, error? }`, `status` one of `COMING_UP`, `ACTIVE_HEALTHY`, `UNHEALTHY`. `healthy` (boolean) is deprecated; StackDash reads `status`.

StackDash keeps no per-service status. It turns changes in the readings into health events (see Timeline events below).

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
| `user_signedup` | New user registration | "New signup" timeline event, one per row; daily count |
| `login` | User sign-in attempt | Daily login count; daily active users |
| `logout` | User sign-out | Daily count |
| `user_deleted` | User account deleted | Daily count |
| `token_refreshed` | Refresh token used to obtain new tokens | Daily active users only |

The docs warn "there may be a short delay before logs appear". StackDash ends every window 5 minutes in the past, rounded down to the minute, so late events are not missed.

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

If the signup query returns the full `limit`, StackDash splits the window in half and queries each half, at most two levels deep. If a quarter window still returns the full `limit`, the extra signups are missing from the timeline, but the daily count still comes from `count()`.

Daily active users, aggregated by ClickHouse so no user id leaves Supabase:

```sql
select uniqExact(log_attributes['auth_audit_event.actor_id']) as active_users
from logs
where source = 'auth_audit_logs'
  and log_attributes['auth_audit_event.action'] in ('login', 'token_refreshed')
limit 1
```

The changelog's examples filter on `source_name`, while the current query guide and field reference use `source`. StackDash uses `source`; this is not confirmed against a live project.

#### Windows and daily active users

- Event counts add up across windows, so the daily "N logins" figure is the sum of every poll window in the UTC day.
- Distinct users do not add up. An exact daily active user count needs one query over the whole UTC day (`00:00:00Z` to the next `00:00:00Z`, exactly 24 hours), run after the day ends and while that day is still retained.
- That works when `security.audit_logs_days` is at least 1 (Pro: 7 days, Team: 28 days). StackDash runs the query when the day's last window closes and stores the result as `supabase.auth.daily_active_users` (unit `users`, the UTC day as the period).
- On the Free plan, auth audit logs are kept for 1 hour, so no full-day query is possible. Summing hourly distinct counts overstates the figure, and keeping ids to deduplicate breaks the privacy rule. On Free, StackDash stores no daily active users and the daily summary says why ("Supabase keeps auth logs for 1 hour on the Free plan."). Logins and signups are shown as normal. When the audit retention cannot be read, StackDash does the same and says it could not read how long the organization keeps auth logs.

### Usage and database size

| Metric | Reachable with these scopes | Label |
|---|---|---|
| Spend, invoices, credits | No. No billing endpoint has an OAuth scope (`GET /v1/projects/{ref}/billing/addons` lists none) | Unavailable |
| Monthly active users (billed MAU) | No endpoint | Unavailable |
| Database size in use | Not read. `GET /v1/projects/{ref}/analytics/endpoints/metrics` (`analytics:read`) returns Prometheus text with about 200 series, and Supabase's own Grafana dashboard charts `pg_database_size_mb` from this feed ([supabase-grafana](https://github.com/supabase/supabase-grafana)). The pricing page lists the metrics endpoint as not included on Free, and it returns `400` when the project is not active and healthy. StackDash does not call it | Unavailable |
| Provisioned disk | `databases[].disk_volume_size_gb` from the organization projects list (`projects:read`). This is the disk size, not data in use. StackDash does not read it | Not read |
| API request counts | `GET /v1/projects/{ref}/analytics/endpoints/usage.api-counts` (`interval` from `15min` to `7day`, returns `total_auth_requests`, `total_rest_requests`, `total_storage_requests`, `total_realtime_requests` per timestamp). The spec lists no OAuth scope for it. StackDash does not call it | Not read |
| Disk utilization | `GET /v1/projects/{ref}/config/disk/util` exists but lists no OAuth scope | Unavailable for OAuth [inference], not read |

The metrics endpoint is the only documented path to database size in use with these scopes. StackDash does not call it, so it does not show database size in use.

### Timeline events (by polling)

| Event | Endpoint | Rule |
|---|---|---|
| `supabase.auth.signup` (New signup) | Logs, signup query | One per `user_signedup` row, at the event's time. Only the time is kept |
| `supabase.auth.daily_summary` (Daily auth summary) | Logs, counts query and daily active users query | One per project per UTC day, after the day's last window: logins, signups, logouts, deleted users, and daily active users where available. Says when part of the day was not counted |
| `supabase.project.unhealthy` (Project unhealthy) | Health | When a checked service reports `UNHEALTHY` and the last reading was not unhealthy. Names the unhealthy services. A first reading that is unhealthy also counts |
| `supabase.project.healthy` (Project healthy again) | Health | When every checked service reports `ACTIVE_HEALTHY` after an unhealthy reading. A first healthy reading creates no event, and `COMING_UP` changes nothing |

Each health event is kept at most once per project, state, and UTC day.

### Verified, estimated, unavailable

| Metric | Unit, period | Label |
|---|---|---|
| Signups, logins, logouts, deleted users | count per UTC day, plus one timestamp per signup | Verified (provider-reported log events) |
| Daily active users | count per UTC day | Verified on Pro and above; unavailable on Free |
| Plan | `free`, `pro`, `team`, `enterprise`, `platform` | Verified. Used to choose the plan limits and the audit retention; not stored itself |
| Entitlements (log retention, function count, realtime limits) | as given by `unit` | Verified |
| Plan limits not in entitlements (database size on Free, disk on Pro and Team, MAU) | MB or GB, users | Estimated (pricing page constant) |
| Project health | event when it changes | Verified |
| Database size in use | | Unavailable |
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
- Every 15 minutes, StackDash syncs each connected project:
  1. The project (`GET /v1/projects/{ref}`), then its organization and entitlements (two calls).
  2. Unless the project is paused: health (one call), then auth counts and signup timestamps for each window since the last successful poll (two log queries per window, more when the signup query is split).
  3. After a UTC day's last window: the full-day daily active users query (Pro and above).
- Projects are listed only at connect time, so a project created later appears after reconnecting.
- Windows are non-overlapping, from the previous window's end to now minus a settle lag of 5 minutes, and never cross UTC midnight. A 15 minute interval with a 5 minute lag keeps every window well inside the 1 hour Free retention, and leaves room for one missed cycle. On Free, a window never starts more than about 45 minutes before the settle point: when a project falls further behind, StackDash starts at the oldest retained minute and marks that day's summary as a partial day rather than claiming zero events.
- The first sync starts at the start of the current UTC day, or at the oldest retained minute if that is later, and marks the day partial when it starts late. One sync covers at most 8 windows; the rest wait for the next sync.
- The interval is 15 minutes on every plan, including Pro and above, where `security.audit_logs_days` would allow longer.

### Rate limits

From the [Management API reference](https://supabase.com/docs/reference/api/introduction#rate-limits):

- 120 requests per minute, per project or organization, per endpoint.
- For OAuth apps the identifier is the OAuth app id, so the limit is shared by everyone calling through the app. For a hosted StackDash, every user who connects the same Supabase project shares that project's budget.
- Calls without a project or organization in the path (`GET /v1/projects`, `GET /v1/organizations`) are tracked on the identifier alone. Reading the docs, for an OAuth app this is one budget for the whole app across all users [inference]. StackDash calls `GET /v1/organizations` only at connect time and never calls `GET /v1/projects`.
- Analytics endpoints are stricter. The exceptions table lists 30 requests per minute for `logs.all`, `usage.api-counts`, and `usage.api-requests-count`. It does not list the new `logs` endpoint, so its limit is unverified. A normal sync sends two log queries per project.
- Over the limit, every call returns `429` for the rest of the minute. Responses carry `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (seconds). On a `429`, StackDash retries the sync after `Retry-After`, or after `X-RateLimit-Reset` when that is the only one given.

### Log query allowance

Logs Query is not billed, but each organization gets an allowance of 100 times its log ingest (Free: 100 GB) ([logs query usage](https://supabase.com/docs/guides/platform/manage-your-usage/logs-query)). The docs warn that scheduled polling rescans data on every run. Once enforcement starts (not yet, per the docs), going over means the next month is degraded: 10 queries per minute and log retention cut to 1 hour on Free or 24 hours on paid plans, and a second month over cuts off log access. In normal running each window is one poll interval long, and every query filters on the source. The `402` status on the logs endpoint is the likely signal; StackDash reports it as a sync error saying the Logs Query allowance is exceeded.

### Retention per plan

From the [pricing comparison](https://supabase.com/pricing):

| Plan | Auth audit logs | API and database logs | Fits a 15 minute poll |
|---|---|---|---|
| Free | 1 hour | 1 day | Yes, with little slack |
| Pro | 7 days | 7 days | Yes |
| Team | 28 days | 28 days | Yes |
| Enterprise | Included (custom) | 90 days | Yes |

## Privacy

- StackDash stores counts and timestamps only. Never emails, phone numbers, IP addresses, user agents, Supabase user ids, actor names, or log row ids.
- It never selects an identifying column. Daily active users are counted with `uniqExact()` inside the query, so ids never reach StackDash.
- It parses `result` with zod schemas that accept only the expected aggregate columns (`action`, `events`, `timestamp`, `active_users`), and rejects anything else instead of storing it.
- It does not log raw responses from the logs endpoint.
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

From documentation, not recorded. Shapes follow the OpenAPI schemas; values are synthetic. The adapter's test fixtures follow the same shapes and are synthetic too.

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

The documented audit log event format, shown only to make clear what StackDash does not store ([auth audit logs](https://supabase.com/docs/guides/auth/audit-logs)):

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

## Unverified

Not yet confirmed against a Free and a Pro organization. Until they are, StackDash follows the documented behavior described on this page.

- Whether auth audit events appear in the logs endpoint under source `auth_audit_logs`, with the action in `log_attributes['auth_audit_event.action']` and the user in `auth_audit_event.actor_id`, and whether they are recorded without turning on "Write audit logs to the database".
- `source` (query guide, used by StackDash) versus `source_name` (changelog) as the filter column.
- That `logs` works with an OAuth token holding `analytics:read`.
- The rate limit for `GET /v1/projects/{ref}/analytics/endpoints/logs`. Only `logs.all` (30 per minute) is listed.
- Access and refresh token lifetimes, and refresh token rotation. Not documented.
- That the Free plan keeps auth audit logs for 1 hour, and how that is expressed in `security.audit_logs_days`.
- Whether `login` counts failed attempts (the docs say "sign-in attempt"), which would inflate login counts.
- Whether a token spans one organization or all of the user's organizations, and whether a member without the owner or admin role can authorize the app and read the organization and entitlements (the spec lists the internal permission `organization_admin_read` for both).
- Whether an OAuth app must be published before users outside its organization can authorize it.
- Whether `GET /v1/projects/{ref}/config/disk/util` accepts OAuth tokens. The spec lists no OAuth scope for it.
- Whether the user-scoped rate limit on `GET /v1/projects` and `GET /v1/organizations` is one budget for the whole OAuth app.
- The value types of `count()`, `uniqExact()`, and `timestamp` in the logs `result` array. StackDash accepts a number or a string for counts, and an ISO string or epoch microseconds for `timestamp`.
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

Go. StackDash reads the organization's plan limits, each project's health, and auth activity through `/analytics/endpoints/logs`, polling every 15 minutes. The limits a user trips on: on the Free plan, auth audit logs are kept for 1 hour, so daily active users are unavailable and a project more than about 45 minutes behind records a partial day. A member without the owner or admin role may be refused the plan and limits; health and auth activity still sync. Projects are listed at connect time, paused projects are skipped, and spend and database size in use are not available.
