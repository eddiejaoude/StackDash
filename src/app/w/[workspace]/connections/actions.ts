"use server";

import { refresh } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { z } from "zod";

import { availableProviders, getAdapter } from "@/lib/adapters/registry";
import { isProviderSimulationEnabled } from "@/lib/adapters/simulated";
import { Secret, type ConnectionWebhookSetup, type ProviderAdapter, type ProviderId } from "@/lib/adapters/types";
import { requestPublicOrigin } from "@/lib/connections/oauth-state";
import { providerUnavailableReason } from "@/lib/connections/provider-availability";
import { disconnectConnection, manualRevokeMessage, revokeAtProvider } from "@/lib/connections/revoke";
import { needsWriteAccess, webhookSetupResultCopy, type WebhookSetupResult } from "@/lib/connections/webhook-copy";
import {
  connectionWebhookSetup,
  setupRefusal,
  removeConnectionWebhook,
  rotateWebhookSecret,
  setUpWebhookAutomatically,
  setUpWebhookByHand,
  webhookRemovalMessage,
} from "@/lib/connections/webhook-setup";
import { CONNECTIONS_LIMIT } from "@/lib/data/dashboard";
import { getConnectionWebhook, replaceWebhookEndpointSecret } from "@/lib/data/webhook-endpoints";
import { addSampleData, SAMPLE_DATA_ADDED_PARAM, sampleDataRefusal } from "@/lib/demo/workspace";
import { enqueueSync, MANUAL_SYNC_COOLDOWN_SECONDS } from "@/lib/jobs/queue";
import { log, logError } from "@/lib/log/logger";
import { PROVIDER_NAMES } from "@/lib/providers";
import { createClient } from "@/lib/supabase/server";
import { requireWorkspaceAction, type WorkspaceAccess } from "@/lib/workspaces/access";
import { workspacePath } from "@/lib/workspaces/paths";
import { actionDeniedReason, ForbiddenError } from "@/lib/workspaces/permissions";

/*
 * Connection management (#40). Every action authorizes with the role matrix, then re-reads the
 * row it was given inside the caller's workspace: an id that does not exist and an id from another
 * workspace get the same answer. No credential, token, or provider error text is ever returned.
 */

export type ConnectionActionResult = { ok: true; message?: string } | ConnectionActionFailure;
type ConnectionActionFailure = { ok: false; fieldErrors?: Record<string, string>; message: string; referenceId?: string };

/** A webhook setup action's result (#426): `secret` is a new secret to show once, never stored here. */
export type WebhookActionResult = { ok: true; message: string; secret?: string } | ConnectionActionFailure;

const NOT_FOUND_MESSAGE = "That item no longer exists in this workspace. Reload the page to see what is current.";
const STALE_FORM_MESSAGE = "This form is out of date. Reload the page and try again.";

// Fixture ids skip the RFC version bits, so `guid` rather than `uuid`.
const Id = z.guid();

const accountProjectSchema = z
  .object({ workspace: z.string().min(1), accountId: Id, projectId: z.union([Id, z.literal("")]) })
  .strict();
const accountIncludedSchema = z
  .object({ workspace: z.string().min(1), accountId: Id, included: z.enum(["true", "false"]) })
  .strict();
const connectionSchema = z.object({ workspace: z.string().min(1), connectionId: Id }).strict();
const workspaceSchema = z.object({ workspace: z.string().min(1) }).strict();

/** Expected failures become messages; anything else is logged and answered with a reference. */
function failure(event: string, error: unknown, message: string): ConnectionActionFailure {
  unstable_rethrow(error);
  if (error instanceof ForbiddenError) return { ok: false, message: actionDeniedReason("manage_connections") };
  return { ok: false, message, referenceId: logError(event, error) };
}

async function findAccount(access: WorkspaceAccess, accountId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("external_accounts")
    .select("id")
    .eq("workspace_id", access.workspace.id)
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw new Error("External account lookup failed", { cause: error });
  return data;
}

async function findConnection(access: WorkspaceAccess, connectionId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("connections")
    .select("id, provider, status")
    .eq("workspace_id", access.workspace.id)
    .eq("id", connectionId)
    .maybeSingle();
  if (error) throw new Error("Connection lookup failed", { cause: error });
  return data;
}

/** The given connections of the caller's workspace, in one read; an id from elsewhere is absent. */
async function findConnections(access: WorkspaceAccess, connectionIds: readonly string[]) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("connections")
    .select("id, provider, status, last_sync_requested_at")
    .eq("workspace_id", access.workspace.id)
    .in("id", [...connectionIds])
    .limit(connectionIds.length);
  if (error) throw new Error("Connection lookup failed", { cause: error });
  return data;
}

export async function assignAccountProject(
  _previous: ConnectionActionResult | null,
  formData: FormData,
): Promise<ConnectionActionResult> {
  const parsed = accountProjectSchema.safeParse({
    workspace: formData.get("workspace"),
    accountId: formData.get("accountId"),
    projectId: formData.get("projectId"),
  });
  if (!parsed.success) return { ok: false, message: STALE_FORM_MESSAGE };
  const { workspace, accountId, projectId } = parsed.data;

  try {
    const access = await requireWorkspaceAction(workspace, "manage_connections");
    const supabase = await createClient();
    const [account, project] = await Promise.all([
      findAccount(access, accountId),
      projectId === ""
        ? Promise.resolve({ id: "" })
        : supabase
            .from("projects")
            .select("id")
            .eq("workspace_id", access.workspace.id)
            .eq("id", projectId)
            .maybeSingle()
            .then(({ data, error }) => {
              if (error) throw new Error("Project lookup failed", { cause: error });
              return data;
            }),
    ]);
    if (account === null) return { ok: false, message: NOT_FOUND_MESSAGE };
    if (project === null) {
      return {
        ok: false,
        fieldErrors: { projectId: "That project no longer exists. Choose another one." },
        message: "The project was not saved. That project no longer exists. Choose another one.",
      };
    }
    const { data, error } = await supabase
      .from("external_accounts")
      .update({ project_id: projectId === "" ? null : projectId })
      .eq("workspace_id", access.workspace.id)
      .eq("id", accountId)
      .select("id");
    if (error) throw new Error("Project assignment failed", { cause: error });
    if (data.length === 0) throw new ForbiddenError("admin", actionDeniedReason("manage_connections"));
  } catch (error) {
    return failure("connections.assign_project_failed", error, "The project could not be saved. Try again in a moment.");
  }
  refresh();
  return { ok: true, message: projectId === "" ? "Project removed." : "Project saved." };
}

export async function setAccountIncluded(
  _previous: ConnectionActionResult | null,
  formData: FormData,
): Promise<ConnectionActionResult> {
  const parsed = accountIncludedSchema.safeParse({
    workspace: formData.get("workspace"),
    accountId: formData.get("accountId"),
    included: formData.get("included"),
  });
  if (!parsed.success) return { ok: false, message: STALE_FORM_MESSAGE };
  const { workspace, accountId } = parsed.data;
  const included = parsed.data.included === "true";

  try {
    const access = await requireWorkspaceAction(workspace, "manage_connections");
    if ((await findAccount(access, accountId)) === null) return { ok: false, message: NOT_FOUND_MESSAGE };
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("external_accounts")
      .update({ included })
      .eq("workspace_id", access.workspace.id)
      .eq("id", accountId)
      .select("id");
    if (error) throw new Error("Include toggle failed", { cause: error });
    if (data.length === 0) throw new ForbiddenError("admin", actionDeniedReason("manage_connections"));
  } catch (error) {
    return failure("connections.set_included_failed", error, "The change could not be saved. Try again in a moment.");
  }
  refresh();
  return {
    ok: true,
    message: included ? "Account included. It syncs from the next run." : "Account excluded. It no longer syncs.",
  };
}

function formatWait(seconds: number): string {
  const minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? "about a minute" : `${minutes} minutes`;
}

// One connection from its page, or every stale one from the dashboard's notice (#267); never more
// than the dashboard lists.
const syncNowSchema = z
  .object({ workspace: z.string().min(1), connectionIds: z.array(Id).min(1).max(CONNECTIONS_LIMIT) })
  .strict();

export async function syncNow(
  _previous: ConnectionActionResult | null,
  formData: FormData,
): Promise<ConnectionActionResult> {
  const parsed = syncNowSchema.safeParse({
    workspace: formData.get("workspace"),
    connectionIds: formData.getAll("connectionId"),
  });
  if (!parsed.success) return { ok: false, message: STALE_FORM_MESSAGE };
  const connectionIds = [...new Set(parsed.data.connectionIds)];

  let queued: number;
  let failed: number;
  let requested: number;
  let referenceId: string | undefined;
  try {
    const access = await requireWorkspaceAction(parsed.data.workspace, "manage_connections");
    const connections = await findConnections(access, connectionIds);
    if (connections.length < connectionIds.length) return { ok: false, message: NOT_FOUND_MESSAGE };
    const connected = connections.filter((connection) => connection.status !== "revoked");
    // A provider this instance does not offer has no adapter, so its sync could only fail (#570).
    const offered = new Set(availableProviders().map((adapter) => adapter.id));
    const syncable = connected.filter((connection) => offered.has(connection.provider));
    if (syncable.length === 0) {
      const [unavailable] = connected;
      if (unavailable === undefined) {
        return {
          ok: false,
          message:
            connectionIds.length === 1
              ? "This connection is disconnected. Reconnect it before syncing."
              : "These connections are disconnected. Reconnect them before syncing.",
        };
      }
      return {
        ok: false,
        message:
          connectionIds.length === 1
            ? providerUnavailableReason(PROVIDER_NAMES[unavailable.provider])
            : "None of these connections can sync. Each one is disconnected, or its provider is not available on this instance.",
      };
    }
    // Settled, not all: one connection's failed request must not hide that the others were queued.
    const results = await Promise.allSettled(
      syncable.map((connection) => enqueueSync({ workspaceId: access.workspace.id, connectionId: connection.id, reason: "manual" })),
    );
    const rejected = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    queued = results.filter((result) => result.status === "fulfilled" && result.value.queued).length;
    failed = rejected.length;
    requested = syncable.length;
    if (failed > 0) {
      referenceId = logError(
        "connections.sync_now_failed",
        new AggregateError(rejected, `${failed} of ${requested} manual syncs could not be queued`),
      );
    }
    if (queued === 0 && failed > 0) {
      return { ok: false, message: "The sync could not be queued. Try again in a moment.", ...(referenceId === undefined ? {} : { referenceId }) };
    }
    if (queued === 0) {
      // Re-read after the attempt: the queue records the request time when it accepts one. The
      // newest request is the one to wait out.
      const latest = await findConnections(access, syncable.map((connection) => connection.id));
      const requestedAt = latest.flatMap((connection) =>
        connection.last_sync_requested_at === null ? [] : [Date.parse(connection.last_sync_requested_at)],
      );
      const remaining =
        requestedAt.length === 0 ? 0 : Math.ceil((Math.max(...requestedAt) + MANUAL_SYNC_COOLDOWN_SECONDS * 1000 - Date.now()) / 1000);
      return {
        ok: false,
        message:
          remaining > 0
            ? `A sync was requested recently. Try again in ${formatWait(remaining)}.`
            : `A sync is already queued for ${requested === 1 ? "this connection" : "these connections"}. It runs within a minute.`,
      };
    }
  } catch (error) {
    return failure("connections.sync_now_failed", error, "The sync could not be queued. Try again in a moment.");
  }
  refresh();
  if (requested === 1) return { ok: true, message: "Sync queued. New numbers appear within a few minutes." };
  const waiting = requested - queued - failed;
  const parts = [queued === requested ? `Sync queued for ${requested} connections.` : `Sync queued for ${queued} of ${requested} connections.`];
  if (waiting > 0) {
    parts.push(
      `${waiting === 1 ? "One already has" : `${waiting} already have`} a sync queued or requested in the last ${MANUAL_SYNC_COOLDOWN_SECONDS / 60} minutes.`,
    );
  }
  if (failed > 0) parts.push(`${failed === 1 ? "One" : failed} could not be queued. Try again in a moment, reference ${referenceId ?? "unknown"}.`);
  parts.push("New numbers appear within a few minutes.");
  return { ok: true, message: parts.join(" ") };
}

export async function disconnect(
  _previous: ConnectionActionResult | null,
  formData: FormData,
): Promise<ConnectionActionResult> {
  const parsed = connectionSchema.safeParse({
    workspace: formData.get("workspace"),
    connectionId: formData.get("connectionId"),
  });
  if (!parsed.success) return { ok: false, message: STALE_FORM_MESSAGE };

  let message: string;
  try {
    const access = await requireWorkspaceAction(parsed.data.workspace, "manage_connections");
    const connection = await findConnection(access, parsed.data.connectionId);
    if (connection === null) return { ok: false, message: NOT_FOUND_MESSAGE };

    const outcome = await disconnectConnection({
      workspaceId: access.workspace.id,
      connectionId: connection.id,
      provider: connection.provider,
      userId: access.user.id,
    });
    message = [
      "Disconnected. The credential is deleted and the history is kept.",
      webhookRemovalMessage(connection.provider, outcome.webhook),
      manualRevokeMessage(connection.provider, outcome.revoke),
    ]
      .filter((part) => part !== null)
      .join(" ");
  } catch (error) {
    return failure("connections.disconnect_failed", error, "The connection could not be disconnected. Try again in a moment.");
  }
  refresh();
  return { ok: true, message };
}

export async function deleteConnection(
  _previous: ConnectionActionResult | null,
  formData: FormData,
): Promise<ConnectionActionResult> {
  const parsed = connectionSchema.safeParse({
    workspace: formData.get("workspace"),
    connectionId: formData.get("connectionId"),
  });
  if (!parsed.success) return { ok: false, message: STALE_FORM_MESSAGE };

  let connectionsPath: string;
  let provider: ProviderId;
  let manualStep: string | null = null;
  let webhookLeft = false;
  try {
    const access = await requireWorkspaceAction(parsed.data.workspace, "manage_connections");
    const connection = await findConnection(access, parsed.data.connectionId);
    if (connection === null) return { ok: false, message: NOT_FOUND_MESSAGE };
    provider = connection.provider;
    if (connection.status !== "revoked") {
      // Before the revoke and the cascade: deleting a webhook StackDash created needs the credential.
      const removal = await removeConnectionWebhook({ workspaceId: access.workspace.id, connectionId: connection.id, provider });
      webhookLeft = removal.kind === "manual" || removal.kind === "failed";
      manualStep = manualRevokeMessage(
        connection.provider,
        await revokeAtProvider(access.workspace.id, connection.id, connection.provider),
      );
    }
    // The cascade removes the credential, accounts, snapshots, events, and jobs with it.
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("connections")
      .delete()
      .eq("workspace_id", access.workspace.id)
      .eq("id", connection.id)
      .select("id");
    if (error) throw new Error("Connection delete failed", { cause: error });
    if (data.length === 0) throw new ForbiddenError("admin", actionDeniedReason("manage_connections"));
    connectionsPath = workspacePath(access.workspace.slug, "connections");
  } catch (error) {
    return failure("connections.delete_failed", error, "The connection could not be deleted. Try again in a moment.");
  }
  const query = new URLSearchParams({ deleted: provider });
  if (manualStep !== null) query.set("revoke", "manual");
  if (webhookLeft) query.set("webhook", "remove");
  redirect(`${connectionsPath}?${query.toString()}`);
}

/**
 * "Explore with sample data" (#257): connects every simulated provider to an empty workspace and
 * runs their first sync, then opens the timeline with the result. Owners and admins only, checked
 * against the verified user, and refused when simulation is off or anything is already connected.
 */
export async function exploreWithSampleData(
  _previous: ConnectionActionResult | null,
  formData: FormData,
): Promise<ConnectionActionResult> {
  const parsed = workspaceSchema.safeParse({ workspace: formData.get("workspace") });
  if (!parsed.success) return { ok: false, message: STALE_FORM_MESSAGE };

  let timelinePath: string;
  try {
    const access = await requireWorkspaceAction(parsed.data.workspace, "manage_connections");
    const supabase = await createClient();
    const { count, error } = await supabase
      .from("connections")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", access.workspace.id);
    if (error) throw new Error("Connection count failed", { cause: error });
    const refusal = sampleDataRefusal({ simulationEnabled: isProviderSimulationEnabled(), connectionCount: count ?? 0 });
    if (refusal !== null) return { ok: false, message: refusal };

    const connections = await addSampleData({ workspaceId: access.workspace.id, userId: access.user.id, now: new Date() });
    log.info("connections.sample_data_added", { workspaceId: access.workspace.id, connections: connections.length });
    timelinePath = workspacePath(access.workspace.slug, "timeline");
  } catch (error) {
    return failure(
      "connections.sample_data_failed",
      error,
      "The sample data could not be added in full. Any simulated provider it connected is on the Connections page, where it keeps syncing or can be deleted.",
    );
  }
  redirect(`${timelinePath}?${new URLSearchParams({ [SAMPLE_DATA_ADDED_PARAM]: "added" }).toString()}`);
}

const webhookSetupSchema = z
  .object({ workspace: z.string().min(1), connectionId: Id, mode: z.enum(["automatic", "manual"]) })
  .strict();
// Provider signing secrets are a few dozen characters (Svix's `whsec_` keys are 38); the bound only
// keeps a pasted page out of the database.
const SIGNING_SECRET_MAX_LENGTH = 500;
const signingSecretSchema = z
  .object({
    workspace: z.string().min(1),
    connectionId: Id,
    signingSecret: z
      .string()
      .trim()
      .min(1, "Paste the signing secret before saving.")
      .max(SIGNING_SECRET_MAX_LENGTH, `A signing secret is at most ${SIGNING_SECRET_MAX_LENGTH} characters. Copy only the secret.`),
  })
  .strict();

const WEBHOOK_FAILED_MESSAGE = "The webhook could not be set up. Try again in a moment.";

type WebhookTarget = Readonly<{
  access: WorkspaceAccess;
  connection: NonNullable<Awaited<ReturnType<typeof findConnection>>>;
  adapter: ProviderAdapter;
  setup: ConnectionWebhookSetup;
}>;

/**
 * The caller's connection whose provider takes a per-connection webhook, or the failure to return.
 * Owners and admins only, re-read inside the caller's workspace.
 */
async function findWebhookTarget(workspace: string, connectionId: string): Promise<WebhookTarget | ConnectionActionFailure> {
  const access = await requireWorkspaceAction(workspace, "manage_connections");
  const connection = await findConnection(access, connectionId);
  if (connection === null) return { ok: false, message: NOT_FOUND_MESSAGE };
  if (connection.status === "revoked") {
    return { ok: false, message: "This connection is disconnected. Reconnect it before setting up a webhook." };
  }
  const adapter = getAdapter(connection.provider);
  const setup = connectionWebhookSetup(adapter);
  if (setup === null) return { ok: false, message: STALE_FORM_MESSAGE };
  return { access, connection, adapter, setup };
}

/**
 * Sets up the connection's webhook the way the user chose on the setup panel (#426). By hand never
 * asks the provider for anything. Automatic setup that needs write access goes to the connect
 * screen first, which shows the write access and asks for consent before the provider's own
 * screen; automatic setup with the access already granted (Resend) creates the webhook now.
 */
export async function setUpWebhook(_previous: WebhookActionResult | null, formData: FormData): Promise<WebhookActionResult> {
  const parsed = webhookSetupSchema.safeParse({
    workspace: formData.get("workspace"),
    connectionId: formData.get("connectionId"),
    mode: formData.get("mode"),
  });
  if (!parsed.success) return { ok: false, message: "Choose how to set up the webhook, then try again." };
  const { workspace, connectionId, mode } = parsed.data;

  let next: Readonly<{ kind: "result"; result: WebhookActionResult }> | Readonly<{ kind: "consent"; path: string }>;
  try {
    const target = await findWebhookTarget(workspace, connectionId);
    if ("ok" in target) return target;
    const { access, connection, adapter, setup } = target;
    const name = PROVIDER_NAMES[connection.provider];
    const asResult = (kind: WebhookSetupResult) => {
      const { tone, body: message } = webhookSetupResultCopy(kind, name, setup);
      const result: WebhookActionResult = tone === "success" ? { ok: true, message } : { ok: false, message };
      return { kind: "result", result } as const;
    };
    if (mode === "manual") {
      const outcome = await setUpWebhookByHand({ workspaceId: access.workspace.id, connectionId: connection.id, adapter, setup });
      if (outcome.kind !== "manual") {
        next = asResult(outcome.kind);
      } else if (outcome.secret === null) {
        next = {
          kind: "result",
          result: { ok: true, message: `Webhook address created. Add it in ${name} with the steps below, then paste ${name}'s signing secret here.` },
        };
      } else {
        next = {
          kind: "result",
          result: { ok: true, message: `Webhook address and secret created. Add them in ${name} with the steps below.`, secret: outcome.secret.reveal() },
        };
      }
    } else if (setup.automatic === undefined) {
      return { ok: false, message: STALE_FORM_MESSAGE };
    } else if (needsWriteAccess(setup)) {
      // Never send the user to a write access consent the webhook could not use, including a
      // connection whose accounts automatic setup cannot serve.
      const refused = await setupRefusal(access.workspace.id, connection.id, setup.automatic);
      if (refused !== null) {
        next = asResult(refused.kind);
      } else {
        const query = new URLSearchParams({ connection: connection.id, webhook: "automatic" });
        next = { kind: "consent", path: `${workspacePath(access.workspace.slug, "connections")}/new/${connection.provider}?${query.toString()}` };
      }
    } else {
      const outcome = await setUpWebhookAutomatically({
        workspaceId: access.workspace.id,
        connectionId: connection.id,
        adapter,
        setup,
        origin: await requestPublicOrigin(),
      });
      next = asResult(outcome.kind);
    }
  } catch (error) {
    return failure("connections.webhook_setup_failed", error, WEBHOOK_FAILED_MESSAGE);
  }
  if (next.kind === "consent") redirect(next.path);
  refresh();
  return next.result;
}

/** A new secret for a webhook set up by hand with StackDash's secret, shown once; the old one stops working at once. */
export async function regenerateWebhookSecret(_previous: WebhookActionResult | null, formData: FormData): Promise<WebhookActionResult> {
  const parsed = connectionSchema.safeParse({ workspace: formData.get("workspace"), connectionId: formData.get("connectionId") });
  if (!parsed.success) return { ok: false, message: STALE_FORM_MESSAGE };

  let secret: string;
  let name: string;
  try {
    const target = await findWebhookTarget(parsed.data.workspace, parsed.data.connectionId);
    if ("ok" in target) return target;
    const { access, connection, setup } = target;
    const webhook = await getConnectionWebhook(access.workspace.id, connection.id);
    // StackDash holds no secret the user can see for an automatic webhook or a provider's secret.
    if (webhook?.setupMode !== "manual" || setup.secretSource !== "stackdash") return { ok: false, message: STALE_FORM_MESSAGE };
    const regenerated = await rotateWebhookSecret(access.workspace.id, connection.id);
    if (regenerated === null) return { ok: false, message: NOT_FOUND_MESSAGE };
    secret = regenerated.reveal();
    name = PROVIDER_NAMES[connection.provider];
  } catch (error) {
    return failure("connections.webhook_secret_failed", error, "A new secret could not be made. The old one still works. Try again in a moment.");
  }
  refresh();
  return { ok: true, message: `New secret made. The old one no longer works: replace it in ${name} now.`, secret };
}

/** Stores the signing secret the provider generated for a webhook set up by hand. */
export async function saveWebhookSigningSecret(_previous: WebhookActionResult | null, formData: FormData): Promise<WebhookActionResult> {
  const parsed = signingSecretSchema.safeParse({
    workspace: formData.get("workspace"),
    connectionId: formData.get("connectionId"),
    signingSecret: formData.get("signingSecret"),
  });
  if (!parsed.success) {
    const fieldError = parsed.error.issues.find((issue) => issue.path[0] === "signingSecret")?.message;
    return fieldError === undefined
      ? { ok: false, message: STALE_FORM_MESSAGE }
      : { ok: false, message: `The signing secret was not saved. ${fieldError}`, fieldErrors: { signingSecret: fieldError } };
  }

  let name: string;
  try {
    const target = await findWebhookTarget(parsed.data.workspace, parsed.data.connectionId);
    if ("ok" in target) return target;
    const { access, connection, setup } = target;
    const webhook = await getConnectionWebhook(access.workspace.id, connection.id);
    if (webhook?.setupMode !== "manual" || setup.secretSource !== "provider") return { ok: false, message: STALE_FORM_MESSAGE };
    const saved = await replaceWebhookEndpointSecret({
      workspaceId: access.workspace.id,
      connectionId: connection.id,
      secret: new Secret(parsed.data.signingSecret),
    });
    if (!saved) return { ok: false, message: NOT_FOUND_MESSAGE };
    name = PROVIDER_NAMES[connection.provider];
  } catch (error) {
    return failure("connections.webhook_signing_secret_failed", error, "The signing secret could not be saved. Try again in a moment.");
  }
  refresh();
  return { ok: true, message: `Signing secret saved. Deliveries ${name} signs with it are accepted from now on.` };
}
