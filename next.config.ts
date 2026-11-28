import type { NextConfig } from "next";

// Baseline browser policy for every route.
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
];

// Static CSP for routes outside the proxy (the landing page, API routes, assets). It covers
// framing, base, form, and plugin policy only: a script-src policy needs per-request nonces, which
// would make the static landing page dynamic. src/proxy.ts enforces a full nonce policy on app
// routes with the same four directives, except that form-action there also allows the
// no-JavaScript sign-in redirect chain; e2e/csp.spec.ts asserts both. This header is kept off the
// proxied paths rather than replaced there: a second policy would be enforced alongside the nonce
// policy, and the Next.js docs give no order between a header set here and one the proxy sets.
const staticCsp = {
  key: "Content-Security-Policy",
  value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
};

// Every path except the paths in the proxy matcher in src/proxy.ts (/app, /app/*, /w, /w/*,
// /account, /account/messages, /sign-in, /auth, /auth/*, /unsubscribe, the public project pages at
// /@* and /p/*, and the super admin route at /super-admin and /super-admin/*). Keep the two lists
// in sync; src/proxy.test.ts checks them together. Next matches these sources without regard to
// case, so /App and /W/x are kept out as well, and the proxy matcher spells each prefix in every
// case to give them the nonce policy (#376). The proxy also matches mis-cased /docs paths but sets
// no CSP there, so they stay covered here.
const outsideProxy =
  "/((?!app$|app/|w$|w/|account$|account/messages$|sign-in$|auth$|auth/|unsubscribe$|@|p$|p/|super-admin$|super-admin/).*)";

// Badges (#149) are SVG documents another site embeds and anyone can open directly: opened as a
// page, they may load and run nothing. Next applies these headers before a route handler runs and
// drops a handler's header of the same name, so the policy lives here, not in the route. Listed
// after outsideProxy, so it replaces the static policy for /badge/* (the last matching entry wins).
const badgeCsp = {
  key: "Content-Security-Policy",
  value: "default-src 'none'; frame-ancestors 'none'; sandbox",
};

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  experimental: {
    // src/app/global-not-found.tsx answers unmatched URLs, rendered per request so the 404 under the
    // app paths carries the CSP nonce (#197). The root not-found.tsx cannot: it is rendered into every
    // route, so request data there would make the prerendered pages dynamic.
    globalNotFound: true,
  },
  // src/lib/docs.ts reads docs/**/*.md with fs. A /docs slug that was not prerendered renders on
  // demand (and answers 404), so the Markdown ships with that route's server output, the MCP
  // endpoint serves the provider pages as resources (#163), and /sitemap.xml lists every docs page
  // per request (#338). The super admin page compares the database's newest migration with the
  // newest file in this build (src/lib/admin/deployment.ts, #250).
  outputFileTracingIncludes: {
    "/docs/**": ["./docs/**/*.md"],
    "/api/mcp": ["./docs/**/*.md"],
    "/sitemap.xml": ["./docs/**/*.md"],
    "/super-admin": ["./supabase/migrations/*.sql"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: outsideProxy, headers: [staticCsp] },
      { source: "/badge/:path*", headers: [badgeCsp] },
    ];
  },
};

export default nextConfig;
