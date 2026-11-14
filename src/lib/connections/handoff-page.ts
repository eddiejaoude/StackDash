import { FAKE_AUTHORIZE_PATH } from "@/lib/adapters/fake";

/*
 * The page the start route answers with (#40) instead of redirecting its form POST to the provider.
 * Browsers check CSP form-action on every redirect hop that follows a form submission, and a
 * provider's authorize URL can bounce through origins StackDash cannot list. A meta refresh (and the
 * link beside it, for a browser that ignores refresh) is a plain navigation, which form-action does
 * not govern, so the provider's hops need no entry in the app's policy.
 *
 * The page is served from /api, outside the proxy, so next.config.ts's static policy applies: it
 * has no script or style directives, which allows the style block below. The page carries no
 * script either way.
 */

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for an HTML text node or a double-quoted attribute value. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char] ?? char);
}

export type HandoffInput = Readonly<{
  providerName: string;
  /** The adapter's authorize URL. */
  authorizeUrl: URL;
  /** StackDash's own origin, where the dev-only fake provider's authorize route lives. */
  appOrigin: string;
}>;

/** Only an https provider page, or the fake provider's authorize route on StackDash's own origin. */
function isAllowedTarget(url: URL, appOrigin: string): boolean {
  if (url.protocol === "https:") return true;
  return url.origin === appOrigin && url.pathname === FAKE_AUTHORIZE_PATH;
}

/**
 * The handoff document: a zero-second meta refresh to the authorize URL, plus a heading and a link
 * to the same URL. Throws for any other target, so a misbuilt adapter URL (http, javascript:, data:)
 * never reaches the browser.
 */
export function handoffPage({ providerName, authorizeUrl, appOrigin }: HandoffInput): string {
  if (!isAllowedTarget(authorizeUrl, appOrigin)) {
    // The URL itself carries the state token, so only its scheme is logged.
    throw new Error(`Refusing to send the browser to a ${authorizeUrl.protocol} authorize URL.`);
  }
  const href = escapeHtml(authorizeUrl.href);
  const name = escapeHtml(providerName);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0;url=${href}">
<title>Continue to ${name}</title>
<style>
body { margin: 0; padding: 4rem 1.5rem; background: #0a0a0a; color: #ededed; font-family: system-ui, sans-serif; line-height: 1.5; }
main { max-width: 32rem; margin: 0 auto; }
h1 { margin: 0 0 0.75rem; font-size: 1.5rem; font-weight: 600; }
p { margin: 0 0 0.5rem; }
a { display: inline-block; padding: 0.25rem 0; color: #ff5d3b; }
a:focus-visible { outline: 2px solid #ff5d3b; outline-offset: 2px; border-radius: 2px; }
</style>
</head>
<body>
<main>
<h1>Continue to ${name}</h1>
<p>Taking you to ${name} to approve access.</p>
<p><a href="${href}">Continue to ${name}</a></p>
</main>
</body>
</html>
`;
}

/**
 * The start route's success answer. next.config.ts sets Referrer-Policy on every path and Next.js
 * keeps a header the config already set, so the meta referrer tag in the page is what keeps the
 * StackDash URL from reaching the provider; the header here covers a host that does not merge them.
 */
export function handoffResponse(input: HandoffInput): Response {
  return new Response(handoffPage(input), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
