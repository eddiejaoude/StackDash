import { expect, test, type Page } from "@playwright/test";

import { createTestWorkspace, deleteTestWorkspace } from "./fixtures/db";
import { publishStars, seedProjectWithHistory, turnOnPage } from "./fixtures/public-pages";
import { anonymous, pngSize } from "./fixtures/share";

// Link previews and search metadata of the public pages (#338), read from the rendered <head> as a
// crawler sees it: signed out. The canonical address, og:url, and og:image are absolute only when
// NEXT_PUBLIC_SITE_URL is set; playwright.config.ts sets it to the server's own origin. Every
// locator is strict, so a duplicated tag fails the spec: the root opengraph-image.tsx convention
// and the explicit SITE_IMAGE both rendering an og:image, or two layers each emitting an og:title.

type Head = Readonly<{ ogTitle: string | null; canonical: string | null; ogUrl: string | null; ogImage: string | null }>;

async function readHead(page: Page, path: string): Promise<Head> {
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  const content = (selector: string) => page.locator(selector).getAttribute("content");
  return {
    ogTitle: await content('meta[property="og:title"]'),
    canonical: await page.locator('link[rel="canonical"]').getAttribute("href"),
    ogUrl: await content('meta[property="og:url"]'),
    ogImage: await content('meta[property="og:image"]'),
  };
}

/** The absolute address of `path` on the test server, normalized the way URL writes it. */
function absolute(baseURL: string, path: string): string {
  return new URL(path, baseURL).href;
}

function normalized(url: string | null): string | null {
  return url === null ? null : new URL(url).href;
}

test.describe("social metadata", () => {
  test("the landing page, /docs, a docs page, the legal pages, and a public project page each have their own title and address", async ({ page, baseURL }) => {
    if (baseURL === undefined) throw new Error("baseURL is not configured");
    const workspace = await createTestWorkspace("Social metadata");
    try {
      const projectId = await seedProjectWithHistory(workspace);
      await publishStars(workspace, projectId);
      await turnOnPage(workspace, projectId, "acme-web", true);
      const projectAddress = `/@${workspace.slug}/acme-web`;

      const expected = [
        { path: "/", ogTitle: "StackDash · One timeline and one alert for your whole developer stack" },
        { path: "/docs", ogTitle: "Documentation" },
        { path: "/docs/providers/vercel", ogTitle: "Vercel" },
        // Published because playwright.config.ts gives the app a synthetic operator (#339).
        { path: "/privacy", ogTitle: "Privacy policy" },
        { path: "/terms", ogTitle: "Terms of use" },
        { path: projectAddress, ogTitle: "Acme web: public metrics" },
      ];
      const heads = new Map<string, Head>();
      for (const { path, ogTitle } of expected) {
        const head = await readHead(page, path);
        expect(head.ogTitle, path).toBe(ogTitle);
        expect(normalized(head.canonical), path).toBe(absolute(baseURL, path));
        expect(normalized(head.ogUrl), path).toBe(absolute(baseURL, path));
        heads.set(path, head);
      }
      // No page reuses another's preview title, the landing page's least of all.
      expect(new Set([...heads.values()].map((head) => head.ogTitle)).size).toBe(expected.length);

      // The project page previews with its published card, not the site image.
      expect(heads.get(projectAddress)?.ogImage).toBe(absolute(baseURL, `/card/${projectId}/github-stars.png`));
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  test("the landing page and /docs preview with the site image, a 1200 by 630 PNG", async ({ page, baseURL }) => {
    const request = await anonymous(baseURL);
    try {
      for (const path of ["/", "/docs"]) {
        const head = await readHead(page, path);
        expect(head.ogImage, path).not.toBeNull();
        await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute(
          "content",
          "StackDash: One timeline and one alert for your whole developer stack",
        );
        await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
        await expect(page.locator('meta[name="twitter:image"]')).toHaveAttribute("content", head.ogImage ?? "");

        const image = await request.get(head.ogImage ?? "");
        expect(image.status(), path).toBe(200);
        expect(image.headers()["content-type"]).toBe("image/png");
        expect(pngSize(await image.body())).toEqual({ width: 1200, height: 630 });
      }
    } finally {
      await request.dispose();
    }
  });

  test("the sitemap lists /docs and every docs page, and robots.txt fences the signed-in paths", async ({ baseURL }) => {
    if (baseURL === undefined) throw new Error("baseURL is not configured");
    const request = await anonymous(baseURL);
    try {
      const sitemap = await request.get("/sitemap.xml");
      expect(sitemap.status()).toBe(200);
      const body = await sitemap.text();
      for (const path of ["/", "/docs", "/docs/providers/vercel", "/docs/operations/deploy", "/docs/architecture/schema"]) {
        expect(body, path).toContain(`<loc>${absolute(baseURL, path)}</loc>`);
      }

      const robots = await request.get("/robots.txt");
      expect(robots.status()).toBe(200);
      const lines = (await robots.text()).split("\n");
      expect(lines).toContain("Allow: /");
      for (const path of ["/w/", "/app", "/api/", "/auth/", "/account", "/oauth"]) {
        expect(lines, path).toContain(`Disallow: ${path}`);
      }
      expect(lines).toContain(`Sitemap: ${absolute(baseURL, "/sitemap.xml")}`);
    } finally {
      await request.dispose();
    }
  });
});
