import Link from "next/link";

import { buttonClass } from "@/components/ui/button";

/**
 * The not-found page inside a workspace's shell: what could not be found, why that may be, and the
 * one link to go on from. The workspace's own not-found page and its item pages' (#484) share it,
 * so a missing workspace and a missing connection look alike and differ only in what they name.
 */
export function NotFoundPanel({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: { href: string; label: string };
}) {
  return (
    <div className="mx-auto max-w-xl rounded-xl border border-line bg-panel px-6 py-10 sm:px-10">
      <p className="font-mono text-[11px] font-medium text-muted">Not found</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-sm leading-6 text-muted">{description}</p>
      <div className="mt-6">
        <Link
          href={action.href}
          className={buttonClass("primary")}
        >
          {action.label}
        </Link>
      </div>
    </div>
  );
}
