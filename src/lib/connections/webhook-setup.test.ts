import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getAdapter, loadOAuthClient } from "@/lib/adapters/registry";
import { simulatedAdapters } from "@/lib/adapters/simulated";
import {
  Secret,
  type ConnectionWebhookSetup,
  type OAuthCredential,
  type PerSourceWebhookSetup,
  type ProviderAdapter,
  type WebhookSource,
} from "@/lib/adapters/types";
import { loadCredential } from "@/lib/data/credentials";
import type * as EndpointsModule from "@/lib/data/webhook-endpoints";
import {
  countWorkspaceWebhookEndpoints,
  deleteWebhookEndpoint,
  getConnectionWebhook,
  getWebhookEndpointSetup,
  insertWebhookEndpoint,
  listWebhookSources,
  loadWebhookEndpoint,
  noteSourceWithoutWebhook,
  saveCreatedWebhookSource,
  WEBHOOK_SOURCES_PER_ENDPOINT,
  WebhookEndpointExistsError,
  WebhookEndpointLimitError,
  WebhookSourceLimitError,
  type ConnectionWebhook,
  type SourceWebhook,
} from "@/lib/data/webhook-endpoints";
import { log, logError } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { fakeSupabase } from "@/lib/supabase/fake-postgrest";

import { WEBHOOK_ENDPOINTS_PER_WORKSPACE } from "./webhook-copy";
import {
  addMissingSourceWebhooks,
  removeConnectionWebhook,
  setUpWebhookAutomatically,
  setUpWebhookByHand,
  webhookRemovalMessage,
  webhookUrl,
  webhookWritePermissions,
} from "./webhook-setup";

/*
 * Webhook setup and removal (#426, #428) against GitLab's and Resend's simulated declarations, with
 * the endpoint repository, the credential store, and the registry replaced: what is asked of the
 * provider, what is stored, and in which order. `withSpies` turns a declaration into one webhook per
 * connection (as Resend's is), `withSourceSpies` keeps GitLab's one webhook per project.
 */

vi.mock("@/lib/data/webhook-endpoints", async (importOriginal) => {
  const actual = await importOriginal<typeof EndpointsModule>();
  return {
    ...actual,
    countWorkspaceWebhookEndpoints: vi.fn(),
    deleteWebhookEndpoint: vi.fn(),
    getConnectionWebhook: vi.fn(),
    getWebhookEndpointSetup: vi.fn(),
    insertWebhookEndpoint: vi.fn(),
    listWebhookSources: vi.fn(),
    loadWebhookEndpoint: vi.fn(),
    noteSourceWithoutWebhook: vi.fn(),
    replaceWebhookEndpointSecret: vi.fn(),
    saveCreatedWebhookSource: vi.fn(),
  };
});
vi.mock("@/lib/data/credentials", () => ({ loadCredential: vi.fn() }));
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

const PROVIDER_SECRET = new Secret("whsec_provider");

/** The connection's webhook as getConnectionWebhook reads it. */
const stored = (setupMode: ConnectionWebhook["setupMode"], perSource = false): ConnectionWebhook => ({
  id: "e",
  setupMode,
  perSource,
  awaitingProviderSecret: false,
  lastDeliveryAt: null,
});

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
  vi.mocked(loadOAuthClient).mockReturnValue(client);
  const { db } = fakeSupabase({
    external_accounts: [
      { workspace_id: WORKSPACE_ID, connection_id: CONNECTION_ID, external_id: "acct_2", display_name: "acct-two", included: true },
      { workspace_id: WORKSPACE_ID, connection_id: CONNECTION_ID, external_id: "acct_1", display_name: "acct-one", included: false },
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
    vi.mocked(getConnectionWebhook).mockResolvedValue(stored("automatic"));
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
});

describe("removeConnectionWebhook", () => {
  it("deletes an automatic webhook at the provider with the stored credential", async () => {
    const { remove } = withSpies(simulatedAdapters.gitlab);
    vi.mocked(deleteWebhookEndpoint).mockResolvedValue({ setupMode: "automatic", providerWebhookId: "hook_9", sourceWebhooks: [] });
    vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read", "simulated:webhooks:write"]));
    const removal = await removeConnectionWebhook({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, provider: "gitlab" });
    expect(removal).toEqual({ kind: "removed" });
    expect(remove).toHaveBeenCalledWith(expect.objectContaining({ webhookId: "hook_9" }), expect.anything());
    expect(webhookRemovalMessage("gitlab", removal)).toBe("StackDash deleted its webhook in GitLab.");
  });

  it("leaves a webhook added by hand to the user, with the provider's steps", async () => {
    const { remove } = withSpies(simulatedAdapters.gitlab);
    vi.mocked(deleteWebhookEndpoint).mockResolvedValue({ setupMode: "manual", providerWebhookId: null, sourceWebhooks: [] });
    const removal = await removeConnectionWebhook({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, provider: "gitlab" });
    expect(removal).toEqual({ kind: "manual" });
    expect(remove).not.toHaveBeenCalled();
    expect(webhookRemovalMessage("gitlab", removal)).toBe(
      "Remove the webhook you added in GitLab: In GitLab, open each project you added it to, then Settings, then Webhooks, and choose Delete next to the StackDash webhook.",
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
    vi.mocked(deleteWebhookEndpoint).mockResolvedValue({ setupMode: "automatic", providerWebhookId: "hook_9", sourceWebhooks: [] });
    vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read", "simulated:webhooks:write"]));
    const removal = await removeConnectionWebhook({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, provider: "gitlab" });
    expect(removal).toEqual({ kind: "failed", referenceId: "ref123", left: [] });
    expect(logError).toHaveBeenCalledWith("webhook_setup.remove_failed", expect.any(Error), expect.objectContaining({ provider: "gitlab" }));
    expect(webhookRemovalMessage("gitlab", removal)).toMatch(/^StackDash could not delete its webhook in GitLab \(reference ref123\)\. In GitLab, open/);
  });
});

describe("webhookWritePermissions", () => {
  it("asks for the write scope when the user chose automatic setup, or the webhook is automatic already", async () => {
    const { adapter } = withSpies(simulatedAdapters.gitlab);
    const chosen = await webhookWritePermissions({ adapter, workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, chosen: true });
    expect(chosen.map((permission) => permission.scope)).toEqual(["simulated:webhooks:write"]);
    vi.mocked(getConnectionWebhook).mockResolvedValue(stored("automatic"));
    expect(await webhookWritePermissions({ adapter, workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, chosen: false })).toEqual(chosen);
  });

  it.each([
    ["a first connect", "gitlab", undefined, null],
    ["a reconnect of a webhook added by hand", "gitlab", CONNECTION_ID, "manual"],
    ["a reconnect without a webhook", "gitlab", CONNECTION_ID, null],
    ["a provider whose automatic setup needs no new scope", "resend", CONNECTION_ID, "automatic"],
  ] as const)("asks for nothing more on %s (boundary)", async (_case, id, connectionId, mode) => {
    vi.mocked(getConnectionWebhook).mockResolvedValue(mode === null ? null : stored(mode));
    expect(await webhookWritePermissions({ adapter: simulatedAdapters[id], workspaceId: WORKSPACE_ID, connectionId, chosen: false })).toEqual([]);
  });
});

describe("one webhook per source (#428)", () => {
  const WRITE = credential(["simulated:read", "simulated:webhooks:write"]);
  const SOURCES: WebhookSource[] = [
    { id: "1001", name: "example-group/web" },
    { id: "1002", name: "example-group/api" },
  ];

  /** GitLab's simulated declaration, one webhook per project, with spies for the provider calls. */
  function withSourceSpies(sources: readonly WebhookSource[] = SOURCES) {
    const adapter = simulatedAdapters.gitlab;
    const webhooks = adapter.webhooks;
    const registration = webhooks?.registration;
    if (webhooks === undefined || registration?.kind !== "connection" || registration.setup.automatic?.per !== "source") {
      throw new Error("expected GitLab's per-project setup");
    }
    const listSources = vi.fn(() => Promise.resolve([...sources]));
    const create = vi.fn((input: { sourceId: string }) => Promise.resolve({ webhookId: `hook_${input.sourceId}` }));
    const remove = vi.fn<PerSourceWebhookSetup["remove"]>(() => Promise.resolve());
    const automatic: PerSourceWebhookSetup = { ...registration.setup.automatic, listSources, create, remove };
    const setup: ConnectionWebhookSetup = { ...registration.setup, secretSource: "stackdash", automatic };
    const spied: ProviderAdapter = { ...adapter, webhooks: { ...webhooks, registration: { kind: "connection", setup } } };
    vi.mocked(getAdapter).mockReturnValue(spied);
    return { adapter: spied, setup, listSources, create, remove };
  }

  beforeEach(() => {
    vi.mocked(saveCreatedWebhookSource).mockResolvedValue(true);
    vi.mocked(noteSourceWithoutWebhook).mockResolvedValue(true);
    vi.mocked(listWebhookSources).mockResolvedValue([]);
    vi.mocked(loadCredential).mockResolvedValue(WRITE);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("setUpWebhookAutomatically", () => {
    it("stores the endpoint first, then gives each project its webhook with the URL and secret, recording each", async () => {
      const { adapter, setup, listSources, create } = withSourceSpies();
      expect(await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN })).toEqual({ kind: "automatic" });

      const endpoint = vi.mocked(insertWebhookEndpoint).mock.calls[0]?.[0];
      expect(endpoint?.setup).toEqual({ mode: "automatic", perSource: true });
      expect(listSources).toHaveBeenCalledWith({ credential: WRITE, externalAccountIds: ["acct_2"] }, expect.anything());
      const url = webhookUrl(ORIGIN, "gitlab", endpoint?.id ?? "");
      expect(create.mock.calls.map(([input]) => input)).toEqual([
        { credential: WRITE, url, secret: endpoint?.secret, sourceId: "1001" },
        { credential: WRITE, url, secret: endpoint?.secret, sourceId: "1002" },
      ]);
      expect(vi.mocked(saveCreatedWebhookSource).mock.calls.map(([input]) => input)).toEqual([
        { endpointId: endpoint?.id, source: SOURCES[0], providerWebhookId: "hook_1001" },
        { endpointId: endpoint?.id, source: SOURCES[1], providerWebhookId: "hook_1002" },
      ]);
    });

    it("keeps the webhooks that were created when one project fails, and lists that one without a webhook", async () => {
      const { adapter, setup, create } = withSourceSpies();
      create.mockRejectedValueOnce(new Error("403 Forbidden"));
      expect(await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN })).toEqual({ kind: "automatic" });
      expect(saveCreatedWebhookSource).toHaveBeenCalledTimes(1);
      expect(logError).toHaveBeenCalledWith("webhook_setup.source_failed", expect.any(Error), expect.objectContaining({ sourceId: "1001" }));
      // Shown on the panel as having no webhook yet, and tried again after the next sync.
      expect(vi.mocked(noteSourceWithoutWebhook).mock.calls.map(([input]) => input.source)).toEqual([SOURCES[0]]);
      expect(deleteWebhookEndpoint).not.toHaveBeenCalled();
    });

    it("deletes its own webhook again where a racing setup already recorded one (boundary: the source holds a webhook)", async () => {
      const { adapter, setup, remove } = withSourceSpies([SOURCES[0] ?? { id: "1", name: "a/b" }]);
      vi.mocked(saveCreatedWebhookSource).mockResolvedValue(false);
      expect(await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN })).toEqual({ kind: "automatic" });
      // Covered, not failed: the endpoint stays, and only the recorded webhook is left at GitLab.
      expect(remove).toHaveBeenCalledWith({ credential: WRITE, webhookId: "hook_1001", sourceId: "1001" }, expect.anything());
      expect(deleteWebhookEndpoint).not.toHaveBeenCalled();
      expect(noteSourceWithoutWebhook).not.toHaveBeenCalled();
    });

    it("deletes the endpoint again and throws when no project got a webhook (boundary: every one fails)", async () => {
      const { adapter, setup, create } = withSourceSpies();
      create.mockRejectedValue(new Error("GitLab unavailable"));
      await expect(setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN })).rejects.toThrow("No gitlab webhook could be created.");
      expect(deleteWebhookEndpoint).toHaveBeenCalledWith(WORKSPACE_ID, CONNECTION_ID);
    });

    it("sets up with no webhook yet when the connection reads no project (boundary: empty)", async () => {
      const { adapter, setup, create } = withSourceSpies([]);
      expect(await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN })).toEqual({ kind: "automatic" });
      expect(create).not.toHaveBeenCalled();
      expect(deleteWebhookEndpoint).not.toHaveBeenCalled();
    });

    it("deletes a webhook at GitLab again when it cannot be recorded, so none is left that disconnect would miss", async () => {
      const { adapter, setup, remove } = withSourceSpies([SOURCES[0] ?? { id: "1", name: "a/b" }]);
      vi.mocked(saveCreatedWebhookSource).mockRejectedValue(new WebhookSourceLimitError("full"));
      await expect(setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN })).rejects.toThrow();
      expect(remove).toHaveBeenCalledWith({ credential: WRITE, webhookId: "hook_1001", sourceId: "1001" }, expect.anything());
    });

    it("gives at most as many projects a webhook as an endpoint may hold (boundary: one over)", async () => {
      const many = Array.from({ length: WEBHOOK_SOURCES_PER_ENDPOINT + 1 }, (_, index) => ({ id: String(index + 1), name: `g/p${index + 1}` }));
      const { adapter, setup, create } = withSourceSpies(many);
      await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN });
      expect(create).toHaveBeenCalledTimes(WEBHOOK_SOURCES_PER_ENDPOINT);
    });

    it("asks GitLab nothing when the grant lacks the write scope (boundary: consent not given)", async () => {
      const { adapter, setup, listSources, create } = withSourceSpies();
      vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read"]));
      expect(await setUpWebhookAutomatically({ ...target(adapter, setup), origin: ORIGIN })).toEqual({ kind: "write_access_missing" });
      expect(listSources).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });
  });

  describe("removeConnectionWebhook", () => {
    const hook = (sourceId: string): SourceWebhook => ({ sourceId, name: `example-group/p${sourceId}`, providerWebhookId: `hook_${sourceId}` });
    const removed = (sourceWebhooks: readonly SourceWebhook[]) =>
      vi.mocked(deleteWebhookEndpoint).mockResolvedValue({ setupMode: "automatic", providerWebhookId: null, sourceWebhooks });

    it("deletes every project's webhook with the stored credential", async () => {
      const { remove } = withSourceSpies();
      removed([hook("1001"), hook("1002")]);
      const removal = await removeConnectionWebhook({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, provider: "gitlab" });
      expect(removal).toEqual({ kind: "removed" });
      expect(remove.mock.calls.map(([input]) => input)).toEqual([
        { credential: WRITE, webhookId: "hook_1001", sourceId: "1001" },
        { credential: WRITE, webhookId: "hook_1002", sourceId: "1002" },
      ]);
      expect(webhookRemovalMessage("gitlab", removal)).toBe("StackDash deleted its webhooks in GitLab.");
    });

    it("tries every project and names the ones whose webhook is still there when one cannot be deleted", async () => {
      const { remove } = withSourceSpies();
      remove.mockRejectedValueOnce(new Error("GitLab unavailable"));
      removed([hook("1001"), hook("1002")]);
      const removal = await removeConnectionWebhook({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, provider: "gitlab" });
      expect(removal).toEqual({ kind: "failed", referenceId: "ref123", left: ["example-group/p1001"] });
      expect(remove).toHaveBeenCalledTimes(2);
      expect(webhookRemovalMessage("gitlab", removal)).toMatch(
        /^StackDash could not delete its webhooks in GitLab \(reference ref123\)\. They are still in example-group\/p1001\. In GitLab, open each project/,
      );
    });

    it("names three projects and counts the rest when many are left (boundary: more than three)", () => {
      withSourceSpies();
      const removal = { kind: "failed", referenceId: "ref123", left: ["a/1", "a/2", "a/3", "a/4", "a/5"] } as const;
      expect(webhookRemovalMessage("gitlab", removal)).toContain("They are still in a/1, a/2, a/3 and 2 more.");
    });

    it("names every project when the credential is gone and none could be tried", async () => {
      withSourceSpies();
      vi.mocked(loadCredential).mockResolvedValue(null);
      removed([hook("1001"), hook("1002")]);
      const removal = await removeConnectionWebhook({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, provider: "gitlab" });
      expect(removal).toEqual({ kind: "failed", referenceId: "ref123", left: ["example-group/p1001", "example-group/p1002"] });
    });

    it("says nothing when automatic setup never found a project (boundary: none created)", async () => {
      const { remove } = withSourceSpies();
      removed([]);
      expect(await removeConnectionWebhook({ workspaceId: WORKSPACE_ID, connectionId: CONNECTION_ID, provider: "gitlab" })).toEqual({ kind: "none" });
      expect(remove).not.toHaveBeenCalled();
    });
  });

  describe("addMissingSourceWebhooks", () => {
    const ENDPOINT = {
      id: "42600000-0000-4000-8000-000000000003",
      provider: "gitlab" as const,
      workspaceId: WORKSPACE_ID,
      connectionId: CONNECTION_ID,
      secret: new Secret("stored-endpoint-secret"),
    };

    beforeEach(() => {
      vi.mocked(getWebhookEndpointSetup).mockResolvedValue({ id: ENDPOINT.id, setupMode: "automatic", perSource: true });
      vi.mocked(loadWebhookEndpoint).mockResolvedValue(ENDPOINT);
    });

    it("gives a project the sync reads since setup its webhook, on the instance's address with the stored secret", async () => {
      const { create } = withSourceSpies();
      vi.mocked(listWebhookSources).mockResolvedValue([{ sourceId: "1001", name: "example-group/web", providerWebhookId: "hook_1001", lastDeliveryAt: null }]);
      expect(await addMissingSourceWebhooks(WORKSPACE_ID, CONNECTION_ID, "gitlab")).toBe(1);
      expect(create.mock.calls.map(([input]) => input)).toEqual([
        { credential: WRITE, url: webhookUrl(ORIGIN, "gitlab", ENDPOINT.id), secret: ENDPOINT.secret, sourceId: "1002" },
      ]);
    });

    it("gives a project known only from its deliveries a webhook too, without taking a new place", async () => {
      const { create } = withSourceSpies();
      const full = Array.from({ length: WEBHOOK_SOURCES_PER_ENDPOINT - 1 }, (_, index) => ({
        sourceId: `9${index}`,
        name: `g/p${index}`,
        providerWebhookId: `hook_9${index}`,
        lastDeliveryAt: null,
      }));
      vi.mocked(listWebhookSources).mockResolvedValue([...full, { sourceId: "1001", name: "example-group/web", providerWebhookId: null, lastDeliveryAt: null }]);
      // The endpoint is at its limit: 1001 already has a row, and 1002 would need a new one.
      expect(await addMissingSourceWebhooks(WORKSPACE_ID, CONNECTION_ID, "gitlab")).toBe(1);
      expect(create.mock.calls.map(([input]) => input.sourceId)).toEqual(["1001"]);
    });

    it.each([
      ["no webhook", null],
      ["a webhook added by hand", { id: "e", setupMode: "manual", perSource: false }],
      ["one automatic webhook for the whole connection", { id: "e", setupMode: "automatic", perSource: false }],
    ] as const)("does nothing for a connection with %s", async (_case, endpoint) => {
      const { listSources, create } = withSourceSpies();
      vi.mocked(getWebhookEndpointSetup).mockResolvedValue(endpoint);
      expect(await addMissingSourceWebhooks(WORKSPACE_ID, CONNECTION_ID, "gitlab")).toBe(0);
      expect(listSources).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it("reads nothing for a provider without per-source webhooks (boundary: every other provider's sync)", async () => {
      withSpies(simulatedAdapters.resend);
      expect(await addMissingSourceWebhooks(WORKSPACE_ID, CONNECTION_ID, "resend")).toBe(0);
      expect(getWebhookEndpointSetup).not.toHaveBeenCalled();
      expect(getConnectionWebhook).not.toHaveBeenCalled();
    });

    it("does nothing, with a warning, once a reconnect gave up the write access (boundary)", async () => {
      const { listSources } = withSourceSpies();
      vi.mocked(loadCredential).mockResolvedValue(credential(["simulated:read"]));
      expect(await addMissingSourceWebhooks(WORKSPACE_ID, CONNECTION_ID, "gitlab")).toBe(0);
      expect(listSources).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith("webhook_setup.write_access_gone", expect.objectContaining({ connectionId: CONNECTION_ID }));
    });

    it("asks nothing more when every project has its webhook (boundary: none missing)", async () => {
      const { create } = withSourceSpies();
      vi.mocked(listWebhookSources).mockResolvedValue(
        SOURCES.map((source) => ({ sourceId: source.id, name: source.name, providerWebhookId: `hook_${source.id}`, lastDeliveryAt: null })),
      );
      expect(await addMissingSourceWebhooks(WORKSPACE_ID, CONNECTION_ID, "gitlab")).toBe(0);
      expect(create).not.toHaveBeenCalled();
    });

    it("throws when every missing webhook fails, so the sync logs it (boundary: GitLab fails)", async () => {
      const { create } = withSourceSpies();
      create.mockRejectedValue(new Error("GitLab unavailable"));
      await expect(addMissingSourceWebhooks(WORKSPACE_ID, CONNECTION_ID, "gitlab")).rejects.toThrow("No new gitlab webhook could be created.");
    });
  });
});
