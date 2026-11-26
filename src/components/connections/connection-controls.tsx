"use client";

import { useActionState, useId, useRef, useState, type ReactNode } from "react";

import {
  assignAccountProject,
  deleteConnection,
  disconnect,
  exploreWithSampleData,
  setAccountIncluded,
  syncNow,
  type ConnectionActionResult,
} from "@/app/w/[workspace]/connections/actions";
import { GuardedButton } from "@/components/guarded-button";
import { buttonClass } from "@/components/ui/button";
import { DialogError, type DialogFailure } from "@/components/ui/dialog-error";
import { OutcomeAnnouncement, outcomeOf } from "@/components/ui/live-region";
import { DialogActions, DialogCloseButton, ModalDialog, useModalDialog } from "@/components/ui/modal-dialog";

type Action = (previous: ConnectionActionResult | null, formData: FormData) => Promise<ConnectionActionResult>;

// The account forms sit side by side in the page's three-row grid (label, controls, status) from
// `sm` up and take those rows as a subgrid, so their controls share a row.
const ACCOUNT_FORM = "flex flex-col gap-2 sm:row-span-3 sm:grid sm:grid-rows-subgrid";

/** Always mounted, so screen readers announce every change. */
function ActionStatus({ state, pending }: { state: ConnectionActionResult | null; pending: boolean }) {
  return (
    <OutcomeAnnouncement
      outcome={outcomeOf(pending ? null : state, state?.ok === true ? state.message : null)}
      className="text-sm"
    />
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
        <GuardedButton type="submit" unavailable={pending} className={`shrink-0 ${buttonClass("outline")}`}>
          {pending ? "Saving" : "Save project"}
        </GuardedButton>
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
      <GuardedButton
        type="submit"
        unavailable={pending}
        aria-label={included ? `Exclude ${accountName}` : `Include ${accountName}`}
        className={`shrink-0 self-start sm:row-start-2 sm:justify-self-start ${buttonClass("outline")}`}
      >
        {included ? "Exclude" : "Include"}
      </GuardedButton>
      {/* Pinned: with the button placed in row 2, auto-placement would put this in row 1. */}
      <div className="sm:row-start-3">
        <ActionStatus state={state} pending={pending} />
      </div>
    </form>
  );
}

export function SyncNowForm({
  workspaceSlug,
  connectionIds,
  cooldownNotice,
}: {
  workspaceSlug: string;
  /** One connection on its page; every stale one in the dashboard's notice (#267). */
  connectionIds: readonly string[];
  // Set while the manual sync cooldown runs, e.g. "Available again in 4 minutes."
  cooldownNotice: string | null;
}) {
  const [state, formAction, pending] = useConnectionAction(syncNow);
  const hintId = useId();
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      {connectionIds.map((connectionId) => (
        <input key={connectionId} type="hidden" name="connectionId" value={connectionId} />
      ))}
      {/* Unavailable rather than disabled during the cooldown too: a sync that starts one leaves
          focus on the button instead of dropping it to the page (#161). */}
      <GuardedButton
        type="submit"
        unavailable={pending || cooldownNotice !== null}
        aria-describedby={cooldownNotice === null ? undefined : hintId}
        className={`shrink-0 ${buttonClass("primary")}`}
      >
        {pending ? "Queueing sync" : "Sync now"}
      </GuardedButton>
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
 * "Explore with sample data" in an empty workspace's timeline (#257); success opens the timeline.
 * It is the `secondaryAction` of an `EmptyState`. The form draws no box of its own, so its button
 * sits in the row beside "Connect a provider" and its message takes a line of its own under the
 * whole row, where a long refusal wraps instead of pushing the buttons apart (#666).
 */
export function SampleDataForm({ workspaceSlug }: { workspaceSlug: string }) {
  const [state, formAction, pending] = useConnectionAction(exploreWithSampleData);
  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="workspace" value={workspaceSlug} />
      <GuardedButton type="submit" unavailable={pending} className={`shrink-0 ${buttonClass("outline")}`}>
        {pending ? "Adding sample data" : "Explore with sample data"}
      </GuardedButton>
      <div className="basis-full">
        <div className="mx-auto max-w-md">
          <ActionStatus state={state} pending={pending} />
        </div>
      </div>
    </form>
  );
}

/**
 * A `ModalDialog` whose body lists exactly what confirming does. A failure keeps the dialog open
 * and shows inside it, where it can be seen and heard; a success closes it and shows beside the
 * opener. A failure that arrives after Cancel or Escape closed the dialog mid-action, or after a
 * reopen replaced the confirmation that ran it, shows beside the opener too (#367), since that
 * confirmation can no longer report it. When the dialog is open again, the page behind it is
 * inert, so the new confirmation shows that failure as well. The confirmation remounts on every
 * open, so it starts without a previous attempt's error.
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
  const dialog = useModalDialog();
  // Held here rather than in the confirmation, so a result outlives the dialog closing.
  const [settled, setSettled] = useState<ConnectionActionResult | null>(null);

  return (
    <div className="flex flex-col gap-2">
      {hideOpener ? null : (
        <button
          type="button"
          className={`shrink-0 self-start ${buttonClass("danger-outline")}`}
          onClick={(event) => {
            setSettled(null);
            dialog.open(event.currentTarget);
          }}
        >
          {openLabel}
        </button>
      )}
      {/* Outside the dialog so a result stays readable after it closes. */}
      <ActionStatus state={settled} pending={false} />
      <ModalDialog dialog={dialog} title={title} description={children}>
        <ConfirmForm
          confirmLabel={confirmLabel}
          action={action}
          workspaceSlug={workspaceSlug}
          connectionId={connectionId}
          replacedFailure={settled?.ok === false ? settled : null}
          onSettled={(result, shownInDialog) => {
            if (result.ok) {
              setSettled(result);
              dialog.close("completed");
            } else if (!shownInDialog) {
              setSettled(result);
            }
          }}
        />
      </ModalDialog>
    </div>
  );
}

function ConfirmForm({
  confirmLabel,
  action,
  workspaceSlug,
  connectionId,
  onSettled,
  replacedFailure,
}: {
  confirmLabel: string;
  action: Action;
  workspaceSlug: string;
  connectionId: string;
  /** `shownInDialog`: this confirmation is still mounted in the open dialog, so it shows a failure itself. */
  onSettled: (result: ConnectionActionResult, shownInDialog: boolean) => void;
  /** The failure of a confirmation this one replaced, which settled after this one opened. */
  replacedFailure: DialogFailure | null;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useConnectionAction(async (previous, formData) => {
    const result = await action(previous, formData);
    // React clears the ref once a reopen unmounts this confirmation.
    onSettled(result, formRef.current?.closest("dialog")?.open === true);
    return result;
  });

  return (
    <>
      <DialogError failure={state?.ok === false ? state : replacedFailure} />
      <form ref={formRef} action={formAction}>
        <input type="hidden" name="workspace" value={workspaceSlug} />
        <input type="hidden" name="connectionId" value={connectionId} />
        <DialogActions>
          <DialogCloseButton className={`shrink-0 ${buttonClass("outline")}`} />
          <GuardedButton type="submit" unavailable={pending} className={`shrink-0 ${buttonClass("danger-outline")}`}>
            {pending ? "Working" : confirmLabel}
          </GuardedButton>
        </DialogActions>
      </form>
    </>
  );
}

export function DisconnectDialog({
  workspaceSlug,
  connectionId,
  providerName,
  canRevoke,
  revoked,
  canReconnect,
  webhook,
}: {
  workspaceSlug: string;
  connectionId: string;
  providerName: string;
  canRevoke: boolean;
  // Already disconnected: nothing to confirm, but the last result stays readable.
  revoked: boolean;
  // False when the provider is absent from the registry (#562): the page offers no reconnect then.
  canReconnect: boolean;
  // The connection's webhook (#426), with the steps that remove one added by hand; null when none.
  // `perSource`: automatic setup added one webhook per project (#428), so they are spoken of in the plural.
  webhook: Readonly<{ mode: "automatic" | "manual"; perSource: boolean; removalSteps: string }> | null;
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
        {webhook === null ? null : webhook.mode === "automatic" ? (
          <li>
            Deletes the {webhook.perSource ? "webhooks" : "webhook"} StackDash added in {providerName}. If that fails, you are
            told how to do it there.
          </li>
        ) : (
          <li>
            Stops accepting the webhook you added in {providerName}. Remove it there afterwards: {webhook.removalSteps}
          </li>
        )}
        <li>Deletes the stored credential, so StackDash can no longer reach {providerName}.</li>
        {canRevoke ? (
          <li>Asks {providerName} to revoke StackDash&apos;s access. If that fails, you are told how to do it there.</li>
        ) : (
          <li>
            {providerName} does not let apps revoke their own access, so remove StackDash in your {providerName}{" "}
            settings afterwards.
          </li>
        )}
        <li>
          Keeps the history already collected and marks the connection disconnected.
          {canReconnect ? " Reconnect at any time." : null}
        </li>
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
