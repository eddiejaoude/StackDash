// The static policy next.config.ts sends on every route outside the proxy matcher in src/proxy.ts:
// the landing page, the docs, and the legal pages (#339). A route that gains the proxy, and with it
// the session refresh, gets the nonce policy instead, so a spec that expects this one notices.
export const BASELINE_CSP = "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";
