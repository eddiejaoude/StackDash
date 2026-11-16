import type { ReactNode } from "react";

import { site } from "@/lib/site";
import { SITE_IMAGE } from "@/lib/site-metadata";

/*
 * The link preview card (#530): `SiteCard` with the `Frame` and `Tag` it uses, copied from `main`'s
 * src/lib/public-metrics/card-image.tsx (#338). Rendered by src/app/opengraph-image.tsx with
 * `ImageResponse` (node_modules/next/dist/docs/01-app/03-api-reference/04-functions/image-response.md):
 * flexbox only, and the renderer's bundled font, so no font file ships. Colors are the site's tokens
 * (src/app/globals.css); text is at least 4.5:1 against the background.
 */

const COLORS = {
  background: "#0a0a0a",
  foreground: "#ededed",
  muted: "#a1a1aa",
  accent: "#ff5d3b",
} as const;

const PADDING_PX = 64;

function Frame({ tag, children, footer }: { tag: ReactNode; children: ReactNode; footer: readonly [string, string] }) {
  return (
    <div
      style={{
        // In pixels: with height 100% the frame took its content's height, leaving a white band under short cards.
        width: SITE_IMAGE.width,
        height: SITE_IMAGE.height,
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: PADDING_PX,
        backgroundColor: COLORS.background,
        color: COLORS.foreground,
        fontSize: 28,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", fontSize: 36, color: COLORS.accent, letterSpacing: -1 }}>{site.name}</div>
        {tag}
      </div>
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>{children}</div>
      <div style={{ display: "flex", justifyContent: "space-between", color: COLORS.muted, fontSize: 24 }}>
        <div style={{ display: "flex" }}>{footer[0]}</div>
        <div style={{ display: "flex" }}>{footer[1]}</div>
      </div>
    </div>
  );
}

function Tag({ text, color }: { text: string; color: string }) {
  return (
    <div
      style={{
        display: "flex",
        padding: "8px 20px",
        borderRadius: 999,
        border: `2px solid ${color}`,
        color,
        fontSize: 24,
      }}
    >
      {text}
    </div>
  );
}

/**
 * What StackDash does and who it is for. The tag says "Coming soon" as the page's own pill does, so
 * a shared link never suggests the product is live; `main`'s card says "Open source" only.
 */
export function SiteCard() {
  return (
    <Frame tag={<Tag text="Coming soon · Open source" color={COLORS.accent} />} footer={[site.tagline, site.githubUrl.replace(/^https:\/\//, "")]}>
      <div style={{ display: "flex", fontSize: 68, lineHeight: 1.1, letterSpacing: -2 }}>{site.headline}</div>
      <div style={{ display: "flex", fontSize: 32, lineHeight: 1.3, marginTop: 28, color: COLORS.muted }}>{`For ${site.audience}.`}</div>
    </Frame>
  );
}
