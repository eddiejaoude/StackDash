import { BellIcon, GaugeIcon, LayersIcon, MailIcon, ReportIcon, TimelineIcon } from "@/components/icons";
import { IconCard, type IconCardItem } from "@/components/icon-card";
import { Section } from "@/components/section";
import { SeverityBadge, type Severity } from "@/components/severity-badge";

const features: readonly IconCardItem[] = [
  {
    icon: ReportIcon,
    title: "Spending per provider and project",
    body: "Total spend this month, broken down by service and by project, with trends over days, weeks, and months.",
  },
  {
    icon: GaugeIcon,
    title: "Allowances, quotas, and reset dates",
    body: "How much of each included allowance you have used, what is left, and when it resets.",
  },
  {
    icon: BellIcon,
    title: "Thresholds that fire once",
    body: "Alert at 50, 75, 90, or 100 percent, or at a dollar amount you choose. Each alert fires once per billing period and follows the provider's reset date.",
  },
  {
    icon: MailIcon,
    title: "Daily summaries",
    body: "Yesterday's usage across every connected service, with each line marked as verified or estimated.",
  },
  {
    icon: TimelineIcon,
    title: "One activity timeline",
    body: "Signups, logins, payments, deployments, and GitHub stars next to usage events. Filter by provider, project, account, or severity.",
  },
  {
    icon: LayersIcon,
    title: "Many accounts, many projects",
    body: "Several GitHub organizations, Vercel teams, or Supabase projects side by side, grouped the way you run your projects.",
  },
];

interface TimelineEvent {
  time: string;
  severity: Severity;
  text: string;
}

// Illustrative events only, labeled as such in the UI.
const timeline: readonly TimelineEvent[] = [
  { time: "09:00", severity: "Summary", text: "Yesterday: $7.15 across 4 providers, $0.65 of it estimated" },
  { time: "08:42", severity: "Failed", text: "Vercel deployment failed for acme-web in production" },
  { time: "08:10", severity: "Alert", text: "Resend reached 75% of its monthly email allowance" },
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
      title="Usage, spending, and activity in one place"
      intro="The first release focuses on the questions you ask every week: what did this cost, what is left, and what changed."
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
                <dt className="font-mono text-xs uppercase tracking-wide text-foreground">{label.term}</dt>
                <dd className="text-sm text-muted">{label.definition}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </Section>
  );
}
