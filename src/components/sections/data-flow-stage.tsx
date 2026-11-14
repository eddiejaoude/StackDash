"use client";

import { useEffect, useId, useImperativeHandle, useRef, useState, type PointerEvent, type Ref } from "react";

import { PlatformLogo } from "@/components/icons";
import { CENTER, INNER_ORBIT, ORBIT } from "@/components/sections/data-flow-geometry";
import { Wordmark } from "@/components/wordmark";
import type { Platform } from "@/lib/site";

export type FlowSeverity = "success" | "warning" | "danger" | "summary";

export interface FlowEvent {
  label: string;
  severity: FlowSeverity;
}

export interface FlowAmbientPacket extends FlowEvent {
  /** Seconds after load that the packet first leaves its node. */
  delay: number;
}

/** One source on the orbit, placed by the server component in data-flow.tsx. */
export interface FlowNode {
  id: string;
  name: string;
  caption: string;
  platform: Platform | null;
  x: number;
  y: number;
  /** The side of the dot a packet's label sits on: the side facing the center. */
  labelSide: "left" | "right";
  /** Where this line's packets park under reduced motion, as an offset-distance. */
  park: string;
  axis: "vertical" | "horizontal";
  /** Which way a line's second parked packet stacks beside its first. */
  stack: "up" | "down";
  /** The packets that loop on this line by themselves. */
  ambient: readonly FlowAmbientPacket[];
  /** What a click on the source sends, in turn. */
  events: readonly FlowEvent[];
}

interface SentPacket {
  key: number;
  node: FlowNode;
  event: FlowEvent;
}

const severityDot: Record<FlowSeverity, string> = {
  success: "bg-success text-success",
  warning: "bg-warning text-warning",
  danger: "bg-danger text-danger",
  summary: "bg-muted text-muted",
};

const eventCount = new Intl.NumberFormat("en-US");

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
// How far the stage tilts toward the cursor at the frame's edge.
const MAX_TILT_DEG = 5;
// Each card drifts round a small circle (flow-drift in globals.css). Periods and phases differ by
// slot so neighboring cards never move in step.
const DRIFT_SECONDS = [7, 8.5, 10] as const;
// Dragging a card: it follows the pointer, but ever more stiffly, and never gets further than
// DRAG_REACH stage pixels from its place. A pointer has to move DRAG_THRESHOLD stage pixels
// before a press counts as a drag rather than a click.
const DRAG_REACH = 36;
const DRAG_THRESHOLD = 4;
// The spring that pulls a released card home: underdamped, so it overshoots and wobbles for
// about a second.
const SPRING_STIFFNESS = 260;
const SPRING_DAMPING = 9;
// Arrival pulses kept at once. Under reduced motion they never animate, so nothing removes them.
const MAX_PULSES = 4;

export function FlowSourceMark({ platform }: { platform: Platform | null }) {
  return platform === null ? null : <PlatformLogo platform={platform} width={14} height={14} className="shrink-0" />;
}

/** The wordmark and the illustrative event count in the center circle. */
export function FlowCore({ count }: { count: number }) {
  return (
    <div data-testid="flow-core-text" className="flex flex-col items-center gap-1.5 text-center">
      <Wordmark loading="lazy" />
      <p className="font-mono text-xs tabular-nums text-foreground">{eventCount.format(count)} events</p>
      <p className="font-mono text-[10px] text-muted">Illustrative</p>
    </div>
  );
}

interface HubHandle {
  /** One event reached the center: count it and pulse in its severity's color. */
  arrive: (severity: FlowSeverity) => void;
}

/**
 * The center circle. It keeps its own count and pulses, so the many arrivals a minute re-render
 * only this, not the whole stage.
 */
function Hub({ initialCount, ref }: { initialCount: number; ref: Ref<HubHandle> }) {
  const [count, setCount] = useState(initialCount);
  const [pulses, setPulses] = useState<readonly { key: number; severity: FlowSeverity }[]>([]);
  const nextPulse = useRef(0);

  useImperativeHandle(
    ref,
    () => ({
      arrive(severity) {
        setCount((current) => current + 1);
        const key = nextPulse.current++;
        setPulses((current) => [...current.slice(1 - MAX_PULSES), { key, severity }]);
      },
    }),
    [],
  );

  return (
    <div
      aria-hidden="true"
      className="flow-core absolute z-20 flex size-[150px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-line-strong bg-panel"
      style={{ left: CENTER.x, top: CENTER.y }}
    >
      {pulses.map((pulse) => (
        <span
          key={pulse.key}
          data-pulse={pulse.severity}
          className="flow-pulse"
          onAnimationEnd={() => setPulses((current) => current.filter((other) => other.key !== pulse.key))}
        />
      ))}
      <FlowCore count={count} />
    </div>
  );
}

function Packet({
  node,
  event,
  stack,
  delay,
  sent,
  on,
  onArrive,
}: {
  node: FlowNode;
  event: FlowEvent;
  stack?: FlowNode["stack"] | undefined;
  delay?: number;
  sent?: boolean;
  /** Its source is spotlighted, so it stays bright while the others dim. */
  on: boolean;
  /** A looping packet arrives at the end of each cycle; a sent one when its single run ends. */
  onArrive: () => void;
}) {
  return (
    <div
      data-testid="flow-packet"
      data-source={node.id}
      data-sent={sent || undefined}
      data-on={on || undefined}
      data-label-side={node.labelSide}
      data-axis={node.axis}
      data-stack={stack}
      className={`flow-packet flex items-center gap-2 ${sent ? "flow-packet-sent" : ""}`}
      style={{
        offsetPath: `path('M ${node.x} ${node.y} L ${CENTER.x} ${CENTER.y}')`,
        animationDelay: delay === undefined ? undefined : `${delay}s`,
        "--park": node.park,
      }}
      onAnimationIteration={sent ? undefined : onArrive}
      onAnimationEnd={sent ? onArrive : undefined}
    >
      <span className={`flow-packet-dot size-2 shrink-0 rounded-full ${severityDot[event.severity]}`} />
      <span
        data-testid="flow-label"
        className={`whitespace-nowrap rounded-full border bg-background/80 px-2 py-0.5 font-mono text-[10px] leading-4 text-foreground backdrop-blur-sm ${sent ? "border-accent/60" : "border-line-strong"}`}
      >
        {event.label}
      </span>
    </div>
  );
}

interface Drag {
  node: FlowNode;
  pointerId: number;
  startX: number;
  startY: number;
  /** Screen pixels per stage pixel, read when the press starts. */
  scale: number;
  dx: number;
  dy: number;
  moved: boolean;
}

/** Pulls a raw pointer offset in toward the card's place: free at first, never past DRAG_REACH. */
function stretch(dx: number, dy: number): [number, number] {
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return [0, 0];
  const reach = DRAG_REACH * Math.tanh(distance / DRAG_REACH);
  return [(dx / distance) * reach, (dy / distance) * reach];
}

/**
 * The interactive constellation, from the sm breakpoint up.
 *
 * - Hovering or focusing a source spotlights it.
 * - Clicking a source, or pulling it and letting go, sends its next example event to the center.
 *   A pulled card stretches out on an elastic and springs back.
 * - The center counts every event that reaches it and pulses in the event's color.
 * - A mouse pointer tilts the stage.
 * - A Pause control stops every loop.
 *
 * Motion lives in globals.css. Reduced motion turns it off there, and here it skips the tilt, the
 * spring, and the travelling packet a click would send.
 */
export function FlowStage({
  nodes,
  initialCount,
  label,
}: {
  nodes: readonly FlowNode[];
  initialCount: number;
  /** The picture's text alternative, on the group around the source buttons. */
  label: string;
}) {
  const hintId = useId();
  const [paused, setPaused] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [sent, setSent] = useState<readonly SentPacket[]>([]);
  const [announcement, setAnnouncement] = useState("");
  const hub = useRef<HubHandle>(null);
  // Which of its events each source sends next, and a key per sent packet. Neither renders.
  const nextEvent = useRef(new Map<string, number>());
  const nextKey = useRef(0);
  const stageRef = useRef<HTMLDivElement>(null);
  const tiltRef = useRef<HTMLDivElement>(null);
  const tiltFrame = useRef(0);
  // Dragging writes straight to each card and its line, once per pointer move or spring frame, so
  // it never re-renders React.
  const cards = useRef(new Map<string, HTMLLIElement>());
  const lines = useRef(new Map<string, SVGLineElement>());
  const drag = useRef<Drag | null>(null);
  const springs = useRef(new Map<string, number>());
  // The click a browser fires after a drag ends on the card; the drag already sent the event.
  const swallowClick = useRef(false);

  useEffect(() => {
    const running = springs.current;
    return () => {
      cancelAnimationFrame(tiltFrame.current);
      for (const frame of running.values()) cancelAnimationFrame(frame);
    };
  }, []);

  // Written straight to the element, once per frame, so pointer moves never re-render React.
  function setTilt(x: number, y: number) {
    cancelAnimationFrame(tiltFrame.current);
    tiltFrame.current = requestAnimationFrame(() => {
      tiltRef.current?.style.setProperty("--tilt-x", `${(x * MAX_TILT_DEG).toFixed(2)}deg`);
      tiltRef.current?.style.setProperty("--tilt-y", `${(-y * MAX_TILT_DEG).toFixed(2)}deg`);
    });
  }

  // Pointer capture during a pull keeps moves arriving from outside the frame, so the position is
  // clamped to the frame's edges and the tilt never passes MAX_TILT_DEG.
  function tiltTowardPointer(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse" || paused || window.matchMedia(REDUCED_MOTION_QUERY).matches) return;
    const box = event.currentTarget.getBoundingClientRect();
    const edge = (offset: number, size: number) => Math.max(-1, Math.min(1, (offset / size) * 2 - 1));
    setTilt(edge(event.clientX - box.left, box.width), edge(event.clientY - box.top, box.height));
  }

  function togglePaused() {
    if (!paused) setTilt(0, 0);
    setPaused(!paused);
  }

  function send(node: FlowNode) {
    const index = nextEvent.current.get(node.id) ?? 0;
    const event = node.events[index % node.events.length];
    if (event === undefined) return;
    nextEvent.current.set(node.id, index + 1);
    setAnnouncement(`Sent an example ${node.name} event: ${event.label}.`);
    // Under reduced motion nothing travels, so the event lands at once.
    if (window.matchMedia(REDUCED_MOTION_QUERY).matches) {
      hub.current?.arrive(event.severity);
      return;
    }
    const key = nextKey.current++;
    setSent((current) => [...current, { key, node, event }]);
  }

  function arriveSent(packet: SentPacket) {
    setSent((current) => current.filter((other) => other.key !== packet.key));
    hub.current?.arrive(packet.event.severity);
  }

  // Moves a card, and the end of its line with it, by an offset in stage pixels.
  function place(node: FlowNode, dx: number, dy: number) {
    const card = cards.current.get(node.id);
    card?.style.setProperty("left", `${node.x + dx}px`);
    card?.style.setProperty("top", `${node.y + dy}px`);
    lines.current.get(node.id)?.setAttribute("x1", String(node.x + dx));
    lines.current.get(node.id)?.setAttribute("y1", String(node.y + dy));
  }

  function springHome(node: FlowNode, fromX: number, fromY: number) {
    if (window.matchMedia(REDUCED_MOTION_QUERY).matches) {
      place(node, 0, 0);
      return;
    }
    let x = fromX;
    let y = fromY;
    let vx = 0;
    let vy = 0;
    // The first frame has no previous timestamp, so it steps one 60 Hz frame.
    let last: number | null = null;
    const step = (now: number) => {
      const seconds = last === null ? 1 / 60 : Math.min(0.032, (now - last) / 1000);
      last = now;
      vx += (-SPRING_STIFFNESS * x - SPRING_DAMPING * vx) * seconds;
      vy += (-SPRING_STIFFNESS * y - SPRING_DAMPING * vy) * seconds;
      x += vx * seconds;
      y += vy * seconds;
      if (Math.hypot(x, y) < 0.1 && Math.hypot(vx, vy) < 1) {
        place(node, 0, 0);
        springs.current.delete(node.id);
        return;
      }
      place(node, x, y);
      springs.current.set(node.id, requestAnimationFrame(step));
    };
    springs.current.set(node.id, requestAnimationFrame(step));
  }

  // Touch is left to scroll the page; a tap still clicks.
  function startDrag(node: FlowNode, event: PointerEvent<HTMLButtonElement>) {
    swallowClick.current = false;
    if (event.pointerType === "touch" || event.button !== 0) return;
    cancelAnimationFrame(springs.current.get(node.id) ?? 0);
    springs.current.delete(node.id);
    const stage = stageRef.current;
    if (stage === null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      node,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      // Screen pixels per stage pixel: the stage's drawn width over its layout width.
      scale: stage.getBoundingClientRect().width / stage.offsetWidth,
      dx: 0,
      dy: 0,
      moved: false,
    };
  }

  function moveDrag(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const rawX = (event.clientX - current.startX) / current.scale;
    const rawY = (event.clientY - current.startY) / current.scale;
    if (!current.moved && Math.hypot(rawX, rawY) < DRAG_THRESHOLD) return;
    current.moved = true;
    [current.dx, current.dy] = stretch(rawX, rawY);
    place(current.node, current.dx, current.dy);
  }

  // Letting go of a pulled card sends an event, as a click does. A cancelled drag only springs back.
  function endDrag(event: PointerEvent<HTMLButtonElement>, released: boolean) {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    if (!current.moved) return;
    springHome(current.node, current.dx, current.dy);
    if (!released) return;
    swallowClick.current = true;
    send(current.node);
  }

  function click(node: FlowNode) {
    if (swallowClick.current) {
      swallowClick.current = false;
      return;
    }
    send(node);
  }

  return (
    <div role="group" aria-label={label} className="hidden sm:block">
      <div className="flow-frame" onPointerMove={tiltTowardPointer} onPointerLeave={() => setTilt(0, 0)}>
        <div ref={tiltRef} data-testid="flow-tilt" className="flow-tilt">
          <div ref={stageRef} className="flow-stage" data-paused={paused || undefined} data-active={active ?? undefined}>
            <svg aria-hidden="true" className="absolute inset-0" width="700" height="520" viewBox="0 0 700 520" fill="none">
              <ellipse
                cx={CENTER.x}
                cy={CENTER.y}
                rx={ORBIT.rx}
                ry={ORBIT.ry}
                className="stroke-line-strong"
                strokeDasharray="4 6"
              />
              <ellipse cx={CENTER.x} cy={CENTER.y} rx={INNER_ORBIT.rx} ry={INNER_ORBIT.ry} className="stroke-line" />
              {nodes.map((node) => (
                <line
                  key={node.id}
                  ref={(element) => {
                    if (element) lines.current.set(node.id, element);
                    return () => {
                      lines.current.delete(node.id);
                    };
                  }}
                  data-source={node.id}
                  data-on={active === node.id || undefined}
                  x1={node.x}
                  y1={node.y}
                  x2={CENTER.x}
                  y2={CENTER.y}
                  className="flow-line stroke-accent/25"
                />
              ))}
            </svg>

            <ul aria-label="Sources">
              {nodes.map((node, slot) => (
                <li
                  key={node.id}
                  ref={(element) => {
                    if (element) cards.current.set(node.id, element);
                    return () => {
                      cards.current.delete(node.id);
                    };
                  }}
                  className="absolute"
                  style={{ left: node.x, top: node.y }}
                >
                  <button
                    type="button"
                    data-testid="flow-node"
                    data-source={node.id}
                    data-on={active === node.id || undefined}
                    aria-describedby={hintId}
                    onClick={() => click(node)}
                    onPointerDown={(event) => startDrag(node, event)}
                    onPointerMove={moveDrag}
                    onPointerUp={(event) => endDrag(event, true)}
                    onPointerCancel={(event) => endDrag(event, false)}
                    onPointerEnter={() => setActive(node.id)}
                    onPointerLeave={() => setActive(null)}
                    // A tap focuses the button after its pointerleave, so only a focus the browser
                    // marks (a keyboard one) spotlights; otherwise the spotlight would stick on touch.
                    onFocus={(event) => {
                      if (event.currentTarget.matches(":focus-visible")) setActive(node.id);
                    }}
                    onBlur={() => setActive(null)}
                    className="flow-source flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-xl border border-line-strong bg-panel px-3 py-1.5 text-left"
                    style={{
                      animationDuration: `${DRIFT_SECONDS[slot % DRIFT_SECONDS.length]}s`,
                      animationDelay: `${-slot * 1.3}s`,
                    }}
                  >
                    <FlowSourceMark platform={node.platform} />
                    <span className="block leading-none">
                      <span className="block whitespace-nowrap text-[13px] font-medium">{node.name}</span>{" "}
                      <span className="mt-1 block whitespace-nowrap font-mono text-[10px] text-muted">{node.caption}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>

            <Hub ref={hub} initialCount={initialCount} />

            {/* Moving packets paint under the center circle (z-20 above, z-index in globals.css), so a
                label slides into the hub instead of covering the wordmark. Parked packets paint above
                it. Under reduced motion a line's second packet stacks beside its first (data-stack). */}
            <div aria-hidden="true">
              {nodes.flatMap((node) =>
                node.ambient.map((packet, index) => (
                  <Packet
                    key={`${node.id}-${packet.label}`}
                    node={node}
                    event={packet}
                    delay={packet.delay}
                    stack={index === 0 ? undefined : node.stack}
                    on={active === node.id}
                    onArrive={() => hub.current?.arrive(packet.severity)}
                  />
                )),
              )}
              {sent.map((packet) => (
                <Packet
                  key={packet.key}
                  node={packet.node}
                  event={packet.event}
                  sent
                  on={active === packet.node.id}
                  onArrive={() => arriveSent(packet)}
                />
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="mt-2 flex justify-end motion-reduce:hidden">
        <button
          type="button"
          onClick={togglePaused}
          className="min-h-7 rounded-md border border-line px-2.5 font-mono text-xs text-muted transition-colors hover:border-line-strong hover:text-foreground"
        >
          {paused ? "Resume" : "Pause"}
          <span className="sr-only"> animation</span>
        </button>
      </div>
      <p id={hintId} className="sr-only">
        Sends an example event into the illustrative timeline.
      </p>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
