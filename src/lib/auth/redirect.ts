export const DEFAULT_NEXT_PATH = "/app";

const MAX_NEXT_PATH_LENGTH = 512;

// A placeholder origin for parsing. `.invalid` is reserved (RFC 2606), so it can never collide with
// a real host, and any input that resolves to a different origin is absolute and rejected.
const PARSE_BASE = "https://stackdash.invalid";

// Browsers treat a backslash as a slash and silently drop tabs and newlines in URLs, so "/\evil.com"
// or "/\t/evil.com" can navigate to another origin even though it looks relative.
const UNSAFE_CHARACTERS = /[\\\u0000-\u001f\u007f]/;

/**
 * Paths of the signed-in app: the proxy requires a session for these, and `next` may only target
 * them. `/account` is exact: `/account/deleted` is shown after sign-out and must stay public.
 */
export function isAppPath(pathname: string): boolean {
  return pathname === "/app" || pathname.startsWith("/app/") || pathname.startsWith("/w/") || pathname === "/account";
}

/**
 * Returns `input` when it is a relative path inside the signed-in app, otherwise `/app`.
 *
 * `next` values arrive from query strings and form fields, so passing one straight to a redirect is
 * an open redirect. Only same-origin paths under `/app` or `/w/` survive; the result is rebuilt from
 * the parsed URL so dot segments such as `/w/../evil` are resolved before the prefix check.
 */
export function safeNextPath(input: unknown): string {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_NEXT_PATH_LENGTH) {
    return DEFAULT_NEXT_PATH;
  }
  if (!input.startsWith("/") || input.startsWith("//") || UNSAFE_CHARACTERS.test(input)) {
    return DEFAULT_NEXT_PATH;
  }

  // Check the decoded form too: an encoded backslash, control character, or leading "//" is a sign
  // of a smuggling attempt even if this parser would keep it inert.
  let decoded: string;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  if (decoded.startsWith("//") || UNSAFE_CHARACTERS.test(decoded)) {
    return DEFAULT_NEXT_PATH;
  }

  let url: URL;
  try {
    url = new URL(input, PARSE_BASE);
  } catch {
    return DEFAULT_NEXT_PATH;
  }
  if (url.origin !== PARSE_BASE || !isAppPath(url.pathname)) {
    return DEFAULT_NEXT_PATH;
  }

  const path = `${url.pathname}${url.search}${url.hash}`;
  return path.length > MAX_NEXT_PATH_LENGTH ? DEFAULT_NEXT_PATH : path;
}

/** Codes the auth routes put in `/sign-in?error=`. The sign-in page has a message for each. */
export const SIGN_IN_ERROR_CODES = ["not_invited", "cancelled", "start_failed", "callback_failed", "link_invalid", "link_failed"] as const;

export type SignInErrorCode = (typeof SIGN_IN_ERROR_CODES)[number];

/**
 * `/sign-in` on `base`'s origin showing `error`, with the log reference when there is one, and
 * `next` for after sign-in. Pass `next` through `safeNextPath` first.
 */
export function signInErrorUrl(base: string | URL, error: SignInErrorCode, next: string, referenceId?: string): URL {
  const url = new URL("/sign-in", base);
  url.searchParams.set("error", error);
  if (referenceId !== undefined) url.searchParams.set("ref", referenceId);
  url.searchParams.set("next", next);
  return url;
}
