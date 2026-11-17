import type { OAuthContext, OAuthCredential, ProviderAdapter } from "@/lib/adapters/types";
import type { ConnectionKey, JobStore } from "@/lib/jobs/store";
import type { LogFields } from "@/lib/log/logger";

/*
 * Refreshing a connection's credential before it is used: by a sync (#44), and by automatic webhook
 * setup and its removal on disconnect (#496), which call the provider outside any sync job.
 *
 * Providers that rotate refresh tokens invalidate one once it is used, so two refreshes of one
 * connection that read the same token race, and the loser spends a dead token and loses the
 * connection. Every refresh therefore runs under the connection's refresh lock
 * (credential_refresh_locks, 20261116170000_credential_refresh_locks.sql) and re-reads the
 * credential once it holds it: a refresh that finished while this one waited has already saved a
 * fresh credential, and the token read before waiting is spent.
 *
 * The lease is what keeps a second holder out, so the refresh token is spent only while enough of it
 * is left: the provider's whole request timeout (`ctx.timeoutMs`) plus REFRESH_SAVE_MARGIN_MS for
 * the save. Its end is measured on this server's clock from just before the winning acquire call;
 * the database starts the lease at that moment or later, so the estimate is never later than the
 * real end. What the lease cannot fence: a save that stalls after the provider has answered. The
 * new token is then spent and held only in memory, and a holder that takes the lease over meanwhile
 * re-reads the old one; such a save is logged (`credential_refresh.not_saved`) when it fails.
 */

// Refresh this long before the access token expires, so a token never expires mid-use.
export const TOKEN_REFRESH_SKEW_MS = 5 * 60_000;
// Longer than one refresh can take: the adapter's request timeout (`ctx.timeoutMs`, 15 seconds in
// production) plus saving the result. A holder that dies frees the lock when this runs out.
export const REFRESH_LOCK_LEASE_SECONDS = 60;
// Lease time kept back, beyond the provider's timeout, for saving the refreshed credential.
export const REFRESH_SAVE_MARGIN_MS = 10_000;
// While another refresh holds the lock, ask again this often, this many times: about 20 seconds,
// enough for a live holder to finish, after which the credential it saved is used as it is.
export const REFRESH_LOCK_RETRY_MS = 1000;
export const REFRESH_LOCK_ATTEMPTS = 20;

export type CredentialRefreshStore = Pick<
  JobStore,
  "loadCredential" | "saveCredential" | "acquireCredentialRefreshLock" | "releaseCredentialRefreshLock"
>;

export type CredentialRefreshDeps = Readonly<{
  store: CredentialRefreshStore;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  logError: (event: string, error: unknown, fields?: LogFields) => string;
}>;

/**
 * The refresh could not run safely under the lock: another refresh held it for longer than this one
 * waited, or too little of this one's lease was left to spend the refresh token. Nothing was spent.
 */
export class CredentialRefreshBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialRefreshBusyError";
  }
}

function needsRefresh(adapter: ProviderAdapter, credential: OAuthCredential, now: Date): boolean {
  if (adapter.refreshTokens === undefined || credential.expiresAt === undefined) return false;
  return credential.expiresAt.getTime() - now.getTime() <= TOKEN_REFRESH_SKEW_MS;
}

type HeldLock = Readonly<{ lockId: string; leaseEndsAt: number }>;

async function acquireLock(key: ConnectionKey, deps: CredentialRefreshDeps): Promise<HeldLock> {
  for (let attempt = 1; ; attempt += 1) {
    const askedAt = deps.now().getTime();
    const lockId = await deps.store.acquireCredentialRefreshLock(key, REFRESH_LOCK_LEASE_SECONDS);
    if (lockId !== null) return { lockId, leaseEndsAt: askedAt + REFRESH_LOCK_LEASE_SECONDS * 1000 };
    if (attempt >= REFRESH_LOCK_ATTEMPTS) {
      throw new CredentialRefreshBusyError("Another refresh of the connection's credential is still running.");
    }
    await deps.sleep(REFRESH_LOCK_RETRY_MS);
  }
}

/**
 * Returns `credential` when it is not within TOKEN_REFRESH_SKEW_MS of expiry (or the adapter cannot
 * refresh); otherwise refreshes it under the connection's refresh lock and saves the result before
 * returning it. A rotated refresh token must be persisted at once: if it were lost, the connection
 * could never refresh again. A failed refresh or save is thrown.
 */
export async function refreshIfExpiring(
  adapter: ProviderAdapter,
  credential: OAuthCredential,
  key: ConnectionKey,
  ctx: OAuthContext,
  deps: CredentialRefreshDeps,
): Promise<OAuthCredential> {
  if (adapter.refreshTokens === undefined || !needsRefresh(adapter, credential, deps.now())) return credential;

  const lock = await acquireLock(key, deps);
  try {
    const current = await deps.store.loadCredential(key);
    if (current === null) throw new Error("The connection's credential was deleted before it could be refreshed.");
    if (!needsRefresh(adapter, current, deps.now())) return current;
    if (lock.leaseEndsAt - deps.now().getTime() <= ctx.timeoutMs + REFRESH_SAVE_MARGIN_MS) {
      throw new CredentialRefreshBusyError("Too little of the refresh lock's lease was left to refresh the credential.");
    }

    const refreshed = await adapter.refreshTokens(current, ctx);
    try {
      await deps.store.saveCredential(key, refreshed);
    } catch (error) {
      // The old refresh token may already be spent. Logged distinctly so an operator can see why
      // the connection will ask to be reconnected on its next sync.
      deps.logError("credential_refresh.not_saved", error, { connectionId: key.connectionId, provider: adapter.id });
      throw error;
    }
    return refreshed;
  } finally {
    try {
      await deps.store.releaseCredentialRefreshLock(key, lock.lockId);
    } catch (error) {
      // Handled by the lease: the lock frees itself within REFRESH_LOCK_LEASE_SECONDS. Not rethrown,
      // so it never hides the refresh's own outcome.
      deps.logError("credential_refresh.release_failed", error, { connectionId: key.connectionId, provider: adapter.id });
    }
  }
}
