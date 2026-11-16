import { notFound, unstable_rethrow } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";

import { getAdapter, isFakeProviderEnabled, loadOAuthClient } from "@/lib/adapters/registry";
import { isSimulatedAdapter } from "@/lib/adapters/simulated";
import { ProviderIdSchema } from "@/lib/adapters/types";
import { safeNextPath } from "@/lib/auth/redirect";
import { isSameOrigin } from "@/lib/auth/same-origin";
import { getCurrentUser } from "@/lib/auth/session";
import { handoffResponse } from "@/lib/connections/handoff-page";
import {
  callbackRedirectUri,
  connectFeedbackQuery,
  connectOrigin,
  createOAuthState,
  createPkcePair,
  newStateToken,
  reconnectMismatch,
  type ConnectFeedback,
} from "@/lib/connections/oauth-state";
import { needsWriteAccess } from "@/lib/connections/webhook-copy";
import { connectionWebhookSetup, webhookWritePermissions } from "@/lib/connections/webhook-setup";
import { getConnection, isConnectionId } from "@/lib/data/connections";
import { logError } from "@/lib/log/logger";
import { requireWorkspaceAction, type WorkspaceAccess } from "@/lib/workspaces/access";
import { isWorkspaceSlug, workspacePath } from "@/lib/workspaces/paths";
import { ForbiddenError } from "@/lib/workspaces/permissions";

/** A text field of the posted form, or null when it is missing or a file. */
function textField(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

/**
 * Starts connecting a provider (#40): a `POST` of `workspace=<slug>&consent=1[&connection=<id>]`
 * from the permission disclosure form. It creates a state row and sends the user to a provider, so
 * it refuses a request posted from another site. Authorizes the member, checks consent for
 * full-access permissions, stores a single-use state (with the PKCE verifier sealed), and answers
 * with a page that moves on to the provider's consent screen by meta refresh. Not a redirect:
 * browsers check form-action on every redirect hop after a form post, and the provider's hops are
 * outside StackDash's control (see handoff-page.ts).
 */
export async function POST(request: NextRequest, ctx: RouteContext<"/api/connections/[provider]/start">) {
  if (!isSameOrigin(request)) {
    return new NextResponse(
      "Connecting a provider must start from StackDash. Go back to Connections and choose the provider again.",
      { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  const { provider: providerParam } = await ctx.params;
  const parsedProvider = ProviderIdSchema.safeParse(providerParam);
  if (!parsedProvider.success) notFound();
  const provider = parsedProvider.data;
  if (provider === "fake" && !isFakeProviderEnabled()) notFound();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // Not a form body, so there is no workspace to send the user back to.
    return new NextResponse("Connecting a provider needs the form on the Connections page. Go back and try again.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const slug = textField(form, "workspace") ?? "";
  if (!isWorkspaceSlug(slug)) notFound();
  const reconnectParam = textField(form, "connection");
  const connectionsPath = workspacePath(slug, "connections");
  const disclosurePath = `${connectionsPath}/new/${provider}`;

  const back = (path: string, feedback: ConnectFeedback, extra?: Record<string, string>) => {
    const url = new URL(`${path}?${connectFeedbackQuery(feedback)}`, request.nextUrl.origin);
    for (const [key, value] of Object.entries(extra ?? {})) url.searchParams.set(key, value);
    return NextResponse.redirect(url, 303);
  };

  // `webhook=automatic`: the user chose automatic webhook setup on the connection page (#426), so
  // this reconnect also asks for the scopes that create the webhook.
  const webhookSetup = textField(form, "webhook") === "automatic";
  const reconnectExtra: Record<string, string> = {
    ...(reconnectParam === null ? {} : { connection: reconnectParam }),
    ...(webhookSetup ? { webhook: "automatic" } : {}),
  };

  // `redirect()` answers a route handler with a 307, which would re-post the form to the sign-in
  // page, so a signed-out user gets an explicit 303 instead. `next` keeps the reconnect target, so
  // signing in returns to the same reconnect rather than starting a second connection.
  if ((await getCurrentUser()) === null) {
    const signIn = new URL("/sign-in", request.nextUrl.origin);
    const reconnectQuery = new URLSearchParams(reconnectExtra).toString();
    signIn.searchParams.set("next", safeNextPath(reconnectQuery === "" ? disclosurePath : `${disclosurePath}?${reconnectQuery}`));
    return NextResponse.redirect(signIn, 303);
  }

  let access: WorkspaceAccess;
  try {
    access = await requireWorkspaceAction(slug, "manage_connections");
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) return back(connectionsPath, { error: "forbidden", provider });
    const ref = logError("connections.start_authorize_failed", error, { provider });
    return back(connectionsPath, { error: "failed", provider, ref });
  }

  const adapter = getAdapter(provider);
  const client = loadOAuthClient(adapter);
  if (client === null) return back(connectionsPath, { error: "not_configured", provider });
  // Automatic setup that needs write access goes through this consent; it is chosen for an
  // existing connection, never while connecting for the first time.
  const webhookSetupDeclared = connectionWebhookSetup(adapter);
  if (webhookSetup && (reconnectParam === null || webhookSetupDeclared === null || !needsWriteAccess(webhookSetupDeclared))) {
    return back(connectionsPath, { error: "invalid", provider });
  }

  try {
    let reconnectId: string | undefined;
    if (reconnectParam !== null) {
      // Re-read in this workspace: a missing id and another tenant's id get the same answer.
      const existing = isConnectionId(reconnectParam)
        ? await getConnection(access.workspace.id, reconnectParam)
        : null;
      if (existing === null || existing.provider !== provider) {
        return back(connectionsPath, { error: "invalid", provider });
      }
      // A real connection is never reconnected through the simulator, nor the reverse (#131).
      const mismatch = reconnectMismatch(existing, isSimulatedAdapter(adapter));
      if (mismatch !== null) return back(connectionsPath, { error: mismatch, provider });
      reconnectId = existing.id;
    }

    const extraPermissions = await webhookWritePermissions({
      adapter,
      workspaceId: access.workspace.id,
      connectionId: reconnectId,
      chosen: webhookSetup,
    });
    const needsConsent = [...adapter.permissions, ...extraPermissions].some((permission) => permission.access === "full");
    if (needsConsent && textField(form, "consent") !== "1") {
      return back(disclosurePath, { error: "consent_required", provider }, reconnectExtra);
    }

    const state = newStateToken();
    const pkce = adapter.oauth.pkce ? createPkcePair() : null;
    const appOrigin = connectOrigin(request.url, process.env.NEXT_PUBLIC_SITE_URL);
    const redirectUri = callbackRedirectUri(appOrigin, provider);
    // Request data is all read above, so the clock is safe to read now.
    await createOAuthState({
      state,
      workspaceId: access.workspace.id,
      provider,
      userId: access.user.id,
      ...(pkce === null ? {} : { codeVerifier: pkce.verifier }),
      ...(reconnectId === undefined ? {} : { reconnectId }),
      ...(webhookSetup ? { webhookSetup } : {}),
      now: new Date(),
    });

    const authorizeUrl = adapter.buildAuthorizeUrl({
      client,
      state,
      redirectUri,
      ...(pkce === null ? {} : { codeChallenge: pkce.challenge }),
      ...(extraPermissions.length === 0 ? {} : { extraScopes: extraPermissions.map((permission) => permission.scope) }),
    });
    return handoffResponse({ providerName: adapter.displayName, authorizeUrl, appOrigin });
  } catch (error) {
    unstable_rethrow(error);
    const ref = logError("connections.start_failed", error, { provider });
    return back(connectionsPath, { error: "failed", provider, ref });
  }
}
