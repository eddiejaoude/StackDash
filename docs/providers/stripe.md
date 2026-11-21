# Stripe

Provider id: `stripe`. Verification: documentation only.

StackDash reads your Stripe fees and revenue, and payment, refund, customer, and subscription events, to show them next to your costs. It installs as a Stripe App with seven read-only permissions and never writes to Stripe. This is separate from StackDash billing its own customers.

All facts below come from Stripe's documentation, checked 2026-10-31. Anything not confirmed by a doc is in [Unverified](#unverified).

## Summary

| Item | Value |
|---|---|
| Authentication | Stripe App with OAuth 2.0 (`stripe_api_access_type: "oauth"`, `distribution_type: "public"`) |
| Install link | `https://marketplace.stripe.com/oauth/v2/authorize?client_id=...&redirect_uri=...&state=...` |
| Token endpoint | `POST https://api.stripe.com/v1/oauth/token`, HTTP Basic auth with the app developer account's secret key |
| Access token lifetime | 1 hour |
| Refresh token | Rotated on every refresh, expires 1 year after it was issued or last rotated |
| Account id | `stripe_user_id` in the token response (`acct_...`) |
| Permissions | `event_read`, `charge_read`, `customer_read`, `subscription_read`, `invoice_read`, `balance_read`, `payout_read`. All read-only |
| API base | `https://api.stripe.com/v1` |
| Units | Integer amounts in the smallest currency unit, lowercase ISO 4217 currency, Unix timestamps in seconds (UTC) |
| Events history | `GET /v1/events` goes back up to 30 days |
| Rate limits | 100 requests per second per account in live mode, 25 in sandboxes, 25 per endpoint by default |
| Before review | Up to 25 external testers per app |
| Webhooks | Received for live mode and test mode installs at `/api/webhooks/stripe`, each delivery reaching only connections of its mode, with polling as the backfill (see [Webhooks](#webhooks)) |

## Connection

### How a user connects

1. In StackDash, the user picks Stripe in the provider catalog and sees the permissions and what is stored (see [Disclosure copy](#disclosure-copy)).
2. StackDash redirects to the install link with a fresh `state`.
3. On Stripe, the user picks an account, reviews the permissions, and installs the app. The user needs Apps administrator rights on that account.
4. Stripe redirects to `<SITE_URL>/api/connections/stripe/callback?code=ac_...&state=...`.
5. StackDash checks `state`, then exchanges the code for tokens on the server.

### Install link

```
https://marketplace.stripe.com/oauth/v2/authorize?client_id=${clientId}&redirect_uri=${redirectUrl}&state=${state}
```

| Parameter | Notes |
|---|---|
| `client_id` | The app's client id, shown in the install links in the Dashboard |
| `redirect_uri` | Optional. Must exactly match one entry in `allowed_redirect_uris` in the manifest. If omitted, Stripe uses the first entry. Live mode requires HTTPS |
| `state` | Recommended for CSRF protection. Stripe returns it unchanged. Use a unique, unguessable value and do not put sensitive data in it |

Links differ by where the app is installed:

- External test links (the **External test** or **External testing** section of the app in the Dashboard) work before the app is published. Use these until it is.
- Public links (the **Settings** tab) only work after the app is published to the Stripe App Marketplace. App review needs the live mode public link.
- There are separate links for live mode, the legacy test mode sandbox, and general sandboxes. Send each tester the link for the environment they will install into.

### Code exchange

The callback receives a one-time `code` that is valid for 5 minutes.

```bash
curl -X POST https://api.stripe.com/v1/oauth/token \
  -u sk_live_***: \
  -d code=ac_*** \
  -d grant_type=authorization_code
```

- Authentication is the **app developer account's secret API key** as the Basic auth username, with an empty password. There is no separate client secret, and `client_id` is not sent to the token endpoint.
- The key must match the environment of the link the user installed from:

| Link used | Key for the exchange and refreshes |
|---|---|
| Live mode link | App developer account's live mode secret key |
| Test mode link | App developer account's test mode secret key |
| Sandbox link | The app's managed sandbox secret key |

- Stripe's docs say to carry the link type in `state`. StackDash does not: `state` stays an opaque token. StackDash exchanges the code with the live mode key and, if Stripe refuses it and `STRIPE_APP_TEST_SECRET_KEY` is set, again with the test mode key, then records the mode from `livemode` in the response.
- Stripe warns that a restricted key, an access token, or a refresh token in place of the secret key fails with a permissions error. So the exchange needs a full secret key, not a restricted key. See [Permission risks](#permission-risks).

Response fields:

| Field | Use |
|---|---|
| `access_token` | Bearer token for API calls. Stored encrypted. Never logged |
| `refresh_token` | Stored encrypted. Never logged |
| `stripe_user_id` | The connected account id (`acct_...`). The connection's external id |
| `livemode` | `true` for live mode installs. Stored with the credential. A test mode account's name in StackDash ends in "(test mode)" |
| `scope` | Documented value is `stripe_apps` |
| `token_type` | `bearer` |
| `stripe_publishable_key` | Not read or stored |

The response has no `expires_in`. StackDash sets the access token's expiry to the time of the exchange plus 1 hour.

### API calls

The access token is the API key. Stripe's own check is `curl https://api.stripe.com/v1/customers -u "{{ ACCESS_TOKEN }}"`, which is Basic auth with the token as username. StackDash sends the equivalent, `Authorization: Bearer <access_token>`. The token is already scoped to the installing account, so StackDash sends no `Stripe-Account` header.

StackDash pins the API version with the `Stripe-Version` header to `2026-10-28.endive`, the version the API reference examples used on 2026-10-31.

### Refresh

```bash
curl -X POST https://api.stripe.com/v1/oauth/token \
  -u sk_live_***: \
  -d refresh_token={{ REFRESH_TOKEN }} \
  -d grant_type=refresh_token
```

- Access tokens expire after 1 hour. Refresh tokens expire after 1 year.
- Every refresh returns a new refresh token and the previous one expires. The new one is valid for a year from then, so a connection that syncs at least once a year never hits refresh token expiry.
- Because the old refresh token dies on use, **refreshes for one connection are serialized**. Two workers refreshing at once would mean one of them uses a dead token and the connection looks revoked. StackDash takes the connection's refresh lock, re-reads the stored credential inside it, refreshes only if still needed, and saves the new access token, refresh token, and expiry in one write before releasing the lock.
- If the save after a successful refresh fails, the stored refresh token is already dead. StackDash logs it (`credential_refresh.not_saved`) and does not retry with the old token: the connection asks to be reconnected on its next sync.
- Refreshes use the secret key of the environment recorded at the exchange. A test mode install falls back to `STRIPE_APP_SECRET_KEY` when `STRIPE_APP_TEST_SECRET_KEY` is not set.

### Test mode, live mode, and sandboxes

- A connection is one Stripe account in one environment, and live and test data never mix. Polled data comes from each connection's own mode's key, and each webhook delivery reaches only connections of the mode its `livemode` names (see [Webhooks](#webhooks)). StackDash records a connection's mode beside it (`connections.mode`) when the grant completes.
- `livemode=false` on objects and events does not say which kind of sandbox it came from.
- Sandbox installs of a public app need `sandbox_install_compatible: true` in the manifest and use the managed sandbox keys. StackDash does not support general sandbox installs: it has no setting for a managed sandbox key. It supports live mode and, for development, the legacy test mode link.

### Disconnect and uninstall

- Users uninstall the app in the Stripe Dashboard: **Settings** > **Installed apps**, the app's menu, **Uninstall**. Only an administrator can do this.
- Stripe sends `apps.install.deleted` and `account.application.deauthorized` when an account uninstalls the app. On API versions before 2026-09-30 the install events are named `app.install.created`, `app.install.updated`, and `app.install.deleted`. StackDash receives both uninstall events (and the older name) by webhook for live mode and test mode installs, and marks the account's connections of that mode as needing a reconnect at once (see [Webhooks](#webhooks)).
- Stripe documents no token revocation endpoint for Stripe Apps OAuth. Connect's `POST https://connect.stripe.com/oauth/deauthorize` is documented for Connect OAuth only; do not use it here (see [Unverified](#unverified)).
- So "Disconnect" in StackDash deletes the stored tokens, keeps the Stripe history already synced, and tells the user to uninstall the app in the Stripe Dashboard to remove StackDash's access on Stripe's side.
- An instance without the webhook secret for a mode (`STRIPE_WEBHOOK_SECRET` for live mode, `STRIPE_WEBHOOK_TEST_SECRET` for test mode, unless the account installed the app in both modes, whose test mode events also reach the live endpoint) gets no uninstall event for that mode: the uninstall shows up as a failed refresh or a failed API call with a valid token, and the next sync marks the connection as needing reconnection and stops syncing it. Uninstalling one mode's install never marks the other mode's connection of the same account.

### External testers and review

- An unpublished public app can be installed by up to 25 external testers. External testing is for testing only.
- Testers need Apps administrator rights on their Stripe account. After install, every member of that account can use the app.
- If the published version is already installed on an account, it must be uninstalled before the test version can be installed.
- Changing the external test version updates every tester's install.
- Testers must be told the app is in development and has not been reviewed by Stripe.
- Publishing needs Stripe's app review, about 4 business days. Any change to the app or the listing needs review again.

## Packaging the Stripe App

A Stripe App is a small project built and uploaded with the Stripe CLI and its `apps` plugin. StackDash's app only exists to request permissions and issue OAuth tokens. It has no UI in the Stripe Dashboard.

Tooling, as documented on 2026-10-31:

- Stripe CLI 1.25.0 or later (`stripe version`).
- Stripe Apps CLI plugin 1.19.0 or later: `stripe plugin install apps`, check with `stripe apps -v`.
- Node.js 22 or later, and pnpm 10 (pnpm 11 is not supported).

Commands:

```bash
stripe login
stripe apps create stackdash-connector
cd stackdash-connector
stripe apps grant permission "event_read" "Read payment, customer, subscription, and refund events to show them on your StackDash timeline"
stripe apps grant permission "charge_read" "Read payment and refund amounts to show revenue"
stripe apps grant permission "customer_read" "Count new customers. StackDash does not store customer names or emails"
stripe apps grant permission "subscription_read" "Count new and canceled subscriptions"
stripe apps grant permission "invoice_read" "Read paid invoice amounts to show revenue"
stripe apps grant permission "balance_read" "Read your balance and Stripe fees"
stripe apps grant permission "payout_read" "Read payout amounts and dates"
stripe apps upload
```

Manifest (`stripe-app.json`, the v1 manifest that `stripe apps create` generates):

```json
{
  "id": "com.example.stackdash-connector",
  "version": "0.0.1",
  "name": "StackDash connector",
  "icon": "./icon.png",
  "distribution_type": "public",
  "stripe_api_access_type": "oauth",
  "allowed_redirect_uris": [
    "https://stackdash.example.com/api/connections/stripe/callback"
  ],
  "permissions": [
    { "permission": "event_read", "purpose": "Read payment, customer, subscription, and refund events to show them on your StackDash timeline" },
    { "permission": "charge_read", "purpose": "Read payment and refund amounts to show revenue" },
    { "permission": "customer_read", "purpose": "Count new customers. StackDash does not store customer names or emails" },
    { "permission": "subscription_read", "purpose": "Count new and canceled subscriptions" },
    { "permission": "invoice_read", "purpose": "Read paid invoice amounts to show revenue" },
    { "permission": "balance_read", "purpose": "Read your balance and Stripe fees" },
    { "permission": "payout_read", "purpose": "Read payout amounts and dates" }
  ]
}
```

Manifest fields that matter:

| Field | Value | Notes |
|---|---|---|
| `id` | Globally unique slug | Validated by Stripe on first upload. Each self-hosted install picks its own |
| `name` | Display name | Public apps must not include the words "Stripe", "app", "free", or "paid" |
| `icon` | Relative path to a 300 x 300 PNG | |
| `distribution_type` | `public` | Required for OAuth and for external testers |
| `stripe_api_access_type` | `oauth` | Cannot be changed after the first upload |
| `allowed_redirect_uris` | Callback URLs | The first entry is the default redirect |
| `permissions` | Array of `{ permission, purpose }` | `purpose` is shown to the installing user |
| `sandbox_install_compatible` | Omit | Only for general sandbox installs, which StackDash does not support |

A v2 manifest (`stripe-app.yaml`) also exists. It nests the same values under `declarations` (`distribution_type`, `stripe_api_access_type`, `allowed_redirect_uris`, `stripe_api_access.permissions`). `stripe apps migrate` converts v1 to v2. Either works; keep whichever `stripe apps create` produces.

Account restrictions for the account that owns the app:

- One public app per Stripe account. Private apps can sit alongside it.
- A Stripe account with Connect enabled cannot publish an app.
- Publishing requires an activated account.

## Permissions

| Permission | Why StackDash needs it | What it also allows |
|---|---|---|
| `event_read` | Poll `GET /v1/events` for the timeline | Lists and retrieves all event types. Event payloads embed full objects, including customer emails and billing details |
| `charge_read` | The `charge.*` payment and refund events on the timeline | Full charge objects, including `billing_details` and `receipt_email` |
| `customer_read` | Customer events for "new customer" | Full customer records: names, emails, phone numbers, addresses |
| `subscription_read` | The subscription created and ended events | Full subscription objects |
| `invoice_read` | Not used: StackDash does not read invoices | Invoices include `customer_email`, `customer_name`, and more |
| `balance_read` | Balance transactions, for fees and revenue. StackDash does not read the current balance | Balance only |
| `payout_read` | Not used: StackDash does not read payouts | Payout objects, including the destination bank account id |

No write permission is requested. `balance_transaction_source_read` is not requested: StackDash does not expand `source` on balance transactions.

### Permission risks

- `customer_read`, `charge_read`, `invoice_read`, and `event_read` let StackDash read personal data about the user's customers. StackDash discards it at the parse boundary (see [Privacy](#privacy)), but the access is real and must be disclosed.
- Stripe's permission model is per object type. There is no field-level restriction, so data minimization is StackDash's job.
- The code exchange and every refresh use the app developer account's full secret key. Whoever runs a StackDash instance holds a live secret key for their app's Stripe account. Use a dedicated Stripe account that only owns the app and processes no payments, so that key can move no money.

### Disclosure copy

The connect screen lists the seven permissions, each with its purpose from the manifest above, then this under **Data collected**:

- Stripe fees per currency, this month and last 30 days
- Revenue net of refunds per currency, this month and last 30 days
- Payment, refund, new customer, and subscription events with Stripe ids, dates, and each payment's amount and currency
- Never customer names, emails, addresses, or card details

> Tokens are encrypted and stay on the server. You can disconnect at any time, and the provider's own settings let you revoke access too.

## Data

All list endpoints share cursor pagination: `limit` (1 to 100, default 10), `starting_after`, `ending_before`, and a `has_more` flag. Results come newest first. Most list endpoints accept `created[gt]`, `created[gte]`, `created[lt]`, `created[lte]` as Unix seconds.

| Metric or event | Endpoint | Key fields | Label |
|---|---|---|---|
| Stripe fees (`stripe.fees.<window>.<currency>`) | `GET /v1/balance_transactions` | `fee_details[].amount`, `fee_details[].currency`, `fee_details[].type`, `type`, `amount`, `currency`, `created` | Verified, spending |
| Revenue net of refunds (`stripe.revenue.<window>.<currency>`) | `GET /v1/balance_transactions` | `amount`, `type`, `currency`, `created` | Verified, revenue |
| Timeline events | `GET /v1/events` | `id`, `type`, `created`, `data.object.id`, plus the allowlisted fields of the object | Verified |

`<window>` is `month` (this calendar month, UTC) or `last_30_days`, and `<currency>` is the lowercase currency code. StackDash does not call `GET /v1/charges`, `GET /v1/invoices`, `GET /v1/subscriptions`, `GET /v1/balance`, or `GET /v1/payouts`: fees and revenue come from balance transactions alone, and customers and subscriptions appear only as timeline events.

### Fees

- `fee` is the total fee on a balance transaction in the smallest currency unit, positive when assessed. `fee_details` breaks it down: each entry has `amount`, `currency`, `type`, `application`, and `description`. Documented `type` values: `application_fee`, `payment_method_passthrough_fee`, `stripe_fee`, `tax`, `withheld_tax`.
- StackDash's "Stripe fees" is the sum of `fee_details[].amount` where `type` is `stripe_fee`, `payment_method_passthrough_fee`, or `tax`, grouped by `currency`. `application_fee` is not counted: that goes to a Connect platform, not Stripe.
- Some fees arrive as their own balance transactions with `type` `stripe_fee`, `stripe_fx_fee`, or `tax_fee` and a negative `amount`. StackDash counts those too, as `-amount`, so fees billed outside a charge are not missed. Fee credits net into the total, and a currency whose fees net to a credit gets no fee figure for that window.
- Balance transactions are in the account's settlement currency. If a charge is in EUR and the account settles in USD, the balance transaction is in USD with an `exchange_rate`. StackDash does not read `exchange_rate` (a float) and never converts currencies.

### Revenue

- Revenue is the sum of balance transactions with `type` `charge` or `payment` (gross `amount`) and `refund` or `payment_refund` (negative `amount`), per settlement `currency`, for this month and the last 30 days. They line up with fees in the same currency.
- StackDash does not read charges or invoices for revenue: an invoice payment also creates a charge, so adding the sources would count it twice. Totals are never summed across currencies.
- Each sync reads every balance transaction since the earlier of the start of the month and 30 days ago, up to 10 pages of 100. An account with more than 1,000 in that span gets no fee or revenue figures from that sync, rather than partial ones.

### Timeline events by polling

`GET /v1/events` with `types[]` set to these six (up to 20 names; `type` and `types` cannot be combined):

| Stripe event type | Timeline entry | Object fields read |
|---|---|---|
| `charge.succeeded` | Payment succeeded | `id`, `amount`, `currency` |
| `charge.failed` | Payment failed | `id`, `amount`, `currency`, `failure_code` |
| `charge.refunded` | Payment refunded, or partially refunded | `id`, `amount`, `amount_refunded`, `currency`, `refunded` |
| `customer.created` | New customer | `id` only |
| `customer.subscription.created` | Subscription created | `id`, `status` |
| `customer.subscription.deleted` | Subscription ended | `id`, `status` |

The adapter polls `charge.succeeded`, `charge.failed`, and `charge.refunded` for payments (Unverified item 1), reading `amount`, `amount_refunded`, `currency`, `refunded`, and `failure_code` from the charge. Payment titles carry the amount and its currency, formatted with the currency's own number of minor digits, one payment at a time and never summed: "Payment succeeded: $49.00", "Payment failed: ¥1,900", "Payment refunded: €49.00", and "Payment partially refunded: $9.00 of $49.00 so far". Stripe sends `charge.refunded` for every refund of a charge and `amount_refunded` is the running total, so a partial refund's title says "so far". A charge without an amount or currency gets the title alone. A failed payment's body is its `failure_code` as a plain sentence ("The card issuer declined the payment."); a code StackDash does not list reads "Stripe gave a reason StackDash does not recognize. Open the payment in your Stripe Dashboard to see it." The code itself is never shown.

Polling algorithm:

1. First sync: `created[gte]` = now minus 30 days, `limit=100`, page with `starting_after` = last id of the previous page until `has_more` is `false`. A sync reads at most 10 pages (1,000 events); past that, the oldest events of its window are skipped and the sync logs it.
2. Later syncs: `created[gte]` = the `created` of the newest event seen. Timestamps are whole seconds, so overlap at the boundary is expected. StackDash dedupes on the Stripe event id: a workspace stores each event id once.
3. `/v1/events` only goes back 30 days. If a connection has not synced for more than 30 days, events in the gap are gone. StackDash logs the gap and reads from 30 days back. On an instance that receives webhooks for the connection's mode, an event delivered by webhook is stored when it happens, so the gap only loses what a delivery also missed.
4. Each event's `data` is rendered in the API version that was current when the event was created (`api_version`), not the pinned `Stripe-Version`. The schemas accept only the few fields above and ignore everything else, so older shapes still parse.
5. `data.object` is a full snapshot that contains personal data. StackDash parses it with an allowlist schema and drops the raw payload at once. It is never logged.

### Units, granularity, freshness

- Amounts: integers in the smallest currency unit. Zero-decimal currencies (for example JPY) have no minor unit, so `100` means 100 yen. StackDash stores `amountMinor` plus currency and formats it with the currency's exponent.
- Currency: Stripe returns lowercase three-letter ISO codes. StackDash normalizes them to uppercase ISO 4217 at the parse boundary.
- Timestamps: Unix seconds, UTC. `available_on` and `arrival_date` are dates expressed as timestamps.
- Granularity: per object. StackDash totals fees and revenue per currency over two windows: this calendar month (UTC) and the last 30 days.
- Freshness: the API reflects objects as soon as they exist. A balance transaction has `status` `pending` until its `available_on`, but its `fee` is already set, and StackDash counts pending transactions too. StackDash syncs hourly, so fees and revenue are up to an hour old. Timeline events arrive within a minute where the instance receives webhooks for the connection's mode.

## Achievements

StackDash evaluates these for each project the Stripe accounts are assigned to, from the Stripe data it has stored, after each sync (see [Achievements](../adapters.md#achievements)). A project earns each one once, and it stays private until an owner or admin publishes it.

Counts only, never amounts. The payment and subscription ladder is the same on Polar. Payments count `stripe.charge.succeeded` events, subscriptions `stripe.customer.subscription.created`, and customers `stripe.customer.created`. Days and hours are London time.

| Id | Title | How it is earned |
|---|---|---|
| `stripe.payments.first` | First Stripe payment recorded | Earned when StackDash records the first successful Stripe payment. |
| `stripe.payments.10` | 10 Stripe payments recorded | Earned when StackDash records the 10th successful Stripe payment. |
| `stripe.payments.100` | 100 Stripe payments recorded | Earned when StackDash records the 100th successful Stripe payment. |
| `stripe.payments.1000` | 1,000 Stripe payments recorded | Earned when StackDash records the 1,000th successful Stripe payment. |
| `stripe.payments.payday` | Payday: 10 payments in one day | Earned when StackDash records 10 successful Stripe payments on one London calendar day. |
| `stripe.payments.while_you_slept` | While you slept: a payment between midnight and 5 am | Earned when StackDash records a successful Stripe payment between midnight and 5 am London time. |
| `stripe.subscriptions.first` | First Stripe subscription recorded | Earned when StackDash records the first new Stripe subscription. |
| `stripe.subscriptions.10` | 10 Stripe subscriptions recorded | Earned when StackDash records the 10th new Stripe subscription. |
| `stripe.customers.first` | First Stripe customer recorded | Earned when StackDash records the first new Stripe customer. |
| `stripe.customers.100` | 100 Stripe customers recorded | Earned when StackDash records the 100th new Stripe customer. |

## Rate limits and request budget

- Global: 100 requests per second per account in live mode, 25 in sandboxes. Most endpoints also have a limit of 25 requests per second each.
- Concurrency: about 50 in-flight requests in live mode. List requests are the expensive kind.
- Exceeded limits return `429` with a `Stripe-Rate-Limited-Reason` header: `global-rate`, `endpoint-rate`, `global-concurrency`, `endpoint-concurrency`, or `resource-specific`. A `429` without that header is a lock timeout (`code: lock_timeout`). StackDash retries the sync later for both, after `Retry-After` when Stripe sends one, otherwise with exponential backoff and full jitter.
- **Read request allocation:** an account's read requests must average no more than 500 per transaction over a rolling 30 days, with a minimum of 10,000 read requests per month. A quiet account with few payments has about 10,000 reads a month. StackDash syncs hourly, and each sync lists balance transactions and events, one request each while each fits in a page of 100: about 1,440 reads a month for a quiet account. A busy account needs more pages, and its transactions raise its allocation. Which account this allocation is charged to for Stripe Apps OAuth calls is not documented (see [Unverified](#unverified)).
- Every outbound call times out after 15 seconds.

## Privacy

StackDash stores only:

- Connection: `stripe_user_id`, `livemode`, `scope`, encrypted `access_token` and `refresh_token`, the access token's expiry, connected at, last synced at.
- Stripe event ids (`evt_`), as the timeline's dedupe key. No other Stripe object id is stored.
- Stripe fees and revenue net of refunds, as totals in minor units per currency, for this month and the last 30 days.
- Per timeline event: its type, its `created` time, and its title. A payment title carries the charge's `amount`, or for a refund `amount_refunded` and `amount`, with its currency. A failed payment's body is a fixed sentence chosen by `failure_code`, never the code itself.

Never store, never log:

- Names, emails, phone numbers, addresses: `name`, `email`, `phone`, `address`, `shipping`, `billing_details`, `receipt_email`, `customer_email`, `customer_name`, `customer_phone`, `customer_address`, `customer_shipping`.
- Card and payment method details: `payment_method_details` (brand, last 4, expiry, fingerprint, country), `payment_method`, `source`, `card`, payout `destination`.
- Free text that users or their customers can fill with anything: `description`, `metadata`, `statement_descriptor`, `failure_message`, `last_payment_error.message`, `fee_details[].description`.
- Secrets and keys: `client_secret` on payment intents, `stripe_publishable_key`, the developer secret key.
- Raw event payloads and raw API responses.
- `exchange_rate` (a float, and not needed).

A unit test syncs fixtures full of synthetic personal data and asserts that the metrics and events the adapter emits contain none of it, and none of the forbidden field names.

## Webhooks

StackDash receives Stripe's webhooks for live mode and test mode installs through the shared webhook route (see [Webhooks](../adapters.md#webhooks)), so a payment reaches the timeline within a minute instead of on the next hourly sync. Polling keeps running: it fills in fees, revenue, and any event a delivery missed. The app already holds `event_read`, so webhooks need no extra permission.

| Item | Value |
|---|---|
| Where the endpoints live | Two endpoints on the app owner's account, both at `<SITE_URL>/api/webhooks/stripe` with **Listen to events on Connected accounts**: one in live mode and one in test mode. Events from installs arrive with `account` set to the installing account, the connection's account id (`stripe_user_id`) |
| Signature | `Stripe-Signature: t=<timestamp>,v1=<signature>`: hex HMAC SHA-256 of `<t>.<raw body>` keyed with the endpoint's `whsec_` signing secret. Stripe gives each endpoint its own secret, and a different one in each mode ([Webhooks](https://docs.stripe.com/webhooks), "Retrieving your endpoint's secret"), so StackDash checks a delivery against `STRIPE_WEBHOOK_SECRET` (live mode endpoint) and `STRIPE_WEBHOOK_TEST_SECRET` (test mode endpoint), each one that is set. Every `v1` entry is compared in constant time and one must match, which covers a secret being rolled. Other schemes (`v0`, which Stripe adds to sandbox events) are ignored |
| Tolerance | 5 minutes either side of StackDash's clock, the default of Stripe's libraries. Stripe signs each delivery attempt afresh, so a retry is never stale |
| Delivery id | The Stripe event id (`evt_...`), read from the body once the signature matches. Stripe retries an event under the same id, so a retry is acknowledged as a duplicate. The id is inside the signed body, so a captured delivery cannot be sent again under a new one |
| Events | `charge.succeeded`, `charge.failed`, `charge.refunded`, `customer.created`, `customer.subscription.created`, `customer.subscription.deleted`: the six the sync polls, mapped by the same function with the same allowlists, so a pushed event and the same event polled later share a dedupe key (the event id) and show once |
| Mode | Every event and uninstall names its mode from the event's `livemode`, and reaches only connections of that mode, in every workspace that includes the account. A delivery only the test mode secret verifies must be a test mode one, or it is refused with `422`, so that secret can never reach a live connection. StackDash records a connection's mode when it is granted, and the database refuses a connected Stripe connection without one, so every connection a delivery can reach has its mode |
| Uninstall | `apps.install.deleted` (`app.install.deleted` on endpoints pinned before 2026-09-30) and `account.application.deauthorized`, in either mode. Either marks the account's connections of that mode as needing a reconnect at once. A connection granted again after the event's `created` time (a reconnect) is left to its next sync, because deliveries arrive late and out of order |
| Ignored | Events without `account` (the app owner's own account), event types the timeline does not show, and an object the allowlist rejects. Each is acknowledged so Stripe stops retrying, and none is stored. A rejected object is logged by event type only, and the next sync fails on the same event, which is where it surfaces |
| Not pushed | Fees and revenue stay polled |

The payment events are the `charge.*` ones the sync polls (Unverified item 1), not `payment_intent.*`: a payment intent event is a different Stripe event with its own id, so pushing it beside a polled charge event would show one payment twice.

**Both modes, one URL.** A public app's test mode install sends its events only to test mode endpoints, and an account that installed the app in both modes sends its test mode events to the live mode endpoint as well ([Handle different modes](https://docs.stripe.com/stripe-apps/handling-modes#webhooks), [Event behavior depends on install mode](https://docs.stripe.com/stripe-apps/build-backend#event-behavior-depends-on-install-mode)). Stripe is expected to send both copies under one event id, which makes the second a duplicate that is acknowledged and dropped, but neither page says so (Unverified item 13). A Stripe account id is the same in both modes, so StackDash routes each delivery by the mode its `livemode` names: a live payment never lands on a test mode connection, and a test mode uninstall never marks a live one. `livemode: false` does not say which kind of sandbox an event came from, and StackDash's app is not sandbox compatible, so every non-live event here is from the test mode sandbox.

Nothing is stored from a delivery but the timeline event the sync would store: `data.object` goes through the allowlists above and the raw body is dropped. Rejected deliveries are logged by reason only, never with their body.

## Self-hosted setup

Every self-hosted instance registers its own Stripe App, because the app's redirect URLs and the secret key used for the token exchange belong to one deployment.

1. Create or pick a Stripe account just for the app. It must not have Connect enabled. Activate it if you will publish. Each account can own only one public app.
2. Install the Stripe CLI (1.25.0 or later), run `stripe login` with that account, install the apps plugin (`stripe plugin install apps`, 1.19.0 or later). Node.js 22 or later and pnpm 10 are required.
3. Run `stripe apps create <your-app-name>`. Pick a globally unique app id.
4. Edit `stripe-app.json` as in [Packaging the Stripe App](#packaging-the-stripe-app). Set `allowed_redirect_uris` to `["<SITE_URL>/api/connections/stripe/callback"]`, with `<SITE_URL>` your public HTTPS origin. Add the seven permissions with `stripe apps grant permission`.
5. Run `stripe apps upload` from the app directory. The authentication type is fixed after this.
6. In the Dashboard, open **Created apps** in the account's live mode, select the app, click **Set external test version**, pick the uploaded version, and set **Access** to **Anyone with the link**.
7. Copy the OAuth install link for each environment you want to support. The `client_id` query parameter of that link is your client id.
8. Optional, for webhooks: in the Dashboard, in the account's live mode, open **Developers**, **Webhooks**, add an endpoint at `<SITE_URL>/api/webhooks/stripe`, select **Listen to events on Connected accounts**, and choose the eight events in [Webhooks](#webhooks). Copy its signing secret (`whsec_...`) into `STRIPE_WEBHOOK_SECRET`. To push test mode installs' events too, switch the Dashboard to test mode and add a second endpoint at the same URL with the same settings, and copy its signing secret into `STRIPE_WEBHOOK_TEST_SECRET`. Without either, Stripe is polled only.
9. Set the environment variables below and restart StackDash.
10. To go beyond 25 testers, submit the app for review and switch to the public links from the **Settings** tab after publishing.

Environment variables (server only, never `NEXT_PUBLIC_`):

| Variable | Value | Required |
|---|---|---|
| `STRIPE_APP_CLIENT_ID` | The `client_id` from the install link | Yes |
| `STRIPE_APP_SECRET_KEY` | Live mode secret key (`sk_live_...`) of the account that owns the app. Used as Basic auth username for code exchange and refresh of live mode installs | Yes, for live mode installs |
| `STRIPE_APP_TEST_SECRET_KEY` | Test mode secret key (`sk_test_...`) of the same account. Used for installs from the test mode link | Only to support test mode installs |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_...`) of the live mode webhook endpoint from step 8. Verifies live mode deliveries to `/api/webhooks/stripe`, and the test mode events of an account installed in both modes, which Stripe sends there too | Only to receive live mode webhooks. A delivery while neither webhook secret is set is answered `503` |
| `STRIPE_WEBHOOK_TEST_SECRET` | Signing secret (`whsec_...`) of the test mode webhook endpoint from step 8. Verifies test mode deliveries only: one it alone verifies that is not a test mode event is refused | Only to receive test mode webhooks |

There is no OAuth client secret for Stripe Apps; the secret key takes that role. Do not use a restricted key: Stripe documents that the exchange fails with one.

## Sample responses

All samples are from documentation, not recorded. Trimmed and synthetic.

Token exchange and refresh (same shape for both):

```json
{
  "access_token": "{{ ACCESS_TOKEN }}",
  "livemode": true,
  "refresh_token": "{{ REFRESH_TOKEN }}",
  "scope": "stripe_apps",
  "stripe_publishable_key": "pk_live_***",
  "stripe_user_id": "acct_***",
  "token_type": "bearer"
}
```

`GET /v1/balance_transactions?limit=3`:

```json
{
  "object": "list",
  "url": "/v1/balance_transactions",
  "has_more": false,
  "data": [
    {
      "id": "txn_1MiN3gLkdIwHu7ixxapQrznl",
      "object": "balance_transaction",
      "amount": -400,
      "available_on": 1678043844,
      "created": 1678043844,
      "currency": "usd",
      "description": null,
      "exchange_rate": null,
      "fee": 0,
      "fee_details": [],
      "net": -400,
      "reporting_category": "transfer",
      "source": "tr_1MiN3gLkdIwHu7ixNCZvFdgA",
      "status": "available",
      "type": "transfer"
    }
  ]
}
```

`GET /v1/events?limit=3` (the documented example is a `setup_intent.created` event; `data.object` trimmed):

```json
{
  "object": "list",
  "url": "/v1/events",
  "has_more": false,
  "data": [
    {
      "id": "evt_1NG8Du2eZvKYlo2CUI79vXWy",
      "object": "event",
      "api_version": "2019-02-19",
      "created": 1686089970,
      "data": {
        "object": {
          "id": "seti_1NG8Du2eZvKYlo2C9XMqbR0x",
          "object": "setup_intent",
          "created": 1686089970,
          "livemode": false,
          "status": "requires_confirmation"
        }
      },
      "livemode": false,
      "pending_webhooks": 0,
      "request": { "id": null, "idempotency_key": null },
      "type": "setup_intent.created"
    }
  ]
}
```

`GET /v1/balance`:

```json
{
  "object": "balance",
  "available": [{ "amount": 666670, "currency": "usd", "source_types": { "card": 666670 } }],
  "connect_reserved": [{ "amount": 0, "currency": "usd" }],
  "livemode": false,
  "pending": [{ "amount": 61414, "currency": "usd", "source_types": { "card": 61414 } }]
}
```

App install object, from the `apps.install.created` webhook event:

```json
{
  "object": "apps.install",
  "id": "appinst_1234",
  "account": "acct_1234",
  "app": "app_1234",
  "permissions_granted": [],
  "channel": "public",
  "created": 123,
  "livemode": true,
  "status": "installed"
}
```

## Unverified

Not yet confirmed with a test app and a test account:

1. **Event permissions for `payment_intent.*`.** Stripe says each event type needs at least one matching permission, but the event to permission table did not render in the docs. `payment_intent.succeeded` and `payment_intent.payment_failed` may need `payment_intent_read`, which StackDash does not request. So StackDash uses `charge.succeeded`, `charge.failed`, and `charge.refunded` for payments, which `charge_read` covers.
2. Whether `event_read` alone returns every event type from `GET /v1/events`, or only those whose object permissions are also granted.
3. Which account's read allocation (500 reads per transaction, 10,000 a month minimum) is charged for Stripe Apps OAuth calls: the installing account or the app developer account.
4. Whether the `client_id` is the same across live, test mode, and sandbox install links, and its format.
5. The error returned by the token endpoint for a used, expired, or revoked refresh token (likely an OAuth `invalid_grant`), and what an API call returns after uninstall. The adapter maps both to "needs reconnection".
6. The query parameters on the callback when a user cancels or declines the install (Connect OAuth uses `error` and `error_description`; not documented for Stripe Apps).
7. Whether `http://localhost` redirect URIs are accepted for test mode installs. Only live mode is documented as requiring HTTPS.
8. Whether an uninstall immediately invalidates outstanding access tokens, and whether any API revokes a Stripe Apps OAuth grant from StackDash's side. Connect's `/oauth/deauthorize` is not documented for Stripe Apps.
9. Whether `stripe apps upload` accepts an app with no UI views. The scaffold from `stripe apps create` includes a view, and the docs say auth-only apps should remove unnecessary UI.
10. Whether external testing works from a live account that is not activated. Docs require activation for publishing only.
11. Which `fee_details[].type` values cover all Stripe processing fees for every payment method (for example whether some fees post later as separate `stripe_fee` balance transactions).
12. Whether **Listen to events on Connected accounts** is offered on an app owner account without Connect enabled. The Stripe Apps event docs say to use it and do not mention Connect.
13. Whether the two copies of a test mode event that an account installed in both modes sends, one to each endpoint, carry the same event id. [Handle different modes](https://docs.stripe.com/stripe-apps/handling-modes#webhooks) and [Event behavior depends on install mode](https://docs.stripe.com/stripe-apps/build-backend#event-behavior-depends-on-install-mode) say only that the event goes to both endpoints, and [Webhooks](https://docs.stripe.com/webhooks), "Handle duplicate events", warns that two separate Event objects can be sent for one occurrence. If the ids differ, both copies are accepted, both name test mode, and the test mode connection shows the event twice: the timeline's dedupe key is the event id, and a poll of the account's events shares only one of the two ids.

## Go or no-go

Go. Self-serve OAuth with seven read-only permissions. StackDash reads Stripe fees and revenue net of refunds per currency from balance transactions, and payment, refund, customer, and subscription events, by hourly polling and, where the instance has the signing secrets, by webhook. Limits a user can trip on: installing needs Apps administrator rights on the Stripe account; until the app is published, at most 25 accounts can install it from the external test link; only live mode and test mode installs work, not general sandboxes; an account with more than 1,000 balance transactions since the earlier of the start of the month and 30 days ago gets no fee or revenue figures; and events more than 30 days old cannot be read. Items 1 to 3 in [Unverified](#unverified) are still open.

## Sources

All checked 2026-10-31, except the webhook pages, checked 2026-11-16, and the mode routing pages ([Handle different modes](https://docs.stripe.com/stripe-apps/handling-modes), [Event behavior depends on install mode](https://docs.stripe.com/stripe-apps/build-backend#event-behavior-depends-on-install-mode), and "Retrieving your endpoint's secret" in [Webhooks](https://docs.stripe.com/webhooks)), checked 2026-11-18.

- [Stripe Apps: OAuth 2.0](https://docs.stripe.com/stripe-apps/api-authentication/oauth)
- [Stripe Apps: API authentication methods](https://docs.stripe.com/stripe-apps/api-authentication)
- [Stripe Apps: permissions reference](https://docs.stripe.com/stripe-apps/reference/permissions)
- [Stripe Apps: app manifest reference](https://docs.stripe.com/stripe-apps/reference/app-manifest)
- [Stripe Apps: create an app](https://docs.stripe.com/stripe-apps/create-app)
- [Stripe Apps: upload and install your app](https://docs.stripe.com/stripe-apps/upload-install-app)
- [Stripe Apps: test your app externally](https://docs.stripe.com/stripe-apps/test-app)
- [Stripe Apps: publish your app](https://docs.stripe.com/stripe-apps/publish-app)
- [Stripe Apps: migrate a plugin to an OAuth 2.0 app](https://docs.stripe.com/stripe-apps/plugins/oauth)
- [Stripe Apps: enable sandbox support](https://docs.stripe.com/stripe-apps/enable-sandbox-support)
- [Stripe Apps: server-side logic](https://docs.stripe.com/stripe-apps/build-backend)
- [Stripe Apps: listen for events](https://docs.stripe.com/stripe-apps/events)
- [Support: how can I uninstall an app](https://support.stripe.com/questions/how-can-i-uninstall-an-app)
- [API: list all events](https://docs.stripe.com/api/events/list)
- [API: the Event object](https://docs.stripe.com/api/events/object)
- [API: types of events](https://docs.stripe.com/api/events/types)
- [API: the Balance Transaction object](https://docs.stripe.com/api/balance_transactions/object)
- [API: list all balance transactions](https://docs.stripe.com/api/balance_transactions/list)
- [API: the Balance object](https://docs.stripe.com/api/balance/balance_object)
- [API: the Charge object](https://docs.stripe.com/api/charges/object)
- [API: list all charges](https://docs.stripe.com/api/charges/list)
- [API: the Invoice object](https://docs.stripe.com/api/invoices/object)
- [API: the Subscription object](https://docs.stripe.com/api/subscriptions/object)
- [API: list subscriptions](https://docs.stripe.com/api/subscriptions/list)
- [API: the Payout object](https://docs.stripe.com/api/payouts/object)
- [API: pagination](https://docs.stripe.com/api/pagination)
- [Rate limits](https://docs.stripe.com/rate-limits)
- [Webhooks](https://docs.stripe.com/webhooks), "Verify signatures manually"
- [Stripe Apps: handle different modes](https://docs.stripe.com/stripe-apps/handling-modes)
- [Stripe Apps: event behavior depends on install mode](https://docs.stripe.com/stripe-apps/build-backend#event-behavior-depends-on-install-mode)
- [Connect OAuth reference](https://docs.stripe.com/connect/oauth-reference) (for the deauthorize endpoint that does not apply here)
