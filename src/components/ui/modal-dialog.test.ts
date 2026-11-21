import { getEventListeners } from "node:events";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TOUCH_REPEAT_RADIUS_PX, TOUCH_REPEAT_WINDOW_MS, type Tap } from "./dialog-controller";
import { DialogCloseButton, ignoreClosingRepeat, ModalDialog, openingRepeatRule, recordTaps, useModalDialog } from "./modal-dialog";

type Props = Omit<Parameters<typeof ModalDialog>[0], "dialog" | "children">;

/** A closed dialog as the server renders it, with `children` as its content. */
function render(props: Props, children: ReactNode = createElement("p", null, "Body")): string {
  function Harness() {
    const dialogProps: Parameters<typeof ModalDialog>[0] = { ...props, dialog: useModalDialog(), children };
    return createElement(ModalDialog, dialogProps);
  }
  return renderToStaticMarkup(createElement(Harness));
}

function attribute(markup: string, name: string): string | undefined {
  const dialog = /<dialog\b[^>]*>/.exec(markup)?.[0] ?? "";
  return new RegExp(`${name}="([^"]+)"`).exec(dialog)?.[1];
}

describe("ModalDialog", () => {
  it("is labeled by its title and described by its description, whatever classes style them", () => {
    const markup = render({ title: "Delete Billing?", description: "This cannot be undone." });
    const labeledBy = attribute(markup, "aria-labelledby");
    const describedBy = attribute(markup, "aria-describedby");
    expect(labeledBy).toBeDefined();
    expect(describedBy).toBeDefined();
    expect(markup).toMatch(new RegExp(`<h2 id="${labeledBy}"[^>]*>Delete Billing\\?</h2>`));
    expect(markup).toMatch(new RegExp(`<div id="${describedBy}"[^>]*>This cannot be undone\\.</div>`));
  });

  it("is described by an element inside its content when there is no description under the title", () => {
    const markup = render({ title: "Command palette", hideTitle: true, describedBy: "notice", content: "always" });
    expect(attribute(markup, "aria-describedby")).toBe("notice");
    expect(markup).toMatch(/<h2 id="[^"]+" class="sr-only">Command palette<\/h2>/);
  });

  it("has no description when it is given none", () => {
    expect(attribute(render({ title: "Share GitHub stars" }), "aria-describedby")).toBeUndefined();
  });

  it.each([
    ["each-open", false],
    ["after-first-open", false],
    ["always", true],
  ] as const)("with %s content, renders the content before the first open: %s", (content, rendered) => {
    expect(render({ title: "Title", content }).includes("<p>Body</p>")).toBe(rendered);
  });

  it("marks Cancel to take focus on open, and a Close beside a search box not to", () => {
    const cancel = render({ title: "Title", content: "always" }, createElement(DialogCloseButton));
    expect(cancel).toMatch(/<button type="button" data-initial-focus=""[^>]*>Cancel<\/button>/);
    const close = render({ title: "Title", content: "always" }, createElement(DialogCloseButton, { initialFocus: false }, "Close"));
    expect(close).not.toContain("data-initial-focus");
  });

  it("refuses a close button outside a dialog", () => {
    expect(() => renderToStaticMarkup(createElement(DialogCloseButton))).toThrow(/inside ModalDialog/);
  });
});

type Type = "mousedown" | "mouseup" | "click" | "dblclick";

/** Where and when a press happened, as far as the touch window reads one. */
type At = Readonly<{ x: number; y: number; ms: number }>;

/** A mouse event as far as the rules read one: its type, the browser's click count, and where and when. */
class Press extends Event {
  stopped = false;
  readonly clientX: number;
  readonly clientY: number;
  readonly #ms: number;
  constructor(type: Type, readonly detail: number, at: At = { x: 0, y: 0, ms: 0 }) {
    super(type, { cancelable: true });
    this.clientX = at.x;
    this.clientY = at.y;
    this.#ms = at.ms;
  }
  override get timeStamp(): number {
    return this.#ms;
  }
  override stopPropagation(): void {
    this.stopped = true;
    super.stopPropagation();
  }
}

/** Sends each event to `target` in turn and says, for each, whether it was ignored. */
function ignored(target: EventTarget, events: ReadonlyArray<readonly [Type, number] | readonly [Type, number, At]>): boolean[] {
  return events.map(([type, count, at]) => {
    const event = new Press(type, count, at);
    target.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(event.stopped);
    return event.stopped;
  });
}

const TYPES = ["mousedown", "mouseup", "click", "dblclick"] as const;

/** The click of a tap that closed or opened a dialog. */
const TAP: Tap = { x: 300, y: 33, timeStamp: 1_000 };
/** A tap's press, release, and click, each counted 1, `ms` after `TAP`, `dx` to its right and `dy` below it. */
const tap = (ms: number, dx = 0, dy = 0) => (["mousedown", "mouseup", "click"] as const).map((type) => [type, 1, { x: TAP.x + dx, y: TAP.y + dy, ms: TAP.timeStamp + ms }] as const);

/**
 * The touch window, the same on the closing side (#578) and the opening side (#592): the tap that
 * closed or opened the dialog (`null` for a mouse's click), the next press's events, and whether
 * each is ignored.
 */
const TOUCH_WINDOW_CASES = [
  ["ignores a second tap at the same point 15 ms later, as WebKit and Firefox count it 1", TAP, tap(15), [true, true, true]],
  ["ignores a second tap at the window's edge in time", TAP, tap(TOUCH_REPEAT_WINDOW_MS), [true, true, true]],
  ["ignores a second tap at the window's edge in distance", TAP, tap(15, TOUCH_REPEAT_RADIUS_PX), [true, true, true]],
  ["lets a tap 1 ms past the window through", TAP, tap(TOUCH_REPEAT_WINDOW_MS + 1), [false, false, false]],
  ["lets a tap 1 px past the window's distance through", TAP, tap(15, TOUCH_REPEAT_RADIUS_PX + 1), [false, false, false]],
  ["ignores a second tap 60 px across and 80 px down, on the window's radius", TAP, tap(15, 60, 80), [true, true, true]],
  ["lets a tap 71 px across and 71 px down through, inside a square of the radius but outside the circle", TAP, tap(15, 71, 71), [false, false, false]],
  ["lets a press counted 1 at the same point 15 ms later through after a mouse's click", null, tap(15), [false, false, false]],
] as const;

describe("ignoreClosingRepeat", () => {
  it.each([
    ["the rest of the double-click whose click closed the dialog", [["mousedown", 2], ["mouseup", 2], ["click", 2], ["dblclick", 2]], [true, true, true, true]],
    ["a triple-click's third press as well", [["mousedown", 2], ["mouseup", 2], ["click", 2], ["mousedown", 3], ["mouseup", 3], ["click", 3]], [true, true, true, true, true, true]],
    ["nothing from a press counted 1 on: a click of its own and the double-click it starts", [["mousedown", 1], ["mouseup", 1], ["click", 1], ["mousedown", 2], ["mouseup", 2], ["click", 2], ["dblclick", 2]], [false, false, false, false, false, false, false]],
    ["nothing from a press counted 0 on, as a script sends", [["mousedown", 0], ["mousedown", 2], ["click", 2]], [false, false, false]],
    ["no click counted 0, a key's, which leaves the rule in place", [["click", 0], ["mousedown", 2], ["click", 2]], [false, true, true]],
  ] as const)("ignores %s", (_, events, expected) => {
    const target = new EventTarget();
    ignoreClosingRepeat(target);
    expect(ignored(target, events)).toEqual(expected);
  });

  it("removes every listener at the press counted 1 that ends it", () => {
    const target = new EventTarget();
    ignoreClosingRepeat(target);
    expect(TYPES.map((type) => getEventListeners(target, type).length)).toEqual([1, 1, 1, 1]);
    ignored(target, [["mousedown", 1]]);
    expect(TYPES.map((type) => getEventListeners(target, type).length)).toEqual([0, 0, 0, 0]);
  });

  it("removes every listener when ended before any press, and ending again does nothing", () => {
    const target = new EventTarget();
    const end = ignoreClosingRepeat(target);
    end();
    end();
    expect(TYPES.map((type) => getEventListeners(target, type).length)).toEqual([0, 0, 0, 0]);
    expect(ignored(target, [["mousedown", 2], ["click", 2]])).toEqual([false, false]);
  });

  describe("after a tap closed the dialog (#578)", () => {
    it.each(TOUCH_WINDOW_CASES)("%s", (_, closingTap, events, expected) => {
      const target = new EventTarget();
      ignoreClosingRepeat(target, closingTap);
      expect(ignored(target, events)).toEqual(expected);
    });

    it("checks only the next press: a third tap counted 1 inside the window acts and ends the rule", () => {
      const target = new EventTarget();
      ignoreClosingRepeat(target, TAP);
      expect(ignored(target, [...tap(15), ["mousedown", 2], ...tap(30)])).toEqual([true, true, true, true, false, false, false]);
      expect(TYPES.map((type) => getEventListeners(target, type).length)).toEqual([0, 0, 0, 0]);
    });

    it("ends the second tap at its click: a click counted 1 with no press before it passes, and the rule stays", () => {
      const target = new EventTarget();
      ignoreClosingRepeat(target, TAP);
      expect(ignored(target, [...tap(15), ["click", 1], ["mousedown", 2], ["click", 2]])).toEqual([true, true, true, false, true, true]);
      expect(TYPES.map((type) => getEventListeners(target, type).length)).toEqual([1, 1, 1, 1]);
    });

    it("ends at a press counted 1 once the window has passed, which then acts as a click of its own", () => {
      const target = new EventTarget();
      ignoreClosingRepeat(target, TAP);
      expect(ignored(target, [["mousedown", 2], ...tap(TOUCH_REPEAT_WINDOW_MS + 1)])).toEqual([true, false, false, false]);
      expect(TYPES.map((type) => getEventListeners(target, type).length)).toEqual([0, 0, 0, 0]);
    });
  });
});

/**
 * A dialog's capture phase with the opening rule on it, as `ModalDialog` puts it, on `target`, and
 * `lastTap` as the page's latest tap. Listeners on `target` before it run first, as `window`'s do.
 */
function openedDialog(lastTap: () => Tap | null = () => null, target = new EventTarget()) {
  const rule = openingRepeatRule(lastTap);
  for (const type of TYPES) {
    target.addEventListener(type, (event) => {
      if (event instanceof Press) rule.ignore(event);
    });
  }
  return { target, rule };
}

describe("openingRepeatRule", () => {
  it.each([
    ["the rest of the double-click whose click opened the dialog", [["mousedown", 2], ["mouseup", 2], ["click", 2], ["dblclick", 2]], [true, true, true, true]],
    ["a triple-click's third press as well", [["mousedown", 2], ["mouseup", 2], ["click", 2], ["mousedown", 3], ["mouseup", 3], ["click", 3]], [true, true, true, true, true, true]],
    ["nothing from a press counted 1 on: a click of its own and the double-click it starts", [["mousedown", 1], ["mouseup", 1], ["click", 1], ["mousedown", 2], ["mouseup", 2], ["click", 2], ["dblclick", 2]], [false, false, false, false, false, false, false]],
    ["nothing from a press counted 0 on, as a script sends", [["mousedown", 0], ["mousedown", 2], ["click", 2]], [false, false, false]],
    ["no click counted 0, a key's, which leaves the rule in place", [["click", 0], ["mousedown", 2], ["click", 2]], [false, true, true]],
  ] as const)("ignores %s", (_, events, expected) => {
    const { target } = openedDialog();
    expect(ignored(target, events)).toEqual(expected);
  });

  it("starts again at the next open", () => {
    const { target, rule } = openedDialog();
    expect(ignored(target, [["mousedown", 1], ["mousedown", 2]])).toEqual([false, false]);
    rule.closed();
    expect(ignored(target, [["mousedown", 2], ["click", 2]])).toEqual([true, true]);
  });

  describe("after a tap opened the dialog (#592)", () => {
    it.each(TOUCH_WINDOW_CASES)("%s", (_, openingTap, events, expected) => {
      const { target } = openedDialog(() => openingTap);
      expect(ignored(target, events)).toEqual(expected);
    });

    it("checks only the first press: a third tap counted 1 inside the window acts and ends the rule", () => {
      const { target } = openedDialog(() => TAP);
      expect(ignored(target, [...tap(15), ["mousedown", 2], ...tap(30), ["mousedown", 2]])).toEqual([true, true, true, true, false, false, false, false]);
    });

    it("ends the second tap at its click: a click counted 1 with no press before it passes, and the rule stays", () => {
      const { target } = openedDialog(() => TAP);
      expect(ignored(target, [...tap(15), ["click", 1], ["mousedown", 2], ["click", 2]])).toEqual([true, true, true, false, true, true]);
    });

    it("ends at a press counted 1 once the window has passed, which then acts as a click of its own", () => {
      const { target } = openedDialog(() => TAP);
      expect(ignored(target, [["mousedown", 2], ...tap(TOUCH_REPEAT_WINDOW_MS + 1), ["mousedown", 2]])).toEqual([true, false, false, false, false]);
    });

    it("checks the tap again at the next open", () => {
      const { target, rule } = openedDialog(() => TAP);
      expect(ignored(target, [...tap(15), ...tap(30)])).toEqual([true, true, true, false, false, false]);
      rule.closed();
      expect(ignored(target, tap(45))).toEqual([true, true, true]);
    });
  });
});

describe("recordTaps", () => {
  /** A `pointerdown` as far as the recorder reads one. */
  class PointerPress extends Event {
    constructor(readonly pointerType: string) {
      super("pointerdown");
    }
  }

  /** Sends a `pointerdown` from `pointerType` (none for a key's click), then a click counted `count` at `at`. */
  function click(target: EventTarget, pointerType: string | null, count: number, at: At): void {
    if (pointerType !== null) target.dispatchEvent(new PointerPress(pointerType));
    target.dispatchEvent(new Press("click", count, at));
  }

  const AT: At = { x: TAP.x, y: TAP.y, ms: TAP.timeStamp };

  it("records a tap's click: its place and time", () => {
    const target = new EventTarget();
    const recorder = recordTaps(target);
    click(target, "touch", 1, AT);
    expect(recorder.last()).toEqual(TAP);
  });

  it.each([
    ["a mouse's click", "mouse", 1],
    ["a pen's click", "pen", 1],
    ["a key's click, counted 0 with no press before it", null, 0],
  ] as const)("records no tap for %s, and forgets the tap before it", (_, pointerType, count) => {
    const target = new EventTarget();
    const recorder = recordTaps(target);
    click(target, "touch", 1, AT);
    click(target, pointerType, count, { ...AT, ms: AT.ms + 15 });
    expect(recorder.last()).toBeNull();
  });

  it("records no tap for a key's click after a touch press that made no click, as a scroll's", () => {
    const target = new EventTarget();
    const recorder = recordTaps(target);
    target.dispatchEvent(new PointerPress("touch"));
    click(target, null, 0, AT);
    expect(recorder.last()).toBeNull();
  });

  it("keeps the opening tap through the second tap's own press, so the opening rule ignores that tap", () => {
    const target = new EventTarget();
    const recorder = recordTaps(target);
    openedDialog(recorder.last, target);
    click(target, "touch", 1, AT);
    target.dispatchEvent(new PointerPress("touch"));
    expect(ignored(target, tap(15))).toEqual([true, true, true]);
  });

  it("stops checking at a second tap counted 2, as Chromium counts it, so a tap counted 1 1 ms past the opening tap's window acts though inside the second's", () => {
    const target = new EventTarget();
    const recorder = recordTaps(target);
    openedDialog(recorder.last, target);
    click(target, "touch", 1, AT);
    const second = { ...AT, ms: AT.ms + 100 };
    target.dispatchEvent(new PointerPress("touch"));
    expect(ignored(target, [["mousedown", 2, second], ["mouseup", 2, second], ["click", 2, second]])).toEqual([true, true, true]);
    expect(recorder.last()).toEqual({ ...TAP, timeStamp: second.ms });
    target.dispatchEvent(new PointerPress("touch"));
    expect(ignored(target, tap(TOUCH_REPEAT_WINDOW_MS + 1))).toEqual([false, false, false]);
  });

  it("removes its listeners when ended", () => {
    const target = new EventTarget();
    recordTaps(target).end();
    expect(["pointerdown", "click"].map((type) => getEventListeners(target, type).length)).toEqual([0, 0]);
  });
});
