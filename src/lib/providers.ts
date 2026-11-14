import type { Platform } from "@/lib/site";
import type { Database } from "@/lib/supabase/database.types";

/**
 * The one home for provider display names and brand marks. Client-safe: plain data and pure
 * functions, so adapters, server pages, and client components all read the same strings.
 */

type ProviderId = Database["public"]["Enums"]["provider_id"];

export const PROVIDER_NAMES: Record<ProviderId, string> = {
  vercel: "Vercel",
  github: "GitHub",
  resend: "Resend",
  stripe: "Stripe",
  supabase: "Supabase",
  digitalocean: "DigitalOcean",
  posthog: "PostHog",
  polar: "Polar",
  sentry: "Sentry",
  railway: "Railway",
  gitlab: "GitLab",
  fake: "Example provider",
};

// The test-only fake provider has no brand mark; its name is still printed.
const PROVIDER_PLATFORMS: Record<ProviderId, Platform | null> = {
  vercel: "Vercel",
  github: "GitHub",
  resend: "Resend",
  stripe: "Stripe",
  supabase: "Supabase",
  digitalocean: "DigitalOcean",
  posthog: "PostHog",
  polar: "Polar",
  sentry: "Sentry",
  railway: "Railway",
  gitlab: "GitLab",
  fake: null,
};

/** Who produced an event: a provider, or StackDash itself (daily summaries, alerts) when null. */
export function providerName(provider: ProviderId | null): string {
  return provider === null ? "StackDash" : PROVIDER_NAMES[provider];
}

export function providerPlatform(provider: ProviderId | null): Platform | null {
  return provider === null ? null : PROVIDER_PLATFORMS[provider];
}

/** Provider name for a type id's prefix (`vercel.deployment_failed` is Vercel's). */
export function typeOwnerName(typeId: string): string {
  const prefix = typeId.split(".")[0] ?? "";
  if (prefix === "stackdash") return "StackDash";
  const provider = Object.keys(PROVIDER_NAMES).find((id): id is ProviderId => id === prefix);
  return provider === undefined ? prefix : PROVIDER_NAMES[provider];
}
