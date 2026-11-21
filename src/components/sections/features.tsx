import { BellIcon, EyeIcon, GaugeIcon, MailIcon, PuzzleIcon, TimelineIcon } from "@/components/icons";
import { IconCard, type IconCardItem } from "@/components/icon-card";
import { Section } from "@/components/section";
import { SeverityBadge, type Severity } from "@/components/severity-badge";

// What works on every plan first, spend last (#305): the same order as the hero.
const features: readonly IconCardItem[] = [
  {
    icon: TimelineIcon,
    title: "One activity timeline",
    body: "Deploys, stars, signups, logins, payments, and errors from every connected account in one feed, across several organizations, teams, and projects. Filter by provider, project, account, or severity.",
  },
  {
    icon: BellIcon,
    title: "Alerts where you read them",
    body: "Email, Slack, Discord, or a signed webhook. A threshold fires once per billing period, and unusual daily spend or usage is flagged with no setup.",
  },
  {
    icon: MailIcon,
    title: "Daily and weekly digests",
    body: "What changed across your stack, on the same channels as your alerts, with each number marked as verified or estimated.",
  },
  {
    icon: EyeIcon,
    title: "Stats you can share",
    body: "Publish one metric at a time as a README badge, a card image, or a public project page. Every value is labeled verified or self-reported.",
  },
  {
    icon: PuzzleIcon,
    title: "A read-only API and MCP server",
    body: "Read events, usage, alerts, and connections from your own scripts with scoped keys, or ask an AI assistant such as Claude Code or Cursor through the MCP server on the same keys.",
  },
  {
    icon: GaugeIcon,
    title: "Allowances and spend",
    body: "What is left of each included allowance, when it resets, and where it is heading by the end of the period. Spend per provider and project where the provider's plan reports it.",
  },
];

interface TimelineEvent {
  time: string;
  severity: Severity;
  text: string;
}

// Illustrative events only, labeled as such in the UI.
const timeline: readonly TimelineEvent[] = [
  { time: "09:12", severity: "Success", text: "Production deployment of acme-web is ready" },
  { time: "09:00", severity: "Summary", text: "Daily summary for yesterday: 4 providers, each figure marked verified or estimated" },
  { time: "08:42", severity: "Failed", text: "Vercel deployment failed for acme-web in production" },
  { time: "08:10", severity: "Alert", text: "Resend passed 75% of its monthly emails, sent to Slack and email" },
  { time: "07:55", severity: "Success", text: "Pull request #42 merged in acme/api" },
  { time: "07:31", severity: "Success", text: "Supabase: 12 new signups on acme-app since midnight" },
];

interface CostLabel {
  term: string;
  definition: string;
}

const costLabels: readonly CostLabel[] = [
  { term: "Verified cost", definition: "Reported by the provider's own billing API." },
  { term: "Estimated cost", definition: "Calculated from usage and published pricing." },
  { term: "Included allowance", definition: "What your plan includes, such as minutes, emails, or credits." },
  { term: "Remaining allowance", definition: "The part of that allowance not used yet." },
  { term: "Budget", definition: "A limit you set yourself, for alerts only." },
  { term: "Credit balance", definition: "Prepaid or promotional credit left on the account." },
];

export function Features() {
  return (
    <Section
      id="features"
      eyebrow="Features"
      title="One timeline, one alert, and stats you can share"
      intro="What happened across your stack, who hears about it, and what you can show come first. Allowances and spend sit beside them, where each provider reports them."
    >
      <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {features.map((feature) => (
          <IconCard key={feature.title} {...feature} />
        ))}
      </ul>

      <div className="mt-16 grid gap-10 lg:grid-cols-2">
        <figure className="self-start rounded-xl border border-line bg-panel">
          <div className="border-b border-line px-5 py-3.5">
            <p className="text-sm font-medium">Timeline · today</p>
          </div>
          <ol className="divide-y divide-line px-5">
            {timeline.map((event) => (
              <li key={event.time} className="flex items-start gap-4 py-3.5">
                <span className="w-11 shrink-0 font-mono text-xs leading-5 text-muted">{event.time}</span>
                <span className="flex-1 text-sm leading-5">{event.text}</span>
                <SeverityBadge severity={event.severity} />
              </li>
            ))}
          </ol>
          <figcaption className="border-t border-line px-5 py-3 text-xs text-muted">Example data.</figcaption>
        </figure>

        <div>
          <h3 className="text-xl font-semibold tracking-tight">Every number says where it came from</h3>
          <p className="mt-3 text-sm leading-6 text-muted">
            Providers expose different things. Some report billed cost, some only usage, some neither.
            An estimate is never shown as a bill, and different kinds of numbers are never added
            together without a label.
          </p>
          <dl className="mt-6 divide-y divide-line rounded-xl border border-line bg-panel">
            {costLabels.map((label) => (
              <div key={label.term} className="grid gap-1 px-5 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
                <dt className="font-mono text-xs text-foreground">{label.term}</dt>
                <dd className="text-sm text-muted">{label.definition}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Section>
  );
}
