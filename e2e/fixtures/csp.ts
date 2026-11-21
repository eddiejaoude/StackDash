import type { Page } from "@playwright/test";

// The static policy next.config.ts sends on every route outside the proxy matcher in src/proxy.ts:
// the landing page, the docs, and the legal pages (#339). A route that gains the proxy, and with it
// the session refresh, gets the nonce policy instead, so a spec that expects this one notices.
export const BASELINE_CSP = "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

/**
 * For WebKit only: every `@touch` test calls it in WebKit before its first navigation.
 * WebKit applies the production policy's `upgrade-insecure-requests` (src/proxy.ts) to localhost:
 * against CI's production build on http://localhost it asks for every `/_next/static` file over
 * https, which fails, and the page never hydrates. A local run on the dev server passes without it,
 * because the dev policy has no `upgrade-insecure-requests`. Chromium and Firefox leave localhost
 * alone, so they keep the policy the app ships, and `bypassCSP` does not stop the upgrade. Drops
 * that one directive from each document's policy and keeps the rest, until #597 settles the policy
 * for plain http. A route added later, such as `interceptSignOut`'s in e2e/timeline.spec.ts, runs
 * before this one.
 */
export async function keepLocalhostOnHttp(page: Page): Promise<void> {
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch({ maxRedirects: 0 });
    const headers = response.headers();
    const policy = headers["content-security-policy"];
    if (policy === undefined) return route.fulfill({ response });
    await route.fulfill({ response, headers: { ...headers, "content-security-policy": policy.replace(/;\s*upgrade-insecure-requests\b/, "") } });
  });
}
