import { GaugeIcon, PlugIcon, RadarIcon } from "@/components/icons";
import { IconTile, type IconCardItem } from "@/components/icon-card";
import { Section } from "@/components/section";
import { site } from "@/lib/site";

const steps: readonly IconCardItem[] = [
  {
    icon: PlugIcon,
    title: "Connect",
    body: "Pick a provider, click Connect, and approve read-only access on the provider's own screen. Choose the organizations, teams, and projects that matter. No API keys to copy for most providers, and no code changes in your apps.",
  },
  {
    icon: RadarIcon,
    title: "Collect",
    body: `${site.name} reads usage, costs, and events through official APIs, signed webhooks, and scheduled syncs, and keeps daily snapshots so you have history, not just today's number.`,
  },
  {
    icon: GaugeIcon,
    title: "Know",
    body: "One dashboard for spend and allowances, one timeline for activity, and alerts when a threshold is crossed: once per billing period, not every hour.",
  },
];

export function HowItWorks() {
  return (
    <Section
      id="how-it-works"
      eyebrow="How it works"
      title="Connect once, stop checking ten dashboards"
      intro="Connecting a service takes a few clicks. Once an integration exists, you never write code to use it."
    >
      <ol className="grid gap-6 md:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.title} className="rounded-xl border border-line bg-panel p-6">
            <div className="flex items-center justify-between">
              <IconTile icon={step.icon} />
              <span className="font-mono text-xs text-muted">0{index + 1}</span>
            </div>
            <h3 className="mt-5 text-lg font-medium">{step.title}</h3>
            <p className="mt-2 text-sm leading-6 text-muted">{step.body}</p>
          </li>
        ))}
      </ol>
    </Section>
  );
}
