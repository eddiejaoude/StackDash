import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/auth/session";
import type { WorkspaceMembership } from "@/lib/data/workspaces";
import type { WorkspaceRole } from "@/lib/workspaces/permissions";

import { revokeApiKey } from "./actions";

/*
 * Revoking an API key (#162) through the real `requireWorkspaceAction` and role matrix (#603): only
 * the signed-in user and their membership row, the layers under it, are stubbed, so a viewer or a
 * non-member revoking a key is a failing test here, not a mocked pass.
 */

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn<(nextPath: string) => Promise<SessionUser>>(),
  getWorkspaceMembership: vi.fn<(userId: string, slug: string) => Promise<WorkspaceMembership | null>>(),
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/cache", () => ({ refresh: mocks.refresh }));
// `requireWorkspace` waits for the request first; a unit test has no request scope to wait for.
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth/session", () => ({ requireUser: mocks.requireUser, getCurrentUser: vi.fn() }));
vi.mock("@/lib/data/workspaces", () => ({ getWorkspaceMembership: mocks.getWorkspaceMembership }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/log/logger", () => ({ logError: () => "ref-603" }));

const USER: SessionUser = { id: "60300000-0000-4000-8000-0000000000aa", email: "e2e-owner@example.com", profile: { name: null, avatarUrl: null } };
const WORKSPACE: WorkspaceMembership["workspace"] = { id: "60300000-0000-4000-8000-000000000001", slug: "acme", name: "Acme", handle: null };
const KEY_ID = "60300000-0000-4000-8000-000000000101";

function memberAs(role: WorkspaceRole): void {
  mocks.getWorkspaceMembership.mockResolvedValue({ workspace: WORKSPACE, role });
}

function form(): FormData {
  const data = new FormData();
  data.set("workspace", "acme");
  data.set("keyId", KEY_ID);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
});

describe("revokeApiKey and the role matrix (#603)", () => {
  it("refuses a viewer with the reason, before reading or changing any key", async () => {
    memberAs("viewer");
    expect(await revokeApiKey(null, form())).toEqual({ ok: false, message: "Only owners and admins can create, see, or revoke API keys." });
    expect(mocks.getWorkspaceMembership).toHaveBeenCalledExactlyOnceWith(USER.id, "acme");
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("answers a non-member not found, the same as a workspace that does not exist", async () => {
    mocks.getWorkspaceMembership.mockResolvedValue(null);
    await expect(revokeApiKey(null, form())).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  // The control that keeps the two refusals above honest: the same form gets past the check for an
  // admin and an owner, and goes on to the workspace's keys (here, in a database that fails).
  it.each<WorkspaceRole>(["admin", "owner"])("lets an %s through to the workspace's keys", async (role) => {
    memberAs(role);
    mocks.createClient.mockRejectedValue(new Error("database unreachable"));
    expect(await revokeApiKey(null, form())).toEqual({
      ok: false,
      message: "The key could not be revoked. Try again in a moment.",
      referenceId: "ref-603",
    });
    expect(mocks.createClient).toHaveBeenCalledTimes(1);
  });
});
