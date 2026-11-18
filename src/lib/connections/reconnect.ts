import type { ProviderAdapter } from "@/lib/adapters/types";

/** Where a connection's Reconnect links go, or why the connection page offers none. */
export type ReconnectTarget = Readonly<{ kind: "available"; href: string }> | Readonly<{ kind: "unavailable"; reason: string }>;

/**
 * The connection page's reconnect (#562). A connection outlives its provider's adapter: the fake
 * provider is absent from the registry while its flag is off, and the connect page answers not
 * found for it then, so a Reconnect link would always end there. The link is built from the
 * adapter, so there is none without one; `adapter` is the registry's (`availableProviders`) entry
 * for the connection's provider, undefined when this instance does not offer it.
 */
export function reconnectTarget(
  input: Readonly<{ connectionsPath: string; connectionId: string; providerName: string; adapter: ProviderAdapter | undefined }>,
): ReconnectTarget {
  const { connectionsPath, connectionId, providerName, adapter } = input;
  if (adapter === undefined) {
    return {
      kind: "unavailable",
      reason: `${providerName} is not available on this instance, so this connection cannot be reconnected. Its history stays here until you delete the connection.`,
    };
  }
  return {
    kind: "available",
    href: `${connectionsPath}/new/${adapter.id}?${new URLSearchParams({ connection: connectionId }).toString()}`,
  };
}
