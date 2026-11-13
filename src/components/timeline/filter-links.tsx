"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";

/*
 * The client leaves of `timeline-filters.tsx`, which stays a Server Component. Each wraps the
 * server-rendered links it is given as `children` and adds one behavior a row of links cannot get
 * from the server (#406).
 */

/**
 * The severity links' row. Below `sm` it scrolls sideways and starts at its left edge, so the
 * current view's link (Critical is the last) could sit past the right edge with no selected link in
 * view. Whenever the current link changes, the row scrolls sideways just enough to show it whole,
 * padding included so its focus outline shows too. Sideways only: `scrollIntoView` would also
 * scroll the page to the row.
 *
 * Why client code: CSS `scroll-initial-target: nearest` on the current link needs none, but MDN's
 * browser compatibility data (8.1.9, 2026-11-12) has it in Chrome, Edge, and Samsung Internet 29
 * only: not Safari, so no browser on iOS, where most of the narrow screens this is for are, and not
 * Firefox. It also acts only when the row is first rendered, not after a client navigation that
 * keeps the row, such as Back to a severity or choosing one in the filter form.
 */
export function SeverityLinkRow({
  current,
  label,
  className,
  children,
}: {
  /** The current link's label, or null when no link is current. */
  current: string | null;
  label: string;
  className: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const row = ref.current;
    const link = row?.querySelector('[aria-current="page"]');
    if (row === null || link === null || link === undefined) return;
    const style = getComputedStyle(row);
    const rowBox = row.getBoundingClientRect();
    const linkBox = link.getBoundingClientRect();
    const hiddenBefore = rowBox.left + parseFloat(style.paddingLeft) - linkBox.left;
    const hiddenAfter = linkBox.right - (rowBox.right - parseFloat(style.paddingRight));
    if (hiddenBefore > 0) row.scrollLeft -= hiddenBefore;
    else if (hiddenAfter > 0) row.scrollLeft += hiddenAfter;
  }, [current]);
  return (
    <nav ref={ref} aria-label={label} className={className}>
      {children}
    </nav>
  );
}
