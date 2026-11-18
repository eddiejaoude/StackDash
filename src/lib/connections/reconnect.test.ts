import { afterEach, describe, expect, it, vi } from "vitest";

import { availableProviders } from "@/lib/adapters/registry";
import type { ProviderId } from "@/lib/adapters/types";
import { PROVIDER_NAMES } from "@/lib/providers";

import { reconnectTarget } from "./reconnect";

const CONNECTIONS_PATH = "/w/abcdefghij/connections";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000000";

// The connection page's own lookup: the registry's entry for the connection's provider, if any.
function targetFor(provider: ProviderId) {
  return reconnectTarget({
    connectionsPath: CONNECTIONS_PATH,
    connectionId: CONNECTION_ID,
    providerName: PROVIDER_NAMES[provider],
    adapter: availableProviders().find((candidate) => candidate.id === provider),
  });
}

describe("reconnectTarget", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("links a fake connection to its reconnect while the fake provider is on", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "1");
    expect(targetFor("fake")).toEqual({
      kind: "available",
      href: `${CONNECTIONS_PATH}/new/fake?connection=${CONNECTION_ID}`,
    });
  });

  it("links a live provider's connection whatever the fake provider's flag says", () => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", "");
    expect(targetFor("github")).toEqual({
      kind: "available",
      href: `${CONNECTIONS_PATH}/new/github?connection=${CONNECTION_ID}`,
    });
  });

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["0", "0"],
    ["any value but 1", "true"],
  ])("offers no reconnect for a fake connection while the fake provider is off (flag %s), and says why", (_title, value) => {
    vi.stubEnv("STACKDASH_ENABLE_FAKE_PROVIDER", value);
    expect(targetFor("fake")).toEqual({
      kind: "unavailable",
      reason:
        "Example provider is not available on this instance, so this connection cannot be reconnected. Its history stays here until you delete the connection.",
    });
  });

  it("encodes the connection id into the query, never the path", () => {
    const target = reconnectTarget({
      connectionsPath: CONNECTIONS_PATH,
      connectionId: "a b&c",
      providerName: PROVIDER_NAMES.github,
      adapter: availableProviders().find((candidate) => candidate.id === "github"),
    });
    expect(target).toEqual({ kind: "available", href: `${CONNECTIONS_PATH}/new/github?connection=a+b%26c` });
  });
});
