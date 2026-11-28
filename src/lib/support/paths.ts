/*
 * Where support chat (#680) lives, for links in email, in the app shell, and in the command palette.
 * Client safe. The screens serve these paths; a screen that moves updates the path here, and the
 * email links follow.
 */

/** The user's full messages page (signed in). */
export const SUPPORT_MESSAGES_PATH = "/account/messages";

/**
 * The operators' inbox: ADMIN_PATH (src/lib/auth/super-admin.ts) plus "/inbox", which src/proxy.ts
 * treats as ADMIN_PATH is treated (#374): rewritten for a super admin, the global 404 for anyone
 * else. Written out because super-admin.ts is server only; paths.test.ts pins the two together.
 */
export const SUPPORT_INBOX_PATH = "/app/admin/inbox";

/** The query parameter that opens one conversation on either page. */
export const SUPPORT_THREAD_PARAM = "thread";

/** `path` opened on one conversation. */
export function supportThreadPath(path: typeof SUPPORT_MESSAGES_PATH | typeof SUPPORT_INBOX_PATH, threadId: string): string {
  return `${path}?${new URLSearchParams({ [SUPPORT_THREAD_PARAM]: threadId }).toString()}`;
}
