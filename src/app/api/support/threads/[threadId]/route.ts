import type { NextRequest } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { logError } from "@/lib/log/logger";
import { loadMemberConversation } from "@/lib/support/threads";

/*
 * One of the signed-in user's own conversations (#680): GET /api/support/threads/<thread id>, and
 * `?before=<olderCursor>` for the page before. For the launcher, which loads only once it is opened,
 * and for any screen reloading after a Realtime hint. Signed out is 401; a thread that does not
 * exist and one that is someone else's are the same 404. JSON, never cached.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/support/threads/[threadId]">): Promise<Response> {
  const user = await getCurrentUser();
  if (user === null) return json(401, { error: "unauthenticated" });
  const { threadId } = await ctx.params;
  if (!z.guid().safeParse(threadId).success) return json(404, { error: "not_found" });
  try {
    const conversation = await loadMemberConversation(user.id, threadId, request.nextUrl.searchParams.get("before"));
    return conversation === null ? json(404, { error: "not_found" }) : json(200, { conversation });
  } catch (error) {
    return json(500, { error: "failed", referenceId: logError("support.conversation_failed", error) });
  }
}
