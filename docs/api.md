# REST API

The REST API lets your own scripts, tools, and dashboards read one workspace: usage and spend, timeline events, triggered alerts, and connection status, in the same units and with the same verified or estimated labels as the dashboard. It only reads. No key can change anything in a workspace.

The OpenAPI 3.1 document for every endpoint below is published at `/docs/api/openapi.json` on your StackDash site. It is generated from the same schemas the endpoints validate requests with, so it always matches what the server accepts and returns.

The same keys also connect an AI assistant to the workspace through the read-only [MCP server](mcp.md).

## Create a key

1. Open the workspace, then **Settings**, then **API keys**. Only owners and admins can create keys; everyone else sees why not. **Create API key** in the command palette (Cmd+K or Ctrl+K) opens the same form.
2. Under **Key name**, name the key after the script or tool that will use it, choose **What the key may read**, and select **Create key**.
3. Copy the key. StackDash shows it once and stores only a hash of it, so it cannot show it again. If you lose it, revoke it and create another.

A key belongs to one workspace. It stops working when you revoke it, and when the member who created it leaves the workspace. Settings marks such a key **Not working**; revoke it and create a new one. A workspace can hold 20 keys that are not revoked, so revoke keys you no longer use to make room.

Keep the key out of your shell history and out of your code. Read it into an environment variable instead:

```bash
export STACKDASH_URL="https://your-stackdash-site.example.com"
read -rs STACKDASH_API_KEY && export STACKDASH_API_KEY   # paste the key, then press Enter
```

## Scopes

| Scope | What it reads | Endpoint |
|---|---|---|
| `usage:read` | Daily snapshots of usage, spend, allowances, and revenue | `/api/v1/usage-snapshots` |
| `events:read` | The timeline: deployments, payments, sync failures, daily summaries | `/api/v1/events` |
| `alerts:read` | Alerts that fired, and whether someone acknowledged them | `/api/v1/triggered-alerts` |
| `connections:read` | Each connection's status and last sync. Never credentials | `/api/v1/connections` |

Any working key, whatever its scopes, can read `/api/v1/workspaces` and `/api/v1/projects`, because the other answers refer to them.

## Requests and responses

Send the key as a bearer token. Every endpoint is a `GET` and answers JSON.

```bash
curl -sS -H "Authorization: Bearer $STACKDASH_API_KEY" "$STACKDASH_URL/api/v1/workspaces"
```

Every endpoint answers with one page of a list:

```json
{
  "data": [
    { "id": "20000000-0000-4000-8000-000000000001", "slug": "acmeseedws", "name": "Acme", "is_personal": false, "created_at": "2026-11-05T09:00:00.000000+00:00" }
  ],
  "next_cursor": null
}
```

- **Pages.** `limit` sets the page size, 1 to 100, default 50. When `next_cursor` is not null, pass it as `cursor` to read the next page, with the same filters. Lists are ordered by time with the row id as a tie break, so a page never skips or repeats a row while new rows arrive.
- **Money** is `amount_minor`, an integer in the currency's minor unit (cents for `USD`), plus `currency`, an ISO 4217 code. Amounts in different currencies are never added together.
- **Quantities** are `value` plus `unit`, for example `1200` and `emails`.
- **Provenance.** `provenance` is `verified` when the provider reported the number and `estimated` when StackDash calculated it from a price list, named in `pricing_source`. These are the labels the dashboard shows.
- **Simulated data.** `simulated` is true when the provider simulator made the connection, so the numbers are made up.
- **Times** are RFC 3339 with an offset, in UTC. Snapshot days are UTC calendar dates.
- Unknown or repeated query parameters are refused with `400`, so a typo never silently returns everything.

## Endpoints

### Workspace

`GET /api/v1/workspaces` returns the key's workspace, as a list of one. `slug` is the workspace ID shown in settings and in app URLs.

```bash
curl -sS -H "Authorization: Bearer $STACKDASH_API_KEY" "$STACKDASH_URL/api/v1/workspaces"
```

### Projects

`GET /api/v1/projects` returns the workspace's projects, oldest first.

```bash
curl -sS -H "Authorization: Bearer $STACKDASH_API_KEY" "$STACKDASH_URL/api/v1/projects"
```

### Connection status

`GET /api/v1/connections` needs `connections:read`. It returns each connection's provider, name, account, status (`pending`, `active`, `needs_attention`, `revoked`, or `failed`), and last sync, oldest first. Tokens, scopes, and error details are never returned.

```bash
curl -sS -H "Authorization: Bearer $STACKDASH_API_KEY" "$STACKDASH_URL/api/v1/connections"
```

### Usage and spend

`GET /api/v1/usage-snapshots` needs `usage:read`. It returns one row per provider account, metric, and UTC day, newest day first; the latest day of a metric is its current value. Filters: `from` and `to` (UTC days, inclusive), `metric_key`, `kind` (`verified_spend`, `estimated_spend`, `included_allowance`, `remaining_allowance`, `usage`, `credit_balance`, `revenue`), `provider`, `connection_id`, and `project_id`.

```bash
curl -sS -H "Authorization: Bearer $STACKDASH_API_KEY" "$STACKDASH_URL/api/v1/usage-snapshots?metric_key=fake.spend&limit=10"
curl -sS -H "Authorization: Bearer $STACKDASH_API_KEY" "$STACKDASH_URL/api/v1/usage-snapshots?kind=usage&project_id=30000000-0000-4000-8000-000000000001"
```

### Events

`GET /api/v1/events` needs `events:read`. It returns the timeline, newest first. Filters: `from` (inclusive) and `to` (exclusive) as RFC 3339 times with an offset, `type` (one event type id), `severity` (`info`, `success`, `warning`, `critical`), and `provider`.

```bash
curl -sS -H "Authorization: Bearer $STACKDASH_API_KEY" "$STACKDASH_URL/api/v1/events?limit=2"
curl -sS -H "Authorization: Bearer $STACKDASH_API_KEY" "$STACKDASH_URL/api/v1/events?severity=critical&type=fake.deployment_failed"
```

To read every page, follow `next_cursor` until it is null:

```bash
cursor=""
while :; do
  page=$(curl -sS -G -H "Authorization: Bearer $STACKDASH_API_KEY" "$STACKDASH_URL/api/v1/events" \
    --data-urlencode "limit=100" ${cursor:+--data-urlencode "cursor=$cursor"})
  echo "$page" | jq -c '.data[]'
  cursor=$(echo "$page" | jq -r '.next_cursor // empty')
  [ -z "$cursor" ] && break
done
```

### Triggered alerts

`GET /api/v1/triggered-alerts` needs `alerts:read`. It returns alerts that fired, newest first, with the severity the alerts page shows. `acknowledged=false` returns only the ones nobody has acknowledged yet, and `acknowledged=true` only the acknowledged ones.

```bash
curl -sS -H "Authorization: Bearer $STACKDASH_API_KEY" "$STACKDASH_URL/api/v1/triggered-alerts?acknowledged=false"
```

## Errors

Every error has the same shape, and `code` is what to branch on:

```json
{ "error": { "code": "unauthorized", "message": "The API key is missing or no longer works. Send a working key as a bearer token.", "reference_id": "REF-7K2M9QXA" } }
```

| Status | `code` | When |
|---|---|---|
| 400 | `invalid_request` | A query parameter is unknown, repeated, or not valid, or the cursor was changed |
| 401 | `unauthorized` | The key is missing, malformed, unknown, revoked, or its creator left the workspace. The answer is the same in every case, so it never reveals whether a key exists |
| 403 | `forbidden` | The key works but does not have the scope this endpoint needs |
| 429 | `rate_limited` | The key made more than 120 requests this minute |
| 500 | `internal` | Something failed on the server |

Messages never contain internal details. Quote the `reference_id` when you ask for help: the server logs the details against it.

## Rate limit

Each key may make 120 requests per minute, counted in fixed one minute windows across every server. Every answer to a working key carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (Unix seconds). Past the limit the answer is `429` with `Retry-After` in seconds. Limits per plan are planned.

## Try it against the local seed data

The seed (`supabase/seed.sql`) loads the workspace Acme (`acmeseedws`) with one project, one connection, three days of snapshots, and four events. Its users have no password, so add your own account to Acme as an admin, then create a key in its settings:

1. Sign in locally once (README, step 7), so your account exists.
2. Add yourself to Acme, with your sign-in email:

   ```bash
   psql "postgresql://postgres:postgres@127.0.0.1:55422/postgres" -c "insert into public.workspace_members (workspace_id, user_id, role) select '20000000-0000-4000-8000-000000000001', id, 'admin' from auth.users where email = 'you@example.com'"
   ```

   Without `psql` on your computer, run the same `insert` statement in the SQL editor of the local Supabase Studio at <http://127.0.0.1:55423>.

3. Open <http://localhost:3000/w/acmeseedws/settings#create-api-key>, create a key with every scope, and read it into `STACKDASH_API_KEY` as shown above, with `STACKDASH_URL=http://localhost:3000`.

Every example on this page then answers with seed data: the workspace Acme, the project Acme web, the connection Fake provider, `fake.spend` in `USD` cents, and the failed deployment event. Once jobs have run on your instance, the events also include StackDash's daily summaries. The seed has no triggered alerts, so that list is empty until an alert fires.

## Security

- StackDash stores a SHA-256 hash of each key and an 8 character prefix to tell keys apart. The key itself exists only in the browser that created it, once.
- Every read resolves the workspace from the key inside the database, so a key can never read another workspace, whatever the request asks for.
- Keys appear as `[redacted]` in StackDash's logs.
- The API answers only bearer requests: it reads no cookies and sends no CORS headers, so it is meant for scripts and servers, not for other sites' pages.
