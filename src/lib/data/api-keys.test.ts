import { beforeEach, describe, expect, it, vi } from "vitest";

import { API_KEYS_LIST_LIMIT, listApiKeys } from "./api-keys";

/*
 * Which members listApiKeys asks for when it labels keys whose creator left (#162). The query
 * builder is replaced by one that records every call and answers per table, so the test pins the
 * request (only this page's creators) and the label that follows from the answer.
 */

type Call = { table: string; method: string; args: unknown[] };
type Result = { data: unknown[] | null; error: { message: string } | null };

const { calls, results } = vi.hoisted(() => ({
  calls: [] as Call[],
  results: new Map<string, Result>(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      const builder = {
        then(resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve(results.get(table) ?? { data: [], error: null }).then(resolve, reject);
        },
      };
      for (const method of ["select", "eq", "order", "limit", "in"]) {
        Object.assign(builder, {
          [method]: (...args: unknown[]) => {
            calls.push({ table, method, args });
            return builder;
          },
        });
      }
      return builder;
    },
  }),
}));

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const MEMBER = "a1620000-0000-4000-8000-000000000001";
const LEFT = "a1620000-0000-4000-8000-000000000002";

function keyRow(index: number, createdBy: string | null) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `Key ${index}`,
    token_prefix: "sd_abcdefgh",
    scopes: ["usage:read"],
    created_by: createdBy,
    created_at: "2026-11-04T09:15:00+00:00",
    last_used_at: null,
    revoked_at: null,
  };
}

function memberQuery(): Call[] {
  return calls.filter((call) => call.table === "workspace_members");
}

beforeEach(() => {
  calls.length = 0;
  results.clear();
});

describe("listApiKeys", () => {
  it("asks only for the page's distinct creators and marks a key whose creator is not returned", async () => {
    results.set("api_keys", {
      data: [keyRow(1, MEMBER), keyRow(2, LEFT), keyRow(3, MEMBER), keyRow(4, null)],
      error: null,
    });
    results.set("workspace_members", { data: [{ user_id: MEMBER }], error: null });

    const list = await listApiKeys(WORKSPACE_ID);

    expect(memberQuery()).toEqual([
      { table: "workspace_members", method: "select", args: ["user_id"] },
      { table: "workspace_members", method: "eq", args: ["workspace_id", WORKSPACE_ID] },
      { table: "workspace_members", method: "in", args: ["user_id", [MEMBER, LEFT]] },
    ]);
    expect(list.keys.map((key) => [key.name, key.creator_left])).toEqual([
      ["Key 1", false],
      ["Key 2", true],
      ["Key 3", false],
      ["Key 4", true],
    ]);
    expect(list.hasMore).toBe(false);
    expect(list.keys[0]).not.toHaveProperty("created_by");
  });

  it("leaves out the creator of the extra row past the page, and skips the member read when no key has a creator", async () => {
    const page = Array.from({ length: API_KEYS_LIST_LIMIT }, (_, index) => keyRow(index, null));
    results.set("api_keys", { data: [...page, keyRow(API_KEYS_LIST_LIMIT, LEFT)], error: null });

    const list = await listApiKeys(WORKSPACE_ID);

    expect(list.keys).toHaveLength(API_KEYS_LIST_LIMIT);
    expect(list.hasMore).toBe(true);
    expect(list.keys.every((key) => key.creator_left)).toBe(true);
    expect(memberQuery()).toEqual([]);
  });

  it("fails loudly when the member read fails rather than labelling every key", async () => {
    results.set("api_keys", { data: [keyRow(1, MEMBER)], error: null });
    results.set("workspace_members", { data: null, error: { message: "boom" } });

    await expect(listApiKeys(WORKSPACE_ID)).rejects.toThrow("Failed to list workspace members for API keys");
  });
});
