import { describe, expect, it, vi } from "vitest";

import {
  createDialogController,
  dismissedByClick,
  focusAfterClose,
  type ClosedDialog,
  type CloseReason,
  type FocusTarget,
} from "./dialog-controller";

/** An element that records when it takes focus, and can leave the document like a deleted row. */
function target(name: string, focused: string[]): FocusTarget & { isConnected: boolean } {
  return {
    isConnected: true,
    focus: () => {
      focused.push(name);
    },
  };
}

/**
 * A native `<dialog>` as far as the controller sees it. `showModal()` and `close()` behave like the
 * browser's; `pressEscape()` is the browser closing it on Escape, which never goes through the
 * controller's `close`. Each close fires the `close` event, as the browser does, unless
 * `closeEventFires` is false: the event React drops once the row holding the dialog is gone.
 */
function fakeDialog({
  fallback = null,
  otherModalOpen = () => false,
  closeEventFires = true,
}: { fallback?: FocusTarget | null; otherModalOpen?: () => boolean; closeEventFires?: boolean } = {}) {
  const controller = createDialogController();
  const closes: ClosedDialog[] = [];
  const dialog = {
    open: false,
    showModal: vi.fn(() => {
      dialog.open = true;
    }),
    close: () => {
      if (!dialog.open) return;
      dialog.open = false;
      if (closeEventFires) fireClose();
    },
  };
  function fireClose() {
    controller.closed(dialog, { fallback, onClose: (closed) => closes.push(closed), otherModalOpen });
  }
  return {
    controller,
    dialog,
    closes,
    fireClose,
    pressEscape: () => {
      dialog.open = false;
      fireClose();
    },
    close: (reason: CloseReason) => controller.close(dialog, reason, fallback),
  };
}

describe("focusAfterClose", () => {
  it.each([
    ["dismissed", "opener"],
    ["completed", "fallback"],
  ] as const)("a %s close prefers the %s", (reason, expected) => {
    const focused: string[] = [];
    focusAfterClose(reason, target("opener", focused), target("fallback", focused))?.focus();
    expect(focused).toEqual([expected]);
  });

  it.each([
    ["dismissed", "fallback"],
    ["completed", "fallback"],
  ] as const)("a %s close skips an opener that left the document for the %s", (reason, expected) => {
    const focused: string[] = [];
    const opener = target("opener", focused);
    opener.isConnected = false;
    focusAfterClose(reason, opener, target("fallback", focused))?.focus();
    expect(focused).toEqual([expected]);
  });

  it("a completed close without a fallback leaves focus where the action put it", () => {
    expect(focusAfterClose("completed", target("opener", []), null)).toBeNull();
  });

  it("a completed close skips a fallback that left the document rather than refocusing the opener", () => {
    const fallback = target("fallback", []);
    fallback.isConnected = false;
    expect(focusAfterClose("completed", target("opener", []), fallback)).toBeNull();
  });

  it("returns nothing when neither target is in the document", () => {
    const opener = target("opener", []);
    const fallback = target("fallback", []);
    opener.isConnected = false;
    fallback.isConnected = false;
    expect(focusAfterClose("dismissed", opener, fallback)).toBeNull();
    expect(focusAfterClose("completed", null, null)).toBeNull();
  });
});

describe("dismissedByClick", () => {
  // The event details panel at 1280 by 900: a right-hand column, the dimmed timeline to its left.
  const panel = { left: 832, top: 0, right: 1280, bottom: 900 };
  const beside = { x: 400, y: 450 };
  const inside = { x: 1000, y: 450 };

  it.each([
    ["pressed and released beside the panel", true, beside, beside],
    ["pressed and released at different points beside the panel", true, beside, { x: 10, y: 890 }],
    ["pressed and released one pixel left of the panel's edge", true, { x: 831, y: 450 }, { x: 831, y: 450 }],
    ["pressed and released inside the panel", false, inside, inside],
    ["pressed and released on the panel's left edge, its padding", false, { x: 832, y: 450 }, { x: 832, y: 450 }],
    ["pressed and released on the panel's corners", false, { x: 1280, y: 0 }, { x: 832, y: 900 }],
    ["pressed inside and released beside, selecting text", false, inside, beside],
    ["pressed beside and released inside", false, beside, inside],
  ] as const)("%s: closes %s", (_case, closes, pressedAt, releasedAt) => {
    expect(dismissedByClick(panel, pressedAt, releasedAt)).toBe(closes);
  });

  it("never closes on a click with no press, as a keyboard activation fires", () => {
    expect(dismissedByClick(panel, null, beside)).toBe(false);
  });
});

describe("createDialogController", () => {
  it("returns focus to the opener when Escape closes the dialog", () => {
    const focused: string[] = [];
    const { controller, dialog, closes, pressEscape } = fakeDialog({ fallback: target("fallback", focused) });
    const opener = target("opener", focused);
    controller.open(dialog, opener);
    expect(dialog.open).toBe(true);

    pressEscape();

    expect(dialog.open).toBe(false);
    expect(closes).toEqual([{ reason: "dismissed", opener }]);
    expect(focused).toEqual(["opener"]);
  });

  it("treats Escape as dismissed even after an earlier open completed", () => {
    const focused: string[] = [];
    const { controller, dialog, closes, pressEscape, close } = fakeDialog({
      fallback: target("fallback", focused),
    });
    controller.open(dialog, target("opener", focused));
    close("completed");
    controller.open(dialog, target("opener", focused));
    pressEscape();
    expect(closes.map((closed) => closed.reason)).toEqual(["completed", "dismissed"]);
    expect(focused).toEqual(["fallback", "opener"]);
  });

  it("returns focus to the opener when Cancel closes the dialog", () => {
    const focused: string[] = [];
    const { controller, dialog, close } = fakeDialog({ fallback: target("fallback", focused) });
    controller.open(dialog, target("opener", focused));
    close("dismissed");
    expect(focused).toEqual(["opener"]);
  });

  it("moves focus to the fallback when the action completed", () => {
    const focused: string[] = [];
    const { controller, dialog, closes, close } = fakeDialog({ fallback: target("fallback", focused) });
    controller.open(dialog, target("opener", focused));
    close("completed");
    expect(closes.map((closed) => closed.reason)).toEqual(["completed"]);
    expect(focused).toEqual(["fallback"]);
  });

  it("moves focus to the fallback at once on a completed close, before any close event", () => {
    const focused: string[] = [];
    const { controller, dialog, closes, close, fireClose } = fakeDialog({
      fallback: target("fallback", focused),
      closeEventFires: false,
    });
    controller.open(dialog, target("opener", focused));
    close("completed");
    expect(focused).toEqual(["fallback"]);
    expect(closes).toEqual([]);

    // The event arriving late still reports the close, and does not move focus a second time.
    fireClose();
    expect(closes.map((closed) => closed.reason)).toEqual(["completed"]);
    expect(focused).toEqual(["fallback"]);
  });

  it("moves focus to the fallback on a completed close of a dialog Escape closed while the action ran", () => {
    const focused: string[] = [];
    const { controller, dialog, closes, close, pressEscape } = fakeDialog({
      fallback: target("fallback", focused),
    });
    controller.open(dialog, target("opener", focused));
    pressEscape();
    close("completed");
    expect(closes.map((closed) => closed.reason)).toEqual(["dismissed"]);
    expect(focused).toEqual(["opener", "fallback"]);
  });

  it("keeps focus on the fallback when the action completes while Escape's close event is in flight", () => {
    const focused: string[] = [];
    const { controller, dialog, closes, close, fireClose } = fakeDialog({
      fallback: target("fallback", focused),
    });
    controller.open(dialog, target("opener", focused));
    // Escape hid the dialog; the browser delivers its close event a frame later.
    dialog.open = false;
    close("completed");
    expect(focused).toEqual(["fallback"]);

    fireClose();
    expect(closes.map((closed) => closed.reason)).toEqual(["completed"]);
    expect(focused).toEqual(["fallback"]);
  });

  it("moves focus to the fallback on a completed close once the dialog itself is gone", () => {
    const focused: string[] = [];
    const controller = createDialogController();
    controller.close(null, "completed", target("fallback", focused));
    expect(focused).toEqual(["fallback"]);
  });

  it("leaves focus alone on a completed close without a fallback", () => {
    const focused: string[] = [];
    const { controller, dialog, closes, close } = fakeDialog();
    controller.open(dialog, target("opener", focused));
    close("completed");
    expect(closes.map((closed) => closed.reason)).toEqual(["completed"]);
    expect(focused).toEqual([]);
  });

  it("does nothing on a dismissed close of a dialog that is already closed", () => {
    const focused: string[] = [];
    const { controller, dialog, closes, close } = fakeDialog({ fallback: target("fallback", focused) });
    controller.open(dialog, target("opener", focused));
    // Hidden by the browser, its close event not delivered yet.
    dialog.open = false;
    close("dismissed");
    expect(closes).toEqual([]);
    expect(focused).toEqual([]);
  });

  it("moves focus to the fallback when Escape closes a dialog whose opener is gone", () => {
    const focused: string[] = [];
    const { controller, dialog, pressEscape } = fakeDialog({ fallback: target("fallback", focused) });
    const opener = target("opener", focused);
    controller.open(dialog, opener);
    opener.isConnected = false;
    pressEscape();
    expect(focused).toEqual(["fallback"]);
  });

  it("focuses nothing when opened from nowhere and there is no fallback", () => {
    const focused: string[] = [];
    const { controller, dialog, closes, pressEscape } = fakeDialog();
    controller.open(dialog, null);
    pressEscape();
    expect(closes).toEqual([{ reason: "dismissed", opener: null }]);
    expect(focused).toEqual([]);
  });

  it("sends focus where returnFocusTo says instead of the opener", () => {
    const focused: string[] = [];
    const { controller, dialog, close } = fakeDialog();
    controller.open(dialog, target("opener", focused));
    controller.returnFocusTo(target("section", focused));
    close("dismissed");
    expect(focused).toEqual(["section"]);
  });

  it("ignores a late close event once the dialog has opened again (#225)", () => {
    const focused: string[] = [];
    const { controller, dialog, closes, fireClose, close } = fakeDialog();
    controller.open(dialog, target("first opener", focused));
    // The browser hides the dialog, the user reopens it, and only then the first close event fires.
    dialog.open = false;
    controller.open(dialog, target("second opener", focused));
    fireClose();
    expect(closes).toEqual([]);
    expect(focused).toEqual([]);

    close("dismissed");
    expect(focused).toEqual(["second opener"]);
  });

  it("leaves focus alone when the close handed off to another modal", () => {
    const focused: string[] = [];
    const { controller, dialog, closes, close } = fakeDialog({
      fallback: target("fallback", focused),
      otherModalOpen: () => true,
    });
    controller.open(dialog, target("opener", focused));
    close("dismissed");
    expect(closes).toHaveLength(1);
    expect(focused).toEqual([]);
  });

  it("does not call showModal again on a dialog that is already open", () => {
    const { controller, dialog } = fakeDialog();
    controller.open(dialog, null);
    controller.open(dialog, null);
    expect(dialog.showModal).toHaveBeenCalledTimes(1);
  });
});
