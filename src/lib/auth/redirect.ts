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

/** The sign-in form's field carrying the fragment the browser kept on `/sign-in` (#358). */
export const SIGN_IN_FRAGMENT_FIELD = "fragment";

// A fragment that names an element: every element id the app links to has this shape, the
// headings and the achievement items, whose ids have dots (`vercel.deployments.10`). Anything else
// on `/sign-in`, such as the `#error=...` Supabase Auth leaves after a failed provider sign-in, is
// not from the link the reader opened.
const SECTION_FRAGMENT = /^#[A-Za-z][A-Za-z0-9._-]*$/;

/**
 * `next` with `fragment`, the fragment the browser kept on `/sign-in`, as `safeNextPath` returns it.
 *
 * A fragment never reaches the server, so the proxy builds `next` without the one on the link the
 * reader opened; the browser carries it onto `/sign-in` and the sign-in form sends it back (#358).
 * It never widens what `next` may target: the path and fragment pass `safeNextPath` together, and
 * when they fail it (over the length limit) the fragment is dropped and the path is checked alone.
 * A `next` outside the app still gives `/app`, and a `next` that already has a fragment keeps its
 * own. Only a fragment that names a section counts; any other value gives the path alone.
 */
export function nextPathWithFragment(next: unknown, fragment: unknown): string {
  const path = safeNextPath(next);
  if (typeof next !== "string" || next.includes("#") || typeof fragment !== "string" || !SECTION_FRAGMENT.test(fragment)) {
    return path;
  }
  const combined = safeNextPath(`${next}${fragment}`);
  // The combined input always has a fragment, so DEFAULT_NEXT_PATH means safeNextPath refused it.
  return combined === DEFAULT_NEXT_PATH ? path : combined;
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
