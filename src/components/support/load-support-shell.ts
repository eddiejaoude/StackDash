import "server-only";

import { getCurrentUser } from "@/lib/auth/session";
import { showsAdminLink } from "@/lib/auth/super-admin";
import { logError } from "@/lib/log/logger";
import { memberUnreadCount, operatorUnreadCount } from "@/lib/support/threads";

import type { SupportShell } from "./support-unread";

/**
 * What the signed-in shell (the workspace layout, /account) hands SupportShellProvider (#680): the
 * user's id for the support channel, their unread count, and a super admin's operator count. Call
 * it without awaiting and pass the promise down, so it runs beside the shell's other reads and
 * nothing waits on it. The session read is request-cached, so it shares the shell's verification;
 * the two counts run together. It never rejects: a failure is logged and resolves to null, which
 * leaves the launcher and badges out of the page rather than breaking the shell.
 */
export async function loadSupportShell(): Promise<SupportShell | null> {
  try {
    const user = await getCurrentUser();
    if (user === null) return null;
    const [memberUnread, operatorUnread] = await Promise.all([
      memberUnreadCount(user.id),
      showsAdminLink(user) ? operatorUnreadCount(user.id) : null,
    ]);
    return { userId: user.id, memberUnread, operatorUnread };
  } catch (error) {
    logError("support.shell_load_failed", error);
    return null;
  }
}
