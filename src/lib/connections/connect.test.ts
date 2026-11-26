import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { fakeAdapter, fakeScopes } from "@/lib/adapters/fake";
import { Secret, type OAuthContext, type OAuthCredential, type ProviderAdapter } from "@/lib/adapters/types";
import { saveCredential } from "@/lib/data/credentials";
import { enqueueSync } from "@/lib/jobs/queue";
import { createAdminClient } from "@/lib/supabase/admin";
import type { Database } from "@/lib/supabase/database.types";

import { completeConnection, WorkspaceNotEmptyError } from "./connect";

/*
 * What completeConnection writes to the connection row when a grant completes: the grant time
 * (#476) and the installation the credential belongs to (#480), on connect and on reconnect, and
 * nothing when the grant fails part way. A connection asked to be the workspace's first (#287) goes
 * in through insert_first_connection, and nothing is written when the workspace already has one.
 * The database calls go through a client that answers the reconnect lookup, the insert, and
 * insert_first_connection, and records every write.
 */

vi.mock("@/lib/supabase/admin");
vi.mock("@/lib/data/credentials", () => ({ saveCredential: vi.fn(async () => undefined), deleteCredential: vi.fn(async () => undefined) }));
vi.mock("@/lib/jobs/queue", () => ({ enqueueSync: vi.fn(async () => ({ queued: true })) }));

const WORKSPACE_ID = "47600000-0000-4000-8000-000000000001";
const CONNECTION_ID = "47600000-0000-4000-8000-000000000002";
const NEW_CONNECTION_ID = "47600000-0000-4000-8000-000000000003";
const USER_ID = "47600000-0000-4000-8000-000000000004";
const NOW = new Date("2026-11-16T10:00:00.000Z");

const credential: OAuthCredential = {
  accessToken: new Secret("at-ok"),
  refreshToken: new Secret("rt-ok"),
  scopes: [...fakeScopes],
  tokenType: "bearer",
  metadata: { mode: "ok" },
};

const ctx: OAuthContext = {
  client: { clientId: "fake-client", clientSecret: new Secret("fake-secret"), extra: {} },
  fetch: () => Promise.reject(new Error("no network in tests")),
  now: () => NOW,
  timeoutMs: 1000,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

const WriteSchema = z.record(z.string(), z.unknown());
type Write = Readonly<{ method: string; table: string; body: unknown }>;

/**
 * A client whose reconnect lookup finds the existing connection, whose insert_first_connection
 * answers `firstConnection` (null when the workspace already has a connection), and that records
 * every write.
 */
function recordingClient(firstConnection: string | null = NEW_CONNECTION_ID) {
  const writes: Write[] = [];
  const db = createClient<Database>("http://postgrest.test", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        const table = url.pathname.split("/").at(-1) ?? "";
        const method = init?.method ?? "GET";
        if (method === "GET") return Response.json([{ id: CONNECTION_ID, granted_scopes: [...fakeScopes] }]);
        const body: unknown = init?.body === undefined ? null : JSON.parse(String(init.body));
        writes.push({ method, table, body });
        if (method === "POST" && table === "connections") return Response.json({ id: NEW_CONNECTION_ID });
        if (method === "POST" && table === "insert_first_connection") return Response.json(firstConnection);
        return new Response(null, { status: 204 });
      },
    },
  });
  vi.mocked(createAdminClient).mockReturnValue(db);
  return writes;
}

/** The final update of the connection row: the one that makes it live. */
function finalUpdate(writes: readonly Write[]): Record<string, unknown> {
  const updates = writes.filter((write) => write.method === "PATCH" && write.table === "connections");
  expect(updates).toHaveLength(1);
  return WriteSchema.parse(updates[0]?.body);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("completeConnection grant time (#476)", () => {
  it("stamps granted_at on a new connection when its grant completes", async () => {
    const writes = recordingClient();

    const result = await completeConnection({ adapter: fakeAdapter, ctx, workspaceId: WORKSPACE_ID, userId: USER_ID, credential });

    expect(result.connectionId).toBe(NEW_CONNECTION_ID);
    // The pending insert carries no grant time: the grant has not completed yet.
    const insert = writes.find((write) => write.method === "POST" && write.table === "connections");
    expect(WriteSchema.parse(insert?.body)).not.toHaveProperty("granted_at");
    expect(finalUpdate(writes)).toMatchObject({ status: "active", granted_at: NOW.toISOString() });
  });

  it("stamps granted_at again on a reconnect, keeping the connection", async () => {
    const writes = recordingClient();

    const result = await completeConnection({
      adapter: fakeAdapter,
      ctx,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      credential,
      reconnectId: CONNECTION_ID,
    });

    expect(result.connectionId).toBe(CONNECTION_ID);
    expect(writes.some((write) => write.method === "POST" && write.table === "connections")).toBe(false);
    expect(finalUpdate(writes)).toMatchObject({ granted_at: NOW.toISOString() });
  });

  it("leaves granted_at alone when a reconnect fails before the grant completes (boundary: credential save fails)", async () => {
    const writes = recordingClient();
    vi.mocked(saveCredential).mockRejectedValueOnce(new Error("connection_credentials upsert failed (code 08006)."));

    await expect(
      completeConnection({ adapter: fakeAdapter, ctx, workspaceId: WORKSPACE_ID, userId: USER_ID, credential, reconnectId: CONNECTION_ID }),
    ).rejects.toThrow("upsert failed");

    expect(writes.filter((write) => write.table === "connections")).toEqual([]);
  });
});

describe("completeConnection installation id (#480)", () => {
  const installed: ProviderAdapter = { ...fakeAdapter, installationIdOf: (granted) => granted.metadata?.installation ?? null };
  const inInstallation = (installation: string): OAuthCredential => ({ ...credential, metadata: { ...credential.metadata, installation } });

  it("records the installation the credential belongs to on a new connection", async () => {
    const writes = recordingClient();

    await completeConnection({ adapter: installed, ctx, workspaceId: WORKSPACE_ID, userId: USER_ID, credential: inInstallation("fake-installation-1") });

    expect(finalUpdate(writes)).toMatchObject({ external_installation_id: "fake-installation-1" });
  });

  it("records the reconnect's installation, which may differ from the old one", async () => {
    const writes = recordingClient();

    await completeConnection({
      adapter: installed,
      ctx,
      workspaceId: WORKSPACE_ID,
      userId: USER_ID,
      credential: inInstallation("fake-installation-2"),
      reconnectId: CONNECTION_ID,
    });

    expect(finalUpdate(writes)).toMatchObject({ external_installation_id: "fake-installation-2" });
  });

  it.each([
    ["an adapter that does not declare installationIdOf (boundary: omitted)", fakeAdapter],
    ["a credential that names no installation (boundary: null)", installed],
    ["an adapter that returns an empty id (boundary: blank)", { ...fakeAdapter, installationIdOf: () => "" }],
    ["an adapter that returns whitespace (boundary: blank)", { ...fakeAdapter, installationIdOf: () => "  " }],
  ])("writes null for %s", async (_case, adapter: ProviderAdapter) => {
    const writes = recordingClient();

    await completeConnection({ adapter, ctx, workspaceId: WORKSPACE_ID, userId: USER_ID, credential });

    expect(finalUpdate(writes)).toMatchObject({ external_installation_id: null });
  });
});

describe("completeConnection mode (#481)", () => {
  const moded = (mode: "live" | "test" | null): ProviderAdapter => ({ ...fakeAdapter, modeOf: () => mode });

  it.each(["live", "test"] as const)("records a %s mode grant on a new connection", async (mode) => {
    const writes = recordingClient();

    await completeConnection({ adapter: moded(mode), ctx, workspaceId: WORKSPACE_ID, userId: USER_ID, credential });

    expect(finalUpdate(writes)).toMatchObject({ mode });
  });

  it("records the reconnect's mode, which may differ from the old one", async () => {
    const writes = recordingClient();

    await completeConnection({ adapter: moded("test"), ctx, workspaceId: WORKSPACE_ID, userId: USER_ID, credential, reconnectId: CONNECTION_ID });

    expect(finalUpdate(writes)).toMatchObject({ mode: "test" });
  });

  it.each([
    ["an adapter that does not declare modeOf (boundary: omitted)", fakeAdapter],
    ["a credential that names no mode (boundary: null)", moded(null)],
  ])("writes null for %s", async (_case, adapter: ProviderAdapter) => {
    const writes = recordingClient();

    await completeConnection({ adapter, ctx, workspaceId: WORKSPACE_ID, userId: USER_ID, credential });

    expect(finalUpdate(writes)).toMatchObject({ mode: null });
  });
});

describe("completeConnection as the workspace's first connection (#287)", () => {
  it("inserts it through insert_first_connection, pending as any new connection, then completes it", async () => {
    const writes = recordingClient();

    const result = await completeConnection({ adapter: fakeAdapter, ctx, workspaceId: WORKSPACE_ID, userId: USER_ID, credential, onlyIntoEmptyWorkspace: true });

    expect(result.connectionId).toBe(NEW_CONNECTION_ID);
    expect(writes.some((write) => write.method === "POST" && write.table === "connections")).toBe(false);
    const update = finalUpdate(writes);
    expect(writes.find((write) => write.table === "insert_first_connection")?.body).toEqual({
      p_workspace_id: WORKSPACE_ID,
      p_provider: fakeAdapter.id,
      p_display_name: update.display_name,
      p_poll_interval_seconds: fakeAdapter.pollIntervalSeconds,
      p_user_id: USER_ID,
    });
    expect(update).toMatchObject({ status: "active", granted_at: NOW.toISOString() });
    expect(saveCredential).toHaveBeenCalledOnce();
    expect(enqueueSync).toHaveBeenCalledExactlyOnceWith({ workspaceId: WORKSPACE_ID, connectionId: NEW_CONNECTION_ID, reason: "initial" });
  });

  it("makes nothing when the workspace already has a connection, and says so (boundary: one connection)", async () => {
    const writes = recordingClient(null);

    await expect(
      completeConnection({ adapter: fakeAdapter, ctx, workspaceId: WORKSPACE_ID, userId: USER_ID, credential, onlyIntoEmptyWorkspace: true }),
    ).rejects.toBeInstanceOf(WorkspaceNotEmptyError);

    expect(writes.map((write) => write.table)).toEqual(["insert_first_connection"]);
    expect(saveCredential).not.toHaveBeenCalled();
    expect(enqueueSync).not.toHaveBeenCalled();
  });
});
