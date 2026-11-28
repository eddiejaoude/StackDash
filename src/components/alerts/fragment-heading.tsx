"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * The scroll margin of a heading links land on (#312), so it stops below the sticky workspace
 * header (`src/app/w/[workspace]/layout.tsx`: its 3.5rem top row, the workspace nav under it, and
 * a border) rather than under it. Change it with that header's height.
 */
const SCROLL_MARGIN = "scroll-mt-32";

/**
 * A section heading that links land on by its fragment: the alerts pagers (#312), the links into
 * alert settings (#343), such as the email setting every alert email links to, and the setup
 * checklist's link to AI assistants (#674). When the page arrives on `#<id>`, the heading scrolls
 * into view and takes focus, so a screen reader says where the user is and the next Tab enters the
 * section (#313).
 *
 * The scroll is done here because the section streams in behind a Suspense boundary: when the
 * router, or the browser on a document load, looks for the fragment, the heading is not there yet.
 *
 * `cursor` is the page a paged list shows. A page stays mounted across a pager navigation (only its
 * search params change), so the effect runs when the cursor changes, not on mount alone. It also
 * runs on mount, deliberately: a reload, a shared link, or a pager pressed before hydration (a
 * full page load) arrives with the same fragment and lands on the same heading. A live refresh
 * keeps the cursor and never takes focus mid-task.
 */
export function FragmentHeading({ id, cursor = null, children }: { id: string; cursor?: string | null; children: ReactNode }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const heading = ref.current;
    if (heading === null || window.location.hash !== `#${id}`) return;
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }, [id, cursor]);
  return (
    // tabIndex -1 also lets the action flows move focus here (`after*FocusId` props).
    <h2 ref={ref} id={id} tabIndex={-1} className={`${SCROLL_MARGIN} text-sm font-semibold`}>
      {children}
    </h2>
  );
}
