import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublishedProjectMetrics } from "@/lib/public-metrics/published";
import type * as RequestsModule from "@/lib/public-metrics/requests";
import type { RateLimitDecision } from "@/lib/public-metrics/requests";

import { GET } from "./route";

// vi.mock factories run before the imports above, so the mocks they share are hoisted with them.
const { loadPublishedProjectMetrics, checkPublicRateLimit } = vi.hoisted(() => ({
  loadPublishedProjectMetrics: vi.fn<(projectId: string, now: Date) => Promise<PublishedProjectMetrics | null>>(),
  checkPublicRateLimit: vi.fn<(headers: Headers, now: Date) => Promise<RateLimitDecision>>(),
}));

vi.mock("@/lib/public-metrics/published", () => ({ loadPublishedProjectMetrics }));
vi.mock("@/lib/public-metrics/requests", async (importOriginal) => ({
  ...(await importOriginal<typeof RequestsModule>()),
  checkPublicRateLimit,
}));
vi.mock("@/lib/log/logger", () => ({ logError: () => "ref-123" }));
// Outside a Next.js request there is no request scope to wait for.
vi.mock("next/server", () => ({ connection: async () => {} }));

const PROJECT_ID = "30000000-0000-4000-8000-000000000001";
const AT = new Date("2026-11-05T12:00:00Z");

function get(projectId: string): Promise<Response> {
  return GET(new Request(`http://localhost/api/public/projects/${projectId}/metrics`), {
    params: Promise.resolve({ projectId }),
  });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  checkPublicRateLimit.mockResolvedValue({ allowed: true });
});

afterEach(() => {
  loadPublishedProjectMetrics.mockReset();
  checkPublicRateLimit.mockReset();
  vi.unstubAllEnvs();
});

describe("GET /api/public/projects/[projectId]/metrics", () => {
  it("returns live publications with provenance, last sync, and a one minute cache", async () => {
    loadPublishedProjectMetrics.mockResolvedValue({
      projectId: PROJECT_ID,
      workspaceId: "20000000-0000-4000-8000-000000000001",
      metrics: [
        {
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
        },
        {
          kind: "engine",
          publicationId: "80000000-0000-4000-8000-000000000002",
          metricId: "vercel-deployments-30d",
          providers: ["vercel"],
          label: "Deployments in 30 days",
          unit: "deployments",
          provenance: "verified",
          formulaPath: "/docs/architecture/public-metrics#vercel-deployments-30d",
          rounding: "exact",
          delayDays: 7,
          publishedAt: AT,
          asOf: AT,
          value: { status: "unavailable", reason: "not_enough_history", text: "Not enough history yet" },
        },
        {
          kind: "self_reported",
          publicationId: "80000000-0000-4000-8000-000000000003",
          label: "Downloads",
          unit: "downloads",
          provenance: "self_reported",
          value: 42,
          text: "42 downloads",
          publishedAt: AT,
        },
      ],
    });

    const response = await get(PROJECT_ID);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60");
    const body = await response.json();
    expect(body.projectId).toBe(PROJECT_ID);
    expect(body.metrics[0]).toMatchObject({
      kind: "engine",
      id: "github-stars",
      provenance: "verified",
      status: "available",
      value: 1200,
      atLeast: true,
      lastSyncedAt: AT.toISOString(),
      formulaUrl: "http://localhost/docs/architecture/public-metrics#github-stars",
    });
    expect(body.metrics[1]).toEqual(expect.objectContaining({ status: "unavailable", reason: "not_enough_history" }));
    expect(body.metrics[1]).not.toHaveProperty("value");
    expect(body.metrics[2]).toEqual(expect.objectContaining({ kind: "self_reported", provenance: "self_reported", value: 42 }));
    // Internal ids stay inside: no workspace id or publication ids in the public answer.
    expect(JSON.stringify(body)).not.toMatch(/20000000-0000-4000-8000-000000000001|80000000-/);
    // Same-origin only: no CORS header, so another site's scripts cannot read it.
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("builds formula links from NEXT_PUBLIC_SITE_URL when it is set, not from the request", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://stackdash.example.com/ignored-path");
    loadPublishedProjectMetrics.mockResolvedValue({
      projectId: PROJECT_ID,
      workspaceId: "20000000-0000-4000-8000-000000000001",
      metrics: [
        {
          kind: "engine",
          publicationId: "80000000-0000-4000-8000-000000000001",
          metricId: "github-stars",
          providers: ["github"],
          label: "GitHub stars",
          provenance: "verified",
          unit: "stars",
          formulaPath: "/docs/architecture/public-metrics#github-stars",
          rounding: "exact",
          delayDays: 0,
          asOf: AT,
          publishedAt: AT,
          value: { status: "unavailable", reason: "no_data", text: "No data yet" },
        },
      ],
    });
    const body = await (await get(PROJECT_ID)).json();
    expect(body.metrics[0].formulaUrl).toBe("https://stackdash.example.com/docs/architecture/public-metrics#github-stars");
  });

  it.each([
    ["a malformed id", "not-a-uuid", false],
    ["an empty id", "", false],
    ["a project with nothing published", PROJECT_ID, true],
  ])("answers the same 404 for %s", async (_title, projectId, reachesDatabase) => {
    loadPublishedProjectMetrics.mockResolvedValue(null);
    const response = await get(projectId);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found", message: "Nothing is published for this project." });
    expect(loadPublishedProjectMetrics).toHaveBeenCalledTimes(reachesDatabase ? 1 : 0);
  });

  it("answers 503 with a reference and no detail when the read fails, and is not cached", async () => {
    loadPublishedProjectMetrics.mockRejectedValue(new Error("connection refused at 10.0.0.1"));
    const response = await get(PROJECT_ID);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toEqual({ error: "unavailable", message: "Published metrics could not be read. Try again in a moment.", referenceId: "ref-123" });
  });

  it("answers 429 with Retry-After and no cache once the client is over the limit, before reading anything", async () => {
    checkPublicRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });
    const response = await get(PROJECT_ID);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("17");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "rate_limited", message: "Too many requests from this address. Try again in a minute." });
    expect(loadPublishedProjectMetrics).not.toHaveBeenCalled();
  });

  it("counts a malformed id against the limit too (boundary: probing ids is not free)", async () => {
    await get("not-a-uuid");
    expect(checkPublicRateLimit).toHaveBeenCalledTimes(1);
  });

  it("answers 503 when the rate limit cannot be counted (boundary: the counter fails)", async () => {
    checkPublicRateLimit.mockRejectedValue(new Error("counter down"));
    const response = await get(PROJECT_ID);
    expect(response.status).toBe(503);
    expect(loadPublishedProjectMetrics).not.toHaveBeenCalled();
  });
});
