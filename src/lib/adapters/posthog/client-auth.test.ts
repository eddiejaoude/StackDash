import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ASSERTION_AUDIENCE,
  clientMetadataDocument,
  createClientAssertion,
  JWKS_PATH,
  loadSigningKey,
  publicJwks,
  SigningKeyError,
} from "./client-auth";

const CLIENT_ID = "https://stackdash.example.com/oauth/posthog/client-metadata";
const NOW = new Date("2026-11-05T09:00:00.000Z");

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const pem = (key: typeof rsa.privateKey, type: "pkcs8" | "pkcs1" | "sec1") =>
  key.export({ type, format: "pem" }).toString();

function decode(part: string | undefined): Record<string, unknown> {
  if (part === undefined) throw new Error("missing JWS part");
  return JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
}

describe("loadSigningKey", () => {
  it.each([
    ["an RSA PKCS#8 key", pem(rsa.privateKey, "pkcs8"), "RS256", ["e", "kty", "n"]],
    ["an RSA PKCS#1 key", pem(rsa.privateKey, "pkcs1"), "RS256", ["e", "kty", "n"]],
    ["a P-256 PKCS#8 key", pem(ec.privateKey, "pkcs8"), "ES256", ["crv", "kty", "x", "y"]],
    ["a P-256 SEC1 key", pem(ec.privateKey, "sec1"), "ES256", ["crv", "kty", "x", "y"]],
  ])("accepts %s and keeps only the public members", (_title, text, alg, members) => {
    const key = loadSigningKey(text);
    expect(key.alg).toBe(alg);
    expect(Object.keys(key.publicJwk)).toEqual(members);
    expect(key.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("accepts a PEM stored with \\n escapes, as single-line hosts keep it", () => {
    const text = pem(ec.privateKey, "pkcs8");
    expect(loadSigningKey(text.replaceAll("\n", "\\n")).kid).toBe(loadSigningKey(text).kid);
  });

  it("derives the key id as the RFC 7638 thumbprint, so the same key always gets the same id", () => {
    const other = generateKeyPairSync("ec", { namedCurve: "P-256" });
    expect(loadSigningKey(pem(ec.privateKey, "pkcs8")).kid).toBe(loadSigningKey(pem(ec.privateKey, "sec1")).kid);
    expect(loadSigningKey(pem(other.privateKey, "pkcs8")).kid).not.toBe(loadSigningKey(pem(ec.privateKey, "pkcs8")).kid);
  });

  it.each([
    ["empty text", ""],
    ["a public key", ec.publicKey.export({ type: "spki", format: "pem" }).toString()],
    ["text that is not a key", "-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----"],
    ["a P-384 key", pem(generateKeyPairSync("ec", { namedCurve: "P-384" }).privateKey, "pkcs8")],
    ["an Ed25519 key", pem(generateKeyPairSync("ed25519").privateKey, "pkcs8")],
  ])("refuses %s with a message that names only the setting", (_title, text) => {
    expect(() => loadSigningKey(text)).toThrow(SigningKeyError);
    expect(() => loadSigningKey(text)).toThrow(/POSTHOG_OAUTH_PRIVATE_KEY/);
  });
});

describe("publicJwks", () => {
  it("publishes the public key with kid, alg, and use, and never the private exponent or scalar", () => {
    for (const text of [pem(rsa.privateKey, "pkcs8"), pem(ec.privateKey, "pkcs8")]) {
      const key = loadSigningKey(text);
      const [jwk] = publicJwks(key).keys;
      expect(jwk).toMatchObject({ kid: key.kid, alg: key.alg, use: "sig" });
      for (const secret of ["d", "p", "q", "dp", "dq", "qi"]) expect(jwk).not.toHaveProperty(secret);
      expect(createPublicKey({ key: { ...jwk }, format: "jwk" }).asymmetricKeyType).toBe(key.alg === "RS256" ? "rsa" : "ec");
    }
  });
});

describe("createClientAssertion", () => {
  it.each([
    ["ES256", pem(ec.privateKey, "pkcs8"), { key: ec.publicKey, dsaEncoding: "ieee-p1363" as const }],
    ["RS256", pem(rsa.privateKey, "pkcs8"), { key: rsa.publicKey }],
  ])("signs an %s assertion with the claims PostHog lists", (alg, text, verifyKey) => {
    const key = loadSigningKey(text);
    const assertion = createClientAssertion(CLIENT_ID, key, NOW, "jti-1");
    const [header, payload, signature] = assertion.split(".");
    expect(decode(header)).toEqual({ alg, kid: key.kid, typ: "JWT" });
    expect(decode(payload)).toEqual({
      iss: CLIENT_ID,
      sub: CLIENT_ID,
      aud: [...ASSERTION_AUDIENCE],
      iat: 1_793_869_200,
      exp: 1_793_869_260,
      jti: "jti-1",
    });
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), verifyKey, Buffer.from(signature ?? "", "base64url"))).toBe(true);
  });

  it("rounds iat down to whole seconds and keeps exp within PostHog's 300 second ceiling", () => {
    const key = loadSigningKey(pem(ec.privateKey, "pkcs8"));
    const claims = decode(createClientAssertion(CLIENT_ID, key, new Date(NOW.getTime() + 999), "jti-2").split(".")[1]);
    expect(claims.iat).toBe(1_793_869_200);
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(300);
  });
});

describe("clientMetadataDocument", () => {
  const document = clientMetadataDocument({
    clientId: CLIENT_ID,
    origin: "https://stackdash.example.com",
    redirectUri: "https://stackdash.example.com/api/connections/posthog/callback",
    scopes: ["billing:read", "organization:read"],
  });

  it("names the client id, callback, JWKS, private_key_jwt, and the scope ceiling", () => {
    expect(document).toEqual({
      client_id: CLIENT_ID,
      client_name: "StackDash",
      client_uri: "https://stackdash.example.com",
      redirect_uris: ["https://stackdash.example.com/api/connections/posthog/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "private_key_jwt",
      jwks_uri: `https://stackdash.example.com${JWKS_PATH}`,
      "com.posthog": { scopes: ["billing:read", "organization:read"] },
    });
  });

  it("stays inside PostHog's document rules: no reserved words in the name, under 5 KB", () => {
    expect(document.client_name).not.toMatch(/post\W*hog|official|verified|trusted/i);
    expect(Buffer.byteLength(JSON.stringify(document))).toBeLessThan(5 * 1024);
  });
});
