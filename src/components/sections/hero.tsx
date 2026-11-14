import { ArrowRightIcon, BellIcon, EyeIcon, GaugeIcon, TimelineIcon } from "@/components/icons";
import type { Icon } from "@/components/icon-card";
import { GitHubButton } from "@/components/github-button";
import { DataFlow } from "@/components/sections/data-flow";
import { HeroPreview } from "@/components/sections/hero-preview";
import { site } from "@/lib/site";

interface HeroFeature {
  icon: Icon;
  title: string;
  body: string;
}

// The strip restates the paragraph's order: what works on every plan first, spend last.
const heroFeatures: readonly HeroFeature[] = [
  { icon: TimelineIcon, title: "One timeline", body: "Deploys, stars, signups, logins, payments, and errors in one feed." },
  { icon: BellIcon, title: "One alert, where you read it", body: "Email, Slack, Discord, or a webhook. Each threshold fires once per billing period." },
  { icon: EyeIcon, title: "Stats you can share", body: "Publish one metric at a time, each labeled with where it came from." },
  { icon: GaugeIcon, title: "Spend where the provider reports it", body: "With allowances and reset dates, and the plan each provider needs." },
];

// The feature strip follows the preview's own entrance (see hero-preview.tsx).
const FEATURES_START_MS = 1400;
const FEATURES_STAGGER_MS = 90;

/** Hero: one promise, one primary action, and a moving picture of the dashboard. */
export function Hero() {
  return (
    <section id="top" aria-labelledby="hero-title" className="relative overflow-hidden">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[900px] bg-[linear-gradient(to_right,var(--line)_1px,transparent_1px),linear-gradient(to_bottom,var(--line)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black,transparent)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-[-10%] h-[560px] w-[min(960px,100vw)] -translate-x-1/2 rounded-full bg-accent/10 blur-[140px]"
      />
      <div className="relative mx-auto w-full max-w-6xl px-6 pb-24 pt-14 sm:pt-20">
        <div className="mx-auto max-w-3xl text-center">
          <p className="rise inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 font-mono text-xs text-muted">
            <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
            Open source · In development
          </p>

          <h1
            id="hero-title"
            className="rise mt-6 text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl"
          >
            {site.headline}.
          </h1>

          <p className="rise-late mx-auto mt-6 max-w-2xl text-lg leading-8 text-muted">
            Built for {site.audience}. {site.name} puts the deploys, stars, signups, logins, payments, and errors
            from the services you build on into one feed, sends an alert by email, Slack, Discord, or webhook when
            usage or spend crosses a line you set, and publishes the stats you choose, each labeled with its
            source. Spend shows where the provider reports it.
          </p>

          <div className="rise-late mt-10 flex flex-wrap items-center justify-center gap-4">
            <GitHubButton />
            <a
              href="#how-it-works"
              className="inline-flex items-center gap-2 rounded-lg border border-line px-5 py-3 text-sm font-medium text-muted transition-colors hover:border-line-strong hover:text-foreground"
            >
              See how it works
              <ArrowRightIcon />
            </a>
          </div>
          <p className="rise-late mt-3 font-mono text-xs text-muted">
            Read-only access where providers allow it · self-hostable · hosted version planned
          </p>
        </div>

        <div className="mt-16">
          <HeroPreview />
        </div>

        <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {heroFeatures.map((feature, index) => (
            <li
              key={feature.title}
              className="rise-in flex gap-3"
              style={{ animationDelay: `${FEATURES_START_MS + index * FEATURES_STAGGER_MS}ms` }}
            >
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-line bg-panel text-accent">
                <feature.icon />
              </span>
              <div>
                <p className="text-sm font-medium">{feature.title}</p>
                <p className="mt-0.5 text-sm leading-6 text-muted">{feature.body}</p>
              </div>
            </li>
          ))}
        </ul>

        <div className="mt-24 sm:mt-32">
          <DataFlow />
        </div>
      </div>
    </section>
  );
}
