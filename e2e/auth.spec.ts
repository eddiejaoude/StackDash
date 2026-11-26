import { randomUUID } from "node:crypto";

import { test, type Page } from "@playwright/test";

import { DEMO_USER_MARKER, demoSignInLink } from "../src/lib/demo/sign-in";

import {
  authAdminClient,
  authEnv,
  createSyntheticUser,
  editedSessionCookies,
  expect,
  ownerTest,
  removeSyntheticUser,
  signOutTest,
  STORAGE_STATE,
  type StoredSession,
  type SyntheticUser,
} from "./fixtures/auth";
import { expectNoAxeViolations } from "./fixtures/axe";
import { adminClient, createTestWorkspace, deleteTestWorkspace, personalWorkspace } from "./fixtures/db";
import { expectHydrated } from "./fixtures/hydration";
import { tabTo } from "./fixtures/keyboard";
import { EVIDENCE, HIDE_DEV_INDICATOR } from "./fixtures/webhook-panel";

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
    await expect(page.getByText("Sign-up to StackDash is invite only for now.")).toBeVisible();

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

/*
 * A signed-out reader who opens a link with a fragment, such as the Alert emails link in every alert
 * email, lands on that section once signed in (#358). The fragment never reaches the server, so the
 * proxy's `next` has none; the browser carries it onto /sign-in and the form sends it back.
 *
 * GitHub cannot run here: the local stack has no GitHub OAuth app, and Supabase Auth's code exchange
 * runs on the server, out of the test's reach. So the browser is stopped at Supabase Auth's authorize
 * request, the `next` the app put in its redirect_to is read, and GitHub and /auth/callback are stood
 * in for by the one-time sign-in link /auth/confirm consumes (#260), which checks `next` with
 * safeNextPath and redirects to it as /auth/callback does. That link only signs in an account with
 * the demo marker, so each test marks a throwaway user it removes afterwards. Every other step is
 * the app's own: the proxy redirect, the sign-in page, its form, and the landing page.
 */
test.describe("signing in from a link with a fragment", () => {
  // Evidence (PW_PR_EVIDENCE=1): the page the reader lands on, at one size, in London time, and with
  // reduced motion, so the capture shows where the page scrolled to rather than a smooth scroll.
  test.use(EVIDENCE ? { timezoneId: "Europe/London", viewport: { width: 1280, height: 900 }, reducedMotion: "reduce" } : {});

  /** Supabase Auth's authorize requests answered for GitHub, recording the `next` of each. */
  async function standInForGitHub(page: Page, user: SyntheticUser | null): Promise<string[]> {
    const sent: string[] = [];
    await page.route(
      (url) => url.pathname === "/auth/v1/authorize",
      async (route) => {
        const redirectTo = new URL(new URL(route.request().url()).searchParams.get("redirect_to") ?? "");
        const next = redirectTo.searchParams.get("next") ?? "";
        sent.push(next);
        if (user === null) {
          await route.fulfill({ status: 200, contentType: "text/plain", body: "GitHub stand-in" });
          return;
        }
        const location = await demoSignInLink(authAdminClient(authEnv()), { email: user.email, origin: redirectTo.origin, next });
        await route.fulfill({ status: 303, headers: { location } });
      },
    );
    return sent;
  }

  async function markAsDemoAccount(user: SyntheticUser): Promise<void> {
    const { error } = await authAdminClient(authEnv()).auth.admin.updateUserById(user.id, { app_metadata: { [DEMO_USER_MARKER]: true } });
    if (error) throw new Error(`Marking ${user.email} for the sign-in link failed: ${error.message}`);
  }

  const cases = [
    {
      title: "a link to Alert emails lands on Alert emails",
      link: (slug: string) => `/w/${slug}/alerts/settings#alert-emails`,
      evidence: "alert-settings-link",
    },
    {
      title: "an alerts link sent before alert settings moved lands on Alert emails",
      link: (slug: string) => `/w/${slug}/alerts#alert-emails`,
      evidence: "old-alerts-link",
    },
  ];

  for (const { title, link, evidence } of cases) {
    test(title, async ({ page }) => {
      const user = await createSyntheticUser("fragment-sign-in");
      try {
        await markAsDemoAccount(user);
        const { slug } = await personalWorkspace(user.id);
        const sent = await standInForGitHub(page, user);
        const [path] = link(slug).split("#");

        await page.goto(link(slug));
        await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(path ?? "")}#alert-emails`);
        await expectHydrated(page);
        await expectNoAxeViolations(page);

        // Keyboard only: Tab to the one button and press Enter.
        await page.locator("body").focus();
        await tabTo(page, page.getByRole("button", { name: "Continue with GitHub" }), 10);
        await page.keyboard.press("Enter");

        await page.waitForURL(new RegExp(`/w/${slug}/alerts`));
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        if (EVIDENCE) {
          await page.waitForLoadState("networkidle");
          await page.screenshot({ path: `pr-evidence/${evidence}.png`, animations: "disabled", style: HIDE_DEV_INDICATOR });
        }

        expect(sent).toEqual([link(slug)]);
        await expect(page).toHaveURL(`/w/${slug}/alerts/settings#alert-emails`);
        await expect(page.getByRole("heading", { level: 1 })).toHaveText("Alert settings");
        const emails = page.getByRole("heading", { name: "Alert emails" });
        await expect(emails).toBeInViewport();
        await expect(emails).toBeFocused();
      } finally {
        await removeSyntheticUser(user);
      }
    });
  }

  test("a link with no fragment signs in to the same page", async ({ page }) => {
    const user = await createSyntheticUser("no-fragment-sign-in");
    try {
      await markAsDemoAccount(user);
      const { slug } = await personalWorkspace(user.id);
      const sent = await standInForGitHub(page, user);

      await page.goto(`/w/${slug}/alerts/settings`);
      await expect(page).toHaveURL(`/sign-in?next=${encodeURIComponent(`/w/${slug}/alerts/settings`)}`);
      await expectHydrated(page);
      await page.getByRole("button", { name: "Continue with GitHub" }).click();

      await expect(page).toHaveURL(`/w/${slug}/alerts/settings`);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Alert settings");
      expect(sent).toEqual([`/w/${slug}/alerts/settings`]);
    } finally {
      await removeSyntheticUser(user);
    }
  });

  test("a fragment never takes sign-in outside the app", async ({ page }) => {
    const sent = await standInForGitHub(page, null);

    await page.goto(`/sign-in?next=${encodeURIComponent("/sign-in")}#alert-emails`);
    await expectHydrated(page);
    await page.getByRole("button", { name: "Continue with GitHub" }).click();

    await expect.poll(() => sent).toEqual(["/app"]);
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
