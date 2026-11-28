import { getCurrentUser } from "@/lib/auth/session";
import { isSuperAdminEmail, syncSuperAdminRow } from "@/lib/auth/super-admin";
import { superAdminEmails } from "@/lib/env";
import { logError } from "@/lib/log/logger";
import { operatorUnreadCount } from "@/lib/support/threads";

/*
 * The signed-in operator's unread count (#680): GET /api/support/inbox/unread answers
 * `{ unreadCount }`, the active threads with activity after this operator's own read markers, or
 * null when it could not be read (keep the badge as it is). For the Admin link's badge in the app
 * shell, which reads it again after each hint on the operators' topic instead of refreshing the
 * whole page. Authorized as the inbox's conversation route is: signed out is 401, and anyone who is
 * not a super admin gets a 404. JSON, never cached.
 */

const NO_STORE = { "Cache-Control": "no-store" };

function json(status: number, body: unknown): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function GET(): Promise<Response> {
  const user = await getCurrentUser();
  if (user === null) return json(401, { error: "unauthenticated" });
  try {
    const admins = superAdminEmails();
    if (!isSuperAdminEmail(user.email, admins)) return json(404, { error: "not_found" });
    await syncSuperAdminRow(user.id, admins);
    return json(200, { unreadCount: await operatorUnreadCount(user.id) });
  } catch (error) {
    return json(500, { error: "failed", referenceId: logError("support.inbox_unread_failed", error) });
  }
}
