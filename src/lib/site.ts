const audience = "solo developers running side projects and small products";

/** Single source of truth for the placeholder's copy. */
export const site = {
  name: "StackDash",
  domain: "stackda.sh",
  /** The origin Vercel serves as primary: the apex, `https://stackda.sh`, 308s here. Canonical and preview addresses use it. */
  url: "https://www.stackda.sh",
  /** The brand line: the footer row of the link preview (`SiteCard`), as on `main`. */
  tagline: "The big picture of your developer stack",
  /** The promise: the hero heading and the link preview's heading. */
  headline: "One timeline and one alert for your whole developer stack",
  audience,
  description: `StackDash is an open-source dashboard for ${audience}, coming soon: one timeline and one alert for your whole developer stack. Deploys, stars, signups, payments, and errors in one feed, alerts by email, Slack, Discord, or webhook, and the stats you choose to publish.`,
  githubUrl: "https://github.com/eddiejaoude/StackDash",
  founder: {
    name: "Eddie Jaoude",
    url: "https://github.com/eddiejaoude",
  },
} as const;

/** Every platform with a brand mark: the hero's data-flow sources, preview, and live feed. */
export type Platform =
  | "Vercel"
  | "GitHub"
  | "GitHub Actions"
  | "GitHub Copilot"
  | "Resend"
  | "Stripe"
  | "Supabase"
  | "DigitalOcean"
  | "PostHog"
  | "Polar"
  | "Sentry"
  | "Railway"
  | "GitLab";
