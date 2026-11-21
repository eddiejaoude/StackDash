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
