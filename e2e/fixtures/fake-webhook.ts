import type { APIRequestContext, APIResponse } from "@playwright/test";

import { FAKE_WEBHOOK_HEADERS, signFakeWebhook } from "../../src/lib/adapters/fake";

/*
 * Plays the fake provider's side of a webhook delivery (#28). playwright.config.ts gives the app
 * this secret as STACKDASH_FAKE_WEBHOOK_SECRET, which takes precedence over .env.local, so a run
 * never depends on a local value. Synthetic and used only by end-to-end runs: not a secret.
 */
export const FAKE_WEBHOOK_E2E_SECRET = "e2e-only-fake-webhook-secret";

/**
 * POSTs `body` to the fake provider's app-level URL as the provider would: the delivery id, the
 * current timestamp, and the signature over both, unless `signed` is false, which sends no
 * signature at all.
 */
export function postFakeWebhook(
  request: APIRequestContext,
  body: string,
  options: Readonly<{ deliveryId: string; signed?: boolean }>,
): Promise<APIResponse> {
  const timestampSeconds = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [FAKE_WEBHOOK_HEADERS.delivery]: options.deliveryId,
    [FAKE_WEBHOOK_HEADERS.timestamp]: String(timestampSeconds),
  };
  if (options.signed !== false) {
    headers[FAKE_WEBHOOK_HEADERS.signature] = signFakeWebhook({ secret: FAKE_WEBHOOK_E2E_SECRET, rawBody: body, timestampSeconds });
  }
  return request.post("/api/webhooks/fake", { data: body, headers });
}
