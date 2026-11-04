import Form from "next/form";
import Link from "next/link";
import { useId, type ReactNode } from "react";

import { ChevronDownIcon, FilterIcon } from "@/components/icons";
import type { ScopeFilters, ScopeOption, ScopeOptions } from "@/lib/filters/scope";

const CHECKBOX_LABEL = "flex min-h-6 cursor-pointer items-center gap-2 px-1 text-sm";
const CHECKBOX = "size-4 shrink-0 accent-accent";

function OptionGroup({
  legend,
  name,
  options,
  selected,
  emptyText,
}: {
  legend: string;
  name: string;
  options: readonly ScopeOption[];
  selected: readonly string[];
  emptyText: string;
}) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-medium">{legend}</legend>
      {options.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{emptyText}</p>
      ) : (
        <div className="mt-2 grid max-h-56 gap-1 overflow-y-auto pr-1">
          {options.map((option) => (
            <label key={option.value} className={CHECKBOX_LABEL}>
              <input
                type="checkbox"
                name={name}
                value={option.value}
                defaultChecked={selected.includes(option.value)}
                className={CHECKBOX}
              />
              <span className="min-w-0 break-words">{option.label}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/**
 * The one filter control for the dashboard and the timeline: provider, project, and account,
 * plus any screen-specific fields passed as `children`. A plain GET form, so the filter lives in
 * the URL: a filtered view can be bookmarked, shared, and reloaded, and it works before any
 * JavaScript loads. Native checkboxes keep it keyboard operable.
 *
 * The form sits inside a native `details` element that starts closed, so the data leads the page
 * and the controls stay one click (or Enter) away; it opens as a panel under the whole bar. The
 * bar itself carries the page's `status` sentence (the "Showing ..." result, announced as a live
 * region) and how many filters are active, so nothing is lost while the form is closed.
 */
export function ScopeFilter({
  action,
  scope,
  options,
  status,
  extraActiveCount = 0,
  hidden,
  resetKey,
  children,
}: {
  action: string;
  scope: ScopeFilters;
  options: ScopeOptions;
  /** The result in words, such as "Showing 3 events for provider GitHub". */
  status: string;
  /** Active screen-specific filters (the timeline's types, severities, and dates). */
  extraActiveCount?: number | undefined;
  /** Other URL state the form must carry, such as the dashboard's trend period. */
  hidden?: Readonly<Record<string, string>> | undefined;
  /** Changes when the screen's own fields change, so their uncontrolled inputs reset too. */
  resetKey?: string | undefined;
  children?: ReactNode;
}) {
  const titleId = useId();
  const activeCount = scope.providers.length + scope.projects.length + scope.accounts.length + extraActiveCount;
  // Inputs are uncontrolled, so the disclosure and its form remount when the filters in the URL
  // change; otherwise a client navigation (Apply filters, Clear filters, a severity link) would
  // leave the old boxes ticked and the panel open over the new result.
  const formKey = JSON.stringify([scope.providers, scope.projects, scope.accounts, resetKey ?? ""]);
  return (
    <section
      aria-labelledby={titleId}
      className="relative mt-4 flex min-h-12 flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-xl border border-line bg-panel px-4"
    >
      {/* The status sits outside the disclosure so it is announced as a live region and does not
          become part of the toggle's accessible name (a summary's children are presentational). */}
      <p role="status" aria-live="polite" className="min-w-0 break-words text-sm text-muted">
        {status}
      </p>
      {/* `details` stays static, so the absolutely positioned panel spans the whole bar. */}
      <details key={formKey} className="group">
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-md text-sm [&::-webkit-details-marker]:hidden">
          <FilterIcon className="size-4 text-muted" />
          <span id={titleId} className="font-semibold">
            Filters
          </span>
          {activeCount === 0 ? null : (
            <span className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-xs font-medium text-foreground">
              {activeCount} active
            </span>
          )}
          <ChevronDownIcon className="size-4 shrink-0 text-muted transition-transform motion-reduce:transition-none group-open:rotate-180" />
        </summary>
        <Form
          action={action}
          className="absolute inset-x-0 top-full z-20 mt-2 grid gap-6 rounded-xl border border-line bg-panel px-4 py-4 shadow-lg"
        >
          {Object.entries(hidden ?? {}).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
        <div className="grid gap-6 md:grid-cols-3">
          <OptionGroup
            legend="Provider"
            name="provider"
            options={options.providers}
            selected={scope.providers}
            emptyText="No providers connected yet."
          />
          <OptionGroup
            legend="Project"
            name="project"
            options={options.projects}
            selected={scope.projects}
            emptyText="No projects yet."
          />
          <OptionGroup
            legend="Account"
            name="account"
            options={options.accounts}
            selected={scope.accounts}
            emptyText="No provider accounts yet."
          />
        </div>
        {children}
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            className="inline-flex min-h-10 items-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85"
          >
            Apply filters
          </button>
          <Link
            href={action}
            className="inline-flex min-h-10 items-center rounded-md border border-line-strong px-4 py-2 text-sm text-muted transition-colors hover:text-foreground"
          >
            Clear filters
          </Link>
        </div>
        </Form>
      </details>
    </section>
  );
}
