import { Analytics } from "@vercel/analytics/next";
import type { Metadata, Viewport } from "next";
import { siteMetadata } from "@/lib/site-metadata";
import { documentClassName } from "./fonts";
import "./globals.css";

export const metadata: Metadata = siteMetadata;

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={documentClassName}>
      <body className="flex min-h-full flex-col">
        {children}
        {/* Vercel Web Analytics: page views only, no cookies. On Vercel it loads from this origin. */}
        <Analytics />
      </body>
    </html>
  );
}
