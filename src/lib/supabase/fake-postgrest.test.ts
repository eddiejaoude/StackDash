import { describe, expect, it } from "vitest";

import { fakeSupabase } from "./fake-postgrest";

const typeIds = [
  "github.stars.milestone",
  "github.stars.daily",
  "github.starsXdaily",
  "stripe.payment.succeeded",
];

async function like(pattern: string): Promise<string[]> {
  const { db } = fakeSupabase({
    activity_events: typeIds.map((type_id) => ({ type_id })),
  });
  const { data, error } = await db
    .from("activity_events")
    .select("type_id")
    .like("type_id", pattern);
  if (error) throw new Error(error.message);
  return data.map((row) => row.type_id);
}

describe("fakeSupabase like", () => {
  it("matches any run with PostgREST's `*` (happy path)", async () => {
    expect(await like("github.stars.*")).toEqual([
      "github.stars.milestone",
      "github.stars.daily",
    ]);
  });

  it("matches any run with Postgres's `%`, as PostgREST passes it through (boundary: `%`)", async () => {
    expect(await like("%.payment.%")).toEqual(["stripe.payment.succeeded"]);
  });

  it("matches exactly one character with `_`, and a `.` only itself (boundary: `_` and `.`)", async () => {
    expect(await like("github.stars_daily")).toEqual([
      "github.stars.daily",
      "github.starsXdaily",
    ]);
    expect(await like("github.stars.dail")).toEqual([]);
    expect(await like("github.stars.dail_")).toEqual(["github.stars.daily"]);
  });
});
