"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

export type SwitcherWorkspace = {
  slug: string;
  name: string;
  /** Where the workspace opens; computed by the server, since the default section lives in server-only code. */
  href: string;
};

/**
 * Lists every workspace the user belongs to. Switching is plain navigation to that workspace's
 * URL, never hidden session state, so links and the back button stay correct. A disclosure, not
 * a menu widget: links keep their native keyboard behavior and there is no focus trap.
 */
export function WorkspaceSwitcher({
  workspaces,
  currentSlug,
}: {
  workspaces: readonly SwitcherWorkspace[];
  currentSlug: string | null;
}) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const current = workspaces.find((workspace) => workspace.slug === currentSlug);

  // Close when the pointer goes down anywhere outside the switcher.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (event.target instanceof Node && rootRef.current?.contains(event.target)) return;
      setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && open) {
      setOpen(false);
      buttonRef.current?.focus();
    }
  }

  // Tabbing past the last workspace closes the list instead of leaving it open behind the focus.
  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (event.relatedTarget instanceof Node && rootRef.current?.contains(event.relatedTarget)) return;
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative min-w-0" onKeyDown={onKeyDown} onBlur={onBlur}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-9 max-w-[7.5rem] items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-sm transition-colors hover:border-line-strong sm:max-w-[16rem]"
      >
        <span className="sr-only">Workspace: </span>
        <span className="truncate">{current?.name ?? "Choose a workspace"}</span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="shrink-0 text-muted"
        >
          <path d="m7 15 5 5 5-5" />
          <path d="m7 9 5-5 5 5" />
        </svg>
      </button>

      <div
        id={listId}
        hidden={!open}
        className="absolute left-0 top-full z-50 mt-2 w-64 max-w-[calc(100vw-3rem)] rounded-lg border border-line-strong bg-panel-raised p-1.5 shadow-xl shadow-black/40"
      >
        <p className="px-2.5 pb-1.5 pt-1 font-mono text-[11px] text-muted">
          Your workspaces
        </p>
        <ul className="max-h-80 overflow-y-auto">
          {workspaces.map((workspace) => {
            const isCurrent = workspace.slug === currentSlug;
            return (
              <li key={workspace.slug}>
                <Link
                  href={workspace.href}
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => setOpen(false)}
                  className={`flex min-h-9 items-center justify-between gap-3 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-panel ${
                    isCurrent ? "font-medium text-foreground" : "text-muted hover:text-foreground"
                  }`}
                >
                  <span className="truncate">{workspace.name}</span>
                  {isCurrent ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs text-accent">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                      Current
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
