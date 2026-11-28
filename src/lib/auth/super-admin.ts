import "server-only";

import { notFound } from "next/navigation";
import { after } from "next/server";
import { cache } from "react";

import { requireUser, type SessionUser } from "@/lib/auth/session";
import { superAdminEmails } from "@/lib/env";
import { log, logError } from "@/lib/log/logger";
import { createAdminClient } from "@/lib/supabase/admin";

/*
 * Super admins (#250) run the instance: they see its configuration and instance-wide figures. They
 * are named by email in STACKDASH_SUPER_ADMIN_EMAILS, matched against the verified email claim, the
 * same key the invite list uses. This is the one check every super admin surface calls. A super
 * admin is no more than a workspace member anywhere else in the app.
 *
 * The env list stays the source of truth, and the database holds a mirror of it (public.super_admins,
 * #680): Realtime and Storage authorize support chat through row level security, which can only read
 * the database (is_super_admin()). The mirror follows the list in two places:
 * - every super admin check here (requireSuperAdmin, showsAdminLink) syncs the signed-in user's row:
 *   a listed account with a confirmed email gets one, an account that is not listed loses it;
 * - every server start (src/instrumentation.ts) deletes the rows of accounts no longer listed.
 * So removing an address and redeploying revokes it, and the next check of that user already has.
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

// Every outbound call has a timeout; at boot an unreachable database must not hold the server.
const MIRROR_TIMEOUT_MS = 5000;

/**
 * Makes the user's mirror row follow `admins` (sync_super_admin in
 * 20261128120000_super_admins.sql): a row while the account's confirmed email is listed, none
 * otherwise. The database reads the account's current email itself rather than trusting the
 * session's copy. Returns whether the user has a row afterwards; a failure is logged and answers
 * false, and the next check tries again.
 */
export async function syncSuperAdminRow(userId: string, admins: ReadonlySet<string>): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .rpc("sync_super_admin", { p_user_id: userId, p_listed_emails: [...admins] })
    .abortSignal(AbortSignal.timeout(MIRROR_TIMEOUT_MS));
  if (error) {
    logError("admin.mirror_sync_failed", error, { userId });
    return false;
  }
  return data;
}

/**
 * The boot reconcile (src/instrumentation.ts): deletes every mirror row whose account email is not
 * on the list, case-insensitively. An empty list empties the table, and so does a list that is not
 * valid, which no super admin page accepts either. Never throws: a failure is logged as an error,
 * since stale rows keep their Realtime and Storage access until the next start or check.
 */
export async function reconcileSuperAdmins(): Promise<void> {
  let admins: ReadonlySet<string>;
  try {
    admins = superAdminEmails();
  } catch (error) {
    logError("admin.mirror_list_invalid", error);
    admins = new Set();
  }
  try {
    const { data, error } = await createAdminClient()
      .rpc("reconcile_super_admins", { p_listed_emails: [...admins] })
      .abortSignal(AbortSignal.timeout(MIRROR_TIMEOUT_MS));
    if (error) throw new Error("Reconciling the super admin mirror failed", { cause: error });
    if (data > 0) log.info("admin.mirror_reconciled", { removed: data, listed: admins.size });
  } catch (error) {
    logError("admin.mirror_reconcile_failed", error);
  }
}

/**
 * Whether the app header and the command palette offer the way to the admin page (#364): the rule
 * `requireSuperAdmin` applies, for a user the caller already verified, so only a super admin's HTML
 * and RSC payload carry the link or `ADMIN_PATH`. An invalid list hides the link and logs why,
 * rather than failing every page that shows the header; the admin page itself still fails on it.
 * The mirror row is synced after the response, so the page never waits on it. Cached per request,
 * so the header and the palette share one check, one log line, and one sync.
 */
export const showsAdminLink = cache((user: Pick<SessionUser, "id" | "email">): boolean => {
  let admins: ReadonlySet<string>;
  try {
    admins = superAdminEmails();
  } catch (error) {
    logError("admin.link_check_failed", error);
    admins = new Set();
  }
  after(() => syncSuperAdminRow(user.id, admins));
  return isSuperAdminEmail(user.email, admins);
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
 * src/proxy.ts, or it answers a non super admin with a 200. The mirror row is synced before the
 * answer, so a super admin's row exists before the page's Realtime channel joins, and a user who is
 * no longer listed has lost theirs. Cached per request, so the page and its metadata share one
 * check, one sync, and one log line.
 */
export const requireSuperAdmin = cache(async (nextPath: string): Promise<SessionUser> => {
  const user = await requireUser(nextPath);
  // An invalid list throws here, before anything is synced, and the page shows its error page.
  const admins = superAdminEmails();
  await syncSuperAdminRow(user.id, admins);
  if (!isSuperAdminEmail(user.email, admins)) {
    log.warn("admin.access_refused", { userId: user.id });
    notFound();
  }
  return user;
});
