import { beforeEach, describe, expect, it, vi } from "vitest";

import { achievementEventDedupeKey } from "./events";
import {
  achievementEarnedText,
  achievementEvidenceText,
  groupAchievementsByProvider,
  loadProjectAchievements,
  loadTimelineAchievements,
  type ProjectAchievement,
} from "./private";

/*
 * What members read about earned achievements (#413): the dates and evidence the Achievements
 * section prints, its grouping, and the timeline's lookup of the achievements behind a page of
 * entries. The query builder answers per table with whatever the test seeds.
 */

type Result = { data: unknown; error: { message: string } | null };

const { results } = vi.hoisted(() => ({ results: new Map<string, Result>() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from(table: string) {
      const builder = {
        then(resolve: (value: Result) => unknown, reject: (reason: unknown) => unknown) {
          return Promise.resolve(results.get(table) ?? { data: [], error: null }).then(resolve, reject);
        },
      };
      for (const method of ["select", "eq", "in", "order", "limit"]) {
        Object.assign(builder, { [method]: () => builder });
      }
      return builder;
    },
  }),
}));

const WORKSPACE = { id: "41300000-0000-4000-8000-000000000001", slug: "acme", handle: null };
const WEB = "41300000-0000-4000-8000-000000000002";
const API = "41300000-0000-4000-8000-000000000003";

function achievement(overrides: Partial<ProjectAchievement>): ProjectAchievement {
  return {
    id: "vercel.deployments.10",
    provider: "vercel",
    providerName: "Vercel",
    title: "10 Vercel deployments recorded",
    publicTitle: "10 Vercel deployments recorded",
    description: "The 10th deployment DevMacro recorded.",
    earnedAt: "2026-07-01T23:30:00+00:00",
    earnedPrecision: "instant",
    evidence: "crossed",
    threshold: null,
    published: false,
    ...overrides,
  };
}

beforeEach(() => {
  results.clear();
});

describe("achievementEarnedText", () => {
  it("dates an event or reading in London time, which can be the next day", () => {
    // 23:30 UTC in July is 00:30 BST on the 2nd.
    expect(achievementEarnedText(achievement({ earnedAt: "2026-07-01T23:30:00+00:00" }))).toBe("2026-07-02 00:30 BST");
  });

  it("dates a daily total to its day, with no time and no shift to London", () => {
    // Stored at the start of its UTC day; read in London it would be 01:00 BST on the same day,
    // and a negative offset would pull it into the day before.
    expect(achievementEarnedText(achievement({ earnedAt: "2026-07-02T00:00:00+00:00", earnedPrecision: "day" }))).toBe(
      "2026-07-02",
    );
  });
});

describe("achievementEvidenceText", () => {
  it("says how a crossed achievement is earned", () => {
    expect(achievementEvidenceText(achievement({}))).toBe("The 10th deployment DevMacro recorded.");
  });

  it("claims only the reading DevMacro saw when the first one was already past the threshold", () => {
    expect(achievementEvidenceText(achievement({ evidence: "at_least", threshold: 1024 }))).toBe("Recorded at least 1,024");
  });
});

describe("groupAchievementsByProvider", () => {
  it("groups by provider name and keeps each group's order", () => {
    const groups = groupAchievementsByProvider([
      achievement({ id: "vercel.deployments.first", earnedAt: "2026-01-01T00:00:00Z" }),
      achievement({ id: "github.stars.10", provider: "github", providerName: "GitHub", earnedAt: "2026-02-01T00:00:00Z" }),
      achievement({ id: "vercel.deployments.10", earnedAt: "2026-03-01T00:00:00Z" }),
    ]);
    expect(groups.map((group) => [group.providerName, group.achievements.map((item) => item.id)])).toEqual([
      ["GitHub", ["github.stars.10"]],
      ["Vercel", ["vercel.deployments.first", "vercel.deployments.10"]],
    ]);
  });
});

describe("loadProjectAchievements", () => {
  it("reads publication from the joined row", async () => {
    results.set("project_achievements", {
      data: [
        {
          achievement_id: "github.stars.1024",
          provider: "github",
          title: "Kilostar: 1,024 GitHub stars",
          public_title: "1,024 GitHub stars",
          description: "The first stored count of 1,024 stars or more.",
          earned_at: "2026-11-01T09:00:00+00:00",
          earned_precision: "instant",
          evidence: "at_least",
          threshold: 1024,
          project_achievement_publications: { project_achievement_id: "41300000-0000-4000-8000-000000000010" },
        },
        {
          achievement_id: "github.stars.10",
          provider: "github",
          title: "10 GitHub stars",
          public_title: "10 GitHub stars",
          description: "The first stored count of 10 stars or more.",
          earned_at: "2026-11-01T09:00:00+00:00",
          earned_precision: "instant",
          evidence: "at_least",
          threshold: 10,
          project_achievement_publications: null,
        },
      ],
      error: null,
    });
    const loaded = await loadProjectAchievements(WORKSPACE.id, WEB);
    expect(loaded.map((item) => [item.id, item.providerName, item.published])).toEqual([
      ["github.stars.1024", "GitHub", true],
      ["github.stars.10", "GitHub", false],
    ]);
  });
});

describe("loadTimelineAchievements", () => {
  function row(projectId: string, achievementId: string, pages: { slug: string; enabled: boolean }[]) {
    return {
      project_id: projectId,
      achievement_id: achievementId,
      provider: "vercel",
      public_title: "10 Vercel deployments recorded",
      project_achievement_publications: null,
      projects: { name: projectId === WEB ? "Acme web" : "Acme API", project_pages: pages },
    };
  }

  it("matches each entry to its own project's achievement, not another project's with the same id", async () => {
    // The read filters projects and ids separately, so it can return API's achievement too.
    results.set("project_achievements", {
      data: [
        row(WEB, "vercel.deployments.10", [{ slug: "web", enabled: true }]),
        row(API, "vercel.deployments.10", []),
        row(API, "vercel.deployments.first", [{ slug: "api", enabled: false }]),
      ],
      error: null,
    });
    const found = await loadTimelineAchievements(WORKSPACE, [
      { projectId: WEB, achievementId: "vercel.deployments.10" },
      { projectId: API, achievementId: "vercel.deployments.first" },
    ]);
    expect([...found.keys()].sort()).toEqual(
      [achievementEventDedupeKey(WEB, "vercel.deployments.10"), achievementEventDedupeKey(API, "vercel.deployments.first")].sort(),
    );
    expect(found.get(achievementEventDedupeKey(WEB, "vercel.deployments.10"))).toMatchObject({
      projectName: "Acme web",
      href: `/w/acme/projects/${WEB}/achievements#vercel.deployments.10`,
      projectPage: { path: "/@acme/web", projectName: "Acme web" },
    });
    // A page that is off gives the share dialog no page to link to.
    expect(found.get(achievementEventDedupeKey(API, "vercel.deployments.first"))?.projectPage).toBeNull();
  });

  it("reads nothing for a page with no achievement entries", async () => {
    results.set("project_achievements", { data: null, error: { message: "must not be read" } });
    expect((await loadTimelineAchievements(WORKSPACE, [])).size).toBe(0);
  });
});
