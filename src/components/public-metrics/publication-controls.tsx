"use client";

import { createContext, startTransition, use, useActionState, useEffect, useId, useState, type ReactNode } from "react";

import {
  disableProjectPage,
  publishMetric,
  publishSelfReported,
  saveProjectPage,
  unpublishEverything,
  unpublishMetric,
  type PublicMetricActionResult,
} from "@/app/w/[workspace]/projects/[projectId]/public-metrics/actions";
import { inputClass } from "@/components/alerts/form-controls";
import { GuardedButton } from "@/components/guarded-button";
import { buttonClass } from "@/components/ui/button";
import { DialogError } from "@/components/ui/dialog-error";
import { FailureAnnouncement, LiveRegion } from "@/components/ui/live-region";
import { DialogActions, DialogCloseButton, ModalDialog, useModalDialog } from "@/components/ui/modal-dialog";
import { livePublicationsText, type LivePublicationCounts } from "@/lib/public-metrics/display";
import { PAGE_SLUG_MAX } from "@/lib/public-metrics/project-page";

import { SELF_REPORTED_LABEL_MAX, SELF_REPORTED_UNIT_MAX, type SelfReportedField } from "./self-reported-rules";

/*
 * Controls on the public metrics page (#148) and its project page settings (#150). A publish swaps
 * its form for an Unpublish button and the reverse, so success messages live in one polite live
 * region above the list (it outlives the control that triggered it) and focus moves to the section
 * heading named by the caller rather than being dropped. Failures stay beside the control, in an
 * assertive region.
 */

type Announce = (message: string, focusId: string) => void;
type Announcement = Readonly<{ message: string; focusId: string }>;

const AnnounceContext = createContext<Announce | null>(null);

export function PublicationAnnouncer({ children }: { children: ReactNode }) {
  const [announcement, setAnnouncement] = useState<Announcement | null>(null);
  // Set in a transition, which React batches with the action's own (https://react.dev/reference/
  // react/startTransition#caveats), so the message and the focus move commit with the server's new
  // tree. Focusing straight away left focus on a form that a slower commit (a client chunk still
  // loading, such as the share dialog's) then removed, dropping a keyboard user to the page body.
  const announce: Announce = (message, focusId) => startTransition(() => setAnnouncement({ message, focusId }));
  useEffect(() => {
    if (announcement !== null) document.getElementById(announcement.focusId)?.focus();
  }, [announcement]);
  return (
    <AnnounceContext value={announce}>
      <LiveRegion tone="status" className="text-sm">
        {announcement === null ? null : <p className="mt-6 text-success">{announcement.message}</p>}
      </LiveRegion>
      {children}
    </AnnounceContext>
  );
}

/** Runs an action, announcing success through the page's live region. */
export function useAnnouncedAction(
  action: (previous: PublicMetricActionResult | null, formData: FormData) => Promise<PublicMetricActionResult>,
  focusId: string,
) {
  const announce = use(AnnounceContext);
  if (announce === null) throw new Error("Publication controls must be rendered inside PublicationAnnouncer");
  return useActionState<PublicMetricActionResult | null, FormData>(async (previous, formData) => {
    const result = await action(previous, formData);
    if (result.ok) announce(result.message, focusId);
    return result;
  }, null);
}

function failureOf(state: PublicMetricActionResult | null) {
  return state !== null && !state.ok ? state : null;
}

export function Failure({ state }: { state: PublicMetricActionResult | null }) {
  return <FailureAnnouncement failure={failureOf(state)} className="text-sm" messageClassName="mt-2" />;
}

export type Choice = Readonly<{ value: string; label: string }>;

export function PublishMetricForm({
  workspaceSlug,
  projectId,
  metricId,
  metricLabel,
  roundings,
  delays,
  focusId,
}: {
  workspaceSlug: string;
  projectId: string;
  metricId: string;
  metricLabel: string;
  roundings: readonly Choice[];
  delays: readonly Choice[];
  /** Takes focus after a publish, when this form is replaced. */
  focusId: string;
}) {
  const [state, formAction, pending] = useAnnouncedAction(publishMetric, focusId);
  const roundingId = useId();
  const delayId = useId();
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="projectId" value={projectId} />
      <input type="hidden" name="metricId" value={metricId} />
      <div>
        <label htmlFor={roundingId} className="block text-xs font-medium text-muted">
          Rounding
        </label>
        <select id={roundingId} name="rounding" defaultValue="exact" className={`${inputClass} mt-1 border-line-strong`}>
          {roundings.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label htmlFor={delayId} className="block text-xs font-medium text-muted">
          Timing
        </label>
        <select id={delayId} name="delayDays" defaultValue="0" className={`${inputClass} mt-1 border-line-strong`}>
          {delays.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </select>
      </div>
      <button type="submit" disabled={pending} className={buttonClass("raised")}>
        {pending ? "Publishing" : "Publish"}
        <span className="sr-only"> {metricLabel}</span>
      </button>
      <div className="basis-full">
        <Failure state={state} />
      </div>
    </form>
  );
}

export function UnpublishButton({
  workspaceSlug,
  publicationId,
  label,
  focusId,
}: {
  workspaceSlug: string;
  publicationId: string;
  label: string;
  focusId: string;
}) {
  const [state, formAction, pending] = useAnnouncedAction(unpublishMetric, focusId);
  return (
    <form action={formAction}>
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="publicationId" value={publicationId} />
      <button type="submit" disabled={pending} className={buttonClass("raised", "xs")}>
        {pending ? "Unpublishing" : "Unpublish"}
        <span className="sr-only"> {label}</span>
      </button>
      <Failure state={state} />
    </form>
  );
}

/**
 * "Unpublish everything" plus a `ModalDialog` that names what it takes down before confirming,
 * like `DeleteProjectDialog`: every live metric and published achievement of every project in the
 * workspace, not only this page's. Escape or Cancel closes it and focus goes back to the button.
 * After it succeeds the button is gone, so focus goes to the section named by `focusId` instead.
 */
export function UnpublishEverythingButton({
  workspaceSlug,
  liveCounts,
  focusId,
}: {
  workspaceSlug: string;
  /** What the whole workspace has public: metrics (engine and self-reported) and achievements. */
  liveCounts: LivePublicationCounts;
  focusId: string;
}) {
  const dialog = useModalDialog();
  const total = liveCounts.metrics + liveCounts.achievements;

  return (
    <>
      <button type="button" onClick={(event) => dialog.open(event.currentTarget)} className={buttonClass("danger-outline")}>
        Unpublish everything
      </button>
      <ModalDialog
        dialog={dialog}
        title="Unpublish everything in this workspace?"
        description={
          <div className="space-y-2">
            <p>
              {livePublicationsText(liveCounts)} {total === 1 ? "stops" : "stop"} being public, across every project in
              this workspace, not only this one.
            </p>
            <p>
              Anything that reads them shows nothing within a minute. To publish again, publish each one again: a metric
              with its rounding and timing, an achievement from its project&apos;s Achievements page.
            </p>
          </div>
        }
      >
        <UnpublishEverythingConfirmation
          workspaceSlug={workspaceSlug}
          focusId={focusId}
          onDone={() => dialog.close("completed")}
        />
      </ModalDialog>
    </>
  );
}

function UnpublishEverythingConfirmation({
  workspaceSlug,
  focusId,
  onDone,
}: {
  workspaceSlug: string;
  focusId: string;
  onDone: () => void;
}) {
  // The dialog closes before the success is announced, so focus lands on `focusId`, not the trigger.
  const [state, formAction, pending] = useAnnouncedAction(async (previous, formData) => {
    const result = await unpublishEverything(previous, formData);
    if (result.ok) onDone();
    return result;
  }, focusId);

  return (
    <form action={formAction}>
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <DialogError failure={failureOf(state)} />
      <DialogActions>
        <DialogCloseButton unavailable={pending} />
        <GuardedButton type="submit" unavailable={pending} className={buttonClass("danger")}>
          {pending ? "Unpublishing everything" : "Unpublish everything"}
        </GuardedButton>
      </DialogActions>
    </form>
  );
}

const SELF_REPORTED_FIELDS: readonly { name: SelfReportedField; label: string; hint: string; maxLength: number; inputMode?: "numeric" }[] = [
  { name: "label", label: "Name", hint: "For example, Downloads this month.", maxLength: SELF_REPORTED_LABEL_MAX },
  { name: "value", label: "Value", hint: "A whole number.", maxLength: 13, inputMode: "numeric" },
  { name: "unit", label: "Unit", hint: "For example, downloads.", maxLength: SELF_REPORTED_UNIT_MAX },
];

export function SelfReportedForm({
  workspaceSlug,
  projectId,
  focusId,
}: {
  workspaceSlug: string;
  projectId: string;
  focusId: string;
}) {
  const announce = use(AnnounceContext);
  if (announce === null) throw new Error("Publication controls must be rendered inside PublicationAnnouncer");
  const baseId = useId();
  // Controlled, so a rejected value stays in its field to be corrected (a form action resets
  // uncontrolled fields) and a published one is cleared.
  const [values, setValues] = useState<Record<SelfReportedField, string>>({ label: "", value: "", unit: "" });
  const [state, formAction, pending] = useActionState<PublicMetricActionResult | null, FormData>(
    async (previous, formData) => {
      const result = await publishSelfReported(previous, formData);
      if (result.ok) {
        setValues({ label: "", value: "", unit: "" });
        announce(result.message, focusId);
      } else {
        // Focus the first field the message is about, so its error is read out with it.
        const first = SELF_REPORTED_FIELDS.find((field) => result.fieldErrors?.[field.name] !== undefined);
        if (first !== undefined) document.getElementById(`${baseId}-${first.name}`)?.focus();
      }
      return result;
    },
    null,
  );
  const fieldErrors = state !== null && !state.ok ? (state.fieldErrors ?? {}) : {};
  return (
    <form action={formAction} noValidate className="grid gap-4 sm:grid-cols-3">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="projectId" value={projectId} />
      {SELF_REPORTED_FIELDS.map((field) => {
        const id = `${baseId}-${field.name}`;
        const error = fieldErrors[field.name];
        return (
          <div key={field.name}>
            <label htmlFor={id} className="block text-sm font-medium">
              {field.label}
            </label>
            <p id={`${id}-hint`} className="mt-1 text-sm text-muted">
              {field.hint}
            </p>
            <input
              id={id}
              name={field.name}
              required
              maxLength={field.maxLength}
              inputMode={field.inputMode}
              value={values[field.name]}
              onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
              aria-invalid={error === undefined ? undefined : true}
              aria-describedby={error === undefined ? `${id}-hint` : `${id}-hint ${id}-error`}
              className={`${inputClass} mt-2 ${error === undefined ? "border-line-strong" : "border-danger"}`}
            />
            {error === undefined ? null : (
              <p id={`${id}-error`} className="mt-2 text-sm text-danger">
                <span className="font-medium">Error: </span>
                {error}
              </p>
            )}
          </div>
        );
      })}
      <div className="sm:col-span-3">
        <button type="submit" disabled={pending} className={buttonClass("primary")}>
          {pending ? "Publishing" : "Publish value"}
        </button>
        <Failure state={state} />
      </div>
    </form>
  );
}

/**
 * Turns the project page on with an address and an indexing choice, or saves new ones while it is
 * on. Controlled, so a refused address stays in its field to be corrected.
 */
export function ProjectPageForm({
  workspaceSlug,
  workspaceAddress,
  projectId,
  initialSlug,
  initialIndexable,
  enabled,
  focusId,
}: {
  workspaceSlug: string;
  /** The first segment of the page's address: the workspace's handle when set, otherwise its slug. */
  workspaceAddress: string;
  projectId: string;
  initialSlug: string;
  initialIndexable: boolean;
  enabled: boolean;
  focusId: string;
}) {
  const announce = use(AnnounceContext);
  if (announce === null) throw new Error("Publication controls must be rendered inside PublicationAnnouncer");
  const baseId = useId();
  const slugId = `${baseId}-slug`;
  const indexableId = `${baseId}-indexable`;
  const [slug, setSlug] = useState(initialSlug);
  const [indexable, setIndexable] = useState(initialIndexable);
  const [state, formAction, pending] = useActionState<PublicMetricActionResult | null, FormData>(async (previous, formData) => {
    const result = await saveProjectPage(previous, formData);
    if (result.ok) announce(result.message, focusId);
    else if (result.fieldErrors?.slug !== undefined) document.getElementById(slugId)?.focus();
    return result;
  }, null);
  const error = state !== null && !state.ok ? state.fieldErrors?.slug : undefined;
  return (
    <form action={formAction} noValidate className="space-y-4">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="projectId" value={projectId} />
      <div>
        <label htmlFor={slugId} className="block text-sm font-medium">
          Address
        </label>
        <p id={`${slugId}-hint`} className="mt-1 text-sm text-muted">
          The page opens at <span className="font-mono">/@{workspaceAddress}/</span> followed by this. Lowercase letters,
          numbers, and hyphens.
        </p>
        <input
          id={slugId}
          name="slug"
          required
          maxLength={PAGE_SLUG_MAX}
          autoComplete="off"
          spellCheck={false}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? `${slugId}-hint` : `${slugId}-hint ${slugId}-error`}
          className={`${inputClass} mt-2 w-full max-w-sm font-mono ${error === undefined ? "border-line-strong" : "border-danger"}`}
        />
        {error === undefined ? null : (
          <p id={`${slugId}-error`} className="mt-2 text-sm text-danger">
            <span className="font-medium">Error: </span>
            {error}
          </p>
        )}
      </div>
      <div>
        <label htmlFor={indexableId} className="flex min-h-6 cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            id={indexableId}
            type="checkbox"
            name="indexable"
            checked={indexable}
            onChange={(event) => setIndexable(event.target.checked)}
            aria-describedby={`${indexableId}-hint`}
            className="size-4 shrink-0 accent-accent"
          />
          Let search engines index this page
        </label>
        <p id={`${indexableId}-hint`} className="mt-1 text-sm text-muted">
          When this is off, the page asks search engines not to index it and stays out of the sitemap. Anyone with the
          address can still open it.
        </p>
      </div>
      <div>
        <button type="submit" disabled={pending} className={buttonClass("primary")}>
          {pending ? "Saving" : enabled ? "Save page settings" : "Turn on the project page"}
        </button>
        <Failure state={state} />
      </div>
    </form>
  );
}

/** Turns the project page off. Safe to undo, so it asks for no confirmation. */
export function DisableProjectPageButton({
  workspaceSlug,
  projectId,
  focusId,
}: {
  workspaceSlug: string;
  projectId: string;
  focusId: string;
}) {
  const [state, formAction, pending] = useAnnouncedAction(disableProjectPage, focusId);
  return (
    <form action={formAction}>
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="projectId" value={projectId} />
      <button type="submit" disabled={pending} className={buttonClass("raised", "xs")}>
        {pending ? "Turning off the project page" : "Turn off the project page"}
      </button>
      <Failure state={state} />
    </form>
  );
}
