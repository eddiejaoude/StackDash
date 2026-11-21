import Link from "next/link";

import { Section } from "@/components/section";
import { getDoc } from "@/lib/docs";
import { site } from "@/lib/site";

interface IntegrationGroup {
  stage: string;
  dotClass: string;
  note: string;
  providers: readonly string[];
}

interface SpendAvailability {
  provider: string;
  /** The page under docs/providers that lists what is verified, estimated, and still unverified. */
  docSlug: string;
  /** What spend data the provider gives, and the plan or role it needs. */
  spend: string;
  /** What works without that plan or role. */
  everyPlan: string;
}

// One row per built adapter, in the first group's order. Each line restates the "Verified,
// estimated, unavailable" and "Plan restrictions" sections of docs/providers/<id>.md.
const spendAvailability: readonly SpendAvailability[] = [
  {
    provider: "Vercel",
    docSlug: "vercel",
    spend: "Pro and Enterprise plans only. Vercel shares no billing data for Hobby accounts.",
    everyPlan: "Deployments.",
  },
  {
    provider: "GitHub",
    docSlug: "github",
    spend: "Billed usage, Actions minutes, and Copilot AI Credits for accounts on GitHub's enhanced billing platform. For an organization, an owner installs the app.",
    everyPlan: "Stars, forks, releases, merged pull requests, and opened issues.",
  },
  {
    provider: "Resend",
    docSlug: "resend",
    spend: "None. Resend has no billing API.",
    everyPlan: "Emails sent against the daily and monthly quota, with reset dates.",
  },
  {
    provider: "Stripe",
    docSlug: "stripe",
    spend: "Stripe fees, on any account.",
    everyPlan: "Revenue, payments, refunds, new customers, and subscriptions.",
  },
  {
    provider: "Supabase",
    docSlug: "supabase",
    spend: "None. No Supabase billing endpoint accepts OAuth.",
    everyPlan: "Plan limits, project health, signups, and logins. Daily active users on Pro and above.",
  },
  {
    provider: "DigitalOcean",
    docSlug: "digitalocean",
    spend: "Month to date usage, balance, and invoices on any team, if your team role can read billing.",
    everyPlan: "Droplet actions and App Platform deployments.",
  },
  {
    provider: "PostHog",
    docSlug: "posthog",
    spend: "Spend and projected spend per product on PostHog Cloud, for a member with billing access.",
    everyPlan: "Signups per project.",
  },
  {
    provider: "Railway",
    docSlug: "railway",
    spend: "Usage cost and an estimated bill on Free, Hobby, and Pro, if Railway lets your role read billing.",
    everyPlan: "Deployments.",
  },
  {
    provider: "Polar",
    docSlug: "polar",
    spend: "Polar fees, on any organization.",
    everyPlan: "Revenue, orders, subscriptions, new customers, and refunds.",
  },
  {
    provider: "Sentry",
    docSlug: "sentry",
    spend: "None. Sentry has no billing endpoint for integrations.",
    everyPlan: "Errors per project, new issues, regressions, and releases.",
  },
  {
    provider: "GitLab",
    docSlug: "gitlab",
    spend: "None. GitLab shares no cost through read-only access.",
    everyPlan: "Compute minutes and storage for the GitLab.com namespaces you own, with the monthly minutes quota estimated from the published Free, Premium, or Ultimate limit. Pipelines, deployments, releases, and merged merge requests.",
  },
];

// Fails the build, not a visitor, when a provider page the list links to is renamed or removed.
function providerDocHref(slug: string): string {
  const doc = getDoc(["providers", slug]);
  if (!doc) throw new Error(`docs/providers/${slug}.md is missing: the integrations section links to it`);
  return doc.href;
}

// Order from the OAuth research on issue #11. The first group is every adapter built so far and
// connects through OAuth. The planned group is ElevenLabs, which returns with a restricted API key
// (#49). The last group waits because its usage data needs an admin key or partner approval, and
// says which.
const groups: readonly IntegrationGroup[] = [
  {
    stage: "Available",
    dotClass: "bg-success",
    note: "Connect them today",
    providers: [
      "Vercel",
      "GitHub and GitHub Actions",
      "Resend",
      "Stripe",
      "Supabase",
      "DigitalOcean",
      "PostHog",
      "Railway",
      "Polar",
      "Sentry",
      "GitLab",
    ],
  },
  {
    stage: "Planned",
    dotClass: "bg-warning",
    note: "Further out on the roadmap",
    providers: ["ElevenLabs"],
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
        <span className="font-medium text-foreground">Not yet tried with real accounts.</span> Every integration
        listed as available is built from the provider&apos;s documentation and tested against sample responses
        taken from it. None has been connected to a real account yet, so each provider&apos;s page in the docs
        lists what is still unverified. Until Sentry approves the hosted integration for publication, only the
        organization that registered it can install it.
      </p>

      <div className="mt-16 max-w-4xl">
        <h3 className="text-xl font-semibold tracking-tight">Spend depends on the provider and your plan</h3>
        <p className="mt-3 text-sm leading-6 text-muted">
          {site.name} shows spend only where the provider reports it. Activity and quotas work on every plan,
          free tiers included.
        </p>
        <dl className="mt-6 divide-y divide-line rounded-xl border border-line bg-panel">
          {spendAvailability.map((row) => (
            <div key={row.provider} className="grid gap-1 px-5 py-4 sm:grid-cols-[10rem_1fr] sm:gap-4">
              <dt className="text-sm font-medium">
                <Link
                  href={providerDocHref(row.docSlug)}
                  className="inline-flex min-h-6 items-center underline decoration-line-strong underline-offset-4 transition-colors hover:text-accent"
                >
                  {row.provider}
                </Link>
              </dt>
              <dd className="space-y-1 text-sm leading-6 text-muted">
                <p>
                  <span className="text-foreground">Spend: </span>
                  {row.spend}
                </p>
                <p>
                  <span className="text-foreground">Every plan: </span>
                  {row.everyPlan}
                </p>
              </dd>
            </div>
          ))}
        </dl>
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
