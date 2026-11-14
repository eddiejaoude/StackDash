import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as CardImageModule from "@/lib/public-metrics/card-image";
import type { PublicMetricId } from "@/lib/public-metrics/definitions";
import type { PublishedAchievement, PublishedMetricCard } from "@/lib/public-metrics/published";
import type { ShareProjectPage } from "@/lib/public-metrics/share";
import type * as RequestsModule from "@/lib/public-metrics/requests";
import type { RateLimitDecision, ShareSurface } from "@/lib/public-metrics/requests";

import { GET } from "./route";

// vi.mock factories run before the imports above, so the mocks they share are hoisted with them.
const { loadPublishedMetricCard, loadPublishedAchievement, loadPublicPageOfProject, checkPublicRateLimit, countViewAfterResponse, cardImageResponse } =
  vi.hoisted(() => ({
    loadPublishedMetricCard:
      vi.fn<(projectId: string, metricId: PublicMetricId, now: Date, trendDays: number) => Promise<PublishedMetricCard | null>>(),
    loadPublishedAchievement: vi.fn<(projectId: string, achievementId: string) => Promise<PublishedAchievement | null>>(),
    loadPublicPageOfProject: vi.fn<(projectId: string) => Promise<ShareProjectPage | null>>(),
    checkPublicRateLimit: vi.fn<(headers: Headers, now: Date) => Promise<RateLimitDecision>>(),
    countViewAfterResponse: vi.fn<(projectId: string, metricId: PublicMetricId, surface: ShareSurface) => void>(),
    cardImageResponse: vi.fn<(element: ReactNode, init: { status?: number; headers: Record<string, string> }) => Response>(),
  }));

vi.mock("@/lib/public-metrics/published", () => ({ loadPublishedMetricCard, loadPublishedAchievement }));
vi.mock("@/lib/data/project-pages", () => ({ loadPublicPageOfProject }));
vi.mock("@/lib/public-metrics/requests", async (importOriginal) => ({
  ...(await importOriginal<typeof RequestsModule>()),
  checkPublicRateLimit,
  countViewAfterResponse,
}));
// The PNG renderer itself is Next.js'; here the route's choice of card, status, and headers is
// what is under test, so the response describes the element it was given.
vi.mock("@/lib/public-metrics/card-image", async (importOriginal) => ({
  ...(await importOriginal<typeof CardImageModule>()),
  cardImageResponse,
}));
vi.mock("@/lib/log/logger", () => ({ logError: () => "ref-123" }));
vi.mock("next/server", () => ({ connection: async () => {}, after: () => {} }));

const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const AT = new Date("2026-11-05T12:00:00Z");

const CARD: PublishedMetricCard = {
  metric: {
    kind: "engine",
    publicationId: "80000000-0000-4000-8000-000000000001",
    metricId: "vercel-deployments-30d",
    providers: ["vercel"],
    label: "Deployments in 30 days",
    unit: "deployments",
    provenance: "verified",
    formulaPath: "/docs/architecture/public-metrics#vercel-deployments-30d",
    rounding: "exact",
    delayDays: 0,
    publishedAt: AT,
    asOf: AT,
    value: { status: "available", value: 42, text: "42 deployments", atLeast: false, lastSyncedAt: AT, simulated: false },
  },
  trend: [
    { at: new Date(AT.getTime() - 86_400_000), value: 40 },
    { at: AT, value: 42 },
  ],
};

function get(projectId: string, file: string): Promise<Response> {
  return GET(new Request(`http://localhost/card/${projectId}/${file}`), { params: Promise.resolve({ projectId, file }) });
}

/** The card component and props the route chose, with the status and headers it asked for. */
function rendered(): { card: string; props: Record<string, unknown>; status: number; headers: Record<string, string> } {
  const [element, init] = cardImageResponse.mock.calls[0] ?? [];
  if (!isValidElement<Record<string, unknown>>(element) || typeof element.type !== "function" || init === undefined) {
    throw new Error("cardImageResponse was not called with a card element");
  }
  return { card: element.type.name, props: element.props, status: init.status ?? 200, headers: init.headers };
}

beforeEach(() => {
  checkPublicRateLimit.mockResolvedValue({ allowed: true });
  cardImageResponse.mockReturnValue(new Response("png"));
  loadPublicPageOfProject.mockResolvedValue(null);
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /card/[projectId]/[file]", () => {
  it("renders the metric card with its 30 day trend, a one minute cache, and counts the serve", async () => {
    loadPublishedMetricCard.mockResolvedValue(CARD);
    await get(PROJECT_ID, "vercel-deployments-30d.png");

    expect(loadPublishedMetricCard).toHaveBeenCalledWith(PROJECT_ID, "vercel-deployments-30d", expect.any(Date), 30);
    const { card, props, status, headers } = rendered();
    expect(card).toBe("MetricCard");
    expect(props.card).toBe(CARD);
    // No public project page: the card names no project.
    expect(props.projectName).toBeNull();
    expect(status).toBe(200);
    expect(headers).toEqual({ "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "public, max-age=60, s-maxage=60" });
    expect(countViewAfterResponse).toHaveBeenCalledWith(PROJECT_ID, "vercel-deployments-30d", "card");
  });

  it("names the project while its page is public", async () => {
    loadPublishedMetricCard.mockResolvedValue(CARD);
    loadPublicPageOfProject.mockResolvedValue({ path: "/@k3j4h5g6f7/acme-web", projectName: "Acme web" });
    await get(PROJECT_ID, "vercel-deployments-30d.png");

    expect(loadPublicPageOfProject).toHaveBeenCalledWith(PROJECT_ID);
    const { card, props } = rendered();
    expect(card).toBe("MetricCard");
    expect(props.projectName).toBe("Acme web");
  });

  it.each([
    ["an unpublished or unknown metric", PROJECT_ID, "github-stars.png", true],
    ["a malformed project id", "../etc", "github-stars.png", false],
    ["the badge's extension", PROJECT_ID, "github-stars.svg", false],
  ])("answers %s with a cached Unpublished card and counts nothing", async (_title, projectId, file, reachesDatabase) => {
    loadPublishedMetricCard.mockResolvedValue(null);
    // Boundary: a page read that would fail never decides an Unpublished answer.
    loadPublicPageOfProject.mockRejectedValue(new Error("timeout"));
    await get(projectId, file);

    const { card, props, status, headers } = rendered();
    expect(card).toBe("NoticeCard");
    expect(props.title).toBe("Unpublished");
    expect(status).toBe(200);
    expect(headers["Cache-Control"]).toBe("public, max-age=60, s-maxage=60");
    expect(loadPublishedMetricCard).toHaveBeenCalledTimes(reachesDatabase ? 1 : 0);
    expect(loadPublicPageOfProject).not.toHaveBeenCalled();
    expect(countViewAfterResponse).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After and no cache over the rate limit", async () => {
    checkPublicRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 30 });
    await get(PROJECT_ID, "github-stars.png");

    const { card, status, headers } = rendered();
    expect(card).toBe("NoticeCard");
    expect(status).toBe(429);
    expect(headers).toMatchObject({ "Retry-After": "30", "Cache-Control": "no-store" });
    expect(loadPublishedMetricCard).not.toHaveBeenCalled();
    expect(loadPublicPageOfProject).not.toHaveBeenCalled();
  });

  it("answers 503 with an uncached card when the read fails", async () => {
    loadPublishedMetricCard.mockRejectedValue(new Error("timeout"));
    await get(PROJECT_ID, "github-stars.png");

    const { props, status, headers } = rendered();
    expect(props.title).toBe("Temporarily unavailable");
    expect(status).toBe(503);
    expect(headers["Cache-Control"]).toBe("no-store");
  });

  it("answers 503 with an uncached card when the project page read fails", async () => {
    loadPublishedMetricCard.mockResolvedValue(CARD);
    loadPublicPageOfProject.mockRejectedValue(new Error("timeout"));
    await get(PROJECT_ID, "github-stars.png");

    const { props, status, headers } = rendered();
    expect(props.title).toBe("Temporarily unavailable");
    expect(status).toBe(503);
    expect(headers["Cache-Control"]).toBe("no-store");
  });
});

describe("GET /card/[projectId]/achievement-[id].png (#413)", () => {
  const DEPLOYMENTS: PublishedAchievement = {
    achievementId: "vercel.deployments.10",
    provider: "vercel",
    providerName: "Vercel",
    publicTitle: "10 Vercel deployments recorded",
    earnedAt: AT,
    earnedPrecision: "instant",
    evidence: "crossed",
    threshold: 10,
    publishedAt: AT,
  };

  it("renders the published achievement's card with a metric card's cache and headers", async () => {
    loadPublishedAchievement.mockResolvedValue(DEPLOYMENTS);
    await get(PROJECT_ID, "achievement-vercel.deployments.10.png");

    expect(loadPublishedAchievement).toHaveBeenCalledWith(PROJECT_ID, "vercel.deployments.10");
    const { card, props, status, headers } = rendered();
    expect(card).toBe("AchievementCard");
    expect(props.achievement).toBe(DEPLOYMENTS);
    expect(props.projectName).toBeNull();
    expect(status).toBe(200);
    expect(headers).toEqual({ "Cross-Origin-Resource-Policy": "cross-origin", "Cache-Control": "public, max-age=60, s-maxage=60" });
    expect(loadPublishedMetricCard).not.toHaveBeenCalled();
  });

  it("names the project while its page is public", async () => {
    loadPublishedAchievement.mockResolvedValue(DEPLOYMENTS);
    loadPublicPageOfProject.mockResolvedValue({ path: "/@k3j4h5g6f7/acme-web", projectName: "Acme web" });
    await get(PROJECT_ID, "achievement-vercel.deployments.10.png");

    expect(rendered().props.projectName).toBe("Acme web");
  });

  it.each([
    ["an unpublished or unknown achievement", PROJECT_ID, "achievement-vercel.deployments.10.png", true],
    ["a malformed project id", "../etc", "achievement-vercel.deployments.10.png", false],
    ["a malformed achievement id", PROJECT_ID, "achievement-../etc.png", false],
    ["the badge's extension", PROJECT_ID, "achievement-vercel.deployments.10.svg", false],
  ])("answers %s with a cached Unpublished card", async (_title, projectId, file, reachesDatabase) => {
    loadPublishedAchievement.mockResolvedValue(null);
    loadPublicPageOfProject.mockRejectedValue(new Error("timeout"));
    await get(projectId, file);

    const { card, props, status, headers } = rendered();
    expect(card).toBe("NoticeCard");
    expect(props.title).toBe("Unpublished");
    expect(status).toBe(200);
    expect(headers["Cache-Control"]).toBe("public, max-age=60, s-maxage=60");
    expect(loadPublishedAchievement).toHaveBeenCalledTimes(reachesDatabase ? 1 : 0);
    expect(loadPublicPageOfProject).not.toHaveBeenCalled();
  });

  it("answers 503 with an uncached card when the read fails", async () => {
    loadPublishedAchievement.mockRejectedValue(new Error("timeout"));
    await get(PROJECT_ID, "achievement-vercel.deployments.10.png");

    const { props, status, headers } = rendered();
    expect(props.title).toBe("Temporarily unavailable");
    expect(status).toBe(503);
    expect(headers["Cache-Control"]).toBe("no-store");
  });
});
