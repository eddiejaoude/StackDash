import { availableProviders } from "@/lib/adapters/registry";
import type { ProviderId } from "@/lib/adapters/types";

/**
 * The providers this instance offers: those with an adapter in the registry (`availableProviders`).
 * Only their connections can sync, so `syncNow` refuses the rest (#570), and the command palette
 * and the dashboard's stale notice offer no sync for them (#588).
 */
export function offeredProviderIds(): ReadonlySet<ProviderId> {
  return new Set(availableProviders().map((adapter) => adapter.id));
}

/**
 * Why a connection whose provider this instance does not offer can neither sync nor be reconnected
 * (#562, #570). A connection outlives its provider's adapter: the fake provider is absent from the
 * registry (`availableProviders`) while its flag is off, and its rows still render. The connection
 * page shows this in place of Sync now and Reconnect, and `syncNow` refuses with it, so the two say
 * the same thing.
 */
export function providerUnavailableReason(providerName: string): string {
  return `${providerName} is not available on this instance, so this connection cannot sync or be reconnected. Its history stays here until you delete the connection.`;
}
