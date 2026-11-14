import { PlatformLogo } from "@/components/icons";
import { Wordmark } from "@/components/wordmark";
import { liveProviderIds, type LiveProviderId } from "@/lib/adapters/types";
import { PROVIDER_NAMES, providerPlatform } from "@/lib/providers";
import { site } from "@/lib/site";

type PacketSeverity = "success" | "warning" | "danger" | "summary";

interface Packet {
  label: string;
  severity: PacketSeverity;
  /** Seconds after load that the packet first leaves its node. */
  delay: number;
}

interface SourceDetail {
  caption: string;
  packets: readonly Packet[];
}

// Illustrative only. One entry per live adapter: a new provider in liveProviderIds fails the type
// check here until it has a caption, and then joins the constellation and the text alternative on
// its own. Packet wording is the hero feed's (feedEvents in live-event-feed.tsx), shortened, so the
// hero tells one story. Resend mirrors Vercel across the orbit and their labels point at each
// other, so their delays sit a second apart.
const sourceDetails: Record<LiveProviderId, SourceDetail> = {
  vercel: {
    caption: "Deploys · spend",
    packets: [
      { label: "Deploy ready · acme-web", severity: "success", delay: 0.6 },
      { label: "Preview failed · acme-docs", severity: "danger", delay: 2.6 },
    ],
  },
  github: {
    caption: "Billing · repos",
    packets: [
      { label: "PR #128 merged", severity: "success", delay: 0 },
      { label: "acme/cli hit 1,000 ★", severity: "success", delay: 2 },
    ],
  },
  resend: {
    caption: "Emails · quota",
    packets: [
      { label: "Emails at 75% of quota", severity: "warning", delay: 1.6 },
      { label: "Allowance reset", severity: "summary", delay: 3.6 },
    ],
  },
  stripe: {
    caption: "Payments · fees",
    packets: [
      { label: "$49.00 paid · Pro", severity: "success", delay: 1.2 },
      { label: "Renewal failed", severity: "danger", delay: 3.2 },
    ],
  },
  supabase: {
    caption: "Usage · signups",
    packets: [
      { label: "New signup · acme-app", severity: "success", delay: 0.3 },
      { label: "312 logins yesterday", severity: "summary", delay: 2.3 },
    ],
  },
  digitalocean: { caption: "Deploys · usage", packets: [] },
  posthog: { caption: "Signups · spend", packets: [] },
  polar: { caption: "Orders · fees", packets: [] },
  sentry: { caption: "Errors · releases", packets: [] },
  railway: { caption: "Deploys · usage", packets: [] },
  gitlab: { caption: "Pipelines · minutes", packets: [] },
};

const severityDot: Record<PacketSeverity, string> = {
  success: "bg-success text-success",
  warning: "bg-warning text-warning",
  danger: "bg-danger text-danger",
  summary: "bg-muted text-muted",
};

// The stage is drawn at 700 by 520 and scaled to its container (.flow-stage in globals.css).
// offset-path coordinates are stage pixels, so every position below is too.
const CENTER = { x: 350, y: 260 } as const;
const ORBIT = { rx: 270, ry: 200 } as const;
const INNER_ORBIT = { rx: 150, ry: 110 } as const;

// Rough stage-pixel extents for the parked-packet clearance below: the widest card is about 136
// by 42, a label is 22 tall, and the dot's glow reaches about 8 px from its center.
// e2e/data-flow.spec.ts measures the real boxes and fails if a parked packet touches a card.
const CARD_HALF = { x: 68, y: 21 } as const;
const DOT_REACH = 8;
const LABEL_HALF_HEIGHT = 11;
// On a mostly vertical line the next cards round the orbit sit about a card height lower than the
// node, so its labels are clear of their row once the dot is this far below the node.
const NEIGHBOR_ROW_CLEARANCE = 64;

/**
 * How far along its line a packet parks under reduced motion: the first point where it is clear of
 * its own card. A mostly horizontal line clears it sideways (the dot past the card's edge) or
 * vertically (the label below or above the card), whichever comes first; a mostly vertical line
 * goes on until its labels are below the neighboring cards' row.
 */
function parkDistance(dx: number, dy: number, mostlyVertical: boolean): string {
  const length = Math.hypot(dx, dy);
  const along = (offset: number, component: number) => offset / (Math.abs(component) / length);
  const clearance = mostlyVertical
    ? along(NEIGHBOR_ROW_CLEARANCE, dy)
    : Math.min(along(CARD_HALF.x + DOT_REACH, dx), along(CARD_HALF.y + LABEL_HALF_HEIGHT, dy));
  return `${Math.ceil((clearance / length) * 100)}%`;
}

// The sources with packets, clockwise from the top. They are spread evenly around the orbit and
// every other source fills the slots between them, in liveProviderIds order, so the moving labels
// never bunch on one side.
const FEATURED: readonly LiveProviderId[] = ["github", "vercel", "stripe", "supabase", "resend"];

function orbitOrder(): LiveProviderId[] {
  const featuredSlots = new Map(
    FEATURED.map((id, index) => [Math.round((index * liveProviderIds.length) / FEATURED.length), id]),
  );
  const rest = liveProviderIds.filter((id) => !FEATURED.includes(id));
  const order: LiveProviderId[] = [];
  for (let slot = 0; slot < liveProviderIds.length; slot++) {
    const id = featuredSlots.get(slot) ?? rest.shift();
    if (id === undefined) throw new Error(`No provider for orbit slot ${slot}`);
    order.push(id);
  }
  return order;
}

interface SourceNode extends SourceDetail {
  id: LiveProviderId;
  name: string;
  x: number;
  y: number;
  /**
   * Which side of the dot a packet's label sits on: the side facing the center. A line straight
   * down from the top has no such side and takes the right; its labels only appear once they are
   * below the neighboring cards' row (the fade-in in globals.css).
   */
  labelSide: "left" | "right";
  /** Where this line's packets park under reduced motion (parkDistance), as an offset-distance. */
  park: string;
  /**
   * Under reduced motion a line's second packet parks beside its first, one label higher or lower.
   * A mostly vertical line stacks toward the center, along itself. A mostly horizontal line stacks
   * up, nudged toward the center, so its dot clears its own card: stacking down would put the
   * bottom lines' dots on their cards.
   */
  axis: "vertical" | "horizontal";
  stack: "up" | "down";
}

// Evenly spaced around the orbit, clockwise from the top.
const nodes: readonly SourceNode[] = orbitOrder().map((id, slot) => {
  const angle = (slot / liveProviderIds.length) * 2 * Math.PI;
  const x = Math.round(CENTER.x + ORBIT.rx * Math.sin(angle));
  const y = Math.round(CENTER.y - ORBIT.ry * Math.cos(angle));
  const towardCenterIsDown = y < CENTER.y;
  const mostlyVertical = Math.abs(CENTER.x - x) < Math.abs(CENTER.y - y);
  return {
    id,
    name: PROVIDER_NAMES[id],
    x,
    y,
    labelSide: x > CENTER.x ? "left" : "right",
    park: parkDistance(CENTER.x - x, CENTER.y - y, mostlyVertical),
    axis: mostlyVertical ? "vertical" : "horizontal",
    stack: mostlyVertical && towardCenterIsDown ? "down" : "up",
    ...sourceDetails[id],
  };
});

const sourceNames = new Intl.ListFormat("en-US", { type: "conjunction" }).format(nodes.map((node) => node.name));

// Matches the hero feed's opening counter: EVENTS_TODAY_BEFORE_FEED plus INITIAL_SEQ in
// live-event-feed.tsx. A client module's constants are not values in a server component, so it is
// restated here.
const ILLUSTRATIVE_EVENT_COUNT = "1,287";

function ProviderMark({ id }: { id: LiveProviderId }) {
  const platform = providerPlatform(id);
  return platform === null ? null : <PlatformLogo platform={platform} width={14} height={14} className="shrink-0" />;
}

function Core() {
  return (
    <div className="flex flex-col items-center gap-1.5 text-center">
      <Wordmark loading="lazy" />
      <p className="font-mono text-xs text-foreground">{ILLUSTRATIVE_EVENT_COUNT} events</p>
      <p className="font-mono text-[10px] text-muted">Illustrative</p>
    </div>
  );
}

function Stage() {
  return (
    <div className="flow-stage">
      <svg
        className="absolute inset-0"
        width="700"
        height="520"
        viewBox="0 0 700 520"
        fill="none"
      >
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
            x1={node.x}
            y1={node.y}
            x2={CENTER.x}
            y2={CENTER.y}
            className="stroke-accent/25"
          />
        ))}
      </svg>

      {nodes.map((node) => (
        <div
          data-testid="flow-node"
          key={node.id}
          className="absolute flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-xl border border-line-strong bg-panel px-3 py-1.5"
          style={{ left: node.x, top: node.y }}
        >
          <ProviderMark id={node.id} />
          <div className="leading-none">
            <p className="whitespace-nowrap text-[13px] font-medium">{node.name}</p>
            <p className="mt-1 whitespace-nowrap font-mono text-[10px] text-muted">{node.caption}</p>
          </div>
        </div>
      ))}

      <div
        className="flow-core absolute z-20 flex size-[150px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-line-strong bg-panel"
        style={{ left: CENTER.x, top: CENTER.y }}
      >
        <Core />
      </div>

      {/* Moving packets paint under the center circle (z-20 above, z-index in globals.css), so a
          label slides into the hub instead of covering the wordmark. Parked packets paint above it.
          Under reduced motion a line's second packet stacks beside its first (data-stack). */}
      {nodes.flatMap((node) =>
        node.packets.map((packet, index) => (
          <div
            key={`${node.id}-${packet.label}`}
            data-testid="flow-packet"
            className="flow-packet flex items-center gap-2"
            data-label-side={node.labelSide}
            data-axis={node.axis}
            data-stack={index === 0 ? undefined : node.stack}
            style={{
              offsetPath: `path('M ${node.x} ${node.y} L ${CENTER.x} ${CENTER.y}')`,
              animationDelay: `${packet.delay}s`,
              "--park": node.park,
            }}
          >
            <span className={`flow-packet-dot size-2 shrink-0 rounded-full ${severityDot[packet.severity]}`} />
            <span
              data-testid="flow-label"
              className="whitespace-nowrap rounded-full border border-line-strong bg-background/80 px-2 py-0.5 font-mono text-[10px] leading-4 text-foreground backdrop-blur-sm"
            >
              {packet.label}
            </span>
          </div>
        )),
      )}
    </div>
  );
}

// Below sm the scaled stage would shrink its labels past reading, so phones get the same story
// without motion: every source, an arrow, and the timeline they land on.
function CompactFlow() {
  return (
    <div className="flex flex-col items-center gap-4">
      <ul className="grid w-full grid-cols-2 gap-2">
        {nodes.map((node) => (
          <li key={node.id} className="flex items-center gap-2 rounded-xl border border-line-strong bg-panel px-3 py-2">
            <ProviderMark id={node.id} />
            <div className="min-w-0 leading-none">
              <p className="text-[13px] font-medium">{node.name}</p>
              <p className="mt-1 font-mono text-[10px] leading-4 text-muted">{node.caption}</p>
            </div>
          </li>
        ))}
      </ul>
      <svg width="16" height="32" viewBox="0 0 16 32" fill="none" className="stroke-accent">
        <path d="M8 0v30M2 24l6 6 6-6" strokeWidth="1.5" />
      </svg>
      <div className="flow-core flex size-[150px] items-center justify-center rounded-full border border-line-strong bg-panel">
        <Core />
      </div>
    </div>
  );
}

/** Every live source feeding one timeline: an illustrative constellation beside the hero heading. */
export function DataFlow() {
  return (
    <div role="img" aria-label={`Events from ${sourceNames} flow into one ${site.name} timeline.`}>
      <div aria-hidden="true">
        <div className="sm:hidden">
          <CompactFlow />
        </div>
        <div className="flow-frame hidden sm:block">
          <Stage />
        </div>
      </div>
    </div>
  );
}
