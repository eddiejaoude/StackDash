import Link from "next/link";

import { GitHubButton } from "@/components/github-button";
import { StatusBadge } from "@/components/status-badge";
import { Wordmark } from "@/components/wordmark";
import { docsLink, navLinks, signInLink } from "@/lib/site";

interface SiteNavProps {
  /** "/" off the landing page, so the section anchors lead back to it. */
  anchorBase?: "" | "/";
}

/**
 * Sticky top nav. A server component: on small screens the section links hide and the page
 * itself is the menu, so the landing page ships no client JavaScript for navigation. Sign in
 * stays visible at every width. Below sm the wordmark shrinks and the GitHub button shows only its
 * mark, so a 320 px phone keeps the wordmark, Sign in, and GitHub on one row with room to spare:
 * at full label the row fitted a 390 px phone by under 3 px, and CI's font rendering wrapped it.
 * The row still wraps rather than overflows when it cannot fit, for example with enlarged text:
 * the actions drop below the wordmark.
 */
export function SiteNav({ anchorBase = "" }: SiteNavProps) {
  return (
    <header className="sticky top-0 z-50 border-b border-line bg-background/80 backdrop-blur-md">
      <nav
        aria-label="Main"
        className="mx-auto flex min-h-16 w-full max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-6 py-3"
      >
        <div className="flex items-center gap-2">
          <a href={`${anchorBase}#top`} className="inline-flex min-h-6 shrink-0 items-center">
            <Wordmark size="site" />
          </a>
          <span className="hidden sm:inline">
            <StatusBadge />
          </span>
        </div>

        <ul className="hidden items-center gap-8 lg:flex">
          {navLinks.map((link) => (
            <li key={link.href}>
              <a
                href={`${anchorBase}${link.href}`}
                className="inline-flex min-h-6 items-center text-sm text-muted transition-colors hover:text-foreground"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-4">
          <ul className="flex items-center gap-4">
            <li className="hidden sm:block">
              <Link
                href={docsLink.href}
                className="inline-flex min-h-6 items-center text-sm text-muted transition-colors hover:text-foreground"
              >
                {docsLink.label}
              </Link>
            </li>
            <li>
              <Link
                href={signInLink.href}
                className="inline-flex min-h-6 items-center text-sm font-medium text-foreground transition-colors hover:text-accent"
              >
                {signInLink.label}
              </Link>
            </li>
          </ul>
          <GitHubButton size="sm" iconOnlyOnPhone />
        </div>
      </nav>
    </header>
  );
}
