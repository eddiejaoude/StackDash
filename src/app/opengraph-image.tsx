import { ImageResponse } from "next/og";

import { SiteCard } from "@/lib/site-card";
import { SITE_IMAGE } from "@/lib/site-metadata";

/*
 * The link preview image (#530) at /opengraph-image, as on `main` (#338). The opengraph-image file
 * convention
 * (node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/01-metadata/opengraph-image.md):
 * no request data, so it is generated once at build time and served as a static file. It also
 * writes the page's `og:image` tags, which Next.js copies to `twitter:image`; see SITE_IMAGE in
 * src/lib/site-metadata.ts.
 */

export const alt = SITE_IMAGE.alt;
export const size = { width: SITE_IMAGE.width, height: SITE_IMAGE.height };
export const contentType = "image/png";

export default function Image() {
  return new ImageResponse(<SiteCard />, size);
}
