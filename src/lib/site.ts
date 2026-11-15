// Who the landing page speaks to (#305). An assumption until #141 question 3 is answered.
const audience = "solo developers running side projects and small products";

/** Single source of truth for site-wide constants. Update links here, nowhere else. */
export const site = {
  name: "StackDash",
  /** The brand line: the footer and the share card. Not the page heading, which says what StackDash does. */
  tagline: "The big picture of your developer stack",
  /** The promise: the hero heading, the document title, and the README (#144, #305). */
  headline: "One timeline and one alert for your whole developer stack",
  audience,
  description: `StackDash is an open-source dashboard for ${audience}: one timeline and one alert for your whole developer stack. Deploys, stars, signups, payments, and errors in one feed, alerts by email, Slack, Discord, or webhook, and the stats you choose to publish. Spend and allowances show where each provider reports them.`,
  githubUrl: "https://github.com/eddiejaoude/StackDash",
  founder: {
    name: "Eddie Jaoude",
    url: "https://github.com/eddiejaoude",
  },
} as const;

/** Every platform with a brand mark: the landing page's hero preview and live feed, and each provider. */
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

export interface NavLink {
  label: string;
  href: string;
}

// Homepage sections in page order. The footer renders all of them; the header renders the
// subset in HEADER_LABELS so the two lists cannot drift apart.
export const sectionLinks: readonly NavLink[] = [
  { label: "The problem", href: "#problem" },
  { label: "How it works", href: "#how-it-works" },
  { label: "Features", href: "#features" },
  { label: "Integrations", href: "#integrations" },
  { label: "Security", href: "#security" },
  { label: "Open source", href: "#open-source" },
  { label: "Share progress", href: "#share" },
  { label: "Roadmap", href: "#roadmap" },
  { label: "FAQ", href: "#faq" },
];

const HEADER_LABELS = new Set(["How it works", "Features", "Integrations", "Security", "Roadmap"]);
export const navLinks: readonly NavLink[] = sectionLinks.filter((link) => HEADER_LABELS.has(link.label));

// A sectionLinks rename must fail loudly, not silently shrink the header.
if (navLinks.length !== HEADER_LABELS.size) {
  throw new Error("HEADER_LABELS names a label missing from sectionLinks: update both together");
}

// Pages outside the landing page. Kept apart from sectionLinks, which are all in-page anchors.
export const docsLink: NavLink = { label: "Docs", href: "/docs" };
export const signInLink: NavLink = { label: "Sign in", href: "/sign-in" };
// The privacy policy and terms of use (#339). Only rendered where `operatorEnv()` names an operator.
export const privacyLink: NavLink = { label: "Privacy policy", href: "/privacy" };
export const termsLink: NavLink = { label: "Terms of use", href: "/terms" };
