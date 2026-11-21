import { test, type Page } from "@playwright/test";

import { authEnv, expect, ownerTest } from "./fixtures/auth";
import { BASELINE_CSP } from "./fixtures/csp";
import { createTestWorkspace, deleteTestWorkspace } from "./fixtures/db";
import { expectHydrated } from "./fixtures/hydration";
import { publishStars, seedProjectWithHistory, turnOffPage, turnOnPage } from "./fixtures/public-pages";

// Content security policy (#125). App routes enforce a per-request nonce policy (src/proxy.ts) and
// render their HTML per request so Next.js can stamp the nonce on every script. So do the signed-out
// unsubscribe page that alert emails link to (#152), public project pages (#150), and the global
// not-found page that answers paths matching no route, which includes paths under the proxied
// prefixes (#197). The rest of the site keeps a static policy (next.config.ts). CI runs these
// against the production build, where a prerendered page under the nonce policy would carry
// unnonced inline scripts and never hydrate.

// The server under test is a production build when CI is set and the dev server otherwise, the same
// switch as the webServer command in playwright.config.ts.
const PRODUCTION_BUILD = Boolean(process.env.CI);

const NONCE_SOURCE = /^'nonce-[A-Za-z0-9+/=]+'$/;

/** The page's view of the function `watchViolations` exposes to it. */
type ViolationWindow = Window & { reportCspViolation?: (violation: string) => Promise<void> };

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split(";").map((directive): [string, string[]] => {
      const [name = "", ...sources] = directive.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

/**
 * App routes enforce the landing directives plus the nonce policy. form-action also allows
 * exactly the no-JavaScript sign-in chain (Supabase Auth, then GitHub), because browsers check
 * form-action on every redirect after a form post. The connect form leaves by meta refresh, not a
 * redirect, so no provider origin is listed.
 */
function expectAppPolicy(policy: string | undefined): void {
  const app = directives(policy ?? "");
  for (const [name, sources] of directives(BASELINE_CSP)) {
    if (name !== "form-action") expect(app.get(name), name).toEqual(sources);
  }
  const supabaseUrl = new URL(authEnv().NEXT_PUBLIC_SUPABASE_URL);
  expect(new Set(app.get("form-action"))).toEqual(new Set(["'self'", supabaseUrl.origin, "https://github.com"]));
  // Scripts from this origin or carrying this response's nonce, and nothing else: no
  // 'unsafe-inline', and 'unsafe-eval' only from the dev server (src/proxy.ts).
  expect(app.get("script-src")).toEqual([
    "'self'",
    expect.stringMatching(NONCE_SOURCE),
    ...(PRODUCTION_BUILD ? [] : ["'unsafe-eval'"]),
  ]);
  // Live updates (#129) need the Realtime socket.
  expect(app.get("connect-src")).toContain(`${supabaseUrl.protocol === "https:" ? "wss:" : "ws:"}//${supabaseUrl.host}`);
}

/**
 * Collects every CSP violation the page reports, from the DOM event (enforced and report-only
 * alike) and from the browser console, across navigations. Call before the first `goto`.
 */
async function watchViolations(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction("reportCspViolation", (violation: string) => {
    violations.push(violation);
  });
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      void (window as ViolationWindow).reportCspViolation?.(
        `${event.disposition} ${event.effectiveDirective}: ${event.blockedURI} on ${location.pathname}`,
      );
    });
  });
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) violations.push(message.text());
  });
  return violations;
}

/**
 * A path under a proxied prefix that matches no page gets the enforced nonce policy and a not-found
 * page rendered per request, so it carries the nonce (#197). It is never cached, as for the sign-in
 * page.
 */
async function expectNotFoundPage(page: Page, path: string): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status()).toBe(404);
  const headers = response?.headers() ?? {};
  expectAppPolicy(headers["content-security-policy"]);
  expect(headers["content-security-policy-report-only"]).toBeUndefined();
  expect(headers["cache-control"]).toContain("no-store");
  await expect(page).toHaveTitle("Page not found · StackDash");
  await expect(page.getByRole("heading", { level: 1, name: "We could not find that page" })).toBeVisible();
  await expectHydrated(page);
}

test.describe("signed out", () => {
  test("the landing page keeps its static policy without a nonce", async ({ page }) => {
    const response = await page.goto("/");
    const headers = response?.headers() ?? {};
    expect(headers["content-security-policy"]).toBe(BASELINE_CSP);
    expect(headers["content-security-policy-report-only"]).toBeUndefined();
  });

  test("the sign-in page enforces the nonce policy, is never cached, hydrates, and reports no violations", async ({ page }) => {
    const violations = await watchViolations(page);
    const response = await page.goto("/sign-in");

    const headers = response?.headers() ?? {};
    expectAppPolicy(headers["content-security-policy"]);
    expect(headers["content-security-policy-report-only"]).toBeUndefined();
    // The policy depends on request headers a client can forge (isPlainHttpToLoopback in
    // src/proxy.ts, #597), which is safe only while no cache can hand one client's response to another.
    expect(headers["cache-control"]).toContain("no-store");
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
    await expectHydrated(page);
    expect(violations).toEqual([]);
  });

  test("the unsubscribe page enforces the nonce policy, hydrates, and reports no violations", async ({ page }) => {
    // Alert emails link here signed out (#152). A valid link's button is covered by alert-email.spec.ts,
    // which needs a sent email; a broken link renders the same page without one.
    const violations = await watchViolations(page);
    const response = await page.goto("/unsubscribe?token=not-a-token");

    expect(response?.status()).toBe(200);
    const headers = response?.headers() ?? {};
    expectAppPolicy(headers["content-security-policy"]);
    expect(headers["content-security-policy-report-only"]).toBeUndefined();
    await expect(page.getByRole("heading", { level: 1, name: "Unsubscribe from alert emails" })).toBeVisible();
    await expect(page.getByText("This unsubscribe link is incomplete or no longer valid.", { exact: false })).toBeVisible();
    await expectHydrated(page);
    expect(violations).toEqual([]);
  });

  test("every app response gets a fresh nonce", async ({ request }) => {
    const nonces = await Promise.all(
      [0, 1].map(async () => {
        const response = await request.get("/sign-in");
        return directives(response.headers()["content-security-policy"] ?? "").get("script-src")?.[1];
      }),
    );
    expect(nonces[0]).toMatch(NONCE_SOURCE);
    expect(nonces[1]).toMatch(NONCE_SOURCE);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  test("an injected inline script without the nonce is blocked", async ({ page }) => {
    const violations = await watchViolations(page);
    await page.goto("/sign-in");
    await expectHydrated(page);

    // The way a stored or reflected XSS would arrive: an inline script added to the document.
    const ran = await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "document.documentElement.dataset.injected = 'ran'";
      document.body.append(script);
      return document.documentElement.dataset.injected === "ran";
    });

    expect(ran).toBe(false);
    await expect.poll(() => violations.some((violation) => violation.startsWith("enforce script-src-elem"))).toBe(true);
  });

  test("an unmatched auth path answers 404 with a not-found page that hydrates", async ({ page }) => {
    const violations = await watchViolations(page);
    await expectNotFoundPage(page, "/auth/no-such-page");
    expect(violations).toEqual([]);
  });

  test("an unmatched path outside the proxy answers 404 under the static policy and hydrates", async ({ page }) => {
    const violations = await watchViolations(page);
    const response = await page.goto("/no-such-page");
    expect(response?.status()).toBe(404);
    expect(response?.headers()["content-security-policy"]).toBe(BASELINE_CSP);
    await expect(page).toHaveTitle("Page not found · StackDash");
    await expect(page.getByRole("heading", { level: 1, name: "We could not find that page" })).toBeVisible();
    await expectHydrated(page);
    expect(violations).toEqual([]);
  });

  test("a public project page enforces the nonce policy, hydrates, and reports no violations, on and once off", async ({ page }) => {
    const workspace = await createTestWorkspace("Content security policy project page");
    try {
      const projectId = await seedProjectWithHistory(workspace);
      await publishStars(workspace, projectId);
      await turnOnPage(workspace, projectId, "acme-web", false);
      const address = `/@${workspace.slug}/acme-web`;
      const violations = await watchViolations(page);
      const response = await page.goto(address);

      expect(response?.status()).toBe(200);
      const headers = response?.headers() ?? {};
      expectAppPolicy(headers["content-security-policy"]);
      expect(headers["content-security-policy-report-only"]).toBeUndefined();
      await expect(page.getByRole("heading", { level: 1, name: "Acme web" })).toBeVisible();
      await expectHydrated(page);

      // The same address once the page is off: a real 404 (the proxy checks before the page
      // streams its 200 shell) under the nonce policy, with a not-found page that hydrates.
      await turnOffPage(workspace, projectId);
      await test.step("turned off", () => expectNotFoundPage(page, address));
      expect(violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  test("unknown project page addresses answer 404 with a not-found page that hydrates", async ({ page }) => {
    const violations = await watchViolations(page);
    for (const path of ["/@nosuchwork/no-such-page", "/@nosuchwork", "/p/nosuchwork/no-such-page"]) {
      await test.step(path, () => expectNotFoundPage(page, path));
    }
    expect(violations).toEqual([]);
  });

  // The super admin page's route answers only through the proxy's rewrite of /app/admin (#374):
  // its own path and any path under it are the not-found page, under the nonce policy.
  test("the super admin route's own paths answer 404 with a not-found page that hydrates", async ({ page }) => {
    const violations = await watchViolations(page);
    for (const path of ["/super-admin", "/super-admin/no-such-page"]) {
      await test.step(path, () => expectNotFoundPage(page, path));
    }
    expect(violations).toEqual([]);
  });
});

ownerTest.describe("signed in", () => {
  ownerTest("app routes enforce the nonce policy, hydrate, and report no violations", async ({ page }) => {
    const workspace = await createTestWorkspace("Content security policy");
    try {
      const violations = await watchViolations(page);
      const paths = [
        "/account",
        "/auth/error",
        `/w/${workspace.slug}/timeline`,
        `/w/${workspace.slug}/dashboard`,
        `/w/${workspace.slug}/projects`,
        `/w/${workspace.slug}/connections`,
        `/w/${workspace.slug}/connections/new/fake`,
        `/w/${workspace.slug}/alerts`,
        `/w/${workspace.slug}/alerts/settings`,
        `/w/${workspace.slug}/settings`,
        // The year in review (#151, slides #262): its slides hydrate under the nonce policy, and a
        // slide's image loads from this origin under img-src 'self' once its share dialog opens.
        `/w/${workspace.slug}/year/${new Date().getUTCFullYear()}`,
      ];

      for (const path of paths) {
        await ownerTest.step(path, async () => {
          const response = await page.goto(path);
          expect(response?.status()).toBe(200);
          const headers = response?.headers() ?? {};
          expectAppPolicy(headers["content-security-policy"]);
          expect(headers["content-security-policy-report-only"]).toBeUndefined();
          await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
          await expectHydrated(page);
        });
      }

      expect(violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });

  ownerTest("the app entry redirects into a workspace that responds to input", async ({ page }) => {
    const violations = await watchViolations(page);
    await page.goto("/app");
    await expect(page).toHaveURL(/\/w\/[a-z0-9]+\/timeline$/);
    await expectHydrated(page);

    // The switcher opens from a click handler, so this works only on a hydrated page.
    const switcher = page.getByRole("button", { name: /^Workspace: / });
    await switcher.click();
    await expect(switcher).toHaveAttribute("aria-expanded", "true");
    expect(violations).toEqual([]);
  });

  ownerTest("unmatched app paths answer 404 with a not-found page that hydrates", async ({ page }) => {
    const workspace = await createTestWorkspace("Content security policy not found");
    try {
      const violations = await watchViolations(page);
      for (const path of [`/w/${workspace.slug}/no-such-page`, "/app/no-such-page"]) {
        await ownerTest.step(path, () => expectNotFoundPage(page, path));
      }
      expect(violations).toEqual([]);
    } finally {
      await deleteTestWorkspace(workspace);
    }
  });
});
