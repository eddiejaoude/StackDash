import Link from "next/link";
import { useId, type ReactNode } from "react";

import { ArrowRightIcon, LockIcon } from "@/components/icons";
import { buttonClass } from "@/components/ui/button";

export type EmptyStateAction = {
  href: string;
  label: string;
};

/**
 * What a section shows before it has data: what goes here, what to do first, and the control that
 * does it. When the viewer's role cannot take that step, the control is replaced by the reason, so
 * nobody is left looking for a button they cannot use.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  deniedReason,
  secondaryAction,
  children,
}: {
  title: string;
  description: string;
  icon?: ReactNode;
  action?: EmptyStateAction | undefined;
  /** Set when the current role cannot take `action`; shown in its place. */
  deniedReason?: string | undefined;
  /**
   * A second control beside `action`, such as a form; hidden with it when `deniedReason` is set.
   * It joins the row of actions, which wraps. A control that shows a message under itself should
   * draw no box of its own (`contents`) and give the message a whole line (`basis-full`), so the
   * control and the message are separate items of the row and the message never widens it (#666).
   */
  secondaryAction?: ReactNode;
  /** Extra controls, such as a list of choices, shown below the description. */
  children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="mt-8 rounded-xl border border-dashed border-line-strong bg-panel px-6 py-12 text-center sm:px-10"
    >
      {icon === undefined ? null : (
        <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-lg border border-line bg-panel-raised text-accent">
          {icon}
        </div>
      )}
      <h2 id={titleId} className="text-lg font-semibold tracking-tight">
        {title}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-muted">{description}</p>

      {children}

      {deniedReason !== undefined ? (
        <p className="mx-auto mt-6 flex max-w-md items-center justify-center gap-2 text-sm text-muted">
          <LockIcon className="shrink-0" />
          <span>{deniedReason}</span>
        </p>
      ) : action === undefined ? null : (
        <div className="mt-6 flex flex-wrap items-start justify-center gap-3">
          <Link
            href={action.href}
            className={`gap-2 ${buttonClass("primary")}`}
          >
            {action.label}
            <ArrowRightIcon />
          </Link>
          {secondaryAction}
        </div>
      )}
    </section>
  );
}
