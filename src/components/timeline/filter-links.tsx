"use client";

import { useEffect, useLayoutEffect, useRef, type MouseEvent, type ReactNode } from "react";

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

/**
 * The list of active filter chips. A chip links to the view without its filter, so activating it
 * unmounts it, and Next leaves focus alone on a navigation (`InnerScrollHandler` in
 * `next/dist/client/components/layout-router.js`, Next 16.4.3: "This handler intentionally leaves
 * focus untouched"), so focus would fall to the page. Once the new list renders, focus goes to the
 * chip that took the removed one's place, to the last chip when the removed one was last, or to
 * `emptyFocusId` when no chip is left. It moves only after a chip's own client navigation and only
 * when focus is on nothing, so it never takes focus from where someone put it. Rendered even with
 * no chips, so it is still mounted when the last one goes.
 */
export function ActiveFilterList({
  chipKeys,
  emptyFocusId,
  label,
  className,
  children,
}: {
  /** One key per chip, in order. */
  chipKeys: readonly string[];
  emptyFocusId: string;
  label: string;
  className: string;
  children: ReactNode;
}) {
  const listRef = useRef<HTMLUListElement>(null);
  const removedIndex = useRef<number | null>(null);
  // A string, so a re-render with the same chips (a live refresh) does not run the effect.
  const chipKeyList = chipKeys.join("\n");
  useEffect(() => {
    const index = removedIndex.current;
    removedIndex.current = null;
    if (index === null) return;
    const focused = document.activeElement;
    if (focused !== null && focused !== document.body) return;
    const chips = listRef.current === null ? [] : [...listRef.current.querySelectorAll<HTMLElement>(":scope > li > a")];
    (chips[Math.min(index, chips.length - 1)] ?? document.getElementById(emptyFocusId))?.focus();
  }, [chipKeyList, emptyFocusId]);

  const remember = (event: MouseEvent<HTMLUListElement>) => {
    // `Link` cancels the browser's navigation exactly when it navigates on the client, so a click
    // that opens a new tab, which removes nothing here, is left alone.
    if (!event.defaultPrevented || !(event.target instanceof Element)) return;
    const item = event.target.closest("li");
    const index = item === null ? -1 : [...event.currentTarget.children].indexOf(item);
    if (index >= 0) removedIndex.current = index;
  };

  if (chipKeys.length === 0) return null;
  return (
    // The click handler only notes which chip navigated; each chip is a link with its own name.
    <ul ref={listRef} aria-label={label} className={className} onClick={remember}>
      {children}
    </ul>
  );
}
