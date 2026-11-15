import type { Metadata, Viewport } from "next";
import { SkipLink } from "@/components/skip-link";
import { WebAnalytics } from "@/components/web-analytics";
import { onVercel } from "@/lib/env";
import { site } from "@/lib/site";
import { LANDING_TITLE, siteMetadataBase, socialMetadata } from "@/lib/site-metadata";
import { documentClassName } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  // NEXT_PUBLIC_SITE_URL; unset means no absolute URLs in metadata (src/lib/site-metadata.ts).
  metadataBase: siteMetadataBase(),
  title: {
    default: LANDING_TITLE,
    template: `%s · ${site.name}`,
  },
  description: site.description,
  // The cards a page without its own inherits. No path: a canonical address here would be every page's.
  ...socialMetadata({ title: LANDING_TITLE, description: site.description }),
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={documentClassName}>
      <body className="flex min-h-full flex-col">
        <SkipLink targetId="main" placement="focus:left-4 focus:top-4 focus:z-[60]">
          Skip to content
        </SkipLink>
        {children}
        {onVercel() ? <WebAnalytics /> : null}
      </body>
    </html>
  );
}
