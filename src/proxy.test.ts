import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicPageMatch } from "@/lib/data/project-pages";
import type * as LoggerModule from "@/lib/log/logger";
import type * as RequestsModule from "@/lib/public-metrics/requests";
import type { RateLimitDecision } from "@/lib/public-metrics/requests";

import { proxy } from "./proxy";

// Public project page addresses (#150) through the proxy: the rate limit the badges and cards
// share (#321), then the lookup that decides between the page, a redirect, and the 404. Then the
// super admin page (#374): only a verified super admin's /app/admin is sent to the page's route,
// and that route's own path is answered as not found. Last, the one directive of the nonce policy
// that depends on the request (#597).

// vi.mock factories run before the imports above, so the mocks they share are hoisted with them.
const { checkPublicRateLimit, findPublicProjectPage, getClaims, warn } = vi.hoisted(() => ({
  checkPublicRateLimit: vi.fn<(headers: Headers, now: Date) => Promise<RateLimitDecision>>(),
  findPublicProjectPage: vi.fn<(address: string, pageSlug: string) => Promise<PublicPageMatch | null>>(),
  getClaims: vi.fn<() => Promise<{ data: { claims: { sub: string; email?: string } } | null }>>(),
  warn: vi.fn(),
}));

vi.mock("@/lib/data/project-pages", () => ({ findPublicProjectPage }));
vi.mock("@/lib/public-metrics/requests", async (importOriginal) => ({
  ...(await importOriginal<typeof RequestsModule>()),
  checkPublicRateLimit,
}));
vi.mock("@supabase/ssr", () => ({ createServerClient: () => ({ auth: { getClaims } }) }));
// The admin refusal's warning is asserted; the invalid list case's error line stays out of the output.
vi.mock("@/lib/log/logger", async (importOriginal) => {
  const original = await importOriginal<typeof LoggerModule>();
  return { ...original, log: { ...original.log, warn }, logError: () => "ref-123" };
});

const ADDRESS = "/@acme-labs/acme-web";
const PAGE: PublicPageMatch = {
  projectId: "30000000-0000-4000-8000-000000000001",
  projectName: "Acme web",
  indexable: false,
  workspace: { slug: "k3j4h5g6f7", handle: "acme-labs" },
};

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`, { headers: { "x-forwarded-for": "203.0.113.7" } });
}

/** The path the proxy rewrote the request to, or null when it did not rewrite. */
function rewrittenTo(response: Response): string | null {
  const target = response.headers.get("x-middleware-rewrite");
  return target === null ? null : new URL(target).pathname;
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
  checkPublicRateLimit.mockResolvedValue({ allowed: true });
  findPublicProjectPage.mockResolvedValue(PAGE);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("proxy for public project pages", () => {
  it("counts the request against the public rate limit and, under it, renders the page", async () => {
    const response = await proxy(request(ADDRESS));

    expect(response.status).toBe(200);
    expect(rewrittenTo(response)).toBe("/p/acme-labs/acme-web");
    expect(response.headers.get("Content-Security-Policy")).toMatch(/script-src 'self' 'nonce-/);
    expect(checkPublicRateLimit).toHaveBeenCalledTimes(1);
    const [headers] = checkPublicRateLimit.mock.calls[0] ?? [];
    expect(headers?.get("x-forwarded-for")).toBe("203.0.113.7");
    expect(findPublicProjectPage).toHaveBeenCalledExactlyOnceWith("acme-labs", "acme-web");
  });

  it("past the limit answers 429 with Retry-After, never cached, and reads nothing else", async () => {
    checkPublicRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 42 });

    const response = await proxy(request(ADDRESS));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("Content-Security-Policy")).toMatch(/default-src 'self'/);
    expect(rewrittenTo(response)).toBeNull();
    const body = await response.text();
    expect(body).toContain("Too many requests from this address</h1>");
    expect(body).toContain("Try again in 42 seconds");
    expect(findPublicProjectPage).not.toHaveBeenCalled();
  });

  it("fails closed when the count cannot be taken: the request errors and the page is never read (boundary: counter down)", async () => {
    checkPublicRateLimit.mockRejectedValue(new Error("Failed to count a public request"));

    await expect(proxy(request(ADDRESS))).rejects.toThrow("Failed to count a public request");
    expect(findPublicProjectPage).not.toHaveBeenCalled();
  });

  it("refuses a slug address past the limit too, instead of redirecting it to the handle", async () => {
    checkPublicRateLimit.mockResolvedValue({ allowed: false, retryAfterSeconds: 1 });

    const response = await proxy(request("/@k3j4h5g6f7/acme-web"));

    expect(response.status).toBe(429);
    expect(response.headers.get("Location")).toBeNull();
    expect(findPublicProjectPage).not.toHaveBeenCalled();
  });

  // public_project_page() answers null alike for an unknown address, a page that is off, and a page
  // with nothing published, so all three reach the same 404 route as a path that is no address.
  it("answers an address that is not public, under the limit, with the same 404 route as any unknown path", async () => {
    findPublicProjectPage.mockResolvedValue(null);

    const response = await proxy(request("/@acme-labs/no-such-page"));

    expect(rewrittenTo(response)).toBe("/p/_");
    expect(checkPublicRateLimit).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a slug longer than any page can have", `/@acme-labs/${"a".repeat(41)}`],
    ["the page route's own path", "/p/acme-labs/acme-web"],
    ["a workspace with no page slug", "/@acme-labs"],
  ])("answers %s with the 404 route without counting it or reading the database", async (_title, path) => {
    const response = await proxy(request(path));

    expect(rewrittenTo(response)).toBe("/p/_");
    expect(checkPublicRateLimit).not.toHaveBeenCalled();
    expect(findPublicProjectPage).not.toHaveBeenCalled();
  });

  it("answers a counted slug address of a workspace with a handle with a 307 to the handle address", async () => {
    const response = await proxy(request("/@k3j4h5g6f7/acme-web?ref=readme"));

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("http://localhost/@acme-labs/acme-web?ref=readme");
    expect(checkPublicRateLimit).toHaveBeenCalledTimes(1);
  });
});

describe("proxy for the super admin page", () => {
  beforeEach(() => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", "ops@example.com");
  });

  const USER_ID = "10000000-0000-4000-8000-000000000001";

  function signedInAs(email: string | undefined): void {
    const claims = { sub: USER_ID, ...(email === undefined ? {} : { email }) };
    getClaims.mockResolvedValue({ data: { claims } });
  }

  it.each([
    ["another address", "someone@example.com"],
    ["a user with no email", undefined],
  ])("leaves %s on /app/admin, which has no route, exactly as a missing app path, and logs the refusal", async (_title, email) => {
    signedInAs(email);

    const admin = await proxy(request("/app/admin?after=x"));
    const missing = await proxy(request("/app/no-such-page?after=x"));

    for (const response of [admin, missing]) {
      expect(rewrittenTo(response)).toBeNull();
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("Content-Security-Policy")).toMatch(/script-src 'self' 'nonce-/);
    }
    expect(warn).toHaveBeenCalledExactlyOnceWith("admin.access_refused", { userId: USER_ID });
  });

  it("sends a super admin, in any case of the address, to the page route with the query kept", async () => {
    signedInAs("OPS@example.com");

    const response = await proxy(request("/app/admin?after=x"));

    const target = new URL(response.headers.get("x-middleware-rewrite") ?? "http://localhost/none");
    expect(`${target.pathname}${target.search}`).toBe("/super-admin?after=x");
    expect(response.headers.get("Content-Security-Policy")).toMatch(/script-src 'self' 'nonce-/);
    expect(warn).not.toHaveBeenCalled();
  });

  it("sends an invalid list on to the page, whose error page reports it", async () => {
    vi.stubEnv("STACKDASH_SUPER_ADMIN_EMAILS", "ops@example.com,not-an-address");
    signedInAs("someone@example.com");

    const response = await proxy(request("/app/admin"));

    expect(rewrittenTo(response)).toBe("/super-admin");
  });

  it("sends a signed-out visitor to sign in and back, as on every app page", async () => {
    getClaims.mockResolvedValue({ data: null });

    const response = await proxy(request("/app/admin"));

    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("http://localhost/sign-in?next=%2Fapp%2Fadmin");
  });

  it.each([
    ["a super admin", "ops@example.com"],
    ["anyone else", "someone@example.com"],
  ])("answers the page route's own path, and any path under it, with one 404 route for %s", async (_title, email) => {
    signedInAs(email);

    for (const path of ["/super-admin", "/super-admin?after=x", "/super-admin/anything"]) {
      const response = await proxy(request(path));
      expect(rewrittenTo(response)).toBe("/super-admin/_");
      expect(response.headers.get("Content-Security-Policy")).toMatch(/script-src 'self' 'nonce-/);
    }
    expect(getClaims).not.toHaveBeenCalled();
  });
});

describe("proxy's nonce policy and upgrade-insecure-requests", () => {
  const HOSTED = "https://stackdash.example.com";
  // The whole policy this file's Supabase URL gives, nonce aside, so any other change shows.
  const PRODUCTION_POLICY = [
    "default-src 'self'",
    "script-src 'self' 'nonce-N'",
    "style-src 'self' 'nonce-N'",
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data: https://avatars.githubusercontent.com",
    "font-src 'self'",
    "connect-src 'self' http://127.0.0.1:54321 ws://127.0.0.1:54321",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self' http://127.0.0.1:54321 https://github.com",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
  const WITHOUT_UPGRADE = PRODUCTION_POLICY.replace("; upgrade-insecure-requests", "");

  /** The policy on a public page's response for a request to `origin`, its nonce written as N. */
  async function policyFor(origin: string, headers: Record<string, string> = {}): Promise<string | undefined> {
    const response = await proxy(new NextRequest(`${origin}${ADDRESS}`, { headers }));
    return response.headers.get("Content-Security-Policy")?.replace(/'nonce-[^']+'/g, "'nonce-N'");
  }

  it("keeps the whole policy, upgrade-insecure-requests included, for https on a hosted name", async () => {
    expect(await policyFor(HOSTED)).toBe(PRODUCTION_POLICY);
  });

  // A browser always sends Host, port included, and `next start` copies it into x-forwarded-host,
  // so every row but the one about a missing Host sends it as a header.
  it.each([
    ["a LAN address (boundary: private, not loopback)", "http://192.168.1.20:3000", { host: "192.168.1.20:3000" }],
    ["a name that starts with localhost (boundary: not loopback)", "http://localhost.example.com", { host: "localhost.example.com" }],
    ["a LAN Host while the server listens on localhost (boundary: next start's URL host)", "http://localhost:3000", { host: "192.168.1.20:3000" }],
    [
      "a hosted x-forwarded-host on a loopback server (boundary: proxy in front)",
      "http://localhost:3000",
      { "x-forwarded-host": "stackdash.example.com", host: "localhost:3000" },
    ],
    [
      "an x-forwarded-host list that starts with localhost (boundary: a host list is refused, not split)",
      "http://localhost:3000",
      { "x-forwarded-host": "localhost:3000, stackdash.example.com", host: "localhost:3000" },
    ],
    [
      "an x-forwarded-host list that ends with localhost (boundary: a host list is refused, not split)",
      "http://localhost:3000",
      { "x-forwarded-host": "stackdash.example.com, localhost:3000", host: "localhost:3000" },
    ],
    [
      "a hosted name, as a forged x-forwarded-proto says (boundary: the scheme alone is not enough)",
      HOSTED,
      { "x-forwarded-proto": "http", host: "stackdash.example.com" },
    ],
    ["a loopback server with no Host header (boundary: fail closed, not the URL host)", "http://localhost:3000", {}],
  ])("keeps upgrade-insecure-requests for plain http to %s", async (_title, origin, headers) => {
    expect(await policyFor(origin, headers)).toBe(PRODUCTION_POLICY);
  });

  it.each([
    ["https", { "x-forwarded-proto": "https", host: "localhost:3000" }],
    ["a list whose first value is https", { "x-forwarded-proto": "https, http", host: "localhost:3000" }],
  ])("keeps upgrade-insecure-requests on a loopback host when x-forwarded-proto is %s (boundary: TLS ended in front)", async (_title, headers) => {
    expect(await policyFor("http://localhost:3000", headers)).toBe(PRODUCTION_POLICY);
  });

  it.each([
    ["localhost", "http://localhost:3000", { host: "localhost:3000" }],
    ["127.0.0.1", "http://127.0.0.1:3000", { host: "127.0.0.1:3000" }],
    ["[::1]", "http://[::1]:3000", { host: "[::1]:3000" }],
    [
      "localhost, with the headers next start adds",
      "http://localhost:3000",
      { "x-forwarded-proto": "http", "x-forwarded-host": "localhost:3000", host: "localhost:3000" },
    ],
    [
      "localhost, when the first x-forwarded-proto value is http and a later one https",
      "http://localhost:3000",
      { "x-forwarded-proto": "http, https", host: "localhost:3000" },
    ],
  ])("leaves out only upgrade-insecure-requests for plain http to %s (boundary: loopback)", async (_title, origin, headers) => {
    expect(await policyFor(origin, headers)).toBe(WITHOUT_UPGRADE);
  });

  it.each([
    ["https on a hosted name", HOSTED, { host: "stackdash.example.com" }],
    ["plain http to localhost", "http://localhost:3000", { host: "localhost:3000" }],
  ])("keeps the development policy as it was for %s (boundary: NODE_ENV development)", async (_title, origin, headers) => {
    vi.stubEnv("NODE_ENV", "development");

    expect(await policyFor(origin, headers)).toBe(
      WITHOUT_UPGRADE.replace("script-src 'self' 'nonce-N'", "script-src 'self' 'nonce-N' 'unsafe-eval'").replace(
        "style-src 'self' 'nonce-N'",
        "style-src 'self' 'unsafe-inline'",
      ),
    );
  });
});
