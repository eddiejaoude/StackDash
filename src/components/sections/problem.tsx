import { Section } from "@/components/section";

// Ordered by what StackDash answers on a free plan first; spend comes last because it depends on the
// provider's plan (see the integrations section).
const questions: readonly string[] = [
  "What shipped across my projects today?",
  "Did that launch bring in signups, or errors?",
  "How many stars did my repository gain this week?",
  "How many emails can I still send before the quota resets?",
  "Will I hear about it before a limit is reached?",
  "Where my plan allows it, what am I spending?",
];

export function Problem() {
  return (
    <Section
      id="problem"
      eyebrow="The problem"
      title="Every service has its own dashboard, pricing, and reset date"
      intro="GitHub, Vercel, Supabase, Resend, Stripe, OpenAI, Anthropic. Each one answers a slice of the question, in its own units and on its own billing cycle. None of them answers it for your whole stack, so simple questions turn into a tour of browser tabs."
    >
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {questions.map((question) => (
          <li key={question} className="rounded-xl border border-line bg-panel px-5 py-4 font-mono text-sm">
            {question}
          </li>
        ))}
      </ul>
    </Section>
  );
}
