import "server-only";

import { notFound } from "next/navigation";
import { cache } from "react";

import { requireUser, type SessionUser } from "@/lib/auth/session";
import { superAdminEmails } from "@/lib/env";
import { log, logError } from "@/lib/log/logger";

/*
 * Super admins (#250) run the instance: they see its configuration and instance-wide figures. They
 * are named by email in STACKDASH_SUPER_ADMIN_EMAILS, matched against the verified email claim, the
 * same key the invite list uses. This is the one check every super admin surface calls; there is no
 * database role, so a super admin is no more than a workspace member anywhere else in the app.
 */

/** The super admin page's address: the instance overview. No route answers it directly. */
export const ADMIN_PATH = "/app/admin";

/**
 * The route that renders the instance overview (src/app/super-admin/). src/proxy.ts rewrites
 * ADMIN_PATH to it for a super admin only and answers any direct request to it as not found, so a
 * non super admin's ADMIN_PATH is a path with no route: the same 404 as any other (#374).
 */
export const ADMIN_ROUTE = "/super-admin";

/** True when `email` is on the super admin list. A user with no email is never one. */
export function isSuperAdminEmail(email: string | null, admins: ReadonlySet<string> = superAdminEmails()): boolean {
  return email !== null && admins.has(email.toLowerCase());
}

/**
 * Whether the app header and the command palette offer the way to the admin page (#364): the rule
 * `requireSuperAdmin` applies, for a user the caller already verified, so only a super admin's HTML
 * and RSC payload carry the link or `ADMIN_PATH`. An invalid list hides the link and logs why,
 * rather than failing every page that shows the header; the admin page itself still fails on it.
 * Cached per request, so the header and the palette share one check and one log line.
 */
export const showsAdminLink = cache((email: string | null): boolean => {
  try {
    return isSuperAdminEmail(email);
  } catch (error) {
    logError("admin.link_check_failed", error);
    return false;
  }
});

/**
 * Whether the proxy sends a request for ADMIN_PATH to ADMIN_ROUTE (#374), for a user the proxy
 * already verified. Anyone else's request is left alone, and ADMIN_PATH has no route, so it is the
 * global 404 with the same status and headers as any missing path. The status cannot come from the
 * page: with Cache Components a production build sends its prerendered static shell with a 200
 * before the page runs (Next.js docs, loading.js, "Status codes"). A refusal is logged as the page
 * logs it, because the page does not run for that request. An invalid list is logged and sent to
 * the page, which fails on it with its error page, as it did before the route moved.
 */
export function admitsToAdminRoute(user: Pick<SessionUser, "id" | "email">): boolean {
  let admitted: boolean;
  try {
    admitted = isSuperAdminEmail(user.email);
  } catch (error) {
    logError("admin.proxy_check_failed", error);
    return true;
  }
  if (!admitted) log.warn("admin.access_refused", { userId: user.id });
  return admitted;
}

/**
 * The signed-in super admin: the authorization for every super admin surface. Signed out, a
 * redirect to sign-in like every app page. Signed in as anyone else, notFound(), which on a
 * production build only streams the not-found page into a response already sent with a 200: the
 * 404 status, and a route that reveals nothing, come from the proxy sending only super admins to
 * ADMIN_ROUTE (`admitsToAdminRoute`, #374). A new super admin page needs the same treatment in
 * src/proxy.ts, or it answers a non super admin with a 200. Cached per request, so the page and its
 * metadata share one check and one log line.
 */
export const requireSuperAdmin = cache(async (nextPath: string): Promise<SessionUser> => {
  const user = await requireUser(nextPath);
  if (!isSuperAdminEmail(user.email)) {
    log.warn("admin.access_refused", { userId: user.id });
    notFound();
  }
  return user;
});
