import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionUser } from "@/lib/auth/session";
import type { WorkspaceMembership } from "@/lib/data/workspaces";

import { isWorkspaceMember } from "./access";

const { getCurrentUser, getWorkspaceMembership } = vi.hoisted(() => ({
  getCurrentUser: vi.fn<() => Promise<SessionUser | null>>(),
  getWorkspaceMembership: vi.fn<(userId: string, slug: string) => Promise<WorkspaceMembership | null>>(),
}));
vi.mock("@/lib/auth/session", () => ({ getCurrentUser, requireUser: vi.fn() }));
vi.mock("@/lib/data/workspaces", () => ({ getWorkspaceMembership }));

const USER: SessionUser = { id: "10000000-0000-4000-8000-000000000001", email: null, profile: { name: null, avatarUrl: null } };
const MEMBERSHIP: WorkspaceMembership = {
  workspace: { id: "20000000-0000-4000-8000-000000000001", slug: "acme", name: "Acme", handle: null },
  role: "viewer",
};

describe("isWorkspaceMember", () => {
  beforeEach(() => {
    getCurrentUser.mockReset().mockResolvedValue(USER);
    getWorkspaceMembership.mockReset().mockResolvedValue(MEMBERSHIP);
  });

  it("is true for a member, asked about their user and the slug", async () => {
    await expect(isWorkspaceMember("acme")).resolves.toBe(true);
    expect(getWorkspaceMembership).toHaveBeenCalledWith(USER.id, "acme");
  });

  it("is false for a non-member and for a workspace that does not exist, which read alike", async () => {
    getWorkspaceMembership.mockResolvedValue(null);
    await expect(isWorkspaceMember("acme")).resolves.toBe(false);
  });

  it("is false when signed out, without redirecting or reading a membership", async () => {
    getCurrentUser.mockResolvedValue(null);
    await expect(isWorkspaceMember("acme")).resolves.toBe(false);
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["uppercase", "Acme"],
    ["a path", "acme/connections"],
    ["longer than 64 characters", "a".repeat(65)],
  ])("is false for a slug that is %s, before any read", async (_label, slug) => {
    await expect(isWorkspaceMember(slug)).resolves.toBe(false);
    expect(getCurrentUser).not.toHaveBeenCalled();
    expect(getWorkspaceMembership).not.toHaveBeenCalled();
  });
});
