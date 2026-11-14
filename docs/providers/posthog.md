# PostHog

Provider id: `posthog`. Verification: documentation only. Docs checked 2026-11-05.

StackDash reads your PostHog organization's spend, billing limits, and product usage, plus daily signups. It asks for four read-only scopes: billing, organization, project, and query.

## Go or no-go

**Go, built against the documentation only.** There is no PostHog account behind this adapter yet, so every request and response shape below comes from PostHog's OAuth guide, its OpenAPI reference, and its frontend billing types, and every claim that needs a real account to confirm is listed under [Unverified](#unverified). The tests run against sample responses built from those sources, never against PostHog.

The biggest open question is whether PostHog grants `billing:read` to an app registered by client ID metadata document. If it does not, the connection still works and syncs signups; the connection page then lists `billing:read` as missing and no spend or limits appear.

## Connection

OAuth 2.0 authorization code flow with PKCE (S256). PostHog has no app registration form for third parties: the app is a **client ID metadata document** (CIMD) that StackDash serves itself, and the `client_id` is that document's URL. StackDash authenticates to the token endpoint with `private_key_jwt`: a short-lived assertion signed with the deployment's private key, checked by PostHog against a JWKS that StackDash also serves.

| Item | Value |
|---|---|
| Client id | `<SITE_URL>/oauth/posthog/client-metadata`, served by StackDash (`POSTHOG_OAUTH_CLIENT_ID`) |
| Metadata document | `GET <SITE_URL>/oauth/posthog/client-metadata`, JSON, `Cache-Control: public, max-age=3600` |
| JWKS | `GET <SITE_URL>/oauth/posthog/jwks`, the public half of `POSTHOG_OAUTH_PRIVATE_KEY` |
| Authorize URL | `GET https://oauth.posthog.com/oauth/authorize/` (region-agnostic, browser navigation) |
| Token URL | `POST https://oauth.posthog.com/oauth/token/` |
| Revoke URL | `POST https://oauth.posthog.com/oauth/revoke/` (RFC 7009) |
| Callback URL | `<SITE_URL>/api/connections/posthog/callback` |
| API base URL | `https://us.posthog.com` or `https://eu.posthog.com`, by the region that issued the token |
| Client authentication | `private_key_jwt`: `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer` and a fresh `client_assertion` on every token and revoke call. RS256 (RSA key) or ES256 (P-256 key), `kid` is the RFC 7638 thumbprint |
| Access token | Prefix `pha_`, 10 hours in the guide's sample (`expires_in: 36000`); StackDash stores the returned `expires_in` |
| Refresh token | Prefix `phr_`. Kept when a refresh returns none, replaced when it returns one |

### Metadata document

What `GET /oauth/posthog/client-metadata` returns, with `<SITE_URL>` filled in:

```json
{
  "client_id": "<SITE_URL>/oauth/posthog/client-metadata",
  "client_name": "StackDash",
  "client_uri": "<SITE_URL>",
  "redirect_uris": ["<SITE_URL>/api/connections/posthog/callback"],
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"],
  "token_endpoint_auth_method": "private_key_jwt",
  "jwks_uri": "<SITE_URL>/oauth/posthog/jwks",
  "com.posthog": { "scopes": ["billing:read", "organization:read", "project:read", "query:read"] }
}
```

PostHog's rules for the document, all met by the route: the `client_id` URL is HTTPS with a path and no query or fragment; it answers 200 with JSON and no redirect, under 5 KB and within 5 seconds; `client_id` matches the URL character for character; `client_name` contains none of "PostHog", "official", "verified", or "trusted"; `com.posthog.scopes` is the scope ceiling, so a token can never carry more than these four read scopes. The route answers 404 when `POSTHOG_OAUTH_CLIENT_ID` or `POSTHOG_OAUTH_PRIVATE_KEY` is empty, or when `POSTHOG_OAUTH_CLIENT_ID` is not exactly its own URL (it logs `posthog.client_metadata.client_id_mismatch`), because PostHog would refuse such a document anyway. No `logo_uri` is sent; PostHog then tries `<SITE_URL>/apple-touch-icon.png`, which StackDash does not serve, and falls back to the first letter of the name (OAuth development guide, Self-registered client logos).

### Authorize request

`https://oauth.posthog.com/oauth/authorize/?client_id=<metadata URL>&response_type=code&redirect_uri=<callback>&scope=billing:read organization:read project:read query:read&state=<state>&code_challenge=<S256>&code_challenge_method=S256&required_access_level=organization`

`required_access_level=organization` makes the user pick whole organizations rather than single projects, because billing belongs to the organization (OAuth development guide, Access levels). A signed-out visitor is sent to PostHog's login first and returns to the consent screen afterwards.

### Token exchange and region

`POST https://oauth.posthog.com/oauth/token/` with `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, `client_id`, and the client assertion. The response carries `access_token`, `token_type`, `expires_in`, `refresh_token`, `scope`, and PostHog's `scoped_organizations` and `scoped_teams`. Only the fields StackDash reads are parsed: `scoped_teams` and `id_token` are ignored whatever their shape, so neither can fail a connection. `invalid_grant` is treated as a revoked grant. A 401, or `invalid_client`, means PostHog rejected the client assertion: it could not read the JWKS, has not seen a new key yet, or the server clock drifted more than 30 seconds (Provisioning, Troubleshoot assertion errors). That is a problem with the deployment, not the user's grant, so the sync is retried with backoff and the connection is never marked revoked.

The region-agnostic host does not say which region issued the token, and the API has no region-agnostic host. Right after the exchange the adapter calls `GET /api/organizations/?limit=1` on US Cloud, then on EU Cloud: the region that answers anything but 401 (a 403 included, since the token is known there) is stored as `region` in the credential's metadata, and every later API call goes there. If both answer 401 the connection fails as revoked.

### Refresh, disconnect, and revoke

- Refresh: `POST https://oauth.posthog.com/oauth/token/` with `grant_type=refresh_token`, `refresh_token`, `client_id`, and a fresh assertion. Refreshes for one connection must be serialized, as for every provider.
- Disconnect from StackDash: `POST https://oauth.posthog.com/oauth/revoke/` with the refresh token, `token_type_hint=refresh_token`, and the assertion. An empty 200 is success.
- Disconnect from PostHog: the user removes StackDash from their connected apps in PostHog. StackDash finds out on the next sync, when the API answers 401, and marks the connection revoked.

## Permissions

All read-only. Each scope is the read half of a PostHog scope pair; the `:write` halves are never requested and the metadata document's scope ceiling excludes them.

| Scope | Why | Endpoints |
|---|---|---|
| `billing:read` | Spend so far, projected spend, billing period, and each product's usage, free allocation, and billing limit | `GET /api/billing/` |
| `organization:read` | Organization names for the account list, and the region check | `GET /api/organizations/` |
| `project:read` | Project names and ids, to know which projects to count signups for | `GET /api/organizations/{organization_id}/projects/` |
| `query:read` | One HogQL count of new people per day per project | `POST /api/projects/{project_id}/query/` |

PostHog lets the user narrow a grant to some organizations, and the token response names them in `scoped_organizations`. StackDash keeps those ids in the credential's metadata as `organizations` (comma separated; absent when the grant covers every organization) and lists only those organizations as accounts. A refresh response without the field keeps the list.

## Data

### Billing overview: `GET /api/billing/?organization_id=<uuid>&include_forecasting=true`

Scope `billing:read`. `organization_id` names the connected organization explicitly; without it PostHog uses the user's current project's organization. With token authentication PostHog also requires the user to have billing access in that organization, or it answers 403. The organization-level billing API (`/api/organizations/{id}/billing/...`) is in beta behind a feature flag and answers 403 without it, so it is not used.

Fields read, everything else is dropped at the parse boundary (including `account_owner`, which holds a name and email):

| Field | Becomes |
|---|---|
| `current_total_amount_usd_after_discount`, else `current_total_amount_usd` | `posthog.spend.current`, verified spend |
| `projected_total_amount_usd_after_discount`, else `projected_total_amount_usd` | `posthog.spend.projected`, estimated spend (PostHog's own projection), declared as projected spend (`projectedSpend`), so no reading of spend counts it as money spent: not the dashboard's totals, cards, or headline, the daily summary, digests, alerts, unusual spend and usage checks, or the dashboard's own projections. Sent whenever PostHog returns it, with or without a current total, since nothing counts it either way |
| `billing_period.current_period_start`, `current_period_end` | Timeframe and reset time of every billing metric |
| `products[].current_usage`, `unit` | `posthog.<type>.usage` |
| `products[].free_allocation` | `posthog.<type>.free` (included allowance) and `posthog.<type>.free_remaining` |
| `products[].current_amount_usd` | `posthog.spend.current.<type>`, verified spend: a breakdown of `posthog.spend.current`, so the dashboard, alerts, daily summary, and headline count the organization total once and never add the products to it |
| `products[].usage_limit`, `has_exceeded_limit` | Usage limit events (below) |

Only products with a `usage_key` (metered) and a lowercase `type` produce metrics; inclusion-only products such as Platform and support have no usage. A product's free allocation of zero or null produces no allowance metric.

Earlier versions stored each product's spend as `posthog.<type>.spend`, beside the total rather than below it, and the dashboard added the two together. Rows already stored under that name are read as breakdowns of `posthog.spend.current` (`dropSupersededBreakdowns` in `src/lib/dashboard/aggregate.ts`), so they never count beside the total either.

### Organizations: `GET /api/organizations/?limit=100`

Scope `organization:read`. One page of up to 100; more logs `posthog.organizations_truncated`. Only `id` and `name` are kept. When the grant names organizations, the list is filtered to them, in case PostHog does not filter it already (see Unverified).

### Projects: `GET /api/organizations/{organization_id}/projects/?limit=20`

Scope `project:read`. Up to 20 projects per organization are counted for signups; more logs `posthog.sync.project_cap`. Only `id` and `name` are kept: the project `api_token` in the response is dropped at the parse boundary.

### Signups: `POST /api/projects/{project_id}/query/`

Scope `query:read`. Body `{"query": {"kind": "HogQLQuery", "query": "..."}, "name": "StackDash signups per day"}`:

```sql
SELECT toDate(toTimeZone(created_at, 'UTC')) AS day, count() AS signups
FROM persons
WHERE created_at >= toDateTime('<from> 00:00:00', 'UTC') AND created_at < toDateTime('<to> 00:00:00', 'UTC')
GROUP BY day
ORDER BY day
LIMIT 7
```

A "signup" is a person profile PostHog created that day. With PostHog's default `person_profiles: 'identified_only'` a person is created when someone is first identified, which is the signup signal; a project that creates profiles for anonymous visitors too counts those as well. Date literals name UTC explicitly, because HogQL parses them in the project's timezone otherwise. Only counts leave PostHog: no names, emails, properties, or person ids.

### Units, freshness, retention

- Money: billing amounts are decimal strings in US dollars. They are parsed as decimals and rounded once to cents (`amountMinor`, `currency: "USD"`), never through floats. A non-string amount fails the sync as an unexpected shape.
- Quantities: the product's own `unit` (`event`, `recording`, `survey response`), or `units` when PostHog sends none or one the metric model cannot store.
- Billing period: `current_period_start` and `current_period_end` are read as ISO 8601 timestamps with `Z`, an offset, or no zone, which is read as UTC. Anything else fails the sync as an unexpected shape.
- Freshness: billing usage is not real time; PostHog's billing page and the API read the same billing service. Signups are counted once a UTC day has ended.
- The first sync reports the last 7 complete UTC days of signups; later syncs report only days that ended since the last one, at most 7 back after a long pause.
- The organization's signups for the latest whole UTC day are also a `usage` metric, `posthog.signups.daily`, over exactly that day. The adapter declares it as its daily signup total (`signupDailyTotals`), so the dashboard headline counts PostHog's signups by summing these daily readings. Each sync stores only the latest day as a reading, so a day no sync reported in time (a pause of more than a day) has no reading, and the headline names PostHog unavailable for a window that includes that day; the timeline events still cover it.

### Timeline events (by polling)

| Event | Type id | Source | Rule |
|---|---|---|---|
| Daily signups | `posthog.signups.daily` | Signup query | One event per project and UTC day with at least one signup, dated when the day ended. Dedupe key: project id and date |
| Usage near billing limit | `posthog.usage_limit.near` | Billing overview | `current_usage` at 80 percent or more of `usage_limit`. Warning |
| Billing limit reached | `posthog.usage_limit.reached` | Billing overview | `current_usage` at or over `usage_limit`, or `has_exceeded_limit`. Critical, because PostHog then drops new data for that product |

80 and 100 percent are PostHog's own alert levels (Billing limits and alerts). Each level fires once per organization, product, and billing period, dated when a sync first saw it. A product with no billing limit set produces no limit events. Event types that would need a write scope: none; every event above comes from the four read scopes.

## Achievements

StackDash evaluates these for each project the PostHog accounts are assigned to, from the PostHog data it has stored, after each sync (see [Achievements](../adapters.md#achievements)). A project earns each one once, and it stays private until an owner or admin publishes it.

The signup ladder is the same on Supabase, but PostHog reports signups as one total per UTC day (`posthog.signups.daily`), so these add up the daily totals, are dated to the day they were reached rather than to a time, and none is based on the hour. Big day needs one day's total of 100 or more.

| Id | Title | How it is earned |
|---|---|---|
| `posthog.signups.first` | First PostHog signup recorded | Earned when StackDash records the first PostHog signup, counted from daily signup totals. |
| `posthog.signups.10` | 10 PostHog signups recorded | Earned when StackDash records the 10th PostHog signup, counted from daily signup totals. |
| `posthog.signups.100` | 100 PostHog signups recorded | Earned when StackDash records the 100th PostHog signup, counted from daily signup totals. |
| `posthog.signups.1000` | 1,000 PostHog signups recorded | Earned when StackDash records the 1,000th PostHog signup, counted from daily signup totals. |
| `posthog.signups.big_day` | Big day: 100 signups in one day | Earned when StackDash records a PostHog daily signup total of 100 or more. |

## Verified, estimated, unavailable

| Value | Status |
|---|---|
| Spend so far in the billing period, total and per product | Verified (PostHog's billed figures; the period is provisional until invoiced) |
| Projected spend for the period | Estimated (PostHog's projection). Stored, but never shown or counted as spend this billing period |
| Usage, free allocation, and free allocation left per product | Verified |
| Billing limit per product, as a timeline event | Verified when PostHog returns `usage_limit` |
| Signups per project per day | Verified counts of person profiles created, with the caveat in Signups |
| Invoices, payment history, card details | Unavailable (not read) |
| Organization-level billing breakdowns (spend per project, forecasts per tier) | Unavailable: beta API behind a PostHog feature flag |
| Self-hosted PostHog billing | Unavailable: billing is a PostHog Cloud service |

## Rate limits

- Analytics endpoints: 240 per minute and 1,200 per hour; the query endpoint: 2,400 per hour per project, at most 3 queries running at once per project, 10 seconds of execution each. Other private endpoints are rate limited too (API overview, Rate limiting).
- Budget per organization: an hourly sync makes 1 billing call. Once a day it also makes 1 project list call and 1 query per project (at most 20), one after another. A first connection adds 2 calls for the region check.
- A 429 carries `Retry-After`, which the shared fetch helper passes to the sync runner's backoff.

## Webhooks

None. PostHog offers no webhooks to OAuth apps, so everything is polled.

## Permission risks

Disclosed on the connect screen before redirecting:

- **`billing:read`** reads the organization's billing overview, which also includes the account owner's name and email, the billing customer id, discount details, and the billing portal and invoices URLs. StackDash drops all of those at the parse boundary and keeps only amounts, usage, limits, and the billing period.
- **`query:read`** can run any read-only HogQL query in the granted projects, which reaches every event and person property, emails included. StackDash runs exactly one fixed query, which returns counts per day, and never stores rows.
- **`project:read`** returns each project's public project token (`phc_...`, the key the PostHog snippet sends events with). StackDash drops it.
- **`POSTHOG_OAUTH_PRIVATE_KEY`** signs every token request for every PostHog connection of the deployment. Store it only in the server environment, never in the database or logs. The JWKS route publishes this one key only, so rotating it is a cutover: PostHog's zero-downtime rotation needs the new key published next to the old one first, which one variable cannot do. PostHog caches the JWKS for 1 hour whatever `Cache-Control` says, and re-fetches it early when an assertion names a key id it has not seen, at most once a minute (Provisioning, Publish your keys). So for up to a minute after a rotation, token refreshes and new connections can fail; the failed syncs are retried, and no connection is marked revoked. After a leak, PostHog can keep accepting the removed key for up to an hour.

## Limitations

- Billing needs an organization member with billing access; other members connect, see signups, and get `billing:read` listed as missing.
- One page of up to 100 organizations per grant, and up to 20 projects per organization for signups.
- The `/query` endpoint is not meant for exports, and PostHog may rate limit or reject queries that look like one. StackDash's single aggregated count per project per day is the documented "pull aggregated data into your own app" use, but PostHog's wording reserves the right to restrict it.
- Signup counts follow PostHog's person model: merged or deleted persons change past counts, and StackDash keeps the count as first reported.
- One signing key at a time. Rotating `POSTHOG_OAUTH_PRIVATE_KEY` is a cutover: token calls can fail for up to a minute until PostHog re-fetches the JWKS, and are retried (Permission risks).
- PostHog Cloud only (US and EU). A self-hosted PostHog has no billing service and would need its own host; not supported.

## Self-hosted registration

Each deployment registers itself, because the client id is a URL on the deployment's own domain. There is nothing to create in PostHog.

1. Make sure `NEXT_PUBLIC_SITE_URL` is the deployment's public HTTPS origin, for example `https://stackdash.example.com`. PostHog requires HTTPS for the metadata URL and fetches it from the internet, so a local `http://localhost` instance cannot connect a real PostHog account; use the simulated provider locally.
2. Generate the signing key (P-256, PKCS#8 PEM) and keep the file out of the repository:

   ```bash
   openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out posthog-oauth.pem
   ```

   An RSA key of 2048 bits or more also works (`openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out posthog-oauth.pem`).
3. Set the environment variables, then redeploy:

| Variable | Value |
|---|---|
| `POSTHOG_OAUTH_CLIENT_ID` | `<SITE_URL>/oauth/posthog/client-metadata`, exactly, with no trailing slash |
| `POSTHOG_OAUTH_PRIVATE_KEY` | Full contents of `posthog-oauth.pem`. If the host cannot store multiline values, store it with `\n` escapes; StackDash turns them back into line breaks |

4. Open `<SITE_URL>/oauth/posthog/client-metadata` and `<SITE_URL>/oauth/posthog/jwks` in a browser. Both must answer JSON. A 404 from the first means a variable is empty or `POSTHOG_OAUTH_CLIENT_ID` is not exactly that URL; a 500 from the second means the key is not a usable private key.
5. Connect PostHog from a workspace. The first authorization makes PostHog fetch and cache the document (for `max-age`, one hour). Delete the downloaded PEM file once the key is stored.

Optional, later: request PostHog's verified badge through PostHog support (topic Authentication) with the client id URL, which removes the "unverified application" notice on the consent screen. It is not needed to connect.

## Sample responses

All samples are from documentation, not recorded, trimmed and with synthetic ids and values. They are the fixtures in `src/lib/adapters/posthog/fixtures/`.

Token response (OAuth development guide, "Response includes"):

```json
{
  "access_token": "fixture-access-token",
  "token_type": "Bearer",
  "expires_in": 36000,
  "refresh_token": "fixture-refresh-token",
  "scope": "billing:read organization:read project:read query:read",
  "scoped_teams": [],
  "scoped_organizations": ["0191c2d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d"]
}
```

Billing overview, one product shown (`BillingOverviewResponse` in the OpenAPI reference; product fields from `BillingProductV2Type`):

```json
{
  "current_total_amount_usd": "23.40",
  "current_total_amount_usd_after_discount": "18.72",
  "projected_total_amount_usd": "51.30",
  "projected_total_amount_usd_after_discount": "41.04",
  "billing_period": { "current_period_start": "2026-11-01T00:00:00Z", "current_period_end": "2026-12-01T00:00:00Z", "interval": "month" },
  "products": [
    {
      "type": "session_replay",
      "usage_key": "recordings",
      "name": "Session replay",
      "free_allocation": 5000,
      "current_usage": 6100,
      "current_amount_usd": "5.50",
      "projected_amount_usd": "12.00",
      "usage_limit": 7000,
      "has_exceeded_limit": false,
      "unit": "recording"
    }
  ]
}
```

Signup query (API queries, Response structure):

```json
{
  "columns": ["day", "signups"],
  "results": [["2026-11-03", 14], ["2026-11-04", 9]],
  "is_cached": false
}
```

## Unverified

Confirm with a real PostHog account before relying on the adapter:

1. Whether PostHog grants `billing:read` to an app registered by metadata document. If it drops the scope from the ceiling, billing shows as missing permission.
2. That `private_key_jwt` works for a consent-flow CIMD app that is not a provisioning partner. The OAuth guide lists it as allowed; the signing details come from the provisioning guide, which also mentions a registration call that only provisioning apps are told to make.
3. That the region-agnostic `oauth.posthog.com` accepts the assertion `aud` of `["https://us.posthog.com", "https://eu.posthog.com"]` and routes code exchange, refresh, and revoke to the right region.
4. That the region check behaves as described: a token from one region answers 401 in the other.
5. That `required_access_level=organization` is accepted for a CIMD app.
6. That `GET /api/billing/?organization_id=` answers for a member with billing access through an OAuth token, the exact status for a member without it (403 expected), and the real product `type`, `unit`, and `usage_key` strings.
7. Whether amounts can arrive as numbers rather than strings (the adapter refuses numbers as an unexpected shape).
8. Whether `count()` arrives as a JSON number in query results (the adapter refuses strings).
9. Token lifetimes and whether refresh tokens rotate.
10. That the JWKS cache the provisioning guide documents (1 hour, an early re-fetch at most once a minute for a key id PostHog has not seen) applies to a consent-flow CIMD app as well. Permission risks and Limitations assume it does.
11. That the revoke endpoint answers 200 with an empty body for a refresh token.
12. Whether `GET /api/organizations/` is already narrowed to `scoped_organizations` for an organization-level grant, and whether `scoped_organizations` is empty or null for a grant that covers every organization. The adapter filters by the list when it names any organization.
13. The exact `billing_period` timestamp format (no sample shows one). The adapter accepts `Z`, an offset, or no zone.

## Sources

All checked 2026-11-05.

- [PostHog OAuth integration](https://posthog.com/docs/api/oauth) (CIMD, document rules, scope ceiling, server endpoints, token prefixes)
- [OAuth development guide](https://posthog.com/handbook/engineering/oauth-development-guide) (PKCE flow, token response, access levels, introspection)
- [Provisioning API, Sign requests with a key](https://posthog.com/docs/integrate/provisioning#sign-requests-with-a-key) (`private_key_jwt` claims, JWKS rules, JWKS cache and key rotation, assertion error messages)
- [Authorization server metadata](https://oauth.posthog.com/.well-known/oauth-authorization-server) (`token_endpoint_auth_methods_supported`, `code_challenge_methods_supported`, `scopes_supported`)
- [OpenAPI: billing_list](https://posthog.com/docs/open-api-spec/billing_list) (`GET /api/billing/`, `billing:read`)
- [OpenAPI: billing_products_summary_retrieve](https://posthog.com/docs/open-api-spec/billing_products_summary_retrieve) (organization billing API is in beta)
- [OpenAPI: list](https://posthog.com/docs/open-api-spec/list) (`GET /api/organizations/`, `organization:read`)
- [OpenAPI: organizations_projects_list](https://posthog.com/docs/open-api-spec/organizations_projects_list) (`project:read`)
- [OpenAPI: query_create](https://posthog.com/docs/open-api-spec/query_create) and [API queries](https://posthog.com/docs/api/queries) (HogQL query endpoint, limits, export policy)
- [Supported ClickHouse functions](https://posthog.com/docs/sql/clickhouse-functions) (date literals parse in the project timezone)
- [PostHog billing source, `ee/api/billing.py`](https://github.com/PostHog/posthog/blob/master/ee/api/billing.py) (`organization_id` on `list`, billing access check for token requests)
- [PostHog frontend types, `BillingProductV2Type`](https://github.com/PostHog/posthog/blob/master/frontend/src/types.ts) (product fields the OpenAPI schema leaves untyped)
- [Billing limits and alerts](https://posthog.com/docs/billing/limits-alerts) (80 and 100 percent alert levels, data dropped over the limit)
- [API overview, Rate limiting](https://posthog.com/docs/api#rate-limiting)
- [RFC 7523](https://datatracker.ietf.org/doc/html/rfc7523), [RFC 7638](https://datatracker.ietf.org/doc/html/rfc7638), [RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)
