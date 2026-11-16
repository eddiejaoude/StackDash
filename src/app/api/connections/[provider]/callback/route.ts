import { notFound, unstable_rethrow } from "next/navigation";
import { NextResponse, type NextRequest } from "next/server";

import { AdapterError } from "@/lib/adapters/errors";
import {
  createOAuthContext,
  getAdapter,
  isFakeProviderEnabled,
  isProviderSimulated,
  loadOAuthClient,
} from "@/lib/adapters/registry";
import { ProviderIdSchema, type ProviderAdapter, type ProviderId } from "@/lib/adapters/types";
import { getCurrentUser } from "@/lib/auth/session";
import { completeConnection, ReconnectMismatchError, ReconnectTargetMissingError } from "@/lib/connections/connect";
import { githubCallbackStep, type CallbackStep } from "@/lib/connections/github-steps";
import {
  callbackRedirectUri,
  connectFeedbackQuery,
  connectOrigin,
  consumeOAuthState,
  isStateExpired,
  type ConnectFeedback,
  type ConsumedState,
} from "@/lib/connections/oauth-state";
import type { WebhookSetupResult } from "@/lib/connections/webhook-copy";
import { connectionWebhookSetup, setUpWebhookAutomatically } from "@/lib/connections/webhook-setup";
import { getLastWorkspaceSlug } from "@/lib/data/workspaces";
import { logError } from "@/lib/log/logger";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAction } from "@/lib/workspaces/access";
import { workspacePath } from "@/lib/workspaces/paths";
import { ForbiddenError } from "@/lib/workspaces/permissions";

/**
 * Creates the webhook the user chose to set up automatically (#426), once the grant with its write
 * scopes is stored. The connection is already saved, so a failure here is reported on its page
 * rather than as a failed connect.
 */
async function setUpAfterConsent({
  workspaceId,
  connectionId,
  adapter,
  origin,
}: Readonly<{ workspaceId: string; connectionId: string; adapter: ProviderAdapter; origin: string }>): Promise<
  Readonly<{ webhook: WebhookSetupResult; ref?: string }>
> {
  try {
    const setup = connectionWebhookSetup(adapter);
    if (setup === null) throw new Error(`${adapter.id} declares no per-connection webhook setup.`);
    return { webhook: (await setUpWebhookAutomatically({ workspaceId, connectionId, adapter, setup, origin })).kind };
  } catch (error) {
    unstable_rethrow(error);
    return { webhook: "failed", ref: logError("connections.webhook_setup_failed", error, { provider: adapter.id }) };
  }
}

/**
 * Where the provider sends the browser back (#40). The state row is read and deleted in one
 * statement, so it works once; it must belong to this provider and to the signed-in user, and be
 * unexpired. Failures go back to the connections page with a fixed error code, never provider
 * text. Success lands on the new (or reconnected) connection.
 */
export async function GET(request: NextRequest, ctx: RouteContext<"/api/connections/[provider]/callback">) {
  const { provider: providerParam } = await ctx.params;
  const parsedProvider = ProviderIdSchema.safeParse(providerParam);
  if (!parsedProvider.success) notFound();
  const provider: ProviderId = parsedProvider.data;
  if (provider === "fake" && !isFakeProviderEnabled()) notFound();

  const params: Record<string, string> = Object.fromEntries(request.nextUrl.searchParams);
  const origin = request.nextUrl.origin;
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, origin), 303);
  const withFeedback = (path: string, feedback: ConnectFeedback) =>
    redirectTo(`${path}?${connectFeedbackQuery(feedback)}`);

  // Signed out: the state cannot be matched to anyone, so start over after signing in.
  const user = await getCurrentUser();
  if (user === null) return redirectTo(`/sign-in?${new URLSearchParams({ next: "/app" }).toString()}`);

  // Without a usable state there is no workspace to return to; use the last one the user opened.
  const fallback = async (feedback: ConnectFeedback) => {
    const lastSlug = await getLastWorkspaceSlug();
    return lastSlug === null ? redirectTo("/app") : withFeedback(workspacePath(lastSlug, "connections"), feedback);
  };

  const state = params.state;
  if (state === undefined || state.length === 0) {
    // GitHub's "redirect on update" and a non-owner's install request can arrive without a state.
    return fallback({ error: params.error === "access_denied" ? "cancelled" : "invalid", provider });
  }

  let consumed: ConsumedState | null;
  try {
    consumed = await consumeOAuthState(state);
  } catch (error) {
    const ref = logError("connections.callback_state_failed", error, { provider });
    return fallback({ error: "failed", provider, ref });
  }
  if (consumed === null || consumed.provider !== provider || consumed.userId !== user.id) {
    return fallback({ error: "invalid", provider });
  }

  // The user-scoped client only returns the workspace while the user is still a member.
  const supabase = await createClient();
  const { data: workspaceRow, error: workspaceError } = await supabase
    .from("workspaces")
    .select("slug")
    .eq("id", consumed.workspaceId)
    .maybeSingle();
  if (workspaceError || workspaceRow === null) return fallback({ error: "invalid", provider });
  const connectionsPath = workspacePath(workspaceRow.slug, "connections");

  // Request data is all read above, so the clock is safe to read now.
  const now = new Date();
  if (isStateExpired(consumed.expiresAt, now)) return withFeedback(connectionsPath, { error: "expired", provider });

  try {
    // Roles can change during the provider round trip; authorize again.
    const access = await requireWorkspaceAction(workspaceRow.slug, "manage_connections");
    const adapter = getAdapter(provider);
    const client = loadOAuthClient(adapter);
    if (client === null) return withFeedback(connectionsPath, { error: "not_configured", provider });
    const redirectUri = callbackRedirectUri(connectOrigin(request.url, process.env.NEXT_PUBLIC_SITE_URL), provider);

    let step: CallbackStep;
    // Simulated GitHub returns the code on the first leg, like every other provider.
    if (provider === "github" && !isProviderSimulated(provider)) {
      step = await githubCallbackStep({ params, consumed, client, redirectUri, now });
    } else if (params.error !== undefined) {
      step = { kind: "error", code: params.error === "access_denied" ? "cancelled" : "provider_error" };
    } else if (params.code === undefined || params.code.length === 0) {
      step = { kind: "error", code: "provider_error" };
    } else {
      step = { kind: "exchange", code: params.code, callbackParams: params };
    }

    if (step.kind === "redirect") return NextResponse.redirect(step.url, 303);
    if (step.kind === "error") return withFeedback(connectionsPath, { error: step.code, provider });

    const oauthCtx = createOAuthContext(client);
    const credential = await adapter.exchangeCode(
      {
        code: step.code,
        redirectUri,
        ...(consumed.codeVerifier === undefined ? {} : { codeVerifier: consumed.codeVerifier }),
        callbackParams: step.callbackParams,
      },
      oauthCtx,
    );
    const result = await completeConnection({
      adapter,
      ctx: oauthCtx,
      workspaceId: access.workspace.id,
      userId: access.user.id,
      credential,
      ...(consumed.reconnectId === undefined ? {} : { reconnectId: consumed.reconnectId }),
    });
    const connectionPath = `${connectionsPath}/${result.connectionId}`;
    if (!consumed.webhookSetup) return redirectTo(`${connectionPath}?connected=1`);
    // The user chose automatic webhook setup (#426) and approved its write access just now.
    const webhook = await setUpAfterConsent({
      workspaceId: access.workspace.id,
      connectionId: result.connectionId,
      adapter,
      origin: connectOrigin(request.url, process.env.NEXT_PUBLIC_SITE_URL),
    });
    return redirectTo(`${connectionPath}?${new URLSearchParams(webhook).toString()}`);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof ForbiddenError) return withFeedback(connectionsPath, { error: "forbidden", provider });
    if (error instanceof ReconnectTargetMissingError) {
      return withFeedback(connectionsPath, { error: "invalid", provider });
    }
    if (error instanceof ReconnectMismatchError) {
      return withFeedback(connectionsPath, { error: error.code, provider });
    }
    if (error instanceof AdapterError) {
      // The provider refused or answered badly; the log keeps the detail, the user gets a reference.
      const ref = logError("connections.callback_provider_failed", error, { provider, code: error.code });
      return withFeedback(connectionsPath, { error: "provider_error", provider, ref });
    }
    const ref = logError("connections.callback_failed", error, { provider });
    return withFeedback(connectionsPath, { error: "failed", provider, ref });
  }
}
