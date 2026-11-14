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
// check here until it has a caption, and then joins the constellation, the heading count, and the
// text alternative on its own. Packet wording is the hero feed's (feedEvents in
// live-event-feed.tsx), shortened, so the hero tells one story.
const sourceDetails: Record<LiveProviderId, SourceDetail> = {
  vercel: {
    caption: "deploys · spend",
    packets: [
      { label: "deploy ready · acme-web", severity: "success", delay: 0.6 },
      { label: "preview failed · acme-docs", severity: "danger", delay: 2.6 },
    ],
  },
  github: {
    caption: "billing · repos",
    packets: [
      { label: "PR #128 merged", severity: "success", delay: 0 },
      { label: "acme/cli hit 1,000 ★", severity: "success", delay: 2 },
    ],
  },
  resend: {
    caption: "emails · quota",
    packets: [
      { label: "emails at 75% of quota", severity: "warning", delay: 0.9 },
      { label: "allowance reset", severity: "summary", delay: 2.9 },
    ],
  },
  stripe: {
    caption: "payments · fees",
    packets: [
      { label: "$49.00 paid · Pro", severity: "success", delay: 1.2 },
      { label: "renewal failed", severity: "danger", delay: 3.2 },
    ],
  },
  supabase: {
    caption: "usage · signups",
    packets: [
      { label: "new signup · acme-app", severity: "success", delay: 0.3 },
      { label: "312 logins yesterday", severity: "summary", delay: 2.3 },
    ],
  },
  digitalocean: { caption: "deploys · usage", packets: [] },
  posthog: { caption: "signups · spend", packets: [] },
  polar: { caption: "orders · fees", packets: [] },
  sentry: { caption: "errors · releases", packets: [] },
  railway: { caption: "deploys · usage", packets: [] },
  gitlab: { caption: "pipelines · minutes", packets: [] },
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
  /** Which side of the dot a packet's label sits on: always toward the center, clear of its own node. */
  labelSide: "left" | "right";
}

// Evenly spaced around the orbit, clockwise from the top.
const nodes: readonly SourceNode[] = orbitOrder().map((id, slot) => {
  const angle = (slot / liveProviderIds.length) * 2 * Math.PI;
  const x = Math.round(CENTER.x + ORBIT.rx * Math.sin(angle));
  return {
    id,
    name: PROVIDER_NAMES[id],
    x,
    y: Math.round(CENTER.y - ORBIT.ry * Math.cos(angle)),
    labelSide: x > CENTER.x ? "left" : "right",
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
      <p className="font-mono text-[10px] text-muted">illustrative</p>
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
        className="flow-core absolute flex size-[150px] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-line-strong bg-panel"
        style={{ left: CENTER.x, top: CENTER.y }}
      >
        <Core />
      </div>

      {/* Packets draw last so a label passing a node or the center circle stays readable. Under
          reduced motion a line's two packets park apart (data-park) so they don't stack. */}
      {nodes.flatMap((node) =>
        node.packets.map((packet, index) => (
          <div
            key={`${node.id}-${packet.label}`}
            className="flow-packet flex items-center gap-2"
            data-label-side={node.labelSide}
            data-park={index === 0 ? "near" : "far"}
            style={{
              offsetPath: `path('M ${node.x} ${node.y} L ${CENTER.x} ${CENTER.y}')`,
              animationDelay: `${packet.delay}s`,
            }}
          >
            <span className={`flow-packet-dot size-2 shrink-0 rounded-full ${severityDot[packet.severity]}`} />
            <span className="whitespace-nowrap rounded-full border border-line-strong bg-background/80 px-2 py-0.5 font-mono text-[10px] leading-4 text-foreground backdrop-blur-sm">
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
