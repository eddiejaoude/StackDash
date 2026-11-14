import { z } from "zod";

import { InvalidResponseError, ProviderUnavailableError } from "@/lib/adapters/errors";
import type { ActivityEvent } from "@/lib/adapters/events";
import { FAKE_AUTHORIZE_PATH } from "@/lib/adapters/fake";
import {
  Secret,
  type LiveProviderId,
  type OAuthContext,
  type OAuthCredential,
  type ProviderAdapter,
  type SyncInput,
  type SyncResult,
} from "@/lib/adapters/types";
import { PROVIDER_NAMES } from "@/lib/providers";

import { digitaloceanProfile } from "./digitalocean";
import { githubProfile } from "./github";
import { postHogProfile } from "./posthog";
import { gitlabProfile } from "./gitlab";
import { resendProfile } from "./resend";
import { isSimulatedCredential, SIMULATED_SCOPE, simulatedCredentialMetadata } from "./marker";
import { polarProfile } from "./polar";
import { sentryProfile } from "./sentry";
import { railwayProfile } from "./railway";
import {
  DEFAULT_EVENT_VOLUME,
  MAX_EVENT_VOLUME,
  simulatedEndpoint,
  SLOT_MS,
  slotOf,
  type SimulatedIncident,
  type SimulatedProfile,
} from "./simulation";
import { stripeProfile } from "./stripe";
import { supabaseProfile } from "./supabase";
import { vercelProfile } from "./vercel";

/**
 * Simulated providers for local demos and testing (#131), built by one factory from a profile per
 * provider. Each simulated adapter has the real adapter's id, capabilities, event types, and
 * metric vocabulary, so its data runs through the real sync, validation, alerts, and realtime
 * path. It never touches the network: the consent screen is the dev-only route at
 * FAKE_AUTHORIZE_PATH (with `provider=<id>`), tokens are minted locally, and `sync` derives every
 * value from `ctx.now()` and the account id.
 */

export const SIMULATE_PROVIDERS_ENV = "DEVMACRO_SIMULATE_PROVIDERS";

/**
 * True when this process simulates the live providers: the flag is exactly "1" and this is not a
 * Vercel production deployment, where it is refused even if set. Read on every call, not at
 * module load, so the flag can never be baked into a build.
 */
export function isProviderSimulationEnabled(): boolean {
  return process.env[SIMULATE_PROVIDERS_ENV] === "1" && process.env.VERCEL_ENV !== "production";
}

export const SIMULATED_CODE_PREFIX = "simulated-";
// Polled as often as the contract allows, so `npm run jobs:tick -- --watch` sees fresh data.
export const SIMULATED_POLL_INTERVAL_SECONDS = 60;
// The first sync fills the last half hour; a sync after a long pause catches up at most this far.
export const SIMULATED_BACKFILL_MS = 30 * 60_000;
const BACKFILL_SLOTS = SIMULATED_BACKFILL_MS / SLOT_MS;

const CursorSchema = z.iso.datetime();

function seedOf(credential: OAuthCredential, provider: LiveProviderId): string {
  const seed = credential.metadata?.seed;
  if (!isSimulatedCredential(credential) || seed === undefined || !/^[0-9a-f]{8}$/.test(seed)) {
    // A real credential is never synced with made-up data. Treated as the provider not answering:
    // retried, then the connection is marked failed and retried hourly, so once the simulator is
    // off again the real adapter syncs it as before.
    throw new ProviderUnavailableError(
      `Simulated ${provider} refuses a credential it did not mint; unset ${SIMULATE_PROVIDERS_ENV} to sync this connection`,
      { endpoint: simulatedEndpoint(provider, "/sync") },
    );
  }
  return seed;
}

/** The last slot a sync covered, or undefined to backfill. */
function readCursor(cursor: string | undefined, provider: LiveProviderId, ctx: OAuthContext): number | undefined {
  if (cursor === undefined) return undefined;
  const parsed = CursorSchema.safeParse(cursor);
  if (parsed.success) return slotOf(new Date(parsed.data));
  ctx.logger.warn("simulated.sync.cursor_reset", { provider });
  return undefined;
}

// Every adapter createSimulatedAdapter built: the registry's, the one `npm run demo:event` builds
// with an incident (#256), and the ones `npm run jobs:tick -- --watch --volume` builds (#383).
// Membership, not the id, is what makes an adapter simulated.
const builtBySimulator = new WeakSet<ProviderAdapter>();

export type SimulatedAdapterOptions = Readonly<{
  /** Carried by every sync, on top of the profile's events. */
  incident?: SimulatedIncident;
  /** Whole number, DEFAULT_EVENT_VOLUME (the default) to MAX_EVENT_VOLUME. */
  volume?: number;
}>;

/** A simulated adapter for `provider`, optionally with an incident or at a higher event volume. */
export function createSimulatedAdapter(profile: SimulatedProfile, provider: LiveProviderId, options: SimulatedAdapterOptions = {}): ProviderAdapter {
  const { incident, volume = DEFAULT_EVENT_VOLUME } = options;
  if (!Number.isInteger(volume) || volume < DEFAULT_EVENT_VOLUME || volume > MAX_EVENT_VOLUME) {
    throw new RangeError(`Simulated event volume must be a whole number from ${DEFAULT_EVENT_VOLUME} to ${MAX_EVENT_VOLUME}`);
  }
  const { real } = profile;
  const name = PROVIDER_NAMES[provider];
  const endpoint = (path: string) => simulatedEndpoint(provider, path);
  const metrics = incident?.metrics ?? profile.metrics;

  const adapter: ProviderAdapter = {
    id: provider,
    displayName: name,
    capabilities: real.capabilities,
    permissions: [
      {
        scope: SIMULATED_SCOPE,
        access: "read",
        description: `Simulated. DevMacro makes up example ${name} data on this computer. No ${name} account is connected and nothing is read from ${name}.`,
      },
    ],
    dataCollected: real.dataCollected,
    eventTypes: real.eventTypes,
    ...(real.achievements === undefined ? {} : { achievements: real.achievements }),
    ...(real.signupDailyTotals === undefined ? {} : { signupDailyTotals: real.signupDailyTotals }),
    ...(real.dailyTotals === undefined ? {} : { dailyTotals: real.dailyTotals }),
    ...(real.projectedSpend === undefined ? {} : { projectedSpend: real.projectedSpend }),
    ...(real.beta === undefined ? {} : { beta: real.beta }),
    oauth: {
      authorizeUrl: FAKE_AUTHORIZE_PATH,
      // Never requested: `exchangeCode` mints the credential in memory.
      tokenUrl: endpoint("/token"),
      scopes: [SIMULATED_SCOPE],
      pkce: false,
      // Never read: the registry gives simulated adapters a fixed local client.
      clientIdEnv: SIMULATE_PROVIDERS_ENV,
      clientSecretEnv: SIMULATE_PROVIDERS_ENV,
    },
    pollIntervalSeconds: SIMULATED_POLL_INTERVAL_SECONDS,

    buildAuthorizeUrl({ state, redirectUri }) {
      const url = new URL(FAKE_AUTHORIZE_PATH, new URL(redirectUri).origin);
      url.searchParams.set("provider", provider);
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", SIMULATED_SCOPE);
      return url;
    },

    async exchangeCode({ code }) {
      if (!code.startsWith(SIMULATED_CODE_PREFIX) || code.length === SIMULATED_CODE_PREFIX.length) {
        throw new InvalidResponseError(`Simulated ${provider} did not issue this authorization code`, {
          status: 400,
          endpoint: endpoint("/token"),
        });
      }
      // A fresh seed per grant, so two simulated connections never share accounts or events.
      return {
        accessToken: new Secret(`simulated-at-${crypto.randomUUID()}`),
        scopes: [SIMULATED_SCOPE],
        tokenType: "bearer",
        metadata: simulatedCredentialMetadata(crypto.randomUUID().slice(0, 8)),
      };
    },

    // Nothing exists outside this process, so there is nothing to revoke.
    async revoke() {},

    async listAccounts(credential) {
      return [...profile.accounts(seedOf(credential, provider))];
    },

    detectMissingPermissions(grant) {
      return grant.scopes.includes(SIMULATED_SCOPE) ? [] : [SIMULATED_SCOPE];
    },

    async sync({ credential, externalAccountId, cursor }: SyncInput, ctx): Promise<SyncResult> {
      const accounts = profile.accounts(seedOf(credential, provider));
      if (!accounts.some((account) => account.externalId === externalAccountId)) {
        throw new InvalidResponseError(`Simulated ${provider} has no such account`, { status: 404, endpoint: endpoint("/sync") });
      }
      // Only whole 10 second slots count, so every call within one slot returns the same result.
      const currentSlot = slotOf(ctx.now());
      const lastSlot = currentSlot - 1;
      const previous = readCursor(cursor, provider, ctx);
      const backfillFrom = lastSlot - BACKFILL_SLOTS + 1;
      const firstSlot = previous === undefined ? backfillFrom : Math.max(previous + 1, backfillFrom);

      const events: ActivityEvent[] = [];
      for (let slot = firstSlot; slot <= lastSlot; slot += 1) {
        events.push(...profile.eventsInSlot(externalAccountId, slot, volume));
      }
      // Outside the slot loop, so the incident arrives even when this slot was already synced.
      if (incident !== undefined) events.push(...incident.events(externalAccountId, ctx.now()));
      // A clock that moved back keeps the cursor where it was, so no slot is replayed.
      const covered = previous === undefined ? lastSlot : Math.max(previous, lastSlot);
      return {
        metrics: metrics(externalAccountId, new Date(currentSlot * SLOT_MS), ctx),
        events,
        cursor: new Date(covered * SLOT_MS).toISOString(),
      };
    },
  };
  builtBySimulator.add(adapter);
  return adapter;
}

/** A simulated adapter for every live provider, at `volume` (#383). */
export function simulatedAdaptersAtVolume(volume: number): Readonly<Record<LiveProviderId, ProviderAdapter>> {
  const options = { volume };
  return {
    vercel: createSimulatedAdapter(vercelProfile, "vercel", options),
    github: createSimulatedAdapter(githubProfile, "github", options),
    resend: createSimulatedAdapter(resendProfile, "resend", options),
    stripe: createSimulatedAdapter(stripeProfile, "stripe", options),
    supabase: createSimulatedAdapter(supabaseProfile, "supabase", options),
    digitalocean: createSimulatedAdapter(digitaloceanProfile, "digitalocean", options),
    posthog: createSimulatedAdapter(postHogProfile, "posthog", options),
    polar: createSimulatedAdapter(polarProfile, "polar", options),
    sentry: createSimulatedAdapter(sentryProfile, "sentry", options),
    railway: createSimulatedAdapter(railwayProfile, "railway", options),
    gitlab: createSimulatedAdapter(gitlabProfile, "gitlab", options),
  };
}

export const simulatedAdapters = simulatedAdaptersAtVolume(DEFAULT_EVENT_VOLUME);

/**
 * True only for an adapter createSimulatedAdapter built, compared by identity rather than id, so
 * a real adapter, or a copy of a simulated one, is never treated as simulated.
 */
export function isSimulatedAdapter(adapter: ProviderAdapter): boolean {
  return builtBySimulator.has(adapter);
}
