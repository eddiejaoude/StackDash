import { isAppPath, parseRelativePath } from "@/lib/auth/redirect";

/** Longest path stored. Mirrors support_threads_from_page_format (20261128120100_support_chat.sql). */
const MAX_FROM_PAGE_LENGTH = 512;

/**
 * The page a user wrote from, as support chat (#680) records it: a relative path of the signed-in
 * app (`/app`, a workspace page, the account pages), with dot segments resolved, and with no query
 * string or fragment, which can carry search terms and tokens that context does not need. Null for
 * anything else; the message is still sent, only without the breadcrumb. The browser sends it, so
 * it is never trusted beyond that: it is display text for the operator.
 */
export function supportFromPage(input: unknown): string | null {
  const url = parseRelativePath(input);
  if (url === null) return null;
  const path = url.pathname;
  if (path.length > MAX_FROM_PAGE_LENGTH) return null;
  // The account pages are signed in, except the page shown after an account is deleted.
  const accountPage = path.startsWith("/account/") && path !== "/account/deleted" && !path.startsWith("/account/deleted/");
  return isAppPath(path) || accountPage ? path : null;
}
