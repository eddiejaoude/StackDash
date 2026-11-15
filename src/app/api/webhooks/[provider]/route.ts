import { createReceiveDeps, receiveWebhook } from "@/lib/webhooks/receive";

/*
 * POST /api/webhooks/<provider> (#28): the one URL on StackDash's own app registration, for a
 * provider whose adapter declares an `app` webhook. Verified against the instance secret, stored,
 * and applied on the next tick; see src/lib/webhooks/receive.ts and docs/operations/jobs.md.
 * POST only: any other method gets 405 from Next.js.
 */
export async function POST(request: Request, ctx: RouteContext<"/api/webhooks/[provider]">): Promise<Response> {
  const { provider } = await ctx.params;
  return receiveWebhook({ provider, endpointId: null, request }, createReceiveDeps());
}
