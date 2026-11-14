import { describe, expect, it } from "vitest";

import {
  achievementBadgeAltText,
  achievementBadgePath,
  achievementCardAltText,
  achievementCardPath,
  achievementEarnedText,
  achievementIdFromFile,
  achievementShareLinks,
  badgeMarkdown,
  badgePath,
  cardAltText,
  cardPath,
  metricIdFromFile,
  metricShareLinks,
  shareText,
  shareToLinkedInUrl,
  shareToXUrl,
  type ShareableMetric,
} from "./share";

const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const AT = new Date("2026-11-05T12:00:00Z");

const stars: ShareableMetric = {
  label: "GitHub stars",
  text: "at least 1,200 stars",
  available: true,
  provenance: "verified",
  simulated: false,
  lastSyncedAt: AT,
};

describe("badge and card paths", () => {
  it("key both by project id and metric id, with the image type as the extension", () => {
    expect(badgePath(PROJECT_ID, "github-stars")).toBe(`/badge/${PROJECT_ID}/github-stars.svg`);
    expect(cardPath(PROJECT_ID, "vercel-deployments-30d")).toBe(`/card/${PROJECT_ID}/vercel-deployments-30d.png`);
  });
});

describe("metricIdFromFile", () => {
  it.each([
    ["github-stars.svg", "svg", "github-stars"],
    ["stripe-payments-30d.png", "png", "stripe-payments-30d"],
    // Boundaries: the other surface's extension, no extension, a doubled one, an unknown id, a
    // money id, and an empty segment are all not a metric.
    ["github-stars.png", "svg", null],
    ["github-stars", "svg", null],
    ["github-stars.svg.svg", "svg", null],
    ["github-spend-actions.svg", "svg", null],
    ["GitHub-Stars.svg", "svg", null],
    [".svg", "svg", null],
    ["", "png", null],
  ] as const)("%s as %s is %s", (file, extension, expected) => {
    expect(metricIdFromFile(file, extension)).toBe(expected);
  });
});

describe("share text", () => {
  it("writes the badge Markdown as an image linking to the given page", () => {
    expect(
      badgeMarkdown({
        badgeUrl: "https://stackdash.example.com/badge/p/github-stars.svg",
        linkUrl: "https://stackdash.example.com/docs/architecture/public-metrics#github-stars",
        label: "GitHub stars",
      }),
    ).toBe(
      "[![GitHub stars](https://stackdash.example.com/badge/p/github-stars.svg)](https://stackdash.example.com/docs/architecture/public-metrics#github-stars)",
    );
  });

  it("keeps brackets out of the Markdown alt text (boundary: a label that would end it early)", () => {
    expect(badgeMarkdown({ badgeUrl: "b", linkUrl: "f", label: "Stars [beta]" })).toBe("[![Stars beta](b)](f)");
  });

  it("describes the card with its value, provenance, sync time, and trend", () => {
    expect(cardAltText(stars, null)).toBe(
      "StackDash card. GitHub stars: at least 1,200 stars. Verified by StackDash, last synced 2026-11-05 12:00 GMT. With its trend over the last 30 days.",
    );
  });

  it("names the project in the card's alt text when the card shows it", () => {
    expect(cardAltText(stars, "Acme web")).toBe(
      "StackDash card for Acme web. GitHub stars: at least 1,200 stars. Verified by StackDash, last synced 2026-11-05 12:00 GMT. With its trend over the last 30 days.",
    );
  });

  it("describes a card with no number without a trend or a sync time", () => {
    expect(cardAltText({ ...stars, text: "Not connected", available: false, lastSyncedAt: null }, null)).toBe(
      "StackDash card. GitHub stars: Not connected.",
    );
  });

  it("never calls simulated data verified in a post", () => {
    expect(shareText({ ...stars, simulated: true }, null)).toBe("GitHub stars: at least 1,200 stars. Simulated data, not verified.");
    expect(shareText(stars, null)).toBe("GitHub stars: at least 1,200 stars. Verified by StackDash.");
  });

  it("names the project in a post when given one, with or without a number", () => {
    expect(shareText(stars, "Acme web")).toBe("GitHub stars for Acme web: at least 1,200 stars. Verified by StackDash.");
    expect(shareText({ ...stars, text: "Not connected", available: false, lastSyncedAt: null }, "Acme web")).toBe(
      "GitHub stars for Acme web on StackDash.",
    );
  });

  it("builds X's post intent with the text and link encoded, and no link when there is none", () => {
    const url = new URL(shareToXUrl("1,200 stars & more", "https://stackdash.example.com/card/p/github-stars.png"));
    expect(url.origin + url.pathname).toBe("https://x.com/intent/tweet");
    expect(url.searchParams.get("text")).toBe("1,200 stars & more");
    expect(url.searchParams.get("url")).toBe("https://stackdash.example.com/card/p/github-stars.png");
    expect(new URL(shareToXUrl("text only")).searchParams.has("url")).toBe(false);
  });

  it("builds LinkedIn's share page with the link encoded", () => {
    const url = new URL(shareToLinkedInUrl("https://stackdash.example.com/@k3j4h5g6f7/acme-web?a=1&b=2"));
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/sharing/share-offsite/");
    expect(url.searchParams.get("url")).toBe("https://stackdash.example.com/@k3j4h5g6f7/acme-web?a=1&b=2");
  });
});

describe("metricShareLinks", () => {
  const ORIGIN = "https://stackdash.example.com";
  const PAGE_URL = `${ORIGIN}/@k3j4h5g6f7/acme-web`;
  const CARD_URL = `${ORIGIN}/card/${PROJECT_ID}/github-stars.png`;
  const links = (projectPage: { path: string; projectName: string } | null) =>
    metricShareLinks({
      origin: ORIGIN,
      projectId: PROJECT_ID,
      metricId: "github-stars",
      formulaPath: "/docs/architecture/public-metrics#github-stars",
      metric: stars,
      projectPage,
    });

  it("points the post, X, LinkedIn, and the badge at the project page while it is public", () => {
    const on = links({ path: "/@k3j4h5g6f7/acme-web", projectName: "Acme web" });
    expect(on.link).toBe(PAGE_URL);
    const x = new URL(on.xIntentUrl);
    expect(x.searchParams.get("url")).toBe(PAGE_URL);
    expect(x.searchParams.get("text")).toBe("GitHub stars for Acme web: at least 1,200 stars. Verified by StackDash.");
    expect(new URL(on.linkedInUrl).searchParams.get("url")).toBe(PAGE_URL);
    expect(on.badgeMarkdown).toBe(`[![GitHub stars](${ORIGIN}/badge/${PROJECT_ID}/github-stars.svg)](${PAGE_URL})`);
    expect(on.cardUrl).toBe(CARD_URL);
  });

  it("never links an unpublished page: with the page off, posts carry the card and the badge the formula (boundary)", () => {
    const off = links(null);
    expect(off.link).toBe(CARD_URL);
    const x = new URL(off.xIntentUrl);
    expect(x.searchParams.get("url")).toBe(CARD_URL);
    expect(x.searchParams.get("text")).toBe("GitHub stars: at least 1,200 stars. Verified by StackDash.");
    expect(new URL(off.linkedInUrl).searchParams.get("url")).toBe(CARD_URL);
    expect(off.badgeMarkdown).toBe(
      `[![GitHub stars](${ORIGIN}/badge/${PROJECT_ID}/github-stars.svg)](${ORIGIN}/docs/architecture/public-metrics#github-stars)`,
    );
  });
});

describe("achievement badge and card paths (#413)", () => {
  it("key both by project id and achievement id, prefixed so they never meet a metric's file", () => {
    expect(achievementBadgePath(PROJECT_ID, "vercel.deployments.10")).toBe(`/badge/${PROJECT_ID}/achievement-vercel.deployments.10.svg`);
    expect(achievementCardPath(PROJECT_ID, "github.stars.1024")).toBe(`/card/${PROJECT_ID}/achievement-github.stars.1024.png`);
  });

  it("reads back the id each path was built with", () => {
    const file = achievementBadgePath(PROJECT_ID, "stripe.payments.while_you_slept").split("/").at(-1) ?? "";
    expect(achievementIdFromFile(file, "svg")).toBe("stripe.payments.while_you_slept");
  });
});

describe("achievementIdFromFile", () => {
  it.each([
    ["achievement-vercel.deployments.10.svg", "svg", "vercel.deployments.10"],
    ["achievement-github.stars.hot_day.png", "png", "github.stars.hot_day"],
    // Boundaries: the other surface's extension, a metric's file, no prefix, an id without a dot,
    // uppercase, a path separator, an empty id, and an id longer than the database stores.
    ["achievement-vercel.deployments.10.png", "svg", null],
    ["github-stars.svg", "svg", null],
    ["vercel.deployments.10.svg", "svg", null],
    ["achievement-vercel.svg", "svg", null],
    ["achievement-Vercel.deployments.10.svg", "svg", null],
    ["achievement-vercel..deployments.svg", "svg", null],
    ["achievement-.svg", "svg", null],
    [`achievement-a.${"b".repeat(99)}.svg`, "svg", null],
  ] as const)("%s as %s is %s", (file, extension, expected) => {
    expect(achievementIdFromFile(file, extension)).toBe(expected);
  });

  it("accepts the longest id the database stores (boundary: 100 characters)", () => {
    const id = `a.${"b".repeat(98)}`;
    expect(achievementIdFromFile(`achievement-${id}.svg`, "svg")).toBe(id);
  });
});

describe("achievementEarnedText", () => {
  const crossed = { earnedAt: new Date("2026-11-05T14:05:00Z"), earnedPrecision: "instant", evidence: "crossed", threshold: 10 } as const;

  it("dates an event achievement to the London minute it was recorded", () => {
    expect(achievementEarnedText(crossed)).toBe("Earned 2026-11-05 14:05 GMT");
    // Boundary: late on a UTC day in summer is the next day in London.
    expect(achievementEarnedText({ ...crossed, earnedAt: new Date("2026-06-20T23:30:00Z") })).toBe("Earned 2026-06-21 00:30 BST");
  });

  it("dates a daily total to its day, never a time", () => {
    expect(achievementEarnedText({ ...crossed, earnedAt: new Date("2026-06-20T00:00:00Z"), earnedPrecision: "day" })).toBe("Earned 2026-06-20");
  });

  it("says recorded at least, not earned, when StackDash never saw a reading below the threshold", () => {
    expect(achievementEarnedText({ ...crossed, evidence: "at_least", threshold: 1000 })).toBe("Recorded at least 1,000 on 2026-11-05 14:05 GMT");
  });

  it("reads the stored timestamp string the private Achievements page passes, in the same words", () => {
    expect(achievementEarnedText({ ...crossed, earnedAt: "2026-07-01T23:30:00+00:00" })).toBe("Earned 2026-07-02 00:30 BST");
    // A daily total stored at the start of its UTC day stays on that day, whatever London's offset.
    expect(achievementEarnedText({ ...crossed, earnedAt: "2026-07-02T00:00:00+00:00", earnedPrecision: "day" })).toBe("Earned 2026-07-02");
    expect(achievementEarnedText({ ...crossed, earnedAt: "2026-11-05T14:05:00+00:00", evidence: "at_least", threshold: 1024 })).toBe(
      "Recorded at least 1,024 on 2026-11-05 14:05 GMT",
    );
  });
});

describe("achievementShareLinks", () => {
  const ORIGIN = "https://stackdash.example.com";
  const PAGE_URL = `${ORIGIN}/@k3j4h5g6f7/acme-web`;
  const BADGE_URL = `${ORIGIN}/badge/${PROJECT_ID}/achievement-vercel.deployments.10.svg`;
  const CARD_URL = `${ORIGIN}/card/${PROJECT_ID}/achievement-vercel.deployments.10.png`;
  const achievement = { providerName: "Vercel", publicTitle: "10 Vercel deployments recorded", simulated: false };
  const links = (projectPage: { path: string; projectName: string } | null) =>
    achievementShareLinks({ origin: ORIGIN, projectId: PROJECT_ID, achievementId: "vercel.deployments.10", achievement, projectPage });

  it("points the badge Markdown, the post, X, and LinkedIn at the project page while it is public", () => {
    const on = links({ path: "/@k3j4h5g6f7/acme-web", projectName: "Acme web" });
    expect(on.badgeMarkdown).toBe(`[![10 Vercel deployments recorded](${BADGE_URL})](${PAGE_URL})`);
    expect(on.cardUrl).toBe(CARD_URL);
    expect(on.link).toBe(PAGE_URL);
    const x = new URL(on.xIntentUrl);
    expect(x.searchParams.get("url")).toBe(PAGE_URL);
    expect(x.searchParams.get("text")).toBe("Achievement for Acme web: 10 Vercel deployments recorded. Earned from Vercel data on StackDash.");
    expect(new URL(on.linkedInUrl).searchParams.get("url")).toBe(PAGE_URL);
  });

  it("with the page off, links the badge to the site and posts to the card, and names no project (boundary)", () => {
    const off = links(null);
    expect(off.badgeMarkdown).toBe(`[![10 Vercel deployments recorded](${BADGE_URL})](${ORIGIN}/)`);
    expect(off.link).toBe(CARD_URL);
    const x = new URL(off.xIntentUrl);
    expect(x.searchParams.get("url")).toBe(CARD_URL);
    expect(x.searchParams.get("text")).toBe("Achievement: 10 Vercel deployments recorded. Earned from Vercel data on StackDash.");
    expect(new URL(off.linkedInUrl).searchParams.get("url")).toBe(CARD_URL);
  });

  it("describes the card, naming the project only when the card shows it", () => {
    expect(achievementCardAltText(achievement, null)).toBe("StackDash achievement card. Vercel achievement: 10 Vercel deployments recorded.");
    expect(achievementCardAltText(achievement, "Acme web")).toBe(
      "StackDash achievement card for Acme web. Vercel achievement: 10 Vercel deployments recorded.",
    );
  });

  it("says simulated, never earned from real data, in every word shared about a simulated achievement", () => {
    const simulated = { ...achievement, simulated: true };
    expect(achievementBadgeAltText(simulated)).toBe(
      "Vercel achievement on StackDash: 10 Vercel deployments recorded. Simulated data, not verified.",
    );
    expect(achievementCardAltText(simulated, "Acme web")).toBe(
      "StackDash achievement card for Acme web. Vercel achievement: 10 Vercel deployments recorded. Simulated data, not verified.",
    );
    const post = achievementShareLinks({ origin: ORIGIN, projectId: PROJECT_ID, achievementId: "vercel.deployments.10", achievement: simulated, projectPage: null });
    expect(new URL(post.xIntentUrl).searchParams.get("text")).toBe(
      "Achievement: 10 Vercel deployments recorded. Earned from simulated Vercel data on StackDash, not verified.",
    );
  });
});
