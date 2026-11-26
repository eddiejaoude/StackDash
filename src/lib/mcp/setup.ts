/*
 * How to connect each MCP client to this instance (#163), for the settings page. docs/mcp.md walks
 * through the same steps with the URL as $STACKDASH_URL. Claude Code and Cursor never get the key in
 * their snippet: they read it from STACKDASH_API_KEY each time they connect. Claude Desktop and other
 * clients keep the key in their own configuration anyway, so their snippets carry a placeholder, or
 * the key itself right after "Create assistant key" made one (#254), shown once like the key.
 *
 * Sources, checked 2026-11-05:
 * - Claude Code: https://code.claude.com/docs/en/mcp, "Option 1: Add a remote HTTP server",
 *   "Environment variable expansion in .mcp.json", and "How references appear in /mcp and CLI
 *   output": a ${VAR} reference in a remote server's headers is stored as written, in the local,
 *   project, and user scope alike, and expanded when Claude Code connects. The single quotes keep
 *   the shell from expanding it first, which would store the key itself in ~/.claude.json.
 * - Claude Desktop: Settings, Developer, Edit Config, then a restart, per
 *   https://modelcontextprotocol.io/docs/develop/connect-local-servers. The remote server is reached
 *   through mcp-remote (README, "Custom Headers", https://www.npmjs.com/package/mcp-remote), with
 *   the header in an env variable because Claude Desktop on Windows does not escape spaces in args.
 *   Custom connectors with request headers are the alternative for an instance on the public
 *   internet (https://claude.com/docs/connectors/custom/add-unlisted); docs/mcp.md covers them.
 * - Cursor: https://cursor.com/docs/mcp, "Config interpolation".
 */

/** The MCP endpoint's path on every StackDash instance. */
export const MCP_ENDPOINT_PATH = "/api/mcp";

/**
 * The name of every key the AI assistants section creates (#254), so the API keys list says what
 * each one is for, and the Timeline's setup checklist can tell an assistant is connected (#674).
 */
export const ASSISTANT_KEY_NAME = "AI assistant";

export type McpClientSetup = Readonly<{
  id: "claude-code" | "claude-desktop" | "cursor" | "other";
  name: string;
  /** What to do with the snippet, in one or two sentences. */
  instructions: string;
  snippet: string;
}>;

const KEY_VARIABLE = "STACKDASH_API_KEY";

export function mcpEndpointUrl(origin: string): string {
  return new URL(MCP_ENDPOINT_PATH, origin).href;
}

/** `apiKey` is the key settings just created, or null for the placeholder. */
export function mcpClientSetups(endpointUrl: string, apiKey: string | null): readonly McpClientSetup[] {
  const claudeDesktop = {
    mcpServers: {
      stackdash: {
        command: "npx",
        args: ["-y", "mcp-remote", endpointUrl, "--header", "Authorization:${AUTH_HEADER}"],
        env: { AUTH_HEADER: `Bearer ${apiKey ?? "paste-your-key-here"}` },
      },
    },
  };
  const cursor = {
    mcpServers: {
      stackdash: { url: endpointUrl, headers: { Authorization: `Bearer \${env:${KEY_VARIABLE}}` } },
    },
  };
  return [
    {
      id: "claude-code",
      name: "Claude Code",
      instructions: `Put the key in ${KEY_VARIABLE} in the environment Claude Code starts from, then run this once. Claude Code saves the variable's name, not the key. Check it with claude mcp list.`,
      snippet: `claude mcp add --transport http stackdash ${endpointUrl} \\\n  --header 'Authorization: Bearer \${${KEY_VARIABLE}}'`,
    },
    {
      id: "claude-desktop",
      name: "Claude Desktop",
      instructions: `Open Settings, then Developer, then Edit Config, and add this to claude_desktop_config.json${
        apiKey === null ? " with your key after Bearer" : ". It holds the new key, so keep that file to yourself"
      }. Restart Claude Desktop. It needs Node.js for npx.`,
      snippet: JSON.stringify(claudeDesktop, null, 2),
    },
    {
      id: "cursor",
      name: "Cursor",
      instructions: `Add this to ~/.cursor/mcp.json, or .cursor/mcp.json in a project. Cursor reads the key from ${KEY_VARIABLE} in the environment it starts from.`,
      snippet: JSON.stringify(cursor, null, 2),
    },
    {
      id: "other",
      name: "Other clients",
      instructions:
        "Any client that speaks the Streamable HTTP transport works. Give it the URL and send the key as a bearer token on every request.",
      snippet: [
        `URL:        ${endpointUrl}`,
        "Transport:  Streamable HTTP",
        `Header:     Authorization: Bearer ${apiKey ?? "<your key>"}`,
      ].join("\n"),
    },
  ];
}
