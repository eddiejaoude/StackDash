import { describe, expect, it } from "vitest";

import { DOCS_ROUTE } from "@/lib/docs";
import { site } from "@/lib/site";

import { LANDING_TITLE, robotsRules, ROBOTS_DISALLOW, SITE_IMAGE, siteMetadataBase, sitemapEntries, socialMetadata } from "./site-metadata";

const ORIGIN = "https://stackdash.example";
const DOC_PATHS = ["/docs/providers/vercel", "/docs/operations/deploy"];
const PROJECT_PAGE = { path: "/@acme/acme-web", lastModified: new Date("2026-11-01T09:00:00Z") };
const LEGAL_PAGES = [
  { path: "/privacy", lastModified: "2026-11-12" },
  { path: "/terms", lastModified: "2026-11-10" },
];

describe("sitemapEntries", () => {
  it("lists the static pages, then every docs page, then the project pages, all absolute", () => {
    expect(sitemapEntries(ORIGIN, { docPaths: DOC_PATHS, legalPages: [], projectPages: [PROJECT_PAGE] })).toEqual([
      { url: `${ORIGIN}/` },
      { url: `${ORIGIN}/docs` },
      { url: `${ORIGIN}/docs/providers/vercel` },
      { url: `${ORIGIN}/docs/operations/deploy` },
      { url: `${ORIGIN}/@acme/acme-web`, lastModified: PROJECT_PAGE.lastModified },
    ]);
  });

  it("lists the legal pages after the static pages, each with the date it last changed", () => {
    expect(sitemapEntries(ORIGIN, { docPaths: DOC_PATHS, legalPages: LEGAL_PAGES, projectPages: [PROJECT_PAGE] })).toEqual([
      { url: `${ORIGIN}/` },
      { url: `${ORIGIN}/docs` },
      { url: `${ORIGIN}/privacy`, lastModified: "2026-11-12" },
      { url: `${ORIGIN}/terms`, lastModified: "2026-11-10" },
      { url: `${ORIGIN}/docs/providers/vercel` },
      { url: `${ORIGIN}/docs/operations/deploy` },
      { url: `${ORIGIN}/@acme/acme-web`, lastModified: PROJECT_PAGE.lastModified },
    ]);
  });

  it("still lists the landing page and /docs with no docs, legal, or project pages", () => {
    expect(sitemapEntries(ORIGIN, { docPaths: [], legalPages: [], projectPages: [] })).toEqual([{ url: `${ORIGIN}/` }, { url: `${ORIGIN}${DOCS_ROUTE}` }]);
  });

  it("writes no double slash when the origin ends with a slash", () => {
    const urls = sitemapEntries(`${ORIGIN}/`, { docPaths: DOC_PATHS, legalPages: LEGAL_PAGES, projectPages: [PROJECT_PAGE] }).map((entry) => entry.url);
    expect(urls).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/docs`,
      `${ORIGIN}/privacy`,
      `${ORIGIN}/terms`,
      `${ORIGIN}/docs/providers/vercel`,
      `${ORIGIN}/docs/operations/deploy`,
      `${ORIGIN}/@acme/acme-web`,
    ]);
  });
});

describe("robotsRules", () => {
  it("allows the public pages, disallows the signed-in paths, and names the sitemap", () => {
    expect(robotsRules(ORIGIN)).toEqual({
      rules: { userAgent: "*", allow: "/", disallow: ["/w/", "/app", "/api/", "/auth/", "/account", "/oauth"] },
      sitemap: `${ORIGIN}/sitemap.xml`,
    });
  });

  it("names the sitemap without a double slash when the origin ends with a slash", () => {
    expect(robotsRules(`${ORIGIN}/`).sitemap).toBe(`${ORIGIN}/sitemap.xml`);
  });

  it("never disallows a public page, a badge, or a card", () => {
    for (const path of ["/", "/docs", "/docs/providers/vercel", "/@acme/acme-web", "/badge/x/y.svg", "/card/x/y.png", "/opengraph-image"]) {
      expect(ROBOTS_DISALLOW.some((prefix) => path.startsWith(prefix))).toBe(false);
    }
  });
});

describe("siteMetadataBase", () => {
  it("is the configured site URL", () => {
    expect(siteMetadataBase(`${ORIGIN}/`)?.href).toBe(`${ORIGIN}/`);
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "  "],
  ])("is null when NEXT_PUBLIC_SITE_URL is %s", (_title, value) => {
    expect(siteMetadataBase(value)).toBeNull();
  });
});

describe("socialMetadata", () => {
  const page = { title: "Vercel", description: "StackDash reads deployments from Vercel.", path: "/docs/providers/vercel" };

  it("gives a page its own canonical address, cards, and the site image when the site URL is set", () => {
    expect(socialMetadata(page, ORIGIN)).toEqual({
      alternates: { canonical: page.path },
      openGraph: {
        type: "website",
        siteName: site.name,
        title: page.title,
        description: page.description,
        url: page.path,
        images: [SITE_IMAGE],
      },
      twitter: { card: "summary_large_image", title: page.title, description: page.description, images: [SITE_IMAGE] },
    });
  });

  it("uses the page's own images instead of the site image", () => {
    const card = { url: "/card/p/github_stars.png", width: 1200, height: 630, alt: "GitHub stars for Acme web" };
    const metadata = socialMetadata({ ...page, images: [card] }, ORIGIN);
    expect(metadata.openGraph?.images).toEqual([card]);
    expect(metadata.twitter?.images).toEqual([card]);
  });

  it.each([
    ["unset", undefined],
    ["blank", " "],
  ])("keeps the page's title and description but no absolute URL when the site URL is %s", (_title, value) => {
    expect(socialMetadata(page, value)).toEqual({
      openGraph: { type: "website", siteName: site.name, title: page.title, description: page.description, images: [] },
      twitter: { card: "summary", title: page.title, description: page.description, images: [] },
    });
  });

  it("has no canonical address or og:url without a path, as in the root layout", () => {
    const metadata = socialMetadata({ title: LANDING_TITLE, description: site.description }, ORIGIN);
    expect(metadata.alternates).toBeUndefined();
    expect(metadata.openGraph).not.toHaveProperty("url");
    expect(metadata.openGraph?.images).toEqual([SITE_IMAGE]);
  });
});
