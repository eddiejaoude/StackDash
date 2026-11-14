# MCP server

The MCP server lets an AI assistant such as Claude Code, Claude Desktop, or Cursor answer questions about one workspace from its own data: what changed in the stack this week, how much of an allowance is left, which alerts fired. It only reads. No tool can change anything in a workspace, and no answer contains a provider credential.

It speaks the [Model Context Protocol](https://modelcontextprotocol.io/specification/2026-07-28) over the Streamable HTTP transport at `/api/mcp` on your StackDash site, and serves clients of the 2025 protocol revisions as well as 2026-07-28. Self-hosted installs serve the same endpoint; nothing about it depends on the hosted instance.

## Create a key

The server uses the same API keys as the [REST API](api.md). Give a key for an assistant every scope, so it can answer any question about the workspace. A key without `usage:read` never sees an amount: `get_usage` refuses it, and `list_events` and `list_alerts` withhold the text and money that can quote one (see [What a tool returns](#what-a-tool-returns)).

The quickest way is **Settings**, under **AI assistants**: an owner or admin selects **Create assistant key**, and StackDash creates a key named `AI assistant` with every scope. It is an ordinary API key: it counts toward the workspace's 20 keys that are not revoked, it is listed under **API keys**, and it is revoked there. A workspace that already has 20 gets the same message as the API keys section, saying to revoke one first; a viewer sees no button and is told to ask an owner or admin.

The new key is shown once, with a button to copy it, and the snippets below it fill in this site's server URL. The Claude Desktop and other clients snippets also hold the new key, because those clients keep it in their own configuration anyway. The Claude Code and Cursor snippets never do: put the key in `STACKDASH_API_KEY` as described below. Once you select **Hide key**, or leave the page, the key cannot be shown again; revoke it and create another if you lose it.

To choose the scopes yourself, create the key under **API keys** instead; see [Create a key](api.md#create-a-key) for the details.

## Connect a client

Claude Code and Cursor read the key from the environment each time they connect, so their configuration holds only the variable's name. Claude Desktop keeps the key in its own config file, so do not share that file. Put the key in `STACKDASH_API_KEY` in your shell profile, and set `STACKDASH_URL` to your StackDash site, for example `https://your-stackdash-site.example.com` or `http://localhost:3000` for a local install.

### Claude Code

```bash
claude mcp add --transport http stackdash "$STACKDASH_URL/api/mcp" \
  --header 'Authorization: Bearer ${STACKDASH_API_KEY}'
claude mcp list
```

The single quotes keep your shell from expanding `${STACKDASH_API_KEY}`, so Claude Code saves the reference, not the key, and reads the variable each time it connects; `claude mcp list` and `/mcp` show the reference by name ([Claude Code, MCP](https://code.claude.com/docs/en/mcp), "Environment variable expansion in .mcp.json"). `claude mcp list` shows `stackdash` as connected. Add `--scope project` to share the server through the project's `.mcp.json`; each person's key stays in their own environment.

### Claude Desktop

Open **Settings**, then **Developer**, then **Edit Config**, and add the server to `claude_desktop_config.json`, with your site's URL and your key after `Bearer`:

```json
{
  "mcpServers": {
    "stackdash": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://your-stackdash-site.example.com/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
      "env": { "AUTH_HEADER": "Bearer paste-your-key-here" }
    }
  }
}
```

Then quit and restart Claude Desktop. [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) connects Claude Desktop's local servers to a remote one and needs Node.js. The header goes through `AUTH_HEADER` because Claude Desktop on Windows does not escape spaces in `args` (mcp-remote README, "Custom Headers"). It accepts `http://localhost` for a local install.

The key sits in `claude_desktop_config.json` in plain text. To keep it in a separate file you can lock down, put the line `Authorization: Bearer <your key>` in a file only you can read, and pass `"--header-file", "/path/to/stackdash-headers.txt"` in `args` in place of the `--header` pair and the `env` entry (mcp-remote README, "Custom Headers").

For an instance on the public internet, a custom connector also works where your Claude plan offers request headers (a beta): **Customize**, **Connectors**, **Add custom connector**, the server URL, **No sign-in**, then an `authorization` request header with the value `Bearer` and your key ([Claude, custom connectors](https://claude.com/docs/connectors/custom/add-unlisted)). Claude connects to a custom connector from Anthropic's cloud, so it cannot reach a server on your own computer or private network.

### Cursor

Add the server to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "stackdash": {
      "url": "https://your-stackdash-site.example.com/api/mcp",
      "headers": { "Authorization": "Bearer ${env:STACKDASH_API_KEY}" }
    }
  }
}
```

Cursor reads `STACKDASH_API_KEY` from the environment it was started from ([Cursor, MCP, config interpolation](https://cursor.com/docs/mcp)).

### Other clients

Any client that speaks Streamable HTTP works: give it the URL `$STACKDASH_URL/api/mcp` and send `Authorization: Bearer <key>` on every request. The endpoint keeps no sessions, so every message is a POST; `GET` and `DELETE` answer `405`.

## Tools

| Tool | Scope | What it returns | Arguments |
|---|---|---|---|
| `list_projects` | any working key | The key's workspace and its projects, oldest first | `limit`, `cursor` |
| `get_usage` | `usage:read` | Daily usage, spend, allowance, credit balance, and revenue snapshots, newest day first. The latest day of a metric is its current value | `provider`, `project_id`, `from` and `to` (UTC days, inclusive), `metric_key`, `kind`, `limit`, `cursor` |
| `list_events` | `events:read` | The timeline, newest first: deployments, payments, sync failures, alerts, daily summaries | `from` (inclusive) and `to` (exclusive) as RFC 3339 times, `type`, `severity`, `provider`, `limit`, `cursor` |
| `list_alerts` | `alerts:read` | Alerts that fired, newest first, with the severity the alerts page shows | `acknowledged` (`true` or `false`), `limit`, `cursor` |
| `get_connection_status` | `connections:read` | Each connection's status and last sync, oldest first. Never credentials | `limit`, `cursor` |

The arguments are the REST API's query parameters, with the same limits: `limit` is 1 to 100 (default 50), an unknown argument is refused, and `cursor` is the `next_cursor` of the previous page, passed back with the same filters.

## Resources

Each provider page in [`docs/providers/`](providers) is a Markdown resource at `stackdash://docs/providers/<provider>`, for example `stackdash://docs/providers/resend`. An assistant reads them to explain what a metric means, how StackDash reads it, and whether it is verified or estimated.

## Prompts

Prompts are questions ready to ask: a client lists them, for example as slash commands, and running one hands the assistant a message that says which tools to call, with their exact arguments, and how to answer from the results. A prompt reads nothing itself, so every number in the answer still comes through a tool and its scope.

| Prompt | Title | What it asks | Arguments |
|---|---|---|---|
| `weekly_stack_review` | Weekly stack review | Review the 7 UTC days ending today: connections that need attention, spend on the newest day beside the starting reading, allowances running low, failed deployments, sync failures, and unusual spend and usage events, and unacknowledged alerts. Calls all five tools | none |
| `why_did_spend_change` | Why did spend change | Explain how spend moved over the period: reads verified spend, estimated spend, and usage with `get_usage`, then events and alerts, and ties each increase to the usage and events behind it | `days` (1 to 90, default 7), `provider` (a provider id, default all) |

The period is the `days` UTC days ending today on the server's clock (7 for the weekly review), and the prompts also read the day before them as the starting reading, because a day's spend is its reading minus the previous day's. So the tool calls cover `days + 1` dates: for 7 days ending 2026-11-05, `from` is 2026-10-29. Arguments arrive as text, as MCP requires: `days` is a whole number from 1 to 90, and an unknown provider, an unknown argument, or a `days` outside that range is refused with an invalid params error (`-32602`) before anything is read.

In Claude Code, type `/` to find them as `/stackdash:weekly_stack_review (MCP)`, or run `/mcp__stackdash__why_did_spend_change 30 vercel`; arguments go in the order of the table, separated by spaces ([Claude Code, MCP](https://code.claude.com/docs/en/mcp), "Use MCP prompts as commands"). A key without `usage:read` still gets both prompts; the spend steps then answer with the scope error, and the prompt tells the assistant to say which scope would show them rather than guess.

## What a tool returns

Every tool answers with JSON, both as `structuredContent` (with an `outputSchema` in the tool list) and as text for clients that read only text:

- `read_at`: when StackDash read the answer from its database.
- `data` and `next_cursor`: one page of rows, as in the REST API, with the same fields and units. Money is `amount_minor` in the currency's minor unit plus an ISO 4217 `currency`; quantities are `value` plus `unit`; `provenance` is `verified` or `estimated`; `simulated` marks data the provider simulator made up.
- `get_usage` rows keep `retrieved_at`, when StackDash fetched the number from the provider, and add `display`, the amount or quantity formatted for people (`$12.50`, `1,200 emails`), so an assistant never reads cents as dollars.
- `list_alerts` rows add `display` for the amount a spend alert measured.
- `withheld`: on `list_events` and `list_alerts`, null for a key with `usage:read`. For a key without it, it lists the fields set to null in every row, names `usage:read` as the scope that would return them, and says why. Event titles and bodies are withheld because providers and StackDash's own daily summaries and spend alerts quote amounts there; an alert's `message`, `threshold_label`, `observed_amount_minor`, `currency`, and `display` because a spend or budget alert quotes money.

## Errors and limits

- A key that is missing or does not work gets HTTP `401` with the REST API's error envelope and a reference id, before any MCP message is read. Past the rate limit it gets `429` with `Retry-After`.
- The rate limit is the REST API's: 120 requests per key per minute. Every MCP message is one request, so the messages a client sends to connect count as well as each tool call. A JSON-RPC batch (an array of messages in one request) is refused with `400` and the API's error envelope, so one request never runs more than one tool call.
- A tool the key's scopes do not allow, a malformed argument, or a changed cursor answers with a tool error the assistant can read (`isError: true`), saying what to do next. A failure on the server answers with a generic message and a reference id; the details are in the server log against that id.
- A request from a web page on another site (an `Origin` header that is not this site) gets `403`, as the Streamable HTTP transport requires. A request body over 64 KiB gets `413`; no tool takes anything near that size.

## Try it against the demo data

On a local install with the simulated providers on (`STACKDASH_SIMULATE_PROVIDERS=1`), `npm run demo:seed -- --member you@example.com` builds a demo workspace with 90 days of history and adds your account as an admin (see the header of `scripts/demo-seed.ts`). In that workspace's settings, under **AI assistants**, select **Create assistant key**, connect Claude Code as above with `STACKDASH_URL=http://localhost:3000`, and run `/mcp__stackdash__weekly_stack_review`, or ask, for example, "Which projects are in my StackDash workspace, and how much Resend quota is left?"

`npm run demo:seed` replaces the demo workspace each time it runs. To try the server without it, use the seed workspace Acme instead: add yourself to it as in [Try it against the local seed data](api.md#try-it-against-the-local-seed-data), then create the assistant key in its settings. Its answers are smaller: one project, one connection, and a few days of snapshots.

## Security

- The server reads through the same database functions as the REST API, with the hash of the presented key. The database resolves the workspace from that hash, so a key never reads another workspace, whatever a tool is asked.
- The key itself is never stored, logged, or passed on: the server works with its SHA-256 hash.
- Responses are `Cache-Control: no-store, no-transform`, so no cache keeps an answer and no proxy buffers or compresses a streamed one.
