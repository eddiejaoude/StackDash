# GitHub

Provider id: `github`. Verification: documentation only. Docs checked 2026-11-16.

StackDash reads your GitHub billing usage by product, including Actions minutes, storage, and Copilot, plus stars, star history, and forks, and puts pull requests merged, issues opened, releases published, and new stars on the timeline. It installs as a GitHub App with five read-only permissions, and receives GitHub's webhooks so that pull requests, issues, stars, an uninstall, a suspension, or a revoked authorization reach StackDash within a minute. Releases arrive by the hourly sync.

## Go or no-go

**Go for the MVP, with one scope correction.** A GitHub App with three read-only permissions covers everything StackDash reads: organization billing usage by product and SKU (Actions minutes, storage, Copilot, and every other metered product), star count, star history, and forks. Organization data uses short-lived installation access tokens. Personal account billing is only readable with a user access token, so personal accounts also need the user authorization step.

The correction: **since 2026-06-01 every Copilot plan is billed in GitHub AI Credits, not premium requests** ([changelog](https://github.blog/changelog/2026-06-01-updates-to-github-copilot-billing-and-plans/)). Premium requests now only apply to Copilot Pro and Pro+ annual plans that stayed on legacy billing. The adapter should read `GET /organizations/{org}/settings/billing/ai_credit/usage` for Copilot spend and keep `premium_request/usage` only as a legacy fallback. The landing page's Copilot row names AI Credits for the same reason.

**Go for timeline activity, with two more read-only permissions.** Pull requests read and Issues read let GitHub send the `pull_request` and `issues` webhooks and let the hourly sync read the same lists as the backfill. Releases come from each repository's events feed, which needs only the Metadata read the app already has. The `release` webhook and the release list need Contents read, which also reads every covered repository's code, and an installer cannot leave out one permission ("Choosing permissions for a GitHub App": they "see and grant the repository and organization permissions that the app requested"). So StackDash does not ask for it, and releases reach the timeline within about an hour, or up to about 7 hours when GitHub's feed lags. Both new permissions are optional for an installation made before they were added: it keeps syncing billing, stars, forks, and releases, and the connection lists the permissions it lacks until the owner accepts them on GitHub.

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

1. A workspace owner or admin clicks Connect GitHub. StackDash creates a random `state` bound to the session and workspace (short TTL, single use) and redirects to the install URL. "Sharing your GitHub App" documents `state` on the install URL as a way to correlate an installation to a user.
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
2. `POST /app/installations/{installation_id}/access_tokens` with `Authorization: Bearer <JWT>`. Narrow the token with the body: `{"permissions": {"metadata": "read", "organization_administration": "read"}}`, plus `pull_requests` and `issues` at `read` for each the installation holds (a token "cannot be granted permissions that the app was not granted", so an installation that has not accepted them yet asks for fewer). Optional `repositories` or `repository_ids` (up to 500) narrow it further.
3. Use the token until `expires_at` minus a margin, then mint a new one. Do not persist installation tokens; mint per sync run. Expired tokens return `401`.

### User token refresh (personal accounts only)

`POST https://github.com/login/oauth/access_token` with `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token`. The response holds a new access token **and a new refresh token**; the old pair stops working at once. Serialize refreshes per connection and persist the new pair atomically before use. `bad_refresh_token` means the user must authorize again. A refresh token unused for 6 months expires, so a daily sync keeps it alive.

### Disconnect and revoke

- From StackDash: `DELETE /app/installations/{installation_id}` with the JWT uninstalls the app from that account. Also revoke the stored user grant with `DELETE /applications/{client_id}/grant` (Basic auth `client_id:client_secret`, body `{"access_token": "..."}`), which removes every token for that user. Delete stored tokens either way.
- From GitHub: the user can uninstall or suspend the app in account or organization settings, or revoke the user authorization. StackDash hears of it from the webhook within a minute (see [Webhooks](#webhooks)) and asks for a reconnect; when a delivery is missed, it finds out on the next sync instead: token minting or API calls fail. Treat `401` on a user token, and `404` or `403` when minting an installation token, as "needs reconnection" and stop retrying. Exact status codes for uninstalled and suspended installations are unverified.
- Revoking the user authorization does not uninstall the app.

## Permissions

All read-only. Nothing in this list can write.

| Permission (GitHub UI group) | Level | Why | Token types |
|---|---|---|---|
| Repository: Metadata | Read | Repo details, star count, star history, forks, list of installed repositories, the `star` webhook, and published releases from the repository events feed (`GET /repos/{owner}/{repo}/events`). Mandatory for every GitHub App | Installation, user |
| Organization: Administration | Read | Organization billing usage, usage summary, AI credit usage, premium request usage, budgets | Installation, user |
| Account: Plan | Read | Personal account billing usage, usage summary, AI credit usage, premium request usage | User only |
| Repository: Pull requests | Read | The `pull_request` webhook and `GET /repos/{owner}/{repo}/pulls`, for merged pull requests on the timeline. Optional | Installation |
| Repository: Issues | Read | The `issues` webhook and `GET /repos/{owner}/{repo}/issues`, for opened issues on the timeline. Optional | Installation |

The `star` webhook needs only Metadata read. `installation` and `github_app_authorization` deliveries reach every GitHub App without a permission.

Not requested: Contents, Organization plan, Actions. `GET /installation/repositories` needs no permission beyond the installation token. Contents read would allow the `release` and `fork` webhooks and the release list, but it also reads every covered repository's code, so releases come from the events feed (Metadata read) and forks stay polled.

"Optional" means an installation without it still connects and syncs. Each sync checks the installation's permissions and reports the missing ones as partial errors, which the connection page lists as missing permissions until the account owner approves the app's new permissions on GitHub (GitHub asks the owners of every installation to review an app's added permissions); the next sync then clears them.

Organization owners approve "Administration: read" at install time. On a personal account install, the organization permission has no effect.

## Data

### Which repositories

`GET /installation/repositories` (installation token, `per_page=100`, paginate). Returns the repositories the owner granted. Respect `repository_selection`: a "selected" install only shows chosen repositories. Re-read every sync because users add and remove repositories. Each repository carries `stargazers_count`, a required integer in GitHub's reference for this endpoint ([List repositories accessible to the app installation](https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation)) and the number of users who starred it ([REST API endpoints for starring](https://docs.github.com/en/rest/activity/starring)). It is StackDash's star count for every repository, with no request per repository.

### Repositories and StackDash projects

A GitHub connection represents the user or organization account where the GitHub App is installed, not an individual repository. StackDash assigns that account to one StackDash project, so every repository selected for the installation follows the same project assignment.

| Goal | Supported | Setup |
|---|---|---|
| Put several repositories in one StackDash project | Yes | Select those repositories for one or more GitHub account installations, then assign each resulting GitHub account to the same StackDash project |
| Put one repository in each StackDash project | Yes, when each repository belongs to a different GitHub user or organization | Install the app once per GitHub account, select the repository, and assign each resulting account to its StackDash project |
| Split repositories from the same GitHub user or organization across different StackDash projects | No | GitHub allows one installation per account, and StackDash assigns that account as one unit |

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

StackDash stores the same money at three levels: month to date per product (`github.spend.<product>`), per SKU (`github.spend.<product>.<sku>`), and per product per UTC day (`github.daily_spend.<product>`). Spend totals, alerts, and the daily summary count only the month to date per product. A SKU row is a breakdown of its product, and a day row lies inside the month, so neither is added again (`countedSnapshots` in `src/lib/dashboard/aggregate.ts`).

### AI credits, organization: `GET /organizations/{org}/settings/billing/ai_credit/usage`

Copilot usage since 2026-06-01. Filters: `year`, `month`, `day`, `user`, `model`, `product`. Response: `timePeriod`, `organization`, and `usageItems[]` with `product`, `sku`, `model`, `unitType`, `pricePerUnit`, `grossQuantity`, `grossAmount`, `discountQuantity`, `discountAmount`, `netQuantity`, `netAmount`. Included credits are pooled across the organization; `discountAmount` is the part covered by the pool, `netAmount` the billed overage. Last 24 months only. No per-item date: for a daily series, query with `day`.

### Premium requests, organization: `GET /organizations/{org}/settings/billing/premium_request/usage`

Same parameters and schema as AI credits, with `unitType: "requests"`. Legacy since 2026-06-01. Keep it as a fallback so months before June 2026 still show, and in case an account still has premium request rows. Last 24 months only.

### Budgets, organization: `GET /organizations/{org}/settings/billing/budgets`

Optional, same Administration read permission. Each budget has `budget_type`, `budget_product_skus` or `budget_product_sku`, `budget_scope`, `budget_amount` (**whole US dollars**, or a license count for license products), `prevent_further_usage`, `budget_alerting`. Gives StackDash a real limit to compare spend against. Paginated (`per_page` max 100, default 10, `has_next_page`).

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

Returns `{ "count": 42 }`. Current stars; users who unstarred are not included. StackDash does not call it: the repository list already carries each repository's count (`stargazers_count`, see Which repositories), so a request per repository would only slow the sync.

### Star history: `GET /repos/{owner}/{repo}/stargazers/history`

Stars grouped by calendar week, newest first. Each item: `week` (Unix seconds, start of week), `total` (stars that week), `days` (7 integers, Sunday first). Weeks without stars contain zeros. `per_page` max 30, `page` max 100. Pages go back to the repository's creation week; concatenating pages gives one continuous series. **Week and day boundaries are not guaranteed to align with UTC.** Use it to backfill history on first connect and to show recent weeks, not for exact UTC days.

### Stargazer list: avoid

`GET /repos/{owner}/{repo}/stargazers` with `Accept: application/vnd.github.star+json` adds `starred_at` per user. Since July 2026 GitHub limits this endpoint to admins and collaborators and may return empty results or `403` ([changelog](https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/)). It also returns personal data (logins, avatars) StackDash does not need. Use count and history instead.

### Forks: `GET /repos/{owner}/{repo}/forks`

`sort=newest` (default), `per_page` max 100. Each item is a repository: `id`, `full_name`, `owner.login`, `created_at` (when the fork was made), `private`. On each sync that reaches the repository within the fork budget (see [Time budget](#time-budget)), read the first page and stop at the first fork id already seen. Store the fork `id` and `created_at` for de-duplication; do not store owner logins. `forks_count` on the repository is the total.

### Merged pull requests: `GET /repos/{owner}/{repo}/pulls`

Pull requests read. `state=closed&sort=updated&direction=desc&per_page=30`: a merge updates the pull request, so the newest merges are on the first page. There is no `since` filter, so an active repository returns a full page every hour whether or not anything merged; a page of 100 is 2 to 3 MB, a page of 30 (GitHub's default) about 0.7 MB. StackDash keeps `number`, `merged_at` (null when closed without merging), `updated_at` (to see whether the page reached back far enough), and `html_url`. The title, body, and author are never parsed.

### Opened issues: `GET /repos/{owner}/{repo}/issues`

Issues read. `state=all&sort=created&direction=desc&since=<read start>&per_page=100`. `since` filters by last update, which opening an issue sets. The list holds pull requests too, marked by a `pull_request` key; StackDash skips them, because a pull request is counted when it is merged. It keeps `number`, `created_at`, and `html_url`; the title, body, labels, and author are never parsed, since anyone can open an issue on a public repository.

### Published releases: `GET /repos/{owner}/{repo}/events`

Metadata read. The repository events feed, every event type, `per_page=100`, roughly newest first: an event days old can sit among this hour's. GitHub keeps at most 300 events from the last 30 days in it, and a fourth page answers `422`. StackDash reads `ReleaseEvent` entries (action `published`) and keeps the release's `id`, `tag_name`, `draft`, `published_at`, and `html_url`, the release object "GitHub event types" documents in its payload. It never reads `actor` (the person who published) or any other event's payload. A release event whose payload lacks those fields fails the page's schema, and so the sync, rather than losing releases silently. `GET /repos/{owner}/{repo}/releases` is not used: it needs Contents read.

GitHub's events documentation says the feed "is not built to serve real-time use cases. Depending on the time of day, event latency can be anywhere from 30s to 6h." The feed is therefore read back 6 hours further than the other lists. It is read a page at a time, at most 3 pages (all 300 events), and a page ends the read only when it is empty, or when even the newest of its last five events is past that window. A short page does not end it: GitHub answers fewer than 100 events while more pages follow (97, 99, and 92 on `kubernetes/kubernetes`, measured in November 2026), and one stray old event at the end of a page must not end it either.

### Activity read window

The pull request and issue lists are the backfill for the webhooks: they catch a delivery that was missed. The events feed is the only source of releases. Each sync reads one page of each list per repository (the feed up to three), each list from its own previous read less one poll interval (so an item GitHub listed late is still caught; the dedupe key absorbs the overlap), and at most 7 days back on a first sync, after a long gap, or once a list's permission is granted. The events feed reads 6 hours further back, as above. Each repository's read times are kept per list in the cursor (`activity`), and a list's time moves on only when it was read, not when its permission is missing or GitHub refused it. A full page whose last item is still inside the window is logged as `github.sync.activity_truncated` with its page size, by path template only. For the events feed, the signal is three pages that did not reach back to the feed's own previous read (or the backfill start on a first read): events may have been missed between two reads. Three pages that reach back that far but not through the 6 hour allowance are normal on a busy repository and are not logged. A `403` on a list becomes a partial error naming its permission, and a `404` or `410` (the repository went away, or issues are turned off) gives that repository no events for the list; neither stops the rest of the sync.

The activity reads run within their own time budget; see [Time budget](#time-budget).

### Time budget

A sync has about 70 seconds: a job starts at most 50 seconds into a tick (`TICK_BUDGET_MS`) and holds its claim for 120 (`TICK_LEASE_SECONDS`, `src/lib/jobs/runner.ts`). A sync still running after that is cut off by a hosted function's time limit, losing everything it read, or, self-hosted, overlaps the next tick's run of the same connection. Star counts need no time of their own: they come with the repository list, so every repository's star count, baseline, milestones, and day close run on every sync. The per-repository reads run within two 20 second budgets, both kept by one mechanism (`readWithinBudget` in `src/lib/adapters/github/repositories.ts`):

- Forks (`FORKS_BUDGET_MS`): no repository's fork read starts more than 20 seconds into them. A busy repository's first page of forks took 1.1 to 5.8 s (`supabase/supabase` 1.11 s, `vercel/next.js` 5.83 s, measured on 2026-11-16), so the fork reads take at most about 26 seconds with the repository in progress, and reach about 4 busy repositories a sync.
- Activity (`ACTIVITY_BUDGET_MS`): no repository's reads start more than 20 seconds into them, so they take at most about 29 seconds with the repository in progress (a busy repository's activity is about 6 to 8 s, see Rate limits).

That leaves about 15 seconds for the installation, token, and repository list reads before them and the billing reads after. With every request taking the measured times (and 1 s for the others), a sync of 100 busy repositories takes about 55 seconds, inside its claim; reading every repository's star count and forks with no budget took over 700. The unit tests in `src/lib/adapters/github/index.test.ts` ("sync: fork read budget") model it with a clock moved on by each request.

Each budget reads the repositories read longest ago first, never read first, and leaves the rest for a later sync, logged as `github.sync.forks_deferred` or `github.sync.activity_deferred` with how many were deferred and read. A busy installation therefore catches up over several syncs: the forks of 100 busy repositories in about a day, their activity in about a day and a half.

- Forks are ordered by when they were last read (`forksReadAt`). A repository not reached keeps its newest fork seen, so the sync that reads it reports each fork made since, once. A repository new to the installation and not reached on its first sync takes that sync's time as its fork baseline (`forksSeenAt`), so its first fork read reports every fork made after StackDash first listed it, and none from before. The baseline compares this host's clock with GitHub's `created_at`, so a fork made within the clock difference of that first sync can fall either side.
- Activity is ordered by when each repository's activity was last attempted (`activityAttemptedAt`), never-attempted first, so a list that is never read (a permission not accepted, a list refused) cannot keep a repository at the front or the back. A repository not reached keeps its read times and is read from where it left off.

### New stars per day: `github.stars.gained.daily`

A usage metric StackDash derives from the star count snapshots (`stargazers_count` on the repository list), declared in the adapter's `dailyTotals`. Each repository keeps a baseline: its star count at the first sync of a UTC day. The first sync of the next day closes that day, and the reading is the sum of each repository's net change over it, counting a repository that lost stars as 0, so an unstar never cancels another repository's new stars. Its timeframe is the closed day (00:00 to 00:00 UTC), and it is stored in that sync's daily row.

- A repository on its first sync, including one just added to the installation, only sets its baseline: its existing stars are never counted as new.
- A repository whose baseline is older than yesterday (syncs were missed) adds nothing, because its change spans several days.
- A repository adds to the day only when the sync that closes it runs within two poll intervals (2 hours) of the day's end, by 02:00 UTC. A later first sync (a connection waiting for attention, a job runner down across midnight) would take in the next day's stars too, so the repository adds nothing to that day, and no reading is written when no repository closed the day in time. A reading therefore runs from the first sync of its day to at most 02:00 UTC the next day, never more than 26 hours: a late day is undercounted, never overclaimed. The `github.stars.daily` event follows the same bound (see Timeline events).
- When repositories closed the day without new stars, the reading is 0. When no repository closed a day on a sync (every later sync that day), no reading is written, so the first sync's reading stands.
- It is an achievement input, not usage to watch: the unusual spend and usage checks never read it, and alert settings does not offer it to mute (see `dailyTotals` in [Adapters](../adapters.md#the-adapter-interface)).

### Units, freshness, retention

- Money: every amount is a JSON number in US dollars, with sub-cent prices (`pricePerUnit: 0.008`). No currency field is returned; USD is the inference from GitHub's billing docs, which price everything in USD. Convert at the parse boundary to integer cents (`amountMinor`, `currency: "USD"`) with decimal string arithmetic, never by multiplying floats. Keep `pricePerUnit` as the original decimal string. Round per line item and note that StackDash totals can differ from GitHub's by a few cents.
- Quantities: `minutes`, `requests`, `credits` or `ai-credits`, and storage in GB-hours for Actions storage (GitHub's GB is 2^30 bytes). Always store the `unitType` string next to the number.
- Dates: billing `date` is a UTC day. Star history weeks are not UTC aligned.
- Freshness: not documented for the REST endpoints. Actions artifact storage usage updates "within 6 to 12 hours". Treat the current day as provisional and re-read it on the next sync.
- Retention: summary, AI credit, and premium request endpoints return the last 24 months only.

### Timeline events

Pull requests, issues, and single stars arrive by webhook within a minute; the polled rows are the backfill and the only source of the rest, releases included. A delivered event and the same event polled later share a dedupe key, so the timeline stores it once.

| Event | Source | Rule |
|---|---|---|
| New stars | Daily snapshot of `stargazers_count` | One event per UTC day with the net change, if positive. Unstars reduce it, so it is net, not gross. Only when the first sync of the next day runs by 02:00 UTC: a later close would report up to two days as one, so that day gets no event. Its stars still show in the star counts (`github.stars.total` and each repository's) |
| Star milestone | `stargazers_count` | When the count first reaches 100, 500, 1,000, then every further 1,000. Fire once per milestone per repository, even if the count dips and rises again. Polled only: only the cursor knows which milestones already fired |
| Repository starred | `star` webhook, `created` | One event per star, at `starred_at`, keyed by repository and `starred_at`. Who starred is never read. Webhook only: the stargazer list that could backfill it is restricted and personal (see [Stargazer list](#stargazer-list-avoid)), so a missed delivery shows only in the daily net and the counts. An unstar (`deleted`) is ignored: the daily net counts it |
| New fork | `/forks` (newest first) | One event per new fork id, at its `created_at`. Summarize per day if there are many |
| Pull request merged | `pull_request` webhook (`closed` with `merged: true`), then `/pulls` | One event per merge, at `merged_at`, keyed `github.pull_request.merged:<repository id>:<number>`. Only the number and the repository |
| Issue opened | `issues` webhook (`opened`), then `/issues` | One event per issue, at `created_at`, keyed `github.issue.opened:<repository id>:<number>`. Only the number and the repository |
| Release published | `/events` (`ReleaseEvent`, `published`), polled only | One event per published release, at `published_at`, keyed `github.release.published:<repository id>:<release id>`, titled with its tag. Within about an hour, or up to about 7 hours when the feed lags |
| Spend started | `/usage/summary` | First non-zero `netAmount` for a product in a month: included usage has run out |
| Daily spend | `/usage` | Net spend per product per UTC day |
| Budget threshold | `/budgets` plus `/usage/summary` | Month-to-date net spend crosses 75, 90, or 100 percent of a budget (GitHub's own alert levels) |

## Achievements

StackDash evaluates these for each project the GitHub accounts are assigned to, from the GitHub data it has stored, after each sync (see [Achievements](../adapters.md#achievements)). A project earns each one once, and it stays private until an owner or admin publishes it.

The star thresholds read the stored `github.stars.total` snapshots. When the first snapshot StackDash stored is already at or above a threshold, the achievement says "Recorded at least" that many, because StackDash did not see the crossing. Trending reads `github.stars.gained.daily` (see [New stars per day](#new-stars-per-day-githubstarsgaineddaily)): the new stars of repositories StackDash already followed over one UTC day, added across the GitHub accounts, and dated to that day. A repository added to the installation never counts its existing stars as new, and a day counts only when the first sync after it runs by 02:00 UTC, so a reading never covers more than 26 hours (from the day's first sync to 02:00 UTC the next day) and a late or missed sync leaves the day uncounted rather than counting two days as one. One UTC day is the London day in winter, 01:00 to 01:00 London time in summer. The fork achievements count `github.forks.new` events, and Steady glow and Weekend stargazers read `github.stars.daily`, which is emitted only for a repository whose star count rose over a UTC day (a day with no net gain has no event).

`github.stars.daily` is dated to the end of its UTC day: 00:00 UTC the next day, which is always the next London date. Saturday's and Sunday's stars therefore arrive as Sunday and Monday events, so Weekend stargazers looks for a two-day run that starts on a Sunday. Steady glow needs no such change: every day moves by one, so 7 consecutive days stay consecutive.

| Id | Title | How it is earned |
|---|---|---|
| `github.stars.10` | 10 GitHub stars | Earned when StackDash records 10 or more stars across the connected GitHub repositories. |
| `github.stars.100` | 100 GitHub stars | Earned when StackDash records 100 or more stars across the connected GitHub repositories. |
| `github.stars.1000` | 1,000 GitHub stars | Earned when StackDash records 1,000 or more stars across the connected GitHub repositories. |
| `github.stars.10000` | 10,000 GitHub stars | Earned when StackDash records 10,000 or more stars across the connected GitHub repositories. |
| `github.stars.777` | Lucky sevens: 777 GitHub stars | Earned when StackDash records 777 or more stars across the connected GitHub repositories. |
| `github.stars.1024` | Kilostar: 1,024 GitHub stars | Earned when StackDash records 1,024 or more stars across the connected GitHub repositories. |
| `github.stars.hot_day` | Trending: 10 new stars in one day | Earned when GitHub repositories StackDash already followed gain 10 or more new stars between them over one UTC day. |
| `github.stars.steady_glow` | Steady glow: new stars on 7 days in a row | Earned when StackDash records new stars on a connected GitHub repository on each of 7 consecutive days. |
| `github.stars.weekend` | Weekend stargazers: new stars on a Saturday and the Sunday after it | Earned when StackDash records new stars on a connected GitHub repository on a Saturday and on the Sunday after it. |
| `github.forks.first` | First fork recorded | Earned when StackDash records the first new fork of a connected GitHub repository. |
| `github.forks.10` | 10 forks recorded | Earned when StackDash records the 10th new fork of a connected GitHub repository. |
| `github.forks.100` | 100 forks recorded | Earned when StackDash records the 100th new fork of a connected GitHub repository. |
| `github.forks.party` | Fork party: 5 forks in one day | Earned when StackDash records 5 new forks of the connected GitHub repositories on one London calendar day. |

## Verified, estimated, unavailable

| Value | Status |
|---|---|
| Net, gross, discount amounts per product and SKU per day (org and personal) | Verified (GitHub's billed figures; the current month is provisional until invoiced) |
| AI credit and premium request quantities and amounts | Verified |
| Budgets and their amounts | Verified |
| Star count, fork count, new fork ids and times | Verified |
| Star history per week | Verified counts; days are approximate because boundaries are not UTC |
| Daily new stars from count snapshots | Verified net change at poll time; gross stars per day unavailable |
| Pull requests merged, issues opened, releases published, single stars | Verified: GitHub's own event, by webhook or from its list or events feed |
| Month-end spend projection | Estimated (StackDash extrapolation) |
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
- Budget: per repository per sync 1 request for forks within their 20 second budget (star counts come with the repository list), plus the activity reads within theirs (see [Time budget](#time-budget)): one page each of pull requests and issues and one to three pages of the events feed. About 4 billing calls per account. Measured on 2026-11-16 against three busy public repositories (`vercel/next.js`, `supabase/supabase`, `eddiejaoude/StackDash`), one authenticated request per page: pull requests (30) 0.66 to 0.81 MB in 0.9 to 1.3 s, issues since an hour ago 0.03 to 0.25 MB in 0.5 to 0.8 s, and the events feed read the way the code reads it (back to 8 hours ago, an hourly sync's window with its 6 hour allowance): 3 pages on all three, 1.4 to 2.1 MB in 4.4 to 6.6 s. So a busy repository's activity is about 6 to 8 s and 2.2 to 3 MB a sync, the budget reads about 3 busy repositories, or about 20 quiet ones, per sync, and 100 busy repositories cycle in about a day and a half. Its first page of forks took 1.1 to 5.8 s, so the fork budget reads about 4 busy repositories a sync. Webhook deliveries cost no requests. Run requests serially per installation.

## Webhooks

StackDash receives the GitHub App's webhooks at `POST <SITE_URL>/api/webhooks/github`, through the shared webhook route (see [Webhooks](../adapters.md#webhooks)), with polling kept as the backfill and the only source of billing, star counts, and forks. The code is `src/lib/adapters/github/webhooks.ts`.

- **One URL and one secret** on the app registration receive every installation's deliveries. The secret is `GITHUB_APP_WEBHOOK_SECRET`; without it the route answers `503` and logs `webhook.secret_missing` by variable name.
- **Signature.** Each delivery carries `X-Hub-Signature-256: sha256=<hex>`, an HMAC SHA-256 of the raw request body keyed with the secret. StackDash computes it over the raw bytes before parsing anything and compares in constant time. The legacy SHA-1 `X-Hub-Signature` is ignored. GitHub's test vector (secret `It's a Secret to Everybody`, payload `Hello, World!`, signature `sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17`) is a unit test. A delivery without the header is `missing_signature`, a wrong one `bad_signature`, both answered `401` and logged without the body.
- **Deduplication.** `X-GitHub-Delivery` is the delivery id, and a redelivery keeps it, so a repeat is answered `200` as a duplicate and not applied again. GitHub does not retry a failed delivery on its own; the app's owner can redeliver recent ones from the app's settings, and the hourly sync reads the same lists.
- **Replay.** GitHub signs no timestamp and not the delivery id, so a captured delivery posted again under a new delivery id verifies. For timeline events that changes nothing: the event's dedupe key is the one already stored. A suspension is dated by the signed `suspended_at`, so a replay after a reconnect is stale. An uninstall and a revoked authorization carry no time, so they are dated when they arrive, and a replay of one marks the connection as needing a reconnect again. It reveals and changes no data, and capturing a delivery takes the TLS traffic to StackDash or the app's delivery log, which only the app's owner sees.
- **Event name.** `X-GitHub-Event` names the event and is not signed, but each event's body must match that event's shape, so a signed body sent under another name is ignored.

| Event | Actions used | What StackDash does |
|---|---|---|
| `pull_request` | `closed` with `merged: true` | Pull request merged. Other actions are ignored |
| `issues` | `opened` | Issue opened. Other actions are ignored |
| `star` | `created` | Repository starred, at `starred_at`. `deleted` is ignored: the daily net counts an unstar |
| `installation` | `deleted`, `suspend` | The account's connections need a reconnect at once (an uninstall for `installation.account.id`). `unsuspend`, `created`, and `new_permissions_accepted` are ignored: the reconnect a suspension asked for, or the next sync, picks them up |
| `github_app_authorization` | `revoked` | The revoking user's personal account connection needs a reconnect (see below) |

Every delivery for a repository names its account by `repository.owner.id`: an installation covers one account's repositories, and that account's id is the connection's external account. A delivery reaches every workspace that includes that account and nothing else, and only from repositories the installation covers, the ones the owner selected.

**Revoked authorization, organization or personal account.** `github_app_authorization` says only who revoked (`sender.id`), not for which installation, and revoking does not uninstall the app. StackDash treats it as an uninstall of the account whose id is the sender's:

- A personal account connection keeps the user's token, because personal billing accepts nothing else, and its external account is that user's own account id. The revocation kills the token, so the connection asks for a reconnect at once rather than when the next token refresh fails.
- An organization connection revoked its user token right after connecting and syncs with installation tokens, which a revoked authorization does not touch. Its external account is the organization's id, and users and organizations share one account id space, so a user's revocation never matches it, which is right: it keeps working.
- If someone other than its owner connected a personal installation (see Unverified), their revocation does not match it, and the connection asks for a reconnect when its next token refresh fails, as it did before webhooks.

**Uninstall timing.** An uninstall is applied unless the connection's credential was saved after it (by a reconnect or a personal account's token refresh). Since a `deleted` delivery has no removal time, an uninstall of an old installation redelivered by hand after the account reinstalled the app would mark the new connection too; the reconnect it asks for restores it.

No billing webhooks exist in the docs checked. Spend stays polled.

## Permission risks

Disclose these on the connect screen before redirecting:

- **Organization Administration read** is broader than billing. It also reads organization Actions settings and permissions, hosted runner details, code security configurations, security managers, secret scanning custom patterns, interaction limits, the organization's app installations, and Copilot seat assignments (`/orgs/{org}/copilot/billing/seats`, which lists members). StackDash calls only the billing endpoints, but the token can read the rest.
- **Repository Metadata read** on private repositories also exposes the collaborator list and permissions, contributors, commit comments, and languages, and on every covered repository the events feed: who pushed, opened, commented, or released what. StackDash reads only repository details, stars, forks, and the feed's `ReleaseEvent` entries, and of those only the release's id, tag, time, and link.
- **Repository Pull requests read** reads pull request titles, descriptions, comments, and reviews. StackDash keeps only the number, merge time, and link.
- **Repository Issues read** reads issue titles, bodies, comments, and labels. StackDash keeps only the number, opening time, and link.
- **Account Plan read** (personal accounts) reads that user's billing usage and plan. It is held through a refresh token valid for 6 months, the longest-lived secret in this adapter. Encrypt it at rest.
- The **private key** can mint tokens for every installation of the app. It never expires. Store it only in the server environment, never in the database or logs; rotate by adding a new key, deploying, then deleting the old one.
- The **webhook secret** signs every installation's deliveries: anyone holding it can post events to every workspace's timeline and mark connections as needing a reconnect. Server environment only; rotate by changing it on the app registration and in the environment together.
- Installation tokens default to every permission and repository the installation has. Always narrow `permissions` when minting.
- Org installs need an organization owner; the connect screen should say so.
- **Private repository names** appear in the timeline titles of their events, which only the workspaces that connected that account can read. A verified delivery holds its parsed events, titles included, until the next job tick applies them, normally within a minute; the row then keeps the delivery id for 30 days to deduplicate redeliveries, with the events cleared (`webhook_deliveries.outcome`, set to null once applied). StackDash never logs the names: a failed repository read names the path template (`/repos/{owner}/{repo}/pulls`), never the repository, and webhook logs name only the provider, the delivery id, and the outcome.

## Limitations

- The billing usage report requires the enhanced billing platform. Organizations still on legacy billing get no billing data; stars and forks still work.
- Copilot moved to AI credits on 2026-06-01. Premium request data before that date is in the premium request endpoint; after it, in the AI credit endpoint. Show both under one "Copilot" row, by `unitType`.
- The usage summary endpoints are in public preview and may change. Validate every response with zod and fail the sync on schema drift instead of guessing.
- No per-workflow or per-user detail through the API (organization owners cannot see per-user AI usage in the UI either; the API `user` filter exists).
- Only 24 months of history for summary, AI credit, and premium request data.
- Star history days are not UTC aligned; daily star events come from count snapshots and are net.
- The stargazer list is restricted; StackDash never knows who starred.
- Single star events come only by webhook. A missed `star` delivery shows in the daily net and the star counts, not as its own event.
- Activity is read one page per list per repository per sync (the events feed up to three), within a 20 second budget. A repository with more than 30 merges or 100 new issues since its list was last read, and a missed webhook among them, can miss some; the truncation is logged. A repository the budget defers is read first on the next sync, from where it left off.
- Forks are read within a 20 second budget too. In an installation with more busy repositories than one sync reaches, each repository's forks are read every several hours rather than every hour: a new fork is reported that much later, and when more than 100 forks are made between two of its reads, the oldest of them are not reported.
- Releases are polled only, from the events feed: within about an hour, or up to about 7 hours when GitHub's feed lags. A repository with more than 300 events since its feed was last read (the feed's cap) can miss a release, and that is logged as `github.sync.activity_truncated`. On an hourly read that takes more than 300 events an hour. A repository the budget defers is read less often, so in an installation with more busy repositories than one sync reaches, releases published between two of its turns can be missed, and each such turn logs it.
- One installation per account. A user with a personal account and two organizations installs three times and gets three connections.
- Enterprise accounts are out of scope.

## Self-hosted registration

Each deployment registers its own GitHub App, because the private key, client secret, and URLs belong to one deployment.

1. GitHub, profile picture, **Settings**, **Developer settings**, **GitHub Apps**, **New GitHub App**. To own it as an organization, use the organization's **Settings**, **Developer settings** instead.
2. **GitHub App name**: for example `StackDash (your name)`. The URL-safe form shown on the app's public page (`https://github.com/apps/<slug>`) is `GITHUB_APP_SLUG`.
3. **Homepage URL**: `<SITE_URL>`.
4. **Callback URL**: `<SITE_URL>/api/connections/github/callback`.
5. Leave **Expire user authorization tokens** checked. Leave **Request user authorization (OAuth) during installation** unchecked (it disables the setup URL). Leave **Enable Device Flow** unchecked.
6. **Setup URL**: `<SITE_URL>/api/connections/github/callback`. Check **Redirect on update**, so adding or removing repositories returns to StackDash.
7. **Webhook**: check **Active**. **Webhook URL**: `<SITE_URL>/api/webhooks/github`. **Webhook secret**: a long random value (for example `openssl rand -hex 32`), the same value as `GITHUB_APP_WEBHOOK_SECRET`. GitHub Apps send JSON. SSL verification stays enabled. A local instance that GitHub cannot reach leaves the webhook inactive. Polling then still brings merged pull requests and opened issues within an hour and releases within about 7 hours, but single star events never arrive (they come only by webhook), and an uninstall, a suspension, or a revoked authorization is noticed on the next failed sync instead of at once.
8. **Permissions**: Repository, Metadata: Read-only (preselected). Repository, Issues: Read-only. Repository, Pull requests: Read-only. Organization, Administration: Read-only. Account, Plan: Read-only. Leave everything else at No access, Contents included. **Subscribe to events**: **Issues**, **Pull request**, and **Star** (`installation` and `github_app_authorization` need no box; **Release** needs Contents read, so it stays unchecked).
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
| `GITHUB_APP_WEBHOOK_SECRET` | The webhook secret from step 7. Leave it unset while the webhook is inactive |

An app registered before StackDash received webhooks keeps working: in its settings set step 7, add the two repository permissions and the three events from step 8, and save. GitHub then asks the owner of every installation to accept the new permissions; until they do, their connections list the missing ones and keep syncing billing, stars, forks, and releases. An app that already requested Contents read for releases can remove it: StackDash no longer uses it.

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

`GET /repos/{owner}/{repo}/pulls?state=closed&sort=updated&direction=desc` (from documentation, not recorded; trimmed to the fields read plus the title and author StackDash drops):

```json
[
  {
    "number": 1347,
    "title": "Amazing new feature",
    "user": { "login": "octocat", "id": 1 },
    "merged_at": "2011-01-26T19:01:12Z",
    "updated_at": "2011-01-26T19:01:12Z",
    "html_url": "https://github.com/octocat/Hello-World/pull/1347"
  }
]
```

`GET /repos/{owner}/{repo}/events` (from documentation, not recorded; trimmed; "GitHub event types" documents the common properties and that a `ReleaseEvent` payload holds the release object):

```json
[
  {
    "id": "22249084964",
    "type": "ReleaseEvent",
    "actor": { "id": 1, "login": "octocat" },
    "repo": { "id": 1296269, "name": "octocat/Hello-World" },
    "payload": {
      "action": "published",
      "release": {
        "id": 1,
        "tag_name": "v1.0.0",
        "draft": false,
        "published_at": "2013-02-27T19:35:32Z",
        "html_url": "https://github.com/octocat/Hello-World/releases/v1.0.0"
      }
    },
    "public": true,
    "created_at": "2013-02-27T19:35:33Z"
  }
]
```

A `pull_request` delivery (from documentation, not recorded; headers from "Delivery headers", body trimmed). The signature is GitHub's documented example, not a signature of this trimmed body:

```text
POST /api/webhooks/github
X-GitHub-Delivery: 72d3162e-cc78-11e3-81ab-4c9367dc0958
X-GitHub-Event: pull_request
X-Hub-Signature-256: sha256=d57c68ca6f92289e6987922ff26938930f6e66a2d161ef06abdf1859230aa23c
Content-Type: application/json
```

```json
{
  "action": "closed",
  "pull_request": { "number": 2, "merged": true, "merged_at": "2019-05-15T15:21:18Z", "html_url": "https://github.com/Codertocat/Hello-World/pull/2" },
  "repository": { "id": 186853002, "full_name": "Codertocat/Hello-World", "html_url": "https://github.com/Codertocat/Hello-World", "owner": { "id": 21031067 } },
  "installation": { "id": 1 }
}
```

A `github_app_authorization` delivery body, complete apart from the sender's profile links:

```json
{ "action": "revoked", "sender": { "login": "octocat", "id": 1, "type": "User" } }
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
- Whether an installation token counts as "admin or collaborator" for the restricted stargazer list. StackDash does not plan to call it, so this only matters if plans change.
- Whether `/stargazers/history` counts stars that were later removed.
- What `GET /repos/{owner}/{repo}/issues` answers for a repository with issues turned off (the list documents `404` and `422`, not `410`). StackDash treats `404` and `410` the same: no issues for that repository.
- That every `installation` delivery carries `installation.account` (an enterprise installation may name no user or organization), and that `suspended_at` is set on `suspend`.
- Whether someone other than a personal account's owner can authorize against its installation (`GET /user/installations` lists installations the user has "explicit permission" to). If so, their revoked authorization does not match the connection by `sender.id` (see [Webhooks](#webhooks)).
- How long the events feed lags today. The REST page still says 30 seconds to 6 hours; GitHub's 2025 changelog says events would appear "almost immediately". StackDash reads back the documented 6 hours either way.
- That an installation token with Metadata read lists a private repository's events, and that a private repository's `ReleaseEvent` carries the same release fields. The public half is checked (below).

Checked on a public repository on 2026-11-16: `GET /repos/vercel/next.js/events?per_page=100` (authenticated) honours `per_page=100`, answers `422` for page 4, and holds a `ReleaseEvent` (created 2026-11-15T23:49:25Z, action `published`) whose `payload.release` carries `id` (446440896), `tag_name` (`v16.5.0-canary.52`), `draft` (false), `published_at`, and `html_url`: the five fields `ReleaseSchema` reads.

## Sources

Checked 2026-10-31, except the webhook and activity pages, rechecked or first read 2026-11-16.

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
- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries) (2026-11-16)
- [Webhook events and payloads](https://docs.github.com/en/webhooks/webhook-events-and-payloads) (2026-11-16): `pull_request` and `issues` need Pull requests and Issues read, `release` needs Contents read (not subscribed); `star` needs Metadata read; `installation` and `github_app_authorization` reach every app
- [Best practices for using webhooks](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks) (2026-11-16): answer within 10 seconds, check the event and action, `X-GitHub-Delivery` against replays and kept on redelivery
- [Handling failed webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries) (2026-11-16): GitHub does not redeliver on its own
- [Permissions required for GitHub Apps](https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps) (2026-11-16): list pull requests (Pull requests), list repository issues (Issues), list repository events (Metadata), list releases (Contents, not used)
- [Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app) (2026-11-16): an installer grants the permissions the app requested, all of them; an existing installation keeps its old permissions until the owner approves new ones
- [REST API: pull requests](https://docs.github.com/en/rest/pulls/pulls#list-pull-requests) (2026-11-16)
- [REST API: issues](https://docs.github.com/en/rest/issues/issues#list-repository-issues) (2026-11-16)
- [REST API: events](https://docs.github.com/en/rest/activity/events#list-repository-events) (2026-11-16): the feed's 300 events and 30 days, and its latency
- [GitHub event types](https://docs.github.com/en/rest/using-the-rest-api/github-event-types) (2026-11-16): common properties and the `ReleaseEvent` payload
- [Changelog: upcoming changes to GitHub Events API payloads (2025-08-08)](https://github.blog/changelog/2025-08-08-upcoming-changes-to-github-events-api-payloads/) (2026-11-16): which payloads were trimmed
- [REST API: create an installation access token](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app) (2026-11-16): a token cannot be granted permissions the app was not granted
- [octokit/webhooks payload examples](https://github.com/octokit/webhooks/tree/main/payload-examples/api.github.com) (2026-11-16): the example bodies the documentation is generated from, the source of the webhook fixtures
