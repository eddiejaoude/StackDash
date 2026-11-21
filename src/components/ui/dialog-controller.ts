/**
 * Focus for a native modal `<dialog>` (#342), kept free of React and the DOM so its rules are unit
 * tested. The browser opens, traps, and closes the dialog (Escape fires `cancel` and then `close`);
 * this decides where focus goes once it has closed:
 *
 * - Dismissed (Escape, Cancel, Close): back to the element that opened it, or to the named
 *   fallback when the opener is no longer in the document.
 * - Completed (the dialog's action succeeded): to the named fallback when there is one, because
 *   the opener usually goes with the row the action removed. This happens as `close` is called,
 *   not on the `close` event: Chromium fires that event a frame later, React stops delivering it
 *   once the row holding the dialog is gone, and a dialog Escape already closed fires none. Without
 *   a fallback, focus stays where the browser and the action left it: the browser returns it to
 *   the opener as the dialog closes, and an action that knows better (a status heading, the next
 *   empty state) has moved it on.
 * - Nowhere, when the close handed off to another modal (the palette opening its shortcut list),
 *   whose own close restores focus.
 *
 * It also decides when a click on a light-dismiss dialog's backdrop closes it (#407):
 * `dismissedByClick`, and holds the touch window of the closing and opening rules in
 * modal-dialog.tsx (#578, #592), which the end-to-end tests wait out.
 */

export type FocusTarget = Readonly<{ focus: () => void; isConnected: boolean }>;
export type DialogElement = Readonly<{ open: boolean; showModal: () => void; close: () => void }>;
export type CloseReason = "dismissed" | "completed";
export type ClosedDialog = Readonly<{ reason: CloseReason; opener: FocusTarget | null }>;

export function focusAfterClose(
  reason: CloseReason,
  opener: FocusTarget | null,
  fallback: FocusTarget | null,
): FocusTarget | null {
  const order = reason === "completed" ? [fallback] : [opener, fallback];
  return order.find((target): target is FocusTarget => target !== null && target.isConnected) ?? null;
}

export type Point = Readonly<{ x: number; y: number }>;
/** A `DOMRect`, as far as `dismissedByClick` needs one. */
export type Box = Readonly<{ left: number; top: number; right: number; bottom: number }>;

/**
 * True when a click both started and ended outside the dialog's box, on its backdrop. A point on
 * the box's edge is inside, so the dialog's own padding and border never close it. A press inside
 * released outside is a text selection or a drag, not a dismissal, and a click with no press
 * (`pressedAt` null: a keyboard activation) is never one either.
 *
 * `clickCount` is the click event's `detail`, counted by the browser from the system's
 * double-click time. Only a click of its own (1) dismisses: a later click of a double-click
 * belongs to it, not to the backdrop (#506).
 */
export function dismissedByClick(box: Box, pressedAt: Point | null, releasedAt: Point, clickCount: number): boolean {
  const outside = ({ x, y }: Point) => x < box.left || x > box.right || y < box.top || y > box.bottom;
  return clickCount === 1 && pressedAt !== null && outside(pressedAt) && outside(releasedAt);
}

/**
 * The touch window of `ignoreClosingRepeat` (#578) and `openingRepeatRule` (#592): a press counted
 * 1 at most this long after, and this far from, a tap that closed or opened a dialog is that
 * double-tap's second tap. Playwright's WebKit (`isMobile`) and Firefox, with touch, count both
 * taps of a double-tap `detail` 1, so time and place are all that tell the second tap apart: it
 * came 15 to 19 ms after the first, at the same point. No web API reports the platform's double-tap
 * settings, so these follow its defaults:
 *
 * - 500 ms: Windows' default double-click time (SetDoubleClickTime, learn.microsoft.com). The
 *   window runs from the click that closed or opened the dialog, fired as the first tap lifts, to
 *   the second tap's press, fired as it lifts, so it has to hold Android's double-tap time, 300 ms
 *   from the first tap's up to the second's down (`DOUBLE_TAP_TIMEOUT`, ViewConfiguration.java),
 *   plus the second tap itself. iOS publishes no value.
 * - 100 px: Android's double-tap distance, 100 dp between the two touches (`DOUBLE_TAP_SLOP`,
 *   ViewConfiguration.java). Next.js's default viewport is `width=device-width` (src/app/layout.tsx
 *   sets no width; node_modules/next/dist/docs/01-app/01-getting-started/14-metadata-and-og-images.md),
 *   at which a CSS pixel is a dp.
 *
 * The cost: a separate tap that close and that soon after a tap closed or opened a dialog does
 * nothing, and the person taps again.
 */
export const TOUCH_REPEAT_WINDOW_MS = 500;
export const TOUCH_REPEAT_RADIUS_PX = 100;

/** Where and when a tap's click happened: `clientX`, `clientY`, and the event's `timeStamp`. */
export type Tap = Readonly<Point & { timeStamp: number }>;

export type DialogController = Readonly<{
  open: (dialog: DialogElement, opener: FocusTarget | null) => void;
  /**
   * Closes the dialog if it is open. A completed close moves focus straight away, even when the
   * dialog is gone or Escape closed it while the action ran.
   */
  close: (dialog: DialogElement | null, reason: CloseReason, fallback: FocusTarget | null) => void;
  /** Sends focus somewhere else on the next close, such as the part of the page a result named. */
  returnFocusTo: (target: FocusTarget | null) => void;
  /** Handles the dialog's `close` event, however the dialog was closed. */
  closed: (
    dialog: DialogElement,
    context: Readonly<{
      fallback: FocusTarget | null;
      onClose: ((closed: ClosedDialog) => void) | undefined;
      /** Asked after `onClose`, which may have opened the next modal. */
      otherModalOpen: () => boolean;
    }>,
  ) => void;
}>;

export function createDialogController(): DialogController {
  let opener: FocusTarget | null = null;
  let reason: CloseReason = "dismissed";
  return {
    open(dialog, from) {
      opener = from;
      reason = "dismissed";
      if (!dialog.open) dialog.showModal();
    },
    close(dialog, next, fallback) {
      const open = dialog?.open === true;
      // A completed close counts even when Escape has already hidden the dialog: its `close` event
      // may still be on the way, and must not then send focus back to the opener.
      if (open || next === "completed") reason = next;
      if (open) dialog.close();
      if (next === "completed") focusAfterClose(next, opener, fallback)?.focus();
    },
    returnFocusTo(target) {
      opener = target;
    },
    closed(dialog, { fallback, onClose, otherModalOpen }) {
      // Chromium hides a closing dialog at once but fires `close` on the next animation frame, so
      // a shortcut pressed in between reopens it first (#225). The event then belongs to the
      // earlier close, and the open dialog keeps its own opener and focus.
      if (dialog.open) return;
      const closed: ClosedDialog = { reason, opener };
      opener = null;
      reason = "dismissed";
      onClose?.(closed);
      if (closed.reason === "completed" || otherModalOpen()) return;
      focusAfterClose(closed.reason, closed.opener, fallback)?.focus();
    },
  };
}
