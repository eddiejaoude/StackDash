"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";

/**
 * Sends Vercel Web Analytics an event's page address without its query string or fragment (#439).
 * Those carry secrets: the token in an /unsubscribe link and the OAuth `code` and `state` on the
 * auth and connection callbacks. The path itself is sent, workspace handle included, and the
 * component reports the route pattern beside it (`/w/[workspace]/timeline`).
 *
 * One limit this cannot reach: on a route with no dynamic segment, the package builds that route
 * from the query (`useRoute` and `computeRoute` in `@vercel/analytics/next`), so a query key can
 * appear in it: `/?ref=` is reported as `/[ref]`, and `/docs/mcp?x=mcp` as `/docs/[x]`. Only a key
 * name, and only where its value is empty or equals a path segment; query values are never sent.
 *
 * A cut at the first `?` or `#` rather than a `URL` round trip, because nothing needs parsing: the
 * insights script passes `location.href` or a `URL` href, where the query comes before the
 * fragment and neither character appears unencoded in the path, so the first of the two ends it.
 */
export function withoutQueryOrFragment(event: BeforeSendEvent): BeforeSendEvent {
  const end = event.url.search(/[?#]/);
  return end === -1 ? event : { ...event, url: event.url.slice(0, end) };
}

/**
 * Counts page views with Vercel Web Analytics: no cookies, and on Vercel the script and the intake
 * are this origin's own, so the content security policies need no change. A client component
 * because `beforeSend` is a function, which a Server Component cannot pass down. The root documents
 * render it only on Vercel (`onVercel`), so a self-hosted install loads nothing.
 */
export function WebAnalytics() {
  return <Analytics beforeSend={withoutQueryOrFragment} />;
}
