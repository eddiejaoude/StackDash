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
