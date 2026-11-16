import { createReceiveDeps, receiveWebhook } from "@/lib/webhooks/receive";

/*
 * POST /api/webhooks/<provider>/<endpointId> (#28): one URL per connection, for a provider whose
 * adapter declares a `connection` webhook (created through its API or pasted by the user, #426).
 * Verified against that connection's stored secret, stored, and applied on the next tick; see
 * src/lib/webhooks/receive.ts and docs/operations/jobs.md. POST only: any other method gets 405
 * from Next.js.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/webhooks/[provider]/[endpointId]">): Promise<Response> {
  const { provider, endpointId } = await ctx.params;
  return receiveWebhook({ provider, endpointId, request }, createReceiveDeps());
}
