import { Section } from "@/components/section";
import { site } from "@/lib/site";

interface FaqItem {
  question: string;
  answer: string;
}

const faq: readonly FaqItem[] = [
  {
    question: `Can I use ${site.name} today?`,
    answer: `Not yet. ${site.name} is in early development and is being built in the open. Follow the GitHub repository to watch progress and hear about the first release.`,
  },
  {
    question: "Is it open source?",
    answer: "Yes. The core application, integrations included, will be open source and self-hostable. The license will be chosen before the code is made public.",
  },
  {
    question: `Does ${site.name} need write access to my accounts?`,
    answer: `No. It connects through OAuth and asks for read-only access wherever a provider offers it. A few providers only share usage data with broader access; Resend's OAuth, for example, grants full access. Those integrations are labeled Elevated access required before you connect, and ${site.name} still only performs read operations.`,
  },
  {
    question: "Will any of my data be public?",
    answer: "Not unless you choose to share it. Everything is private by default. An optional feature being explored for after the first release would let you publish milestone cards or a project page, picking each metric yourself. Credentials can never be published, and spending, budgets, and billing details are never shared automatically.",
  },
  {
    question: "Are the costs exact?",
    answer: "Each number is labeled with where it came from. Verified cost comes from a provider's billing API. Estimated cost is calculated from usage and published pricing. Allowances, budgets, and credit balances are shown separately. Some providers report with a delay, so every account shows when it last synced.",
  },
  {
    question: "Can it track my ChatGPT Plus or Claude Pro usage?",
    answer: `Only where an official way to read it exists. Consumer subscriptions are separate from API billing and most do not offer a documented usage API. ${site.name} will not scrape sessions or ask for your password to fill that gap.`,
  },
  {
    question: "Which services come first?",
    answer: "Vercel, GitHub, Resend, Stripe, and Supabase, all connected with OAuth. GitLab, Railway, Polar, PostHog, DigitalOcean, Sentry, and ElevenLabs are planned next. The OpenAI and Anthropic APIs only share usage with admin API keys, so they wait until an OAuth route exists.",
  },
  {
    question: "Will there be an API or MCP server?",
    answer: `Yes, soon after the first release: a public REST API with scoped keys, and a read-only MCP server so AI assistants can answer questions like "which provider is closest to its limit?" without ever seeing your provider credentials.`,
  },
];

/** FAQ rendered with native details/summary: zero JavaScript and fully crawlable. */
export function Faq() {
  return (
    <Section id="faq" eyebrow="FAQ" title="Questions people actually ask">
      <div className="mx-auto max-w-3xl divide-y divide-line rounded-xl border border-line bg-panel">
        {faq.map((item) => (
          <details key={item.question} className="group px-6 py-5">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-sm font-medium marker:hidden [&::-webkit-details-marker]:hidden">
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
