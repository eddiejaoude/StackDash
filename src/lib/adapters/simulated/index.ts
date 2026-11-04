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

import { githubProfile } from "./github";
import { resendProfile } from "./resend";
import { isSimulatedCredential, SIMULATED_SCOPE, simulatedCredentialMetadata } from "./marker";
import { simulatedEndpoint, SLOT_MS, slotOf, type SimulatedProfile } from "./simulation";
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

export function createSimulatedAdapter(profile: SimulatedProfile, provider: LiveProviderId): ProviderAdapter {
  const { real } = profile;
  const name = PROVIDER_NAMES[provider];
  const endpoint = (path: string) => simulatedEndpoint(provider, path);

  return {
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
        events.push(...profile.eventsInSlot(externalAccountId, slot));
      }
      // A clock that moved back keeps the cursor where it was, so no slot is replayed.
      const covered = previous === undefined ? lastSlot : Math.max(previous, lastSlot);
      return {
        metrics: profile.metrics(externalAccountId, new Date(currentSlot * SLOT_MS), ctx),
        events,
        cursor: new Date(covered * SLOT_MS).toISOString(),
      };
    },
  };
}

export const simulatedAdapters: Readonly<Record<LiveProviderId, ProviderAdapter>> = {
  vercel: createSimulatedAdapter(vercelProfile, "vercel"),
  github: createSimulatedAdapter(githubProfile, "github"),
  resend: createSimulatedAdapter(resendProfile, "resend"),
  stripe: createSimulatedAdapter(stripeProfile, "stripe"),
  supabase: createSimulatedAdapter(supabaseProfile, "supabase"),
};

/** True only for the registry's own simulated adapters, compared by identity rather than id. */
export function isSimulatedAdapter(adapter: ProviderAdapter): boolean {
  return adapter.id !== "fake" && simulatedAdapters[adapter.id] === adapter;
}
