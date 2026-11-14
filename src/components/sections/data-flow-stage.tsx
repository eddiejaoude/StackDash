"use client";

import { useEffect, useId, useRef, useState, type PointerEvent } from "react";

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

function Packet({
  node,
  event,
  stack,
  delay,
  sent,
  onArrive,
}: {
  node: FlowNode;
  event: FlowEvent;
  stack?: FlowNode["stack"] | undefined;
  delay?: number;
  sent?: boolean;
  onArrive?: () => void;
}) {
  return (
    <div
      data-testid="flow-packet"
      data-source={node.id}
      data-sent={sent || undefined}
      data-label-side={node.labelSide}
      data-axis={node.axis}
      data-stack={stack}
      className={`flow-packet flex items-center gap-2 ${sent ? "flow-packet-sent" : ""}`}
      style={{
        offsetPath: `path('M ${node.x} ${node.y} L ${CENTER.x} ${CENTER.y}')`,
        animationDelay: delay === undefined ? undefined : `${delay}s`,
        "--park": node.park,
      }}
      onAnimationEnd={onArrive}
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

/**
 * The interactive constellation, from the sm breakpoint up.
 *
 * - Hovering or focusing a source spotlights it.
 * - Hovering the picture holds the looping packets still.
 * - Clicking a source sends its next example event to the center.
 * - A mouse pointer tilts the stage.
 * - A Pause control stops every loop.
 *
 * Motion lives in globals.css. Reduced motion turns it off there, and here it skips the tilt and
 * the travelling packet a click would send.
 */
export function FlowStage({ nodes, initialCount }: { nodes: readonly FlowNode[]; initialCount: number }) {
  const hintId = useId();
  const [paused, setPaused] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const [sent, setSent] = useState<readonly SentPacket[]>([]);
  const [count, setCount] = useState(initialCount);
  const [announcement, setAnnouncement] = useState("");
  // Which of its events each source sends next, and a key per sent packet. Neither renders.
  const nextEvent = useRef(new Map<string, number>());
  const nextKey = useRef(0);
  const tiltRef = useRef<HTMLDivElement>(null);
  const tiltFrame = useRef(0);

  useEffect(() => () => cancelAnimationFrame(tiltFrame.current), []);

  // Written straight to the element, once per frame, so pointer moves never re-render React.
  function setTilt(x: number, y: number) {
    cancelAnimationFrame(tiltFrame.current);
    tiltFrame.current = requestAnimationFrame(() => {
      tiltRef.current?.style.setProperty("--tilt-x", `${(x * MAX_TILT_DEG).toFixed(2)}deg`);
      tiltRef.current?.style.setProperty("--tilt-y", `${(-y * MAX_TILT_DEG).toFixed(2)}deg`);
    });
  }

  function tiltTowardPointer(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse" || paused || window.matchMedia(REDUCED_MOTION_QUERY).matches) return;
    const box = event.currentTarget.getBoundingClientRect();
    setTilt(((event.clientX - box.left) / box.width) * 2 - 1, ((event.clientY - box.top) / box.height) * 2 - 1);
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
      setCount((current) => current + 1);
      return;
    }
    const key = nextKey.current++;
    setSent((current) => [...current, { key, node, event }]);
  }

  function arrive(key: number) {
    setSent((current) => current.filter((packet) => packet.key !== key));
    setCount((current) => current + 1);
  }

  return (
    <div className="hidden sm:block">
      <div className="flow-frame" onPointerMove={tiltTowardPointer} onPointerLeave={() => setTilt(0, 0)}>
        <div ref={tiltRef} className="flow-tilt">
          <div className="flow-stage" data-paused={paused || undefined} data-active={active ?? undefined}>
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
                <li key={node.id} className="absolute" style={{ left: node.x, top: node.y }}>
                  <button
                    type="button"
                    data-testid="flow-node"
                    data-source={node.id}
                    data-on={active === node.id || undefined}
                    aria-describedby={hintId}
                    onClick={() => send(node)}
                    onPointerEnter={() => setActive(node.id)}
                    onPointerLeave={() => setActive(null)}
                    onFocus={() => setActive(node.id)}
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

            <div
              aria-hidden="true"
              className="flow-core absolute z-20 flex size-[150px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-line-strong bg-panel"
              style={{ left: CENTER.x, top: CENTER.y }}
            >
              <FlowCore count={count} />
            </div>

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
                  />
                )),
              )}
              {sent.map((packet) => (
                <Packet key={packet.key} node={packet.node} event={packet.event} sent onArrive={() => arrive(packet.key)} />
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
