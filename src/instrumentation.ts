/**
 * Runs once when a server instance starts, before it serves a request
 * (node_modules/next/dist/docs/01-app/02-guides/instrumentation.md).
 *
 * Reconciles the super admin mirror (#680, src/lib/auth/super-admin.ts): every row whose account
 * email is no longer in STACKDASH_SUPER_ADMIN_EMAILS is deleted, so removing an address and
 * redeploying revokes it, Realtime and Storage access included. Node.js only: the edge runtime
 * cannot run the service role client, and has nothing to reconcile. The reconcile logs a failure
 * and never throws, so a database that is down at start never stops the server starting; the
 * request-time check (requireSuperAdmin, showsAdminLink) removes a stale row on its user's next
 * visit anyway. Not during `next build`, which has no database to reach.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  // Imported here, as the guide's "Importing runtime-specific code" does: a static import would put
  // the service role client into the edge runtime's instrumentation bundle as well.
  const { reconcileSuperAdmins } = await import("@/lib/auth/super-admin");
  await reconcileSuperAdmins();
}
