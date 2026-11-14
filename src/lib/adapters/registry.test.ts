import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeAdapter } from "./fake";
import { githubAdapter } from "./github";
import {
  availableProviders,
  createAdapterContext,
  createOAuthContext,
  declaredCapabilities,
  eventTypeName,
  getAdapter,
  isProviderConfigured,
  isProviderSimulated,
  liveProviderSetup,
  loadOAuthClient,
  missingOAuthEnv,
} from "./registry";
import { simulatedAdapters } from "./simulated";
import { liveProviderIds, Secret, type ProviderAdapter } from "./types";
import { vercelAdapter } from "./vercel";

function withOAuth(oauth: Partial<ProviderAdapter["oauth"]>): ProviderAdapter {
  return { ...fakeAdapter, oauth: { ...fakeAdapter.oauth, ...oauth } };
}

const TEST_ADAPTER = withOAuth({
  clientIdEnv: "TEST_REGISTRY_CLIENT_ID",
  clientSecretEnv: "TEST_REGISTRY_CLIENT_SECRET",
  extraEnv: { slug: "TEST_REGISTRY_SLUG", testKey: "TEST_REGISTRY_TEST_KEY" },
  optionalExtraKeys: ["testKey"],
});

function setRequired(): void {
  vi.stubEnv("TEST_REGISTRY_CLIENT_ID", "client-id");
  vi.stubEnv("TEST_REGISTRY_CLIENT_SECRET", "client-secret");
  vi.stubEnv("TEST_REGISTRY_SLUG", "stackdash");
  vi.stubEnv("TEST_REGISTRY_TEST_KEY", "");
}

// Real adapters by default, whatever the developer's shell exports; simulation tests opt in.
beforeEach(() => {
  vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "");
  vi.stubEnv("VERCEL_ENV", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("provider simulation", () => {
  it("hands out the real adapters and simulates nothing when the flag is off", () => {
    expect(getAdapter("vercel")).toBe(vercelAdapter);
    expect(availableProviders().some((adapter) => Object.values(simulatedAdapters).includes(adapter))).toBe(false);
    expect(isProviderSimulated("vercel")).toBe(false);
  });

  it("leaves a real provider not set up when the flag is off, as before", () => {
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "");
    expect(isProviderConfigured(getAdapter("github"))).toBe(false);
    expect(getAdapter("github")).toBe(githubAdapter);
  });

  it("replaces every live provider with its simulated twin, set up without an OAuth app, when the flag is 1", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    for (const id of liveProviderIds) {
      const adapter = getAdapter(id);
      expect(adapter).toBe(simulatedAdapters[id]);
      expect(isProviderConfigured(adapter)).toBe(true);
      expect(isProviderSimulated(id)).toBe(true);
    }
    expect(availableProviders().map((adapter) => adapter.id)).toEqual([...liveProviderIds]);
  });

  it("never simulates the fake provider", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    expect(getAdapter("fake")).toBe(fakeAdapter);
    expect(isProviderSimulated("fake")).toBe(false);
  });

  it("refuses simulation on a Vercel production deployment even with the flag set", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    vi.stubEnv("VERCEL_ENV", "production");
    expect(getAdapter("stripe").id).toBe("stripe");
    expect(getAdapter("stripe")).not.toBe(simulatedAdapters.stripe);
    expect(isProviderSimulated("stripe")).toBe(false);
  });

  it("gives a simulated adapter no client once the flag is off, so it can never sync", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    expect(loadOAuthClient(simulatedAdapters.resend)).not.toBeNull();
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "0");
    expect(loadOAuthClient(simulatedAdapters.resend)).toBeNull();
  });

  it("never hands the simulated client to a real adapter", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    vi.stubEnv("VERCEL_CLIENT_ID", "");
    expect(loadOAuthClient(vercelAdapter)).toBeNull();
  });
});

describe("getAdapter", () => {
  it("returns the adapter for every live provider id", () => {
    for (const id of liveProviderIds) {
      expect(getAdapter(id).id).toBe(id);
    }
  });

  it("refuses the fake provider when the flag is unset", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "");
    expect(() => getAdapter("fake")).toThrow(/disabled/);
  });

  it("refuses the fake provider when the flag is any value other than 1", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "true");
    expect(() => getAdapter("fake")).toThrow(/disabled/);
  });

  it("returns the fake provider when the flag is exactly 1", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    expect(getAdapter("fake")).toBe(fakeAdapter);
  });
});

describe("availableProviders", () => {
  it("lists only live providers, in catalog order, when the fake flag is unset", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "");
    expect(availableProviders().map((adapter) => adapter.id)).toEqual([...liveProviderIds]);
  });

  it("adds the fake provider last when the flag is 1", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    expect(availableProviders().map((adapter) => adapter.id)).toEqual([...liveProviderIds, "fake"]);
  });
});

describe("beta declarations", () => {
  it.each([
    ["real", ""],
    ["simulated", "1"],
  ])("declares Resend in beta, and no other registered adapter, with %s providers", (_, simulate) => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", simulate);
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    expect(availableProviders().filter((adapter) => adapter.beta !== undefined).map((adapter) => adapter.id)).toEqual(["resend"]);
  });
});

describe("declaredCapabilities (#269)", () => {
  it.each([
    ["real", ""],
    ["simulated", "1"],
  ])("gives every provider its adapter's declaration, with %s providers", (_, simulate) => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", simulate);
    for (const adapter of availableProviders()) expect(declaredCapabilities(adapter.id)).toEqual(adapter.capabilities);
  });

  it("answers for the fake provider whatever its flag says, since its stored data outlives the flag", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", undefined);
    expect(declaredCapabilities("fake")).toEqual(fakeAdapter.capabilities);
  });
});

describe("eventTypeName (#294)", () => {
  it.each([
    ["stripe.charge.succeeded", "Payment succeeded"],
    ["github.stars.daily", "New stars"],
    ["fake.signup", "New signup"],
  ])("names the declared type %s by its adapter's label", (typeId, expected) => {
    expect(eventTypeName(typeId)).toBe(expected);
  });

  it.each([
    // A type no adapter declares any more, such as an older Vercel id still stored on past events.
    ["vercel.deployment_ready", "Deployment ready"],
    // StackDash's own types are declared by no adapter; the id-derived name keeps its overrides.
    ["stackdash.anomaly_detected", "Unusual spend or usage"],
    ["stackdash.daily_summary", "Daily summary"],
    // An id with no dot after the provider has nothing to derive a name from.
    ["stripe", "stripe"],
  ])("falls back to the derived name for the undeclared type %s", (typeId, expected) => {
    expect(eventTypeName(typeId)).toBe(expected);
  });
});

describe("loadOAuthClient", () => {
  it("returns the client with required extras wrapped in Secret when every variable is set", () => {
    setRequired();
    const client = loadOAuthClient(TEST_ADAPTER);
    expect(client?.clientId).toBe("client-id");
    expect(client?.clientSecret).toBeInstanceOf(Secret);
    expect(client?.clientSecret.reveal()).toBe("client-secret");
    expect(client?.extra.slug?.reveal()).toBe("stackdash");
  });

  it("leaves an unset optional extra out instead of returning null", () => {
    setRequired();
    const client = loadOAuthClient(TEST_ADAPTER);
    expect(client).not.toBeNull();
    expect(client?.extra).not.toHaveProperty("testKey");
  });

  it("includes an optional extra when it is set", () => {
    setRequired();
    vi.stubEnv("TEST_REGISTRY_TEST_KEY", "sk_test_value");
    expect(loadOAuthClient(TEST_ADAPTER)?.extra.testKey?.reveal()).toBe("sk_test_value");
  });

  it("returns null when the client id is empty", () => {
    setRequired();
    vi.stubEnv("TEST_REGISTRY_CLIENT_ID", "");
    expect(loadOAuthClient(TEST_ADAPTER)).toBeNull();
    expect(isProviderConfigured(TEST_ADAPTER)).toBe(false);
  });

  it("returns null when the client secret is only whitespace", () => {
    setRequired();
    vi.stubEnv("TEST_REGISTRY_CLIENT_SECRET", "   ");
    expect(loadOAuthClient(TEST_ADAPTER)).toBeNull();
  });

  it("returns null when a required extra is empty", () => {
    setRequired();
    vi.stubEnv("TEST_REGISTRY_SLUG", "");
    expect(loadOAuthClient(TEST_ADAPTER)).toBeNull();
  });

  it("works for an adapter with no extras", () => {
    vi.stubEnv("FAKE_PROVIDER_CLIENT_ID", "fake-client");
    vi.stubEnv("FAKE_PROVIDER_CLIENT_SECRET", "fake-secret");
    expect(loadOAuthClient(fakeAdapter)?.extra).toEqual({});
  });

  it("never serializes the secret", () => {
    setRequired();
    expect(JSON.stringify(loadOAuthClient(TEST_ADAPTER))).not.toContain("client-secret");
  });
});

describe("missingOAuthEnv", () => {
  it("names nothing when every required variable is set and the optional extra is not", () => {
    setRequired();
    expect(missingOAuthEnv(TEST_ADAPTER)).toEqual([]);
  });

  it("names every empty or whitespace-only required variable in declaration order, never the optional one", () => {
    vi.stubEnv("TEST_REGISTRY_CLIENT_ID", "");
    vi.stubEnv("TEST_REGISTRY_CLIENT_SECRET", "  ");
    vi.stubEnv("TEST_REGISTRY_SLUG", "");
    vi.stubEnv("TEST_REGISTRY_TEST_KEY", "");
    expect(missingOAuthEnv(TEST_ADAPTER)).toEqual(["TEST_REGISTRY_CLIENT_ID", "TEST_REGISTRY_CLIENT_SECRET", "TEST_REGISTRY_SLUG"]);
  });
});

describe("liveProviderSetup", () => {
  function clearVercel(): void {
    for (const name of ["VERCEL_CLIENT_ID", "VERCEL_CLIENT_SECRET", "VERCEL_INTEGRATION_SLUG"]) vi.stubEnv(name, "");
  }

  it("lists every live provider in catalog order and never the fake one", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    expect(liveProviderSetup().map(({ provider }) => provider)).toEqual([...liveProviderIds]);
  });

  it("reports the real OAuth app as missing while simulation stands in for it", () => {
    vi.stubEnv("STACKDASH_SIMULATE_PROVIDERS", "1");
    clearVercel();
    expect(isProviderConfigured(getAdapter("vercel"))).toBe(true);
    expect(liveProviderSetup().find(({ provider }) => provider === "vercel")?.missing).toEqual([
      "VERCEL_CLIENT_ID",
      "VERCEL_CLIENT_SECRET",
      "VERCEL_INTEGRATION_SLUG",
    ]);
  });
});

describe("createOAuthContext", () => {
  it("carries the client, a 15 second timeout, and a live clock", () => {
    setRequired();
    const client = loadOAuthClient(TEST_ADAPTER);
    if (client === null) throw new Error("expected a client");
    const ctx = createOAuthContext(client);
    expect(ctx.client).toBe(client);
    expect(ctx.timeoutMs).toBe(15_000);
    expect(ctx.now()).toBeInstanceOf(Date);
    expect(createAdapterContext().timeoutMs).toBe(15_000);
  });
});

describe("buildAuthorizeUrl", () => {
  it("is https for every live adapter, the only scheme the start route's handoff page accepts", () => {
    for (const id of liveProviderIds) {
      const adapter = getAdapter(id);
      const client = {
        clientId: "client-id",
        clientSecret: new Secret("client-secret"),
        extra: Object.fromEntries(Object.keys(adapter.oauth.extraEnv ?? {}).map((key) => [key, new Secret("stackdash")])),
      };
      const url = adapter.buildAuthorizeUrl({
        client,
        state: "state",
        redirectUri: `https://stackdash.example/api/connections/${id}/callback`,
        codeChallenge: "challenge",
      });
      expect(url.protocol, id).toBe("https:");
    }
  });
});
