import { generateKeyPairSync } from "node:crypto";
import type * as NextServer from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

// `connection()` only marks the handler request-time and needs Next's request scope, which a unit
// test does not have; everything else in next/server is the real module. Hoisted above the imports.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof NextServer>()),
  connection: async () => undefined,
}));

const KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

beforeEach(() => {
  vi.stubEnv("POSTHOG_OAUTH_CLIENT_ID", "https://stackdash.example.com/oauth/posthog/client-metadata");
  vi.stubEnv("POSTHOG_OAUTH_PRIVATE_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /oauth/posthog/jwks", () => {
  it("publishes one public signing key and no private member", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    const { keys } = await response.json();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256", use: "sig" });
    expect(keys[0]).not.toHaveProperty("d");
  });

  it("answers 404 when PostHog is not set up", async () => {
    vi.stubEnv("POSTHOG_OAUTH_PRIVATE_KEY", "");
    expect((await GET()).status).toBe(404);
  });

  it("answers 500 with a reference, and no key text, when the key is not a usable private key", async () => {
    vi.stubEnv("POSTHOG_OAUTH_PRIVATE_KEY", "not a key");
    const response = await GET();
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toMatch(/^PostHog is not set up correctly on this StackDash instance\. Reference: /);
    expect(text).not.toContain("not a key");
  });
});
