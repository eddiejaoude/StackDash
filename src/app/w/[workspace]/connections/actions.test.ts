import { randomBytes, randomUUID } from "node:crypto";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { simulatedAdapters } from "@/lib/adapters/simulated";
import type { ProviderId } from "@/lib/adapters/types";
import type { SessionUser } from "@/lib/auth/session";
import type { WorkspaceMembership } from "@/lib/data/workspaces";
import type * as HistoryModule from "@/lib/demo/history";
import type { Database } from "@/lib/supabase/database.types";
import type { WorkspaceRole } from "@/lib/workspaces/permissions";

import {
  assignAccountProject,
  deleteConnection,
  disconnect,
  exploreWithSampleData,
  regenerateWebhookSecret,
  saveWebhookSigningSecret,
  setAccountIncluded,
  setUpWebhook,
  syncNow,
} from "./actions";

/*
 * Authorization is the real `requireWorkspaceAction` and role matrix (#603): only the signed-in
 * user and their membership row, the layers under it, are stubbed, so a viewer or a non-member
 * reaching a connection is a failing test here, not a mocked pass. The database clients, the queue,
 * and the logger are stubbed as well.
 *
 * "Sync now" for a provider this instance does not offer (#570): the fake provider is absent from
 * the registry while STACKDASH_ENABLE_FAKE_PROVIDER is not "1", so its sync could only fail. The
 * action refuses it with the reason the connection page shows, and queues nothing. The registry is
 * the real one, switched by the flag.
 *
 * Sample data under overlapping submits (#287): the simulated providers, `completeConnection`, and
 * the credential save are the real ones, against an in-memory connections table; the history
 * replay is stubbed, since it runs every sync job.
 */

type Row = Readonly<{ id: string; provider: ProviderId; status: "active" | "revoked"; last_sync_requested_at: null }>;

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn<(nextPath: string) => Promise<SessionUser>>(),
  getWorkspaceMembership: vi.fn<(userId: string, slug: string) => Promise<WorkspaceMembership | null>>(),
  enqueueSync: vi.fn<(input: { workspaceId: string; connectionId: string; reason: string }) => Promise<{ queued: boolean }>>(),
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  refresh: vi.fn(),
  replayHistory: vi.fn(async () => {}),
}));

vi.mock("next/cache", () => ({ refresh: mocks.refresh }));
// `requireWorkspace` waits for the request first; a unit test has no request scope to wait for.
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth/session", () => ({ requireUser: mocks.requireUser, getCurrentUser: vi.fn() }));
vi.mock("@/lib/data/workspaces", () => ({ getWorkspaceMembership: mocks.getWorkspaceMembership }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/jobs/queue", () => ({ enqueueSync: mocks.enqueueSync, MANUAL_SYNC_COOLDOWN_SECONDS: 300, createJobDeps: () => ({}) }));
vi.mock("@/lib/demo/history", async (importOriginal) => ({ ...(await importOriginal<typeof HistoryModule>()), replayHistory: mocks.replayHistory }));
vi.mock("@/lib/log/logger", () => ({ logError: () => "ref-570", log: { info: () => {}, warn: () => {}, error: () => {} } }));

const USER: SessionUser = { id: "57000000-0000-4000-8000-0000000000aa", email: "e2e-owner@example.com", profile: { name: null, avatarUrl: null } };
const WORKSPACE: WorkspaceMembership["workspace"] = { id: "57000000-0000-4000-8000-000000000001", slug: "acme", name: "Acme", handle: null };

function memberAs(role: WorkspaceRole): void {
  mocks.getWorkspaceMembership.mockResolvedValue({ workspace: WORKSPACE, role });
}

const FAKE: Row = { id: "57000000-0000-4000-8000-000000000101", provider: "fake", status: "active", last_sync_requested_at: null };
const GITHUB: Row = { id: "57000000-0000-4000-8000-000000000102", provider: "github", status: "active", last_sync_requested_at: null };
const ACCOUNT_ID = "57000000-0000-4000-8000-000000000201";
const PROJECT_ID = "57000000-0000-4000-8000-000000000301";
const UNAVAILABLE =
  "Example provider is not available on this instance, so this connection cannot sync or be reconnected. Its history stays here until you delete the connection.";
const QUEUED = { ok: true, message: "Sync queued. New numbers appear within a few minutes." };

/** The connections table as findConnections reads it: the workspace's rows among the given ids. */
function stubConnections(rows: readonly Row[]): void {
  mocks.createClient.mockResolvedValue({
    from: () => ({
      select: () => ({
        eq: () => ({
          in: (_column: string, ids: readonly string[]) => ({
            limit: async () => ({ data: rows.filter((row) => ids.includes(row.id)), error: null }),
          }),
        }),
      }),
    }),
  });
}

function form(connectionIds: readonly string[]): FormData {
  const data = new FormData();
  data.set("workspace", "acme");
  for (const id of connectionIds) data.append("connectionId", id);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  memberAs("admin");
  mocks.enqueueSync.mockResolvedValue({ queued: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

type GuardedAction = (previous: null, formData: FormData) => Promise<unknown>;

// Every action that changes a connection or one of its accounts, with a form that passes its schema,
// so the role check is the only thing left to refuse it.
const GUARDED: ReadonlyArray<readonly [string, GuardedAction, Readonly<Record<string, string>>]> = [
  ["assignAccountProject", assignAccountProject, { accountId: ACCOUNT_ID, projectId: PROJECT_ID }],
  ["setAccountIncluded", setAccountIncluded, { accountId: ACCOUNT_ID, included: "false" }],
  ["disconnect", disconnect, { connectionId: GITHUB.id }],
  ["deleteConnection", deleteConnection, { connectionId: GITHUB.id }],
  ["exploreWithSampleData", exploreWithSampleData, {}],
  ["setUpWebhook", setUpWebhook, { connectionId: GITHUB.id, mode: "manual" }],
  ["regenerateWebhookSecret", regenerateWebhookSecret, { connectionId: GITHUB.id }],
  ["saveWebhookSigningSecret", saveWebhookSigningSecret, { connectionId: GITHUB.id, signingSecret: "whsec_synthetic" }],
  ["syncNow", syncNow, { connectionId: GITHUB.id }],
];

function guardedForm(fields: Readonly<Record<string, string>>): FormData {
  const data = new FormData();
  data.set("workspace", "acme");
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

describe("connection actions and the role matrix (#603)", () => {
  it.each(GUARDED)("%s refuses a viewer with the reason, before reading or changing anything", async (_name, action, fields) => {
    memberAs("viewer");
    expect(await action(null, guardedForm(fields))).toEqual({ ok: false, message: "Only owners and admins can connect providers." });
    expect(mocks.getWorkspaceMembership).toHaveBeenCalledExactlyOnceWith(USER.id, "acme");
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.enqueueSync).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each(GUARDED)("%s answers a non-member not found, the same as a workspace that does not exist", async (_name, action, fields) => {
    mocks.getWorkspaceMembership.mockResolvedValue(null);
    await expect(action(null, guardedForm(fields))).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.enqueueSync).not.toHaveBeenCalled();
  });

  // The control that keeps the two refusals above honest: the same forms get past the check for an
  // admin and an owner, and go on to read the workspace's rows (here, from a database that fails).
  it.each(GUARDED.flatMap(([name, action, fields]) => (["admin", "owner"] as const).map((role) => [name, role, action, fields] as const)))(
    "%s lets an %s through to the workspace's rows",
    async (_name, role, action, fields) => {
      memberAs(role);
      mocks.createClient.mockRejectedValue(new Error("database unreachable"));
      expect(await action(null, guardedForm(fields))).toMatchObject({ ok: false, referenceId: "ref-570" });
      expect(mocks.createClient).toHaveBeenCalled();
    },
  );
});

describe("syncNow and the provider registry", () => {
  it("queues a fake connection's sync while the fake provider is on", async () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    stubConnections([FAKE]);
    expect(await syncNow(null, form([FAKE.id]))).toEqual(QUEUED);
    expect(mocks.enqueueSync).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE.id, connectionId: FAKE.id, reason: "manual" });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("queues a live provider's sync whatever the fake provider's flag says", async () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "");
    stubConnections([GITHUB]);
    expect(await syncNow(null, form([GITHUB.id]))).toEqual(QUEUED);
    expect(mocks.enqueueSync).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE.id, connectionId: GITHUB.id, reason: "manual" });
  });

  it("refuses a fake connection while the fake provider is off, says why, and queues nothing", async () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "0");
    stubConnections([FAKE]);
    expect(await syncNow(null, form([FAKE.id]))).toEqual({ ok: false, message: UNAVAILABLE });
    expect(mocks.enqueueSync).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("queues only the offered connections of a many-connection request while the fake provider is off", async () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "0");
    stubConnections([FAKE, GITHUB]);
    expect(await syncNow(null, form([FAKE.id, GITHUB.id]))).toEqual(QUEUED);
    expect(mocks.enqueueSync).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE.id, connectionId: GITHUB.id, reason: "manual" });
  });

  it("refuses a many-connection request with nothing it can sync, when one is disconnected and one is not offered", async () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "0");
    stubConnections([FAKE, { ...GITHUB, status: "revoked" }]);
    expect(await syncNow(null, form([FAKE.id, GITHUB.id]))).toEqual({
      ok: false,
      message: "None of these connections can sync. Each one is disconnected, or its provider is not available on this instance.",
    });
    expect(mocks.enqueueSync).not.toHaveBeenCalled();
  });

  it("says a disconnected fake connection's provider is off, not to reconnect it, since it cannot be reconnected", async () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "0");
    stubConnections([{ ...FAKE, status: "revoked" }]);
    expect(await syncNow(null, form([FAKE.id]))).toEqual({ ok: false, message: UNAVAILABLE });
    expect(mocks.enqueueSync).not.toHaveBeenCalled();
  });

  it("asks for a reconnect when a disconnected connection's provider is offered", async () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "0");
    stubConnections([{ ...GITHUB, status: "revoked" }]);
    expect(await syncNow(null, form([GITHUB.id]))).toEqual({
      ok: false,
      message: "This connection is disconnected. Reconnect it before syncing.",
    });
    expect(mocks.enqueueSync).not.toHaveBeenCalled();
  });
});

type ConnectionRow = Readonly<{ id: string; workspace_id: string; provider: string }>;

const FirstConnectionArgsSchema = z.object({ p_workspace_id: z.string(), p_provider: z.string() });
const ConnectionInsertSchema = z.object({ workspace_id: z.string(), provider: z.string() });

/**
 * The admin client over an in-memory connections table: the inserts and reads `completeConnection`
 * and `saveCredential` make, and `insert_first_connection`, which checks and inserts in one step, as
 * the database function does in one transaction under the workspace row's lock. Every other write
 * is accepted and dropped.
 */
function sampleDataDatabase(seeded: readonly ConnectionRow[] = []): ConnectionRow[] {
  const connections = [...seeded];
  const insert = (workspaceId: string, provider: string): string => {
    const id = randomUUID();
    connections.push({ id, workspace_id: workspaceId, provider });
    return id;
  };
  const admin = createSupabaseClient<Database>("http://postgrest.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const method = init?.method ?? "GET";
        const body: unknown = init?.body === undefined ? null : JSON.parse(String(init.body));
        if (url.pathname.endsWith("/rpc/insert_first_connection")) {
          const args = FirstConnectionArgsSchema.parse(body);
          if (connections.some((row) => row.workspace_id === args.p_workspace_id)) return Response.json(null);
          return Response.json(insert(args.p_workspace_id, args.p_provider));
        }
        if (url.pathname.endsWith("/connections") && method === "POST") {
          const row = ConnectionInsertSchema.parse(body);
          return Response.json({ id: insert(row.workspace_id, row.provider) });
        }
        if (url.pathname.endsWith("/connections") && method === "GET") {
          const id = url.searchParams.get("id")?.replace(/^eq\./, "");
          return Response.json(connections.filter((row) => row.id === id).map((row) => ({ id: row.id })));
        }
        return new Response(null, { status: 204 });
      },
    },
  });
  mocks.createAdminClient.mockReturnValue(admin);
  return connections;
}

/**
 * The count the action reads with the user's client before adding sample data. Each read answers
 * once `submits` reads have arrived, so that many submits all count before any of them connects
 * anything: the overlap of #287.
 */
function stubConnectionCount(submits: number, count: () => number): void {
  let arrived = 0;
  const together = Promise.withResolvers<void>();
  mocks.createClient.mockResolvedValue({
    from: () => ({
      select: () => ({
        eq: async () => {
          arrived += 1;
          if (arrived === submits) together.resolve();
          await together.promise;
          return { count: count(), error: null };
        },
      }),
    }),
  });
}

describe("exploreWithSampleData and a workspace that gains a connection meanwhile (#287)", () => {
  const ALREADY_CONNECTED =
    "This workspace already has connections. Sample data is only added to a workspace with none, so it never mixes with real data.";
  const ADDED = { digest: expect.stringContaining(";/w/acme/timeline?sample=added;") };
  const ONE_SET = Object.keys(simulatedAdapters).toSorted();

  beforeEach(() => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    vi.stubEnv("STACKDASH_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("STACKDASH_ENCRYPTION_KEYS_PREVIOUS", "");
  });

  it("connects every simulated provider once into an empty workspace and opens the timeline", async () => {
    const connections = sampleDataDatabase();
    stubConnectionCount(1, () => connections.length);
    await expect(exploreWithSampleData(null, guardedForm({}))).rejects.toMatchObject(ADDED);
    expect(connections.map((row) => row.provider).toSorted()).toEqual(ONE_SET);
    expect(mocks.enqueueSync).toHaveBeenCalledTimes(ONE_SET.length);
    expect(mocks.replayHistory).toHaveBeenCalledTimes(1);
  });

  it("connects one set between two submits that both found the workspace empty, and gives the other the reason (boundary: concurrent submits)", async () => {
    const connections = sampleDataDatabase();
    stubConnectionCount(2, () => connections.length);
    const results = await Promise.allSettled([exploreWithSampleData(null, guardedForm({})), exploreWithSampleData(null, guardedForm({}))]);
    expect(connections.map((row) => row.provider).toSorted()).toEqual(ONE_SET);
    expect(results).toContainEqual({ status: "rejected", reason: expect.objectContaining(ADDED) });
    expect(results).toContainEqual({ status: "fulfilled", value: { ok: false, message: ALREADY_CONNECTED } });
    // The refused submit queued no sync and replayed nothing.
    expect(mocks.enqueueSync).toHaveBeenCalledTimes(ONE_SET.length);
    expect(mocks.replayHistory).toHaveBeenCalledTimes(1);
  });

  it("refuses with the reason and writes nothing when a connection landed after the count (boundary: one connection)", async () => {
    const connections = sampleDataDatabase([{ id: GITHUB.id, workspace_id: WORKSPACE.id, provider: GITHUB.provider }]);
    stubConnectionCount(1, () => 0);
    expect(await exploreWithSampleData(null, guardedForm({}))).toEqual({ ok: false, message: ALREADY_CONNECTED });
    expect(connections).toHaveLength(1);
    expect(mocks.enqueueSync).not.toHaveBeenCalled();
    expect(mocks.replayHistory).not.toHaveBeenCalled();
  });
});
