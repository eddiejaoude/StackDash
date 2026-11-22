import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/auth/session";
import type { WorkspaceMembership } from "@/lib/data/workspaces";
import type { WorkspaceRole } from "@/lib/workspaces/permissions";

import { createApiKey, revokeApiKey } from "./actions";

/*
 * Creating and revoking an API key (#162) through the real `requireWorkspaceAction` and role matrix
 * (#603): only the signed-in user and their membership row, the layers under it, are stubbed, so a
 * viewer or a non-member creating or revoking a key is a failing test here, not a mocked pass.
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

type GuardedAction = (previous: null, formData: FormData) => Promise<unknown>;

// Every API key action, with a form that passes its schema, so the role check is the only thing
// left to refuse it, and the message each answers with when the database then fails.
const GUARDED: ReadonlyArray<readonly [string, GuardedAction, ReadonlyArray<readonly [string, string]>, string]> = [
  [
    "createApiKey",
    createApiKey,
    [
      ["name", "Deploy script"],
      ["scope", "usage:read"],
    ],
    "The key could not be created. Try again in a moment.",
  ],
  ["revokeApiKey", revokeApiKey, [["keyId", KEY_ID]], "The key could not be revoked. Try again in a moment."],
];

function form(fields: ReadonlyArray<readonly [string, string]>): FormData {
  const data = new FormData();
  data.set("workspace", "acme");
  for (const [name, value] of fields) data.append(name, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
});

describe("API key actions and the role matrix (#603)", () => {
  it.each(GUARDED)("%s refuses a viewer with the reason, before reading or changing any key", async (_name, action, fields) => {
    memberAs("viewer");
    expect(await action(null, form(fields))).toEqual({ ok: false, message: "Only owners and admins can create, see, or revoke API keys." });
    expect(mocks.getWorkspaceMembership).toHaveBeenCalledExactlyOnceWith(USER.id, "acme");
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it.each(GUARDED)("%s answers a non-member not found, the same as a workspace that does not exist", async (_name, action, fields) => {
    mocks.getWorkspaceMembership.mockResolvedValue(null);
    await expect(action(null, form(fields))).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  // The control that keeps the two refusals above honest: the same forms get past the check for an
  // admin and an owner, and go on to the workspace's keys (here, in a database that fails).
  it.each(GUARDED.flatMap(([name, action, fields, message]) => (["admin", "owner"] as const).map((role) => [name, role, action, fields, message] as const)))(
    "%s lets an %s through to the workspace's keys",
    async (_name, role, action, fields, message) => {
      memberAs(role);
      mocks.createClient.mockRejectedValue(new Error("database unreachable"));
      expect(await action(null, form(fields))).toEqual({ ok: false, message, referenceId: "ref-603" });
      expect(mocks.createClient).toHaveBeenCalledTimes(1);
    },
  );
});
