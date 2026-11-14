import { isValidElement, type CSSProperties, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { AchievementCard, MetricCard, trendPath, YearSlideCard } from "./card-image";
import { MemoryMetricStore } from "./memory-store";
import type { PublishedAchievement, PublishedMetricCard } from "./published";
import { computeYearReview, yearSlides } from "./yearly";

describe("trendPath", () => {
  it("draws from the oldest point on the left to the newest on the right, higher values higher up", () => {
    expect(trendPath([0, 5, 10], 100, 50)).toBe("M0 45 L50 25 L100 5");
  });

  it("breaks the line at a missing day instead of drawing across the gap", () => {
    expect(trendPath([0, null, 10, 10], 90, 50)).toBe("M0 45 M60 5 L90 5");
  });

  it("draws a flat series at mid height (boundary: no change at all)", () => {
    expect(trendPath([7, 7, 7], 100, 50)).toBe("M0 25 L50 25 L100 25");
  });

  it.each([
    ["no points", []],
    ["one point", [3]],
    ["one known point among gaps", [null, 3, null]],
    ["only gaps", [null, null]],
  ])("draws nothing for %s, since that is not a trend", (_title, values) => {
    expect(trendPath(values, 100, 50)).toBeNull();
  });
});

const AT = new Date("2026-11-05T12:00:00Z");

const CARD: PublishedMetricCard = {
  metric: {
    kind: "engine",
    publicationId: "80000000-0000-4000-8000-000000000001",
    metricId: "github-stars",
    providers: ["github"],
    label: "GitHub stars",
    unit: "stars",
    provenance: "verified",
    formulaPath: "/docs/architecture/public-metrics#github-stars",
    rounding: "exact",
    delayDays: 0,
    publishedAt: AT,
    asOf: AT,
    value: { status: "available", value: 1204, text: "1,204 stars", atLeast: false, lastSyncedAt: AT, simulated: false },
  },
  trend: [
    { at: new Date(AT.getTime() - 86_400_000), value: 1198 },
    { at: AT, value: 1204 },
  ],
};

type DrawnText = Readonly<{ text: string; style: CSSProperties; color: string; background: string }>;

/**
 * Every string the card draws, with its own style and the color and background it inherits, by
 * calling each component the way the renderer does. Satori lays out these same elements.
 */
function drawnText(node: ReactNode, inherited = { color: "", background: "" }): DrawnText[] {
  if (Array.isArray(node)) return node.flatMap((child: ReactNode) => drawnText(child, inherited));
  if (!isValidElement<{ style?: CSSProperties; children?: ReactNode }>(node)) return [];
  if (typeof node.type === "function") {
    const render = node.type as (props: unknown) => ReactNode;
    return drawnText(render(node.props), inherited);
  }
  const style = node.props.style ?? {};
  const own = {
    color: typeof style.color === "string" ? style.color : inherited.color,
    background: typeof style.backgroundColor === "string" ? style.backgroundColor : inherited.background,
  };
  const { children } = node.props;
  if (typeof children === "string") return [{ text: children, style, ...own }];
  return drawnText(children, own);
}

/** WCAG 2.2 contrast ratio of two `#rrggbb` colors (https://www.w3.org/TR/WCAG22/#dfn-contrast-ratio). */
function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const [r = 0, g = 0, b = 0] = [1, 3, 5].map((start) => {
      const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light = 0, dark = 0] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

describe("MetricCard", () => {
  it.each([
    ["a short name", "Acme web"],
    // Boundary: the longest name a project can have (projects_name_length allows 80 characters).
    ["the longest name", "W".repeat(80)],
    ["a name in another script", "Ünïcødé プロジェクト"],
  ])("names the project on one line that ends in an ellipsis, at 4.5:1 contrast or more: %s", (_title, name) => {
    const drawn = drawnText(MetricCard({ card: CARD, projectName: name })).filter((entry) => entry.text === name);
    expect(drawn).toHaveLength(1);
    const [line] = drawn;
    expect(line?.style).toMatchObject({ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" });
    expect(line?.color).toMatch(/^#[0-9a-f]{6}$/);
    expect(line?.background).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastRatio(line?.color ?? "", line?.background ?? "")).toBeGreaterThanOrEqual(4.5);
  });

  it("draws no project name while the project page is not public (boundary: null)", () => {
    const without = drawnText(MetricCard({ card: CARD, projectName: null })).map((entry) => entry.text);
    const named = drawnText(MetricCard({ card: CARD, projectName: "Acme web" })).map((entry) => entry.text);
    expect(without).toContain("GitHub stars");
    expect(without).not.toContain("Acme web");
    expect(named.filter((text) => text !== "Acme web")).toEqual(without);
  });
});

describe("AchievementCard (#413)", () => {
  const achievement: PublishedAchievement = {
    achievementId: "posthog.signups.100",
    provider: "posthog",
    providerName: "PostHog",
    publicTitle: "100 PostHog signups recorded",
    earnedAt: new Date("2026-11-04T00:00:00Z"),
    earnedPrecision: "day",
    evidence: "crossed",
    threshold: 100,
    publishedAt: AT,
  };

  it("draws the project, provider, public title, and earned day, every word at 4.5:1 contrast or more", () => {
    const drawn = drawnText(AchievementCard({ achievement, projectName: "Acme web" }));
    expect(drawn.map((entry) => entry.text)).toEqual(
      expect.arrayContaining(["Acme web", "PostHog achievement", "100 PostHog signups recorded", "Earned 2026-11-04", "Achievement earned"]),
    );
    for (const entry of drawn) expect(contrastRatio(entry.color, entry.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("draws no project name while the project page is not public (boundary: null)", () => {
    const without = drawnText(AchievementCard({ achievement, projectName: null })).map((entry) => entry.text);
    expect(without).toContain("100 PostHog signups recorded");
    expect(without).not.toContain("Acme web");
  });
});

describe("YearSlideCard", () => {
  it("draws each slide's title, value, and detail, the value on one line, every word at 4.5:1 contrast or more", async () => {
    const review = await computeYearReview(
      new MemoryMetricStore(
        [{ accountId: "vercel-acct", provider: "vercel", connectionCreatedAt: new Date("2025-12-01T00:00:00Z"), lastSyncedAt: AT, simulated: true }],
        [],
        [{ accountId: "vercel-acct", typeId: "vercel.deployment.succeeded", occurredAt: new Date("2026-03-04T10:00:00Z") }],
      ),
      2026,
      AT,
    );
    const slides = yearSlides(review).flatMap((slide) => (slide.id === "totals" ? [] : [slide]));
    expect(slides).toHaveLength(3);
    for (const slide of slides) {
      const drawn = drawnText(YearSlideCard({ summary: review.summary, slide }));
      expect(drawn.map((entry) => entry.text)).toEqual(
        expect.arrayContaining([`${slide.title}, 2026 so far`, slide.value, slide.detail, "Year to date", "Simulated data, not verified"]),
      );
      expect(drawn.find((entry) => entry.text === slide.value)?.style).toMatchObject({ whiteSpace: "nowrap", textOverflow: "ellipsis" });
      for (const entry of drawn) expect(contrastRatio(entry.color, entry.background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
