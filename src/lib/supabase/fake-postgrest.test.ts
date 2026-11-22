import { describe, expect, it } from "vitest";

import { fakeSupabase } from "./fake-postgrest";

const typeIds = ["github.stars.milestone", "github.stars.daily", "github.starsXdaily", "stripe.payment.succeeded"];

async function like(pattern: string): Promise<string[]> {
  const { db } = fakeSupabase({ activity_events: typeIds.map((type_id) => ({ type_id })) });
  const { data, error } = await db.from("activity_events").select("type_id").like("type_id", pattern);
  if (error) throw new Error(error.message);
  return data.map((row) => row.type_id);
}

describe("fakeSupabase like", () => {
  it("matches any run with PostgREST's `*` (happy path)", async () => {
    expect(await like("github.stars.*")).toEqual(["github.stars.milestone", "github.stars.daily"]);
  });

  it("matches any run with Postgres's `%`, as PostgREST passes it through (boundary: `%`)", async () => {
    expect(await like("%.payment.%")).toEqual(["stripe.payment.succeeded"]);
  });

  it("matches exactly one character with `_`, and a `.` only itself (boundary: `_` and `.`)", async () => {
    expect(await like("github.stars_daily")).toEqual(["github.stars.daily", "github.starsXdaily"]);
    expect(await like("github.stars.dail")).toEqual([]);
    expect(await like("github.stars.dail_")).toEqual(["github.stars.daily"]);
  });
});

describe("fakeSupabase update", () => {
  const rows = [
    { connection_id: "a", key_id: "old" },
    { connection_id: "b", key_id: "old" },
  ];

  it("applies the update to the matching rows only and answers them with the selected columns (happy path)", async () => {
    const { db, tables } = fakeSupabase({ connection_credentials: rows });
    const { data, error } = await db.from("connection_credentials").update({ key_id: "new" }).eq("connection_id", "a").select("connection_id");
    if (error) throw new Error(error.message);
    expect(data).toEqual([{ connection_id: "a" }]);
    expect(tables.connection_credentials).toEqual([
      { connection_id: "a", key_id: "new" },
      { connection_id: "b", key_id: "old" },
    ]);
  });

  it("answers no rows when no row matches, and never writes to the caller's arrays (boundary: compare-and-set miss)", async () => {
    const { db, tables } = fakeSupabase({ connection_credentials: rows });
    const { data, error } = await db
      .from("connection_credentials")
      .update({ key_id: "new" })
      .eq("connection_id", "a")
      .eq("key_id", "gone")
      .select("connection_id");
    if (error) throw new Error(error.message);
    expect(data).toEqual([]);
    await db.from("connection_credentials").update({ key_id: "new" }).eq("connection_id", "b");
    expect(tables.connection_credentials).toEqual([
      { connection_id: "a", key_id: "old" },
      { connection_id: "b", key_id: "new" },
    ]);
    expect(rows).toEqual([
      { connection_id: "a", key_id: "old" },
      { connection_id: "b", key_id: "old" },
    ]);
  });

  it("lets `intercept` answer a request instead of the fake (boundary: injected Postgres error)", async () => {
    const { db, tables } = fakeSupabase({ connection_credentials: rows }, {}, (request) =>
      request.method === "PATCH" ? new Response(JSON.stringify({ code: "57014", message: "canceled", details: null, hint: null }), { status: 500 }) : undefined,
    );
    const { error } = await db.from("connection_credentials").update({ key_id: "new" }).eq("connection_id", "a").select("connection_id");
    expect(error?.code).toBe("57014");
    expect(tables.connection_credentials).toEqual(rows);
  });
});

describe("fakeSupabase cs", () => {
  const connections = [
    { id: "both", granted_scopes: ["simulated:read", "usage:read"] },
    { id: "simulated", granted_scopes: ["simulated:read"] },
    { id: "none", granted_scopes: [] },
    { id: "null", granted_scopes: null },
  ];

  async function containing(scopes: string[]): Promise<string[]> {
    const { db } = fakeSupabase({ connections });
    const { data, error } = await db.from("connections").select("id").contains("granted_scopes", scopes);
    if (error) throw new Error(error.message);
    return data.map((row) => row.id);
  }

  it("matches an array column holding the one value (happy path)", async () => {
    expect(await containing(["simulated:read"])).toEqual(["both", "simulated"]);
  });

  it("matches only an array holding every listed value, in any order (boundary: several values)", async () => {
    expect(await containing(["simulated:read", "usage:read"])).toEqual(["both"]);
    expect(await containing(["usage:read", "simulated:read"])).toEqual(["both"]);
    expect(await containing(["simulated:read", "billing:read"])).toEqual([]);
  });

  it("never matches a null cell, not even for no values, as Postgres's null `@>` is not true (boundary: null and empty)", async () => {
    expect(await containing([])).toEqual(["both", "simulated", "none"]);
    expect(await containing(["usage:read"])).toEqual(["both"]);
  });

  it("answers a one value `cs` inside `or`, and a several value one with 400 (boundary: logic list)", async () => {
    const { db } = fakeSupabase({ connections });
    const one = await db.from("connections").select("id").or("granted_scopes.cs.{usage:read},id.eq.none");
    if (one.error) throw new Error(one.error.message);
    expect(one.data.map((row) => row.id)).toEqual(["both", "none"]);
    const several = await db.from("connections").select("id").or("granted_scopes.cs.{simulated:read,usage:read},id.eq.none");
    expect(several.status).toBe(400);
    expect(several.data).toBeNull();
  });
});
