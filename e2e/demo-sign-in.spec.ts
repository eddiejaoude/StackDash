import { execFile } from "node:child_process";
import { promisify } from "node:util";

import AxeBuilder from "@axe-core/playwright";
import { test, type Page } from "@playwright/test";
import { z } from "zod";

import { DEMO_USER_MARKER, demoSignInLink } from "../src/lib/demo/sign-in";

import { authAdminClient, authEnv, createSyntheticUser, expect, removeSyntheticUser, type SyntheticUser } from "./fixtures/auth";
import { adminClient, personalWorkspace } from "./fixtures/db";

/*
 * The demo account's one-time sign-in link (#260), end to end on the local stack: minted by
 * `demoSignInLink`, the helper `npm run demo` prints it with, opened in a signed-out browser, and
 * consumed by `/auth/confirm`. The links are minted for throwaway accounts, one carrying the demo
 * account's marker, never for demo@example.com, so the demo workspace someone may be presenting
 * from is never touched. `npm run demo` rebuilds that workspace, so only its refusal runs here;
 * src/lib/demo/seed.test.ts covers its order.
 */

const run = promisify(execFile);
const FAILED_RUN = z.object({ code: z.number(), stdout: z.string(), stderr: z.string() });
const LINK_INVALID = "This sign-in link has expired or was already used. Run npm run demo again to print a new one.";

/** A one-time link for `user` that lands on `next`, relative to the test's base URL. */
function mintLink(user: SyntheticUser, next: string): Promise<string> {
  return demoSignInLink(authAdminClient(authEnv()), { email: user.email, origin: "", next });
}

async function markAsDemoAccount(user: SyntheticUser): Promise<void> {
  const { error } = await authAdminClient(authEnv()).auth.admin.updateUserById(user.id, { app_metadata: { [DEMO_USER_MARKER]: true } });
  if (error) throw new Error(`Marking ${user.email} as the demo account failed: ${error.message}`);
}

async function expectLinkRefused(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/sign-in\?error=link_invalid&next=/);
  await expect(page.getByRole("main").getByRole("alert")).toHaveText(LINK_INVALID);
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
}

test.describe("demo sign-in link", () => {
  test("signs in as the demo account and opens its dashboard, once", async ({ page }) => {
    const user = await createSyntheticUser("demo-link");
    try {
      await markAsDemoAccount(user);
      const { slug } = await personalWorkspace(user.id);
      const link = await mintLink(user, `/w/${slug}/dashboard`);

      await page.goto(link);
      await expect(page).toHaveURL(new RegExp(`/w/${slug}/dashboard$`));
      await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");

      // Signed out, the same link again: used, so it is refused with the next step.
      await page.context().clearCookies();
      await page.goto(link);
      await expectLinkRefused(page);
      await expect(page).toHaveURL(new RegExp(`next=${encodeURIComponent(`/w/${slug}/dashboard`)}$`));

      const scan = await new AxeBuilder({ page }).analyze();
      expect(scan.violations).toEqual([]);

      // Keyboard: Tab from the top of the page reaches the GitHub button, with a visible focus ring.
      const github = page.getByRole("button", { name: "Continue with GitHub" });
      await page.locator("body").focus();
      for (let presses = 0; presses < 10 && !(await github.evaluate((button) => button === document.activeElement)); presses++) {
        await page.keyboard.press("Tab");
      }
      await expect(github).toBeFocused();
      expect(await github.evaluate((button) => getComputedStyle(button).outlineStyle)).not.toBe("none");
    } finally {
      await removeSyntheticUser(user);
    }
  });

  test("refuses a link for an account that is not the demo account, and leaves it signed out", async ({ page }) => {
    const user = await createSyntheticUser("not-demo-link");
    try {
      const { slug } = await personalWorkspace(user.id);
      await page.goto(await mintLink(user, `/w/${slug}/dashboard`));
      await expectLinkRefused(page);

      await page.goto("/app");
      await expect(page).toHaveURL(/\/sign-in\?next=%2Fapp$/);
    } finally {
      await removeSyntheticUser(user);
    }
  });

  test("refuses a link with no token", async ({ page }) => {
    await page.goto("/auth/confirm?type=email&next=%2Fapp");
    await expectLinkRefused(page);
  });
});

test("npm run demo refuses with simulation off and writes nothing", async () => {
  const countDemoWorkspaces = async (): Promise<number | null> => {
    const { count, error } = await adminClient().from("workspaces").select("id", { count: "exact", head: true }).eq("name", "Demo workspace");
    if (error) throw new Error(`Counting demo workspaces failed (code ${error.code}).`);
    return count;
  };
  const before = await countDemoWorkspaces();

  let refused: z.infer<typeof FAILED_RUN>;
  try {
    await run("npm", ["run", "-s", "demo"], { env: { ...process.env, STACKDASH_SIMULATE_PROVIDERS: "0" }, timeout: 60_000 });
    throw new Error("npm run demo ran with simulation off.");
  } catch (error) {
    // execFile rejects on a non-zero exit, with the exit code and both streams on the error.
    refused = FAILED_RUN.parse(error);
  }

  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain("Demo refused. Provider simulation is off.");
  expect(refused.stdout).toBe("");
  expect(await countDemoWorkspaces()).toBe(before);
});
