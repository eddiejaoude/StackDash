import { NextResponse } from "next/server";

import { postHogAdapter } from "@/lib/adapters/posthog";
import {
  CLIENT_METADATA_PATH,
  clientMetadataDocument,
  METADATA_MAX_AGE_SECONDS,
} from "@/lib/adapters/posthog/client-auth";
import { loadOAuthClient } from "@/lib/adapters/registry";
import { callbackRedirectUri, connectOrigin } from "@/lib/connections/oauth-state";
import { log } from "@/lib/log/logger";

const NOT_SET_UP = "PostHog is not set up on this StackDash instance.";

/**
 * PostHog's client ID metadata document (#115, docs/providers/posthog.md, Self-hosted registration).
 * POSTHOG_OAUTH_CLIENT_ID is this route's own URL; PostHog fetches it, unauthenticated and without
 * following redirects, the first time someone authorizes StackDash and again when its cache expires.
 * Public by design: it holds only what PostHog's consent screen shows and where to send the user
 * back. `request.url` is read first, which makes this a request-time handler (Route Handlers, "With
 * Cache Components"), so the environment is read when PostHog asks, never baked in at build time.
 */
export async function GET(request: Request) {
  const origin = connectOrigin(request.url, process.env.NEXT_PUBLIC_SITE_URL);
  const client = loadOAuthClient(postHogAdapter);
  if (client === null) return new NextResponse(NOT_SET_UP, { status: 404 });

  const expected = `${origin}${CLIENT_METADATA_PATH}`;
  if (client.clientId !== expected) {
    // PostHog rejects a document whose client_id differs from its URL, so serving it would only
    // move the failure to the consent screen. The URL is public; the log names both values.
    log.warn("posthog.client_metadata.client_id_mismatch", { configured: client.clientId, expected });
    return new NextResponse(NOT_SET_UP, { status: 404 });
  }

  const document = clientMetadataDocument({
    clientId: client.clientId,
    origin,
    redirectUri: callbackRedirectUri(origin, "posthog"),
    scopes: postHogAdapter.oauth.scopes,
  });
  return NextResponse.json(document, {
    headers: { "Cache-Control": `public, max-age=${METADATA_MAX_AGE_SECONDS}` },
  });
}
