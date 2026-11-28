import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/auth/session";
import type { WorkspaceMembership } from "@/lib/data/workspaces";
import type { WorkspaceRole } from "@/lib/workspaces/permissions";

import { dismissChecklist } from "./actions";

/*
 * Hiding the Timeline's setup checklist (#674) through the real `requireWorkspace`: only the
 * signed-in user, their membership row, and the database client are stubbed, so who may hide it,
 * and whose row is written, are decided by the action itself.
 */

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn<(nextPath: string) => Promise<SessionUser>>(),
  getWorkspaceMembership: vi.fn<(userId: string, slug: string) => Promise<WorkspaceMembership | null>>(),
  createClient: vi.fn(),
  upsert: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/cache", () => ({ refresh: mocks.refresh }));
// `requireWorkspace` waits for the request first; a unit test has no request scope to wait for.
vi.mock("next/server", () => ({ connection: async () => {} }));
vi.mock("@/lib/auth/session", () => ({ requireUser: mocks.requireUser, getCurrentUser: vi.fn() }));
vi.mock("@/lib/data/workspaces", () => ({ getWorkspaceMembership: mocks.getWorkspaceMembership }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/log/logger", () => ({ logError: () => "ref-674" }));

const USER: SessionUser = { id: "67400000-0000-4000-8000-0000000000aa", email: "e2e-viewer@example.com", profile: { name: null, avatarUrl: null } };
const WORKSPACE: WorkspaceMembership["workspace"] = { id: "67400000-0000-4000-8000-000000000001", slug: "acme", name: "Acme", handle: null };
const OTHER_USER_ID = "67400000-0000-4000-8000-0000000000bb";

function memberAs(role: WorkspaceRole): void {
  mocks.getWorkspaceMembership.mockResolvedValue({ workspace: WORKSPACE, role });
}

function form(fields: Readonly<Record<string, string>>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) data.set(name, value);
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireUser.mockResolvedValue(USER);
  mocks.upsert.mockResolvedValue({ error: null });
  mocks.createClient.mockResolvedValue({ from: () => ({ upsert: mocks.upsert }) });
});

describe("dismissChecklist (#674)", () => {
  it("lets a viewer hide it, for the session's user and never one named in the form", async () => {
    memberAs("viewer");
    const result = await dismissChecklist(null, form({ workspace: "acme", user_id: OTHER_USER_ID }));
    expect(result).toEqual({ ok: true });
    expect(mocks.getWorkspaceMembership).toHaveBeenCalledExactlyOnceWith(USER.id, "acme");
    expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith(
      { workspace_id: WORKSPACE.id, user_id: USER.id },
      { onConflict: "workspace_id,user_id", ignoreDuplicates: true },
    );
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it("answers a non-member not found and writes nothing", async () => {
    mocks.getWorkspaceMembership.mockResolvedValue(null);
    await expect(dismissChecklist(null, form({ workspace: "acme" }))).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("answers a form without its workspace as out of date, before any session or database read", async () => {
    expect(await dismissChecklist(null, form({}))).toEqual({
      ok: false,
      message: "This form is out of date. Reload the page and try again.",
    });
    expect(mocks.requireUser).not.toHaveBeenCalled();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });

  it("returns the message with its reference id when the write fails, and does not refresh", async () => {
    memberAs("owner");
    mocks.upsert.mockResolvedValue({ error: { code: "57014", message: "canceling statement due to statement timeout" } });
    expect(await dismissChecklist(null, form({ workspace: "acme" }))).toEqual({
      ok: false,
      message: "The checklist could not be hidden. Try again in a moment.",
      referenceId: "ref-674",
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
