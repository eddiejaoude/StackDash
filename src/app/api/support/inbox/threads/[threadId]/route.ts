import type { NextRequest } from "next/server";
import { z } from "zod";

import { getCurrentUser } from "@/lib/auth/session";
import { isSuperAdminEmail, syncSuperAdminRow } from "@/lib/auth/super-admin";
import { superAdminEmails } from "@/lib/env";
import { logError } from "@/lib/log/logger";
import { loadOperatorConversation } from "@/lib/support/threads";

/*
 * One conversation for an operator (#680): GET /api/support/inbox/threads/<thread id>, and
 * `?before=<olderCursor>` for the page before. A route handler rather than a Server Action because
 * Next.js runs a client's actions one at a time, so opening a conversation would wait behind a
 * reply still sending (BackTalk README at 274976f^1, "The support inbox"); the inbox loads it on
 * open and after every Realtime hint. Authorized here, as every route handler is: signed out is 401,
 * and anyone who is not a super admin gets the same 404 as a thread that does not exist. JSON
 * throughout, never cached, because it holds personal data and signed image URLs.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest, ctx: RouteContext<"/api/support/inbox/threads/[threadId]">): Promise<Response> {
  const user = await getCurrentUser();
  if (user === null) return json(401, { error: "unauthenticated" });
  const { threadId } = await ctx.params;
  try {
    const admins = superAdminEmails();
    if (!isSuperAdminEmail(user.email, admins) || !z.guid().safeParse(threadId).success) return json(404, { error: "not_found" });
    await syncSuperAdminRow(user.id, admins);
    const conversation = await loadOperatorConversation(user.id, threadId, request.nextUrl.searchParams.get("before"));
    return conversation === null ? json(404, { error: "not_found" }) : json(200, { conversation });
  } catch (error) {
    return json(500, { error: "failed", referenceId: logError("support.inbox_conversation_failed", error) });
  }
}
