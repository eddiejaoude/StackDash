"use client";

import { useActionState, useEffect, useId, useRef, type ReactNode } from "react";

import {
  assignAccountProject,
  deleteConnection,
  disconnect,
  setAccountIncluded,
  syncNow,
  type ConnectionActionResult,
} from "@/app/w/[workspace]/connections/actions";

type Action = (previous: ConnectionActionResult | null, formData: FormData) => Promise<ConnectionActionResult>;

const PRIMARY =
  "inline-flex min-h-10 shrink-0 items-center justify-center rounded-md bg-accent px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-85 disabled:opacity-60";
const SECONDARY =
  "inline-flex min-h-10 shrink-0 items-center justify-center rounded-md border border-line-strong px-4 py-2 text-sm transition-colors hover:border-foreground disabled:opacity-60";
const DANGER =
  "inline-flex min-h-10 shrink-0 items-center justify-center rounded-md border border-danger/60 px-4 py-2 text-sm text-danger transition-colors hover:bg-danger/10 disabled:opacity-60";

// The account forms sit side by side in the page's three-row grid (label, controls, status) from
// `sm` up and take those rows as a subgrid, so their controls share a row.
const ACCOUNT_FORM = "flex flex-col gap-2 sm:row-span-3 sm:grid sm:grid-rows-subgrid";

/** Always mounted, so screen readers announce every change. */
function ActionStatus({ state, pending }: { state: ConnectionActionResult | null; pending: boolean }) {
  return (
    <div role="status" aria-live="polite" className="text-sm">
      {pending || state === null ? null : state.ok ? (
        state.message === undefined ? null : <p className="text-success">{state.message}</p>
      ) : (
        <p className="text-danger">
          {state.message}
          {state.referenceId === undefined ? null : (
            <>
              {" "}
              Reference <code className="font-mono text-xs text-foreground">{state.referenceId}</code>.
            </>
          )}
        </p>
      )}
    </div>
  );
}

function useConnectionAction(action: Action) {
  return useActionState<ConnectionActionResult | null, FormData>(action, null);
}

export function AccountProjectForm({
  workspaceSlug,
  accountId,
  accountName,
  projectId,
  projects,
}: {
  workspaceSlug: string;
  accountId: string;
  accountName: string;
  projectId: string | null;
  projects: readonly { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useConnectionAction(assignAccountProject);
  const selectId = useId();
  const errorId = useId();
  const fieldError = state !== null && !state.ok ? state.fieldErrors?.projectId : undefined;
  return (
    <form action={formAction} className={ACCOUNT_FORM}>
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="accountId" value={accountId} />
      <label htmlFor={selectId} className="text-xs font-medium text-muted">
        Project for {accountName}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        {/*
         * React resets a form after its action and only reads a select's defaultValue on mount, so
         * without the key the reset restores the project this select mounted with, not the one saved.
         */}
        <select
          key={projectId ?? ""}
          id={selectId}
          name="projectId"
          defaultValue={projectId ?? ""}
          aria-invalid={fieldError === undefined ? undefined : true}
          aria-describedby={fieldError === undefined ? undefined : errorId}
          className="min-h-10 min-w-40 rounded-md border border-line-strong bg-panel-raised px-3 py-2 text-sm"
        >
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <button type="submit" disabled={pending} className={SECONDARY}>
          {pending ? "Saving" : "Save project"}
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {fieldError === undefined ? null : (
          <p id={errorId} className="text-sm text-danger">
            <span className="font-medium">Error: </span>
            {fieldError}
          </p>
        )}
        <ActionStatus state={fieldError === undefined ? state : null} pending={pending} />
      </div>
    </form>
  );
}

export function AccountIncludedForm({
  workspaceSlug,
  accountId,
  accountName,
  included,
}: {
  workspaceSlug: string;
  accountId: string;
  accountName: string;
  included: boolean;
}) {
  const [state, formAction, pending] = useConnectionAction(setAccountIncluded);
  return (
    <form action={formAction} className={ACCOUNT_FORM}>
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="accountId" value={accountId} />
      <input type="hidden" name="included" value={included ? "false" : "true"} />
      <button
        type="submit"
        disabled={pending}
        aria-label={included ? `Exclude ${accountName}` : `Include ${accountName}`}
        className={`${SECONDARY} self-start sm:row-start-2 sm:justify-self-start`}
      >
        {included ? "Exclude" : "Include"}
      </button>
      <ActionStatus state={state} pending={pending} />
    </form>
  );
}

export function SyncNowForm({
  workspaceSlug,
  connectionId,
  cooldownNotice,
}: {
  workspaceSlug: string;
  connectionId: string;
  // Set while the manual sync cooldown runs, e.g. "Available again in 4 minutes."
  cooldownNotice: string | null;
}) {
  const [state, formAction, pending] = useConnectionAction(syncNow);
  const hintId = useId();
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <input type="hidden" name="connectionId" value={connectionId} />
      <button
        type="submit"
        disabled={pending || cooldownNotice !== null}
        aria-describedby={cooldownNotice === null ? undefined : hintId}
        className={PRIMARY}
      >
        {pending ? "Queueing sync" : "Sync now"}
      </button>
      {cooldownNotice === null ? null : (
        <p id={hintId} className="text-sm text-muted">
          {cooldownNotice}
        </p>
      )}
      <ActionStatus state={state} pending={pending} />
    </form>
  );
}

/**
 * Native modal dialog: the browser traps focus, closes on Escape, and returns focus to the
 * opener. The body lists exactly what confirming does.
 */
function ConfirmDialog({
  hideOpener = false,
  openLabel,
  title,
  confirmLabel,
  action,
  workspaceSlug,
  connectionId,
  children,
}: {
  // Hides the button but keeps the component mounted, so its result stays on screen.
  hideOpener?: boolean;
  openLabel: string;
  title: string;
  confirmLabel: string;
  action: Action;
  workspaceSlug: string;
  connectionId: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [state, formAction, pending] = useConnectionAction(action);
  const titleId = useId();

  useEffect(() => {
    if (state?.ok === true) dialogRef.current?.close();
  }, [state]);

  return (
    <div className="flex flex-col gap-2">
      {hideOpener ? null : (
        <button type="button" className={DANGER} onClick={() => dialogRef.current?.showModal()}>
          {openLabel}
        </button>
      )}
      {/* Outside the dialog so the result stays readable after it closes. */}
      <ActionStatus state={state} pending={pending} />
      <dialog
        ref={dialogRef}
        aria-labelledby={titleId}
        className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-line-strong bg-panel p-6 text-foreground backdrop:bg-black/70"
      >
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {title}
        </h2>
        <div className="mt-3 text-sm leading-6 text-muted">{children}</div>
        <form action={formAction} className="mt-6 flex flex-wrap justify-end gap-3">
          <input type="hidden" name="workspace" value={workspaceSlug} />
          <input type="hidden" name="connectionId" value={connectionId} />
          <button type="button" className={SECONDARY} onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" disabled={pending} className={DANGER}>
            {pending ? "Working" : confirmLabel}
          </button>
        </form>
      </dialog>
    </div>
  );
}

export function DisconnectDialog({
  workspaceSlug,
  connectionId,
  providerName,
  canRevoke,
  revoked,
}: {
  workspaceSlug: string;
  connectionId: string;
  providerName: string;
  canRevoke: boolean;
  // Already disconnected: nothing to confirm, but the last result stays readable.
  revoked: boolean;
}) {
  return (
    <ConfirmDialog
      hideOpener={revoked}
      openLabel="Disconnect"
      title={`Disconnect ${providerName}?`}
      confirmLabel="Disconnect"
      action={disconnect}
      workspaceSlug={workspaceSlug}
      connectionId={connectionId}
    >
      <p>Disconnecting does this:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>Deletes the stored credential, so DevMacro can no longer reach {providerName}.</li>
        {canRevoke ? (
          <li>Asks {providerName} to revoke DevMacro&apos;s access. If that fails, you are told how to do it there.</li>
        ) : (
          <li>
            {providerName} does not let apps revoke their own access, so remove DevMacro in your {providerName}{" "}
            settings afterwards.
          </li>
        )}
        <li>Keeps the history already collected and marks the connection disconnected. Reconnect at any time.</li>
      </ul>
    </ConfirmDialog>
  );
}

export function DeleteConnectionDialog({
  workspaceSlug,
  connectionId,
  providerName,
}: {
  workspaceSlug: string;
  connectionId: string;
  providerName: string;
}) {
  return (
    <ConfirmDialog
      openLabel="Delete connection and history"
      title="Delete this connection and its history?"
      confirmLabel="Delete connection and history"
      action={deleteConnection}
      workspaceSlug={workspaceSlug}
      connectionId={connectionId}
    >
      <p>Deleting does this, and it cannot be undone:</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        <li>Deletes the stored credential and asks {providerName} to revoke access where it supports that.</li>
        <li>Deletes the accounts, usage, spend, and activity history collected through this connection.</li>
        <li>Removes it from the dashboard, timeline, and alerts.</li>
      </ul>
    </ConfirmDialog>
  );
}
