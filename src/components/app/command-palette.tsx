"use client";

import { useRouter } from "next/navigation";
import {
  Fragment,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { acknowledgeAllAlerts } from "@/app/w/[workspace]/alerts/actions";
import { syncNow } from "@/app/w/[workspace]/connections/actions";
import { acknowledgedAllMessage } from "@/components/alerts/labels";
import { SearchIcon } from "@/components/icons";
import { buttonClass } from "@/components/ui/button";
import type { FocusTarget } from "@/components/ui/dialog-controller";
import { LiveRegion, OutcomeAnnouncement, type Outcome } from "@/components/ui/live-region";
import { DialogActions, DialogCloseButton, INITIAL_FOCUS, ModalDialog, useModalDialog } from "@/components/ui/modal-dialog";
import {
  isApplePlatform,
  isTypingTarget,
  matchPaletteKey,
  matchShortcut,
  MAX_QUERY_LENGTH,
  paletteShortcut,
  pointerMoved,
  searchCommands,
  type PaletteAction,
  type PaletteCommand,
  type PaletteSearch,
  type PointerPosition,
} from "@/lib/palette/search";

const noSubscribe = () => () => {};

/** The platform never changes while the page is open. The server renders the Ctrl label. */
function useApplePlatform(): boolean {
  return useSyncExternalStore(
    noSubscribe,
    () => isApplePlatform(navigator.userAgent),
    () => false,
  );
}

const count = new Intl.NumberFormat("en-US");

function resultStatus(search: PaletteSearch, query: string): string {
  if (search.total === 0) {
    return `No commands match "${query.trim()}". Try a page, action, workspace, provider, project, or account name.`;
  }
  if (search.results.length < search.total) {
    return `Showing ${count.format(search.results.length)} of ${count.format(search.total)} results. Type more to narrow the list.`;
  }
  return `${count.format(search.total)} ${search.total === 1 ? "result" : "results"}`;
}

/** The palette results that run a Server Action rather than open a page. */
type ServerAction = Extract<PaletteAction, { kind: "sync" | "acknowledge_all" }>;

/**
 * What an action says while it runs, to a second request made before it ends, and when its
 * request never got an answer.
 */
function wordsFor(action: ServerAction): Readonly<{ running: string; busy: string; lost: string }> {
  return action.kind === "sync"
    ? {
        running: `Queueing a sync for ${action.name}.`,
        busy: "A sync is already being queued. Wait for its result, then try again.",
        lost: `The sync for ${action.name} could not be requested`,
      }
    : {
        running: "Acknowledging all alerts.",
        busy: "Alerts are already being acknowledged. Wait for the result, then try again.",
        lost: "The alerts could not be acknowledged",
      };
}

/**
 * Runs an action through the existing Server Action for it (the connection page's sync, the alerts
 * list's acknowledge all), which authorizes the caller and words every result, so the palette adds
 * only the case where the request never got an answer.
 */
async function runServerAction(workspaceSlug: string, action: ServerAction): Promise<Outcome> {
  const formData = new FormData();
  formData.set("workspace", workspaceSlug);
  let failure: Readonly<{ message: string; referenceId?: string | undefined }>;
  try {
    if (action.kind === "sync") {
      formData.append("connectionId", action.connectionId);
      const result = await syncNow(null, formData);
      if (result.ok) return { tone: "success", message: result.message ?? `Sync queued for ${action.name}.` };
      failure = result;
    } else {
      const result = await acknowledgeAllAlerts(null, formData);
      // The palette is not the alerts list, so there is no "Show acknowledged alerts" to point to.
      if (result.ok) return { tone: "success", message: acknowledgedAllMessage(result, true) };
      failure = result;
    }
  } catch {
    // A rejected Server Action means the request or its response was lost on the way; the server
    // logs its own failures, so all the palette can add is the next step.
    return {
      tone: "error",
      message: `${wordsFor(action).lost} because StackDash did not answer. Check that you are online, then try again.`,
    };
  }
  return {
    tone: "error",
    message: failure.message,
    ...(failure.referenceId === undefined ? {} : { referenceId: failure.referenceId }),
  };
}

const KBD = "rounded border border-line-strong bg-panel-raised px-1.5 font-mono text-[11px] leading-5 text-foreground";

function ArrowKeys() {
  return (
    <>
      <kbd className={KBD}>
        <span aria-hidden="true">↑</span>
        <span className="sr-only">Up arrow</span>
      </kbd>{" "}
      <kbd className={KBD}>
        <span aria-hidden="true">↓</span>
        <span className="sr-only">Down arrow</span>
      </kbd>
    </>
  );
}

/**
 * The workspace command palette (#170): a button in the shell, Cmd+K or Ctrl+K, and `?` for the
 * shortcut list. Both are `ModalDialog`s, like the repository's confirm dialogs: focus moves in on
 * open, stays in while open, returns to where it was on close (the button when that is gone), and
 * Escape closes. The results follow the ARIA combobox pattern with a listbox popup: focus stays in
 * the input and `aria-activedescendant` names the selected result, so a screen reader announces
 * it.
 *
 * `commands` arrive from the server already built; filtering happens here, in memory. A result is
 * named by its label and described by its kind ("Stripe", "Provider dashboard"). An action (#265)
 * runs its existing Server Action with the palette left open, and its progress, result, or failure
 * is announced in the palette, where focus already is.
 */
export function CommandPalette({
  workspaceSlug,
  commands,
  notice,
}: {
  /** The workspace the actions run in; each Server Action checks the member's role there again. */
  workspaceSlug: string;
  commands: readonly PaletteCommand[];
  /** Shown above the results when part of the list could not be loaded. */
  notice: string | null;
}) {
  const router = useRouter();
  const apple = useApplePlatform();
  const shortcut = paletteShortcut(apple);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [running, startRunning] = useTransition();
  const buttonId = useId();
  const palette = useModalDialog({ fallbackFocusId: buttonId });
  const shortcuts = useModalDialog({ fallbackFocusId: buttonId });
  // "Keyboard shortcuts" closes the palette and opens the list, which returns focus where the
  // palette would have.
  const shortcutsNextRef = useRef(false);
  // Where the pointer last was over the results, so a row scrolling under a resting pointer does
  // not take the selection from the arrow keys.
  const pointerRef = useRef<PointerPosition | null>(null);
  // Counts opens, so an action still running from an earlier open does not report into this one.
  const openCountRef = useRef(0);
  // The open the running action reports to: the one that started it, or a later one that asked for
  // another action while it ran and was told to wait for its result.
  const actionOpenRef = useRef(0);
  // What a request made while an action runs is told: the running action's own words.
  const busyRef = useRef("");
  const inputId = useId();
  const listboxId = useId();
  const noticeId = useId();
  const optionId = (index: number) => `${listboxId}-option-${index}`;

  // Only searched while open; a closed palette renders no results.
  const search = open ? searchCommands(commands, query) : null;
  const results = search?.results ?? [];
  const activeIndex = Math.min(active, Math.max(results.length - 1, 0));
  const hasResults = results.length > 0;

  function openPalette(): void {
    openCountRef.current += 1;
    // A list request from a close that never finished (the palette reopened first) is dropped.
    shortcutsNextRef.current = false;
    setQuery("");
    setActive(0);
    setOutcome(null);
    setOpen(true);
    palette.open();
  }

  function onPaletteClose(opener: FocusTarget | null): void {
    setOpen(false);
    if (!shortcutsNextRef.current) return;
    shortcutsNextRef.current = false;
    shortcuts.open(opener);
  }

  function choose(command: PaletteCommand): void {
    const { action } = command;
    // An action runs with the palette open, so its result is announced where focus already is.
    if (action.kind === "sync" || action.kind === "acknowledge_all") {
      // One at a time. A second request, including one from a reopened palette while the first is
      // still on its way, is told to wait, and this open now receives the running action's result.
      if (running) {
        actionOpenRef.current = openCountRef.current;
        setOutcome({ tone: "info", message: busyRef.current });
        return;
      }
      const words = wordsFor(action);
      busyRef.current = words.busy;
      setOutcome({ tone: "info", message: words.running });
      actionOpenRef.current = openCountRef.current;
      startRunning(async () => {
        const next = await runServerAction(workspaceSlug, action);
        if (openCountRef.current === actionOpenRef.current) setOutcome(next);
      });
      return;
    }
    if (action.kind === "shortcuts") shortcutsNextRef.current = true;
    if (action.kind === "navigate") {
      // A result for part of this page (Create API key, chosen on settings) leaves focus there:
      // navigating within the page mounts nothing new that could take it.
      const destination = new URL(action.href, window.location.href);
      const target =
        destination.hash !== "" && destination.pathname === window.location.pathname
          ? document.getElementById(destination.hash.slice(1))
          : null;
      if (target !== null) palette.returnFocusTo(target);
    }
    palette.close();
    if (action.kind === "navigate") router.push(action.href);
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    // `nativeEvent` carries `isComposing`; mid-composition keys belong to the IME, not the palette.
    const key = matchPaletteKey(event.nativeEvent);
    if (key === "next" || key === "previous") {
      event.preventDefault();
      if (!hasResults) return;
      const step = key === "next" ? 1 : -1;
      setActive((activeIndex + step + results.length) % results.length);
    } else if (key === "choose") {
      const command = results[activeIndex];
      if (command === undefined) return;
      event.preventDefault();
      choose(command);
    }
  }

  // A row selects on hover only when the pointer moves over it. Entering records the position
  // without selecting, so a row that scrolls under a resting pointer (the arrow keys scrolled the
  // list) keeps the keyboard's selection; the next real movement selects it.
  function onOptionPointerEnter(event: ReactPointerEvent<HTMLLIElement>): void {
    pointerRef.current = { x: event.clientX, y: event.clientY };
  }

  function onOptionPointerMove(event: ReactPointerEvent<HTMLLIElement>, index: number): void {
    const next = { x: event.clientX, y: event.clientY };
    const moved = pointerMoved(pointerRef.current, next);
    pointerRef.current = next;
    if (moved) setActive(index);
  }

  const onDocumentKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.defaultPrevented || isTypingTarget(event.target)) return;
    const requested = matchShortcut(event, apple);
    if (requested === null) return;
    // One modal at a time: an open confirm dialog, the palette, or the list keeps the keys.
    if (document.querySelector("dialog[open]") !== null) return;
    event.preventDefault();
    if (requested === "palette") {
      openPalette();
    } else {
      shortcuts.open();
    }
  });

  useEffect(() => {
    const listener = (event: KeyboardEvent) => onDocumentKeyDown(event);
    document.addEventListener("keydown", listener);
    return () => document.removeEventListener("keydown", listener);
  }, []);

  // Keeps the selected result visible while the arrow keys move through a long list.
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex, listboxId]);

  const shortcutRows: readonly Readonly<{ keys: ReactNode; description: string }>[] = [
    { keys: <kbd className={KBD}>{shortcut.label}</kbd>, description: "Open the command palette" },
    { keys: <kbd className={KBD}>?</kbd>, description: "Show this list of shortcuts" },
    { keys: <ArrowKeys />, description: "Move through the palette's results" },
    { keys: <kbd className={KBD}>Enter</kbd>, description: "Open or run the selected result" },
    { keys: <kbd className={KBD}>Esc</kbd>, description: "Close the palette or this list" },
  ];

  return (
    <>
      <button
        id={buttonId}
        type="button"
        aria-haspopup="dialog"
        aria-keyshortcuts={shortcut.aria}
        onClick={openPalette}
        className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-md border border-line px-2.5 py-1.5 text-sm text-muted transition-colors hover:border-line-strong hover:text-foreground"
      >
        <SearchIcon className="size-4 shrink-0" />
        <span className="sr-only sm:not-sr-only">Jump to</span>
        <kbd aria-hidden="true" className={`hidden md:inline ${KBD}`}>
          {shortcut.label}
        </kbd>
      </button>

      <ModalDialog
        dialog={palette}
        title="Command palette"
        hideTitle
        describedBy={notice === null ? undefined : noticeId}
        size="palette"
        content="always"
        onClose={({ opener }) => onPaletteClose(opener)}
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-2">
          <SearchIcon className="size-4 shrink-0 text-muted" />
          <label htmlFor={inputId} className="sr-only">
            Search commands
          </label>
          {/* No outline utility here: the field has no border, so the global :focus-visible outline in
              globals.css is its only focus indicator (#345). */}
          <input
            {...INITIAL_FOCUS}
            id={inputId}
            type="text"
            role="combobox"
            aria-expanded={hasResults}
            aria-controls={hasResults ? listboxId : undefined}
            aria-activedescendant={hasResults ? optionId(activeIndex) : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={MAX_QUERY_LENGTH}
            placeholder="Search pages, actions, workspaces, providers, projects, and accounts"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onInputKeyDown}
            className="min-h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-muted"
          />
          <DialogCloseButton initialFocus={false} className={buttonClass("secondary", "sm")}>
            Close
          </DialogCloseButton>
        </div>

        {notice === null ? null : (
          <p id={noticeId} className="border-b border-line px-4 py-2 text-sm text-warning">
            {notice}
          </p>
        )}

        {/* Always mounted, so screen readers announce every change: progress and success politely,
            a failure at once. */}
        <OutcomeAnnouncement outcome={outcome} className="text-sm" messageClassName="border-b border-line px-4 py-2" />

        {hasResults ? (
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Commands"
            // Clicking a result must not move focus out of the input, or the combobox loses it.
            onMouseDown={(event) => event.preventDefault()}
            className="max-h-[50vh] overflow-y-auto p-1.5"
          >
            {results.map((command, index) => {
              const selected = index === activeIndex;
              return (
                <li
                  key={command.id}
                  id={optionId(index)}
                  role="option"
                  // The kind is the option's description: a screen reader reads "Stripe" and then
                  // "Provider dashboard", the way the row shows them. A name built from both would
                  // need a separator the row does not show, or read the visible text out of order.
                  aria-describedby={`${optionId(index)}-kind`}
                  aria-selected={selected}
                  onClick={() => choose(command)}
                  onPointerEnter={onOptionPointerEnter}
                  onPointerMove={(event) => onOptionPointerMove(event, index)}
                  className={`flex min-h-9 cursor-pointer items-center gap-3 rounded-md border px-3 py-1.5 text-sm ${
                    selected ? "border-line-strong bg-panel-raised text-foreground" : "border-transparent text-muted"
                  }`}
                >
                  <span className="min-w-0 flex-1 break-words">{command.label}</span>
                  <span id={`${optionId(index)}-kind`} aria-hidden="true" className="shrink-0 text-xs text-muted">
                    {command.kind}
                  </span>
                  {/* Shape as well as color marks the selection. */}
                  {selected ? (
                    <kbd aria-hidden="true" className={`shrink-0 ${KBD}`}>
                      Enter
                    </kbd>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-xs text-muted">
          <LiveRegion tone="status" as="p">
            {search === null ? null : resultStatus(search, query)}
          </LiveRegion>
          <p aria-hidden="true" className="hidden sm:block">
            <ArrowKeys /> to move, <kbd className={KBD}>Enter</kbd> to choose, <kbd className={KBD}>Esc</kbd> to close
          </p>
        </div>
      </ModalDialog>

      <ModalDialog
        dialog={shortcuts}
        title="Keyboard shortcuts"
        description="Shortcuts do nothing while you are typing in a field."
        size="sm"
      >
        <dl className="mt-4 grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          {shortcutRows.map(({ keys, description }) => (
            <Fragment key={description}>
              <dt className="whitespace-nowrap">{keys}</dt>
              <dd>{description}</dd>
            </Fragment>
          ))}
        </dl>
        <DialogActions>
          <DialogCloseButton className={buttonClass("secondary", "sm")}>Close</DialogCloseButton>
        </DialogActions>
      </ModalDialog>
    </>
  );
}
