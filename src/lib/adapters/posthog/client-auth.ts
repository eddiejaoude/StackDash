import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";

/**
 * How StackDash identifies itself to PostHog (docs/providers/posthog.md, Connection; decision on #115).
 *
 * PostHog registers third-party apps by client ID metadata document (CIMD): the `client_id` is the
 * URL of a JSON document this deployment serves, so there is nothing to register and no client
 * secret. StackDash is a confidential client all the same: the document names
 * `token_endpoint_auth_method: private_key_jwt` and a JWKS, and every token request carries a
 * client assertion signed with the deployment's private key (RFC 7523). The key sits in the slot the
 * adapter contract calls the client secret, so a stolen refresh token alone cannot mint tokens.
 */

/** Paths of the two public routes; the client id is `<SITE_URL>` plus the first. */
export const CLIENT_METADATA_PATH = "/oauth/posthog/client-metadata";
export const JWKS_PATH = "/oauth/posthog/jwks";

// The assertion audience PostHog documents for both regions: "PostHog can forward a request to the
// other region, and this value is valid in both" (Provisioning, Build the assertion).
export const ASSERTION_AUDIENCE = ["https://us.posthog.com", "https://eu.posthog.com"] as const;
export const CLIENT_ASSERTION_TYPE = "urn:ietf:params:oauth:client-assertion-type:jwt-bearer";
// PostHog accepts `exp` at most 300 seconds after `iat`; a minute is plenty for one request.
const ASSERTION_LIFETIME_SECONDS = 60;
// What PostHog may cache the metadata document for. It clamps the value to 5 minutes to 24 hours.
export const METADATA_MAX_AGE_SECONDS = 3600;

type SigningAlgorithm = "RS256" | "ES256";

export type SigningKey = Readonly<{
  privateKey: KeyObject;
  alg: SigningAlgorithm;
  kid: string;
  publicJwk: Readonly<Record<string, string>>;
}>;

/** A deployment configuration error. Its message names the setting, never the key material. */
export class SigningKeyError extends Error {
  constructor(message: string, options?: { cause: unknown }) {
    super(message, options);
    this.name = "SigningKeyError";
  }
}

// RFC 7638 section 3.2: the required members, in lexicographic order, per key type.
const THUMBPRINT_MEMBERS: Readonly<Record<SigningAlgorithm, readonly string[]>> = {
  RS256: ["e", "kty", "n"],
  ES256: ["crv", "kty", "x", "y"],
};

function algorithmOf(key: KeyObject): SigningAlgorithm {
  if (key.asymmetricKeyType === "rsa") return "RS256";
  if (key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1") return "ES256";
  throw new SigningKeyError("POSTHOG_OAUTH_PRIVATE_KEY must be an RSA key or an EC key on the P-256 curve");
}

/**
 * Parses the PEM in POSTHOG_OAUTH_PRIVATE_KEY (PKCS#8, PKCS#1, or SEC1). Hosts that cannot store
 * multiline values keep `\n` escapes, which are turned back into line breaks, as for GitHub's key.
 * The key id is the RFC 7638 thumbprint, so rotating the key rotates the id with no extra setting.
 */
export function loadSigningKey(pem: string): SigningKey {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem.replaceAll("\\n", "\n"));
  } catch (error) {
    throw new SigningKeyError("POSTHOG_OAUTH_PRIVATE_KEY is not a PEM private key", { cause: error });
  }
  const alg = algorithmOf(privateKey);
  const exported = createPublicKey(privateKey).export({ format: "jwk" });
  const publicJwk: Record<string, string> = {};
  for (const member of THUMBPRINT_MEMBERS[alg]) {
    const value = exported[member];
    if (typeof value !== "string") throw new SigningKeyError(`The public key has no "${member}" member`);
    publicJwk[member] = value;
  }
  const kid = createHash("sha256").update(JSON.stringify(publicJwk)).digest("base64url");
  return { privateKey, alg, kid, publicJwk };
}

/** The JWKS PostHog fetches from `jwks_uri`: public members only, with `kid`, `alg`, and `use`. */
export function publicJwks(key: SigningKey): { keys: Record<string, string>[] } {
  return { keys: [{ ...key.publicJwk, kid: key.kid, alg: key.alg, use: "sig" }] };
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * A single-use client assertion (RFC 7523 section 2.2) with the claims PostHog lists: `iss` and
 * `sub` are the client id, `aud` names both regions, `jti` is fresh because PostHog accepts each
 * assertion once per region, and `exp` is well inside PostHog's 300 second ceiling.
 */
export function createClientAssertion(clientId: string, key: SigningKey, now: Date, jti: string): string {
  const iat = Math.floor(now.getTime() / 1000);
  const unsigned = `${base64UrlJson({ alg: key.alg, kid: key.kid, typ: "JWT" })}.${base64UrlJson({
    iss: clientId,
    sub: clientId,
    aud: ASSERTION_AUDIENCE,
    iat,
    exp: iat + ASSERTION_LIFETIME_SECONDS,
    jti,
  })}`;
  const data = Buffer.from(unsigned);
  // JWS ES256 is the raw r||s pair (RFC 7518 section 3.4), not node's default DER encoding.
  const signature =
    key.alg === "ES256"
      ? sign("sha256", data, { key: key.privateKey, dsaEncoding: "ieee-p1363" })
      : sign("sha256", data, key.privateKey);
  return `${unsigned}.${signature.toString("base64url")}`;
}

export type ClientMetadataInput = Readonly<{
  clientId: string;
  origin: string;
  redirectUri: string;
  scopes: readonly string[];
}>;

/**
 * The client ID metadata document. Rules from PostHog OAuth, "How PostHog reads your document":
 * `client_id` equals the URL character for character, `client_name` never contains "PostHog",
 * "official", "verified", or "trusted", and `com.posthog.scopes` is the scope ceiling, so a token
 * can never carry more than the read scopes listed on the connect screen.
 */
export function clientMetadataDocument({ clientId, origin, redirectUri, scopes }: ClientMetadataInput) {
  return {
    client_id: clientId,
    client_name: "StackDash",
    client_uri: origin,
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "private_key_jwt",
    jwks_uri: `${origin}${JWKS_PATH}`,
    "com.posthog": { scopes: [...scopes] },
  };
}
