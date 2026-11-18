import { getEventListeners } from "node:events";

import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DialogCloseButton, ignoreClosingRepeat, ModalDialog, useModalDialog } from "./modal-dialog";

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

describe("ignoreClosingRepeat", () => {
  type Type = "mousedown" | "mouseup" | "click" | "dblclick";

  /** A mouse event as far as the rule reads one: its type and the browser's click count. */
  class Press extends Event {
    stopped = false;
    constructor(type: Type, readonly detail: number) {
      super(type, { cancelable: true });
    }
    override stopPropagation(): void {
      this.stopped = true;
      super.stopPropagation();
    }
  }

  /** Sends each event to `target` in turn and says, for each, whether it was ignored. */
  function ignored(target: EventTarget, events: ReadonlyArray<readonly [Type, number]>): boolean[] {
    return events.map(([type, count]) => {
      const event = new Press(type, count);
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(event.stopped);
      return event.stopped;
    });
  }

  const TYPES = ["mousedown", "mouseup", "click", "dblclick"] as const;

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
});
