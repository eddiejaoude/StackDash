import { randomUUID } from "node:crypto";

import type { APIRequestContext, Page } from "@playwright/test";

import { SIMULATED_SCOPE } from "../src/lib/adapters/simulated/marker";
import {
  SIMULATED_DELIVERY_HEADER,
  SIMULATED_SIGNATURE_HEADER,
  SIMULATED_WEBHOOK_WRITE_SCOPE,
  simulatedWebhookSignature,
} from "../src/lib/adapters/simulated/webhooks";
import { Secret } from "../src/lib/adapters/types";
import { WEBHOOK_ENDPOINTS_PER_WORKSPACE } from "../src/lib/connections/webhook-copy";
import { expect, ownerTest, viewerTest } from "./fixtures/auth";
import { connectSimulated } from "./fixtures/connections";
import {
  adminClient,
  CONNECTION_URL,
  createTestWorkspace,
  deleteTestWorkspace,
  type TestWorkspace,
} from "./fixtures/db";
import { anonymous } from "./fixtures/share";
import {
  chooseWithKeyboard,
  connectionId,
  disconnect,
  endpointCount,
  EVIDENCE,
  evidence,
  expectAccessiblePanel,
  grantedScopes,
  panel,
  tabTo,
} from "./fixtures/webhook-panel";

/*
 * The webhook setup panel (#426), end to end through the simulated providers. GitLab's simulated
 * twin carries a stand-in webhook (src/lib/adapters/simulated/webhooks.ts) until #428 lands;
 * Resend's carries the live declaration (#427). GitLab's automatic setup needs write access,
 * Resend's uses the access already granted and generates the signing secret.
 *
 * Covers both paths with the copy from #426, the write access warning before the consent screen,
 * the write access shown while it is held, setup by hand with the address, the secret shown once,
 * the steps, a signed delivery and its time, a new secret, disconnect for each path, the endpoint
 * limit, an axe scan of the panel, and a keyboard-only pass. Deliveries are posted from a context
 * with no session, as a provider sends them. No job tick runs: a delivery shows on the panel when
 * it is received.
 */

const GITLAB_AUTOMATIC =
  "StackDash asks GitLab for write access, because GitLab has no read-only access that can create a webhook. With write access, StackDash's connection can change your GitLab account, not only read it. If you want StackDash to stay read-only, set up the webhook by hand instead.";
const GITLAB_MANUAL =
  "StackDash stays read-only. You add the webhook in GitLab yourself, using the address and secret below.";
const RESEND_AUTOMATIC =
  "StackDash adds a webhook to your Resend team, using the access you already granted. You can see it in Resend, and StackDash removes it when you disconnect.";
const RESEND_MANUAL =
  "You add the webhook in Resend yourself, using the address below.";

async function pageEvidence(page: Page, name: string): Promise<void> {
  if (!EVIDENCE) return;
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `pr-evidence/after/${name}.png`,
    animations: "disabled",
    fullPage: true,
  });
}

function postDelivery(
  request: APIRequestContext,
  url: string,
  secret: string,
  deliveryId = `e2e-${randomUUID()}`,
) {
  const body = JSON.stringify({ test: true });
  return request.post(new URL(url).pathname, {
    data: body,
    headers: {
      "Content-Type": "application/json",
      [SIMULATED_DELIVERY_HEADER]: deliveryId,
      [SIMULATED_SIGNATURE_HEADER]: simulatedWebhookSignature(
        new Secret(secret),
        deliveryId,
        new TextEncoder().encode(body),
      ),
    },
  });
}

ownerTest.describe("webhook setup panel", () => {
  let workspace: TestWorkspace;

  ownerTest.beforeEach(async () => {
    workspace = await createTestWorkspace("Webhook setup");
  });

  ownerTest.afterEach(async () => {
    await deleteTestWorkspace(workspace);
  });

  ownerTest(
    "automatic setup with write access warns before the consent screen and shows the write access while held",
    async ({ page }) => {
      ownerTest.slow();
      if (EVIDENCE) await page.emulateMedia({ reducedMotion: "reduce" });
      await connectSimulated(page, workspace.slug, "GitLab");
      const connection = await connectionId(page);

      // Both choices, with their copy, before anything is requested or changed.
      await expect(
        panel(page).getByText(
          "Until a webhook is set up, StackDash checks GitLab for changes on a schedule.",
        ),
      ).toBeVisible();
      await expect(
        panel(page).getByRole("radio", { name: /Set up automatically/ }),
      ).toHaveAccessibleDescription(GITLAB_AUTOMATIC);
      await expect(
        panel(page).getByRole("radio", { name: "Set up by hand" }),
      ).toHaveAccessibleDescription(GITLAB_MANUAL);
      await expect(
        panel(page).getByText("Write access", { exact: true }),
      ).toBeVisible();
      expect(await endpointCount(connection)).toBe(0);
      await expectAccessiblePanel(page);
      await evidence(panel(page), "panel-choices-write-access");

      await chooseWithKeyboard(page, "Set up automatically");

      // The warning again, with the scope and its reason, before the provider's own screen.
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(
        "Set up GitLab webhooks automatically",
      );
      // Visible only: the connection page the user came from can stay mounted, hidden, behind this one.
      await expect(
        page.getByText(GITLAB_AUTOMATIC).filter({ visible: true }),
      ).toBeVisible();
      const writeScope = page
        .getByRole("listitem")
        .filter({ hasText: SIMULATED_WEBHOOK_WRITE_SCOPE });
      await expect(
        writeScope.getByText("Full access", { exact: true }),
      ).toBeVisible();
      await expect(
        writeScope.getByText(
          "Why full access: Simulated. GitLab has no read-only access that can create a webhook.",
        ),
      ).toBeVisible();
      expect(await grantedScopes(connection)).toEqual([SIMULATED_SCOPE]);
      await pageEvidence(page, "consent-write-access-warning");
      const consent = page.getByRole("checkbox", {
        name: "I understand StackDash gets full access to my GitLab account",
      });
      await tabTo(page, consent);
      await page.keyboard.press("Space");
      await tabTo(
        page,
        page.getByRole("button", { name: "Continue to GitLab" }),
      );
      await page.keyboard.press("Enter");

      await expect(page).toHaveURL(CONNECTION_URL);
      await expect(
        page.getByText("Webhook set up", { exact: true }),
      ).toBeVisible();
      await expect(
        panel(page).getByText(
          /^Set up automatically\. StackDash added this webhook in GitLab/,
        ),
      ).toBeVisible();
      const held = panel(page).getByRole("heading", {
        name: "Write access StackDash holds in GitLab",
      });
      await expect(held).toBeVisible();
      await expect(
        panel(page).getByText(SIMULATED_WEBHOOK_WRITE_SCOPE, { exact: true }),
      ).toBeVisible();
      expect(await grantedScopes(connection)).toEqual([
        SIMULATED_SCOPE,
        SIMULATED_WEBHOOK_WRITE_SCOPE,
      ]);
      expect(await endpointCount(connection)).toBe(1);
      await expectAccessiblePanel(page);
      await evidence(panel(page), "panel-automatic-write-access-held");

      await disconnect(
        page,
        "Deletes the webhook StackDash added in GitLab. If that fails, you are told how to do it there.",
        /StackDash deleted its webhook in GitLab\./,
        "disconnect-automatic",
      );
      await expect(panel(page)).toHaveCount(0);
      expect(await endpointCount(connection)).toBe(0);
    },
  );

  ownerTest(
    "setup by hand shows the address, the secret once, the steps, and the last delivery, and never asks for a scope",
    async ({ page, baseURL }) => {
      ownerTest.slow();
      if (EVIDENCE) await page.emulateMedia({ reducedMotion: "reduce" });
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"]);
      const provider = await anonymous(baseURL);
      try {
        await connectSimulated(page, workspace.slug, "GitLab");
        const connection = await connectionId(page);

        await chooseWithKeyboard(page, "Set up by hand");
        await expect(
          panel(page).getByText(
            "Webhook address and secret created. Add them in GitLab with the steps below.",
          ),
        ).toBeVisible();
        await expect(page).toHaveURL(CONNECTION_URL);
        expect(await grantedScopes(connection)).toEqual([SIMULATED_SCOPE]);

        const address = panel(page).getByRole("textbox", {
          name: "Webhook address",
        });
        const secretField = panel(page).getByRole("textbox", {
          name: "Webhook secret",
        });
        const url = await address.inputValue();
        expect(url).toMatch(/\/api\/webhooks\/gitlab\/[0-9a-f-]{36}$/);
        const secret = await secretField.inputValue();
        expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
        await expect(
          panel(page)
            .getByRole("listitem")
            .filter({
              hasText:
                "Paste the address below into URL and the secret below into Secret token.",
            }),
        ).toBeVisible();
        await expect(
          panel(page).getByRole("status").filter({ hasText: "Last delivery:" }),
        ).toHaveText("Last delivery: None in the last 30 days.");

        // Copy buttons, from the keyboard.
        await tabTo(
          page,
          panel(page).getByRole("button", { name: "Copy address" }),
        );
        await page.keyboard.press("Enter");
        await expect(panel(page).getByText("Address copied.")).toBeVisible();
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
          url,
        );
        await tabTo(
          page,
          panel(page).getByRole("button", { name: "Copy secret" }),
        );
        await page.keyboard.press("Enter");
        await expect(panel(page).getByText("Secret copied.")).toBeVisible();
        await expectAccessiblePanel(page);
        await evidence(panel(page), "panel-by-hand-secret-shown-once");

        // The provider sends a delivery; checking again shows when it arrived, through a polite region.
        expect(
          (await postDelivery(provider, url, "not-the-secret")).status(),
        ).toBe(401);
        expect((await postDelivery(provider, url, secret)).status()).toBe(202);
        await tabTo(
          page,
          panel(page).getByRole("button", { name: "Check for deliveries" }),
        );
        await page.keyboard.press("Enter");
        const lastDelivery = panel(page)
          .getByRole("status")
          .filter({ hasText: "Last delivery:" });
        await expect(lastDelivery).toHaveAttribute("aria-live", "polite");
        await expect(lastDelivery.locator("time")).toHaveAttribute(
          "datetime",
          /^\d{4}-\d{2}-\d{2}T/,
        );

        // The secret is not shown again after a reload; a new one replaces it and the old one stops working.
        await page.reload();
        await expect(
          panel(page).getByRole("textbox", { name: "Webhook secret" }),
        ).toHaveCount(0);
        await expect(
          panel(page).getByText(/StackDash shows the secret only once/),
        ).toBeVisible();
        await evidence(panel(page), "panel-by-hand-delivery-received");
        await tabTo(
          page,
          panel(page).getByRole("button", { name: "Make a new secret" }),
        );
        await page.keyboard.press("Enter");
        await expect(
          panel(page).getByText(
            "New secret made. The old one no longer works: replace it in GitLab now.",
          ),
        ).toBeVisible();
        const rotated = await panel(page)
          .getByRole("textbox", { name: "Webhook secret" })
          .inputValue();
        expect(rotated).not.toBe(secret);
        expect((await postDelivery(provider, url, secret)).status()).toBe(401);
        expect((await postDelivery(provider, url, rotated)).status()).toBe(202);

        // Leaving the page hides the new secret: with cacheComponents the page is kept, hidden, so
        // coming back through client navigation must not show it again.
        await page.getByRole("link", { name: "All connections" }).click();
        await expect(page.getByRole("heading", { level: 1, name: "Connections" })).toBeVisible();
        await page.goBack();
        await expect(panel(page)).toBeVisible();
        await expect(panel(page).getByRole("textbox", { name: "Webhook secret" })).toHaveCount(0);

        await disconnect(
          page,
          /^Stops accepting the webhook you added in GitLab\. Remove it there afterwards: In GitLab, open the group/,
          /Remove the webhook you added in GitLab: In GitLab, open the group, then Settings, then Webhooks/,
          "disconnect-by-hand",
        );
        // Deliveries for a removed connection are dropped.
        expect((await postDelivery(provider, url, rotated)).status()).toBe(404);
      } finally {
        await provider.dispose();
      }
    },
  );

  ownerTest(
    "automatic setup without new access creates the webhook at once, and setup by hand takes the provider's signing secret",
    async ({ page }) => {
      ownerTest.slow();
      await connectSimulated(page, workspace.slug, "Resend");
      await expect(
        panel(page).getByRole("radio", { name: "Set up automatically" }),
      ).toHaveAccessibleDescription(RESEND_AUTOMATIC);
      await expect(
        panel(page).getByRole("radio", { name: "Set up by hand" }),
      ).toHaveAccessibleDescription(RESEND_MANUAL);
      await expect(
        panel(page).getByText("Write access", { exact: true }),
      ).toHaveCount(0);
      await evidence(panel(page), "panel-choices-no-new-access");

      await chooseWithKeyboard(page, "Set up automatically");
      await expect(
        panel(page).getByText(/^StackDash added a webhook in Resend\./),
      ).toBeVisible();
      await expect(
        panel(page).getByText(
          /^Set up automatically\. StackDash added this webhook in Resend/,
        ),
      ).toBeVisible();
      await expect(
        panel(page).getByRole("heading", { name: /^Write access/ }),
      ).toHaveCount(0);
      // Every automatic webhook says how to move to setup by hand, here without write access.
      await expect(
        panel(page).getByText(
          "To set up the webhook by hand instead, disconnect Resend, reconnect it, and choose setup by hand. Disconnecting deletes the webhook.",
        ),
      ).toBeVisible();

      // A second Resend connection, set up by hand: Resend generates the signing secret.
      await connectSimulated(page, workspace.slug, "Resend");
      await chooseWithKeyboard(page, "Set up by hand");
      await expect(
        panel(page).getByText(
          /^Webhook address created\. Add it in Resend with the steps below/,
        ),
      ).toBeVisible();
      const signingSecret = panel(page).getByLabel(
        "Signing secret from Resend",
      );
      await expect(signingSecret).toHaveAccessibleDescription(
        /^Deliveries are refused until you paste it\./,
      );
      await tabTo(
        page,
        panel(page).getByRole("button", { name: "Save signing secret" }),
      );
      await page.keyboard.press("Enter");
      // Boundary: nothing pasted.
      await expect(signingSecret).toBeFocused();
      await expect(signingSecret).toHaveAttribute("aria-invalid", "true");
      await expect(
        panel(page).getByText("Paste the signing secret before saving."),
      ).toBeVisible();
      await signingSecret.fill("whsec_e2eSyntheticSigningSecret");
      await page.keyboard.press("Enter");
      await expect(
        panel(page).getByText(
          "Signing secret saved. Deliveries Resend signs with it are accepted from now on.",
        ),
      ).toBeVisible();
      await expect(signingSecret).toHaveAccessibleDescription(/^Saved\./);
      await expectAccessiblePanel(page);
      await evidence(panel(page), "panel-by-hand-provider-secret");
    },
  );

  ownerTest(
    "a workspace at the endpoint limit says so instead of offering setup",
    async ({ page }) => {
      await seedGitLabEndpoints(workspace, WEBHOOK_ENDPOINTS_PER_WORKSPACE);

      await connectSimulated(page, workspace.slug, "GitLab");
      await expect(
        panel(page).getByText(
          `This workspace already has ${WEBHOOK_ENDPOINTS_PER_WORKSPACE} webhooks, the most one workspace can have.`,
          { exact: false },
        ),
      ).toBeVisible();
      await expect(panel(page).getByRole("radio")).toHaveCount(0);
      await expectAccessiblePanel(page);
      await evidence(panel(page), "panel-endpoint-limit");
    },
  );

  ownerTest(
    "write access left without a webhook drops the read-only claim and a read-only reconnect gives it up",
    async ({ page }) => {
      ownerTest.slow();
      await connectSimulated(page, workspace.slug, "GitLab");
      const connection = await connectionId(page);
      await chooseWithKeyboard(page, "Set up automatically");
      await page
        .getByRole("checkbox", { name: "I understand StackDash gets full access to my GitLab account" })
        .check();
      await page.getByRole("button", { name: "Continue to GitLab" }).click();
      await expect(page.getByText("Webhook set up", { exact: true })).toBeVisible();

      // As if creating the webhook had failed after the consent: the write-scoped grant is stored
      // and no webhook uses it.
      const { error } = await adminClient().from("webhook_endpoints").delete().eq("connection_id", connection);
      if (error) throw new Error(`Deleting the endpoint failed (code ${error.code}).`);
      await page.goto(page.url().split("?")[0] ?? page.url());

      await expect(
        panel(page).getByText(
          "StackDash still holds write access from automatic setup, but no webhook uses it. Reconnect GitLab to return to read-only access.",
        ),
      ).toBeVisible();
      await expect(panel(page).getByRole("radio", { name: "Set up by hand" })).toHaveAccessibleDescription(
        "You add the webhook in GitLab yourself, using the address and secret below.",
      );
      await expect(panel(page).getByRole("radio", { name: /Set up automatically/ })).toHaveAccessibleDescription(
        "StackDash asks GitLab for write access, because GitLab has no read-only access that can create a webhook. With write access, StackDash's connection can change your GitLab account, not only read it.",
      );
      await expectAccessiblePanel(page);
      await evidence(panel(page), "panel-leftover-write-access");

      const reconnect = panel(page).getByRole("link", { name: "Reconnect GitLab read-only" });
      await tabTo(page, reconnect);
      await page.keyboard.press("Enter");
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Reconnect GitLab");
      // Visible only: the connection page stays mounted, hidden, behind this one.
      await expect(page.getByText(SIMULATED_WEBHOOK_WRITE_SCOPE).filter({ visible: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Continue to GitLab" }).click();
      await expect(page).toHaveURL(CONNECTION_URL);
      expect(await grantedScopes(connection)).toEqual([SIMULATED_SCOPE]);
      await expect(panel(page).getByRole("heading", { name: /^Write access/ })).toHaveCount(0);
      await expect(panel(page).getByRole("radio", { name: "Set up by hand" })).toHaveAccessibleDescription(GITLAB_MANUAL);
    },
  );
});

viewerTest.describe("webhook setup panel for a viewer", () => {
  viewerTest("shows how the webhook was set up and its last delivery, with no address or controls", async ({ page }) => {
    const workspace = await createTestWorkspace("Webhook viewer");
    try {
      const [connection] = await seedGitLabEndpoints(workspace, 1);
      if (connection === undefined) throw new Error("expected a seeded connection");
      await page.goto(`/w/${workspace.slug}/connections/${connection}`);

      await expect(panel(page).getByText("Set up by hand.", { exact: true })).toBeVisible();
      await expect(panel(page).getByText("Last delivery: None in the last 30 days.")).toBeVisible();
      for (const role of ["radio", "textbox", "button", "link"] as const) {
        await expect(panel(page).getByRole(role)).toHaveCount(0);
      }
      await expectAccessiblePanel(page);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});

/** Seeds `count` GitLab connections in the workspace, each with a webhook set up by hand. */
async function seedGitLabEndpoints(workspace: TestWorkspace, count: number): Promise<string[]> {
  const admin = adminClient();
  const seeded = Array.from({ length: count }, () => randomUUID());
  const { error: connectionError } = await admin.from("connections").insert(
    seeded.map((id, index) => ({
      id,
      workspace_id: workspace.id,
      provider: "gitlab" as const,
      status: "active" as const,
      display_name: `Seeded ${index}`,
      poll_interval_seconds: 3600,
    })),
  );
  if (connectionError) throw new Error(`Seeding connections failed (code ${connectionError.code}).`);
  const { error: endpointError } = await admin.from("webhook_endpoints").insert(
    seeded.map((id) => ({
      workspace_id: workspace.id,
      connection_id: id,
      provider: "gitlab" as const,
      key_id: "e2e",
      iv: "\\x00",
      ciphertext: "\\x00",
      auth_tag: "\\x00",
    })),
  );
  if (endpointError) throw new Error(`Seeding endpoints failed (code ${endpointError.code}).`);
  return seeded;
}
