import type { ReactNode } from "react";

/**
 * The page's one `<h1>`, with an optional summary and page-level actions. `titleAside` sits at the
 * end of the title's own row, for compact page-level status such as the timeline's provider
 * badges. `id` names the heading as a focus target, such as where a dialog returns focus when it
 * has no opener, so it also takes `tabIndex={-1}`.
 */
export function PageHeader({
  title,
  description,
  actions,
  titleAside,
  id,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  titleAside?: ReactNode;
  id?: string;
}) {
  const heading = (
    <h1 id={id} tabIndex={id === undefined ? undefined : -1} className="text-2xl font-semibold tracking-tight sm:text-3xl">
      {title}
    </h1>
  );
  return (
    <div className="flex flex-col gap-4 border-b border-line pb-6 sm:flex-row sm:items-end sm:justify-between">
      <div className={titleAside === undefined ? "min-w-0" : "min-w-0 flex-1"}>
        {titleAside === undefined ? (
          heading
        ) : (
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            {heading}
            {titleAside}
          </div>
        )}
        {description === undefined ? null : (
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">{description}</p>
        )}
      </div>
      {actions === undefined ? null : <div className="flex shrink-0 flex-wrap gap-3">{actions}</div>}
    </div>
  );
}
