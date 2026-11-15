import type { Metadata, Viewport } from "next";
import { connection } from "next/server";

import { SkipLink } from "@/components/skip-link";
import { WebAnalytics } from "@/components/web-analytics";
import { onVercel } from "@/lib/env";
import { site } from "@/lib/site";

import { documentClassName } from "./fonts";
import { metadata as rootMetadata, viewport as rootViewport } from "./layout";
import NotFound from "./not-found";
import "./globals.css";

// This document replaces the root layout, so it takes the layout's metadata itself: the origin
// that resolves the root preview image (src/app/opengraph-image.tsx, which Next.js attaches here
// too) and the default cards (#338). The title template does not apply: name the site here.
export const metadata: Metadata = { ...rootMetadata, title: `Page not found · ${site.name}` };
export const viewport: Viewport = rootViewport;

// Next.js answers every URL that matches no route with this page (experimental.globalNotFound in
// next.config.ts), including unmatched paths under /app, /w/<slug>, and /auth, where the proxy
// enforces the nonce CSP (src/proxy.ts). A page prerendered at build time carries no nonce, and its
// scripts would be blocked, so this one renders per request like the app entry segments: it awaits
// `connection()` before anything renders and allows an empty static shell (#125, #197). The cost:
// every 404 on the site is a render instead of a cached file.
//
// This is not `not-found.tsx`: Next.js renders that one into every route as the root not-found
// boundary, so request data there would make the prerendered pages, the docs included, fail.
export const instant = false;

export default async function GlobalNotFound() {
  await connection();
  return (
    <html lang="en" className={documentClassName}>
      <body className="flex min-h-full flex-col">
        <SkipLink targetId="main" placement="focus:left-4 focus:top-4 focus:z-[60]">
          Skip to content
        </SkipLink>
        <NotFound />
        {onVercel() ? <WebAnalytics /> : null}
      </body>
    </html>
  );
}
