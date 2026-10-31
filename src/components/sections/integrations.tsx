import { Section } from "@/components/section";
import { site } from "@/lib/site";

interface IntegrationGroup {
  stage: string;
  dotClass: string;
  note: string;
  providers: readonly string[];
}

// Order from the OAuth research on issue #11. The first group connects through OAuth. The next
// group does too, except ElevenLabs, which returns with a restricted API key (#49). The last group
// waits because its usage data needs an admin key or partner approval, and says which.
const groups: readonly IntegrationGroup[] = [
  {
    stage: "First",
    dotClass: "bg-success",
    note: "In the first release",
    providers: ["Vercel", "GitHub and GitHub Actions", "Resend", "Stripe", "Supabase"],
  },
  {
    stage: "Next",
    dotClass: "bg-warning",
    note: "Planned straight after",
    providers: ["GitLab", "Railway", "Polar", "PostHog", "DigitalOcean", "Sentry", "ElevenLabs"],
  },
  {
    stage: "Waiting",
    dotClass: "bg-muted",
    note: "Usage needs an admin key or partner approval",
    providers: ["OpenAI API: admin keys only", "Anthropic API: admin keys only", "PayPal: approved partners only"],
  },
];

export function Integrations() {
  return (
    <Section
      id="integrations"
      eyebrow="Integrations"
      title="A few reliable integrations beat a long list of shaky ones"
      intro="Integrations connect with OAuth wherever the provider offers it, and each one documents exactly what it reads, which permissions it needs, how often it syncs, and what the provider does not expose. The order follows what each official API allows."
    >
      <div className="grid gap-6 md:grid-cols-3">
        {groups.map((group) => (
          <section
            key={group.stage}
            aria-labelledby={`integrations-${group.stage.toLowerCase()}`}
            className="rounded-xl border border-line bg-panel p-6"
          >
            <h3 id={`integrations-${group.stage.toLowerCase()}`} className="flex items-center gap-2 text-lg font-medium">
              <span className={`size-2 rounded-full ${group.dotClass}`} aria-hidden="true" />
              {group.stage}
            </h3>
            <p className="mt-1 text-sm text-muted">{group.note}</p>
            <ul className="mt-5 space-y-2.5">
              {group.providers.map((provider) => (
                <li key={provider} className="font-mono text-sm">
                  {provider}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-8 max-w-3xl rounded-xl border border-line bg-panel/60 px-5 py-4 text-sm leading-6 text-muted">
        <span className="font-medium text-foreground">About ChatGPT and Claude subscriptions.</span> Plans like
        ChatGPT Plus or Claude Pro are separate from API billing, and most do not offer a documented usage
        API. {site.name} will only show subscription usage where an official route exists. It will never
        scrape your sessions or ask for your password to fill the gap.
      </p>
    </Section>
  );
}
