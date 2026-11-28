"use client";

import { useId, useRef, useState, useTransition, type ClipboardEvent, type FormEvent, type KeyboardEvent, type ReactNode } from "react";

import { GuardedButton } from "@/components/guarded-button";
import { buttonClass } from "@/components/ui/button";
import { LiveRegion, ReferenceNote } from "@/components/ui/live-region";
import type { SendMessageResult, SupportFailure } from "@/lib/support/views";

import type { AttachmentController } from "./attachment-picker";

/*
 * The message box of a support conversation (#680), for the user's screens and the operators'.
 * The screen passes the action that sends (startThread, sendMessage, or replyToThread) and the
 * hidden fields it needs (threadId, fromPage). Enter sends and Shift with Enter starts a new line,
 * as the hint under the field says. A failure keeps the draft and says why in an assertive region
 * the field is described by; the rate limit's says when sending works again. With an attachment
 * controller (useAttachmentUploads) the ready images go with the message, pasted images join them,
 * and sending waits for uploads to finish. Only a type is imported from the picker, so a screen
 * without attachments (the launcher) never loads it.
 */

type SendAction = (previous: SendMessageResult | null, formData: FormData) => Promise<SendMessageResult>;

export type ComposerProps = Readonly<{
  action: SendAction;
  /** Hidden fields the action reads, such as { threadId } or { fromPage }. */
  fields?: Readonly<Record<string, string>>;
  /** The field's visible label, such as "Message to support" or "Reply". */
  label: string;
  /** The send button's text. */
  submitLabel?: string;
  attachments?: AttachmentController;
  /** Rendered between the field and the send button, such as the AttachmentPicker. */
  children?: ReactNode;
  /** Called after a send succeeds, with the draft already cleared: read the conversation again. */
  onSent?: (result: Extract<SendMessageResult, { ok: true }>) => void;
  autoFocus?: boolean;
}>;

/** Files from a clipboard or a drop, for an attachment controller's `addFiles`; text is left alone. */
export function filesFrom(data: DataTransfer | null): File[] {
  if (data === null) return [];
  return [...data.items].flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file === null ? [] : [file];
  });
}

const NETWORK_FAILURE: SupportFailure = {
  ok: false,
  message: "Your message was not sent because the connection failed. Check your connection, then send it again. Your message is still here.",
};

export function Composer({ action, fields = {}, label, submitLabel = "Send message", attachments, children, onSent, autoFocus = false }: ComposerProps) {
  const fieldId = useId();
  const hintId = useId();
  const errorId = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [failure, setFailure] = useState<SupportFailure | null>(null);
  const [pending, startSending] = useTransition();
  const waiting = pending || (attachments?.uploading ?? false);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (waiting) return;
    const formData = new FormData(event.currentTarget);
    setFailure(null);
    startSending(async () => {
      let result: SendMessageResult;
      try {
        result = await action(null, formData);
      } catch (cause) {
        // A rejected action (the connection dropped, the session lapsed) must not reach the error
        // boundary, which would throw the draft away; it is a failure like any other.
        console.error(JSON.stringify({ level: "error", event: "support.send_request_failed", reason: cause instanceof Error ? cause.message : "unknown" }));
        result = NETWORK_FAILURE;
      }
      if (result.ok) {
        setDraft("");
        attachments?.clear();
        onSent?.(result);
      } else {
        setFailure(result);
      }
      // A keyboard send left focus in the field; a click on the button may have dropped it.
      if (document.activeElement === null || document.activeElement === document.body) field.current?.focus();
    });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Not while an input method is composing a character, where Enter confirms the character.
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }

  function onPaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (attachments === undefined) return;
    const files = filesFrom(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    attachments.addFiles(files);
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2" aria-busy={pending}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {attachments?.readyIds.map((id) => <input key={id} type="hidden" name="attachmentId" value={id} />)}
      <label htmlFor={fieldId} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        ref={field}
        id={fieldId}
        name="body"
        rows={3}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        readOnly={pending}
        autoFocus={autoFocus}
        aria-invalid={failure?.fieldErrors?.body === undefined ? undefined : true}
        aria-describedby={failure === null ? hintId : `${hintId} ${errorId}`}
        className="min-h-20 w-full resize-y rounded-md border border-line-strong bg-panel-raised px-3 py-2 text-sm"
      />
      <p id={hintId} className="text-xs text-muted">
        Press Enter to send, or Shift and Enter for a new line.
      </p>
      {children}
      <div className="flex items-center gap-3">
        <GuardedButton type="submit" unavailable={waiting} className={buttonClass("primary", "sm")}>
          {pending ? "Sending" : attachments?.uploading === true ? "Waiting for images" : submitLabel}
        </GuardedButton>
      </div>
      {/* Always mounted, so the failure is announced when it appears. */}
      <LiveRegion tone="error" id={errorId} className="text-sm">
        {failure === null ? null : (
          <p className="mt-1 text-danger">
            {failure.message}
            <ReferenceNote referenceId={failure.referenceId} />
          </p>
        )}
      </LiveRegion>
    </form>
  );
}
