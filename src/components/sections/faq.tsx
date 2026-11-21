import { Section } from "@/components/section";
import { site } from "@/lib/site";

interface FaqItem {
  question: string;
  answer: string;
}

const faq: readonly FaqItem[] = [
  {
    question: `Can I use ${site.name} today?`,
    answer: `Yes, if you host it yourself. ${site.name} is an early MVP: every integration is built from the provider's documentation and none has been tried with a real account yet. Sign-up is invite only for now, so whoever runs a copy invites each person who signs in. A hosted version is planned. The README shows how to run it on your own computer with simulated data, and the docs cover deploying your own copy.`,
  },
  {
    question: "Is it open source?",
    answer: "Yes. The core application, integrations included, is open source under the GNU AGPL v3.0, and you can host it yourself.",
  },
  {
    question: `Does ${site.name} need write access to my accounts?`,
    answer: `Not where a provider offers read-only access. It connects through OAuth and asks for read-only access wherever a provider offers it. A few providers only share usage data with broader access; Resend's OAuth, for example, grants full access. Those integrations are labeled Elevated access required before you connect. Polar and GitLab have no read-only way to add a webhook, so automatic webhook setup asks for write access there, and says so first. ${site.name} writes only to add and delete its own webhook, and setting the webhook up by hand asks for no extra access.`,
  },
  {
    question: "Will any of my data be public?",
    answer: "Not unless you publish it. Everything is private by default. You choose each metric to publish, one at a time, and can round it or delay it 7 days first. Only verified metrics can count toward any public ranking. Self-reported numbers can appear on your project page, labeled self-reported. Credentials can never be published, and spending, budgets, and billing details are never shared automatically.",
  },
  {
    question: "Are the costs exact?",
    answer: `Each number is labeled with where it came from. Verified cost comes from a provider's billing API. Estimated cost is calculated from usage and published pricing. Allowances, budgets, and credit balances are shown separately. Some providers report with a delay, so every account shows when it last synced. Where spend or a quota is projected to the end of its period, the projection is labeled Estimate by ${site.name} and is never added to the amounts shown.`,
  },
  {
    question: "Can it track my ChatGPT Plus or Claude Pro usage?",
    answer: `Only where an official way to read it exists. Consumer subscriptions are separate from API billing and most do not offer a documented usage API. ${site.name} will not scrape sessions or ask for your password to fill that gap.`,
  },
  {
    question: "Which services does it connect to?",
    answer: "Vercel, GitHub, Resend, Stripe, Supabase, DigitalOcean, PostHog, Railway, Polar, Sentry, and GitLab, all connected with OAuth. Each is built from the provider's documentation and has not been tried with a real account yet. ElevenLabs is planned later. Spend depends on the provider and your plan, and the integrations section lists what each one needs.",
  },
  {
    question: "Will it show OpenAI and Anthropic API spend?",
    answer: "Not yet. Both share usage and cost only with an organization admin API key, not through OAuth. Once those adapters exist, they will connect with an admin key, restricted where the provider allows it, and be labeled Elevated access required, because an admin key is not read-only.",
  },
  {
    question: "Is there an API or MCP server?",
    answer: `Yes. A read-only REST API with scoped keys lets your own scripts and dashboards read usage, spend, timeline events, alerts, and connection status. A read-only MCP server on the same keys lets AI assistants such as Claude Code, Claude Desktop, or Cursor answer questions like "which provider is closest to its limit?" without ever seeing your provider credentials. The API and MCP guides are in the docs.`,
  },
];

/** FAQ rendered with native details/summary: zero JavaScript and fully crawlable. */
export function Faq() {
  return (
    <Section id="faq" eyebrow="FAQ" title="Questions people actually ask">
      <div className="mx-auto max-w-3xl divide-y divide-line rounded-xl border border-line bg-panel">
        {faq.map((item) => (
          <details key={item.question} className="group px-6 py-5">
            <summary className="flex min-h-6 cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium marker:hidden [&::-webkit-details-marker]:hidden">
              {item.question}
              <span aria-hidden="true" className="shrink-0 font-mono text-muted transition-transform group-open:rotate-45">
                +
              </span>
            </summary>
            <p className="mt-3 text-sm leading-7 text-muted">{item.answer}</p>
          </details>
        ))}
      </div>
    </Section>
  );
}
