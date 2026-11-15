# Polar

Provider id: `polar`. Verification: documentation only. Docs checked 2026-11-05 against Polar API version `2026-10`.

StackDash reads your Polar revenue, Polar fees, recurring revenue, orders, subscriptions, new customers, and refunds. It asks for six read-only scopes and never writes to Polar.

**Not yet confirmed with a real Polar account.** StackDash has not registered a Polar OAuth client yet. Everything below comes from Polar's documentation, and every claim that only a real account can confirm is listed under [Unverified](#unverified). The adapter's tests run against sample responses built from the API reference, and the simulated Polar provider (`STACKDASH_SIMULATE_PROVIDERS=1`) shows the whole flow locally without an account.

## Go or no-go

**Go for demos with the simulated provider. No-go for real connections until the Unverified list is checked with a real organization.** Polar has OAuth 2.0 with PKCE and read-only scopes for everything StackDash reads: revenue, Polar fees, recurring revenue, orders, subscriptions, new customers, and refunds. All money comes from Polar's own analytics endpoint, so StackDash shows Polar's numbers rather than recomputing them from orders.

The timeline is polled. Setting up Polar webhooks automatically would need `webhooks:write`, which is not read-only (see [Webhooks](#webhooks)).

## Connection

OAuth 2.0 authorization code flow with PKCE (S256), as a confidential client. Polar implements OpenID Connect; StackDash does not request `openid` because it needs no identity claims.

| Item | Value |
|---|---|
| Authorize URL | `https://polar.sh/oauth2/authorize` (browser navigation) |
| Token URL | `POST https://api.polar.sh/v1/oauth2/token` |
| Revoke URL | `POST https://api.polar.sh/v1/oauth2/revoke` (RFC 7009) |
| Discovery | `https://api.polar.sh/.well-known/openid-configuration` (issuer `https://api.polar.sh`) |
| Callback URL | `<SITE_URL>/api/connections/polar/callback` |
| API base URL | `https://api.polar.sh/v1` |
| API version header | `Polar-Version: 2026-10` on every call, including the OAuth2 token and revoke requests (both are in the `2026-10` reference). `2026-10` was the Current version on 2026-11-05. Without it Polar uses Current, which changes every quarter. `2026-10` is removed in the first week of April 2027; see [Limitations](#limitations) |
| Client authentication | `client_id` and `client_secret` in the form body (`client_secret_post`, as in Polar's token request reference). `client_secret_basic` is also advertised |
| PKCE | `S256`, advertised in the discovery document. StackDash always sends it |
| Access token | 864000 seconds (10 days) in Polar's example; StackDash reads `expires_in` from each response. Prefix `polar_at_` |
| Refresh token | Returned with the access token. Prefix `polar_rt_`. Lifetime not documented |
| Sandbox | A separate environment (`https://sandbox.polar.sh`, `https://sandbox-api.polar.sh/v1`) with its own OAuth clients. Not supported by the adapter; see [Limitations](#limitations) |

### Authorize

Query: `response_type=code`, `client_id`, `redirect_uri` (must match a registered redirect URI), `scope` (space separated, always sent in full), `state`, `code_challenge`, `code_challenge_method=S256`.

Polar issues **user-scoped** tokens. On the consent screen the user can limit the token to some of their organizations; by default it reaches every organization they belong to, including ones they join later. Access always follows the user's current membership.

The callback carries `code` and `state`, and `iss` when Polar sends it: the discovery document sets `authorization_response_iss_parameter_supported`. A callback with any other issuer than `https://api.polar.sh` is refused (RFC 9207).

### Code exchange

`POST /v1/oauth2/token` with `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`, `client_id`, `client_secret`, form encoded. The response has `token_type` (`Bearer`), `access_token`, `expires_in`, `refresh_token`, `scope`, and `id_token` (only with `openid`; never stored). Token errors are read by their RFC 6749 `error` code, the same way as on refresh (below). On the code exchange, `invalid_grant` also means the client's redirect URI does not match `redirect_uri`, so when every first connect fails with it, check the client registration ([OAuth apps](../operations/oauth-apps.md#polar-oauth-client)), not the user's grant.

### Refresh

`POST /v1/oauth2/token` with `grant_type=refresh_token`, `refresh_token`, `client_id`, `client_secret`. The adapter stores the new refresh token when one is returned and keeps the current one otherwise.

- Only `invalid_grant` (RFC 6749 section 5.2: a code or refresh token that is used, expired, or revoked), as a `400` or a `401`, is reported as `auth_revoked`, so the connection asks to be reconnected instead of retrying a token that can never work again. Polar's exact answer for a spent refresh token is Unverified item 2.
- `invalid_client` (wrong client id or secret, as a `400` or a `401`), `invalid_request`, and `unsupported_grant_type` are this instance's OAuth client configuration, not the user's grant. They are reported as `invalid_response`: retried, and logged with the error reference, never a reconnect prompt. If every Polar connection fails this way, check `POLAR_CLIENT_ID` and `POLAR_CLIENT_SECRET`.

### Disconnect and revoke

- From StackDash: disconnecting revokes the refresh token, then the access token, at `POST /v1/oauth2/revoke` with `token`, `token_type_hint`, `client_id`, `client_secret`. Polar answers `200` with `{}`. Both are revoked because the docs do not say whether revoking one ends the other.
- From Polar: the user can remove the app's access in their Polar account. Without webhooks StackDash finds out on the next sync, when the API answers `401` and the connection asks to reconnect.

## Permissions

All read-only. Descriptions in the second column are Polar's own wording from the authorize schema.

| Scope | Polar's description | Why StackDash asks |
|---|---|---|
| `organizations:read` | Read your organizations | Lists the organizations the grant reaches, so each becomes an external account |
| `metrics:read` | Read metrics | Revenue, net revenue (for Polar fees), MRR, ARR, orders, and subscription counts from `GET /v1/metrics/` |
| `orders:read` | Read orders made on your organizations | Paid orders on the timeline |
| `subscriptions:read` | Read subscriptions made on your organizations | New and canceled subscriptions on the timeline |
| `customers:read` | Read customers | Counting new customers this month |
| `refunds:read` | Read refunds made on your organizations | Refunds on the timeline |

Not requested: `webhooks:write` (push events, not read-only), `webhooks:read` (StackDash has no webhook to read), `openid`, `profile`, `email`, `user:read` (no identity needed), `payments:read`, `transactions:read`, `payouts:read`, and every `:write` scope.

## Data

### Organizations: `GET /v1/organizations/`

`page` and `limit=100`, sorted by name. Only `id` and `name` are kept. Each organization is one external account of kind `organization`; its `id` (a UUID) is the `organization_id` filter on every other call.

### Analytics: `GET /v1/metrics/`

One call per organization per sync: `start_date` the first of the current UTC month, `end_date` today, `interval=day`, `timezone=UTC`, `organization_id`, and one `metrics` parameter for each field in the table below, so Polar runs only those queries instead of every series in its schema. The response has one period per day. Currency values are documented as "output in cents"; the response carries no currency field (see [Units](#units-freshness-retention)).

| Polar field | StackDash metric | Kind | How |
|---|---|---|---|
| `revenue` | `polar.revenue.month.usd`, "Revenue before fees, this month (USD)" | `revenue` | Sum of the month's days |
| `revenue` minus `net_revenue` | `polar.fees.month.usd`, "Polar fees, this month (USD)" | `verified_spend` | Sum of the month's days. Polar defines net revenue as "revenue after deducting Polar's platform fee and the payment processor's fee on each order" ([Analytics](https://polar.sh/docs/features/analytics)) |
| `orders` | `polar.orders.month` | `usage` (orders) | Sum of the month's days |
| `new_subscriptions` | `polar.subscriptions.new.month` | `usage` (subscriptions) | Sum of the month's days |
| `canceled_subscriptions` | `polar.subscriptions.canceled.month` | `usage` (subscriptions) | Sum of the month's days |
| `monthly_recurring_revenue` | `polar.mrr.usd`, "Monthly recurring revenue (USD)" | `recurring_revenue` | Latest day |
| `annual_recurring_revenue` | `polar.arr.usd`, "Annual recurring revenue (USD)" | `recurring_revenue` | Latest day |
| `active_subscriptions` | `polar.subscriptions.active` | `usage` (subscriptions) | Latest day |

Revenue is revenue and fees are spend, like Stripe: revenue appears under "Revenue this billing period" and Polar fees under spending, never mixed. MRR and ARR are run rates, not money earned in a period, so they have their own kind, `recurring_revenue`, which the dashboard never adds into revenue or spend. They appear on the Polar card under "Recurring revenue", one figure each (summed over the connection's organizations, never MRR into ARR), and in trends.

Rounding: amounts are summed exactly and rounded once to cents, half to even (`src/lib/money.ts`). MRR can carry a fraction of a cent because yearly plans are divided by twelve.

A day with a missing or null value makes that metric unavailable for the sync, never zero. Net revenue above revenue (fees below zero) is not shown as spend and is logged.

Polar's definitions ([Analytics](https://polar.sh/docs/features/analytics)): revenue is "gross revenue from every completed order in the interval", "computed on the order subtotal, before Polar fees and tax". MRR is the sum of every ongoing subscription's net amount normalized to a month, excluding trials and including paused and past-due subscriptions. Active subscriptions are counted at the end of each interval.

### New customers: `GET /v1/customers/`

The customer list has no date filter, so it is read newest first (`sorting=-created_at`) until the first customer created before the month began, and those are counted: `polar.customers.new.month` ("New customers this month", `usage`, customers). Only `id` and `created_at` are parsed; email, name, address, tax id, and metadata are dropped at the parse boundary. Past 10 pages of 100 the count is not reported, because a partial count would understate it.

### Timeline events (by polling)

The first sync reads the last 30 days. Each later sync reads from one day before the previous sync, so an order paid late or a refund confirmed late is still seen; dedupe keys absorb the overlap. Each stream reads at most 10 pages of 100 per sync and logs `polar.events.truncated` past that.

| Event type | Source | Rule | Title |
|---|---|---|---|
| `polar.order.paid` | `GET /v1/orders/?created_after=` | Status `paid`, `refunded`, or `partially_refunded`. Draft, pending, and void orders are skipped | By `billing_reason`: "Order paid", "Order paid for a new subscription", "Subscription renewed", "Order paid for a subscription change", each followed by the order's `total_amount` in its `currency`: "Subscription renewed: $19.00" |
| `polar.subscription.started` | `GET /v1/subscriptions/?started_after=` | `started_at` set | "Subscription started", or "Trial started" while trialing |
| `polar.subscription.canceled` | `GET /v1/subscriptions/?canceled_at_after=` | `canceled_at` set | "Subscription canceled". Body: the customer's reason from Polar's enum, and "Access continues until the paid period ends." when `cancel_at_period_end` |
| `polar.refund.succeeded` | `GET /v1/refunds/?succeeded=true&sorting=-created_at` | Status `succeeded`, filtered by Polar so pending and failed refunds do not use the page cap. No date filter exists, so the list stops at the first refund before the window | "Order refunded", followed by `amount` plus `tax_amount` in its `currency`: "Order refunded: $9.00". Body: Polar's reason enum in words |

Event times are the order's `created_at`, the subscription's `started_at` or `canceled_at`, and the refund's `created_at`. Dedupe keys are `order:<id>`, `subscription_started:<id>`, `subscription_canceled:<id>`, and `refund:<id>`.

Amounts on titles are integer minor units with the order's or refund's own ISO 4217 currency, formatted with that currency's number of minor digits, one event at a time and never added across events or currencies. An order shows `total_amount`, the order's value after discounts and tax; a customer's applied balance (`applied_balance_amount`) can make the amount charged differ, and is not shown. A refund's `amount` is before tax and Polar refunds the matching tax alongside it ([Refunds](https://polar.sh/docs/features/refunds), "Amount"), so the title shows their sum. An order or refund without its amount, its tax part, or its currency gets the title alone.

Every event type here needs only a read scope; none was left out for needing a write scope.

### Units, freshness, retention

- Money: integer cents in USD. The metrics endpoint has no currency field. Polar settles in USD ("Polar's settlement currency (USD)" in the organization schema), and Polar's [multi-currency design document](https://handbook.polar.sh/engineering/design-documents/multi-currency) says metrics are computed in USD. Unverified item 3.
- Counts: orders, subscriptions, and customers, as numbers with those units.
- Periods: UTC days from the first of the month to now. Month totals are period metrics from the first of the month to the read time, so the dashboard counts them in the current billing period. MRR, ARR, and active subscriptions are point readings at the read time.
- Freshness: not documented. StackDash polls hourly.
- Retention: the metrics endpoint has a minimum date per organization (`GET /v1/metrics/limits`, `min_date`); a month to date is always inside it.

## Achievements

StackDash evaluates these for each project the Polar accounts are assigned to, from the Polar data it has stored, after each sync (see [Achievements](../adapters.md#achievements)). A project earns each one once, and it stays private until an owner or admin publishes it.

Counts only, never amounts. The payment and subscription ladder is the same on Stripe, except for Stripe's customer achievements: Polar has no customer event. Payments count `polar.order.paid` events and subscriptions `polar.subscription.started`. Days and hours are London time.

| Id | Title | How it is earned |
|---|---|---|
| `polar.payments.first` | First Polar payment recorded | Earned when StackDash records the first successful Polar payment. |
| `polar.payments.10` | 10 Polar payments recorded | Earned when StackDash records the 10th successful Polar payment. |
| `polar.payments.100` | 100 Polar payments recorded | Earned when StackDash records the 100th successful Polar payment. |
| `polar.payments.1000` | 1,000 Polar payments recorded | Earned when StackDash records the 1,000th successful Polar payment. |
| `polar.payments.payday` | Payday: 10 payments in one day | Earned when StackDash records 10 successful Polar payments on one London calendar day. |
| `polar.payments.while_you_slept` | While you slept: a payment between midnight and 5 am | Earned when StackDash records a successful Polar payment between midnight and 5 am London time. |
| `polar.subscriptions.first` | First Polar subscription recorded | Earned when StackDash records the first new Polar subscription. |
| `polar.subscriptions.10` | 10 Polar subscriptions recorded | Earned when StackDash records the 10th new Polar subscription. |

## Verified, estimated, unavailable

| Value | Status |
|---|---|
| Revenue this month, MRR, ARR, orders, new, canceled, and active subscriptions | Verified (Polar's own analytics) |
| Polar fees this month | Verified: revenue minus net revenue, both from Polar. Not inferred from a price list |
| New customers this month | Verified count of customers Polar lists as created this month |
| Paid orders, new and canceled subscriptions, refunds | Verified events with Polar ids and times, and each order's and refund's amount in its own currency |
| Revenue in the currency the customer paid | Unavailable: analytics are in USD only. Orders carry their own currency but are not summed by StackDash |
| Payout fees (Stripe's fees on Polar payouts) | Unavailable: not part of net revenue |
| Dispute fees | Unavailable: deducted from the balance, not reported per order |
| Customer names, emails, addresses | Never collected |

## Rate limits

- Production: 500 requests per minute per organization, customer, or OAuth client. Sandbox: 100 per minute.
- Exceeded: `429` with `Retry-After`. The sync runner backs off with that delay.
- Budget: about six requests per organization per hourly sync (metrics, customers, orders, two subscription queries, refunds), more only for busy organizations that need extra pages.

## Webhooks

Not received yet; planned, through the shared webhook route (see [Webhooks](../adapters.md#webhooks)), with polling kept as the backfill. Polar's webhook endpoints need `webhooks:write` to create, which is not read-only, so automatic setup would be an opt-in; an endpoint set up by hand keeps StackDash read-only. The useful events are `order.paid`, `order.refunded`, `subscription.created`, `subscription.canceled`, `subscription.revoked`, and `refund.created`, from Polar's webhook event list.

## Permission risks

Disclose these on the connect screen before redirecting:

- **`customers:read`** returns every customer's email, name, billing address, and tax id. StackDash parses only `id` and `created_at` and drops the rest at the parse boundary, but the token can read all of it.
- **`orders:read` and `subscriptions:read`** responses embed the customer and their billing details, and subscriptions carry the customer's free text cancellation comment. StackDash keeps only ids, statuses, times, Polar's enum reason codes, and each order's and refund's amount and currency.
- The token is **user-scoped**: unless the user limits it on the consent screen, it reaches every organization the user belongs to now or joins later.
- The access token lasts 10 days and the refresh token longer. Both are encrypted at rest and revoked on disconnect.

## Limitations

- Money is in USD only, from Polar's analytics. Per-currency revenue would mean summing orders, which the adapter does not do.
- The sandbox environment is not supported: it has its own URLs and OAuth clients, and the adapter calls production only. Test with a real organization in a test workspace, or with the simulated provider.
- One connection covers every organization the grant reaches; each organization is an external account that can be excluded.
- Refunds, customers, and new orders are read newest first with a cap of 10 pages of 100 per sync. A larger month leaves new customers unreported and logs a warning.
- A pending order that is paid more than a day after it was created, and a refund that succeeds more than a day after it was created, never reach the timeline.
- Polar API version `2026-10` is removed in the first week of April 2027 ([API versioning](https://polar.sh/docs/api-reference/2026-10/versioning): about nine months per version, then "a malformed, unknown, or removed version returns `404 Not Found`"). From then every Polar sync fails with `invalid_response`. Before then: set `POLAR_API_VERSION` in `src/lib/adapters/polar/index.ts` to the then Current version, re-read every endpoint this page lists in that version's reference, and refresh the fixtures and sample responses.

## Self-hosted registration

Each deployment registers its own OAuth client, because the redirect URI and client secret belong to one deployment.

1. Polar, **Account Settings**, **Developer** ([direct link](https://polar.sh/dashboard/account/developer)), and create an OAuth 2.0 client.
2. **Application name**: for example `StackDash (your name)`. It is shown to users on the consent screen.
3. **Client type**: confidential (not a public client). StackDash keeps the secret on the server and sends PKCE as well.
4. **Redirect URIs**: `<SITE_URL>/api/connections/polar/callback`. HTTPS is required except for `localhost`, so a local development client can use `http://localhost:3000/api/connections/polar/callback`.
5. **Scopes**: `organizations:read`, `metrics:read`, `orders:read`, `subscriptions:read`, `customers:read`, `refunds:read`. Nothing else.
6. **Homepage URL**: `<SITE_URL>`. Optionally add the terms of service and privacy policy URLs; Polar shows them on the consent screen.
7. Create the client and copy the **Client ID** and **Client Secret**.
8. Set the environment variables:

| Variable | Value |
|---|---|
| `POLAR_CLIENT_ID` | Client ID of the OAuth app |
| `POLAR_CLIENT_SECRET` | Client secret of the OAuth app. Secret |

## Sample responses

All samples are from documentation, not recorded: shaped after the API reference for version `2026-10`, trimmed, with synthetic values. The test fixtures in `src/lib/adapters/polar/fixtures/` follow them. Replace them with recorded, sanitized responses once a real organization is connected.

`POST /v1/oauth2/token` (from the [OAuth 2.0 Connect](https://polar.sh/docs/integrate/oauth2/connect) example):

```json
{
  "token_type": "Bearer",
  "access_token": "polar_at_XXX",
  "expires_in": 864000,
  "refresh_token": "polar_rt_XXX",
  "scope": "openid email",
  "id_token": "ID_TOKEN"
}
```

`GET /v1/organizations/` (trimmed):

```json
{
  "items": [
    { "id": "1dbfc517-0bbf-4301-9ba8-555ca42b9737", "name": "Example organization", "slug": "example-organization", "default_presentment_currency": "usd" }
  ],
  "pagination": { "total_count": 1, "max_page": 1 }
}
```

`GET /v1/metrics/?start_date=2026-11-01&end_date=2026-11-10&interval=day&timezone=UTC&metrics=revenue&metrics=net_revenue&...` (one `metrics` per field read; one period shown, trimmed):

```json
{
  "periods": [
    {
      "timestamp": "2026-11-10T00:00:00.000000Z",
      "revenue": 3300,
      "net_revenue": 3085,
      "orders": 1,
      "new_subscriptions": 0,
      "canceled_subscriptions": 0,
      "active_subscriptions": 83,
      "monthly_recurring_revenue": 158333.3333,
      "annual_recurring_revenue": 1899999.9996
    }
  ],
  "totals": { "revenue": 54800, "orders": 14 },
  "metrics": { "revenue": { "slug": "revenue", "display_name": "Revenue", "type": "currency" } }
}
```

`GET /v1/orders/` (trimmed; the embedded customer is dropped at the parse boundary):

```json
{
  "items": [
    {
      "id": "0a1b2c3d-0000-4000-8000-000000000001",
      "created_at": "2026-11-10T09:30:00.000000Z",
      "status": "paid",
      "billing_reason": "purchase",
      "currency": "usd",
      "net_amount": 4900,
      "tax_amount": 980,
      "total_amount": 5880,
      "platform_fee_amount": 295,
      "customer": { "id": "c0ffee00-0000-4000-8000-000000000001", "email": "jane.doe@example.com", "name": "Jane Doe" }
    }
  ],
  "pagination": { "total_count": 1, "max_page": 1 }
}
```

`GET /v1/subscriptions/?canceled_at_after=...` (trimmed):

```json
{
  "items": [
    {
      "id": "5ab5ab50-0000-4000-8000-000000000002",
      "status": "active",
      "started_at": "2026-09-08T12:00:00.000000Z",
      "canceled_at": "2026-11-08T11:20:00.000000Z",
      "cancel_at_period_end": true,
      "customer_cancellation_reason": "too_expensive",
      "customer_cancellation_comment": "Found a cheaper tool"
    }
  ],
  "pagination": { "total_count": 1, "max_page": 1 }
}
```

`GET /v1/refunds/?succeeded=true&sorting=-created_at` (trimmed):

```json
{
  "items": [
    {
      "id": "7ef07ef0-0000-4000-8000-000000000001",
      "created_at": "2026-11-08T08:00:00.000000Z",
      "status": "succeeded",
      "reason": "customer_request",
      "amount": 900,
      "tax_amount": 0,
      "currency": "usd",
      "order_id": "0a1b2c3d-0000-4000-8000-000000000004"
    }
  ],
  "pagination": { "total_count": 1, "max_page": 1 }
}
```

`GET /v1/customers/?sorting=-created_at` (trimmed):

```json
{
  "items": [
    { "id": "c0ffee00-0000-4000-8000-000000000001", "created_at": "2026-11-10T09:29:00.000000Z", "email": "jane.doe@example.com", "name": "Jane Doe" }
  ],
  "pagination": { "total_count": 12, "max_page": 3 }
}
```

## Unverified

Confirm with a real Polar organization before the adapter is used for real connections. The code refers to these by number.

1. Whether the user can deselect individual scopes on the consent screen, and what `scope` then returns. The adapter compares the returned `scope` with the six it asked for.
2. Whether refresh tokens rotate on every use, how long they last, and the exact error for a used, expired, or revoked refresh token (a `400 invalid_grant` is assumed from RFC 6749 section 5.2; `invalid_grant` is treated as revoked with `400` or `401`, and every other code is not).
3. That every currency value from `GET /v1/metrics/` is in USD cents for organizations selling in other presentment currencies.
4. Whether `revenue` in the metrics endpoint deducts refunds, and whether `revenue` minus `net_revenue` is exactly the fees Polar keeps (platform fee plus payment processing, without payout fees).
5. That daily periods with `timezone=UTC` are stamped at 00:00 UTC and include today up to the request time, and that the `metrics` parameter the request names its fields with returns each of them under the same key.
6. The status code when a token limited to some organizations is asked about another organization (`403`, `404`, or an empty result).
7. Whether `created_after`, `started_after`, and `canceled_at_after` are inclusive, and whether `sorting=-started_at` is honored together with `started_after`.
8. Whether revoking the refresh token also revokes the access token, or the other way round.
9. Whether Polar sends `iss` on the callback, as its discovery document advertises.
10. That PKCE is accepted together with a confidential client's secret at the token endpoint (the docs describe PKCE for public clients; the discovery document lists `S256`).
11. Token prefixes beyond `polar_at_`, `polar_rt_`, and `polar_oat_` (used by log redaction).
12. What `pagination.max_page` is for an empty list (`0` or `1`); the adapter stops on an empty page either way.
13. Where a user removes a third-party OAuth app's access in the Polar dashboard.

## Sources

All checked 2026-11-05.

- [OAuth 2.0 introduction](https://polar.sh/docs/integrate/oauth2/introduction)
- [OAuth 2.0 Connect](https://polar.sh/docs/integrate/oauth2/connect)
- [Create an OAuth 2.0 client](https://polar.sh/docs/integrate/oauth2/setup)
- [OpenID configuration](https://api.polar.sh/.well-known/openid-configuration)
- [API reference 2026-10: Authorize (scope descriptions)](https://polar.sh/docs/api-reference/2026-10/oauth2/authorize)
- [API reference 2026-10: Request token](https://polar.sh/docs/api-reference/2026-10/oauth2/request-token)
- [API reference 2026-10: Revoke token](https://polar.sh/docs/api-reference/2026-10/oauth2/revoke-token)
- [API overview: base URLs, pagination, rate limits](https://polar.sh/docs/api-reference/2026-10/introduction)
- [API versioning](https://polar.sh/docs/api-reference/2026-10/versioning)
- [API reference 2026-10: List organizations](https://polar.sh/docs/api-reference/2026-10/organizations/list-organizations)
- [API reference 2026-10: Get metrics](https://polar.sh/docs/api-reference/2026-10/metrics/get-metrics)
- [API reference 2026-10: Get metrics limits](https://polar.sh/docs/api-reference/2026-10/metrics/get-metrics-limits)
- [API reference 2026-10: List orders](https://polar.sh/docs/api-reference/2026-10/orders/list-orders)
- [API reference 2026-10: List subscriptions](https://polar.sh/docs/api-reference/2026-10/subscriptions/list-subscriptions)
- [API reference 2026-10: List refunds](https://polar.sh/docs/api-reference/2026-10/refunds/list-refunds)
- [API reference 2026-10: List customers](https://polar.sh/docs/api-reference/2026-10/customers/list-customers)
- [Analytics: how every metric is calculated](https://polar.sh/docs/features/analytics)
- [Fees](https://polar.sh/docs/merchant-of-record/fees)
- [Orders](https://polar.sh/docs/features/orders) and [Refunds](https://polar.sh/docs/features/refunds)
- [Sandbox environment](https://polar.sh/docs/integrate/sandbox)
- [Multi-currency design document (Polar handbook)](https://handbook.polar.sh/engineering/design-documents/multi-currency)
- [Brand assets](https://polar.sh/brand) (the logomark in `src/components/icons.tsx`)
