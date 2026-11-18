import { afterEach, describe, expect, it, vi } from "vitest";

import { availableProviders } from "@/lib/adapters/registry";
import type { ProviderId } from "@/lib/adapters/types";
import { PROVIDER_NAMES } from "@/lib/providers";

import { reconnectTarget } from "./reconnect";

const CONNECTIONS_PATH = "/w/abcdefghij/connections";
const CONNECTION_ID = "00000000-0000-4000-8000-000000000000";

// This file stands in for a Playwright spec of the switched-off case, as #562's fallback allows.
// `playwright.config.ts` starts one app server for every spec, `isFakeProviderEnabled` reads the
// process environment on each request, and CI sets STACKDASH_ENABLE_FAKE_PROVIDER=1 because other
// specs connect through the fake provider, so no spec can switch it off for itself. A second server
// with the flag off would need a second `next dev` in the same directory, which Next's dev lock
// refuses. Hence `targetFor` repeats the page's lookup rather than rendering the page, and the flag
// table below overlaps `registry.test.ts`: here it decides the reconnect, not the registry.
//
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
