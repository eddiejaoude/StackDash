# GitLab

Provider id: `gitlab`. Verification: documentation only. Docs checked 2026-11-05.

StackDash reads GitLab.com compute minutes, storage, and plan, plus pipelines, deployments, releases, and merged merge requests. It asks for the read-only `read_api` and `read_user` scopes.

**Not yet confirmed with a real account.** Registering the OAuth application on GitLab.com is deferred, so everything below comes from GitLab's official documentation and was checked on 2026-11-05. The adapter is tested against sample responses copied from that documentation, not recorded traffic. Every claim that a real account still has to confirm is in [Unverified](#unverified). Until then, try GitLab locally with the simulator (`STACKDASH_SIMULATE_PROVIDERS=1`).

## Go or no-go

**Go, GitLab.com only, with one estimate.** An OAuth application with the read-only `read_api` and `read_user` scopes reads compute minutes per namespace and per project, namespace storage and its limit, the plan, and activity: pipelines, deployments per environment, releases, and merged merge requests. Two limits shape it:

- GitLab returns no dollar cost through these scopes, and the monthly compute quota (`shared_runners_minutes_limit`) is only returned to GitLab.com administrators. The quota is therefore derived from the plan and the pricing page, and labeled estimated.
- Compute minutes and storage are only shown to the namespace's Owner (see [Unverified](#unverified)). StackDash lists only namespaces the user owns (`owned_only=true`), so a member who is not an Owner gets no GitLab account at all. If GitLab still refuses the usage of a listed namespace, the connection lists it as unavailable and activity keeps arriving.

Self-managed GitLab instances are out of scope: each would need its own OAuth app and API origin.

## Connection

OAuth 2.0 authorization code flow with PKCE (S256), as a confidential application (StackDash keeps the secret on the server).

| Item | Value |
|---|---|
| Authorize URL | `GET https://gitlab.com/oauth/authorize` (browser navigation) |
| Token URL | `POST https://gitlab.com/oauth/token` |
| Revoke URL | `POST https://gitlab.com/oauth/revoke` |
| Callback URL | `<SITE_URL>/api/connections/gitlab/callback` |
| REST base URL | `https://gitlab.com/api/v4` |
| GraphQL URL | `POST https://gitlab.com/api/graphql` |
| Scopes | `read_api read_user` |
| Access token | 2 hours (`expires_in: 7200`) |
| Refresh token | No documented lifetime. Rotates on every use |
| Client authentication | `client_id` and `client_secret` in the form body. Never also in a Basic header: GitLab answers `400` when both are sent |

### Authorize

Query: `client_id`, `redirect_uri`, `response_type=code`, `state`, `scope=read_api read_user`, `code_challenge`, `code_challenge_method=S256`. The scope is always sent: the guide describes `scope` as the list the app requests, and StackDash never relies on what an omitted value means. `root_namespace_id` is only for groups with SAML SSO and is not sent (see [Limitations](#limitations)).

### Token exchange

`POST /oauth/token` with `client_id`, `client_secret`, `grant_type=authorization_code`, `code`, `redirect_uri`, `code_verifier`. The response holds `access_token`, `token_type` (`bearer`), `expires_in`, `refresh_token`, and `created_at`. The documented examples carry no `scope`; when GitLab sends one, StackDash stores what was granted, otherwise the requested scopes.

Then `GET /api/v4/user` (needs `read_user`) reads the user's id and username. They are kept on the stored credential, with the redirect URI, and nothing else from the profile is read.

### Token lifetimes and refresh

Access tokens expire after 2 hours. `POST /oauth/token` with `client_id`, `client_secret`, `grant_type=refresh_token`, `refresh_token`, and `redirect_uri` (the guide's example sends it and says it must match the authorize request). The refresh invalidates the old access token **and the old refresh token** and returns a new pair.

StackDash refreshes through the shared sync path (`refreshIfExpiring` in `src/lib/jobs/sync-connection.ts`): a token within 5 minutes of expiry is refreshed, the new pair is saved before anything else runs, and two syncs of one connection never run together, so two refreshes can never race and spend the same refresh token. `invalid_grant` on refresh means the grant is gone and the connection asks to be reconnected.

### Disconnect and revoke

- From StackDash: `POST /oauth/revoke` with `client_id`, `client_secret`, and `token` (the refresh token, or the access token when no refresh token is stored). Success is `200` with `{}`. The stored credential is deleted either way.
- From GitLab: avatar, **Edit profile**, **Access**, **Applications**, then **Revoke** next to StackDash under **Authorized applications**. Without webhooks StackDash finds out on the next sync, which fails with `401` and marks the connection as needing attention.

## Permissions

| Scope | Access | Why | Also allows |
|---|---|---|---|
| `read_api` | Read | Namespaces and plan, compute minutes and storage (GraphQL), projects, pipelines, deployments, releases, merge requests | Read access to the whole API for everything the user can see: code through the API, issues, the container and package registries |
| `read_user` | Read | The user's id and username at connect time | The user's profile through `/user` (username, public email, full name) and read-only endpoints under `/users` |

Not requested: `api` (read and write), `read_repository`, `openid`, `profile`, `email`. **No activity in this adapter needs a write scope.** Setting up webhooks automatically would need `api` (see [Webhooks](#webhooks)), which is why activity is polled.

## Data

One external account per **top-level namespace the user owns**: the personal namespace and each top-level group listed by `GET /namespaces?owned_only=true&top_level_only=true` (paginated, 100 per page, at most 5 pages). Subgroups belong to their top-level group, where compute minutes and storage are counted.

### Plan: `GET /namespaces/:id`

`plan` (for example `free`, `premium`, `ultimate`), `kind` (`user` or `group`), `path`, `full_path`. Only the plan name is used, to pick the estimated compute quota.

### Compute minutes and storage: `POST /api/graphql`

One query per sync for the current UTC month (`$month` is the first day of the month):

```graphql
query StackDashUsage($fullPath: ID!, $namespaceId: NamespaceID!, $month: Date!, $projects: Int!) {
  namespace(fullPath: $fullPath) { actualSizeLimit rootStorageStatistics { storageSize } }
  ciMinutesUsage(namespaceId: $namespaceId, date: $month, first: 1) { nodes { monthIso8601 minutes } }
  ciMinutesProjectMonthlyUsage(namespaceId: $namespaceId, date: $month, first: $projects) {
    nodes { minutes project { id fullPath } }
  }
}
```

- `ciMinutesUsage.minutes`: compute minutes used by every project in the namespace this month. No row yet this month counts as 0.
- `ciMinutesProjectMonthlyUsage`: the same per project, for up to 20 projects. Project ids are GraphQL global ids (`gid://gitlab/Project/42`); the number keys the per project metric.
- `rootStorageStatistics.storageSize`: total storage of the namespace in bytes (repositories, LFS, artifacts, packages, registry, wiki, snippets, uploads). GitLab builds these statistics in the background, so a namespace with nothing stored yet can have none. Then the storage used and limit are left out, with no permission error.
- `actualSizeLimit`: the storage limit in bytes for the namespace, whichever kind of enforcement applies. Zero or null means no limit is shown.

`read_api` is enough for GraphQL queries. A query field the user may not read comes back `null` with no error, and a refused connection field is `null` while an allowed one with no data is `{ "nodes": [] }` ([GraphQL API, "Authorization"](https://docs.gitlab.com/api/graphql/#authorization), checked 2026-11-05). So a `null` usage field is reported as unavailable, not as zero, and only a `null` `ciMinutesUsage` is reported as a missing permission. A response that carries `errors` is not a permission answer: it means a parse, validation, complexity, or server failure, so it fails the sync with an error reference (only the number of errors is logged) and the next sync retries.

The REST `ci_minutes_usage` attribute on `GET /namespaces/:id` (GitLab 19.4) was not used: it is documented for top-level groups only, so personal namespaces would have no minutes at all.

### Activity (by polling)

Each sync reads the 10 most recently active, non-archived projects of the namespace (`GET /groups/:id/projects?include_subgroups=true&with_shared=false&archived=false&simple=true&order_by=last_activity_at&sort=desc`, or `GET /users/:username/projects` with the same filters for a personal namespace). For each project, four requests run together, one page each:

| Event | Endpoint | Rule |
|---|---|---|
| Pipeline succeeded or failed | `GET /projects/:id/pipelines?scope=finished&updated_after=<since>&order_by=updated_at&sort=desc&per_page=100` | One event per pipeline and final status. Dated by `updated_at`, the closest the list gives to the finish time. A failure on the default branch is critical, elsewhere a warning. Canceled and skipped pipelines are left out |
| Deployment succeeded or failed, per environment | `GET /projects/:id/deployments?updated_after=<since>&order_by=updated_at&sort=desc&per_page=100` | One event per deployment and final status, titled with the environment. A failure in `production` (or `prod`, or a `production/...` folder) is critical. `updated_after` without `order_by=updated_at` is a `400` |
| Release published | `GET /projects/:id/releases?order_by=released_at&sort=desc&per_page=20` | No date filter exists, so the newest page is filtered: released after `<since>` and not in the future (`upcoming_release`) |
| Merge request merged | `GET /projects/:id/merge_requests?state=merged&merged_after=<since>&order_by=merged_at&sort=desc&per_page=100` | One event per merged merge request, titled with its number. The title, description, author, and reviewers are never read |

`<since>` is the previous sync's start minus 10 minutes, or 7 days back on the first sync. Dedupe keys (`gitlab.pipeline:<project>:<pipeline>:<status>` and the like) make the overlap and re-reads idempotent. A `403` or `404` from one project endpoint (for example CI/CD turned off in that project) skips that endpoint for that project only. A full page is logged, because older items in the window were not read.

The dashboard headline's deploys count `gitlab.deployment.succeeded` as a succeeded deploy and `gitlab.deployment.failed` as a failed one. Pipelines are CI runs that may deploy nothing, and releases and merges are not deployments, so none of them counts. GitLab reports no spend, so it declares no projected spend.

## Achievements

StackDash evaluates these for each project the GitLab accounts are assigned to, from the GitLab data it has stored, after each sync (see [Achievements](../adapters.md#achievements)). A project earns each one once, and it stays private until an owner or admin publishes it.

The deployment ladder is the same on Vercel, Railway, and DigitalOcean. It counts `gitlab.deployment.succeeded` events, and a `gitlab.deployment.failed` event breaks a run of deployments in a row. The pipeline achievements count `gitlab.pipeline.succeeded` events, broken by `gitlab.pipeline.failed`; the merge request ones count `gitlab.merge_request.merged`, and the release ones `gitlab.release.published`. Days, hours, and weekdays are London time.

| Id | Title | How it is earned |
|---|---|---|
| `gitlab.deployments.first` | First GitLab deployment recorded | Earned when StackDash records the first successful GitLab deployment. |
| `gitlab.deployments.10` | 10 GitLab deployments recorded | Earned when StackDash records the 10th successful GitLab deployment. |
| `gitlab.deployments.100` | 100 GitLab deployments recorded | Earned when StackDash records the 100th successful GitLab deployment. |
| `gitlab.deployments.streak_10` | 10 GitLab deployments in a row | Earned when StackDash records 10 successful GitLab deployments in a row, with no failed deployment between them. |
| `gitlab.deployments.night_owl` | Night owl: a GitLab deployment between midnight and 5 am | Earned when StackDash records a successful GitLab deployment between midnight and 5 am London time. |
| `gitlab.deployments.friday_ship` | Shipped on a Friday afternoon | Earned when StackDash records a successful GitLab deployment on a Friday between 4 pm and midnight London time. |
| `gitlab.deployments.busy_day` | Busy day: 10 GitLab deployments in one day | Earned when StackDash records 10 successful GitLab deployments on one London calendar day. |
| `gitlab.deployments.weekly_rhythm` | Weekly rhythm: a GitLab deployment on 7 days in a row | Earned when StackDash records a successful GitLab deployment on each of 7 consecutive London calendar days. |
| `gitlab.pipelines.100` | 100 GitLab pipelines passed | Earned when StackDash records the 100th successful GitLab pipeline. |
| `gitlab.pipelines.green_streak` | Green streak: 25 pipelines passed in a row | Earned when StackDash records 25 successful GitLab pipelines in a row, with no failed pipeline between them. |
| `gitlab.merge_requests.first` | First merge request merged | Earned when StackDash records the first merged GitLab merge request. |
| `gitlab.merge_requests.100` | 100 merge requests merged | Earned when StackDash records the 100th merged GitLab merge request. |
| `gitlab.merge_requests.marathon` | Merge marathon: 10 merge requests in one day | Earned when StackDash records 10 merged GitLab merge requests on one London calendar day. |
| `gitlab.releases.first` | First GitLab release published | Earned when StackDash records the first published GitLab release. |
| `gitlab.releases.10` | 10 GitLab releases published | Earned when StackDash records the 10th published GitLab release. |

## Verified, estimated, unavailable

| Value | Status |
|---|---|
| Compute minutes used this month, per namespace and per project | Verified (GitLab's figure), unit `minutes`, period the UTC month, resets on the 1st |
| Monthly compute quota | **Estimated** from the plan: Free 400, Premium 10,000, Ultimate 50,000 minutes ([pricing](https://about.gitlab.com/pricing/)). Trial and other plan names get no estimate |
| Compute minutes left this month | Estimated: the estimated quota minus verified use, never below zero |
| Namespace storage used | Verified, converted to GiB (2^30 bytes) |
| Storage limit | Verified when GitLab returns one (`actualSizeLimit`) |
| Pipelines, deployments, releases, merged merge requests | Verified, by polling, dated as described above |
| Dollar cost, invoices, purchased compute minutes, seats | Unavailable through these scopes |
| The real monthly quota (`shared_runners_minutes_limit`, `extra_shared_runners_minutes_limit`) | Unavailable: GitLab.com administrators only |

Every metric carries its unit, period, and retrieval time; estimated ones carry the pricing page and the date it was checked.

## Rate limits

GitLab.com allows 2,000 authenticated API requests a minute per user, 600 a minute on `GET /groups/:id/projects`, and 300 a minute on `GET /users/:user_id/projects`. A throttled request gets `429` with `Retry-After` in seconds, which StackDash honors. One hourly sync is at most 1 namespace read, 1 GraphQL query, 1 project list, and 40 project requests (10 projects, 4 each), about 43 requests an hour per namespace. GraphQL queries are limited to a complexity of 250 and 100 nodes a page; the usage query asks for at most 20 project nodes.

## Webhooks

Not received yet; planned, through the shared webhook route (see [Webhooks](../adapters.md#webhooks)), with polling kept as the backfill. Project and group webhooks are created through the API with the `api` scope, which is read and write, so automatic setup would be an opt-in; a webhook set up by hand keeps StackDash read-only. Pipeline, deployment, release, and merge request events would then reach the timeline as they happen; compute minutes and storage stay polled.

## Permission risks

Disclose these on the connect screen before redirecting:

- **`read_api` is broad.** It reads everything the user can see through the API: source code through the repository files API, issues, merge request contents, CI/CD job logs, and the container and package registries, across every group and project the user belongs to. StackDash calls only the endpoints listed in [Data](#data).
- **`read_user`** reads the user's profile, including public email and full name. StackDash keeps only the user id and username.
- The access token lasts 2 hours, but the refresh token has no documented expiry, so a stored refresh token keeps access alive until it is revoked. It is encrypted at rest and rotates on every refresh.
- The client secret can exchange any code issued to the app. Store it only in the server environment, and use **Renew secret** in the application settings to rotate it.

## Limitations

- GitLab.com only. Self-managed and Dedicated instances need their own OAuth app and origin.
- No dollar cost and no real compute quota (see [Verified, estimated, unavailable](#verified-estimated-unavailable)).
- Usage needs the Owner role. Every listed namespace is one the user owns; the missing permission notice is the fallback if GitLab still refuses usage for one of them.
- Activity covers the 10 most recently active projects per namespace and one page per endpoint and project per sync.
- Pipeline and deployment times are `updated_at`, which can be later than the finish time if the record changes afterwards.
- Groups with SAML SSO may need `root_namespace_id` on the authorize URL; StackDash does not send it yet.
- Namespaces owned through a group where the user is an Owner but not the creator may not be listed by `owned_only` (see [Unverified](#unverified)).

## Self-hosted registration

Each deployment registers its own GitLab.com application, because the callback URL and client secret belong to one deployment.

1. On GitLab.com, select your avatar, then **Edit profile**, then **Access**, then **Applications**, then **Add new application**. To own it as a group, open the group's **Settings**, then **Applications** instead.
2. **Name**: for example `StackDash (your name)`.
3. **Redirect URI**: `<SITE_URL>/api/connections/gitlab/callback`.
4. **Confidential**: checked. StackDash keeps the secret on the server.
5. **Scopes**: `read_api` and `read_user`. Nothing else.
6. **Save application**. Copy the **Application ID** and, with **Copy**, the **Secret**.
7. Set the environment variables:

| Variable | Value |
|---|---|
| `GITLAB_CLIENT_ID` | Application ID |
| `GITLAB_CLIENT_SECRET` | Secret. Server only |

## Sample responses

All from GitLab's API reference (checked 2026-11-05), trimmed, with synthetic names, emails, and tokens. The test fixtures in `src/lib/adapters/gitlab/fixtures` are these samples. They are not recorded traffic (see [Unverified](#unverified)).

`POST /oauth/token` (authorization code):

```json
{
  "access_token": "synthetic-gitlab-access-token",
  "token_type": "bearer",
  "expires_in": 7200,
  "refresh_token": "synthetic-gitlab-refresh-token",
  "created_at": 1607635748
}
```

`GET /namespaces/:id` (trimmed):

```json
{
  "id": 2,
  "name": "group1",
  "path": "group1",
  "kind": "group",
  "full_path": "group1",
  "parent_id": null,
  "web_url": "https://gitlab.example.com/groups/group1",
  "plan": "free",
  "trial": false,
  "root_repository_size": 100
}
```

`POST /api/graphql` with the usage query (the reference lists fields, not samples, so the values are synthetic):

```json
{
  "data": {
    "namespace": { "actualSizeLimit": 10737418240, "rootStorageStatistics": { "storageSize": 3221225472 } },
    "ciMinutesUsage": { "nodes": [{ "monthIso8601": "2026-11-01", "minutes": 312 }] },
    "ciMinutesProjectMonthlyUsage": {
      "nodes": [{ "minutes": 250, "project": { "id": "gid://gitlab/Project/9", "fullPath": "group1/html5-boilerplate" } }]
    }
  }
}
```

`GET /projects/:id/pipelines` (one item):

```json
{
  "id": 47,
  "iid": 12,
  "project_id": 9,
  "status": "failed",
  "source": "push",
  "ref": "main",
  "web_url": "https://gitlab.example.com/group1/html5-boilerplate/-/pipelines/47",
  "created_at": "2026-11-05T09:28:34.085Z",
  "updated_at": "2026-11-05T09:32:35.169Z"
}
```

`GET /projects/:id/deployments` (one item, trimmed):

```json
{
  "id": 41,
  "iid": 1,
  "status": "success",
  "ref": "main",
  "created_at": "2026-11-05T07:36:40.222Z",
  "updated_at": "2026-11-05T07:38:12.414Z",
  "environment": { "id": 9, "name": "production", "external_url": "https://example.com" }
}
```

`GET /projects/:id/releases` (one item, trimmed):

```json
{
  "tag_name": "v0.2",
  "name": "Awesome app v0.2 beta",
  "released_at": "2026-11-05T01:56:19.539Z",
  "upcoming_release": false,
  "_links": { "self": "https://gitlab.example.com/group1/html5-boilerplate/-/releases/v0.2" }
}
```

`GET /projects/:id/merge_requests?state=merged` (one item, trimmed):

```json
{
  "iid": 1,
  "title": "test1",
  "state": "merged",
  "merged_at": "2026-11-05T11:16:17.520Z",
  "web_url": "https://gitlab.example.com/group1/html5-boilerplate/-/merge_requests/1"
}
```

## Unverified

Confirm with a real GitLab.com account and a test group once the application is registered:

- That the token response carries `scope`, and in which form (space separated is assumed). Without it, StackDash records the requested scopes.
- That the refresh request needs `redirect_uri` (the guide's example sends it; RFC 6749 does not require it) and that `invalid_grant` is the error for a spent or revoked refresh token.
- That revoking the refresh token also ends its access token and removes StackDash from **Authorized applications**.
- That OAuth tokens with `read_api` are accepted by the releases endpoints (their page only names personal access tokens and job tokens).
- That `owned_only=true` lists every top-level group where the user has the Owner role, and not only groups the user created.
- Who may read `ciMinutesUsage`, `ciMinutesProjectMonthlyUsage`, and `rootStorageStatistics` (Owner is assumed, from the Usage Quotas page). That a refused field is `null` with no error is documented ([GraphQL API, "Authorization"](https://docs.gitlab.com/api/graphql/#authorization)); which role GitLab checks for these three fields is not.
- That `rootStorageStatistics` is `null` for a namespace whose statistics GitLab has not built yet, and not only when the role is missing (assumed from the field being nullable).
- That the token request may send `client_secret` and `code_verifier` together. The OAuth guide shows PKCE for public clients without the secret, and the confidential flow without PKCE. Doorkeeper, which GitLab uses, is expected to accept both for a confidential application, but the guide does not show the combination.
- That a month without usage returns an empty `ciMinutesUsage` list rather than a row with `0`.
- What `actualSizeLimit` holds for a Free namespace under project limit enforcement (per project or per namespace) and on paid plans.
- The exact `plan` strings GitLab.com returns for trials and programs (`ultimate_trial`, `opensource`, and others). Only `free`, `premium`, and `ultimate` get an estimate.
- That the compute minutes month runs on UTC days.
- Whether `updated_at` of a finished pipeline or deployment matches its finish time in practice.

## Sources

All checked 2026-11-05.

- [OAuth 2.0 identity provider API](https://docs.gitlab.com/api/oauth2/)
- [Configure GitLab as an OAuth 2.0 authentication identity provider (scopes, registering an application)](https://docs.gitlab.com/integration/oauth_provider/)
- [Namespaces API](https://docs.gitlab.com/api/namespaces/)
- [Users API (retrieve the current user)](https://docs.gitlab.com/api/users/)
- [Groups API (list a group's projects)](https://docs.gitlab.com/api/groups/)
- [Projects API (list a user's projects)](https://docs.gitlab.com/api/projects/)
- [Pipelines API](https://docs.gitlab.com/api/pipelines/)
- [Deployments API](https://docs.gitlab.com/api/deployments/)
- [Releases API](https://docs.gitlab.com/api/releases/)
- [Merge requests API](https://docs.gitlab.com/api/merge_requests/)
- [GraphQL API (authentication, token scopes, limits)](https://docs.gitlab.com/api/graphql/)
- [GraphQL API reference: queries `ciMinutesUsage`, `ciMinutesProjectMonthlyUsage`, `namespace`](https://docs.gitlab.com/api/graphql/reference/)
- [Compute minutes (quota, reset on the first of each month)](https://docs.gitlab.com/ci/pipelines/compute_minutes/)
- [GitLab.com rate limits](https://docs.gitlab.com/user/gitlab_com/rate_limits/)
- [GitLab pricing (compute minutes and storage per plan)](https://about.gitlab.com/pricing/)
- [GitLab press kit (brand color)](https://about.gitlab.com/press/press-kit/)
