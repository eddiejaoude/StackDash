import AxeBuilder from "@axe-core/playwright";
import { Client, StreamableHTTPClientTransport, type CallToolResult } from "@modelcontextprotocol/client";
import type { APIRequestContext, Page } from "@playwright/test";

import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import {
  activeApiKeyCount,
  adminClient,
  createTestWorkspace,
  deleteTestWorkspace,
  seedApiKeys,
  seededKey,
  type TestWorkspace,
} from "./fixtures/db";

// The REST API with scoped keys (#162), and the MCP server on the same keys (#163). Each test creates
// its own workspace and seeds only inside it.

const KEY_PATTERN = /^sd_[A-Za-z0-9_-]{43}$/;
const REFERENCE_PATTERN = /^REF-[0-9A-Z]{8}$/;
// The order the create form lists them in (the database enum's order).
const SCOPES = ["usage:read", "events:read", "alerts:read", "connections:read"] as const;
type Scope = (typeof SCOPES)[number];

type Seeded = { projectId: string; connectionId: string };

/** A project, a fake connection with one account in that project, one spend snapshot, one event. */
async function seedWorkspaceData(workspace: TestWorkspace): Promise<Seeded> {
  const admin = adminClient();
  const { data: project, error: projectError } = await admin
    .from("projects")
    .insert({ workspace_id: workspace.id, name: "API web" })
    .select("id")
    .single();
  if (projectError) throw new Error(`Seeding a project failed (code ${projectError.code}).`);
  const { data: connection, error: connectionError } = await admin
    .from("connections")
    .insert({
      workspace_id: workspace.id,
      provider: "fake",
      status: "active",
      display_name: "API fake",
      poll_interval_seconds: 3600,
      // Never due, so a sync elsewhere in the run leaves this workspace alone.
      next_sync_at: "2999-01-01T00:00:00Z",
    })
    .select("id")
    .single();
  if (connectionError) throw new Error(`Seeding a connection failed (code ${connectionError.code}).`);
  const { data: account, error: accountError } = await admin
    .from("external_accounts")
    .insert({
      workspace_id: workspace.id,
      connection_id: connection.id,
      external_id: "api-e2e-team",
      display_name: "API team",
      kind: "team",
      project_id: project.id,
    })
    .select("id")
    .single();
  if (accountError) throw new Error(`Seeding an account failed (code ${accountError.code}).`);
  const { error: snapshotError } = await admin.from("usage_snapshots").insert({
    workspace_id: workspace.id,
    connection_id: connection.id,
    external_account_id: account.id,
    metric_key: "fake.spend",
    kind: "verified_spend",
    label: "Spend this month",
    snapshot_date: "2026-10-31",
    amount_minor: 1250,
    currency: "USD",
    period_start: "2026-10-01T00:00:00Z",
    period_end: "2026-11-01T00:00:00Z",
    retrieved_at: "2026-10-31T09:00:00Z",
    provenance_source: "provider_api",
  });
  if (snapshotError) throw new Error(`Seeding a snapshot failed (code ${snapshotError.code}).`);
  const { error: eventError } = await admin.from("activity_events").insert({
    workspace_id: workspace.id,
    connection_id: connection.id,
    external_account_id: account.id,
    provider: "fake",
    type_id: "fake.deployment_failed",
    severity: "critical",
    title: "Deployment failed",
    occurred_at: "2026-10-31T08:00:00Z",
    dedupe_key: "api-e2e:deployment:1",
  });
  if (eventError) throw new Error(`Seeding an event failed (code ${eventError.code}).`);
  return { projectId: project.id, connectionId: connection.id };
}

function keysSection(page: Page) {
  return page.getByRole("region", { name: "API keys" });
}

/**
 * Creates a key with the keyboard only: type the name, Tab through the scope checkboxes pressing
 * Space on the wanted ones, Tab to "Create key", Enter. Returns the key the page shows once.
 */
async function createKeyWithKeyboard(page: Page, name: string, scopes: readonly Scope[]): Promise<string> {
  const section = keysSection(page);
  await section.getByLabel("Key name").focus();
  await page.keyboard.type(name);
  for (const scope of SCOPES) {
    await page.keyboard.press("Tab");
    await expect(section.getByRole("checkbox", { name: new RegExp(scope) })).toBeFocused();
    if (scopes.includes(scope)) await page.keyboard.press("Space");
  }
  await page.keyboard.press("Tab");
  await expect(section.getByRole("button", { name: "Create key" })).toBeFocused();
  await page.keyboard.press("Enter");

  // Focus moves to the one-time key so it is the next thing read.
  await expect(section.getByRole("heading", { name: `Copy the key for ${name} now` })).toBeFocused();
  await expect(page.getByRole("status").filter({ hasText: `Created the key ${name}.` })).toBeVisible();
  const key = await section.getByLabel("API key", { exact: true }).inputValue();
  expect(key).toMatch(KEY_PATTERN);
  return key;
}

async function getJson(request: APIRequestContext, path: string, key: string | null) {
  const response = await request.get(path, key === null ? {} : { headers: { authorization: `Bearer ${key}` } });
  return { status: response.status(), headers: response.headers(), body: (await response.json()) as unknown };
}

ownerTest.describe("API keys as the owner", () => {
  ownerTest("creates a key, reads the workspace through every endpoint, then revokes it", async ({ page, request }) => {
    const workspace = await createTestWorkspace("API keys");
    try {
      const seeded = await seedWorkspaceData(workspace);
      await page.goto(`/w/${workspace.slug}/settings`);
      const section = keysSection(page);
      await expect(section.getByText("No API keys yet.")).toBeVisible();

      const key = await createKeyWithKeyboard(page, "Reporting script", SCOPES);
      // The button fades back from its pending style; scan once it has, or axe measures mid-fade.
      await expect(section.getByRole("button", { name: "Create key" })).toHaveCSS("opacity", "1");
      await expectNoAxeViolations(page);

      const row = section.getByRole("listitem").filter({ hasText: "Reporting script" });
      await expect(row).toContainText("Active");
      await expect(row).toContainText(key.slice(0, "sd_".length + 8));
      await expect(row).toContainText("Never used.");

      // Every endpoint answers with the seeded workspace's data.
      const workspaces = await getJson(request, "/api/v1/workspaces", key);
      expect(workspaces.status).toBe(200);
      expect(workspaces.headers["cache-control"]).toBe("no-store");
      expect(workspaces.headers["x-ratelimit-limit"]).toBe("120");
      expect(workspaces.body).toEqual({
        data: [expect.objectContaining({ id: workspace.id, slug: workspace.slug, name: workspace.name })],
        next_cursor: null,
      });
      expect((await getJson(request, "/api/v1/projects", key)).body).toMatchObject({
        data: [{ id: seeded.projectId, name: "API web" }],
      });
      expect((await getJson(request, "/api/v1/connections", key)).body).toMatchObject({
        data: [{ id: seeded.connectionId, provider: "fake", name: "API fake", status: "active", simulated: false }],
      });
      expect(
        (await getJson(request, `/api/v1/usage-snapshots?metric_key=fake.spend&project_id=${seeded.projectId}`, key)).body,
      ).toMatchObject({
        data: [{ metric_key: "fake.spend", amount_minor: 1250, currency: "USD", provenance: "verified", date: "2026-10-31" }],
        next_cursor: null,
      });
      expect((await getJson(request, "/api/v1/events?severity=critical", key)).body).toMatchObject({
        data: [{ type: "fake.deployment_failed", title: "Deployment failed", account_name: "API team" }],
      });
      expect((await getJson(request, "/api/v1/triggered-alerts", key)).body).toEqual({ data: [], next_cursor: null });

      // The settings list records the use; the key itself is never shown again.
      await page.reload();
      await expect(section.getByRole("listitem").filter({ hasText: "Reporting script" })).toContainText("Last used");
      await expect(page.getByText(key)).toHaveCount(0);

      // Revoke through the confirmation dialog, then the same key gets 401 with a reference id.
      await section.getByRole("button", { name: "Revoke Reporting script" }).click();
      const dialog = page.getByRole("dialog", { name: "Revoke Reporting script?" });
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await dialog.getByRole("button", { name: "Revoke key" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Revoked the key Reporting script." })).toBeVisible();
      await expect(section.getByRole("listitem").filter({ hasText: "Reporting script" })).toContainText("Revoked");

      const revoked = await getJson(request, "/api/v1/workspaces", key);
      expect(revoked.status).toBe(401);
      expect(revoked.body).toEqual({
        error: {
          code: "unauthorized",
          message: "The API key is missing or no longer works. Send a working key as a bearer token.",
          reference_id: expect.stringMatching(REFERENCE_PATTERN),
        },
      });
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("a key reads only what its scopes allow", async ({ page, request }) => {
    const workspace = await createTestWorkspace("API scopes");
    try {
      await seedWorkspaceData(workspace);
      await page.goto(`/w/${workspace.slug}/settings`);
      const key = await createKeyWithKeyboard(page, "Usage only", ["usage:read"]);

      expect((await getJson(request, "/api/v1/usage-snapshots", key)).status).toBe(200);
      expect((await getJson(request, "/api/v1/projects", key)).status).toBe(200);
      const events = await getJson(request, "/api/v1/events", key);
      expect(events.status).toBe(403);
      expect(events.body).toMatchObject({ error: { code: "forbidden", reference_id: expect.stringMatching(REFERENCE_PATTERN) } });
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("explains a missing name and scope without creating a key", async ({ page }) => {
    const workspace = await createTestWorkspace("API key errors");
    try {
      await page.goto(`/w/${workspace.slug}/settings`);
      const section = keysSection(page);
      await section.getByRole("button", { name: "Create key" }).click();
      await expect(section.getByText("Enter a name for the key, such as the script or tool that will use it.").first()).toBeVisible();
      await expect(section.getByText("Choose at least one thing the key may read.")).toBeVisible();
      await expect(section.getByLabel("Key name")).toHaveAttribute("aria-invalid", "true");
      await expect(section.getByText("No API keys yet.")).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("marks a key whose creator left as not working, and the API refuses it", async ({ page, request }) => {
    const workspace = await createTestWorkspace("API key creator left");
    const admin = adminClient();
    try {
      // The viewer becomes an admin, creates a key, then leaves the workspace.
      const { error: promoteError } = await admin
        .from("workspace_members")
        .update({ role: "admin" })
        .eq("workspace_id", workspace.id)
        .eq("user_id", workspace.viewerId);
      if (promoteError) throw new Error(`Promoting the viewer failed (code ${promoteError.code}).`);
      const { key, token_hash, token_prefix } = seededKey();
      const { error: keyError } = await admin.from("api_keys").insert({
        workspace_id: workspace.id,
        name: "Departed admin script",
        token_hash,
        token_prefix,
        scopes: ["usage:read"],
        created_by: workspace.viewerId,
      });
      if (keyError) throw new Error(`Seeding a key failed (code ${keyError.code}).`);
      expect((await getJson(request, "/api/v1/workspaces", key)).status).toBe(200);

      await page.goto(`/w/${workspace.slug}/settings`);
      const section = keysSection(page);
      const row = section.getByRole("listitem").filter({ hasText: "Departed admin script" });
      await expect(row).toContainText("Active");

      const { error: leaveError } = await admin
        .from("workspace_members")
        .delete()
        .eq("workspace_id", workspace.id)
        .eq("user_id", workspace.viewerId);
      if (leaveError) throw new Error(`Removing the admin failed (code ${leaveError.code}).`);

      const refused = await getJson(request, "/api/v1/workspaces", key);
      expect(refused.status).toBe(401);
      expect(refused.body).toMatchObject({
        error: { code: "unauthorized", reference_id: expect.stringMatching(REFERENCE_PATTERN) },
      });

      // Settings is where the owner learns why: the API's 401 deliberately does not say.
      await page.reload();
      await expect(row).toContainText("Not working");
      await expect(row).not.toContainText("Active");
      await expect(row).toContainText(
        "Its creator left the workspace, so requests with it fail. Revoke it and create a new key.",
      );
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      // Revoke stays available, with the keyboard only.
      await row.getByRole("button", { name: "Revoke Departed admin script" }).focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog", { name: "Revoke Departed admin script?" });
      await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(dialog.getByRole("button", { name: "Revoke key" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.getByRole("status").filter({ hasText: "Revoked the key Departed admin script." })).toBeVisible();
      await expect(row).toContainText("Revoked");
      await expect(row).not.toContainText("Not working");
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("refuses a key past the limit of 20 that are not revoked, and says how to make room", async ({ page }) => {
    const workspace = await createTestWorkspace("API key limit");
    try {
      await seedApiKeys(workspace, 20);

      await page.goto(`/w/${workspace.slug}/settings`);
      const section = keysSection(page);
      await section.getByLabel("Key name").fill("One too many");
      await section.getByRole("checkbox", { name: /usage:read/ }).check();
      await section.getByRole("button", { name: "Create key" }).click();

      // The error summary takes focus so keyboard and screen reader users land on it.
      await expect(page.locator(":focus")).toContainText(
        "This workspace already has 20 keys that are not revoked. Revoke one you no longer use, then create the new one.",
      );
      // A rejected submit keeps what was typed and ticked.
      await expect(section.getByLabel("Key name")).toHaveValue("One too many");
      await expect(section.getByRole("checkbox", { name: /usage:read/ })).toBeChecked();
      await expect(section.getByRole("listitem").filter({ hasText: "One too many" })).toHaveCount(0);
      expect(await activeApiKeyCount(workspace)).toBe(20);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("a signed-in session is not an API key", async ({ page }) => {
    const response = await page.request.get("/api/v1/workspaces");
    expect(response.status()).toBe(401);
    expect(response.headers()["www-authenticate"]).toMatch(/^Bearer/);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });
});

viewerTest.describe("API keys as a viewer", () => {
  viewerTest("sees why the section is locked and no keys", async ({ page }) => {
    const workspace = await createTestWorkspace("API keys viewer");
    try {
      await page.goto(`/w/${workspace.slug}/settings`);
      const section = keysSection(page);
      await expect(section).toContainText("Only owners and admins can create, see, or revoke API keys.");
      await expect(section.getByLabel("Key name")).toHaveCount(0);
      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

ownerTest.describe("API docs", () => {
  ownerTest("publishes the guide at /docs/api and the OpenAPI document beside it", async ({ page, request }) => {
    await page.goto("/docs/api");
    await expect(page.getByRole("heading", { level: 1, name: "REST API" })).toBeVisible();
    const scan = await new AxeBuilder({ page }).analyze();
    expect(scan.violations).toEqual([]);

    const response = await request.get("/docs/api/openapi.json");
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      openapi: "3.1.0",
      paths: { "/api/v1/events": { get: { security: [{ apiKey: ["events:read"] }] } } },
    });
  });
});

/** A key the service role inserts into the workspace, with these scopes. */
async function insertKey(workspace: TestWorkspace, name: string, scopes: readonly Scope[]): Promise<string> {
  const { key, token_hash, token_prefix } = seededKey();
  const { error } = await adminClient()
    .from("api_keys")
    .insert({ workspace_id: workspace.id, name, token_hash, token_prefix, scopes: [...scopes], created_by: workspace.ownerId });
  if (error) throw new Error(`Seeding a key failed (code ${error.code}).`);
  return key;
}

/** The MCP SDK's own client, connected over HTTP to the running app with this key. */
async function mcpClient(baseURL: string | undefined, key: string): Promise<Client> {
  const client = new Client({ name: "stackdash-e2e", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("/api/mcp", baseURL), { authProvider: { token: async () => key } }),
  );
  return client;
}

function toolText(result: CallToolResult): string {
  const [first] = result.content;
  return first?.type === "text" ? first.text : "";
}

ownerTest.describe("MCP server", () => {
  ownerTest("an assistant lists projects and answers a usage question with the workspace's data", async ({ baseURL }) => {
    const workspace = await createTestWorkspace("MCP");
    try {
      const seeded = await seedWorkspaceData(workspace);
      const client = await mcpClient(baseURL, await insertKey(workspace, "Assistant", SCOPES));
      try {
        const { tools } = await client.listTools();
        expect(tools.map((tool) => tool.name).sort()).toEqual([
          "get_connection_status",
          "get_usage",
          "list_alerts",
          "list_events",
          "list_projects",
        ]);

        const projects = await client.callTool({ name: "list_projects", arguments: {} });
        expect(projects.structuredContent).toMatchObject({
          workspace: { id: workspace.id, slug: workspace.slug },
          data: [{ id: seeded.projectId, name: "API web" }],
        });
        const usage = await client.callTool({
          name: "get_usage",
          arguments: { project_id: seeded.projectId, metric_key: "fake.spend" },
        });
        expect(usage.structuredContent).toMatchObject({
          data: [
            {
              amount_minor: 1250,
              currency: "USD",
              display: "$12.50",
              provenance: "verified",
              retrieved_at: expect.stringMatching(/^2026-10-31T09:00:00/),
            },
          ],
        });
        const connections = await client.callTool({ name: "get_connection_status", arguments: {} });
        expect(connections.structuredContent).toMatchObject({ data: [{ id: seeded.connectionId, status: "active" }] });

        const { contents } = await client.readResource({ uri: "stackdash://docs/providers/resend" });
        expect(contents[0]).toMatchObject({ mimeType: "text/markdown", text: expect.stringContaining("# Resend") });
      } finally {
        await client.close();
      }
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("a key without usage:read gets no spend and a tool error for usage", async ({ baseURL }) => {
    const workspace = await createTestWorkspace("MCP scopes");
    try {
      await seedWorkspaceData(workspace);
      const client = await mcpClient(baseURL, await insertKey(workspace, "Events only", ["events:read"]));
      try {
        const usage = await client.callTool({ name: "get_usage", arguments: {} });
        expect(usage.isError).toBe(true);
        expect(toolText(usage)).toContain("does not have the usage:read scope");

        const events = await client.callTool({ name: "list_events", arguments: {} });
        expect(events.structuredContent).toMatchObject({
          withheld: { fields: ["title", "body"], scope: "usage:read" },
          data: [{ type: "fake.deployment_failed", severity: "critical", title: null, body: null }],
        });
      } finally {
        await client.close();
      }
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("refuses a request without a working key, and answers only POST", async ({ request }) => {
    const response = await request.post("/api/mcp", {
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized", reference_id: expect.stringMatching(REFERENCE_PATTERN) },
    });
    expect((await request.get("/api/mcp")).status()).toBe(405);
  });

  ownerTest("settings shows this site's server URL and a snippet per client", async ({ page, baseURL }) => {
    const workspace = await createTestWorkspace("MCP setup");
    try {
      await page.goto(`/w/${workspace.slug}/settings`);
      const section = page.getByRole("region", { name: "AI assistants" });
      const endpoint = new URL("/api/mcp", baseURL).href;
      await expect(section.getByText(endpoint, { exact: true })).toBeVisible();
      const clients = ["Claude Code", "Claude Desktop", "Cursor", "Other clients"];
      for (const client of clients) {
        await expect(section.getByRole("heading", { level: 3, name: client })).toBeVisible();
      }
      await expect(section.getByText("Create a key for the assistant.", { exact: false })).toBeVisible();
      await expect(section.getByRole("region", { name: "Claude Code", exact: true })).toContainText(
        `claude mcp add --transport http stackdash ${endpoint}`,
      );

      // Keyboard: the guide link, the create button, then each snippet in turn, which takes focus so it can scroll.
      await section.getByRole("link", { name: "Read the MCP guide" }).focus();
      await page.keyboard.press("Tab");
      await expect(section.getByRole("button", { name: "Create assistant key" })).toBeFocused();
      for (const client of clients) {
        await page.keyboard.press("Tab");
        await expect(section.getByRole("region", { name: client, exact: true })).toBeFocused();
      }
      const scan = await new AxeBuilder({ page }).include("section[aria-labelledby='assistants-title']").analyze();
      expect(scan.violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("publishes the guide at /docs/mcp", async ({ page }) => {
    await page.goto("/docs/mcp");
    await expect(page.getByRole("heading", { level: 1, name: "MCP server" })).toBeVisible();
    const scan = await new AxeBuilder({ page }).analyze();
    expect(scan.violations).toEqual([]);
  });
});

viewerTest.describe("MCP setup as a viewer", () => {
  viewerTest("sees the snippets and is told to ask an owner or admin for a key", async ({ page }) => {
    const workspace = await createTestWorkspace("MCP setup viewer");
    try {
      await page.goto(`/w/${workspace.slug}/settings`);
      const section = page.getByRole("region", { name: "AI assistants" });
      await expect(section).toContainText("Ask an owner or admin of this workspace for an API key for the assistant.");
      await expect(section.getByRole("heading", { level: 3, name: "Cursor" })).toBeVisible();
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
