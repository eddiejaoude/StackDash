import "server-only";

import { log } from "@/lib/log/logger";
import { eventTypeLabel } from "@/lib/timeline/query";

import { digitaloceanAdapter } from "./digitalocean";
import type { EventType } from "./events";
import { fakeAdapter, FAKE_PROVIDER_ENABLE_ENV } from "./fake";
import { githubAdapter } from "./github";
import { postHogAdapter } from "./posthog";
import { gitlabAdapter } from "./gitlab";
import { railwayAdapter } from "./railway";
import { resendAdapter } from "./resend";
import { polarAdapter } from "./polar";
import { sentryAdapter } from "./sentry";
import { isProviderSimulationEnabled, isSimulatedAdapter, simulatedAdapters } from "./simulated";
import { stripeAdapter } from "./stripe";
import { supabaseAdapter } from "./supabase";
import {
  liveProviderIds,
  Secret,
  type AdapterCapabilities,
  type AdapterContext,
  type LiveProviderId,
  type OAuthClient,
  type OAuthContext,
  type ProviderAdapter,
  type ProviderId,
} from "./types";
import { vercelAdapter } from "./vercel";

/**
 * The one place that maps a provider id to its adapter: routes, pages, and the sync runner ask the
 * registry and never import an adapter themselves. Adding a provider is still far more than an
 * entry here: the id, its database enum value, names and brand mark, simulated twin, docs,
 * environment variables, landing page, and tests touch 24 files outside the adapter's folder, and
 * a few more when it reports deployments. docs/adapters.md, "Register the provider", lists every
 * one, checked against the GitLab adapter.
 */

const ADAPTER_TIMEOUT_MS = 15_000;

const liveAdapters: Readonly<Record<LiveProviderId, ProviderAdapter>> = {
  vercel: vercelAdapter,
  github: githubAdapter,
  resend: resendAdapter,
  stripe: stripeAdapter,
  supabase: supabaseAdapter,
  digitalocean: digitaloceanAdapter,
  posthog: postHogAdapter,
  polar: polarAdapter,
  sentry: sentryAdapter,
  railway: railwayAdapter,
  gitlab: gitlabAdapter,
};

/** Read on every call, not at module load, so the flag can never be baked into a build. */
export function isFakeProviderEnabled(): boolean {
  return process.env[FAKE_PROVIDER_ENABLE_ENV] === "1";
}

/**
 * The adapter for `id`. The fake provider exists only when DEVMACRO_ENABLE_FAKE_PROVIDER is "1";
 * the live providers are replaced by their simulated twins while DEVMACRO_SIMULATE_PROVIDERS is.
 */
export function getAdapter(id: ProviderId): ProviderAdapter {
  if (id === "fake") {
    if (!isFakeProviderEnabled()) {
      throw new Error(`The fake provider is disabled; set ${FAKE_PROVIDER_ENABLE_ENV}=1 to use it.`);
    }
    return fakeAdapter;
  }
  return isProviderSimulationEnabled() ? simulatedAdapters[id] : liveAdapters[id];
}

/**
 * True when `provider` is simulated in this process: simulation is on and the provider is live.
 * Only for screens with no connection yet (the catalog, the connect screen, the OAuth callback);
 * an existing connection is labeled from its own marker, `isSimulatedConnection`.
 */
export function isProviderSimulated(provider: ProviderId): boolean {
  return provider !== "fake" && isProviderSimulationEnabled();
}

/** Every provider a person can pick on this instance, in catalog order; the fake one last. */
export function availableProviders(): ProviderAdapter[] {
  const adapters = liveProviderIds.map((id) => getAdapter(id));
  return isFakeProviderEnabled() ? [...adapters, fakeAdapter] : adapters;
}

/**
 * What adapters declare for figures across providers: every event type, every usage metric that
 * is a daily signup total or another daily total, every estimated spend metric that is a
 * projection, and the providers that report revenue or spend. The fake provider's are included
 * whatever the flag says, because its stored data outlives the flag; simulated twins declare the
 * live adapters' own.
 */
const declaringAdapters: readonly ProviderAdapter[] = [...Object.values(liveAdapters), fakeAdapter];
export const declaredEventTypes: readonly EventType[] = declaringAdapters.flatMap((adapter) => adapter.eventTypes);
export const declaredSignupDailyTotals: readonly string[] = declaringAdapters.flatMap((adapter) => adapter.signupDailyTotals ?? []);
export const declaredDailyTotals: readonly string[] = declaringAdapters.flatMap((adapter) => adapter.dailyTotals ?? []);
export const declaredProjectedSpend: readonly string[] = declaringAdapters.flatMap((adapter) => adapter.projectedSpend ?? []);
export const revenueProviderIds: readonly ProviderId[] = declaringAdapters
  .filter((adapter) => adapter.capabilities.revenue)
  .map((adapter) => adapter.id);
export const spendProviderIds: readonly ProviderId[] = declaringAdapters
  .filter((adapter) => adapter.capabilities.spending)
  .map((adapter) => adapter.id);

// A Map: the key is a stored type id, which may be one no adapter declares any more.
const declaredEventTypeLabels: ReadonlyMap<string, string> = new Map(declaredEventTypes.map((type) => [type.id, type.label]));

/**
 * The adapter's own name for an event type, "Payment succeeded" for `stripe.charge.succeeded`, so
 * every timeline surface names a type the way its events read (#294). A type no adapter declares
 * any more falls back to the name `eventTypeLabel` derives from its id.
 */
export function eventTypeName(typeId: string): string {
  return declaredEventTypeLabels.get(typeId) ?? eventTypeLabel(typeId);
}

/**
 * What the adapter for `provider` declares it reports, whatever the flags say: a simulated twin
 * declares its live adapter's, and stored fake provider data outlives its flag. The dashboard's
 * provider cards leave out what a provider never reports (#269).
 */
export function declaredCapabilities(provider: ProviderId): AdapterCapabilities {
  return provider === "fake" ? fakeAdapter.capabilities : liveAdapters[provider].capabilities;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

// Simulated adapters never send their client anywhere; this only satisfies the OAuth contract.
const SIMULATED_CLIENT: OAuthClient = {
  clientId: "simulated",
  clientSecret: new Secret("simulated"),
  extra: {},
};

/**
 * The variables `adapter`'s OAuth app needs that are empty on this instance, in declaration order;
 * none means the app is registered. Extra keys listed in `optionalExtraKeys` are never required.
 */
export function missingOAuthEnv(adapter: ProviderAdapter): string[] {
  const { clientIdEnv, clientSecretEnv, extraEnv, optionalExtraKeys } = adapter.oauth;
  const optional = new Set(optionalExtraKeys ?? []);
  const required = [
    clientIdEnv,
    clientSecretEnv,
    ...Object.entries(extraEnv ?? {})
      .filter(([key]) => !optional.has(key))
      .map(([, envName]) => envName),
  ];
  return required.filter((envName) => readEnv(envName) === undefined);
}

/**
 * The OAuth app settings this instance registered for `adapter`, or null when any required
 * variable is empty: the catalog then says the provider is not set up here. Extra keys listed in
 * `optionalExtraKeys` are passed through only when set and never make the provider unavailable.
 */
export function loadOAuthClient(adapter: ProviderAdapter): OAuthClient | null {
  // Identity, not id: only adapters the simulator built get the local client, and only while
  // simulation is on, so a simulated adapter can never sync once the flag is gone.
  if (isSimulatedAdapter(adapter)) {
    return isProviderSimulationEnabled() ? SIMULATED_CLIENT : null;
  }
  const { clientIdEnv, clientSecretEnv, extraEnv } = adapter.oauth;
  const clientId = readEnv(clientIdEnv);
  const clientSecret = readEnv(clientSecretEnv);
  if (clientId === undefined || clientSecret === undefined || missingOAuthEnv(adapter).length > 0) return null;

  const extra: Record<string, Secret> = {};
  for (const [key, envName] of Object.entries(extraEnv ?? {})) {
    const value = readEnv(envName);
    if (value !== undefined) extra[key] = new Secret(value);
  }
  return { clientId, clientSecret: new Secret(clientSecret), extra };
}

/**
 * Whether each live provider's OAuth app is registered on this instance, in catalog order, from the
 * live adapters even while simulation replaces them, so the answer is about the real setup.
 */
export function liveProviderSetup(): { provider: LiveProviderId; missing: string[] }[] {
  return liveProviderIds.map((provider) => ({ provider, missing: missingOAuthEnv(liveAdapters[provider]) }));
}

/** True when this instance has registered the provider's OAuth app. Never exposes the values. */
export function isProviderConfigured(adapter: ProviderAdapter): boolean {
  return loadOAuthClient(adapter) !== null;
}

export function createAdapterContext(): AdapterContext {
  return {
    fetch: (input, init) => fetch(input, init),
    now: () => new Date(),
    timeoutMs: ADAPTER_TIMEOUT_MS,
    logger: {
      info: (event, fields) => log.info(event, fields),
      warn: (event, fields) => log.warn(event, fields),
      error: (event, fields) => log.error(event, fields),
    },
  };
}

export function createOAuthContext(client: OAuthClient): OAuthContext {
  return { ...createAdapterContext(), client };
}
