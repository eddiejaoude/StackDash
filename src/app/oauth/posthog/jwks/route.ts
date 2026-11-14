import { connection, NextResponse } from "next/server";

import { postHogAdapter } from "@/lib/adapters/posthog";
import { loadSigningKey, METADATA_MAX_AGE_SECONDS, publicJwks, SigningKeyError } from "@/lib/adapters/posthog/client-auth";
import { loadOAuthClient } from "@/lib/adapters/registry";
import { logError } from "@/lib/log/logger";

/**
 * The public half of POSTHOG_OAUTH_PRIVATE_KEY as a JWKS, the `jwks_uri` of PostHog's client ID
 * metadata document. PostHog verifies every client assertion against it (Provisioning, Publish your
 * keys). Only public members leave the key: `publicJwks` copies the RFC 7638 members and nothing
 * else. Answered at request time, never prerendered, so a rotated key is published at once.
 */
export async function GET() {
  await connection();
  const client = loadOAuthClient(postHogAdapter);
  if (client === null) return new NextResponse("PostHog is not set up on this StackDash instance.", { status: 404 });

  try {
    const jwks = publicJwks(loadSigningKey(client.clientSecret.reveal()));
    return NextResponse.json(jwks, { headers: { "Cache-Control": `public, max-age=${METADATA_MAX_AGE_SECONDS}` } });
  } catch (error) {
    if (!(error instanceof SigningKeyError)) throw error;
    const ref = logError("posthog.jwks.invalid_key", error);
    return new NextResponse(`PostHog is not set up correctly on this StackDash instance. Reference: ${ref}`, {
      status: 500,
    });
  }
}
