import { describe, expect, it } from "vitest";

import { declaredEventTypes } from "@/lib/adapters/registry";
import { SYNC_FAILED_TYPE_ID } from "@/lib/jobs/sync-connection";

import {
  eventCountLabel,
  heatCellLabel,
  heatEmptyLabel,
  heatGrid,
  heatMatch,
  heatmapWindowStart,
  heatSteps,
  peakRun,
  peakRunLabel,
  type HeatGrid,
  type HeatMatch,
} from "./heatmap";

const KNOWN = [...declaredEventTypes, { id: SYNC_FAILED_TYPE_ID }];

function typeIdsOf(match: HeatMatch): readonly string[] {
  if (match.kind === "every") throw new Error("expected a type list");
  return match.typeIds;
}

/** A 7 x 24 grid of zeros with the given cells set: `[day, hour, count]`, day 0 is Monday. */
function grid(cells: readonly (readonly [number, number, number])[] = []): number[][] {
  const rows = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const [day, hour, count] of cells) {
    const row = rows[day];
    if (row === undefined) throw new Error(`no day ${day}`);
    row[hour] = count;
  }
  return rows;
}

describe("heatMatch", () => {
  it("counts every event for all", () => {
    expect(heatMatch("all", KNOWN)).toEqual({ kind: "every" });
  });

  it("counts the deployments the adapters declare, finished or failed, and not a build that only started", () => {
    const ids = typeIdsOf(heatMatch("deploys", KNOWN));
    expect(ids).toEqual(
      expect.arrayContaining([
        "vercel.deployment.succeeded",
        "vercel.deployment.failed",
        "railway.deployment.deployed",
        "railway.deployment.failed",
        "gitlab.deployment.succeeded",
        "digitalocean.deployment.succeeded",
        "fake.deploy.succeeded",
      ]),
    );
    expect(ids).not.toContain("railway.deployment.building");
    expect(ids).not.toContain("gitlab.pipeline.succeeded");
    expect(heatMatch("deploys", KNOWN)).toMatchObject({ severities: [] });
  });

  it("counts one event per signup, and never a daily total", () => {
    const ids = typeIdsOf(heatMatch("signups", KNOWN));
    expect(ids).toEqual(expect.arrayContaining(["supabase.auth.signup", "fake.signup"]));
    expect(ids).not.toContain("supabase.auth.daily_summary");
    expect(ids).not.toContain("posthog.signups.daily");
  });

  it("counts critical events and every known type ending in failed, DevMacro's own included", () => {
    const match = heatMatch("failures", KNOWN);
    expect(match).toMatchObject({ kind: "some", severities: ["critical"] });
    const ids = typeIdsOf(match);
    expect(ids).toEqual(
      expect.arrayContaining([
        "vercel.deployment.failed",
        "stripe.charge.failed",
        "resend.domain.failed",
        "gitlab.pipeline.failed",
        "digitalocean.droplet.action_failed",
        SYNC_FAILED_TYPE_ID,
      ]),
    );
    expect(ids.every((id) => id.endsWith("failed"))).toBe(true);
  });

  it("boundary: a group no known type falls in stays a group of nothing, never every event", () => {
    expect(heatMatch("deploys", [])).toEqual({ kind: "some", typeIds: [], severities: [] });
    expect(heatMatch("failures", [])).toEqual({ kind: "some", typeIds: [], severities: ["critical"] });
  });

  it("boundary: a type declared twice is listed once", () => {
    const twice = [
      { id: "vercel.deployment.failed", category: "deploy_failed" as const },
      { id: "vercel.deployment.failed", category: "deploy_failed" as const },
    ];
    expect(typeIdsOf(heatMatch("deploys", twice))).toEqual(["vercel.deployment.failed"]);
    expect(typeIdsOf(heatMatch("failures", twice))).toEqual(["vercel.deployment.failed"]);
  });
});

describe("heatmapWindowStart", () => {
  it("starts exactly 30 days of 24 hours before now", () => {
    expect(heatmapWindowStart(new Date("2026-03-31T10:15:00.000Z"))).toBe("2026-03-01T10:15:00.000Z");
  });
});

describe("heatGrid", () => {
  it("places isodow 1 on Monday's row and isodow 7 on Sunday's, every other cell zero", () => {
    const result = heatGrid([
      { isodow: 1, hour: 0, events: 2 },
      { isodow: 7, hour: 23, events: 5 },
    ]);
    expect(result).toEqual(
      grid([
        [0, 0, 2],
        [6, 23, 5],
      ]),
    );
  });

  it("boundary: no rows is a full grid of zeros", () => {
    expect(heatGrid([])).toEqual(grid());
  });

  it.each([
    { isodow: 0, hour: 0 },
    { isodow: 8, hour: 0 },
    { isodow: 1, hour: -1 },
    { isodow: 1, hour: 24 },
  ])("boundary: rejects a row outside the week (isodow $isodow, hour $hour)", (row) => {
    expect(() => heatGrid([{ ...row, events: 1 }])).toThrow("out of range");
  });
});

describe("heatSteps", () => {
  it("boundary: all zero is step 0 everywhere", () => {
    expect(heatSteps(grid()).flat().every((step) => step === 0)).toBe(true);
  });

  it("boundary: a single non-zero cell is the busiest, so it takes the top step alone", () => {
    const steps = heatSteps(grid([[4, 15, 1]]));
    expect(steps[4]?.[15]).toBe(4);
    expect(steps.flat().filter((step) => step !== 0)).toEqual([4]);
  });

  it("boundary: a uniform grid puts every cell on the same step, the top one", () => {
    const uniform: HeatGrid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 3));
    expect(new Set(heatSteps(uniform).flat())).toEqual(new Set([4]));
  });

  it("one extreme outlier takes the top step without washing every other cell down to the first", () => {
    // Counts 1 to 10 across Monday to Wednesday, and one hour of 10,000 on Friday.
    const cells: [number, number, number][] = Array.from({ length: 30 }, (_, index) => [
      Math.floor(index / 10),
      index % 10,
      (index % 10) + 1,
    ]);
    const steps = heatSteps(grid([...cells, [4, 15, 10_000]]));
    expect(steps[4]?.[15]).toBe(4);
    const others = cells.map(([day, hour]) => steps[day]?.[hour]);
    expect(new Set(others).size).toBeGreaterThanOrEqual(3);
    expect(steps[0]?.[0]).toBe(1);
  });

  it("gives the lowest count step 1, the highest step 4, and never a lower step to a higher count", () => {
    const counts = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
    const steps = heatSteps(grid(counts.map((count, hour) => [0, hour, count])));
    const monday = counts.map((_, hour) => steps[0]?.[hour] ?? 0);
    expect(monday[0]).toBe(1);
    expect(monday.at(-1)).toBe(4);
    expect(monday).toEqual([...monday].sort((a, b) => a - b));
  });

  it("boundary: equal counts share a step, and two distinct counts are the two ends of the scale", () => {
    const steps = heatSteps(
      grid([
        [0, 0, 2],
        [3, 5, 2],
        [6, 23, 9],
      ]),
    );
    expect(steps[0]?.[0]).toBe(1);
    expect(steps[3]?.[5]).toBe(1);
    expect(steps[6]?.[23]).toBe(4);
  });
});

describe("peakRun", () => {
  const runOf = (cells: readonly (readonly [number, number, number])[]) => {
    const counts = grid(cells);
    return peakRun(counts, heatSteps(counts));
  };

  it("boundary: no events has no peak", () => {
    expect(runOf([])).toBeNull();
  });

  // Monday 00:00 to 11:00 holding 1 to 12 events: twelve low counts, so the busy hours below rank
  // at the top of the scale, as they would in a month of real activity.
  const background: [number, number, number][] = Array.from({ length: 12 }, (_, hour) => [0, hour, hour + 1]);

  it("finds the adjacent top step hours on one day, and sums their events", () => {
    const run = runOf([...background, [4, 14, 3], [4, 15, 20], [4, 16, 22], [4, 17, 4]]);
    expect(run).toEqual({ day: 4, startHour: 15, endHour: 17, events: 42, tiedWith: 0 });
  });

  it("picks the run holding the most events, not the one with the single busiest hour", () => {
    // Two top step runs: Tuesday 10:00 alone (30), and Thursday 08:00 to 11:00 (28 + 29 + 29).
    const run = runOf([...background, [1, 10, 30], [3, 8, 28], [3, 9, 29], [3, 10, 29]]);
    expect(run).toEqual({ day: 3, startHour: 8, endHour: 11, events: 86, tiedWith: 0 });
  });

  it("boundary: a run never wraps past midnight into the next day's row", () => {
    const run = runOf([
      [0, 22, 1],
      [0, 23, 9],
      [1, 0, 9],
    ]);
    expect(run).toEqual({ day: 0, startHour: 23, endHour: 24, events: 9, tiedWith: 1 });
  });

  it("boundary: on a tie returns the earliest run and counts the others", () => {
    const run = runOf([
      [0, 0, 1],
      [2, 5, 7],
      [5, 18, 7],
    ]);
    expect(run).toEqual({ day: 2, startHour: 5, endHour: 6, events: 7, tiedWith: 1 });
  });

  it("boundary: a uniform grid is seven whole day runs tied with each other", () => {
    const uniform: HeatGrid = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 1));
    expect(peakRun(uniform, heatSteps(uniform))).toEqual({ day: 0, startHour: 0, endHour: 24, events: 24, tiedWith: 6 });
  });
});

describe("wording", () => {
  it("labels a cell with its day, hour, and count", () => {
    expect(heatCellLabel(4, 15, 42)).toBe("Fri 15:00, 42 events");
    expect(heatCellLabel(6, 0, 0)).toBe("Sun 00:00, 0 events");
  });

  it("boundary: one event is singular, and thousands are grouped", () => {
    expect(eventCountLabel(1)).toBe("1 event");
    expect(eventCountLabel(1204)).toBe("1,204 events");
  });

  it("names the peak by its first hour and the hour after its last", () => {
    expect(peakRunLabel({ day: 4, startHour: 15, endHour: 17, events: 42, tiedWith: 0 })).toBe("Fri 15:00 to 17:00 · 42 events");
    expect(peakRunLabel({ day: 6, startHour: 23, endHour: 24, events: 1, tiedWith: 2 })).toBe(
      "Sun 23:00 to 24:00 · 1 event, tied with 2 other runs",
    );
  });

  it("says which events are missing in the empty state", () => {
    expect(heatEmptyLabel("all")).toBe("No events in the last 30 days");
    expect(heatEmptyLabel("failures")).toBe("No failure events in the last 30 days");
  });
});
