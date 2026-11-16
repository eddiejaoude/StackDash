import type { z } from "zod";
import { hmacHex, readDeliveryId, safeEqual } from "@/lib/webhooks/signature";
import type { ActivityEvent } from "../events";
import type { AdapterContext, Secret, WebhookDescriptor, WebhookOutcome, WebhookRequest, WebhookVerification } from "../types";
import { issueOpenedEvent, pullRequestMergedEvent } from "./activity";
import { newStarEvent } from "./repositories";
import {
  AppAuthorizationDeliverySchema,
  InstallationDeliverySchema,
  IssuesDeliverySchema,
  PullRequestDeliverySchema,
  StarDeliverySchema,
} from "./schemas";

/**
 * GitHub App webhooks (#62), per docs/providers/github.md ("Webhooks"). One URL and one secret on
 * the app registration receive every installation's deliveries at `POST /api/webhooks/github`.
 * Releases are not among them: the `release` webhook needs Contents read, which also reads code, so
 * releases are polled from the repository events feed instead (./activity.ts, decided on #62).
 *
 * Verification: `X-Hub-Signature-256` is `sha256=` and the hex HMAC SHA-256 of the raw body, keyed
 * with GITHUB_APP_WEBHOOK_SECRET, compared in constant time. `X-GitHub-Delivery` is the delivery id,
 * which a manual redelivery keeps, so a redelivered delivery is acknowledged once and dropped.
 * GitHub never retries a failed delivery on its own ("Handling failed webhook deliveries"): one
 * lost to an error here is recovered only by the hourly sync, and a single star not at all.
 *
 * Replay: GitHub signs neither a timestamp nor its delivery id, so there is no freshness check, and
 * a captured delivery posted again under a new delivery id verifies. What bounds it:
 * - timeline events: each event's dedupe key, which the sync builds the same way, so a replayed
 *   pull request, issue, or star is the event already stored;
 * - `installation` `suspend`: the signed `suspended_at`, so a replay after a reconnect is stale;
 * - `installation` `deleted` and `github_app_authorization` `revoked`: nothing in the body says
 *   when they happened, so `occurredAt` is when StackDash received the delivery, and a replay marks
 *   the connection as needing a reconnect again. It reveals and changes no data, and capturing a
 *   delivery takes the TLS traffic to StackDash or the app's delivery log, which only its owner sees.
 *
 * `X-GitHub-Event` is not signed either, but each event's body must match that event's schema, so a
 * signed body sent under another event name is ignored.
 */

const HEADERS = {
  delivery: "x-github-delivery",
  event: "x-github-event",
  signature: "x-hub-signature-256",
} as const;
const SIGNATURE_PREFIX = "sha256=";

const GITHUB_WEBHOOK_SECRET_ENV = "GITHUB_APP_WEBHOOK_SECRET";

// Event names to tick on the app registration. `installation` and `github_app_authorization` are
// sent to every GitHub App without a subscription; they are listed because StackDash handles them.
const githubWebhookSubscriptions = ["pull_request", "issues", "star", "installation", "github_app_authorization"] as const;

/** The `X-Hub-Signature-256` value GitHub sends for `rawBody`. Exported for tests. */
export function githubWebhookSignature(secret: Secret, rawBody: Uint8Array | string): string {
  return `${SIGNATURE_PREFIX}${hmacHex("sha256", secret, rawBody)}`;
}

/** The signature over the raw bytes first, then the delivery id, which deduplicates. */
function verifyWebhook({ headers, rawBody }: WebhookRequest, secret: Secret): WebhookVerification {
  const signature = headers.get(HEADERS.signature);
  if (!signature) return { ok: false, reason: "missing_signature" };
  if (!safeEqual(signature, githubWebhookSignature(secret, rawBody))) return { ok: false, reason: "bad_signature" };
  const deliveryId = readDeliveryId(headers, HEADERS.delivery);
  if (deliveryId === undefined) return { ok: false, reason: "malformed" };
  return { ok: true, deliveryId };
}

const NOT_MAPPED = "not a delivery StackDash maps";

/** The body as one event's schema, or undefined when it does not match. */
function bodyAs<T>(schema: z.ZodType<T>, raw: unknown): T | undefined {
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** One event for the account it names; undefined (a closed but unmerged pull request) is ignored. */
function eventOutcome(event: ActivityEvent | undefined): WebhookOutcome {
  if (event === undefined) return { kind: "ignored", reason: NOT_MAPPED };
  return { kind: "events", externalAccountId: event.externalAccountId, events: [event] };
}

/**
 * Maps a verified delivery with the sync's own event builders. Actions StackDash does not show
 * (an issue edited, a pull request closed unmerged, an unstar, which the daily net counts) are
 * `ignored`: the delivery is recorded as handled with nothing queued, and GitHub's delivery log
 * shows it as delivered.
 */
function parseWebhook({ headers, rawBody }: WebhookRequest, ctx: AdapterContext): WebhookOutcome {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(rawBody));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    // A registration set to form-encoded payloads: the self-hosted steps say JSON.
    return { kind: "ignored", reason: "body is not JSON" };
  }

  switch (headers.get(HEADERS.event)) {
    case "pull_request": {
      const body = bodyAs(PullRequestDeliverySchema, raw);
      if (body === undefined || body.action !== "closed" || body.pull_request.merged !== true) break;
      return eventOutcome(pullRequestMergedEvent(body.repository, body.pull_request, String(body.repository.owner.id)));
    }
    case "issues": {
      const body = bodyAs(IssuesDeliverySchema, raw);
      if (body === undefined || body.action !== "opened") break;
      return eventOutcome(issueOpenedEvent(body.repository, body.issue, String(body.repository.owner.id)));
    }
    case "star": {
      const body = bodyAs(StarDeliverySchema, raw);
      if (body === undefined || body.action !== "created" || body.starred_at === null) break;
      return eventOutcome(newStarEvent(body.repository, new Date(body.starred_at), String(body.repository.owner.id)));
    }
    case "installation": {
      // The account the app was installed on is the connection's external account
      // (`listAccounts`). `unsuspend`, `created`, and `new_permissions_accepted` need no action:
      // the next sync, or the reconnect a suspension asked for, picks them up.
      const body = bodyAs(InstallationDeliverySchema, raw);
      if (body === undefined) break;
      const externalAccountId = String(body.installation.account.id);
      if (body.action === "deleted") return { kind: "uninstalled", externalAccountId, occurredAt: ctx.now() };
      if (body.action === "suspend") {
        const suspendedAt = body.installation.suspended_at;
        const occurredAt = suspendedAt === null || suspendedAt === undefined ? ctx.now() : new Date(suspendedAt);
        return { kind: "uninstalled", externalAccountId, occurredAt };
      }
      break;
    }
    case "github_app_authorization": {
      // A user revoked their authorization of the app. Only a personal account connection holds a
      // user token (personal billing accepts nothing else), and its external account is that user's
      // own account id, which is `sender.id` here. An organization connection revoked its user token
      // when it connected and syncs with installation tokens, which a revoked authorization leaves
      // working; an organization's id never equals a user's (one account id space), so it is never
      // matched. docs/providers/github.md, "Webhooks", has the reasoning.
      const body = bodyAs(AppAuthorizationDeliverySchema, raw);
      if (body === undefined || body.action !== "revoked") break;
      return { kind: "uninstalled", externalAccountId: String(body.sender.id), occurredAt: ctx.now() };
    }
  }
  return { kind: "ignored", reason: NOT_MAPPED };
}

export const githubWebhooks: WebhookDescriptor = {
  registration: { kind: "app", secretEnv: GITHUB_WEBHOOK_SECRET_ENV },
  subscriptions: githubWebhookSubscriptions,
  verify: verifyWebhook,
  parse: parseWebhook,
};
