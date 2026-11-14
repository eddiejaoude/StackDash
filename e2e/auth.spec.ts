import { randomUUID } from "node:crypto";

import { test } from "@playwright/test";

import {
  createSyntheticUser,
  editedSessionCookies,
  expect,
  ownerTest,
  removeSyntheticUser,
  signOutTest,
  STORAGE_STATE,
  type StoredSession,
} from "./fixtures/auth";
import { adminClient, createTestWorkspace, deleteTestWorkspace, personalWorkspace } from "./fixtures/db";

test.describe("signed out", () => {
  test("visiting the app redirects to sign-in and keeps where you were going", async ({ page }) => {
    await page.goto("/app");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);

    await page.goto("/w/someworkspace/dashboard");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fw%2Fsomeworkspace%2Fdashboard$/);
  });

  test("the sign-in page offers GitHub only and has a sound structure", async ({ page }) => {
    await page.goto("/sign-in");

    await expect(page).toHaveTitle(/Sign in/);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    await expect(page.getByText("StackDash is invite only during the test.")).toBeVisible();

    const buttons = page.getByRole("main").getByRole("button");
    await expect(buttons).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
    await expect(page.getByRole("main").getByRole("textbox")).toHaveCount(0);
    // Scoped to main: Next.js renders its own route announcer as a live region.
    await expect(page.getByRole("main").getByRole("status")).toBeAttached();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  });

  test("a not-invited error explains what to do next", async ({ page }) => {
    await page.goto("/sign-in?error=not_invited");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      "This GitHub account's email has not been invited to StackDash. Ask for an invite, then try again.",
    );
  });

  test("an unknown error code is ignored", async ({ page }) => {
    await page.goto("/sign-in?error=%3Cscript%3E");
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
  });

  test("sign-out refuses a cross-site post", async ({ request }) => {
    const response = await request.post("/auth/sign-out", {
      headers: { Origin: "https://evil.example" },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(403);
  });
});

/** The token with `claims` merged into its payload and its original signature kept. */
function withClaims(token: string, claims: Record<string, unknown>): string {
  const [header, payload, signature] = token.split(".");
  if (header === undefined || payload === undefined || signature === undefined) throw new Error("not a JWT");
  const decoded: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (typeof decoded !== "object" || decoded === null) throw new Error("not a JWT payload");
  const edited = Buffer.from(JSON.stringify({ ...decoded, ...claims })).toString("base64url");
  return `${header}.${edited}.${signature}`;
}

// Sessions are verified in the app against the stack's public signing key, without asking the
// Auth server (#318), so the app itself must refuse a session it cannot vouch for. Each case edits
// a copy of the owner's stored session and never touches the session itself. An edited token no
// longer matches its signature, so the first two cases prove refusal, not which check fired: a
// correctly signed expired token would need the stack's private key, which stays out of the repo.
test.describe("a session the app cannot verify", () => {
  const cases: [string, (session: StoredSession) => StoredSession][] = [
    [
      "a tampered access token whose exp claim is past",
      (session) => ({
        ...session,
        access_token: withClaims(session.access_token, { exp: Math.floor(Date.now() / 1000) - 60 }),
      }),
    ],
    [
      "an access token claiming another user under the original signature",
      (session) => ({ ...session, access_token: withClaims(session.access_token, { sub: randomUUID() }) }),
    ],
    [
      // An unknown refresh token, so the refresh fails without rotating the owner's real one.
      "an expired session whose refresh token Auth refuses",
      (session) => ({
        ...session,
        expires_at: Math.floor(Date.now() / 1000) - 60,
        refresh_token: "e2e-unknown-refresh-token",
      }),
    ],
  ];

  for (const [title, edit] of cases) {
    test(`${title} redirects to sign-in`, async ({ browser }) => {
      const cookies = await editedSessionCookies(STORAGE_STATE.owner, edit);
      const context = await browser.newContext({ storageState: { cookies, origins: [] } });
      try {
        const page = await context.newPage();
        await page.goto("/w/someworkspace/timeline");
        await expect(page).toHaveURL(/\/sign-in\?next=%2Fw%2Fsomeworkspace%2Ftimeline$/);
      } finally {
        await context.close();
      }
    });
  }
});

ownerTest("a signed-in user visiting sign-in is sent into the app", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page).not.toHaveURL(/\/sign-in/);
  await expect(page).toHaveURL(/\/(app|w\/)/);
});

ownerTest("the app and a workspace root open on the timeline", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/w\/[a-z0-9]+\/timeline$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Timeline");

  const slug = new URL(page.url()).pathname.split("/")[2];
  await page.goto(`/w/${slug}`);
  await expect(page).toHaveURL(new RegExp(`/w/${slug}/timeline$`));

  const switcher = page.getByRole("button", { name: /^Workspace: / });
  await switcher.click();
  await expect(switcher).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("link", { name: /Current$/ })).toHaveAttribute("href", `/w/${slug}/timeline`);
});

// The last workspace is read with the membership list (#346): a recorded workspace the user still
// belongs to opens first, and one they have since left gives way to the personal workspace.
test("the app opens the last workspace while the user is still a member of it", async ({ browser }) => {
  const admin = adminClient();
  const user = await createSyntheticUser("last-workspace");
  const team = await createTestWorkspace("Last workspace");
  const context = await browser.newContext({ storageState: { cookies: user.cookies, origins: [] } });
  try {
    const { error: memberError } = await admin
      .from("workspace_members")
      .insert({ workspace_id: team.id, user_id: user.id, role: "viewer" });
    if (memberError) throw new Error(`Adding the member failed (code ${memberError.code}).`);
    const { error: profileError } = await admin.from("profiles").update({ last_workspace_id: team.id }).eq("user_id", user.id);
    if (profileError) throw new Error(`Recording the last workspace failed (code ${profileError.code}).`);
    const personal = await personalWorkspace(user.id);

    const page = await context.newPage();
    await page.goto("/app");
    await expect(page).toHaveURL(new RegExp(`/w/${team.slug}/timeline$`));

    const { error: leaveError } = await admin
      .from("workspace_members")
      .delete()
      .eq("workspace_id", team.id)
      .eq("user_id", user.id);
    if (leaveError) throw new Error(`Removing the member failed (code ${leaveError.code}).`);

    await page.goto("/app");
    await expect(page).toHaveURL(new RegExp(`/w/${personal.slug}/timeline$`));
  } finally {
    await context.close();
    await deleteTestWorkspace(team);
    await removeSyntheticUser(user);
  }
});

signOutTest("signing out ends the session", async ({ page }) => {
  await page.goto("/app");
  await expect(page).not.toHaveURL(/\/sign-in/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/app");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);
});
