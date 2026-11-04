import { test } from "@playwright/test";

import { authEnv, expect, ownerTest, signOutTest } from "./fixtures/auth";

// The enforced policy of the landing page (next.config.ts).
const BASELINE_CSP = "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'";

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((directive): [string, string[]] => {
      const [name = "", ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

/**
 * App routes (src/proxy.ts) enforce the landing directives, except that form-action also allows
 * exactly the no-JavaScript sign-in chain (Supabase Auth, then GitHub), because browsers check
 * form-action on every redirect after a form post. The connect form leaves by meta refresh, not a
 * redirect, so no provider origin is listed.
 */
function expectAppPolicy(policy: string | undefined): void {
  const app = directives(policy ?? "");
  const baseline = directives(BASELINE_CSP);
  expect([...app.keys()]).toEqual([...baseline.keys()]);
  for (const [name, sources] of baseline) {
    if (name !== "form-action") expect(app.get(name), name).toEqual(sources);
  }
  expect(new Set(app.get("form-action"))).toEqual(
    new Set(["'self'", new URL(authEnv().NEXT_PUBLIC_SUPABASE_URL).origin, "https://github.com"]),
  );
}

test.describe("signed out", () => {
  test("visiting the app redirects to sign-in and keeps where you were going", async ({ page }) => {
    await page.goto("/app");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);

    await page.goto("/w/someworkspace/dashboard");
    await expect(page).toHaveURL(/\/sign-in\?next=%2Fw%2Fsomeworkspace%2Fdashboard$/);
  });

  test("the sign-in page offers GitHub only and has a sound structure", async ({ page }) => {
    const response = await page.goto("/sign-in");

    await expect(page).toHaveTitle(/Sign in/);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in");
    await expect(page.getByText("DevMacro is invite only during the test.")).toBeVisible();

    const buttons = page.getByRole("main").getByRole("button");
    await expect(buttons).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
    await expect(page.getByRole("main").getByRole("textbox")).toHaveCount(0);
    // Scoped to main: Next.js renders its own route announcer as a live region.
    await expect(page.getByRole("main").getByRole("status")).toBeAttached();
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);

    // App routes enforce only the script-independent directives (form-action widened for the
    // sign-in chain above) and report the nonce policy, until #125 moves it to enforcement.
    const headers = response?.headers() ?? {};
    expectAppPolicy(headers["content-security-policy"]);
    const reportOnly = headers["content-security-policy-report-only"] ?? "";
    expect(reportOnly).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
    // Report-only today, so this enforces nothing yet: it pins connect-src so that enforcing the
    // nonce policy (#125) cannot cut off the Realtime socket that live updates need (#129).
    const supabaseUrl = new URL(authEnv().NEXT_PUBLIC_SUPABASE_URL);
    expect(directives(reportOnly).get("connect-src")).toContain(
      `${supabaseUrl.protocol === "https:" ? "wss:" : "ws:"}//${supabaseUrl.host}`,
    );
  });

  test("a not-invited error explains what to do next", async ({ page }) => {
    await page.goto("/sign-in?error=not_invited");
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      "This GitHub account's email has not been invited to the DevMacro test. Ask for an invite, then try again.",
    );
  });

  test("an unknown error code is ignored", async ({ page }) => {
    await page.goto("/sign-in?error=%3Cscript%3E");
    await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
  });

  test("the landing page keeps its static policy without a nonce", async ({ page }) => {
    const response = await page.goto("/");
    const headers = response?.headers() ?? {};
    expect(headers["content-security-policy"]).toBe(BASELINE_CSP);
    expect(headers["content-security-policy-report-only"]).toBeUndefined();
  });

  test("sign-out refuses a cross-site post", async ({ request }) => {
    const response = await request.post("/auth/sign-out", {
      headers: { Origin: "https://evil.example" },
      maxRedirects: 0,
    });
    expect(response.status()).toBe(403);
  });
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
});

signOutTest("signing out ends the session", async ({ page }) => {
  await page.goto("/app");
  await expect(page).not.toHaveURL(/\/sign-in/);

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/$/);

  await page.goto("/app");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);
});
