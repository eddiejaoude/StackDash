import Link from "next/link";

import { ArrivalProviderChip, ArrivalProviderChips } from "@/components/timeline/arrival-events";
import { ProviderMark } from "@/components/ui/provider-mark";
import type { ConnectionEventCount } from "@/lib/data/timeline";
import { providerBadgeQuery, providerBadges, providerBadgeText } from "@/lib/timeline/provider-badges";
import { timelineHref, type TimelineQuery } from "@/lib/timeline/query";

/**
 * One chip per provider with events in view, in the title row (#245): its logo, its name, and how
 * many of its events match the current filters across every page, so nothing needs a hover. The
 * chips wrap when there are many; below `sm` the name is hidden and the logo and count remain. Each
 * chip is a link that shows only that provider, keeping every other filter, or back to every
 * provider when it is already the only one. The picture is hidden from assistive tech, because the
 * count is shortened ("1.5K"); one sentence with the exact counts and the provider's connections in
 * view is the link's name and the chip's tooltip.
 *
 * A Server Component: only the arrival wrappers around the list and each chip are client code, and
 * they glow a chip when its provider's count grows in a live refresh (#403).
 */
export function ProviderBadges({
  counts,
  action,
  query,
}: {
  counts: readonly ConnectionEventCount[];
  action: string;
  query: TimelineQuery;
}) {
  const badges = providerBadges(counts);
  return (
    // Mounted even with no chip, so the first chip in an empty view glows when its event arrives.
    <ArrivalProviderChips counts={Object.fromEntries(badges.map((badge) => [badge.provider, badge.events]))}>
      {badges.length === 0 ? null : (
        <ul aria-label="Events by provider" className="flex min-w-0 flex-wrap items-center gap-2">
          {badges.map((badge) => {
            const link = providerBadgeQuery(query, badge.provider);
            const { name, label, short } = providerBadgeText(badge, link.current);
            return (
              <ArrivalProviderChip key={badge.provider} provider={badge.provider}>
                <Link
                  href={timelineHref(action, link.query, null)}
                  scroll={false}
                  aria-current={link.current ? "page" : undefined}
                  className={`flex min-h-9 items-center rounded-lg border bg-panel py-1 pl-1 pr-3 text-sm transition-colors hover:border-accent ${
                    link.current ? "border-accent ring-1 ring-accent" : "border-line-strong"
                  }`}
                >
                  <span aria-hidden="true" title={name} className="flex items-center gap-2">
                    <ProviderMark provider={badge.provider} size="sm" />
                    <span className="hidden text-foreground sm:inline">{label}</span>
                    <span className="font-mono text-xs text-muted">{short}</span>
                  </span>
                  <span className="sr-only">{name}</span>
                </Link>
              </ArrivalProviderChip>
            );
          })}
        </ul>
      )}
    </ArrivalProviderChips>
  );
}
