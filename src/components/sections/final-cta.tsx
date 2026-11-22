import { GitHubButton } from "@/components/github-button";
import { site } from "@/lib/site";

/** Closing move: one clear invitation, follow the build. */
export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="border-t border-line">
      <div className="mx-auto w-full max-w-6xl px-6 py-24 text-center sm:py-32">
        <h2 id="cta-title" className="mx-auto max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-5xl">
          See your whole developer stack. <span className="text-accent">Follow the build.</span>
        </h2>
        <p className="mx-auto mt-5 max-w-xl text-base leading-7 text-muted">
          {site.name} is being built in the open. Star or watch the repository to follow progress, request
          the integrations you need, and help shape what comes next.
        </p>
        <div className="mt-10 flex justify-center">
          <GitHubButton size="lg" />
        </div>
      </div>
    </section>
  );
}
