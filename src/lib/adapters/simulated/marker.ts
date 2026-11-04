import type { OAuthCredential } from "@/lib/adapters/types";

/*
 * What marks a connection as made by the provider simulator (#131). It is a property of the
 * connection, recorded when it is created, never of the process flag: a simulated connection stays
 * simulated after the flag is removed, and a real connection stays real while the flag is on.
 * Dependency free, so pure reductions and pages can import it without the simulator itself.
 */

/** The only scope a simulated grant has; `completeConnection` stores it in `granted_scopes`. */
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

/** True when the simulator minted this credential. */
export function isSimulatedCredential(credential: Pick<OAuthCredential, "metadata">): boolean {
  return credential.metadata?.[SIMULATED_METADATA_KEY] === "1";
}
