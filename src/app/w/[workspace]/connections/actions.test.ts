import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderId } from "@/lib/adapters/types";
import type { WorkspaceAccess } from "@/lib/workspaces/access";

import { syncNow } from "./actions";

/*
 * "Sync now" for a provider this instance does not offer (#570): the fake provider is absent from
 * the registry while STACKDASH_ENABLE_FAKE_PROVIDER is not "1", so its sync could only fail. The
 * action refuses it with the reason the connection page shows, and queues nothing. The registry is
 * the real one, switched by the flag; the database and the queue are stubbed.
 */

type Row = Readonly<{ id: string; provider: ProviderId; status: "active" | "revoked"; last_sync_requested_at: null }>;

const mocks = vi.hoisted(() => ({
  requireWorkspaceAction: vi.fn<(slug: string, action: string) => Promise<WorkspaceAccess>>(),
  enqueueSync: vi.fn<(input: { workspaceId: string; connectionId: string; reason: string }) => Promise<{ queued: boolean }>>(),
  createClient: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/cache", () => ({ refresh: mocks.refresh }));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAction: mocks.requireWorkspaceAction }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/jobs/queue", () => ({ enqueueSync: mocks.enqueueSync, MANUAL_SYNC_COOLDOWN_SECONDS: 300 }));
vi.mock("@/lib/log/logger", () => ({ logError: () => "ref-570", log: { info: () => {}, warn: () => {}, error: () => {} } }));

const ACCESS: WorkspaceAccess = {
  user: { id: "57000000-0000-4000-8000-0000000000aa", email: "e2e-owner@example.com", profile: { name: null, avatarUrl: null } },
  workspace: { id: "57000000-0000-4000-8000-000000000001", slug: "acme", name: "Acme", handle: null },
  role: "admin",
};

const FAKE: Row = { id: "57000000-0000-4000-8000-000000000101", provider: "fake", status: "active", last_sync_requested_at: null };
const GITHUB: Row = { id: "57000000-0000-4000-8000-000000000102", provider: "github", status: "active", last_sync_requested_at: null };
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
  mocks.requireWorkspaceAction.mockResolvedValue(ACCESS);
  mocks.enqueueSync.mockResolvedValue({ queued: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("syncNow and the provider registry", () => {
  it("queues a fake connection's sync while the fake provider is on", async () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    stubConnections([FAKE]);
    expect(await syncNow(null, form([FAKE.id]))).toEqual(QUEUED);
    expect(mocks.enqueueSync).toHaveBeenCalledExactlyOnceWith({ workspaceId: ACCESS.workspace.id, connectionId: FAKE.id, reason: "manual" });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("queues a live provider's sync whatever the fake provider's flag says", async () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "");
    stubConnections([GITHUB]);
    expect(await syncNow(null, form([GITHUB.id]))).toEqual(QUEUED);
    expect(mocks.enqueueSync).toHaveBeenCalledExactlyOnceWith({ workspaceId: ACCESS.workspace.id, connectionId: GITHUB.id, reason: "manual" });
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
    expect(mocks.enqueueSync).toHaveBeenCalledExactlyOnceWith({ workspaceId: ACCESS.workspace.id, connectionId: GITHUB.id, reason: "manual" });
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

  it("says a disconnected fake connection is disconnected, before saying its provider is off", async () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "0");
    stubConnections([{ ...FAKE, status: "revoked" }]);
    expect(await syncNow(null, form([FAKE.id]))).toEqual({
      ok: false,
      message: "This connection is disconnected. Reconnect it before syncing.",
    });
    expect(mocks.enqueueSync).not.toHaveBeenCalled();
  });
});
