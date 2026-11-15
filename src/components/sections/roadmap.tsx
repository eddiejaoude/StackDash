import { Section } from "@/components/section";

interface Phase {
  name: string;
  summary: string;
  items: readonly string[];
}

const phases: readonly Phase[] = [
  {
    name: "First release",
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
  {
    name: "Straight after",
    summary: "Connect more of your stack, run it yourself, and share it with a team.",
    items: [
      "More integrations, starting with ElevenLabs",
      "Open source release with self-hosting",
      "Team workspaces with owner, admin, and viewer roles",
      "Hide the event types you do not care about",
    ],
  },
  {
    name: "Later",
    summary: "Ideas we will build only if users ask for them.",
    items: ["Cost optimization suggestions", "Many more integrations"],
  },
];

export function Roadmap() {
  return (
    <Section
      id="roadmap"
      eyebrow="Roadmap"
      title="Small first release, clear next steps"
      intro="The first release covers the timeline, alerts, flags for unusual spend and usage, spend and quota projections, a read-only API and MCP server, and badges, cards, and a public page for the stats you choose. More integrations and self-hosting follow."
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
    </Section>
  );
}
