import { describe, expect, it, vi } from "vitest";

import { AuthRevokedError } from "@/lib/adapters/errors";
import { fakeAdapter } from "@/lib/adapters/fake";
import { Secret, type OAuthContext, type OAuthCredential, type ProviderAdapter } from "@/lib/adapters/types";
import { MemoryJobStore } from "@/lib/jobs/memory-store";

import {
  CredentialRefreshBusyError,
  REFRESH_LOCK_ATTEMPTS,
  REFRESH_LOCK_LEASE_SECONDS,
  REFRESH_LOCK_RETRY_MS,
  refreshIfExpiring,
  TOKEN_REFRESH_SKEW_MS,
  type CredentialRefreshDeps,
} from "./credential-refresh";

/*
 * The shared refresh (#44, #496) against the in-memory store, whose refresh lock behaves as
 * acquire_credential_refresh_lock does: what is refreshed, what is saved, and that two refreshes
 * of one connection never spend the same refresh token.
 */

const NOW = new Date("2026-11-16T12:00:00.000Z");
const KEY = { workspaceId: "49600000-0000-4000-8000-000000000001", connectionId: "49600000-0000-4000-8000-000000000002" };

const ctx: OAuthContext = {
  client: { clientId: "client", clientSecret: new Secret("client-secret"), extra: {} },
  fetch: () => Promise.reject(new Error("no network in tests")),
  now: () => NOW,
  timeoutMs: 1000,
  logger: { info: () => {}, warn: () => {}, error: () => {} },
};

function credential(refreshToken: string, expiresInMs: number): OAuthCredential {
  return {
    accessToken: new Secret(`at-${refreshToken}`),
    refreshToken: new Secret(refreshToken),
    expiresAt: new Date(NOW.getTime() + expiresInMs),
    scopes: ["read"],
    tokenType: "bearer",
  };
}

/** A provider with rotating refresh tokens: each token works once, as GitLab's and Railway's do. */
function rotatingAdapter() {
  const spent: string[] = [];
  const refreshTokens = vi.fn(async (current: OAuthCredential) => {
    const token = current.refreshToken?.reveal() ?? "";
    if (spent.includes(token)) throw new AuthRevokedError("refresh token already used");
    spent.push(token);
    return credential(`${token}+`, 2 * 60 * 60_000);
  });
  const adapter: ProviderAdapter = { ...fakeAdapter, refreshTokens };
  return { adapter, refreshTokens, spent };
}

function harness(stored: OAuthCredential | null) {
  const store = new MemoryJobStore(() => NOW);
  if (stored !== null) store.credentials.set(KEY.connectionId, stored);
  const logError = vi.fn<(event: string, error: unknown) => string>(() => "REF-TEST");
  // Waiting costs nothing here; a test that needs the wait to mean something replaces it.
  const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
  const deps: CredentialRefreshDeps = { store, now: () => NOW, sleep, logError };
  return { store, deps, sleep, logError };
}

describe("refreshIfExpiring", () => {
  it("refreshes a token at exactly the skew and saves the rotated one before returning it", async () => {
    const original = credential("rt-1", TOKEN_REFRESH_SKEW_MS);
    const { store, deps } = harness(original);
    const { adapter, refreshTokens } = rotatingAdapter();

    const result = await refreshIfExpiring(adapter, original, KEY, ctx, deps);

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(result.refreshToken?.reveal()).toBe("rt-1+");
    expect(store.savedCredentials).toEqual([result]);
    expect(store.refreshLocks.size).toBe(0);
  });

  const { expiresAt: _never, ...noExpiry } = credential("rt-1", 0);
  it.each([
    ["a token 1 ms past the skew", credential("rt-1", TOKEN_REFRESH_SKEW_MS + 1)],
    ["a credential with no expiry", noExpiry],
  ])("returns %s as it is, without the lock (boundary)", async (_case, stored) => {
    const { store, deps } = harness(stored);
    const { adapter, refreshTokens } = rotatingAdapter();
    expect(await refreshIfExpiring(adapter, stored, KEY, ctx, deps)).toBe(stored);
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(store.savedCredentials).toHaveLength(0);
  });

  it("returns an expired credential as it is when the adapter cannot refresh (boundary)", async () => {
    const stored = credential("rt-1", -1);
    const { deps } = harness(stored);
    const { refreshTokens: _omitted, ...adapter } = fakeAdapter;
    expect(await refreshIfExpiring(adapter, stored, KEY, ctx, deps)).toBe(stored);
  });

  it("spends the refresh token once when two refreshes of one connection start together (race)", async () => {
    const original = credential("rt-1", 60_000);
    const { store, deps, sleep } = harness(original);
    const { adapter, refreshTokens } = rotatingAdapter();
    // The one that finds the lock held waits until the holder frees it.
    const released = Promise.withResolvers<void>();
    const release = store.releaseCredentialRefreshLock.bind(store);
    vi.spyOn(store, "releaseCredentialRefreshLock").mockImplementation(async (key, lockId) => {
      await release(key, lockId);
      released.resolve();
    });
    sleep.mockImplementation(() => released.promise);
    // A sync and a webhook setup that both read the same expiring credential.
    const [first, second] = await Promise.all([
      refreshIfExpiring(adapter, original, KEY, ctx, deps),
      refreshIfExpiring(adapter, original, KEY, ctx, deps),
    ]);

    expect(refreshTokens).toHaveBeenCalledTimes(1);
    expect(first.refreshToken?.reveal()).toBe("rt-1+");
    // The second waited for the lock, then re-read the credential the first had saved.
    expect(second).toBe(first);
    expect(store.savedCredentials).toEqual([first]);
    expect(store.refreshLocks.size).toBe(0);
  });

  it("uses the credential another holder saved while it waited, without refreshing (race: a sync holds the lock)", async () => {
    const original = credential("rt-1", 60_000);
    const { store, deps, sleep } = harness(original);
    const { adapter, refreshTokens } = rotatingAdapter();
    const syncLock = await store.acquireCredentialRefreshLock(KEY, REFRESH_LOCK_LEASE_SECONDS);
    if (syncLock === null) throw new Error("expected the lock");
    const savedBySync = credential("rt-1+", 2 * 60 * 60_000);
    sleep.mockImplementationOnce(async () => {
      await store.saveCredential(KEY, savedBySync);
      await store.releaseCredentialRefreshLock(KEY, syncLock);
    });

    expect(await refreshIfExpiring(adapter, original, KEY, ctx, deps)).toBe(savedBySync);
    expect(sleep).toHaveBeenCalledWith(REFRESH_LOCK_RETRY_MS);
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it("gives up without refreshing when the lock stays held (boundary: last attempt)", async () => {
    const original = credential("rt-1", 60_000);
    const { store, deps, sleep } = harness(original);
    const { adapter, refreshTokens } = rotatingAdapter();
    await store.acquireCredentialRefreshLock(KEY, REFRESH_LOCK_LEASE_SECONDS);

    await expect(refreshIfExpiring(adapter, original, KEY, ctx, deps)).rejects.toBeInstanceOf(CredentialRefreshBusyError);
    expect(sleep).toHaveBeenCalledTimes(REFRESH_LOCK_ATTEMPTS - 1);
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it("takes over a lock whose holder died once its lease has run out (boundary: expired lease)", async () => {
    const original = credential("rt-1", 60_000);
    const { store, deps, sleep } = harness(original);
    const { adapter, refreshTokens } = rotatingAdapter();
    store.refreshLocks.set(KEY.connectionId, { lockId: "dead-holder", lockedUntil: new Date(NOW.getTime() - 1) });

    await refreshIfExpiring(adapter, original, KEY, ctx, deps);

    expect(sleep).not.toHaveBeenCalled();
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it("throws a refused refresh, saves nothing, and frees the lock (boundary: provider refuses)", async () => {
    const original = credential("rt-1", 60_000);
    const { store, deps } = harness(original);
    const { adapter, refreshTokens } = rotatingAdapter();
    refreshTokens.mockRejectedValueOnce(new AuthRevokedError("invalid_grant"));

    await expect(refreshIfExpiring(adapter, original, KEY, ctx, deps)).rejects.toBeInstanceOf(AuthRevokedError);
    expect(store.savedCredentials).toHaveLength(0);
    expect(store.refreshLocks.size).toBe(0);
  });

  it("logs and throws a rotated credential it could not save, and frees the lock (boundary: save fails)", async () => {
    const original = credential("rt-1", 60_000);
    const { store, deps, logError } = harness(original);
    const { adapter } = rotatingAdapter();
    vi.spyOn(store, "saveCredential").mockRejectedValueOnce(new Error("database down"));

    await expect(refreshIfExpiring(adapter, original, KEY, ctx, deps)).rejects.toThrow("database down");
    expect(logError).toHaveBeenCalledWith("credential_refresh.not_saved", expect.any(Error), expect.objectContaining({ connectionId: KEY.connectionId }));
    expect(store.refreshLocks.size).toBe(0);
  });

  it("returns the refreshed credential when freeing the lock fails, leaving it to its lease (boundary: release fails)", async () => {
    const original = credential("rt-1", 60_000);
    const { store, deps, logError } = harness(original);
    const { adapter } = rotatingAdapter();
    vi.spyOn(store, "releaseCredentialRefreshLock").mockRejectedValueOnce(new Error("database down"));

    expect((await refreshIfExpiring(adapter, original, KEY, ctx, deps)).refreshToken?.reveal()).toBe("rt-1+");
    expect(logError).toHaveBeenCalledWith("credential_refresh.release_failed", expect.any(Error), expect.anything());
  });

  it("throws when the credential was deleted while it waited for the lock (boundary: disconnected meanwhile)", async () => {
    const original = credential("rt-1", 60_000);
    const { deps } = harness(null);
    const { adapter, refreshTokens } = rotatingAdapter();
    await expect(refreshIfExpiring(adapter, original, KEY, ctx, deps)).rejects.toThrow(/deleted/);
    expect(refreshTokens).not.toHaveBeenCalled();
  });
});
