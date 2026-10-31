import { CloudIcon, PuzzleIcon, ServerIcon } from "@/components/icons";
import { IconCard, type IconCardItem } from "@/components/icon-card";
import { Section } from "@/components/section";

const pillars: readonly IconCardItem[] = [
  {
    icon: ServerIcon,
    title: "Self-host it",
    body: "Run the whole thing yourself with Docker Compose. The self-hosted edition is the real product: integrations are not held back for paying customers.",
  },
  {
    icon: PuzzleIcon,
    title: "Write an integration",
    body: "Integrations are modular adapters with a documented interface, typed schemas, tests, and a template. Missing a provider you rely on? Add it, and everyone gets it.",
  },
  {
    icon: CloudIcon,
    title: "Or let us host it",
    body: "A managed version is planned for people who would rather not run infrastructure: OAuth apps, webhooks, sync jobs, updates, and backups handled for you.",
  },
];

export function OpenSource() {
  return (
    <Section
      id="open-source"
      eyebrow="Open source"
      title="Open source first, hosted if you want it"
      intro="The code, the roadmap, and the decisions happen in public on GitHub. The license will be chosen before the code is made public."
    >
      <ul className="grid gap-6 md:grid-cols-3">
        {pillars.map((pillar) => (
          <IconCard key={pillar.title} {...pillar} />
        ))}
      </ul>
    </Section>
  );
}
