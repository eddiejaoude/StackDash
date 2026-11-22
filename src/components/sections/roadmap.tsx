import Link from "next/link";

import { Section } from "@/components/section";
import { getDoc } from "@/lib/docs";

interface Phase {
  name: string;
  summary: string;
  items: readonly string[];
}

const phases: readonly Phase[] = [
  {
    name: "Available now",
    summary:
      "One timeline and one alert across your stack, with stats you choose to share and an API and MCP server to read it all.",
    items: [
      "Provider connections through OAuth, no pasted keys",
      "Timeline of deploys, stars, signups, logins, payments, and errors",
      "Alerts by email, Slack, Discord, and webhook",
      "Daily and weekly digests on the same channels",
      "Percentage and dollar thresholds",
      "Unusual daily spend and usage flagged with no setup, and a mute per metric",
      "Publish chosen metrics, one at a time",
      "Opt-in public project pages",
      "README badges and shareable milestone cards",
      "A card of your year so far",
      "Read-only REST API with scoped keys",
      "Read-only MCP server for AI assistants, on the same keys",
      "Allowances, remaining quota, and reset dates",
      "Spend where the provider reports it",
      "Spend and quota projected to the end of the period, labeled as estimates",
      "Usage history",
      "Deploys, payments, signups, stars, and alerts marked on the trend charts",
      "Revenue against spend, signups, cost per signup, and deploys for the week or month so far",
    ],
  },
  // The last two phases sum up docs/roadmap.md at theme level, so one issue closing does not make
  // them wrong: "Coming next" is its Now, Next, and Later sections, "Further out" its Further out
  // section. Never list a blocked item as coming next. CONTRIBUTING.md says when to update both.
  {
    name: "Coming next",
    summary: "What is being built now and what follows it.",
    items: [
      "More providers pushing events within a minute",
      "A hosted version, with open sign-up and a public demo",
      "A shorter path from sign-in to a useful timeline",
    ],
  },
  {
    name: "Further out",
    summary: "Planned after that, as priorities allow.",
    items: [
      "More integrations",
      "Invite teammates, change their roles, and switch between workspaces",
      "A leaderboard of verified stats and a public project directory",
      "Saved timeline views and hidden event types",
    ],
  },
];

function roadmapDocHref(): string {
  const doc = getDoc(["roadmap"]);
  if (!doc) throw new Error("docs/roadmap.md is missing: the roadmap section links to it");
  return doc.href;
}

export function Roadmap() {
  return (
    <Section
      id="roadmap"
      eyebrow="Roadmap"
      title="What works today, and what comes next"
      intro="Today you can host it yourself and get the timeline, alerts, flags for unusual spend and usage, spend and quota projections, a read-only API and MCP server, and badges, cards, and a public page for the stats you choose. The full roadmap says what is being built now and what comes next."
    >
      <ol className="grid gap-6 md:grid-cols-3">
        {phases.map((phase, index) => (
          <li key={phase.name} className="rounded-xl border border-line bg-panel p-6">
            <span className="font-mono text-xs text-muted">Phase {index + 1}</span>
            <h3 className="mt-2 text-lg font-medium">{phase.name}</h3>
            <p className="mt-2 text-sm leading-6 text-muted">{phase.summary}</p>
            <ul className="mt-5 space-y-2.5">
              {phase.items.map((item) => (
                <li key={item} className="flex items-start gap-3 text-sm">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-accent" aria-hidden="true" />
                  {item}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      <p className="mt-8 text-sm">
        <Link
          href={roadmapDocHref()}
          className="inline-flex min-h-6 items-center underline decoration-line-strong underline-offset-4 transition-colors hover:text-accent"
        >
          Read the full roadmap
        </Link>
      </p>
    </Section>
  );
}
