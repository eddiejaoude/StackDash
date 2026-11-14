import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./route";

const ORIGIN = "https://stackdash.example.com";
const CLIENT_ID = `${ORIGIN}/oauth/posthog/client-metadata`;
const KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function request(origin = ORIGIN): Request {
  return new Request(`${origin}/oauth/posthog/client-metadata`);
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
  vi.stubEnv("POSTHOG_OAUTH_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("POSTHOG_OAUTH_PRIVATE_KEY", KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /oauth/posthog/client-metadata", () => {
  it("serves the document with its own URL as client_id, cacheable for an hour", async () => {
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = await response.json();
    expect(body).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uris: [`${ORIGIN}/api/connections/posthog/callback`],
      jwks_uri: `${ORIGIN}/oauth/posthog/jwks`,
      token_endpoint_auth_method: "private_key_jwt",
      "com.posthog": { scopes: ["billing:read", "organization:read", "project:read", "query:read"] },
    });
    // The key never appears in the public document.
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
  });

  it("builds every URL from NEXT_PUBLIC_SITE_URL when set, as the connect routes do", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", ORIGIN);
    const response = await GET(request("http://10.0.0.5:3000"));
    expect(response.status).toBe(200);
    expect((await response.json()).redirect_uris).toEqual([`${ORIGIN}/api/connections/posthog/callback`]);
  });

  it.each([
    ["the client id is unset", "POSTHOG_OAUTH_CLIENT_ID", ""],
    ["the private key is unset", "POSTHOG_OAUTH_PRIVATE_KEY", ""],
    ["the client id names another URL", "POSTHOG_OAUTH_CLIENT_ID", `${ORIGIN}/oauth/posthog/other`],
    ["the client id names another origin", "POSTHOG_OAUTH_CLIENT_ID", "https://elsewhere.example.com/oauth/posthog/client-metadata"],
  ])("answers 404 when %s", async (_title, name, value) => {
    vi.stubEnv(name, value);
    const response = await GET(request());
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("PostHog is not set up on this StackDash instance.");
  });
});
