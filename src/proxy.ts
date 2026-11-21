import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { isAppPath, safeNextPath } from "@/lib/auth/redirect";
import { ADMIN_PATH, ADMIN_ROUTE, admitsToAdminRoute } from "@/lib/auth/super-admin";
import { findPublicProjectPage } from "@/lib/data/project-pages";
import { isLoopbackUrl, publicEnv } from "@/lib/env";
import { parseProjectPagePath, projectPagePath } from "@/lib/public-metrics/project-page";
import { checkPublicRateLimit, rateLimitedHeaders, rateLimitedPageHtml, type RateLimitDecision } from "@/lib/public-metrics/requests";
import type { Database } from "@/lib/supabase/database.types";

/**
 * Where a form on an app page may lead. Browsers apply form-action to every redirect hop of a
 * form submission, so the list names where that chain goes: without JavaScript the sign-in form
 * posts, then redirects through Supabase Auth to GitHub. The connect form's start route answers
 * with a page that moves on to the provider by meta refresh, a navigation form-action does not
 * govern, so no provider origin belongs here. The landing page has no such form and keeps
 * `form-action 'self'` (next.config.ts).
 */
function formActionSources(supabaseOrigin: string): string {
  return `'self' ${supabaseOrigin} https://github.com`;
}

/**
 * True when the browser asked for this page over plain http on this computer (`localhost`, a
 * 127.x.x.x address, or `[::1]`), the only case where the policy leaves out
 * `upgrade-insecure-requests` (#597). WebKit applies that directive to localhost too, so a
 * production build served on http://localhost (`npm run start`, the e2e run) asked for every
 * `/_next/static` file over https, which failed, and the page never hydrated in Safari. Chromium
 * and Firefox leave localhost alone. Hosted pages are https, so they keep the directive as before,
 * and so does plain http to any other host (a LAN address, a name that only starts with
 * localhost).
 *
 * The scheme is the first `x-forwarded-proto` value when a proxy in front set one (TLS ended
 * there), else the request URL's. The host is the one the browser addressed, `x-forwarded-host`
 * then `Host`, as isSameOrigin reads it: under `next start` the request URL's host is the address
 * the server was started on, not the one the browser used, so it is never read, and a request with
 * neither header keeps the directive. A client that forges these headers only drops the directive
 * from its own response, which is rendered per request with its own nonce and never cached
 * (`no-store`, held in e2e/csp.spec.ts), so nobody else's policy changes.
 */
function isPlainHttpToLoopback(request: NextRequest): boolean {
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const isHttp = forwardedProto ? forwardedProto === "http" : request.nextUrl.protocol === "http:";
  if (!isHttp) return false;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  return host !== null && isLoopbackUrl(`http://${host}`);
}

/**
 * Builds the per-request nonce policy, enforced on every proxied page. Next.js reads the nonce from
 * the request's CSP header and stamps it on the scripts it renders per request, so no page code has
 * to handle it. That only works for HTML rendered per request: a static shell prerendered at build
 * time carries no nonce. So every page a proxied path can answer with renders its HTML per request
 * (`instant = false` plus `connection()` at the top): each app entry segment (decision on issue
 * #125), the signed-out /unsubscribe page that alert emails link to (#152), and the global
 * not-found page that answers paths matching no route (#197).
 */
function contentSecurityPolicy(nonce: string, supabaseUrl: URL, request: NextRequest): string {
  const isDev = process.env.NODE_ENV === "development";
  const supabaseOrigin = supabaseUrl.origin;
  const supabaseSocket = `${supabaseUrl.protocol === "https:" ? "wss:" : "ws:"}//${supabaseUrl.host}`;

  return [
    "default-src 'self'",
    // No 'strict-dynamic': Next.js loads its chunks from this origin, and 'self' keeps them allowed.
    // 'unsafe-eval' only in development, where React rebuilds server error stacks with eval (per the
    // Next.js CSP guide); production policy never includes it.
    `script-src 'self' 'nonce-${nonce}'${isDev ? " 'unsafe-eval'" : ""}`,
    // Development injects unnonced style tags for hot reloading, as the Next.js CSP guide notes.
    `style-src 'self' ${isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    // Style attributes cannot carry a nonce, and server-rendered usage bars set their width with
    // one. Attributes cannot run script, so allowing them does not reopen script injection.
    "style-src-attr 'unsafe-inline'",
    // GitHub avatars appear next to the signed-in user.
    "img-src 'self' blob: data: https://avatars.githubusercontent.com",
    "font-src 'self'",
    `connect-src 'self' ${supabaseOrigin} ${supabaseSocket}`,
    "object-src 'none'",
    "base-uri 'self'",
    `form-action ${formActionSources(supabaseOrigin)}`,
    "frame-ancestors 'none'",
    // Local Supabase serves plain http on 127.0.0.1, which this directive would break in
    // development. A production build served over plain http on this computer leaves it out too,
    // or WebKit never hydrates the page (isPlainHttpToLoopback, #597).
    ...(isDev || isPlainHttpToLoopback(request) ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

// Doc slugs are lowercase (isDocSlug in src/lib/docs.ts), so a /docs path with an uppercase letter
// is never a doc. It is answered here, before Next looks the path up in its prerender cache: that
// cache is files on disk, and on a case-insensitive file system (macOS) /docs/Providers/Vercel
// would find the prerendered /docs/providers/vercel and serve it with a 200. The rewrite target is
// a slug that can never exist (`_` is outside the slug alphabet), so the docs route renders its
// not-found page with a 404 status.
const MIS_CASED_DOC_PATH = /^\/docs\/.*[A-Z]/;
const UNKNOWN_DOC_PATH = "/docs/_";

// Public project pages (#150) are addressed as /@<handle or workspace slug>/<page slug>. A route
// folder that starts with @ is a parallel route slot, so the address is rewritten to the page route
// under /p. That route is never answered under its own path: anything else under /@ or /p is
// rewritten to a path no route matches, so a page has one address and every other path there is the
// global 404. parseProjectPagePath applies the page's own slug and handle rules, length limits
// included, so a path the page would refuse never reaches the database.
//
// While a workspace has a handle (#258), its slug address answers 307 to the handle address.
// Temporary, not 308: a handle can change or be removed, and the old one is released at once for
// any workspace to claim, so no browser or crawler may keep the redirect. An unknown handle, a
// released one, and another workspace's handle with this page slug get the same 404.
const UNKNOWN_PROJECT_PAGE = "/p/_";

// The super admin page (#250) is addressed as ADMIN_PATH, which has no route of its own: only a
// super admin's request is rewritten to ADMIN_ROUTE, where the page is. Anyone else's is left alone
// and is the global 404, with the same status and headers as any missing /app path; a rewrite to a
// 404 path would show in the x-middleware-rewrite response header (#374). ADMIN_ROUTE is never
// answered under its own path: every request there is rewritten to one path no route matches, so
// the route and any missing path under it answer alike.
const UNKNOWN_ADMIN_ROUTE = `${ADMIN_ROUTE}/_`;

type ProjectPageRoute =
  | { redirect: string }
  | { rewrite: string }
  | { limited: Extract<RateLimitDecision, { allowed: false }> };

/**
 * Where a public address goes: the handle address for a slug address of a workspace with a handle,
 * the page route for the address the page answers at, the 404 path, or a refusal past the public
 * rate limit. It asks public_project_page(), the same rule the page reads, because with Cache
 * Components the page streams its shell with a 200 before its own notFound() can run, so only a
 * check before the render can answer a real 404 (Next.js docs, loading.js, "Status codes"). The
 * page keeps its own check for a page turned off between the two reads.
 *
 * The rate limit is the badge and card routes' (checkPublicRateLimit, one count per client IP
 * across every public read, #321), decided here for the same reason: only the proxy can still
 * answer a 429. It counts before the lookup, as those routes do, so a refused request reads
 * nothing else, and only for a well-formed address, the only kind that reaches the database.
 */
async function routeProjectPage(pathname: string, headers: Headers): Promise<ProjectPageRoute> {
  const address = parseProjectPagePath(pathname);
  if (address === null) return { rewrite: UNKNOWN_PROJECT_PAGE };
  const limit = await checkPublicRateLimit(headers, new Date());
  if (!limit.allowed) return { limited: limit };
  const page = await findPublicProjectPage(address.workspaceAddress, address.pageSlug);
  if (page === null) return { rewrite: UNKNOWN_PROJECT_PAGE };
  if (page.workspace.handle !== null && page.workspace.handle !== address.workspaceAddress) {
    return { redirect: projectPagePath(page.workspace, address.pageSlug) };
  }
  return { rewrite: `/p/${address.workspaceAddress}/${address.pageSlug}` };
}

/** Puts a fresh nonce policy on the request (Next.js stamps its scripts with it) and the response. */
function withNoncePolicy(
  request: NextRequest,
  supabaseUrl: string,
  respond: (init: { request: { headers: Headers } }) => NextResponse,
): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce, new URL(supabaseUrl), request);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("Content-Security-Policy", policy);
  const response = respond({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

/**
 * Refreshes the Supabase session cookie, bounces signed-out visitors away from app pages, sets the
 * CSP headers, rewrites public project page addresses, sends a super admin's ADMIN_PATH to the
 * page's route (the only way to reach it), and answers that route's own path as not found. This is
 * not authorization: every page, Server Function, and route handler still checks the user itself,
 * because a matcher can drift and silently stop covering a path.
 */
export async function proxy(request: NextRequest) {
  if (MIS_CASED_DOC_PATH.test(request.nextUrl.pathname)) {
    // No session refresh and no app CSP: docs keep the static policy from next.config.ts.
    return NextResponse.rewrite(new URL(UNKNOWN_DOC_PATH, request.url));
  }

  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith("/@") || pathname === "/p" || pathname.startsWith("/p/")) {
    // No session refresh: nothing on a public page depends on who is signed in. The nonce policy
    // still applies, because the page renders its scripts per request.
    const route = await routeProjectPage(pathname, request.headers);
    if ("redirect" in route) {
      const target = request.nextUrl.clone();
      target.pathname = route.redirect;
      return NextResponse.redirect(target, 307);
    }
    if ("limited" in route) {
      return withNoncePolicy(
        request,
        publicEnv().NEXT_PUBLIC_SUPABASE_URL,
        () =>
          new NextResponse(rateLimitedPageHtml(route.limited), {
            status: 429,
            headers: { "Content-Type": "text/html; charset=utf-8", ...rateLimitedHeaders(route.limited) },
          }),
      );
    }
    return withNoncePolicy(request, publicEnv().NEXT_PUBLIC_SUPABASE_URL, (init) =>
      NextResponse.rewrite(new URL(route.rewrite, request.url), init),
    );
  }

  if (pathname === ADMIN_ROUTE || pathname.startsWith(`${ADMIN_ROUTE}/`)) {
    // No session refresh: nothing is rendered for anyone here. The nonce policy still applies,
    // because the global 404 renders its scripts per request.
    return withNoncePolicy(request, publicEnv().NEXT_PUBLIC_SUPABASE_URL, (init) =>
      NextResponse.rewrite(new URL(UNKNOWN_ADMIN_ROUTE, request.url), init),
    );
  }

  const { NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY } = publicEnv();

  // Cookie writes are collected and applied to whichever response this request ends with.
  const cookiesToApply: { name: string; value: string; options: CookieOptions }[] = [];
  const headersToApply: Record<string, string> = {};

  const supabase = createServerClient<Database>(
    NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          // Updating the request cookies forwards the refreshed tokens to this request's render,
          // so Server Components do not try (and fail) to refresh the same single-use token.
          for (const { name, value } of cookiesToSet) request.cookies.set(name, value);
          cookiesToApply.push(...cookiesToSet);
          Object.assign(headersToApply, headers);
        },
      },
    },
  );

  // Verifies the access token and refreshes it when it is close to expiry. Run before deciding
  // anything else so a refresh is never lost to an early return. Local with an asymmetric signing
  // key, an Auth server call per request with the legacy secret (see getCurrentUser, #318).
  const { data } = await supabase.auth.getClaims();
  const signedIn = data !== null;

  let response: NextResponse;
  if (!signedIn && isAppPath(pathname)) {
    const signIn = new URL("/sign-in", request.url);
    signIn.searchParams.set("next", safeNextPath(`${pathname}${search}`));
    response = NextResponse.redirect(signIn);
  } else if (
    signedIn &&
    pathname === ADMIN_PATH &&
    admitsToAdminRoute({ id: data.claims.sub, email: data.claims.email ?? null })
  ) {
    // The page reads `after` from the query, which a rewrite to a bare path would drop.
    const target = request.nextUrl.clone();
    target.pathname = ADMIN_ROUTE;
    response = withNoncePolicy(request, NEXT_PUBLIC_SUPABASE_URL, (init) => NextResponse.rewrite(target, init));
  } else {
    response = withNoncePolicy(request, NEXT_PUBLIC_SUPABASE_URL, (init) => NextResponse.next(init));
  }

  for (const { name, value, options } of cookiesToApply) response.cookies.set(name, value, options);
  // Cache-Control: private, no-store when auth cookies change, so no CDN serves one user's tokens
  // to another.
  for (const [key, value] of Object.entries(headersToApply)) response.headers.set(key, value);
  return response;
}

// The signed-in app, the account page, the auth pages, the signed-out /unsubscribe page (it reads
// its link per request and posts a form, so it gets the full policy), public project pages (/@
// addresses and the /p route they are rewritten to), the super admin route (ADMIN_ROUTE, answered
// as not found above), plus /docs paths with an uppercase letter
// (answered as not found above, before any session or CSP work). The landing page, the docs, the
// signed-out /account/deleted page, API routes, and static assets stay out: they need no session
// refresh, and a nonce would force static pages to render per request. next.config.ts applies the
// static CSP to every path except the paths listed here; keep them in sync.
//
// Next compiles each matcher to a case-sensitive regular expression, so the docs entry matches only
// paths that contain an uppercase letter and correctly cased docs never invoke the proxy. "/@" is
// followed by a pattern rather than `:path*`, which repeats only after a slash.
export const config = {
  matcher: [
    "/app",
    "/app/:path*",
    "/w/:path*",
    "/account",
    "/sign-in",
    "/auth/:path*",
    "/unsubscribe",
    "/docs/:path(.*[A-Z].*)",
    "/@:path(.*)",
    "/p/:path*",
    "/super-admin",
    "/super-admin/:path*",
  ],
};
