import { beforeEach, describe, expect, it, vi } from "vitest";

import { rememberWorkspace } from "./workspaces";

/*
 * How the deferred last-workspace write reports a failure (#614). Row level security refuses the
 * write with 42501 when the workspace was deleted, or the user left it, after the request: that is
 * expected and only warns. Anything else is still an error with a reference.
 */

type UpdateResult = { error: { code: string; message: string } | null };

const { state, warn, logError } = vi.hoisted(() => ({
  state: { result: { error: null } as UpdateResult, pending: [] as Array<() => Promise<void>> },
  warn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("next/server", () => ({
  after: (task: () => Promise<void>) => {
    state.pending.push(task);
  },
}));

vi.mock("@/lib/auth/session", () => ({
  getCurrentUser: async () => ({ id: "11111111-1111-4111-8111-111111111111" }),
}));

vi.mock("@/lib/log/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
  logError,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from() {
      const builder = {
        update: () => builder,
        eq: () => builder,
        or: () => Promise.resolve(state.result),
      };
      return builder;
    },
  }),
}));

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

async function remember(): Promise<void> {
  await rememberWorkspace(WORKSPACE_ID);
  for (const task of state.pending.splice(0)) await task();
}

beforeEach(() => {
  state.result = { error: null };
  state.pending = [];
  warn.mockClear();
  logError.mockClear();
});

describe("rememberWorkspace", () => {
  it("warns, not errors, when row level security refuses the write because the user is no longer a member", async () => {
    state.result = { error: { code: "42501", message: 'new row violates row-level security policy for table "profiles"' } };
    await remember();
    expect(logError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("workspaces.remember_skipped_not_member", { workspaceId: WORKSPACE_ID });
  });

  it("logs any other failure as an error", async () => {
    const error = { code: "08006", message: "connection failure" };
    state.result = { error };
    await remember();
    expect(warn).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith("workspaces.remember_failed", error, { workspaceId: WORKSPACE_ID });
  });

  it("logs nothing when the write succeeds", async () => {
    await remember();
    expect(warn).not.toHaveBeenCalled();
    expect(logError).not.toHaveBeenCalled();
  });
});
