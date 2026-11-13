import { ADMIN_PATH } from "@/lib/auth/super-admin";
import { appendScopeParams, buildScopeOptions, EMPTY_SCOPE, type ScopeFilters, type ScopeSources } from "@/lib/filters/scope";
import { providerName, typeOwnerName } from "@/lib/providers";
import type { Database } from "@/lib/supabase/database.types";
import { eventTypeLabel, timelineHref } from "@/lib/timeline/query";
import {
  alertSettingsPath,
  createApiKeyPath,
  WORKSPACE_SECTIONS,
  workspaceHome,
  workspacePath,
  yearInReviewPath,
  type WorkspaceSection,
} from "@/lib/workspaces/paths";
import { canPerform, type WorkspaceRole } from "@/lib/workspaces/permissions";

import type { PaletteCommand } from "./search";

/**
 * The command palette's server-side half (#170): every command for one workspace, built from data
 * the shell already holds (the workspace's connections, accounts, and projects, the adapters'
 * declared event types, and the member's workspaces), so the palette runs no query of its own.
 * Every href is built here with the same helpers the screens use, so a palette result lands on
 * exactly the URL the filter form would produce. Actions (#265) are left out for a role that
 * cannot run them; the Server Action each one calls authorizes again.
 */

// Record so a new workspace section fails to compile until the palette can go to it. Listed in
// `WORKSPACE_SECTIONS` order, which is the nav bar's.
const SECTION_COMMANDS: Record<WorkspaceSection, Readonly<{ label: string; keywords: string }>> = {
  timeline: { label: "Timeline", keywords: "events activity deploys payments" },
  dashboard: { label: "Dashboard", keywords: "spend usage allowances trends totals" },
  connections: { label: "Connections", keywords: "providers integrations" },
  alerts: { label: "Alerts", keywords: "triggered acknowledge inbox" },
  projects: { label: "Projects", keywords: "groups" },
  settings: { label: "Settings", keywords: "workspace members rename api keys" },
};

type ConnectionStatus = Database["public"]["Enums"]["connection_status"];

/** What the scope filter reads, plus each connection's status, which decides whether it can sync. */
export type PaletteScope = Readonly<{
  connections: readonly Readonly<ScopeSources["connections"][number] & { status: ConnectionStatus }>[];
  accounts: ScopeSources["accounts"];
  projects: ScopeSources["projects"];
}>;

export type PaletteSources = Readonly<{
  workspaceSlug: string;
  /** The member's role in this workspace; actions it cannot run are not listed. */
  role: WorkspaceRole;
  /** Connections, included accounts, and projects; null when they could not be loaded. */
  scope: PaletteScope | null;
  /** Event types the workspace's connected providers declare. */
  eventTypeIds: readonly string[];
  /** Providers configured on this instance, offered to members who may connect one. */
  configuredProviders: readonly Readonly<{ id: string; displayName: string }>[];
  /** Every workspace the member belongs to, this one included. */
  workspaces: readonly Readonly<{ slug: string; name: string }>[];
  /** True for a super admin only (`showsAdminLink`); nobody else's list holds the admin page or its path. */
  superAdmin: boolean;
  /** The newest year with a yearly card (`latestCardYear`). */
  reviewYear: number;
}>;

function dashboardHref(basePath: string, scope: ScopeFilters): string {
  const params = new URLSearchParams();
  appendScopeParams(params, scope);
  return `${basePath}?${params.toString()}`;
}

function timelineFor(basePath: string, scope: ScopeFilters, types: string[]): string {
  return timelineHref(basePath, { types, severities: [], from: null, to: null, timeRange: null, search: null, cursor: null, scope }, null);
}

/**
 * Each item's short label, or its long one where another item has the same short label: a name is
 * shown once unless repeating more of it is the only way to tell two results apart.
 */
function distinctLabels<T>(items: readonly T[], short: (item: T) => string, long: (item: T) => string): string[] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(short(item), (counts.get(short(item)) ?? 0) + 1);
  return items.map((item) => ((counts.get(short(item)) ?? 0) > 1 ? long(item) : short(item)));
}

/** Dashboard and timeline results for the workspace's providers, projects, and accounts, and its sync actions. */
function scopeCommands(sources: PaletteSources, scope: PaletteScope) {
  const dashboardPath = workspacePath(sources.workspaceSlug, "dashboard");
  const timelinePath = workspacePath(sources.workspaceSlug, "timeline");
  // The filter's own choices, so the palette offers the same providers and projects (Unassigned too).
  const { providers, projects } = buildScopeOptions(scope, EMPTY_SCOPE);
  const connections = new Map(scope.connections.map((connection) => [connection.id, connection]));

  const accountLabels = distinctLabels(
    scope.accounts,
    (account) => account.display_name,
    (account) => `${account.display_name} (${connections.get(account.connection_id)?.display_name ?? "unknown connection"})`,
  );
  const accounts = scope.accounts
    .map((account, index): PaletteCommand => {
      const connection = connections.get(account.connection_id);
      return {
        id: `dashboard:account:${account.id}`,
        label: accountLabels[index] ?? account.display_name,
        kind: "Account dashboard",
        // The provider and connection the label no longer repeats still find the account.
        keywords:
          connection === undefined
            ? "spend usage"
            : `${connection.provider} ${providerName(connection.provider)} ${connection.display_name} spend usage`,
        action: { kind: "navigate", href: dashboardHref(dashboardPath, { ...EMPTY_SCOPE, accounts: [account.id] }) },
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  const dashboards: PaletteCommand[] = [
    ...providers.map((option): PaletteCommand => ({
      id: `dashboard:provider:${option.value}`,
      label: option.label,
      kind: "Provider dashboard",
      keywords: `${option.value} spend usage`,
      action: { kind: "navigate", href: dashboardHref(dashboardPath, { ...EMPTY_SCOPE, providers: [option.value] }) },
    })),
    ...projects.map((option): PaletteCommand => ({
      id: `dashboard:project:${option.value}`,
      label: option.label,
      kind: "Project dashboard",
      keywords: "spend usage",
      action: { kind: "navigate", href: dashboardHref(dashboardPath, { ...EMPTY_SCOPE, projects: [option.value] }) },
    })),
    ...accounts,
  ];

  const timelines: PaletteCommand[] = [
    ...providers.map((option): PaletteCommand => ({
      id: `timeline:provider:${option.value}`,
      label: option.label,
      kind: "Provider timeline",
      keywords: `${option.value} events activity`,
      action: { kind: "navigate", href: timelineFor(timelinePath, { ...EMPTY_SCOPE, providers: [option.value] }, []) },
    })),
    ...sources.eventTypeIds.map((typeId): PaletteCommand => ({
      id: `timeline:type:${typeId}`,
      // The words the timeline's own type filter prints, so the palette and the form agree.
      label: `${typeOwnerName(typeId)}: ${eventTypeLabel(typeId)}`,
      kind: "Event timeline",
      keywords: `${typeId.replaceAll(/[._]/g, " ")} events`,
      action: { kind: "navigate", href: timelineFor(timelinePath, EMPTY_SCOPE, [typeId]) },
    })),
  ];

  // syncNow refuses a disconnected connection, so it is not offered.
  const syncable = canPerform(sources.role, "manage_connections")
    ? scope.connections.filter((connection) => connection.status !== "revoked")
    : [];
  const syncNames = distinctLabels(
    syncable,
    (connection) => providerName(connection.provider),
    (connection) => connection.display_name,
  );
  const syncs = syncable.map((connection, index): PaletteCommand => {
    const name = syncNames[index] ?? connection.display_name;
    return {
      id: `action:sync:${connection.id}`,
      label: `Sync ${name} now`,
      kind: "Action",
      keywords: `${connection.provider} ${connection.display_name} refresh update connection`,
      action: { kind: "sync", connectionId: connection.id, name },
    };
  });

  return { dashboards, timelines, syncs };
}

/**
 * Every command, in display order for a blank query: pages, actions (Acknowledge all alerts, syncs,
 * Create API key, then providers to connect, so one kind sits together), other workspaces,
 * dashboard scopes (providers, projects, accounts), timeline views (providers, then event types),
 * and the shortcut list.
 */
export function buildPaletteCommands(sources: PaletteSources): PaletteCommand[] {
  const { workspaceSlug, role } = sources;

  const pages: PaletteCommand[] = WORKSPACE_SECTIONS.map((section) => ({
    id: `page:${section}`,
    ...SECTION_COMMANDS[section],
    kind: "Page",
    action: { kind: "navigate", href: workspacePath(workspaceSlug, section) },
  }));
  pages.push(
    {
      // The settings moved off the alerts inbox (#343); these words used to find the Alerts page.
      id: "page:alert-settings",
      label: "Alert settings",
      kind: "Page",
      keywords: "rules budgets thresholds channels webhooks digest emails unusual anomaly mute",
      action: { kind: "navigate", href: alertSettingsPath(workspaceSlug) },
    },
    {
      id: "page:year",
      label: "Year in review",
      kind: "Page",
      keywords: `${sources.reviewYear} yearly card stack share`,
      action: { kind: "navigate", href: yearInReviewPath(workspaceSlug, sources.reviewYear) },
    },
    {
      id: "page:account",
      label: "Account",
      kind: "Page",
      keywords: "profile email sign out",
      action: { kind: "navigate", href: "/account" },
    },
  );
  if (sources.superAdmin) {
    pages.push({
      id: "page:admin",
      label: "Admin",
      kind: "Page",
      keywords: "open instance overview super configuration operator",
      action: { kind: "navigate", href: ADMIN_PATH },
    });
  }

  const { dashboards, timelines, syncs } =
    sources.scope === null ? { dashboards: [], timelines: [], syncs: [] } : scopeCommands(sources, sources.scope);

  const actions: PaletteCommand[] = [];
  if (canPerform(role, "acknowledge_alert")) {
    // Always listed: how many alerts wait is not read for the shell, and the result says when
    // none were left.
    actions.push({
      id: "action:acknowledge-all",
      label: "Acknowledge all alerts",
      kind: "Action",
      keywords: "triggered dismiss clear",
      action: { kind: "acknowledge_all" },
    });
  }
  actions.push(...syncs);
  if (canPerform(role, "manage_api_keys")) {
    // Creating a key needs a name and scopes and shows the key once, so it opens the settings form.
    actions.push({
      id: "action:create-api-key",
      label: "Create API key",
      kind: "Action",
      keywords: "new token rest assistant mcp settings",
      action: { kind: "navigate", href: createApiKeyPath(workspaceSlug) },
    });
  }

  const workspaces = sources.workspaces
    .filter((workspace) => workspace.slug !== workspaceSlug)
    .map((workspace): PaletteCommand => ({
      id: `workspace:${workspace.slug}`,
      label: workspace.name,
      kind: "Workspace",
      keywords: "switch change open",
      action: { kind: "navigate", href: workspaceHome(workspace.slug) },
    }));

  const connect = canPerform(role, "manage_connections")
    ? sources.configuredProviders.map((provider): PaletteCommand => ({
        id: `connect:${provider.id}`,
        label: `Connect ${provider.displayName}`,
        kind: "Action",
        keywords: `${provider.id} add provider integration`,
        action: { kind: "navigate", href: `${workspacePath(workspaceSlug, "connections")}/new/${provider.id}` },
      }))
    : [];

  const help: PaletteCommand = {
    id: "help:shortcuts",
    label: "Keyboard shortcuts",
    kind: "Help",
    keywords: "show keys hotkeys",
    action: { kind: "shortcuts" },
  };

  return [...pages, ...actions, ...connect, ...workspaces, ...dashboards, ...timelines, help];
}
