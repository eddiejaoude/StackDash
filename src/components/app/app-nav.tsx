"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useRef, useState, type KeyboardEvent } from "react";

const SECTIONS = [
  { segment: "timeline", label: "Timeline" },
  { segment: "dashboard", label: "Dashboard" },
  { segment: "connections", label: "Connections" },
  { segment: "alerts", label: "Alerts" },
  { segment: "projects", label: "Projects" },
  { segment: "settings", label: "Settings" },
] as const;

/**
 * Primary navigation for a workspace. A client leaf only because it reads the pathname to mark
 * the current section. Below the md breakpoint the links collapse behind a disclosure button;
 * it is not a modal, so there is no focus trap and the page stays reachable.
 */
export function AppNav({ workspaceSlug }: { workspaceSlug: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const base = `/w/${workspaceSlug}`;
  const current = SECTIONS.find(
    (section) => pathname === `${base}/${section.segment}` || pathname.startsWith(`${base}/${section.segment}/`),
  );

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && open) {
      setOpen(false);
      buttonRef.current?.focus();
    }
  }

  return (
    <nav aria-label="Workspace" onKeyDown={onKeyDown} className="border-t border-line md:border-t-0">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 w-full items-center justify-between gap-2 text-sm md:hidden"
      >
        <span>
          <span className="text-muted">Menu</span>
          {current === undefined ? null : <span className="ml-2 font-medium">{current.label}</span>}
        </span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className={`transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      <ul
        id={listId}
        className={`${open ? "flex" : "hidden"} flex-col gap-1 pb-3 md:flex md:flex-row md:gap-1 md:pb-0`}
      >
        {SECTIONS.map((section) => {
          const isCurrent = section === current;
          return (
            <li key={section.segment}>
              <Link
                href={`${base}/${section.segment}`}
                aria-current={isCurrent ? "page" : undefined}
                onClick={() => setOpen(false)}
                className={`flex min-h-10 items-center rounded-md px-3 text-sm transition-colors md:min-h-11 md:rounded-none md:border-b-2 md:px-3 ${
                  isCurrent
                    ? "bg-panel-raised font-medium text-foreground md:border-accent md:bg-transparent"
                    : "text-muted hover:bg-panel-raised hover:text-foreground md:border-transparent md:hover:bg-transparent"
                }`}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
