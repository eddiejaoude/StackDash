import { describe, expect, it } from "vitest";

import { generateApiKey } from "@/lib/api/keys";

import { mcpClientSetups, mcpEndpointUrl } from "./setup";

describe("mcpEndpointUrl", () => {
  it.each([
    ["https://stackdash.example.com", "https://stackdash.example.com/api/mcp"],
    ["https://stackdash.example.com/", "https://stackdash.example.com/api/mcp"],
    ["http://localhost:3000", "http://localhost:3000/api/mcp"],
  ])("puts the endpoint on the origin %s", (origin, expected) => {
    expect(mcpEndpointUrl(origin)).toBe(expected);
  });
});

describe("mcpClientSetups", () => {
  const endpoint = "https://stackdash.example.com/api/mcp";
  const setups = mcpClientSetups(endpoint, null);
  const byId = Object.fromEntries(setups.map((setup) => [setup.id, setup]));

  it("covers Claude Code, Claude Desktop, Cursor, and other clients, each with this instance's URL", () => {
    expect(setups.map((setup) => setup.id)).toEqual(["claude-code", "claude-desktop", "cursor", "other"]);
    for (const setup of setups) expect(setup.snippet).toContain(endpoint);
  });

  it("gives Claude Desktop a config file that parses, names the endpoint, and sends the key as a bearer header", () => {
    const config = JSON.parse(byId["claude-desktop"]?.snippet ?? "") as {
      mcpServers: { stackdash: { args: string[]; env: Record<string, string> } };
    };
    const { args, env } = config.mcpServers.stackdash;
    expect(args).toContain(endpoint);
    const header = args[args.indexOf("--header") + 1];
    expect(header).toMatch(/^Authorization:\$\{(\w+)\}$/);
    const variable = /\$\{(\w+)\}/.exec(header ?? "")?.[1] ?? "";
    expect(env[variable]).toMatch(/^Bearer /);
  });

  it("gives Cursor a config file that parses, names the endpoint, and reads the key from STACKDASH_API_KEY", () => {
    const config = JSON.parse(byId.cursor?.snippet ?? "") as {
      mcpServers: { stackdash: { url: string; headers: Record<string, string> } };
    };
    const { url, headers } = config.mcpServers.stackdash;
    expect(url).toBe(endpoint);
    expect(headers.Authorization).toMatch(/^Bearer \$\{env:STACKDASH_API_KEY\}$/);
  });

  it("passes the Claude Code header in single quotes, so the shell leaves the variable for Claude Code", () => {
    const snippet = byId["claude-code"]?.snippet ?? "";
    expect(snippet).toContain(endpoint);
    expect(/--header '([^']*)'/.exec(snippet)?.[1]).toMatch(/^Authorization: Bearer \$\{STACKDASH_API_KEY\}$/);
  });

  it("never leaves the key variable inside double quotes, where the shell would expand it", () => {
    expect(byId["claude-code"]?.snippet).not.toMatch(/"[^"]*\$\{?STACKDASH_API_KEY/);
  });

  it("never contains a key or a dash in the words people read", () => {
    for (const setup of setups) {
      expect(setup.snippet).not.toMatch(/sd_/);
      expect(`${setup.name} ${setup.instructions}`).not.toMatch(/[\u2013\u2014]/);
    }
  });
});

describe("mcpClientSetups with the key settings just created", () => {
  const endpoint = "https://stackdash.example.com/api/mcp";
  const { key } = generateApiKey();
  const byId = Object.fromEntries(mcpClientSetups(endpoint, key).map((setup) => [setup.id, setup]));

  it("fills the key into Claude Desktop's config, which still parses, and into the other clients' header", () => {
    const config = JSON.parse(byId["claude-desktop"]?.snippet ?? "") as {
      mcpServers: { stackdash: { env: Record<string, string> } };
    };
    expect(config.mcpServers.stackdash.env.AUTH_HEADER).toBe(`Bearer ${key}`);
    expect(byId["claude-desktop"]?.instructions).not.toContain("with your key after Bearer");
    expect(byId.other?.snippet).toContain(`Header:     Authorization: Bearer ${key}`);
    expect(byId.other?.snippet).not.toContain("<your key>");
  });

  it("keeps the key out of Claude Code and Cursor, which read it from STACKDASH_API_KEY", () => {
    for (const id of ["claude-code", "cursor"]) {
      expect(byId[id]?.snippet).not.toContain(key);
      expect(byId[id]?.snippet).toContain("STACKDASH_API_KEY");
    }
  });
});
