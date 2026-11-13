"use client";

import {
  createContext,
  Fragment,
  use,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { GuardedButton } from "@/components/guarded-button";

import { buttonClass } from "./button";
import {
  createDialogController,
  dismissedByClick,
  type ClosedDialog,
  type CloseReason,
  type DialogController,
  type FocusTarget,
  type Point,
} from "./dialog-controller";

/**
 * The app's one modal dialog (#342): a native `<dialog>` opened with `showModal()`, so the browser
 * makes the page behind it inert and Escape closes it. It is labeled by its title and described by
 * its description, keeps Tab inside it, and on close returns focus by the rules in
 * `dialog-controller.ts`: to the element that opened it, or to `fallbackFocusId` after its action
 * completed or once the opener is gone.
 *
 * `useModalDialog` gives the handle a trigger opens it with; `ModalDialog` renders it. Inside,
 * `DialogCloseButton` dismisses it and, unless told otherwise, takes focus when it opens, so Enter
 * right after opening a destructive confirmation cancels rather than confirms. `lightDismiss` also
 * closes it on a click outside it, as Escape does: only for a dialog with nothing to lose.
 */

export type ModalDialogHandle = Readonly<{
  ref: RefObject<HTMLDialogElement | null>;
  /** Opens so far; `ModalDialog` keys per-open content on it. */
  openCount: number;
  controller: DialogController;
  /** Where focus goes after the action completed, or when the opener is no longer on the page. */
  fallback: () => FocusTarget | null;
  /** Opens the dialog. Focus returns to `opener` on close: by default, whatever has focus now. */
  open: (opener?: FocusTarget | null) => void;
  /**
   * `completed` after the dialog's action succeeded: focus goes to the fallback at once, or stays
   * where the action put it.
   */
  close: (reason?: CloseReason) => void;
  /** Sends focus somewhere other than the opener on the next close. */
  returnFocusTo: (target: FocusTarget | null) => void;
}>;

export function useModalDialog({ fallbackFocusId }: { fallbackFocusId?: string } = {}): ModalDialogHandle {
  const ref = useRef<HTMLDialogElement>(null);
  const [controller] = useState(createDialogController);
  const [openCount, setOpenCount] = useState(0);
  const fallback = () => (fallbackFocusId === undefined ? null : document.getElementById(fallbackFocusId));
  return {
    ref,
    openCount,
    controller,
    fallback,
    open(opener) {
      const dialog = ref.current;
      if (dialog === null) return;
      const focused = document.activeElement;
      const from = opener !== undefined ? opener : focused instanceof HTMLElement && focused !== document.body ? focused : null;
      setOpenCount((count) => count + 1);
      controller.open(dialog, from);
    },
    close(reason = "dismissed") {
      controller.close(ref.current, reason, fallback());
    },
    returnFocusTo: controller.returnFocusTo,
  };
}

const ModalDialogContext = createContext<ModalDialogHandle | null>(null);

/** Spread on the control that takes focus each time the dialog opens, when it is not a `DialogCloseButton`. */
export const INITIAL_FOCUS = { "data-initial-focus": "" } as const;

const FOCUSABLE = [
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "a[href]",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

/**
 * Wraps Tab and Shift+Tab inside the dialog. `showModal()` makes the page behind it inert, but
 * Chromium still lets Tab leave the last control for the browser's own UI.
 */
function keepTabInside(event: KeyboardEvent<HTMLDialogElement>): void {
  if (event.key !== "Tab") return;
  const focusable = [...event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const first = focusable[0];
  const last = focusable.at(-1);
  if (first === undefined || last === undefined) return;
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

const FRAME = "rounded-xl border bg-panel text-foreground backdrop:bg-black/60";

const SIZES = {
  sm: `m-auto w-[min(28rem,calc(100%-2rem))] border-line p-6 ${FRAME}`,
  md: `m-auto w-[min(32rem,calc(100%-2rem))] border-line p-6 ${FRAME}`,
  lg: `m-auto max-h-[calc(100%-2rem)] w-[min(40rem,calc(100%-2rem))] overflow-y-auto border-line p-6 ${FRAME}`,
  /** Near the top and edge to edge inside, for a search box with results under it. */
  palette: `mx-auto mt-[12vh] w-[calc(100%-2rem)] max-w-xl border-line-strong p-0 shadow-xl shadow-black/40 ${FRAME}`,
  /**
   * Full-screen on phones; a right-hand panel leaves the timeline visible on wider screens. It
   * slides in and out (`panel-slide` in globals.css), and not under reduced motion.
   */
  inspector: "panel-slide fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto overscroll-contain border-0 border-l border-line-strong bg-panel p-5 text-foreground shadow-xl backdrop:bg-black/30 sm:w-[28rem] sm:p-6",
} as const;

export function ModalDialog({
  dialog,
  title,
  hideTitle = false,
  titleAction,
  description,
  describedBy,
  size = "md",
  content = "each-open",
  onClose,
  lightDismiss = false,
  children,
}: {
  dialog: ModalDialogHandle;
  title: ReactNode;
  /** Names the dialog for assistive tech only, when its content makes the purpose plain. */
  hideTitle?: boolean;
  /** A control beside the title, such as Close in a dialog without a confirm row. */
  titleAction?: ReactNode;
  /** Shown under the title and read out with it. */
  description?: ReactNode;
  /** The id of a description inside `children`, when it is not under the title. */
  describedBy?: string | undefined;
  size?: keyof typeof SIZES;
  /**
   * `each-open` (the default) mounts the content fresh on every open, so a confirmation never
   * shows the previous attempt's error; `after-first-open` mounts it once and keeps it, so the page
   * loads nothing the dialog shows until someone opens it; `always` keeps it mounted from the start.
   */
  content?: "each-open" | "after-first-open" | "always";
  onClose?: (closed: ClosedDialog) => void;
  /**
   * Closes on a click outside the dialog, on its backdrop, exactly as Escape does (#407). Off by
   * default: an outside click must never discard what someone typed into a form or confirmation.
   */
  lightDismiss?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const { ref, openCount } = dialog;
  // Where the last press on the dialog or its backdrop started, for `dismissedByClick`.
  const pressedAt = useRef<Point | null>(null);

  // After each open commits, so content mounted by this open is there to focus.
  useEffect(() => {
    const element = ref.current;
    if (openCount === 0 || element?.open !== true) return;
    element.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
  }, [openCount, ref]);

  const heading = (
    <h2 id={titleId} className={hideTitle ? "sr-only" : "text-lg font-semibold tracking-tight break-words"}>
      {title}
    </h2>
  );

  return (
    <ModalDialogContext value={dialog}>
      {/* Light dismiss checks the pointer against the dialog's box rather than using the native
          `closedby="any"`: @types/react accepts it, but Safari ships it only from 27.3 (MDN
          browser-compat-data, html.elements.dialog.closedby) and Next.js 16 supports Safari 16.4
          and up (node_modules/next/dist/docs/03-architecture/supported-browsers.md). A click on
          the backdrop targets the dialog itself, as a click on its padding does, so only the box
          tells them apart. Escape closes it from the keyboard. */}
      <dialog
        ref={ref}
        aria-labelledby={titleId}
        aria-describedby={description === undefined ? describedBy : descriptionId}
        onClose={(event) =>
          dialog.controller.closed(event.currentTarget, {
            fallback: dialog.fallback(),
            onClose,
            otherModalOpen: () => document.querySelector("dialog[open]") !== null,
          })
        }
        onKeyDown={keepTabInside}
        onPointerDown={lightDismiss ? (event) => { pressedAt.current = { x: event.clientX, y: event.clientY }; } : undefined}
        onClick={lightDismiss ? (event) => {
          const pressed = pressedAt.current;
          pressedAt.current = null;
          const released = { x: event.clientX, y: event.clientY };
          if (event.target === event.currentTarget && dismissedByClick(event.currentTarget.getBoundingClientRect(), pressed, released)) {
            dialog.close("dismissed");
          }
        } : undefined}
        className={SIZES[size]}
      >
        {titleAction === undefined ? (
          heading
        ) : (
          <div className="flex items-start justify-between gap-4">
            {heading}
            {titleAction}
          </div>
        )}
        {description === undefined ? null : (
          <div id={descriptionId} className="mt-3 text-sm leading-6 text-muted">
            {description}
          </div>
        )}
        {content === "always" ? (
          children
        ) : openCount === 0 ? null : (
          <Fragment key={content === "each-open" ? openCount : 0}>{children}</Fragment>
        )}
      </dialog>
    </ModalDialogContext>
  );
}

/** Closes the dialog without doing its work: Cancel in a confirmation, Close elsewhere. */
export function DialogCloseButton({
  children = "Cancel",
  className = buttonClass("secondary"),
  unavailable = false,
  initialFocus = true,
}: {
  children?: ReactNode;
  className?: string;
  unavailable?: boolean;
  /** Takes focus when the dialog opens. Off when another control, such as a search box, should. */
  initialFocus?: boolean;
}) {
  const dialog = use(ModalDialogContext);
  if (dialog === null) throw new Error("DialogCloseButton must be rendered inside ModalDialog");
  return (
    <GuardedButton
      type="button"
      unavailable={unavailable}
      {...(initialFocus ? INITIAL_FOCUS : {})}
      onClick={() => dialog.close("dismissed")}
      className={className}
    >
      {children}
    </GuardedButton>
  );
}

/** The row of buttons at the foot of a dialog, Cancel first. */
export function DialogActions({ children }: { children: ReactNode }) {
  return <div className="mt-6 flex flex-wrap justify-end gap-3">{children}</div>;
}
