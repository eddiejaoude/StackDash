"use client";

import { useActionState, useRef, useState } from "react";

import type { AlertActionFailure, AlertActionResult } from "@/app/w/[workspace]/alerts/actions";
import { GuardedButton } from "@/components/guarded-button";
import { buttonClass } from "@/components/ui/button";
import { DialogError, type DialogFailure } from "@/components/ui/dialog-error";
import { FailureAnnouncement } from "@/components/ui/live-region";
import { DialogActions, DialogCloseButton, ModalDialog, useModalDialog } from "@/components/ui/modal-dialog";

import { failureOf } from "./form-controls";

type Action = (previous: AlertActionResult | null, formData: FormData) => Promise<AlertActionResult>;

/**
 * A delete button that asks first, in a `ModalDialog`. Escape or Cancel returns focus to the
 * button; after a delete the row is gone, so focus moves to `afterDeleteFocusId` (the section
 * heading) instead. A failure keeps the dialog open and shows inside it. A failure that arrives
 * after Cancel or Escape closed the dialog mid-delete, or after a reopen replaced the confirmation
 * that ran it, shows beside the button instead (#369, as #367 did for connections), since that
 * confirmation can no longer report it. When the dialog is open again, the page behind it is
 * inert, so the new confirmation shows that failure as well. The confirmation remounts on every
 * open, so it starts without a previous attempt's error.
 */
export function ConfirmDelete({
  label,
  accessibleSuffix,
  title,
  description,
  confirmLabel,
  action,
  fields,
  afterDeleteFocusId,
}: {
  label: string;
  /** Visually hidden text that makes the button name unique in a list, such as the rule summary. */
  accessibleSuffix: string;
  title: string;
  description: string;
  confirmLabel: string;
  action: Action;
  fields: Record<string, string>;
  afterDeleteFocusId: string;
}) {
  const dialog = useModalDialog({ fallbackFocusId: afterDeleteFocusId });
  // Held here rather than in the confirmation, so a failure outlives the dialog closing.
  const [unshownFailure, setUnshownFailure] = useState<AlertActionFailure | null>(null);

  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          setUnshownFailure(null);
          dialog.open(event.currentTarget);
        }}
        className={buttonClass("raised", "xs")}
      >
        {label}
        <span className="sr-only">: {accessibleSuffix}</span>
      </button>
      {/* Outside the dialog so a failure stays readable after it closes. */}
      <FailureAnnouncement inline failure={unshownFailure} className="basis-full text-sm" />
      <ModalDialog dialog={dialog} title={title} description={description} size="sm">
        <ConfirmDeleteForm
          confirmLabel={confirmLabel}
          action={action}
          fields={fields}
          replacedFailure={unshownFailure}
          onSettled={(result, shownInDialog) => {
            if (result.ok) dialog.close("completed");
            else if (!shownInDialog) setUnshownFailure(result);
          }}
        />
      </ModalDialog>
    </>
  );
}

function ConfirmDeleteForm({
  confirmLabel,
  action,
  fields,
  onSettled,
  replacedFailure,
}: {
  confirmLabel: string;
  action: Action;
  fields: Record<string, string>;
  /** `shownInDialog`: this confirmation is still mounted in the open dialog, so it shows a failure itself. */
  onSettled: (result: AlertActionResult, shownInDialog: boolean) => void;
  /** The failure of a confirmation this one replaced, which settled after this one opened. */
  replacedFailure: DialogFailure | null;
}) {
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<AlertActionResult | null, FormData>(
    async (previous, formData) => {
      const result = await action(previous, formData);
      // React clears the ref once a reopen unmounts this confirmation.
      onSettled(result, formRef.current?.closest("dialog")?.open === true);
      return result;
    },
    null,
  );

  return (
    <>
      <DialogError failure={failureOf(state) ?? replacedFailure} />
      <form ref={formRef} action={formAction}>
        {Object.entries(fields).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        <DialogActions>
          <DialogCloseButton className={buttonClass("raised")} />
          <GuardedButton type="submit" unavailable={pending} className={buttonClass("danger")}>
            {pending ? "Deleting" : confirmLabel}
          </GuardedButton>
        </DialogActions>
      </form>
    </>
  );
}
