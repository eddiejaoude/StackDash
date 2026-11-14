import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Achievement } from "@/lib/adapters/achievements";
import { SIMULATED_SCOPE } from "@/lib/adapters/simulated/marker";
import { log } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { fakeSupabase, MAX_ROWS, type Row } from "@/lib/supabase/fake-postgrest";

import { evaluateConnectionAchievements } from "./run";

/*
 * Evaluation end to end against the fake PostgREST (src/lib/supabase/fake-postgrest.ts), which
 * answers at most max_rows rows a request like the real Data API. record_project_achievements() is
 * played by a handler that inserts on conflict do nothing, as the migration does, so a repeated
 * evaluation is checked against the same rule the database enforces.
 */

vi.mock("@/lib/supabase/admin");

const DEFINITIONS: Readonly<Record<string, readonly Achievement[]>> = {
  vercel: [
    definition("vercel.deployments.first", { kind: "event_count", typeIds: ["vercel.deployment_ready"], count: 1 }),
    definition("vercel.deployments.1000", { kind: "event_count", typeIds: ["vercel.deployment_ready"], count: MAX_ROWS }),
    definition("vercel.deployments.10", { kind: "event_count", typeIds: ["vercel.deployment_ready"], count: 10 }),
  ],
  railway: [definition("railway.deployments.10", { kind: "event_count", typeIds: ["railway.deployment.succeeded"], count: 10 })],
  github: [definition("github.stars.100", { kind: "metric_threshold", metricKey: "github.stars.total", value: 100 })],
};

vi.mock("@/lib/adapters/registry", () => ({
  getAdapter: (provider: string) => ({ achievements: DEFINITIONS[provider] ?? [] }),
  isFakeProviderEnabled: () => false,
}));

function definition(id: string, rule: Achievement["rule"]): Achievement {
  return { id, title: `Title ${id}`, publicTitle: `Public ${id}`, description: `How ${id} is earned.`, rule };
}

const WORKSPACE = "41300000-0000-4000-8000-000000000001";
const OTHER_WORKSPACE = "41300000-0000-4000-8000-000000000002";
const PROJECT = "41300000-0000-4000-8000-000000000010";
const OTHER_PROJECT = "41300000-0000-4000-8000-000000000011";
const UNREACHED_PROJECT = "41300000-0000-4000-8000-000000000012";
const VERCEL = "41300000-0000-4000-8000-000000000020";
const RAILWAY = "41300000-0000-4000-8000-000000000021";
const GITHUB = "41300000-0000-4000-8000-000000000022";
const SECOND_RAILWAY = "41300000-0000-4000-8000-000000000023";
const SIMULATED_VERCEL = "41300000-0000-4000-8000-000000000024";
const NOW = new Date("2026-11-14T12:00:00.000Z");
const HOUR_MS = 60 * 60 * 1000;

function uuid(prefix: number, index: number): string {
  return `${String(prefix).padStart(8, "0")}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function connection(id: string, provider: string, grantedScopes: readonly string[] = []): Row {
  return { id, workspace_id: WORKSPACE, provider, granted_scopes: grantedScopes };
}

function account(id: string, connectionId: string, projectId: string | null, fields: Partial<Row> = {}): Row {
  return { id, workspace_id: WORKSPACE, connection_id: connectionId, project_id: projectId, included: true, ...fields };
}

function deployments(accountId: string, typeId: string, count: number, start: string, prefix: number): Row[] {
  return Array.from({ length: count }, (_, index) => ({
    id: uuid(prefix, index),
    workspace_id: WORKSPACE,
    external_account_id: accountId,
    type_id: typeId,
    occurred_at: new Date(Date.parse(start) + index * HOUR_MS).toISOString(),
  }));
}

type Recorded = { workspaceId: string; projectId: string; achievements: Array<Record<string, unknown>> };

function database(tables: Record<string, Row[]>) {
  const earned: Row[] = [];
  const calls: Recorded[] = [];
  const { db, requests } = fakeSupabase(
    { ...tables, project_achievements: earned },
    {
      record_project_achievements: (args) => {
        const workspaceId = String(args.p_workspace_id);
        const projectId = String(args.p_project_id);
        const achievements = (args.p_achievements as Array<Record<string, unknown>>) ?? [];
        calls.push({ workspaceId, projectId, achievements });
        const fresh: string[] = [];
        for (const achievement of achievements) {
          const id = String(achievement.achievement_id);
          if (earned.some((row) => row.project_id === projectId && row.achievement_id === id)) continue;
          earned.push({ workspace_id: workspaceId, project_id: projectId, achievement_id: id });
          fresh.push(id);
        }
        // PostgREST answers a `setof text` function with a JSON array of the values.
        return fresh;
      },
    },
  );
  vi.mocked(createAdminClient).mockReturnValue(db);
  vi.spyOn(log, "info").mockImplementation(() => {});
  return { calls, earned, requests };
}

describe("evaluateConnectionAchievements", () => {
  let tables: Record<string, Row[]>;

  beforeEach(() => {
    const vercelAccount = uuid(1, 1);
    const railwayAccount = uuid(1, 2);
    const githubAccount = uuid(1, 3);
    const otherProjectAccount = uuid(1, 4);
    const excludedAccount = uuid(1, 5);
    tables = {
      connections: [connection(VERCEL, "vercel"), connection(RAILWAY, "railway"), connection(GITHUB, "github")],
      external_accounts: [
        account(vercelAccount, VERCEL, PROJECT),
        account(railwayAccount, RAILWAY, PROJECT),
        account(githubAccount, GITHUB, PROJECT),
        account(otherProjectAccount, RAILWAY, OTHER_PROJECT),
        account(excludedAccount, RAILWAY, PROJECT, { included: false }),
      ],
      activity_events: [
        // More than one page of Vercel deployments, so the 1,000th needs the second page.
        ...deployments(vercelAccount, "vercel.deployment_ready", MAX_ROWS + 50, "2025-12-01T00:00:00.000Z", 2),
        // A deployment dated after now is not evidence yet.
        { id: uuid(9, 1), workspace_id: WORKSPACE, external_account_id: vercelAccount, type_id: "vercel.deployment_ready", occurred_at: "2026-12-01T00:00:00.000Z" },
        // Railway: 6 here, 4 on another project's account, 4 on an excluded account. None reaches 10.
        ...deployments(railwayAccount, "railway.deployment.succeeded", 6, "2026-02-01T00:00:00.000Z", 3),
        ...deployments(otherProjectAccount, "railway.deployment.succeeded", 4, "2026-02-02T00:00:00.000Z", 4),
        ...deployments(excludedAccount, "railway.deployment.succeeded", 4, "2026-02-03T00:00:00.000Z", 5),
      ],
      usage_snapshots: [
        {
          id: uuid(6, 1),
          workspace_id: WORKSPACE,
          external_account_id: githubAccount,
          metric_key: "github.stars.total",
          snapshot_date: "2026-03-01",
          value: 140,
          retrieved_at: "2026-03-01T09:00:00.000Z",
          point_at: "2026-03-01T09:00:00.000Z",
          period_start: null,
        },
      ],
    };
  });

  it("backfills everything the synced provider's stored history proves, at historical dates", async () => {
    const { calls, requests } = database(tables);
    expect(await evaluateConnectionAchievements(WORKSPACE, VERCEL, NOW)).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.workspaceId).toBe(WORKSPACE);
    expect(calls[0]?.projectId).toBe(PROJECT);
    const byId = new Map(calls[0]?.achievements.map((row) => [row.achievement_id, row]));
    expect([...byId.keys()].sort()).toEqual(["vercel.deployments.10", "vercel.deployments.1000", "vercel.deployments.first"]);
    expect(byId.get("vercel.deployments.first")).toEqual({
      achievement_id: "vercel.deployments.first",
      provider: "vercel",
      title: "Title vercel.deployments.first",
      public_title: "Public vercel.deployments.first",
      description: "How vercel.deployments.first is earned.",
      earned_at: "2025-12-01T00:00:00.000Z",
      earned_precision: "instant",
      evidence: "crossed",
      threshold: null,
      simulated: false,
    });
    expect(byId.get("vercel.deployments.1000")?.earned_at).toBe(
      new Date(Date.parse("2025-12-01T00:00:00.000Z") + (MAX_ROWS - 1) * HOUR_MS).toISOString(),
    );
    // The second page starts after the first page's last row, not at an offset.
    const eventPages = requests.filter((request) => request.table === "activity_events");
    expect(eventPages).toHaveLength(2);
    expect(eventPages.map((request) => request.offset)).toEqual([0, 0]);
    const lastOfFirstPage = new Date(Date.parse("2025-12-01T00:00:00.000Z") + (MAX_ROWS - 1) * HOUR_MS).toISOString();
    expect(eventPages[1]?.filters).toContainEqual([
      "or",
      `(occurred_at.gt."${lastOfFirstPage}",and(occurred_at.eq."${lastOfFirstPage}",id.gt.${uuid(2, MAX_ROWS - 1)}))`,
    ]);
  });

  it("evaluates only the synced provider, reading no other provider's evidence", async () => {
    const { calls, requests } = database(tables);
    expect(await evaluateConnectionAchievements(WORKSPACE, GITHUB, NOW)).toBe(1);
    expect(calls.map((call) => call.achievements.map((row) => row.achievement_id))).toEqual([["github.stars.100"]]);
    expect(calls[0]?.achievements[0]).toMatchObject({
      provider: "github",
      earned_at: "2026-03-01T09:00:00.000Z",
      evidence: "at_least",
      threshold: 100,
    });
    // GitHub's achievements read metrics only, so no event was read at all.
    expect(requests.filter((request) => request.table === "activity_events")).toHaveLength(0);
  });

  it("counts only the project's included accounts of the provider", async () => {
    const { calls } = database(tables);
    expect(await evaluateConnectionAchievements(WORKSPACE, RAILWAY, NOW)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("reads every account of the provider on the project, across its connections", async () => {
    const secondAccount = uuid(1, 6);
    tables.connections = [...(tables.connections ?? []), connection(SECOND_RAILWAY, "railway")];
    tables.external_accounts = [...(tables.external_accounts ?? []), account(secondAccount, SECOND_RAILWAY, PROJECT)];
    tables.activity_events = [
      ...(tables.activity_events ?? []),
      ...deployments(secondAccount, "railway.deployment.succeeded", 4, "2026-03-01T00:00:00.000Z", 12),
    ];
    const { calls } = database(tables);
    expect(await evaluateConnectionAchievements(WORKSPACE, SECOND_RAILWAY, NOW)).toBe(1);
    // The 6 on the first Railway connection and the 4th on the second: the other project's and the
    // excluded account's deployments, which are earlier, are not counted.
    expect(calls[0]?.achievements.map((row) => [row.achievement_id, row.earned_at])).toEqual([
      ["railway.deployments.10", "2026-03-01T03:00:00.000Z"],
    ]);
  });

  it("records an achievement as simulated when any of the provider's accounts on the project is simulated", async () => {
    const simulatedAccount = uuid(1, 7);
    tables.connections = [...(tables.connections ?? []), connection(SIMULATED_VERCEL, "vercel", [SIMULATED_SCOPE])];
    tables.external_accounts = [...(tables.external_accounts ?? []), account(simulatedAccount, SIMULATED_VERCEL, PROJECT)];
    const { calls } = database(tables);
    expect(await evaluateConnectionAchievements(WORKSPACE, VERCEL, NOW)).toBe(3);
    expect(calls[0]?.achievements.map((row) => row.simulated)).toEqual([true, true, true]);
  });

  it("records nothing new on a repeated evaluation", async () => {
    const { calls, earned } = database(tables);
    await evaluateConnectionAchievements(WORKSPACE, VERCEL, NOW);
    expect(await evaluateConnectionAchievements(WORKSPACE, VERCEL, NOW)).toBe(0);
    expect(earned).toHaveLength(3);
    // Everything provable is earned, so the second run had nothing to record.
    expect(calls).toHaveLength(1);
  });

  it("returns only what the database newly recorded when a concurrent evaluation got there first", async () => {
    const { calls, earned } = database(tables);
    earned.push({ workspace_id: WORKSPACE, project_id: PROJECT, achievement_id: "vercel.deployments.first" });
    expect(await evaluateConnectionAchievements(WORKSPACE, VERCEL, NOW)).toBe(2);
    expect(calls[0]?.achievements.map((row) => row.achievement_id)).not.toContain("vercel.deployments.first");
  });

  it("never reads another workspace's connection", async () => {
    const { calls } = database(tables);
    expect(await evaluateConnectionAchievements(OTHER_WORKSPACE, VERCEL, NOW)).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it("evaluates each project the connection's accounts are assigned to, and only those", async () => {
    const first = uuid(7, 1);
    const second = uuid(7, 2);
    const elsewhere = uuid(7, 3);
    const unassigned = uuid(7, 4);
    const { calls } = database({
      connections: [connection(VERCEL, "vercel"), connection(RAILWAY, "railway")],
      external_accounts: [
        account(first, VERCEL, PROJECT),
        account(second, VERCEL, OTHER_PROJECT),
        account(unassigned, VERCEL, null),
        account(elsewhere, RAILWAY, UNREACHED_PROJECT),
      ],
      activity_events: [
        ...deployments(first, "vercel.deployment_ready", 1, "2026-01-01T00:00:00.000Z", 8),
        ...deployments(second, "vercel.deployment_ready", 1, "2026-01-02T00:00:00.000Z", 9),
        ...deployments(unassigned, "vercel.deployment_ready", 10, "2026-01-03T00:00:00.000Z", 10),
        ...deployments(elsewhere, "railway.deployment.succeeded", 10, "2026-01-04T00:00:00.000Z", 11),
      ],
      usage_snapshots: [],
    });
    expect(await evaluateConnectionAchievements(WORKSPACE, VERCEL, NOW)).toBe(2);
    expect(calls.map((call) => [call.projectId, call.achievements.map((row) => [row.achievement_id, row.earned_at])])).toEqual([
      [PROJECT, [["vercel.deployments.first", "2026-01-01T00:00:00.000Z"]]],
      [OTHER_PROJECT, [["vercel.deployments.first", "2026-01-02T00:00:00.000Z"]]],
    ]);
  });
});
