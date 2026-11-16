import Image from "next/image";

import { DataFlow } from "@/components/data-flow";
import { HeroPreview } from "@/components/hero-preview";
import { BellIcon, EyeIcon, GaugeIcon, PlatformLogo, TimelineIcon } from "@/components/icons";
import { SignupForm } from "@/components/signup-form";
import { site } from "@/lib/site";

interface HeroFeature {
  icon: typeof TimelineIcon;
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

/** The coming soon page: the landing page hero, with a launch note in place of its actions. */
export default function Home() {
  return (
    <>
      <header className="relative z-10 mx-auto flex w-full max-w-6xl items-center px-6 pt-8">
        <Image
          src="/brand/stackdash-logo-dark-domain.svg"
          alt={`${site.name}, ${site.domain}`}
          width={377}
          height={76}
          className="h-9 w-auto sm:h-12"
          loading="eager"
          unoptimized
        />
      </header>

      <main id="main" className="flex-1">
        <section aria-labelledby="hero-title" className="relative overflow-hidden">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-[900px] bg-[linear-gradient(to_right,var(--line)_1px,transparent_1px),linear-gradient(to_bottom,var(--line)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,black,transparent)]"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute left-1/2 top-[-10%] h-[560px] w-[min(960px,100vw)] -translate-x-1/2 rounded-full bg-accent/10 blur-[140px]"
          />
          <div className="relative mx-auto w-full max-w-6xl px-6 pb-24 pt-14 sm:pt-20">
            <div className="grid items-center gap-16 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-10">
              <div className="mx-auto max-w-3xl text-center lg:mx-0 lg:text-left">
                <p className="rise inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 font-mono text-xs text-muted">
                  <span className="size-1.5 rounded-full bg-warning" aria-hidden="true" />
                  Coming soon · Open source
                </p>

                <h1
                  id="hero-title"
                  className="rise mt-6 text-balance text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl lg:text-5xl"
                >
                  {site.headline}.
                </h1>

                <div className="rise mx-auto mt-6 max-w-xl rounded-xl border border-accent/40 bg-accent-soft px-6 py-5 lg:mx-0">
                  <p className="text-base font-medium">{site.name} is coming soon.</p>
                  <p className="mt-2 text-sm leading-6 text-muted">
                    It is open source, so you can read the code, contribute, and host it yourself. A hosted version is
                    planned too.
                  </p>
                  <SignupForm purpose="Get the launch email and occasional progress updates" />
                  <p className="mt-3 text-left text-xs leading-5 text-muted">
                    Your email address is kept with Resend, our email provider, and used only for these emails. Every
                    email has an unsubscribe link.
                  </p>
                </div>

                {/* Below the form: the launch list stays the page's first action (#471). */}
                <p className="rise mt-4">
                  <a
                    href={site.githubUrl}
                    className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-line-strong px-4 text-sm font-medium text-foreground transition-colors hover:border-accent hover:text-accent"
                  >
                    <PlatformLogo platform="GitHub" />
                    Star {site.name} on GitHub
                  </a>
                </p>

                <p className="rise-late mx-auto mt-6 max-w-2xl text-lg leading-8 text-muted lg:mx-0 lg:text-base lg:leading-7">
                  Built for {site.audience}. {site.name} puts the deploys, stars, signups, logins, payments, and errors
                  from the services you build on into one feed, sends an alert by email, Slack, Discord, or webhook when
                  usage or spend crosses a line you set, and publishes the stats you choose, each labeled with its
                  source. Spend shows where the provider reports it.
                </p>

                <p className="rise-late mt-4 font-mono text-xs text-muted">
                  Read-only access where providers allow it · self-hostable · hosted version planned
                </p>
              </div>

              <div className="rise-late">
                <DataFlow />
              </div>
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
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto w-full max-w-6xl px-6 py-8 text-sm text-muted">
          <p>
            {site.name} by{" "}
            <a href={site.founder.url} className="text-foreground underline underline-offset-4 hover:text-accent">
              {site.founder.name}
            </a>
            .
          </p>
          <p className="mt-2 text-xs">This page counts visits with Vercel Web Analytics, which sets no cookies.</p>
        </div>
      </footer>
    </>
  );
}
