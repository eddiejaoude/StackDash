import type { NextRequest } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { logError } from "@/lib/log/logger";
import { listMemberThreads, memberUnreadCount } from "@/lib/support/threads";

/*
 * The signed-in user's conversations (#680): GET /api/support/threads, `?cursor=<nextCursor>` for
 * the next page, unread first, with their unread count for the badge (null when it could not be
 * read: keep the badge as it is). For the launcher and for reloads after a Realtime hint. Signed out
 * is 401. JSON, never cached.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function GET(request: NextRequest): Promise<Response> {
  const user = await getCurrentUser();
  if (user === null) return json(401, { error: "unauthenticated" });
  try {
    const [page, unreadCount] = await Promise.all([
      listMemberThreads(user.id, request.nextUrl.searchParams.get("cursor")),
      memberUnreadCount(user.id),
    ]);
    return json(200, { ...page, unreadCount });
  } catch (error) {
    return json(500, { error: "failed", referenceId: logError("support.threads_failed", error) });
  }
}
