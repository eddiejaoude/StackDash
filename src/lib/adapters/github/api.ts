import { createSign } from "node:crypto";
import type { z } from "zod";
import {
  AdapterError,
  AdapterTimeoutError,
  AuthRevokedError,
  fetchJson,
  InvalidResponseError,
  PermissionMissingError,
  ProviderUnavailableError,
  RateLimitedError,
} from "../errors";
import { Secret, type AdapterContext, type OAuthClient, type OAuthContext, type OAuthCredential } from "../types";
import { InstallationSchema, InstallationTokenSchema, type Installation } from "./schemas";

/** GitHub REST plumbing shared by the connect flow and sync, per docs/providers/github.md. */

export const API_ORIGIN = "https://api.github.com";
const API_VERSION = "2026-03-10";
const USER_AGENT = "StackDash";

// Keys in `OAuthClient.extra`, mapped to their environment variables in the adapter descriptor.
export const extraKeys = {
  appSlug: "appSlug",
  appId: "appId",
  privateKey: "privateKey",
} as const;

// Credential metadata keys written by `exchangeCode` and read by every later call.
export const metadataKeys = {
  installationId: "installationId",
  accountId: "accountId",
  accountLogin: "accountLogin",
  accountType: "accountType",
} as const;

// GitHub allows `exp` at most 10 minutes ahead; `iat` is backdated 60 seconds for clock drift.
const JWT_BACKDATE_SECONDS = 60;
const JWT_LIFETIME_SECONDS = 9 * 60;

type RequestContext = Pick<AdapterContext, "fetch" | "now" | "timeoutMs">;

export function apiHeaders(bearer: Secret | string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": USER_AGENT,
    Authorization: `Bearer ${typeof bearer === "string" ? bearer : bearer.reveal()}`,
    ...extra,
  };
}

export async function getJson<T>(
  ctx: RequestContext,
  path: string,
  bearer: Secret | string,
  schema: z.ZodType<T>,
  query: Record<string, string> = {},
): Promise<T> {
  const url = new URL(path, API_ORIGIN);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return fetchJson(ctx, url, { method: "GET", headers: apiHeaders(bearer) }, schema);
}

/**
 * The same error with `endpoint` (an origin and a path template) in place of the real path, in its
 * message and its `endpoint` field, which the logger writes: a private repository's owner and name
 * never leave the workspace (#62). The original's cause is kept; the original itself is not, since
 * its message names the repository.
 */
function withEndpointTemplate(error: unknown, endpoint: string): unknown {
  if (!(error instanceof AdapterError)) return error;
  const message = error.endpoint === undefined ? error.message : error.message.replaceAll(error.endpoint, endpoint);
  const options = {
    endpoint,
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  };
  if (error instanceof PermissionMissingError) return new PermissionMissingError(message, error.missingScopes, options);
  if (error instanceof RateLimitedError) return new RateLimitedError(message, error.retryAfterMs, options);
  if (error instanceof AuthRevokedError) return new AuthRevokedError(message, options);
  if (error instanceof ProviderUnavailableError) return new ProviderUnavailableError(message, options);
  if (error instanceof AdapterTimeoutError) return new AdapterTimeoutError(message, options);
  return new InvalidResponseError(message, options);
}

export type RepositoryPath = Readonly<{ owner: Readonly<{ login: string }>; name: string }>;

/** The path template of a repository read, for provenance and errors: `/repos/{owner}/{repo}/forks`. */
export function repositoryEndpoint(suffix: string): string {
  return `/repos/{owner}/{repo}${suffix}`;
}

/**
 * `GET /repos/{owner}/{repo}<suffix>`. A failure names the path template, never the repository
 * (`withEndpointTemplate`), because the repository can be private.
 */
export async function getRepositoryJson<T>(
  ctx: RequestContext,
  repo: RepositoryPath,
  suffix: string,
  bearer: Secret,
  schema: z.ZodType<T>,
  query: Record<string, string> = {},
): Promise<T> {
  const path = `/repos/${encodeURIComponent(repo.owner.login)}/${encodeURIComponent(repo.name)}${suffix}`;
  try {
    return await getJson(ctx, path, bearer, schema, query);
  } catch (error) {
    throw withEndpointTemplate(error, `${API_ORIGIN}${repositoryEndpoint(suffix)}`);
  }
}

export function requireExtra(client: OAuthClient, key: keyof typeof extraKeys): Secret {
  const value = client.extra[extraKeys[key]];
  // A deployment configuration error, not a provider failure: the message names the setting only.
  if (value === undefined) throw new Error(`GitHub adapter is missing the "${key}" app setting`);
  return value;
}

function base64UrlJson(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * App JWT (RS256) signed with the app private key, built in memory for each call.
 * Hosts that cannot store multiline values keep the PEM with `\n` escapes (docs, Self-hosted
 * registration), so those are turned back into line breaks here.
 */
export function createAppJwt(ctx: OAuthContext): string {
  const appId = requireExtra(ctx.client, "appId").reveal();
  const privateKey = requireExtra(ctx.client, "privateKey").reveal().replaceAll("\\n", "\n");
  const nowSeconds = Math.floor(ctx.now().getTime() / 1000);
  const unsigned = `${base64UrlJson({ alg: "RS256", typ: "JWT" })}.${base64UrlJson({
    iat: nowSeconds - JWT_BACKDATE_SECONDS,
    exp: nowSeconds + JWT_LIFETIME_SECONDS,
    iss: appId,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

export function installationIdOf(credential: OAuthCredential): string {
  const installationId = credential.metadata?.[metadataKeys.installationId];
  if (installationId === undefined || !/^\d+$/.test(installationId)) {
    throw new AuthRevokedError("GitHub credential has no installation id; reconnect GitHub");
  }
  return installationId;
}

/**
 * The docs list 404 or 403 when the installation is gone or suspended as "needs reconnection"
 * (exact codes are in docs/providers/github.md, Unverified), so both become `auth_revoked`.
 */
async function withInstallationGoneAsRevoked<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (error) {
    if (
      (error instanceof PermissionMissingError && error.status === 403) ||
      (error instanceof InvalidResponseError && error.status === 404)
    ) {
      throw new AuthRevokedError("The GitHub App installation is no longer available; reconnect GitHub", {
        cause: error,
        status: error.status,
        ...(error.endpoint === undefined ? {} : { endpoint: error.endpoint }),
      });
    }
    throw error;
  }
}

/** `GET /app/installations/{id}` with the app JWT: the current account login, id, and type. */
export async function getInstallation(ctx: OAuthContext, installationId: string): Promise<Installation> {
  const installation = await withInstallationGoneAsRevoked(() =>
    getJson(ctx, `/app/installations/${installationId}`, createAppJwt(ctx), InstallationSchema),
  );
  assertNotSuspended(installation);
  return installation;
}

export function assertNotSuspended(installation: Installation): void {
  if (installation.suspended_at !== null && installation.suspended_at !== undefined) {
    throw new AuthRevokedError("The GitHub App installation is suspended; unsuspend it or reconnect GitHub");
  }
}

// Repository permissions the timeline's activity reads add (#62): merged pull requests and opened
// issues. Each is optional, because an installation made before they were added keeps them only once
// its owner accepts the app's new permissions, and until then stars, forks, releases, and billing
// must keep syncing. Releases need none: the repository events feed needs only Metadata read.
export const activityPermissions = ["pull_requests", "issues"] as const;

/** True when the installation holds `permission` at read level or above. */
export function grantsRead(installation: Installation, permission: string): boolean {
  const level = installation.permissions[permission];
  return level === "read" || level === "write" || level === "admin";
}

/**
 * Installation access token, minted per sync and never persisted (1 hour lifetime).
 * Narrowed to the read permissions the adapter uses; the organization permission has no effect
 * on a personal account install, so it is only requested for organizations. An activity
 * permission is requested only when the installation holds it: GitHub documents that a token
 * "cannot be granted permissions that the app was not granted".
 */
export async function mintInstallationToken(ctx: OAuthContext, installation: Installation): Promise<Secret> {
  const permissions: Record<string, string> =
    installation.account.type === "Organization"
      ? { metadata: "read", organization_administration: "read" }
      : { metadata: "read" };
  for (const permission of activityPermissions) {
    if (grantsRead(installation, permission)) permissions[permission] = "read";
  }
  const installationId = String(installation.id);
  const response = await withInstallationGoneAsRevoked(() =>
    fetchJson(
      ctx,
      new URL(`/app/installations/${installationId}/access_tokens`, API_ORIGIN),
      {
        method: "POST",
        headers: apiHeaders(createAppJwt(ctx), { "Content-Type": "application/json" }),
        body: JSON.stringify({ permissions }),
      },
      InstallationTokenSchema,
    ),
  );
  return new Secret(response.token);
}
