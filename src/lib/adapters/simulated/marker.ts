import type { OAuthCredential } from "@/lib/adapters/types";

/*
 * What marks a connection as made by the provider simulator (#131). It is a property of the
 * connection, recorded when it is created, never of the process flag: a simulated connection stays
 * simulated after the flag is removed, and a real connection stays real while the flag is on.
 * Dependency free, so pure reductions and pages can import it without the simulator itself.
 */

/**
 * The only scope a simulated grant has; `completeConnection` stores it in `granted_scopes`.
 * list_webhook_targets (20261118140000_webhook_targets_simulated.sql) repeats the literal, since
 * SQL cannot import it: change both together.
 */
export const SIMULATED_SCOPE = "simulated:read";

// Credential metadata key the simulator sets to "1" on every credential it mints.
const SIMULATED_METADATA_KEY = "simulated";

/** Metadata the simulator puts on every credential it mints; `seed` picks the made-up accounts. */
export function simulatedCredentialMetadata(seed: string): Readonly<Record<string, string>> {
  return { [SIMULATED_METADATA_KEY]: "1", seed };
}

/** True when the connection was made by the simulator, so its data is made up. */
export function isSimulatedConnection(connection: Readonly<{ granted_scopes: readonly string[] }>): boolean {
  return connection.granted_scopes.includes(SIMULATED_SCOPE);
}

/**
 * True when something is in view and the simulator made every connection behind it (#269). A page
 * then says "Simulated" once, in `SimulatedNotice`, instead of on every row, card, and chart. A
 * page that mixes real and simulated connections keeps the badge on each simulated item, so the
 * real ones stand apart.
 */
export function everySimulated(items: readonly Readonly<{ simulated: boolean }>[]): boolean {
  return items.length > 0 && items.every((item) => item.simulated);
}

/** True when the simulator minted this credential. */
export function isSimulatedCredential(credential: Pick<OAuthCredential, "metadata">): boolean {
  return credential.metadata?.[SIMULATED_METADATA_KEY] === "1";
}
