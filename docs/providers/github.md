# GitHub

Provider id: `github`. Verification: documentation only. Docs checked 2026-10-31.

DevMacro reads your GitHub billing usage by product, including Actions minutes, storage, and Copilot, plus stars, star history, and forks. It installs as a GitHub App with three read-only permissions.

## Go or no-go

**Go for the MVP, with one scope correction.** A GitHub App with three read-only permissions covers everything DevMacro reads: organization billing usage by product and SKU (Actions minutes, storage, Copilot, and every other metered product), star count, star history, and forks. Organization data uses short-lived installation access tokens. Personal account billing is only readable with a user access token, so personal accounts also need the user authorization step.

The correction: **since 2026-06-01 every Copilot plan is billed in GitHub AI Credits, not premium requests** ([changelog](https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/)). Premium requests now only apply to Copilot Pro and Pro+ annual plans that stayed on legacy billing. The adapter should read `GET /organizations/{org}/settings/billing/ai_credit/usage` for Copilot spend and keep `premium_request/usage` only as a legacy fallback. The landing page's Copilot row names AI Credits for the same reason.

## Connection

GitHub App, installed on a user or organization account, plus a one-time user authorization (web application flow) that proves the installing user owns the installation.

| Item | Value |
|---|---|
| Install URL | `https://github.com/apps/<GITHUB_APP_SLUG>/installations/new?state=<state>` (browser navigation) |
| Setup URL | `<SITE_URL>/api/connections/github/callback`. GitHub redirects here after install with `installation_id` |
| User authorize URL | `GET https://github.com/login/oauth/authorize` (browser navigation) |
| User token URL | `POST https://github.com/login/oauth/access_token` |
| Callback URL (user authorization) | `<SITE_URL>/api/connections/github/callback` (same route as the setup URL) |
| API base URL | `https://api.github.com` |
| API version header | `X-GitHub-Api-Version: 2026-03-10` (latest). `2022-11-28` is supported until 2028-03-10. Requests without the header get `2022-11-28` |
| App JWT | RS256, signed with the app private key. `iat` 60 seconds in the past, `exp` at most 10 minutes ahead, `iss` = client ID (recommended) or app ID |
| Installation access token | 1 hour. Minted with the JWT. Starts with `ghs` and an underscore. Since 2026-04-27 new tokens roll out in a longer stateless format (that prefix, the app ID, an underscore, then a JWT), so never assume 40 characters |
| User access token | 8 hours (`expires_in: 28800`), starts with `ghu` and an underscore. Only when "Expire user authorization tokens" is on (the default) |
| Refresh token | 6 months (`refresh_token_expires_in: 15897600`), starts with `ghr` and an underscore, rotates on every use |
| Private key | PEM, PKCS#1 (`BEGIN RSA PRIVATE KEY`). Never expires. Up to 25 keys per app, for rotation |

### Install

1. A workspace owner or admin clicks Connect GitHub. DevMacro creates a random `state` bound to the session and workspace (short TTL, single use) and redirects to the install URL. "Sharing your GitHub App" documents `state` on the install URL as a way to correlate an installation to a user.
2. On GitHub the user picks the account (personal or organization), chooses all or selected repositories, and approves the permissions.
3. GitHub redirects to the setup URL with `installation_id`. In practice it also sends `setup_action` (`install` or `update`) and the `state`, but `setup_action` is not in the official docs (see Unverified).
4. **Never trust `installation_id` from the query string.** The setup URL docs warn that it can be spoofed and say to generate a user access token and check that the installation belongs to that user. So the callback does not save anything yet. It starts the web application flow below.

If an organization member without owner rights installs, GitHub sends the owner a request instead of installing ([requesting a GitHub App](https://docs.github.com/en/apps/using-github-apps/requesting-a-github-app-from-your-organization-owner)). The callback must then show "Waiting for an organization owner to approve" and not create a connection. Whether the redirect carries `setup_action=request` and no `installation_id` is unverified.

### User authorization (verifies the installation)

Do **not** enable "Request user authorization (OAuth) during installation": when it is on, GitHub disables the setup URL and always uses the first callback URL. Run the flow explicitly instead.

Authorize query: `client_id`, `redirect_uri` (must exactly match a registered callback URL), `state` (new value, bound to the pending `installation_id`), `code_challenge` and `code_challenge_method=S256` (PKCE, `plain` is not supported). Do not send `scope`: GitHub Apps have no scopes; the only accepted value is `offline_access`, which forces expiring tokens, and that is already the default.

Exchange: `POST https://github.com/login/oauth/access_token` with `client_id`, `client_secret`, `code`, `redirect_uri`, `code_verifier`. Response fields: `access_token`, `expires_in`, `refresh_token`, `refresh_token_expires_in`, `scope` (always empty), `token_type` (`bearer`). A mismatched `state` means abort.

Then:

1. `GET /user/installations` with the user token (paginate, `per_page=100`). The `installation_id` must be in the list, otherwise reject.
2. `GET /app/installations/{installation_id}` with the app JWT. Read `account.login`, `account.id`, `account.type` (`User` or `Organization`), `target_type`, `repository_selection` (`all` or `selected`), `permissions`, `suspended_at`.
3. Persist the connection: installation id, account id, login, and type. Store the account **id** as the stable key; logins can be renamed.
4. Personal account (`account.type = User`): keep the user refresh token, encrypted, because the user billing endpoints only accept user access tokens. Organization: the user token is not needed after step 1, so revoke it with `DELETE /applications/{client_id}/token` and store nothing.

A user access token only has permissions both the app and the user hold. For personal billing that is fine: the account holder can always read their own billing.

### Installation access tokens (every sync)

1. Build the JWT in memory from `GITHUB_APP_PRIVATE_KEY`.
2. `POST /app/installations/{installation_id}/access_tokens` with `Authorization: Bearer <JWT>`. Narrow the token with the body: `{"permissions": {"metadata": "read", "organization_administration": "read"}}`. Optional `repositories` or `repository_ids` (up to 500) narrow it further.
3. Use the token until `expires_at` minus a margin, then mint a new one. Do not persist installation tokens; mint per sync run. Expired tokens return `401`.

### User token refresh (personal accounts only)

`POST https://github.com/login/oauth/access_token` with `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token`. The response holds a new access token **and a new refresh token**; the old pair stops working at once. Serialize refreshes per connection and persist the new pair atomically before use. `bad_refresh_token` means the user must authorize again. A refresh token unused for 6 months expires, so a daily sync keeps it alive.

### Disconnect and revoke

- From DevMacro: `DELETE /app/installations/{installation_id}` with the JWT uninstalls the app from that account. Also revoke the stored user grant with `DELETE /applications/{client_id}/grant` (Basic auth `client_id:client_secret`, body `{"access_token": "..."}`), which removes every token for that user. Delete stored tokens either way.
- From GitHub: the user can uninstall or suspend the app in account or organization settings, or revoke the user authorization. Without webhooks (Post-MVP), DevMacro finds out on the next sync: token minting or API calls fail. Treat `401` on a user token, and `404` or `403` when minting an installation token, as "needs reconnection" and stop retrying. Exact status codes for uninstalled and suspended installations are unverified.
- Revoking the user authorization does not uninstall the app.

## Permissions

All read-only. Nothing in this list can write.

| Permission (GitHub UI group) | Level | Why | Token types |
|---|---|---|---|
| Repository: Metadata | Read | Repo details, star count, star history, forks, list of installed repositories. Mandatory for every GitHub App | Installation, user |
| Organization: Administration | Read | Organization billing usage, usage summary, AI credit usage, premium request usage, budgets | Installation, user |
| Account: Plan | Read | Personal account billing usage, usage summary, AI credit usage, premium request usage | User only |

Not requested: Contents (only needed for the `fork` webhook, Post-MVP), Organization plan, Actions. `GET /installation/repositories` needs no permission beyond the installation token.

Organization owners approve "Administration: read" at install time. On a personal account install, the organization permission has no effect.

## Data

### Which repositories

`GET /installation/repositories` (installation token, `per_page=100`, paginate). Returns the repositories the owner granted. Respect `repository_selection`: a "selected" install only shows chosen repositories. Re-read every sync because users add and remove repositories.

### Billing usage, organization: `GET /organizations/{org}/settings/billing/usage`

Daily line items for every metered product. **Only for organizations on the enhanced billing platform**; others get an error (see Unverified for the exact code).

| Query | Meaning |
|---|---|
| `year` | Four digit year, default current year |
| `month` | 1 to 12. No default documented: omitting it returns the whole year |
| `day` | 1 to 31 |

Each `usageItems[]` entry: `date` (string, one UTC day), `product` (for example `Actions`), `sku` (for example `Actions Linux`), `quantity` (integer, in `unitType`), `unitType` (for example `minutes`), `pricePerUnit` (USD number), `grossAmount`, `discountAmount`, `netAmount` (USD numbers), `organizationName`, `repositoryName` (optional, `owner/repo`).

Granularity: per day, product, SKU, and repository where the product has one. `netAmount = grossAmount - discountAmount` is what GitHub bills; `discountAmount` covers included usage and free usage (for example standard runners in public repositories). Request `year` and `month` for the current month on each sync, and the previous month during the first days of a new month to pick up late usage.

### Billing usage summary, organization: `GET /organizations/{org}/settings/billing/usage/summary`

Public preview, subject to change. Aggregated over the requested period (default: current month). Extra filters: `repository` (`owner/repo`), `product`, `sku`. Response: `timePeriod` (`year`, `month`, `day`), `organization`, and `usageItems[]` with `product`, `sku`, `unitType`, `pricePerUnit`, `grossQuantity`, `grossAmount`, `discountQuantity`, `discountAmount`, `netQuantity`, `netAmount`. Only the last 24 months are available. Use it for the month-to-date total per product; use `/usage` for the daily chart.

DevMacro stores the same money at three levels: month to date per product (`github.spend.<product>`), per SKU (`github.spend.<product>.<sku>`), and per product per UTC day (`github.daily_spend.<product>`). Spend totals, alerts, and the daily summary count only the month to date per product. A SKU row is a breakdown of its product, and a day row lies inside the month, so neither is added again (`countedSnapshots` in `src/lib/dashboard/aggregate.ts`).

### AI credits, organization: `GET /organizations/{org}/settings/billing/ai_credit/usage`

Copilot usage since 2026-06-01. Filters: `year`, `month`, `day`, `user`, `model`, `product`. Response: `timePeriod`, `organization`, and `usageItems[]` with `product`, `sku`, `model`, `unitType`, `pricePerUnit`, `grossQuantity`, `grossAmount`, `discountQuantity`, `discountAmount`, `netQuantity`, `netAmount`. Included credits are pooled across the organization; `discountAmount` is the part covered by the pool, `netAmount` the billed overage. Last 24 months only. No per-item date: for a daily series, query with `day`.

### Premium requests, organization: `GET /organizations/{org}/settings/billing/premium_request/usage`

Same parameters and schema as AI credits, with `unitType: "requests"`. Legacy since 2026-06-01. Keep it as a fallback so months before June 2026 still show, and in case an account still has premium request rows. Last 24 months only.

### Budgets, organization: `GET /organizations/{org}/settings/billing/budgets`

Optional, same Administration read permission. Each budget has `budget_type`, `budget_product_skus` or `budget_product_sku`, `budget_scope`, `budget_amount` (**whole US dollars**, or a license count for license products), `prevent_further_usage`, `budget_alerting`. Gives DevMacro a real limit to compare spend against. Paginated (`per_page` max 100, default 10, `has_next_page`).

### Personal account equivalents (user access token, Account: Plan read)

| Endpoint | Notes |
|---|---|
| `GET /users/{username}/settings/billing/usage` | Same item schema as the organization report without `organizationName`. Enhanced billing platform only |
| `GET /users/{username}/settings/billing/usage/summary` | Public preview. Filters `repository`, `product`, `sku` |
| `GET /users/{username}/settings/billing/ai_credit/usage` | Filters `model`, `product` |
| `GET /users/{username}/settings/billing/premium_request/usage` | Legacy, filters `model`, `product` |

Installation tokens do **not** work on these. They only cover usage billed to the personal account: Copilot seats paid by an organization show up in that organization's report, not the user's. There is no personal account budgets endpoint in the billing reference.

### Repository: `GET /repos/{owner}/{repo}`

`stargazers_count`, `forks_count`, `watchers_count` (equals stars, legacy naming), `subscribers_count` (actual watchers), `private`, `visibility`, `fork`, `archived`, `pushed_at`. Never log the response: it can contain `temp_clone_token`, a 5 minute read credential.

### Star count: `GET /repos/{owner}/{repo}/stargazers/count`

Returns `{ "count": 42 }`. Current stars; users who unstarred are not included. Cheapest call for milestones.

### Star history: `GET /repos/{owner}/{repo}/stargazers/history`

Stars grouped by calendar week, newest first. Each item: `week` (Unix seconds, start of week), `total` (stars that week), `days` (7 integers, Sunday first). Weeks without stars contain zeros. `per_page` max 30, `page` max 100. Pages go back to the repository's creation week; concatenating pages gives one continuous series. **Week and day boundaries are not guaranteed to align with UTC.** Use it to backfill history on first connect and to show recent weeks, not for exact UTC days.

### Stargazer list: avoid

`GET /repos/{owner}/{repo}/stargazers` with `Accept: application/vnd.github.star+json` adds `starred_at` per user. Since July 2026 GitHub limits this endpoint to admins and collaborators and may return empty results or `403` ([changelog](https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/)). It also returns personal data (logins, avatars) DevMacro does not need. Use count and history instead.

### Forks: `GET /repos/{owner}/{repo}/forks`

`sort=newest` (default), `per_page` max 100. Each item is a repository: `id`, `full_name`, `owner.login`, `created_at` (when the fork was made), `private`. On each sync read the first page and stop at the first fork id already seen. Store the fork `id` and `created_at` for de-duplication; do not store owner logins. `forks_count` on the repository is the total.

### Units, freshness, retention

- Money: every amount is a JSON number in US dollars, with sub-cent prices (`pricePerUnit: 0.008`). No currency field is returned; USD is the inference from GitHub's billing docs, which price everything in USD. Convert at the parse boundary to integer cents (`amountMinor`, `currency: "USD"`) with decimal string arithmetic, never by multiplying floats. Keep `pricePerUnit` as the original decimal string. Round per line item and note that DevMacro totals can differ from GitHub's by a few cents.
- Quantities: `minutes`, `requests`, `credits` or `ai-credits`, and storage in GB-hours for Actions storage (GitHub's GB is 2^30 bytes). Always store the `unitType` string next to the number.
- Dates: billing `date` is a UTC day. Star history weeks are not UTC aligned.
- Freshness: not documented for the REST endpoints. Actions artifact storage usage updates "within 6 to 12 hours". Treat the current day as provisional and re-read it on the next sync.
- Retention: summary, AI credit, and premium request endpoints return the last 24 months only.

### Timeline events (by polling)

| Event | Source | Rule |
|---|---|---|
| New stars | Daily snapshot of `/stargazers/count` | One event per UTC day with the net change, if positive. Unstars reduce it, so it is net, not gross |
| Star milestone | `/stargazers/count` | When the count first reaches 100, 500, 1,000, then every further 1,000. Fire once per milestone per repository, even if the count dips and rises again |
| New fork | `/forks` (newest first) | One event per new fork id, at its `created_at`. Summarize per day if there are many |
| Spend started | `/usage/summary` | First non-zero `netAmount` for a product in a month: included usage has run out |
| Daily spend | `/usage` | Net spend per product per UTC day |
| Budget threshold | `/budgets` plus `/usage/summary` | Month-to-date net spend crosses 75, 90, or 100 percent of a budget (GitHub's own alert levels) |

## Achievements

DevMacro evaluates these for each project the GitHub accounts are assigned to, from the GitHub data it has stored, after each sync (see [Achievements](../adapters.md#achievements)). A project earns each one once, and it stays private until an owner or admin publishes it.

The star thresholds read the stored `github.stars.total` snapshots. When the first snapshot DevMacro stored is already at or above a threshold, the achievement says "Recorded at least" that many, because DevMacro did not see the crossing. Trending compares the last snapshot of a London day with the last of the day before. The fork achievements count `github.forks.new` events, and Steady glow and Weekend stargazers read `github.stars.daily`, which is emitted only for a repository whose star count rose over a UTC day (a day with no net gain has no event).

`github.stars.daily` is dated to the end of its UTC day: 00:00 UTC the next day, which is always the next London date. Saturday's and Sunday's stars therefore arrive as Sunday and Monday events, so Weekend stargazers looks for a two-day run that starts on a Sunday. Steady glow needs no such change: every day moves by one, so 7 consecutive days stay consecutive.

| Id | Title | How it is earned |
|---|---|---|
| `github.stars.10` | 10 GitHub stars | Earned when DevMacro records 10 or more stars across the connected GitHub repositories. |
| `github.stars.100` | 100 GitHub stars | Earned when DevMacro records 100 or more stars across the connected GitHub repositories. |
| `github.stars.1000` | 1,000 GitHub stars | Earned when DevMacro records 1,000 or more stars across the connected GitHub repositories. |
| `github.stars.10000` | 10,000 GitHub stars | Earned when DevMacro records 10,000 or more stars across the connected GitHub repositories. |
| `github.stars.777` | Lucky sevens: 777 GitHub stars | Earned when DevMacro records 777 or more stars across the connected GitHub repositories. |
| `github.stars.1024` | Kilostar: 1,024 GitHub stars | Earned when DevMacro records 1,024 or more stars across the connected GitHub repositories. |
| `github.stars.hot_day` | Trending: 10 new stars in one day | Earned when the stars across the connected GitHub repositories rise by 10 or more in one London calendar day. |
| `github.stars.steady_glow` | Steady glow: new stars on 7 days in a row | Earned when DevMacro records new stars on a connected GitHub repository on each of 7 consecutive days. |
| `github.stars.weekend` | Weekend stargazers: new stars on a Saturday and the Sunday after it | Earned when DevMacro records new stars on a connected GitHub repository on a Saturday and on the Sunday after it. |
| `github.forks.first` | First fork recorded | Earned when DevMacro records the first new fork of a connected GitHub repository. |
| `github.forks.10` | 10 forks recorded | Earned when DevMacro records the 10th new fork of a connected GitHub repository. |
| `github.forks.100` | 100 forks recorded | Earned when DevMacro records the 100th new fork of a connected GitHub repository. |
| `github.forks.party` | Fork party: 5 forks in one day | Earned when DevMacro records 5 new forks of the connected GitHub repositories on one London calendar day. |

## Verified, estimated, unavailable

| Value | Status |
|---|---|
| Net, gross, discount amounts per product and SKU per day (org and personal) | Verified (GitHub's billed figures; the current month is provisional until invoiced) |
| AI credit and premium request quantities and amounts | Verified |
| Budgets and their amounts | Verified |
| Star count, fork count, new fork ids and times | Verified |
| Star history per week | Verified counts; days are approximate because boundaries are not UTC |
| Daily new stars from count snapshots | Verified net change at poll time; gross stars per day unavailable |
| Month-end spend projection | Estimated (DevMacro extrapolation) |
| Included allowance remaining (for example "$12 of Actions compute left") | Estimated: `discountAmount` is returned, the plan allowance is not; it would come from GitHub's pricing docs |
| Invoices, payment history, plan name | Unavailable through these permissions |
| Per user and per workflow usage | Unavailable (detailed report is web only; AI credit `user` filter exists for orgs) |
| Billing for organizations not on the enhanced billing platform | Unavailable |
| Enterprise billing | Unavailable (GitHub App access to enterprise billing is not generally available) |
| Who starred, and when (per user) | Unavailable in practice (restricted since July 2026, and not wanted) |

## Rate limits

- Installation tokens: 5,000 requests per hour per installation, plus 50 per hour per repository above 20 and 50 per hour per organization user above 20, capped at 12,500. GitHub Enterprise Cloud organizations: 15,000.
- User access tokens: share the user's 5,000 per hour with every other app and personal token the user runs.
- Secondary limits: at most 100 concurrent requests, 900 points per minute for REST (`GET` costs 1), 90 seconds of CPU per minute, and 2,000 OAuth token requests per hour per app. Some endpoints cost more, undisclosed.
- Headers: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-used`, `x-ratelimit-reset` (UTC epoch seconds), `x-ratelimit-resource`. Values can vary between responses because of multiple regions; use them for pacing, not exact counting.
- Exceeded: `403` or `429`. If `retry-after` is present, wait that many seconds. If `x-ratelimit-remaining` is `0`, wait until `x-ratelimit-reset`. Otherwise wait at least one minute, then back off exponentially and give up after a fixed number of tries. Continuing while limited can get the app banned.
- Budget: per repository per sync about 3 requests (count, history page 1, forks page 1) plus about 4 billing calls per account. 100 repositories hourly is about 300 requests per hour, well under the limit. Run requests serially per installation.

## Webhooks (Post-MVP)

Polling only for the MVP. When webhooks arrive:

- One webhook URL per app, set in the app registration, with a secret. Each delivery carries `X-Hub-Signature-256: sha256=<hex>`, an HMAC SHA-256 of the raw request body keyed with the secret. Compute over the raw bytes as UTF-8 and compare in constant time (`crypto.timingSafeEqual`). Ignore the legacy SHA-1 `X-Hub-Signature`. GitHub's test vector: secret `It's a Secret to Everybody`, payload `Hello, World!`, signature `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`.
- Useful events: `installation` (`created`, `deleted`, `suspend`, `unsuspend`, `new_permissions_accepted`) and `installation_repositories`, both sent to every app by default; `github_app_authorization` (user revoked; cannot be unsubscribed); `star` (`created` with `starred_at`, `deleted`), which needs Metadata read; `fork`, which needs **Contents read**, a broader permission. Keep polling forks rather than adding Contents.
- No billing webhooks exist in the docs checked. Spend stays polled.

## Permission risks

Disclose these on the connect screen before redirecting:

- **Organization Administration read** is broader than billing. It also reads organization Actions settings and permissions, hosted runner details, code security configurations, security managers, secret scanning custom patterns, interaction limits, the organization's app installations, and Copilot seat assignments (`/orgs/{org}/copilot/billing/seats`, which lists members). DevMacro calls only the billing endpoints, but the token can read the rest.
- **Repository Metadata read** on private repositories also exposes the collaborator list and permissions, contributors, commit comments, repository events, and languages. DevMacro reads only repository details, stars, and forks.
- **Account Plan read** (personal accounts) reads that user's billing usage and plan. It is held through a refresh token valid for 6 months, the longest-lived secret in this adapter. Encrypt it at rest.
- The **private key** can mint tokens for every installation of the app. It never expires. Store it only in the server environment, never in the database or logs; rotate by adding a new key, deploying, then deleting the old one.
- Installation tokens default to every permission and repository the installation has. Always narrow `permissions` when minting.
- Org installs need an organization owner; the connect screen should say so.

## Limitations

- The billing usage report requires the enhanced billing platform. Organizations still on legacy billing get no billing data; stars and forks still work.
- Copilot moved to AI credits on 2026-06-01. Premium request data before that date is in the premium request endpoint; after it, in the AI credit endpoint. Show both under one "Copilot" row, by `unitType`.
- The usage summary endpoints are in public preview and may change. Validate every response with zod and fail the sync on schema drift instead of guessing.
- No per-workflow or per-user detail through the API (organization owners cannot see per-user AI usage in the UI either; the API `user` filter exists).
- Only 24 months of history for summary, AI credit, and premium request data.
- Star history days are not UTC aligned; daily star events come from count snapshots and are net.
- The stargazer list is restricted; DevMacro never knows who starred.
- One installation per account. A user with a personal account and two organizations installs three times and gets three connections.
- Enterprise accounts are out of scope.

## Self-hosted registration

Each deployment registers its own GitHub App, because the private key, client secret, and URLs belong to one deployment.

1. GitHub, profile picture, **Settings**, **Developer settings**, **GitHub Apps**, **New GitHub App**. To own it as an organization, use the organization's **Settings**, **Developer settings** instead.
2. **GitHub App name**: for example `DevMacro (your name)`. The URL-safe form shown on the app's public page (`https://github.com/apps/<slug>`) is `GITHUB_APP_SLUG`.
3. **Homepage URL**: `<SITE_URL>`.
4. **Callback URL**: `<SITE_URL>/api/connections/github/callback`.
5. Leave **Expire user authorization tokens** checked. Leave **Request user authorization (OAuth) during installation** unchecked (it disables the setup URL). Leave **Enable Device Flow** unchecked.
6. **Setup URL**: `<SITE_URL>/api/connections/github/callback`. Check **Redirect on update**, so adding or removing repositories returns to DevMacro.
7. **Webhook**: uncheck **Active** for the MVP.
8. **Permissions**: Repository, Metadata: Read-only (preselected). Organization, Administration: Read-only. Account, Plan: Read-only. Leave everything else at No access.
9. **Where can this GitHub App be installed?**: **Any account** for a shared deployment, **Only on this account** for a single-user self-host.
10. **Create GitHub App**. On the settings page note the **App ID** and **Client ID**, click **Generate a new client secret**, and under **Private keys** click **Generate a private key** (downloads a PEM file).
11. Set the environment variables:

| Variable | Value |
|---|---|
| `GITHUB_APP_ID` | Numeric App ID. Accepted as JWT `iss`; GitHub recommends the client ID instead |
| `GITHUB_APP_SLUG` | Slug from the app's public page URL. Builds the install URL |
| `GITHUB_APP_PRIVATE_KEY` | Full PEM contents, PKCS#1. If your host cannot store multiline values, store it with `\n` escapes and convert back when loading |
| `GITHUB_APP_CLIENT_ID` | Client ID (different from the App ID). Used as JWT `iss` and in the user authorization flow |
| `GITHUB_APP_CLIENT_SECRET` | Client secret. Shown once |

Check the key with GitHub's fingerprint command and compare to the settings page: `openssl rsa -in key.pem -pubout -outform DER | openssl sha256 -binary | openssl base64`.

## Sample responses

All samples are from documentation, not recorded. Trimmed and synthetic; replace with recorded, sanitized fixtures before tests rely on them.

Setup URL redirect after install (from documentation, not recorded; `setup_action` and `state` assumed, see Unverified):

```
<SITE_URL>/api/connections/github/callback?installation_id=12345678&setup_action=install&state=AB12t
```

`POST /app/installations/{installation_id}/access_tokens` (from documentation, not recorded; the token is shown as a placeholder):

```json
{
  "token": "<installation-token>",
  "expires_at": "2016-07-11T22:14:10Z",
  "permissions": { "metadata": "read", "organization_administration": "read" },
  "repository_selection": "selected"
}
```

`POST https://github.com/login/oauth/access_token` (from documentation, not recorded; the tokens are shown as placeholders):

```json
{
  "access_token": "<user-access-token>",
  "expires_in": 28800,
  "refresh_token": "<refresh-token>",
  "refresh_token_expires_in": 15897600,
  "scope": "",
  "token_type": "bearer"
}
```

`GET /user/installations` (from documentation, not recorded):

```json
{
  "total_count": 1,
  "installations": [
    {
      "id": 1,
      "account": { "login": "octocat", "id": 1, "type": "User" },
      "repository_selection": "all",
      "target_type": "User",
      "suspended_at": null
    }
  ]
}
```

`GET /organizations/{org}/settings/billing/usage` (from documentation, not recorded):

```json
{
  "usageItems": [
    {
      "date": "2023-08-01",
      "product": "Actions",
      "sku": "Actions Linux",
      "quantity": 100,
      "unitType": "minutes",
      "pricePerUnit": 0.008,
      "grossAmount": 0.8,
      "discountAmount": 0,
      "netAmount": 0.8,
      "organizationName": "GitHub",
      "repositoryName": "github/example"
    }
  ]
}
```

`GET /organizations/{org}/settings/billing/usage/summary` (from documentation, not recorded):

```json
{
  "timePeriod": { "year": 2025 },
  "organization": "GitHub",
  "usageItems": [
    {
      "product": "Actions",
      "sku": "actions_linux",
      "unitType": "minutes",
      "pricePerUnit": 0.008,
      "grossQuantity": 1000,
      "grossAmount": 8,
      "discountQuantity": 0,
      "discountAmount": 0,
      "netQuantity": 1000,
      "netAmount": 8
    }
  ]
}
```

Note the SKU spelling differs between the two documented examples (`Actions Linux` and `actions_linux`). Do not join on SKU strings across endpoints until recorded fixtures show the real values.

`GET /organizations/{org}/settings/billing/ai_credit/usage` (from documentation, not recorded):

```json
{
  "timePeriod": { "year": 2025 },
  "organization": "GitHub",
  "usageItems": [
    {
      "product": "Copilot",
      "sku": "Copilot AI Credits",
      "model": "GPT-5",
      "unitType": "credits",
      "pricePerUnit": 0.01,
      "grossQuantity": 100,
      "grossAmount": 1,
      "discountQuantity": 0,
      "discountAmount": 0,
      "netQuantity": 100,
      "netAmount": 1
    }
  ]
}
```

The user-level documented example uses `"unitType": "ai-credits"` and `"product": "Copilot AI Credits"`, so accept both spellings.

`GET /organizations/{org}/settings/billing/premium_request/usage` (from documentation, not recorded):

```json
{
  "timePeriod": { "year": 2025 },
  "organization": "GitHub",
  "usageItems": [
    {
      "product": "Copilot",
      "sku": "Copilot Premium Request",
      "model": "GPT-5",
      "unitType": "requests",
      "pricePerUnit": 0.04,
      "grossQuantity": 100,
      "grossAmount": 4,
      "discountQuantity": 0,
      "discountAmount": 0,
      "netQuantity": 100,
      "netAmount": 4
    }
  ]
}
```

`GET /organizations/{org}/settings/billing/budgets` (from documentation, not recorded; trimmed):

```json
{
  "budgets": [
    {
      "id": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "budget_type": "SkuPricing",
      "budget_product_skus": ["actions_linux"],
      "budget_scope": "organization",
      "budget_amount": 500,
      "prevent_further_usage": false,
      "budget_alerting": { "will_alert": true, "alert_recipients": ["org-owner"] }
    }
  ],
  "has_next_page": false
}
```

`GET /repos/{owner}/{repo}` (from documentation, not recorded; trimmed):

```json
{
  "id": 1296269,
  "full_name": "octocat/Hello-World",
  "private": false,
  "visibility": "public",
  "fork": false,
  "forks_count": 9,
  "stargazers_count": 80,
  "watchers_count": 80,
  "subscribers_count": 42,
  "pushed_at": "2011-01-26T19:06:43Z"
}
```

`GET /repos/{owner}/{repo}/stargazers/count` (from documentation, not recorded):

```json
{ "count": 42 }
```

`GET /repos/{owner}/{repo}/stargazers/history` (from documentation, not recorded):

```json
[
  { "week": 1754784000, "total": 19, "days": [0, 12, 7, 0, 0, 0, 0] }
]
```

`GET /repos/{owner}/{repo}/forks` (from documentation, not recorded; trimmed):

```json
[
  {
    "id": 1296269,
    "full_name": "octocat/Hello-World",
    "owner": { "login": "octocat", "id": 1, "type": "User" },
    "private": false,
    "fork": true,
    "created_at": "2011-01-26T19:01:12Z"
  }
]
```

## Unverified

Confirm with a test organization and a test personal account before the adapter ships:

- `setup_action` (`install`, `update`, `request`) on the setup URL redirect is not in the official docs, and neither is the exact form of `state` passthrough. The handler must work if either is missing.
- What the redirect looks like when a non-owner requests an org install (no `installation_id` expected).
- The status code from `/settings/billing/usage` for an account not on the enhanced billing platform (the docs list `400` and `403`).
- Whether `/usage` without `month` returns the whole year (no default documented for `month`, unlike the other endpoints).
- The automation tutorial says billing usage endpoints do not support fine-grained personal access tokens and asks for a classic token, while the endpoint reference lists installation, user, and fine-grained tokens with Administration read. Confirm an installation token returns `200`.
- That the organization AI credit endpoint returns data for Copilot Business and Enterprise orgs, and whether the premium request endpoint still returns rows for months after 2026-06-01.
- Real `product`, `sku`, and `unitType` strings (documented examples disagree).
- Whether amounts can carry more than two decimal places in `netAmount`, and that all amounts are USD for accounts billed through Azure.
- Freshness of billing usage (how long after usage it appears) and of star counts.
- Status codes when minting a token for a deleted or suspended installation.
- Whether the user token exchange returns JSON by default or needs `Accept: application/json` (documented for OAuth apps; the GitHub App page does not say).
- Whether an installation token counts as "admin or collaborator" for the restricted stargazer list. DevMacro does not plan to call it, so this only matters if plans change.
- Whether `/stargazers/history` counts stars that were later removed.

## Sources

All checked 2026-10-31.

- [REST API: billing usage](https://docs.github.com/en/rest/billing/usage)
- [REST API: budgets](https://docs.github.com/en/rest/billing/budgets)
- [Automating usage reporting with the REST API](https://docs.github.com/en/billing/tutorials/automate-usage-reporting)
- [Billing reports reference](https://docs.github.com/en/billing/reference/billing-reports)
- [Viewing your usage of metered products and licenses](https://docs.github.com/en/billing/how-tos/products/view-productlicense-use)
- [Introduction to billing (enhanced billing platform)](https://docs.github.com/en/billing/using-the-new-billing-platform/about-the-new-billing-platform)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [Premium requests (legacy)](https://docs.github.com/en/billing/concepts/product-billing/github-copilot-premium-requests)
- [Usage-based billing for organizations and enterprises](https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-organizations-and-enterprises)
- [Changelog: updates to GitHub Copilot billing and plans (2026-06-01)](https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/)
- [REST API: starring](https://docs.github.com/en/rest/activity/starring)
- [Changelog: upcoming access restrictions to public API endpoints (2026-06-30)](https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/)
- [REST API: forks](https://docs.github.com/en/rest/repos/forks)
- [REST API: repositories](https://docs.github.com/en/rest/repos/repos)
- [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps)
- [Generating a JWT for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
- [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [Managing private keys for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
- [About the setup URL](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)
- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
- [Sharing your GitHub App (install URL and `state`)](https://docs.github.com/en/apps/sharing-github-apps/sharing-your-github-app)
- [Requesting a GitHub App from your organization owner](https://docs.github.com/en/apps/using-github-apps/requesting-a-github-app-from-your-organization-owner)
- [REST API: GitHub Apps](https://docs.github.com/en/rest/apps/apps)
- [REST API: installations](https://docs.github.com/en/rest/apps/installations)
- [REST API: OAuth authorizations (revoke grant and token)](https://docs.github.com/en/rest/apps/oauth-applications)
- [Rate limits for the REST API](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
