import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AuthRevokedError } from "@/lib/adapters/errors";
import { getAdapter, loadOAuthClient } from "@/lib/adapters/registry";
import { simulatedAdapters } from "@/lib/adapters/simulated";
import { Secret, type ConnectionWebhookSetup, type OAuthCredential, type ProviderAdapter } from "@/lib/adapters/types";
import {
  acquireCredentialRefreshLock,
  loadCredential,
  releaseCredentialRefreshLock,
  saveCredential,
} from "@/lib/data/credentials";
import type * as EndpointsModule from "@/lib/data/webhook-endpoints";
import {
  countWorkspaceWebhookEndpoints,
  deleteWebhookEndpoint,
  getConnectionWebhook,
  insertWebhookEndpoint,
  WebhookEndpointExistsError,
  WebhookEndpointLimitError,
} from "@/lib/data/webhook-endpoints";
import { logError } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { fakeSupabase } from "@/lib/supabase/fake-postgrest";

import { TOKEN_REFRESH_SKEW_MS } from "./credential-refresh";
import { WEBHOOK_ENDPOINTS_PER_WORKSPACE } from "./webhook-copy";
import {
  removeConnectionWebhook,
  setUpWebhookAutomatically,
  setUpWebhookByHand,
  webhookRemovalMessage,
  webhookUrl,
  webhookWritePermissions,
} from "./webhook-setup";

/*
 * Webhook setup and removal (#426) against GitLab's and Resend's simulated declarations, with the
 * endpoint repository, the credential store, and the registry replaced: what is asked of the
 * provider, what is stored, and in which order.
 */

vi.mock("@/lib/data/webhook-endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof EndpointsModule>();
  return {
    ...actual,
    countWorkspaceWebhookEndpoints: vi.fn(),
    deleteWebhookEndpoint: vi.fn(),
    getConnectionWebhook: vi.fn(),
    insertWebhookEndpoint: vi.fn(),
    replaceWebhookEndpointSecret: vi.fn(),
  };
});
vi.mock("@/lib/data/credentials", () => ({
  loadCredential: vi.fn(),
  saveCredential: vi.fn(),
  acquireCredentialRefreshLock: vi.fn(),
  releaseCredentialRefreshLock: vi.fn(),
}));
vi.mock("@/lib/adapters/registry", () => ({ getAdapter: vi.fn(), loadOAuthClient: vi.fn(), createOAuthContext: vi.fn(() => ({})) }));
vi.mock("@/lib/supabase/admin");
vi.mock("@/lib/log/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, logError: vi.fn(() => "ref123") }));

const WORKSPACE_ID = "42600000-0000-4000-8000-000000000001";
const CONNECTION_ID = "42600000-0000-4000-8000-000000000002";
const ORIGIN = "https://stackdash.example";

const client = { clientId: "simulated", clientSecret: new Secret("simulated"), extra: {} };

function credential(scopes: readonly string[]): OAuthCredential {
  return { accessToken: new Secret("simulated-at"), scopes, tokenType: "bearer" };
}

const WRITE_SCOPES = ["simulated:read", "simulated:webhooks:write"];
const KEY = { workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID };

function expiringIn(ms: number): OAuthCredential {
  return { ...credential(WRITE_SCOPES), refreshToken: new Secret("rt-1"), expiresAt: new Date(Date.now() + ms) };
}

const REFRESHED: OAuthCredential = {
  accessToken: new Secret("refreshed-at"),
  refreshToken: new Secret("rt-2"),
  expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
  scopes: WRITE_SCOPES,
  tokenType: "bearer",
};

/** `spied` with a refresh that rotates the token, as GitLab's does (#496). */
function refreshing(spied: ProviderAdapter) {
  const refreshTokens = vi.fn<(current: OAuthCredential) => Promise<OAuthCredential>>(() => Promise.resolve(REFRESHED));
  const adapter: ProviderAdapter = { ...spied, refreshTokens };
  vi.mocked(getAdapter).mockReturnValue(adapter);
  return { adapter, refreshTokens };
}

const PROVIDER_SECRET = new Secret("whsec_provider");

/** A copy of a simulated adapter whose automatic create and remove are spies. */
function withSpies(adapter: ProviderAdapter) {
  const webhooks = adapter.webhooks;
  const registration = webhooks?.registration;
  if (webhooks === undefined || registration?.kind !== "connection" || registration.setup.automatic === undefined) {
    throw new Error("expected automatic setup");
  }
  const declared = registration.setup;
  const extraPermissions = declared.automatic?.extraPermissions ?? [];
  // Returns the provider's secret whichever arm calls it; a StackDash-secret provider ignores it.
  const create = vi.fn(() => Promise.resolve({ webhookId: "hook_1", secret: PROVIDER_SECRET }));
  const remove = vi.fn(() => Promise.resolve());
  const setup: ConnectionWebhookSetup =
    declared.secretSource === "stackdash"
      ? { ...declared, automatic: { extraPermissions, create, remove } }
      : { ...declared, automatic: { extraPermissions, create, remove } };
  const spied: ProviderAdapter = { ...adapter, webhooks: { ...webhooks, registration: { kind: "connection", setup } } };
  vi.mocked(getAdapter).mockReturnValue(spied);
  return { adapter: spied, setup, create, remove };
}

const target = (adapter: ProviderAdapter, setup: ConnectionWebhookSetup) => ({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, adapter, setup });

beforeEach(() => {
  vi.mocked(countWorkspaceWebhookEndpoints).mockResolvedValue(0);
  vi.mocked(getConnectionWebhook).mockResolvedValue(null);
  vi.mocked(insertWebhookEndpoint).mockResolvedValue();
  vi.mocked(saveCredential).mockResolvedValue();
  vi.mocked(acquireCredentialRefreshLock).mockResolvedValue("lock_1");
  vi.mocked(releaseCredentialRefreshLock).mockResolvedValue();
  vi.mocked(loadOAuthClient).mockReturnValue(client);
  const { db } = fakeSupabase({
    external_accounts: [
      { workspace_id: WORKSPACE_ID, connection_id: CONNECTION_ID, external_id: "acct_2", included: true },
      { workspace_id: WORKSPACE_ID, connection_id: CONNECTION_ID, external_id: "acct_1", included: false },
    ],
  });
  vi.mocked(createAdminClient).mockReturnValue(db);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("setUpWebhookByHand", () => {
  it("creates the endpoint and returns StackDash's secret once, asking the provider nothing (GitLab)", async () => {
    const { adapter, setup, create } = withSpies(simulatedAdapters.gitlab);
    const outcome = await setUpWebhookByHand(target(adapter, setup));
    expect(outcome.kind).toBe("manual");
    if (outcome.kind !== "manual") return;
    expect(outcome.secret?.reveal()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(insertWebhookEndpoint).toHaveBeenCalledWith(
      expect.objectContaining({ id: outcome.endpointId, setup: { mode: "manual", awaitingProviderSecret: false } }),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("returns no secret and waits for the provider's where the provider generates it (Resend)", async () => {
    const { adapter, setup } = withSpies(simulatedAdapters.resend);
    const outcome = await setUpWebhookByHand(target(adapter, setup));
    expect(outcome).toEqual({ kind: "manual", endpointId: expect.any(String), secret: null });
    expect(insertWebhookEndpoint).toHaveBeenCalledWith(expect.objectContaining({ setup: { mode: "manual", awaitingProviderSecret: true } }));
  });

  it.each([
    ["at the limit", WEBHOOK_ENDPOINTS_PER_WORKSPACE, undefined, "limit_reached"],
    ["one under the limit, but a concurrent setup took the last place", WEBHOOK_ENDPOINTS_PER_WORKSPACE - 1, new WebhookEndpointLimitError("full"), "limit_reached"],
    ["set up already by a second click", 0, new WebhookEndpointExistsError("exists"), "already_set_up"],
  ] as const)("refuses %s (boundary)", async (_case, count, insertError, kind) => {
    const { adapter, setup } = withSpies(simulatedAdapters.gitlab);
    vi.mocked(countWorkspaceWebhookEndpoints).mockResolvedValue(count);
    if (insertError !== undefined) vi.mocked(insertWebhookEndpoint).mockRejectedValue(insertError);
    expect(await setUpWebhookByHand(target(adapter, setup))).toEqual({ kind });
  });
});

describe("setUpWebhookAutomatically", () => {
  it("creates the webhook at the provider with the connection's URL and included accounts, then stores it", async () => {
    const { adapter, setup, create } = withSpies(simulatedAdapters.gitlab);
    vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read", "simulated:webhooks:write"]));

    expect(await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN })).toEqual({ kind: "automatic" });

    const stored = vi.mocked(insertWebhookEndpoint).mock.calls[0]?.[0];
    expect(stored?.setup).toEqual({ mode: "automatic", providerWebhookId: "hook_1" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ url: webhookUrl(ORIGIN, "gitlab", stored?.id ?? ""), externalAccountIds: ["acct_2"] }),
      expect.anything(),
    );
  });

  it("stores the provider's own signing secret where the provider generates it (Resend)", async () => {
    const { adapter, setup } = withSpies(simulatedAdapters.resend);
    vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read"]));
    await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN });
    expect(vi.mocked(insertWebhookEndpoint).mock.calls[0]?.[0].secret).toBe(PROVIDER_SECRET);
  });

  it("stores StackDash's own secret, the one it sent, where StackDash generates it (GitLab)", async () => {
    const { adapter, setup, create } = withSpies(simulatedAdapters.gitlab);
    vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read", "simulated:webhooks:write"]));
    await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN });
    const stored = vi.mocked(insertWebhookEndpoint).mock.calls[0]?.[0].secret;
    expect(stored).not.toBe(PROVIDER_SECRET);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ secret: stored }), expect.anything());
  });

  it("asks the provider nothing when the grant lacks the write scope (boundary: consent not given)", async () => {
    const { adapter, setup, create } = withSpies(simulatedAdapters.gitlab);
    vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read"]));
    expect(await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN })).toEqual({ kind: "write_access_missing" });
    expect(create).not.toHaveBeenCalled();
  });

  it("deletes the webhook at the provider again when the endpoint cannot be stored (boundary: limit reached in a race)", async () => {
    const { adapter, setup, remove } = withSpies(simulatedAdapters.gitlab);
    vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read", "simulated:webhooks:write"]));
    vi.mocked(insertWebhookEndpoint).mockRejectedValue(new WebhookEndpointLimitError("full"));
    expect(await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN })).toEqual({ kind: "limit_reached" });
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ webhookId: "hook_1" }), expect.anything());
  });

  it("asks the provider nothing when the connection has a webhook already (boundary: repeat or stale tab)", async () => {
    const { adapter, setup, create, remove } = withSpies(simulatedAdapters.gitlab);
    vi.mocked(getConnectionWebhook).mockResolvedValue({ id: "e", setupMode: "automatic", awaitingProviderSecret: false, lastDeliveryAt: null });
    vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read", "simulated:webhooks:write"]));
    expect(await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN })).toEqual({ kind: "already_set_up" });
    expect(create).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("refuses before any call when the provider is no longer set up on this instance (boundary)", async () => {
    const { adapter, setup, create } = withSpies(simulatedAdapters.resend);
    vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read"]));
    vi.mocked(loadOAuthClient).mockReturnValue(null);
    expect(await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN })).toEqual({ kind: "not_configured" });
    expect(create).not.toHaveBeenCalled();
  });

  it("refreshes an expiring credential and saves it before creating the webhook with it (#496)", async () => {
    const spies = withSpies(simulatedAdapters.gitlab);
    const { adapter, refreshTokens } = refreshing(spies.adapter);
    const stored = expiringIn(60_000);
    vi.mocked(loadCredential).mockResolvedValue(stored);

    expect(await setUpWebhookAutomatically({ ...target(adapter, spies.setup), origin: ORIGIN })).toEqual({ kind: "automatic" });

    expect(refreshTokens).toHaveBeenCalledExactlyOnceWith(stored, expect.anything());
    expect(saveCredential).toHaveBeenCalledWith({ ...KEY, credential: REFRESHED });
    expect(spies.create).toHaveBeenCalledWith(expect.objectContaining({ credential: REFRESHED }), expect.anything());
    expect(vi.mocked(saveCredential).mock.invocationCallOrder[0]).toBeLessThan(spies.create.mock.invocationCallOrder[0] ?? 0);
    expect(releaseCredentialRefreshLock).toHaveBeenCalledWith(KEY, "lock_1");
  });

  it("creates with an unexpired credential as it is, without the refresh lock (boundary: outside the skew)", async () => {
    const spies = withSpies(simulatedAdapters.gitlab);
    const { adapter, refreshTokens } = refreshing(spies.adapter);
    const stored = expiringIn(TOKEN_REFRESH_SKEW_MS + 60_000);
    vi.mocked(loadCredential).mockResolvedValue(stored);

    await setUpWebhookAutomatically({ ...target(adapter, spies.setup), origin: ORIGIN });

    expect(refreshTokens).not.toHaveBeenCalled();
    expect(acquireCredentialRefreshLock).not.toHaveBeenCalled();
    expect(spies.create).toHaveBeenCalledWith(expect.objectContaining({ credential: stored }), expect.anything());
  });

  it("refuses setup, creating nothing at the provider or here, when the refresh fails (boundary: refresh refused)", async () => {
    const spies = withSpies(simulatedAdapters.gitlab);
    const { adapter, refreshTokens } = refreshing(spies.adapter);
    refreshTokens.mockRejectedValue(new AuthRevokedError("invalid_grant"));
    vi.mocked(loadCredential).mockResolvedValue(expiringIn(60_000));

    await expect(setUpWebhookAutomatically({ ...target(adapter, spies.setup), origin: ORIGIN })).rejects.toBeInstanceOf(AuthRevokedError);

    expect(spies.create).not.toHaveBeenCalled();
    expect(insertWebhookEndpoint).not.toHaveBeenCalled();
    expect(saveCredential).not.toHaveBeenCalled();
    expect(releaseCredentialRefreshLock).toHaveBeenCalledWith(KEY, "lock_1");
  });
});

describe("removeConnectionWebhook", () => {
  it("deletes an automatic webhook at the provider with the stored credential", async () => {
    const { remove } = withSpies(simulatedAdapters.gitlab);
    vi.mocked(deleteWebhookEndpoint).mockResolvedValue({ setupMode: "automatic", providerWebhookId: "hook_9" });
    vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read", "simulated:webhooks:write"]));
    const removal = await removeConnectionWebhook({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, provider: "gitlab" });
    expect(removal).toEqual({ kind: "removed" });
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ webhookId: "hook_9" }), expect.anything());
    expect(webhookRemovalMessage("gitlab", removal)).toBe("StackDash deleted its webhook in GitLab.");
  });

  it("leaves a webhook added by hand to the user, with the provider's steps", async () => {
    const { remove } = withSpies(simulatedAdapters.gitlab);
    vi.mocked(deleteWebhookEndpoint).mockResolvedValue({ setupMode: "manual", providerWebhookId: null });
    const removal = await removeConnectionWebhook({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, provider: "gitlab" });
    expect(removal).toEqual({ kind: "manual" });
    expect(remove).not.toHaveBeenCalled();
    expect(webhookRemovalMessage("gitlab", removal)).toBe(
      "Remove the webhook you added in GitLab: In GitLab, open the group, then Settings, then Webhooks, and choose Delete next to the StackDash webhook.",
    );
  });

  it("says nothing when the connection had no webhook (boundary: none)", async () => {
    vi.mocked(deleteWebhookEndpoint).mockResolvedValue(null);
    const removal = await removeConnectionWebhook({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, provider: "gitlab" });
    expect(removal).toEqual({ kind: "none" });
    expect(webhookRemovalMessage("gitlab", removal)).toBeNull();
  });

  it("returns a failed deletion with its reference and the steps instead of throwing (boundary: provider fails)", async () => {
    const { remove } = withSpies(simulatedAdapters.gitlab);
    remove.mockRejectedValue(new Error("provider down"));
    vi.mocked(deleteWebhookEndpoint).mockResolvedValue({ setupMode: "automatic", providerWebhookId: "hook_9" });
    vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read", "simulated:webhooks:write"]));
    const removal = await removeConnectionWebhook({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, provider: "gitlab" });
    expect(removal).toEqual({ kind: "failed", referenceId: "ref123" });
    expect(logError).toHaveBeenCalledWith("webhook_setup.remove_failed", expect.any(Error), expect.objectContaining({ provider: "gitlab" }));
    expect(webhookRemovalMessage("gitlab", removal)).toMatch(/^StackDash could not delete its webhook in GitLab \(reference ref123\)\. In GitLab, open/);
  });

  it("refreshes an expiring credential and saves it before deleting the webhook with it (#496)", async () => {
    const spies = withSpies(simulatedAdapters.gitlab);
    const { refreshTokens } = refreshing(spies.adapter);
    vi.mocked(deleteWebhookEndpoint).mockResolvedValue({ setupMode: "automatic", providerWebhookId: "hook_9" });
    vi.mocked(loadCredential).mockResolvedValue(expiringIn(-1));

    const removal = await removeConnectionWebhook({ ...KEY, provider: "gitlab" });

    expect(removal).toEqual({ kind: "removed" });
    expect(refreshTokens).toHaveBeenCalledOnce();
    expect(saveCredential).toHaveBeenCalledWith({ ...KEY, credential: REFRESHED });
    expect(spies.remove).toHaveBeenCalledWith({ credential: REFRESHED, webhookId: "hook_9" }, expect.anything());
  });

  it("gives the steps by hand, with a reference, when the refresh fails (boundary: refresh refused on disconnect)", async () => {
    const spies = withSpies(simulatedAdapters.gitlab);
    const { refreshTokens } = refreshing(spies.adapter);
    refreshTokens.mockRejectedValue(new AuthRevokedError("invalid_grant"));
    vi.mocked(deleteWebhookEndpoint).mockResolvedValue({ setupMode: "automatic", providerWebhookId: "hook_9" });
    vi.mocked(loadCredential).mockResolvedValue(expiringIn(60_000));

    const removal = await removeConnectionWebhook({ ...KEY, provider: "gitlab" });

    expect(removal).toEqual({ kind: "failed", referenceId: "ref123" });
    expect(spies.remove).not.toHaveBeenCalled();
    expect(logError).toHaveBeenCalledWith("webhook_setup.remove_failed", expect.any(AuthRevokedError), expect.objectContaining({ provider: "gitlab" }));
    expect(webhookRemovalMessage("gitlab", removal)).toMatch(/^StackDash could not delete its webhook in GitLab \(reference ref123\)\. In GitLab, open/);
  });
});

describe("webhookWritePermissions", () => {
  it("asks for the write scope when the user chose automatic setup, or the webhook is automatic already", async () => {
    const { adapter } = withSpies(simulatedAdapters.gitlab);
    const chosen = await webhookWritePermissions({ adapter, workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, chosen: true });
    expect(chosen.map((permission) => permission.scope)).toEqual(["simulated:webhooks:write"]);
    vi.mocked(getConnectionWebhook).mockResolvedValue({ id: "e", setupMode: "automatic", awaitingProviderSecret: false, lastDeliveryAt: null });
    expect(await webhookWritePermissions({ adapter, workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, chosen: false })).toEqual(chosen);
  });

  it.each([
    ["a first connect", "gitlab", undefined, null],
    ["a reconnect of a webhook added by hand", "gitlab", CONNECTION_ID, "manual"],
    ["a reconnect without a webhook", "gitlab", CONNECTION_ID, null],
    ["a provider whose automatic setup needs no new scope", "resend", CONNECTION_ID, "automatic"],
  ] as const)("asks for nothing more on %s (boundary)", async (_case, id, connectionId, mode) => {
    vi.mocked(getConnectionWebhook).mockResolvedValue(mode === null ? null : { id: "e", setupMode: mode, awaitingProviderSecret: false, lastDeliveryAt: null });
    expect(await webhookWritePermissions({ adapter: simulatedAdapters[id], workspaceId: WORKSPACE_ID, connectionId, chosen: false })).toEqual([]);
  });
});
