import { createMcpHandler, originValidationResponse, readRequestBody } from "@modelcontextprotocol/server";
import { unstable_rethrow } from "next/navigation";

import { authenticateApiRequest, rateLimitHeaders } from "@/lib/api/auth";
import { apiErrorResponse, invalidRequest } from "@/lib/api/errors";
import { connectOrigin } from "@/lib/connections/oauth-state";
import { log } from "@/lib/log/logger";
import { authInfoFor, createStackDashMcpServer, principalFrom } from "@/lib/mcp/server";

/*
 * The read-only MCP endpoint (#163), Streamable HTTP at /api/mcp. Each request goes through the
 * REST API's key check first (authenticateApiRequest: 401 for a key that does not work, 429 past
 * the per key limit, the same error envelope as /api/v1), then the SDK's handler, which builds a
 * fresh server for that key (src/lib/mcp/server.ts). Stateless: nothing is kept between requests,
 * so it runs the same on every server and on a self-hosted install. See docs/mcp.md.
 */

// Tool calls carry a few short filters; anything near this size is not a StackDash request.
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

// no-transform, which the SDK sets on its event streams, keeps a proxy from buffering or
// compressing one; no-store keeps any answer out of a cache.
const NO_STORE = { "Cache-Control": "no-store, no-transform" } as const;

// The default response mode answers with one JSON body unless a tool sends progress or log
// messages first, and none does.
const handler = createMcpHandler(({ authInfo }) => createStackDashMcpServer(principalFrom(authInfo)), {
  maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
  onerror: (error) => log.warn("mcp.request_rejected", { message: error.message }),
});

/*
 * Whether the body is a JSON-RPC batch. The SDK's 2025 leg dispatches every message of a batch
 * array (up to 100), so one request, counted once against the key's limit, could run a hundred tool
 * calls. Batches left the protocol in 2025-06-18, and no StackDash client needs one. The check reads
 * a copy, so the SDK still reads the original and answers a body that is too large or not JSON.
 */
async function isBatch(request: Request): Promise<boolean> {
  const body = await readRequestBody(request.clone(), MAX_REQUEST_BODY_BYTES);
  if (body.tooLarge) return false;
  try {
    return Array.isArray(JSON.parse(body.text));
  } catch {
    return false;
  }
}

// Every MCP message is a POST (Streamable HTTP, Sending Messages). The endpoint keeps no sessions,
// so it has no GET stream or DELETE, and Next.js answers those methods with 405.
export async function POST(request: Request): Promise<Response> {
  // Streamable HTTP, Security: a request whose Origin is another site's is refused with 403 before
  // anything else, so a web page cannot drive the endpoint from a visitor's browser.
  const ownHostname = new URL(connectOrigin(request.url, process.env.NEXT_PUBLIC_SITE_URL)).hostname;
  const rejected = originValidationResponse(request, [ownHostname]);
  if (rejected !== undefined) return rejected;

  let headers: Record<string, string> = { ...NO_STORE };
  try {
    const { principal, rateLimit } = await authenticateApiRequest(request);
    headers = { ...headers, ...rateLimitHeaders(rateLimit) };
    if (await isBatch(request)) throw invalidRequest("Send one JSON-RPC message per request.");
    const response = await handler.fetch(request, { authInfo: authInfoFor(principal) });
    const merged = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: merged });
  } catch (error) {
    // A Next.js control-flow error (notFound, redirect) belongs to Next.js, as in src/lib/api/route.ts.
    unstable_rethrow(error);
    return apiErrorResponse(error, headers);
  }
}
