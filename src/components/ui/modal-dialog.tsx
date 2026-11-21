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
  TOUCH_REPEAT_RADIUS_PX,
  TOUCH_REPEAT_WINDOW_MS,
  type ClosedDialog,
  type CloseReason,
  type DialogController,
  type FocusTarget,
  type Point,
  type Tap,
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
 * closes it on a click outside it, as Escape does: only for a dialog with nothing to lose. Every
 * dialog ignores the later clicks of the double-click that opened it (#506), and once a click has
 * closed it, the page ignores the rest of that click's double-click (#563); after a tap, also the
 * next tap near it within `TOUCH_REPEAT_WINDOW_MS` (#578, #592). So no dialog, and nothing under
 * one, may depend on a second click at the same point within the system's double-click time of a
 * click that opened or closed it.
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

/** A press, its release, its click, and a double-click's `dblclick`. */
const PRESS_EVENTS = ["mousedown", "mouseup", "click", "dblclick"] as const;

/**
 * The closing side of #506 (#563). A closing dialog takes no pointer input (`panel-slide` in
 * globals.css, #399), so once a click has closed one, the rest of that click's double-click lands
 * on whatever the dialog covered: under the event details' "Close event", the header's "Sign out".
 * Until a press counted 1 reaches `target`, this stops every press, release, click, and `dblclick`
 * the browser counts 2 or more in the capture phase and prevents its default, so nothing acts on
 * it, takes focus, or selects a word, as `openingRepeatRule` does inside a dialog it opened. The
 * press counted 1 (or 0, from a script) starts a click of its own: it passes and removes the
 * listeners. A click counted 0, a key's, passes and leaves them. Returns what removes them sooner;
 * calling it again does nothing.
 *
 * The rule depends on the browser counting the later press of a double-click or double-tap as
 * `detail` 2. Chromium does, mouse and touch (`hasTouch`, two taps at one point counted 1 then 2),
 * but Playwright's WebKit and Firefox with touch count both taps of a double-tap 1 (#578). So when
 * a tap closed the dialog (`closingTap`, its click's place and time), the next press counted 1
 * within `TOUCH_REPEAT_RADIUS_PX` of it and `TOUCH_REPEAT_WINDOW_MS` after it is that double-tap's
 * second tap: its press, release, and click, each counted 1, are ignored, and the rule stays for
 * what the browser counts 2 or more. Once that click is ignored, a click counted 1 passes again.
 * Any other press counted 1 ends it as above. Only the next press is checked, so a third tap
 * counted 1 acts. A mouse's close passes no tap and keeps the count-only rule.
 */
export function ignoreClosingRepeat(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  closingTap: Tap | null = null,
): () => void {
  let tap = closingTap;
  // Whether the press counted 1 that came last was the double-tap's second tap.
  let secondTap = false;
  function ignore(event: globalThis.MouseEvent): void {
    if (event.type === "mousedown" && event.detail <= 1) {
      secondTap = tap !== null && repeatsTap(tap, event);
      tap = null;
      if (!secondTap) {
        end();
        return;
      }
    }
    if (event.detail > 1 || (secondTap && event.detail === 1)) {
      event.preventDefault();
      event.stopPropagation();
      // The second tap ends at its click, so a click counted 1 after it is not part of the double-tap.
      if (event.type === "click" && event.detail === 1) secondTap = false;
    }
  }
  function end(): void {
    for (const type of PRESS_EVENTS) target.removeEventListener(type, ignore, { capture: true });
  }
  for (const type of PRESS_EVENTS) target.addEventListener(type, ignore, { capture: true });
  return end;
}

/** A mouse event as far as the opening rule reads and stops one, from React or the DOM. */
type MousePress = Pick<globalThis.MouseEvent, "type" | "detail" | "clientX" | "clientY" | "timeStamp" | "preventDefault" | "stopPropagation">;

/** Whether `press` came close enough to `tap`, and soon enough after it, to be its double-tap's second tap. */
function repeatsTap(tap: Tap, press: Pick<MousePress, "clientX" | "clientY" | "timeStamp">): boolean {
  const elapsed = press.timeStamp - tap.timeStamp;
  const distance = Math.hypot(press.clientX - tap.x, press.clientY - tap.y);
  return elapsed <= TOUCH_REPEAT_WINDOW_MS && distance <= TOUCH_REPEAT_RADIUS_PX;
}

/**
 * The opening side of #506. A dialog a click opened is under the pointer at once, so the rest of
 * that click's double-click, as on an event row, lands on whatever the dialog now shows there: its
 * backdrop, a word, a link, a button. It is not for the dialog, so until a press counted 1 reaches
 * the dialog, `ignore`, in the dialog's capture phase, stops every press, release, click, and
 * `dblclick` the browser counts 2 or more and prevents its default: nothing inside sees it, the
 * press selects no word and moves no focus off the control the open focused, and the click follows
 * no link. A deliberate double-click inside starts with a press counted 1, and keyboard activation
 * has no count at all. `closed` starts the rule again for the next open.
 *
 * As on the closing side (`ignoreClosingRepeat`), Playwright's WebKit and Firefox with touch count
 * both taps of a double-tap 1 (#592). So the first press counted 1 inside is checked against
 * `lastTap`, the page's latest tap (`recordTaps`), which for a dialog a tap opened is that tap
 * until a press counted 2 or more is ignored. Within `TOUCH_REPEAT_RADIUS_PX` of it and
 * `TOUCH_REPEAT_WINDOW_MS` after it, the press is that double-tap's second tap: its press, release,
 * and click, each counted 1, are ignored, and the rule stays for what the browser counts 2 or more.
 * Once that click is ignored, a click counted 1 passes again. Only that first press is checked, so
 * a third tap counted 1 acts. A press the browser counts 2 or more shows it counts the double-tap
 * itself, as Chromium does, and its click then replaces the recorded tap, so from there no press is
 * checked against the tap. A mouse's click records no tap and keeps the count-only rule. A dialog
 * opened from the keyboard just after a tap is checked against that tap too, so a tap inside near
 * it within the window does nothing, and the person taps again.
 */
export function openingRepeatRule(lastTap: () => Tap | null): Readonly<{ ignore: (event: MousePress) => void; closed: () => void }> {
  // Whether a press counted 1 other than the double-tap's second tap has reached the dialog since it opened.
  let pressedSinceOpen = false;
  // Whether `lastTap` still holds the tap that opened the dialog, so the next press counted 1 is checked
  // against it. Cleared by the first press counted 1, and by an ignored press counted 2 or more, whose
  // click replaces `lastTap`.
  let checkTap = true;
  // Whether the press counted 1 that came last was the double-tap's second tap.
  let secondTap = false;
  return {
    ignore(event) {
      if (pressedSinceOpen) return;
      if (event.type === "mousedown" && event.detail <= 1) {
        const tap = checkTap ? lastTap() : null;
        checkTap = false;
        secondTap = tap !== null && repeatsTap(tap, event);
        if (!secondTap) {
          pressedSinceOpen = true;
          return;
        }
      }
      if (event.detail > 1 || (secondTap && event.detail === 1)) {
        event.preventDefault();
        event.stopPropagation();
        // The browser counts this double-tap itself, and its click becomes `lastTap`, which is not the opening tap.
        if (event.detail > 1) checkTap = false;
        // The second tap ends at its click, so a click counted 1 after it is not part of the double-tap.
        if (event.type === "click" && event.detail === 1) secondTap = false;
      }
    },
    closed() {
      pressedSinceOpen = false;
      checkTap = true;
      secondTap = false;
    },
  };
}

/** The latest tap `recordTaps` saw, and what removes its listeners. */
export type TapRecorder = Readonly<{ last: () => Tap | null; end: () => void }>;

/**
 * Records the place and time of the page's latest click when a tap made it, for the opening rule's
 * touch window (#592). The click that opens a dialog lands outside it, on an event row or a button,
 * and the event details open only once the router has rendered the URL that click wrote, so
 * neither the dialog nor its `open` sees that click; `target` (`window`) sees every click first, in
 * the capture phase. As on the closing side, the `pointerdown` before the click says whether a tap
 * made it, since a click is not a `PointerEvent` in every supported browser. A click after a
 * mouse's or pen's press, or with no press before it (counted 0, a key's), records no tap. Returns
 * the latest tap, and what removes the listeners.
 */
export function recordTaps(target: Pick<Window, "addEventListener" | "removeEventListener">): TapRecorder {
  let pressedWithTouch = false;
  let tap: Tap | null = null;
  function pressed(event: PointerEvent): void {
    pressedWithTouch = event.pointerType === "touch";
  }
  function clicked(event: globalThis.MouseEvent): void {
    tap = pressedWithTouch && event.detail > 0 ? { x: event.clientX, y: event.clientY, timeStamp: event.timeStamp } : null;
    pressedWithTouch = false;
  }
  target.addEventListener("pointerdown", pressed, { capture: true });
  target.addEventListener("click", clicked, { capture: true });
  return {
    last: () => tap,
    end() {
      target.removeEventListener("pointerdown", pressed, { capture: true });
      target.removeEventListener("click", clicked, { capture: true });
    },
  };
}

// The page's one tap recorder, on `window` while any dialog is mounted, and how many are: a list
// with a confirmation on every row then adds no listeners per row.
let sharedTaps: { recorder: TapRecorder; dialogs: number } | null = null;

/** Keeps the page's tap recorder on while the dialog calling it is mounted; returns what lets it go. */
function holdTapRecorder(): () => void {
  const shared = (sharedTaps ??= { recorder: recordTaps(window), dialogs: 0 });
  shared.dialogs += 1;
  return () => {
    shared.dialogs -= 1;
    if (shared.dialogs > 0) return;
    shared.recorder.end();
    sharedTaps = null;
  };
}

function lastTap(): Tap | null {
  return sharedTaps?.recorder.last() ?? null;
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
  // The `pointerType` of that press, for `ignoreClosingRepeat`'s touch window (#578). A click is a
  // `PointerEvent` with its own `pointerType` only from Safari 18.2 and Firefox 129 (MDN
  // browser-compat-data, api.Element.click_event.type_pointerevent), so the press says whether a
  // tap closed the dialog.
  const pressedWith = useRef<string | null>(null);
  // The opening rule (#506), this dialog's own, with the touch window of #592. In the capture
  // phase, so nothing inside sees any event it ignores: the press, the release, the click, or the
  // `dblclick`.
  const [openingRepeat] = useState(() => openingRepeatRule(lastTap));
  // A tap that opens the dialog lands on the page before it opens, so the page's tap recorder runs
  // while the dialog is mounted.
  useEffect(() => holdTapRecorder(), []);

  // Removes what `ignoreClosingRepeat` put in place when a click last closed this dialog, unless a
  // press counted 1 already has: before the next such close puts its own, and on unmount.
  const endClosingRepeat = useRef<(() => void) | null>(null);
  useEffect(() => () => endClosingRepeat.current?.(), []);

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
        onClose={(event) => {
          // This dialog's own close resets the rule for its next open. React delivers a nested
          // dialog's `close` here too, as the Share dialog inside the event details closes, but this
          // dialog stays open then and keeps its rule (#577): the rest of a double-click on the
          // nested dialog's Close never reaches it, because the click that closed the nested dialog
          // put `ignoreClosingRepeat` on `window` (#563). Resetting here as well would only make a
          // click counted 2 do nothing, such as Share clicked again at the same point after Escape
          // closed the Share dialog.
          if (event.target === event.currentTarget) openingRepeat.closed();
          dialog.controller.closed(event.currentTarget, {
            fallback: dialog.fallback(),
            onClose,
            otherModalOpen: () => document.querySelector("dialog[open]") !== null,
          });
        }}
        onKeyDown={keepTabInside}
        onPointerDown={(event) => {
          pressedWith.current = event.pointerType;
          if (lightDismiss) pressedAt.current = { x: event.clientX, y: event.clientY };
        }}
        onMouseDownCapture={openingRepeat.ignore}
        onMouseUpCapture={openingRepeat.ignore}
        onClickCapture={openingRepeat.ignore}
        onDoubleClickCapture={openingRepeat.ignore}
        onClick={(event) => {
          if (lightDismiss) {
            const pressed = pressedAt.current;
            pressedAt.current = null;
            const released = { x: event.clientX, y: event.clientY };
            if (event.target === event.currentTarget && dismissedByClick(event.currentTarget.getBoundingClientRect(), pressed, released, event.detail)) {
              dialog.close("dismissed");
            }
          }
          // React runs this after every click handler inside the dialog, so it sees the dialog as
          // the click left it. A pointer's click (counted 1 or more; a key's is 0) that closed it
          // may be the first of a double-click, and its rest lands on the page under it (#563).
          // The listeners go on `window`, the first stop of an event's capture path: React listens
          // on the document (`appElement = document` in next/dist/client/app-index.js) from before
          // they exist, and a node runs its listeners in the order they were added. A tap's click
          // also passes its place and time, the native event's so they compare with the next press.
          const pressedWithTouch = pressedWith.current === "touch";
          pressedWith.current = null;
          if (event.detail > 0 && !event.currentTarget.open) {
            endClosingRepeat.current?.();
            const { clientX, clientY, timeStamp } = event.nativeEvent;
            endClosingRepeat.current = ignoreClosingRepeat(window, pressedWithTouch ? { x: clientX, y: clientY, timeStamp } : null);
          }
        }}
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
