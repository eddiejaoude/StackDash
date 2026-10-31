import { BanIcon, EyeIcon, LockIcon, ShieldIcon } from "@/components/icons";
import { IconCard, type IconCardItem } from "@/components/icon-card";
import { Section } from "@/components/section";
import { site } from "@/lib/site";

const principles: readonly IconCardItem[] = [
  {
    icon: ShieldIcon,
    title: "Read-only wherever the provider allows it",
    body: "OAuth first, with the narrowest read-only scopes the provider offers, so most connections need no API key at all. Where a provider has no OAuth route, a restricted read-only key is the fallback. Write permissions are never requested for a dashboard that only reads.",
  },
  {
    icon: EyeIcon,
    title: "Permissions shown before you connect",
    body: `Every integration is labeled Read-only, Restricted API key, or Elevated access required. If a provider only shares usage data with broader access, as Resend's OAuth does, ${site.name} tells you before you connect and never calls it read-only.`,
  },
  {
    icon: LockIcon,
    title: "Credentials stay on the server",
    body: "Tokens are encrypted at rest, never sent to the browser, never written to logs, and isolated per workspace. Disconnect any service whenever you like.",
  },
  {
    icon: BanIcon,
    title: "No scraping, no passwords",
    body: `Only official APIs, authorized integrations, and signed webhooks. Where no official route exists, ${site.name} says so instead of guessing.`,
  },
];

export function Security() {
  return (
    <Section
      id="security"
      eyebrow="Security"
      title="Least privilege is the product, not a setting"
      intro={`${site.name} connects to accounts that run your business, so trust comes first. These rules apply to every integration, including the ones the community writes.`}
    >
      <ul className="grid gap-6 md:grid-cols-2">
        {principles.map((principle) => (
          <IconCard key={principle.title} {...principle} />
        ))}
      </ul>
    </Section>
  );
}
