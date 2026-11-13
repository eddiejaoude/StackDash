import { describe, expect, it } from "vitest";

import { EMPTY_SCOPE, parseScopeFilters, UNASSIGNED_PROJECT } from "@/lib/filters/scope";
import { parseTimelineSearchParams } from "@/lib/timeline/query";
import type { WorkspaceRole } from "@/lib/workspaces/permissions";

import { buildPaletteCommands, type PaletteScope, type PaletteSources } from "./commands";
import { searchCommands, type PaletteCommand, type PaletteKind } from "./search";

const SLUG = "abc123";
const OTHER_SLUG = "def456";
const P1 = "10000000-0000-4000-8000-000000000001";
const A1 = "20000000-0000-4000-8000-000000000001";
const A2 = "20000000-0000-4000-8000-000000000002";
const C1 = "30000000-0000-4000-8000-000000000001";
const C2 = "30000000-0000-4000-8000-000000000002";
const C3 = "30000000-0000-4000-8000-000000000003";

// The demo's Stripe connection is named after its account, which the old labels repeated (#265).
const SCOPE: PaletteScope = {
  connections: [
    { id: C1, provider: "vercel", display_name: "Vercel team", status: "active" },
    { id: C2, provider: "stripe", display_name: "Stripe (Example Stripe account (test mode))", status: "active" },
  ],
  accounts: [
    { id: A1, connection_id: C1, display_name: "Production" },
    { id: A2, connection_id: C2, display_name: "Example Stripe account (test mode)" },
  ],
  projects: [{ id: P1, name: "Checkout & billing?" }],
};

const SOURCES: PaletteSources = {
  workspaceSlug: SLUG,
  role: "owner",
  scope: SCOPE,
  eventTypeIds: ["vercel.deployment.failed"],
  configuredProviders: [{ id: "resend", displayName: "Resend" }],
  workspaces: [
    { slug: SLUG, name: "Acme" },
    { slug: OTHER_SLUG, name: "Side project" },
  ],
  superAdmin: false,
  reviewYear: 2026,
};

const NO_SCOPE: PaletteScope = { connections: [], accounts: [], projects: [] };

function hrefOf(command: PaletteCommand | undefined): string {
  if (command?.action.kind !== "navigate") throw new Error("Expected a navigation command");
  return command.action.href;
}

function find(commands: readonly PaletteCommand[], kind: PaletteKind, label: string): PaletteCommand | undefined {
  return commands.find((command) => command.kind === kind && command.label === label);
}

/** The search params of an app-relative href, as a page's `searchParams` would hold them. */
function searchParamsOf(href: string): Record<string, string[]> {
  const params = new URL(href, "https://devmacro.example").searchParams;
  const result: Record<string, string[]> = {};
  for (const [key, value] of params) result[key] = [...(result[key] ?? []), value];
  return result;
}

describe("buildPaletteCommands", () => {
  const commands = buildPaletteCommands(SOURCES);

  it("goes to every workspace section in nav order, then alert settings, the year in review, and the account", () => {
    expect(commands.slice(0, 9).map((command) => [command.label, command.kind, hrefOf(command)])).toEqual([
      ["Timeline", "Page", `/w/${SLUG}/timeline`],
      ["Dashboard", "Page", `/w/${SLUG}/dashboard`],
      ["Connections", "Page", `/w/${SLUG}/connections`],
      ["Alerts", "Page", `/w/${SLUG}/alerts`],
      ["Projects", "Page", `/w/${SLUG}/projects`],
      ["Settings", "Page", `/w/${SLUG}/settings`],
      ["Alert settings", "Page", `/w/${SLUG}/alerts/settings`],
      ["Year in review", "Page", `/w/${SLUG}/year/2026`],
      ["Account", "Page", "/account"],
    ]);
  });

  it("goes to the admin page after the account for a super admin, and finds it as \"open admin\"", () => {
    const forAdmin = buildPaletteCommands({ ...SOURCES, superAdmin: true });
    expect(forAdmin.slice(8, 10).map((command) => [command.label, command.kind, hrefOf(command)])).toEqual([
      ["Account", "Page", "/account"],
      ["Admin", "Page", "/app/admin"],
    ]);
    expect(searchCommands(forAdmin, "open admin").results.map((command) => command.id)).toEqual(["page:admin"]);
    expect(searchCommands(forAdmin, "instance overview").results[0]?.id).toBe("page:admin");
  });

  it("leaves the admin page, and its path, out of anyone else's commands", () => {
    expect(commands.find((command) => command.id === "page:admin")).toBeUndefined();
    expect(JSON.stringify(commands)).not.toContain("/app/admin");
    expect(searchCommands(commands, "admin").total).toBe(0);
  });

  // Rules, budgets, channels, and digests moved off the alerts inbox (#343).
  it.each(["budgets", "rules", "channels", "digest", "webhook", "unusual"])("finds alert settings first for %j", (query) => {
    expect(searchCommands(commands, query).results[0]?.id).toBe("page:alert-settings");
  });

  it("finds the alerts inbox, not its settings, for triggered alerts", () => {
    const ids = searchCommands(commands, "triggered").results.map((command) => command.id);
    expect(ids[0]).toBe("page:alerts");
    expect(ids).not.toContain("page:alert-settings");
  });

  it("scopes the dashboard to one provider, project, unassigned, or account, labeled by name alone", () => {
    expect(hrefOf(find(commands, "Provider dashboard", "Vercel"))).toBe(`/w/${SLUG}/dashboard?provider=vercel`);
    expect(hrefOf(find(commands, "Project dashboard", "Checkout & billing?"))).toBe(`/w/${SLUG}/dashboard?project=${P1}`);
    expect(hrefOf(find(commands, "Project dashboard", "Unassigned"))).toBe(
      `/w/${SLUG}/dashboard?project=${UNASSIGNED_PROJECT}`,
    );
    expect(hrefOf(find(commands, "Account dashboard", "Production"))).toBe(`/w/${SLUG}/dashboard?account=${A1}`);
  });

  it("builds dashboard hrefs the dashboard parses back to exactly that scope", () => {
    const project = searchParamsOf(hrefOf(find(commands, "Project dashboard", "Checkout & billing?")));
    expect(parseScopeFilters(project)).toEqual({ ...EMPTY_SCOPE, projects: [P1] });
    const account = searchParamsOf(hrefOf(find(commands, "Account dashboard", "Production")));
    expect(parseScopeFilters(account)).toEqual({ ...EMPTY_SCOPE, accounts: [A1] });
  });

  it("opens the timeline for a provider or an event type, in the type filter's words", () => {
    expect(hrefOf(find(commands, "Provider timeline", "Vercel"))).toBe(`/w/${SLUG}/timeline?provider=vercel`);
    const byType = find(commands, "Event timeline", "Vercel: Deployment failed");
    expect(hrefOf(byType)).toBe(`/w/${SLUG}/timeline?type=vercel.deployment.failed`);
    expect(parseTimelineSearchParams(searchParamsOf(hrefOf(byType)))).toMatchObject({
      types: ["vercel.deployment.failed"],
      severities: [],
      cursor: null,
      scope: EMPTY_SCOPE,
    });
    expect(byType?.keywords).toContain("deployment failed");
  });

  it("names an event type by its adapter's declared label, and an undeclared one by its id (#294)", () => {
    const labels = buildPaletteCommands({ ...SOURCES, eventTypeIds: ["stripe.charge.succeeded", "vercel.deployment_ready"] })
      .filter((command) => command.kind === "Event timeline")
      .map((command) => [command.label, hrefOf(command)]);
    expect(labels).toEqual([
      ["Stripe: Payment succeeded", `/w/${SLUG}/timeline?type=stripe.charge.succeeded`],
      ["Vercel: Deployment ready", `/w/${SLUG}/timeline?type=vercel.deployment_ready`],
    ]);
    // The id's own words still find it.
    const found = searchCommands(buildPaletteCommands({ ...SOURCES, eventTypeIds: ["stripe.charge.succeeded"] }), "charge succeeded");
    expect(found.results.map((command) => command.label)).toEqual(["Stripe: Payment succeeded"]);
  });

  it("never repeats an account's name in its label, and still finds it by its provider and connection", () => {
    const stripe = find(commands, "Account dashboard", "Example Stripe account (test mode)");
    expect(hrefOf(stripe)).toBe(`/w/${SLUG}/dashboard?account=${A2}`);
    for (const command of commands) {
      expect(command.label.split("Example Stripe account").length, command.label).toBeLessThanOrEqual(2);
    }
    expect(searchCommands(commands, "stripe").results.map((command) => command.id)).toContain(`dashboard:account:${A2}`);
    // "Vercel team" is the connection's name, which the account's label no longer carries.
    expect(searchCommands(commands, "vercel team").results.map((command) => command.id)).toContain(`dashboard:account:${A1}`);
  });

  it("adds the connection to an account's label only when another account has the same name", () => {
    const twins = buildPaletteCommands({
      ...SOURCES,
      scope: {
        ...SCOPE,
        accounts: [
          { id: A1, connection_id: C1, display_name: "Production" },
          { id: A2, connection_id: C2, display_name: "Production" },
        ],
      },
    });
    const labels = twins.filter((command) => command.kind === "Account dashboard").map((command) => command.label);
    expect(labels).toEqual(["Production (Stripe (Example Stripe account (test mode)))", "Production (Vercel team)"]);
  });

  it("acknowledges every alert through the acknowledge all action", () => {
    expect(find(commands, "Action", "Acknowledge all alerts")?.action).toEqual({ kind: "acknowledge_all" });
  });

  it("syncs each connection now through the sync action, named by its provider", () => {
    const syncs = commands.filter((command) => command.action.kind === "sync");
    expect(syncs.map((command) => [command.label, command.kind, command.action])).toEqual([
      ["Sync Vercel now", "Action", { kind: "sync", connectionId: C1, name: "Vercel" }],
      ["Sync Stripe now", "Action", { kind: "sync", connectionId: C2, name: "Stripe" }],
    ]);
  });

  it("names a sync by its connection when the provider is connected twice, and skips a disconnected one", () => {
    const scope: PaletteScope = {
      ...NO_SCOPE,
      connections: [
        { id: C1, provider: "vercel", display_name: "Vercel team", status: "active" },
        { id: C2, provider: "vercel", display_name: "Vercel hobby", status: "needs_attention" },
        { id: C3, provider: "stripe", display_name: "Stripe live", status: "revoked" },
      ],
    };
    const labels = buildPaletteCommands({ ...SOURCES, scope })
      .filter((command) => command.action.kind === "sync")
      .map((command) => command.label);
    expect(labels).toEqual(["Sync Vercel team now", "Sync Vercel hobby now"]);
  });

  it("opens the create API key form in settings", () => {
    expect(hrefOf(find(commands, "Action", "Create API key"))).toBe(`/w/${SLUG}/settings#create-api-key`);
  });

  it("connects each configured provider through its connect screen", () => {
    expect(hrefOf(find(commands, "Action", "Connect Resend"))).toBe(`/w/${SLUG}/connections/new/resend`);
  });

  it("switches to every other workspace, never the current one", () => {
    const workspaces = commands.filter((command) => command.kind === "Workspace");
    expect(workspaces.map((command) => [command.label, hrefOf(command)])).toEqual([["Side project", `/w/${OTHER_SLUG}/timeline`]]);
  });

  it("offers no workspace switch to a member of one workspace", () => {
    const single = buildPaletteCommands({ ...SOURCES, workspaces: [{ slug: SLUG, name: "Acme" }] });
    expect(single.filter((command) => command.kind === "Workspace")).toEqual([]);
  });

  it.each<[WorkspaceRole, boolean]>([
    ["owner", true],
    ["admin", true],
    ["viewer", false],
  ])("lists actions to %s only when the role can run them (%s)", (role, allowed) => {
    const forRole = buildPaletteCommands({ ...SOURCES, role });
    const actions = forRole.filter((command) => command.kind === "Action").map((command) => command.label);
    expect(actions).toEqual(
      allowed ? ["Acknowledge all alerts", "Sync Vercel now", "Sync Stripe now", "Create API key", "Connect Resend"] : [],
    );
    // Pages, views, and other workspaces are for every member.
    expect(forRole.filter((command) => command.kind !== "Action")).toEqual(commands.filter((command) => command.kind !== "Action"));
  });

  it("ends with the shortcut list", () => {
    expect(commands.at(-1)).toMatchObject({ label: "Keyboard shortcuts", kind: "Help", action: { kind: "shortcuts" } });
  });

  it("gives every command a unique id", () => {
    expect(new Set(commands.map((command) => command.id)).size).toBe(commands.length);
  });

  it("offers no provider, account, or sync results when nothing is connected", () => {
    const bare = buildPaletteCommands({ ...SOURCES, scope: NO_SCOPE, eventTypeIds: [] });
    expect(bare.filter((command) => command.action.kind === "sync")).toEqual([]);
    // The scope filter always offers Unassigned, and so does the palette.
    expect(bare.filter((command) => command.id.startsWith("dashboard:") || command.id.startsWith("timeline:")).map((c) => c.id)).toEqual([
      `dashboard:project:${UNASSIGNED_PROJECT}`,
    ]);
  });

  it("still offers pages, actions, and workspaces when the scope could not be loaded", () => {
    const unloaded = buildPaletteCommands({ ...SOURCES, scope: null, eventTypeIds: [] });
    expect(unloaded.map((command) => command.id)).toEqual([
      "page:timeline",
      "page:dashboard",
      "page:connections",
      "page:alerts",
      "page:projects",
      "page:settings",
      "page:alert-settings",
      "page:year",
      "page:account",
      "action:acknowledge-all",
      "action:create-api-key",
      "connect:resend",
      `workspace:${OTHER_SLUG}`,
      "help:shortcuts",
    ]);
  });

  it("keeps a very long name whole and unrepeated, for the list to wrap", () => {
    const longName = `Workspace ${"with a very long name ".repeat(12)}end`;
    const longAccount = `Account ${"x".repeat(300)}`;
    const long = buildPaletteCommands({
      ...SOURCES,
      workspaces: [...SOURCES.workspaces, { slug: "ghi789", name: longName }],
      scope: { ...SCOPE, accounts: [{ id: A1, connection_id: C1, display_name: longAccount }] },
    });
    expect(find(long, "Workspace", longName)).toBeDefined();
    expect(find(long, "Account dashboard", longAccount)).toBeDefined();
  });

  it("keeps a thousand accounts as a thousand distinct commands", () => {
    const accounts = Array.from({ length: 1000 }, (_, index) => ({
      id: `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      connection_id: C1,
      display_name: `Account ${index}`,
    }));
    const many = buildPaletteCommands({ ...SOURCES, scope: { ...SCOPE, accounts } });
    const accountCommands = many.filter((command) => command.kind === "Account dashboard");
    expect(accountCommands).toHaveLength(1000);
    expect(new Set(many.map((command) => command.id)).size).toBe(many.length);
  });
});
