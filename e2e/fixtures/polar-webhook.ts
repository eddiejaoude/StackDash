import { randomBytes, randomUUID } from "node:crypto";

import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";

import { polarWebhookSignature } from "../../src/lib/adapters/polar";
import { Secret } from "../../src/lib/adapters/types";
import { STANDARD_WEBHOOK_HEADERS } from "../../src/lib/webhooks/standard-webhooks";
import { adminClient, type TestWorkspace } from "./db";
import { chooseWithKeyboard, panel, tabTo } from "./webhook-panel";

/*
 * Polar webhook deliveries (#429) for the specs that drive simulated Polar's webhook:
 * webhook-setup-polar.spec.ts (both setup paths) and webhooks-polar.spec.ts (a paid order on the
 * timeline). Signed as Polar signs them, with Standard Webhooks, and shaped like Polar's 2026-10
 * `order.paid` payload with synthetic personal data the parse must drop.
 */

/** A Standard Webhooks secret as Polar makes one: `whsec_` and 32 random bytes in base64. */
export function newPolarSigningSecret(): string {
  return `whsec_${randomBytes(32).toString("base64")}`;
}

export type PolarDeliveryOptions = Partial<{
  // Null sends the delivery unsigned.
  secret: string | null;
  deliveryId: string;
  // The id the signature was made for, when it differs from the one sent (a replay).
  signedId: string;
  timestampSeconds: number;
}>;

/** POSTs `body` to the connection's URL as Polar sends it. */
export function postPolarDelivery(request: APIRequestContext, url: string, body: string, options: PolarDeliveryOptions = {}): Promise<APIResponse> {
  const deliveryId = options.deliveryId ?? `msg_${randomUUID().replaceAll("-", "")}`;
  const timestamp = String(options.timestampSeconds ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    [STANDARD_WEBHOOK_HEADERS.delivery]: deliveryId,
    [STANDARD_WEBHOOK_HEADERS.timestamp]: timestamp,
  };
  if (options.secret !== null && options.secret !== undefined) {
    headers[STANDARD_WEBHOOK_HEADERS.signature] = polarWebhookSignature(
      new Secret(options.secret),
      options.signedId ?? deliveryId,
      timestamp,
      new TextEncoder().encode(body),
    );
  }
  return request.post(new URL(url).pathname, { headers, data: body });
}

/** An `order.paid` delivery for a synthetic $49.00 purchase in `organizationId`, created at `createdAt`. */
export function orderPaid(orderId: string, organizationId: string, createdAt: Date): string {
  return JSON.stringify({
    type: "order.paid",
    timestamp: new Date().toISOString(),
    api_version: "2026-10",
    data: {
      id: orderId,
      created_at: createdAt.toISOString(),
      status: "paid",
      billing_reason: "purchase",
      total_amount: 4900,
      currency: "usd",
      billing_name: "Jane Doe",
      customer: { id: randomUUID(), email: "jane.doe@example.com", name: "Jane Doe", organization_id: organizationId },
    },
  });
}

/** The organization a workspace's one simulated Polar connection includes: its id is seeded per grant. */
export async function connectedOrganizationId(workspace: TestWorkspace): Promise<string> {
  const { data, error } = await adminClient().from("external_accounts").select("external_id").eq("workspace_id", workspace.id);
  if (error) throw new Error(`Reading the accounts failed (code ${error.code}).`);
  expect(data).toHaveLength(1);
  const [account] = data;
  if (account === undefined) throw new Error("The simulated Polar connection has no organization.");
  return account.external_id;
}

/** The connection's webhook address from the panel. */
export async function polarWebhookAddress(page: Page): Promise<string> {
  const url = await panel(page).getByRole("textbox", { name: "Webhook address" }).inputValue();
  expect(url).toMatch(/\/api\/webhooks\/polar\/[0-9a-f-]{36}$/);
  return url;
}

/**
 * Sets up the webhook by hand from the panel and pastes `secret` as Polar's, with the keyboard
 * only. Returns the connection's webhook address.
 */
export async function setUpPolarByHand(page: Page, secret: string): Promise<string> {
  await chooseWithKeyboard(page, "Set up by hand");
  await expect(panel(page).getByText(/^Webhook address created\. Add it in Polar with the steps below/)).toBeVisible();
  const url = await polarWebhookAddress(page);
  const field = panel(page).getByLabel("Signing secret from Polar");
  await tabTo(page, field);
  await page.keyboard.type(secret);
  await page.keyboard.press("Enter");
  await expect(panel(page).getByText("Signing secret saved. Deliveries Polar signs with it are accepted from now on.")).toBeVisible();
  return url;
}
