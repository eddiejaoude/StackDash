# Resend

Provider id: `resend`. Verification: documentation only. Docs checked 2026-10-31.

StackDash reads your Resend email usage for the day and the month, your plan limits, and when they reset. Resend shares usage only with full access, which also allows sending email and changing your Resend team, so StackDash asks you to agree to that first.

## Go or no-go

**Go for the MVP.** Resend has a documented account usage endpoint, `GET /usage` (released 2026-10-01), that returns daily and monthly email usage, plan limits, and reset times in one call. Remaining allowance is `limit - used`. The catch is the scope: reading usage needs `full_access`, which also lets StackDash send email, delete domains, and change everything else in the Resend team. The connection flow must say so plainly and ask for explicit consent before redirecting.

## Connection

OAuth 2.1 authorization code flow with PKCE (`S256` only). StackDash registers as a **pre-registered confidential client** (`token_endpoint_auth_method: "client_secret_basic"`), because it has a backend that can hold a secret. Resend's guide recommends pre-registration over dynamic registration for remote third-party clients.

| Item | Value |
|---|---|
| Discovery document | `https://api.resend.com/.well-known/oauth-authorization-server` |
| Issuer | `https://api.resend.com` |
| Authorize URL | `GET https://api.resend.com/oauth/authorize` (browser navigation, never fetched server side) |
| Token URL | `POST https://api.resend.com/oauth/token` |
| Revoke URL | `POST https://api.resend.com/oauth/revoke` (RFC 7009) |
| Registration URL | `POST https://api.resend.com/oauth/register` (RFC 7591, unauthenticated, 20 registrations per hour per IP) |
| JWKS | `https://api.resend.com/.well-known/jwks.json` |
| API base URL | `https://api.resend.com` |
| Scopes | `emails:send`, `full_access`. No read-only scope exists |
| Scope StackDash requests | `full_access` |
| Access token | JWT signed with `ES256`, `expires_in: 900` (15 minutes). Cannot be revoked individually |
| Refresh token | Opaque, valid 60 days from when it was last issued, rotates on every use |
| Authorization code | Single use, expires 10 minutes after issue |
| Client secret | Returned once at registration, never expires (`client_secret_expires_at: 0`) |

### Authorize request

Query parameters: `client_id`, `response_type=code`, `redirect_uri` (exact match with a registered URI), `scope=full_access`, `state` (max 1024 characters, required by StackDash even though Resend treats it as optional), `code_challenge`, `code_challenge_method=S256`. Do not send `resource`: it is accepted but ignored.

Resend redirects the browser to its dashboard consent screen, where the user signs in and picks **which team** the app can access. One grant covers one Resend team, so one StackDash connection maps to one Resend team.

The discovery document advertises `authorization_response_iss_parameter_supported: true`. Following [RFC 9207, section 2.4](https://www.rfc-editor.org/rfc/rfc9207#section-2.4), StackDash rejects a callback whose `iss` is missing, empty, or anything other than `https://api.resend.com`, before calling the token endpoint. The Authorize reference lists only `code` and `state` on the redirect, so this rests on the metadata flag alone (see Unverified).

Error handling on authorize has two shapes, and the callback must not assume it always receives an error redirect:

- Before `client_id` and `redirect_uri` are validated, Resend returns a JSON error body. The user never comes back to StackDash.
- After validation, Resend redirects errors (`error`, `error_description`, `state`) to `redirect_uri` only for loopback, private-use scheme, or **verified** clients. An unverified `https` client gets a JSON error page instead. Resend has no self-service verification yet, so StackDash should expect the JSON page for authorize errors and treat a missing callback as an abandoned connection.

### Token exchange

Form encoded (`application/x-www-form-urlencoded`), client authenticated with HTTP Basic (`client_id:client_secret`). Body: `grant_type=authorization_code`, `code`, `redirect_uri` (same value as the authorize request), `code_verifier` (43 to 128 characters from `A-Z a-z 0-9 - . _ ~`). Sending both a Basic header and a body `client_secret` fails with `invalid_request`.

### Refresh and rotation

Body: `grant_type=refresh_token`, `refresh_token`, optional `scope` (subset only, cannot escalate). Every successful refresh returns a new refresh token and the old one stops working.

- **Serialize refreshes per connection** (row lock or single flight). Replaying an old refresh token fails with `invalid_grant` and also **revokes the whole grant**, unless the rotation happened in the last minute. Do not rely on that window.
- Persist the new refresh token atomically with the new access token before using either. If a refresh succeeds and the new token is not saved, the user has to reconnect.
- Each refresh restarts the 60 day lifetime, so a connection that syncs at least every few days never expires. A connection idle for 60 days needs reauthorization.
- `invalid_grant` on refresh means the grant is gone (revoked by the user, reuse detected, or expired). Mark the connection as needing reconnection; do not retry.

Token errors: `400 invalid_request`, `400 invalid_scope`, `400 invalid_grant`, `400 unauthorized_client`, `401 invalid_client`. These use the OAuth error shape `{ "error", "error_description" }`, not Resend's usual API error shape.

### Disconnect

- From StackDash: `POST /oauth/revoke` with Basic auth and body `token=<refresh token>&token_type_hint=refresh_token`. This revokes the whole grant, including access tokens already issued. It always returns `200` with an empty body. `token_type_hint=access_token` is rejected.
- From Resend: users can review and revoke any app's access in their Resend team settings (changelog wording; exact dashboard path not documented). Team API keys can also list grants (`GET /oauth/grants`) and revoke one (`DELETE /oauth/grants/:id`).

### API calls

Every request needs `Authorization: Bearer <access token>` and a `User-Agent` header. Requests without `User-Agent` are blocked with `403` and error code `1010` before they reach the API. Set something like `StackDash/<version>`.

A token missing a required scope gets `403 invalid_permission` ("Access token is missing required scopes").

## Data

All endpoints below need `full_access`. Only send routes (`POST /emails`, `POST /email`, `POST /emails/sending`, `POST /email/sending`, `POST /broadcasts/:broadcastId/send`) accept `emails:send`.

### Primary: `GET /usage`

One request returns current usage and limits across every quota on the team.

| Field | Meaning | Unit and period |
|---|---|---|
| `emails.daily.used` | Emails counted against the daily quota (sent plus received) | emails, current day |
| `emails.daily.sent`, `emails.daily.received` | Split of `used` | emails, current day |
| `emails.daily.limit` | Daily cap. `null` once the team has a paid sending subscription (daily caps are Free plan only) | emails per day |
| `emails.daily.resets_at` | When the daily window resets | ISO 8601 UTC |
| `emails.monthly.used`, `.sent`, `.received` | Same, for the month | emails, current month |
| `emails.monthly.limit` | Monthly plan quota. Documented as always a number | emails per month |
| `emails.monthly.resets_at` | When the monthly window resets | ISO 8601 UTC |
| `contacts.used`, `contacts.limit` | Marketing contacts against plan | contacts |
| `segments.used`, `segments.limit` | `limit` is `null` with a paid contacts subscription | segments |
| `broadcasts.used`, `broadcasts.limit` | `limit` is always `null` | broadcasts |
| `domains.used`, `domains.limit` | `limit` is `null` when the plan has no domain cap | domains |
| `automation_runs.used`, `.limit`, `.resets_at` | Automation runs this period | runs |
| `ai_credits.used`, `.limit`, `.next_increase_at` | AI credits in a rolling window | credits |
| `rate_limit.limit`, `rate_limit.duration` | Team API rate limit, `duration` is a string such as `"1000ms"` | requests per duration |

A `limit` of `null` means no cap on that resource for the plan. Show "no limit", never `0` or infinity.

Use `resets_at` from the response for the reset date. Do not compute it: the docs disagree on the window shape (see Unverified).

Every quota counts both sent and received (inbound) email, and each `To`, `CC`, and `BCC` recipient counts as a separate email.

### Secondary: `GET /emails/metrics`

Account level delivery and engagement counts, released 2026-08-27. Optional query: `start_date`, `end_date` (ISO 8601 date or datetime), `timezone` (IANA, default UTC), `granularity` (`hourly | daily | weekly | monthly`, default `daily`), `metrics` (list), `dimensions` (`period`, `domain`, `email`, `broadcast`), `domain_id`, `email_id`, `broadcast_id`. With no parameters it returns `totals` for the last 7 days.

Useful metrics for StackDash: `sent`, `delivered`, `bounced`, `complained`, `failed`, `suppressed`, `delivery_rate`, `bounce_rate`, `complaint_rate`. Counts are integers. Rates are percentages as numbers (for example `50.0`), not fractions.

- Responses are cached for up to 15 minutes.
- Data is retained 30 days on Free, Pro, and Scale. Older `start_date` values are clamped to the oldest retained date.
- `sent` here counts emails handed to recipient mail servers. It is not the quota count: quota includes received email and per-recipient counting. Show quota from `/usage` and delivery from `/emails/metrics`, and never mix the two.

### Domains: `GET /domains`

Returns all domains in one response when `limit` is omitted (max 100 per page with `limit`, cursor pagination via `after` or `before`). Fields per domain: `id`, `name`, `status`, `created_at`, `region`, `open_tracking`, `click_tracking`, `capabilities.sending`, `capabilities.receiving`.

Domain `status` values: `not_started`, `pending`, `verified`, `partially_verified`, `partially_failed`, `failed` (DNS records not found within 72 hours), `temporary_failure` (a verified domain whose records disappeared; Resend rechecks for 72 hours, then moves it to `verified` or `failed`).

`created_at` uses a Postgres style timestamp (`2026-04-26 20:21:26.347412+00`), not strict ISO 8601. Parse it explicitly and store as UTC.

### Quota response headers

Documented on the usage limits page, returned by the API:

| Header | Meaning |
|---|---|
| `x-resend-daily-quota` | Used daily email quota. Only sent to Free plan users |
| `x-resend-monthly-quota` | Used monthly email quota |
| `ratelimit-limit`, `ratelimit-remaining`, `ratelimit-reset`, `retry-after` | Rate limit state (IETF draft 6). `ratelimit-reset` and `retry-after` are seconds |

The quota headers carry used counts only, no limit or reset. `/usage` replaces them; the adapter does not need them. Honor the rate limit headers on every call.

### Timeline events (by polling)

Resend has no event feed that StackDash can poll for account activity. The adapter derives events by comparing each sync with the previous snapshot:

| Event | Source | Rule |
|---|---|---|
| Daily or monthly quota near limit | `/usage` | `used / limit` crosses a threshold (for example 80% and 100%) in the current window. Skip when `limit` is `null` |
| Quota reset | `/usage` | `resets_at` moved forward since the last sync |
| Monthly overage | `/usage` | `monthly.used > monthly.limit` on a paid plan (paid plans keep sending with pay as you go overage, hard capped at 5x the monthly quota, then sending pauses until the next billing cycle) |
| Domain verified, failed, or at risk | `/domains` | `status` changed, especially into `verified`, `failed`, or `temporary_failure` |
| Domain added or removed | `/domains` | `id` appeared or disappeared |
| Bounce rate high | `/emails/metrics` | `bounce_rate` at or above 4% (Resend may pause sending above 4%) |
| Complaint rate high | `/emails/metrics` | `complaint_rate` at or above 0.08% (Resend may pause sending above 0.08%) |

## Achievements

StackDash evaluates these for each project the Resend accounts are assigned to, from the Resend data it has stored, after each sync (see [Achievements](../adapters.md#achievements)). A project earns each one once, and it stays private until an owner or admin publishes it.

Both count `resend.domain.verified` events.

| Id | Title | How it is earned |
|---|---|---|
| `resend.domains.first` | First Resend domain verified | Earned when StackDash records the first verified Resend domain. |
| `resend.domains.collector` | Domain collector: 3 domains verified | Earned when StackDash records the 3rd verified Resend domain. |

## Verified, estimated, unavailable

| Data | Status | Source |
|---|---|---|
| Emails used today and this month (sent and received split) | Verified | `GET /usage` |
| Daily limit (Free plan) and monthly limit | Verified | `GET /usage` |
| Remaining allowance | Verified (derived as `limit - used`, floor at 0, shown as overage when negative) | `GET /usage` |
| Reset date for daily and monthly windows | Verified | `GET /usage` `resets_at` |
| Contacts, segments, domains, automation runs against limits | Verified | `GET /usage` |
| Team API rate limit | Verified | `GET /usage` `rate_limit` |
| Delivery, bounce, complaint counts and rates | Verified, up to 15 minutes stale | `GET /emails/metrics` |
| Domain verification status | Verified | `GET /domains` |
| Plan name and tier | Unavailable. Not in any response. Cannot be derived from `monthly.limit` alone (Pro and Scale both offer 100,000 emails per month) | None |
| Spend, invoices, overage charges | Unavailable. No billing API; invoices are dashboard only | None |
| Overage cost estimate | Unavailable for the MVP. Would need the plan price, which is not exposed. Do not estimate | None |
| History older than 30 days | Unavailable from Resend. StackDash keeps its own snapshots | None |

## Rate limits

- Default 10 requests per second **per team**, shared with every API key and app on that team. No burst allowance: the 11th request in a one second window gets `429 rate_limit_exceeded`.
- StackDash shares the user's budget, so a sync must stay small: one `/usage`, one `/domains`, one or two `/emails/metrics` calls per sync. Run them sequentially, honor `retry-after`, and back off on `429`.
- Quota errors also return `429`, with `daily_quota_exceeded` or `monthly_quota_exceeded`. These only come from send routes, which StackDash never calls. If seen, treat them as data, not as a rate limit.
- Client registration is limited to 20 per hour per IP.

## Plan restrictions

- Free: 100 emails per day (UTC day, midnight UTC reset) and 3,000 per month, 1,000 marketing contacts, 3 domains, 3 inboxes, no overage.
- Pro and Scale: no daily cap, monthly quota by tier, pay as you go overage hard capped at 5x the monthly quota. Pro includes 10 domains, Scale 1,000.
- Data retention: 30 days on Free, Pro, and Scale; flexible on Enterprise.
- OAuth and `/usage` are not documented as plan restricted.

## Webhooks

Not received yet; planned, through the shared webhook route (see [Webhooks](../adapters.md#webhooks)), set up automatically with the `full_access` StackDash already holds or by hand, with polling kept as the backfill. Notes:

- Event types include `email.sent`, `email.delivered`, `email.bounced`, `email.complained`, `email.failed`, `email.suppressed`, `domain.created`, `domain.updated`, `domain.deleted`, `contact.*`, `suppression.*`, and inbox events.
- Signed with Svix: headers `svix-id`, `svix-timestamp`, `svix-signature` (`v1,<base64>`). Verify against the raw request body with the per-webhook signing secret, using `resend.webhooks.verify` or the `svix` library. Reject stale timestamps to block replays.
- Webhooks can be created through the API (`POST /webhooks`), which needs `full_access`. Creating one in the user's team is a visible change to their account and needs its own consent copy.
- No quota or usage webhook exists. Quota near limit stays a polling job.

## Permission risks

`full_access` is the only scope that can read usage. It is not read-only. Resend documents it as required for, and sufficient for, every API route, so a `full_access` token can do what a full access API key can, including:

- Send email as the user's verified domains, including broadcasts to their contacts.
- Delete domains, contacts, segments, templates, broadcasts, webhooks, and inboxes.
- Create and delete API keys.
- Read sent and received email content and attachments, and the contact list.
- List and revoke OAuth grants on the team (documented for team API keys; assumed to apply to a `full_access` token too).

StackDash only calls `GET /usage`, `GET /emails/metrics`, and `GET /domains`. That is a code promise, not a technical limit. The consent copy must say this plainly before the redirect, for example:

> Resend only offers full access for reading usage. StackDash will be able to send email and change or delete anything in this Resend team. StackDash only reads usage, metrics, and domains, and you can revoke access at any time in your Resend team settings.

Mitigations: store tokens encrypted at rest, never log tokens or `Authorization` headers, keep the adapter's HTTP client restricted to the three GET paths, request `full_access` only (never let the scope default by omitting it).

## Limitations

- No read-only scope. See Permission risks.
- No spend, invoice, or plan name data.
- No endpoint that names the connected team. The consent screen picks the team, but no documented API returns its id or name. Label the connection from user input or from the first domain name.
- Metrics are cached up to 15 minutes and retained 30 days.
- No API versioning yet; Resend plans calendar based version headers. Parse every response with zod and fail loudly on shape changes.
- Authorize errors for an unverified `https` client land on a Resend JSON page, not the StackDash callback.
- Refresh token reuse revokes the grant. A bug in refresh serialization disconnects the user.

## Self-hosted registration

Every StackDash deployment registers its own client, because the redirect URI and secret belong to one deployment. Resend has no dashboard page for creating OAuth clients yet; registration is one API call.

1. Pick the deployment's public URL, `<SITE_URL>`. The redirect URI is `<SITE_URL>/api/connections/resend/callback`. It must be `https` (plain `http` is only allowed for loopback addresses, so local development uses `http://127.0.0.1:<port>/api/connections/resend/callback` or `http://localhost:<port>/...`, registered as a separate URI; loopback URIs may vary the port).
2. Register a confidential client:

   ```bash
   curl -X POST 'https://api.resend.com/oauth/register' \
        -H 'Content-Type: application/json' \
        -H 'User-Agent: StackDash-setup/1.0' \
        -d '{
     "client_name": "StackDash",
     "client_uri": "<SITE_URL>",
     "logo_uri": "<SITE_URL>/logo.png",
     "redirect_uris": ["<SITE_URL>/api/connections/resend/callback"],
     "grant_types": ["authorization_code", "refresh_token"],
     "response_types": ["code"],
     "token_endpoint_auth_method": "client_secret_basic",
     "scope": "full_access"
   }'
   ```

   Up to 10 redirect URIs, each up to 2048 characters, no fragments.
3. Copy `client_id` and `client_secret` from the response immediately. The secret is shown once; Resend stores only a hash. If it is lost, register a new client.
4. Set the environment variables:

   ```
   RESEND_CLIENT_ID=<client_id>
   RESEND_CLIENT_SECRET=<client_secret>
   ```

   `RESEND_CLIENT_SECRET` is server only. Never expose it to the browser.
5. Changing the redirect URI later means registering a new client: no update endpoint for clients is documented.

## Sample responses

From documentation, not recorded. Trimmed. Identifiers are the documentation's synthetic values; tokens are shown as placeholders.

`POST /oauth/token` (authorization code or refresh):

```json
{
  "access_token": "<access-token>",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "<refresh-token>",
  "scope": "emails:send"
}
```

`POST /oauth/register` (confidential client):

```json
{
  "client_id": "550e8400-e29b-41d4-a716-446655440000",
  "client_id_issued_at": 1750000000,
  "client_name": "Example OAuth Client",
  "redirect_uris": ["http://127.0.0.1/oauth/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "client_secret_basic",
  "scope": "emails:send",
  "client_secret": "3vProAFw7...store-this-now...KpQ",
  "client_secret_expires_at": 0
}
```

`GET /usage`:

```json
{
  "object": "usage",
  "emails": {
    "daily": { "used": 10, "limit": 100, "sent": 8, "received": 2, "resets_at": "2026-07-29T00:00:00.000Z" },
    "monthly": { "used": 100, "limit": 3000, "sent": 80, "received": 20, "resets_at": "2026-08-01T00:00:00.000Z" }
  },
  "contacts": { "used": 10, "limit": 3000 },
  "segments": { "used": 1, "limit": 3 },
  "broadcasts": { "used": 2, "limit": null },
  "ai_credits": { "used": 5, "limit": 100, "next_increase_at": null },
  "automation_runs": { "used": 3, "limit": 10000, "resets_at": "2026-08-01T00:00:00.000Z" },
  "domains": { "used": 1, "limit": 1 },
  "rate_limit": { "limit": 1000, "duration": "1000ms" }
}
```

`GET /emails/metrics?start_date=2026-07-01&end_date=2026-07-08&metrics=sent,delivered,open_rate&dimensions=period,domain`:

```json
{
  "object": "metrics",
  "start_date": "2026-07-01T00:00:00.000Z",
  "end_date": "2026-07-08T00:00:00.000Z",
  "metrics": ["sent", "delivered", "open_rate"],
  "dimensions": ["period", "domain"],
  "granularity": "daily",
  "totals": { "sent": 1204, "delivered": 1180, "open_rate": 50.0 },
  "data": [
    {
      "period": "2026-07-01",
      "domain_id": "d91cd9bd-1176-4f47-2a4b-fce2d5399cbf",
      "domain_name": "example.com",
      "sent": 172,
      "delivered": 169,
      "open_rate": 49.7
    }
  ]
}
```

`GET /domains`:

```json
{
  "object": "list",
  "has_more": false,
  "data": [
    {
      "id": "d91cd9bd-1176-453e-8fc1-35364d380206",
      "name": "example.com",
      "status": "not_started",
      "created_at": "2026-04-26 20:21:26.347412+00",
      "region": "us-east-1",
      "open_tracking": true,
      "click_tracking": false,
      "capabilities": { "sending": "enabled", "receiving": "disabled" }
    }
  ]
}
```

`GET /.well-known/oauth-authorization-server` (fetched 2026-10-31, no credentials involved):

```json
{
  "issuer": "https://api.resend.com",
  "authorization_endpoint": "https://api.resend.com/oauth/authorize",
  "token_endpoint": "https://api.resend.com/oauth/token",
  "jwks_uri": "https://api.resend.com/.well-known/jwks.json",
  "registration_endpoint": "https://api.resend.com/oauth/register",
  "revocation_endpoint": "https://api.resend.com/oauth/revoke",
  "scopes_supported": ["full_access", "emails:send"],
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "token_endpoint_auth_methods_supported": ["none", "client_secret_basic", "client_secret_post"],
  "code_challenge_methods_supported": ["S256"],
  "client_id_metadata_document_supported": true,
  "authorization_response_iss_parameter_supported": true
}
```

## Unverified

Confirm with a test account before the adapter ships:

1. An OAuth `full_access` access token can call `GET /usage`. The changelog only says "with a full access API key"; the authorize docs say `full_access` covers every non-send route.
2. Daily window shape. The `/usage` reference calls it a "rolling 24-hour quota", while the usage limits page, the quotas page, and the error docs say it is a UTC calendar day that resets at midnight UTC. The sample `resets_at` is midnight UTC. Use `resets_at` as returned either way.
3. Monthly window shape. The `/usage` reference says "calendar-month"; the overage docs say sending pauses "until the next billing cycle". Check whether `monthly.resets_at` is the first of the month or the billing anniversary on a paid plan.
4. The `rate_limit` sample (`1000` per `1000ms`) conflicts with the documented default of 10 requests per second. Check the real value on a default team.
5. Whether `monthly.used` keeps counting past `monthly.limit` during paid overage.
6. Whether `x-resend-daily-quota` and `x-resend-monthly-quota` appear on GET responses or only on send responses.
7. Whether OAuth API calls count toward the team's shared 10 requests per second.
8. The exact dashboard path where users revoke app access ("Team settings" per the OAuth changelog).
9. How a pre-registered client becomes "verified" (affects authorize error redirects and how the consent screen presents StackDash). No self-service path is documented.
10. Access token JWT claims (for example a team id). Not documented, so not relied on.
11. Response shapes for `/usage` on Pro and Scale plans (`daily.limit: null`, `domains.limit`, `segments.limit`).
12. The authorize callback carries `iss=https://api.resend.com`. The discovery metadata advertises it ([RFC 9207, section 2.3](https://www.rfc-editor.org/rfc/rfc9207#section-2.3)), but the Authorize reference says the redirect carries only `code` and the original `state`. If the live redirect omits `iss`, `exchangeCode` refuses every Resend callback and no connection can complete.

## Sources

All checked 2026-10-31.

- [Building an OAuth client for Resend](https://resend.com/docs/guides/building-a-resend-oauth-client)
- [Authorize](https://resend.com/docs/api-reference/oauth/authorize)
- [Token](https://resend.com/docs/api-reference/oauth/token)
- [Revoke Token](https://resend.com/docs/api-reference/oauth/revoke)
- [Register Client](https://resend.com/docs/api-reference/oauth/register)
- [List Grants](https://resend.com/docs/api-reference/oauth/list-grants)
- [Revoke Grant](https://resend.com/docs/api-reference/oauth/revoke-grant)
- [OAuth authorization server metadata](https://api.resend.com/.well-known/oauth-authorization-server)
- [Retrieve Usage](https://resend.com/docs/api-reference/usage/retrieve-usage)
- [Retrieve Metrics](https://resend.com/docs/api-reference/emails/get-metrics)
- [List Domains](https://resend.com/docs/api-reference/domains/list-domains)
- [Managing Domains (status values)](https://resend.com/docs/dashboard/domains/manage-domains)
- [Usage Limits (rate limit and quota headers)](https://resend.com/docs/api-reference/rate-limit)
- [Account quotas and limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits)
- [Pricing](https://resend.com/docs/knowledge-base/what-is-resend-pricing)
- [API introduction (auth, User-Agent)](https://resend.com/docs/api-reference/introduction)
- [Errors](https://resend.com/docs/api-reference/errors)
- [Verify webhook requests](https://resend.com/docs/webhooks/verify-webhooks-requests)
- [Webhook event types](https://resend.com/docs/webhooks/event-types)
- [Changelog: OAuth Support (2026-07-13)](https://resend.com/changelog/oauth-support)
- [Changelog: OAuth Client ID Metadata Document Support (2026-08-21)](https://resend.com/changelog/oauth-client-id-metadata-document-support)
- [Changelog: Email Metrics API (2026-08-27)](https://resend.com/changelog/email-metrics-api)
- [Changelog: Account Usage API (2026-10-01)](https://resend.com/changelog/account-usage-api)
