import type { Metadata } from "next";

import { site } from "@/lib/site";

/*
 * The placeholder's link preview (#530), ported from `main`'s src/lib/site-metadata.ts (#338).
 * `main` reads the origin from NEXT_PUBLIC_SITE_URL because self-hosters serve from their own; the
 * placeholder only ever serves `site.url`, so the origin is fixed and nothing needs configuring.
 */

/** The page's title: the document title and the preview title. */
const PLACEHOLDER_TITLE = `${site.name}: coming soon`;

/**
 * The 1200 by 630 preview image, src/app/opengraph-image.tsx. The file convention writes the
 * `og:image` and `twitter:image` tags itself, with a cache hash, and replaces any `images` named in
 * the metadata below, so none are named there.
 */
export const SITE_IMAGE = {
  width: 1200,
  height: 630,
  alt: `${site.name}, coming soon: ${site.headline}`,
} as const;

/** The root layout's metadata: title, description, canonical address, and the Open Graph and Twitter cards. */
export const siteMetadata: Metadata = {
  metadataBase: new URL(site.url),
  title: PLACEHOLDER_TITLE,
  description: site.description,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: site.name,
    title: PLACEHOLDER_TITLE,
    description: site.description,
    url: "/",
  },
  twitter: {
    card: "summary_large_image",
    title: PLACEHOLDER_TITLE,
    description: site.description,
  },
};
