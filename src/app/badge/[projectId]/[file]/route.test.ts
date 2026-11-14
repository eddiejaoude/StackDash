import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicMetricId } from "@/lib/public-metrics/definitions";
import type { PublishedAchievement, PublishedEngineMetric } from "@/lib/public-metrics/published";
import type * as RequestsModule from "@/lib/public-metrics/requests";
import type { RateLimitDecision, ShareSurface } from "@/lib/public-metrics/requests";

import { GET } from "./route";

// vi.mock factories run before the imports above, so the mocks they share are hoisted with them.
const { loadPublishedMetric, loadPublishedAchievement, checkPublicRateLimit, countViewAfterResponse } = vi.hoisted(() => ({
  loadPublishedMetric: vi.fn<(projectId: string, metricId: PublicMetricId, now: Date) => Promise<PublishedEngineMetric | null>>(),
  loadPublishedAchievement: vi.fn<(projectId: string, achievementId: string) => Promise<PublishedAchievement | null>>(),
  checkPublicRateLimit: vi.fn<(headers: Headers, now: Date) => Promise<RateLimitDecision>>(),
  countViewAfterResponse: vi.fn<(projectId: string, metricId: PublicMetricId, surface: ShareSurface) => void>(),
}));

vi.mock("@/lib/public-metrics/published", () => ({ loadPublishedMetric, loadPublishedAchievement }));
vi.mock("@/lib/public-metrics/requests", async (importOriginal) => ({
  ...(await importOriginal<typeof RequestsModule>()),
  checkPublicRateLimit,
  countViewAfterResponse,
}));
vi.mock("@/lib/log/logger", () => ({ logError: () => "ref-123" }));
// Outside a Next.js request there is no request scope to wait for.
vi.mock("next/server", () => ({ connection: async () => {}, after: () => {} }));

const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const AT = new Date("2026-11-05T12:00:00Z");

const STARS: PublishedEngineMetric = {
  kind: "engine",
  publicationId: "80000000-0000-4000-8000-000000000001",
  metricId: "github-stars",
  providers: ["github"],
  label: "GitHub stars",
  unit: "stars",
  provenance: "verified",
  formulaPath: "/docs/architecture/public-metrics#github-stars",
  rounding: "hundreds",
  delayDays: 0,
  publishedAt: AT,
  asOf: AT,
  value: { status: "available", value: 1200, text: "at least 1,200 stars", atLeast: true, lastSyncedAt: AT, simulated: false },
};

function get(projectId: string, file: string): Promise<Response> {
  return GET(new Request(`http://localhost/badge/${projectId}/${file}`), { params: Promise.resolve({ projectId, file }) });
}

beforeEach(() => {
  checkPublicRateLimit.mockResolvedValue({ allowed: true });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("GET /badge/[projectId]/[file]", () => {
  it("serves the published value as an embeddable SVG with a one minute cache, and counts the serve", async () => {
    loadPublishedMetric.mockResolvedValue(STARS);
    const response = await get(PROJECT_ID, "github-stars.svg");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("set-cookie")).toBeNull();
    const svg = await response.text();
    expect(svg).toContain("1,200+ verified");
    expect(svg).toContain("<title>GitHub stars: at least 1,200 stars.");
    expect(loadPublishedMetric).toHaveBeenCalledWith(PROJECT_ID, "github-stars", expect.any(Date));
    expect(countViewAfterResponse).toHaveBeenCalledWith(PROJECT_ID, "github-stars", "badge");
  });

  it.each([
    ["an unpublished or unknown metric", PROJECT_ID, "github-stars.svg", true],
    ["a malformed project id", "not-a-uuid", "github-stars.svg", false],
    ["a metric id that does not exist", PROJECT_ID, "github-spend-actions.svg", false],
    ["the card's extension", PROJECT_ID, "github-stars.png", false],
  ])("answers %s with the same cached Unpublished badge and counts nothing", async (_title, projectId, file, reachesDatabase) => {
    loadPublishedMetric.mockResolvedValue(null);
    const response = await get(projectId, file);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    expect(await response.text()).toContain(">Unpublished</text>");
    expect(loadPublishedMetric).toHaveBeenCalledTimes(reachesDatabase ? 1 : 0);
    expect(countViewAfterResponse).not.toHaveBeenCalled();
  });

  it("answers 429 with Retry-After and no cache over the rate limit, before reading anything", async () => {
    checkPublicRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });
    const response = await get(PROJECT_ID, "github-stars.svg");

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("9");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(await response.text()).toContain("Try again in a minute");
    expect(loadPublishedMetric).not.toHaveBeenCalled();
  });

  it("answers 503 with an uncached Temporarily unavailable badge when the read fails, with no detail", async () => {
    loadPublishedMetric.mockRejectedValue(new Error("connection refused at 10.0.0.1"));
    const response = await get(PROJECT_ID, "github-stars.svg");

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const svg = await response.text();
    expect(svg).toContain("Temporarily unavailable");
    expect(svg).not.toContain("10.0.0.1");
  });
});

describe("GET /badge/[projectId]/achievement-[id].svg (#413)", () => {
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

  it("serves the published achievement's public title under the provider's name, with a metric badge's headers", async () => {
    loadPublishedAchievement.mockResolvedValue(DEPLOYMENTS);
    const response = await get(PROJECT_ID, "achievement-vercel.deployments.10.svg");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(response.headers.get("set-cookie")).toBeNull();
    const svg = await response.text();
    expect(svg).toContain(">Vercel</text>");
    expect(svg).toContain(">10 Vercel deployments recorded</text>");
    expect(loadPublishedAchievement).toHaveBeenCalledWith(PROJECT_ID, "vercel.deployments.10");
    expect(loadPublishedMetric).not.toHaveBeenCalled();
  });

  it.each([
    ["an unpublished or unknown achievement", PROJECT_ID, "achievement-vercel.deployments.10.svg", true],
    ["a malformed project id", "not-a-uuid", "achievement-vercel.deployments.10.svg", false],
    ["a malformed achievement id", PROJECT_ID, "achievement-Vercel deployments.svg", false],
    ["the card's extension", PROJECT_ID, "achievement-vercel.deployments.10.png", false],
  ])("answers %s with the same cached Unpublished badge", async (_title, projectId, file, reachesDatabase) => {
    loadPublishedAchievement.mockResolvedValue(null);
    const response = await get(projectId, file);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    expect(await response.text()).toContain(">Unpublished</text>");
    expect(loadPublishedAchievement).toHaveBeenCalledTimes(reachesDatabase ? 1 : 0);
    expect(countViewAfterResponse).not.toHaveBeenCalled();
  });

  it("answers 429 over the rate limit before reading the achievement", async () => {
    checkPublicRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 9 });
    const response = await get(PROJECT_ID, "achievement-vercel.deployments.10.svg");

    expect(response.status).toBe(429);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(loadPublishedAchievement).not.toHaveBeenCalled();
  });

  it("answers 503 with an uncached badge when the read fails", async () => {
    loadPublishedAchievement.mockRejectedValue(new Error("connection refused at 10.0.0.1"));
    const response = await get(PROJECT_ID, "achievement-vercel.deployments.10.svg");

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("10.0.0.1");
  });
});
