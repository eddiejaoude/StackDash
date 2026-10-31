import { Section } from "@/components/section";

const questions: readonly string[] = [
  "How much am I spending this month?",
  "Which service is getting expensive?",
  "How much of my included allowance is left?",
  "When does my allowance reset?",
  "Am I about to hit a usage limit?",
  "What happened across my projects today?",
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
