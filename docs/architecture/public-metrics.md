# Public metrics

The numbers a workspace can choose to make public, how each one is counted, and how the rest of DevMacro reads them. Badges, cards, public project pages, the weekly email, and the leaderboard all read published values through one engine, so every surface shows the same number with the same label.

## Rules

- Nothing is public until an owner or admin publishes it, one metric per project at a time. Viewers see what is published and nothing more.
- Values come only from stored snapshots and events, never from a provider call on request.
- Spend, budgets, alert thresholds, revenue, and any amount of money have no metric id, so they cannot be published. The database enum `public_metric_id` is the only list of publishable ids.
- No account names, repository names, emails, keys, or infrastructure details appear in a published value or its label.
- Every value carries its provenance (Verified, Estimated, or Self-reported), the time of the sync it rests on, and a link to its formula on this page.
- A value made up by the provider simulator is marked simulated, and a surface must say so rather than show it as verified.

### Provenance

| Label | Meaning | Where it may appear |
|---|---|---|
| Verified | Counted from what the provider reported | Every surface |
| Estimated | Calculated by DevMacro | Every surface, labeled Estimated |
| Self-reported | Typed by a person on the public metrics page | The project page only, labeled Self-reported. Never on a badge, a card that claims Verified, or a leaderboard |

Every metric in the first set below is Verified.

### When there is no number

A metric that cannot be computed honestly says why instead of showing a number:

| Reason | Shown as | When |
|---|---|---|
| `not_connected` | Not connected | The project has no included account of the metric's provider, or every connection behind those accounts is disconnected. A disconnected connection keeps its stored rows, but they stop feeding public numbers the moment it is disconnected |
| `no_data` | No data yet | Connected, but nothing is stored yet, or the provider does not report it for this account |
| `not_enough_history` | Not enough history yet | Stored data does not cover the whole window, for example a 30 day count from 3 days of data |
| `stale` | Not synced in the last 2 days | The newest data behind the value is more than 48 hours old, or an account has never synced |
| `too_many_accounts` | Not computed: too many accounts | Only on the owner's public metrics page: the project has more than 200 included accounts (see below). Public surfaces show no value at all in that case |

Partial data always understates, never overstates: an account added in the middle of a window adds only what it saw, and a missing start-of-window reading is replaced by the next day's (a shorter window), never an earlier one.

A number rests on every included account behind it, so it is never computed from part of them. The metric store (`src/lib/public-metrics/supabase-store.ts`) reads at most 200 included accounts of a project, or of the workspace for the [year in review](#year-in-review), and asks for one more: when that one comes back it throws `AccountBoundError` rather than publish a smaller number. What each surface shows then:

- The public route, badges, and cards answer `503` like any failed read, and the error is logged.
- The public project page shows its error page ("This project page could not be loaded", with Try again and a reference id).
- The year in review's page shows the workspace's error page, and each slide image answers `503`.
- The owner's public metrics page still loads, because it holds every Unpublish control: each engine metric reads "Not computed: too many accounts", a notice above them says the project has more than 200 included accounts and to exclude the ones it does not need on their connection's page, and published values and self-reported values stay listed and can be unpublished.

The connections behind the accounts are read by id, so that read can never be cut.

### Rounding and delay

Each publication chooses how the value is shown:

- Rounding: exact, or rounded down to 10, 100, or 1,000. Always down, so a public number never claims more than the stored data shows; a rounded value reads "at least 1,200 stars". A percent rounds to 10 at most.
- Timing: the current value, or the value as it was 7 days ago. A delayed value only uses rows retrieved and events that occurred up to that moment.

Changing either option revokes the publication and publishes a new one, so the history shows what was public when.

## Publishing and the audit trail

Owners and admins publish on a project's public metrics page (Projects, then Public metrics). Every change writes a DevMacro event to the workspace timeline in the same transaction:

| Event type | Title | Body |
|---|---|---|
| `devmacro.metric_published` | Published GitHub stars | Project Acme web. Rounded down to 100, current. |
| `devmacro.metric_published` (self-reported) | Published Downloads this month (self-reported) | Project Acme web. 4,200 downloads. |
| `devmacro.metric_unpublished` | Unpublished GitHub stars | None |
| `devmacro.metrics_unpublished_all` | Unpublished everything | 2 metrics and 1 achievement are no longer public. |
| `devmacro.achievement_published` | Published 10 Vercel deployments recorded | None |
| `devmacro.achievement_unpublished` | Unpublished 10 Vercel deployments recorded | None |

Achievements are published on the project's Achievements page instead (see [Achievements](#achievements)); their titles are the public title. "Unpublish everything" revokes every live metric publication and deletes every achievement publication of every project in the workspace in one transaction (`unpublish_all_metrics`), after a confirmation that names how many metrics and achievements it covers and that it reaches every project, not only the one on screen. Its result and its audit event name both counts. Deleting an account removes every publication its user made, and deleting a workspace or a project removes theirs. The schema, row level security, and functions are in [Database schema](schema.md#public-metrics).

A project holds at most 100 live self-reported values, and the self-reported section of the public metrics page says so. `publish_self_reported_metric` refuses the 101st (`limit_reached`), and the page says to unpublish one first. With one live row per engine metric, a project's live publications stay far below the 1,000 rows the Data API returns in one request, so the public read always gets all of them.

## Reading published values

### Public route

`GET /api/public/projects/<project id>/metrics` returns a project's live publications as JSON, for anyone. A project that does not exist and one with nothing published both answer `404`, so the route never reveals which projects exist. Responses are cached for 60 seconds (`Cache-Control: public, max-age=60, s-maxage=60`), so an unpublished value stops showing within a minute. It shares the per IP [rate limit](#rate-limit) with badges and cards.

The route is same-origin only: it sends no `Access-Control-Allow-Origin`, so a script on another site cannot `fetch` it in a browser. Badges and cards are rendered by DevMacro's own server, and anyone can still read the JSON from a server or with curl. `formulaUrl` is an absolute URL on this DevMacro (from `NEXT_PUBLIC_SITE_URL`, else the request's origin), so a reader off-site can follow it.

```json
{
  "projectId": "30000000-0000-4000-8000-000000000001",
  "metrics": [
    {
      "kind": "engine",
      "id": "github-stars",
      "label": "GitHub stars",
      "provenance": "verified",
      "unit": "stars",
      "formulaUrl": "https://devmacro.example.com/docs/architecture/public-metrics#github-stars",
      "rounding": "hundreds",
      "delayDays": 0,
      "asOf": "2026-11-05T12:00:00.000Z",
      "publishedAt": "2026-11-05T11:00:00.000Z",
      "status": "available",
      "value": 1200,
      "atLeast": true,
      "text": "at least 1,200 stars",
      "lastSyncedAt": "2026-11-05T11:55:00.000Z",
      "simulated": false
    },
    {
      "kind": "self_reported",
      "label": "Downloads this month",
      "provenance": "self_reported",
      "value": 4200,
      "unit": "downloads",
      "text": "4,200 downloads",
      "publishedAt": "2026-11-05T11:00:00.000Z"
    }
  ]
}
```

An engine metric with no number has `"status": "unavailable"`, a `reason` from the table above, and `text`, and no `value`.

### Server API

Server code that shows published values (badges and cards, project pages, the leaderboard) reads them through `src/lib/public-metrics/published.ts` and never queries `published_metrics` itself:

| Function | Returns |
|---|---|
| `loadPublishedProjectMetrics(projectId, now)` | Every live publication of the project, engine metrics in definition order then self-reported values, or `null` when nothing is published |
| `loadPublishedMetric(projectId, metricId, now)` | One published engine metric, or `null`. It takes a `PublicMetricId`, so a self-reported value can never become a badge |
| `loadPublishedMetricCard(projectId, metricId, now, trendDays)` | The same, with its trend: the published value at the same time of day on each of the last `trendDays` days, rounded as the publication is, so a rounded metric's trend never reveals exact numbers |
| `loadPublishedProjectHistory(published)` | The daily history of each published engine metric in what `loadPublishedProjectMetrics` returned, over 90 days ending at the publication's own `asOf` and rounded the same way, plus the milestones those publications reveal. It takes that result, not a project id, so it can only describe what is published |
| `loadPublishedAchievements(projectId)` | Every published [achievement](#achievements) of the project, oldest first: id, provider and its display name, public title, earned date and precision, evidence, threshold, whether it is simulated, and when it was published. Empty for an unknown project |
| `loadPublishedAchievement(projectId, achievementId)` | One published achievement, or `null` when it is unknown, not earned, or not published |

The first three read live rows through `public_published_metrics()` with the service role and compute each value at its own delay. A leaderboard keeps only `provenance === "verified"` values that are not `simulated`. `src/lib/public-metrics/definitions.ts` holds the definitions (`PUBLIC_METRICS`, `publicMetricDefinition`, `formulaPath`), `engine.ts` computes from any `PublicMetricStore`, and `display.ts` formats values and summaries without touching data. `share.ts` builds badge and card URLs (`badgePath`, `cardPath`), alt text, and share text, and `badge.ts` renders the SVG. `definitions.ts`, `display.ts`, `share.ts`, and `badge.ts` import no adapter, data access, or Node module, so client components can use them; `display.test.ts` walks their imports and fails if one creeps in.

Private surfaces compute values that need not be published. The [year in review](#year-in-review) calls `computePublicMetrics(store, requests)` in `engine.ts` with `createSupabaseMetricStore(db, workspaceId, null)` (every included account of the workspace) and passes `from` on each request to count from there instead of the metric's own 7 or 30 days. Only change and count metrics take `from`; a current total, a percent, or a streak refuses it, and `from` must be before `asOf`. `historyStart(store, metricId)` says where a change or count metric's stored history starts, so a caller can start its window there instead of reporting "Not enough history yet". Publications always use the metric's own window.

## Badges and cards

Every published engine metric has a live badge and a card, keyed by project id like the public route:

| Route | What it serves |
|---|---|
| `GET /badge/<project id>/<metric id>.svg` | A two part SVG badge: the metric's label, then its value and provenance ("1,200+ verified", "1,204 simulated"). Its `<title>` says it all in words, with the last sync time. A value with no number says why ("Not enough history yet") |
| `GET /card/<project id>/<metric id>.png` | A 1200 by 630 PNG for posts and link previews: the project's name while its [project page](#project-pages) is public, then label, value, provenance, the trend over the last 30 days, and the last sync time. The name is one line that ends in an ellipsis when it does not fit. Rendered by Next.js `ImageResponse`, no external image service |
| `GET /badge/<project id>/achievement-<achievement id>.svg`, `GET /card/<project id>/achievement-<achievement id>.png` | The badge and card of a published achievement, by the same rules. See [Achievements](#achievements) |

Both follow the same rules:

- Values come from the engine through `loadPublishedMetric` and `loadPublishedMetricCard`, so a badge shows exactly what the public route shows. A self-reported value has no badge or card. No spend, budget, alert, account, or repository data can appear, because the engine has no metric for them.
- A project that does not exist, a metric that is not published or was unpublished, a malformed id, and a wrong extension all get the same neutral "Unpublished" badge or card with a `200`, so an embed never shows a broken image and never tells which projects exist.
- Cached for 60 seconds like the public route, so a newly published value shows and an unpublished one disappears within a minute. Errors are `503` and rate limited requests `429`, both `no-store`.
- A card's trend is 31 values (the 30 days before the value, and the value), each computed by the engine with the publication's rounding. `computeTrend` in `src/lib/public-metrics/trend.ts` reads the rows behind all of them once (the accounts, one snapshot or one event read covering every window, and for an event count the oldest stored event) and computes each day against them in memory, so a card costs the same few queries whatever its length. The event read is one request of 1,000 rows, newest first, because PostgREST returns no more than `max_rows` (1,000, `supabase/config.toml`) per request and cuts a longer read without an error. A full read counts as cut: a day whose window reaches past it shows no point rather than a smaller number, so a project with more than 1,000 events in a trend's 60 days (a 30 day count) or 37 days (a 7 day count) shows only its newest points. The snapshot read is paged instead: the Supabase store reads a window's snapshots in pages of 1,000 rows, newest day first, up to 10,000 rows (`SNAPSHOT_READ_MAX_ROWS` in `engine.ts`), and logs `public_metrics.snapshots_truncated` when it stops there. A read stopped there may hold only some accounts of its oldest day, so a day whose window reaches that day shows no point.
- Safe to embed anywhere: no session is read and no cookie is set, `Cross-Origin-Resource-Policy: cross-origin` lets other sites load them as images, and the SVG is text only, every string escaped. Opened directly, a badge can load and run nothing: `next.config.ts` sends `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; sandbox` for `/badge/*` in place of the static policy. It has to be set there, because Next applies the config's headers before a route handler runs and drops a handler header of the same name.

The public metrics page (Projects, then Public metrics) has a Share button beside each published metric. Its dialog shows the badge and card, the badge Markdown for a README, the card URL, the card's alt text, the link for a post with "Copy link", and "Share to X" and "Share to LinkedIn", which open the network's prefilled post for the person to edit and send. Nothing is posted automatically. Where the links lead depends on the project page, built by `metricShareLinks` in `share.ts`:

- Page on: the post, X, LinkedIn, and the badge link to the project page, and the card and its alt text name the project. The card route asks `public_project_page()` about the project's address (`loadPublicPageOfProject` in `src/lib/data/project-pages.ts`), so the card follows the same rule as the page itself.
- Page off, or never turned on: the post, X, and LinkedIn link to the card, the badge links to the metric's formula, and nothing names the project, because the page is the only place the name is public. Nothing ever links to a page that answers 404.

### Rate limit

The badge, card, and JSON routes and public project pages allow 120 requests per client IP per minute between them (`PUBLIC_REQUESTS_PER_MINUTE` in `src/lib/public-metrics/requests.ts`), then answer `429` with `Retry-After` until the next minute. The count lives in Postgres (`public_rate_limit_counters`), so every server instance shares it. The IP is hashed with HMAC-SHA-256 under a key derived from `DEVMACRO_ENCRYPTION_KEY` before it is stored, and the table accepts nothing but such a hash. Requests a cache answers never reach DevMacro and are not counted. Counters are deleted after a day.

Each surface says so in its own form, with the same words: the badge reads "Try again in a minute", the card shows "Try again in a minute" and "Too many requests from this address.", the JSON route answers `{ "error": "rate_limited" }` with that message, and a project page answers a short HTML page titled "Too many requests from this address" that names the seconds left and links to the home page. Every refusal is `no-store`.

Where the IP comes from (`clientIpEnv` in `src/lib/env.ts`, `clientIp` in `requests.ts`):

- On Vercel (`VERCEL=1`): `x-vercel-forwarded-for`, which Vercel sets to the client it saw and a proxy in front of Vercel cannot overwrite ([Vercel request headers](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for), checked 2026-11-05). `x-real-ip` is never read: it adds nothing on Vercel and a client can send it anywhere else.
- Self-hosted: `x-forwarded-for`, taking the entry `DEVMACRO_TRUSTED_PROXY_COUNT` places from the right (1 when unset). Each proxy appends the address it received the request from, so that entry is the one the outermost trusted proxy wrote, and whatever a client put to its left is ignored. The app must sit behind a proxy that appends to `x-forwarded-for`: reached directly, a client can claim any address and gets a bucket per claimed address.
- A request with no address shares one `unknown` bucket.

### View counts

Each time DevMacro serves a published metric's badge or card it counts one view for that project, metric, surface, and UTC day (`published_metric_views`), after the response has gone. The share dialog shows the last 7 days: "DevMacro served the badge 12 times and the card 3 times, including previews here." It counts what DevMacro served, not every reader: a cache in between (a CDN, GitHub's image proxy) serves copies for up to a minute that are not counted. Unpublishing stops the count. Counts are kept 13 months.

## Year in review

`/w/<workspace>/year/<year>` shows a workspace's year as four slides, counted from stored data across every included account of the workspace. Dashboard, then "Your 2026 so far", opens the current year. `computeYearReview` in `src/lib/public-metrics/yearly.ts` computes every slide.

| Slide | What it shows | Rule |
|---|---|---|
| Busiest day | The Europe/London calendar day with the most events on the timeline, and how many | Every event type counts except payments, failed payments, and refunds (`PAYMENT_EVENT_TYPE_IDS`), because a payment count hints at revenue. Events with no account, such as daily summaries, do not count. On a tie, the earliest of those days |
| Longest run of successful deployments | The most deployments that succeeded one after another on one provider in the year, with no failed deployment of that provider between them, and the provider's name | Each deployment provider's own success and failure types (`DEPLOYMENT_OUTCOMES`: DigitalOcean, GitLab, Railway, and Vercel), the deployments "Deployments shipped" counts. A failure on one provider never breaks another's run. On a tie between providers, the first name from A to Z, and the slide names at most two others and then how many more. A run that began the year before counts from 1 January. A failure at the same instant as a success is taken first, so a tie never lengthens a run |
| Most active provider | The provider's product name, for example Vercel, and its event count | The same events as the busiest day. On a tie, the first name from A to Z, and the slide names at most two others and then how many more |
| Totals | Deployments shipped, stars gained, signups, and providers connected | Counted by the engine, as below |

- The current year is there at any time as the year to date: titled "Your stack in 2026 so far", tagged "Year to date", and counted up to now. Once the year ends (1 January, UTC), the same page shows the whole year, tagged "2026 in review". Past years link from the page; a year that has not started is a `404`.
- A slide with nothing to count says so in words: "No events", "No successful deployments", "Not connected", "No provider activity". When no provider was connected in the year, the page says so, and for the current year links to Connections. When the first thing stored for the year (the first connection, or the first event counted, whichever is earlier) is after 1 January, the page says nothing is stored before that day, so the slides may cover only part of the year.
- Each total counts from 1 January, or from where its stored history starts when that is later (`historyStart`), and then says "since" that day. A total whose provider was connected only after the year reads "No data in 2025".
- A total whose provider has not synced for more than 48 hours (`STALE_AFTER_MS`) is counted up to the oldest last sync of that provider's accounts and says "counted up to" that day, instead of "Not synced in the last 2 days" in place of the count. A count over the year is still true up to there; a public current value is not, so published values, badges, and cards keep the 48 hour rule.
- No spend, revenue, account names, or repository names appear on any slide. Emails and GitHub Actions minutes are monthly totals in the engine, with no yearly formula, so they are not among the totals.
- The busiest day, the most active provider, and the run are counted in the database (see [Year in review counts](schema.md#year-in-review-counts)), so a year of events is never read into the app.
- Keyboard: Previous slide and Next slide are buttons; at either end the one that cannot move stays focusable and says it is unavailable (`GuardedButton`). Each move is announced as "Slide 2 of 4" and the slide's title. A slide's entrance animation is off under reduced motion.
- Each slide downloads as a 1200 by 630 PNG of the same figure: `busiest-day.png`, `deployment-run.png`, and `top-provider.png` under the year's address, and the totals at `card.png`. Each image reads only what its slide shows: the totals image never runs the year's event counts. On a slide image the title and the value are one line each, ending in an ellipsis where they would not fit; the detail wraps, and a tie names at most two other providers and then how many more, so the longest detail stays within three lines. The page shows the slide in full and the alt text says it all.
- Private: the page and its images answer only members (`Cache-Control: private, no-store`, the same `404` for anyone else, and for an unknown slide). Share opens the same dialog as milestone cards for the slide in view, with Download card in place of a public URL, the alt text, and "Share to X" with prefilled text. A slide is public only once a member posts it.
- A slide that rests on simulated data says "Simulated data, not verified".

History points are the engine's own values at each moment, computed by `computeMetricHistories` in `history.ts` with the same formulas as the current value. To avoid reading the database once per day and metric, it computes against `preloadHistoryStore`, a read-through cache that loads the window's snapshots (one paged read per metric key, up to 10,000 rows) and events (up to 5,000, in pages of 1,000, newest first) once, answers every query it fully covers from memory, and passes anything older to the real store. A read that stopped at its bound may be cut short, so its oldest day is treated as not loaded. Every answer is therefore the real store's answer.

## Project pages

An owner or admin can turn on one public page per project, at `/@<workspace>/<page slug>`, on the project's public metrics page. Nothing is public by default. The schema and functions are in [Database schema](schema.md#project-pages).

The `<workspace>` part is the workspace's handle once it has one, and its workspace ID otherwise. Owners and admins claim, change, or remove the handle under Settings, Public handle. A handle has 3 to 32 characters: lowercase letters and numbers with single hyphens between them. Input is trimmed and lowercased first, and every top-level route of the app plus names such as `www`, `help`, `support`, and `devmacro` are reserved (`RESERVED_HANDLES` in `src/lib/workspaces/handles.ts`, the one list). Handles are unique across workspaces, and none may equal another workspace's ID. While a workspace has a handle, its workspace ID address for a public page answers `307` to the handle address. Changing or removing a handle frees the old one at once for any workspace to claim, and links that use it answer 404; nothing redirects an old handle.

The page shows only what this engine publishes for the project:

| Section | What it shows |
|---|---|
| Published metrics | Every live publication, with its provenance (Verified, Estimated, or Self-reported), when it was last synced or the moment a delayed value describes, a link to its formula, and Simulated when the provider simulator made it up |
| Connected providers | An icon, named for screen readers, for each provider behind a published value that is still connected. Never an account name |
| History | One chart per published engine metric over the last 90 days, each day's value published with the same rounding and delay as today's. The chart's accessible name summarizes it (start, end, highest, lowest, and days with no value, or "no value on any day" when the period has none, as for a metric that stopped syncing), a sentence beside it states the same figures for the last 30 days, and its values open as a table. Self-reported values have no history |
| Achievements | Each published [achievement](#achievements), oldest first, with Share. Left out when none is published |
| Milestones | "First deployment recorded", "First signup recorded", "First customer recorded", and "First successful payment recorded", from the oldest stored event, while a metric counting those events is published exactly (a rounded publication can show 0 while events exist, so it reveals no first-event milestone) and no later than that publication's `asOf`; and "Reached 100 GitHub stars" (also 1,000, 10,000, 100,000) when the published GitHub stars history crosses it, only for thresholds its rounding can show. A milestone a published achievement already states is left out (see [Achievements](#achievements)) |

Choosing metrics, rounding to 10, 100, or 1,000, and showing values 7 days late are the publication options above; the page follows them. The page settings are the address, whether search engines may index it, and turning it on or off. Each change writes a DevMacro event to the timeline:

| Event type | Title | Body |
|---|---|---|
| `devmacro.project_page_enabled` | Turned on the public project page | Project Acme web. Address /@acme-labs/acme-web. Search engines are asked not to index it. |
| `devmacro.project_page_updated` | Updated the public project page | Project Acme web. Address /@k3j4h5g6f7/acme-web. Search engines may index it. |
| `devmacro.project_page_disabled` | Turned off the public project page | Project Acme web. The page is no longer public. |

Each body names the address the page answered at when the event was written: the handle address while the workspace had a handle, the workspace ID address otherwise. An event is history, so a later change of handle does not rewrite it.

An address answers only while its page is on and the project has at least one live publication, so "Unpublish everything" takes every page offline too. An unknown address, a page that is off, and a page with nothing published answer the same 404. The page renders per request and is not cached, unlike badges and cards: the enforced nonce policy needs per request HTML, and a shared cache would hand one nonce to every reader. So turning a page off answers 404 from the next request, and the [rate limit](#rate-limit) bounds what the page costs instead. Within one request the page and its metadata share one read of the page (`loadPublicProjectPage`, a React `cache`). A page asks search engines not to index it unless its owner allows indexing; `/sitemap.xml` lists the pages that are public and indexable, at most 1,000, and is read per request too. The page always sets its own preview title and description. When `NEXT_PUBLIC_SITE_URL` is set, it also names its canonical address and previews with the card of its first published engine metric (`/card/<project id>/<metric id>.png`), or with the site image (`/opengraph-image`) when only self-reported values are published.

`src/proxy.ts` rewrites `/@<workspace>/<page slug>` to the page route at `/p/<workspace>/<page slug>`, because a route folder starting with `@` is a parallel route slot, and answers every other path under `/@` or `/p` with the global 404, so a page has exactly one address. It reads the address with `parseProjectPagePath` (`src/lib/public-metrics/project-page.ts`), which applies the page's own slug and handle rules, length limits included, so a path no page can have answers that 404 without a database read or a rate limit count. For any other address it first counts the request against the public [rate limit](#rate-limit) and answers `429` past it, before any other read; the page cannot answer a `429` itself, for the same reason as the 404 below. Then it asks `public_project_page()` before rewriting and answers an address that is not public with that same 404: with Cache Components the page sends its shell with a `200` before its data loads, so a `notFound()` in the page could only stream a not-found page under a `200` ([Next.js, loading.js status codes](https://nextjs.org/docs/app/api-reference/file-conventions/loading#status-codes)). The page keeps its own check for a page turned off between the two reads. Each request for a well-formed address therefore costs one rate limit count and one `public_project_page()` read in the proxy before the page's own reads. The same read says whether the workspace has a handle: a workspace ID address of a workspace with one answers `307` to the handle address, query string kept. It is temporary rather than `308` because a handle can change and the old one is then free for another workspace, so no browser or crawler may keep the redirect. Only an address that answers a page redirects, so the redirect never reveals the handle of a workspace with nothing public. An unknown handle, a released one, and another workspace's handle with that page slug answer the same 404.

## Achievements

A project earns permanent achievements from its providers' data (#413), such as "10 Vercel deployments recorded" or "Kilostar: 1,024 GitHub stars". Each adapter declares its own in `ProviderAdapter.achievements`; the rule kinds and the wording rules are in [Adapters, Achievements](../adapters.md#achievements), and the tables and functions in [Database schema](schema.md#project-achievements).

### Counting

- After each successful sync of a connection, DevMacro evaluates that provider's achievements for every project the connection's accounts are assigned to, from the events and usage snapshots it has stored for the project's included accounts. Nothing calls a provider.
- Achievements count per provider: a project that deploys through Vercel and Railway earns "10 Vercel deployments recorded" and "10 Railway deployments recorded" separately. Cross-provider metrics such as "Deployments shipped" are unchanged.
- A project earns each achievement once, at the first moment its stored evidence supports. `(project_id, achievement_id)` is unique and recording never overwrites, so repeated syncs, backfills, and two evaluations at once can neither duplicate an achievement nor move its date.
- Earned is permanent. The 10th recorded deployment stays earned after it leaves a 30 day window, after the events and snapshots behind it are purged, and after the achievement is removed from its adapter, with the titles stored when it was earned.
- "In one day", "in one hour", "between midnight and 5 am", and "on 7 days in a row" are Europe/London calendar days and clock hours, the zone of the activity heatmap, never rolling windows. Metric rules are the exception: `usage_snapshots` keeps one reading per account, metric, and UTC day, so a metric rule's day is that stored UTC day. "Trending: 10 new stars in one day" (`daily_total_threshold` on `github.stars.gained.daily`) reads the new stars of repositories DevMacro already followed over one UTC day: the London day in winter, 01:00 to 01:00 London time in summer. A repository added to the installation never counts its existing stars as new, and a gap of more than one day between syncs never counts as one day (see [Adapters, Achievements](../adapters.md#achievements) and [GitHub, New stars per day](../providers/github.md#new-stars-per-day-githubstarsgaineddaily)).

### Evidence limits

- An event achievement says "recorded": providers backfill a limited history and some adapters set a baseline on the first sync, so the oldest event DevMacro stores may not be the very first. It is dated to the event that reached the count.
- A snapshot threshold such as "1,000 GitHub stars" is dated to the first stored reading at or above it. When no earlier reading below it is stored, DevMacro did not see the crossing, so every surface says "Recorded at least 1,000 on" that reading's date instead of "Earned".
- A daily total, such as PostHog's signups per day, is dated to its UTC day and shown as a date, never a time.
- Nothing is inferred from before DevMacro's evidence, and revenue, spend, quota, email volume, failures, and logins have no achievements. Payment achievements count payments, never amounts.

### Privacy and publishing

- Private by default. Every member sees the project's earned achievements in its Achievements section, and only owners and admins publish or unpublish them, one at a time there, or every one at once with "Unpublish everything".
- Each achievement has a private title and a public title. Public surfaces read only `public_published_achievements()`, through `loadPublishedAchievements` and `loadPublishedAchievement` in `published.ts`: the id, the provider, the public title, the earned date and its precision, the evidence and threshold, whether it is simulated, and when it was published. Never the private title, the description, an account or repository name, an amount, or an achievement that is not published.
- An achievement earned from data the provider simulator made up (any contributing account's connection is simulated) is stored as simulated and stays so. Every surface says so, as for a simulated metric: "Simulated" beside it on the Achievements page, the public project page, and its timeline entry; "(simulated)" after the title and the simulated fill on its badge; "Simulated data, not verified" on its card and in the badge and card alt text; and "Earned from simulated <provider> data on DevMacro, not verified" in a post.
- A published achievement does not make a project page public on its own: the page still needs a live published metric.

### Timeline entries

- Earning an achievement writes one `devmacro.achievement_earned` event to the workspace timeline, with the visible label "Achievement earned", the private title, severity success, and the earned date as its time, so a backfill lands in its place in history rather than at the top. Its dedupe key `achievement:<project id>:<achievement id>` stops a repeated evaluation from writing it twice.
- The row shows the logo and name of the provider that earned it, read from the adapter-scoped id, with 🏆 in the logo's corner, and its pill says "Achievement" in gold where other success events say "Success". The event details show the gold "Achievement earned" label in place of a severity pill. Every other row carries its own type's emoji in the same corner (`EventType.emoji`, or DevMacro's own in `src/lib/timeline/event-emoji.ts`).
- The event has no connection, so whether it is simulated comes from its achievement (`withAchievementSimulated` in `src/lib/achievements/private.ts`): a simulated achievement's row and details say "Simulated".
- Publishing and unpublishing an achievement write `devmacro.achievement_published` and `devmacro.achievement_unpublished` audit events (see [Publishing and the audit trail](#publishing-and-the-audit-trail)).
- The entry links to the achievement in the project's Achievements section. Share opens the share dialog when the achievement is published; when it is not, owners and admins see Publish instead and other members see neither. Members can hide the event type like any other.
- The timeline is private, so unpublishing keeps the entry. Deleting the project or its workspace deletes the achievements, their publications, and these entries.

### Public surfaces

| Surface | What it shows |
|---|---|
| Project page, Achievements | Each published achievement, oldest first: its public title, "Simulated" when simulator data earned it, the provider's mark and name, "Earned 2026-11-05 14:05 GMT" (Europe/London), "Earned 2026-11-05" for a daily total, or "Recorded at least 1,000 on 2026-11-05 14:05 GMT", and Share. The private Achievements page uses the same words (`achievementEarnedText` in `share.ts`) |
| `GET /badge/<project id>/achievement-<achievement id>.svg` | A two part SVG badge: 🏆 and the provider's name, then the public title, followed by "(simulated)" on the simulated fill when simulator data earned it. Its `<title>` adds when it was earned in the same words |
| `GET /card/<project id>/achievement-<achievement id>.png` | A 1200 by 630 PNG: the project's name while its page is public, the provider, the public title, and when it was earned, under a gold "Achievement earned" tag, or "Simulated data, not verified" when simulator data earned it |

- The badge and card follow the [metric badge rules](#badges-and-cards): an unknown, unpublished, or malformed id gets the same neutral "Unpublished" badge or card with a `200`; the same 60 second cache and [rate limit](#rate-limit); no session or cookie; `Cross-Origin-Resource-Policy: cross-origin`; and the badge's Content-Security-Policy from `next.config.ts`. `achievementIdFromFile` in `share.ts` accepts only an id the database can store. Achievement serves are not counted in [view counts](#view-counts), which are kept per published metric.
- No fact is listed twice. While a published achievement states a derived milestone, the page leaves the milestone out (`milestonesBesideAchievements` in `history.ts`): "Reached 1,000 GitHub stars" while `github.stars.1000` is published (also 100 and 10,000), the first signup, customer, and payment while Supabase's first signup or Stripe's first customer or payment is, and "First deployment recorded" while one host's first deployment is published and is the same event. The milestones keep their own definitions.
- The share dialog (`AchievementShareDialog` in `src/components/public-metrics/achievement-share-dialog.tsx`), on the project page and in the app, offers the badge with its Markdown for a README and "Copy badge Markdown", for example `[![10 Vercel deployments recorded](<site>/badge/<project id>/achievement-vercel.deployments.10.svg)](<project page>)`; the card with its URL and alt text; and "Copy link", "Share to X", and "Share to LinkedIn". Nothing is posted automatically. While the project page is off, the badge links to the site, posts link to the card, and nothing names the project (`achievementShareLinks` in `share.ts`).

### Unpublishing

Unpublishing deletes the achievement's publication row, one at a time from the Achievements page or all at once with "Unpublish everything" on a public metrics page. The project page renders per request, so the achievement leaves it on the next request; the badge and card are cached for up to a minute and then show "Unpublished". The achievement stays earned and private, with its timeline entry, and publishing it again shows it with its original date.

## Metrics

Each metric below is defined once in `src/lib/public-metrics/definitions.ts`. The heading is the metric id, used in the public route, badge URLs, and links to this page.

### `github-stars`

GitHub stars. Verified, in stars. Snapshots: `github.stars.total`. Minimum history: none.

Stars across the repositories the project's GitHub accounts can see, from the newest hourly star count. Repository names are never shown.

### `github-stars-gained-7d`

GitHub stars gained in 7 days. Verified, in stars. Snapshots: `github.stars.total`. Minimum history: 7 days.

The newest star count minus the star count at the end of the day 7 days ago, per GitHub account, added up. Unstars count against it, and it never goes below zero.

### `github-stars-gained-30d`

GitHub stars gained in 30 days. Verified, in stars. Snapshots: `github.stars.total`. Minimum history: 30 days.

The newest star count minus the star count at the end of the day 30 days ago, per GitHub account, added up. Unstars count against it, and it never goes below zero.

### `vercel-deployments-7d`

Deployments in 7 days. Verified, in deployments. Events: `digitalocean.deployment.succeeded`, `gitlab.deployment.succeeded`, `railway.deployment.deployed`, `vercel.deployment.succeeded`. Minimum history: 7 days.

Deployments that finished successfully on the project's DigitalOcean, GitLab, Railway, and Vercel accounts in the last 7 days, one per deployment. Counts deployments to every environment (production and preview) until DevMacro records the environment of each deployment.

The id keeps its `vercel-` prefix because published rows store it; until 2026-11 it counted Vercel deployments only, so a project with deployments on the other providers reads a higher value from then on.

### `vercel-deployments-30d`

Deployments in 30 days. Verified, in deployments. Events: `digitalocean.deployment.succeeded`, `gitlab.deployment.succeeded`, `railway.deployment.deployed`, `vercel.deployment.succeeded`. Minimum history: 30 days. The year in review's "Deployments shipped" total counts these events over the year.

Deployments that finished successfully on the project's DigitalOcean, GitLab, Railway, and Vercel accounts in the last 30 days, one per deployment. Counts deployments to every environment (production and preview) until DevMacro records the environment of each deployment.

The id keeps its `vercel-` prefix because published rows store it; until 2026-11 it counted Vercel deployments only, so a project with deployments on the other providers reads a higher value from then on.

### `vercel-deployment-streak`

Successful deployments in a row. Verified, in deployments. Events: `vercel.deployment.succeeded` and `vercel.deployment.failed`. Minimum history: none.

Vercel deployments that succeeded since the newest failed one, counted in deployments, not days. Counts deployments to every environment (production and preview) until DevMacro records the environment of each deployment.

### `supabase-signups-7d`

Signups in 7 days. Verified, in signups. Events: `supabase.auth.signup`. Minimum history: 7 days.

New users in the project's Supabase projects in the last 7 days, from Supabase's auth logs, one per signup.

### `supabase-signups-30d`

Signups in 30 days. Verified, in signups. Events: `supabase.auth.signup`. Minimum history: 30 days.

New users in the project's Supabase projects in the last 30 days, from Supabase's auth logs, one per signup.

### `resend-emails-month`

Emails this month. Verified, in emails. Snapshots: `resend.emails.monthly.used`. Minimum history: none.

Emails counted against the Resend monthly quota in the current quota month, as Resend reports it (sent and received), added up across the project's Resend teams.

### `resend-quota-percent-month`

Resend monthly quota used. Verified, in percent. Snapshots: `resend.emails.monthly.used` over `resend.emails.monthly.limit`. Minimum history: none.

Emails counted against the Resend monthly quota divided by the monthly quota, in the current quota month, rounded down to a whole percent. Teams with no quota limit are left out.

### `github-actions-minutes-month`

GitHub Actions minutes this month. Verified, in minutes. Snapshots: `github.usage.actions.minutes`. Minimum history: none.

GitHub Actions minutes used this billing month, as GitHub's billing usage report states them. Only accounts on GitHub's enhanced billing platform report it.

### `stripe-customers-30d`

New customers in 30 days. Verified, in customers. Events: `stripe.customer.created`. Minimum history: 30 days.

Customers created on the project's Stripe accounts in the last 30 days, as a count. Never an amount.

### `stripe-payments-30d`

Successful payments in 30 days. Verified, in payments. Events: `stripe.charge.succeeded`. Minimum history: 30 days.

Payments that succeeded on the project's Stripe accounts in the last 30 days, as a count. Never an amount.

## Adding a metric

1. Add the id to the enum in a new migration: `alter type public.public_metric_id add value '<id>';`, then regenerate the database types.
2. Add its definition in `definitions.ts`; the type checker refuses an enum value without one.
3. Add its section here with the same formula; `definitions.test.ts` fails until the page and the code agree.
4. Add its expected value to `simulated-data.test.ts` and boundary cases to `engine.test.ts`.

A metric must read a quantity or an event its provider already stores. A metric about money is never added.
