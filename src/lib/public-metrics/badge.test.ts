import { describe, expect, it } from "vitest";

import { achievementBadgeContent, badgeContent, escapeXml, RATE_LIMITED_BADGE, renderBadgeSvg, textWidth } from "./badge";
import type { PublishedAchievement, PublishedEngineMetric, PublishedValue } from "./published";

const AT = new Date("2026-11-05T12:00:00Z");

function metric(value: PublishedValue, overrides: Partial<PublishedEngineMetric> = {}): PublishedEngineMetric {
  return {
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
    value,
    ...overrides,
  };
}

const available = (overrides: Partial<Extract<PublishedValue, { status: "available" }>> = {}): PublishedValue => ({
  status: "available",
  value: 1204,
  text: "1,204 stars",
  atLeast: false,
  lastSyncedAt: AT,
  simulated: false,
  ...overrides,
});

describe("badgeContent", () => {
  it("shows the label, the value, and verified, with the whole sentence as its title", () => {
    expect(badgeContent(metric(available()))).toEqual({
      label: "GitHub stars",
      message: "1,204 verified",
      tone: "verified",
      title: "GitHub stars: 1,204 stars. Verified by DevMacro, last synced 2026-11-05 12:00 GMT.",
    });
  });

  it("marks a rounded value with + and keeps the full wording in the title", () => {
    const content = badgeContent(metric(available({ value: 1200, text: "at least 1,200 stars", atLeast: true }), { rounding: "hundreds" }));
    expect(content.message).toBe("1,200+ verified");
    expect(content.title).toContain("at least 1,200 stars");
  });

  it("never calls a simulated value verified (boundary: simulated beats provenance)", () => {
    const content = badgeContent(metric(available({ simulated: true })));
    expect(content).toMatchObject({ message: "1,204 simulated", tone: "simulated" });
    expect(content.title).toContain("Simulated data, not verified");
    expect(content.title).not.toContain("Verified by DevMacro");
  });

  it("formats a percent as a percent", () => {
    const content = badgeContent(
      metric(available({ value: 87, text: "87%" }), { metricId: "resend-quota-percent-month", unit: "percent", label: "Resend monthly quota used" }),
    );
    expect(content.message).toBe("87% verified");
  });

  it("says why there is no number, in a neutral color", () => {
    expect(badgeContent(metric({ status: "unavailable", reason: "not_enough_history", text: "Not enough history yet" }))).toMatchObject({
      label: "GitHub stars",
      message: "Not enough history yet",
      tone: "neutral",
    });
  });

  it("shows the same neutral Unpublished badge for anything not published (boundary: null)", () => {
    expect(badgeContent(null)).toEqual({
      label: "DevMacro",
      message: "Unpublished",
      tone: "neutral",
      title: "This metric is not published on DevMacro.",
    });
  });
});

describe("achievementBadgeContent (#413)", () => {
  const achievement: PublishedAchievement = {
    achievementId: "github.stars.1024",
    provider: "github",
    providerName: "GitHub",
    publicTitle: "Kilostar: 1,024 GitHub stars",
    earnedAt: AT,
    earnedPrecision: "instant",
    evidence: "crossed",
    threshold: 1024,
    publishedAt: AT,
  };

  it("labels the badge with a trophy and the provider and shows the public title, with when it was earned in its title", () => {
    expect(achievementBadgeContent(achievement)).toEqual({
      label: "🏆 GitHub",
      message: "Kilostar: 1,024 GitHub stars",
      tone: "achievement",
      title: "GitHub achievement on DevMacro: Kilostar: 1,024 GitHub stars. Earned 2026-11-05 12:00 GMT.",
    });
  });

  it("never claims the crossing when DevMacro only saw the value already past it", () => {
    expect(achievementBadgeContent({ ...achievement, evidence: "at_least" }).title).toBe(
      "GitHub achievement on DevMacro: Kilostar: 1,024 GitHub stars. Recorded at least 1,024 on 2026-11-05 12:00 GMT.",
    );
  });

  it("shows the metric's neutral Unpublished badge for anything not published (boundary: null)", () => {
    const unpublished = achievementBadgeContent(null);
    expect(unpublished).toMatchObject({ label: "DevMacro", message: "Unpublished", tone: "neutral" });
    expect(renderBadgeSvg(unpublished)).toBe(renderBadgeSvg({ ...badgeContent(null), title: unpublished.title }));
  });
});

describe("renderBadgeSvg", () => {
  it("is an image with a title and no script, link, or external reference", () => {
    const svg = renderBadgeSvg(badgeContent(metric(available())));
    expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    expect(svg).toContain('role="img"');
    expect(svg).toContain("<title>GitHub stars: 1,204 stars. Verified by DevMacro, last synced 2026-11-05 12:00 GMT.</title>");
    expect(svg).not.toMatch(/<script|<a\b|href=|<image|<foreignObject|on[a-z]+=/i);
  });

  it("escapes every string, so a label can never inject markup (boundary: hostile text)", () => {
    const svg = renderBadgeSvg({ label: `<script>alert("x")</script>`, message: "a & b", tone: "neutral", title: "'quoted'" });
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(svg).toContain("a &amp; b");
    expect(svg).toContain("&apos;quoted&apos;");
  });

  it("is wider for a longer message", () => {
    const width = (svg: string) => Number(/width="(\d+)"/.exec(svg)?.[1]);
    expect(width(renderBadgeSvg(RATE_LIMITED_BADGE))).toBeGreaterThan(
      width(renderBadgeSvg({ ...RATE_LIMITED_BADGE, message: "Short" })),
    );
  });
});

describe("textWidth and escapeXml", () => {
  it("measures nothing as zero and wide letters wider than narrow ones", () => {
    expect(textWidth("")).toBe(0);
    expect(textWidth("mmm")).toBeGreaterThan(textWidth("iii"));
  });

  it("gives an emoji the room of a wide letter, so the trophy in a label never overflows its half", () => {
    expect(textWidth("🏆")).toBeGreaterThan(textWidth("W"));
    // The presentation selector draws nothing of its own.
    expect(textWidth("⚠️")).toBe(textWidth("⚠"));
  });

  it("leaves plain text alone", () => {
    expect(escapeXml("GitHub stars 1,204")).toBe("GitHub stars 1,204");
  });
});
